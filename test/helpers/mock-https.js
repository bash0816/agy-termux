'use strict';

// テスト専用の preload(node --require で読み込む)。
// https / http / net の通信を偽物に置き換え、実ネットワークに触れないようにする。
// 環境変数:
//   MOCK_HTTPS_MODE  tripwire(通信が呼ばれたら失敗させる) / ok(既定) / http500 / abort / reserr / badjson
//   MOCK_HTTPS_BODY  ok 系で返す本文(既定は {"tag_name":"1.2.16"})
//   MOCK_HTTPS_LOG   呼び出しを1行ずつ追記するファイル(未指定なら記録しない)

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
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
