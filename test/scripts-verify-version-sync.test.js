'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readPatcherRev } = require('../scripts/lib/va39-baseline');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verify-version-sync.js');
const REPO_REV = readPatcherRev();

function fiveFields(rev) {
  return {
    va39_patcher_rev: rev,
    va39_patch_counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 13 },
    va39_patch_breakdown: [
      { kind: 'main', offset: 0, size: 100, counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 13 } },
    ],
    va39_patched_sha256: 'a'.repeat(64),
    va39_patched_size: 1000,
  };
}

function setup(t, verified, pkgVersion = '1.3.2') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-sync-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agy', version: pkgVersion }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'config', 'agy-verified-versions.json'), JSON.stringify(verified, null, 2) + '\n');
  return dir;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('old schema (no VA39 fields at all) is accepted by default', (t) => {
  const dir = setup(t, { tag_name: '1.3.2' });
  const r = run(dir, []);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /version sync verified: 1\.3\.2/);
});

test('legacy record with va39_patch_counts only is accepted by default', (t) => {
  const dir = setup(t, { tag_name: '1.3.2', va39_patch_counts: { ubfx: 4, lsl: 19, mask: 0, mmap: 6, word: 7 } });
  const r = run(dir, []);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /version sync verified: 1\.3\.2/);
});

test('new fields without va39_patcher_rev are an inconsistency and fail', (t) => {
  const full = fiveFields(2);
  const dir = setup(t, { tag_name: '1.3.2', va39_patch_breakdown: full.va39_patch_breakdown });
  const r = run(dir, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /va39_patcher_rev がないのに他の VA39 欄があります: va39_patch_breakdown/);
});

test('legacy record (counts only) fails under --require-current-rev', (t) => {
  const dir = setup(t, { tag_name: '1.3.2', va39_patch_counts: { ubfx: 4, lsl: 19, mask: 0, mmap: 6, word: 7 } });
  const r = run(dir, ['--require-current-rev']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /揃っていません。欠落: va39_patcher_rev/);
});

test('partial five fields fail with the missing names listed', (t) => {
  const full = fiveFields(2);
  const partial = { tag_name: '1.3.2', va39_patcher_rev: full.va39_patcher_rev, va39_patched_size: full.va39_patched_size };
  const dir = setup(t, partial);
  const r = run(dir, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /欠落: va39_patch_counts, va39_patch_breakdown, va39_patched_sha256/);
});

test('complete five fields pass', (t) => {
  const dir = setup(t, Object.assign({ tag_name: '1.3.2' }, fiveFields(2)));
  const r = run(dir, []);
  assert.equal(r.status, 0, r.stderr);
});

test('malformed field is reported by name', (t) => {
  const bad = Object.assign({ tag_name: '1.3.2' }, fiveFields(2), { va39_patched_sha256: 'NOT-HEX' });
  const dir = setup(t, bad);
  const r = run(dir, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /不正な欄: va39_patched_sha256/);
});

test('--require-current-rev fails when the five fields are missing', (t) => {
  const dir = setup(t, { tag_name: '1.3.2' });
  const r = run(dir, ['--require-current-rev']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /必須/);
});

test('--require-current-rev fails on rev mismatch', (t) => {
  const dir = setup(t, Object.assign({ tag_name: '1.3.2' }, fiveFields(REPO_REV + 1)));
  const r = run(dir, ['--require-current-rev']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /va39_patcher_rev が現在の patcher rev と一致しません/);
});

test('--require-current-rev passes on rev match', (t) => {
  const dir = setup(t, Object.assign({ tag_name: '1.3.2' }, fiveFields(REPO_REV)));
  const r = run(dir, ['--require-current-rev']);
  assert.equal(r.status, 0, r.stderr);
});

test('unknown argument exits 1', (t) => {
  const dir = setup(t, { tag_name: '1.3.2' });
  const r = run(dir, ['--bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未知の引数/);
});

test('version mismatch still fails', (t) => {
  const dir = setup(t, { tag_name: '1.3.2' }, '1.3.3');
  const r = run(dir, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /version mismatch/);
});
