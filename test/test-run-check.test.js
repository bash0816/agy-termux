'use strict';

// scripts/lib/test-run-check.js の単体テスト
// 1. 合成文字列で parseTapSummary / evaluateRun / compareRuns の各判定を確かめる
// 2. 実 Node の --test を fixture に対して走らせ、実際の TAP 出力を判定して確かめる
// 一時ディレクトリは os.tmpdir() 配下に作り、テスト終了時に削除する

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { SUMMARY_KEYS, compareRuns, evaluateRun, parseTapSummary } = require('../scripts/lib/test-run-check');

const OK_SUMMARY = { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 };

// 集計行を組み立てる。values で値を、omit で欠落させるキーを、extra で追加行を指定する
function summaryText(values = {}, { omit = [], extra = [] } = {}) {
  const v = { ...OK_SUMMARY, ...values };
  const lines = SUMMARY_KEYS.filter((key) => !omit.includes(key)).map((key) => `# ${key} ${v[key]}`);
  return ['TAP version 13', ...lines, ...extra, ''].join('\n');
}

// 判定入力を組み立てる。既定は「正常終了・集計どおり全件 pass」
function run(overrides = {}) {
  return { exitCode: 0, signal: null, timedOut: false, stdout: summaryText(), ...overrides };
}

// 合成文字列: parseTapSummary

test('parseTapSummary: 正常な集計行を整数として読む', () => {
  assert.deepEqual(parseTapSummary(summaryText()), { ok: true, summary: OK_SUMMARY });
});

for (const key of SUMMARY_KEYS) {
  test(`parseTapSummary: ${key} の集計行が欠落すると summary_missing`, () => {
    assert.deepEqual(parseTapSummary(summaryText({}, { omit: [key] })), { ok: false, reason: 'summary_missing' });
  });
}

for (const key of SUMMARY_KEYS) {
  test(`parseTapSummary: ${key} の集計行が重複すると summary_duplicate`, () => {
    assert.deepEqual(parseTapSummary(summaryText({}, { extra: [`# ${key} 0`] })), {
      ok: false,
      reason: 'summary_duplicate',
    });
  });
}

test('parseTapSummary: 欠落と重複が両方あれば summary_duplicate を優先する', () => {
  assert.deepEqual(parseTapSummary(summaryText({}, { omit: ['todo'], extra: ['# tests 2'] })), {
    ok: false,
    reason: 'summary_duplicate',
  });
});

test('parseTapSummary: インデント付きの集計行は集計と見なさない(欠落扱い)', () => {
  assert.deepEqual(parseTapSummary(summaryText({}, { omit: ['tests'], extra: ['  # tests 2'] })), {
    ok: false,
    reason: 'summary_missing',
  });
});

test('parseTapSummary: インデント付きの重複行は無視し、正しい集計を読む', () => {
  assert.deepEqual(parseTapSummary(summaryText({}, { extra: ['  # tests 99', '    # fail 5'] })), {
    ok: true,
    summary: OK_SUMMARY,
  });
});

test('parseTapSummary: 前後に余計な文字がある行は集計と見なさない', () => {
  const extra = ['# pass 2 ', '# pass 2 extra', 'x # pass 2'];
  assert.deepEqual(parseTapSummary(summaryText({}, { omit: ['pass'], extra })), {
    ok: false,
    reason: 'summary_missing',
  });
});

test('parseTapSummary: 数値でない値・負の値は集計と見なさず summary_missing', () => {
  const extra = ['# tests abc', '# fail -1'];
  assert.deepEqual(parseTapSummary(summaryText({}, { omit: ['tests', 'fail'], extra })), {
    ok: false,
    reason: 'summary_missing',
  });
});

test('parseTapSummary: CRLF 改行でも正しく読む', () => {
  assert.deepEqual(parseTapSummary(summaryText().replace(/\n/g, '\r\n')), { ok: true, summary: OK_SUMMARY });
});

test('parseTapSummary: 空文字列や非文字列は summary_missing', () => {
  assert.deepEqual(parseTapSummary(''), { ok: false, reason: 'summary_missing' });
  assert.deepEqual(parseTapSummary(null), { ok: false, reason: 'summary_missing' });
});

// 合成文字列: evaluateRun の各判定

test('evaluateRun: 全件 pass なら ok', () => {
  assert.deepEqual(evaluateRun(run()), { ok: true, reason: null, summary: OK_SUMMARY });
});

test('evaluateRun: timedOut なら timeout(集計は返す)', () => {
  assert.deepEqual(evaluateRun(run({ timedOut: true })), { ok: false, reason: 'timeout', summary: OK_SUMMARY });
});

test('evaluateRun: signal があれば signal(集計は返す)', () => {
  assert.deepEqual(evaluateRun(run({ exitCode: null, signal: 'SIGTERM' })), {
    ok: false,
    reason: 'signal',
    summary: OK_SUMMARY,
  });
});

test('evaluateRun: 終了コードが 0 以外なら exit_nonzero(集計は返す)', () => {
  assert.deepEqual(evaluateRun(run({ exitCode: 1 })), { ok: false, reason: 'exit_nonzero', summary: OK_SUMMARY });
});

test('evaluateRun: tests が 0 なら no_tests(summary.tests は 0)', () => {
  const result = evaluateRun(run({ stdout: summaryText({ tests: 0, pass: 0 }) }));
  assert.deepEqual(result, {
    ok: false,
    reason: 'no_tests',
    summary: { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
  });
});

test('evaluateRun: todo が 1 以上なら todo_nonzero', () => {
  assert.deepEqual(evaluateRun(run({ stdout: summaryText({ todo: 1 }) })), {
    ok: false,
    reason: 'todo_nonzero',
    summary: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 1 },
  });
});

test('evaluateRun: skipped が 1 以上なら skipped_nonzero', () => {
  assert.deepEqual(evaluateRun(run({ stdout: summaryText({ pass: 1, skipped: 1 }) })), {
    ok: false,
    reason: 'skipped_nonzero',
    summary: { tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 },
  });
});

test('evaluateRun: cancelled が 1 以上なら cancelled_nonzero', () => {
  assert.deepEqual(evaluateRun(run({ stdout: summaryText({ pass: 1, cancelled: 1 }) })), {
    ok: false,
    reason: 'cancelled_nonzero',
    summary: { tests: 2, pass: 1, fail: 0, cancelled: 1, skipped: 0, todo: 0 },
  });
});

test('evaluateRun: fail が 1 以上なら fail_nonzero', () => {
  assert.deepEqual(evaluateRun(run({ stdout: summaryText({ pass: 1, fail: 1 }) })), {
    ok: false,
    reason: 'fail_nonzero',
    summary: { tests: 2, pass: 1, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
  });
});

test('evaluateRun: pass と tests が一致しなければ pass_mismatch', () => {
  assert.deepEqual(evaluateRun(run({ stdout: summaryText({ tests: 3, pass: 2 }) })), {
    ok: false,
    reason: 'pass_mismatch',
    summary: { tests: 3, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
  });
});

// 合成文字列: evaluateRun の判定順

test('evaluateRun: timedOut と exitCode≠0 が同時なら timeout', () => {
  assert.deepEqual(evaluateRun(run({ timedOut: true, exitCode: 1 })), {
    ok: false,
    reason: 'timeout',
    summary: OK_SUMMARY,
  });
});

test('evaluateRun: signal と exitCode≠0 が同時なら signal', () => {
  assert.deepEqual(evaluateRun(run({ exitCode: 1, signal: 'SIGKILL' })), {
    ok: false,
    reason: 'signal',
    summary: OK_SUMMARY,
  });
});

test('evaluateRun: exitCode≠0 かつ集計なしなら exit_nonzero(summary は null)', () => {
  assert.deepEqual(evaluateRun(run({ exitCode: 1, stdout: '' })), {
    ok: false,
    reason: 'exit_nonzero',
    summary: null,
  });
});

test('evaluateRun: exitCode 0 で集計が欠落していれば summary_missing(summary は null)', () => {
  assert.deepEqual(evaluateRun(run({ stdout: summaryText({}, { omit: ['pass'] }) })), {
    ok: false,
    reason: 'summary_missing',
    summary: null,
  });
});

test('evaluateRun: exitCode 0 で集計が重複していれば summary_duplicate(summary は null)', () => {
  assert.deepEqual(evaluateRun(run({ stdout: summaryText({}, { extra: ['# pass 2'] }) })), {
    ok: false,
    reason: 'summary_duplicate',
    summary: null,
  });
});

test('evaluateRun: tests が 0 でも todo が 1 なら no_tests(no_tests が todo_nonzero より先)', () => {
  assert.deepEqual(evaluateRun(run({ stdout: summaryText({ tests: 0, pass: 0, todo: 1 }) })), {
    ok: false,
    reason: 'no_tests',
    summary: { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 1 },
  });
});

test('evaluateRun: todo・skipped・fail が同時なら todo_nonzero が先', () => {
  assert.deepEqual(evaluateRun(run({ stdout: summaryText({ tests: 3, pass: 0, todo: 1, skipped: 1, fail: 1 }) })), {
    ok: false,
    reason: 'todo_nonzero',
    summary: { tests: 3, pass: 0, fail: 1, cancelled: 0, skipped: 1, todo: 1 },
  });
});

test('evaluateRun: fail と pass 不一致が同時なら fail_nonzero が先', () => {
  assert.deepEqual(evaluateRun(run({ stdout: summaryText({ tests: 3, pass: 1, fail: 1 }) })), {
    ok: false,
    reason: 'fail_nonzero',
    summary: { tests: 3, pass: 1, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
  });
});

// 合成文字列: compareRuns

const PASSED = evaluateRun(run());

test('compareRuns: 両方 ok で tests が同じなら ok', () => {
  assert.deepEqual(compareRuns(PASSED, evaluateRun(run())), { ok: true, reason: null });
});

test('compareRuns: 両方 ok で tests が違えば tests_mismatch', () => {
  const other = evaluateRun(run({ stdout: summaryText({ tests: 3, pass: 3 }) }));
  assert.deepEqual(compareRuns(PASSED, other), { ok: false, reason: 'tests_mismatch' });
});

test('compareRuns: a が失敗していれば run_failed', () => {
  assert.deepEqual(compareRuns(evaluateRun(run({ exitCode: 1 })), PASSED), { ok: false, reason: 'run_failed' });
});

test('compareRuns: b が失敗していれば run_failed', () => {
  assert.deepEqual(compareRuns(PASSED, evaluateRun(run({ timedOut: true }))), { ok: false, reason: 'run_failed' });
});

test('compareRuns: 両方失敗なら run_failed', () => {
  assert.deepEqual(
    compareRuns(evaluateRun(run({ exitCode: 1 })), evaluateRun(run({ timedOut: true }))),
    { ok: false, reason: 'run_failed' },
  );
});

// 実 Node の --test による fixture

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-check-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const FIXTURES = {
  pass: [
    "const { test } = require('node:test');",
    "test('a1', () => {});",
    "test('a2', () => {});",
    '',
  ].join('\n'),
  todo: [
    "const { test } = require('node:test');",
    "test('x', { todo: true }, () => {});",
    '',
  ].join('\n'),
  skip: [
    "const { test } = require('node:test');",
    "test('x', { skip: true }, () => {});",
    '',
  ].join('\n'),
  fail: [
    "const { test } = require('node:test');",
    "test('x', () => { throw new Error('意図的な失敗'); });",
    '',
  ].join('\n'),
};

function fixtureFile(name) {
  return path.join(ROOT, `${name}.test.js`);
}
for (const [name, source] of Object.entries(FIXTURES)) {
  fs.writeFileSync(fixtureFile(name), source);
}

// 親の node --test が設定する NODE_TEST_CONTEXT を取り除き、子が通常の TAP 出力をするようにする
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.NODE_TEST_CONTEXT;

// fixture を実 Node で走らせ、evaluateRun に渡せる形の結果を返す
function runFixture(name) {
  const r = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', fixtureFile(name)],
    { encoding: 'utf8', env: CHILD_ENV },
  );
  return { exitCode: r.status, signal: r.signal, timedOut: false, stdout: r.stdout };
}

test('fixture (a): 全 pass 2 件は ok', () => {
  assert.deepEqual(evaluateRun(runFixture('pass')), {
    ok: true,
    reason: null,
    summary: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
  });
});

test('fixture (b): todo を含むと todo_nonzero', () => {
  // pass の値は Node のバージョン差を避けるため assert しない
  const result = evaluateRun(runFixture('todo'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'todo_nonzero');
  const { tests, fail, skipped, cancelled, todo } = result.summary;
  assert.deepEqual({ tests, fail, skipped, cancelled, todo }, { tests: 1, fail: 0, skipped: 0, cancelled: 0, todo: 1 });
});

test('fixture (c): skip を含むと skipped_nonzero', () => {
  assert.deepEqual(evaluateRun(runFixture('skip')), {
    ok: false,
    reason: 'skipped_nonzero',
    summary: { tests: 1, pass: 0, fail: 0, cancelled: 0, skipped: 1, todo: 0 },
  });
});

test('fixture (d): 失敗 1 件は exit_nonzero', () => {
  assert.deepEqual(evaluateRun(runFixture('fail')), {
    ok: false,
    reason: 'exit_nonzero',
    summary: { tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
  });
});

// fixture (e)(テスト 0 件の空ファイル)は削除: Node は空ファイル自体を 1 件と数えるため、実 Node では 0 件を作れない。
// no_tests の判定は上の合成文字列のテストで検証する。
