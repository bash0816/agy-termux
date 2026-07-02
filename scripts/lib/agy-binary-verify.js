'use strict';
const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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
 * Verify and download agy binary tarball
 * - Safe tar extraction (check for path traversal, symlinks)
 * - ELF header validation
 * - AArch64 (ARM64) validation
 * - SHA256 computation
 * @param {string} downloadUrl - URL to download tarball from
 * @returns {Promise<{tarSha256: string, binSha256: string, binBuf: Buffer}>}
 */
async function verifyBinary(downloadUrl) {
  const tarBuf = await httpsGet(downloadUrl);
  const tarSha256 = crypto.createHash('sha256').update(tarBuf).digest('hex');

  // Validate tarball size (10MB minimum as per existing downloadBinary logic)
  if (tarBuf.length < 10 * 1024 * 1024) {
    throw new Error(`Tarball too small: ${tarBuf.length} bytes (minimum 10MB)`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-verify-'));
  try {
    const tarPath = path.join(tmpDir, 'agy.tar.gz');
    fs.writeFileSync(tarPath, tarBuf);

    // List tar contents for security check
    let tarListStr;
    try {
      tarListStr = execSync(`tar -tzvf "${tarPath}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`Failed to list tar contents: ${e.message}`);
    }

    // Validate tar entries (path traversal / symlink / hardlink detection)
    const entries = tarListStr.trim().split('\n');
    for (const entry of entries) {
      if (!entry.trim()) continue;

      // Parse tar -tzvf output format: permissions ... filename
      // First char is file type (l=symlink, h=hardlink, -=file, d=dir, etc)
      const fileType = entry[0];

      // Extract filename (last space-separated field)
      const parts = entry.split(/\s+/);
      const fileInfo = parts[parts.length - 1];

      if (!fileInfo) continue;

      // Check for symlinks
      if (fileType === 'l') {
        throw new Error(`Symlink detected in tarball: ${fileInfo}`);
      }

      // Check for hardlinks (tar marks them as 'h' or shows 'link to' in output)
      if (fileType === 'h' || entry.includes('link to')) {
        throw new Error(`Hardlink detected in tarball: ${fileInfo}`);
      }

      // Check for absolute paths
      if (fileInfo.startsWith('/')) {
        throw new Error(`Absolute path in tarball: ${fileInfo}`);
      }

      // Check for directory traversal
      if (fileInfo.includes('../') || fileInfo.includes('..\\')) {
        throw new Error(`Directory traversal (../) detected in tarball: ${fileInfo}`);
      }
    }

    // Extract tarball
    try {
      execSync(`tar -xzf "${tarPath}"`, { cwd: tmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`Failed to extract tarball: ${e.message}`);
    }

    // Find binary (check 'antigravity' first, fallback to 'agy')
    const binName = fs.existsSync(path.join(tmpDir, 'antigravity')) ? 'antigravity' : 'agy';
    const binPath = path.join(tmpDir, binName);

    if (!fs.existsSync(binPath)) {
      throw new Error(`Binary not found in tarball: ${binName}`);
    }

    const binBuf = fs.readFileSync(binPath);

    // Validate binary is not too small
    if (binBuf.length < 10 * 1024 * 1024) {
      throw new Error(`Binary too small: ${binBuf.length} bytes (minimum 10MB)`);
    }

    // Validate ELF header
    if (binBuf[0] !== 0x7F || binBuf.toString('ascii', 1, 4) !== 'ELF') {
      throw new Error('Invalid ELF header (not ELF binary)');
    }

    // Validate AArch64 (ARM64)
    // e_machine field at offset 18-19 (little-endian uint16)
    // AArch64 is 0xB7 (183)
    const eMachine = binBuf.readUInt16LE(18);
    if (eMachine !== 0xB7) {
      throw new Error(`Not AArch64: e_machine = 0x${eMachine.toString(16).padStart(2, '0')} (expected 0xB7 for AArch64)`);
    }

    const binSha256 = crypto.createHash('sha256').update(binBuf).digest('hex');

    return { tarSha256, binSha256, binBuf };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { verifyBinary };
