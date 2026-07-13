#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { normalizeVersion, getTokyoDate } = require('./lib/version-utils');

const CANDIDATE_CONFIG_PATH = './config/agy-candidate-version.json';
const VERIFIED_CONFIG_PATH = './config/agy-verified-versions.json';

function main() {
  const rawVersion = process.argv[2];
  const confirmFlag = process.argv[3];

  if (!rawVersion) {
    console.error('Usage: prepare-local-test-build.js <version> --confirm-local-test-only');
    process.exit(1);
  }
  if (confirmFlag !== '--confirm-local-test-only') {
    console.error('Error: --confirm-local-test-only flag is required');
    process.exit(1);
  }
  // CI変数は 'true' 以外の表記(1, True等)でも真値なら拒否する
  if (process.env.CI) {
    console.error('Error: this script must not run in CI (local device testing only)');
    process.exit(1);
  }
  // 実行場所ガード(コードレベル): 実クローンは.gitを持つが、既存運用の「スクラッチにコピー」は
  // プレーンファイルコピーで.gitを含まないため、.gitの有無でこの2つを確実に区別できる。
  // さらに専用env varによる明示的opt-inも必須にする(二重ガード)。
  if (fs.existsSync('.git')) {
    console.error('Error: refusing to run inside a git working tree (this looks like the real clone, not a scratch copy)');
    console.error('Copy the repo to a scratch directory (without .git) first, then run this script there.');
    process.exit(1);
  }
  if (process.env.AGY_TERMUX_ALLOW_LOCAL_TEST_WRITE !== '1') {
    console.error('Error: AGY_TERMUX_ALLOW_LOCAL_TEST_WRITE=1 must be set to run this script');
    process.exit(1);
  }

  const version = normalizeVersion(rawVersion);
  const candidateMeta = JSON.parse(fs.readFileSync(CANDIDATE_CONFIG_PATH, 'utf8'));

  if (candidateMeta.tag_name !== version) {
    console.error(`Error: Version mismatch. Candidate is ${candidateMeta.tag_name}, but ${version} requested`);
    process.exit(1);
  }

  const verifiedMeta = {
    tag_name: candidateMeta.tag_name,
    download_url: candidateMeta.download_url,
    sha256_tar: candidateMeta.sha256_tar,
    sha256_binary: candidateMeta.sha256_binary,
    va39_patch_counts: candidateMeta.va39_patch_counts,
    release_id: candidateMeta.release_id,
    asset_id: candidateMeta.asset_id,
    asset_updated_at: candidateMeta.asset_updated_at,
    source_repo: candidateMeta.source_repo,
    verified_date: getTokyoDate(),
    release_state: 'local_test',
    notes: `Local test build prepared via prepare-local-test-build.js on ${getTokyoDate()}. NOT published to npm. Device-local TUI/smoke verification only.`,
  };

  fs.writeFileSync(VERIFIED_CONFIG_PATH, JSON.stringify(verifiedMeta, null, 2) + '\n');

  // package.json の version も candidate と同じ値に同時更新する(local-testビルドでも
  // package.json.version と config.tag_name の一致を保証するため)
  const PACKAGE_JSON_PATH = './package.json';
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  packageJson.version = version;
  fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(packageJson, null, 2) + '\n');

  // read-back検証: 書き込んだ内容を再読込し、一致を確認する
  const verifyPkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const verifyConfig = JSON.parse(fs.readFileSync(VERIFIED_CONFIG_PATH, 'utf8'));
  if (verifyPkg.version !== verifyConfig.tag_name) {
    console.error(`Error: post-write verification failed. package.json.version(${verifyPkg.version}) !== config.tag_name(${verifyConfig.tag_name})`);
    process.exit(1);
  }

  console.log(`✓ Wrote local_test verified config for ${version}`);
  console.log(`✓ Updated package.json version to ${version}`);
  console.log('✓ Read-back verification passed');
  console.log('⚠️  This config must NEVER be committed or published. Use only on a scratch copy for npm pack.');
}

main();
