#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { getTokyoDate } = require('./lib/version-utils');

const REPO_ROOT = path.resolve(__dirname, '..');
const CANDIDATE_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'agy-candidate-version.json');
const VERIFIED_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'agy-verified-versions.json');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

function main() {
  let originalVerifiedConfig = null;
  let originalPackageJson = null;

  try {
    // 1. Load candidate config
    if (!fs.existsSync(CANDIDATE_CONFIG_PATH)) {
      console.error(`Error: Candidate config not found at ${CANDIDATE_CONFIG_PATH}`);
      console.error('Run scripts/prepare-agy-candidate.js first to create a candidate');
      process.exit(1);
    }

    const candidateMeta = JSON.parse(fs.readFileSync(CANDIDATE_CONFIG_PATH, 'utf8'));
    const candidateVersion = candidateMeta.tag_name;

    if (!candidateVersion) {
      console.error('Error: Candidate config missing tag_name');
      process.exit(1);
    }

    // 2. Load existing verified config and merge candidate fields
    originalVerifiedConfig = fs.readFileSync(VERIFIED_CONFIG_PATH, 'utf8');
    const verifiedMeta = JSON.parse(originalVerifiedConfig);

    // Merge candidate fields into verified config
    const stagedMeta = {
      verified_version: candidateMeta.tag_name,
      tag_name: candidateMeta.tag_name,
      download_url: candidateMeta.download_url,
      sha256_tar: candidateMeta.sha256_tar,
      sha256_binary: candidateMeta.sha256_binary,
      va39_patch_counts: candidateMeta.va39_patch_counts,
      va39_patch_regression: candidateMeta.va39_patch_regression,
      release_id: candidateMeta.release_id,
      asset_id: candidateMeta.asset_id,
      asset_updated_at: candidateMeta.asset_updated_at,
      source_repo: candidateMeta.source_repo,
      verified_date: getTokyoDate(),
      notes: `[CANDIDATE STAGING] ${candidateMeta.tag_name}`,
    };

    // 3. Temporarily write staged config
    fs.writeFileSync(
      VERIFIED_CONFIG_PATH,
      JSON.stringify(stagedMeta, null, 2) + '\n'
    );

    // 4. Temporarily update package.json version
    originalPackageJson = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
    const packageJson = JSON.parse(originalPackageJson);
    const originalVersion = packageJson.version;
    packageJson.version = candidateVersion;
    fs.writeFileSync(
      PACKAGE_JSON_PATH,
      JSON.stringify(packageJson, null, 2) + '\n'
    );

    // 5. Run npm pack and capture output
    let tgzFileName = null;
    try {
      const result = spawnSync('npm', ['pack'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (result.error) {
        throw new Error(`npm pack failed: ${result.error.message}`);
      }

      if (result.status !== 0) {
        throw new Error(`npm pack exited with status ${result.status}: ${result.stderr}`);
      }

      // npm pack outputs the tgz filename as the last line of stdout
      const lines = result.stdout.trim().split('\n');
      tgzFileName = lines[lines.length - 1];

      if (!tgzFileName || !tgzFileName.endsWith('.tgz')) {
        throw new Error(`Invalid npm pack output: ${result.stdout}`);
      }

      const tgzPath = path.join(REPO_ROOT, tgzFileName);
      if (!fs.existsSync(tgzPath)) {
        throw new Error(`Generated tgz file not found: ${tgzPath}`);
      }

      // 7. Success: output the tgz path
      console.log(tgzPath);
    } finally {
      // 6. Always restore original files
      fs.writeFileSync(VERIFIED_CONFIG_PATH, originalVerifiedConfig);
      fs.writeFileSync(PACKAGE_JSON_PATH, originalPackageJson);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    // Ensure cleanup on error
    if (originalVerifiedConfig !== null) {
      try {
        fs.writeFileSync(VERIFIED_CONFIG_PATH, originalVerifiedConfig);
      } catch (cleanupErr) {
        console.error(`Failed to restore verified config: ${cleanupErr.message}`);
      }
    }
    if (originalPackageJson !== null) {
      try {
        fs.writeFileSync(PACKAGE_JSON_PATH, originalPackageJson);
      } catch (cleanupErr) {
        console.error(`Failed to restore package.json: ${cleanupErr.message}`);
      }
    }
    process.exit(1);
  }
}

main();
