'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bc = require('../lib/binary-cache.js');
const { buildExpectation } = require('../lib/va39-expectation');

const MIN_SIZE = 10 * 1024 * 1024;
const ELF_HEAD = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const NOT_ELF_HEAD = Buffer.from('ABCD', 'ascii');
const COUNTS = { ubfx: 1, lsl: 1, mask: 1, mmap: 1, word: 1 };
const TAG = 'v1.2.3';

// 有効な新記録の期待値(va39-entry.test.js と同じ fixture)
function validExpectation() {
  return buildExpectation(
    { ...COUNTS, containers: [{ kind: 'main', offset: 0, size: MIN_SIZE, counts: { ...COUNTS } }] },
    { patchedSha256: 'a'.repeat(64), patchedSize: MIN_SIZE, rev: 1 },
  );
}

// 一時ディレクトリを作り、関数の終了後に削除する
function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-inspect-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 先頭に head を書き、size まで伸ばした疎ファイルを作る(実際のディスク使用量はほぼゼロ)
function writeCacheFile(file, size, head = ELF_HEAD) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, head, 0, head.length, 0);
    fs.ftruncateSync(fd, size);
  } finally {
    fs.closeSync(fd);
  }
}

// --- inspectFile ---

test('inspectFile: ファイルが無ければ missing', () => {
  withDir((dir) => {
    assert.equal(bc.inspectFile({ file: path.join(dir, 'agy-1.2.3.bin') }), 'missing');
  });
});

test('inspectFile: 10MiB 未満のファイルは invalid', () => {
  withDir((dir) => {
    const file = path.join(dir, 'agy-1.2.3.bin');
    writeCacheFile(file, MIN_SIZE - 1);
    assert.equal(bc.inspectFile({ file }), 'invalid');
  });
});

test('inspectFile: 10MiB 以上でも先頭が ELF でなければ invalid', () => {
  withDir((dir) => {
    const file = path.join(dir, 'agy-1.2.3.bin');
    writeCacheFile(file, MIN_SIZE, NOT_ELF_HEAD);
    assert.equal(bc.inspectFile({ file }), 'invalid');
  });
});

test('inspectFile: 10MiB 以上で先頭が ELF マジックなら ok', () => {
  withDir((dir) => {
    const file = path.join(dir, 'agy-1.2.3.bin');
    writeCacheFile(file, MIN_SIZE, ELF_HEAD);
    assert.equal(bc.inspectFile({ file }), 'ok');
  });
});

test('inspectFile: expectedSize を指定するとサイズ一致のときだけ ok', () => {
  withDir((dir) => {
    const file = path.join(dir, 'agy-1.2.3.va39r2');
    writeCacheFile(file, MIN_SIZE + 1, ELF_HEAD);
    assert.equal(bc.inspectFile({ file, expectedSize: MIN_SIZE }), 'invalid');
    assert.equal(bc.inspectFile({ file, expectedSize: MIN_SIZE + 1 }), 'ok');
  });
});

// --- inspectPinned ---
// readPinnedMeta・needsPatch・fs・env は注入し、通信や実環境の設定に依存しないようにする

test('inspectPinned: AGY_TERMUX_FORCE_LATEST=1 なら unknown で readPinnedMeta を呼ばない', () => {
  withDir((dir) => {
    let called = false;
    const r = bc.inspectPinned({
      installDir: dir,
      env: { AGY_TERMUX_FORCE_LATEST: '1' },
      readPinnedMeta: () => { called = true; return { tagName: TAG, expectation: undefined }; },
      needsPatch: () => false,
    });
    assert.deepEqual(r, { state: 'unknown', tag: null });
    assert.equal(called, false);
  });
});

test('inspectPinned: readPinnedMeta が例外を投げたら unknown', () => {
  withDir((dir) => {
    const r = bc.inspectPinned({
      installDir: dir,
      env: {},
      readPinnedMeta: () => { throw new Error('設定が読めません'); },
      needsPatch: () => false,
    });
    assert.deepEqual(r, { state: 'unknown', tag: null });
  });
});

test('inspectPinned: 非パッチ(VA48 相当)は agy-<tag>.bin の状態を見る。期待サイズは使わない', () => {
  const meta = { tagName: TAG, expectation: { va39_patched_size: 1 } };
  const readPinnedMeta = () => meta;
  const needsPatch = () => false;

  withDir((dir) => {
    const r = bc.inspectPinned({ installDir: dir, env: {}, readPinnedMeta, needsPatch });
    assert.deepEqual(r, { state: 'missing', tag: TAG });
  });

  withDir((dir) => {
    writeCacheFile(path.join(dir, 'agy-1.2.3.bin'), MIN_SIZE + 5, ELF_HEAD);
    const r = bc.inspectPinned({ installDir: dir, env: {}, readPinnedMeta, needsPatch });
    assert.deepEqual(r, { state: 'ok', tag: TAG });
  });

  withDir((dir) => {
    writeCacheFile(path.join(dir, 'agy-1.2.3.bin'), MIN_SIZE, NOT_ELF_HEAD);
    const r = bc.inspectPinned({ installDir: dir, env: {}, readPinnedMeta, needsPatch });
    assert.deepEqual(r, { state: 'invalid', tag: TAG });
  });
});

test('inspectPinned: パッチ版は agy-<tag>.va39r2 と期待サイズで判定し、旧 .va39 は見ない', () => {
  const meta = { tagName: TAG, expectation: validExpectation() };
  const readPinnedMeta = () => meta;
  const needsPatch = () => true;
  const expected = meta.expectation.va39_patched_size;

  withDir((dir) => {
    writeCacheFile(path.join(dir, 'agy-1.2.3.va39r2'), expected, ELF_HEAD);
    const r = bc.inspectPinned({ installDir: dir, env: {}, readPinnedMeta, needsPatch });
    assert.deepEqual(r, { state: 'ok', tag: TAG });
  });

  withDir((dir) => {
    writeCacheFile(path.join(dir, 'agy-1.2.3.va39r2'), expected + 1, ELF_HEAD);
    const r = bc.inspectPinned({ installDir: dir, env: {}, readPinnedMeta, needsPatch });
    assert.deepEqual(r, { state: 'invalid', tag: TAG });
  });

  withDir((dir) => {
    const r = bc.inspectPinned({ installDir: dir, env: {}, readPinnedMeta, needsPatch });
    assert.deepEqual(r, { state: 'missing', tag: TAG });
  });

  withDir((dir) => {
    writeCacheFile(path.join(dir, 'agy-1.2.3.va39'), expected, ELF_HEAD);
    const r = bc.inspectPinned({ installDir: dir, env: {}, readPinnedMeta, needsPatch });
    assert.deepEqual(r, { state: 'missing', tag: TAG });
  });
});

test('inspectPinned: パッチ端末で期待値が欠落していれば unknown', () => {
  withDir((dir) => {
    const r = bc.inspectPinned({
      installDir: dir,
      env: {},
      readPinnedMeta: () => ({ tagName: TAG, expectation: undefined }),
      needsPatch: () => true,
    });
    assert.deepEqual(r, { state: 'unknown', tag: null });
  });
});

test('inspectPinned: タグの形式が不正なら unknown', () => {
  withDir((dir) => {
    const r = bc.inspectPinned({
      installDir: dir,
      env: {},
      readPinnedMeta: () => ({ tagName: 'latest', expectation: undefined }),
      needsPatch: () => false,
    });
    assert.deepEqual(r, { state: 'unknown', tag: null });
  });
});
