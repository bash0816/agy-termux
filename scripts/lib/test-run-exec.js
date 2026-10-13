'use strict';

// テストを子プロセス(node --test)として起動し、制限時間と pipe の残留を見て結果を返す小さなライブラリ
// 検証専用。配布物(bin/ lib/ config/)には含めない
// require しても副作用(出力・プロセス起動)は無い。関数を呼んだときだけ動く

const { spawn } = require('node:child_process');

// エラー内容を文字列にする
function errorText(err) {
  return err && err.message ? err.message : String(err);
}

// テストを子プロセスとして実行し、結果を一度だけ返す(reject はしない)
// 引数: { cwd, files, timeoutMs, pipeGraceMs, nodeBin, args }
//   args を指定したときは、その配列を nodeBin の引数にそのまま使い、files は無視する
//   省略時は node --test で files を実行する
// 戻り値: { exitCode, signal, timedOut, pipeAbandoned, stdout, stderr, pid }
function runTestProcess({
  cwd,
  files,
  timeoutMs = 15 * 60 * 1000,
  pipeGraceMs = 5000,
  nodeBin = process.execPath,
  args: explicitArgs,
} = {}) {
  return new Promise((resolve) => {
    // 親の test runner の文脈を子へ引き継がないよう、NODE_TEST_CONTEXT だけ取り除く
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const args = explicitArgs
      ? [...explicitArgs]
      : ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', ...files];

    let child;
    try {
      child = spawn(nodeBin, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (err) {
      // 同期的に spawn が失敗した場合も reject せず、エラー内容を stderr に入れて返す
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        pipeAbandoned: false,
        stdout: '',
        stderr: errorText(err),
        pid: null,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let signal = null;
    let timedOut = false;
    let settled = false;
    let timeoutTimer = null;
    let graceTimer = null;

    // 結果を一度だけ返す。タイマーを全て止め、pipe が残っていた場合は stdout / stderr を閉じる
    const settle = (pipeAbandoned) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      if (pipeAbandoned) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolve({ exitCode, signal, timedOut, pipeAbandoned, stdout, stderr, pid: child.pid ?? null });
    };

    // 子のプロセスグループ全体を SIGKILL する(既に終了していた場合の ESRCH などは無視する)
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // 無視する
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    // spawn の失敗(存在しない実行ファイルなど)。pid は無く、結果は exitCode null で返す
    child.on('error', (err) => {
      stderr += errorText(err);
      settle(false);
    });

    // 制限時間を過ぎたらプロセスグループごと止める
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.on('exit', (code, sig) => {
      exitCode = code;
      signal = sig;
      clearTimeout(timeoutTimer);
      // 終了後、pipe が閉じるのを最大 pipeGraceMs 待つ。閉じなければ pipe を残したまま返す
      graceTimer = setTimeout(() => settle(true), pipeGraceMs);
    });

    child.on('close', () => {
      settle(false);
    });
  });
}

module.exports = { runTestProcess };
