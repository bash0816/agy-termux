'use strict';

// install 失敗時の自動復旧(配置の読み直しと、元の版の入れ直しを1回だけ)を偽 deps で検証する
// 実 npm・実ネットワーク・実ファイルは使わない
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runUpdate, classifyInstallFailure } = require('../lib/audited-update');

const PREFIX = '/p';
const PKG = path.join('/p', 'lib', 'node_modules', '@bash0816', 'agy-termux');
const FAIL = { ok: false, code: 1, signal: null, timedOut: false, stderrTail: 'npm ERR! boom' };
const OK = { ok: true, code: 0, signal: null, timedOut: false, stderrTail: '' };

// installResults は runInstall の呼び出しごとに順に返す(尽きたら例外にして余分な呼び出しを検出する)
// placements は checkPlacement の呼び出しごとに順に complete の値を返す
function setup({ installResults, placements, freeMB = 1234 }) {
  const outLines = [];
  const errLines = [];
  const calls = { install: [], placement: [], freeMB: [] };
  const installQueue = installResults.slice();
  const placementQueue = placements.slice();
  const deps = {
    pkgVersion: '1.2.0',
    url: 'https://example.invalid/agy.json',
    urlError: null,
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    fetchAudited: async () => '1.2.3',
    npmViewLatest: async () => ({ ok: true, version: '1.2.3' }),
    detectPrefix: () => PREFIX,
    realFilePath: () => '/p/bin/agy',
    preflight: async () => ({ ok: true }),
    runInstall: async (prefix, version, opts) => {
      calls.install.push({ prefix, version, opts });
      if (installQueue.length === 0) throw new Error('runInstall が想定より多く呼ばれました');
      return installQueue.shift();
    },
    checkPlacement: (pkgDir, prefix, expectedVersion) => {
      calls.placement.push({ pkgDir, prefix, expectedVersion });
      if (placementQueue.length === 0) throw new Error('checkPlacement が想定より多く呼ばれました');
      const complete = placementQueue.shift();
      return { complete, version: expectedVersion, problems: complete ? [] : ['missing'] };
    },
    freeMB: (p) => {
      calls.freeMB.push(p);
      return freeMB;
    },
  };
  return { deps, outLines, errLines, calls, installQueue, placementQueue };
}

const KEEP_MSG = '[agy] 更新に失敗しました(npm ERR! boom)。バージョンは 1.2.0 のままです。もう一度 agy update を実行してください';

// (a) install 失敗 + 元の版 A が無事
test('(a) install 失敗で A が無事なら、表示して code 1。runInstall は1回だけ', async () => {
  const t = setup({ installResults: [FAIL], placements: [true] });
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 1);
  assert.equal(r.installed, false);
  assert.equal(r.pkgDir, null);
  assert.equal(r.from, '1.2.0');
  assert.equal(r.to, '1.2.3');
  assert.equal(r.aud, '1.2.3');
  assert.equal(r.notice, null);
  assert.equal(t.calls.install.length, 1);
  assert.equal(t.calls.install[0].version, '1.2.3');
  assert.equal(t.calls.install[0].opts.timeoutMs, 120000);
  assert.deepEqual(t.calls.placement.map((c) => c.expectedVersion), ['1.2.0']);
  assert.equal(t.calls.placement[0].pkgDir, PKG);
  assert.ok(t.errLines.includes(KEEP_MSG), 'A のままの案内が出る: ' + t.errLines.join(' | '));
  assert.deepEqual(t.outLines, []);
});

// (b) install 失敗 + A 不完全 + 新しい版 B は完全
test('(b) install 失敗で A 不完全・B 完全なら、installed true。表示なし、再 install なし', async () => {
  const t = setup({ installResults: [FAIL], placements: [false, true] });
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 0);
  assert.equal(r.installed, true);
  assert.equal(r.pkgDir, PKG);
  assert.equal(r.from, '1.2.0');
  assert.equal(r.to, '1.2.3');
  assert.equal(r.aud, '1.2.3');
  assert.equal(r.notice, null);
  assert.equal(r.installWarning, 'npm ERR! boom');
  assert.equal(t.calls.install.length, 1, '再 install しない');
  assert.deepEqual(t.calls.placement.map((c) => c.expectedVersion), ['1.2.0', '1.2.3']);
  assert.deepEqual(t.outLines, []);
  const failureLines = t.errLines.filter((s) => s.includes('更新に失敗') || s.includes('不完全'));
  assert.deepEqual(failureLines, [], '失敗・不完全の表示は出ない');
});

// (c-1) 両方不完全 → A を1回だけ入れ直して、A が無事なら (a) の表示で code 1
test('(c-1) 両方不完全で入れ直しが成功し A が無事なら、(a) の表示で code 1。install は2回だけ', async () => {
  const t = setup({ installResults: [FAIL, OK], placements: [false, false, true] });
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 1);
  assert.equal(r.installed, false);
  assert.equal(r.pkgDir, null);
  assert.equal(r.from, '1.2.0');
  assert.equal(r.to, '1.2.3');
  assert.equal(t.calls.install.length, 2, '合計2回。3回目は無い(queue が空なら例外)');
  assert.equal(t.calls.install[0].version, '1.2.3');
  assert.equal(t.calls.install[0].opts.timeoutMs, 120000);
  assert.equal(t.calls.install[1].version, '1.2.0');
  assert.equal(t.calls.install[1].opts.timeoutMs, 120000);
  assert.deepEqual(t.calls.placement.map((c) => c.expectedVersion), ['1.2.0', '1.2.3', '1.2.0']);
  assert.ok(t.errLines.includes('[agy] パッケージが不完全です。元の版 1.2.0 を入れ直します...'));
  assert.ok(t.errLines.includes(KEEP_MSG), '(a) と同じ表示: ' + t.errLines.join(' | '));
  assert.equal(t.placementQueue.length, 0);
  assert.equal(t.installQueue.length, 0);
});

// (c-2) 入れ直しも失敗 → 最終案内2行と code 1
const C2_CASES = [
  {
    name: 'ENOSPC(freeMB あり)',
    rr: { ok: false, code: 1, signal: null, timedOut: false, stderrTail: 'ENOSPC: no space left on device' },
    freeMB: 1234,
    line1: '[agy] パッケージが不完全な状態です(元の版 1.2.0 の入れ直しも失敗しました: 空き容量が足りません(空き 約 1234 MB))。空きを作ってから、次のコマンドを実行してください:',
    freeMBCalled: true,
  },
  {
    name: 'EACCES(パス付き)',
    rr: { ok: false, code: 1, signal: null, timedOut: false, stderrTail: "npm ERR! EACCES: permission denied, mkdir '/p/lib/x'" },
    freeMB: 1234,
    line1: '[agy] パッケージが不完全な状態です(元の版 1.2.0 の入れ直しも失敗しました: 権限エラー(/p/lib/x))。権限を確認してから、次のコマンドを実行してください:',
    freeMBCalled: true,
  },
  {
    name: 'network(timedOut)',
    rr: { ok: false, code: null, signal: 'SIGTERM', timedOut: true, stderrTail: '' },
    freeMB: 1234,
    line1: '[agy] パッケージが不完全な状態です(元の版 1.2.0 の入れ直しも失敗しました: 通信できませんでした)。ネットワークを確認してから、次のコマンドを実行してください:',
    freeMBCalled: true,
  },
  {
    name: 'unknown(最後の行を含む)',
    rr: { ok: false, code: 2, signal: null, timedOut: false, stderrTail: 'first line\nnpm ERR! last line here\n' },
    freeMB: 1234,
    line1: '[agy] パッケージが不完全な状態です(元の版 1.2.0 の入れ直しも失敗しました: npm ERR! last line here)。次のコマンドを実行してください:',
    freeMBCalled: true,
  },
];

for (const c of C2_CASES) {
  test('(c-2) 入れ直しも失敗: ' + c.name + ' → 最終案内2行と code 1', async () => {
    const t = setup({ installResults: [FAIL, c.rr], placements: [false, false, false], freeMB: c.freeMB });
    const r = await runUpdate(t.deps);
    assert.equal(r.code, 1);
    assert.equal(r.installed, false);
    assert.equal(r.pkgDir, null);
    assert.equal(r.from, '1.2.0');
    assert.equal(r.to, '1.2.3');
    assert.equal(r.aud, '1.2.3');
    assert.equal(r.notice, null);
    assert.equal(t.calls.install.length, 2, '合計2回。3回目は無い');
    assert.equal(t.calls.install[1].version, '1.2.0');
    assert.equal(t.calls.install[1].opts.timeoutMs, 120000);
    assert.deepEqual(t.calls.placement.map((p) => p.expectedVersion), ['1.2.0', '1.2.3', '1.2.0']);
    assert.ok(t.errLines.includes('[agy] パッケージが不完全です。元の版 1.2.0 を入れ直します...'));
    const n = t.errLines.length;
    assert.equal(t.errLines[n - 2], c.line1, '最終案内1行目: ' + t.errLines[n - 2]);
    assert.equal(t.errLines[n - 1], '  npm install -g --prefix /p @bash0816/agy-termux@1.2.0', '最終案内2行目');
    assert.equal(t.calls.freeMB.length > 0, c.freeMBCalled);
    assert.deepEqual(t.outLines, []);
  });
}

// 原因の優先順: 1 nospace > 2 perm > 3 network > 4 unknown
test('classifyInstallFailure: ENOSPC と EACCES が両方あれば nospace が優先される', () => {
  const r = classifyInstallFailure({ stderrTail: "EACCES: permission denied, mkdir '/a'\nENOSPC: no space" }, 10);
  assert.equal(r.kind, 'nospace');
});

test('classifyInstallFailure: ENOSPC / No space left は nospace。freeMB が数値なら空き容量を括弧で付ける', () => {
  assert.deepEqual(classifyInstallFailure({ stderrTail: 'ENOSPC: no space' }, 500), {
    kind: 'nospace',
    message: '空き容量が足りません(空き 約 500 MB)',
    remedy: '空きを作ってから',
  });
  assert.deepEqual(classifyInstallFailure({ stderrTail: 'write error: No space left on device' }, null), {
    kind: 'nospace',
    message: '空き容量が足りません',
    remedy: '空きを作ってから',
  });
  assert.equal(classifyInstallFailure({ stderrTail: 'enospc' }, undefined).message, '空き容量が足りません');
});

test('classifyInstallFailure: EACCES / EPERM / EROFS は perm。コード名を含む行のクォート内のパスを付ける', () => {
  assert.deepEqual(classifyInstallFailure({ stderrTail: "EACCES: permission denied, open '/a/b'" }, 1), {
    kind: 'perm',
    message: '権限エラー(/a/b)',
    remedy: '権限を確認してから',
  });
  assert.equal(classifyInstallFailure({ stderrTail: "eperm: operation not permitted, rename '/x y/z'" }, null).message, '権限エラー(/x y/z)');
  assert.equal(classifyInstallFailure({ stderrTail: 'EROFS: read-only file system' }, null).message, '権限エラー');
  assert.equal(classifyInstallFailure({ stderrTail: 'EPERM: failed' }, null).kind, 'perm');
  // コード名を含む行にパスが無ければ、別の行のパスは使わない
  assert.equal(classifyInstallFailure({ stderrTail: "some '/other' path\nEACCES denied" }, null).message, '権限エラー');
});

test('classifyInstallFailure: ETIMEDOUT / ENOTFOUND / EAI_AGAIN / ECONNRESET と timedOut は network', () => {
  const expected = {
    kind: 'network',
    message: '通信できませんでした',
    remedy: 'ネットワークを確認してから',
  };
  assert.deepEqual(classifyInstallFailure({ stderrTail: 'ETIMEDOUT' }, null), expected);
  assert.deepEqual(classifyInstallFailure({ stderrTail: 'getaddrinfo ENOTFOUND registry.npmjs.org' }, null), expected);
  assert.deepEqual(classifyInstallFailure({ stderrTail: 'eai_again' }, null), expected);
  assert.deepEqual(classifyInstallFailure({ stderrTail: 'read econnreset' }, null), expected);
  assert.deepEqual(classifyInstallFailure({ stderrTail: 'something else', timedOut: true }, null), expected);
  assert.deepEqual(classifyInstallFailure({ stderrTail: '', timedOut: true, signal: 'SIGTERM' }, null), expected);
});

test('classifyInstallFailure: それ以外は unknown。最後の非空行、無ければ signal、無ければ exit', () => {
  assert.deepEqual(classifyInstallFailure({ stderrTail: 'first\nlast line\n\n', code: 1, signal: null, timedOut: false }, null), {
    kind: 'unknown',
    message: 'last line',
    remedy: '',
  });
  assert.deepEqual(classifyInstallFailure({ stderrTail: '', code: null, signal: 'SIGKILL', timedOut: false }, null), {
    kind: 'unknown',
    message: 'signal SIGKILL',
    remedy: '',
  });
  assert.deepEqual(classifyInstallFailure({ stderrTail: '  \n\n', code: 3, signal: null, timedOut: false }, null), {
    kind: 'unknown',
    message: 'exit 3',
    remedy: '',
  });
  assert.deepEqual(classifyInstallFailure({ stderrTail: undefined, code: 7, signal: null, timedOut: false }, null), {
    kind: 'unknown',
    message: 'exit 7',
    remedy: '',
  });
});
