'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { runNpm } = require('../lib/run-npm')

// 偽の時計・タイマー。advance(ms) で時刻を進め、期限の来たタイマーを順に発火させる
function createFakeClock() {
  let current = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { at: current + ms, fn, interval: null })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    setInterval(fn, ms) {
      const id = nextId++
      timers.set(id, { at: current + ms, fn, interval: ms })
      return id
    },
    clearInterval(id) {
      timers.delete(id)
    },
    advance(ms) {
      const end = current + ms
      for (;;) {
        let next = null
        for (const [id, t] of timers) {
          if (t.at <= end && (next === null || t.at < next.t.at)) next = { id, t }
        }
        if (next === null) break
        current = next.t.at
        if (next.t.interval !== null) {
          next.t.at += next.t.interval
        } else {
          timers.delete(next.id)
        }
        next.t.fn()
      }
      current = end
    },
    pending: () => timers.size,
  }
}

// 偽の pipe。destroy() の呼出しを記録する
function createFakePipe() {
  const pipe = new EventEmitter()
  pipe.destroyed = false
  pipe.destroy = () => {
    pipe.destroyed = true
  }
  return pipe
}

// 偽の子プロセス。kill() の呼出しを記録する
function createFakeChild() {
  const child = new EventEmitter()
  child.stdout = createFakePipe()
  child.stderr = createFakePipe()
  child.kills = []
  child.kill = (sig) => {
    child.kills.push(sig)
    return true
  }
  return child
}

function startFake(extra = {}) {
  const clock = createFakeClock()
  const child = createFakeChild()
  const writes = []
  const spawnCalls = []
  const promise = runNpm(['install'], {
    label: 'npm install',
    timeoutMs: 60000,
    write: (stream, text) => writes.push([stream, text]),
    spawn: (cmd, args, options) => {
      spawnCalls.push({ cmd, args, options })
      return child
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    ...extra,
  })
  return { clock, child, writes, spawnCalls, promise }
}

// Promise の後続処理(then)を1回まわして、結果が確定しているかを見る
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('正常終了(code 0)で ok=true になり、stderr の末尾が保持される', async () => {
  const { child, spawnCalls, promise } = startFake()
  child.stdout.emit('data', 'added 3 packages\n')
  child.stderr.emit('data', 'npm warn deprecated\n')
  child.emit('close', 0, null)
  const r = await promise

  assert.equal(r.ok, true)
  assert.equal(r.code, 0)
  assert.equal(r.signal, null)
  assert.equal(r.timedOut, false)
  assert.equal(r.stderrTail, 'npm warn deprecated\n')
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0].cmd, 'npm')
  assert.deepEqual(spawnCalls[0].args, ['install'])
  assert.equal(spawnCalls[0].options.shell, false)
  assert.deepEqual(spawnCalls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
})

test('非 0 終了で ok=false になり、code が入る', async () => {
  const { child, promise } = startFake()
  child.stderr.emit('data', 'npm ERR! code E404\n')
  child.emit('close', 1, null)
  const r = await promise

  assert.equal(r.ok, false)
  assert.equal(r.code, 1)
  assert.equal(r.signal, null)
  assert.equal(r.stderrTail, 'npm ERR! code E404\n')
})

test('forward=true では stdout/stderr が write に転送され、forward=false では転送されない', async () => {
  const forwarded = startFake({ forward: true })
  forwarded.child.stdout.emit('data', 'out-line\n')
  forwarded.child.stderr.emit('data', 'err-line\n')
  forwarded.child.emit('close', 0, null)
  await forwarded.promise
  assert.deepEqual(forwarded.writes, [
    ['stdout', 'out-line\n'],
    ['stderr', 'err-line\n'],
  ])

  const captured = startFake({ forward: false })
  captured.child.stdout.emit('data', 'out-line\n')
  captured.child.stderr.emit('data', 'err-line\n')
  captured.child.emit('close', 0, null)
  const r = await captured.promise
  assert.deepEqual(captured.writes, [])
  assert.equal(r.stderrTail, 'err-line\n')
})

test('heartbeat: 無出力が 5 秒続くと経過秒を表示し、以後も 5 秒ごとに繰り返す', async () => {
  const { clock, child, writes, promise } = startFake({ forward: false })
  clock.advance(2000)
  // 捕捉だけの出力は lastShown を更新しないので、heartbeat は 5 秒時点で出る
  child.stdout.emit('data', 'captured\n')
  clock.advance(3000)
  assert.deepEqual(writes, [['stderr', '  ...npm install (経過 5 秒)\n']])

  clock.advance(5000)
  assert.deepEqual(writes, [
    ['stderr', '  ...npm install (経過 5 秒)\n'],
    ['stderr', '  ...npm install (経過 10 秒)\n'],
  ])

  child.emit('close', 0, null)
  await promise
})

test('heartbeat: forward=true で 3 秒ごとに行を出していれば heartbeat は出ない', async () => {
  const { clock, child, writes, promise } = startFake({ forward: true })
  for (let i = 0; i < 4; i++) {
    clock.advance(3000)
    child.stdout.emit('data', 'progress\n')
  }
  child.emit('close', 0, null)
  await promise

  assert.equal(writes.length, 4)
  assert.ok(writes.every(([stream, text]) => stream === 'stdout' && text === 'progress\n'))
})

test('heartbeat: forward=true で開始 1 秒に 1 行出した後は、最後の表示から 5 秒後(開始 6 秒)に出て、以後 5 秒ごとに出る', async () => {
  const { clock, child, writes, promise } = startFake({ forward: true })
  clock.advance(1000)
  child.stdout.emit('data', 'first\n')
  clock.advance(4999)
  assert.deepEqual(writes, [['stdout', 'first\n']])

  clock.advance(1)
  assert.deepEqual(writes, [
    ['stdout', 'first\n'],
    ['stderr', '  ...npm install (経過 6 秒)\n'],
  ])

  clock.advance(4000)
  assert.equal(writes.length, 2)

  clock.advance(1000)
  assert.deepEqual(writes[2], ['stderr', '  ...npm install (経過 11 秒)\n'])

  clock.advance(5000)
  assert.deepEqual(writes[3], ['stderr', '  ...npm install (経過 16 秒)\n'])
  assert.equal(writes.length, 4)

  child.emit('close', 0, null)
  await promise
})

test('heartbeat: tickMs を明示したときは、その刻みで判定される', async () => {
  const { clock, child, writes, promise } = startFake({ forward: true, tickMs: 500 })
  clock.advance(1200)
  child.stdout.emit('data', 'line\n')

  clock.advance(4800)
  assert.deepEqual(writes, [['stdout', 'line\n']])

  clock.advance(500)
  assert.deepEqual(writes, [
    ['stdout', 'line\n'],
    ['stderr', '  ...npm install (経過 6 秒)\n'],
  ])

  child.emit('close', 0, null)
  await promise
})

test('timeout: SIGTERM のあと termGraceMs で SIGKILL を送り、close が来れば ok=false', async () => {
  const { clock, child, promise } = startFake()
  clock.advance(60000)
  assert.deepEqual(child.kills, ['SIGTERM'])

  clock.advance(2999)
  assert.deepEqual(child.kills, ['SIGTERM'])

  clock.advance(1)
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])

  child.emit('close', null, 'SIGKILL')
  const r = await promise
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.equal(r.signal, 'SIGKILL')
})

test('timeout: SIGTERM の後に close が来れば SIGKILL は送らない', async () => {
  const { clock, child, promise } = startFake()
  clock.advance(60000)
  child.emit('close', null, 'SIGTERM')
  const r = await promise
  clock.advance(10000)

  assert.deepEqual(child.kills, ['SIGTERM'])
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.equal(r.signal, 'SIGTERM')
})

test('close が来なくても、SIGKILL の killSettleMs 後に強制確定し、pipe が destroy される', async () => {
  const { clock, child, promise } = startFake({ termGraceMs: 3000, killSettleMs: 5000 })
  let settled = null
  promise.then((r) => {
    settled = r
  })

  clock.advance(60000 + 3000)
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])

  clock.advance(4999)
  await flush()
  assert.equal(settled, null)

  clock.advance(1)
  await flush()
  assert.deepEqual(settled, {
    ok: false,
    code: null,
    signal: 'SIGKILL',
    timedOut: true,
    stderrTail: '',
    stdout: '',
  })
  assert.equal(child.stdout.destroyed, true)
  assert.equal(child.stderr.destroyed, true)
})

test('error イベントで即確定し ok=false、error が入る。その後の close は無視される', async () => {
  const { child, promise } = startFake()
  const err = new Error('spawn npm ENOENT')
  child.emit('error', err)
  const r = await promise

  assert.equal(r.ok, false)
  assert.equal(r.code, null)
  assert.equal(r.signal, null)
  assert.equal(r.timedOut, false)
  assert.equal(r.error, err)
  assert.ok(r.stderrTail.endsWith('spawn npm ENOENT'))

  // 後から close が来ても結果は変わらない(二重確定しない)
  child.emit('close', 0, null)
  const again = await promise
  assert.equal(again, r)
  assert.equal(again.ok, false)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
})

test('確定後に、偽の時計の未発火タイマーが残らない(正常終了・timeout 経由の両方)', async () => {
  const normal = startFake({ forward: false })
  normal.clock.advance(1000)
  normal.child.emit('close', 0, null)
  await normal.promise
  assert.equal(normal.clock.pending(), 0)
  assert.equal(normal.child.stdout.listenerCount('data'), 0)
  assert.equal(normal.child.stderr.listenerCount('data'), 0)
  assert.equal(normal.child.stdout.destroyed, true)
  assert.equal(normal.child.stderr.destroyed, true)

  const timedOut = startFake({ forward: false })
  timedOut.clock.advance(60000)
  timedOut.child.emit('close', null, 'SIGKILL')
  await timedOut.promise
  assert.equal(timedOut.clock.pending(), 0)

  const errored = startFake()
  errored.child.emit('error', new Error('boom'))
  await errored.promise
  assert.equal(errored.clock.pending(), 0)
})

test('既定の spawn で実プロセス(node 自身)を実行し、stdout を write で受け取れる', async () => {
  const writes = []
  const r = await runNpm(['-e', 'console.log("ok")'], {
    command: process.execPath,
    timeoutMs: 30000,
    forward: true,
    write: (stream, text) => writes.push([stream, text]),
  })

  assert.equal(r.ok, true)
  assert.equal(r.code, 0)
  const stdout = writes.filter(([stream]) => stream === 'stdout').map(([, text]) => text).join('')
  assert.equal(stdout, 'ok\n')
})

test('stdout: forward=false でも結果の stdout に捕捉され、write には転送されない', async () => {
  const { child, writes, promise } = startFake({ forward: false })
  child.stdout.emit('data', 'line-1\n')
  child.stdout.emit('data', 'line-2\n')
  child.emit('close', 0, null)
  const r = await promise

  assert.equal(r.stdout, 'line-1\nline-2\n')
  assert.deepEqual(writes, [])
})

test('stdout: forward=true でも結果の stdout に捕捉され、write にも転送される', async () => {
  const { child, writes, promise } = startFake({ forward: true })
  child.stdout.emit('data', 'added 3 packages\n')
  child.emit('close', 0, null)
  const r = await promise

  assert.equal(r.stdout, 'added 3 packages\n')
  assert.deepEqual(writes, [['stdout', 'added 3 packages\n']])
})

test('stdout: 8000 文字を超えた分は先頭から捨て、末尾 8000 文字を保持する', async () => {
  const { child, promise } = startFake({ forward: false })
  child.stdout.emit('data', 'x'.repeat(7000))
  child.stdout.emit('data', 'y'.repeat(3000))
  child.emit('close', 0, null)
  const r = await promise

  assert.equal(r.stdout.length, 8000)
  assert.equal(r.stdout, 'x'.repeat(5000) + 'y'.repeat(3000))
})

test('stdout: stderr の出力は stdout に混ざらない', async () => {
  const { child, promise } = startFake({ forward: false })
  child.stdout.emit('data', 'out\n')
  child.stderr.emit('data', 'err\n')
  child.emit('close', 0, null)
  const r = await promise

  assert.equal(r.stdout, 'out\n')
  assert.equal(r.stderrTail, 'err\n')
})

test('stdout: error イベントの結果にも、それまでに捕捉した stdout が入る', async () => {
  const { child, promise } = startFake({ forward: false })
  child.stdout.emit('data', 'partial\n')
  child.emit('error', new Error('spawn npm ENOENT'))
  const r = await promise

  assert.equal(r.ok, false)
  assert.equal(r.stdout, 'partial\n')
})

test('stdout: 強制 SIGKILL 確定の結果にも、それまでに捕捉した stdout が入る', async () => {
  const { clock, child, promise } = startFake({ forward: false, termGraceMs: 3000, killSettleMs: 5000 })
  child.stdout.emit('data', 'before-timeout\n')
  clock.advance(60000 + 3000 + 5000)
  const r = await promise

  assert.equal(r.signal, 'SIGKILL')
  assert.equal(r.timedOut, true)
  assert.equal(r.stdout, 'before-timeout\n')
})

test('stdout: spawn 自体が例外を投げた場合は stdout が空文字で返る', async () => {
  const r = await runNpm(['install'], {
    timeoutMs: 1000,
    spawn: () => {
      throw new Error('spawn failed')
    },
  })

  assert.equal(r.ok, false)
  assert.equal(r.stdout, '')
  assert.equal(r.error.message, 'spawn failed')
})
