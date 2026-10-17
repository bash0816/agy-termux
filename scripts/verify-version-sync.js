#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { readPatcherRev, buildExpectation, isCompleteExpectation } = require('./lib/va39-baseline');

const PACKAGE_JSON_PATH = './package.json';
const VERIFIED_CONFIG_PATH = './config/agy-verified-versions.json';

const VA39_KEYS = [
  'va39_patcher_rev',
  'va39_patch_counts',
  'va39_patch_breakdown',
  'va39_patched_sha256',
  'va39_patched_size',
];

const USAGE = 'Usage: verify-version-sync.js [--require-current-rev]';

function parseArgs(argv) {
  const out = { requireCurrentRev: false, unknown: [] };
  for (const a of argv) {
    if (a === '--require-current-rev') {
      out.requireCurrentRev = true;
    } else {
      out.unknown.push(a);
    }
  }
  return out;
}

// 欄ごとの型不正を特定する。有効な雛形の各欄を1つずつ差し替えて
// isCompleteExpectation を呼び、通らない欄を不正とみなす。
function findInvalidVa39Fields(verified) {
  const template = buildExpectation({
    patchResult: { ubfx: 0, lsl: 0, mask: 0, mmap: 0, word: 0, containers: [] },
    patchedBuf: Buffer.alloc(1),
    rev: 1,
  });
  const bad = [];
  for (const k of VA39_KEYS) {
    const probe = Object.assign({}, template);
    probe[k] = verified[k];
    if (!isCompleteExpectation(probe)) bad.push(k);
  }
  return bad;
}

// 戻り値: null (問題なし) または日本語のエラーメッセージ配列
// 既定 (フラグ無し):
//   - va39_patcher_rev が無い: va39_patch_counts のみ (または無し) は旧記録として許容。
//     va39_patcher_rev 以外の新欄 (breakdown/sha/size) が有るのは不整合でエラー。
//   - va39_patcher_rev が有る: 5欄すべてが揃い、isCompleteExpectation で完全であること。
// --require-current-rev: 5欄完全 + rev 一致。旧記録はエラー。
function checkVa39(verified, requireCurrentRev) {
  const has = (k) => Object.prototype.hasOwnProperty.call(verified, k);
  const newKeys = VA39_KEYS.filter((k) => k !== 'va39_patch_counts');

  if (!requireCurrentRev && !has('va39_patcher_rev')) {
    const stray = newKeys.filter(has);
    if (stray.length === 0) return null; // 旧記録として許容
    return [`config/agy-verified-versions.json に va39_patcher_rev がないのに他の VA39 欄があります: ${stray.join(', ')}`];
  }

  const missing = VA39_KEYS.filter((k) => !has(k));
  if (missing.length === VA39_KEYS.length) {
    return [`config/agy-verified-versions.json に VA39 期待値5欄がありません (--require-current-rev 指定のため必須): ${VA39_KEYS.join(', ')}`];
  }
  if (missing.length > 0) {
    return [`config/agy-verified-versions.json の VA39 期待値5欄が揃っていません。欠落: ${missing.join(', ')}`];
  }

  if (!isCompleteExpectation(verified)) {
    const bad = findInvalidVa39Fields(verified);
    const list = bad.length > 0 ? bad.join(', ') : '(特定できず)';
    return [`config/agy-verified-versions.json の VA39 期待値の形式が不正です。不正な欄: ${list}`];
  }

  if (requireCurrentRev) {
    let rev;
    try {
      rev = readPatcherRev();
    } catch (e) {
      return [`patcher-rev.json を読めません: ${e.message}`];
    }
    if (verified.va39_patcher_rev !== rev) {
      return [`va39_patcher_rev が現在の patcher rev と一致しません (config: ${verified.va39_patcher_rev}, patcher-rev.json: ${rev})`];
    }
  }

  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0) {
    console.error(`Error: 未知の引数です: ${args.unknown.join(' ')}`);
    console.error(USAGE);
    process.exit(1);
  }

  let pkg, verified;
  try {
    pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  } catch (e) {
    console.error(`Error: failed to read/parse ${PACKAGE_JSON_PATH}: ${e.message}`);
    process.exit(1);
  }
  try {
    verified = JSON.parse(fs.readFileSync(VERIFIED_CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`Error: failed to read/parse ${VERIFIED_CONFIG_PATH}: ${e.message}`);
    process.exit(1);
  }

  const pkgVersion = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  const tagName = typeof verified.tag_name === 'string' ? verified.tag_name.trim() : '';

  if (!pkgVersion) {
    console.error(`Error: package.json version is empty or missing`);
    process.exit(1);
  }
  if (!tagName) {
    console.error(`Error: config/agy-verified-versions.json tag_name is empty or missing`);
    process.exit(1);
  }
  if (pkgVersion !== tagName) {
    console.error(`Error: version mismatch. package.json.version(${pkgVersion}) !== config.tag_name(${tagName})`);
    process.exit(1);
  }

  const va39Errors = checkVa39(verified, args.requireCurrentRev);
  if (va39Errors) {
    for (const m of va39Errors) console.error(`Error: ${m}`);
    process.exit(1);
  }

  console.error(`✓ version sync verified: ${pkgVersion}`);
  process.exit(0);
}

main();
