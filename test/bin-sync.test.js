'use strict';

// 起動(launch)の配線スモークテスト。実物の bin/agy.js を子プロセスで起動し、
// キャッシュの miss / hit / 旧形式の不整合 / AGY_TERMUX_REFRESH / 取得失敗の挙動を確認する
// 通信は test/helpers/mock-https.js で偽物にし、実ネットワークには触れない

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const h = require('./helpers/wiring');
const { DEFAULT_URL } = require('../lib/audited-update');

const TARBALL_URL = 'https://mock.test/agy_cli_linux_arm64.tar.gz';
// 偽バイナリの大きさ(下限 10MiB を満たす)
const BIN_SIZE = 10 * 1024 * 1024 + 4096;

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// MOCK_ROUTES の JSON に url への応答を書く(既存の応答は残す)。既定の url は tarball
function setRoute(routesFile, route, url = TARBALL_URL) {
  const routes = fs.existsSync(routesFile) ? JSON.parse(fs.readFileSync(routesFile, 'utf8')) : {};
  routes[url] = route;
  fs.writeFileSync(routesFile, JSON.stringify(routes, null, 2));
}

// 監査済み版(DEFAULT_URL)の応答として tag_name を書く
function setAuditedRoute(routesFile, version) {
  setRoute(routesFile, { kind: 'body', body: JSON.stringify({ tag_name: version }) }, DEFAULT_URL);
}

// テストごとに独立した一時ディレクトリを作り、pinVersion の偽 tarball を持つ package を配置する
// url は pin の download_url(既定は TARBALL_URL)
function setup(name, { pkgVersion, pinVersion, url = TARBALL_URL }) {
  const root = h.makeRoot();
  roots.push(root);
  const dir = h.newDir(root, name);
  const prefix = path.join(dir, 'prefix');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });

  const pkgDir = h.stdPackageDir(prefix);
  h.makePackageFromWorktree(pkgDir);
  const bin = h.makeBinary(path.join(dir, 'bin-src'), pinVersion);
  h.writePin(pkgDir, {
    version: pkgVersion,
    tagName: pinVersion,
    url,
    sha256Tar: bin.sha256Tar,
    sha256Binary: bin.sha256Binary,
  });
  h.makeFakeLoader(prefix);
  h.writeConsent(home, { download: true, compat: true });

  const routes = path.join(dir, 'routes.json');
  setRoute(routes, { kind: 'file', file: bin.tarPath }, url);

  return {
    dir,
    agy: path.join(pkgDir, 'bin', 'agy.js'),
    home,
    prefix,
    fakeBin: h.makeFakeNpm(dir),
    npmLog: path.join(dir, 'npm.log'),
    mockLog: path.join(dir, 'https.log'),
    loaderLog: path.join(dir, 'loader.log'),
    pkgDir,
    routes,
    cacheDir: path.join(home, '.agy-termux'),
  };
}

// agy を引数なしで起動する(launch 経路)。MOCK_ROUTES は常に渡す
function launch(sb, env = {}) {
  return h.runAgy(sb, [], { MOCK_ROUTES: sb.routes, ...env });
}

// agy update を起動する。MOCK_ROUTES は常に渡す
function update(sb, env = {}) {
  return h.runAgy(sb, ['update'], { MOCK_ROUTES: sb.routes, ...env });
}

// url の GET が何回呼ばれたか(既定は tarball)
function countGets(sb, url = TARBALL_URL) {
  return h.readLog(sb.mockLog).filter((l) => l === 'GET ' + url).length;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 旧形式のキャッシュ(.bin)用の偽バイナリ。AGYVER の版だけが違う
function legacyBinary(version) {
  const buf = Buffer.alloc(BIN_SIZE);
  buf[0] = 0x7f;
  buf.write('ELF', 1, 'latin1');
  buf.write(`AGYVER:${version}\n`, 4, 'ascii');
  return buf;
}

test('L1 launch miss: キャッシュが無ければ取得してから loader を起動する', () => {
  const sb = setup('l1', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  const r = launch(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LOADER_RAN version=1\.3\.0 /);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.0.bin')), true);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, '.version')), false);
  assert.equal(countGets(sb), 1);
  assert.match(r.stderr, /\[agy\] 1\.3\.0 のバイナリを取得します\(初回のみ・数分かかることがあります。次回からは取得しません\)/);
});

test('L2 launch hit: キャッシュがあれば取得せず loader を起動する', () => {
  const sb = setup('l2', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(countGets(sb), 1);

  const second = launch(sb);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /LOADER_RAN version=1\.3\.0 /);
  assert.equal(countGets(sb), 1);
});

test('L3 旧形式の不整合キャッシュは使わず、旧ファイルには触れない', () => {
  const sb = setup('l3', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  fs.mkdirSync(sb.cacheDir, { recursive: true });
  const legacyBin = path.join(sb.cacheDir, '.bin');
  const legacyVersion = path.join(sb.cacheDir, '.version');
  fs.writeFileSync(legacyBin, legacyBinary('1.2.16'));
  fs.writeFileSync(legacyVersion, '1.3.0');
  const before = [sha256File(legacyBin), sha256File(legacyVersion)];

  const r = launch(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LOADER_RAN version=1\.3\.0 /);
  assert.doesNotMatch(r.stdout, /1\.2\.16/);
  assert.equal(countGets(sb), 1);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.0.bin')), true);
  assert.deepEqual([sha256File(legacyBin), sha256File(legacyVersion)], before);
});

test('L4 AGY_TERMUX_REFRESH=1 は既存キャッシュがあっても取得し直す', () => {
  const sb = setup('l4', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(countGets(sb), 1);

  const second = launch(sb, { AGY_TERMUX_REFRESH: '1' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /LOADER_RAN version=1\.3\.0 /);
  assert.equal(countGets(sb), 2);
});

test('L5 REFRESH で取得に失敗したら救済せず非ゼロで終了し、既存ファイルを壊さず tmp を残さない', () => {
  const sb = setup('l5', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);
  const target = path.join(sb.cacheDir, 'agy-1.3.0.bin');
  const before = sha256File(target);

  setRoute(sb.routes, { kind: 'corrupt' });
  const r = launch(sb, { AGY_TERMUX_REFRESH: '1' });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /LOADER_RAN/);
  assert.equal(sha256File(target), before);
  assert.deepEqual(h.listDir(sb.cacheDir).filter((n) => n.endsWith('.tmp')), []);
});

test('F1 流れ1: 旧形式キャッシュがあっても update で版別ファイルを作り、10 分以内の旧ファイルは掃除しない', () => {
  const sb = setup('f1', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  setAuditedRoute(sb.routes, '1.2.16');
  fs.mkdirSync(sb.cacheDir, { recursive: true });
  const legacyBin = path.join(sb.cacheDir, '.bin');
  const legacyVersion = path.join(sb.cacheDir, '.version');
  fs.writeFileSync(legacyBin, legacyBinary('1.2.16'));
  fs.writeFileSync(legacyVersion, '1.3.0');
  const before = [sha256File(legacyBin), sha256File(legacyVersion)];

  const r = update(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /使用中の 1\.3\.0 は、公開されている監査済み版 \(1\.2\.16\) より新しいため、更新はしません\(ダウングレードもしません\)/);
  assert.doesNotMatch(r.stdout, /Already on latest audited version/);
  assert.match(r.stdout, /バイナリを 1\.3\.0 に取得しました/);
  // 旧形式は mtime が直前に作られたばかり(10分以内)なので掃除の対象外。削除もされず、rm の案内も出ない
  assert.equal(fs.existsSync(legacyBin), true);
  assert.equal(fs.existsSync(legacyVersion), true);
  assert.doesNotMatch(r.stdout, /rm -f -- /);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.0.bin')), true);
  assert.equal(countGets(sb), 1);
  assert.deepEqual(h.readLog(sb.npmLog), []);
  assert.deepEqual([sha256File(legacyBin), sha256File(legacyVersion)], before);

  const after1 = launch(sb);
  assert.equal(after1.status, 0, after1.stderr);
  assert.match(after1.stdout, /LOADER_RAN version=1\.3\.0 /);
  assert.equal(countGets(sb), 1);

  const again = update(sb);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /バイナリは最新です \(1\.3\.0\)/);
});

test('F2 流れ2: update で版が上がると、新しいパッケージの pin で新しい版を取得して起動する', () => {
  const OLD_URL = 'https://mock.test/agy-1.2.14.tar.gz';
  const NEW_URL = 'https://mock.test/agy-1.3.0.tar.gz';
  const sb = setup('f2', { pkgVersion: '1.2.14', pinVersion: '1.2.14', url: OLD_URL });

  // 新しいパッケージ(版 1.3.0)を用意する
  const newPkg = h.makePackageFromWorktree(path.join(sb.dir, 'new-pkg'));
  const newBin = h.makeBinary(path.join(sb.dir, 'bin-130'), '1.3.0');
  h.writePin(newPkg, {
    version: '1.3.0',
    tagName: '1.3.0',
    url: NEW_URL,
    sha256Tar: newBin.sha256Tar,
    sha256Binary: newBin.sha256Binary,
  });
  setRoute(sb.routes, { kind: 'file', file: newBin.tarPath }, NEW_URL);
  setAuditedRoute(sb.routes, '1.3.0');

  // (a) 旧版で起動する
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /LOADER_RAN version=1\.2\.14 /);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.2.14.bin')), true);
  assert.equal(countGets(sb, OLD_URL), 1);

  // (b) update で 1.3.0 に上げる
  const r = update(sb, { MOCK_NPM_VIEW: '1.3.0', FAKE_NPM_NEW_PKG: newPkg });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /1\.2\.14 → 1\.3\.0 に更新します/);
  assert.match(r.stdout, /\[agy\] 1\.2\.14 → 1\.3\.0 に更新しました/);
  assert.match(r.stderr, /1\.3\.0 のバイナリを取得します\(初回のみ・数分かかることがあります。次回からは取得しません\)/);
  assert.deepEqual(h.readLog(sb.npmLog), [
    'view @bash0816/agy-termux@latest version',
    `install -g --prefix ${sb.prefix} @bash0816/agy-termux@1.3.0`,
  ]);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(sb.prefix, 'lib', 'node_modules', '@bash0816', 'agy-termux', 'package.json'), 'utf8'));
  assert.equal(pkgJson.version, '1.3.0');
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.0.bin')), true);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.2.14.bin')), true);
  assert.equal(countGets(sb, NEW_URL), 1);

  // (c) 新版で起動する。取得は増えない
  const second = launch(sb);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /LOADER_RAN version=1\.3\.0 /);
  assert.equal(countGets(sb, NEW_URL), 1);
});

// 新しいパッケージ(版 version)を用意し、url の応答と pin を書く。戻り値は新パッケージの pkgDir
function makeNewPkg(sb, name, version, url) {
  const newPkg = h.makePackageFromWorktree(path.join(sb.dir, name));
  const bin = h.makeBinary(path.join(sb.dir, name + '-bin'), version);
  h.writePin(newPkg, {
    version,
    tagName: version,
    url,
    sha256Tar: bin.sha256Tar,
    sha256Binary: bin.sha256Binary,
  });
  setRoute(sb.routes, { kind: 'file', file: bin.tarPath }, url);
  return newPkg;
}

// キャッシュ内の全ファイルの sha256(ファイル名 → sha)
function cacheShas(sb) {
  return Object.fromEntries(fs.readdirSync(sb.cacheDir).map((f) => [f, sha256File(path.join(sb.cacheDir, f))]));
}

test('M1 移行: 旧 npm 基準コード(6e47c7a)から update しても、更新後の最初の launch で 1 回だけ取得する', () => {
  const OLD_URL = 'https://mock.test/agy-1.2.14.tar.gz';
  const NEW_URL = 'https://mock.test/agy-1.3.0.tar.gz';
  const sb = setup('m1', { pkgVersion: '1.2.14', pinVersion: '1.2.14', url: OLD_URL });

  // pkgDir の中身を旧コード(6e47c7a)に置き換え、旧版 fixture で pin と OLD_URL の応答を書き直す
  for (const name of ['bin', 'lib', 'config', 'package.json']) {
    fs.rmSync(path.join(sb.pkgDir, name), { recursive: true, force: true });
  }
  h.makePackageFromGit('6e47c7a', sb.pkgDir);
  const oldBin = h.makeBinary(path.join(sb.dir, 'bin-old'), '1.2.14');
  setRoute(sb.routes, { kind: 'file', file: oldBin.tarPath }, OLD_URL);
  h.writePin(sb.pkgDir, {
    version: '1.2.14',
    tagName: '1.2.14',
    url: OLD_URL,
    sha256Tar: oldBin.sha256Tar,
    sha256Binary: oldBin.sha256Binary,
  });
  const newPkg = makeNewPkg(sb, 'new-pkg', '1.3.0', NEW_URL);

  // (a) 旧版で起動する
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /LOADER_RAN version=1\.2\.14 /);

  // (b) update で 1.3.0 に上げる。旧コードはバイナリを取得しない(R9)
  const r = update(sb, { MOCK_NPM_VIEW: '1.3.0', FAKE_NPM_NEW_PKG: newPkg });
  assert.equal(r.status, 0, r.stderr);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(sb.pkgDir, 'package.json'), 'utf8'));
  assert.equal(pkgJson.version, '1.3.0');
  assert.equal(countGets(sb, NEW_URL), 0);
  const afterUpdate = cacheShas(sb);

  // (c) 新版で起動する。更新後の最初の起動で 1 回だけ取得し、既存のキャッシュには触れない
  const second = launch(sb);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /LOADER_RAN version=1\.3\.0 /);
  assert.equal(countGets(sb, NEW_URL), 1);
  const afterLaunch = cacheShas(sb);
  for (const [f, sha] of Object.entries(afterUpdate)) {
    assert.equal(afterLaunch[f], sha, `キャッシュ ${f} が変わった`);
  }

  // (d) もう一度起動しても取得は増えない
  const third = launch(sb);
  assert.equal(third.status, 0, third.stderr);
  assert.equal(countGets(sb, NEW_URL), 1);
});

test('M2 移行: 監査済み版基準コード(102ab9a)から update しても、更新後の最初の launch で 1 回だけ取得する', () => {
  const OLD_URL = 'https://mock.test/agy-1.2.14.tar.gz';
  const NEW_URL = 'https://mock.test/agy-1.3.0.tar.gz';
  const sb = setup('m2', { pkgVersion: '1.2.14', pinVersion: '1.2.14', url: OLD_URL });

  // pkgDir の中身を監査済み版(102ab9a)に置き換え、旧版 fixture で pin と OLD_URL の応答を書き直す
  for (const name of ['bin', 'lib', 'config', 'package.json']) {
    fs.rmSync(path.join(sb.pkgDir, name), { recursive: true, force: true });
  }
  h.makePackageFromGit('102ab9a', sb.pkgDir);
  const oldBin = h.makeBinary(path.join(sb.dir, 'bin-old'), '1.2.14');
  setRoute(sb.routes, { kind: 'file', file: oldBin.tarPath }, OLD_URL);
  h.writePin(sb.pkgDir, {
    version: '1.2.14',
    tagName: '1.2.14',
    url: OLD_URL,
    sha256Tar: oldBin.sha256Tar,
    sha256Binary: oldBin.sha256Binary,
  });
  const newPkg = makeNewPkg(sb, 'new-pkg', '1.3.0', NEW_URL);
  setAuditedRoute(sb.routes, '1.3.0');

  // (a) 旧版で起動する
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /LOADER_RAN version=1\.2\.14 /);

  // (b) update で 1.3.0 に上げる。監査済み版コードもバイナリを取得しない
  const r = update(sb, { MOCK_NPM_VIEW: '1.3.0', FAKE_NPM_NEW_PKG: newPkg });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /1\.2\.14 → 1\.3\.0 に更新します/);
  assert.match(r.stdout, /更新完了/);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(sb.pkgDir, 'package.json'), 'utf8'));
  assert.equal(pkgJson.version, '1.3.0');
  assert.equal(countGets(sb, NEW_URL), 0);
  const afterUpdate = cacheShas(sb);

  // (c) 新版で起動する。更新後の最初の起動で 1 回だけ取得し、既存のキャッシュには触れない
  const second = launch(sb);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /LOADER_RAN version=1\.3\.0 /);
  assert.equal(countGets(sb, NEW_URL), 1);
  const afterLaunch = cacheShas(sb);
  for (const [f, sha] of Object.entries(afterUpdate)) {
    assert.equal(afterLaunch[f], sha, `キャッシュ ${f} が変わった`);
  }

  // (d) もう一度起動しても取得は増えない
  const third = launch(sb);
  assert.equal(third.status, 0, third.stderr);
  assert.equal(countGets(sb, NEW_URL), 1);
});

test('E1 取得失敗→起動で回復: 取得に失敗した update は失敗し、その後の launch で取得して起動する', () => {
  const sb = setup('e1', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  setAuditedRoute(sb.routes, '1.3.0');
  const original = JSON.parse(fs.readFileSync(sb.routes, 'utf8'))[TARBALL_URL];
  setRoute(sb.routes, { kind: 'corrupt' });

  // (a) 取得が壊れていると update は失敗し、版別ファイルも一時ファイルも残さない
  const r = update(sb);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /ダウンロードしたファイルの検証に失敗しました/);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.0.bin')), false);
  const tmps = fs.existsSync(sb.cacheDir) ? fs.readdirSync(sb.cacheDir).filter((f) => f.endsWith('.tmp')) : [];
  assert.deepEqual(tmps, []);

  // (b) 取得経路が直った後は、launch が取得して起動する
  setRoute(sb.routes, original);
  const second = launch(sb);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /LOADER_RAN version=1\.3\.0 /);
});

test('E2 更新後の版が想定と異なる: 取得せずに失敗する', () => {
  const OLD_URL = 'https://mock.test/agy-1.2.14.tar.gz';
  const NEW_URL = 'https://mock.test/agy-1.3.0.tar.gz';
  const sb = setup('e2', { pkgVersion: '1.2.14', pinVersion: '1.2.14', url: OLD_URL });
  const newPkg = makeNewPkg(sb, 'new-pkg', '1.2.99', NEW_URL);
  setAuditedRoute(sb.routes, '1.3.0');

  // (a) 旧版で一度起動する
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);

  // (b) latest は 1.3.0 だが、入ったパッケージは 1.2.99。想定と違うので失敗する
  const r = update(sb, { MOCK_NPM_VIEW: '1.3.0', FAKE_NPM_NEW_PKG: newPkg });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /更新後のパッケージの版が想定 \(1\.3\.0\) と異なります \(実際 1\.2\.99\)/);
  assert.match(r.stderr, /npm install -g --prefix .* @bash0816\/agy-termux@1\.3\.0 を実行してください/);
  assert.equal(countGets(sb, NEW_URL), 0);
});

test('E3 更新先に binary-cache.js が無い: 警告を出して成功し、取得は launch に任せる', () => {
  const OLD_URL = 'https://mock.test/agy-1.2.14.tar.gz';
  const NEW_URL = 'https://mock.test/agy-1.3.0.tar.gz';
  const sb = setup('e3', { pkgVersion: '1.2.14', pinVersion: '1.2.14', url: OLD_URL });

  // binary-cache.js を含まない版(102ab9a)のパッケージを新パッケージにする
  const newPkg = path.join(sb.dir, 'new-pkg');
  h.makePackageFromGit('102ab9a', newPkg);
  const newBin = h.makeBinary(path.join(sb.dir, 'new-bin'), '1.3.0');
  h.writePin(newPkg, {
    version: '1.3.0',
    tagName: '1.3.0',
    url: NEW_URL,
    sha256Tar: newBin.sha256Tar,
    sha256Binary: newBin.sha256Binary,
  });
  setRoute(sb.routes, { kind: 'file', file: newBin.tarPath }, NEW_URL);
  setAuditedRoute(sb.routes, '1.3.0');

  // (a) update は成功するが、バイナリは取得せず、警告を出す
  const r = update(sb, { MOCK_NPM_VIEW: '1.3.0', FAKE_NPM_NEW_PKG: newPkg });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /警告/);
  assert.match(r.stderr, /AGY_TERMUX_REFRESH=1/);
  assert.doesNotMatch(r.stdout, /バイナリを 1\.3\.0 に更新しました/);
  assert.equal(countGets(sb, NEW_URL), 0);
  assert.deepEqual(h.readLog(sb.npmLog), [
    'view @bash0816/agy-termux@latest version',
    `install -g --prefix ${sb.prefix} @bash0816/agy-termux@1.3.0`,
  ]);
});

test('E4 引き継ぎ先の同期が失敗: 取得に失敗して終了し、パッケージは更新済みのまま残る', () => {
  const OLD_URL = 'https://mock.test/agy-1.2.14.tar.gz';
  const NEW_URL = 'https://mock.test/agy-1.3.0.tar.gz';
  const sb = setup('e4', { pkgVersion: '1.2.14', pinVersion: '1.2.14', url: OLD_URL });

  const newPkg = makeNewPkg(sb, 'new-pkg', '1.3.0', NEW_URL);
  setAuditedRoute(sb.routes, '1.3.0');
  // 新しい pin の tar への応答を消す(通信エラー相当)
  const routes = JSON.parse(fs.readFileSync(sb.routes, 'utf8'));
  delete routes[NEW_URL];
  fs.writeFileSync(sb.routes, JSON.stringify(routes));

  // (a) 旧版で起動する
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);

  // (b) update は失敗する。パッケージは 1.3.0 に更新済み
  const r = update(sb, { MOCK_NPM_VIEW: '1.3.0', FAKE_NPM_NEW_PKG: newPkg });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /バイナリの取得に失敗しました/);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(sb.prefix, 'lib', 'node_modules', '@bash0816', 'agy-termux', 'package.json'), 'utf8'));
  assert.equal(pkgJson.version, '1.3.0');
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.0.bin')), false);
});

test('E5 同意なし(非 TTY): 質問せず終了コード 1 で止まり、取得もしない', () => {
  const sb = setup('e5', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  setAuditedRoute(sb.routes, '1.3.0');
  // setup は consent を書くので、ここで消す
  fs.rmSync(path.join(sb.cacheDir, '.consent'), { force: true });

  const r = update(sb);
  // 非 TTY で同意がない場合は、取得せずに終了 1 で案内する。削除も .consent の作成もしない
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /同意の入力がありません。端末から agy update または agy を実行してください/);
  assert.doesNotMatch(r.stdout, /今回はバイナリ同期を省略しました/);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.0.bin')), false);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, '.consent')), false);
  assert.equal(countGets(sb), 0);
});

test('E6 loader 無し: 取得前に失敗し、取得も手動削除の案内も出さない', () => {
  const sb = setup('e6', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  setAuditedRoute(sb.routes, '1.3.0');
  fs.rmSync(path.join(sb.prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1'), { force: true });

  const r = update(sb);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pkg install glibc-repo/);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.0.bin')), false);
  assert.equal(countGets(sb), 0);
  assert.doesNotMatch(r.stdout, /手動で削除できる/);
});


// キャッシュ(~/.agy-termux)に掃除の対象と対象外のファイルを置く。mtime は今から何日前かで指定する
function seedCache(sb) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const files = [
    // 掃除の対象: 直前の版より前の版別ファイルと、古い一時ファイル
    ['agy-1.0.0.bin', 50],
    ['agy-1.1.0.bin', 40],
    ['agy-1.2.0.bin', 30],
    ['agy-1.2.14.bin.99999999.abcd1234.tmp', 2],
    // 残す: 直前の版、旧形式、unverified、完全一致しない名前、新しい一時ファイル
    ['agy-1.2.14.bin', 10],
    ['.bin', 0],
    ['.version', 0],
    ['unverified/agy-9.9.9.bin', 0],
    ['agy-foo.bin', 0],
    ['agy-1.2.14.bin.99999998.abcd1234.tmp', 0],
  ];
  fs.mkdirSync(path.join(sb.cacheDir, 'unverified'), { recursive: true });
  for (const [name, daysAgo] of files) {
    const file = path.join(sb.cacheDir, name);
    fs.writeFileSync(file, 'x');
    const t = new Date(now - daysAgo * DAY_MS);
    fs.utimesSync(file, t, t);
  }
}

// キャッシュディレクトリ以下の全ファイルを名前順で返す。サブディレクトリ内は <dir>/<名前> の形にする
function listCache(sb) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(path.join(dir, ent.name), prefix + ent.name + '/');
      else out.push(prefix + ent.name);
    }
  };
  if (fs.existsSync(sb.cacheDir)) walk(sb.cacheDir, '');
  return out.sort();
}

test('P1 update が掃除する: 直前の版と pin の版以外の版別ファイルと古い一時ファイルを消し、残すものは残す', () => {
  const sb = setup('p1', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  setAuditedRoute(sb.routes, '1.3.0');
  seedCache(sb);

  const r = update(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /バイナリを 1\.3\.0 に取得しました/);
  assert.deepEqual(listCache(sb), [
    '.bin',
    '.consent',
    '.version',
    'agy-1.2.14.bin',
    'agy-1.2.14.bin.99999998.abcd1234.tmp',
    'agy-1.3.0.bin',
    'agy-foo.bin',
    'unverified/agy-9.9.9.bin',
  ]);
});

test('P2 launch は掃除しない: 取得しても既存の版別ファイルは消さない', () => {
  const sb = setup('p2', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  setAuditedRoute(sb.routes, '1.3.0');
  seedCache(sb);
  const seeded = listCache(sb);

  const r = launch(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listCache(sb), [...seeded, 'agy-1.3.0.bin'].sort());
});

test('P3 同意なしの省略では掃除しない: 同期を省略した update は何も削除しない', () => {
  const sb = setup('p3', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  setAuditedRoute(sb.routes, '1.3.0');
  seedCache(sb);
  const seeded = listCache(sb);
  fs.rmSync(path.join(sb.cacheDir, '.consent'), { force: true });

  const r = update(sb);
  // 非 TTY で同意がない update は、取得も削除もせず終了 1 で案内する
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /同意の入力がありません。端末から agy update または agy を実行してください/);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, '.consent')), false);
  assert.deepEqual(listCache(sb), seeded.filter((f) => f !== '.consent'));
});

test('P4 取得失敗では掃除しない: 失敗した update は何も削除せず、一時ファイルも増やさない', () => {
  const sb = setup('p4', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  setAuditedRoute(sb.routes, '1.3.0');
  seedCache(sb);
  const seeded = listCache(sb);
  setRoute(sb.routes, { kind: 'corrupt' });

  const r = update(sb);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(listCache(sb), seeded);
});

test('FL1 FORCE_LATEST は別名前空間: 最新版は unverified/ に取得し、通常の pin の版別ファイルには触れない', () => {
  const sb = setup('fl1', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  setRoute(sb.routes, { kind: 'body', body: JSON.stringify({ tag_name: 'v1.3.5', assets: [{ name: 'agy_cli_linux_arm64.tar.gz', browser_download_url: 'https://mock.test/latest-1.3.5.tar.gz' }] }) }, 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest');
  const bin135 = h.makeBinary(path.join(sb.dir, 'bin-135'), '1.3.5');
  setRoute(sb.routes, { kind: 'file', file: bin135.tarPath }, 'https://mock.test/latest-1.3.5.tar.gz');

  const a = launch(sb, { AGY_TERMUX_FORCE_LATEST: '1' });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /LOADER_RAN version=1\.3\.5/);
  assert.match(a.stderr, /AGY_TERMUX_FORCE_LATEST/);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'unverified', 'agy-1.3.5.bin')), true);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.5.bin')), false);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.0.bin')), false);
  const unverifiedSha = sha256File(path.join(sb.cacheDir, 'unverified', 'agy-1.3.5.bin'));

  const b = launch(sb);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /LOADER_RAN version=1\.3\.0 /);
  assert.equal(fs.existsSync(path.join(sb.cacheDir, 'agy-1.3.0.bin')), true);
  assert.equal(sha256File(path.join(sb.cacheDir, 'unverified', 'agy-1.3.5.bin')), unverifiedSha);
});

test('U1 update は REFRESH/FORCE_LATEST を無視する: 既存の pin 版を再取得せず、最新版 API も呼ばない', () => {
  const sb = setup('u1', { pkgVersion: '1.3.0', pinVersion: '1.3.0' });
  setAuditedRoute(sb.routes, '1.3.0');
  const seed = launch(sb);
  assert.equal(seed.status, 0, seed.stderr);
  assert.equal(countGets(sb), 1);

  const r = update(sb, { AGY_TERMUX_REFRESH: '1', AGY_TERMUX_FORCE_LATEST: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /バイナリは最新です \(1\.3\.0\)/);
  assert.equal(countGets(sb), 1);
  assert.equal(h.readLog(sb.mockLog).some((l) => l.includes('api.github.com')), false);
});
