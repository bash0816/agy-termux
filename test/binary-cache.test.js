'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bc = require('../lib/binary-cache.js');

const MIN_SIZE = 10 * 1024 * 1024;
const ELF_HEAD = [0x7f, 0x45, 0x4c, 0x46];
// utimes と突き合わせるための固定の現在時刻(秒)
const NOW_SEC = 2000000000;
const DAY_SEC = 24 * 60 * 60;
const META = {
  tagName: '1.2.16',
  downloadUrl: 'https://example.invalid/agy_cli_linux_arm64.tar.gz',
  sha256Tar: 'aa',
  sha256Binary: 'bb',
};

// 一時ディレクトリを作り、テスト終了時に削除する
function mkTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir() || process.env.TMPDIR, 'agy-bc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// name → 更新時刻(秒) の対応で実ファイルを作る
function writeFiles(dir, entries) {
  for (const [name, sec] of Object.entries(entries)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    fs.utimesSync(p, sec, sec);
  }
  return dir;
}

// isCacheValid 用の偽 fsDeps。実ファイルには触れない
function fakeFsDeps({
  exists = true, size = MIN_SIZE, head = ELF_HEAD,
  statThrows = false, openThrows = false, readThrows = false,
} = {}) {
  const closed = [];
  return {
    closed,
    existsSync: () => exists,
    statSync: () => { if (statThrows) throw new Error('stat failed'); return { size }; },
    openSync: () => { if (openThrows) throw new Error('open failed'); return 3; },
    readSync: (fd, buf, off, len) => {
      if (readThrows) throw new Error('read failed');
      Buffer.from(head).copy(buf, off, 0, len);
      return len;
    },
    closeSync: (fd) => { closed.push(fd); },
  };
}

// --- normalizeCacheTag / cacheFileName / cachePaths / tmpPathFor ---

test('normalizeCacheTag: 先頭の v を1つだけ外し、x.y.z 形式を通す', () => {
  assert.equal(bc.normalizeCacheTag('1.2.16'), '1.2.16');
  assert.equal(bc.normalizeCacheTag('v1.2.16'), '1.2.16');
  assert.equal(bc.normalizeCacheTag('0.0.0'), '0.0.0');
});

test('normalizeCacheTag: 不正な形式と非文字列は例外にする', () => {
  for (const bad of ['vv1.2.16', '1.2', '1.2.3.4', '01.2.3', '1.2.3-rc', 'latest', '', ' 1.2.3']) {
    assert.throws(() => bc.normalizeCacheTag(bad), Error, bad);
  }
  assert.throws(() => bc.normalizeCacheTag(null), Error);
  assert.throws(() => bc.normalizeCacheTag(123), Error);
});

test('cacheFileName: パッチ版は .va39r2、非パッチ版は .bin になる', () => {
  assert.equal(bc.cacheFileName('v1.2.16', true), 'agy-1.2.16.va39r2');
  assert.equal(bc.cacheFileName('1.2.16', false), 'agy-1.2.16.bin');
  assert.throws(() => bc.cacheFileName('x', true), Error);
});

test('cachePaths: 通常の dir と unverified 配下の両方を返す', () => {
  assert.deepEqual(
    bc.cachePaths({ dir: '/c', tag: 'v1.2.16', isPatch: true, unverified: false }),
    {
      dir: '/c',
      file: path.join('/c', 'agy-1.2.16.va39r2'),
      original: path.join('/c', 'agy-1.2.16.bin'),
      legacy: path.join('/c', 'agy-1.2.16.va39'),
      lock: path.join('/c', 'agy-1.2.16.lock'),
    },
  );
  assert.deepEqual(
    bc.cachePaths({ dir: '/c', tag: '1.2.16', isPatch: false }),
    {
      dir: '/c',
      file: path.join('/c', 'agy-1.2.16.bin'),
      original: path.join('/c', 'agy-1.2.16.bin'),
      legacy: path.join('/c', 'agy-1.2.16.va39'),
      lock: path.join('/c', 'agy-1.2.16.lock'),
    },
  );
  assert.deepEqual(
    bc.cachePaths({ dir: '/c', tag: '1.2.16', isPatch: false, unverified: true }),
    {
      dir: path.join('/c', 'unverified'),
      file: path.join('/c', 'unverified', 'agy-1.2.16.bin'),
      original: path.join('/c', 'unverified', 'agy-1.2.16.bin'),
      legacy: path.join('/c', 'unverified', 'agy-1.2.16.va39'),
      lock: path.join('/c', 'unverified', 'agy-1.2.16.lock'),
    },
  );
});

test('tmpPathFor: <file>.<pid>.<rand>.tmp の形になる', () => {
  assert.equal(
    bc.tmpPathFor(path.join('/a', 'agy-1.2.16.bin'), 1234, 'deadbeef'),
    path.join('/a', 'agy-1.2.16.bin') + '.1234.deadbeef.tmp',
  );
});

// --- needsPatch ---

test('needsPatch: 最上位アドレスが 39bit 以下ならパッチが必要', () => {
  const maps = (text) => () => text;
  assert.equal(needsPatchWith(maps('00400000-00401000 r-xp\n7f00000000-7f00001000 rw-p\n')), true);
  assert.equal(needsPatchWith(maps('8000000000-8000001000 rw-p\n')), false);
});

test('needsPatch: 読めない場合は安全側で true', () => {
  assert.equal(needsPatchWith(() => { throw new Error('ENOENT'); }), true);
});

function needsPatchWith(readFileSync) {
  return bc.needsPatch(readFileSync);
}

// --- isCacheValid ---

test('isCacheValid: 10MiB ちょうどは有効、1 バイト小さいと無効', () => {
  const file = '/virtual/agy-1.2.16.bin';
  assert.equal(bc.isCacheValid(fakeFsDeps({ size: MIN_SIZE }), file), true);
  assert.equal(bc.isCacheValid(fakeFsDeps({ size: MIN_SIZE - 1 }), file), false);
});

test('isCacheValid: 存在しない・ELF でない・例外はすべて false', () => {
  const file = '/virtual/agy-1.2.16.bin';
  assert.equal(bc.isCacheValid(fakeFsDeps({ exists: false }), file), false);
  assert.equal(bc.isCacheValid(fakeFsDeps({ head: [0x7f, 0x45, 0x4c, 0x00] }), file), false);
  assert.equal(bc.isCacheValid(fakeFsDeps({ statThrows: true }), file), false);
  assert.equal(bc.isCacheValid(fakeFsDeps({ openThrows: true }), file), false);
});

test('isCacheValid: 読み込みに失敗しても fd は閉じる', () => {
  const fsDeps = fakeFsDeps({ readThrows: true });
  assert.equal(bc.isCacheValid(fsDeps, '/virtual/agy-1.2.16.bin'), false);
  assert.deepEqual(fsDeps.closed, [3]);
});

test('isCacheValid: 有効な場合も fd を閉じる', () => {
  const fsDeps = fakeFsDeps();
  assert.equal(bc.isCacheValid(fsDeps, '/virtual/agy-1.2.16.bin'), true);
  assert.deepEqual(fsDeps.closed, [3]);
});

// --- installBinary ---

function installDeps(over = {}) {
  return {
    download: async () => Buffer.from('NEW-BINARY'),
    patch: () => ({ ubfx: 0, lsl: 0, mask: 0, mmap: 0, word: 0 }),
    fs: {
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      rmSync: fs.rmSync,
    },
    pid: 1234,
    randomHex: () => 'abcdef',
    ...over,
  };
}

// 既存の file・別ファイル・他プロセスの一時ファイルを置いた状態を作る
function plantExisting(t) {
  const dir = mkTmp(t);
  const file = path.join(dir, 'agy-1.2.16.bin');
  fs.writeFileSync(file, 'OLD');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'keep');
  fs.writeFileSync(path.join(dir, 'agy-1.2.16.bin.999.zzz.tmp'), 'partial');
  return { dir, file };
}

async function assertFailureLeavesDir(t, over, error, isPatch = false) {
  const { dir, file } = plantExisting(t);
  const before = fs.readdirSync(dir).sort();
  await assert.rejects(
    bc.installBinary(installDeps(over), { meta: META, isPatch, file }),
    (e) => e === error,
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.equal(fs.readFileSync(file, 'utf8'), 'OLD');
  assert.equal(fs.readFileSync(path.join(dir, 'other.txt'), 'utf8'), 'keep');
}

test('installBinary: download 失敗では既存ファイルと他のファイルを変えず、元のエラーを返す', async (t) => {
  const err = new Error('download failed');
  await assertFailureLeavesDir(t, { download: async () => { throw err; } }, err);
});

test('installBinary: patch 失敗では既存ファイルを変えない', async (t) => {
  const err = new Error('patch failed');
  await assertFailureLeavesDir(t, { patch: () => { throw err; } }, err, true);
});

test('installBinary: 一時ファイル書き込みで失敗しても自分の tmp だけを消す', async (t) => {
  const err = new Error('write failed');
  const fsDeps = {
    ...installDeps().fs,
    // 書き込みは実際に行ってから失敗させ、後始末が必要な状況を作る
    writeFileSync: (p, data, opts) => { fs.writeFileSync(p, data, opts); throw err; },
  };
  await assertFailureLeavesDir(t, { fs: fsDeps }, err);
});

test('installBinary: rename 失敗では既存ファイルを変えず、自分の tmp を消す', async (t) => {
  const err = new Error('rename failed');
  const fsDeps = { ...installDeps().fs, renameSync: () => { throw err; } };
  await assertFailureLeavesDir(t, { fs: fsDeps }, err);
});

test('installBinary: 後始末の rmSync が失敗しても元のエラーを返す', async (t) => {
  const err = new Error('rename failed');
  const fsDeps = {
    ...installDeps().fs,
    renameSync: () => { throw err; },
    rmSync: () => { throw new Error('rm failed'); },
  };
  const { file } = plantExisting(t);
  await assert.rejects(
    bc.installBinary(installDeps({ fs: fsDeps }), { meta: META, isPatch: false, file }),
    (e) => e === err,
  );
});

test('installBinary: 成功時は配置して file を返し、他のファイルは変えない', async (t) => {
  const dir = mkTmp(t);
  const file = path.join(dir, 'nested', 'agy-1.2.16.bin');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'keep');
  const result = await bc.installBinary(installDeps(), { meta: META, isPatch: false, file });
  assert.equal(result, file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'NEW-BINARY');
  assert.equal(fs.statSync(file).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(dir, 'other.txt'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'nested')), ['agy-1.2.16.bin']);
});

test('installBinary: パッチ版は buf を in-place で書き換えた内容を書き出す', async (t) => {
  const dir = mkTmp(t);
  const file = path.join(dir, 'agy-1.2.16.va39');
  let patched = null;
  const patchCounts = { ubfx: 1, lsl: 0, mask: 0, mmap: 0, word: 0 };
  const deps = installDeps({
    patch: (buf) => { patched = buf; buf[0] = 0x58; return patchCounts; },
  });
  await bc.installBinary(deps, { meta: META, isPatch: true, file });
  assert.ok(Buffer.isBuffer(patched));
  // 戻り値の counts ではなく、書き換え後の buf が配置されること
  assert.equal(fs.readFileSync(file, 'utf8'), 'XEW-BINARY');
});

test('installBinary: 一時ファイル名は tmpPathFor と同じ規則で作る', async (t) => {
  const dir = mkTmp(t);
  const file = path.join(dir, 'agy-1.2.16.bin');
  const seen = [];
  const fsDeps = {
    ...installDeps().fs,
    writeFileSync: (p, data, opts) => { seen.push(p); fs.writeFileSync(p, data, opts); },
  };
  await bc.installBinary(installDeps({ fs: fsDeps }), { meta: META, isPatch: false, file });
  assert.deepEqual(seen, [bc.tmpPathFor(file, 1234, 'abcdef')]);
});

// --- syncBinary ---

// 呼び出し順と出力を記録する syncBinary 用の依存
function syncDeps(over = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const deps = {
    meta: { ...META },
    dir: '/virtual/cache',
    isPatch: true,
    hasConsent: (key) => { calls.push('hasConsent:' + key); return true; },
    loaderExists: () => { calls.push('loaderExists'); return true; },
    confirmCompat: async () => { calls.push('confirmCompat'); return true; },
    install: async (file) => { calls.push('install:' + file); },
    fsDeps: fakeFsDeps({ exists: false }),
    prune: (pinTag) => { calls.push('prune:' + pinTag); return []; },
    listManualCleanup: () => { calls.push('listManualCleanup'); return { files: [], total: 0 }; },
    out: (m) => out.push(m),
    err: (m) => err.push(m),
    ...over,
  };
  return { deps, calls, out, err };
}

test('syncBinary: 初回の同意が無ければ省略し、以降の処理と掃除をしない', async () => {
  const { deps, calls, out, err } = syncDeps({ hasConsent: (key) => { calls.push('hasConsent:' + key); return false; } });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, { status: 'skipped', reason: 'consent_declined', detail: '', tag: '1.2.16', deleted: { count: 0, bytes: 0 } });
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
  assert.deepEqual(calls, ['hasConsent:download']);
});

test('syncBinary: loader が無ければ error にして案内する', async () => {
  const { deps, calls, out, err } = syncDeps({ loaderExists: () => { calls.push('loaderExists'); return false; } });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, { status: 'error', reason: 'loader', detail: '', tag: '1.2.16', deleted: { count: 0, bytes: 0 } });
  assert.deepEqual(err, []);
  assert.deepEqual(out, []);
  assert.deepEqual(calls, ['hasConsent:download', 'loaderExists']);
});

test('syncBinary: キャッシュが有効なら current。掃除だけ行い、取得や互換確認はしない', async () => {
  const { deps, calls, out, err } = syncDeps({ fsDeps: fakeFsDeps() });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, { status: 'current', detail: '', tag: '1.2.16', file: path.join('/virtual/cache', 'agy-1.2.16.va39r2'), deleted: { count: 0, bytes: 0 } });
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
  assert.deepEqual(calls, ['hasConsent:download', 'loaderExists', 'prune:1.2.16']);
});

test('syncBinary: 手動削除候補があれば一覧・合計・案内を出す', async () => {
  const listing = {
    files: [
      { path: '/virtual/cache/agy.bin', size: 5 },
      { path: '/virtual/cache/unverified/agy-1.2.16.va39', size: 7 },
    ],
    total: 12,
  };
  const { deps, calls, out, err } = syncDeps({ fsDeps: fakeFsDeps(), listManualCleanup: () => listing });
  const r = await bc.syncBinary(deps);
  assert.equal(r.status, 'current');
  // 手動削除の案内は出さず、listManualCleanup も呼ばない
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
  assert.deepEqual(calls, ['hasConsent:download', 'loaderExists', 'prune:1.2.16']);
});

test('syncBinary: パッチ版で互換同意が無く、拒否されたら skipped にして取得しない', async () => {
  const { deps, calls, out } = syncDeps({
    hasConsent: (key) => { calls.push('hasConsent:' + key); return key === 'download'; },
    confirmCompat: async () => { calls.push('confirmCompat'); return false; },
  });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, { status: 'skipped', reason: 'compat_declined', detail: '', tag: '1.2.16', deleted: { count: 0, bytes: 0 } });
  assert.deepEqual(out, []);
  assert.deepEqual(calls, ['hasConsent:download', 'loaderExists', 'hasConsent:compat', 'confirmCompat']);
});

test('syncBinary: パッチ版で互換同意済みなら confirmCompat を呼ばず取得する', async () => {
  const { deps, calls, out } = syncDeps({ fsDeps: fakeFsDeps({ exists: false }) });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, { status: 'synced', detail: '', tag: '1.2.16', file: path.join('/virtual/cache', 'agy-1.2.16.va39r2'), deleted: { count: 0, bytes: 0 } });
  assert.deepEqual(calls, [
    'hasConsent:download', 'loaderExists', 'hasConsent:compat',
    'install:' + path.join('/virtual/cache', 'agy-1.2.16.va39r2'),
    'prune:1.2.16',
  ]);
  assert.deepEqual(out, []);
});

test('syncBinary: パッチ版で互換同意が無ければ確認し、承諾されたら取得する', async () => {
  const { deps, calls } = syncDeps({ hasConsent: (key) => { calls.push('hasConsent:' + key); return key === 'download'; } });
  const r = await bc.syncBinary(deps);
  assert.equal(r.status, 'synced');
  assert.deepEqual(calls, [
    'hasConsent:download', 'loaderExists', 'hasConsent:compat', 'confirmCompat',
    'install:' + path.join('/virtual/cache', 'agy-1.2.16.va39r2'),
    'prune:1.2.16',
  ]);
});

test('syncBinary: 非パッチ版では互換確認をせず .bin を取得する', async () => {
  const { deps, calls } = syncDeps({ isPatch: false, hasConsent: (key) => { calls.push('hasConsent:' + key); return key === 'download'; } });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, { status: 'synced', detail: '', tag: '1.2.16', file: path.join('/virtual/cache', 'agy-1.2.16.bin'), deleted: { count: 0, bytes: 0 } });
  assert.deepEqual(calls, [
    'hasConsent:download', 'loaderExists',
    'install:' + path.join('/virtual/cache', 'agy-1.2.16.bin'),
    'prune:1.2.16',
  ]);
});

test('syncBinary: 取得に失敗したら error。掃除と案内はしない', async () => {
  const { deps, calls, out, err } = syncDeps({
    install: async () => { calls.push('install'); throw new Error('net down'); },
  });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, { status: 'error', reason: 'install', detail: 'net down', tag: '1.2.16', deleted: { count: 0, bytes: 0 }, error: { detail: 'net down' } });
  assert.deepEqual(err, []);
  assert.deepEqual(out, []);
  assert.deepEqual(calls, ['hasConsent:download', 'loaderExists', 'hasConsent:compat', 'install']);
});

test('syncBinary: prune が例外を投げても synced の結果は変わらない', async () => {
  const { deps, out } = syncDeps({ prune: () => { throw new Error('prune boom'); } });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, { status: 'synced', detail: '', tag: '1.2.16', file: path.join('/virtual/cache', 'agy-1.2.16.va39r2'), deleted: { count: 0, bytes: 0 } });
  assert.deepEqual(out, []);
});

test('syncBinary: 不正な tagName は cachePaths の例外をそのまま返す', async () => {
  const { deps } = syncDeps({ meta: { ...META, tagName: '2.x' } });
  await assert.rejects(bc.syncBinary(deps), Error);
});

// --- prune ---

// prune 用の依存。実ファイルに対して動き、呼び出し履歴を残す
function pruneDeps(over = {}) {
  const seen = { stat: [], unlink: [], killPid: [] };
  const deps = {
    readdirSync: (d) => fs.readdirSync(d),
    statSync: (p) => { seen.stat.push(p); return fs.statSync(p); },
    unlinkSync: (p) => { seen.unlink.push(p); fs.unlinkSync(p); },
    killPid: (pid) => { seen.killPid.push(pid); return 'alive'; },
    now: () => NOW_SEC * 1000,
    ...over,
  };
  return { deps, seen };
}

test('prune: pin と最新の1版だけを残し、他のタグは両拡張子を消す', (t) => {
  const dir = writeFiles(mkTmp(t), {
    'agy-1.2.16.va39': 100, 'agy-1.2.16.bin': 100,
    'agy-1.3.0.va39': 300, 'agy-1.3.0.bin': 200,
    'agy-1.1.0.bin': 250, 'agy-1.0.0.bin': 50,
  });
  const { deps } = pruneDeps();
  const deleted = bc.prune(deps, { dir, pinTag: '1.2.16' });
  assert.deepEqual(deleted.files.sort(), ['agy-1.0.0.bin', 'agy-1.1.0.bin']);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'agy-1.2.16.bin', 'agy-1.2.16.va39', 'agy-1.3.0.bin', 'agy-1.3.0.va39',
  ]);
});

test('prune: タグの更新時刻は両拡張子の最大で決まる', (t) => {
  const dir = writeFiles(mkTmp(t), {
    'agy-1.0.0.va39': 10, 'agy-1.0.0.bin': 500,
    'agy-2.0.0.va39': 400,
  });
  const { deps } = pruneDeps();
  assert.deepEqual(bc.prune(deps, { dir, pinTag: '9.9.9' }).files, ['agy-2.0.0.va39']);
});

test('prune: 同じ更新時刻なら版を数値で比べ、1.10.0 は 1.9.0 より新しい', (t) => {
  const dir = writeFiles(mkTmp(t), { 'agy-1.9.0.bin': 100, 'agy-1.10.0.bin': 100 });
  const { deps } = pruneDeps();
  assert.deepEqual(bc.prune(deps, { dir, pinTag: '2.0.0' }).files, ['agy-1.9.0.bin']);
  assert.deepEqual(fs.readdirSync(dir), ['agy-1.10.0.bin']);
});

test('prune: pinTag は v 付きでも正規化して一致を見る', (t) => {
  const dir = writeFiles(mkTmp(t), {
    'agy-1.2.16.bin': 10, 'agy-1.3.0.bin': 200, 'agy-1.4.0.bin': 300,
  });
  const { deps } = pruneDeps();
  assert.deepEqual(bc.prune(deps, { dir, pinTag: 'v1.2.16' }).files, ['agy-1.3.0.bin']);
});

test('prune: pinTag が不正なら何も消さず [] を返す', (t) => {
  const dir = writeFiles(mkTmp(t), { 'agy-1.2.16.bin': 10, 'agy-1.3.0.bin': 20 });
  const { deps, seen } = pruneDeps();
  const res = bc.prune(deps, { dir, pinTag: 'latest' });
  assert.deepEqual(res.files, []);
  assert.equal(res.count, 0);
  assert.equal(res.bytes, 0);
  assert.equal(seen.unlink.length, 0);
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('prune: 規則に完全一致しない名前には stat も unlink もしない', (t) => {
  const nonMatching = [
    'agy.va39.bak', 'agy.bin.bak', '.version.bak', '.bin.tmp.bak',
    'agy-1.2.16.bin.tmp', 'agy-1.2.16.bin.1234.ABC.tmp', 'agy-1.2.16.va39.bin', 'readme.txt',
  ];
  const entries = { 'agy-1.2.16.bin': 100, 'unverified/agy-0.9.0.bin': 1 };
  for (const n of nonMatching) entries[n] = 1;
  const dir = writeFiles(mkTmp(t), entries);
  const { deps, seen } = pruneDeps();
  const res = bc.prune(deps, { dir, pinTag: '1.2.16' });
  assert.deepEqual(res.files, []);
  assert.equal(res.count, 0);
  assert.equal(res.bytes, 0);
  const forbidden = nonMatching.map((n) => path.join(dir, n));
  forbidden.push(path.join(dir, 'unverified'), path.join(dir, 'unverified', 'agy-0.9.0.bin'));
  for (const p of [...seen.stat, ...seen.unlink]) {
    assert.ok(!forbidden.includes(p), 'touched: ' + p);
  }
  assert.equal(fs.readdirSync(path.join(dir, 'unverified')).length, 1);
});

// 中断された一時ファイルの掃除。名前は installBinary が作るものと同じ
function runTmpCase(t, { ageSec, status }) {
  const dir = mkTmp(t);
  const file = bc.cachePaths({ dir, tag: '1.2.16', isPatch: true }).file;
  const tmpName = path.basename(bc.tmpPathFor(file, 1234, 'deadbeef'));
  writeFiles(dir, { [tmpName]: NOW_SEC - ageSec });
  const { deps, seen } = pruneDeps({ killPid: (pid) => { seen.killPid.push(pid); return status; } });
  const deleted = bc.prune(deps, { dir, pinTag: '9.9.9' });
  return { deleted, tmpName, seen, remaining: fs.readdirSync(dir) };
}

test('prune: 所有プロセスが esrch で24時間以上前の一時ファイルは消す(installBinary の名前と対応)', (t) => {
  const r = runTmpCase(t, { ageSec: DAY_SEC + 1, status: 'esrch' });
  assert.deepEqual(r.deleted.files,[r.tmpName]);
  assert.deepEqual(r.remaining, []);
  // pid は文字列ではなく数値で渡す
  assert.deepEqual(r.seen.killPid, [1234]);
});

test('prune: ちょうど24時間前の一時ファイルは消す(境界は含む)', (t) => {
  const r = runTmpCase(t, { ageSec: DAY_SEC, status: 'esrch' });
  assert.deepEqual(r.deleted.files,[r.tmpName]);
});

test('prune: 24時間未満の一時ファイルは esrch でも残す', (t) => {
  const r = runTmpCase(t, { ageSec: DAY_SEC - 1, status: 'esrch' });
  assert.deepEqual(r.deleted.files,[]);
  assert.deepEqual(r.remaining, [r.tmpName]);
});

test('prune: 所有プロセスが alive または unknown なら古くても残す', (t) => {
  for (const status of ['alive', 'unknown']) {
    const r = runTmpCase(t, { ageSec: DAY_SEC * 3, status });
    assert.deepEqual(r.deleted.files,[], status);
    assert.deepEqual(r.remaining, [r.tmpName], status);
  }
});

test('prune: stat や unlink の失敗は握りつぶし、他の削除は続ける', (t) => {
  const dir = writeFiles(mkTmp(t), {
    'agy-1.2.16.bin': 100, 'agy-1.3.0.bin': 300,
    'agy-1.0.0.bin': 1, 'agy-0.9.0.bin': 2,
  });
  const { deps } = pruneDeps({
    unlinkSync: (p) => { if (p.endsWith('agy-1.0.0.bin')) throw new Error('EPERM'); fs.unlinkSync(p); },
  });
  assert.deepEqual(bc.prune(deps, { dir, pinTag: '1.2.16' }).files, ['agy-0.9.0.bin']);
});

test('prune: stat に失敗したタグは消さない', (t) => {
  const dir = writeFiles(mkTmp(t), {
    'agy-1.2.16.bin': 100, 'agy-1.3.0.bin': 300, 'agy-1.0.0.bin': 5,
  });
  const { deps } = pruneDeps({
    statSync: (p) => { if (p.endsWith('agy-1.0.0.bin')) throw new Error('EIO'); return fs.statSync(p); },
  });
  const res = bc.prune(deps, { dir, pinTag: '1.2.16' });
  assert.deepEqual(res.files, []);
  assert.equal(res.count, 0);
  assert.equal(res.bytes, 0);
  assert.equal(fs.existsSync(path.join(dir, 'agy-1.0.0.bin')), true);
});

test('prune: readdir に失敗しても例外を投げず [] を返す', () => {
  const { deps } = pruneDeps({ readdirSync: () => { throw new Error('ENOENT'); } });
  const res = bc.prune(deps, { dir: '/nonexistent', pinTag: '1.2.16' });
  assert.deepEqual(res.files, []);
  assert.equal(res.count, 0);
  assert.equal(res.bytes, 0);
});

// --- listManualCleanup ---

test('listManualCleanup: 旧版・unverified・掃除対象外の agy- 名だけを一覧し、何も消さない', (t) => {
  const dir = writeFiles(mkTmp(t), {
    'agy.va39': 1, 'agy.bin': 1, '.version': 1, '.bin.tmp': 1,
    'agy-1.2.16.bin': 100,
    'agy-foo.bin': 1,
    'unverified/agy-1.2.16.va39': 1,
    'readme.txt': 1,
  });
  fs.writeFileSync(path.join(dir, 'agy.va39'), 'aaa');
  fs.writeFileSync(path.join(dir, 'agy.bin'), 'bbbb');
  fs.writeFileSync(path.join(dir, '.version'), 'c');
  fs.writeFileSync(path.join(dir, '.bin.tmp'), 'dd');
  fs.writeFileSync(path.join(dir, 'agy-foo.bin'), 'eeeee');
  fs.writeFileSync(path.join(dir, 'unverified', 'agy-1.2.16.va39'), 'ffffff');

  const r = bc.listManualCleanup({ readdirSync: fs.readdirSync, statSync: fs.statSync }, { dir });
  assert.deepEqual(r.files.map((f) => path.relative(dir, f.path)), [
    '.bin.tmp', '.version', 'agy-foo.bin', 'agy.va39', path.join('unverified', 'agy-1.2.16.va39'),
  ]);
  assert.equal(r.total, 2 + 1 + 5 + 3 + 6);
  assert.deepEqual(r.files.map((f) => f.size), [2, 1, 5, 3, 6]);
  // 何も消していないこと
  assert.equal(fs.existsSync(path.join(dir, 'agy-1.2.16.bin')), true);
  assert.equal(fs.existsSync(path.join(dir, 'readme.txt')), true);
});

test('listManualCleanup: stat に失敗した項目は飛ばす', (t) => {
  const dir = writeFiles(mkTmp(t), { 'agy.bin': 1, 'agy.va39': 1 });
  const r = bc.listManualCleanup({
    readdirSync: fs.readdirSync,
    statSync: (p) => { if (p.endsWith('agy.bin')) throw new Error('EIO'); return fs.statSync(p); },
  }, { dir });
  assert.deepEqual(r.files.map((f) => path.basename(f.path)), ['agy.va39']);
});

test('listManualCleanup: dir を読めなければ空の結果を返す', () => {
  const r = bc.listManualCleanup({
    readdirSync: () => { throw new Error('ENOENT'); },
    statSync: () => { throw new Error('ENOENT'); },
  }, { dir: '/nonexistent' });
  assert.deepEqual(r, { files: [], total: 0 });
});

// --- S2a: 名前・パス・ロックファイルの扱い ---

test('cacheFileName: 新世代は .va39r2、原本は .bin。タグの v 付きも同じ名前になる', () => {
  assert.equal(bc.cacheFileName('1.2.16', true), 'agy-1.2.16.va39r2');
  assert.equal(bc.cacheFileName('1.2.16', false), 'agy-1.2.16.bin');
  assert.equal(bc.cacheFileName('v1.2.16', true), 'agy-1.2.16.va39r2');
});

test('originalFileName / legacyPatchedFileName / lockFileName: 各世代とロックの名前を返す', () => {
  assert.equal(bc.originalFileName('1.2.16'), 'agy-1.2.16.bin');
  assert.equal(bc.legacyPatchedFileName('1.2.16'), 'agy-1.2.16.va39');
  assert.equal(bc.lockFileName('1.2.16'), 'agy-1.2.16.lock');
  // normalizeCacheTag を通すので v 付きでも同じ名前
  assert.equal(bc.originalFileName('v1.2.16'), 'agy-1.2.16.bin');
  assert.equal(bc.legacyPatchedFileName('v1.2.16'), 'agy-1.2.16.va39');
  assert.equal(bc.lockFileName('v1.2.16'), 'agy-1.2.16.lock');
  // 不正なタグは拒否する
  assert.throws(() => bc.lockFileName('../x'));
  assert.throws(() => bc.originalFileName('../x'));
  assert.throws(() => bc.legacyPatchedFileName('../x'));
});

test('cachePaths: file・original・legacy・lock を同じ dir の絶対パスで返す', () => {
  const p = bc.cachePaths({ dir: '/d', tag: '1.2.16', isPatch: true });
  assert.equal(p.dir, '/d');
  assert.equal(p.file, path.join('/d', 'agy-1.2.16.va39r2'));
  assert.equal(p.original, path.join('/d', 'agy-1.2.16.bin'));
  assert.equal(p.legacy, path.join('/d', 'agy-1.2.16.va39'));
  assert.equal(p.lock, path.join('/d', 'agy-1.2.16.lock'));
  // 非パッチ版でも original・legacy・lock は同じ
  const q = bc.cachePaths({ dir: '/d', tag: '1.2.16', isPatch: false });
  assert.equal(q.file, path.join('/d', 'agy-1.2.16.bin'));
  assert.equal(q.original, p.original);
  assert.equal(q.legacy, p.legacy);
  assert.equal(q.lock, p.lock);
});

test('prune: .va39r2・.va39・.bin を同じタグとして扱い、pin のタグは3種とも残す', (t) => {
  const dir = writeFiles(mkTmp(t), {
    'agy-1.2.16.va39r2': 100, 'agy-1.2.16.va39': 100, 'agy-1.2.16.bin': 100,
    'agy-1.3.0.va39r2': 300, 'agy-1.3.0.bin': 300,
    'agy-1.1.0.va39r2': 250, 'agy-1.1.0.va39': 250, 'agy-1.1.0.bin': 250,
    'agy-1.0.0.va39': 50,
  });
  const { deps } = pruneDeps();
  const deleted = bc.prune(deps, { dir, pinTag: '1.2.16' });
  // 1.3.0 が最新なので残し、1.1.0 と 1.0.0 は版ごとすべて消す
  assert.deepEqual(deleted.files.sort(), [
    'agy-1.0.0.va39', 'agy-1.1.0.bin', 'agy-1.1.0.va39', 'agy-1.1.0.va39r2',
  ]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'agy-1.2.16.bin', 'agy-1.2.16.va39', 'agy-1.2.16.va39r2',
    'agy-1.3.0.bin', 'agy-1.3.0.va39r2',
  ]);
});

test('prune: .lock は消さない(タグの版には数えず、残す)', (t) => {
  const dir = writeFiles(mkTmp(t), {
    'agy-1.2.16.va39r2': 100,
    'agy-1.0.0.bin': 50,
    'agy-1.0.0.lock': 1,
    'agy-1.1.0.bin': 250,
    'agy-1.1.0.lock': 250,
  });
  const { deps } = pruneDeps();
  const deleted = bc.prune(deps, { dir, pinTag: '1.2.16' });
  // 1.1.0 が pin 以外の最新なので残す。ロックは古いタグのものも消さない
  assert.deepEqual(deleted.files, ['agy-1.0.0.bin']);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'agy-1.0.0.lock', 'agy-1.1.0.bin', 'agy-1.1.0.lock', 'agy-1.2.16.va39r2',
  ]);
});

test('prune: ロック用の一時ファイル(agy-<tag>.lock.<pid>.<rand>.tmp)は、esrch かつ24時間以上前なら消す', (t) => {
  const name = 'agy-1.2.3.lock.123.ab12cd34.tmp';
  const dir = writeFiles(mkTmp(t), { [name]: NOW_SEC - DAY_SEC - 1 });
  const seen = { killPid: [] };
  const deps = {
    readdirSync: (d) => fs.readdirSync(d),
    statSync: (p) => fs.statSync(p),
    unlinkSync: (p) => fs.unlinkSync(p),
    killPid: (pid) => { seen.killPid.push(pid); return 'esrch'; },
    now: () => NOW_SEC * 1000,
  };
  const deleted = bc.prune(deps, { dir, pinTag: '9.9.9' });
  assert.deepEqual(deleted.files, [name]);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(seen.killPid, [123]);
});

test('prune: ロック用の一時ファイルは、所有 pid が生存なら残す', (t) => {
  const name = 'agy-1.2.3.lock.123.ab12cd34.tmp';
  const dir = writeFiles(mkTmp(t), { [name]: NOW_SEC - DAY_SEC - 1 });
  const { deps } = pruneDeps({ killPid: () => 'alive' });
  const deleted = bc.prune(deps, { dir, pinTag: '9.9.9' });
  assert.deepEqual(deleted.files, []);
  assert.deepEqual(fs.readdirSync(dir), [name]);
});

test('prune: ロック用の一時ファイルは、esrch でも24時間未満なら残す', (t) => {
  const name = 'agy-1.2.3.lock.123.ab12cd34.tmp';
  const dir = writeFiles(mkTmp(t), { [name]: NOW_SEC - DAY_SEC + 60 });
  const { deps } = pruneDeps({ killPid: () => 'esrch' });
  const deleted = bc.prune(deps, { dir, pinTag: '9.9.9' });
  assert.deepEqual(deleted.files, []);
  assert.deepEqual(fs.readdirSync(dir), [name]);
});

test('listManualCleanup: agy-<tag>.lock は手動削除候補に載らない。世代ファイルも載らない', (t) => {
  const dir = writeFiles(mkTmp(t), {
    'agy-1.2.16.lock': 1,
    'agy-1.2.16.va39r2': 1,
    'agy-1.2.16.bin': 1,
    'agy-foo.bin': 1,
  });
  const r = bc.listManualCleanup({ readdirSync: fs.readdirSync, statSync: fs.statSync }, { dir });
  assert.deepEqual(r.files.map((f) => path.basename(f.path)), ['agy-foo.bin']);
  assert.equal(fs.existsSync(path.join(dir, 'agy-1.2.16.lock')), true);
});
