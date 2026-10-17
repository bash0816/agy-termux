'use strict'

// ensureBinary に渡す実依存を組み立てる。プロセス情報・kill・sleep は実装を注入できるようにしてある。
const fs = require('fs')
const crypto = require('crypto')
const cacheLock = require('./cache-lock')

// /proc/<pid>/stat から starttime(全体の 22 番目の欄)を取り出す。読めない・形式不正は null
function readProcStart(pid, readFileSync = fs.readFileSync) {
  let text
  try {
    text = String(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
  // comm 欄は括弧で囲まれ、空白や括弧を含みうるので最後の ')' より後ろを解析する
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const tokens = text.slice(close + 1).trim().split(/\s+/)
  // ')' の後ろの先頭が 3 番目の欄(state)なので、全体の 22 番目は index 19
  const starttime = tokens[19]
  if (starttime === undefined || !/^\d+$/.test(starttime)) return null
  return starttime
}

// プロセスの生死を kill(pid, 0) で判定する
function killPid(pid, kill = process.kill) {
  try {
    kill(pid, 0)
    return 'alive'
  } catch (e) {
    if (e && e.code === 'ESRCH') return 'esrch'
    if (e && e.code === 'EPERM') return 'eperm'
    return 'unknown'
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ensureBinary の deps を組み立てる。opts.sleep は試験用の差し替え口で、未指定なら本物の sleep を使う
function makeEnsureDeps(opts) {
  const {
    download,
    patch,
    onPhase,
    progress,
    stallMs,
    npmVersion,
    pid = process.pid,
    now = Date.now,
    randomHex = () => crypto.randomBytes(4).toString('hex'),
    hooks,
  } = opts
  const sleepFn = opts.sleep || sleep

  return {
    fs: opts.fs,
    download,
    patch,
    pid,
    now,
    randomHex,
    onPhase,
    progress,
    stallMs,
    npmVersion,
    hooks,
    // cache-lock の acquireLock への薄い橋渡し。sha256・patcherRev は渡さず ensureBinary の既定を使う
    acquireLock(lockPath, { checkDone, onWait }) {
      return cacheLock.acquireLock(
        { fs: opts.fs, pid, now, randomHex, readProcStart, killPid, sleep: sleepFn },
        { lockPath, npmVersion, checkDone, onWait }
      )
    },
  }
}

module.exports = { readProcStart, killPid, sleep, makeEnsureDeps }
