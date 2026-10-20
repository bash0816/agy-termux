'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  readPatcherRev,
  buildExpectation,
  isCompleteExpectation,
  compareExpectation,
} = require('../scripts/lib/va39-baseline')

const FIELDS = [
  'va39_patcher_rev',
  'va39_patch_counts',
  'va39_patch_breakdown',
  'va39_patched_sha256',
  'va39_patched_size',
]

// 合成データ（実バイナリは使わない）
function makeResult(over = {}) {
  return {
    ubfx: 1,
    lsl: 21,
    mask: 3,
    mmap: 0,
    word: 5,
    containers: [
      { kind: 'main', offset: 0, size: 4096, counts: { ubfx: 1, lsl: 10, mask: 2, mmap: 0, word: 3 } },
      { kind: 'embedded', offset: 8192, size: 2048, counts: { ubfx: 0, lsl: 11, mask: 1, mmap: 0, word: 2 } },
      { kind: 'embedded', offset: 16384, size: 1024, counts: { ubfx: 0, lsl: 0, mask: 0, mmap: 0, word: 0 } },
    ],
    ...over,
  }
}

const BUF_A = Buffer.from('synthetic-patched-A')
const BUF_B = Buffer.from('synthetic-patched-B-longer')

function build(over = {}, buf = BUF_A, rev = 2) {
  return buildExpectation({ patchResult: makeResult(over), patchedBuf: buf, rev })
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va39-baseline-test-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- readPatcherRev ----------

test('readPatcherRev: 指定ファイルの rev(整数)を返す', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'rev.json')
    fs.writeFileSync(file, '{"rev":7}')
    assert.equal(readPatcherRev(file), 7)
  })
})

test('readPatcherRev: 既定パスは lib/patcher-rev.json の rev を返す', () => {
  const file = path.join(__dirname, '..', 'lib', 'patcher-rev.json')
  const expected = JSON.parse(fs.readFileSync(file, 'utf8')).rev
  assert.ok(Number.isInteger(expected))
  assert.equal(readPatcherRev(), expected)
})

test('readPatcherRev: rev が整数でない・JSON が不正・ファイルなしは Error', () => {
  withTempDir((dir) => {
    const cases = ['{"rev":"2"}', '{"rev":1.5}', '{}', 'null', '[1]', '{bad json']
    cases.forEach((text, i) => {
      const file = path.join(dir, `case-${i}.json`)
      fs.writeFileSync(file, text)
      assert.throws(() => readPatcherRev(file), Error, text)
    })
    assert.throws(() => readPatcherRev(path.join(dir, 'none.json')), Error)
  })
})

// ---------- buildExpectation ----------

test('buildExpectation: 5 欄だけをこの順で持つ', () => {
  assert.deepEqual(Object.keys(build()), FIELDS)
})

test('buildExpectation: va39_patch_counts は 5 数のみ(containers を含まない)', () => {
  const e = build()
  assert.deepEqual(e.va39_patch_counts, { ubfx: 1, lsl: 21, mask: 3, mmap: 0, word: 5 })
  assert.deepEqual(Object.keys(e.va39_patch_counts), ['ubfx', 'lsl', 'mask', 'mmap', 'word'])
})

test('buildExpectation: breakdown は入力の順序を保ち、kind/offset/size/counts のみコピーする', () => {
  const pr = makeResult()
  pr.containers[0].extra = 'drop-me'
  const e = buildExpectation({ patchResult: pr, patchedBuf: BUF_A, rev: 2 })
  assert.deepEqual(
    e.va39_patch_breakdown.map((c) => c.kind),
    ['main', 'embedded', 'embedded'],
  )
  assert.deepEqual(
    e.va39_patch_breakdown.map((c) => c.offset),
    [0, 8192, 16384],
  )
  assert.deepEqual(e.va39_patch_breakdown[0], {
    kind: 'main',
    offset: 0,
    size: 4096,
    counts: { ubfx: 1, lsl: 10, mask: 2, mmap: 0, word: 3 },
  })
})

test('buildExpectation: sha256 は小文字 hex、size は buffer の長さ、rev は入力どおり', () => {
  const e = buildExpectation({ patchResult: makeResult(), patchedBuf: Buffer.from('abc'), rev: 2 })
  assert.equal(e.va39_patched_sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(e.va39_patched_size, 3)
  assert.equal(e.va39_patcher_rev, 2)
})

test('buildExpectation: 不正入力(counts 非整数・containers 非配列・patchedBuf 非 Buffer)は Error', () => {
  const badCounts = [makeResult({ lsl: 1.5 }), makeResult({ word: '3' }), makeResult({ ubfx: undefined })]
  for (const pr of badCounts) {
    assert.throws(() => buildExpectation({ patchResult: pr, patchedBuf: BUF_A, rev: 2 }), Error)
  }
  for (const containers of [{}, null, 'x']) {
    assert.throws(
      () => buildExpectation({ patchResult: makeResult({ containers }), patchedBuf: BUF_A, rev: 2 }),
      Error,
    )
  }
  for (const buf of [Uint8Array.from([1, 2]), 'str', null, undefined]) {
    assert.throws(() => buildExpectation({ patchResult: makeResult(), patchedBuf: buf, rev: 2 }), Error)
  }
})

// ---------- isCompleteExpectation ----------

test('isCompleteExpectation: build の出力は true(containers 空の場合も true)', () => {
  assert.equal(isCompleteExpectation(build()), true)
  assert.equal(isCompleteExpectation(build({ containers: [] })), true)
})

test('isCompleteExpectation: null/undefined/非オブジェクト/配列/空オブジェクトは false', () => {
  for (const v of [null, undefined, 'x', 3, [], {}]) {
    assert.equal(isCompleteExpectation(v), false, String(v))
  }
})

test('isCompleteExpectation: 5 欄のどれかが欠けると false', () => {
  for (const key of FIELDS) {
    const e = build()
    delete e[key]
    assert.equal(isCompleteExpectation(e), false, key)
  }
})

test('isCompleteExpectation: rev が正の整数でない場合は false', () => {
  for (const rev of [0, -1, 1.5, '2']) {
    const e = build({}, BUF_A, rev)
    assert.equal(isCompleteExpectation(e), false, String(rev))
  }
})

test('isCompleteExpectation: counts の不正(負数・キー欠け)は false', () => {
  const neg = build()
  neg.va39_patch_counts.lsl = -1
  assert.equal(isCompleteExpectation(neg), false)

  const missing = build()
  delete missing.va39_patch_counts.word
  assert.equal(isCompleteExpectation(missing), false)
})

test('isCompleteExpectation: breakdown の不正(kind・offset・counts)は false', () => {
  const badKind = build()
  badKind.va39_patch_breakdown[0].kind = 'other'
  assert.equal(isCompleteExpectation(badKind), false)

  const badOffset = build()
  badOffset.va39_patch_breakdown[1].offset = -1
  assert.equal(isCompleteExpectation(badOffset), false)

  const noCounts = build()
  delete noCounts.va39_patch_breakdown[2].counts
  assert.equal(isCompleteExpectation(noCounts), false)

  const notArray = build()
  notArray.va39_patch_breakdown = {}
  assert.equal(isCompleteExpectation(notArray), false)
})

test('isCompleteExpectation: sha256 は 64 桁小文字 hex のみ、size は正の整数', () => {
  const upper = build()
  upper.va39_patched_sha256 = upper.va39_patched_sha256.toUpperCase()
  assert.equal(isCompleteExpectation(upper), false)

  const short = build()
  short.va39_patched_sha256 = short.va39_patched_sha256.slice(0, 63)
  assert.equal(isCompleteExpectation(short), false)

  const zeroSize = build()
  zeroSize.va39_patched_size = 0
  assert.equal(isCompleteExpectation(zeroSize), false)
})

// ---------- compareExpectation ----------

test('compareExpectation: baseline が null/undefined なら baseline_missing', () => {
  for (const b of [null, undefined]) {
    assert.deepEqual(compareExpectation(b, build()), {
      status: 'baseline_missing',
      differences: ['基準値が不完全または未記録'],
    })
  }
})

test('compareExpectation: baseline が不完全(欄の欠け)なら baseline_missing', () => {
  const b = build()
  delete b.va39_patch_breakdown
  assert.deepEqual(compareExpectation(b, build()), {
    status: 'baseline_missing',
    differences: ['基準値が不完全または未記録'],
  })
})

test('compareExpectation: candidate が不完全なら baseline の有無によらず Error', () => {
  const bad = build()
  delete bad.va39_patched_size
  assert.throws(() => compareExpectation(build(), bad), Error)
  assert.throws(() => compareExpectation(null, bad), Error)
})

test('compareExpectation: 完全一致は same(差分なし)', () => {
  assert.deepEqual(compareExpectation(build(), build()), { status: 'same', differences: [] })
})

test('compareExpectation: sha256 と size の差だけなら same', () => {
  const candidate = build({}, BUF_B)
  assert.notEqual(candidate.va39_patched_sha256, build().va39_patched_sha256)
  assert.notEqual(candidate.va39_patched_size, build().va39_patched_size)
  assert.deepEqual(compareExpectation(build(), candidate), { status: 'same', differences: [] })
})

test('compareExpectation: rev の差は changed', () => {
  const r = compareExpectation(build({}, BUF_A, 1), build({}, BUF_A, 2))
  assert.equal(r.status, 'changed')
  assert.deepEqual(r.differences, ['rev: 1 -> 2'])
})

test('compareExpectation: counts の差は changed(差分文字列)', () => {
  const r = compareExpectation(build(), build({ lsl: 6 }))
  assert.equal(r.status, 'changed')
  assert.deepEqual(r.differences, ['counts.lsl: 21 -> 6'])
})

test('compareExpectation: コンテナ数の差は changed(差分文字列)', () => {
  const candidate = build({ containers: makeResult().containers.slice(0, 2) })
  const r = compareExpectation(build(), candidate)
  assert.equal(r.status, 'changed')
  assert.deepEqual(r.differences, ['breakdown: コンテナ数 3 -> 2'])
})

test('compareExpectation: コンテナ個別の counts 差分は breakdown[i].counts.k で示す', () => {
  const containers = makeResult().containers
  containers[1].counts.mmap = 1
  const r = compareExpectation(build(), build({ containers }))
  assert.equal(r.status, 'changed')
  assert.deepEqual(r.differences, ['breakdown[1].counts.mmap: 0 -> 1'])
})

test('compareExpectation: コンテナの kind の差分も検出する', () => {
  const containers = makeResult().containers
  containers[0].kind = 'embedded'
  const r = compareExpectation(build(), build({ containers }))
  assert.equal(r.status, 'changed')
  assert.deepEqual(r.differences, ['breakdown[0].kind: main -> embedded'])
})
