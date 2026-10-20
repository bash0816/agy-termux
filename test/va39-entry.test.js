'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bc = require('../lib/binary-cache.js');
const { buildExpectation } = require('../lib/va39-expectation');
const { VA39_CODES } = require('../lib/errors');

const MIN_SIZE = 10 * 1024 * 1024;
const ELF_HEAD = [0x7f, 0x45, 0x4c, 0x46];
const COUNTS = { ubfx: 1, lsl: 1, mask: 1, mmap: 1, word: 1 };

// 有効な新記録の期待値(buildExpectation は不正なら投げるので、ここで作れていれば有効)
function validExpectation() {
  return buildExpectation(
    { ...COUNTS, containers: [{ kind: 'main', offset: 0, size: MIN_SIZE, counts: { ...COUNTS } }] },
    { patchedSha256: 'a'.repeat(64), patchedSize: MIN_SIZE, rev: 1 },
  );
}

const META = { tagName: '1.2.16' };

function expectEntryError(fn) {
  assert.throws(fn, (e) => e && e.code === VA39_CODES.EXPECTATION_MISSING);
}

// --- assertVa39Entry ---

test('assertVa39Entry: VA39 pin で期待値が無ければ EXPECTATION_MISSING を投げる', () => {
  expectEntryError(() => bc.assertVa39Entry({ ...META, expectation: undefined }, { isPatch: true, unverified: false }));
});

test('assertVa39Entry: VA39 pin で期待値が不正(breakdown が空)なら投げる', () => {
  const exp = { ...validExpectation(), va39_patch_breakdown: [] };
  expectEntryError(() => bc.assertVa39Entry({ ...META, expectation: exp }, { isPatch: true, unverified: false }));
});

test('assertVa39Entry: VA39 pin で旧記録(counts のみ)は allowLegacy false のため投げる', () => {
  const legacy = { va39_patch_counts: { ...COUNTS } };
  expectEntryError(() => bc.assertVa39Entry({ ...META, expectation: legacy }, { isPatch: true, unverified: false }));
});

test('assertVa39Entry: VA39 pin で有効な新記録なら投げない', () => {
  assert.doesNotThrow(() =>
    bc.assertVa39Entry({ ...META, expectation: validExpectation() }, { isPatch: true, unverified: false }),
  );
});

test('assertVa39Entry: VA48(isPatch false)は期待値が不正でも投げない', () => {
  assert.doesNotThrow(() =>
    bc.assertVa39Entry({ ...META, expectation: undefined }, { isPatch: false, unverified: false }),
  );
});

test('assertVa39Entry: unverified は期待値が不正でも投げない', () => {
  assert.doesNotThrow(() =>
    bc.assertVa39Entry({ ...META, expectation: undefined }, { isPatch: true, unverified: true }),
  );
});

// --- isCacheValid の expectedSize ---

// 実ファイルに触れない偽 fsDeps。サイズと先頭 4 バイト(ELF)を指定できる
function fakeFs({ size, head = ELF_HEAD }) {
  return {
    existsSync: () => true,
    statSync: () => ({ size }),
    openSync: () => 3,
    readSync: (fd, buf) => {
      for (let i = 0; i < 4; i++) buf[i] = head[i];
      return 4;
    },
    closeSync: () => {},
  };
}

const FILE = '/virtual/agy-1.2.16.va39r2';

test('isCacheValid: expectedSize と一致するサイズなら true', () => {
  const size = MIN_SIZE + 5;
  assert.equal(bc.isCacheValid(fakeFs({ size }), FILE, { expectedSize: size }), true);
});

test('isCacheValid: expectedSize と一致しなければ false(1 バイトずれても)', () => {
  const size = MIN_SIZE + 5;
  assert.equal(bc.isCacheValid(fakeFs({ size }), FILE, { expectedSize: size + 1 }), false);
  assert.equal(bc.isCacheValid(fakeFs({ size }), FILE, { expectedSize: size - 1 }), false);
});

test('isCacheValid: 第3引数なし、または expectedSize が数値でなければ従来どおり(サイズ不一致の検査は無い)', () => {
  const size = MIN_SIZE + 5;
  assert.equal(bc.isCacheValid(fakeFs({ size }), FILE), true);
  assert.equal(bc.isCacheValid(fakeFs({ size }), FILE, {}), true);
  assert.equal(bc.isCacheValid(fakeFs({ size }), FILE, { expectedSize: undefined }), true);
  assert.equal(bc.isCacheValid(fakeFs({ size }), FILE, { expectedSize: null }), true);
});

test('isCacheValid: expectedSize を指定しても 10MiB 未満や ELF 不一致は false のまま', () => {
  assert.equal(bc.isCacheValid(fakeFs({ size: MIN_SIZE - 1 }), FILE, { expectedSize: MIN_SIZE - 1 }), false);
  assert.equal(bc.isCacheValid(fakeFs({ size: MIN_SIZE, head: [0x7f, 0x45, 0x4c, 0x00] }), FILE, { expectedSize: MIN_SIZE }), false);
});
