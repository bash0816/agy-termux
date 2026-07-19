'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { computePrefixFromRealFilePath } = require('./agy.js');

test('computePrefixFromRealFilePath - standard npm global layout', async (t) => {
  await t.test('should derive prefix from the usr-side standard layout', () => {
    const realFilePath = '/data/data/com.termux/files/usr/lib/node_modules/@bash0816/agy-termux/bin/agy.js';
    const result = computePrefixFromRealFilePath(realFilePath);
    assert.equal(result, '/data/data/com.termux/files/usr');
  });

  await t.test('should derive prefix from a ~/.local-style secondary prefix', () => {
    const realFilePath = '/data/data/com.termux/files/home/.local/lib/node_modules/@bash0816/agy-termux/bin/agy.js';
    const result = computePrefixFromRealFilePath(realFilePath);
    assert.equal(result, '/data/data/com.termux/files/home/.local');
  });

  await t.test('should return null for an unexpected layout (defensive fallback)', () => {
    const realFilePath = '/some/unexpected/path/agy.js';
    const result = computePrefixFromRealFilePath(realFilePath);
    assert.equal(result, null);
  });

  await t.test('should return null when scope/package directory names do not match', () => {
    const realFilePath = '/data/data/com.termux/files/usr/lib/node_modules/@other-scope/agy-termux/bin/agy.js';
    const result = computePrefixFromRealFilePath(realFilePath);
    assert.equal(result, null);
  });

  await t.test('two different prefixes on the same machine resolve independently (regression for the dual-prefix bug)', () => {
    const usrSide = computePrefixFromRealFilePath(
      '/data/data/com.termux/files/usr/lib/node_modules/@bash0816/agy-termux/bin/agy.js'
    );
    const localSide = computePrefixFromRealFilePath(
      '/data/data/com.termux/files/home/.local/lib/node_modules/@bash0816/agy-termux/bin/agy.js'
    );
    assert.notEqual(usrSide, localSide, 'each prefix should resolve to its own distinct path, not silently collapse to the default');
  });
});
