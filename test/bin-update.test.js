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

const REPO = path.resolve(__dirname, '..');
const MOCK = path.join(__dirname, 'helpers', 'mock-https.js');
// 検証対象のパッケージに含める部分(test/ は含めない)
const PACKAGE_PARTS = ['bin', 'lib', 'config', 'package.json'];

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
  return pkgDir;
}

// 偽 npm(Node スクリプト)を <dir>/fakebin/npm に作る
// 引数は NPM_LOG に1行ずつ追記する。view は MOCK_NPM_VIEW を出力して MOCK_NPM_VIEW_EXIT で終了、
// install は MOCK_NPM_INSTALL_EXIT で終了する
function makeFakeBin(dir) {
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  // shebang は絶対パス。Termux/Android には /usr/bin/env が無く、env を最小にすると実行できないため
  const script = [
    '#!' + process.execPath,
    "'use strict';",
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (process.env.NPM_LOG) fs.appendFileSync(process.env.NPM_LOG, args.join(' ') + '\\n');",
    "if (args[0] === 'view') {",
    "  process.stdout.write((process.env.MOCK_NPM_VIEW ?? '') + '\\n');",
    "  process.exit(Number(process.env.MOCK_NPM_VIEW_EXIT || 0));",
    '}',
    "if (args[0] === 'install') process.exit(Number(process.env.MOCK_NPM_INSTALL_EXIT || 0));",
    'process.exit(0);',
    '',
  ].join('\n');
  const npm = path.join(bin, 'npm');
  fs.writeFileSync(npm, script);
  fs.chmodSync(npm, 0o755);
  return bin;
}

// テストごとの隔離環境。標準レイアウトのパッケージを version で置く
function setup(name, version) {
  const dir = newDir(name);
  const prefix = path.join(dir, 'prefix');
  const pkgDir = makePackage(stdPackageDir(prefix), version);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  return {
    dir,
    prefix: fs.realpathSync(prefix),
    agy: path.join(pkgDir, 'bin', 'agy.js'),
    home,
    fakeBin: makeFakeBin(dir),
    npmLog: path.join(dir, 'npm.log'),
    mockLog: path.join(dir, 'https.log'),
  };
}

// 実 bin/agy.js を子プロセスで起動する。env は最小(親の AGY_* 環境変数は引き継がない)
function runAgy(sb, args, env = {}, agy = sb.agy) {
  const r = spawnSync(process.execPath, ['--require', MOCK, agy, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      PATH: `${sb.fakeBin}:${process.env.PATH}`,
      HOME: sb.home,
      NPM_LOG: sb.npmLog,
      MOCK_HTTPS_LOG: sb.mockLog,
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
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.16', MOCK_NPM_INSTALL_EXIT: '0' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /更新完了/);
});

test('W2 d) install 失敗 → exit 1、前のバージョンへの戻し方を表示', () => {
  const sb = setup('w2-install-fail', '1.2.14');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.16', MOCK_NPM_INSTALL_EXIT: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /前のバージョンに戻すには/);
});

test('W2 e) npm の latest が監査済み版と不一致 → exit 0、更新しない', () => {
  const sb = setup('w2-mismatch', '1.2.14');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.14' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /一致しないため、更新しません/);
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
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.16', MOCK_NPM_INSTALL_EXIT: '0' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readLog(sb.npmLog), [
    'view @bash0816/agy-termux@latest version',
    'install -g --prefix ' + sb.prefix + ' @bash0816/agy-termux@1.2.16',
  ]);
});

// W5 symlink と prefix: 実体側の prefix を使い、推定できない場合は中止する
test('W5 a) symlink 経由で起動しても、--prefix は実体側の prefix', () => {
  const sb = setup('w5a', '1.2.14');
  const linkDir = path.join(sb.dir, 'link');
  fs.mkdirSync(linkDir);
  const link = path.join(linkDir, 'agy.js');
  fs.symlinkSync(sb.agy, link);
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok', MOCK_NPM_VIEW: '1.2.16', MOCK_NPM_INSTALL_EXIT: '0' }, link);
  assert.equal(r.status, 0, r.stderr);
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
  const sb = setup('w6', '1.2.16');
  const r = runAgy(sb, ['--version'], { MOCK_HTTPS_MODE: 'tripwire' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'agy-termux 1.2.16\n');
  assert.deepEqual(fs.readdirSync(sb.home), []);
  assert.deepEqual(readLog(sb.mockLog), []);
  assert.deepEqual(readLog(sb.npmLog), []);
});

// W7 通常の update でも、不要な書き込み(~/.agy-termux の作成)をしない
test('W7 update は隔離 HOME に .agy-termux を作らない', () => {
  const sb = setup('w7', '1.2.16');
  const r = runAgy(sb, ['update'], { MOCK_HTTPS_MODE: 'ok' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(sb.home, '.agy-termux')), false);
});
