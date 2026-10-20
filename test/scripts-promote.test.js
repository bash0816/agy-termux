'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'promote-agy-candidate.js');

function expectation(overrides = {}) {
  return Object.assign({
    va39_patcher_rev: 2,
    va39_patch_counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 13 },
    va39_patch_breakdown: [
      { kind: 'main', offset: 0, size: 100, counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 13 } },
    ],
    va39_patched_sha256: 'a'.repeat(64),
    va39_patched_size: 1000,
  }, overrides);
}

function candidateMeta(overrides = {}) {
  return Object.assign({
    tag_name: '1.3.3',
    download_url: 'https://example.invalid/agy-1.3.3.tar.gz',
    sha256_tar: 'b'.repeat(64),
    sha256_binary: 'c'.repeat(64),
    release_id: 1,
    asset_id: 2,
    asset_updated_at: '2026-10-01T00:00:00Z',
    source_repo: 'example/agy',
    status: 'pending_device_verification',
  }, expectation(), overrides);
}

function verifiedMeta(overrides = {}) {
  return Object.assign({
    tag_name: '1.3.2',
    download_url: 'https://example.invalid/agy-1.3.2.tar.gz',
    sha256_tar: 'd'.repeat(64),
    sha256_binary: 'e'.repeat(64),
  }, expectation(), overrides);
}

function setup(t, { candidate, verified, pkgVersion = '1.3.2' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agy', version: pkgVersion }, null, 2) + '\n');
  if (candidate !== undefined) {
    fs.writeFileSync(path.join(dir, 'config', 'agy-candidate-version.json'), JSON.stringify(candidate, null, 2) + '\n');
  }
  if (verified !== undefined) {
    fs.writeFileSync(path.join(dir, 'config', 'agy-verified-versions.json'), JSON.stringify(verified, null, 2) + '\n');
  }
  return dir;
}

function run(cwd, args, extraEnv = {}) {
  const env = Object.assign({}, process.env, extraEnv);
  delete env.CI;
  delete env.AGY_PROMOTE_ALLOW_CI;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8' });
}

function readVerified(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config', 'agy-verified-versions.json'), 'utf8'));
}

test('(1) all same: promotes and writes the five fields into verified', (t) => {
  const dir = setup(t, {
    candidate: candidateMeta(),
    verified: verifiedMeta(),
  });
  const r = run(dir, ['1.3.3', '--confirm-device-verified']);
  assert.equal(r.status, 0, r.stderr);
  const v = readVerified(dir);
  assert.equal(v.tag_name, '1.3.3');
  assert.equal(v.va39_patcher_rev, 2);
  assert.deepEqual(v.va39_patch_counts, expectation().va39_patch_counts);
  assert.deepEqual(v.va39_patch_breakdown, expectation().va39_patch_breakdown);
  assert.equal(v.va39_patched_sha256, 'a'.repeat(64));
  assert.equal(v.va39_patched_size, 1000);
  assert.ok(!('va39_patch_regression' in v));
  assert.match(v.notes, /no regression from the prior verified version/);
});

test('(2) changed without approval: exits 1 and shows the differences', (t) => {
  const dir = setup(t, {
    candidate: candidateMeta(),
    verified: verifiedMeta({
      va39_patch_counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 12 },
      va39_patch_breakdown: [
        { kind: 'main', offset: 0, size: 100, counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 12 } },
      ],
    }),
  });
  const r = run(dir, ['1.3.3', '--confirm-device-verified']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /counts\.word: 12 -> 13/);
  assert.match(r.stderr, /--approve-count-change/);
  assert.equal(readVerified(dir).tag_name, '1.3.2', 'verified must not be overwritten');
});

test('(3) changed with approval: succeeds and puts the reason into notes', (t) => {
  const dir = setup(t, {
    candidate: candidateMeta(),
    verified: verifiedMeta({
      va39_patch_counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 12 },
      va39_patch_breakdown: [
        { kind: 'main', offset: 0, size: 100, counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 12 } },
      ],
    }),
  });
  const r = run(dir, ['1.3.3', '--confirm-device-verified', '--approve-count-change', 'word patch added in 1.3.3']);
  assert.equal(r.status, 0, r.stderr);
  const notes = readVerified(dir).notes;
  assert.match(notes, /VA39 expectation change approved: word patch added in 1.3.3/);
  assert.match(notes, /changed: counts\.word: 12 -> 13/);
  assert.doesNotMatch(notes, /no regression from the prior verified version/);
});

test('(4) baseline_missing (verified is old schema): fails without approval, succeeds with approval', (t) => {
  const oldSchema = { tag_name: '1.3.2', va39_patch_counts: { ubfx: 4, lsl: 19, mask: 0, mmap: 6, word: 7 } };

  const dirNo = setup(t, { candidate: candidateMeta(), verified: oldSchema });
  const rNo = run(dirNo, ['1.3.3', '--confirm-device-verified']);
  assert.equal(rNo.status, 1);
  assert.match(rNo.stderr, /baseline_missing/);
  assert.equal(readVerified(dirNo).tag_name, '1.3.2');

  const dirYes = setup(t, { candidate: candidateMeta(), verified: oldSchema });
  const rYes = run(dirYes, ['1.3.3', '--confirm-device-verified', '--approve-count-change', 'first five-field record']);
  assert.equal(rYes.status, 0, rYes.stderr);
  const v = readVerified(dirYes);
  assert.equal(v.va39_patched_size, 1000);
  assert.match(v.notes, /VA39 expectation change approved: first five-field record \(baseline_missing:/);
});

test('(5) incomplete candidate five fields: exits 1', (t) => {
  const broken = candidateMeta();
  delete broken.va39_patched_sha256;
  const dir = setup(t, { candidate: broken, verified: verifiedMeta() });
  const r = run(dir, ['1.3.3', '--confirm-device-verified']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /candidate に VA39 の期待値5欄が揃っていません/);
});

test('(6) candidate va39_baseline_comparison saying same is ignored', (t) => {
  const dir = setup(t, {
    candidate: candidateMeta({ va39_baseline_comparison: { status: 'same', differences: [] } }),
    verified: verifiedMeta({
      va39_patch_counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 12 },
      va39_patch_breakdown: [
        { kind: 'main', offset: 0, size: 100, counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 12 } },
      ],
    }),
  });
  const r = run(dir, ['1.3.3', '--confirm-device-verified']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /counts\.word: 12 -> 13/);
});

test('(7) CI=true is rejected without AGY_PROMOTE_ALLOW_CI', (t) => {
  const dir = setup(t, { candidate: candidateMeta(), verified: verifiedMeta() });
  const r = run(dir, ['1.3.3', '--confirm-device-verified'], { CI: 'true' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AGY_PROMOTE_ALLOW_CI/);
  assert.equal(readVerified(dir).tag_name, '1.3.2');
});

test('unknown argument exits 1', (t) => {
  const dir = setup(t, { candidate: candidateMeta(), verified: verifiedMeta() });
  const r = run(dir, ['1.3.3', '--confirm-device-verified', '--bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未知の引数/);
});

test('missing --confirm-device-verified exits 1', (t) => {
  const dir = setup(t, { candidate: candidateMeta(), verified: verifiedMeta() });
  const r = run(dir, ['1.3.3']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--confirm-device-verified flag is required/);
});

test('whitespace-only approval reason exits 1', (t) => {
  const dir = setup(t, {
    candidate: candidateMeta(),
    verified: verifiedMeta({
      va39_patch_counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 12 },
      va39_patch_breakdown: [
        { kind: 'main', offset: 0, size: 100, counts: { ubfx: 1, lsl: 21, mask: 0, mmap: 7, word: 12 } },
      ],
    }),
  });
  const r = run(dir, ['1.3.3', '--confirm-device-verified', '--approve-count-change', '   ']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /空でない理由/);
});
