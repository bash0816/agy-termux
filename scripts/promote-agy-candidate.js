#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeVersion, getTokyoDate } = require('./lib/version-utils');

const CANDIDATE_CONFIG_PATH = './config/agy-candidate-version.json';
const VERIFIED_CONFIG_PATH = './config/agy-verified-versions.json';
const PACKAGE_JSON_PATH = './package.json';

function main() {
  try {
    const rawVersion = process.argv[2];
    const confirmFlag = process.argv[3];

    // Validate arguments
    if (!rawVersion) {
      console.error('Usage: promote-agy-candidate.js <version> --confirm-device-verified');
      process.exit(1);
    }

    if (confirmFlag !== '--confirm-device-verified') {
      console.error('Error: --confirm-device-verified flag is required to prevent accidental promotion');
      console.error('Usage: promote-agy-candidate.js <version> --confirm-device-verified');
      process.exit(1);
    }

    // Check CI environment (reject promotion from CI unless explicitly allowed)
    if (process.env.CI === 'true' && process.env.AGY_PROMOTE_ALLOW_CI !== '1') {
      console.error('Error: Promotion from CI environment requires AGY_PROMOTE_ALLOW_CI=1 to prevent accidental automation');
      console.error('This script should be run manually after device verification');
      process.exit(1);
    }

    // Normalize version (strip 'v' prefix, same convention prepare-agy-candidate.js
    // uses when writing candidateMeta.tag_name) so `promote-agy-candidate.js v1.0.16`
    // and `promote-agy-candidate.js 1.0.16` both match a candidate tag_name of '1.0.16'.
    const version = normalizeVersion(rawVersion);

    // Load candidate config
    if (!fs.existsSync(CANDIDATE_CONFIG_PATH)) {
      console.error(`Error: Candidate config not found at ${CANDIDATE_CONFIG_PATH}`);
      console.error('Run scripts/prepare-agy-candidate.js first to create a candidate');
      process.exit(1);
    }

    const candidateMeta = JSON.parse(fs.readFileSync(CANDIDATE_CONFIG_PATH, 'utf8'));

    // Check for va39_patch_regression
    const _regressions = candidateMeta.va39_patch_regression;
    if (Array.isArray(_regressions) ? _regressions.length > 0 : Boolean(_regressions)) {
      console.error(`ERROR: va39_patch_regression is non-empty: ${JSON.stringify(_regressions)}`);
      console.error('Regression must be resolved before promoting.');
      process.exit(1);
    }

    // Validate candidate state
    if (!candidateMeta.tag_name) {
      console.error('Error: Candidate config missing tag_name');
      process.exit(1);
    }

    if (candidateMeta.tag_name !== version) {
      console.error(`Error: Version mismatch. Candidate is ${candidateMeta.tag_name}, but ${version} requested`);
      process.exit(1);
    }

    if (candidateMeta.status !== 'pending_device_verification') {
      console.error(`Error: Candidate status is '${candidateMeta.status}', expected 'pending_device_verification'`);
      process.exit(1);
    }

    // Prepare verified config
    const verifiedMeta = {
      verified_version: candidateMeta.tag_name,
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
      release_state: 'stable',
      notes: `Promoted via promote-agy-candidate.js --confirm-device-verified on ${getTokyoDate()}. VA39 patch-count static check passed with no regression from the prior verified version. Device/functional verification confirmed by the operator invoking this script with --confirm-device-verified.`,
    };

    // Write verified config
    fs.writeFileSync(
      VERIFIED_CONFIG_PATH,
      JSON.stringify(verifiedMeta, null, 2) + '\n'
    );

    // Update package.json version
    const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    packageJson.version = version;
    fs.writeFileSync(
      PACKAGE_JSON_PATH,
      JSON.stringify(packageJson, null, 2) + '\n'
    );

    console.log(`✓ Promoted ${version} from candidate to verified`);
    console.log(`✓ Updated ${VERIFIED_CONFIG_PATH}`);
    console.log(`✓ Updated ${PACKAGE_JSON_PATH} version to ${version}`);
    console.log('');
    console.log('⚠️  IMPORTANT: Before publishing:');
    console.log('   1. Review and manually update README.md Compatibility section if needed');
    console.log('   2. Commit these changes on a branch and open a PR to main (this repo merges via PR, not direct push)');
    console.log('   3. After the PR is merged, dispatch the "npm Publish" GitHub Actions workflow (action: publish-candidate)');
    console.log('      and approve the npm-publish Environment gate. Do NOT run `npm publish` locally.');
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
