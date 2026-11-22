'use strict';

// 配線テスト: 実物の bin/agy.js を子プロセスで起動し、update 系の入口から出口までを確かめる
// 通信は test/helpers/mock-https.js(--require で読み込む偽物)に置き換え、npm は一時ディレクトリの偽 npm を使う
// 実ネットワーク・実 npm・実 HOME には触れない

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { DEFAULT_URL } = require('../lib/audited-update');
const { makeBinary, makeFakeLoader, makeFakeNpm, writeConsent, writePin } = require('./helpers/wiring');

const REPO = path.resolve(__dirname, '..');
const MOCK = path.join(__dirname, 'helpers', 'mock-https.js');
// 検証対象のパッケージに含める部分(test/ は含めない)
const PACKAGE_PARTS = ['bin', 'lib', 'config', 'package.json'];
// 検証済みバイナリの取得先(bin-sync.test.js と同じ値)
const TARBALL_URL = 'https://mock.test/agy_cli_linux_arm64.tar.gz';

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

// 偽 npm は配線ヘルパーの makeFakeNpm を使う(<dir>/fakebin/npm を作り、fakebin のパスを返す)
function makeFakeBin(dir) {
  return makeFakeNpm(dir);
}

// テストごとの隔離環境。標準レイアウトのパッケージを version で置く
// consent: false のときは同意ファイルを置かない(非 TTY の update で同意待ちに入る状態を作る)
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
    fakeBin: makeFakeBin(dir),
    npmLog: path.join(dir, 'npm.log'),
    mockLog: path.join(dir, 'https.log'),
  };
}

// 実 bin/agy.js を子プロセスで起動する。env は最小(親の AGY_* 環境変数は引き継がない)
// input を渡すと標準入力に流す(同意の入力 'n' などを与えるため)。省略時は標準入力を空にする
function runAgy(sb, args, env = {}, agy = sb.agy, input = undefined) {
  const r = spawnSync(process.execPath, [agy, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    ...(input === undefined ? {} : { input }),
    env: {
      PATH: `${sb.fakeBin}:${process.env.PATH}`,
      HOME: sb.home,
      PREFIX: sb.prefix,
      NPM_LOG: sb.npmLog,
      MOCK_HTTPS_LOG: sb.mockLog,
      // 偽の VA 幅を固定し、キャッシュ名を agy-<tag>.bin に決める(実機の差に依存しない)
      MOCK_VA_BITS: '48',
      // NODE_OPTIONS で mock を読み込み、孫プロセス(run-sync-child)にも効かせる。
      // mock-https.js は二重読み込みを防いでいないため、argv の --require とは併用しない
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

// 新しい版のバイナリを検証済みキャッシュとして置く(更新成功の経路でバイナリ取得を省くため)
function seedCache(sb, version) {
  const bin = makeBinary(path.join(sb.dir, 'bin-src-' + version), version);
  const cacheDir = path.join(sb.home, '.agy-termux');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.copyFileSync(bin.binPath, path.join(cacheDir, 'agy-' + version + '.bin'));
}

// npm install が呼ばれたかどうか
function hasInstall(log) {
  return log.some((line) => line.startsWith('install '));
}

// 偽 npm が実際に使われることを確かめるガード(テスト開始時に1回だけ実行する)
// 偽 npm が起動できず PATH の次の候補(実 npm)に落ちた場合は、ここで失敗してテストを止める
function guardFakeNpm() {
  const dir = newDir('guard');
  const fakeBin = makeFakeBin(dir);
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

// W1 エイリアス: 3つの入口はいずれも同じ判定になる(監査済み版と同じなら npm は呼ばない)
for (const alias of ['update', '--update', 'upgrade']) {
  test(`W1 エイリアス ${alias}: 監査済み版と同じなら何もしない`, () => {
    const sb = setup('w1-' + alias.replace(/^-+/, ''), '1.2.16');
    seedCache(sb, '1.2.16');
    const r = runAgy(sb, [alias], { MOCK_HTTPS_MODE: 'ok' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Already on latest audited version: 1\.2\.16/);
    assert.deepEqual(readLog(sb.npmLog), []);
    assert.deepEqual(readLog(sb.mockLog), ['GET ' + DEFAULT_URL]);
  });
}

// W2 終了コード: 通信失敗・npm 失敗・更新成功・不一致の各ケース
test('W2 a) HTTP 500 → exit 1、npm は呼ばない', () => {
  const sb = setup('w2-500', '1.2.14');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'http500', MOCK_NPM_VIEW: '1.2.16' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /監査済み版の確認に失敗しました/);
  assert.deepEqual(readLog(sb.npmLog), []);
});

for (const mode of ['abort', 'reserr', 'badjson']) {
  test(`W2 b) 通信の失敗(${mode}) → exit 1、npm は呼ばない`, () => {
    const sb = setup('w2-' + mode, '1.2.14');
    const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: mode, MOCK_NPM_VIEW: '1.2.16' });
    assert.equal(r.status, 1);
    assert.deepEqual(readLog(sb.npmLog), []);
  });
}

test('W2 c) 更新成功 → exit 0、更新完了', () => {
  const sb = setup('w2-ok', '1.2.14');
  seedCache(sb, '1.2.16');
  const newPkg = makePackage(path.join(sb.dir, 'new-pkg'), '1.2.16');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.16', MOCK_NPM_INSTALL_EXIT: '0', FAKE_NPM_NEW_PKG: newPkg });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readLog(sb.mockLog), ['GET ' + DEFAULT_URL]);
  assert.match(r.stdout, /1\.2\.14 → 1\.2\.16 に更新しました/);
});

test('W2 d) install 失敗 → exit 1、前のバージョンへの戻し方を表示', () => {
  const sb = setup('w2-install-fail', '1.2.14');
  // 導入済みの 1.2.14 パッケージの同梱 pin も 1.2.14 に揃える(self-check の version 一致。監査済み版は別経路で取得するため影響しない)
  const installedPinPath = path.join(stdPackageDir(sb.prefix), 'config', 'agy-verified-versions.json');
  const installedPin = JSON.parse(fs.readFileSync(installedPinPath, 'utf8'));
  installedPin.tag_name = '1.2.14';
  fs.writeFileSync(installedPinPath, JSON.stringify(installedPin, null, 2) + '\n');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.16', MOCK_NPM_INSTALL_EXIT: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /バージョンは 1\.2\.14 のままです/);
});

test('W2 e) npm の latest が監査済み版と不一致 → exit 0、更新しない', () => {
  const sb = setup('w2-mismatch', '1.2.14');
  seedCache(sb, '1.2.14');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.14' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readLog(sb.mockLog), ['GET ' + DEFAULT_URL]);
  assert.match(r.stdout, /更新を見送りました/);
  assert.deepEqual(readLog(sb.npmLog), ['view @bash0816/agy-termux@latest version']);
});

test('W2 f) npm view が失敗 → exit 1、install はしない', () => {
  const sb = setup('w2-view-fail', '1.2.14');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW_EXIT: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /registry の確認に失敗しました/);
  assert.equal(hasInstall(readLog(sb.npmLog)), false);
});

test('W2 f) npm view の出力が不正 → exit 1、install はしない', () => {
  const sb = setup('w2-view-bad', '1.2.14');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: 'abc' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /registry の確認に失敗しました/);
  assert.equal(hasInstall(readLog(sb.npmLog)), false);
});

// W3 URL 上書き: 有効な https の URL は取得先になり、不正な値は取得に到達させない
test('W3 AGY_TERMUX_VERIFIED_URL で取得先を上書きできる', () => {
  const sb = setup('w3-ok', '1.2.16');
  seedCache(sb, '1.2.16');
  const url = 'https://example.test/custom.json';
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', AGY_TERMUX_VERIFIED_URL: url });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readLog(sb.mockLog), ['GET ' + url]);
});

for (const bad of ['http://example.test/x', '', 'not a url']) {
  test(`W3 不正な URL "${bad}" は取得に到達しない`, () => {
    const sb = setup('w3-bad', '1.2.16');
    const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', AGY_TERMUX_VERIFIED_URL: bad });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /AGY_TERMUX_VERIFIED_URL が不正/);
    assert.deepEqual(readLog(sb.mockLog), []);
  });
}

// W4 npm 呼び出し: 版固定で、@latest の install はしない
test('W4 npm は view と版固定の install を1回ずつ呼ぶ', () => {
  const sb = setup('w4', '1.2.14');
  seedCache(sb, '1.2.16');
  const newPkg = makePackage(path.join(sb.dir, 'new-pkg'), '1.2.16');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.16', MOCK_NPM_INSTALL_EXIT: '0', FAKE_NPM_NEW_PKG: newPkg });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readLog(sb.mockLog), ['GET ' + DEFAULT_URL]);
  assert.deepEqual(readLog(sb.npmLog), [
    'view @bash0816/agy-termux@latest version',
    'install -g --prefix ' + sb.prefix + ' @bash0816/agy-termux@1.2.16',
  ]);
});

// W5 symlink と prefix: 実体側の prefix を使い、推定できない場合は中止する
test('W5 a) symlink 経由で起動しても、--prefix は実体側の prefix', () => {
  const sb = setup('w5a', '1.2.14');
  seedCache(sb, '1.2.16');
  const linkDir = path.join(sb.dir, 'link');
  fs.mkdirSync(linkDir);
  const link = path.join(linkDir, 'agy.js');
  fs.symlinkSync(sb.agy, link);
  const newPkg = makePackage(path.join(sb.dir, 'new-pkg'), '1.2.16');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.16', MOCK_NPM_INSTALL_EXIT: '0', FAKE_NPM_NEW_PKG: newPkg }, link);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readLog(sb.mockLog), ['GET ' + DEFAULT_URL]);
  assert.deepEqual(readLog(sb.npmLog), [
    'view @bash0816/agy-termux@latest version',
    'install -g --prefix ' + sb.prefix + ' @bash0816/agy-termux@1.2.16',
  ]);
});

test('W5 b) 標準外のレイアウトでは prefix を推定できず、更新を中止する', () => {
  const sb = setup('w5b', '1.2.14');
  const weird = makePackage(path.join(sb.dir, 'weird', 'agy-termux'), '1.2.14');
  const r = runAgy(
    sb,
    ['update'],
    { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.16', MOCK_NPM_INSTALL_EXIT: '0' },
    path.join(weird, 'bin', 'agy.js'),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /自身の実際のインストール位置を検出できませんでした/);
  assert.match(r.stderr, /@bash0816\/agy-termux@1\.2\.16/);
  assert.equal(hasInstall(readLog(sb.npmLog)), false);
});

// W6 --version: 通信も HOME への書き込みも行わない
test('W6 --version は副作用ゼロ', () => {
  const sb = setup('w6', '1.2.16', { consent: false });
  const r = runAgy(sb, ['--version'], { MOCK_HTTPS_MODE: 'tripwire' });
  // 未取得・同意なし・非TTY: 表示文字列は出さず、終了コード 1
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.deepEqual(fs.readdirSync(sb.home), []);
  assert.deepEqual(readLog(sb.mockLog), []);
  assert.deepEqual(readLog(sb.npmLog), []);
});

// W7 通常の update でも、不要な書き込み(~/.agy-termux の作成)をしない
test('W7 update は隔離 HOME に .agy-termux を作らない', () => {
  // 同意ファイルなし。今の版は監査済み版と同じ(更新なし)でも、キャッシュが無ければ同期に進み、同意の確認で止まる(exit 1)。
  // 同意の確認より前に取得は行われず、~/.agy-termux も作られない
  const sb = setup('w7', '1.2.16', { consent: false });
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /同意の入力がありません/);
  assert.equal(readLog(sb.mockLog).some((l) => l.includes('agy_cli_linux_arm64')), false);
  assert.equal(fs.existsSync(path.join(sb.home, '.agy-termux')), false);
});

// 版の変更なし(監査済み版 = 今の版)の update 用。sha 付きの実物の pin と検証済みバイナリを置く
// 経路ごとの応答は MOCK_ROUTES で与える(監査済み版の確認 DEFAULT_URL と取得先 TARBALL_URL)
function setupPinned(name, version, { consent = true } = {}) {
  const sb = setup(name, version, { consent });
  const bin = makeBinary(path.join(sb.dir, 'bin-src-' + version), version);
  writePin(stdPackageDir(sb.prefix), {
    version,
    tagName: version,
    url: TARBALL_URL,
    sha256Tar: bin.sha256Tar,
    sha256Binary: bin.sha256Binary,
  });
  sb.routes = path.join(sb.dir, 'routes.json');
  sb.tarPath = bin.tarPath;
  sb.binPath = bin.binPath;
  sb.cacheFile = path.join(sb.home, '.agy-termux', 'agy-' + version + '.bin');
  return sb;
}

// 監査済み版(監査用の版 tag)と取得先の応答を MOCK_ROUTES に書く
function writeRoutes(sb, version, tarballRoute) {
  const routes = {
    [DEFAULT_URL]: { kind: 'body', body: JSON.stringify({ tag_name: version }) },
    [TARBALL_URL]: tarballRoute,
  };
  fs.writeFileSync(sb.routes, JSON.stringify(routes, null, 2));
}

// url への GET の回数
function getsOf(sb, url) {
  return readLog(sb.mockLog).filter((l) => l === 'GET ' + url).length;
}

// 版の変更なし・キャッシュ ok: 同意を聞かず、通信は監査済み版の確認だけ、終了コード 0(FORCE_LATEST=1 でも同じ)
for (const force of [false, true]) {
  test(`update 版の変更なし・キャッシュ ok は同意なし・取得なしで exit 0${force ? '(AGY_TERMUX_FORCE_LATEST=1)' : ''}`, () => {
    const sb = setupPinned(force ? 'u-ok-force' : 'u-ok', '1.2.16');
    writeRoutes(sb, '1.2.16', { kind: 'file', file: sb.tarPath });
    fs.mkdirSync(path.dirname(sb.cacheFile), { recursive: true });
    fs.copyFileSync(sb.binPath, sb.cacheFile);
    const env = { MOCK_ROUTES: sb.routes, ...(force ? { AGY_TERMUX_FORCE_LATEST: '1' } : {}) };
    const r = runAgy(sb, ['update'], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /同意/);
    assert.deepEqual(readLog(sb.mockLog), ['GET ' + DEFAULT_URL]);
  });
}

// 版の変更なし・キャッシュなし: 同意があれば取得して exit 0
test('update 版の変更なし・キャッシュなしは同意のうえ取得し exit 0', () => {
  const sb = setupPinned('u-missing', '1.2.16');
  writeRoutes(sb, '1.2.16', { kind: 'file', file: sb.tarPath });
  const r = runAgy(sb, ['update'], { MOCK_ROUTES: sb.routes });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(getsOf(sb, TARBALL_URL), 1);
  assert.equal(fs.existsSync(sb.cacheFile), true);
});

// 同意の質問は stdin が TTY のときだけ行われる(lib/consent.js)。子プロセスの起動前に isTTY を立て、
// 標準入力の 'n' を回答として読ませる(fetch-consent-wiring.test.js の FAKE_TTY と同じ考え方)。
// data: URL の --import で読ませるので、テスト用の追加ファイルは作らない
const TTY_SHIM = 'data:text/javascript,Object.defineProperty(process.stdin,%27isTTY%27,{value:true})';

// 版の変更なし・キャッシュなし・同意を拒否(標準入力 'n'): 取得せず exit 1
test('update 版の変更なし・キャッシュなしで同意を拒否すると exit 1、取得しない', () => {
  const sb = setupPinned('u-refuse', '1.2.16', { consent: false });
  writeRoutes(sb, '1.2.16', { kind: 'file', file: sb.tarPath });
  const nodeOptions = '--require ' + MOCK + ' --import ' + TTY_SHIM;
  const r = runAgy(sb, ['update'], { MOCK_ROUTES: sb.routes, NODE_OPTIONS: nodeOptions }, sb.agy, 'n\n');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /同意されなかった/);
  assert.equal(getsOf(sb, TARBALL_URL), 0);
  assert.equal(fs.existsSync(sb.cacheFile), false);
});

// 版の変更なし・キャッシュなし・取得に失敗(HTTP 500): exit 1、キャッシュは作らない
test('update 版の変更なし・キャッシュなしで取得に失敗すると exit 1、キャッシュを作らない', () => {
  const sb = setupPinned('u-fetchfail', '1.2.16');
  writeRoutes(sb, '1.2.16', { kind: 'error', status: 500 });
  const r = runAgy(sb, ['update'], { MOCK_ROUTES: sb.routes });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(fs.existsSync(sb.cacheFile), false);
});

// --version の注記(キャッシュ状態を標準エラーに 1 行)。bin-sync.test.js の VA39 キャッシュ準備(writeValidVa39Expectation /
// writeFakeVa39Cache)を複製している(ヘルパーはファイル間で共有しない)。pin の期待値を VA39 用に書き、同名のキャッシュ先に偽ファイルを置く
const VERSION_VA39_SIZE = 10 * 1024 * 1024 + 4096;
function prepareVa39Cache(sb, tag, size = VERSION_VA39_SIZE) {
  const { cachePaths } = require('../lib/binary-cache');
  const pkgDir = path.resolve(path.dirname(sb.agy), '..');
  const pinPath = path.join(pkgDir, 'config', 'agy-verified-versions.json');
  const cfg = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  cfg.va39_patched_size = VERSION_VA39_SIZE;
  cfg.va39_patch_breakdown = [
    { kind: 'main', offset: 0, size: VERSION_VA39_SIZE, counts: { ...cfg.va39_patch_counts } },
  ];
  fs.writeFileSync(pinPath, JSON.stringify(cfg, null, 2) + '\n');
  const cacheDir = path.join(sb.home, '.agy-termux');
  const file = cachePaths({ dir: cacheDir, tag, isPatch: true, unverified: false }).file;
  fs.mkdirSync(cacheDir, { recursive: true });
  const buf = Buffer.alloc(size);
  buf[0] = 0x7f;
  buf.write('ELF', 1, 'latin1');
  fs.writeFileSync(file, buf);
  return file;
}

// 標準エラーがちょうど 1 行で、期待する文字列を含むことを確かめる
function assertOneErrorLine(stderr, expected) {
  const lines = stderr.trimEnd().split('\n');
  assert.equal(lines.length, 1, stderr);
  assert.ok(lines[0].includes(expected), stderr);
}

// --version の別名(4 つ)
const VERSION_ALIASES = ['--version', '-v', '-V', 'version'];

test('--version: 未取得・同意なし非TTYは stdout 空で終了コード 1', () => {
  VERSION_ALIASES.forEach((alias, i) => {
    const sb = setup(`u5a-${i}`, '1.2.16', { consent: false });
    const r = runAgy(sb, [alias], { MOCK_HTTPS_MODE: 'tripwire' });
    assert.equal(r.status, 1, `${alias}: ${r.stderr}`);
    assert.equal(r.stdout, '', alias);
    assert.match(r.stderr, /同意/, alias);
    // 通信は 0 回、隔離 HOME には何も作らない
    assert.deepEqual(readLog(sb.mockLog), [], alias);
    assert.deepEqual(readLog(sb.npmLog), [], alias);
    assert.deepEqual(fs.readdirSync(sb.home), [], alias);
  });
});

test('--version: 取得済みは同意なしで本体を実行し本体の出力を返す', () => {
  const sb = setup('u5b', '1.2.16', { consent: false });
  const file = prepareVa39Cache(sb, '1.2.16');
  const r = runAgy(sb, ['--version'], { MOCK_VA_BITS: '39', MOCK_HTTPS_MODE: 'tripwire' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  // 有効キャッシュなので本体(フェイクローダ)を実行する。偽キャッシュには AGYVER が無いため version=unknown
  assert.equal(r.stdout, `LOADER_RAN version=unknown path=${file}\n`);
  assert.deepEqual(readLog(sb.mockLog), []);
});

test('--version: 壊れたキャッシュは同意なし非TTYで stdout 空・終了コード 1', () => {
  const sb = setup('u5c', '1.2.16', { consent: false });
  // 期待サイズ(10MiB 超)より小さい偽ファイルを置く
  prepareVa39Cache(sb, '1.2.16', 1024);
  const r = runAgy(sb, ['--version'], { MOCK_VA_BITS: '39', MOCK_HTTPS_MODE: 'tripwire' });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /同意/);
  assert.deepEqual(readLog(sb.mockLog), []);
});

test('--version: FORCE_LATEST=1 は同意が先に求められる', () => {
  const sb = setup('u5d', '1.2.16', { consent: false });
  const r = runAgy(sb, ['--version'], { AGY_TERMUX_FORCE_LATEST: '1', MOCK_HTTPS_MODE: 'tripwire' });
  // 同意ゲートを先に通すため、同意なし・非TTYでは FORCE_LATEST の案内に進まず終了する
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /同意/);
  assert.doesNotMatch(r.stderr, /AGY_TERMUX_FORCE_LATEST/);
  assert.deepEqual(readLog(sb.mockLog), []);
});

// 本体の代わりに動かす偽ローダを、テスト内で差し替える(wiring.js の makeFakeLoader は argv を出さないため)。
// agy は <prefix>/glibc/lib/ld-linux-aarch64.so.1 を --library-path <lib> <本体> <引数...> で起動するので、
// 先頭 3 つ(--library-path, <lib>, <本体>)の後ろが本体への引数になる
function installBodyLoader(sb, body) {
  const loader = path.join(sb.prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
  fs.writeFileSync(loader, '#!' + process.execPath + '\n' + body);
  fs.chmodSync(loader, 0o755);
  return loader;
}

// 本体が受け取った引数を stdout に 1 行で出す偽本体
const ECHO_ARGV_BODY = `
const i = process.argv.indexOf('--library-path');
process.stdout.write('ARGV ' + JSON.stringify(process.argv.slice(i + 3)) + '\\n');
`;

test('--version: 4 つの別名はすべて --version に書き換えて本体へ渡す', () => {
  VERSION_ALIASES.forEach((alias, i) => {
    const sb = setup(`u5f-alias-${i}`, '1.2.16', { consent: false });
    prepareVa39Cache(sb, '1.2.16');
    installBodyLoader(sb, ECHO_ARGV_BODY);
    const r = runAgy(sb, [alias], { MOCK_VA_BITS: '39', MOCK_HTTPS_MODE: 'tripwire' });
    assert.equal(r.status, 0, `${alias}: ${r.stderr}`);
    assert.equal(r.stdout, 'ARGV ' + JSON.stringify(['--version']) + '\n', alias);
  });
});

test('--version: 先頭以外の --version は書き換えず、先頭の --version の後ろ引数は本体に残す', () => {
  // agy foo --version / agy update --version: 先頭が版表示の別名ではないので、本体を --version 単独で呼ばない
  ['foo', 'update'].forEach((first) => {
    const sb = setup(`u5g-neg-${first}`, '1.2.16', { consent: false });
    prepareVa39Cache(sb, '1.2.16');
    installBodyLoader(sb, ECHO_ARGV_BODY);
    const r = runAgy(sb, [first, '--version'], { MOCK_VA_BITS: '39', MOCK_HTTPS_MODE: 'tripwire' });
    assert.doesNotMatch(r.stdout, /ARGV \["--version"\]/, `${first}: ${r.stdout}${r.stderr}`);
  });

  // agy --version --extra: 書き換えるのは先頭だけなので、--extra は本体の argv に残る
  const sb = setup('u5g-extra', '1.2.16', { consent: false });
  prepareVa39Cache(sb, '1.2.16');
  installBodyLoader(sb, ECHO_ARGV_BODY);
  const r = runAgy(sb, ['--version', '--extra'], { MOCK_VA_BITS: '39', MOCK_HTTPS_MODE: 'tripwire' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ARGV ' + JSON.stringify(['--version', '--extra']) + '\n');
});

test('--version: 本体が終了コード 7 で終わると agy も 7 で終わり、stdout は本体の出力だけ', () => {
  const sb = setup('u5h-exit7', '1.2.16', { consent: false });
  prepareVa39Cache(sb, '1.2.16');
  installBodyLoader(sb, "process.stdout.write('BODY_OUT\\n');\nprocess.exitCode = 7;\n");
  const r = runAgy(sb, ['--version'], { MOCK_VA_BITS: '39', MOCK_HTTPS_MODE: 'tripwire' });
  assert.equal(r.status, 7, r.stderr);
  assert.equal(r.stdout, 'BODY_OUT\n');
});

test('--version: 本体が SIGTERM で終わる・起動に失敗する場合は終了コードが非 0', (t) => {
  // 本体がシグナルで終わる場合: agy は process.exit(r.signal ? 1 : ...) で終わる
  const sbSig = setup('u5i-signal', '1.2.16', { consent: false });
  prepareVa39Cache(sbSig, '1.2.16');
  installBodyLoader(sbSig, "process.kill(process.pid, 'SIGTERM');\n");
  const rSig = runAgy(sbSig, ['--version'], { MOCK_VA_BITS: '39', MOCK_HTTPS_MODE: 'tripwire' });
  t.diagnostic(`measured signal: status=${rSig.status} stdout=${JSON.stringify(rSig.stdout)} stderr=${JSON.stringify(rSig.stderr)}`);
  assert.notEqual(rSig.status, 0, rSig.stderr);

  // 起動に失敗する場合: 実行権を外した偽ローダを起動すると spawn が失敗する
  const sbSpawn = setup('u5i-spawn', '1.2.16', { consent: false });
  prepareVa39Cache(sbSpawn, '1.2.16');
  const loader = installBodyLoader(sbSpawn, ECHO_ARGV_BODY);
  fs.chmodSync(loader, 0o644);
  const rSpawn = runAgy(sbSpawn, ['--version'], { MOCK_VA_BITS: '39', MOCK_HTTPS_MODE: 'tripwire' });
  t.diagnostic(`measured spawn-fail: status=${rSpawn.status} stdout=${JSON.stringify(rSpawn.stdout)} stderr=${JSON.stringify(rSpawn.stderr)}`);
  assert.notEqual(rSpawn.status, 0, rSpawn.stderr);
});

test('--version: 取得済みキャッシュでも同意がなければ通信・npm を行わない', () => {
  const sb = setup('u5j-noconsent', '1.2.16', { consent: false });
  prepareVa39Cache(sb, '1.2.16');
  const r = runAgy(sb, ['--version'], { MOCK_VA_BITS: '39', MOCK_HTTPS_MODE: 'tripwire' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readLog(sb.mockLog), []);
  assert.deepEqual(readLog(sb.npmLog), []);
});
