'use strict';

// 起動(launch)が ensureBinary を通ることの確認。実物の bin/agy.js を子プロセスで起動し、
// 取得の要否・取得失敗時の救済・loader の起動先・自己回復を確認する
// 通信は test/helpers/mock-https.js で偽物にし、実ネットワークには触れない

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const h = require('./helpers/wiring');

const TARBALL_URL = 'https://mock.test/agy_cli_linux_arm64.tar.gz';
const RECOVERED_MSG = /\[agy\] 取得に失敗しましたが、既存のバイナリで起動します/;

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// MOCK_ROUTES の JSON に url への応答を書く
function setRoute(routesFile, route, url = TARBALL_URL) {
  const routes = fs.existsSync(routesFile) ? JSON.parse(fs.readFileSync(routesFile, 'utf8')) : {};
  routes[url] = route;
  fs.writeFileSync(routesFile, JSON.stringify(routes, null, 2));
}

// テストごとに独立した一時ディレクトリを作り、pinVersion の偽 tarball を持つ package を配置する
function setup(name, pinVersion) {
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
    version: pinVersion,
    tagName: pinVersion,
    url: TARBALL_URL,
    sha256Tar: bin.sha256Tar,
    sha256Binary: bin.sha256Binary,
  });
  h.makeFakeLoader(prefix);
  h.writeConsent(home, { download: true, compat: true });

  const routes = path.join(dir, 'routes.json');
  setRoute(routes, { kind: 'file', file: bin.tarPath });

  return {
    dir,
    agy: path.join(pkgDir, 'bin', 'agy.js'),
    home,
    prefix,
    fakeBin: h.makeFakeNpm(dir),
    npmLog: path.join(dir, 'npm.log'),
    mockLog: path.join(dir, 'https.log'),
    loaderLog: path.join(dir, 'loader.log'),
    routes,
    cacheDir: path.join(home, '.agy-termux'),
    target: path.join(home, '.agy-termux', 'agy-' + pinVersion + '.bin'),
  };
}

// agy を引数なしで起動する(launch 経路)。MOCK_ROUTES は常に渡す
function launch(sb, env = {}) {
  return h.runAgy(sb, [], { MOCK_ROUTES: sb.routes, ...env });
}

// TARBALL_URL の GET が何回呼ばれたか
function countGets(sb) {
  return h.readLog(sb.mockLog).filter((l) => l === 'GET ' + TARBALL_URL).length;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// LOADER_RAN の行に出た起動先の path を取り出す
function loaderPaths(stdout) {
  return [...stdout.matchAll(/LOADER_RAN version=\S+ path=(\S+)/g)].map((m) => m[1]);
}

test('E1 REFRESH で取得に失敗し既存の有効な成果物があれば、終了コード 0 で既存ファイルを起動し、表示を出す', () => {
  const sb = setup('e1', '1.3.0');
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);
  const before = sha256File(sb.target);

  setRoute(sb.routes, { kind: 'corrupt' });
  const r = launch(sb, { AGY_TERMUX_REFRESH: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, RECOVERED_MSG);
  assert.deepEqual(loaderPaths(r.stdout), [sb.target]);
  assert.equal(sha256File(sb.target), before);
  assert.equal(countGets(sb), 2);
});

test('E2 REFRESH で取得に成功したときは、既存で起動する表示を出さず、取得した成果物で起動する', () => {
  const sb = setup('e2', '1.3.0');
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);

  const r = launch(sb, { AGY_TERMUX_REFRESH: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, RECOVERED_MSG);
  assert.deepEqual(loaderPaths(r.stdout), [sb.target]);
  assert.match(r.stdout, /LOADER_RAN version=1\.3\.0 /);
  assert.equal(countGets(sb), 2);
});

test('E3 既存の有効な成果物があり REFRESH が無ければ、取得せずに起動し、表示も出さない', () => {
  const sb = setup('e3', '1.3.0');
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(countGets(sb), 1);

  // 取得が呼ばれれば失敗するように差し替える。呼ばれなければ起動できる
  setRoute(sb.routes, { kind: 'corrupt' });
  const r = launch(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, RECOVERED_MSG);
  assert.deepEqual(loaderPaths(r.stdout), [sb.target]);
  assert.equal(countGets(sb), 1);
});

test('E4 loader の起動先は ensure が返した file であり、取得直後の launch でも同じ版別ファイルを指す', () => {
  const sb = setup('e4', '1.3.0');
  const r = launch(sb);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(loaderPaths(r.stdout), [sb.target]);
  assert.equal(fs.existsSync(sb.target), true);
  assert.equal(countGets(sb), 1);
});

test('E5 自己回復: 起動した成果物が消えていたら、launch 全体で 1 回だけ取得し直して起動する', () => {
  const sb = setup('e5', '1.3.0');
  const first = launch(sb);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(countGets(sb), 1);

  // 1 回目の起動では自分の引数の成果物を消して失敗する。2 回目以降は正常に起動する
  const counter = path.join(sb.dir, 'loader-count');
  fs.writeFileSync(sb.prefix ? path.join(sb.prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1') : '', [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "const bin = args[args.indexOf('--library-path') + 2];",
    'const counter = process.env.COUNTER_FILE;',
    'const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;',
    'fs.writeFileSync(counter, String(n + 1));',
    'if (n === 0) { fs.rmSync(bin); process.stderr.write("vanished\\n"); process.exit(1); }',
    "console.log('LOADER_RAN version=1.3.0 path=' + bin);",
    'process.exit(0);',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(sb.prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1'), 0o755);

  const r = launch(sb, { COUNTER_FILE: counter });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /キャッシュが入れ替わったため、取得し直して起動します/);
  assert.doesNotMatch(r.stderr, RECOVERED_MSG);
  assert.equal(countGets(sb), 2);
  assert.deepEqual(loaderPaths(r.stdout), [sb.target]);
  assert.equal(fs.readFileSync(counter, 'utf8'), '2');
});
