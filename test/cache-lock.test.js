'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { acquireLock } = require('../lib/cache-lock')

// 偽 sleep の呼び出し上限。実装のバグで無限待機になってもテストが終わるようにする
const MAX_SLEEPS = 1000

// ロックの形式。link は symlink（リンク先に JSON）、file は通常ファイル
const KINDS = ['link', 'file']
const KIND_LABEL = { link: 'symlink', file: '通常ファイル' }

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-lock-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function realFs(overrides) {
  return Object.assign({
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    writeSync: fs.writeSync,
    symlinkSync: fs.symlinkSync,
    readlinkSync: fs.readlinkSync,
    readFileSync: fs.readFileSync,
    lstatSync: fs.lstatSync,
    unlinkSync: fs.unlinkSync,
  }, overrides || {})
}

function makeErr(code) {
  return Object.assign(new Error(code), { code })
}

// 偽の時計と sleep。sleep は時計を pollMs だけ進める。
function makeDeps(opts) {
  const o = opts || {}
  const clock = { t: o.start || 0 }
  const counts = { sleep: 0 }
  const deps = {
    fs: o.fs || realFs(),
    pid: o.pid || 1000,
    now: () => clock.t,
    randomHex: () => crypto.randomBytes(8).toString('hex'),
    readProcStart: o.readProcStart || (() => null),
    killPid: o.killPid || (() => 'alive'),
    sleep: async (ms) => {
      counts.sleep += 1
      if (counts.sleep > MAX_SLEEPS) throw new Error('sleep の呼び出し上限を超えました')
      clock.t += ms
    },
  }
  return { deps, clock, counts }
}

function removeQuietly(filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

// 所有者情報を書く。owner が文字列ならそのまま中身にする。
// 既存のロックは先に消す（writeFileSync は symlink を辿るため）。
function writeLock(lockPath, owner, kind) {
  removeQuietly(lockPath)
  const text = typeof owner === 'string' ? owner : JSON.stringify(owner)
  if (kind === 'link') {
    fs.symlinkSync(text, lockPath)
  } else {
    fs.writeFileSync(lockPath, text)
  }
}

// ロックの中身を読む（symlink はリンク先、通常ファイルは内容）
function readLockText(lockPath) {
  try {
    return fs.readlinkSync(lockPath)
  } catch (err) {
    if (err.code !== 'EINVAL') throw err
  }
  return fs.readFileSync(lockPath, 'utf8')
}

function readOwner(lockPath) {
  return JSON.parse(readLockText(lockPath))
}

// ロックのディレクトリエントリがあるか（symlink の dangling もあるので existsSync は使わない）
function lockExists(lockPath) {
  try {
    fs.lstatSync(lockPath)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

function isSymlinkLock(lockPath) {
  return fs.lstatSync(lockPath).isSymbolicLink()
}

function isFileLock(lockPath) {
  return fs.lstatSync(lockPath).isFile()
}

function leftoverTmp(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
}

// 形式ごとに同じテストを登録する
function eachKind(name, fn) {
  for (const kind of KINDS) {
    test(`${name} [${KIND_LABEL[kind]}]`, (t) => fn(t, kind))
  }
}

const LIVE_OWNER = { token: 'owner-token', pid: 4242, procStart: 'S1', npmVersion: '9.9.9', createdAt: 0 }

test('空の状態では symlink で取得でき、リンク先に完全な JSON が入り、tmp は残らない', async (t) => {
  const dir = makeDir(t)
  const lockPath = path.join(dir, 'cache.lock')
  const { deps, counts } = makeDeps({ pid: 4321 })

  const r = await acquireLock(deps, { lockPath, npmVersion: '10.0.0', checkDone: () => false, onWait: () => {} })

  assert.equal(r.acquired, true)
  assert.equal(typeof r.release, 'function')
  assert.equal(isSymlinkLock(lockPath), true)
  const owner = readOwner(lockPath)
  assert.equal(typeof owner.token, 'string')
  assert.ok(owner.token.length > 0)
  assert.equal(owner.pid, 4321)
  assert.equal(owner.npmVersion, '10.0.0')
  assert.equal(typeof owner.createdAt, 'number')
  assert.ok('procStart' in owner)
  assert.equal(counts.sleep, 0)
  assert.deepEqual(leftoverTmp(dir), [])

  r.release()
  assert.equal(lockExists(lockPath), false)
})

eachKind('生存者のロックがあれば checkDone が真になるまで待ち、取らずに完了を返す', async (t, kind) => {
  const dir = makeDir(t)
  const lockPath = path.join(dir, 'cache.lock')
  writeLock(lockPath, LIVE_OWNER, kind)
  const original = readLockText(lockPath)
  const { deps, counts } = makeDeps({
    readProcStart: () => 'S1',
    killPid: () => 'alive',
  })

  const r = await acquireLock(deps, {
    lockPath,
    npmVersion: '10.0.0',
    checkDone: () => counts.sleep >= 3,
    onWait: () => {},
  })

  assert.deepEqual(r, { acquired: false, done: true })
  assert.equal(counts.sleep, 3)
  assert.equal(readLockText(lockPath), original)
})

eachKind('生存者のロックは時間が経っても奪わない', async (t, kind) => {
  const dir = makeDir(t)
  const lockPath = path.join(dir, 'cache.lock')
  writeLock(lockPath, LIVE_OWNER, kind)
  const { deps, clock, counts } = makeDeps({
    readProcStart: () => 'S1',
    killPid: () => 'alive',
  })

  const r = await acquireLock(deps, {
    lockPath,
    npmVersion: '10.0.0',
    checkDone: () => counts.sleep >= 50,
    onWait: () => {},
    pollMs: 60000,
  })

  assert.deepEqual(r, { acquired: false, done: true })
  assert.ok(clock.t >= 50 * 60000)
  assert.equal(readOwner(lockPath).token, 'owner-token')
})

eachKind('所有者が死んでいる（esrch）なら奪って取得する', async (t, kind) => {
  const dir = makeDir(t)
  const lockPath = path.join(dir, 'cache.lock')
  writeLock(lockPath, LIVE_OWNER, kind)
  const { deps, counts } = makeDeps({
    killPid: (pid) => (pid === 4242 ? 'esrch' : 'alive'),
  })

  const r = await acquireLock(deps, { lockPath, npmVersion: '10.0.0', checkDone: () => false, onWait: () => {} })

  assert.equal(r.acquired, true)
  assert.notEqual(readOwner(lockPath).token, 'owner-token')
  assert.equal(counts.sleep, 0)
  assert.deepEqual(leftoverTmp(dir), [])
})

eachKind('PID 再利用（開始時刻の不一致）なら奪って取得する', async (t, kind) => {
  const dir = makeDir(t)
  const lockPath = path.join(dir, 'cache.lock')
  writeLock(lockPath, LIVE_OWNER, kind)
  const { deps, counts } = makeDeps({
    readProcStart: () => 'S2',
    killPid: () => 'alive',
  })

  const r = await acquireLock(deps, { lockPath, npmVersion: '10.0.0', checkDone: () => false, onWait: () => {} })

  assert.equal(r.acquired, true)
  assert.equal(counts.sleep, 0)
})

eachKind('壊れた・空のロックは若いうちは待ち、staleUnknownMs を過ぎたら奪う', async (t, kind) => {
  // symlink のリンク先は空にできないので、空の内容は通常ファイルだけで試す
  const contents = ['not json', 'null', '[]', '{"pid":"x","token":""}']
  if (kind === 'file') contents.unshift('')
  for (const content of contents) {
    const dir = makeDir(t)
    const lockPath = path.join(dir, 'cache.lock')
    writeLock(lockPath, content, kind)
    const mtime = fs.lstatSync(lockPath).mtimeMs

    // 若いうちは待つ（取らない・消さない）
    const young = makeDeps({ start: mtime })
    const waited = await acquireLock(young.deps, {
      lockPath,
      npmVersion: '10.0.0',
      checkDone: () => young.counts.sleep >= 1,
      onWait: () => {},
      staleUnknownMs: 10000,
    })
    assert.deepEqual(waited, { acquired: false, done: true }, `内容 ${JSON.stringify(content)}`)
    assert.equal(readLockText(lockPath), content)

    // staleUnknownMs を過ぎたら奪う
    const old = makeDeps({ start: mtime + 10001 })
    const taken = await acquireLock(old.deps, {
      lockPath,
      npmVersion: '10.0.0',
      checkDone: () => false,
      onWait: () => {},
      staleUnknownMs: 10000,
    })
    assert.equal(taken.acquired, true, `内容 ${JSON.stringify(content)}`)
    assert.equal(old.counts.sleep, 0)
    assert.deepEqual(leftoverTmp(dir), [])
  }
})

test('symlinkSync が EPERM などで使えない環境では openSync("wx") にフォールバックして通常ファイルで取得する', async (t) => {
  for (const code of ['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'EACCES', 'EXDEV', 'EINVAL', 'ENAMETOOLONG']) {
    const dir = makeDir(t)
    const lockPath = path.join(dir, 'cache.lock')
    const { deps } = makeDeps({
      fs: realFs({ symlinkSync: () => { throw makeErr(code) } }),
      pid: 777,
    })

    const r = await acquireLock(deps, { lockPath, npmVersion: '10.0.0', checkDone: () => false, onWait: () => {} })

    assert.equal(r.acquired, true, code)
    assert.equal(isFileLock(lockPath), true, code)
    const owner = readOwner(lockPath)
    assert.equal(owner.pid, 777, code)
    assert.equal(owner.npmVersion, '10.0.0', code)
    assert.deepEqual(leftoverTmp(dir), [], code)

    r.release()
    assert.equal(lockExists(lockPath), false, code)
  }
})

test('symlinkSync が EEXIST を返し、フォールバックの openSync も EEXIST なら既存ロックの調査に回る', async (t) => {
  const dir = makeDir(t)
  const lockPath = path.join(dir, 'cache.lock')
  writeLock(lockPath, LIVE_OWNER, 'file')
  const original = readLockText(lockPath)
  const { deps, counts } = makeDeps({
    fs: realFs({ symlinkSync: () => { throw makeErr('EPERM') } }),
    readProcStart: () => 'S1',
    killPid: () => 'alive',
  })

  const r = await acquireLock(deps, {
    lockPath,
    npmVersion: '10.0.0',
    checkDone: () => counts.sleep >= 2,
    onWait: () => {},
  })

  assert.deepEqual(r, { acquired: false, done: true })
  assert.equal(readLockText(lockPath), original)
})

test('symlinkSync が ENOSPC / EDQUOT / EROFS なら待たずに throw し、ロックも tmp も残さない', async (t) => {
  for (const code of ['ENOSPC', 'EDQUOT', 'EROFS']) {
    const dir = makeDir(t)
    const lockPath = path.join(dir, 'cache.lock')
    let checkCalls = 0
    let waitCalls = 0
    const { deps, counts } = makeDeps({
      fs: realFs({ symlinkSync: () => { throw makeErr(code) } }),
    })

    await assert.rejects(
      acquireLock(deps, {
        lockPath,
        npmVersion: '10.0.0',
        checkDone: () => { checkCalls += 1; return false },
        onWait: () => { waitCalls += 1 },
      }),
      { code },
    )

    assert.equal(checkCalls, 0, code)
    assert.equal(waitCalls, 0, code)
    assert.equal(counts.sleep, 0, code)
    assert.equal(lockExists(lockPath), false, code)
    assert.deepEqual(leftoverTmp(dir), [], code)
  }
})

test('symlinkSync も openSync("wx") も EACCES なら待たずに throw する（本物の権限問題）', async (t) => {
  const dir = makeDir(t)
  const lockPath = path.join(dir, 'cache.lock')
  let checkCalls = 0
  let waitCalls = 0
  const { deps, counts } = makeDeps({
    fs: realFs({
      symlinkSync: () => { throw makeErr('EACCES') },
      openSync: () => { throw makeErr('EACCES') },
    }),
  })

  await assert.rejects(
    acquireLock(deps, {
      lockPath,
      npmVersion: '10.0.0',
      checkDone: () => { checkCalls += 1; return false },
      onWait: () => { waitCalls += 1 },
    }),
    { code: 'EACCES' },
  )

  assert.equal(checkCalls, 0)
  assert.equal(waitCalls, 0)
  assert.equal(counts.sleep, 0)
  assert.equal(lockExists(lockPath), false)
  assert.deepEqual(leftoverTmp(dir), [])
})

test('release は自分の token のロックだけを消す', async (t) => {
  for (const kind of KINDS) {
    const dir = makeDir(t)
    const lockPath = path.join(dir, 'cache.lock')
    const { deps } = makeDeps()
    const r = await acquireLock(deps, { lockPath, npmVersion: '10.0.0', checkDone: () => false, onWait: () => {} })

    writeLock(lockPath, { token: 'other-token', pid: 5555, procStart: null, npmVersion: '1', createdAt: 0 }, kind)
    r.release()

    assert.equal(readOwner(lockPath).token, 'other-token', KIND_LABEL[kind])
  }
})

test('release を 2 回呼んでも例外を出さない', async (t) => {
  const dir = makeDir(t)
  const lockPath = path.join(dir, 'cache.lock')
  const { deps } = makeDeps()
  const r = await acquireLock(deps, { lockPath, npmVersion: '10.0.0', checkDone: () => false, onWait: () => {} })

  r.release()
  assert.doesNotThrow(() => r.release())
  assert.equal(lockExists(lockPath), false)
})

eachKind('onWait は最初に即時に呼ばれ、以降は noticeMs ごとに呼ばれる', async (t, kind) => {
  const dir = makeDir(t)
  const lockPath = path.join(dir, 'cache.lock')
  writeLock(lockPath, LIVE_OWNER, kind)
  const { deps, counts } = makeDeps({
    readProcStart: () => 'S1',
    killPid: () => 'alive',
  })
  const notices = []

  const r = await acquireLock(deps, {
    lockPath,
    npmVersion: '10.0.0',
    checkDone: () => counts.sleep >= 25,
    onWait: (info) => notices.push({ ...info, sleepsSoFar: counts.sleep }),
    pollMs: 500,
    noticeMs: 5000,
  })

  assert.deepEqual(r, { acquired: false, done: true })
  assert.deepEqual(notices.map((n) => n.elapsedMs), [0, 5000, 10000])
  assert.equal(notices[0].sleepsSoFar, 0)
  assert.ok(notices.every((n) => n.ownerPid === 4242))
})

eachKind('除去直前に別 token に入れ替わっていたら除去せず待機に戻り、他者のロックを消さない', async (t, kind) => {
  const dir = makeDir(t)
  const lockPath = path.join(dir, 'cache.lock')
  writeLock(lockPath, LIVE_OWNER, kind)
  let firstKill = true
  const { deps, counts } = makeDeps({
    readProcStart: () => 'S1',
    killPid: () => {
      if (firstKill) {
        // 判定の直後に別の所有者が書き込んだ状況を再現する
        firstKill = false
        writeLock(lockPath, { token: 'other-token', pid: 4242, procStart: 'S1', npmVersion: '10.0.0', createdAt: 0 }, kind)
        return 'esrch'
      }
      return 'alive'
    },
  })

  const r = await acquireLock(deps, {
    lockPath,
    npmVersion: '10.0.0',
    checkDone: () => counts.sleep >= 2,
    onWait: () => {},
  })

  assert.deepEqual(r, { acquired: false, done: true })
  assert.equal(counts.sleep, 2)
  assert.equal(readOwner(lockPath).token, 'other-token')
})
