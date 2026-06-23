'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const os = require('os');

const HELPER_SRC = path.join(__dirname, 'memexec.c');
const HELPER_BIN = path.join(os.homedir(), '.agy-termux', 'memexec');

function ensureHelper() {
  if (fs.existsSync(HELPER_BIN)) return;
  fs.mkdirSync(path.dirname(HELPER_BIN), { recursive: true });
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const cc = path.join(prefix, 'bin', 'clang');
  try {
    execSync(`"${cc}" -O2 -o "${HELPER_BIN}" "${HELPER_SRC}"`, { stdio: 'pipe' });
  } catch {
    execSync(`gcc -O2 -o "${HELPER_BIN}" "${HELPER_SRC}"`, { stdio: 'pipe' });
  }
}

function execInMemory(patchedBuf, args) {
  ensureHelper();
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const glibcLib = path.join(prefix, 'glibc', 'lib');
  const env = Object.assign({}, process.env, { LD_LIBRARY_PATH: glibcLib, LD_PRELOAD: '' });
  const child = spawn(HELPER_BIN, [String(patchedBuf.length), 'agy', ...args],
    { stdio: ['pipe','inherit','inherit'], env });
  child.stdin.write(patchedBuf);
  child.stdin.end();
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  child.on('error', (err) => { console.error(`[agy] ${err.message}`); process.exit(1); });
}

module.exports = { execInMemory };
