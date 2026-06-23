#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const INSTALL_DIR = path.join(os.homedir(), '.agy-termux');
const CONSENT_FILE = path.join(INSTALL_DIR, '.consent');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(r => { rl.question(q, a => { rl.close(); r(a.trim().toLowerCase()); }); });
}
function hasConsent(key) {
  try { return !!JSON.parse(fs.readFileSync(CONSENT_FILE,'utf8'))[key]; } catch { return false; }
}
function saveConsent(key) {
  let d = {}; try { d = JSON.parse(fs.readFileSync(CONSENT_FILE,'utf8')); } catch {}
  d[key] = true;
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.writeFileSync(CONSENT_FILE, JSON.stringify(d, null, 2));
}
async function gateDownload() {
  if (hasConsent('download')) return;
  console.error('\n[agy] このツールは google-antigravity/antigravity-cli の公式バイナリを');
  console.error('      Google のサーバーからダウンロードします。');
  console.error('      利用には Google の利用規約 (antigravity.google/terms) への同意が必要です。\n');
  if ((await ask('続けますか？ [y/N] ')) !== 'y') { console.error('キャンセルしました。'); process.exit(0); }
  saveConsent('download');
}
async function gateCompat() {
  if (hasConsent('compat')) return;
  console.error('\n[agy] このデバイスでの起動には互換性のための技術的な調整が必要です。');
  console.error('      調整はこのデバイス上でのみ行われ、元のファイルは変更されません。\n');
  if ((await ask('続けますか？ [y/N] ')) !== 'y') { console.error('キャンセルしました。'); process.exit(0); }
  saveConsent('compat');
}
function needsPatch() {
  try {
    const maps = fs.readFileSync('/proc/self/maps','utf8').trim().split('\n');
    const highest = Math.max(...maps.map(l => parseInt(l.split('-')[0],16)));
    return highest.toString(2).length <= 39;
  } catch { return true; }
}
async function main() {
  const args = process.argv.slice(2);
  if (['update','--update','upgrade'].includes(args[0])) {
    console.log('[agy] npm update -g @bash0816/agy-termux で更新できます。'); process.exit(0);
  }
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
  if (!fs.existsSync(loader)) {
    console.error('[agy] glibc loader が見つかりません。');
    console.error('  pkg install glibc-repo && pkg install glibc'); process.exit(1);
  }
  await gateDownload();
  const { downloadOfficialBinary } = require('../lib/downloader');
  const binBuf = await downloadOfficialBinary();
  if (needsPatch()) {
    await gateCompat();
    const { applyVA39Patch } = require('../lib/patcher');
    applyVA39Patch(binBuf);
    const { execInMemory } = require('../lib/executor');
    execInMemory(binBuf, args);
  } else {
    const tmp = path.join(INSTALL_DIR, '.bin.tmp');
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    fs.writeFileSync(tmp, binBuf, { mode: 0o700 });
    const { spawn } = require('child_process');
    const glibcLib = path.join(prefix, 'glibc', 'lib');
    const child = spawn(loader, ['--library-path', glibcLib, tmp, ...args],
      { stdio: 'inherit', env: Object.assign({}, process.env, { LD_PRELOAD: '' }) });
    child.on('exit', (code, signal) => { fs.rmSync(tmp, { force: true }); process.exit(signal ? 1 : (code ?? 0)); });
    child.on('error', err => { fs.rmSync(tmp, { force: true }); console.error(`[agy] ${err.message}`); process.exit(1); });
  }
}
main().catch(err => { console.error(`[agy] Error: ${err.message}`); process.exit(1); });
