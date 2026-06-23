'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const os = require('os');
const { AGY_VERSION, DOWNLOAD_URL, WALLENTX_REPO, SHA256_TAR, SHA256_VA39, INSTALL_DIR } = require('./config');

function checkCommand(cmd) {
  try {
    execSync(`command -v ${cmd}`, { shell: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getFreeDiskSpace(dirPath) {
  try {
    const result = execSync(`df "${dirPath}" | tail -1`, { encoding: 'utf-8' });
    const parts = result.trim().split(/\s+/);
    return Math.floor(parseInt(parts[3], 10) * 1024);
  } catch {
    return 0;
  }
}

function hashFile(filePath, algorithm = 'sha256') {
  const hash = crypto.createHash(algorithm);
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function downloadTarball(url, outputPath) {
  try {
    execSync(`curl -fL --progress-bar -o "${outputPath}" "${url}"`, { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`Failed to download tarball: ${err.message}`);
  }
}

function verifyAttestation(tarballPath) {
  if (!checkCommand('gh')) {
    console.log('[agy-termux] Warning: gh command not found. Skipping attestation verification.');
    console.log('  To verify provenance, install: pkg install gh');
    return;
  }

  try {
    execSync(`gh attestation verify "${tarballPath}" -R ${WALLENTX_REPO}`, { stdio: 'inherit' });
  } catch (err) {
    fs.unlinkSync(tarballPath);
    throw new Error('Attestation verification failed (possible tampering). Tarball deleted.');
  }
}

function extractAndVerify(tarballPath, tmpDir) {
  try {
    execSync(`tar -xzf "${tarballPath}" -C "${tmpDir}" agy.va39`, { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`Failed to extract tarball: ${err.message}`);
  }

  const extractedBinary = path.join(tmpDir, 'agy.va39');
  if (!fs.existsSync(extractedBinary)) {
    throw new Error('agy.va39 not found in tarball');
  }

  const binaryHash = hashFile(extractedBinary);
  if (binaryHash !== SHA256_VA39) {
    fs.unlinkSync(extractedBinary);
    throw new Error(`SHA256 mismatch for agy.va39. Expected: ${SHA256_VA39}, got: ${binaryHash}`);
  }

  return extractedBinary;
}

function installBinary(extractedBinary) {
  if (!fs.existsSync(INSTALL_DIR)) {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
  }

  const destBinary = path.join(INSTALL_DIR, 'agy.va39');
  fs.copyFileSync(extractedBinary, destBinary);
  fs.chmodSync(destBinary, 0o755);

  const launcherSrc = path.join(__dirname, 'launcher.sh');
  const launcherDest = path.join(INSTALL_DIR, 'launcher.sh');
  fs.copyFileSync(launcherSrc, launcherDest);
  fs.chmodSync(launcherDest, 0o755);

  fs.writeFileSync(path.join(INSTALL_DIR, '.version'), AGY_VERSION);
}

function downloadAndInstall() {
  if (!checkCommand('curl')) {
    console.error('[agy-termux] Error: curl command not found.');
    console.error('  Run: pkg install curl');
    process.exit(1);
  }

  const installCheckDir = fs.existsSync(INSTALL_DIR) ? INSTALL_DIR : os.homedir();
  const installFreeSpace = getFreeDiskSpace(installCheckDir);
  const tmpDir = process.env.TMPDIR || path.join(os.homedir(), 'tmp');
  const tmpFreeSpace = getFreeDiskSpace(tmpDir);

  if (installFreeSpace < 250 * 1024 * 1024) {
    console.error('[agy-termux] Error: Insufficient disk space in installation directory.');
    console.error(`  Required: 250 MB, Available: ${Math.round(installFreeSpace / 1024 / 1024)} MB`);
    process.exit(1);
  }

  if (tmpFreeSpace < 250 * 1024 * 1024) {
    console.error('[agy-termux] Error: Insufficient disk space in temporary directory.');
    console.error(`  Required: 250 MB, Available: ${Math.round(tmpFreeSpace / 1024 / 1024)} MB`);
    process.exit(1);
  }

  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const tarballPath = path.join(tmpDir, `antigravity-termux-standalone-${Date.now()}.tar.gz`);

  try {
    console.log('[agy-termux] Downloading agy binary...');
    downloadTarball(DOWNLOAD_URL, tarballPath);

    console.log('[agy-termux] Verifying tarball SHA256...');
    const tarHash = hashFile(tarballPath);
    if (tarHash !== SHA256_TAR) {
      fs.unlinkSync(tarballPath);
      console.error('[agy-termux] Error: SHA256 mismatch for tarball.');
      console.error(`  Expected: ${SHA256_TAR}, got: ${tarHash}`);
      process.exit(1);
    }

    console.log('[agy-termux] Verifying attestation...');
    verifyAttestation(tarballPath);

    console.log('[agy-termux] Extracting binary...');
    const extractedBinary = extractAndVerify(tarballPath, tmpDir);

    console.log('[agy-termux] Installing binary...');
    installBinary(extractedBinary);

    console.log('[agy-termux] Cleaning up temporary files...');
    fs.unlinkSync(tarballPath);
    fs.unlinkSync(extractedBinary);

    console.log('[agy-termux] Installation complete!');
  } catch (err) {
    console.error(`[agy-termux] Error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = downloadAndInstall;
