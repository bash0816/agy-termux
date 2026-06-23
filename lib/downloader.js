'use strict';
const https = require('https');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RELEASES_API = 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest';
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

async function downloadOfficialBinary() {
  process.stderr.write('[agy] 最新リリース情報を取得中...\n');
  const meta = JSON.parse((await httpsGet(RELEASES_API)).toString());
  const asset = meta.assets.find(a => a.name === ASSET_NAME);
  if (!asset) throw new Error(`${ASSET_NAME} が最新リリースに見つかりません`);
  process.stderr.write(`[agy] ${meta.tag_name} をダウンロード中...\n`);
  const tarBuf = await httpsGet(asset.browser_download_url);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'agy.tar.gz'), tarBuf);
    execFileSync('tar', ['-xzf', 'agy.tar.gz'], { cwd: tmpDir });
    const binName = fs.existsSync(path.join(tmpDir, 'antigravity')) ? 'antigravity' : 'agy';
    return fs.readFileSync(path.join(tmpDir, binName));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { downloadOfficialBinary };
