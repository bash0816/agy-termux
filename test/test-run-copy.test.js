'use strict';

// scripts/lib/test-run-copy.js の単体テスト
// 検証専用。配布物(bin/ lib/ config/)には含めない

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listWorkFiles, makeWorkCopy } = require('../scripts/lib/test-run-copy.js');

// テスト中に作った一時ディレクトリを記録し、after() で全て削除する(途中で assert が落ちても残さない)
const created = [];
function track(dir) {
  created.push(dir);
  return dir;
}
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// ユーザー設定に依存しないよう、identity と署名を明示する
function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

const head = (dir) => git(dir, ['rev-parse', 'HEAD']);

const VERSIONS = {
  tag_name: '1.2.3',
  download_url: 'https://example.invalid/agy.tar.gz',
  sha256_tar: '0'.repeat(64),
};
const PACKAGE = { name: 'x', version: '1.0.0', files: ['a'] };

function writeFile(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

// 一時 git リポジトリを作って 1 コミットする。omit に含めたファイルは作らない
// bin/gone.js はコミットした後で削除する(追跡済みだが存在しない状態を作るため)
function makeFixture({ omit = [] } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-fixture-')));
  const files = {
    'package.json': `${JSON.stringify(PACKAGE, null, 2)}\n`,
    'config/agy-verified-versions.json': `${JSON.stringify(VERSIONS, null, 2)}\n`,
    'bin/a.js': "'use strict';\n",
    'bin/gone.js': "'use strict';\n",
    '.gitignore': 'ignored.txt\n',
    'ignored.txt': 'ignored\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    if (omit.includes(rel)) continue;
    writeFile(dir, rel, body);
  }
  if (!omit.includes('bin/a.js')) fs.chmodSync(path.join(dir, 'bin/a.js'), 0o755);
  git(dir, ['init', '-q']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  if (!omit.includes('bin/gone.js')) fs.rmSync(path.join(dir, 'bin/gone.js'));
  return dir;
}

// os.tmpdir() 直下の agy-vindep- 始まりの名前一覧(makeWorkCopy が作るディレクトリの目印)
function agyTmpNames() {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('agy-vindep-'));
}

test('未追跡ファイルはコピーされ、無視対象・削除済み・.git はコピーされず、版番号だけが書き換わる', () => {
  const fixture = makeFixture();
  fs.writeFileSync(path.join(fixture, 'untracked.txt'), 'hello\n');
  const originalVersions = JSON.parse(
    fs.readFileSync(path.join(fixture, 'config/agy-verified-versions.json'), 'utf8'),
  );
  const originalPackage = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));

  const copy = makeWorkCopy(fixture, {
    requiredCommits: [head(fixture)],
    archivePaths: ['package.json'],
  });
  track(copy.dir);
  const dir = copy.dir;

  // 取り込み対象の列挙
  assert.ok(copy.files.includes('untracked.txt'));
  assert.ok(copy.files.includes('bin/a.js'));
  assert.ok(copy.files.includes('.gitignore'));
  assert.ok(!copy.files.includes('ignored.txt'));
  assert.ok(!copy.files.includes('bin/gone.js'));
  assert.ok(!copy.files.some((f) => f === '.git' || f.startsWith('.git/')));

  // 未追跡ファイルの内容が元と同じ
  assert.equal(fs.readFileSync(path.join(dir, 'untracked.txt'), 'utf8'), 'hello\n');

  // 版番号の書き換え(他の項目は元の値のまま)
  const versions = JSON.parse(fs.readFileSync(path.join(dir, 'config/agy-verified-versions.json'), 'utf8'));
  assert.equal(versions.tag_name, '9.9.9');
  assert.deepEqual(versions, { ...originalVersions, tag_name: '9.9.9' });
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '9.9.9');
  assert.deepEqual(pkg, { ...originalPackage, version: '9.9.9' });

  // モードの保持
  assert.equal(
    fs.statSync(path.join(dir, 'bin/a.js')).mode & 0o777,
    fs.statSync(path.join(fixture, 'bin/a.js')).mode & 0o777,
  );

  // 元リポジトリは変わっていない
  const sourcePkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
  assert.equal(sourcePkg.version, '1.0.0');

  // dir は os.tmpdir() 配下で、リポジトリの外
  const rel = path.relative(os.tmpdir(), dir);
  assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel));
  assert.ok(!dir.startsWith(fixture + path.sep));

  // cleanup で削除される
  copy.cleanup();
  assert.equal(fs.existsSync(dir), false);
});

test('存在しない sha を渡すと Error を投げ、一時ディレクトリを残さない', () => {
  const fixture = makeFixture();
  const before = new Set(agyTmpNames());
  const badSha = '0'.repeat(40);

  let thrown = null;
  try {
    makeWorkCopy(fixture, { requiredCommits: [badSha], archivePaths: ['package.json'] });
  } catch (err) {
    thrown = err;
  }
  // 失敗して残ったものは after() の対象にしてから判定する
  const leaked = agyTmpNames()
    .filter((name) => !before.has(name))
    .map((name) => track(path.join(os.tmpdir(), name)));

  assert.ok(thrown instanceof Error);
  assert.ok(thrown.message.includes(badSha));
  assert.deepEqual(leaked, []);
});

test('symlink があると listWorkFiles は相対パス付きの Error を投げる', () => {
  const fixture = makeFixture();
  const link = path.join(fixture, 'my-link');
  fs.symlinkSync('package.json', link);
  try {
    assert.throws(
      () => listWorkFiles(fixture),
      (err) => err instanceof Error && err.message.includes('symlink') && err.message.includes('my-link'),
    );
  } finally {
    fs.rmSync(link, { force: true });
  }
});

test('linked worktree でも makeWorkCopy が成功し、worktree の HEAD sha の検査が通る', () => {
  const fixture = makeFixture();
  // worktree は fixture の外(別に作った親ディレクトリの下)に置く
  const parent = track(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-wt-')));
  const wtPath = path.join(parent, 'wt');
  git(fixture, ['worktree', 'add', '-q', '--detach', wtPath]);
  try {
    // 前提: linked worktree では .git がファイルになる
    assert.ok(fs.lstatSync(path.join(wtPath, '.git')).isFile());

    const wtHead = head(wtPath);
    const copy = makeWorkCopy(wtPath, {
      requiredCommits: [wtHead],
      archivePaths: ['package.json'],
    });
    track(copy.dir);
    assert.ok(copy.files.includes('package.json'));
    const pkg = JSON.parse(fs.readFileSync(path.join(copy.dir, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '9.9.9');
    copy.cleanup();
  } finally {
    git(fixture, ['worktree', 'remove', '--force', wtPath]);
  }
});

test('config/agy-verified-versions.json が無いリポジトリでは Error を投げる', () => {
  const relPath = 'config/agy-verified-versions.json';
  const fixture = makeFixture({ omit: [relPath] });
  const before = new Set(agyTmpNames());

  assert.throws(
    () => makeWorkCopy(fixture, { requiredCommits: [head(fixture)], archivePaths: ['bin'] }),
    (err) => err instanceof Error && err.message.includes(relPath),
  );
  const leaked = agyTmpNames()
    .filter((name) => !before.has(name))
    .map((name) => track(path.join(os.tmpdir(), name)));
  assert.deepEqual(leaked, []);
});

test('package.json が無いリポジトリでは Error を投げる', () => {
  const relPath = 'package.json';
  const fixture = makeFixture({ omit: [relPath] });
  const before = new Set(agyTmpNames());

  assert.throws(
    () => makeWorkCopy(fixture, { requiredCommits: [head(fixture)], archivePaths: ['bin'] }),
    (err) => err instanceof Error && err.message.includes(relPath),
  );
  const leaked = agyTmpNames()
    .filter((name) => !before.has(name))
    .map((name) => track(path.join(os.tmpdir(), name)));
  assert.deepEqual(leaked, []);
});
