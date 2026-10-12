'use strict';

// scripts/lib/test-run-verify.js の検証
// 実際のテストは走らせない。run / copy は偽物を注入する
// 一時ディレクトリの接頭辞は agy-t5d-test-（実走後の agy-vindep- 残留チェックを汚さないため）

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listTestFiles, verifyVersionIndependence } = require('../scripts/lib/test-run-verify');

const ALL_FILES = ['test/a.test.js', 'test/b.test.js', 'bin/agy.test.js'];
const VERSION = '9.9.9';

let base;
let root;
let copyRoot;
let copyBad;
let rootNoBin;
let rootBinOnly;
let rootEmpty;

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-t5d-test-'));
  root = path.join(base, 'root');
  copyRoot = path.join(base, 'copy');
  copyBad = path.join(base, 'bad');
  rootNoBin = path.join(base, 'nobin');
  rootBinOnly = path.join(base, 'binonly');
  rootEmpty = path.join(base, 'empty');

  for (const dir of [root, copyRoot]) {
    touch(path.join(dir, 'test', 'a.test.js'));
    touch(path.join(dir, 'test', 'b.test.js'));
    touch(path.join(dir, 'test', 'helper.js'));
    touch(path.join(dir, 'bin', 'agy.test.js'));
  }
  touch(path.join(copyBad, 'test', 'a.test.js'));
  touch(path.join(rootNoBin, 'test', 'a.test.js'));
  touch(path.join(rootNoBin, 'test', 'helper.js'));
  touch(path.join(rootBinOnly, 'bin', 'agy.test.js'));
  fs.mkdirSync(rootEmpty, { recursive: true });
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// TAP の集計行を作る（既定は 3 件すべて成功）
function tapStdout(overrides = {}) {
  const counts = { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...overrides };
  return Object.entries(counts)
    .map(([key, value]) => `# ${key} ${value}`)
    .join('\n') + '\n';
}

// 成功した 1 回分の生の実行結果
function rawRun(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    pipeAbandoned: false,
    stdout: tapStdout(),
    stderr: '',
    pid: 1,
    ...overrides,
  };
}

// 偽の run。呼び出しを記録し、decide(opts) の結果を返す（decide が投げれば reject になる）
function fakeRun(decide = () => rawRun()) {
  const calls = [];
  const run = async (opts) => {
    calls.push({ cwd: opts.cwd, files: opts.files, timeoutMs: opts.timeoutMs });
    return decide(opts);
  };
  return { run, calls };
}

// 偽の copy。呼び出しと cleanup の回数を記録する
function fakeCopy(dir, { throws = false } = {}) {
  const state = { calls: [], cleanups: 0 };
  const copy = async (repoRoot, opts) => {
    state.calls.push({ repoRoot, opts });
    if (throws) throw new Error('複製に失敗（テスト用）');
    return {
      dir,
      files: listTestFiles(dir),
      cleanup: () => {
        state.cleanups += 1;
      },
    };
  };
  return { copy, state };
}

function makeLog() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)) };
}

function lastLine(lines) {
  return lines[lines.length - 1];
}

test('listTestFiles は helper.js を除外し、ソートして bin/agy.test.js を末尾に付ける', () => {
  assert.deepEqual(listTestFiles(root), ALL_FILES);
});

test('listTestFiles は bin/agy.test.js が無ければ含めない', () => {
  assert.deepEqual(listTestFiles(rootNoBin), ['test/a.test.js']);
});

test('listTestFiles は test が無く bin/agy.test.js だけあれば、それだけを返す', () => {
  assert.deepEqual(listTestFiles(rootBinOnly), ['bin/agy.test.js']);
});

test('listTestFiles は test も bin も無ければ [] を返す', () => {
  assert.deepEqual(listTestFiles(rootEmpty), []);
});

test('全て成功なら ok:true、failures は空、通常と版独立の両方が 1 回ずつ走り、複製は後始末される', async () => {
  const { run, calls } = fakeRun();
  const { copy, state } = fakeCopy(copyRoot);
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: root, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cwd, root);
  assert.equal(calls[1].cwd, copyRoot);
  assert.deepEqual(calls[0].files, ALL_FILES);
  assert.deepEqual(calls[1].files, ALL_FILES);
  assert.equal(calls[0].timeoutMs, 1000);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].repoRoot, root);
  assert.equal(state.calls[0].opts.version, VERSION);
  assert.equal(state.cleanups, 1);
  assert.ok(lines.includes('=== 通常実行 ==='));
  assert.ok(lines.includes(`=== 版独立実行（version ${VERSION}）===`));
  assert.equal(lastLine(lines), 'OK: 通常実行・版独立実行とも 3 件すべて成功');
});

test('通常実行が exitCode 1 なら normal:exit_nonzero を入れ、版独立実行も行う', async () => {
  const { run, calls } = fakeRun((opts) => (opts.cwd === root ? rawRun({ exitCode: 1 }) : rawRun()));
  const { copy, state } = fakeCopy(copyRoot);
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: root, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['normal:exit_nonzero']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cwd, copyRoot);
  assert.equal(state.cleanups, 1);
  assert.equal(lastLine(lines), 'FAIL: normal:exit_nonzero');
});

test('版独立実行の出力に todo が含まれれば copy:todo_nonzero を入れる', async () => {
  const { run } = fakeRun((opts) => (opts.cwd === copyRoot ? rawRun({ stdout: tapStdout({ todo: 1 }) }) : rawRun()));
  const { copy } = fakeCopy(copyRoot);
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: root, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['copy:todo_nonzero']);
  assert.equal(lastLine(lines), 'FAIL: copy:todo_nonzero');
});

test('両方成功でも件数が違えば compare:tests_mismatch を入れる', async () => {
  const { run } = fakeRun((opts) =>
    opts.cwd === copyRoot ? rawRun({ stdout: tapStdout({ tests: 4, pass: 4 }) }) : rawRun(),
  );
  const { copy } = fakeCopy(copyRoot);
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: root, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['compare:tests_mismatch']);
  assert.equal(lastLine(lines), 'FAIL: compare:tests_mismatch');
});

test('通常実行の pipeAbandoned なら normal:pipe_abandoned を入れる', async () => {
  const { run } = fakeRun((opts) => (opts.cwd === root ? rawRun({ pipeAbandoned: true }) : rawRun()));
  const { copy } = fakeCopy(copyRoot);
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: root, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['normal:pipe_abandoned']);
  assert.equal(lastLine(lines), 'FAIL: normal:pipe_abandoned');
});

test('両方の実行が pipeAbandoned なら normal:pipe_abandoned と copy:pipe_abandoned の両方を入れる', async () => {
  const { run } = fakeRun(() => rawRun({ pipeAbandoned: true }));
  const { copy } = fakeCopy(copyRoot);
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: root, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['normal:pipe_abandoned', 'copy:pipe_abandoned']);
  assert.equal(lastLine(lines), 'FAIL: normal:pipe_abandoned, copy:pipe_abandoned');
});

test('copy が例外を投げれば copy:setup_failed を入れ、run は 1 回だけ、cleanup は呼ばれない', async () => {
  const { run, calls } = fakeRun();
  const { copy, state } = fakeCopy(copyRoot, { throws: true });
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: root, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['copy:setup_failed']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, root);
  assert.equal(state.cleanups, 0);
  assert.equal(lastLine(lines), 'FAIL: copy:setup_failed');
});

test('複製のテスト一覧が違えば files:list_mismatch を入れ、版独立実行はスキップし、cleanup は呼ばれる', async () => {
  const { run, calls } = fakeRun();
  const { copy, state } = fakeCopy(copyBad);
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: root, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['files:list_mismatch']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, root);
  assert.equal(state.cleanups, 1);
  assert.equal(lastLine(lines), 'FAIL: files:list_mismatch');
});

test('複製側の run が reject しても投げずに copy:run_threw を入れ、cleanup は呼ばれる', async () => {
  const { run } = fakeRun((opts) => {
    if (opts.cwd === copyRoot) throw new Error('複製側の実行に失敗（テスト用）');
    return rawRun();
  });
  const { copy, state } = fakeCopy(copyRoot);
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: root, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['copy:run_threw']);
  assert.equal(state.cleanups, 1);
  assert.equal(lastLine(lines), 'FAIL: copy:run_threw');
});

test('通常側の run が reject しても投げずに normal:run_threw を入れ、版独立実行は続けて行う', async () => {
  const { run, calls } = fakeRun((opts) => {
    if (opts.cwd === root) throw new Error('通常側の実行に失敗（テスト用）');
    return rawRun();
  });
  const { copy, state } = fakeCopy(copyRoot);
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: root, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['normal:run_threw']);
  assert.equal(calls.length, 2);
  assert.equal(state.cleanups, 1);
  assert.equal(lastLine(lines), 'FAIL: normal:run_threw');
});

test('空の root では files:empty を返し、run も copy も呼ばれない', async () => {
  const { run, calls } = fakeRun();
  const { copy, state } = fakeCopy(copyRoot);
  const { lines, log } = makeLog();

  const result = await verifyVersionIndependence({ repoRoot: rootEmpty, timeoutMs: 1000, log, run, copy });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['files:empty']);
  assert.equal(calls.length, 0);
  assert.equal(state.calls.length, 0);
  assert.equal(lastLine(lines), 'FAIL: files:empty');
});
