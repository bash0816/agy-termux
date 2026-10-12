'use strict';

// 配線テスト(npm install 失敗時の状態 A): 実物の bin/agy.js を子プロセスで起動し、
// npm install が失敗したときの結果(元の版の維持・新しい版の採用・ENOSPC の表示)を確かめる
// 通信は test/helpers/mock-https.js(--require で読み込む偽物)に置き換え、npm は偽 npm を使う
// 実ネットワーク・実 npm・実 HOME には触れない

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { makeBinary, makeFakeLoader, makeFakeNpm, writeConsent } = require('./helpers/wiring');

const REPO = path.resolve(__dirname, '..');
const MOCK = path.join(__dirname, 'helpers', 'mock-https.js');
// 検証対象のパッケージに含める部分(test/ は含めない)
const PACKAGE_PARTS = ['bin', 'lib', 'config', 'package.json'];
// 完全な配置に必要なファイル(lib/install-state.js の REQUIRED_FILES と同じ一覧)
const REQUIRED_FILES = [
  'bin/agy.js',
  'lib/binary-cache.js',
  'lib/downloader.js',
  'lib/patcher.js',
  'lib/audited-update.js',
  'lib/errors.js',
  'lib/run-npm.js',
  'lib/install-state.js',
  'lib/notified.js',
  'lib/consent.js',
  'lib/render-final.js',
  'lib/run-sync-child.js',
  'lib/self-check.js',
  'lib/native/sigsys_shim.so',
  'config/agy-verified-versions.json',
];

const CUR = '1.2.14';
const AUD = '1.2.16';

// 一時ディレクトリ(テスト終了時に削除)。realpath にして、prefix の比較を実体で行う
function makeRoot() {
  let base;
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wire-'));
  } catch {
    base = fs.mkdtempSync(path.join(process.env.TMPDIR, 'agy-wire-'));
  }
  return fs.realpathSync(base);
}
const ROOT = makeRoot();
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
function newDir(name) {
  const dir = path.join(ROOT, `${name}-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 標準レイアウト(npm のグローバルインストール先)のパッケージ位置
function stdPackageDir(prefix) {
  return path.join(prefix, 'lib', 'node_modules', '@bash0816', 'agy-termux');
}

// 作業ツリーの bin/lib/config/package.json を pkgDir へコピーし、version を書き換える
function makePackage(pkgDir, version) {
  fs.mkdirSync(pkgDir, { recursive: true });
  for (const part of PACKAGE_PARTS) {
    fs.cpSync(path.join(REPO, part), path.join(pkgDir, part), { recursive: true });
  }
  const pkgPath = path.join(pkgDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  // 検証済み pin(tag_name)を version に合わせる。他の項目は読んだ値のまま保持する
  const pinPath = path.join(pkgDir, 'config', 'agy-verified-versions.json');
  const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  pin.tag_name = version;
  fs.writeFileSync(pinPath, JSON.stringify(pin, null, 2) + '\n');
  return pkgDir;
}

// 同梱の監査済み版(pin)の tag_name を書き換える(コピーのみ。作業ツリーは変えない)
function setPinTag(pkgDir, tag) {
  const pinPath = path.join(pkgDir, 'config', 'agy-verified-versions.json');
  const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  pin.tag_name = tag;
  fs.writeFileSync(pinPath, JSON.stringify(pin, null, 2) + '\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// テストごとの隔離環境。標準レイアウトのパッケージを version で置き、同梱 pin も同じ版に揃える
// (self-check の version 一致のため。監査済み版は別経路で取得するので影響しない)
function setup(name, version) {
  const dir = newDir(name);
  const prefix = path.join(dir, 'prefix');
  const pkgDir = makePackage(stdPackageDir(prefix), version);
  setPinTag(pkgDir, version);
  const agyLink = path.join(prefix, 'bin', 'agy');
  fs.mkdirSync(path.dirname(agyLink), { recursive: true });
  fs.symlinkSync(path.join(pkgDir, 'bin', 'agy.js'), agyLink);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const realPrefix = fs.realpathSync(prefix);
  makeFakeLoader(realPrefix);
  writeConsent(home, { download: true, compat: true });
  const fakeBin = makeFakeNpm(dir);
  return {
    dir,
    prefix: realPrefix,
    agy: path.join(pkgDir, 'bin', 'agy.js'),
    agyLink: path.join(realPrefix, 'bin', 'agy'),
    home,
    fakeBin,
    npmLog: path.join(dir, 'npm.log'),
    mockLog: path.join(dir, 'https.log'),
  };
}

// 実 bin/agy.js を子プロセスで起動する。env は最小(親の AGY_* 環境変数は引き継がない)
function runAgy(sb, args, env = {}, agy = sb.agy) {
  const r = spawnSync(process.execPath, [agy, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      PATH: `${sb.fakeBin}:${process.env.PATH}`,
      HOME: sb.home,
      PREFIX: sb.prefix,
      NPM_LOG: sb.npmLog,
      MOCK_HTTPS_LOG: sb.mockLog,
      // 偽の VA 幅を固定し、キャッシュ名を agy-<tag>.bin に決める(実機の差に依存しない)
      MOCK_VA_BITS: '48',
      // NODE_OPTIONS で mock を読み込み、孫プロセス(run-sync-child)にも効かせる
      NODE_OPTIONS: (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '') + '--require ' + MOCK,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ログ(1行1件)を読む。ファイルが無ければ空配列
function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

// 新しい版のバイナリを検証済みキャッシュとして置く(バイナリ取得を省くため)
function seedCache(sb, version) {
  const bin = makeBinary(path.join(sb.dir, 'bin-src-' + version), version);
  const cacheDir = path.join(sb.home, '.agy-termux');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.copyFileSync(bin.binPath, path.join(cacheDir, 'agy-' + version + '.bin'));
}

// 出力の一時ディレクトリ部分を固定語に置き換え、行の配列にする(末尾の空行は除く)
function lines(text, sb) {
  return text.split(sb.prefix).join('<PREFIX>').split('\n').filter((l) => l !== '');
}

// npm install が呼ばれた回数
function installCount(sb) {
  return readLog(sb.npmLog).filter((line) => line.startsWith('install ')).length;
}

// 配置後の状態の確認: 版・bin link・self-check
function assertPlacedVersion(sb, version) {
  const pkgDir = stdPackageDir(sb.prefix);
  assert.equal(readJson(path.join(pkgDir, 'package.json')).version, version);
  assert.equal(
    fs.realpathSync(sb.agyLink),
    fs.realpathSync(path.join(pkgDir, 'bin', 'agy.js')),
    'bin link が配置先を指していません',
  );
  const sc = spawnSync(process.execPath, [sb.agyLink, '--self-check'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(sc.status, 0, `self-check 失敗: ${sc.stderr}`);
}

// 新しい版の完全な配置を作る。version と pin の tag_name の両方を aud に揃え、必要ファイルと ELF を確かめる
function makeCompleteNewPackage(sb, version) {
  const pkgDir = makePackage(path.join(sb.dir, 'new-pkg-' + version), version);
  setPinTag(pkgDir, version);
  assert.equal(readJson(path.join(pkgDir, 'package.json')).version, version);
  assert.equal(readJson(path.join(pkgDir, 'config', 'agy-verified-versions.json')).tag_name, version);
  for (const rel of REQUIRED_FILES) {
    assert.ok(fs.existsSync(path.join(pkgDir, rel)), `新しい版の fixture に ${rel} がありません`);
  }
  const head = fs.readFileSync(path.join(pkgDir, 'lib', 'native', 'sigsys_shim.so')).subarray(0, 4);
  assert.deepEqual(head, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'sigsys_shim.so が ELF ではありません');
  return pkgDir;
}

// 偽 npm が実際に使われることを確かめるガード(テスト開始時に1回だけ実行する)
function guardFakeNpm() {
  const dir = newDir('guard');
  const fakeBin = makeFakeNpm(dir);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const npmLog = path.join(dir, 'npm.log');
  const r = spawnSync('npm', ['view', 'x'], {
    encoding: 'utf8',
    timeout: 20000,
    shell: false,
    env: {
      PATH: fakeBin,
      HOME: home,
      NPM_LOG: npmLog,
    },
  });
  assert.ok(readLog(npmLog).includes('view x'), `偽 npm が使われていません(実 npm に解決された可能性): ${r.error ? r.error.message : ''}`);
}
before(guardFakeNpm);

// A1: 配置なしで install 失敗(exit 1)→ 元の版 1.2.14 のまま
test('A1) install 失敗(配置なし) → exit 1、元の版 1.2.14 のまま', () => {
  const sb = setup('a1', CUR);
  seedCache(sb, AUD);
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: AUD, MOCK_NPM_INSTALL_EXIT: '1' });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(lines(r.stdout, sb), []);
  assert.deepEqual(lines(r.stderr, sb), [
    '[agy] 監査済み版を確認中...',
    '[agy] 公開状況を確認中...',
    '[agy] 1.2.14 → 1.2.16 に更新します... (prefix: <PREFIX>)',
    '[agy] 更新に失敗しました(exit 1)。バージョンは 1.2.14 のままです。もう一度 agy update を実行してください',
  ]);
  assert.ok(!r.stderr.includes('パッケージが不完全です'));
  assert.ok(!r.stdout.includes('更新完了') && !r.stderr.includes('更新完了'));
  assert.ok(!r.stderr.includes('バイナリを取得します'));
  assertPlacedVersion(sb, CUR);
  assert.equal(installCount(sb), 1);
});

// A2: 配置後に失敗(fail_after_swap)→ 新しい版 1.2.16 を採用し、exit 0
test('A2) 配置後に install 失敗(fail_after_swap) → 新しい版 1.2.16 を採用、exit 0', () => {
  const sb = setup('a2', CUR);
  seedCache(sb, AUD);
  const newPkg = makeCompleteNewPackage(sb, AUD);
  const r = runAgy(sb, ['update'], {
    MOCK_HTTPS_MODE: 'ok',
    MOCK_NPM_VIEW: AUD,
    FAKE_NPM_SEQUENCE: 'fail_after_swap',
    FAKE_NPM_NEW_PKG: newPkg,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout, sb), ['[agy] 1.2.14 → 1.2.16 に更新しました']);
  assert.deepEqual(lines(r.stderr, sb), [
    '[agy] 監査済み版を確認中...',
    '[agy] 公開状況を確認中...',
    '[agy] 1.2.14 → 1.2.16 に更新します... (prefix: <PREFIX>)',
  ]);
  assert.ok(!r.stderr.includes('更新に失敗しました'));
  assert.ok(!r.stderr.includes('パッケージが不完全です'));
  assert.ok(!r.stdout.includes('更新完了') && !r.stderr.includes('更新完了'));
  assert.ok(!r.stderr.includes('バイナリを取得します'));
  assertPlacedVersion(sb, AUD);
  assert.equal(installCount(sb), 1);
});

// A3: 配置なしで ENOSPC(exit 1)→ 空き容量の表示、元の版 1.2.14 のまま
test('A3) ENOSPC(配置なし) → 空き容量不足を表示、exit 1、元の版 1.2.14 のまま', () => {
  const sb = setup('a3', CUR);
  seedCache(sb, AUD);
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: AUD, FAKE_NPM_SEQUENCE: 'enospc' });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(lines(r.stdout, sb), []);
  const out = lines(r.stderr, sb);
  // stderr は全行を完全一致で確認する。空き容量の N(MB) だけは環境で変わるため、失敗行のみ正規表現で確認する
  assert.equal(out.length, 6, r.stderr);
  assert.deepEqual(out.slice(0, 5), [
    '[agy] 監査済み版を確認中...',
    '[agy] 公開状況を確認中...',
    '[agy] 1.2.14 → 1.2.16 に更新します... (prefix: <PREFIX>)',
    'npm ERR! code ENOSPC',
    'npm ERR! nospc ENOSPC: no space left on device, write',
  ]);
  assert.match(
    out[5],
    /^\[agy\] 更新に失敗しました\(空き容量が足りません\(空き 約 \d+ MB\)\)。バージョンは 1\.2\.14 のままです。もう一度 agy update を実行してください$/,
  );
  assert.ok(!r.stderr.includes('パッケージが不完全です'));
  assert.ok(!r.stdout.includes('更新完了') && !r.stderr.includes('更新完了'));
  assert.ok(!r.stderr.includes('バイナリを取得します'));
  assertPlacedVersion(sb, CUR);
  assert.equal(installCount(sb), 1);
});
