'use strict';

// scripts/lib/test-run-exec.js の単体テスト
// 検証専用。配布物(bin/ lib/ config/)には含めない

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runTestProcess } = require('../scripts/lib/test-run-exec.js');

const dirs = [];

// 一時ディレクトリを作り、後始末の対象に登録する
function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-run-exec-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 環境変数を一時的に設定し、関数の終了後に元へ戻す
async function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

// pid ファイルに書かれた孫プロセスを SIGKILL する(無ければ何もしない)
function killFromPidFile(pidFile) {
  let text = '';
  try {
    text = fs.readFileSync(pidFile, 'utf8');
  } catch {
    return;
  }
  const pid = Number.parseInt(text, 10);
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 既に終了していれば無視する
  }
}

// 孫プロセスの中身。自分の pid を pid ファイルへ書き、30 秒待って終了する
const GRAND_SCRIPT =
  "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)";

// 孫を別プロセスグループ(detached)で起動し、stdio は継承して外側の pipe を保持させる。
// pid ファイルが現れるまで待つコードを返す(plain script の先頭に埋め込む)
function grandchildSpawnCode(pidFile) {
  return [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const pidFile = ${JSON.stringify(pidFile)};`,
    `const grand = spawn(process.execPath, ['-e', ${JSON.stringify(GRAND_SCRIPT)}, pidFile], { detached: true, stdio: 'inherit' });`,
    'grand.unref();',
    'const deadline = Date.now() + 10000;',
    "while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8') === '') {",
    '  if (Date.now() > deadline) process.exit(2);',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);',
    '}',
    '',
  ].join('\n');
}

// plain script を書き、そのパスを返す(node --test を介さず、node で直接実行する)
function writePlainScript(dir, name, code) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, code);
  return file;
}

test('正常: 1 件 pass の fixture は exitCode 0 で pipeAbandoned は false', async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, 'pass.test.js'), "const { test } = require('node:test');\ntest('one', () => {});\n");

  const result = await withEnv({ NODE_TEST_CONTEXT: 'child-v8' }, () =>
    runTestProcess({ cwd: dir, files: ['pass.test.js'] })
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.pipeAbandoned, false);
  assert.match(result.stdout, /^# tests 1$/m);
  assert.match(result.stdout, /^# pass 1$/m);
});

test('NODE_TEST_CONTEXT は子から除去され、他の環境変数は引き継がれる', async () => {
  const dir = makeDir();
  const script = writePlainScript(
    dir,
    'env-plain.js',
    "process.stdout.write(JSON.stringify({ ctx: process.env.NODE_TEST_CONTEXT === undefined ? 'undefined' : process.env.NODE_TEST_CONTEXT, marker: process.env.AGY_TEST_MARKER ?? 'undefined' }));\n"
  );

  const result = await withEnv({ NODE_TEST_CONTEXT: 'child-v8', AGY_TEST_MARKER: '1' }, () =>
    runTestProcess({ cwd: dir, files: [], args: [script] })
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ctx: 'undefined', marker: '1' });
});

test('タイムアウト: 制限時間で止まり、子は残らず、pipeAbandoned は false', async () => {
  const dir = makeDir();
  fs.writeFileSync(
    path.join(dir, 'hang.test.js'),
    [
      "const { test } = require('node:test');",
      'setInterval(() => {}, 1000);',
      "test('hang', () => new Promise(() => {}));",
      '',
    ].join('\n')
  );

  const started = Date.now();
  const result = await withEnv({ NODE_TEST_CONTEXT: 'child-v8' }, () =>
    runTestProcess({ cwd: dir, files: ['hang.test.js'], timeoutMs: 3000 })
  );
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 30000, `経過が長すぎる: ${elapsed} ms`);
  assert.equal(result.pipeAbandoned, false);
  assert.equal(typeof result.pid, 'number');

  // 子が残っていないこと(最大 2 秒、100ms 間隔で確認)
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    try {
      process.kill(result.pid, 0);
      await sleep(100);
    } catch (err) {
      assert.equal(err.code, 'ESRCH');
      gone = true;
    }
  }
  assert.equal(gone, true, '解決後も子プロセスが残っている');
});

test('pipe を保持する孫(別プロセスグループ): pipeAbandoned は true で解決する', async () => {
  const dir = makeDir();
  const pidFile = path.join(dir, 'grand.pid');
  // 親は孫を起動して pid ファイルを確認してから exit 0 する。孫は stdio 継承で外側 pipe を保持する
  const script = writePlainScript(dir, 'grand-plain.js', grandchildSpawnCode(pidFile) + 'process.exit(0);\n');

  try {
    const started = Date.now();
    const result = await withEnv({ NODE_TEST_CONTEXT: 'child-v8' }, () =>
      runTestProcess({ cwd: dir, files: [], args: [script], pipeGraceMs: 1000 })
    );
    const elapsed = Date.now() - started;

    assert.equal(result.pipeAbandoned, true);
    assert.ok(elapsed < 30000, `経過が長すぎる: ${elapsed} ms`);
    assert.equal(result.exitCode, 0);
  } finally {
    killFromPidFile(pidFile);
  }
});

test('タイムアウトと孫の pipe 保持が重なる場合も、timedOut と pipeAbandoned が両方 true', async () => {
  const dir = makeDir();
  const pidFile = path.join(dir, 'grand.pid');
  // 親は孫を起動した後、無限に待つ。制限時間で親のグループが止まり、孫が pipe を保持したままになる
  const script = writePlainScript(
    dir,
    'grand-hang-plain.js',
    grandchildSpawnCode(pidFile) + 'setInterval(() => {}, 1000);\n'
  );

  try {
    const started = Date.now();
    const result = await withEnv({ NODE_TEST_CONTEXT: 'child-v8' }, () =>
      runTestProcess({ cwd: dir, files: [], args: [script], timeoutMs: 8000, pipeGraceMs: 1000 })
    );
    const elapsed = Date.now() - started;

    assert.equal(result.timedOut, true);
    assert.equal(result.pipeAbandoned, true);
    assert.ok(elapsed < 40000, `経過が長すぎる: ${elapsed} ms`);
  } finally {
    killFromPidFile(pidFile);
  }
});

test('spawn 失敗: 存在しない nodeBin でも reject せず、pid null・exitCode null で解決する', async () => {
  const dir = makeDir();
  const missing = path.join(dir, 'no-such-node-binary');

  const result = await runTestProcess({ cwd: dir, files: [], nodeBin: missing });

  assert.equal(result.exitCode, null);
  assert.equal(result.pid, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.pipeAbandoned, false);
  assert.ok(result.stderr.length > 0, 'stderr にエラー内容が入っていない');
});
