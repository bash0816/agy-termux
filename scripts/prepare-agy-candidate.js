#!/usr/bin/env node
'use strict';

const https = require('https');
const { verifyBinary } = require('./lib/agy-binary-verify');
const { applyVA39Patch } = require('../lib/patcher');
const fs = require('fs');

const VERIFIED_CONFIG_PATH = './config/agy-verified-versions.json';
const ASSET_NAME = 'agy_cli_linux_arm64.tar.gz';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'agy-termux' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Normalize version tag (strip 'v' prefix for comparison)
 */
function normalizeVersion(v) {
  return v.replace(/^v/, '');
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: prepare-agy-candidate.js <version>');
    process.exit(1);
  }

  try {
    // Fetch release info from GitHub API
    const apiUrl = `https://api.github.com/repos/google-antigravity/antigravity-cli/releases/tags/${version}`;
    const releaseMeta = JSON.parse((await httpsGet(apiUrl)).toString());

    // Validate release state
    if (releaseMeta.draft) {
      throw new Error(`Release ${version} is a draft, skipping`);
    }
    if (releaseMeta.prerelease) {
      throw new Error(`Release ${version} is a prerelease, skipping`);
    }

    // Find asset with exact name match
    const asset = releaseMeta.assets.find(a => a.name === ASSET_NAME);
    if (!asset) {
      throw new Error(`Asset '${ASSET_NAME}' not found in release ${version}`);
    }

    const downloadUrl = asset.browser_download_url;
    const assetId = asset.id;
    const assetUpdatedAt = asset.updated_at;
    const releaseId = releaseMeta.id;

    // Verify binary and compute SHA256
    const { tarSha256, binSha256, binBuf } = await verifyBinary(downloadUrl);

    // Apply VA39 patch to a copy to get patch counts
    const binBufCopy = Buffer.from(binBuf);
    const va39PatchCounts = applyVA39Patch(binBufCopy);

    // Load baseline from verified config to detect regressions
    let va39PatchRegression = [];
    try {
      const verifiedConfig = JSON.parse(fs.readFileSync(VERIFIED_CONFIG_PATH, 'utf8'));
      if (verifiedConfig.va39_patch_counts) {
        const baseline = verifiedConfig.va39_patch_counts;
        for (const [pattern, count] of Object.entries(baseline)) {
          if (count > 0 && va39PatchCounts[pattern] === 0) {
            va39PatchRegression.push(`${pattern}: ${count} -> 0`);
          }
        }
      }
    } catch (e) {
      // If we can't read baseline, just continue (first time setup)
    }

    // Current date in Asia/Tokyo timezone
    const tokyoDate = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    // Normalize version (strip 'v' prefix if present)
    const normalizedVersion = normalizeVersion(version);

    const candidateMeta = {
      tag_name: normalizedVersion,
      download_url: downloadUrl,
      sha256_tar: tarSha256,
      sha256_binary: binSha256,
      va39_patch_counts: va39PatchCounts,
      va39_patch_regression: va39PatchRegression,
      release_id: releaseId,
      asset_id: assetId,
      asset_updated_at: assetUpdatedAt,
      source_repo: 'google-antigravity/antigravity-cli',
      detected_date: tokyoDate,
      status: 'pending_device_verification',
    };

    // Output JSON to stdout
    console.log(JSON.stringify(candidateMeta, null, 2));
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
