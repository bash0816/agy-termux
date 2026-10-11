'use strict'

// 更新後の新しいコードを子プロセス(`node <script> ...args`)として起動し、その結果を受け取る。
// 子は fd 3 のパイプに結果(JSON の行)を書く。子の stdout/stderr は親の端末にそのまま流す。
// 子の終了を待ちつつ fd 3 の内容を溜め、例外は投げず、結果オブジェクトで表す。
// text の検証・解釈は呼び出し側(lib/render-final.js の parseResult)が行う。

const { spawn: defaultSpawn } = require('node:child_process')

// 子が終了した後に fd 3 の EOF を待つ既定の最大時間(ミリ秒)
const DEFAULT_EOF_WAIT_MS = 2000
// 結果を受け取る fd 3 のパイプの番号
const RESULT_FD = 3

function runSyncChild(opts = {}) {
  const {
    spawn = defaultSpawn,
    execPath = process.execPath,
    script,
    args = [],
    env = process.env,
    eofWaitMs = DEFAULT_EOF_WAIT_MS,
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
  } = opts

  return new Promise((resolve) => {
    // fd 3 から受信した結果の本体
    let text = ''
    let settled = false
    // fd 3 の EOF を受け取ったか(パイプが無い場合は受け取った扱い)
    let eofSeen = false
    // 子の exit を受け取ったか
    let exited = false
    let exitCode = null
    let exitSignal = null
    // exit 後に fd 3 の EOF を待つタイマー
    let eofTimer = null
    // 結果を受け取っている fd 3 のストリーム(無ければ null)
    let resultStream = null

    // 確定処理。最初の1回だけ有効で、タイマーを解放し、fd 3 の listener を外して destroy する
    const finish = (result) => {
      if (settled) return
      settled = true
      if (eofTimer !== null) {
        clearTimer(eofTimer)
        eofTimer = null
      }
      if (resultStream !== null) {
        resultStream.removeAllListeners()
        resultStream.destroy()
      }
      resolve(result)
    }

    // 子が exit 済みかつ fd 3 の処理が終わった時点で、exit の結果で確定する
    const finishAfterExit = () => {
      finish({ text, code: exitCode, signal: exitSignal, error: null })
    }

    let child
    try {
      child = spawn(execPath, [script, ...args], {
        stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
        env,
      })
    } catch (e) {
      // spawn が同期的に例外を投げた場合も、例外は外へ出さず結果で表す
      finish({ text: '', code: null, signal: null, error: e })
      return
    }

    // spawn の直後から fd 3 を読み始める(パイプが無い場合は読むものが無い)
    const pipe = child.stdio && child.stdio[RESULT_FD]
    if (pipe) {
      resultStream = pipe
      pipe.setEncoding('utf8')
      pipe.on('data', (chunk) => {
        text += String(chunk)
      })
      // 読み取りエラーは、それ以上データが来ない場合として EOF と同じ扱いにする
      const onEof = () => {
        eofSeen = true
        if (exited) finishAfterExit()
      }
      pipe.on('end', onEof)
      pipe.on('close', onEof)
      pipe.on('error', onEof)
    } else {
      eofSeen = true
    }

    child.on('exit', (code, signal) => {
      if (settled) return
      exited = true
      exitCode = code
      exitSignal = signal
      if (eofSeen) {
        finishAfterExit()
        return
      }
      // fd 3 の EOF を最大 eofWaitMs 待つ。来なければ(孫プロセスが書込み側を保持している等)そこまでの分で確定する
      eofTimer = setTimer(() => {
        eofTimer = null
        finishAfterExit()
      }, eofWaitMs)
    })

    // spawn 失敗など。以降の exit / EOF は確定済みとして無視される
    child.on('error', (e) => {
      finish({ text, code: null, signal: null, error: e })
    })
  })
}

module.exports = { runSyncChild }
