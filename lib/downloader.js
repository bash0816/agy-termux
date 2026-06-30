'use strict';
const https = require('https');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
  return { tagName: meta.tag_name, downloadUrl: asset.browser_download_url };
}

async function fetchPinnedMeta() {
  return {
    tagName: VERIFIED_VERSIONS.verified_version,
    downloadUrl: VERIFIED_VERSIONS.download_url,
  };
}

async function downloadBinary(downloadUrl) {
  const tarBuf = await httpsGet(downloadUrl);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'agy.tar.gz'), tarBuf);
    execFileSync('tar', ['-xzf', 'agy.tar.gz'], { cwd: tmpDir });
    const binName = fs.existsSync(path.join(tmpDir, 'antigravity')) ? 'antigravity' : 'agy';
    const binBuf = fs.readFileSync(path.join(tmpDir, binName));
    if (binBuf.length < 10 * 1024 * 1024 || binBuf[0] !== 0x7F || binBuf.toString('ascii', 1, 4) !== 'ELF') {
      throw new Error('ダウンロードしたバイナリが無効です（ELF ヘッダー検証失敗）');
    }
    return binBuf;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { fetchLatestMeta, fetchPinnedMeta, downloadBinary };
