'use strict';

// 配線テスト用の共通ヘルパー。実物の bin/agy.js を子プロセスで起動する検証で使う
// 偽の npm / glibc loader / バイナリ tarball / パッケージ配置を一時ディレクトリに作る
// 通信は test/helpers/mock-https.js(NODE_OPTIONS の --require で読み込む偽物)に置き換える

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const MOCK = path.resolve(__dirname, 'mock-https.js');
// 検証対象のパッケージに含める部分(test/ は含めない)
const PACKAGE_PARTS = ['bin', 'lib', 'config', 'package.json'];
// 偽バイナリの大きさ(下限 10MiB を満たすため 4KiB 余分に確保する)
const BIN_SIZE = 10 * 1024 * 1024 + 4096;
const ASSET_NAME = 'agy_cli_linux_arm64.tar.gz';

// 一時ディレクトリを作る(realpath にして、prefix の比較を実体で行う)
function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wiring-')));
}

// 連番つきのサブディレクトリを作る(例: prefix-0, prefix-1)
let seq = 0;
function newDir(root, name) {
  const dir = path.join(root, `${name}-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// 偽バイナリを作り、gzip 済みの tarball も作る。
// ELF マジック(0x7F 'E' 'L' 'F')の後に AGYVER:<version> を置き、残りは 0 埋めする
function makeBinary(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const binPath = path.join(dir, 'antigravity');
  const buf = Buffer.alloc(BIN_SIZE);
  buf[0] = 0x7f;
  buf.write('ELF', 1, 'latin1');
  buf.write(`AGYVER:${version}\n`, 4, 'ascii');
  fs.writeFileSync(binPath, buf);

  const tarPath = path.join(dir, ASSET_NAME);
  execFileSync('tar', ['-czf', tarPath, '-C', dir, 'antigravity']);
  // gzip ヘッダには作成時刻が入るため、tar の sha256 は作成後のファイルから計算する
  return {
    tarPath,
    binPath,
    sha256Tar: sha256(fs.readFileSync(tarPath)),
    sha256Binary: sha256(buf),
  };
}

// config/agy-verified-versions.json と package.json を指定の値に書き換える(他の項目は残す)
function writePin(pkgDir, { version, tagName, url, sha256Tar, sha256Binary }) {
  const pkgPath = path.join(pkgDir, 'package.json');
  const pkg = readJson(pkgPath);
  pkg.version = version;
  writeJson(pkgPath, pkg);

  const pinPath = path.join(pkgDir, 'config', 'agy-verified-versions.json');
  const pin = readJson(pinPath);
  Object.assign(pin, {
    tag_name: tagName,
    download_url: url,
    sha256_tar: sha256Tar,
    sha256_binary: sha256Binary,
  });
  writeJson(pinPath, pin);
}

// 作業ツリーの bin / lib / config / package.json を pkgDir にコピーする(test/ は含めない)
function makePackageFromWorktree(pkgDir) {
  fs.mkdirSync(pkgDir, { recursive: true });
  for (const part of PACKAGE_PARTS) {
    fs.cpSync(path.join(REPO, part), path.join(pkgDir, part), { recursive: true });
  }
  return pkgDir;
}

// 指定の git ref の内容を git archive で取り出し、pkgDir に展開する
function makePackageFromGit(ref, pkgDir) {
  fs.mkdirSync(pkgDir, { recursive: true });
  // git archive の出力は既定の maxBuffer(1MiB)を超えうるため大きめに指定する
  const archive = execFileSync('git', ['-C', REPO, 'archive', ref, ...PACKAGE_PARTS], {
    maxBuffer: 512 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', pkgDir], { input: archive });
  return pkgDir;
}

// npm のグローバルインストール先(標準レイアウト)のパッケージ位置
function stdPackageDir(prefix) {
  return path.join(prefix, 'lib', 'node_modules', '@bash0816', 'agy-termux');
}

// 偽の glibc loader(Node スクリプト)を <prefix>/glibc/lib/ld-linux-aarch64.so.1 に作る。
// agy.js は "loader --library-path <lib> <バイナリ> ..." の順で起動するため、
// --library-path の次の次の引数をバイナリのパスとして扱う。
// バイナリ先頭 256 バイトの AGYVER:<版> を読んで LOADER_RAN の 1 行を出す
function makeFakeLoader(prefix) {
  const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
  fs.mkdirSync(path.dirname(loader), { recursive: true });
  const script = [
    '#!' + process.execPath,
    "'use strict';",
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "const idx = args.indexOf('--library-path');",
    'const binPath = idx >= 0 ? args[idx + 2] : undefined;',
    "let head = '';",
    'try {',
    "  const fd = fs.openSync(binPath, 'r');",
    '  const buf = Buffer.alloc(256);',
    '  const n = fs.readSync(fd, buf, 0, 256, 0);',
    '  fs.closeSync(fd);',
    "  head = buf.subarray(0, n).toString('latin1');",
    '} catch {}',
    'const m = /AGYVER:([0-9A-Za-z.]+)/.exec(head);',
    "const version = m ? m[1] : 'unknown';",
    'const line = `LOADER_RAN version=${version} path=${binPath}`;',
    'console.log(line);',
    "if (process.env.LOADER_LOG) fs.appendFileSync(process.env.LOADER_LOG, line + '\\n');",
    'process.exit(0);',
    '',
  ].join('\n');
  fs.writeFileSync(loader, script);
  fs.chmodSync(loader, 0o755);
  return loader;
}

// 偽の npm(Node スクリプト)を <dir>/fakebin/npm に作り、fakebin のパスを返す。
// 引数は NPM_LOG に 1 行ずつ追記する。
// view は MOCK_NPM_VIEW を出して MOCK_NPM_VIEW_EXIT で終了する。
// install -g --prefix <p> ... は MOCK_NPM_INSTALL_EXIT で終了し、成功時は FAKE_NPM_NEW_PKG を
// <p> の標準位置へ差し替える(npm が新しいパッケージを入れた状況の再現)。
// 未知のサブコマンドは何もせず exit 0
function makeFakeNpm(dir) {
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const script = [
    '#!' + process.execPath,
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    "if (process.env.NPM_LOG) fs.appendFileSync(process.env.NPM_LOG, args.join(' ') + '\\n');",
    "if (args[0] === 'view') {",
    "  process.stdout.write((process.env.MOCK_NPM_VIEW ?? '') + '\\n');",
    '  process.exit(Number(process.env.MOCK_NPM_VIEW_EXIT || 0));',
    '}',
    "if (args[0] === 'install') {",
    '  const code = Number(process.env.MOCK_NPM_INSTALL_EXIT || 0);',
    '  if (code === 0 && process.env.FAKE_NPM_NEW_PKG) {',
    "    const p = args[args.indexOf('--prefix') + 1];",
    "    const dest = path.join(p, 'lib', 'node_modules', '@bash0816', 'agy-termux');",
    '    fs.rmSync(dest, { recursive: true, force: true });',
    '    fs.cpSync(process.env.FAKE_NPM_NEW_PKG, dest, { recursive: true });',
    '  }',
    '  process.exit(code);',
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
  const npm = path.join(bin, 'npm');
  fs.writeFileSync(npm, script);
  fs.chmodSync(npm, 0o755);
  return bin;
}

// 同意ファイル <home>/.agy-termux/.consent に obj を書く
function writeConsent(home, obj) {
  const dir = path.join(home, '.agy-termux');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.consent');
  writeJson(file, obj);
  return file;
}

// 実 bin/agy.js を子プロセスとして起動する。mock-https は NODE_OPTIONS で読み込むため、
// agy.js が更に起動する子プロセス(update の --sync-binary-only)にも継承される。
// env は新しく組み立てるため、親の AGY_* / MOCK_* / FAKE_* は引き継がない。
// MOCK_VA_BITS の既定は '48'(呼び出し側の env で上書き可能)
// sb は { agy, home, fakeBin, npmLog, mockLog, prefix?, loaderLog? } を持つ
function runAgy(sb, args = [], env = {}, agy = sb.agy) {
  const base = {
    PATH: `${sb.fakeBin}:${process.env.PATH}`,
    HOME: sb.home,
    NPM_LOG: sb.npmLog,
    MOCK_HTTPS_LOG: sb.mockLog,
    MOCK_VA_BITS: '48',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    NODE_OPTIONS: `--require ${MOCK}`,
  };
  if (sb.prefix) base.PREFIX = sb.prefix;
  if (sb.loaderLog) base.LOADER_LOG = sb.loaderLog;
  const r = spawnSync(process.execPath, [agy, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...base, ...env },
  });
  // timeout などで起動自体が失敗したときは、その時点の出力を残して原因を調べられるようにする
  if (r.error) {
    throw new Error('agy の実行が失敗しました: ' + r.error.code + ' (timeout ' + 30000 + 'ms) stdout=' + JSON.stringify(String(r.stdout || '').slice(-500)) + ' stderr=' + JSON.stringify(String(r.stderr || '').slice(-500)));
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ログ(1 行 1 件)を読む。ファイルが無ければ空配列
function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

// ディレクトリの中身を名前順で返す。ディレクトリが無ければ空配列
function listDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

module.exports = {
  REPO,
  MOCK,
  makeRoot,
  newDir,
  makeBinary,
  writePin,
  makePackageFromWorktree,
  makePackageFromGit,
  stdPackageDir,
  makeFakeLoader,
  makeFakeNpm,
  writeConsent,
  runAgy,
  readLog,
  listDir,
};
