'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readProcStart, killPid, sleep, makeEnsureDeps } = require('../lib/ensure-wiring')

// 22 番目(starttime)が 987654 の偽 stat。comm は空白と括弧を含む
function fakeStat(starttime) {
  const after = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 4)), starttime]
  return `1234 (a b) c) ${after.join(' ')}`
}

function errWithCode(code) {
  return Object.assign(new Error(code), { code })
}

function existsEntry(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

test('readProcStart: comm に空白と括弧を含んでも starttime を返す', () => {
  const got = readProcStart(1234, () => fakeStat('987654'))
  assert.equal(got, '987654')
})

test('readProcStart: 欄不足・空・読込例外は null', () => {
  assert.equal(readProcStart(1234, () => '1234 (x) S 1 2'), null)
  assert.equal(readProcStart(1234, () => ''), null)
  assert.equal(readProcStart(1234, () => { throw errWithCode('ENOENT') }), null)
})

test('readProcStart: 実 /proc/self/stat から数字列を返す', () => {
  const got = readProcStart(process.pid)
  assert.equal(typeof got, 'string')
  assert.match(got, /^\d+$/)
})

test('killPid: kill の結果を alive / esrch / eperm / unknown に分類する', () => {
  assert.equal(killPid(1234, () => undefined), 'alive')
  assert.equal(killPid(1234, () => { throw errWithCode('ESRCH') }), 'esrch')
  assert.equal(killPid(1234, () => { throw errWithCode('EPERM') }), 'eperm')
  assert.equal(killPid(1234, () => { throw errWithCode('EINVAL') }), 'unknown')
})

test('sleep: 指定時間後に解決する', async () => {
  const start = Date.now()
  await sleep(20)
  assert.ok(Date.now() - start >= 15, '指定時間より早く解決した')
})

test('makeEnsureDeps: 戻り値に必要なキーが揃う', () => {
  const deps = makeEnsureDeps({
    fs,
    download: () => {},
    patch: () => {},
    onPhase: () => {},
    progress: () => {},
    stallMs: 1000,
    npmVersion: 'test',
    hooks: {},
  })
  for (const k of ['fs', 'download', 'patch', 'pid', 'now', 'randomHex', 'onPhase', 'progress', 'stallMs', 'npmVersion', 'hooks', 'acquireLock']) {
    assert.ok(k in deps, `キーが無い: ${k}`)
  }
  assert.equal(typeof deps.acquireLock, 'function')
  assert.equal(deps.fs, fs)
  assert.equal(deps.pid, process.pid)
  assert.match(deps.randomHex(), /^[0-9a-f]{8}$/)
})

test('makeEnsureDeps: 実ファイルシステムで acquireLock がロックを作り release で消え、完了済みなら取らずに抜ける', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-wiring-'))
  try {
    const lockPath = path.join(dir, 'gen.lock')
    const deps = makeEnsureDeps({
      fs,
      download: () => {},
      patch: () => {},
      npmVersion: 'test',
      sleep: async () => {},
    })

    const first = await deps.acquireLock(lockPath, { checkDone: () => false, onWait: () => {} })
    assert.equal(first.acquired, true)
    assert.equal(existsEntry(lockPath), true, 'ロックが作られていない')
    // ロックを保持したまま 2 つ目を呼ぶ。完了済みなら取得せず done で抜ける
    const second = await deps.acquireLock(lockPath, { checkDone: () => true, onWait: () => {} })
    assert.deepEqual({ acquired: second.acquired, done: second.done }, { acquired: false, done: true })

    first.release()
    assert.equal(existsEntry(lockPath), false, 'release でロックが消えていない')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
