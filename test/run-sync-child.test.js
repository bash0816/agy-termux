'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runSyncChild } = require('../lib/run-sync-child.js')

// 偽の fd 3 読み取りストリーム
function makeFd3() {
  const s = new EventEmitter()
  s.encoding = null
  s.destroyed = false
  s.setEncoding = (enc) => {
    s.encoding = enc
  }
  s.destroy = () => {
    s.destroyed = true
  }
  return s
}

// 偽の spawn。withPipe=false のとき stdio[3] を作らない
function makeFakeSpawn({ withPipe = true, throwError = null } = {}) {
  const calls = []
  const child = new EventEmitter()
  const fd3 = makeFd3()
  child.stdio = withPipe ? [null, null, null, fd3] : [null, null, null]
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    if (throwError) throw throwError
    return child
  }
  return { spawn, child, fd3, calls }
}

// 手動で進められる偽タイマー
function makeFakeTimers() {
  let nextId = 1
  const pending = new Map()
  const scheduled = []
  return {
    scheduled,
    setTimeout(fn, ms) {
      const id = nextId++
      pending.set(id, fn)
      scheduled.push(ms)
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    get pendingCount() {
      return pending.size
    },
    fireAll() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id)
        fn()
      }
    },
  }
}

function baseOpts(fake, timers, extra = {}) {
  return {
    spawn: fake.spawn,
    execPath: '/node',
    script: '/pkg/bin/agy.js',
    args: ['update', '--sync-binary-only', '--result-fd=3'],
    env: { A: '1' },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...extra,
  }
}

test('spawn に execPath・[script, ...args]・stdio・env を渡す', async () => {
  const fake = makeFakeSpawn()
  const timers = makeFakeTimers()
  const env = { A: '1' }
  const p = runSyncChild(baseOpts(fake, timers, { env }))
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].cmd, '/node')
  assert.deepEqual(fake.calls[0].args, [
    '/pkg/bin/agy.js',
    'update',
    '--sync-binary-only',
    '--result-fd=3',
  ])
  assert.deepEqual(fake.calls[0].opts.stdio, ['inherit', 'inherit', 'inherit', 'pipe'])
  assert.equal(fake.calls[0].opts.env, env)
  fake.child.emit('exit', 0, null)
  fake.fd3.emit('end')
  await p
})

test('子が JSON 行を書いて exit し、続いて EOF が来たら text と code=0 で確定する', async () => {
  const fake = makeFakeSpawn()
  const timers = makeFakeTimers()
  const p = runSyncChild(baseOpts(fake, timers))
  assert.equal(fake.fd3.encoding, 'utf8')
  fake.fd3.emit('data', '{"status":"synced"}\n')
  fake.child.emit('exit', 0, null)
  fake.fd3.emit('end')
  const r = await p
  assert.deepEqual(r, { text: '{"status":"synced"}\n', code: 0, signal: null, error: null })
})

test('exit の後で EOF が来る前に届いた追加の出力も text に含まれる', async () => {
  const fake = makeFakeSpawn()
  const timers = makeFakeTimers()
  const p = runSyncChild(baseOpts(fake, timers))
  fake.fd3.emit('data', 'first\n')
  fake.child.emit('exit', 0, null)
  fake.fd3.emit('data', 'extra\n')
  fake.fd3.emit('end')
  const r = await p
  assert.equal(r.text, 'first\nextra\n')
  assert.equal(r.code, 0)
})

test('exit の後 eofWaitMs で EOF が来なければ destroy して、それまでの text で確定する', async () => {
  const fake = makeFakeSpawn()
  const timers = makeFakeTimers()
  const p = runSyncChild(baseOpts(fake, timers))
  fake.fd3.emit('data', '{"status":"sy')
  fake.child.emit('exit', 3, null)
  assert.deepEqual(timers.scheduled, [2000])
  assert.equal(fake.fd3.destroyed, false)
  timers.fireAll()
  const r = await p
  assert.equal(r.text, '{"status":"sy')
  assert.equal(r.code, 3)
  assert.equal(r.signal, null)
  assert.equal(r.error, null)
  assert.equal(fake.fd3.destroyed, true)
})

test('子が何も書かずに exit したら text は空文字', async () => {
  const fake = makeFakeSpawn()
  const timers = makeFakeTimers()
  const p = runSyncChild(baseOpts(fake, timers))
  fake.child.emit('exit', 3, null)
  fake.fd3.emit('end')
  const r = await p
  assert.deepEqual(r, { text: '', code: 3, signal: null, error: null })
})

test('signal で終了したら signal が入り code は null', async () => {
  const fake = makeFakeSpawn()
  const timers = makeFakeTimers()
  const p = runSyncChild(baseOpts(fake, timers))
  fake.child.emit('exit', null, 'SIGKILL')
  fake.fd3.emit('end')
  const r = await p
  assert.deepEqual(r, { text: '', code: null, signal: 'SIGKILL', error: null })
})

test('spawn 失敗(error)で error が入り、その後の exit/EOF は無視される', async () => {
  const fake = makeFakeSpawn()
  const timers = makeFakeTimers()
  const p = runSyncChild(baseOpts(fake, timers))
  const e = new Error('ENOENT')
  fake.fd3.emit('data', 'abc')
  fake.child.emit('error', e)
  const r = await p
  assert.equal(r.error, e)
  assert.equal(r.code, null)
  assert.equal(r.signal, null)
  assert.equal(r.text, 'abc')
  // 確定後の exit / EOF / データは結果を変えない
  fake.child.emit('exit', 0, null)
  fake.fd3.emit('data', 'late')
  fake.fd3.emit('end')
  timers.fireAll()
  assert.equal(r.text, 'abc')
  assert.equal(r.code, null)
  assert.equal(r.error, e)
})

test('exit 後の待ち中に error が来ても一度だけ確定し、未発火タイマーは残らない', async () => {
  const fake = makeFakeSpawn()
  const timers = makeFakeTimers()
  const p = runSyncChild(baseOpts(fake, timers))
  fake.child.emit('exit', 0, null)
  assert.equal(timers.pendingCount, 1)
  const e = new Error('kill failed')
  fake.child.emit('error', e)
  const r = await p
  assert.equal(r.error, e)
  assert.equal(timers.pendingCount, 0)
})

test('確定後に未発火タイマーが残らない(exit の後に EOF で確定した場合)', async () => {
  const fake = makeFakeSpawn()
  const timers = makeFakeTimers()
  const p = runSyncChild(baseOpts(fake, timers))
  fake.child.emit('exit', 0, null)
  assert.equal(timers.pendingCount, 1)
  fake.fd3.emit('end')
  const r = await p
  assert.equal(r.code, 0)
  assert.equal(timers.pendingCount, 0)
})

test('stdio[3] が無い場合は text 空文字で exit により確定する', async () => {
  const fake = makeFakeSpawn({ withPipe: false })
  const timers = makeFakeTimers()
  const p = runSyncChild(baseOpts(fake, timers))
  fake.child.emit('exit', 0, null)
  const r = await p
  assert.deepEqual(r, { text: '', code: 0, signal: null, error: null })
  assert.equal(timers.pendingCount, 0)
})

test('spawn が同期的に例外を投げても、例外は外へ出さず error で確定する', async () => {
  const fake = makeFakeSpawn({ throwError: new Error('EACCES') })
  const timers = makeFakeTimers()
  const r = await runSyncChild(baseOpts(fake, timers))
  assert.equal(r.text, '')
  assert.equal(r.code, null)
  assert.equal(r.signal, null)
  assert.equal(r.error.message, 'EACCES')
})

test('fd 3 の読み取りエラーは EOF と同じく扱い、それまでの text で確定する', async () => {
  const fake = makeFakeSpawn()
  const timers = makeFakeTimers()
  const p = runSyncChild(baseOpts(fake, timers))
  fake.fd3.emit('data', 'partial')
  fake.child.emit('exit', 0, null)
  fake.fd3.emit('error', new Error('read failed'))
  const r = await p
  assert.deepEqual(r, { text: 'partial', code: 0, signal: null, error: null })
})

test('実プロセス: 子が fd 3 に書いた結果を受け取る', async () => {
  const script = path.join(
    os.tmpdir(),
    `run-sync-child-smoke-${process.pid}-${Date.now()}.js`,
  )
  fs.writeFileSync(script, "require('fs').writeSync(3, '{\"status\":\"synced\"}\\n')\n")
  try {
    const r = await runSyncChild({ execPath: process.execPath, script })
    assert.equal(r.error, null)
    assert.equal(r.code, 0)
    assert.equal(r.signal, null)
    assert.equal(r.text, '{"status":"synced"}\n')
  } finally {
    fs.rmSync(script, { force: true })
  }
})
