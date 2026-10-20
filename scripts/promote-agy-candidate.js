#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { normalizeVersion, getTokyoDate } = require('./lib/version-utils');
const { isCompleteExpectation, compareExpectation } = require('./lib/va39-baseline');

const CANDIDATE_CONFIG_PATH = './config/agy-candidate-version.json';
const VERIFIED_CONFIG_PATH = './config/agy-verified-versions.json';
const PACKAGE_JSON_PATH = './package.json';

const VA39_KEYS = [
  'va39_patcher_rev',
  'va39_patch_counts',
  'va39_patch_breakdown',
  'va39_patched_sha256',
  'va39_patched_size',
];

const USAGE = 'Usage: promote-agy-candidate.js <version> --confirm-device-verified';
const USAGE_WITH_APPROVE = 'Usage: promote-agy-candidate.js <version> --confirm-device-verified [--approve-count-change "<理由>"]';

function pickVa39(obj) {
  const out = {};
  for (const k of VA39_KEYS) out[k] = obj[k];
  return out;
}

function parseArgs(argv) {
  const out = {
    version: undefined,
    confirm: false,
    approveGiven: false,
    approveReason: undefined,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm-device-verified') {
      out.confirm = true;
    } else if (a === '--approve-count-change') {
      if (out.approveGiven) {
        out.unknown.push(a);
      } else {
        out.approveGiven = true;
        out.approveReason = argv[i + 1];
        i++;
      }
    } else if (a.startsWith('--')) {
      out.unknown.push(a);
    } else if (out.version === undefined) {
      out.version = a;
    } else {
      out.unknown.push(a);
    }
  }
  return out;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    // Validate arguments
    if (args.unknown.length > 0) {
      console.error(`Error: 未知の引数です: ${args.unknown.join(' ')}`);
      console.error(USAGE_WITH_APPROVE);
      process.exit(1);
    }

    if (!args.version) {
      console.error(USAGE);
      process.exit(1);
    }

    if (!args.confirm) {
      console.error('Error: --confirm-device-verified flag is required to prevent accidental promotion');
      console.error(USAGE);
      process.exit(1);
    }

    if (args.approveGiven && (typeof args.approveReason !== 'string' || args.approveReason.trim() === '')) {
      console.error('Error: --approve-count-change には空でない理由が必要です');
      console.error(USAGE_WITH_APPROVE);
      process.exit(1);
    }
    const approveReason = args.approveGiven ? args.approveReason.trim() : undefined;

    // Check CI environment (reject promotion from CI unless explicitly allowed)
    if (process.env.CI === 'true' && process.env.AGY_PROMOTE_ALLOW_CI !== '1') {
      console.error('Error: Promotion from CI environment requires AGY_PROMOTE_ALLOW_CI=1 to prevent accidental automation');
      console.error('This script should be run manually after device verification');
      process.exit(1);
    }

    // Normalize version (strip 'v' prefix, same convention prepare-agy-candidate.js
    // uses when writing candidateMeta.tag_name) so `promote-agy-candidate.js v1.0.16`
    // and `promote-agy-candidate.js 1.0.16` both match a candidate tag_name of '1.0.16'.
    const version = normalizeVersion(args.version);

    // Load candidate config
    if (!fs.existsSync(CANDIDATE_CONFIG_PATH)) {
      console.error(`Error: Candidate config not found at ${CANDIDATE_CONFIG_PATH}`);
      console.error('Run scripts/prepare-agy-candidate.js first to create a candidate');
      process.exit(1);
    }

    const candidateMeta = JSON.parse(fs.readFileSync(CANDIDATE_CONFIG_PATH, 'utf8'));

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

    // VA39 expectation check. The candidate's own va39_baseline_comparison is
    // deliberately ignored; the comparison is always recomputed here.
    const candidateVa39 = pickVa39(candidateMeta);
    if (!isCompleteExpectation(candidateVa39)) {
      console.error('Error: candidate に VA39 の期待値5欄が揃っていません');
      process.exit(1);
    }

    const verifiedCurrent = JSON.parse(fs.readFileSync(VERIFIED_CONFIG_PATH, 'utf8'));
    const comparison = compareExpectation(pickVa39(verifiedCurrent), candidateVa39);

    let approvalSentence = null;
    if (comparison.status !== 'same') {
      if (approveReason === undefined) {
        console.error(`Error: VA39 期待値が前回の verified と一致しません (status: ${comparison.status})`);
        for (const d of comparison.differences) console.error(`  - ${d}`);
        console.error('内容を確認したうえで承認する場合は --approve-count-change "<理由>" を付けて再実行してください');
        process.exit(1);
      }
      approvalSentence = `VA39 expectation change approved: ${approveReason} (${comparison.status}: ${comparison.differences.join('; ')}).`;
    }

    const expectationSentence = approvalSentence
      ? approvalSentence
      : 'VA39 patch-count static check passed with no regression from the prior verified version.';

    // Prepare verified config
    const verifiedMeta = {
      tag_name: candidateMeta.tag_name,
      download_url: candidateMeta.download_url,
      sha256_tar: candidateMeta.sha256_tar,
      sha256_binary: candidateMeta.sha256_binary,
      ...candidateVa39,
      release_id: candidateMeta.release_id,
      asset_id: candidateMeta.asset_id,
      asset_updated_at: candidateMeta.asset_updated_at,
      source_repo: candidateMeta.source_repo,
      verified_date: getTokyoDate(),
      release_state: 'stable',
      notes: `Promoted via promote-agy-candidate.js --confirm-device-verified on ${getTokyoDate()}. ${expectationSentence} Device/functional verification confirmed by the operator invoking this script with --confirm-device-verified.`,
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
