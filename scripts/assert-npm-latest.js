#!/usr/bin/env node
'use strict';
// npm の dist-tags で latest が指定の版と一致するかを確認する guard。
// 一致しない場合は何も変更せず失敗する(finalize / Release 作成の前後で使う)。
const https = require('https');

// dist-tags 専用 API。スコープ付き名 @bash0816/agy-termux の '/' は %2F にエンコードする。
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@bash0816%2Fagy-termux/dist-tags';
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const DEFAULT_RETRIES = 10;
const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_TIMEOUT_MS = 10000;

const USAGE = [
  'Usage: node scripts/assert-npm-latest.js <version> [--once]',
  '  env: ASSERT_LATEST_RETRIES (1 以上の整数, 既定 10)',
  '       ASSERT_LATEST_INTERVAL_MS (1 以上の整数, 既定 30000)',
].join('\n');

// dist-tags の JSON 本文から latest を取り出す。不正なら null。
function parseLatest(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return null;
  }
  if (!data || typeof data.latest !== 'string') return null;
  return data.latest;
}

// 最新版を 1 回取得する。失敗(HTTP 200 以外、JSON 不正、接続エラー、タイムアウト)は
// 例外を投げず null を返す。呼び出し側は null を『不一致』として扱う。
function fetchLatest({ get = https.get, timeoutMs = DEFAULT_TIMEOUT_MS, url = DIST_TAGS_URL } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let req = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // タイマーを先に張る(get が同期的に失敗しても確実に解除されるように)。
    timer = setTimeout(() => {
      finish(null);
      if (req) req.destroy();
    }, timeoutMs);
    try {
      req = get(
        url,
        { headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' } },
        (res) => {
          // 200 以外は不一致扱い。本文は読み捨てて接続を解放する。
          if (res.statusCode !== 200) {
            res.resume();
            finish(null);
            return;
          }
          res.setEncoding('utf8');
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => finish(parseLatest(body)));
          res.on('error', () => finish(null));
        }
      );
    } catch (e) {
      finish(null);
      return;
    }
    req.on('error', () => finish(null));
  });
}

// 最大 retries 回(once なら 1 回)取得し、latest === version になるまで intervalMs 待つ。
// 待機は試行回数 − 1 回。一致した時点で即返す。
async function assertLatest({
  version,
  fetchLatest: fl = fetchLatest,
  retries = DEFAULT_RETRIES,
  intervalMs = DEFAULT_INTERVAL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  once = false,
  log = () => {},
} = {}) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    const err = new Error(`version は X.Y.Z 形式である必要があります: ${version}`);
    err.code = 'E_VERSION_FORMAT';
    throw err;
  }
  const max = once ? 1 : retries;
  let latest = null;
  for (let i = 1; i <= max; i++) {
    latest = await fl();
    const shown = latest ?? 'unknown';
    if (latest === version) {
      log(`latest='${shown}' == ${version} (try ${i}/${max})`);
      return { ok: true, latest, attempts: i };
    }
    if (i < max) {
      log(`latest='${shown}' != ${version} (try ${i}/${max}), waiting ${intervalMs / 1000}s`);
      await sleep(intervalMs);
    } else {
      log(`latest='${shown}' != ${version} (try ${i}/${max}), giving up`);
    }
  }
  return { ok: false, latest, attempts: max };
}

// 環境変数を 1 以上の整数として読む。未設定なら既定値、不正なら例外。
function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${name} は 1 以上の整数である必要があります: ${raw}`);
  }
  return Number(raw);
}

// CLI 本体。戻り値は終了コード(0 一致 / 1 不一致 / 2 引数・環境変数の誤り)。
async function main(argv) {
  const positional = [];
  let once = false;
  for (const a of argv) {
    if (a === '--once') {
      once = true;
    } else {
      positional.push(a);
    }
  }
  const unknown = positional.filter((a) => a.startsWith('-'));
  const version = positional.find((a) => !a.startsWith('-'));
  const extra = positional.filter((a) => a !== version);
  if (unknown.length > 0 || extra.length > 0 || version === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (!VERSION_RE.test(version)) {
    process.stderr.write(`版の形式が X.Y.Z ではありません: ${version}\n${USAGE}\n`);
    return 2;
  }

  let retries;
  let intervalMs;
  try {
    retries = readIntEnv('ASSERT_LATEST_RETRIES', DEFAULT_RETRIES);
    intervalMs = readIntEnv('ASSERT_LATEST_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    return 2;
  }

  const result = await assertLatest({
    version,
    retries,
    intervalMs,
    once,
    log: (m) => process.stderr.write(`${m}\n`),
  });
  if (result.ok) {
    process.stdout.write(`OK: latest=${version}\n`);
    return 0;
  }
  const shown = result.latest ?? 'unknown';
  process.stderr.write(
    `::error::npm latest (${shown}) != ${version} — no changes made (rollback or registry lag). Re-dispatch is safe once latest==${version}.\n`
  );
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    });
}

module.exports = { assertLatest, fetchLatest, DIST_TAGS_URL };
