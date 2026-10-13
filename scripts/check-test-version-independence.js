#!/usr/bin/env node
'use strict';

// テスト実行の版独立性を確かめる入口（検証専用。配布物(bin/ lib/ config/)には含めない）
// 使い方: node scripts/check-test-version-independence.js [--timeout-ms <N>]
// 終了コード: 0 = 成功 / 1 = 検証失敗または予期しない例外 / 2 = 引数の誤り

const path = require('node:path');

const { verifyVersionIndependence } = require('./lib/test-run-verify');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const USAGE = '使い方: node scripts/check-test-version-independence.js [--timeout-ms <N>]';

// 引数を解釈する。誤りがあれば Error を投げる（メッセージは利用者向けの日本語）
// 受け付けるのは `--timeout-ms <N>` だけ。N は 1 以上の整数（10進の数字だけ）
function parseArgs(argv) {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== '--timeout-ms') {
      throw new Error(`不明な引数: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || !/^\d+$/.test(value) || Number(value) <= 0) {
      throw new Error('--timeout-ms には 1 以上の整数（ミリ秒）を指定してください');
    }
    timeoutMs = Number(value);
    i += 1;
  }
  return { timeoutMs };
}

async function main(argv) {
  let timeoutMs;
  try {
    ({ timeoutMs } = parseArgs(argv));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 2;
  }

  const repoRoot = path.resolve(__dirname, '..');
  try {
    const result = await verifyVersionIndependence({
      repoRoot,
      timeoutMs,
      log: (line) => console.log(line),
    });
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    // process.exit は使わない（パイプへの出力が途中で切れるのを防ぐ）
    process.exitCode = code;
  });
}
