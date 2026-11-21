'use strict';

// bin/agy.js の buildSyncDeps が返す同意まわりの依存(hasConsent / confirmCompat)の配線テスト。
// bin/agy.js は読み込み時に os.homedir() で同意ファイルの場所を決めるため、
// HOME を一時ディレクトリにした子プロセスで読み込んで確認する。
// 実ネットワーク・実 HOME(~/.agy-termux)・TUI には触れない。
// 端末の入力は、子プロセス内で process.stdin.isTTY を立てて piped な回答を読ませる(FAKE_TTY=1 のとき)。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGY = path.resolve(__dirname, '..', 'bin', 'agy.js');

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// 一時ディレクトリに HOME を作る。consentObj が undefined なら同意ファイルは作らない(未保存の環境)
function makeHome(consentObj) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-consent-wiring-'));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const consentFile = path.join(home, '.agy-termux', '.consent');
  if (consentObj !== undefined) {
    fs.mkdirSync(path.dirname(consentFile), { recursive: true });
    fs.writeFileSync(consentFile, JSON.stringify(consentObj));
  }
  return { home, consentFile, prefix: path.join(root, 'prefix') };
}

// 子プロセスで buildSyncDeps を組み立て、hasConsent('download') と confirmCompat() の結果を JSON で返す
function probe({ home, prefix }, { input = '', fakeTty = false }) {
  const script = `
    if (process.env.FAKE_TTY === '1') Object.defineProperty(process.stdin, 'isTTY', { value: true });
    const { buildSyncDeps } = require(${JSON.stringify(AGY)});
    buildSyncDeps().then(async (deps) => {
      const hasDownload = deps.hasConsent('download');
      const compat = await deps.confirmCompat();
      process.stdout.write(JSON.stringify({ hasDownload, compat }));
    }).catch((e) => { console.error(e && e.stack || e); process.exit(2); });
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    input,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PREFIX: prefix,
      FAKE_TTY: fakeTty ? '1' : '0',
    },
  });
  assert.equal(r.error, undefined, 'probe の起動に失敗: ' + (r.error && r.error.message));
  assert.equal(r.status, 0, 'probe が異常終了: ' + r.stderr.slice(-500));
  return JSON.parse(r.stdout);
}

test('buildSyncDeps.hasConsent: 同意ファイルが無い環境では download は false', () => {
  const env = makeHome(undefined);
  assert.deepEqual(probe(env, {}).hasDownload, false);
});

test('buildSyncDeps.hasConsent: download が保存済みなら true(常に false の stub ではない)', () => {
  const env = makeHome({ download: true });
  assert.deepEqual(probe(env, {}).hasDownload, true);
});

test('buildSyncDeps.confirmCompat: 端末で拒否(n)なら false、保存はしない', () => {
  const env = makeHome({ download: true });
  const before = fs.readFileSync(env.consentFile, 'utf8');
  const result = probe(env, { input: 'n\n', fakeTty: true });
  assert.equal(result.compat, false);
  assert.equal(fs.readFileSync(env.consentFile, 'utf8'), before, '拒否のときは同意ファイルを書き換えない');
});

test('buildSyncDeps.confirmCompat: 入力なし(非 TTY・EOF)なら false、保存はしない', () => {
  const env = makeHome({ download: true });
  const before = fs.readFileSync(env.consentFile, 'utf8');
  assert.equal(probe(env, { input: '', fakeTty: false }).compat, false);
  assert.equal(fs.readFileSync(env.consentFile, 'utf8'), before);
});

test('buildSyncDeps.confirmCompat: 端末で承諾(y)なら true、compat を保存する', () => {
  const env = makeHome({ download: true });
  assert.equal(probe(env, { input: 'y\n', fakeTty: true }).compat, true);
  const saved = JSON.parse(fs.readFileSync(env.consentFile, 'utf8'));
  assert.equal(saved.compat, true);
});

test('buildSyncDeps.confirmCompat: 保存済み compat なら質問せず true', () => {
  const env = makeHome({ download: true, compat: true });
  assert.equal(probe(env, { input: '', fakeTty: false }).compat, true);
});
