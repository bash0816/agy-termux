// M14 自動復旧のテスト: agy update で npm install が失敗し、パッケージが不完全になった場合
// 偽 npm(test/helpers/wiring.js の makeFakeNpm)と実 bin/agy.js を使う。
// 配置の確認は実物の lib/install-state.js の checkPlacement と、agy.js の --self-check で行う。
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkPlacement } = require('../lib/install-state');
const { makeBinary, makeFakeLoader, makeFakeNpm, writeConsent } = require('./helpers/wiring');

const REPO = path.resolve(__dirname, '..');
const MOCK = path.join(__dirname, 'helpers', 'mock-https.js');
// 検証対象のパッケージに含める部分(test/ は含めない)
const PACKAGE_PARTS = ['bin', 'lib', 'config', 'package.json'];

// 一時ディレクトリ(テスト終了時に削除)。realpath にして、prefix の比較を実体で行う
function makeRoot() {
  let base;
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-npmfail-b-'));
  } catch {
    base = fs.mkdtempSync(path.join(process.env.TMPDIR, 'agy-npmfail-b-'));
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
  return pkgDir;
}

// 同梱の監査済み版 pin の tag_name を、そのパッケージの版に揃える(self-check の版一致のため)
function patchTag(pkgDir, tag) {
  const file = path.join(pkgDir, 'config', 'agy-verified-versions.json');
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  obj.tag_name = tag;
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// テストごとの隔離環境。標準レイアウトのパッケージを version で置く
function setup(name, version, { consent = true } = {}) {
  const dir = newDir(name);
  const prefix = path.join(dir, 'prefix');
  const pkgDir = makePackage(stdPackageDir(prefix), version);
  const agyLink = path.join(prefix, 'bin', 'agy');
  fs.mkdirSync(path.dirname(agyLink), { recursive: true });
  fs.symlinkSync(path.join(pkgDir, 'bin', 'agy.js'), agyLink);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const realPrefix = fs.realpathSync(prefix);
  makeFakeLoader(realPrefix);
  if (consent) writeConsent(home, { download: true, compat: true });
  return {
    dir,
    prefix: realPrefix,
    agy: path.join(pkgDir, 'bin', 'agy.js'),
    home,
    fakeBin: makeFakeNpm(dir),
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
      NPM_LOG: sb.npmLog,
      MOCK_HTTPS_LOG: sb.mockLog,
      MOCK_VA_BITS: '48',
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

// 版 1.2.14(元の版)と 1.2.16(監査済み版)の完全なフィクスチャ。
// 元の版は self-check が通るよう、同梱 pin の tag_name を 1.2.14 に揃える
let fixtureCache = null;
function fixtures() {
  if (!fixtureCache) {
    const dir = newDir('fixtures');
    const old = makePackage(path.join(dir, 'pkg-1.2.14'), '1.2.14');
    patchTag(old, '1.2.14');
    const cur = makePackage(path.join(dir, 'pkg-1.2.16'), '1.2.16');
    patchTag(cur, '1.2.16');
    fixtureCache = { old, cur };
  }
  return fixtureCache;
}

// 不完全な新版(fail_broken)→ 再導入(sequence の 2 回目)の共通手順を実行する
// installed は現在の版 1.2.14 を置いた状態から始まる
function runFailureCase(name, { sequence, brokenMode, extraEnv = {} }) {
  const sb = setup(name, '1.2.14');
  patchTag(stdPackageDir(sb.prefix), '1.2.14');
  seedCache(sb, '1.2.16');
  const fx = fixtures();
  const env = {
    MOCK_HTTPS_MODE: 'ok',
    MOCK_NPM_VIEW: '1.2.16',
    FAKE_NPM_SEQUENCE: sequence,
    FAKE_NPM_PKG_1_2_14: fx.old,
    FAKE_NPM_PKG_1_2_16: fx.cur,
    ...extraEnv,
  };
  if (brokenMode !== undefined) env.FAKE_NPM_BROKEN_MODE = brokenMode;
  const r = runAgy(sb, ['update'], env);
  const log = readLog(sb.npmLog);
  return { sb, r, log, installs: log.filter((line) => line.startsWith('install ')) };
}

// 出力を行に分ける(空行は除く)
function linesOf(text) {
  return text.split('\n').filter((line) => line !== '');
}

// expected の各要素(文字列または正規表現)が、actual の中で連続して並ぶことを確かめる
function assertConsecutive(actual, expected) {
  const matchesAt = (start) => expected.every((e, k) => {
    const line = actual[start + k];
    if (line === undefined) return false;
    return e instanceof RegExp ? e.test(line) : line === e;
  });
  const found = actual.some((_, i) => matchesAt(i));
  assert.ok(
    found,
    '連続した行が見つかりません:\n' + expected.map(String).join('\n') + '\n--- 実際の行 ---\n' + actual.join('\n'),
  );
}

// 更新成功を示す行や、バイナリ取得の表示が出ていないことを確かめる(キャッシュは置いてある)
function assertNoSuccessOrDownload(r) {
  const all = r.stdout + r.stderr;
  assert.ok(!all.includes('更新完了'), '「更新完了」が表示されています:\n' + all);
  assert.ok(!/取得します|ダウンロード/.test(all), 'バイナリ取得の表示があります:\n' + all);
}

// 元の版を入れ直したときに出る、最終行(バージョンは 1.2.14 のまま)
const KEEP_OLD_LINE = /^\[agy\] 更新に失敗しました\(.+\)。バージョンは 1\.2\.14 のままです。もう一度 agy update を実行してください$/;
const RECOVERY_LINE = '[agy] パッケージが不完全です。元の版 1.2.14 を入れ直します...';

// B1: 新版が不完全になり、元の版の入れ直しで復旧する → exit 1、バージョンは 1.2.14 のまま
test('B1 新版が不完全 → 元の版を入れ直して復旧 → exit 1、バージョンは 1.2.14 のまま', () => {
  const { sb, r, installs } = runFailureCase('b1', { sequence: 'fail_broken,swap', brokenMode: 'missing_file' });
  assert.equal(r.status, 1, r.stderr);
  assertConsecutive(linesOf(r.stderr), [RECOVERY_LINE, KEEP_OLD_LINE]);
  assert.deepEqual(installs, [
    'install -g --prefix ' + sb.prefix + ' @bash0816/agy-termux@1.2.16',
    'install -g --prefix ' + sb.prefix + ' @bash0816/agy-termux@1.2.14',
  ]);
  const pkgDir = stdPackageDir(sb.prefix);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, '1.2.14');
  // <prefix>/bin/agy が動き、self-check も通る
  const link = path.join(sb.prefix, 'bin', 'agy');
  const self = runAgy(sb, ['--self-check'], {}, link);
  assert.equal(self.status, 0, self.stderr);
  // 実物の配置確認でも、元の版が完全と判定される
  const placed = checkPlacement({ pkgDir, prefix: sb.prefix, expectedVersion: '1.2.14', nonce: 'b1nonce' });
  assert.equal(placed.complete, true, JSON.stringify(placed));
  assertNoSuccessOrDownload(r);
});

// B2: 壊れ方ごとに、不完全を検出して元の版を入れ直す
const BROKEN_MODES = ['no_link', 'truncated_config', 'truncated_shim', 'empty_bin', 'missing_file'];
for (const mode of BROKEN_MODES) {
  test(`B2 壊れ方 ${mode}: 不完全を検出して元の版を入れ直す`, () => {
    const { r, installs } = runFailureCase('b2-' + mode, { sequence: 'fail_broken,swap', brokenMode: mode });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('パッケージが不完全です'), r.stderr);
    assertConsecutive(linesOf(r.stderr), [RECOVERY_LINE, KEEP_OLD_LINE]);
    assert.equal(installs.length, 2, JSON.stringify(installs));
    assertNoSuccessOrDownload(r);
  });
}

// B3: 元の版の入れ直しも失敗する → 手動の再導入コマンドを表示して exit 1
test('B3 入れ直しも失敗 → 次のコマンドを表示して exit 1', () => {
  const { sb, r, installs } = runFailureCase('b3', { sequence: 'fail_broken,fail_broken', brokenMode: 'missing_file' });
  assert.equal(r.status, 1, r.stderr);
  assertConsecutive(linesOf(r.stderr), [
    /次のコマンドを実行してください:$/,
    '  npm install -g --prefix ' + sb.prefix + ' @bash0816/agy-termux@1.2.14',
  ]);
  assert.equal(installs.length, 2, JSON.stringify(installs));
  assertNoSuccessOrDownload(r);
});

// B4: 入れ直しが容量不足で失敗する → 空き容量の案内を表示して exit 1
test('B4 入れ直しが ENOSPC で失敗 → 空き容量の案内を表示して exit 1', () => {
  const { sb, r, installs } = runFailureCase('b4', { sequence: 'fail_broken,enospc', brokenMode: 'missing_file' });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('空き容量が足りません'), r.stderr);
  assert.ok(r.stderr.includes('空きを作ってから'), r.stderr);
  assertConsecutive(linesOf(r.stderr), [
    /次のコマンドを実行してください:$/,
    '  npm install -g --prefix ' + sb.prefix + ' @bash0816/agy-termux@1.2.14',
  ]);
  assert.equal(installs.length, 2, JSON.stringify(installs));
  assertNoSuccessOrDownload(r);
});
