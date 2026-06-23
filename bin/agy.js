#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { AGY_VERSION, INSTALL_DIR } = require('../lib/config');

function checkVersionAndDownload() {
  const versionFile = path.join(INSTALL_DIR, '.version');
  let needsDownload = true;

  if (fs.existsSync(versionFile)) {
    try {
      const version = fs.readFileSync(versionFile, 'utf-8').trim();
      if (version === AGY_VERSION) {
        needsDownload = false;
      }
    } catch {
      needsDownload = true;
    }
  }

  if (needsDownload) {
    const downloader = require('../lib/downloader');
    downloader();
  }
}

function handleUpdateCommand() {
  const arg = process.argv[2];
  if (arg === 'update' || arg === '--update' || arg === 'upgrade') {
    console.log('[agy-termux] このパッケージは npm で管理されています。');
    console.log('  更新するには: npm update -g @bash0816/agy-termux');
    process.exit(0);
  }
}

function checkGlibcLoader() {
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');

  if (!fs.existsSync(loader)) {
    console.error('[agy-termux] Error: glibc loader not found.');
    console.error('  Run: pkg install glibc-repo && pkg install glibc');
    process.exit(1);
  }
}

function launchAgy() {
  const launcherPath = path.join(os.homedir(), '.agy-termux', 'launcher.sh');
  const args = process.argv.slice(2);

  const child = spawn(launcherPath, args, { stdio: 'inherit' });

  child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });

  child.on('error', (err) => {
    console.error(`[agy-termux] Error: Failed to launch agy: ${err.message}`);
    process.exit(1);
  });
}

checkVersionAndDownload();
handleUpdateCommand();
checkGlibcLoader();
launchAgy();
