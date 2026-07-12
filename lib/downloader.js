'use strict';
const https = require('https');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const RELEASES_API = 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest';
const ASSET_NAME = 'agy_cli_linux_arm64.tar.gz';
const VERIFIED_VERSIONS = require('../config/agy-verified-versions.json');

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

async function fetchLatestMeta() {
  const meta = JSON.parse((await httpsGet(RELEASES_API)).toString());
  const asset = meta.assets.find(a => a.name === ASSET_NAME);
  if (!asset) throw new Error(`${ASSET_NAME} が最新リリースに見つかりません`);
  // AGY_TERMUX_FORCE_LATEST 経路は検証済みバージョンではないため sha256Tar/sha256Binary は
  // 付与しない (downloadBinary 側で照合をスキップさせる)
  return { tagName: meta.tag_name, downloadUrl: asset.browser_download_url, sha256Tar: null, sha256Binary: null };
}

async function fetchPinnedMeta() {
  if (!VERIFIED_VERSIONS.sha256_tar) {
    throw new Error('config/agy-verified-versions.json に sha256_tar がありません（pinned mode の整合性検証に必須です）');
  }
  if (!VERIFIED_VERSIONS.sha256_binary) {
    throw new Error('config/agy-verified-versions.json に sha256_binary がありません（pinned mode の整合性検証に必須です）');
  }
  return {
    tagName: VERIFIED_VERSIONS.tag_name,
    downloadUrl: VERIFIED_VERSIONS.download_url,
    sha256Tar: VERIFIED_VERSIONS.sha256_tar,
    sha256Binary: VERIFIED_VERSIONS.sha256_binary,
  };
}

async function downloadBinary(downloadUrl, expectedSha256Tar, expectedSha256Binary) {
  const tarBuf = await httpsGet(downloadUrl);

  // pinned mode（fetchPinnedMeta 経由）では、展開前に tarball 自体の sha256 を
  // sha256_tar と照合する。不一致なら展開すら行わずエラーにする。
  // AGY_TERMUX_FORCE_LATEST=1 経由（fetchLatestMeta）の場合は expectedSha256Tar が
  // null のため照合をスキップする（検証済みバージョンではないため）。
  if (expectedSha256Tar) {
    const actualTarSha256 = crypto.createHash('sha256').update(tarBuf).digest('hex');
    if (actualTarSha256 !== expectedSha256Tar) {
      throw new Error(
        `SHA256 検証失敗: ダウンロードした tarball が pin されたハッシュと一致しません ` +
        `(expected: ${expectedSha256Tar}, actual: ${actualTarSha256})`
      );
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'agy.tar.gz'), tarBuf);
    execFileSync('tar', ['-xzf', 'agy.tar.gz'], { cwd: tmpDir });
    const binName = fs.existsSync(path.join(tmpDir, 'antigravity')) ? 'antigravity' : 'agy';
    const binBuf = fs.readFileSync(path.join(tmpDir, binName));
    if (binBuf.length < 10 * 1024 * 1024 || binBuf[0] !== 0x7F || binBuf.toString('ascii', 1, 4) !== 'ELF') {
      throw new Error('ダウンロードしたバイナリが無効です（ELF ヘッダー検証失敗）');
    }
    // pinned mode（fetchPinnedMeta 経由）では sha256_binary との一致を必須で検証する。
    // AGY_TERMUX_FORCE_LATEST=1 経由（fetchLatestMeta）の場合は expectedSha256Binary が
    // null のため照合をスキップする（検証済みバージョンではないため）。
    if (expectedSha256Binary) {
      const actualSha256 = crypto.createHash('sha256').update(binBuf).digest('hex');
      if (actualSha256 !== expectedSha256Binary) {
        throw new Error(
          `SHA256 検証失敗: ダウンロードしたバイナリが pin されたハッシュと一致しません ` +
          `(expected: ${expectedSha256Binary}, actual: ${actualSha256})`
        );
      }
    }
    return binBuf;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { fetchLatestMeta, fetchPinnedMeta, downloadBinary };
