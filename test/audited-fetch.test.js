'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const au = require('../lib/audited-update');

const TEST_URL = 'https://example.test/v.json';
const OK_BODY = '{"tag_name":"v1.2.16"}';

// 仮想時計。setTimeout / setInterval を記録し、advance(ms) で期限順に発火させる(実時間は使わない)
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = [];
  const add = (kind, fn, ms) => {
    const t = { id: nextId++, kind, fn, ms, due: now + ms, active: true };
    timers.push(t);
    return t.id;
  };
  const clear = (id) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.active = false;
  };
  return {
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    clearTimeout: clear,
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearInterval: clear,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = timers
          .filter((t) => t.active && t.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!next) break;
        now = next.due;
        if (next.kind === 'timeout') next.active = false;
        else next.due += next.ms;
        next.fn();
      }
      now = target;
    },
    // まだ解除されていないタイマーの数(setTimeout / setInterval の合計)
    activeCount() {
      return timers.filter((t) => t.active).length;
    },
  };
}

// 偽の https.get。要求ごとに req / res(EventEmitter)を作り、get.last に残す。応答は テスト側から送る
function makeGet() {
  const get = (url, cb) => {
    const req = new EventEmitter();
    req.destroyCount = 0;
    req.destroy = () => {
      req.destroyCount += 1;
    };
    const res = new EventEmitter();
    res.statusCode = 200;
    res.complete = false;
    res.setEncoding = () => {};
    res.resume = () => {};
    get.last = { url, req, res, cb };
    return req;
  };
  return get;
}

// 要求を開始する。fetchAuditedVersion 呼び出し中に get が同期で呼ばれるので、そこで要求を取り出す
function start(opts = {}) {
  const clock = makeClock();
  const get = makeGet();
  const hb = [];
  const p = au.fetchAuditedVersion({
    url: TEST_URL,
    get,
    timers: clock,
    onHeartbeat: (s) => hb.push(s),
    ...opts,
  });
  const { req, res, cb } = get.last;
  return { p, clock, get, req, res, cb, hb };
}

// 応答ヘッダだけを送る
function respond(ctx, status = 200) {
  ctx.res.statusCode = status;
  ctx.cb(ctx.res);
}

// 応答を送り、本文を流して終了させる
function respondBody(ctx, text, status = 200) {
  respond(ctx, status);
  ctx.res.emit('data', text);
  ctx.res.complete = true;
  ctx.res.emit('end');
}

// Promise の状態を追跡する(await せずに途中経過を確認するため)
function track(p) {
  const s = { state: 'pending', code: null, value: null };
  p.then(
    (v) => {
      s.state = 'ok';
      s.value = v;
    },
    (e) => {
      s.state = 'error';
      s.code = e.code;
    }
  );
  return s;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// (1) 正常系: tag_name を返し、タイマーを残さない
test('1 正常: tag_name を正規化して返し、タイマーを残さない', async () => {
  const c = start();
  respondBody(c, OK_BODY);
  assert.equal(await c.p, '1.2.16');
  assert.equal(c.clock.activeCount(), 0);
});

// (2) 非2xx は E_HTTP と httpStatus
test('2 非2xx は E_HTTP と httpStatus を付けて reject し、通信を打ち切る', async () => {
  const c = start();
  respond(c, 503);
  await assert.rejects(c.p, { code: 'E_HTTP', httpStatus: 503, message: 'HTTP 503' });
  assert.equal(c.req.destroyCount, 1);
  assert.equal(c.clock.activeCount(), 0);
});

test('2 2xx(200 以外)も成功として本文を読む', async () => {
  const c = start();
  respondBody(c, OK_BODY, 201);
  assert.equal(await c.p, '1.2.16');
});

// (3) 要求の error は E_NET で errno を残す
test('3 req の error は E_NET で、errno に Node の code を残す', async () => {
  const c = start();
  const e = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  c.req.emit('error', e);
  await assert.rejects(c.p, {
    code: 'E_NET',
    errno: 'ECONNREFUSED',
    message: 'connect ECONNREFUSED',
  });
  assert.equal(c.clock.activeCount(), 0);
});

// (4) 全体期限は E_NET で message が timeout
test('4 全体期限(timeoutMs)で E_NET と message timeout で reject する', async () => {
  const c = start({ timeoutMs: 15000 });
  const s = track(c.p);
  c.clock.advance(14999);
  await flush();
  assert.equal(s.state, 'pending');
  c.clock.advance(1);
  await assert.rejects(c.p, { code: 'E_NET', message: 'timeout' });
  assert.equal(c.clock.activeCount(), 0);
});

// (5) 応答後 data が stallMs 届かないと E_STALL
test('5 応答後に data が stallMs 届かないと E_STALL で reject する', async () => {
  const c = start({ timeoutMs: 120000, stallMs: 60000 });
  const s = track(c.p);
  respond(c);
  c.clock.advance(59999);
  await flush();
  assert.equal(s.state, 'pending');
  c.clock.advance(1);
  await assert.rejects(c.p, { code: 'E_STALL', stallMs: 60000 });
  assert.equal(c.clock.activeCount(), 0);
});

// (6) data が届き続けている間は E_STALL にならない
test('6 data が届き続ける間は E_STALL にならず、完了まで進む', async () => {
  const c = start({ timeoutMs: 300000, stallMs: 60000 });
  const s = track(c.p);
  respond(c);
  for (let i = 0; i < 5; i += 1) {
    c.clock.advance(30000);
    c.res.emit('data', ' ');
    await flush();
    assert.equal(s.state, 'pending');
  }
  c.res.emit('data', OK_BODY);
  c.res.complete = true;
  c.res.emit('end');
  assert.equal(await c.p, '1.2.16');
  assert.equal(c.clock.activeCount(), 0);
});

// (7) heartbeat は heartbeatMs ごとに経過秒を通知し、完了後は呼ばない
test('7 heartbeat は heartbeatMs ごとに経過秒(切り捨て)を通知し、完了後は呼ばない', async () => {
  const c = start({ heartbeatMs: 1500, timeoutMs: 300000 });
  c.clock.advance(4500);
  assert.deepEqual(c.hb, [1, 3, 4]);
  respond(c);
  c.clock.advance(3000);
  assert.deepEqual(c.hb, [1, 3, 4, 6, 7]);
  c.res.emit('data', OK_BODY);
  c.res.complete = true;
  c.res.emit('end');
  assert.equal(await c.p, '1.2.16');
  const n = c.hb.length;
  c.clock.advance(120000);
  assert.equal(c.hb.length, n);
  assert.equal(c.clock.activeCount(), 0);
});

test('7 既定の heartbeatMs は 5000 で、5 秒ごとに 5, 10, 15 を通知する', async () => {
  // 既定の全体期限(15000)と 15 秒目の刻みが重なるため、期限を延ばして刻みだけを見る
  const c = start({ timeoutMs: 300000 });
  c.clock.advance(15000);
  assert.deepEqual(c.hb, [5, 10, 15]);
  respondBody(c, OK_BODY);
  await c.p;
});

// (8) 形式エラーは E_FORMAT(既存のメッセージを維持)
const formatCases = [
  ['JSON 解析失敗', 'not json', {}, 'JSON の解析に失敗しました'],
  ['ルートが配列', '[]', {}, 'JSON のルートがオブジェクトではありません'],
  ['ルートが null', 'null', {}, 'JSON のルートがオブジェクトではありません'],
  ['tag_name が不正', '{"tag_name":"x"}', {}, 'invalid tag_name'],
  ['サイズ超過', OK_BODY, { maxBytes: 10 }, 'too large'],
];
for (const [name, body, opts, message] of formatCases) {
  test('8 ' + name + ' は E_FORMAT で reject する', async () => {
    const c = start(opts);
    respondBody(c, body);
    await assert.rejects(c.p, { code: 'E_FORMAT', message });
    assert.equal(c.clock.activeCount(), 0);
  });
}

// (9) 完了・失敗のどちらでもタイマーが残らず、失敗後は heartbeat も増えない
test('9 完了・失敗のどの経路でもタイマーが残らず、失敗後に heartbeat を呼ばない', async () => {
  const ok = start();
  respondBody(ok, OK_BODY);
  await ok.p;
  assert.equal(ok.clock.activeCount(), 0);

  const http = start();
  respond(http, 500);
  await assert.rejects(http.p, { code: 'E_HTTP' });
  assert.equal(http.clock.activeCount(), 0);
  const httpHb = http.hb.length;
  http.clock.advance(60000);
  assert.equal(http.hb.length, httpHb);

  const net = start();
  net.req.emit('error', new Error('boom'));
  await assert.rejects(net.p, { code: 'E_NET' });
  assert.equal(net.clock.activeCount(), 0);

  const to = start({ timeoutMs: 15000 });
  to.clock.advance(15000);
  await assert.rejects(to.p, { code: 'E_NET', message: 'timeout' });
  assert.equal(to.clock.activeCount(), 0);
  const toHb = to.hb.length;
  to.clock.advance(60000);
  assert.equal(to.hb.length, toHb);

  const stall = start({ timeoutMs: 120000 });
  respond(stall);
  stall.clock.advance(60000);
  await assert.rejects(stall.p, { code: 'E_STALL' });
  assert.equal(stall.clock.activeCount(), 0);
  const stallHb = stall.hb.length;
  stall.clock.advance(60000);
  assert.equal(stall.hb.length, stallHb);

  const fmt = start();
  respondBody(fmt, 'not json');
  await assert.rejects(fmt.p, { code: 'E_FORMAT' });
  assert.equal(fmt.clock.activeCount(), 0);
});
