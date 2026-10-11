'use strict'

// lib/render-final.js の単体テスト。node:test と node:assert を使う。

const { test } = require('node:test')
const assert = require('node:assert')
const { renderFinal, renderUnknownResult, parseResult } = require('../lib/render-final')
const { describeFailure } = require('../lib/errors')

const MB = 1048576
const P = '[agy] '
const RETRY = 'もう一度 agy update または agy を実行して同意してください'

// 出力の期待値。describeFailure の行から作る。先頭だけ接頭辞、続く行は2文字インデント
function expectedFailureTexts(info) {
  const rows = describeFailure(info)
  return rows.map((row, i) => (i === 0 ? P + row : '  ' + row))
}

// ---- installed が偽 ----

test('installed 偽・current: 最新の文言と code 0', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'current', tag: '1.2.3', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{ stream: 'out', text: '[agy] バイナリは最新です (1.2.3)' }],
    code: 0,
  })
})

test('installed 偽・synced: 取得の文言と code 0', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'synced', tag: '1.2.3', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{ stream: 'out', text: '[agy] バイナリを 1.2.3 に取得しました' }],
    code: 0,
  })
})

test('installed 偽・skipped consent_declined: 文言・out・code 0', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'skipped', reason: 'consent_declined', tag: '1.2.3', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'out',
      text: `[agy] 同意されなかったため、バイナリは取得していません。取得するには、${RETRY}`,
    }],
    code: 0,
  })
})

test('installed 偽・skipped compat_declined: 文言・out・code 0', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'skipped', reason: 'compat_declined', tag: '1.2.3', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'out',
      text: `[agy] 互換調整に同意されなかったため、バイナリは取得していません。取得するには、${RETRY}`,
    }],
    code: 0,
  })
})

test('installed 偽・error no_input: 文言・err・code 1', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'error', reason: 'no_input', tag: '', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'err',
      text: '[agy] 同意の入力がありません。端末から agy update または agy を実行してください',
    }],
    code: 1,
  })
})

test('installed 偽・error その他(1行): describeFailure の文言が入り、err・code 1', () => {
  const error = { code: 'E_SHA' }
  const out = renderFinal({
    installed: false,
    result: { status: 'error', reason: 'E_SHA', error, tag: '', deleted: { count: 0, bytes: 0 } },
  })
  const texts = expectedFailureTexts(error)
  assert.strictEqual(texts.length, 1)
  assert.deepStrictEqual(out, {
    lines: texts.map((text) => ({ stream: 'err', text })),
    code: 1,
  })
})

test('installed 偽・error その他(複数行): 先頭だけ接頭辞、続く行は2文字インデント', () => {
  const error = { code: 'EACCES', path: '/data/x/y' }
  const rows = describeFailure(error)
  assert.ok(rows.length >= 2, '複数行の describeFailure 出力を前提にしている')
  const out = renderFinal({
    installed: false,
    result: { status: 'error', reason: 'EACCES', error, tag: '', deleted: { count: 0, bytes: 0 } },
  })
  assert.strictEqual(out.code, 1)
  assert.deepStrictEqual(out.lines, expectedFailureTexts(error).map((text) => ({ stream: 'err', text })))
  assert.strictEqual(out.lines[0].text.startsWith(P), true)
  assert.strictEqual(out.lines[1].text.startsWith('  '), true)
  assert.strictEqual(out.lines[1].text.startsWith(P), false)
})

test('installed 偽・error その他: error が無いときは reason と detail から describeFailure を作る', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'error', reason: 'E_SHA', detail: 'abc', tag: '', deleted: { count: 0, bytes: 0 } },
  })
  const texts = expectedFailureTexts({ code: 'E_SHA', detail: 'abc' })
  assert.deepStrictEqual(out, {
    lines: texts.map((text) => ({ stream: 'err', text })),
    code: 1,
  })
})

// ---- installed が真 ----

test('installed 真・current: 「旧 → 新」の更新文言と code 0', () => {
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'current', tag: '1.1.0', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{ stream: 'out', text: '[agy] 1.0.0 → 1.1.0 に更新しました' }],
    code: 0,
  })
})

test('installed 真・synced: 「旧 → 新」の更新文言と code 0', () => {
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'synced', tag: '1.1.0', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{ stream: 'out', text: '[agy] 1.0.0 → 1.1.0 に更新しました' }],
    code: 0,
  })
})

test('installed 真・skipped consent_declined: 文言・out・code 0', () => {
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'skipped', reason: 'consent_declined', tag: '1.0.0', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'out',
      text: `[agy] パッケージは 1.1.0 に更新しました。同意されなかったため、バイナリは取得していません。取得するには、${RETRY}`,
    }],
    code: 0,
  })
})

test('installed 真・skipped compat_declined: 文言・out・code 0', () => {
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'skipped', reason: 'compat_declined', tag: '1.0.0', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'out',
      text: `[agy] パッケージは 1.1.0 に更新しました。互換調整に同意されなかったため、バイナリは取得していません。取得するには、${RETRY}`,
    }],
    code: 0,
  })
})

test('installed 真・error no_input: 文言・err・code 1', () => {
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'error', reason: 'no_input', tag: '', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'err',
      text: '[agy] パッケージは 1.1.0 に更新しました。同意の入力がありません。端末から agy update または agy を実行してください',
    }],
    code: 1,
  })
})

test('installed 真・error その他: describeFailure の行を半角スペースで連結し、err・code 1', () => {
  const error = { code: 'EACCES', path: '/data/x/y' }
  const rows = describeFailure(error)
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'error', reason: 'EACCES', error, tag: '', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'err',
      text: `[agy] パッケージは 1.1.0 に更新しました。バイナリの取得に失敗しました(${rows.join(' ')})。次に agy を実行すると取得し直します`,
    }],
    code: 1,
  })
})

// ---- 削除報告 ----

test('削除報告: current で count 1 以上なら最終行の後ろに out で足す', () => {
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'synced', tag: '1.1.0', deleted: { count: 2, bytes: 3 * MB } },
  })
  assert.deepStrictEqual(out, {
    lines: [
      { stream: 'out', text: '[agy] 1.0.0 → 1.1.0 に更新しました' },
      { stream: 'out', text: '[agy] 古いキャッシュを削除しました: 2 件、3 MB' },
    ],
    code: 0,
  })
})

test('削除報告: installed 偽の synced でも count 1 以上なら足す', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'synced', tag: '1.2.3', deleted: { count: 1, bytes: MB } },
  })
  assert.deepStrictEqual(out, {
    lines: [
      { stream: 'out', text: '[agy] バイナリを 1.2.3 に取得しました' },
      { stream: 'out', text: '[agy] 古いキャッシュを削除しました: 1 件、1 MB' },
    ],
    code: 0,
  })
})

test('削除報告: count 0 のときは足さない', () => {
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'current', tag: '1.1.0', deleted: { count: 0, bytes: 5 * MB } },
  })
  assert.strictEqual(out.lines.length, 1)
  assert.strictEqual(out.lines[0].text, '[agy] 1.0.0 → 1.1.0 に更新しました')
})

test('削除報告: skipped では count 1 以上でも足さない', () => {
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'skipped', reason: 'consent_declined', tag: '1.0.0', deleted: { count: 1, bytes: MB } },
  })
  assert.strictEqual(out.lines.length, 1)
  assert.strictEqual(out.lines[0].stream, 'out')
  assert.ok(out.lines[0].text.startsWith('[agy] パッケージは 1.1.0 に更新しました。同意されなかった'))
})

test('削除報告: error では count 1 以上でも足さない', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'error', reason: 'no_input', tag: '', deleted: { count: 1, bytes: MB } },
  })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'err',
      text: '[agy] 同意の入力がありません。端末から agy update または agy を実行してください',
    }],
    code: 1,
  })
})

test('削除報告: MB は Math.round(bytes / 1048576) で丸める', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'current', tag: '1.2.3', deleted: { count: 1, bytes: Math.round(2.6 * MB) } },
  })
  assert.strictEqual(out.lines[1].text, '[agy] 古いキャッシュを削除しました: 1 件、3 MB')
})

test('削除報告: bytes が正で丸めると 0 になる場合は 1 MB', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'current', tag: '1.2.3', deleted: { count: 1, bytes: 1 } },
  })
  assert.strictEqual(out.lines[1].text, '[agy] 古いキャッシュを削除しました: 1 件、1 MB')
})

test('削除報告: bytes が 0 のときは 0 MB のまま', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'current', tag: '1.2.3', deleted: { count: 1, bytes: 0 } },
  })
  assert.strictEqual(out.lines[1].text, '[agy] 古いキャッシュを削除しました: 1 件、0 MB')
})

// ---- 未知の status・result 無し ----

const UNKNOWN = {
  lines: [{ stream: 'err', text: '[agy] 結果を解釈できませんでした' }],
  code: 1,
}

test('未知の status は「結果を解釈できませんでした」', () => {
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'weird', tag: '', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, UNKNOWN)
})

test('result が無い・オブジェクトでない場合も「結果を解釈できませんでした」', () => {
  assert.deepStrictEqual(renderFinal({ installed: false }), UNKNOWN)
  assert.deepStrictEqual(renderFinal({ installed: false, result: 'x' }), UNKNOWN)
  assert.deepStrictEqual(renderFinal({ installed: false, result: null }), UNKNOWN)
  assert.deepStrictEqual(renderFinal(), UNKNOWN)
})

// ---- renderUnknownResult ----

test('renderUnknownResult: 文言・err・code 1', () => {
  const out = renderUnknownResult({ to: '1.1.0', cause: 'EIO' })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'err',
      text: '[agy] パッケージは 1.1.0 に更新しました。バイナリの取得が完了したか確認できませんでした(EIO)。次に agy を実行すると必要なら取得し直します',
    }],
    code: 1,
  })
})

// ---- parseResult ----

const GOOD = { status: 'synced', tag: '1.0.0', deleted: { count: 0, bytes: 0 } }
const goodLine = JSON.stringify(GOOD)

function line(overrides) {
  return JSON.stringify({ ...GOOD, ...overrides })
}

test('parseResult: 正常な1行(改行で終わる)を読む', () => {
  assert.deepStrictEqual(parseResult(goodLine + '\n'), GOOD)
})

test('parseResult: 改行で終わらない行は無視する', () => {
  assert.strictEqual(parseResult(goodLine), null)
})

test('parseResult: 末尾の不完全な行は無視する', () => {
  assert.deepStrictEqual(parseResult(goodLine + '\n{"status":"cur'), GOOD)
})

test('parseResult: 最後の行が不正なら一つ前の正常な行を採用する', () => {
  const text = goodLine + '\n' + line({ status: 'bogus' }) + '\n'
  assert.deepStrictEqual(parseResult(text), GOOD)
})

test('parseResult: 全部不正なら null', () => {
  const text = 'not json\n' + line({ status: 'bogus' }) + '\n'
  assert.strictEqual(parseResult(text), null)
})

test('parseResult: status が不正なら不採用', () => {
  assert.strictEqual(parseResult(line({ status: 'bogus' }) + '\n'), null)
})

test('parseResult: tag が文字列でなければ不採用', () => {
  assert.strictEqual(parseResult(line({ tag: 1 }) + '\n'), null)
  assert.strictEqual(parseResult(line({ tag: undefined }) + '\n'), null)
})

test('parseResult: deleted の count・bytes が負・小数・欠落なら不採用', () => {
  assert.strictEqual(parseResult(line({ deleted: { count: -1, bytes: 0 } }) + '\n'), null)
  assert.strictEqual(parseResult(line({ deleted: { count: 1.5, bytes: 0 } }) + '\n'), null)
  assert.strictEqual(parseResult(line({ deleted: { count: 0, bytes: -1 } }) + '\n'), null)
  assert.strictEqual(parseResult(line({ deleted: { count: 0, bytes: 0.5 } }) + '\n'), null)
  assert.strictEqual(parseResult(line({ deleted: undefined }) + '\n'), null)
  assert.strictEqual(parseResult(line({ deleted: { bytes: 0 } }) + '\n'), null)
})

test('parseResult: 空文字列は null', () => {
  assert.strictEqual(parseResult(''), null)
})

test('parseResult: オブジェクトでない JSON は不採用', () => {
  assert.strictEqual(parseResult('null\n'), null)
  assert.strictEqual(parseResult('[1]\n'), null)
})

test('installed 偽・error loader: glibc の案内文・err・code 1', () => {
  const out = renderFinal({
    installed: false,
    result: { status: 'error', reason: 'loader', tag: '', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'err',
      text: '[agy] glibc が必要です。pkg install glibc-repo && pkg install glibc を実行してから、もう一度 agy update を実行してください',
    }],
    code: 1,
  })
})

test('installed 真・error loader: 更新済みの旨と glibc の案内文・err・code 1', () => {
  const out = renderFinal({
    installed: true,
    from: '1.0.0',
    to: '1.1.0',
    result: { status: 'error', reason: 'loader', tag: '', deleted: { count: 0, bytes: 0 } },
  })
  assert.deepStrictEqual(out, {
    lines: [{
      stream: 'err',
      text: '[agy] パッケージは 1.1.0 に更新しました。glibc が必要です。pkg install glibc-repo && pkg install glibc を実行してから、もう一度 agy を実行してください',
    }],
    code: 1,
  })
})
