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
  const _ans1 = await ask('続けますか？ [Y/n] ');
  if (_ans1 === 'n' || _ans1 === 'no') { console.error('キャンセルしました。'); process.exit(0); }
  saveConsent('download');
}
async function gateCompat() {
  if (hasConsent('compat')) return;
  console.error('\n[agy] このデバイスでの起動には互換性のための技術的な調整が必要です。');
  console.error('      調整はこのデバイス上でのみ行われ、元のファイルは変更されません。\n');
  const _ans2 = await ask('続けますか？ [Y/n] ');
  if (_ans2 === 'n' || _ans2 === 'no') { console.error('キャンセルしました。'); process.exit(0); }
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
  // Legacy cleanup: remove leftover .bin.tmp file from old naming scheme
  fs.rmSync(path.join(INSTALL_DIR, '.bin.tmp'), { force: true });

  const args = process.argv.slice(2);

  // --version / -v / -V / version: ローカル情報のみで即座に返す。ネットワーク・同意ゲート・ダウンロード・spawn は一切行わない。
  if (['--version', '-v', '-V', 'version'].includes(args[0])) {
    const pkg = require('../package.json');
    const verified = require('../config/agy-verified-versions.json');
    const versionFile = path.join(INSTALL_DIR, '.version');
    const cached = (() => { try { return fs.readFileSync(versionFile, 'utf8').trim(); } catch { return 'not installed'; } })();
    console.log(`agy-termux wrapper: ${pkg.version}`);
    console.log(`verified upstream:  ${verified.verified_version}`);
    console.log(`cached upstream:    ${cached}`);
    process.exit(0);
  }

  if (['update','--update','upgrade'].includes(args[0])) {
    const { spawnSync } = require('child_process');
    const pkg = require('../package.json');
    const currentVersion = pkg.version;
    function isNewer(a, b) {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) { if (pa[i] > pb[i]) return true; if (pa[i] < pb[i]) return false; }
      return false;
    }
    process.stderr.write('[agy] npm registry を確認中...\n');
    const view = spawnSync('npm', ['view', '@bash0816/agy-termux', 'version'], { shell: false, encoding: 'utf8', timeout: 15000 });
    if (view.error || view.status !== 0) {
      console.error('[agy] registry の確認に失敗しました: ' + (view.error ? view.error.message : 'exit ' + view.status));
      process.exit(1);
    }
    const latest = view.stdout.trim();
    if (!isNewer(latest, currentVersion)) {
      console.log('[agy] 最新版です (' + currentVersion + ')');
      process.exit(0);
    }
    process.stderr.write('[agy] ' + currentVersion + ' → ' + latest + ' に更新します...\n');
    const inst = spawnSync('npm', ['install', '-g', '@bash0816/agy-termux@latest'], { shell: false, stdio: 'inherit', timeout: 60000 });
    if (inst.error || inst.status !== 0) {
      console.error('[agy] 更新に失敗しました。前のバージョンに戻すには: npm install -g @bash0816/agy-termux@' + currentVersion);
      process.exit(1);
    }
    console.log('[agy] 更新完了');
    process.exit(0);
  }
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
  if (!fs.existsSync(loader)) {
    console.error('[agy] glibc loader が見つかりません。');
    console.error('  pkg install glibc-repo && pkg install glibc'); process.exit(1);
  }
  await gateDownload();

  const { fetchLatestMeta, fetchPinnedMeta, downloadBinary } = require('../lib/downloader');
  const glibcLib = path.join(prefix, 'glibc', 'lib');
  const isPatch = needsPatch();
  const tmp = isPatch ? path.join(INSTALL_DIR, 'agy.va39') : path.join(INSTALL_DIR, '.bin');
  const versionFile = path.join(INSTALL_DIR, '.version');

  const useLatest = process.env.AGY_TERMUX_FORCE_LATEST === '1';
  const forceRefresh = process.env.AGY_TERMUX_REFRESH === '1';
  if (useLatest) {
    process.stderr.write('[agy] AGY_TERMUX_FORCE_LATEST: 検証されていない最新版を使用します（自己責任）\n');
  }
  process.stderr.write(useLatest ? '[agy] 最新リリース情報を取得中...\n' : '[agy] 検証済みリリース情報を取得中...\n');
  const { tagName, downloadUrl, sha256Tar, sha256Binary } = useLatest ? await fetchLatestMeta() : await fetchPinnedMeta();

  const cachedTag = (() => { try { return fs.readFileSync(versionFile, 'utf8').trim(); } catch { return ''; } })();

  // キャッシュ済みバイナリの最低限の健全性チェック（サイズ + ELFマジックバイト）。
  // 壊れている場合は再ダウンロードさせる（cacheHit=false扱い）。
  function isCachedBinaryValid() {
    let fd;
    try {
      const stat = fs.statSync(tmp);
      if (stat.size < 10 * 1024 * 1024) return false;
      fd = fs.openSync(tmp, 'r');
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      return head[0] === 0x7F && head.toString('ascii', 1, 4) === 'ELF';
    } catch {
      return false;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  let cacheHit = !forceRefresh && tagName === cachedTag && fs.existsSync(tmp) && isCachedBinaryValid();
  if (!cacheHit) {
    // 壊れたキャッシュ・古いキャッシュを確実に一掃してから再取得する
    fs.rmSync(tmp, { force: true });
    fs.rmSync(versionFile, { force: true });
  }

  if (!cacheHit) {
    if (isPatch) await gateCompat();
    process.stderr.write(`[agy] ${tagName} をダウンロード中...\n`);
    const binBuf = await downloadBinary(downloadUrl, sha256Tar, sha256Binary);
    if (isPatch) {
      const { applyVA39Patch } = require('../lib/patcher');
      applyVA39Patch(binBuf);
    }
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    const tmpWrite = tmp + '.tmp';
    fs.writeFileSync(tmpWrite, binBuf, { mode: 0o700 });
    fs.renameSync(tmpWrite, tmp);
    fs.writeFileSync(versionFile, tagName);
  }

  const { spawn } = require('child_process');
  const child = spawn(loader, ['--library-path', glibcLib, tmp, ...args], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      LD_PRELOAD: path.join(__dirname, "..", "lib", "native", "sigsys_shim.so"),
      SSL_CERT_FILE: path.join(prefix, 'etc', 'tls', 'cert.pem'),
      GODEBUG: 'netdns=cgo',
    }),
  });
  child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });
  // loader自体の起動に失敗した場合（execがそもそも失敗）はキャッシュを破棄して次回再取得させる
  child.on('error', err => {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(versionFile, { force: true });
    console.error(`[agy] ${err.message}`);
    process.exit(1);
  });
}
main().catch(err => { console.error(`[agy] Error: ${err.message}`); process.exit(1); });
