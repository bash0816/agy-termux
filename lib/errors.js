'use strict'

// 失敗の型付けと、原因別の表示文言(純粋関数のみ。fs・ネットワークには触れない)

const path = require('path')

const MB = 1024 * 1024

// tar の stderr から原因を判定する規則(上から順に照合する。大文字小文字は区別しない)
const TAR_RULES = [
  { code: 'ENOSPC', pattern: 'No space left on device' },
  { code: 'EDQUOT', pattern: 'Disk quota exceeded' },
  { code: 'EACCES', pattern: 'Permission denied' },
  // "Operation not permitted" は EPERM。破損の根拠にはしない
  { code: 'EPERM', pattern: 'Operation not permitted' },
  { code: 'EROFS', pattern: 'Read-only file system' },
  { code: 'E_TAR_CORRUPT', pattern: 'Unexpected EOF' },
  { code: 'E_TAR_CORRUPT', pattern: 'not in gzip format' },
  { code: 'E_TAR_CORRUPT', pattern: 'invalid tar header' },
  { code: 'E_TAR_CORRUPT', pattern: 'Skipping to next header' },
]

// 具体的な原因を示さない汎用の行(分類の根拠にしない)
const TAR_GENERIC = ['Cannot open', 'Error is not recoverable']

// npm の stderr から原因を判定する規則(上から順に照合する)
const NPM_RULES = [
  { code: 'ENOSPC', patterns: ['No space left', 'ENOSPC'] },
  { code: 'EACCES', patterns: ['EACCES', 'EPERM', 'permission denied'] },
  {
    code: 'E_NET',
    patterns: ['ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'network'],
  },
]

function containsCI(text, needle) {
  return text.toLowerCase().includes(needle.toLowerCase())
}

// 空行を除いた行の配列(前後の空白は落とす)
function splitLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

// 代入で成り立つ Error。undefined の項目は代入しない(message を壊さないため)
function typedError(code, props = {}) {
  const err = new Error(props.message || props.detail || code)
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) err[key] = value
  }
  err.code = code
  return err
}

// "tar: <path>: ..." 形式の行からパスを取り出す(取れなければ undefined)
function tarPathOf(line) {
  const m = /^tar: (.+?): /.exec(line)
  // "tar: Cannot open: ..." の "Cannot open" はパスではない
  if (!m || TAR_GENERIC.some((g) => containsCI(m[1], g))) return undefined
  return m[1]
}

// tar の stderr を分類する。具体的な原因行を優先し、汎用の行だけなら E_TAR_UNKNOWN
function classifyTarStderr(stderr) {
  const lines = splitLines(stderr)

  for (const line of lines) {
    const rule = TAR_RULES.find((r) => containsCI(line, r.pattern))
    if (rule) return { code: rule.code, line, path: tarPathOf(line) }
  }

  // 認識できない場合: 最後の非空行と、最後の「汎用でない」行を返す
  const lastLine = lines.length ? lines[lines.length - 1] : ''
  const specific = lines.filter((line) => !TAR_GENERIC.some((g) => containsCI(line, g)))
  const line = specific.length ? specific[specific.length - 1] : ''
  return { code: 'E_TAR_UNKNOWN', line, lastLine }
}

// npm install の失敗を分類する
function classifyNpmFailure({ stderrTail = '', timedOut } = {}) {
  const lines = splitLines(stderrTail)
  const lastLine = lines.length ? lines[lines.length - 1] : ''

  if (timedOut) return { code: 'E_NPM_TIMEOUT', line: lastLine }

  for (const rule of NPM_RULES) {
    const hit = lines.find((line) => rule.patterns.some((p) => containsCI(line, p)))
    if (hit) return { code: rule.code, line: hit }
  }
  return { code: 'E_NPM_UNKNOWN', line: lastLine }
}

// 失敗の情報から、利用者に出す日本語の行の配列を作る(先頭の "[agy] " は付けない)
function describeFailure(info = {}) {
  const failedPath = info.path
  const detail = String(info.detail ?? '')
  const httpStatus = String(info.httpStatus ?? '')
  // errno が空でない文字列なら、それを code として扱う。数値の errno(Node の例外の番号)は使わず code を見る
  const code = typeof info.errno === 'string' && info.errno !== '' ? info.errno : info.code
  const where = failedPath ? `: ${failedPath}` : ''

  switch (code) {
    case 'E_STALL':
    case 'E_NET':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return ['通信が止まりました(または接続できません)。ネットワークを確認して、もう一度 agy update を実行してください']
    case 'E_HTTP':
      return [`配布元が応答しませんでした (HTTP ${httpStatus})。しばらくしてからもう一度実行してください`]
    case 'E_SHA':
    case 'E_ELF':
    case 'E_TAR_CORRUPT':
      return ['ダウンロードしたファイルの検証に失敗しました。ファイルは破棄しました。もう一度実行してください。繰り返す場合は Issue で報告してください']
    case 'E_TAR_UNKNOWN':
      return [`展開に失敗しました(原因を特定できません: ${detail})。もう一度実行してください。繰り返す場合は Issue で報告してください`]
    case 'ENOSPC':
    case 'EDQUOT':
      return [`保存できません(容量不足)${where}。空き容量を確認してください(古いキャッシュは ~/.agy-termux に残っています)`]
    case 'EACCES':
    case 'EPERM':
    case 'EROFS': {
      const lines = [`保存できません(権限エラー)${where}。このフォルダへの書き込み権限を確認してください`]
      if (failedPath) lines.push(`例: ls -ld ${path.dirname(failedPath)}`)
      return lines
    }
    case 'E_NOSPACE_MAYBE': {
      const space = Number.isFinite(info.free)
        ? `空き容量 約 ${Math.floor(info.free / MB)} MB`
        : '空き容量は不明'
      return [`保存できません(容量不足の可能性があります。${space})。空きを作ってから、もう一度実行してください`]
    }
    case 'E_NPM_TIMEOUT':
      return ['通信できませんでした。ネットワークを確認してから、もう一度 agy update を実行してください']
    default:
      // E_NPM_UNKNOWN と、未知の code
      return [`失敗しました(原因を特定できません: ${detail})。もう一度実行してください`]
  }
}

// 空き容量が閾値(既定 64MB)未満なら true。free が数値でなければ false
function diagnoseLowSpace({ free, threshold = 64 * MB } = {}) {
  if (typeof free !== 'number') return false
  return free < threshold
}

module.exports = {
  typedError,
  classifyTarStderr,
  classifyNpmFailure,
  describeFailure,
  diagnoseLowSpace,
}
