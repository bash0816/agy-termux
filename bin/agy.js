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
async function gateCompat({ exitOnDecline = true } = {}) {
  if (hasConsent('compat')) return true;
  console.error('\n[agy] このデバイスでの起動には互換性のための技術的な調整が必要です。');
  console.error('      調整はこのデバイス上でのみ行われ、元のファイルは変更されません。\n');
  const _ans2 = await ask('続けますか？ [Y/n] ');
  if (_ans2 === 'n' || _ans2 === 'no') {
    if (exitOnDecline) { console.error('キャンセルしました。'); process.exit(0); }
    return false;
  }
  saveConsent('compat');
  return true;
}
// bin/agy.js は "<prefix>/lib/node_modules/@bash0816/agy-termux/bin/agy.js" に配置される
// (npmのグローバルインストールの標準レイアウト)。ここから4階層上がprefixになる。
// 純粋な文字列パス計算のみ行うため、テストではfsアクセスなしで検証できる。
function computePrefixFromRealFilePath(realFilePath) {
  const packageRoot = path.resolve(path.dirname(realFilePath), '..');
  const candidatePrefix = path.resolve(packageRoot, '..', '..', '..', '..');
  const expectedPackageRoot = path.join(candidatePrefix, 'lib', 'node_modules', '@bash0816', 'agy-termux');
  if (path.resolve(expectedPackageRoot) !== packageRoot) {
    return null;
  }
  return candidatePrefix;
}

function detectOwnPrefix() {
  // fs.realpathSync(__filename) を基点にすることで、symlink経由の起動でも実体のパスで判定する。
  const realFile = fs.realpathSync(__filename);
  return computePrefixFromRealFilePath(realFile);
}

// バイナリ同期(lib/binary-cache.js の syncBinary)に渡す依存を組み立てる
// require は呼び出し時に行い、--version の経路では読み込まれないようにする
async function buildSyncDeps() {
  const bc = require('../lib/binary-cache');
  const { fetchPinnedMeta, downloadBinary } = require('../lib/downloader');
  const meta = await fetchPinnedMeta();
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const isPatch = bc.needsPatch();
  // プロセス生存確認。ESRCH のときだけ「存在しない」と判定し、それ以外は unknown として残す
  const killPid = (pid) => {
    try { process.kill(pid, 0); return 'alive'; } catch (e) { return e && e.code === 'ESRCH' ? 'esrch' : 'unknown'; }
  };
  return {
    meta,
    dir: INSTALL_DIR,
    isPatch,
    hasConsent,
    fsDeps: fs,
    loaderExists: () => fs.existsSync(path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1')),
    confirmCompat: () => gateCompat({ exitOnDecline: false }),
    install: async (file) => {
      process.stderr.write(`[agy] ${meta.tagName} をダウンロード中...\n`);
      await bc.installBinary({
        download: downloadBinary,
        patch: (buf) => require('../lib/patcher').applyVA39Patch(buf),
        fs,
        pid: process.pid,
        randomHex: () => require('crypto').randomBytes(4).toString('hex'),
      }, { meta, isPatch, file });
    },
    prune: (pinTag) => bc.prune({
      readdirSync: fs.readdirSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      killPid,
      now: Date.now,
    }, { dir: INSTALL_DIR, pinTag }),
    listManualCleanup: () => bc.listManualCleanup({
      readdirSync: fs.readdirSync,
      statSync: fs.statSync,
    }, { dir: INSTALL_DIR }),
    out: console.log,
    err: console.error,
  };
}

async function main() {
  const args = process.argv.slice(2);

  // --version / -v / -V / version: ローカル情報のみで即座に返す。ネットワーク・同意ゲート・ダウンロード・spawn・
  // ファイルシステムへの書き込みは一切行わない（副作用ゼロを維持するため、legacy cleanupより前に早期return する）。
  if (['--version', '-v', '-V', 'version'].includes(args[0])) {
    const pkg = require('../package.json');
    console.log(`agy-termux ${pkg.version}`);
    process.exit(0);
  }

  if (['update','--update','upgrade'].includes(args[0])) {
    // 判定ロジックは lib/audited-update.js に分離(監査済み版を基準にする)
    const { spawnSync } = require('child_process');
    // 更新後の新しいコードから呼ばれる同期専用の経路。更新判定は行わない
    if (args[1] === '--sync-binary-only') {
      const res = await require('../lib/binary-cache').syncBinary(await buildSyncDeps());
      process.exit(res.status === 'error' ? 1 : 0);
    }
    const { runUpdate, createDeps } = require('../lib/audited-update');
    const pkg = require('../package.json');
    const r = await runUpdate(createDeps({
      spawnSync,
      realpathSync: fs.realpathSync,
      filename: __filename,
      https: require('https'),
      env: process.env,
      out: (m) => console.log(m),
      err: (m) => console.error(m),
      computePrefix: computePrefixFromRealFilePath,
      pkgVersion: pkg.version,
    }));
    if (r.code !== 0) process.exit(r.code);
    // 版が変わっていない(install されなかった)場合は、現在のコードでバイナリだけ同期する
    if (!r.installed) {
      const res = await require('../lib/binary-cache').syncBinary(await buildSyncDeps());
      process.exit(res.status === 'error' ? 1 : 0);
    }
    // 更新後の package.json をディスクから読み直す(require のキャッシュは使わない)
    let newVer;
    try {
      newVer = JSON.parse(fs.readFileSync(path.join(r.pkgDir, 'package.json'), 'utf8')).version;
    } catch { newVer = undefined; }
    if (newVer !== r.aud) {
      console.error('[agy] 更新後のパッケージの版が想定と異なります(期待: ' + r.aud + '、実際: ' + newVer + ')。');
      process.exit(1);
    }
    // 旧版には binary-cache.js が無いので、同期は行わず案内だけ出す
    if (!fs.existsSync(path.join(r.pkgDir, 'lib', 'binary-cache.js'))) {
      console.error('[agy] 警告: パッケージは ' + r.aud + ' に更新済みですが、このバージョンにはバイナリ同期機能が含まれていないため、バイナリは同期されていません。agy の版が一致しない場合は AGY_TERMUX_REFRESH=1 agy を実行してください。');
      process.exit(0);
    }
    // 新しいコードに同期を任せる(子プロセスの環境は親から継承される)
    const c = spawnSync(process.execPath, [path.join(r.pkgDir, 'bin', 'agy.js'), 'update', '--sync-binary-only'], { stdio: 'inherit' });
    if (c.error || c.signal || c.status !== 0) {
      console.error('[agy] パッケージは ' + r.aud + ' に更新済みですが、バイナリの取得に失敗しました。ネットワークを確認して agy update を再実行するか、agy を起動してください(起動時にも取得されます)。');
      process.exit(1);
    }
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
  const bc = require('../lib/binary-cache');
  const glibcLib = path.join(prefix, 'glibc', 'lib');
  const isPatch = bc.needsPatch();

  const useLatest = process.env.AGY_TERMUX_FORCE_LATEST === '1';
  const forceRefresh = process.env.AGY_TERMUX_REFRESH === '1';
  if (useLatest) {
    process.stderr.write('[agy] AGY_TERMUX_FORCE_LATEST: 検証されていない最新版を使用します（自己責任）\n');
  }
  process.stderr.write(useLatest ? '[agy] 最新リリース情報を取得中...\n' : '[agy] 検証済みリリース情報を取得中...\n');
  const { tagName, downloadUrl, sha256Tar, sha256Binary } = useLatest ? await fetchLatestMeta() : await fetchPinnedMeta();

  // 版付きのキャッシュ先(検証済みは agy-<tag>.<ext>、FORCE_LATEST は unverified/ 配下)
  const { file: tmp } = bc.cachePaths({ dir: INSTALL_DIR, tag: tagName, isPatch, unverified: useLatest });
  // キャッシュの健全性チェック(サイズ + ELFマジックバイト)。壊れている場合は再取得させる
  const cacheHit = !forceRefresh && bc.isCacheValid(fs, tmp);

  if (!cacheHit) {
    if (isPatch) await gateCompat();
    process.stderr.write(`[agy] ${tagName} をダウンロード中...\n`);
    // 取得前に既存キャッシュは消さない。配置は一時ファイル経由の rename で行う
    await bc.installBinary({
      download: downloadBinary,
      patch: (buf) => require('../lib/patcher').applyVA39Patch(buf),
      fs,
      pid: process.pid,
      randomHex: () => require('crypto').randomBytes(4).toString('hex'),
    }, { meta: { tagName, downloadUrl, sha256Tar, sha256Binary }, isPatch, file: tmp });
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
  child.on('error', err => {
    console.error(`[agy] ${err.message}`);
    process.exit(1);
  });
}
if (require.main === module) {
  main().catch(err => { console.error(`[agy] Error: ${err.message}`); process.exit(1); });
}

module.exports = { computePrefixFromRealFilePath, detectOwnPrefix };
