'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { execFileSync } = require('child_process');
const { downloadBinary } = require('../lib/downloader');

const MB = 1024 * 1024;
const DL_URL = 'https://example.invalid/agy.tar.gz';
const ZERO64 = '0'.repeat(64);

// テストごとに一時ディレクトリを作り、終わったら消す。os.tmpdir() は work を返すので、
// downloadBinary が作る一時ファイルも work 配下に閉じる
async function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dlb-'));
  try {
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    return await fn({ root, work });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ELF ヘッダーを持つ 10MiB + 4096 バイトのダミーバイナリ
function elfBuf(size = 10 * MB + 4096) {
  const buf = Buffer.alloc(size);
  buf.set([0x7f, 0x45, 0x4c, 0x46], 0);
  return buf;
}

// 実物の tar.gz を作る(展開は実際の tar で行う)
function makeTgz(root, bin) {
  const src = fs.mkdtempSync(path.join(root, 'src-'));
  fs.writeFileSync(path.join(src, 'antigravity'), bin);
  const out = path.join(root, 'pkg.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', src, 'antigravity']);
  return fs.readFileSync(out);
}

// fs / os を work に寄せ、mkdtemp の結果を記録する。fsOver で個別の関数を差し替えられる
function makeDeps(work, rest = {}, fsOver = {}) {
  const created = [];
  const fsWrap = Object.assign({}, fs, {
    mkdtempSync: (p) => {
      const dir = fs.mkdtempSync(p);
      created.push(dir);
      return dir;
    },
  }, fsOver);
  return {
    created,
    deps: { fs: fsWrap, os: Object.assign({}, os, { tmpdir: () => work }), ...rest },
  };
}

// tar の結果だけを差し替える。statfs 未指定時は呼ばれたら失敗する(呼ばれないことを前提とするケース用)
function tarDeps(work, spawnResult, { statfs = () => { throw new Error('statfs は呼ばれないはず'); }, fsOver, ...rest } = {}) {
  return makeDeps(work, {
    httpsGet: async () => Buffer.from('dummy'),
    spawnSync: () => spawnResult,
    statfsSync: statfs,
    ...rest,
  }, fsOver);
}

const statfsWithFree = (free) => () => ({ bavail: free / 4096, bsize: 4096 });

test('成功: バイナリを返し、段階ラベルを順に通知し、一時ディレクトリを消す', async () => {
  await withRoot(async ({ root, work }) => {
    const bin = elfBuf();
    const tgz = makeTgz(root, bin);
    const calls = [];
    const phases = [];
    const { created, deps } = makeDeps(work, {
      httpsGet: async (url, o) => {
        calls.push({ url, o });
        return tgz;
      },
    });
    const out = await downloadBinary(DL_URL, null, null, {
      onPhase: (p) => phases.push(p),
      progress: true,
      stallMs: 1234,
      deps,
    });
    assert.equal(out.equals(bin), true);
    assert.deepEqual(phases, ['検証しています...', '展開しています...', '検証しています...']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, DL_URL);
    assert.deepEqual(calls[0].o, { label: 'ダウンロード', progress: true, stallMs: 1234 });
    assert.equal(created.length, 1);
    assert.equal(fs.existsSync(created[0]), false);
    assert.deepEqual(fs.readdirSync(work), []);
  });
});

test('tarball の SHA256 が不一致なら E_SHA で、展開前に止まる', async () => {
  await withRoot(async ({ root, work }) => {
    const tgz = makeTgz(root, elfBuf());
    const phases = [];
    const { deps } = tarDeps(work, { status: 0, stderr: '' }, {
      httpsGet: async () => tgz,
      spawnSync: () => {
        throw new Error('展開は呼ばれないはず');
      },
    });
    await assert.rejects(
      downloadBinary(DL_URL, ZERO64, null, { onPhase: (p) => phases.push(p), deps }),
      { code: 'E_SHA' },
    );
    assert.deepEqual(phases, ['検証しています...']);
  });
});

test('バイナリの SHA256 が不一致なら E_SHA、一致なら成功する', async () => {
  await withRoot(async ({ root, work }) => {
    const bin = elfBuf();
    const tgz = makeTgz(root, bin);
    const { deps } = makeDeps(work, { httpsGet: async () => tgz });
    await assert.rejects(downloadBinary(DL_URL, null, ZERO64, { deps }), { code: 'E_SHA' });

    const sha = require('crypto').createHash('sha256').update(bin).digest('hex');
    const { deps: deps2 } = makeDeps(work, { httpsGet: async () => tgz });
    const out = await downloadBinary(DL_URL, null, sha, { deps: deps2 });
    assert.equal(out.equals(bin), true);
  });
});

test('ELF ヘッダーが不正、またはサイズ不足なら E_ELF', async () => {
  await withRoot(async ({ root, work }) => {
    const badPrefix = elfBuf();
    badPrefix[0] = 0x00;
    const { deps: d1 } = makeDeps(work, { httpsGet: async () => makeTgz(root, badPrefix) });
    await assert.rejects(downloadBinary(DL_URL, null, null, { deps: d1 }), { code: 'E_ELF' });

    const small = elfBuf(1024);
    const { deps: d2 } = makeDeps(work, { httpsGet: async () => makeTgz(root, small) });
    await assert.rejects(downloadBinary(DL_URL, null, null, { deps: d2 }), { code: 'E_ELF' });
  });
});

// tar の stderr から確定できる原因は、そのままの code で返す
const confirmed = [
  ['No space left on device', 'ENOSPC'],
  ['Disk quota exceeded', 'EDQUOT'],
  ['Permission denied', 'EACCES'],
  ['tar: antigravity: Cannot open: Operation not permitted', 'EPERM'],
  ['Unexpected EOF', 'E_TAR_CORRUPT'],
];
for (const [stderr, code] of confirmed) {
  test(`tar 失敗 "${stderr}" は ${code}`, async () => {
    await withRoot(async ({ work }) => {
      const { deps } = tarDeps(work, { status: 2, stderr });
      await assert.rejects(downloadBinary(DL_URL, null, null, { deps }), { code });
    });
  });
}

test('原因不明の tar 失敗で空きが十分なら E_TAR_UNKNOWN', async () => {
  await withRoot(async ({ work }) => {
    const { deps } = tarDeps(work, { status: 2, stderr: 'tar: Error is not recoverable: exiting now' }, {
      statfs: statfsWithFree(4096 * MB),
    });
    await assert.rejects(downloadBinary(DL_URL, null, null, { deps }), { code: 'E_TAR_UNKNOWN' });
  });
});

test('原因不明の tar 失敗で空きが 10MB なら E_NOSPACE_MAYBE、free を保持する', async () => {
  await withRoot(async ({ work }) => {
    const { deps } = tarDeps(work, { status: 2, stderr: 'tar: Error is not recoverable: exiting now' }, {
      statfs: statfsWithFree(10 * MB),
    });
    await assert.rejects(downloadBinary(DL_URL, null, null, { deps }), {
      code: 'E_NOSPACE_MAYBE',
      free: 10 * MB,
    });
  });
});

test('EACCES は空きが 10MB でも上書きされない', async () => {
  await withRoot(async ({ work }) => {
    const { deps } = tarDeps(work, { status: 2, stderr: 'Permission denied' }, {
      statfs: statfsWithFree(10 * MB),
    });
    await assert.rejects(downloadBinary(DL_URL, null, null, { deps }), { code: 'EACCES' });
  });
});

test('statfs が失敗しても無視され、E_TAR_UNKNOWN になる', async () => {
  await withRoot(async ({ work }) => {
    const { deps } = tarDeps(work, { status: 2, stderr: 'tar: Error is not recoverable: exiting now' }, {
      statfs: () => {
        throw new Error('statfs failed');
      },
    });
    await assert.rejects(downloadBinary(DL_URL, null, null, { deps }), { code: 'E_TAR_UNKNOWN' });
  });
});

test('spawnSync が error を返したら、その errno code を保持する', async () => {
  await withRoot(async ({ work }) => {
    const error = Object.assign(new Error('spawnSync tar ENOENT'), { code: 'ENOENT' });
    const { deps } = tarDeps(work, { error });
    await assert.rejects(downloadBinary(DL_URL, null, null, { deps }), { code: 'ENOENT' });
  });
});

for (const code of ['EACCES', 'ENOSPC']) {
  test(`mkdtemp が ${code} で失敗したら、errno を保持して stage=extract を付ける`, async () => {
    await withRoot(async ({ work }) => {
      const fsOver = {
        mkdtempSync: () => {
          throw Object.assign(new Error(`${code}: mock`), { code });
        },
      };
      const { deps } = makeDeps(work, { httpsGet: async () => Buffer.from('dummy') }, fsOver);
      await assert.rejects(downloadBinary(DL_URL, null, null, { deps }), { code, stage: 'extract' });
    });
  });
}

test('rmSync が失敗しても、成功時はバイナリを返す', async () => {
  await withRoot(async ({ root, work }) => {
    const bin = elfBuf();
    const tgz = makeTgz(root, bin);
    const { deps } = makeDeps(work, { httpsGet: async () => tgz }, {
      rmSync: () => {
        throw Object.assign(new Error('EBUSY: mock'), { code: 'EBUSY' });
      },
    });
    const out = await downloadBinary(DL_URL, null, null, { deps });
    assert.equal(out.equals(bin), true);
  });
});

test('rmSync が失敗しても、失敗時は元のエラー code を返す', async () => {
  await withRoot(async ({ work }) => {
    const { deps } = tarDeps(work, { status: 2, stderr: 'Permission denied' }, {
      fsOver: {
        rmSync: () => {
          throw Object.assign(new Error('EBUSY: mock'), { code: 'EBUSY' });
        },
      },
    });
    await assert.rejects(downloadBinary(DL_URL, null, null, { deps }), { code: 'EACCES' });
  });
});

test('失敗時も一時ディレクトリを消す', async () => {
  await withRoot(async ({ work }) => {
    const { created, deps } = tarDeps(work, { status: 2, stderr: 'Permission denied' });
    await assert.rejects(downloadBinary(DL_URL, null, null, { deps }), { code: 'EACCES' });
    assert.equal(created.length, 1);
    assert.equal(fs.existsSync(created[0]), false);
    assert.deepEqual(fs.readdirSync(work), []);
  });
});

test('opts を省略した 3 引数呼び出しでも、実 tar と stub した https で動く', async () => {
  await withRoot(async ({ root, work }) => {
    const bin = elfBuf();
    const tgz = makeTgz(root, bin);
    const origTmp = process.env.TMPDIR;
    const origGet = https.get;
    process.env.TMPDIR = work;
    https.get = (url, options, cb) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      process.nextTick(() => {
        const res = new PassThrough();
        res.statusCode = 200;
        res.headers = {};
        cb(res);
        res.end(tgz);
      });
      return req;
    };
    try {
      const out = await downloadBinary(DL_URL, null, null);
      assert.equal(out.equals(bin), true);
    } finally {
      https.get = origGet;
      if (origTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = origTmp;
    }
    assert.deepEqual(fs.readdirSync(work), []);
  });
});
