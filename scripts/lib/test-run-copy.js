'use strict';

// 作業ツリーの内容を一時ディレクトリへ複製し、版番号だけ差し替えたコピーを作る小さなライブラリ
// 検証専用。配布物(bin/ lib/ config/)には含めない
// require しても副作用(出力・プロセス起動・ファイル作成)は無い。関数を呼んだときだけ動く

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// コピーに含める commit の既定値(この commit がコピー側の git から取得できることを要求する)
const DEFAULT_REQUIRED_COMMITS = ['6e47c7a', '102ab9a'];
// git archive で存在を確かめる既定のパス
const DEFAULT_ARCHIVE_PATHS = ['bin', 'lib', 'config', 'package.json'];

const VERSIONS_FILE = 'config/agy-verified-versions.json';
const PACKAGE_FILE = 'package.json';

// 作業ツリーの取り込み対象を列挙する(追跡済み + 無視対象外の未追跡、削除済みの追跡ファイルは除外)
// symlink が含まれていれば Error を投げる。戻り値はソート済みの相対パス配列
function listWorkFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const names = [...new Set(out.split('\0').filter((name) => name !== ''))];
  const files = [];
  for (const rel of names) {
    let stat;
    try {
      stat = fs.lstatSync(path.join(repoRoot, rel));
    } catch (err) {
      // 削除済みの追跡ファイルは対象外。それ以外の失敗はそのまま投げる
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.isSymbolicLink()) throw new Error(`symlink は未対応です: ${rel}`);
    files.push(rel);
  }
  return files.sort();
}

// 一覧のファイルを dir 配下の同じ相対パスへコピーする(モードも保持する)
function copyFiles(repoRoot, dir, files) {
  for (const rel of files) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, fs.lstatSync(src).mode & 0o777);
  }
}

// コピー内の版番号だけを書き換える(他の項目は読んだ値のまま)
function rewriteVersions(dir, files, version) {
  for (const rel of [VERSIONS_FILE, PACKAGE_FILE]) {
    if (!files.includes(rel)) throw new Error(`コピーに ${rel} がありません`);
  }

  const versionsPath = path.join(dir, VERSIONS_FILE);
  const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
  versions.tag_name = version;
  fs.writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);

  const packagePath = path.join(dir, PACKAGE_FILE);
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

// コピーを git リポジトリにし、元リポジトリの object を alternates で参照させる
// linked worktree でも共通の git ディレクトリを指すようにする
function setupGitDir(repoRoot, dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const commonDir = path.resolve(repoRoot, out);
  const infoDir = path.join(dir, '.git', 'objects', 'info');
  fs.mkdirSync(infoDir, { recursive: true });
  fs.writeFileSync(path.join(infoDir, 'alternates'), `${path.join(commonDir, 'objects')}\n`);
}

// 要求された commit がコピー側で取得できること、先頭の commit で git archive が通ることを確かめる
function verifyCommits(dir, requiredCommits, archivePaths) {
  for (const sha of requiredCommits) {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: dir, stdio: 'ignore' });
    } catch {
      throw new Error(`必要な commit をコピー側で取得できません: ${sha}`);
    }
  }
  if (requiredCommits.length > 0) {
    const sha = requiredCommits[0];
    const r = spawnSync('git', ['archive', sha, ...archivePaths], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`git archive が失敗しました (${sha}): ${String(r.stderr).trim()}`);
    }
  }
}

// 作業ツリーの複製を一時ディレクトリに作る
// 戻り値: { dir, files, cleanup }。途中で失敗したら一時ディレクトリを消してから元のエラーを投げる
function makeWorkCopy(
  repoRoot,
  {
    version = '9.9.9',
    requiredCommits = DEFAULT_REQUIRED_COMMITS,
    archivePaths = DEFAULT_ARCHIVE_PATHS,
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-vindep-'));
  let files;
  try {
    files = listWorkFiles(repoRoot);
    copyFiles(repoRoot, dir, files);
    rewriteVersions(dir, files, version);
    setupGitDir(repoRoot, dir);
    verifyCommits(dir, requiredCommits, archivePaths);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, files, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { DEFAULT_REQUIRED_COMMITS, DEFAULT_ARCHIVE_PATHS, listWorkFiles, makeWorkCopy };
