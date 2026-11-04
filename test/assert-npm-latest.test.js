'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { assertLatest, fetchLatest, DIST_TAGS_URL } = require('../scripts/assert-npm-latest')

const REPO = path.join(__dirname, '..')
const SCRIPT = path.join(REPO, 'scripts', 'assert-npm-latest.js')

// 応答計画に従って get を差し替える(ネットワークなし)。
// plan(i) は i 回目の要求への応答: { status, body } / { error } / { silent: true }
function fakeGet(plan) {
  const calls = []
  const get = (url, options, cb) => {
    const req = new EventEmitter()
    req.destroyed = false
    req.destroy = () => {
      req.destroyed = true
    }
    calls.push({ url, options, req })
    const step = plan(calls.length - 1)
    setImmediate(() => {
      if (step.error) {
        req.emit('error', step.error)
        return
      }
      if (step.silent) return
      const res = new EventEmitter()
      res.statusCode = step.status ?? 200
      res.resumed = false
      res.setEncoding = () => {}
      res.resume = () => {
        res.resumed = true
      }
      cb(res)
      if (step.body !== undefined) res.emit('data', step.body)
      res.emit('end')
    })
    return req
  }
  return { get, calls }
}

// 偽のタイマー。登録されたコールバックは、テストが fn() を呼ぶまで発火しない(実時間に依存しない)。
function fakeTimers() {
  const set = []
  const cleared = []
  const setTimer = (fn, ms) => {
    const t = { fn, ms }
    set.push(t)
    return t
  }
  const clearTimer = (t) => {
    cleared.push(t)
  }
  return { setTimer, clearTimer, set, cleared }
}

// 指定のステータスの応答を cb に渡し、その後 steps(res) を実行する get を返す。
function getWithRes(statusCode, steps) {
  return (url, options, cb) => {
    const req = new EventEmitter()
    req.destroy = () => {}
    setImmediate(() => {
      const res = new EventEmitter()
      res.statusCode = statusCode
      res.setEncoding = () => {}
      res.resume = () => {}
      cb(res)
      steps(res)
    })
    return req
  }
}

// 与えた値を順に返す fetchLatest 代わり。尽きたら最後の値を返し続ける。
function seqFetch(values) {
  let i = 0
  const fl = async () => {
    const v = values[Math.min(i, values.length - 1)]
    i++
    return v
  }
  return { fl, count: () => i }
}

// sleep の呼び出し引数を記録する(実際には待たない)。
function recorder() {
  const sleeps = []
  const sleep = async (ms) => {
    sleeps.push(ms)
  }
  return { sleeps, sleep }
}

test('1: 1 回目で一致すれば待機せず ok を返す', async () => {
  const { fl, count } = seqFetch(['1.4.10'])
  const { sleeps, sleep } = recorder()
  const r = await assertLatest({ version: '1.4.10', fetchLatest: fl, retries: 10, intervalMs: 30000, sleep })
  assert.deepEqual(r, { ok: true, latest: '1.4.10', attempts: 1 })
  assert.equal(count(), 1)
  assert.deepEqual(sleeps, [])
})

test('2: 2 回目で一致すれば待機は 1 回。ログに実際の値と期待値が出る', async () => {
  const { fl, count } = seqFetch(['1.4.9', '1.4.10'])
  const { sleeps, sleep } = recorder()
  const logs = []
  const r = await assertLatest({
    version: '1.4.10',
    fetchLatest: fl,
    retries: 10,
    intervalMs: 30000,
    sleep,
    log: (m) => logs.push(m),
  })
  assert.deepEqual(r, { ok: true, latest: '1.4.10', attempts: 2 })
  assert.equal(count(), 2)
  assert.deepEqual(sleeps, [30000])
  assert.match(logs[0], /latest='1\.4\.9' != 1\.4\.10/)
  assert.match(logs[1], /latest='1\.4\.10' == 1\.4\.10/)
})

test('3: 10 回とも不一致なら ok=false、待機は 9 回、メッセージに実値が出る', async () => {
  const { fl, count } = seqFetch(['1.4.10'])
  const { sleeps, sleep } = recorder()
  const logs = []
  const r = await assertLatest({
    version: '1.4.12',
    fetchLatest: fl,
    retries: 10,
    intervalMs: 30000,
    sleep,
    log: (m) => logs.push(m),
  })
  assert.deepEqual(r, { ok: false, latest: '1.4.10', attempts: 10 })
  assert.equal(count(), 10)
  assert.equal(sleeps.length, 9)
  assert.ok(sleeps.every((ms) => ms === 30000))
  assert.match(logs[logs.length - 1], /latest='1\.4\.10' != 1\.4\.12.*giving up/)
})

test('4: 取得失敗・JSON 不正・latest 欠落(fetchLatest が null)は不一致扱い', async () => {
  const { sleeps, sleep } = recorder()
  const logs = []
  const r = await assertLatest({
    version: '1.4.10',
    fetchLatest: async () => null,
    retries: 2,
    intervalMs: 5,
    sleep,
    log: (m) => logs.push(m),
  })
  assert.deepEqual(r, { ok: false, latest: null, attempts: 2 })
  assert.deepEqual(sleeps, [5])
  assert.match(logs[0], /latest='unknown' != 1\.4\.10/)
})

test('5: --once は待機せず 1 回だけ取得する', async () => {
  const { fl, count } = seqFetch(['1.4.9'])
  const { sleeps, sleep } = recorder()
  const r = await assertLatest({
    version: '1.4.10',
    fetchLatest: fl,
    retries: 10,
    intervalMs: 30000,
    sleep,
    once: true,
  })
  assert.deepEqual(r, { ok: false, latest: '1.4.9', attempts: 1 })
  assert.equal(count(), 1)
  assert.deepEqual(sleeps, [])
})

test('6: 版の形式が X.Y.Z でなければ取得前に E_VERSION_FORMAT。CLI も exit 2', async () => {
  for (const bad of ['1.4', '1.4.10-beta', 'v1.4.10', '', undefined]) {
    const { fl, count } = seqFetch(['1.4.10'])
    await assert.rejects(assertLatest({ version: bad, fetchLatest: fl, sleep: async () => {} }), {
      code: 'E_VERSION_FORMAT',
    })
    assert.equal(count(), 0)
  }
  // CLI: 版の形式が不正なら取得前に終了する(ネットワークに触れない)
  const r = spawnSync(process.execPath, [SCRIPT, '1.4'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /X\.Y\.Z/)
})

test('7a: 待機間隔は intervalMs、待機回数は試行回数 − 1', async () => {
  const { fl } = seqFetch(['0.0.1'])
  const { sleeps, sleep } = recorder()
  await assertLatest({ version: '9.9.9', fetchLatest: fl, retries: 3, intervalMs: 1234, sleep })
  assert.deepEqual(sleeps, [1234, 1234])
})

test('7b: 要求はスコープ付き名をエンコードし、no-cache と Accept を送る', async () => {
  const { get, calls } = fakeGet(() => ({ body: JSON.stringify({ latest: '1.4.10' }) }))
  const v = await fetchLatest({ get })
  assert.equal(v, '1.4.10')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://registry.npmjs.org/-/package/@bash0816%2Fagy-termux/dist-tags')
  assert.equal(calls[0].url, DIST_TAGS_URL)
  assert.equal(calls[0].options.headers['Cache-Control'], 'no-cache')
  assert.equal(calls[0].options.headers.Accept, 'application/json')
})

test('7c: HTTP 200 以外は null(不一致扱い)', async () => {
  const { get } = fakeGet(() => ({ status: 503, body: JSON.stringify({ latest: '1.4.10' }) }))
  assert.equal(await fetchLatest({ get }), null)
})

test('7d: get が同期的に例外を投げたら null', async () => {
  const get = () => {
    throw new Error('boom')
  }
  assert.equal(await fetchLatest({ get }), null)
})

test('7e: 接続エラー(request の error)は null', async () => {
  const { get } = fakeGet(() => ({ error: new Error('ECONNRESET') }))
  assert.equal(await fetchLatest({ get }), null)
})

test('7f: JSON 不正・latest 欠落・latest が文字列でない場合は null', async () => {
  for (const body of ['not json', '{"other":1}', '{"latest":1}']) {
    const { get } = fakeGet(() => ({ body }))
    assert.equal(await fetchLatest({ get }), null, `body=${body}`)
  }
})

test('7g: 応答が止まったらタイマー発火で null になり、要求は destroy される(実時間に依存しない)', async () => {
  const { get, calls } = fakeGet(() => ({ silent: true }))
  const timers = fakeTimers()
  const p = fetchLatest({ get, timeoutMs: 20, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
  assert.equal(calls.length, 1)
  assert.equal(timers.set.length, 1)
  assert.equal(timers.set[0].ms, 20)
  timers.set[0].fn()
  assert.equal(await p, null)
  assert.equal(calls[0].req.destroyed, true)
})

test('7h: 応答が先に来たらタイマーは解除され、発火しない', async () => {
  const { get } = fakeGet(() => ({ body: JSON.stringify({ latest: '1.4.10' }) }))
  const timers = fakeTimers()
  const v = await fetchLatest({ get, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
  assert.equal(v, '1.4.10')
  assert.equal(timers.set.length, 1)
  assert.deepEqual(timers.cleared, [timers.set[0]])
})

test('8a: HTTP 404 の本文読み捨て中に res が error を出しても null で resolve し、未処理 error で落ちない', async () => {
  const get = getWithRes(404, (res) => res.emit('error', new Error('x')))
  const timers = fakeTimers()
  assert.equal(await fetchLatest({ get, setTimer: timers.setTimer, clearTimer: timers.clearTimer }), null)
})

test('8b: HTTP 200 の本文途中で res が error を出したら null', async () => {
  const get = getWithRes(200, (res) => {
    res.emit('data', '{"latest":"1.4')
    res.emit('error', new Error('x'))
  })
  const timers = fakeTimers()
  assert.equal(await fetchLatest({ get, setTimer: timers.setTimer, clearTimer: timers.clearTimer }), null)
})
