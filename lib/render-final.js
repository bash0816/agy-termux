'use strict'

// 更新の最終結果を、利用者に表示する行(stream と text)と終了コードに変換する純粋関数群。
// 標準出力への書き込みや process.exit は行わない。呼び出し側が表示と終了を担当する。

const { describeFailure } = require('./errors')

// 1 MB = 1024 * 1024 バイト
const MB = 1048576

const VALID_STATUSES = ['current', 'synced', 'skipped', 'error']

// 行頭に付ける接頭辞
const PREFIX = '[agy] '

// describeFailure の2行目以降に付けるインデント
const CONTINUATION_INDENT = '  '

const CONSENT_RETRY = 'もう一度 agy update または agy を実行して同意してください'

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

// 結果を解釈できなかったときの共通の戻り値
function unknownResult() {
  return {
    lines: [{ stream: 'err', text: `${PREFIX}結果を解釈できませんでした` }],
    code: 1,
  }
}

// describeFailure の行を、先頭だけ接頭辞、続く行は2文字インデントにして返す
function failureLines(info) {
  return describeFailure(info).map((row, i) => (i === 0 ? PREFIX + row : CONTINUATION_INDENT + row))
}

// バイト数を MB に丸める。正の値が 0 MB に丸まる場合だけ 1 MB とする
function toMegabytes(bytes) {
  const mb = Math.round(bytes / MB)
  return bytes > 0 && mb === 0 ? 1 : mb
}

// 取得・更新の主要な行を作る。installed が偽なら from/to は使わない
function mainLines({ installed, from, to, result }) {
  const { status, reason, tag } = result

  if (!installed) {
    if (status === 'current') {
      return { lines: [{ stream: 'out', text: `${PREFIX}バイナリは最新です (${tag})` }], code: 0 }
    }
    if (status === 'synced') {
      return { lines: [{ stream: 'out', text: `${PREFIX}バイナリを ${tag} に取得しました` }], code: 0 }
    }
    if (status === 'skipped' && reason === 'consent_declined') {
      return {
        lines: [{
          stream: 'out',
          text: `${PREFIX}同意されなかったため、バイナリは取得していません。取得するには、${CONSENT_RETRY}`,
        }],
        code: 0,
      }
    }
    if (status === 'skipped' && reason === 'compat_declined') {
      return {
        lines: [{
          stream: 'out',
          text: `${PREFIX}互換調整に同意されなかったため、バイナリは取得していません。取得するには、${CONSENT_RETRY}`,
        }],
        code: 0,
      }
    }
    // status は error
    if (reason === 'no_input') {
      return {
        lines: [{ stream: 'err', text: `${PREFIX}同意の入力がありません。端末から agy update または agy を実行してください` }],
        code: 1,
      }
    }
    if (reason === 'loader') {
      return {
        lines: [{ stream: 'err', text: `${PREFIX}glibc が必要です。pkg install glibc-repo && pkg install glibc を実行してから、もう一度 agy update を実行してください` }],
        code: 1,
      }
    }
    return {
      lines: failureLines(result.error ?? { code: reason, detail: result.detail }).map((text) => ({ stream: 'err', text })),
      code: 1,
    }
  }

  // installed が真: from は旧版 A、to は新版 B
  if (status === 'current' || status === 'synced') {
    return { lines: [{ stream: 'out', text: `${PREFIX}${from} → ${to} に更新しました` }], code: 0 }
  }
  if (status === 'skipped' && reason === 'consent_declined') {
    return {
      lines: [{
        stream: 'out',
        text: `${PREFIX}パッケージは ${to} に更新しました。同意されなかったため、バイナリは取得していません。取得するには、${CONSENT_RETRY}`,
      }],
      code: 0,
    }
  }
  if (status === 'skipped' && reason === 'compat_declined') {
    return {
      lines: [{
        stream: 'out',
        text: `${PREFIX}パッケージは ${to} に更新しました。互換調整に同意されなかったため、バイナリは取得していません。取得するには、${CONSENT_RETRY}`,
      }],
      code: 0,
    }
  }
  // status は error
  if (reason === 'no_input') {
    return {
      lines: [{
        stream: 'err',
        text: `${PREFIX}パッケージは ${to} に更新しました。同意の入力がありません。端末から agy update または agy を実行してください`,
      }],
      code: 1,
    }
  }
  if (reason === 'loader') {
    return {
      lines: [{
        stream: 'err',
        text: `${PREFIX}パッケージは ${to} に更新しました。glibc が必要です。pkg install glibc-repo && pkg install glibc を実行してから、もう一度 agy を実行してください`,
      }],
      code: 1,
    }
  }
  const rows = describeFailure(result.error ?? { code: reason, detail: result.detail })
  return {
    lines: [{
      stream: 'err',
      text: `${PREFIX}パッケージは ${to} に更新しました。バイナリの取得に失敗しました(${rows.join(' ')})。次に agy を実行すると取得し直します`,
    }],
    code: 1,
  }
}

// 最終結果を表示行と終了コードに変換する
function renderFinal({ installed, from, to, result } = {}) {
  if (!isObject(result) || !VALID_STATUSES.includes(result.status)) {
    return unknownResult()
  }
  // skipped の理由は仕様上この2つだけ。それ以外は解釈できないものとして扱う
  if (result.status === 'skipped' && result.reason !== 'consent_declined' && result.reason !== 'compat_declined') {
    return unknownResult()
  }

  const main = mainLines({ installed, from, to, result })
  const lines = main.lines.slice()

  // 古いキャッシュの削除報告。取得・更新が成功したときだけ、最終行の後ろに足す
  if (result.status === 'current' || result.status === 'synced') {
    const deleted = isObject(result.deleted) ? result.deleted : {}
    const count = typeof deleted.count === 'number' ? deleted.count : 0
    const bytes = typeof deleted.bytes === 'number' ? deleted.bytes : 0
    if (count >= 1) {
      lines.push({
        stream: 'out',
        text: `${PREFIX}古いキャッシュを削除しました: ${count} 件、${toMegabytes(bytes)} MB`,
      })
    }
  }

  return { lines, code: main.code }
}

// 子プロセスの結果(JSON)が届かなかったときの代替の最終行
function renderUnknownResult({ to, cause } = {}) {
  return {
    lines: [{
      stream: 'err',
      text: `${PREFIX}パッケージは ${to} に更新しました。バイナリの取得が完了したか確認できませんでした(${cause})。次に agy を実行すると必要なら取得し直します`,
    }],
    code: 1,
  }
}

// 検証を通った結果オブジェクトか判定する
function isValidResult(value) {
  if (!isObject(value)) return false
  if (!VALID_STATUSES.includes(value.status)) return false
  if (typeof value.tag !== 'string') return false
  if (!isObject(value.deleted)) return false
  return isNonNegativeInteger(value.deleted.count) && isNonNegativeInteger(value.deleted.bytes)
}

// 1行を JSON として読み、検証を通ったものだけを返す
function parseLine(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  return isValidResult(value) ? value : null
}

// 子が fd 3 に書いた文字列から、最後の完全な行を後ろから順に試して結果を取り出す
function parseResult(text) {
  if (typeof text !== 'string') return null

  const lines = text.split('\n')
  // 最後の要素は、改行で終わっていない不完全な行(または空文字)なので無視する
  lines.pop()

  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseLine(lines[i])
    if (parsed) return parsed
  }
  return null
}

module.exports = { renderFinal, renderUnknownResult, parseResult }
