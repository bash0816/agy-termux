#!/usr/bin/env node
'use strict';

const https = require('https');
const { verifyBinary } = require('./lib/agy-binary-verify');
const { normalizeVersion, getTokyoDate } = require('./lib/version-utils');
const { applyVA39Patch } = require('../lib/patcher');
const { readPatcherRev, buildExpectation, compareExpectation } = require('./lib/va39-baseline');
const fs = require('fs');

const VERIFIED_CONFIG_PATH = './config/agy-verified-versions.json';
const ASSET_NAME = 'agy_cli_linux_arm64.tar.gz';
const EXPECTATION_KEYS = [
  'va39_patcher_rev',
  'va39_patch_counts',
  'va39_patch_breakdown',
  'va39_patched_sha256',
  'va39_patched_size',
];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'agy-termux' };
    // If a GH_TOKEN is available (e.g. passed through from the calling
    // workflow as `env: GH_TOKEN: ${{ github.token }}`), authenticate the
    // api.github.com call with it. Unauthenticated requests are capped at
    // 60 req/hour/IP, and GitHub Actions' shared runner IPs share that
    // quota across many unrelated workflows/repos, so this call can fail
    // intermittently without it. Falls back to unauthenticated (User-Agent
    // only) when GH_TOKEN is unset, e.g. for local manual runs.
    if (process.env.GH_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GH_TOKEN}`;
    }
    https.get(url, { headers }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300) &&
          !(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
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
 * release の状態を検査し、対象 asset を返す。ダウンロード前に呼ぶこと(ネットワークは使わない)。
 * draft / prerelease / asset 不在なら Error を投げる。
 */
function assertReleaseDownloadable(version, releaseMeta) {
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
  return asset;
}

/**
 * release 情報とバイナリ情報から candidate meta を組み立てる(ネットワークは使わない)。
 * verifiedConfig は読めなかった場合 null。binBuf は書き換えない。
 */
function buildCandidateMeta({ version, releaseMeta, tarSha256, binSha256, binBuf, verifiedConfig, tokyoDate }) {
  // Re-check release state and find the asset (same checks as before download)
  const asset = assertReleaseDownloadable(version, releaseMeta);

  // Apply VA39 patch to a copy and build the expectation fields
  const binBufCopy = Buffer.from(binBuf);
  const patchResult = applyVA39Patch(binBufCopy);
  const expectation = buildExpectation({
    patchResult,
    patchedBuf: binBufCopy,
    rev: readPatcherRev(),
  });

  // Baseline: the expectation fields present in the verified config (none if unreadable)
  const baselineFields = {};
  if (verifiedConfig && typeof verifiedConfig === 'object') {
    for (const k of EXPECTATION_KEYS) {
      if (k in verifiedConfig) baselineFields[k] = verifiedConfig[k];
    }
  }
  const comparison = compareExpectation(baselineFields, expectation);

  // Normalize version (strip 'v' prefix if present)
  const normalizedVersion = normalizeVersion(version);

  return {
    tag_name: normalizedVersion,
    download_url: asset.browser_download_url,
    sha256_tar: tarSha256,
    sha256_binary: binSha256,
    ...expectation,
    va39_baseline_comparison: { status: comparison.status, differences: comparison.differences },
    release_id: releaseMeta.id,
    asset_id: asset.id,
    asset_updated_at: asset.updated_at,
    source_repo: 'google-antigravity/antigravity-cli',
    detected_date: tokyoDate,
    status: 'pending_device_verification',
  };
}

/**
 * 取得・検査・ダウンロード・候補組み立てを行う。外部入出力は注入する。
 * 検査(draft / prerelease / asset 不在)はダウンロードより前に行い、拒否時は download を呼ばない。
 */
async function runCandidate({ version, fetchRelease, download, readVerifiedConfig, tokyoDate }) {
  // Fetch release info from GitHub API
  const releaseMeta = await fetchRelease(version);

  // Validate release state and look up the asset before any download
  const asset = assertReleaseDownloadable(version, releaseMeta);

  // Verify binary and compute SHA256
  const { tarSha256, binSha256, binBuf } = await download(asset.browser_download_url);

  // Load baseline from verified config (null when unreadable: first time setup)
  const verifiedConfig = readVerifiedConfig();

  return buildCandidateMeta({
    version,
    releaseMeta,
    tarSha256,
    binSha256,
    binBuf,
    verifiedConfig,
    tokyoDate,
  });
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: prepare-agy-candidate.js <version>');
    process.exit(1);
  }

  try {
    const candidateMeta = await runCandidate({
      version,
      fetchRelease: async (v) => {
        const apiUrl = `https://api.github.com/repos/google-antigravity/antigravity-cli/releases/tags/${v}`;
        return JSON.parse((await httpsGet(apiUrl)).toString());
      },
      download: verifyBinary,
      readVerifiedConfig: () => {
        try {
          return JSON.parse(fs.readFileSync(VERIFIED_CONFIG_PATH, 'utf8'));
        } catch (e) {
          // If we can't read baseline, just continue
          return null;
        }
      },
      // Current date in Asia/Tokyo timezone
      tokyoDate: getTokyoDate(),
    });

    // Output JSON to stdout
    console.log(JSON.stringify(candidateMeta, null, 2));
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { assertReleaseDownloadable, buildCandidateMeta, runCandidate };
