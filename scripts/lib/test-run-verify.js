'use strict';

// テスト実行の版独立性を確かめる小さなライブラリ
// 作業ツリーのテストを通常実行し、版番号だけ差し替えた複製でも同じ件数・全件成功になることを確かめる
// 検証専用。配布物(bin/ lib/ config/)には含めない
// require しても副作用(出力・プロセス起動・ファイル作成)は無い。関数を呼んだときだけ動く

const fs = require('node:fs');
const path = require('node:path');

const { evaluateRun, compareRuns } = require('./test-run-check');
const { runTestProcess } = require('./test-run-exec');
const { makeWorkCopy } = require('./test-run-copy');

const COPY_VERSION = '9.9.9';
const FAILURE_TAIL_LINES = 60;

// 通常ファイルかどうかを返す(存在しない・ディレクトリ・symlink は false)
function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// root/test 直下の *.test.js を 'test/x.test.js' 形式で列挙し、root/bin/agy.test.js があれば末尾に足す
// test ディレクトリが無ければ空として扱う。戻り値はソート済みの相対パス配列
function listTestFiles(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, 'test'), { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => `test/${entry.name}`)
    .sort();
  if (isRegularFile(path.join(root, 'bin', 'agy.test.js'))) files.push('bin/agy.test.js');
  return files;
}

// 文字列の末尾を行単位で切り出す
function tailLines(text, count) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-count);
}

// 1 回の実行結果を判定し、ログを出す
// 戻り値: 判定結果 + 生の終了情報。pipe の残留は failures に 'label:pipe_abandoned' として入れる
function judgeRun(label, raw, failures, log) {
  const result = evaluateRun(raw);
  const detail = {
    ...result,
    exitCode: raw.exitCode,
    signal: raw.signal,
    timedOut: raw.timedOut,
    pipeAbandoned: raw.pipeAbandoned,
  };

  log(`  exitCode=${raw.exitCode} signal=${raw.signal} timedOut=${raw.timedOut} pipeAbandoned=${raw.pipeAbandoned}`);
  const s = result.summary;
  if (s) {
    log(
      `  集計: tests=${s.tests} pass=${s.pass} fail=${s.fail} cancelled=${s.cancelled} skipped=${s.skipped} todo=${s.todo}`,
    );
  }

  if (raw.pipeAbandoned) failures.push(`${label}:pipe_abandoned`);
  if (!result.ok) failures.push(`${label}:${result.reason}`);

  if (!result.ok || raw.pipeAbandoned) {
    log(`  --- stdout 末尾 ${FAILURE_TAIL_LINES} 行 ---`);
    for (const line of tailLines(raw.stdout, FAILURE_TAIL_LINES)) log(line);
    log(`  --- stderr 末尾 ${FAILURE_TAIL_LINES} 行 ---`);
    for (const line of tailLines(raw.stderr, FAILURE_TAIL_LINES)) log(line);
  }
  return detail;
}

// 版独立性を確かめる
// 引数: { repoRoot, timeoutMs, version, log, run, copy }
//   run / copy は依存注入(既定は runTestProcess / makeWorkCopy)
// 戻り値: Promise<{ ok, failures, normal, copy }>。例外は投げず、失敗は failures に入れる
async function verifyVersionIndependence({
  repoRoot,
  timeoutMs,
  version = COPY_VERSION,
  log = () => {},
  run = runTestProcess,
  copy = makeWorkCopy,
} = {}) {
  const failures = [];
  let normal = null;
  let copyResult = null;

  const files = listTestFiles(repoRoot);
  log(`テストファイル: ${files.length} 件`);
  for (const file of files) log(`  ${file}`);
  if (files.length === 0) {
    failures.push('files:empty');
    log(`FAIL: ${failures.join(', ')}`);
    return { ok: false, failures, normal, copy: copyResult };
  }

  // 通常実行
  log('=== 通常実行 ===');
  let normalRaw = null;
  try {
    normalRaw = await run({ cwd: repoRoot, files, timeoutMs });
  } catch (err) {
    failures.push('normal:run_threw');
    log(`  実行中に例外: ${err && err.message ? err.message : String(err)}`);
  }
  if (normalRaw) normal = judgeRun('normal', normalRaw, failures, log);

  // 版独立実行(通常実行の結果に関係なく行う)
  log(`=== 版独立実行（version ${version}）===`);
  let copyObj = null;
  try {
    copyObj = await copy(repoRoot, { version });
  } catch (err) {
    failures.push('copy:setup_failed');
    log(`  複製の作成に失敗: ${err && err.message ? err.message : String(err)}`);
  }

  if (copyObj) {
    try {
      const copyFiles = listTestFiles(copyObj.dir);
      if (copyFiles.length !== files.length || copyFiles.some((file, i) => file !== files[i])) {
        failures.push('files:list_mismatch');
        log(`  複製側のテスト一覧が一致しません: ${copyFiles.join(', ')}`);
      } else {
        let copyRaw = null;
        try {
          copyRaw = await run({ cwd: copyObj.dir, files: copyFiles, timeoutMs });
        } catch (err) {
          failures.push('copy:run_threw');
          log(`  実行中に例外: ${err && err.message ? err.message : String(err)}`);
        }
        if (copyRaw) copyResult = judgeRun('copy', copyRaw, failures, log);
      }
    } finally {
      try {
        copyObj.cleanup();
      } catch (err) {
        log(`  複製の後始末に失敗（無視）: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  // 両方の実行が成功し、pipe の残留もない場合だけ件数を比べる
  const bothClean =
    normal && copyResult && normal.ok && copyResult.ok && !normal.pipeAbandoned && !copyResult.pipeAbandoned;
  if (bothClean) {
    const cmp = compareRuns(normal, copyResult);
    if (!cmp.ok) failures.push(`compare:${cmp.reason}`);
  }

  if (failures.length === 0) {
    log(`OK: 通常実行・版独立実行とも ${normal.summary.tests} 件すべて成功`);
    return { ok: true, failures, normal, copy: copyResult };
  }
  log(`FAIL: ${failures.join(', ')}`);
  return { ok: false, failures, normal, copy: copyResult };
}

module.exports = { listTestFiles, verifyVersionIndependence };
