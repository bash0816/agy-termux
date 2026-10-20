'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  COUNT_KEYS,
  validateExpectation,
  buildExpectation,
  matchRuntime,
  classifyChange,
} = require('../lib/va39-expectation')

// 検証を通る新記録(呼ぶたびに新しいオブジェクトを返す)
function makeValid() {
  return {
    va39_patcher_rev: 3,
    va39_patch_counts: { ubfx: 2, lsl: 1, mask: 0, mmap: 1, word: 4 },
    va39_patch_breakdown: [
      { kind: 'main', offset: 0, size: 1000, counts: { ubfx: 1, lsl: 0, mask: 0, mmap: 0, word: 2 } },
      { kind: 'embedded', offset: 100, size: 200, counts: { ubfx: 1, lsl: 1, mask: 0, mmap: 1, word: 2 } },
    ],
    va39_patched_sha256: 'a'.repeat(64),
    va39_patched_size: 1000,
  }
}

// 旧記録(4欄が無い)
function makeLegacy() {
  return { va39_patch_counts: { ubfx: 2, lsl: 1, mask: 0, mmap: 1, word: 4 } }
}

function zeroCounts() {
  return { ubfx: 0, lsl: 0, mask: 0, mmap: 0, word: 0 }
}

// makeValid と同じ内容の patchResult(トップの5キーが合計、containers が内訳)
function makePatchResult() {
  return {
    ubfx: 2,
    lsl: 1,
    mask: 0,
    mmap: 1,
    word: 4,
    containers: [
      { kind: 'main', offset: 0, size: 1000, counts: { ubfx: 1, lsl: 0, mask: 0, mmap: 0, word: 2 } },
      { kind: 'embedded', offset: 100, size: 200, counts: { ubfx: 1, lsl: 1, mask: 0, mmap: 1, word: 2 } },
    ],
  }
}

const OPTS = Object.freeze({ patchedSha256: 'a'.repeat(64), patchedSize: 1000, rev: 3 })

// makeValid と一致する実行時の値
function makeActual() {
  return {
    rev: 3,
    counts: { ubfx: 2, lsl: 1, mask: 0, mmap: 1, word: 4 },
    containers: [
      { kind: 'main', offset: 0, size: 1000, counts: { ubfx: 1, lsl: 0, mask: 0, mmap: 0, word: 2 } },
      { kind: 'embedded', offset: 100, size: 200, counts: { ubfx: 1, lsl: 1, mask: 0, mmap: 1, word: 2 } },
    ],
    patchedSha256: 'a'.repeat(64),
    patchedSize: 1000,
  }
}

// makeValid より ubfx を1つ増やした新記録(トップと main の counts が変わる)
function makeUbfxPlusOne() {
  const c = makeValid()
  c.va39_patch_counts.ubfx = 3
  c.va39_patch_breakdown[0].counts.ubfx = 2
  return c
}

test('COUNT_KEYS は5キーの凍結された配列', () => {
  assert.deepEqual([...COUNT_KEYS], ['ubfx', 'lsl', 'mask', 'mmap', 'word'])
  assert.equal(Object.isFrozen(COUNT_KEYS), true)
})

// ---- validateExpectation ----

test('validateExpectation: 正常な新記録は ok になる', () => {
  assert.deepEqual(validateExpectation(makeValid(), { allowLegacy: false }), {
    ok: true,
    legacy: false,
    errors: [],
  })
})

test('validateExpectation: 旧記録は allowLegacy が真なら ok になる', () => {
  const r = validateExpectation(makeLegacy(), { allowLegacy: true })
  assert.equal(r.ok, true)
  assert.equal(r.legacy, true)
  assert.deepEqual(r.errors, [])
})

test('validateExpectation: 旧記録は allowLegacy が偽(省略を含む)なら legacy not allowed', () => {
  const r = validateExpectation(makeLegacy(), { allowLegacy: false })
  assert.equal(r.ok, false)
  assert.equal(r.legacy, true)
  assert.ok(r.errors.includes('legacy not allowed'))

  const omitted = validateExpectation(makeLegacy())
  assert.equal(omitted.ok, false)
  assert.ok(omitted.errors.includes('legacy not allowed'))
})

test('validateExpectation: 欄が1〜3個だけの記録は不正で、不足欄名を挙げる', () => {
  // rev だけ残す(3欄不足)
  const onlyRev = { va39_patcher_rev: 3 }
  const r1 = validateExpectation(onlyRev, { allowLegacy: true })
  assert.equal(r1.ok, false)
  assert.equal(r1.legacy, false)
  for (const field of ['va39_patch_breakdown', 'va39_patched_sha256', 'va39_patched_size']) {
    assert.ok(r1.errors.some((e) => e.includes(field)), field)
  }

  // size だけ欠ける(1欄不足)
  const noSize = makeValid()
  delete noSize.va39_patched_size
  const r2 = validateExpectation(noSize, { allowLegacy: false })
  assert.equal(r2.ok, false)
  assert.equal(r2.legacy, false)
  assert.ok(r2.errors.some((e) => e.includes('va39_patched_size')))
})

test('validateExpectation: rev が正の安全整数でなければ不正', () => {
  for (const rev of [0, 1.5, -1, '3', NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const v = makeValid()
    v.va39_patcher_rev = rev
    const r = validateExpectation(v, { allowLegacy: false })
    assert.equal(r.ok, false, String(rev))
    assert.ok(r.errors.some((e) => e.includes('va39_patcher_rev')), String(rev))
  }
})

test('validateExpectation: counts の余分・欠落・小数・負・NaN は不正', () => {
  const mutations = [
    (c) => { c.foo = 1 },
    (c) => { delete c.word },
    (c) => { c.lsl = 1.5 },
    (c) => { c.mask = -1 },
    (c) => { c.mmap = NaN },
  ]
  for (const mutate of mutations) {
    const v = makeValid()
    mutate(v.va39_patch_counts)
    const r = validateExpectation(v, { allowLegacy: false })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('va39_patch_counts')))
  }
})

test('validateExpectation: patched_sha256 が小文字64桁の16進でなければ不正', () => {
  for (const sha of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 12345, null]) {
    const v = makeValid()
    v.va39_patched_sha256 = sha
    const r = validateExpectation(v, { allowLegacy: false })
    assert.equal(r.ok, false, String(sha))
    assert.ok(r.errors.some((e) => e.includes('va39_patched_sha256')), String(sha))
  }
})

test('validateExpectation: patched_size が main の size と一致しなければ不正', () => {
  const mismatch = makeValid()
  mismatch.va39_patched_size = 999
  const r1 = validateExpectation(mismatch, { allowLegacy: false })
  assert.equal(r1.ok, false)
  assert.ok(r1.errors.some((e) => e.includes('va39_patched_size')))

  const zero = makeValid()
  zero.va39_patched_size = 0
  const r2 = validateExpectation(zero, { allowLegacy: false })
  assert.equal(r2.ok, false)
  assert.ok(r2.errors.some((e) => e.includes('va39_patched_size')))
})

test('validateExpectation: main がちょうど1個でなければ不正', () => {
  const two = makeValid()
  two.va39_patch_breakdown.push({ kind: 'main', offset: 0, size: 1000, counts: zeroCounts() })
  const r1 = validateExpectation(two, { allowLegacy: false })
  assert.equal(r1.ok, false)
  assert.ok(r1.errors.some((e) => e.includes('main')))

  const none = makeValid()
  none.va39_patch_breakdown = [none.va39_patch_breakdown[1]]
  const r2 = validateExpectation(none, { allowLegacy: false })
  assert.equal(r2.ok, false)
  assert.ok(r2.errors.some((e) => e.includes('main')))
})

test('validateExpectation: main が先頭でなければ不正', () => {
  const v = makeValid()
  v.va39_patch_breakdown = [v.va39_patch_breakdown[1], v.va39_patch_breakdown[0]]
  const r = validateExpectation(v, { allowLegacy: false })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('先頭')))
})

test('validateExpectation: main の offset が 0 でなければ不正', () => {
  const v = makeValid()
  v.va39_patch_breakdown[0].offset = 5
  const r = validateExpectation(v, { allowLegacy: false })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('offset')))
})

test('validateExpectation: embedded の offset が逆順なら不正', () => {
  const v = makeValid()
  v.va39_patch_breakdown = [
    v.va39_patch_breakdown[0],
    { kind: 'embedded', offset: 300, size: 50, counts: zeroCounts() },
    { kind: 'embedded', offset: 100, size: 200, counts: zeroCounts() },
  ]
  const r = validateExpectation(v, { allowLegacy: false })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('昇順')))
})

test('validateExpectation: embedded同士が重なれば不正', () => {
  const v = makeValid()
  v.va39_patch_breakdown = [
    v.va39_patch_breakdown[0],
    { kind: 'embedded', offset: 100, size: 200, counts: zeroCounts() },
    { kind: 'embedded', offset: 250, size: 50, counts: zeroCounts() },
  ]
  const r = validateExpectation(v, { allowLegacy: false })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('重なって')))
})

test('validateExpectation: embedded が main の範囲外なら不正。末尾ちょうどは許す', () => {
  const outside = makeValid()
  outside.va39_patch_breakdown.push({ kind: 'embedded', offset: 900, size: 200, counts: zeroCounts() })
  const r1 = validateExpectation(outside, { allowLegacy: false })
  assert.equal(r1.ok, false)
  assert.ok(r1.errors.some((e) => e.includes('範囲')))

  const edge = makeValid()
  edge.va39_patch_breakdown.push({ kind: 'embedded', offset: 900, size: 100, counts: zeroCounts() })
  assert.deepEqual(validateExpectation(edge, { allowLegacy: false }), { ok: true, legacy: false, errors: [] })
})

test('validateExpectation: embedded の size が 0 なら不正', () => {
  const v = makeValid()
  v.va39_patch_breakdown[1].size = 0
  const r = validateExpectation(v, { allowLegacy: false })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('size')))
})

test('validateExpectation: offset が安全整数の範囲を超えれば不正', () => {
  const v = makeValid()
  v.va39_patch_breakdown.push({ kind: 'embedded', offset: Number.MAX_SAFE_INTEGER + 1, size: 1, counts: zeroCounts() })
  const r = validateExpectation(v, { allowLegacy: false })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('offset')))
})

test('validateExpectation: 件数の合計が内訳と一致しなければ不正', () => {
  const v = makeValid()
  v.va39_patch_counts.ubfx = 3
  const r = validateExpectation(v, { allowLegacy: false })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('va39_patch_counts.ubfx')))
})

test('validateExpectation: 不正な形でも例外を出さず ok:false を返す', () => {
  for (const v of [null, undefined, 'x', 5, [], true]) {
    const r = validateExpectation(v, { allowLegacy: true })
    assert.equal(r.ok, false, String(v))
  }

  const mutations = [
    (v) => { v.va39_patch_breakdown = 'x' },
    (v) => { v.va39_patch_breakdown = [null, v.va39_patch_breakdown[1]] },
    (v) => { v.va39_patch_breakdown[1].counts = null },
    (v) => { v.va39_patch_breakdown[1].counts = [] },
    (v) => { v.va39_patch_breakdown[1].counts = 'x' },
    (v) => { v.va39_patch_breakdown[1].kind = 'other' },
    (v) => { v.va39_patch_counts = null },
    (v) => { v.va39_patch_counts = [] },
    (v) => { v.va39_patch_counts = 'x' },
  ]
  for (const mutate of mutations) {
    const v = makeValid()
    mutate(v)
    let r
    assert.doesNotThrow(() => {
      r = validateExpectation(v, { allowLegacy: false })
    })
    assert.equal(r.ok, false)
  }
})

// ---- buildExpectation ----

test('buildExpectation: 正常な入力から新記録を組み立て、検証を通る', () => {
  const r = buildExpectation(makePatchResult(), OPTS)
  assert.deepEqual(r, makeValid())
  assert.deepEqual([...Object.keys(r.va39_patch_counts)], [...COUNT_KEYS])
  assert.deepEqual(validateExpectation(r, { allowLegacy: false }), { ok: true, legacy: false, errors: [] })
})

test('buildExpectation: 入力と参照を共有しない', () => {
  const pr = makePatchResult()
  const r = buildExpectation(pr, OPTS)
  pr.ubfx = 99
  pr.containers[0].counts.ubfx = 99
  pr.containers[1].size = 7
  assert.equal(r.va39_patch_counts.ubfx, 2)
  assert.equal(r.va39_patch_breakdown[0].counts.ubfx, 1)
  assert.equal(r.va39_patch_breakdown[1].size, 200)
})

test('buildExpectation: 不正な入力では検証の Error を投げる', () => {
  assert.throws(() => buildExpectation(null, OPTS), Error)

  const noContainers = makePatchResult()
  delete noContainers.containers
  assert.throws(() => buildExpectation(noContainers, OPTS), /va39/)

  const badSum = makePatchResult()
  badSum.ubfx = 3
  assert.throws(() => buildExpectation(badSum, OPTS), /va39_patch_counts\.ubfx/)

  assert.throws(() => buildExpectation(makePatchResult(), { ...OPTS, rev: 0 }), /va39_patcher_rev/)
  assert.throws(() => buildExpectation(makePatchResult(), { ...OPTS, patchedSize: 999 }), /va39_patched_size/)
  assert.throws(
    () => buildExpectation(makePatchResult(), { ...OPTS, patchedSha256: 'A'.repeat(64) }),
    /va39_patched_sha256/,
  )
})

// ---- matchRuntime ----

test('matchRuntime: 完全一致なら ok', () => {
  const expected = buildExpectation(makePatchResult(), OPTS)
  assert.deepEqual(matchRuntime(expected, makeActual()), { ok: true, mismatches: [] })
})

test('matchRuntime: rev が違えば rev を挙げる', () => {
  const actual = makeActual()
  actual.rev = 4
  const r = matchRuntime(makeValid(), actual)
  assert.equal(r.ok, false)
  assert.equal(r.mismatches.length, 1)
  assert.ok(r.mismatches[0].startsWith('rev'))
})

test('matchRuntime: counts の各キーが違えばそのキーを挙げる', () => {
  const actual = makeActual()
  actual.counts.lsl = 9
  const r = matchRuntime(makeValid(), actual)
  assert.equal(r.ok, false)
  assert.equal(r.mismatches.length, 1)
  assert.ok(r.mismatches[0].startsWith('counts.lsl'))
})

test('matchRuntime: containers の長さ・kind・offset・size・counts の違いを挙げる', () => {
  const cases = [
    [(a) => { a.containers.pop() }, 'containers: 長さ'],
    [(a) => { a.containers[0].kind = 'embedded' }, 'containers[0].kind'],
    [(a) => { a.containers[1].offset = 101 }, 'containers[1].offset'],
    [(a) => { a.containers[1].size = 201 }, 'containers[1].size'],
    [(a) => { a.containers[1].counts.word = 3 }, 'containers[1].counts.word'],
  ]
  for (const [mutate, label] of cases) {
    const actual = makeActual()
    mutate(actual)
    const r = matchRuntime(makeValid(), actual)
    assert.equal(r.ok, false, label)
    assert.ok(r.mismatches.some((m) => m.startsWith(label)), label)
  }
})

test('matchRuntime: patchedSha256 と patchedSize の違いを挙げる', () => {
  const sha = makeActual()
  sha.patchedSha256 = 'b'.repeat(64)
  const r1 = matchRuntime(makeValid(), sha)
  assert.equal(r1.ok, false)
  assert.ok(r1.mismatches.some((m) => m.startsWith('patchedSha256')))

  const size = makeActual()
  size.patchedSize = 999
  const r2 = matchRuntime(makeValid(), size)
  assert.equal(r2.ok, false)
  assert.ok(r2.mismatches.some((m) => m.startsWith('patchedSize')))
})

test('matchRuntime: actual が欠けていても例外を出さず mismatch を返す', () => {
  let r
  assert.doesNotThrow(() => {
    r = matchRuntime(makeValid(), {})
  })
  assert.equal(r.ok, false)
  assert.doesNotThrow(() => matchRuntime(makeValid(), null))
})

test('matchRuntime: expected が不正なら expectation invalid', () => {
  const invalid = [{}, null, makeLegacy()]
  for (const expected of invalid) {
    assert.deepEqual(matchRuntime(expected, makeActual()), {
      ok: false,
      mismatches: ['expectation invalid'],
    })
  }
})

// ---- classifyChange ----

test('classifyChange: offset と sha だけが違えば same', () => {
  const candidate = makeValid()
  candidate.va39_patch_breakdown[1].offset = 300
  candidate.va39_patched_sha256 = 'b'.repeat(64)
  assert.equal(classifyChange(makeValid(), candidate), 'same')
})

test('classifyChange: rev が違えば rev-change(counts も違う場合を含む)', () => {
  const baseline = makeValid()
  baseline.va39_patcher_rev = 2
  assert.equal(classifyChange(baseline, makeValid()), 'rev-change')
  assert.equal(classifyChange(baseline, makeUbfxPlusOne()), 'rev-change')
})

test('classifyChange: baseline が旧記録(rev 欄無し)なら rev-change', () => {
  assert.equal(classifyChange(makeLegacy(), makeValid()), 'rev-change')
})

test('classifyChange: 内訳の要素数、または kind が違えば structure-change', () => {
  const candidate = makeValid()
  candidate.va39_patch_breakdown.push({ kind: 'embedded', offset: 500, size: 100, counts: zeroCounts() })
  assert.equal(classifyChange(makeValid(), candidate), 'structure-change')

  const baseline = makeValid()
  baseline.va39_patch_breakdown[1].kind = 'other'
  assert.equal(classifyChange(baseline, makeValid()), 'structure-change')
})

test('classifyChange: counts が違えば count-diff(トップと対応コンテナの両方)', () => {
  assert.equal(classifyChange(makeValid(), makeUbfxPlusOne()), 'count-diff')

  // トップは同じで、コンテナだけが違う
  const baseline = makeValid()
  baseline.va39_patch_breakdown[1].counts.ubfx = 2
  assert.equal(classifyChange(baseline, makeValid()), 'count-diff')
})

test('classifyChange: candidate が新記録でなければ Error', () => {
  assert.throws(() => classifyChange(makeValid(), makeLegacy()), Error)
  assert.throws(() => classifyChange(makeValid(), {}), Error)
  assert.throws(() => classifyChange(makeValid(), null), Error)
})
