'use strict';

// 配線テスト用の共通ヘルパー。実物の bin/agy.js を子プロセスで起動する検証で使う
// 偽の npm / tar / glibc loader / バイナリ tarball / パッケージ配置を一時ディレクトリに作る
// 通信は test/helpers/mock-https.js(NODE_OPTIONS の --require で読み込む偽物)に置き換える

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const MOCK = path.resolve(__dirname, 'mock-https.js');
// 検証対象のパッケージに含める部分(test/ は含めない)
const PACKAGE_PARTS = ['bin', 'lib', 'config', 'package.json'];
// 偽バイナリの大きさ(下限 10MiB を満たすため 4KiB 余分に確保する)
const BIN_SIZE = 10 * 1024 * 1024 + 4096;
const ASSET_NAME = 'agy_cli_linux_arm64.tar.gz';
// 偽 tar が FAKE_TAR_MODE 未設定のときに委譲する本物の tar(Termux 版を優先する)
const REAL_TAR = fs.existsSync('/data/data/com.termux/files/usr/bin/tar')
  ? '/data/data/com.termux/files/usr/bin/tar'
  : '/usr/bin/tar';

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

// 偽コマンドの本体を Node スクリプトの文字列にする。
// 本体は関数として書き、toString() で埋め込むため、外側の変数は参照しない。
// shebang は絶対パス。Termux/Android には /usr/bin/env が無く、env を最小にすると実行できないため
function scriptOf(main, header = '') {
  return '#!' + process.execPath + '\n' + header + '(' + main.toString() + ')();\n';
}

// 偽の glibc loader の本体。"loader --library-path <lib> <バイナリ> ..." の順で起動されるため、
// --library-path の次の次の引数をバイナリのパスとして扱う。
// バイナリ先頭 256 バイトの AGYVER:<版> を読んで LOADER_RAN の 1 行を出す。
// バイナリを開けない(存在しない等)ときは stderr に理由を出して exit 127 にする
function fakeLoaderMain() {
  'use strict';
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  const idx = args.indexOf('--library-path');
  const binPath = idx >= 0 ? args[idx + 2] : undefined;
  let head = '';
  if (binPath !== undefined) {
    let fd;
    try {
      fd = fs.openSync(binPath, 'r');
    } catch {
      process.stderr.write(`error while loading: cannot open ${binPath}: No such file or directory\n`);
      process.exit(127);
    }
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      head = buf.subarray(0, n).toString('latin1');
    } catch {
      // 読めなければ版は unknown のまま
    } finally {
      fs.closeSync(fd);
    }
  }
  const m = /AGYVER:([0-9A-Za-z.]+)/.exec(head);
  const version = m ? m[1] : 'unknown';
  const line = `LOADER_RAN version=${version} path=${binPath}`;
  console.log(line);
  if (process.env.LOADER_LOG) fs.appendFileSync(process.env.LOADER_LOG, line + '\n');
  process.exit(0);
}

// 偽の glibc loader を <prefix>/glibc/lib/ld-linux-aarch64.so.1 に作り、そのパスを返す
function makeFakeLoader(prefix) {
  const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
  fs.mkdirSync(path.dirname(loader), { recursive: true });
  fs.writeFileSync(loader, scriptOf(fakeLoaderMain));
  fs.chmodSync(loader, 0o755);
  return loader;
}

// 偽 npm の本体。引数は NPM_LOG に 1 行ずつ追記する。
// view: MOCK_NPM_VIEW を出して MOCK_NPM_VIEW_EXIT で終了。MOCK_NPM_VIEW_DELAY_MS があれば何も出さずに待つ
// install -g --prefix <p> @bash0816/agy-termux@<ver>:
//   FAKE_NPM_SEQUENCE があれば、install の呼び出し回数(0 始まり, <NPM_LOG>.count)でシナリオを選ぶ(最後の要素は繰り返す)
//   FAKE_NPM_SEQUENCE が無ければ旧来の動作(MOCK_NPM_INSTALL_EXIT で終了し、成功時は fixture を置くだけ)
// 未知のサブコマンドは何もせず exit 0
function fakeNpmMain() {
  'use strict';
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawn } = require('node:child_process');

  const args = process.argv.slice(2);
  const log = process.env.NPM_LOG;
  if (log) fs.appendFileSync(log, args.join(' ') + '\n');

  if (args[0] === 'view') {
    const finish = () => {
      process.stdout.write((process.env.MOCK_NPM_VIEW ?? '') + '\n');
      process.exit(Number(process.env.MOCK_NPM_VIEW_EXIT || 0));
    };
    if (process.env.FAKE_NPM_SCENARIO === 'slow_view' || process.env.MOCK_NPM_VIEW_DELAY_MS !== undefined) {
      setTimeout(finish, Number(process.env.MOCK_NPM_VIEW_DELAY_MS || process.env.FAKE_NPM_SLOW_MS || 6000));
    } else {
      finish();
    }
    return;
  }
  if (args[0] !== 'install') process.exit(0);

  // 要求された版は、指定(@bash0816/agy-termux@<ver>)の最後の "@" より後ろ。tgz のパスなら空
  const spec = args.find((a) => a.includes('agy-termux')) || '';
  const at = spec.lastIndexOf('@');
  const ver = at > 0 && !spec.endsWith('.tgz') ? spec.slice(at + 1) : '';
  // --prefix が無いときの扱いは、旧来の動作に合わせて scenario 側で判定する(旧来の動作では置くときだけ必要)
  const prefixIdx = args.indexOf('--prefix');
  const prefix = prefixIdx >= 0 && args[prefixIdx + 1] ? path.resolve(args[prefixIdx + 1]) : '';
  const dest = path.join(prefix, 'lib', 'node_modules', '@bash0816', 'agy-termux');
  const link = path.join(prefix, 'bin', 'agy');
  // fixture は FAKE_NPM_PKG_<ver の . を _ に置換した名前> があればそれ、無ければ FAKE_NPM_NEW_PKG
  const fixture = process.env['FAKE_NPM_PKG_' + ver.replace(/\./g, '_')] || process.env.FAKE_NPM_NEW_PKG || '';

  const needFixture = () => {
    if (!fixture) {
      process.stderr.write(`fake npm: no fixture for ${ver}\n`);
      process.exit(99);
    }
  };
  // 標準位置のパッケージを fixture に置き換える
  const place = () => {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(fixture, dest, { recursive: true });
  };
  // <prefix>/bin/agy を絶対パスの symlink(<dest>/bin/agy.js)にする。既存の link は置き換える
  const linkBin = () => {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(dest, 'bin', 'agy.js'), link);
  };
  const unlinkBin = () => fs.rmSync(link, { force: true });
  // fixture を置いてから after で壊し方を加え、code で終了する
  const install = (after, code) => {
    needFixture();
    place();
    after();
    process.exit(code);
  };

  const seqEnv = process.env.FAKE_NPM_SEQUENCE;
  if (seqEnv === undefined) {
    const code = Number(process.env.MOCK_NPM_INSTALL_EXIT || 0);
    if (code === 0 && fixture && prefix) place();
    process.exit(code);
  }
  if (!prefix) {
    process.stderr.write('fake npm: --prefix がありません\n');
    process.exit(2);
  }

  const seq = seqEnv.split(',').map((s) => s.trim()).filter(Boolean);
  const countFile = log ? log + '.count' : '';
  const n = countFile && fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) || 0 : 0;
  if (countFile) fs.writeFileSync(countFile, String(n + 1));
  const scenario = seq[Math.min(n, seq.length - 1)];

  const scenarios = {
    swap: () => install(linkBin, 0),
    ok: () => install(linkBin, 0),
    swap_nolink: () => install(unlinkBin, 0),
    fail_after_swap: () => install(linkBin, 1),
    broken_missing_file: () => install(() => {
      fs.rmSync(path.join(dest, 'lib', 'binary-cache.js'));
      linkBin();
    }, 1),
    broken_no_link: () => install(unlinkBin, 1),
    broken_truncated_config: () => install(() => {
      fs.truncateSync(path.join(dest, 'config', 'agy-verified-versions.json'), 20);
      linkBin();
    }, 1),
    broken_truncated_shim: () => install(() => {
      fs.truncateSync(path.join(dest, 'lib', 'native', 'sigsys_shim.so'), 64);
      linkBin();
    }, 1),
    broken_empty_bin: () => install(() => {
      fs.writeFileSync(path.join(dest, 'bin', 'agy.js'), '');
      linkBin();
    }, 1),
    fail_broken: () => install(() => {
      const mode = process.env.FAKE_NPM_BROKEN_MODE || 'missing_file';
      if (mode === 'no_link') unlinkBin();
      else if (mode === 'truncated_config') fs.truncateSync(path.join(dest, 'config', 'agy-verified-versions.json'), 20);
      else if (mode === 'truncated_shim') fs.truncateSync(path.join(dest, 'lib', 'native', 'sigsys_shim.so'), 64);
      else if (mode === 'empty_bin') fs.writeFileSync(path.join(dest, 'bin', 'agy.js'), '');
      else fs.rmSync(path.join(dest, 'lib', 'binary-cache.js'));
      if (mode !== 'no_link') linkBin();
    }, 1),
    ignore_term: () => {
      // SIGTERM を無視して 120 秒待つ(何も置かない)。SIGKILL でしか止まらない相手の再現
      process.on('SIGTERM', () => {});
      setTimeout(() => process.exit(0), 120000);
    },
    hold_pipe: () => {
      needFixture();
      // stdio を握ったまま残る孫プロセス。pid は <NPM_LOG>.pid に残す
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
        detached: true,
        stdio: 'inherit',
      });
      child.unref();
      if (countFile) fs.writeFileSync(log + '.pid', String(child.pid));
      install(linkBin, 0);
    },
    enospc: () => {
      process.stderr.write('npm ERR! code ENOSPC\nnpm ERR! nospc ENOSPC: no space left on device, write\n');
      process.exit(1);
    },
    eacces: () => {
      process.stderr.write('npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir\n');
      process.exit(1);
    },
    slow_ok: () => {
      needFixture();
      // FAKE_NPM_SLOW_MS(既定 6000ms)の間は何も出さずに待つ
      setTimeout(() => install(linkBin, 0), Number(process.env.FAKE_NPM_SLOW_MS || 6000));
    },
  };
  if (!Object.hasOwn(scenarios, scenario)) {
    process.stderr.write(`fake npm: unknown scenario ${scenario}\n`);
    process.exit(98);
  }
  scenarios[scenario]();
}

// 偽 npm(Node スクリプト)を <dir>/fakebin/npm に作り、fakebin のパスを返す
function makeFakeNpm(dir) {
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const npm = path.join(bin, 'npm');
  fs.writeFileSync(npm, scriptOf(fakeNpmMain));
  fs.chmodSync(npm, 0o755);
  return bin;
}

// 偽 tar の本体。FAKE_TAR_MODE が無ければ REAL_TAR に同じ引数で委譲し、出力と終了コードをそのまま返す。
// 設定されていれば、モードに応じた stderr を出して exit 2 にする(unknown は何も出さない)
function fakeTarMain() {
  'use strict';
  const { spawnSync } = require('node:child_process');
  const mode = process.env.FAKE_TAR_MODE;
  if (mode === undefined) {
    const r = spawnSync(REAL_TAR, process.argv.slice(2), { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  const messages = {
    enospc: [
      'tar: antigravity: Wrote only 4096 of 10240 bytes',
      'tar: antigravity: Cannot write: No space left on device',
      'tar: Error is not recoverable: exiting now',
    ],
    edquot: [
      'tar: antigravity: Cannot write: Disk quota exceeded',
      'tar: Error is not recoverable: exiting now',
    ],
    eacces: [
      'tar: antigravity: Cannot open: Permission denied',
      'tar: Error is not recoverable: exiting now',
    ],
    eperm: [
      'tar: antigravity: Cannot open: Operation not permitted',
      'tar: Error is not recoverable: exiting now',
    ],
    corrupt: [
      'gzip: stdin: unexpected end of file',
      'tar: Unexpected EOF in archive',
      'tar: Error is not recoverable: exiting now',
    ],
    generic: ['tar: Error is not recoverable: exiting now'],
  };
  if (Object.hasOwn(messages, mode)) process.stderr.write(messages[mode].join('\n') + '\n');
  process.exit(2);
}

// 偽 tar を <dir>/faketar/tar に作り、faketar のパスを返す
function makeFakeTar(dir) {
  const bin = path.join(dir, 'faketar');
  fs.mkdirSync(bin, { recursive: true });
  const tar = path.join(bin, 'tar');
  fs.writeFileSync(tar, scriptOf(fakeTarMain, 'const REAL_TAR = ' + JSON.stringify(REAL_TAR) + ';\n'));
  fs.chmodSync(tar, 0o755);
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

// runAgy / runAgyAsync が共通で使う env。PATH は fakeTarDir(あれば)→ fakeBin → 親の PATH の順
function baseEnv(sb) {
  const base = {
    PATH: [sb.fakeTarDir, sb.fakeBin, process.env.PATH].filter(Boolean).join(':'),
    HOME: sb.home,
    NPM_LOG: sb.npmLog,
    MOCK_HTTPS_LOG: sb.mockLog,
    MOCK_VA_BITS: '48',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    NODE_OPTIONS: `--require ${MOCK}`,
  };
  if (sb.prefix) base.PREFIX = sb.prefix;
  if (sb.loaderLog) base.LOADER_LOG = sb.loaderLog;
  return base;
}

// 実 bin/agy.js を子プロセスとして起動する。mock-https は NODE_OPTIONS で読み込むため、
// agy.js が更に起動する子プロセス(update の --sync-binary-only)にも継承される。
// env は新しく組み立てるため、親の AGY_* / MOCK_* / FAKE_* は引き継がない。
// MOCK_VA_BITS の既定は '48'(呼び出し側の env で上書き可能)
// sb は { agy, home, fakeBin, npmLog, mockLog, prefix?, loaderLog?, fakeTarDir? } を持つ
function runAgy(sb, args = [], env = {}, agy = sb.agy) {
  const r = spawnSync(process.execPath, [agy, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...baseEnv(sb), ...env },
  });
  // timeout などで起動自体が失敗したときは、その時点の出力を残して原因を調べられるようにする
  if (r.error) {
    throw new Error('agy の実行が失敗しました: ' + r.error.code + ' (timeout ' + 30000 + 'ms) stdout=' + JSON.stringify(String(r.stdout || '').slice(-500)) + ' stderr=' + JSON.stringify(String(r.stderr || '').slice(-500)));
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// runAgy の非同期版。sb.agy を子プロセスとして起動し、出力を到着順に events へ記録する。
// 各 event の t は起動からの ms。stdin は stdinText があれば書いて閉じ、無ければそのまま閉じる。
// timeoutMs を過ぎたら SIGKILL して timedOut を立てる(reject はせず resolve する)。
// 結果は { status, signal, stdout, stderr, events, maxGapMs, durationMs, timedOut } で、
// maxGapMs は 起動→最初の event、event 同士の間、最後の event→終了 の最大間隔。
// timedOut のときは failureMessage に直近の出力(末尾 500 文字)を入れる
function runAgyAsync(sb, args = [], env = {}, opts = {}) {
  const { stdin, timeoutMs = 60000 } = opts;
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const child = spawn(process.execPath, [sb.agy, ...args], { env: { ...baseEnv(sb), ...env } });
  const events = [];
  let stdout = '';
  let stderr = '';
  const record = (stream) => (chunk) => {
    const text = chunk.toString('utf8');
    events.push({ t: now(), stream, text });
    if (stream === 'stdout') stdout += text;
    else stderr += text;
  };
  child.stdout.on('data', record('stdout'));
  child.stderr.on('data', record('stderr'));
  // 子が先に終了すると stdin への書き込みが EPIPE になるため、そのエラーは無視する
  child.stdin.on('error', () => {});
  if (stdin && typeof stdin.pipe === 'function') stdin.pipe(child.stdin);
  else child.stdin.end(stdin);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let exitedAt = null;
    let grace = null;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      clearTimeout(grace);
      const endAt = exitedAt ?? now();
      const marks = [0, ...events.map((e) => e.t), endAt];
      let maxGapMs = 0;
      for (let i = 1; i < marks.length; i++) maxGapMs = Math.max(maxGapMs, marks[i] - marks[i - 1]);
      const out = { status, signal, stdout, stderr, events, maxGapMs, durationMs: endAt, timedOut };
      if (timedOut) {
        const tail = events.map((e) => `[${e.stream}] ${e.text}`).join('').slice(-500);
        out.failureMessage = `agy が ${timeoutMs}ms 以内に終わらず SIGKILL しました。直近の出力(末尾 500 文字): ${JSON.stringify(tail)}`;
      }
      resolve(out);
    };
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      stderr += err.message;
      finish(null, null);
    });
    child.on('exit', (status, signal) => {
      exitedAt = now();
      // 孫プロセスが stdio を握ったままだと close が来ないため、少し待ってから打ち切る
      grace = setTimeout(() => finish(status, signal), 1000);
    });
    child.on('close', (status, signal) => finish(status, signal));
  });
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
  makeFakeTar,
  writeConsent,
  runAgy,
  runAgyAsync,
  readLog,
  listDir,
};
