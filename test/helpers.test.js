'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const wiring = require('./helpers/wiring');

test('wiring 偽 npm は版別 fixture と呼出し順シナリオで配置する', (t) => {
  const root = wiring.makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'prefix');
  const fakeBin = wiring.makeFakeNpm(root);
  const a = path.join(root, 'a'); const b = path.join(root, 'b');
  fs.mkdirSync(a); fs.writeFileSync(path.join(a, 'marker'), 'A');
  fs.mkdirSync(b); fs.writeFileSync(path.join(b, 'marker'), 'B');
  const log = path.join(root, 'npm.log');
  const env = { ...process.env, PATH: fakeBin + ':' + process.env.PATH, NPM_LOG: log,
    FAKE_NPM_SEQUENCE: 'swap,fail_after_swap', FAKE_NPM_PKG_1_2_16: a, FAKE_NPM_PKG_1_3_0: b };
  const invoke = (version) => spawnSync(path.join(fakeBin, 'npm'), ['install', '-g', '--prefix', prefix, '@bash0816/agy-termux@' + version], { env });
  assert.equal(invoke('1.2.16').status, 0);
  assert.equal(fs.readFileSync(path.join(wiring.stdPackageDir(prefix), 'marker'), 'utf8'), 'A');
  assert.equal(invoke('1.3.0').status, 1);
  assert.equal(fs.readFileSync(path.join(wiring.stdPackageDir(prefix), 'marker'), 'utf8'), 'B');
  assert.equal(fs.readFileSync(log + '.count', 'utf8'), '2');
});

test('wiring 偽 tar は指定した失敗を返し、未指定時は実 tar に委譲する', (t) => {
  const root = wiring.makeRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = wiring.makeFakeTar(root);
  const failed = spawnSync(path.join(dir, 'tar'), ['-x'], { encoding: 'utf8', env: { ...process.env, FAKE_TAR_MODE: 'enospc' } });
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /No space left on device/);
});

test('wiring 偽 loader は対象ファイルが無いと非 0 で終了する', (t) => {
  const root = wiring.makeRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'prefix'); const loader = wiring.makeFakeLoader(prefix);
  const r = spawnSync(loader, ['--library-path', path.join(root, 'lib'), path.join(root, 'missing')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot open/);
});

test('runAgyAsync は stdout/stderr 到着イベントと時刻を返す', async (t) => {
  const root = wiring.makeRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agy = path.join(root, 'agy.js');
  fs.writeFileSync(agy, "process.stdout.write('first\\n'); setTimeout(() => { process.stderr.write('second\\n'); }, 20);");
  const sb = { agy, home: root, fakeBin: root, npmLog: path.join(root, 'npm.log'), mockLog: path.join(root, 'https.log') };
  const r = await wiring.runAgyAsync(sb, [], {}, { timeoutMs: 3000 });
  assert.equal(r.status, 0); assert.equal(r.timedOut, false);
  assert.deepEqual(r.events.map((e) => e.stream), ['stdout', 'stderr']);
  assert.ok(r.events[1].t >= r.events[0].t);
  assert.match(r.events[0].text, /first/); assert.match(r.events[1].text, /second/);
});

test('mock-https MOCK_SCRIPT はファイル定義のヘッダ・遅延チャンク・destroy 記録を返す', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mock-script-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptFile = path.join(root, 'script.json'); const logFile = path.join(root, 'log');
  const url = 'https://mock.invalid/test';
  fs.writeFileSync(scriptFile, JSON.stringify({ [url]: { status: 206, contentLength: true, chunks: [
    { delayMs: 0, text: 'head' }, { delayMs: 100, text: 'late' },
  ] } }));
  const source = `const https=require('node:https'); https.get(${JSON.stringify(url)}, r=>{ console.log('STATUS '+r.statusCode+' LENGTH '+r.headers['content-length']); r.once('data', d=>{console.log('DATA '+d); r.destroy();}); r.on('data', d=>console.log('DATA '+d)); });`;
  const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 3000, env: {
    ...process.env, NODE_OPTIONS: `--require ${wiring.MOCK}`, MOCK_SCRIPT: scriptFile, MOCK_HTTPS_LOG: logFile,
  } });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /STATUS 206 LENGTH 8/);
  assert.match(child.stdout, /DATA head/);
  assert.doesNotMatch(child.stdout, /DATA late/);
  assert.match(fs.readFileSync(logFile, 'utf8'), new RegExp('DESTROY ' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('mock-https MOCK_SCRIPT JSON 文字列で Location を含むリダイレクト元を定義できる', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mock-json-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = 'https://mock.invalid/a'; const b = 'https://mock.invalid/b';
  const script = JSON.stringify({ [a]: { status: 302, location: b, stop: true }, [b]: { status: 200, chunks: [{ delayMs: 0, text: 'ok' }] } });
  const source = `const https=require('node:https'); https.get(${JSON.stringify(a)}, r=>console.log(r.statusCode+' '+r.headers.location));`;
  const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 3000,
    env: { ...process.env, NODE_OPTIONS: `--require ${wiring.MOCK}`, MOCK_SCRIPT: script } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), '302 ' + b);
});

test('mock-https MOCK_SCRIPT はリダイレクト鎖を遷移先シナリオまで返す', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mock-chain-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = 'https://mock.invalid/a'; const b = 'https://mock.invalid/b';
  const script = JSON.stringify({ [a]: { status: 302, location: b }, [b]: { status: 200, contentLength: true, chunks: [{ delayMs: 0, text: 'done' }] } });
  const source = `const https=require('node:https'); function get(u){https.get(u,r=>{if(r.statusCode>=300&&r.statusCode<400)return get(r.headers.location);r.on('data',d=>process.stdout.write(d));});}get(${JSON.stringify(a)});`;
  const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 3000,
    env: { ...process.env, NODE_OPTIONS: `--require ${wiring.MOCK}`, MOCK_SCRIPT: script } });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'done');
});

test('mock-https MOCK_DESTROY_DELAYED=fire は destroy 後の予定チャンクを発火する', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mock-fire-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const url = 'https://mock.invalid/fire';
  const script = JSON.stringify({ [url]: { chunks: [{ delayMs: 0, text: 'first' }, { delayMs: 40, text: 'late' }] } });
  const source = `const https=require('node:https'); https.get(${JSON.stringify(url)},r=>{r.on('data',d=>{process.stdout.write(d);if(String(d)==='first')r.destroy();});});`;
  const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 3000,
    env: { ...process.env, NODE_OPTIONS: `--require ${wiring.MOCK}`, MOCK_SCRIPT: script, MOCK_DESTROY_DELAYED: 'fire' } });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'firstlate');
});
