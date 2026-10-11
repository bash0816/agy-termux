'use strict';

// テスト専用の preload(node --require で読み込む)。
// https / http / net の通信を偽物に置き換え、実ネットワークに触れないようにする。
// 環境変数:
//   MOCK_HTTPS_MODE  tripwire(通信が呼ばれたら失敗させる) / ok(既定) / http500 / abort / reserr / badjson
//   MOCK_HTTPS_BODY  ok 系で返す本文(既定は {"tag_name":"1.2.16"})
//   MOCK_HTTPS_LOG   呼び出しを1行ずつ追記するファイル(未指定なら記録しない)
//   MOCK_ROUTES      URL ごとの応答を定めた JSON ファイル(指定時は MOCK_HTTPS_MODE より優先。tripwire を除く)
//   MOCK_VA_BITS     '39' / '48' のとき /proc/self/maps を 1 行の偽物にする(未指定なら素通し)
//   MOCK_KEEP_PRELOAD=1  ld-linux の起動時に LD_PRELOAD を消さない(既定は消す)

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const MODE = process.env.MOCK_HTTPS_MODE || 'ok';
const DEFAULT_BODY = '{"tag_name":"1.2.16"}';

// 1行をログファイルへ追記する(MOCK_HTTPS_LOG が無ければ何もしない)
function log(line) {
  if (process.env.MOCK_HTTPS_LOG) {
    fs.appendFileSync(process.env.MOCK_HTTPS_LOG, line + '\n');
  }
}

// 応答の statusCode はコールバックの中で同期的に参照されるため、cb(res) の前に決めておく
function statusOf(mode) {
  return mode === 'http500' ? 500 : 200;
}

// モードに応じて本文・エラーを流す(cb(res) の後に呼ぶ)
function streamBody(res) {
  const body = process.env.MOCK_HTTPS_BODY ?? DEFAULT_BODY;
  switch (MODE) {
    case 'ok':
      res.complete = true;
      res.emit('data', body);
      res.emit('end');
      res.emit('close');
      break;
    case 'http500':
      // statusCode 500 のみ。本文は流さない
      break;
    case 'abort':
      // 本文の前半だけ流し、途中で切断する(complete は false のまま)
      res.emit('data', body.slice(0, Math.floor(body.length / 2)));
      res.emit('aborted');
      res.emit('error', new Error('socket hang up'));
      res.emit('close');
      break;
    case 'reserr':
      res.emit('error', new Error('boom'));
      res.emit('close');
      break;
    case 'badjson':
      res.complete = true;
      res.emit('data', 'not json');
      res.emit('end');
      res.emit('close');
      break;
    default:
      throw new Error('未知の MOCK_HTTPS_MODE: ' + MODE);
  }
}

// MOCK_ROUTES の kind ごとの本文。SHA 不一致を起こすための固定の壊れた内容を含む
const CORRUPT_BODY = Buffer.from('corrupt-body-not-a-tarball\n');

function loadRoutes() {
  return JSON.parse(fs.readFileSync(process.env.MOCK_ROUTES, 'utf8'));
}

function routeBody(route) {
  switch (route.kind) {
    case 'file':
      return fs.readFileSync(route.file);
    case 'body':
      return Buffer.from(route.body, 'utf8');
    case 'corrupt':
      return CORRUPT_BODY;
    case 'empty':
      return Buffer.alloc(0);
    default:
      throw new Error('未知の route kind: ' + route.kind);
  }
}

// MOCK_ROUTES に従って応答する。失敗系も本文・end・close は必ず流す(error の kind を除く)。
// setEncoding が呼ばれたら文字列で流し、呼ばれなければ Buffer のまま流す
function serveRoute(req, cb, url) {
  const route = loadRoutes()[url];
  if (!route) {
    req.emit('error', new Error('mock network error: no route for ' + url));
    return;
  }
  if (route.kind === 'error') {
    req.emit('error', new Error('mock network error'));
    return;
  }
  const res = new EventEmitter();
  res.statusCode = route.status ?? 200;
  res.headers = {};
  res.complete = false;
  res.resume = () => {};
  res.destroy = () => {};
  let encoding = null;
  res.setEncoding = (enc) => {
    encoding = enc;
  };
  if (cb) cb(res);
  setImmediate(() => {
    const body = routeBody(route);
    if (body.length > 0) res.emit('data', encoding ? body.toString(encoding) : body);
    res.complete = true;
    res.emit('end');
    res.emit('close');
  });
}

// MOCK_VA_BITS='39' / '48' のとき /proc/self/maps を 1 行だけの偽物にする(needsPatch() の判定用)。
// 39 は先頭 0x4000000000(2 進 39 桁)、48 は先頭 0x700000000000(2 進 47 桁)
const VA_MAPS = {
  '39': '4000000000-4000001000 r-xp 00000000 00:00 0 /x',
  '48': '700000000000-700000001000 r-xp 00000000 00:00 0 /x',
};
const realReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const bits = process.env.MOCK_VA_BITS;
  const fake = file === '/proc/self/maps' && Object.hasOwn(VA_MAPS, bits) ? VA_MAPS[bits] : undefined;
  if (fake === undefined) return realReadFileSync.call(fs, file, ...rest);
  const enc = typeof rest[0] === 'string' ? rest[0] : rest[0]?.encoding;
  return enc ? fake : Buffer.from(fake);
};

// ld-linux(glibc loader)を起動するときだけ LD_PRELOAD を外す。
// 偽 loader は Node スクリプトで、Termux の bionic プロセスに glibc 用 shim を preload させると起動に失敗するため。
// MOCK_KEEP_PRELOAD=1 のときは外さない
const realSpawn = childProcess.spawn;
childProcess.spawn = function (...all) {
  const [file] = all;
  if (typeof file === 'string' && file.endsWith('ld-linux-aarch64.so.1') && process.env.MOCK_KEEP_PRELOAD !== '1' && all[2]?.env) {
    const env = Object.assign({}, all[2].env);
    delete env.LD_PRELOAD;
    all[2] = Object.assign({}, all[2], { env });
  }
  return realSpawn.apply(this, all);
};

if (MODE === 'tripwire') {
  // 通信系の入口がひとつでも呼ばれたら、ログを残して失敗させる
  const trip = () => {
    log('NETWORK_CALLED');
    throw new Error('NETWORK_CALLED');
  };
  https.get = trip;
  https.request = trip;
  http.get = trip;
  http.request = trip;
  net.connect = trip;
  net.createConnection = trip;
} else {
  https.get = function (url, ...rest) {
    log('GET ' + url);
    const cb = rest.find((x) => typeof x === 'function');
    const req = new EventEmitter();
    req.destroy = () => {};
    setImmediate(() => {
      if (process.env.MOCK_ROUTES) {
        serveRoute(req, cb, url);
        return;
      }
      const res = new EventEmitter();
      res.statusCode = statusOf(MODE);
      res.complete = false;
      res.setEncoding = () => {};
      res.resume = () => {};
      res.destroy = () => {};
      if (cb) cb(res);
      setImmediate(() => streamBody(res));
    });
    return req;
  };
}
