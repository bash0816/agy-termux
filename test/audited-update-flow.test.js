'use strict';

// runUpdate の流れを偽の deps で検証する。実 npm・実ネットワークは使わない
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runUpdate, createDeps } = require('../lib/audited-update');
const { makeKey } = require('../lib/notified');

// 既定の偽 deps。各テストは over で必要な差し替えだけ行う
function setup(over = {}) {
  const outLines = [];
  const errLines = [];
  const log = [];
  const calls = { npm: 0, preflight: 0, install: [], record: [], has: [] };
  const deps = {
    pkgVersion: '1.2.0',
    url: 'https://example.invalid/agy.json',
    urlError: null,
    out: (s) => outLines.push(s),
    err: (s) => {
      errLines.push(s);
      log.push('err:' + s);
    },
    fetchAudited: async () => '1.2.3',
    npmViewLatest: async () => {
      calls.npm++;
      log.push('npm');
      return { ok: true, version: '1.2.3' };
    },
    detectPrefix: () => '/p',
    realFilePath: () => '/p/bin/agy',
    preflight: async () => {
      calls.preflight++;
      return { ok: true };
    },
    runInstall: async (prefix, version, opts) => {
      calls.install.push({ prefix, version, opts });
      return { ok: true, code: 0, signal: null, timedOut: false, stderrTail: '' };
    },
    notified: {
      has: (k) => {
        calls.has.push(k);
        return false;
      },
      record: (k) => {
        calls.record.push(k);
        return false;
      },
    },
    ...over,
  };
  return { deps, outLines, errLines, log, calls };
}

// (1) 更新成功
test('(1) 更新成功で installed=true、from/to が入り、「更新完了」は出ない', async () => {
  const t = setup();
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 0);
  assert.equal(r.installed, true);
  assert.equal(r.from, '1.2.0');
  assert.equal(r.to, '1.2.3');
  assert.equal(r.aud, '1.2.3');
  assert.equal(r.notice, null);
  assert.equal(r.pkgDir, path.join('/p', 'lib', 'node_modules', '@bash0816', 'agy-termux'));
  assert.equal(t.calls.install.length, 1);
  assert.equal(t.calls.install[0].version, '1.2.3');
  const all = t.outLines.concat(t.errLines).join('\n');
  assert.ok(!all.includes('更新完了'), '「更新完了」は表示しない');
});

// (2) 監査済み版が新しくない
test('(2) 監査済み版が新しくないとき npmViewLatest も preflight も呼ばれない', async () => {
  const t = setup({ fetchAudited: async () => '1.2.0' });
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 0);
  assert.equal(r.installed, false);
  assert.equal(t.calls.npm, 0);
  assert.equal(t.calls.preflight, 0);
  assert.equal(t.calls.install.length, 0);
  assert.ok(t.outLines.some((l) => l.includes('Already on latest audited version')));
});

// (3) registry 不一致と通知履歴
test('(3a) registry 不一致で record が真なら通知を out に出し notice=mismatch', async () => {
  const t = setup({
    npmViewLatest: async () => {
      t.calls.npm++;
      return { ok: true, version: '1.2.4' };
    },
    notified: {
      has: () => false,
      record: (k) => {
        t.calls.record.push(k);
        return true;
      },
    },
  });
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 0);
  assert.equal(r.installed, false);
  assert.equal(r.notice, 'mismatch');
  assert.ok(t.outLines.some((l) => l.includes('一致しない')));
  assert.deepEqual(t.calls.record, [makeKey('1.2.0', '1.2.3', '1.2.4')]);
  assert.equal(t.calls.install.length, 0);
});

test('(3b) registry 不一致で record が偽なら通知は出ず notice=null', async () => {
  const t = setup({
    npmViewLatest: async () => ({ ok: true, version: '1.2.4' }),
    notified: { has: () => false, record: () => false },
  });
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 0);
  assert.equal(r.notice, null);
  assert.equal(t.outLines.length, 0);
});

test('(3c) registry 不一致で has が真なら record も出力もしない', async () => {
  const t = setup({
    npmViewLatest: async () => ({ ok: true, version: '1.2.4' }),
    notified: {
      has: (k) => {
        t.calls.has.push(k);
        return true;
      },
      record: (k) => {
        t.calls.record.push(k);
        return true;
      },
    },
  });
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 0);
  assert.equal(r.notice, null);
  assert.equal(t.calls.record.length, 0);
  assert.equal(t.outLines.length, 0);
});

// (4) preflight の結果
test('(4a) preflight が skipped(consent_declined) なら runInstall は呼ばれず、code 0・installed false・preflight 付き、更新の表示はない', async () => {
  const t = setup({
    preflight: async () => {
      t.calls.preflight++;
      return { ok: false, status: 'skipped', reason: 'consent_declined' };
    },
  });
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 0);
  assert.equal(r.installed, false);
  assert.deepEqual(r.preflight, { ok: false, status: 'skipped', reason: 'consent_declined' });
  assert.equal(t.calls.install.length, 0);
  assert.equal(t.outLines.length, 0);
  assert.ok(!t.errLines.some((l) => l.includes('に更新します')));
});

test('(4b) preflight が status error なら code 1', async () => {
  const t = setup({
    preflight: async () => ({ ok: false, status: 'error', reason: 'disk' }),
  });
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 1);
  assert.equal(r.installed, false);
  assert.deepEqual(r.preflight, { ok: false, status: 'error', reason: 'disk' });
  assert.equal(t.calls.install.length, 0);
});

// (5) runInstall の失敗
test('(5) runInstall 失敗で code 1・installed false、元のバージョンのままの案内が出る', async () => {
  const t = setup({
    runInstall: async (prefix, version, opts) => {
      t.calls.install.push({ prefix, version, opts });
      return { ok: false, code: 1, signal: null, timedOut: false, stderrTail: '' };
    },
    checkPlacement: () => ({ complete: true, version: '1.2.0', problems: [] }),
  });
  const r = await runUpdate(t.deps);
  assert.equal(r.code, 1);
  assert.equal(r.installed, false);
  assert.equal(r.pkgDir, null);
  assert.equal(t.calls.install.length, 1);
  assert.ok(t.errLines.some((l) => l.includes('更新に失敗しました') && l.includes('バージョンは 1.2.0 のままです')));
  assert.ok(!t.errLines.some((l) => l.includes('前のバージョンに戻すには')));
});

// (6) 公開状況の表示が問い合わせより前
test('(6) 「公開状況を確認中...」は npmViewLatest より前に err へ出る', async () => {
  const t = setup();
  await runUpdate(t.deps);
  const idxMsg = t.log.indexOf('err:[agy] 公開状況を確認中...');
  const idxNpm = t.log.indexOf('npm');
  assert.ok(idxMsg >= 0, '表示がある');
  assert.ok(idxNpm >= 0, 'npmViewLatest が呼ばれる');
  assert.ok(idxMsg < idxNpm, '表示は問い合わせより前');
});

// (7) createDeps の配線(runNpm と checkPlacementImpl を偽にする)
const OK_RESULT = { ok: true, code: 0, signal: null, timedOut: false, stderrTail: '', stdout: '' };

function makeCreate(runNpmImpl) {
  const runNpmCalls = [];
  const checkCalls = [];
  const outLines = [];
  const errLines = [];
  const fsImpl = { realpathSync: (p) => p };
  const deps = createDeps({
    spawnSync: () => {
      throw new Error('spawnSync は使わない');
    },
    realpathSync: (p) => p,
    filename: '/p/bin/agy',
    https: {
      get: () => {
        throw new Error('実通信しない');
      },
    },
    env: {},
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    computePrefix: () => '/p',
    pkgVersion: '1.2.0',
    notifiedFile: null,
    runNpm: async (args, opts) => {
      runNpmCalls.push({ args, opts });
      return runNpmImpl(args, opts);
    },
    checkPlacementImpl: (o) => {
      checkCalls.push(o);
      return { complete: true, version: '1.2.3', problems: [] };
    },
    fsImpl,
    randomHex: () => 'abcd',
  });
  return { deps, runNpmCalls, checkCalls, outLines, errLines, fsImpl };
}

test('(7a) npmViewLatest: runNpm に正しい引数で呼び、stdout の版を返す', async () => {
  const c = makeCreate(async () => ({ ...OK_RESULT, stdout: '1.2.3\n' }));
  const r = await c.deps.npmViewLatest();
  assert.deepEqual(r, { ok: true, version: '1.2.3' });
  assert.equal(c.runNpmCalls.length, 1);
  assert.deepEqual(c.runNpmCalls[0].args, ['view', '@bash0816/agy-termux@latest', 'version']);
  assert.equal(c.runNpmCalls[0].opts.forward, false);
  assert.equal(c.runNpmCalls[0].opts.label, '公開状況の確認');
  assert.equal(c.runNpmCalls[0].opts.timeoutMs, 15000);
});

test('(7b) npmViewLatest: 失敗時の reason は stderr の最後の非空行', async () => {
  const c = makeCreate(async () => ({
    ...OK_RESULT,
    ok: false,
    code: 1,
    stderrTail: 'npm ERR! x\nnpm ERR! last line\n',
  }));
  const r = await c.deps.npmViewLatest();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'npm ERR! last line');
});

test('(7c) npmViewLatest: timedOut なら reason は timeout', async () => {
  const c = makeCreate(async () => ({ ...OK_RESULT, ok: false, code: null, signal: 'SIGKILL', timedOut: true }));
  const r = await c.deps.npmViewLatest();
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
});

test('(7d) npmViewLatest: 版として解釈できない stdout は「不正な出力」', async () => {
  const c = makeCreate(async () => ({ ...OK_RESULT, stdout: 'abc\n' }));
  const r = await c.deps.npmViewLatest();
  assert.equal(r.ok, false);
  assert.ok(r.reason.startsWith('不正な出力'));
});

test('(7e) runInstall: runNpm に正しい引数・label・timeoutMs・termGraceMs・forward を渡す', async () => {
  const c = makeCreate(async () => OK_RESULT);
  const r = await c.deps.runInstall('/p', '1.2.3', { timeoutMs: 60000 });
  assert.equal(r.ok, true);
  assert.equal(c.runNpmCalls.length, 1);
  const call = c.runNpmCalls[0];
  assert.deepEqual(call.args, ['install', '-g', '--prefix', '/p', '@bash0816/agy-termux@1.2.3']);
  assert.equal(call.opts.label, '更新');
  assert.equal(call.opts.timeoutMs, 60000);
  assert.equal(call.opts.termGraceMs, 10000);
  assert.equal(call.opts.forward, true);
});

test('(7f) runInstall: write の stdout は out、stderr は err に、末尾の改行 1 つを除いて渡す', async () => {
  const c = makeCreate(async (args, opts) => {
    opts.write('stdout', 'line\n');
    opts.write('stderr', 'e\n');
    return OK_RESULT;
  });
  await c.deps.runInstall('/p', '1.2.3', { timeoutMs: 60000 });
  assert.deepEqual(c.outLines, ['line']);
  assert.deepEqual(c.errLines, ['e']);
});

test('(7g) notifiedFile が null なら notified.record は偽、has も偽', async () => {
  const c = makeCreate(async () => OK_RESULT);
  assert.equal(c.deps.notified.record('k'), false);
  assert.equal(c.deps.notified.has('k'), false);
});

test('(7h) checkPlacement: nonce・fs・realpath を付けて checkPlacementImpl に渡す', async () => {
  const c = makeCreate(async () => OK_RESULT);
  const pkgDir = '/p/lib/node_modules/@bash0816/agy-termux';
  const r = c.deps.checkPlacement(pkgDir, '/p', '1.2.3');
  assert.equal(r.complete, true);
  assert.equal(c.checkCalls.length, 1);
  const o = c.checkCalls[0];
  assert.equal(o.pkgDir, pkgDir);
  assert.equal(o.prefix, '/p');
  assert.equal(o.expectedVersion, '1.2.3');
  assert.equal(o.nonce, 'abcd');
  assert.equal(o.fs, c.fsImpl);
  assert.equal(typeof o.realpath, 'function');
});
