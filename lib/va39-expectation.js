'use strict'

// va39 パッチの期待値(設定の記録)の検証・組み立て・実行時照合・変更分類(純粋関数のみ。fs・ネットワーク・process には触れない)

// パッチの種類ごとの件数キー(凍結)
const COUNT_KEYS = Object.freeze(['ubfx', 'lsl', 'mask', 'mmap', 'word'])

// 新記録で必須の4欄。旧記録ではこれらがすべて無い
const RECORD_FIELDS = Object.freeze([
  'va39_patcher_rev',
  'va39_patch_breakdown',
  'va39_patched_sha256',
  'va39_patched_size',
])

const SHA256_HEX = /^[0-9a-f]{64}$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafeNonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isSafePositive(value) {
  return Number.isSafeInteger(value) && value > 0
}

// counts が COUNT_KEYS の5キーちょうどで、各値が非負の安全整数かを検査する。違反は errors に追加する
function checkCounts(counts, label, errors) {
  if (!isPlainObject(counts)) {
    errors.push(`${label}: オブジェクトではありません`)
    return false
  }
  let ok = true
  for (const key of Object.keys(counts)) {
    if (!COUNT_KEYS.includes(key)) {
      errors.push(`${label}: 余分なキー ${key} があります`)
      ok = false
    }
  }
  for (const key of COUNT_KEYS) {
    if (!Object.hasOwn(counts, key)) {
      errors.push(`${label}: キー ${key} がありません`)
      ok = false
    } else if (!isSafeNonNegative(counts[key])) {
      errors.push(`${label}.${key}: 非負の安全整数ではありません`)
      ok = false
    }
  }
  return ok
}

// va39_patch_breakdown を検査する。main は先頭に1個、embedded は main の後に offset 昇順で非重複に並ぶ
function checkBreakdown(breakdown, patchedSize, errors) {
  const label = 'va39_patch_breakdown'
  if (!Array.isArray(breakdown)) {
    errors.push(`${label}: 配列ではありません`)
    return false
  }
  let ok = true
  const fail = (message) => {
    errors.push(`${label}: ${message}`)
    ok = false
  }

  breakdown.forEach((el, i) => {
    if (!isPlainObject(el)) {
      fail(`[${i}] がオブジェクトではありません`)
      return
    }
    if (el.kind !== 'main' && el.kind !== 'embedded') fail(`[${i}] の kind が main / embedded 以外です`)
    if (!checkCounts(el.counts, `${label}[${i}].counts`, errors)) ok = false
  })

  const mains = breakdown.filter((el) => isPlainObject(el) && el.kind === 'main')
  if (mains.length !== 1) {
    fail(`main はちょうど1個である必要があります(実際 ${mains.length} 個)`)
    return false
  }
  const main = mains[0]
  if (breakdown[0] !== main) fail('main は先頭に置く必要があります')
  if (main.offset !== 0) fail('main の offset は 0 である必要があります')
  if (main.size !== patchedSize) {
    fail(`main の size(${main.size})が va39_patched_size(${patchedSize}) と一致しません`)
  }

  // 直前の embedded の範囲(先頭の embedded は main と比べない)
  let prevOffset = null
  let prevEnd = null
  breakdown.forEach((el, i) => {
    if (!isPlainObject(el) || el.kind !== 'embedded') return
    if (!isSafeNonNegative(el.offset)) fail(`[${i}] の offset が安全な非負整数ではありません`)
    if (!isSafePositive(el.size)) fail(`[${i}] の size が正の安全整数ではありません`)
    if (!isSafeNonNegative(el.offset) || !isSafePositive(el.size)) return

    const end = el.offset + el.size
    if (!Number.isSafeInteger(end) || end > main.size) {
      fail(`[${i}] の範囲(offset + size)が main の範囲(size ${main.size})の外です`)
    }
    if (prevOffset !== null) {
      if (el.offset < prevOffset) fail(`[${i}] の offset が昇順ではありません`)
      else if (el.offset < prevEnd) fail(`[${i}] が直前の embedded と重なっています`)
    }
    prevOffset = el.offset
    prevEnd = end
  })

  return ok
}

// 設定の記録(va39 の期待値)を検証する。旧記録は allowLegacy が true のときだけ通す
function validateExpectation(obj, options) {
  const allowLegacy = Boolean(options && options.allowLegacy)
  if (!isPlainObject(obj)) {
    return { ok: false, legacy: false, errors: ['オブジェクトではありません'] }
  }

  const present = RECORD_FIELDS.filter((field) => obj[field] !== undefined)

  // 4欄がすべて無い = 旧記録
  if (present.length === 0) {
    if (!allowLegacy) return { ok: false, legacy: true, errors: ['legacy not allowed'] }
    const legacyErrors = []
    if (obj.va39_patch_counts !== undefined) {
      checkCounts(obj.va39_patch_counts, 'va39_patch_counts', legacyErrors)
    }
    return { ok: legacyErrors.length === 0, legacy: true, errors: legacyErrors }
  }

  // 1〜3欄だけ = 不正
  if (present.length < RECORD_FIELDS.length) {
    const missing = RECORD_FIELDS.filter((field) => obj[field] === undefined)
    return { ok: false, legacy: false, errors: [`新記録の欄が不足しています: ${missing.join(', ')}`] }
  }

  // 4欄すべて有る = 新記録
  const errors = []

  const rev = obj.va39_patcher_rev
  if (!isSafePositive(rev)) errors.push('va39_patcher_rev: 正の安全整数ではありません')

  const countsOk = checkCounts(obj.va39_patch_counts, 'va39_patch_counts', errors)

  const sha = obj.va39_patched_sha256
  if (typeof sha !== 'string' || !SHA256_HEX.test(sha)) {
    errors.push('va39_patched_sha256: 小文字の16進64文字ではありません')
  }

  const size = obj.va39_patched_size
  if (!isSafePositive(size)) errors.push('va39_patched_size: 正の安全整数ではありません')

  const breakdownOk = checkBreakdown(obj.va39_patch_breakdown, size, errors)

  // 全要素の counts の合計が、記録したトップの件数と一致するか(形式が正しいときだけ検査する)
  if (countsOk && breakdownOk) {
    for (const key of COUNT_KEYS) {
      const sum = obj.va39_patch_breakdown.reduce((acc, el) => acc + el.counts[key], 0)
      if (sum !== obj.va39_patch_counts[key]) {
        errors.push(
          `va39_patch_counts.${key}: breakdown の合計 ${sum} と一致しません(記録値 ${obj.va39_patch_counts[key]})`,
        )
      }
    }
  }

  return { ok: errors.length === 0, legacy: false, errors }
}

function copyCounts(counts) {
  return isPlainObject(counts) ? { ...counts } : counts
}

// コンテナを、記録に必要な4項目だけの新しいオブジェクトにする
function copyContainer(container) {
  if (!isPlainObject(container)) return container
  return {
    kind: container.kind,
    offset: container.offset,
    size: container.size,
    counts: copyCounts(container.counts),
  }
}

// patchResult(トップの5キーが合計、containers がコンテナ別の内訳)から設定の記録を組み立てる。不正なら Error
function buildExpectation(patchResult, options) {
  const { patchedSha256, patchedSize, rev } = options || {}
  const src = isPlainObject(patchResult) ? patchResult : {}

  const counts = {}
  for (const key of COUNT_KEYS) counts[key] = src[key]

  const containers = Array.isArray(src.containers) ? src.containers : undefined

  const record = {
    va39_patcher_rev: rev,
    va39_patch_counts: counts,
    va39_patch_breakdown: containers ? containers.map(copyContainer) : undefined,
    va39_patched_sha256: patchedSha256,
    va39_patched_size: patchedSize,
  }

  const result = validateExpectation(record, { allowLegacy: false })
  if (!result.ok) {
    throw new Error(`va39 の期待値を組み立てられません: ${result.errors.join('; ')}`)
  }
  return record
}

const show = (value) => JSON.stringify(value) ?? 'undefined'

// 実行時の値(actual)が設定の記録(expected)と完全一致するかを照合する
function matchRuntime(expected, actual) {
  if (!validateExpectation(expected, { allowLegacy: false }).ok) {
    return { ok: false, mismatches: ['expectation invalid'] }
  }

  const act = isPlainObject(actual) ? actual : {}
  const mismatches = []
  const check = (name, want, got) => {
    if (got !== want) mismatches.push(`${name}: 期待 ${show(want)} / 実際 ${show(got)}`)
  }

  check('rev', expected.va39_patcher_rev, act.rev)

  const actCounts = isPlainObject(act.counts) ? act.counts : {}
  for (const key of COUNT_KEYS) {
    check(`counts.${key}`, expected.va39_patch_counts[key], actCounts[key])
  }

  const want = expected.va39_patch_breakdown
  if (!Array.isArray(act.containers)) {
    mismatches.push('containers: 配列ではありません')
  } else if (act.containers.length !== want.length) {
    mismatches.push(`containers: 長さ 期待 ${want.length} / 実際 ${act.containers.length}`)
  } else {
    want.forEach((w, i) => {
      const got = isPlainObject(act.containers[i]) ? act.containers[i] : {}
      check(`containers[${i}].kind`, w.kind, got.kind)
      check(`containers[${i}].offset`, w.offset, got.offset)
      check(`containers[${i}].size`, w.size, got.size)
      const gotCounts = isPlainObject(got.counts) ? got.counts : {}
      for (const key of COUNT_KEYS) {
        check(`containers[${i}].counts.${key}`, w.counts[key], gotCounts[key])
      }
    })
  }

  check('patchedSha256', expected.va39_patched_sha256, act.patchedSha256)
  check('patchedSize', expected.va39_patched_size, act.patchedSize)

  return { ok: mismatches.length === 0, mismatches }
}

// 設定の変更を分類する。baseline は旧記録(legacy)も可。candidate は新記録でなければ Error
function classifyChange(baseline, candidate) {
  if (!validateExpectation(candidate, { allowLegacy: false }).ok) {
    throw new Error('candidate は有効な新記録ではありません')
  }
  const base = isPlainObject(baseline) ? baseline : {}

  // (1) baseline が旧記録(rev 欄無し)、または版数が違う
  if (base.va39_patcher_rev === undefined || base.va39_patcher_rev !== candidate.va39_patcher_rev) {
    return 'rev-change'
  }

  // (2) 内訳の要素数、または kind の並び
  const baseBreakdown = base.va39_patch_breakdown
  const candBreakdown = candidate.va39_patch_breakdown
  if (
    !Array.isArray(baseBreakdown) ||
    baseBreakdown.length !== candBreakdown.length ||
    baseBreakdown.some((el, i) => !isPlainObject(el) || el.kind !== candBreakdown[i].kind)
  ) {
    return 'structure-change'
  }

  // (3) トップの件数、または対応するコンテナの件数
  const baseCounts = isPlainObject(base.va39_patch_counts) ? base.va39_patch_counts : {}
  for (const key of COUNT_KEYS) {
    if (baseCounts[key] !== candidate.va39_patch_counts[key]) return 'count-diff'
  }
  for (let i = 0; i < candBreakdown.length; i++) {
    const baseEntryCounts = isPlainObject(baseBreakdown[i].counts) ? baseBreakdown[i].counts : {}
    for (const key of COUNT_KEYS) {
      if (baseEntryCounts[key] !== candBreakdown[i].counts[key]) return 'count-diff'
    }
  }

  // (4) offset・size・patched_sha256 は比較しない
  return 'same'
}

module.exports = {
  COUNT_KEYS,
  validateExpectation,
  buildExpectation,
  matchRuntime,
  classifyChange,
}
