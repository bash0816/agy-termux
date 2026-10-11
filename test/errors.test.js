'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  typedError,
  classifyTarStderr,
  classifyNpmFailure,
  describeFailure,
  diagnoseLowSpace,
} = require('../lib/errors')

const MB = 1024 * 1024

test('typedError: code と props を持つ Error を作る', () => {
  const err = typedError('E_HTTP', { httpStatus: 404, detail: '配布元の応答' })
  assert.ok(err instanceof Error)
  assert.equal(err.code, 'E_HTTP')
  assert.equal(err.httpStatus, 404)
  assert.equal(err.message, '配布元の応答')
})

test('typedError: message が無ければ code を使う', () => {
  assert.equal(typedError('E_SHA').message, 'E_SHA')
  assert.equal(typedError('E_SHA', { message: '指定の文言' }).message, '指定の文言')
})

test('typedError: undefined の props は代入しない', () => {
  const err = typedError('ENOSPC', { errno: undefined, path: '/a/b' })
  assert.equal(err.path, '/a/b')
  assert.equal(Object.hasOwn(err, 'errno'), false)
})

test('classifyTarStderr: 容量・権限・読み取り専用の判定とパス', () => {
  assert.deepStrictEqual(
    classifyTarStderr('tar: ./a.node: Cannot write: No space left on device'),
    { code: 'ENOSPC', line: 'tar: ./a.node: Cannot write: No space left on device', path: './a.node' },
  )
  assert.deepStrictEqual(
    classifyTarStderr('tar: ./b.node: Cannot write: Disk quota exceeded').code,
    'EDQUOT',
  )
  assert.deepStrictEqual(
    classifyTarStderr('tar: ./c.node: Cannot open: Permission denied'),
    { code: 'EACCES', line: 'tar: ./c.node: Cannot open: Permission denied', path: './c.node' },
  )
  assert.equal(classifyTarStderr('tar: ./d: Cannot mkdir: Read-only file system').code, 'EROFS')
})

test('classifyTarStderr: Operation not permitted は EPERM。汎用の Cannot open 行ではパスを取らない', () => {
  assert.deepStrictEqual(
    classifyTarStderr('tar: Cannot open: Operation not permitted'),
    { code: 'EPERM', line: 'tar: Cannot open: Operation not permitted', path: undefined },
  )
})

test('classifyTarStderr: 破損の根拠になる行は E_TAR_CORRUPT(パスは取らない)', () => {
  for (const line of [
    'tar: Unexpected EOF in archive',
    'gzip: stdin: not in gzip format',
    'tar: invalid tar header',
    'tar: Skipping to next header',
  ]) {
    assert.deepStrictEqual(classifyTarStderr(line), { code: 'E_TAR_CORRUPT', line, path: undefined }, line)
  }
})

test('classifyTarStderr: 表にない行は破損と断定せず E_TAR_UNKNOWN', () => {
  assert.equal(classifyTarStderr('tar: This does not look like a tar archive').code, 'E_TAR_UNKNOWN')
})

test('classifyTarStderr: 汎用の行だけなら E_TAR_UNKNOWN(破損とは断定しない)', () => {
  assert.deepStrictEqual(
    classifyTarStderr('tar: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now'),
    { code: 'E_TAR_UNKNOWN', line: '', lastLine: 'tar: Error is not recoverable: exiting now' },
  )
})

test('classifyTarStderr: 末尾が汎用の終了文でも、前の具体的な原因行を採用する', () => {
  assert.deepStrictEqual(
    classifyTarStderr('tar: ./x.tgz: Unexpected EOF in archive\ntar: Error is not recoverable: exiting now'),
    {
      code: 'E_TAR_CORRUPT',
      line: 'tar: ./x.tgz: Unexpected EOF in archive',
      path: './x.tgz',
    },
  )
})

test('classifyTarStderr: 認識できない具体的な行は E_TAR_UNKNOWN と行を返す', () => {
  assert.deepStrictEqual(
    classifyTarStderr('tar: Something odd happened: boom\ntar: Error is not recoverable: exiting now'),
    {
      code: 'E_TAR_UNKNOWN',
      line: 'tar: Something odd happened: boom',
      lastLine: 'tar: Error is not recoverable: exiting now',
    },
  )
})

test('classifyTarStderr: 空の stderr は E_TAR_UNKNOWN(行は空)', () => {
  assert.deepStrictEqual(classifyTarStderr(''), { code: 'E_TAR_UNKNOWN', line: '', lastLine: '' })
  assert.deepStrictEqual(classifyTarStderr(undefined), { code: 'E_TAR_UNKNOWN', line: '', lastLine: '' })
})

test('classifyNpmFailure: timeout は E_NPM_TIMEOUT(最後の行を添える)', () => {
  assert.deepStrictEqual(
    classifyNpmFailure({ stderrTail: 'npm ERR! timing\nnpm ERR! last line', timedOut: true }),
    { code: 'E_NPM_TIMEOUT', line: 'npm ERR! last line' },
  )
})

test('classifyNpmFailure: 容量不足は ENOSPC', () => {
  assert.deepStrictEqual(
    classifyNpmFailure({ stderrTail: 'npm ERR! code ENOSPC\nnpm ERR! No space left on device' }),
    { code: 'ENOSPC', line: 'npm ERR! code ENOSPC' },
  )
  assert.equal(classifyNpmFailure({ stderrTail: 'npm ERR! No space left on device' }).code, 'ENOSPC')
})

test('classifyNpmFailure: 権限系は EACCES(大文字小文字は区別しない)', () => {
  assert.deepStrictEqual(
    classifyNpmFailure({ stderrTail: 'npm ERR! code EACCES' }),
    { code: 'EACCES', line: 'npm ERR! code EACCES' },
  )
  assert.equal(classifyNpmFailure({ stderrTail: 'npm ERR! code EPERM' }).code, 'EACCES')
  assert.equal(classifyNpmFailure({ stderrTail: 'Permission Denied: /x' }).code, 'EACCES')
})

test('classifyNpmFailure: 通信系は E_NET', () => {
  assert.deepStrictEqual(
    classifyNpmFailure({ stderrTail: 'npm ERR! code ETIMEDOUT\nnpm ERR! network timeout' }),
    { code: 'E_NET', line: 'npm ERR! code ETIMEDOUT' },
  )
  for (const token of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED']) {
    assert.equal(classifyNpmFailure({ stderrTail: `npm ERR! ${token}` }).code, 'E_NET', token)
  }
})

test('classifyNpmFailure: 分類できなければ E_NPM_UNKNOWN と最後の行', () => {
  assert.deepStrictEqual(
    classifyNpmFailure({ stderrTail: 'npm ERR! first\nnpm ERR! last' }),
    { code: 'E_NPM_UNKNOWN', line: 'npm ERR! last' },
  )
  assert.deepStrictEqual(classifyNpmFailure({}), { code: 'E_NPM_UNKNOWN', line: '' })
})

test('describeFailure: 通信の停止・接続不可(E_STALL / E_NET)の文言', () => {
  const expected = ['通信が止まりました(または接続できません)。ネットワークを確認して、もう一度 agy update を実行してください']
  assert.deepStrictEqual(describeFailure({ code: 'E_STALL' }), expected)
  assert.deepStrictEqual(describeFailure({ code: 'E_NET' }), expected)
})

test('describeFailure: HTTP エラーの文言(status を含む)', () => {
  assert.deepStrictEqual(describeFailure({ code: 'E_HTTP', httpStatus: 404 }), [
    '配布元が応答しませんでした (HTTP 404)。しばらくしてからもう一度実行してください',
  ])
})

test('describeFailure: 検証失敗(E_SHA / E_ELF / E_TAR_CORRUPT)の文言', () => {
  const expected = [
    'ダウンロードしたファイルの検証に失敗しました。ファイルは破棄しました。もう一度実行してください。繰り返す場合は Issue で報告してください',
  ]
  for (const code of ['E_SHA', 'E_ELF', 'E_TAR_CORRUPT']) {
    assert.deepStrictEqual(describeFailure({ code }), expected, code)
  }
})

test('describeFailure: E_TAR_UNKNOWN の文言(原因の行を添える)', () => {
  assert.deepStrictEqual(describeFailure({ code: 'E_TAR_UNKNOWN', detail: 'tar: boom' }), [
    '展開に失敗しました(原因を特定できません: tar: boom)。もう一度実行してください。繰り返す場合は Issue で報告してください',
  ])
})

test('describeFailure: 容量不足(ENOSPC / EDQUOT)の文言。パスがあれば示す', () => {
  for (const errno of ['ENOSPC', 'EDQUOT']) {
    assert.deepStrictEqual(describeFailure({ errno, path: '/d/a.node' }), [
      '保存できません(容量不足): /d/a.node。空き容量を確認してください(古いキャッシュは ~/.agy-termux に残っています)',
    ], errno)
    assert.deepStrictEqual(describeFailure({ errno }), [
      '保存できません(容量不足)。空き容量を確認してください(古いキャッシュは ~/.agy-termux に残っています)',
    ], errno)
  }
})

test('describeFailure: 権限系(EACCES / EPERM / EROFS)の文言。容量の案内は出さない', () => {
  for (const errno of ['EACCES', 'EPERM', 'EROFS']) {
    const lines = describeFailure({ errno, path: '/home/u/.agy-termux/bin' })
    assert.deepStrictEqual(lines, [
      '保存できません(権限エラー): /home/u/.agy-termux/bin。このフォルダへの書き込み権限を確認してください',
      '例: ls -ld /home/u/.agy-termux',
    ], errno)
    assert.equal(lines.join('\n').includes('空き容量'), false, errno)
  }
})

test('describeFailure: 権限系でパスが無ければ 1 行だけ出す', () => {
  assert.deepStrictEqual(describeFailure({ errno: 'EACCES' }), [
    '保存できません(権限エラー)。このフォルダへの書き込み権限を確認してください',
  ])
})

test('describeFailure: 容量不足の可能性(E_NOSPACE_MAYBE)は MB 単位で断定しない', () => {
  assert.deepStrictEqual(describeFailure({ code: 'E_NOSPACE_MAYBE', free: 100 * MB + 5 }), [
    '保存できません(容量不足の可能性があります。空き容量 約 100 MB)。空きを作ってから、もう一度実行してください',
  ])
  assert.deepStrictEqual(describeFailure({ code: 'E_NOSPACE_MAYBE' }), [
    '保存できません(容量不足の可能性があります。空き容量は不明)。空きを作ってから、もう一度実行してください',
  ])
})

test('describeFailure: npm の timeout(E_NPM_TIMEOUT)と分類できない失敗(E_NPM_UNKNOWN)', () => {
  assert.deepStrictEqual(describeFailure({ code: 'E_NPM_TIMEOUT' }), [
    '通信できませんでした。ネットワークを確認してから、もう一度 agy update を実行してください',
  ])
  assert.deepStrictEqual(describeFailure({ code: 'E_NPM_UNKNOWN', detail: 'npm ERR! x' }), [
    '失敗しました(原因を特定できません: npm ERR! x)。もう一度実行してください',
  ])
})

test('describeFailure: 容量系の文言に「権限」を含めない', () => {
  for (const errno of ['ENOSPC', 'EDQUOT']) {
    assert.equal(describeFailure({ errno, path: '/p' }).join('\n').includes('権限'), false, errno)
  }
})

test('describeFailure: errno は code より優先する', () => {
  assert.deepStrictEqual(describeFailure({ code: 'E_HTTP', errno: 'EACCES', path: '/p/q' }), [
    '保存できません(権限エラー): /p/q。このフォルダへの書き込み権限を確認してください',
    '例: ls -ld /p',
  ])
})

test('diagnoseLowSpace: 既定の閾値 64MB 未満で true', () => {
  assert.equal(diagnoseLowSpace({ free: 10 * MB }), true)
  assert.equal(diagnoseLowSpace({ free: 64 * MB - 1 }), true)
  assert.equal(diagnoseLowSpace({ free: 64 * MB }), false)
  assert.equal(diagnoseLowSpace({ free: 200 * MB }), false)
})

test('diagnoseLowSpace: free が無い・数値でない場合は false', () => {
  assert.equal(diagnoseLowSpace({}), false)
  assert.equal(diagnoseLowSpace({ free: undefined }), false)
  assert.equal(diagnoseLowSpace({ free: '1' }), false)
})

test('diagnoseLowSpace: 閾値を指定できる', () => {
  assert.equal(diagnoseLowSpace({ free: 5, threshold: 10 }), true)
  assert.equal(diagnoseLowSpace({ free: 10, threshold: 10 }), false)
})
