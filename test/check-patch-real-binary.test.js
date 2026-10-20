'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { changedWordOffsets, bytesOutsideRanges } = require('../scripts/check-patch-real-binary.js');

test('bytesOutsideRanges: 4 バイト非整列の範囲でも、範囲内の変更は違反にならない', () => {
  const original = Buffer.alloc(32, 0);
  const patched = Buffer.from(original);
  patched[7] = 0xff;
  patched[8] = 0xff;
  patched[9] = 0xff;
  patched[10] = 0xff;
  const ranges = [{ start: 6, end: 14 }];
  assert.deepEqual(bytesOutsideRanges(original, patched, ranges), []);
});

test('bytesOutsideRanges: 範囲の外の変更は offset を返す', () => {
  const original = Buffer.alloc(32, 0);
  const patched = Buffer.from(original);
  patched[5] = 0xff;
  patched[20] = 0xff;
  const ranges = [{ start: 6, end: 14 }];
  assert.deepEqual(bytesOutsideRanges(original, patched, ranges), [5, 20]);
});

test('bytesOutsideRanges: 範囲の最後のバイトは内、end ちょうどは外', () => {
  const original = Buffer.alloc(32, 0);
  const ranges = [{ start: 6, end: 14 }];

  const inside = Buffer.from(original);
  inside[13] = 0xff;
  assert.deepEqual(bytesOutsideRanges(original, inside, ranges), []);

  const outside = Buffer.from(original);
  outside[14] = 0xff;
  assert.deepEqual(bytesOutsideRanges(original, outside, ranges), [14]);
});

test('bytesOutsideRanges: 変更が無ければ空', () => {
  const original = Buffer.alloc(32, 0);
  const patched = Buffer.from(original);
  const ranges = [{ start: 6, end: 14 }];
  assert.deepEqual(bytesOutsideRanges(original, patched, ranges), []);
});

test('changedWordOffsets: 4 バイト単位で異なる語の先頭 offset を返す', () => {
  const original = Buffer.alloc(16, 0);

  const one = Buffer.from(original);
  one[5] = 1;
  assert.deepEqual(changedWordOffsets(original, one), [4]);

  const two = Buffer.from(original);
  two[5] = 1;
  two[12] = 1;
  assert.deepEqual(changedWordOffsets(original, two), [4, 12]);
});
