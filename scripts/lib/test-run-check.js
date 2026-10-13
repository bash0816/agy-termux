'use strict';

// テスト実行結果(TAP 出力)の集計行を読み、合否を判定する小さなライブラリ
// 検証専用。配布物(bin/ lib/ config/)には含めない
// require しても副作用(出力・プロセス起動)は無い

// 集計として読むキー。各キーの集計行がちょうど 1 回ずつ現れることを要求する
const SUMMARY_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

// 集計行は行頭から始まる厳密な形のみ認める(インデントや前後の余計な文字がある行は無視する)
const SUMMARY_LINE = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/;

// stdout(TAP)から集計行を読む
// 戻り値: 成功 { ok: true, summary }、失敗 { ok: false, reason: 'summary_missing' | 'summary_duplicate' }
function parseTapSummary(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const counts = Object.fromEntries(SUMMARY_KEYS.map((key) => [key, 0]));
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = SUMMARY_LINE.exec(line);
    if (!match) continue;
    counts[match[1]] += 1;
    values[match[1]] = Number(match[2]);
  }
  // 欠落と重複が両方ある場合は重複を優先する
  if (SUMMARY_KEYS.some((key) => counts[key] >= 2)) return { ok: false, reason: 'summary_duplicate' };
  if (SUMMARY_KEYS.some((key) => counts[key] === 0)) return { ok: false, reason: 'summary_missing' };
  const summary = {};
  for (const key of SUMMARY_KEYS) summary[key] = values[key];
  return { ok: true, summary };
}

// 1 回のテスト実行結果を判定する
// 引数: { exitCode, signal, timedOut, stdout }
// 戻り値: { ok, reason, summary }。summary は集計を解析できれば失敗時も返す(解析不能なら null)
function evaluateRun({ exitCode, signal, timedOut, stdout } = {}) {
  const parsed = parseTapSummary(stdout);
  const summary = parsed.ok ? parsed.summary : null;
  const failed = (reason) => ({ ok: false, reason, summary });

  if (timedOut) return failed('timeout');
  if (signal) return failed('signal');
  if (exitCode !== 0) return failed('exit_nonzero');
  if (!parsed.ok) return { ok: false, reason: parsed.reason, summary: null };
  if (summary.tests <= 0) return failed('no_tests');
  if (summary.todo !== 0) return failed('todo_nonzero');
  if (summary.skipped !== 0) return failed('skipped_nonzero');
  if (summary.cancelled !== 0) return failed('cancelled_nonzero');
  if (summary.fail !== 0) return failed('fail_nonzero');
  if (summary.pass !== summary.tests) return failed('pass_mismatch');
  return { ok: true, reason: null, summary };
}

// 2 回の実行結果の件数が一致するかを比べる
// 引数は evaluateRun の戻り値
function compareRuns(a, b) {
  if (!a.ok || !b.ok) return { ok: false, reason: 'run_failed' };
  if (a.summary.tests !== b.summary.tests) return { ok: false, reason: 'tests_mismatch' };
  return { ok: true, reason: null };
}

module.exports = { SUMMARY_KEYS, parseTapSummary, evaluateRun, compareRuns };
