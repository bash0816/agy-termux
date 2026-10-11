'use strict'

// npm を子プロセスとして実行する。例外は投げず、結果オブジェクトで成否を表す。
// 長時間の無出力に対しては heartbeat で経過時間を表示し、timeout 時は SIGTERM → SIGKILL の順に止める。

const { spawn: defaultSpawn } = require('node:child_process')

// 失敗時の表示用に残す stderr の末尾の長さ(文字数)
const STDERR_TAIL_MAX = 2000
// 結果の stdout として残す末尾の長さ(文字数)
const STDOUT_MAX = 8000

function runNpm(args, opts = {}) {
  const {
    label = '',
    timeoutMs,
    forward = false,
    write = () => {},
    heartbeatMs = 5000,
    termGraceMs = 3000,
    killSettleMs = 5000,
    spawn = defaultSpawn,
    now = Date.now,
    command = 'npm',
  } = opts

  // テストで偽の時計・タイマーを注入できるように、タイマー関数は opts から取る
  const timers = {
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout: opts.clearTimeout || clearTimeout,
  }

  return new Promise((resolve) => {
    const startedAt = now()
    // 利用者に最後に表示した時刻(転送した時刻、または heartbeat を出した時刻)
    let lastShown = startedAt
    let stderrTail = ''
    let stdout = ''
    let timedOut = false
    let settled = false

    let child
    try {
      child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, code: null, signal: null, timedOut: false, stderrTail: e.message, stdout: '', error: e })
      return
    }

    let timeoutTimer = null
    let graceTimer = null
    let settleTimer = null
    let heartbeatTimer = null

    const clearTimer = (t) => {
      if (t !== null) timers.clearTimeout(t)
    }

    // 確定処理。最初の1回だけ有効で、タイマー・listener を解放し、pipe を destroy する
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimer(timeoutTimer)
      clearTimer(graceTimer)
      clearTimer(settleTimer)
      clearTimer(heartbeatTimer)
      timeoutTimer = null
      graceTimer = null
      settleTimer = null
      heartbeatTimer = null

      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve(result)
    }

    const onChunk = (stream, chunk) => {
      const text = String(chunk)
      if (stream === 'stderr') {
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX)
      }
      if (stream === 'stdout') {
        stdout = (stdout + text).slice(-STDOUT_MAX)
      }
      if (forward) {
        write(stream, text)
        lastShown = now()
      }
    }
    const onStdout = (chunk) => onChunk('stdout', chunk)
    const onStderr = (chunk) => onChunk('stderr', chunk)

    // マルチバイト文字が chunk の境界で割れないよう、対応している pipe は文字列で受ける
    for (const pipe of [child.stdout, child.stderr]) {
      if (typeof pipe.setEncoding === 'function') pipe.setEncoding('utf8')
    }
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)

    child.on('close', (code, signal) => {
      finish({ ok: code === 0 && !signal && !timedOut, code, signal, timedOut, stderrTail, stdout })
    })

    child.on('error', (e) => {
      finish({
        ok: false,
        code: null,
        signal: null,
        timedOut,
        stderrTail: stderrTail + e.message,
        stdout,
        error: e,
      })
    })

    // heartbeat: 利用者に最後に表示した時刻から heartbeatMs 後に出す。
    // 期限ごとに setTimeout を張り直す(刻みで判定しないので、出力時刻が刻みに揃わなくても遅れない)
    const onHeartbeatDue = () => {
      heartbeatTimer = null
      if (settled) return
      const t = now()
      const remaining = heartbeatMs - (t - lastShown)
      if (remaining > 0) {
        // 出力があって lastShown が更新されていた場合は、新しい期限まで待ち直す
        heartbeatTimer = timers.setTimeout(onHeartbeatDue, remaining)
        return
      }
      const elapsedSec = Math.floor((t - startedAt) / 1000)
      write('stderr', '  ...' + label + ' (経過 ' + elapsedSec + ' 秒)\n')
      lastShown = t
      heartbeatTimer = timers.setTimeout(onHeartbeatDue, heartbeatMs)
    }
    heartbeatTimer = timers.setTimeout(onHeartbeatDue, heartbeatMs)

    timeoutTimer = timers.setTimeout(() => {
      timeoutTimer = null
      if (settled) return
      timedOut = true
      child.kill('SIGTERM')
      graceTimer = timers.setTimeout(() => {
        graceTimer = null
        if (settled) return
        child.kill('SIGKILL')
        settleTimer = timers.setTimeout(() => {
          settleTimer = null
          finish({ ok: false, code: null, signal: 'SIGKILL', timedOut: true, stderrTail, stdout })
        }, killSettleMs)
      }, termGraceMs)
    }, timeoutMs)
  })
}

module.exports = { runNpm }
