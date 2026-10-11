'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createConsent } = require('../lib/consent.js');

// ---- テスト用ヘルパー ----

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'consent-test-'));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeStderr() {
  const chunks = [];
  return {
    write(s) {
      chunks.push(String(s));
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

// setRawMode が呼ばれたら失敗する stdin（呼ばれた回数も記録する）
function makeTtyStdin(isTTY = true) {
  const rawCalls = [];
  return {
    isTTY,
    rawCalls,
    setRawMode(v) {
      rawCalls.push(v);
      throw new Error('setRawMode は呼んではいけない');
    },
  };
}

// 偽の readline。script(rl, question, cb) で回答の振る舞いを決める。
function makeFakeReadline(script) {
  const instances = [];
  const options = [];
  return {
    instances,
    options,
    createInterface(opts) {
      options.push(opts);
      const rl = new EventEmitter();
      rl.questions = [];
      rl.closeCount = 0;
      rl.closed = false;
      rl.question = (q, cb) => {
        rl.questions.push(q);
        if (script) script(rl, q, cb);
      };
      rl.close = () => {
        rl.closeCount++;
        if (rl.closed) return;
        rl.closed = true;
        rl.emit('close');
      };
      instances.push(rl);
      return rl;
    },
  };
}

// 指定の文字列で回答する（実 readline と同じく非同期に返す）
const answerWith = (text) => (rl, q, cb) => setImmediate(() => cb(text));
// 回答せずに閉じる（EOF / Ctrl-D 相当）
const eofReply = (rl) => setImmediate(() => rl.close());

// gateDownload / gateCompat の共通セットアップ
function build(dir, { isTTY = true, reply, fsImpl = fs } = {}) {
  const file = path.join(dir, 'home', '.agy-termux', '.consent');
  const stderr = makeStderr();
  const readline = makeFakeReadline(reply);
  const stdin = makeTtyStdin(isTTY);
  const c = createConsent({ file, fs: fsImpl, stdin, stderr, readline });
  return { c, file, stderr, readline, stdin };
}

// ---- hasConsent ----

test('hasConsent: ファイルが無ければ false', () => {
  const dir = makeTmpDir();
  try {
    const { c } = build(dir);
    assert.strictEqual(c.hasConsent('download'), false);
  } finally {
    rmTmp(dir);
  }
});

test('hasConsent: 壊れた JSON なら false', () => {
  const dir = makeTmpDir();
  try {
    const { c, file } = build(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{bad json');
    assert.strictEqual(c.hasConsent('download'), false);
  } finally {
    rmTmp(dir);
  }
});

test('hasConsent: キーが無ければ false', () => {
  const dir = makeTmpDir();
  try {
    const { c, file } = build(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ compat: true }));
    assert.strictEqual(c.hasConsent('download'), false);
  } finally {
    rmTmp(dir);
  }
});

test('hasConsent: キーが有れば true', () => {
  const dir = makeTmpDir();
  try {
    const { c, file } = build(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ download: true }));
    assert.strictEqual(c.hasConsent('download'), true);
  } finally {
    rmTmp(dir);
  }
});

// ---- saveConsent ----

test('saveConsent: 新規作成（親ディレクトリも作る）', () => {
  const dir = makeTmpDir();
  try {
    const { c, file } = build(dir);
    c.saveConsent('download');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { download: true });
  } finally {
    rmTmp(dir);
  }
});

test('saveConsent: 既存キーを保持したまま追加する', () => {
  const dir = makeTmpDir();
  try {
    const { c, file } = build(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ compat: true }));
    c.saveConsent('download');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      compat: true,
      download: true,
    });
  } finally {
    rmTmp(dir);
  }
});

test('saveConsent: 実ファイルでは最終的に同意ファイルだけが残る（一時ファイルが残らない）', () => {
  const dir = makeTmpDir();
  try {
    const { c, file } = build(dir);
    c.saveConsent('download');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['.consent']);
    assert.ok(fs.existsSync(file));
  } finally {
    rmTmp(dir);
  }
});

test('saveConsent: 書込みは一時ファイルへ行われ、その後 rename で置換される（順序と引数）', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'home', '.consent');
    const calls = [];
    const fakeFs = {
      readFileSync() {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      },
      mkdirSync(d, o) {
        calls.push(['mkdirSync', d, o]);
      },
      writeFileSync(p, data) {
        calls.push(['writeFileSync', p, data]);
      },
      renameSync(a, b) {
        calls.push(['renameSync', a, b]);
      },
      unlinkSync(p) {
        calls.push(['unlinkSync', p]);
      },
    };
    const c = createConsent({
      file,
      fs: fakeFs,
      stdin: makeTtyStdin(),
      stderr: makeStderr(),
      readline: makeFakeReadline(null),
    });
    c.saveConsent('download');
    const tmp = file + '.' + process.pid + '.tmp';
    assert.deepStrictEqual(
      calls.map((x) => x[0]),
      ['mkdirSync', 'writeFileSync', 'renameSync']
    );
    assert.deepStrictEqual(calls[0], [
      'mkdirSync',
      path.dirname(file),
      { recursive: true },
    ]);
    assert.strictEqual(calls[1][1], tmp);
    assert.deepStrictEqual(JSON.parse(calls[1][2]), { download: true });
    assert.deepStrictEqual(calls[2], ['renameSync', tmp, file]);
  } finally {
    rmTmp(dir);
  }
});

test('saveConsent: 書込み失敗は元の例外のまま投げ直され、元ファイルは壊れず、一時ファイルの unlink が試みられる', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, '.consent');
    const original = JSON.stringify({ compat: true });
    fs.writeFileSync(file, original);
    const boom = new Error('disk full');
    const unlinked = [];
    const fakeFs = Object.assign({}, fs, {
      writeFileSync() {
        throw boom;
      },
      renameSync() {
        throw new Error('rename は呼ばれてはいけない');
      },
      unlinkSync(p) {
        unlinked.push(p);
        throw new Error('ENOENT（一時ファイルは無い）');
      },
    });
    const c = createConsent({
      file,
      fs: fakeFs,
      stdin: makeTtyStdin(),
      stderr: makeStderr(),
      readline: makeFakeReadline(null),
    });
    assert.throws(() => c.saveConsent('download'), (err) => err === boom);
    assert.deepStrictEqual(unlinked, [file + '.' + process.pid + '.tmp']);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  } finally {
    rmTmp(dir);
  }
});

test('saveConsent: rename 失敗は元の例外のまま投げ直され、一時ファイルは削除され、元ファイルは壊れない', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, '.consent');
    const original = JSON.stringify({ compat: true });
    fs.writeFileSync(file, original);
    const boom = new Error('rename failed');
    const tmp = file + '.' + process.pid + '.tmp';
    const unlinked = [];
    const fakeFs = Object.assign({}, fs, {
      renameSync() {
        throw boom;
      },
      unlinkSync(p) {
        unlinked.push(p);
        fs.unlinkSync(p); // 実際の一時ファイルを削除する
      },
    });
    const c = createConsent({
      file,
      fs: fakeFs,
      stdin: makeTtyStdin(),
      stderr: makeStderr(),
      readline: makeFakeReadline(null),
    });
    assert.throws(() => c.saveConsent('download'), (err) => err === boom);
    assert.deepStrictEqual(unlinked, [tmp]);
    assert.ok(!fs.existsSync(tmp));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  } finally {
    rmTmp(dir);
  }
});

// ---- ask ----

test('ask: 非 TTY では質問せず null を返し、readline を作らない', async () => {
  const dir = makeTmpDir();
  try {
    const readline = makeFakeReadline(answerWith('y'));
    const c = createConsent({
      file: path.join(dir, '.consent'),
      fs,
      stdin: makeTtyStdin(false),
      stderr: makeStderr(),
      readline,
    });
    assert.strictEqual(await c.ask('続けますか？ '), null);
    assert.strictEqual(readline.instances.length, 0);
  } finally {
    rmTmp(dir);
  }
});

test('ask: TTY では terminal:false で readline を作り、質問を出す', async () => {
  const dir = makeTmpDir();
  try {
    const readline = makeFakeReadline(answerWith('y'));
    const stdin = makeTtyStdin(true);
    const stderr = makeStderr();
    const c = createConsent({
      file: path.join(dir, '.consent'),
      fs,
      stdin,
      stderr,
      readline,
    });
    assert.strictEqual(await c.ask('Q? '), 'y');
    assert.strictEqual(readline.options.length, 1);
    assert.strictEqual(readline.options[0].terminal, false);
    assert.strictEqual(readline.options[0].input, stdin);
    assert.strictEqual(readline.options[0].output, stderr);
    assert.deepStrictEqual(readline.instances[0].questions, ['Q? ']);
  } finally {
    rmTmp(dir);
  }
});

test('ask: 回答は trim と小文字化をして返す', async () => {
  const dir = makeTmpDir();
  try {
    const { c } = build(dir, { reply: answerWith('  YeS \n') });
    assert.strictEqual(await c.ask('Q? '), 'yes');
  } finally {
    rmTmp(dir);
  }
});

test('ask: 質問ごとに新しい Interface を作り、それぞれ close する', async () => {
  const dir = makeTmpDir();
  try {
    const { c, readline } = build(dir, { reply: answerWith('a') });
    await c.ask('Q1? ');
    await c.ask('Q2? ');
    assert.strictEqual(readline.instances.length, 2);
    assert.strictEqual(readline.instances[0].closeCount, 1);
    assert.strictEqual(readline.instances[1].closeCount, 1);
  } finally {
    rmTmp(dir);
  }
});

test('ask: 回答が無いまま close（EOF）したら null', async () => {
  const dir = makeTmpDir();
  try {
    const { c } = build(dir, { reply: eofReply });
    assert.strictEqual(await c.ask('Q? '), null);
  } finally {
    rmTmp(dir);
  }
});

test('ask: setRawMode は呼ばれない', async () => {
  const dir = makeTmpDir();
  try {
    const { c, stdin } = build(dir, { reply: answerWith('y') });
    assert.strictEqual(await c.ask('Q? '), 'y');
    assert.deepStrictEqual(stdin.rawCalls, []);
  } finally {
    rmTmp(dir);
  }
});

// ---- gateDownload / gateCompat ----

const gates = [
  ['download', 'gateDownload'],
  ['compat', 'gateCompat'],
];

for (const [key, method] of gates) {
  test(`${method}: 同意済みなら質問せず 'granted'`, async () => {
    const dir = makeTmpDir();
    try {
      const { c, file, readline } = build(dir, { reply: answerWith('n') });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ [key]: true }));
      assert.strictEqual(await c[method](), 'granted');
      assert.strictEqual(readline.instances.length, 0);
    } finally {
      rmTmp(dir);
    }
  });

  test(`${method}: 非 TTY では 'no_input'（質問なし・保存なし）`, async () => {
    const dir = makeTmpDir();
    try {
      const { c, file, readline, stderr } = build(dir, { isTTY: false, reply: answerWith('y') });
      assert.strictEqual(await c[method](), 'no_input');
      assert.strictEqual(readline.instances.length, 0);
      assert.strictEqual(fs.existsSync(file), false);
      assert.ok(stderr.text().includes('[agy]'));
    } finally {
      rmTmp(dir);
    }
  });

  for (const answer of ['n', 'no']) {
    test(`${method}: 回答 '${answer}' は 'declined'（保存しない）`, async () => {
      const dir = makeTmpDir();
      try {
        const { c, file, readline } = build(dir, { reply: answerWith(answer) });
        assert.strictEqual(await c[method](), 'declined');
        assert.strictEqual(fs.existsSync(file), false);
        assert.strictEqual(readline.instances[0].closeCount, 1);
      } finally {
        rmTmp(dir);
      }
    });
  }

  for (const answer of ['', 'y']) {
    test(`${method}: 回答 '${answer}' は 'granted' かつ保存する`, async () => {
      const dir = makeTmpDir();
      try {
        const { c, file, readline } = build(dir, { reply: answerWith(answer) });
        assert.strictEqual(await c[method](), 'granted');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [key]: true });
        assert.deepStrictEqual(readline.instances[0].questions, ['続けますか？ [Y/n] ']);
      } finally {
        rmTmp(dir);
      }
    });
  }

  test(`${method}: EOF なら 'no_input'（保存しない）`, async () => {
    const dir = makeTmpDir();
    try {
      const { c, file } = build(dir, { reply: eofReply });
      assert.strictEqual(await c[method](), 'no_input');
      assert.strictEqual(fs.existsSync(file), false);
    } finally {
      rmTmp(dir);
    }
  });

  test(`${method}: 保存失敗の例外は呼び出し側へ伝わる`, async () => {
    const dir = makeTmpDir();
    try {
      const boom = new Error('boom');
      const fakeFs = Object.assign({}, fs, {
        readFileSync() {
          const e = new Error('ENOENT');
          e.code = 'ENOENT';
          throw e;
        },
        writeFileSync() {
          throw boom;
        },
      });
      const { c } = build(dir, { reply: answerWith(''), fsImpl: fakeFs });
      await assert.rejects(c[method](), (err) => err === boom);
    } finally {
      rmTmp(dir);
    }
  });
}

test('gateDownload: 説明文を stderr に出す', async () => {
  const dir = makeTmpDir();
  try {
    const { c, stderr } = build(dir, { reply: answerWith('n') });
    await c.gateDownload();
    assert.ok(stderr.text().includes('Google のサーバーからダウンロードします。'));
  } finally {
    rmTmp(dir);
  }
});

test('gateCompat: 説明文の2行を stderr に出す', async () => {
  const dir = makeTmpDir();
  try {
    const { c, stderr } = build(dir, { reply: answerWith('n') });
    await c.gateCompat();
    const text = stderr.text();
    assert.ok(text.includes('[agy] このデバイスでの起動には互換性のための技術的な調整が必要です。\n'));
    assert.ok(text.includes('      配布元のファイルは変更せず、この端末に保存するコピーだけを調整します。\n'));
  } finally {
    rmTmp(dir);
  }
});
