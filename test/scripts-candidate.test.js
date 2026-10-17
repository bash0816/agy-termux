'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildElf } = require('./helpers/elf-fixture')
const { buildCandidateMeta } = require('../scripts/prepare-agy-candidate')

const REPO = path.join(__dirname, '..')
const UPDATE_SCRIPT = path.join(REPO, 'scripts', 'update-agy-candidate-config.js')
const PREPARE_LOCAL_SCRIPT = path.join(REPO, 'scripts', 'prepare-local-test-build.js')

const NEW_FIVE = [
  'va39_patcher_rev',
  'va39_patch_counts',
  'va39_patch_breakdown',
  'va39_patched_sha256',
  'va39_patched_size',
]

const PROGBITS = 1
const EXEC = 6 // SHF_ALLOC | SHF_EXECINSTR
const PT_LOAD = 1
const PF_X = 1
const PF_R = 4

const u = (x) => x >>> 0
// 64bit 形 UBFM(sf=1, opc=10, N=1): lsl(22,21) 相当など、パッチ対象になる形
const ubfmWord = (immr, imms) => u(0xD3400000 | (immr << 16) | (imms << 10))

function words(list) {
  const b = Buffer.alloc(list.length * 4)
  list.forEach((w, i) => b.writeUInt32LE(u(w), i * 4))
  return b
}

// applyVA39Patch が通る最小の ELF(.text は PF_X の PT_LOAD 内)
function buildBinary() {
  const { buf } = buildElf({
    sections: [{ type: PROGBITS, flags: EXEC, data: words([ubfmWord(22, 21)]) }],
    segments: [{ type: PT_LOAD, flags: PF_X | PF_R, sectionIndexes: [0] }],
  })
  return buf
}

function releaseMeta(overrides = {}) {
  return Object.assign(
    {
      id: 1001,
      tag_name: 'v1.2.3',
      draft: false,
      prerelease: false,
      assets: [
        {
          id: 2002,
          name: 'agy_cli_linux_arm64.tar.gz',
          browser_download_url: 'https://example.invalid/agy_cli_linux_arm64.tar.gz',
          updated_at: '2026-10-01T00:00:00Z',
        },
      ],
    },
    overrides
  )
}

function buildArgs(overrides = {}) {
  return Object.assign(
    {
      version: 'v1.2.3',
      releaseMeta: releaseMeta(),
      tarSha256: 'a'.repeat(64),
      binSha256: 'b'.repeat(64),
      binBuf: buildBinary(),
      verifiedConfig: null,
      tokyoDate: '2026-10-17',
    },
    overrides
  )
}

function pickFive(obj) {
  const out = {}
  for (const k of NEW_FIVE) out[k] = obj[k]
  return out
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cand-test-'))
}

// ---- buildCandidateMeta ----

test('buildCandidateMeta: 新5欄と va39_baseline_comparison を含み、va39_patch_regression を含まない', () => {
  const meta = buildCandidateMeta(buildArgs())
  for (const k of NEW_FIVE) assert.ok(k in meta, `${k} がない`)
  assert.ok('va39_baseline_comparison' in meta)
  assert.equal('va39_patch_regression' in meta, false)
  assert.equal(meta.tag_name, '1.2.3')
  assert.equal(meta.status, 'pending_device_verification')
  assert.equal(meta.detected_date, '2026-10-17')
  assert.equal(meta.sha256_binary, 'b'.repeat(64))
  assert.equal(meta.va39_patch_counts.lsl, 1)
  assert.equal(meta.va39_patcher_rev, 2)
  assert.equal(meta.va39_patched_size, buildBinary().length)
  assert.match(meta.va39_patched_sha256, /^[0-9a-f]{64}$/)
})

test('buildCandidateMeta: 5欄は sha256_binary の直後に並ぶ', () => {
  const keys = Object.keys(buildCandidateMeta(buildArgs()))
  const at = keys.indexOf('sha256_binary')
  assert.deepEqual(keys.slice(at + 1, at + 6), NEW_FIVE)
  assert.equal(keys[at + 6], 'va39_baseline_comparison')
})

test('buildCandidateMeta: binBuf を書き換えない', () => {
  const binBuf = buildBinary()
  const before = Buffer.from(binBuf)
  buildCandidateMeta(buildArgs({ binBuf }))
  assert.deepEqual(binBuf, before)
})

test('buildCandidateMeta: 基準が完全で同一なら same', () => {
  const first = buildCandidateMeta(buildArgs())
  const meta = buildCandidateMeta(buildArgs({ verifiedConfig: pickFive(first) }))
  assert.equal(meta.va39_baseline_comparison.status, 'same')
  assert.deepEqual(meta.va39_baseline_comparison.differences, [])
})

test('buildCandidateMeta: counts が違えば changed', () => {
  const first = buildCandidateMeta(buildArgs())
  const baseline = pickFive(first)
  baseline.va39_patch_counts = Object.assign({}, baseline.va39_patch_counts, {
    lsl: baseline.va39_patch_counts.lsl + 1,
  })
  const meta = buildCandidateMeta(buildArgs({ verifiedConfig: baseline }))
  assert.equal(meta.va39_baseline_comparison.status, 'changed')
  assert.ok(meta.va39_baseline_comparison.differences.some((d) => d.startsWith('counts.lsl')))
})

test('buildCandidateMeta: 基準がない・不完全なら baseline_missing(例外にしない)', () => {
  const none = buildCandidateMeta(buildArgs({ verifiedConfig: null }))
  assert.equal(none.va39_baseline_comparison.status, 'baseline_missing')

  const partial = buildCandidateMeta(buildArgs({ verifiedConfig: { tag_name: '1.2.2' } }))
  assert.equal(partial.va39_baseline_comparison.status, 'baseline_missing')
})

test('buildCandidateMeta: draft / prerelease / asset 無しは Error', () => {
  assert.throws(() => buildCandidateMeta(buildArgs({ releaseMeta: releaseMeta({ draft: true }) })), /draft/)
  assert.throws(() => buildCandidateMeta(buildArgs({ releaseMeta: releaseMeta({ prerelease: true }) })), /prerelease/)
  assert.throws(
    () => buildCandidateMeta(buildArgs({ releaseMeta: releaseMeta({ assets: [] }) })),
    /not found/
  )
})

// ---- update-agy-candidate-config.js ----

function candidateFixture(overrides = {}) {
  const meta = buildCandidateMeta(buildArgs())
  return Object.assign({}, meta, overrides)
}

test('update-agy-candidate-config: 新5欄を転記し、va39_patch_regression は書き出さない', () => {
  const dir = tmpDir()
  fs.mkdirSync(path.join(dir, 'config'))
  const input = candidateFixture({ va39_patch_regression: 'legacy' })
  const r = spawnSync(process.execPath, [UPDATE_SCRIPT], {
    cwd: dir,
    input: JSON.stringify(input),
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'agy-candidate-version.json'), 'utf8'))
  for (const k of NEW_FIVE) assert.deepEqual(written[k], input[k], k)
  assert.ok('va39_baseline_comparison' in written)
  assert.equal('va39_patch_regression' in written, false)
})

test('update-agy-candidate-config: 必須キー va39_patch_counts が無ければ失敗', () => {
  const dir = tmpDir()
  const input = candidateFixture()
  delete input.va39_patch_counts
  const r = spawnSync(process.execPath, [UPDATE_SCRIPT], {
    cwd: dir,
    input: JSON.stringify(input),
    encoding: 'utf8',
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Missing required field: va39_patch_counts/)
})

// ---- prepare-local-test-build.js ----

function runPrepareLocal(dir, version = '1.2.3') {
  const env = Object.assign({}, process.env, { AGY_TERMUX_ALLOW_LOCAL_TEST_WRITE: '1' })
  delete env.CI
  return spawnSync(process.execPath, [PREPARE_LOCAL_SCRIPT, version, '--confirm-local-test-only'], {
    cwd: dir,
    env,
    encoding: 'utf8',
  })
}

test('prepare-local-test-build: candidate の新5欄を verified に転記し、local_test で書く', () => {
  const dir = tmpDir()
  fs.mkdirSync(path.join(dir, 'config'))
  const candidate = candidateFixture()
  fs.writeFileSync(path.join(dir, 'config', 'agy-candidate-version.json'), JSON.stringify(candidate, null, 2))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }, null, 2))

  const r = runPrepareLocal(dir)
  assert.equal(r.status, 0, r.stderr)

  const verified = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'agy-verified-versions.json'), 'utf8'))
  assert.equal(verified.release_state, 'local_test')
  assert.equal(verified.tag_name, '1.2.3')
  for (const k of NEW_FIVE) assert.deepEqual(verified[k], candidate[k], k)
  const keys = Object.keys(verified)
  const at = keys.indexOf('va39_patcher_rev')
  assert.deepEqual(keys.slice(at, at + 5), NEW_FIVE)

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '1.2.3')
})

test('prepare-local-test-build: candidate に新5欄が無ければ verified にも書かない', () => {
  const dir = tmpDir()
  fs.mkdirSync(path.join(dir, 'config'))
  const candidate = {
    tag_name: '1.2.3',
    download_url: 'https://example.invalid/x',
    sha256_tar: 'a'.repeat(64),
    sha256_binary: 'b'.repeat(64),
    release_id: 1,
    asset_id: 2,
    asset_updated_at: '2026-10-01T00:00:00Z',
    source_repo: 'google-antigravity/antigravity-cli',
    detected_date: '2026-10-17',
    status: 'pending_device_verification',
  }
  fs.writeFileSync(path.join(dir, 'config', 'agy-candidate-version.json'), JSON.stringify(candidate, null, 2))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }, null, 2))

  const r = runPrepareLocal(dir)
  assert.equal(r.status, 0, r.stderr)
  const verified = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'agy-verified-versions.json'), 'utf8'))
  for (const k of NEW_FIVE) assert.equal(k in verified, false, k)
})
