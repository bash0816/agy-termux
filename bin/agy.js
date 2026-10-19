#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const INSTALL_DIR = path.join(os.homedir(), '.agy-termux');
const CONSENT_FILE = path.join(INSTALL_DIR, '.consent');

const { createConsent } = require('../lib/consent');
const consent = createConsent({ file: CONSENT_FILE, fs, stdin: process.stdin, stderr: process.stderr });
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
  // 同意は呼び出し前の preflight で取得済みのため、ここでは常に許可扱いにする
  const onPhase = (label) => process.stderr.write('[agy] ' + (label === '取得します...' ? meta.tagName + ' のバイナリを取得します(初回のみ・数分かかることがあります。次回からは取得しません)' : label) + '\n');
  return {
    meta,
    dir: INSTALL_DIR,
    isPatch,
    hasConsent: () => true,
    fsDeps: fs,
    loaderExists: () => fs.existsSync(path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1')),
    confirmCompat: async () => true,
    onPhase,
    progress: true,
    ensure: ({ forceRefresh } = {}) => bc.ensureBinary(require('../lib/ensure-wiring').makeEnsureDeps({ fs, download: downloadBinary, patch: (buf) => require('../lib/patcher').applyVA39Patch(buf), onPhase, progress: true, npmVersion: require('../package.json').version }), { meta, dir: INSTALL_DIR, isPatch, unverified: false, forceRefresh: !!forceRefresh }),
    install: async (file) => {
      await bc.installBinary({
        download: downloadBinary,
        patch: (buf) => require('../lib/patcher').applyVA39Patch(buf),
        fs,
        pid: process.pid,
        randomHex: () => require('crypto').randomBytes(4).toString('hex'),
        onPhase,
        progress: true,
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
    out: () => {},
    err: () => {},
  };
}

// 起動前の確認(loader・同意・互換調整)。同意の入力は端末から行う
async function preflight() {
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
  if (!fs.existsSync(loader)) return { ok: false, status: 'error', reason: 'loader' };
  const g = await consent.gateDownload();
  if (g !== 'granted') {
    return g === 'declined'
      ? { ok: false, status: 'skipped', reason: 'consent_declined' }
      : { ok: false, status: 'error', reason: 'no_input' };
  }
  if (require('../lib/binary-cache').needsPatch()) {
    const c = await consent.gateCompat();
    if (c !== 'granted') {
      return c === 'declined'
        ? { ok: false, status: 'skipped', reason: 'compat_declined' }
        : { ok: false, status: 'error', reason: 'no_input' };
    }
  }
  return { ok: true };
}

// 確認を通してからバイナリを同期する。確認で止まった場合は結果オブジェクトで返す
async function syncWithGates() {
  const pre = await preflight();
  if (!pre.ok) {
    return { status: pre.status, reason: pre.reason, detail: '', tag: '', deleted: { count: 0, bytes: 0 } };
  }
  return require('../lib/binary-cache').syncBinary(await buildSyncDeps());
}

// 行の配列を標準出力・標準エラーへ出す(stream が 'err' なら標準エラー)
function printLines(lines) {
  for (const l of lines) {
    if (l.stream === 'err') console.error(l.text);
    else console.log(l.text);
  }
}

// 例外から結果に載せる情報を作る(同名の項目だけをコピーし、無い項目は省略する)
function errorInfo(e) {
  const info = {};
  for (const k of ['code', 'httpStatus', 'errno', 'path', 'stage']) {
    if (e && e[k] !== undefined) info[k] = e[k];
  }
  info.detail = (e && e.message) || String(e);
  return info;
}

// 同期を実行し、例外は結果オブジェクト(status 'error')に変換して返す
async function syncResultOrError() {
  try {
    return await syncWithGates();
  } catch (e) {
    return {
      status: 'error',
      reason: (e && typeof e.code === 'string' && e.code) || 'E_UNKNOWN',
      detail: (e && e.message) || String(e),
      tag: '',
      deleted: { count: 0, bytes: 0 },
      error: errorInfo(e),
    };
  }
}

// 親へ結果を fd 3 に 1 行の JSON で渡す。書込みの失敗は無視する
function writeResultFd(result) {
  try { fs.writeSync(3, JSON.stringify(result) + '\n'); } catch {}
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

  // --self-check[=<nonce>][ --deep]: 同意・ネットワーク・書き込みより前に返す自己診断
  if (args[0] === '--self-check' || (typeof args[0] === 'string' && args[0].startsWith('--self-check='))) {
    const { runSelfCheck } = require('../lib/self-check');
    const nonce = args[0].includes('=') ? args[0].slice(args[0].indexOf('=') + 1) : undefined;
    const deep = args[1] === '--deep';
    const r = runSelfCheck({ pkgRoot: path.resolve(__dirname, '..'), nonce, deep, cacheDir: INSTALL_DIR });
    if (r.ok) {
      if (r.line) console.log(r.line);
      process.exit(0);
    }
    console.error('[agy] self-check failed: ' + r.problems.join(', '));
    process.exit(1);
  }

  if (['update','--update','upgrade'].includes(args[0])) {
    // 判定ロジックは lib/audited-update.js に分離(監査済み版を基準にする)
    const { spawnSync } = require('child_process');
    const { renderFinal, renderUnknownResult, parseResult } = require('../lib/render-final');
    const { runSyncChild } = require('../lib/run-sync-child');
    // 更新後の新しいコードから呼ばれる同期専用の経路。更新判定は行わない
    if (args[1] === '--sync-binary-only') {
      const resultFd = args.includes('--result-fd=3');
      const result = await syncResultOrError();
      if (resultFd) {
        // 親へ結果を渡す。最終行は出さない(進捗は標準エラーに出ている)
        writeResultFd(result);
        process.exit(result.status === 'error' ? 1 : result.status === 'skipped' ? 10 : 0);
      }
      const rf = renderFinal({ installed: false, result });
      printLines(rf.lines);
      process.exit(rf.code);
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
      notifiedFile: path.join(INSTALL_DIR, '.notified'),
      preflight,
    }));
    // 起動前の確認(loader・同意・互換調整)で止まった場合
    if (r.preflight) {
      const rf = renderFinal({ installed: false, result: { status: r.preflight.status, reason: r.preflight.reason, detail: '', tag: '', deleted: { count: 0, bytes: 0 } } });
      printLines(rf.lines);
      process.exit(rf.code);
    }
    if (r.code !== 0) process.exit(r.code);
    // 版が変わっていない(install されなかった)場合は、現在のコードでバイナリだけ同期する
    if (!r.installed) {
      const result = await syncResultOrError();
      const rf = renderFinal({ installed: false, result });
      printLines(rf.lines);
      process.exit(rf.code);
    }
    // 更新後の package.json をディスクから読み直す(require のキャッシュは使わない)
    let newVer;
    try {
      newVer = JSON.parse(fs.readFileSync(path.join(r.pkgDir, 'package.json'), 'utf8')).version;
    } catch { newVer = undefined; }
    if (newVer !== r.aud) {
      const prefixDir = path.resolve(r.pkgDir, '..', '..', '..', '..');
      console.error('[agy] 更新後のパッケージの版が想定 (' + r.aud + ') と異なります (実際 ' + newVer + ')。npm install -g --prefix ' + prefixDir + ' @bash0816/agy-termux@' + r.aud + ' を実行してください');
      process.exit(1);
    }
    // 旧版には binary-cache.js が無いので、同期は行わず案内だけ出す
    if (!fs.existsSync(path.join(r.pkgDir, 'lib', 'binary-cache.js'))) {
      console.error('[agy] 警告: パッケージは ' + r.aud + ' に更新済みですが、このバージョンにはバイナリ同期機能が含まれていないため、バイナリは同期されていません。agy の版が一致しない場合は AGY_TERMUX_REFRESH=1 agy を実行してください。');
      process.exit(0);
    }
    // 新しいコードに同期を任せる。結果は fd 3 で受け取る
    const c = await runSyncChild({
      execPath: process.execPath,
      script: path.join(r.pkgDir, 'bin', 'agy.js'),
      args: ['update', '--sync-binary-only', '--result-fd=3'],
    });
    const result = parseResult(c.text);
    const rf = result
      ? renderFinal({ installed: true, from: r.from, to: r.to, result })
      : renderUnknownResult({ to: r.to, cause: c.error ? (c.error.code || c.error.message) : c.signal ? 'signal ' + c.signal : 'exit ' + c.code });
    printLines(rf.lines);
    process.exit(rf.code);
  }
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
  if (!fs.existsSync(loader)) {
    console.error('[agy] glibc loader が見つかりません。');
    console.error('  pkg install glibc-repo && pkg install glibc'); process.exit(1);
  }
  const g = await consent.gateDownload();
  if (g === 'declined') { console.error('[agy] 同意されなかったため、バイナリは取得しません。取得するには、もう一度 agy を実行して同意してください'); process.exit(0); }
  if (g === 'no_input') { console.error('[agy] 同意の入力がありません。端末から agy を実行してください'); process.exit(1); }

  const { fetchLatestMeta, fetchPinnedMeta, downloadBinary } = require('../lib/downloader');
  const { describeFailure } = require('../lib/errors');
  const bc = require('../lib/binary-cache');
  const { makeEnsureDeps } = require('../lib/ensure-wiring');
  const glibcLib = path.join(prefix, 'glibc', 'lib');
  const isPatch = bc.needsPatch();

  const useLatest = process.env.AGY_TERMUX_FORCE_LATEST === '1';
  const forceRefresh = process.env.AGY_TERMUX_REFRESH === '1';
  if (useLatest) {
    process.stderr.write('[agy] AGY_TERMUX_FORCE_LATEST: 検証されていない最新版を使用します（自己責任）\n');
    process.stderr.write('[agy] 最新リリース情報を取得中...\n');
  }
  // 取得(メタ情報・バイナリ)で投げられた例外は、原因別の行で表示して終了する
  const failAndExit = (err) => {
    const lines = describeFailure(errorInfo(err));
    lines.forEach((l, i) => console.error(i === 0 ? '[agy] ' + l : l));
    process.exit(1);
  };
  let meta;
  try {
    meta = useLatest ? await fetchLatestMeta() : await fetchPinnedMeta();
  } catch (err) {
    failAndExit(err);
  }
  const { tagName, downloadUrl, sha256Tar, sha256Binary } = meta;

  // 取得が必要か(FORCE_REFRESH のときは常に取得し直す)。使えるキャッシュがあれば取得しない
  const needInstall = forceRefresh || !bc.findUsableArtifact({ fs }, { meta, dir: INSTALL_DIR, isPatch, unverified: useLatest });

  if (needInstall && isPatch) {
    const c = await consent.gateCompat();
    if (c === 'declined') { console.error('[agy] 互換調整に同意されなかったため、バイナリは取得しません。取得するには、もう一度 agy を実行して同意してください'); process.exit(0); }
    if (c === 'no_input') { console.error('[agy] 同意の入力がありません。端末から agy を実行してください'); process.exit(1); }
  }

  // 取得と配置は ensureBinary に任せる。取得の前の予告は従来の文言を維持する(進捗はダウンロード側が出す)
  const onPhase = (label) => process.stderr.write('[agy] ' + (label === '取得します...' ? `${tagName} のバイナリを取得します(初回のみ・数分かかることがあります。次回からは取得しません)` : label) + '\n');
  // refresh は ensureBinary の forceRefresh に渡す。戻り値の file が起動対象になる
  const ensureArtifact = (refresh) => bc.ensureBinary(makeEnsureDeps({ fs, download: downloadBinary, patch: (buf) => require('../lib/patcher').applyVA39Patch(buf), onPhase, progress: true, npmVersion: require('../package.json').version }), { meta, dir: INSTALL_DIR, isPatch, unverified: useLatest, forceRefresh: refresh });

  const { spawn } = require('child_process');
  // loader を 1 回起動して終了を待つ。spawn の直前に標準入力を止める
  const runLoader = (file) => new Promise((resolve) => {
    process.stdin.pause();
    const child = spawn(loader, ['--library-path', glibcLib, file, ...args], {
      stdio: 'inherit',
      env: Object.assign({}, process.env, {
        LD_PRELOAD: path.join(__dirname, "..", "lib", "native", "sigsys_shim.so"),
        SSL_CERT_FILE: path.join(prefix, 'etc', 'tls', 'cert.pem'),
        GODEBUG: 'netdns=cgo',
      }),
    });
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', err => {
      console.error(`[agy] ${err.message}`);
      process.exit(1);
    });
  });
  // ensureBinary で成果物を用意してから loader を起動する。起動に使った file も返す
  const launchOnce = async (refresh) => {
    let res;
    try { res = await ensureArtifact(refresh); } catch (err) { failAndExit(err); }
    // 取得に失敗したが既存の有効な成果物で起動する場合だけ知らせる
    if (res.source === 'recovered') process.stderr.write('[agy] 取得に失敗しましたが、既存のバイナリで起動します\n');
    return { r: await runLoader(res.file), file: res.file };
  };

  // 自己回復は launch 全体で 1 回だけ。キャッシュの実体が消えていた場合に限り、取得し直して起動する
  let recovered = false;
  let { r, file } = await launchOnce(forceRefresh);
  if (!r.signal && r.code !== 0 && !fs.existsSync(file) && !recovered) {
    recovered = true;
    process.stderr.write('[agy] キャッシュが入れ替わったため、取得し直して起動します...\n');
    ({ r } = await launchOnce(false));
  }
  process.exit(r.signal ? 1 : (r.code ?? 0));
}
if (require.main === module) {
  main().catch(err => {
    const lines = require('../lib/errors').describeFailure(errorInfo(err));
    lines.forEach((l, i) => console.error(i === 0 ? '[agy] ' + l : l));
    process.exit(1);
  });
}

module.exports = { computePrefixFromRealFilePath, detectOwnPrefix, preflight, syncWithGates };
