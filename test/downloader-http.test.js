'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const https = require('https')

const { httpsGet, fetchLatestMeta } = require('../lib/downloader')

const MB = 1024 * 1024
const RELEASES_API = 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest'

// 偽の https: get() の呼び出しを記録し、request は EventEmitter にする
function makeFakeHttps() {
  const calls = []
  return {
    calls,
    get(url, opts, cb) {
      const req = new EventEmitter()
      req.destroyCount = 0
      req.destroy = () => { req.destroyCount++ }
      calls.push({ url, opts, cb, req })
      return req
    },
  }
}

// 偽の response: statusCode / headers / complete / resume() を持つ EventEmitter
function fakeRes(statusCode, headers = {}) {
  const res = new EventEmitter()
  res.statusCode = statusCode
  res.headers = headers
  res.complete = true
  res.resumed = 0
  res.resume = () => { res.resumed++ }
  return res
}

// 手動時計: advance(ms) は 500ms 刻みで時刻を進め、登録済みの interval を発火させる
function makeClock() {
  let now = 0
  const timers = []
  return {
    timers,
    now: () => now,
    setInterval: (fn) => {
      const t = { fn, cleared: false }
      timers.push(t)
      return t
    },
    clearInterval: (t) => { t.cleared = true },
    advance(ms) {
      for (let i = 0; i < ms / 500; i++) {
        now += 500
        for (const t of timers) {
          if (!t.cleared) t.fn()
        }
      }
    },
  }
}

// 依存をまとめて用意する。標準エラーへの出力は err 配列に溜める
function setup(isTTY = false) {
  const fake = makeFakeHttps()
  const clock = makeClock()
  const err = []
  const deps = {
    https: fake,
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    err: (s) => err.push(s),
    isTTY,
  }
  return { fake, clock, err, deps }
}

test('(a) 正常応答: チャンクを連結して返し、User-Agent を付ける', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  const call = env.fake.calls[0]
  assert.equal(call.url, 'https://example.com/a')
  assert.equal(call.opts.headers['User-Agent'], 'agy-termux')

  const res = fakeRes(200)
  call.cb(res)
  res.emit('data', Buffer.from('ab'))
  res.emit('data', Buffer.from('cd'))
  res.emit('end')

  assert.equal((await p).toString(), 'abcd')
  assert.equal(call.req.destroyCount, 0)
  assert.equal(env.clock.timers[0].cleared, true)
  assert.deepEqual(env.err, [])
})

test('(a) Content-Length あり: 総量と割合を表示し、完了行を出す', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { progress: true, deps: env.deps })
  const res = fakeRes(200, { 'content-length': String(4 * MB) })
  env.fake.calls[0].cb(res)
  res.emit('data', Buffer.alloc(MB))
  env.clock.advance(2000)
  res.emit('data', Buffer.alloc(3 * MB))
  res.emit('end')

  assert.equal((await p).length, 4 * MB)
  assert.deepEqual(env.err, [
    '[agy] ダウンロード中... 1.0 / 4.0 MB (25%)\n',
    '[agy] ダウンロード完了\n',
  ])
})

test('(a) Content-Length なし: 総量を表示せず MB のみ出す', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { progress: true, deps: env.deps })
  const res = fakeRes(200)
  env.fake.calls[0].cb(res)
  res.emit('data', Buffer.alloc(MB))
  env.clock.advance(2000)
  res.emit('end')

  await p
  assert.deepEqual(env.err, [
    '[agy] ダウンロード中... 1.0 MB\n',
    '[agy] ダウンロード完了\n',
  ])
  assert.equal(env.err[0].includes('%'), false)
})

test('(b) ヘッダ待ち中も heartbeat を 5 秒ごとに出し、stallMs で E_STALL になる', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  env.clock.advance(10000)
  assert.deepEqual(env.err, [
    '  ...ダウンロード (経過 5 秒)\n',
    '  ...ダウンロード (経過 10 秒)\n',
  ])

  env.clock.advance(50000)
  await assert.rejects(p, { code: 'E_STALL', stage: 'download' })
  assert.equal(env.fake.calls[0].req.destroyCount, 1)
  assert.equal(env.clock.timers[0].cleared, true)
})

test('(b) 受信停止は最後にデータを受けた時点から stallMs で判定する', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  const call = env.fake.calls[0]
  const res = fakeRes(200)
  call.cb(res)

  env.clock.advance(30000)
  res.emit('data', Buffer.from('x'))
  env.clock.advance(59000)
  assert.equal(call.req.destroyCount, 0)
  env.clock.advance(1000)

  await assert.rejects(p, { code: 'E_STALL' })
  assert.equal(call.req.destroyCount, 1)
})

test('(b) 進捗表示なしでも受信中は heartbeat を 5 秒ごとに出す', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  const res = fakeRes(200)
  env.fake.calls[0].cb(res)

  for (let i = 0; i < 5; i++) {
    res.emit('data', Buffer.from('x'))
    env.clock.advance(1000)
  }
  assert.deepEqual(env.err, ['  ...ダウンロード (経過 5 秒)\n'])

  res.emit('end')
  assert.equal((await p).toString(), 'xxxxx')
})

test('(c) TTY では進捗を \\r で同じ行に書き直し、他の行の前で改行する', async () => {
  const env = setup(true)
  const p = httpsGet('https://example.com/a', { progress: true, deps: env.deps })
  const res = fakeRes(200)
  env.fake.calls[0].cb(res)

  res.emit('data', Buffer.alloc(MB))
  env.clock.advance(2000)
  res.emit('data', Buffer.alloc(MB))
  env.clock.advance(2000)
  res.emit('end')

  await p
  assert.deepEqual(env.err, [
    '\r[agy] ダウンロード中... 1.0 MB',
    '\r[agy] ダウンロード中... 2.0 MB',
    '\n',
    '[agy] ダウンロード完了\n',
  ])
})

test('(c) 非 TTY では進捗を 2 秒ごとに改行付きの行で出し、\\r は使わない', async () => {
  const env = setup(false)
  const p = httpsGet('https://example.com/a', { progress: true, deps: env.deps })
  const res = fakeRes(200, { 'content-length': String(4 * MB) })
  env.fake.calls[0].cb(res)

  res.emit('data', Buffer.alloc(MB))
  env.clock.advance(1000)
  assert.deepEqual(env.err, [])
  env.clock.advance(1000)
  assert.deepEqual(env.err, ['[agy] ダウンロード中... 1.0 / 4.0 MB (25%)\n'])

  res.emit('data', Buffer.alloc(MB))
  env.clock.advance(2000)
  res.emit('end')

  await p
  assert.deepEqual(env.err, [
    '[agy] ダウンロード中... 1.0 / 4.0 MB (25%)\n',
    '[agy] ダウンロード中... 2.0 / 4.0 MB (50%)\n',
    '[agy] ダウンロード完了\n',
  ])
  assert.equal(env.err.join('').includes('\r'), false)
})

test('(c) progress 未指定なら受信中でも進捗行は出さない', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  const res = fakeRes(200, { 'content-length': String(4 * MB) })
  env.fake.calls[0].cb(res)

  res.emit('data', Buffer.alloc(MB))
  env.clock.advance(4000)
  res.emit('end')

  await p
  assert.deepEqual(env.err, [])
})

test('(d) 301 の絶対 Location へ追従し、旧 request を破棄し旧 response を読み捨てる', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  const first = env.fake.calls[0]
  const redirect = fakeRes(301, { location: 'https://cdn.example.com/b' })
  first.cb(redirect)

  assert.equal(first.req.destroyCount, 1)
  assert.equal(redirect.resumed, 1)
  assert.equal(env.fake.calls.length, 2)
  const second = env.fake.calls[1]
  assert.equal(second.url, 'https://cdn.example.com/b')

  const res = fakeRes(200)
  second.cb(res)
  res.emit('data', Buffer.from('ok'))
  res.emit('end')

  assert.equal((await p).toString(), 'ok')
  assert.equal(second.req.destroyCount, 0)
})

test('(d) 302 の相対 Location を解決して追従し、旧本文が終わらなくても進む', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a/b', { deps: env.deps })
  const redirect = fakeRes(302, { location: '/dl/file.tar.gz' })
  env.fake.calls[0].cb(redirect)

  assert.equal(redirect.resumed, 1)
  assert.equal(env.fake.calls[1].url, 'https://example.com/dl/file.tar.gz')

  const res = fakeRes(200)
  env.fake.calls[1].cb(res)
  res.emit('data', Buffer.from('z'))
  res.emit('end')

  assert.equal((await p).toString(), 'z')
})

test('(d) リダイレクトは maxRedirects(既定 5) 回まで。6 回目は E_NET', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/0', { deps: env.deps })
  for (let i = 0; i < 6; i++) {
    env.fake.calls[i].cb(fakeRes(301, { location: `https://example.com/${i + 1}` }))
  }

  await assert.rejects(p, { code: 'E_NET', message: 'リダイレクトが多すぎます' })
  assert.equal(env.fake.calls.length, 6)
  assert.equal(env.fake.calls[5].req.destroyCount, 1)
})

test('(d) HTTPS 以外へのリダイレクトは E_NET で拒否する', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  env.fake.calls[0].cb(fakeRes(301, { location: 'http://example.com/x' }))

  await assert.rejects(p, { code: 'E_NET', message: 'HTTPS 以外へのリダイレクトは受け付けません' })
  assert.equal(env.fake.calls.length, 1)
  assert.equal(env.fake.calls[0].req.destroyCount, 1)
})

test('(d) リダイレクト後の request も同じタイマーで受信停止を判定する', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  env.clock.advance(30000)
  env.fake.calls[0].cb(fakeRes(302, { location: 'https://example.com/b' }))
  assert.equal(env.clock.timers.length, 1)

  env.clock.advance(59000)
  assert.equal(env.fake.calls[1].req.destroyCount, 0)
  env.clock.advance(1000)

  await assert.rejects(p, { code: 'E_STALL' })
  assert.equal(env.fake.calls[1].req.destroyCount, 1)
  assert.equal(env.clock.timers[0].cleared, true)
})

test('(e) 404/500 は本文を読まず E_HTTP で失敗する', async () => {
  for (const code of [404, 500]) {
    const env = setup()
    const p = httpsGet('https://example.com/a', { deps: env.deps })
    const res = fakeRes(code)
    env.fake.calls[0].cb(res)

    assert.equal(res.resumed, 1)
    assert.equal(res.listenerCount('data'), 0)
    await assert.rejects(p, { code: 'E_HTTP', httpStatus: code, stage: 'download' })
  }
})

const netCases = [
  ['end で res.complete が false なら E_NET', (res) => {
    res.complete = false
    res.emit('end')
  }],
  ['aborted で E_NET', (res) => res.emit('aborted')],
  ['end より前の close で E_NET', (res) => res.emit('close')],
  ['res の error で E_NET', (res) => res.emit('error', Object.assign(new Error('boom'), { code: 'ECONNRESET' }))],
]

for (const [name, act] of netCases) {
  test('(f) ' + name, async () => {
    const env = setup()
    const p = httpsGet('https://example.com/a', { deps: env.deps })
    const res = fakeRes(200)
    env.fake.calls[0].cb(res)
    act(res)

    await assert.rejects(p, { code: 'E_NET' })
  })
}

test('(f) request の error(ヘッダ前)は E_NET で errno を保持する', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  env.fake.calls[0].req.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))

  await assert.rejects(p, { code: 'E_NET', message: 'ECONNRESET socket hang up', errno: 'ECONNRESET' })
})

test('(g) 成功後の data/end/close と tick は無視する', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  const call = env.fake.calls[0]
  const res = fakeRes(200)
  call.cb(res)
  res.emit('data', Buffer.from('ok'))
  res.emit('end')

  assert.equal((await p).toString(), 'ok')
  res.emit('data', Buffer.from('late'))
  res.emit('end')
  res.emit('close')
  env.clock.timers[0].fn()

  assert.equal(call.req.destroyCount, 0)
  assert.deepEqual(env.err, [])
})

test('(g) 失敗後の data/end/error は無視し、tick は何もしない', async () => {
  const env = setup()
  const p = httpsGet('https://example.com/a', { deps: env.deps })
  const call = env.fake.calls[0]
  const res = fakeRes(200)
  call.cb(res)

  env.clock.advance(60000)
  await assert.rejects(p, { code: 'E_STALL' })
  res.emit('data', Buffer.from('late'))
  res.emit('end')
  call.req.emit('error', new Error('late'))
  env.clock.timers[0].fn()

  assert.equal(call.req.destroyCount, 1)
  assert.equal(env.err.some((s) => s.includes('完了')), false)
})

test('(h) fetchLatestMeta は opts なしの httpsGet 呼び出しで従来どおり動く', async () => {
  const body = JSON.stringify({
    tag_name: 'v9.9.9',
    assets: [{ name: 'agy_cli_linux_arm64.tar.gz', browser_download_url: 'https://example.com/agy.tar.gz' }],
  })
  const realGet = https.get
  const calls = []
  https.get = (url, opts, cb) => {
    calls.push({ url, opts })
    const req = new EventEmitter()
    req.destroy = () => {}
    setImmediate(() => {
      const res = fakeRes(200)
      cb(res)
      res.emit('data', Buffer.from(body))
      res.emit('end')
    })
    return req
  }

  let meta
  try {
    meta = await fetchLatestMeta()
  } finally {
    https.get = realGet
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, RELEASES_API)
  assert.equal(calls[0].opts.headers['User-Agent'], 'agy-termux')
  assert.equal(meta.tagName, 'v9.9.9')
  assert.equal(meta.downloadUrl, 'https://example.com/agy.tar.gz')
  assert.equal(meta.sha256Tar, null)
  assert.equal(meta.sha256Binary, null)
})
