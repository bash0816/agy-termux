'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const au = require('../lib/audited-update');

const TEST_URL = 'https://example.test/v.json';

// 偽のタイマー。実時間は使わず、fire(ms) で遅延が ms 以下の未クリア・未発火のものを手動で発火させる
function makeTimers() {
  const all = [];
  let nextId = 1;
  return {
    all,
    setTimeout(fn, ms) {
      const t = { id: nextId++, fn, ms, cleared: false, fired: false };
      all.push(t);
      return t.id;
    },
    clearTimeout(id) {
      const t = all.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
    fire(ms) {
      for (const t of all) {
        if (t.cleared || t.fired || t.ms > ms) continue;
        t.fired = true;
        t.fn();
      }
    },
    // clearTimeout が呼ばれたタイマーの数
    cleared() {
      return all.filter((t) => t.cleared).length;
    },
    // まだクリアも発火もしていないタイマーの数
    pending() {
      return all.filter((t) => !t.cleared && !t.fired).length;
    },
  };
}

// 偽の https.get。応答は setImmediate で非同期に返す
// scriptFn({ req, res, emitBody }) が応答のイベントを流す。status で HTTP ステータスを指定できる
function makeFake(scriptFn, { status = 200 } = {}) {
  const get = (url, cb) => {
    get.calls.push(url);
    const req = new EventEmitter();
    req.destroyCount = 0;
    req.destroy = () => {
      req.destroyCount++;
    };
    const res = new EventEmitter();
    res.statusCode = status;
    res.complete = false;
    res.resumeCount = 0;
    res.destroyCount = 0;
    res.setEncoding = () => {};
    res.resume = () => {
      res.resumeCount++;
    };
    res.destroy = () => {
      res.destroyCount++;
    };
    // 正常系の順序: complete=true → data → end → close
    const emitBody = (...chunks) => {
      res.complete = true;
      for (const c of chunks) res.emit('data', c);
      res.emit('end');
      res.emit('close');
    };
    get.last = { req, res };
    setImmediate(() => {
      cb(res);
      scriptFn({ req, res, emitBody });
    });
    return req;
  };
  get.calls = [];
  return get;
}

// 偽の spawnSync。呼び出し (cmd, args, options) を calls に記録し、handler の戻り値を返す
function makeSpawn(handler) {
  const spawnSync = (cmd, args, options) => {
    spawnSync.calls.push({ cmd, args, options });
    return handler(cmd, args, options);
  };
  spawnSync.calls = [];
  return spawnSync;
}

// runUpdate 用の deps。各依存の呼び出し回数・引数を calls に、出力を out / err に溜める
// overrides の fetchAudited / npmViewLatest / detectPrefix / runInstall は既定動作を差し替える
function makeDeps(overrides = {}) {
  const { fetchAudited, npmViewLatest, detectPrefix, runInstall, ...rest } = overrides;
  const calls = { fetchAudited: [], npmViewLatest: 0, detectPrefix: 0, realFilePath: 0, runInstall: [] };
  const out = [];
  const err = [];
  const deps = {
    pkgVersion: '1.2.14',
    url: TEST_URL,
    urlError: null,
    ...rest,
    fetchAudited: (u) => {
      calls.fetchAudited.push(u);
      return (fetchAudited || (() => Promise.resolve('1.2.16')))(u);
    },
    npmViewLatest: () => {
      calls.npmViewLatest++;
      return (npmViewLatest || (() => ({ ok: true, version: '1.2.16' })))();
    },
    detectPrefix: () => {
      calls.detectPrefix++;
      return (detectPrefix || (() => '/p'))();
    },
    realFilePath: () => {
      calls.realFilePath++;
      return '/fake/agy.js';
    },
    runInstall: (prefix, version) => {
      calls.runInstall.push([prefix, version]);
      return (runInstall || (() => ({ ok: true })))(prefix, version);
    },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  };
  return { deps, calls, out, err };
}

// createDeps 用の既定引数。必要なものだけ overrides で差し替える
function makeCreateDeps(overrides = {}) {
  return au.createDeps({
    spawnSync: makeSpawn(() => ({ status: 0, stdout: '' })),
    realpathSync: (p) => p,
    filename: '/fake/agy.js',
    https: { get: () => {} },
    env: {},
    out: () => {},
    err: () => {},
    computePrefix: () => null,
    pkgVersion: '1.2.14',
    ...overrides,
  });
}

// 本文 body を1回で返す偽の応答で fetchAuditedVersion を呼ぶ
function fetchBody(body, opts = {}) {
  const get = makeFake(({ emitBody }) => emitBody(body));
  return au.fetchAuditedVersion({ url: TEST_URL, get, timers: makeTimers(), ...opts });
}

// 次の setImmediate まで待つ(偽の応答の非同期イベントを流し切るため)
const flush = () => new Promise((resolve) => setImmediate(resolve));

// 出力行の中に s が含まれることを確認する。失敗時は実際の出力を表示する
function assertIncludes(lines, s) {
  const joined = lines.join('\n');
  assert.ok(joined.includes(s), `期待する文字列: ${s}\n実際の出力:\n${joined}`);
}

test('normalizeTag / isNewer', async (t) => {
  // N1: 受理される形式
  await t.test('N1 x.y.z と先頭 v の付いた形式、安全整数の境界を受理する', () => {
    assert.equal(au.normalizeTag('1.2.16'), '1.2.16');
    assert.equal(au.normalizeTag('v1.2.16'), '1.2.16');
    assert.equal(au.normalizeTag('9007199254740991.0.0'), '9007199254740991.0.0');
  });

  // N2: 拒否される形式(すべて null)
  await t.test('N2 不正な形式・非文字列・安全整数を超える値は null を返す', () => {
    const rejected = [
      'vv1.2.16',
      '1.2',
      '1.2.3-rc1',
      ' 1.2.3',
      '01.2.3',
      '9007199254740992.0.0',
      '9007199254740993.2.3',
      '',
      123,
      null,
      undefined,
      ['1.2.3'],
    ];
    for (const v of rejected) {
      assert.equal(au.normalizeTag(v), null, `拒否されるべき: ${JSON.stringify(v)}`);
    }
  });

  // N3: 比較
  await t.test('N3 isNewer は新旧を正しく判定し、不正な形式では例外を投げる', () => {
    assert.equal(au.isNewer('1.2.17', '1.2.16'), true);
    assert.equal(au.isNewer('1.2.16', '1.2.16'), false);
    assert.equal(au.isNewer('1.2.15', '1.2.16'), false);
    assert.equal(au.isNewer('1.3.0', '1.2.99'), true);
    assert.equal(au.isNewer('2.0.0', '1.9.9'), true);
    assert.equal(au.isNewer('v1.2.17', '1.2.16'), true);
    assert.throws(() => au.isNewer('1.2', '1.2.16'));
    assert.throws(() => au.isNewer('1.2.16', null));
  });
});

test('fetchAuditedVersion', async (t) => {
  // F1: 接続エラー
  await t.test('F1 接続エラーで reject し、タイマーを解放して destroy を1回呼ぶ', async () => {
    const timers = makeTimers();
    const get = makeFake(({ req }) => req.emit('error', new Error('ECONNREFUSED')));
    await assert.rejects(au.fetchAuditedVersion({ url: TEST_URL, get, timers }), /ECONNREFUSED/);
    assert.equal(get.last.req.destroyCount, 1);
    assert.equal(timers.cleared(), 1);
    assert.equal(timers.pending(), 0);
  });

  // F2: HTTP エラーステータス
  await t.test('F2 HTTP 404 と 500 は reject し、res.resume と destroy をそれぞれ1回呼ぶ', async () => {
    for (const status of [404, 500]) {
      const timers = makeTimers();
      const get = makeFake(() => {}, { status });
      await assert.rejects(au.fetchAuditedVersion({ url: TEST_URL, get, timers }), new RegExp(`HTTP ${status}`));
      assert.equal(get.last.res.resumeCount, 1, `status ${status}: resume`);
      assert.equal(get.last.req.destroyCount, 1, `status ${status}: destroy`);
    }
  });

  // F3: 応答側の error
  await t.test('F3 応答側の error で reject し、destroy を呼んでタイマーを解放する', async () => {
    const timers = makeTimers();
    const get = makeFake(({ res }) => res.emit('error', new Error('response-error')));
    await assert.rejects(au.fetchAuditedVersion({ url: TEST_URL, get, timers }), /response-error/);
    assert.equal(get.last.req.destroyCount, 1);
    assert.equal(timers.cleared(), 1);
    assert.equal(timers.pending(), 0);
  });

  // F4: 途中切断
  await t.test('F4 data の後に aborted・error・close が来ると reject する', async () => {
    const timers = makeTimers();
    const get = makeFake(({ res }) => {
      res.emit('data', '{"tag_name"');
      res.emit('aborted');
      res.emit('error', new Error('socket hang up'));
      res.emit('close');
    });
    await assert.rejects(au.fetchAuditedVersion({ url: TEST_URL, get, timers }), /aborted/);
    assert.equal(get.last.req.destroyCount, 1);
  });

  await t.test('F4 complete=false のまま close だけ来ても reject する', async () => {
    const timers = makeTimers();
    const get = makeFake(({ res }) => res.emit('close'));
    await assert.rejects(au.fetchAuditedVersion({ url: TEST_URL, get, timers }), /closed before end/);
    assert.equal(get.last.req.destroyCount, 1);
  });

  // F5: 全体期限
  await t.test('F5a 何も流さず期限を過ぎると timeout で reject し、destroy とタイマー解放を行う', async () => {
    const timers = makeTimers();
    const get = makeFake(() => {});
    const p = au.fetchAuditedVersion({ url: TEST_URL, get, timers });
    timers.fire(15000);
    await assert.rejects(p, /timeout/);
    assert.equal(get.last.req.destroyCount, 1);
    assert.equal(timers.cleared(), 1);
    assert.equal(timers.pending(), 0);
  });

  await t.test('F5b data が届き続けていても期限を過ぎると timeout で打ち切る', async () => {
    const timers = makeTimers();
    const get = makeFake(({ res }) => {
      res.emit('data', '{"tag_name"');
      res.emit('data', ':"1.2.3"');
      res.emit('data', ',"pad":"');
    });
    const p = au.fetchAuditedVersion({ url: TEST_URL, get, timers });
    // 偽の応答の data を流し切ってから期限を発火させる
    await flush();
    timers.fire(15000);
    await assert.rejects(p, /timeout/);
    assert.equal(get.last.req.destroyCount, 1);
  });

  await t.test('F5c timeoutMs に渡した値で期限タイマーを登録する', async () => {
    const timers = makeTimers();
    const get = makeFake(() => {});
    const p = au.fetchAuditedVersion({ url: TEST_URL, get, timers, timeoutMs: 5000 });
    assert.equal(timers.all.length, 1);
    assert.equal(timers.all[0].ms, 5000);
    timers.fire(5000);
    await assert.rejects(p, /timeout/);
  });

  // F6: サイズ上限(65536 バイト)
  const head = '{"tag_name":"1.2.3","pad":"';
  const tail = '"}';
  const padLen = 65536 - Buffer.byteLength(head + tail);

  await t.test('F6 ちょうど 65536 バイトの本文は受理する', async () => {
    const body = head + 'a'.repeat(padLen) + tail;
    assert.equal(Buffer.byteLength(body), 65536);
    assert.equal(await fetchBody(body), '1.2.3');
  });

  await t.test('F6 65537 バイトの本文は too large で reject する', async () => {
    const body = head + 'a'.repeat(padLen + 1) + tail;
    assert.equal(Buffer.byteLength(body), 65537);
    await assert.rejects(fetchBody(body), /too large/);
  });

  await t.test('F6 文字数は上限以下でもバイト数で超えるなら too large で reject する', async () => {
    const body = head + 'あ'.repeat(22000) + tail;
    assert.ok(body.length <= 65536, `文字数: ${body.length}`);
    assert.ok(Buffer.byteLength(body) > 65536, `バイト数: ${Buffer.byteLength(body)}`);
    await assert.rejects(fetchBody(body), /too large/);
  });

  await t.test('F6 上限超過の後に data や end・close が来ても二重に完了しない', async () => {
    const timers = makeTimers();
    const get = makeFake(({ res }) => {
      res.emit('data', 'a'.repeat(65537));
      res.emit('data', '{"tag_name":"1.2.3"}');
      res.emit('end');
      res.emit('close');
    });
    await assert.rejects(au.fetchAuditedVersion({ url: TEST_URL, get, timers }), /too large/);
    // 二重完了なら destroy が2回呼ばれるため、1回のままであることを確認する
    assert.equal(get.last.req.destroyCount, 1);
  });

  // F7: JSON の形式
  await t.test('F7 不正な JSON は reject する', async () => {
    await assert.rejects(fetchBody('not json'), /JSON の解析に失敗しました/);
  });

  await t.test('F7 ルートが配列・null・文字列の JSON は reject する', async () => {
    for (const body of ['[]', 'null', '"x"']) {
      await assert.rejects(fetchBody(body), /JSON のルートがオブジェクトではありません/, `body: ${body}`);
    }
  });

  // F8: tag_name
  await t.test('F8 tag_name が欠落・null・数値・配列・オブジェクトなら invalid tag_name で reject する', async () => {
    // JSON では 1.2.3 は数値として書けないため、非文字列の数値として 1.2 を使う
    const bodies = ['{}', '{"tag_name":null}', '{"tag_name":1.2}', '{"tag_name":["1.2.3"]}', '{"tag_name":{"v":"1.2.3"}}'];
    for (const body of bodies) {
      await assert.rejects(fetchBody(body), /invalid tag_name/, `body: ${body}`);
    }
  });

  await t.test('F8 有効な文字列の tag_name は正規化して返す', async () => {
    assert.equal(await fetchBody(JSON.stringify({ tag_name: '1.2.16' })), '1.2.16');
    assert.equal(await fetchBody(JSON.stringify({ tag_name: 'v1.2.16' })), '1.2.16');
    assert.equal(await fetchBody(JSON.stringify({ tag_name: '9007199254740991.0.0' })), '9007199254740991.0.0');
  });

  await t.test('F8 不正な文字列の tag_name は invalid tag_name で reject する', async () => {
    const values = ['vv1.2.16', '1.2', '1.2.3-rc1', ' 1.2.3', '01.2.3', '9007199254740992.0.0', '9007199254740993.2.3'];
    for (const v of values) {
      await assert.rejects(fetchBody(JSON.stringify({ tag_name: v })), /invalid tag_name/, `tag_name: ${v}`);
    }
  });

  // F9: URL
  await t.test('F9 https 以外・解析不能・非文字列の URL は get を呼ばずに reject する', async () => {
    const urls = ['http://example.test/x', 'ftp://x', 'not a url', '', undefined, 123];
    for (const url of urls) {
      const timers = makeTimers();
      const get = makeFake(() => {});
      await assert.rejects(au.fetchAuditedVersion({ url, get, timers }), undefined, `url: ${JSON.stringify(url)}`);
      assert.equal(get.calls.length, 0, `get を呼んではいけない: ${JSON.stringify(url)}`);
    }
  });

  await t.test('F9 正常系はタイマーを解放し、close が後から来ても二重に完了せず destroy も呼ばない', async () => {
    const timers = makeTimers();
    const get = makeFake(({ emitBody }) => emitBody('{"tag_name":"1.2.16"}'));
    assert.equal(await au.fetchAuditedVersion({ url: TEST_URL, get, timers }), '1.2.16');
    assert.equal(timers.cleared(), 1);
    assert.equal(timers.pending(), 0);
    assert.equal(get.last.req.destroyCount, 0);
  });

  await t.test('F9 destroy の後に遅れて error が来ても未処理例外にならない', async () => {
    const timers = makeTimers();
    const get = makeFake(() => {});
    const p = au.fetchAuditedVersion({ url: TEST_URL, get, timers });
    timers.fire(15000);
    await assert.rejects(p, /timeout/);
    // 応答側のリスナーは setImmediate で登録されるため、先に流し切ってから確認する
    await flush();
    const { req, res } = get.last;
    assert.equal(req.destroyCount, 1);
    assert.ok(req.listenerCount('error') > 0, 'req に error リスナーがあること');
    assert.ok(res.listenerCount('error') > 0, 'res に error リスナーがあること');
    assert.doesNotThrow(() => req.emit('error', new Error('late req error')));
    assert.doesNotThrow(() => res.emit('error', new Error('late res error')));
  });
});

test('runUpdate', async (t) => {
  // U1: 既に監査済みの最新
  await t.test('U1 現在版と監査済み版が同じなら何もせず 0 を返す', async () => {
    const { deps, calls, out } = makeDeps({ pkgVersion: '1.2.16' });
    assert.equal(await au.runUpdate(deps), 0);
    assertIncludes(out, 'Already on latest audited version: 1.2.16');
    assert.equal(calls.npmViewLatest, 0);
    assert.equal(calls.runInstall.length, 0);
  });

  // U2: 現在版が監査済み版より新しい
  await t.test('U2 現在版が監査済み版より新しければ 0 を返し、監査済みの最新を併記する', async () => {
    const { deps, calls, out } = makeDeps({ pkgVersion: '1.3.0' });
    assert.equal(await au.runUpdate(deps), 0);
    assertIncludes(out, 'Already on latest audited version: 1.3.0');
    assertIncludes(out, '監査済みの最新は 1.2.16');
    assert.equal(calls.npmViewLatest, 0);
  });

  // U3: 正常な更新
  await t.test('U3 監査済み版と npm の latest が一致すれば prefix を指定して更新する', async () => {
    const { deps, calls, out } = makeDeps({ pkgVersion: '1.2.14' });
    assert.equal(await au.runUpdate(deps), 0);
    assert.deepEqual(calls.runInstall, [['/p', '1.2.16']]);
    assertIncludes(out, '更新完了');
  });

  // U4: npm の latest が監査済み版と違う(現在版と同じ)
  await t.test('U4 npm の latest が監査済み版と一致しなければ更新しない', async () => {
    const { deps, calls, out } = makeDeps({
      pkgVersion: '1.2.14',
      npmViewLatest: () => ({ ok: true, version: '1.2.14' }),
    });
    assert.equal(await au.runUpdate(deps), 0);
    assertIncludes(out, '一致しないため、更新しません');
    assert.equal(calls.runInstall.length, 0);
  });

  // U5: npm の latest が監査済み版と違う(別の版)
  await t.test('U5 npm の latest が 1.2.15 や 1.2.17 でも更新しない', async () => {
    for (const latest of ['1.2.15', '1.2.17']) {
      const { deps, calls, out } = makeDeps({
        pkgVersion: '1.2.14',
        npmViewLatest: () => ({ ok: true, version: latest }),
      });
      assert.equal(await au.runUpdate(deps), 0, `latest: ${latest}`);
      assertIncludes(out, '一致しないため、更新しません');
      assert.equal(calls.runInstall.length, 0, `latest: ${latest}`);
    }
  });

  // U6: 監査済み版が現在版より古い(自動ダウングレードなし)
  await t.test('U6 監査済み版が現在版より古くても自動ダウングレードせず 0 を返す', async () => {
    const { deps, calls, out } = makeDeps({
      pkgVersion: '1.2.16',
      fetchAudited: () => Promise.resolve('1.2.14'),
    });
    assert.equal(await au.runUpdate(deps), 0);
    assertIncludes(out, 'Already on latest audited version: 1.2.16');
    assertIncludes(out, '監査済みの最新は 1.2.14');
    assert.equal(calls.npmViewLatest, 0);
    assert.equal(calls.runInstall.length, 0);
  });

  // U7: 監査済み版の取得に失敗
  await t.test('U7 監査済み版の取得に失敗したら 1 を返し、npm にも問い合わせない', async () => {
    const { deps, calls, err } = makeDeps({
      fetchAudited: () => Promise.reject(new Error('net down')),
    });
    assert.equal(await au.runUpdate(deps), 1);
    assertIncludes(err, '監査済み版の確認に失敗しました');
    assert.equal(calls.npmViewLatest, 0);
    assert.equal(calls.runInstall.length, 0);
  });

  // U8: 'v' 付きタグ由来の監査済み版
  await t.test('U8 正規化済みの監査済み版を使って更新できる', async () => {
    const { deps, calls, out } = makeDeps({
      pkgVersion: '1.2.14',
      fetchAudited: () => Promise.resolve(au.normalizeTag('v1.2.16')),
    });
    assert.equal(await au.runUpdate(deps), 0);
    assert.deepEqual(calls.runInstall, [['/p', '1.2.16']]);
    assertIncludes(out, '更新完了');
  });

  // U9: npm への問い合わせに失敗
  await t.test('U9 npm の問い合わせに失敗したら 1 を返し、更新しない', async () => {
    const { deps, calls, err } = makeDeps({
      npmViewLatest: () => ({ ok: false, reason: 'x' }),
    });
    assert.equal(await au.runUpdate(deps), 1);
    assertIncludes(err, 'registry の確認に失敗しました');
    assert.equal(calls.runInstall.length, 0);
  });

  // U10: prefix を検出できない
  await t.test('U10 prefix を検出できなければ 1 を返し、手動更新の案内を出す', async () => {
    const { deps, calls, err } = makeDeps({
      detectPrefix: () => null,
    });
    assert.equal(await au.runUpdate(deps), 1);
    assertIncludes(err, '手動で更新する');
    assertIncludes(err, '@bash0816/agy-termux@1.2.16');
    assert.equal(calls.runInstall.length, 0);
  });

  // U11: 更新コマンドの失敗
  await t.test('U11 更新に失敗したら 1 を返し、前の版に戻す手順を案内する', async () => {
    const { deps, err } = makeDeps({
      pkgVersion: '1.2.14',
      runInstall: () => ({ ok: false }),
    });
    assert.equal(await au.runUpdate(deps), 1);
    assertIncludes(err, '前のバージョンに戻すには: npm install -g --prefix /p @bash0816/agy-termux@1.2.14');
  });

  // U12: 入力の不正
  await t.test('U12 現在版の形式が不正なら 1 を返し、取得に進まない', async () => {
    const { deps, calls, err } = makeDeps({ pkgVersion: 'abc' });
    assert.equal(await au.runUpdate(deps), 1);
    assert.equal(calls.fetchAudited.length, 0);
    assertIncludes(err, 'バージョン形式を比較できません');
  });

  await t.test('U12 AGY_TERMUX_VERIFIED_URL が不正(空文字を含む)なら 1 を返し、取得に進まない', async () => {
    for (const urlError of ['http://x', '']) {
      const { deps, calls, err } = makeDeps({ urlError });
      assert.equal(await au.runUpdate(deps), 1, `urlError: ${JSON.stringify(urlError)}`);
      assertIncludes(err, 'AGY_TERMUX_VERIFIED_URL が不正');
      assert.equal(calls.fetchAudited.length, 0);
    }
  });
});

test('createDeps', async (t) => {
  // C1: npm の latest の問い合わせ
  await t.test('C1 npmViewLatest は npm view で1回だけ問い合わせ、出力を正規化して返す', () => {
    const spawn = makeSpawn(() => ({ status: 0, stdout: '1.2.16\n' }));
    const deps = makeCreateDeps({ spawnSync: spawn });
    assert.deepEqual(deps.npmViewLatest(), { ok: true, version: '1.2.16' });
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].cmd, 'npm');
    assert.deepEqual(spawn.calls[0].args, ['view', '@bash0816/agy-termux@latest', 'version']);
    assert.deepEqual(spawn.calls[0].options, { shell: false, encoding: 'utf8', timeout: 15000 });
  });

  // C2: インストール
  await t.test('C2 runInstall は版を固定して npm install -g を実行し、成功なら ok:true を返す', () => {
    const spawn = makeSpawn(() => ({ status: 0 }));
    const deps = makeCreateDeps({ spawnSync: spawn });
    assert.deepEqual(deps.runInstall('/p', '1.2.16'), { ok: true });
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].cmd, 'npm');
    assert.deepEqual(spawn.calls[0].args, ['install', '-g', '--prefix', '/p', '@bash0816/agy-termux@1.2.16']);
    assert.deepEqual(spawn.calls[0].options, { shell: false, stdio: 'inherit', timeout: 60000 });
  });

  // C3: 結果の処理。入力ごとに別のサブテストにして、落ちたケースを特定できるようにする
  const npmViewCases = [
    ['error が立つ', { error: new Error('ETIMEDOUT') }],
    ['status が null(signal/timeout)', { status: null }],
    ['status が 1', { status: 1 }],
    ['stdout が空', { status: 0, stdout: '' }],
    ['stdout が不正な文字列', { status: 0, stdout: 'abc' }],
    ['stdout が x.y のみ', { status: 0, stdout: '1.2' }],
    ['stdout が安全整数を超える', { status: 0, stdout: '9007199254740993.0.0' }],
    ['stdout が無い', { status: 0 }],
  ];
  for (const [name, result] of npmViewCases) {
    await t.test(`C3 npmViewLatest: ${name} なら例外を投げず ok:false を返す`, () => {
      const deps = makeCreateDeps({ spawnSync: makeSpawn(() => result) });
      let r;
      assert.doesNotThrow(() => {
        r = deps.npmViewLatest();
      });
      assert.equal(r.ok, false);
    });
  }

  const runInstallCases = [
    ['error が立つ', { error: new Error('ETIMEDOUT') }],
    ['status が 1', { status: 1 }],
    ['status が null', { status: null }],
  ];
  for (const [name, result] of runInstallCases) {
    await t.test(`C3 runInstall: ${name} なら ok:false を返す`, () => {
      const deps = makeCreateDeps({ spawnSync: makeSpawn(() => result) });
      assert.equal(deps.runInstall('/p', '1.2.16').ok, false);
    });
  }

  // C4: 監査済み版 URL の設定
  await t.test('C4 AGY_TERMUX_VERIFIED_URL が未定義なら既定 URL を使う', () => {
    const deps = makeCreateDeps({ env: {} });
    assert.equal(deps.url, au.DEFAULT_URL);
    assert.equal(deps.urlError, null);
  });

  await t.test('C4 https の URL はそのまま使う', () => {
    const deps = makeCreateDeps({ env: { AGY_TERMUX_VERIFIED_URL: 'https://example.test/a.json' } });
    assert.equal(deps.url, 'https://example.test/a.json');
    assert.equal(deps.urlError, null);
  });

  await t.test('C4 https 以外・空文字・解析不能な URL は url:null と入力値の urlError を返す', () => {
    for (const v of ['http://example.test/a.json', '', 'not a url', 'ftp://x']) {
      const deps = makeCreateDeps({ env: { AGY_TERMUX_VERIFIED_URL: v } });
      assert.equal(deps.url, null, `入力: ${JSON.stringify(v)}`);
      assert.equal(deps.urlError, v, `入力: ${JSON.stringify(v)}`);
    }
  });

  // C5: prefix とファイルパス
  const REAL = '/p/lib/node_modules/@bash0816/agy-termux/bin/agy.js';

  await t.test('C5 detectPrefix は実体パスを computePrefix に渡し、その結果を返す', () => {
    const seen = [];
    const deps = makeCreateDeps({
      realpathSync: () => REAL,
      computePrefix: (p) => {
        seen.push(p);
        return '/p';
      },
    });
    assert.equal(deps.detectPrefix(), '/p');
    assert.deepEqual(seen, [REAL]);
  });

  await t.test('C5 realpath が throw すると detectPrefix は null、realFilePath は filename を返す', () => {
    let computeCalled = false;
    const deps = makeCreateDeps({
      realpathSync: () => {
        throw new Error('ENOENT');
      },
      computePrefix: () => {
        computeCalled = true;
        return '/p';
      },
    });
    assert.equal(deps.detectPrefix(), null);
    assert.equal(computeCalled, false);
    assert.equal(deps.realFilePath(), '/fake/agy.js');
  });
});
