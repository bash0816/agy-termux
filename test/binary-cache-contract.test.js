'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bc = require('../lib/binary-cache.js');

const MIN_SIZE = 10 * 1024 * 1024;
const ELF_HEAD = [0x7f, 0x45, 0x4c, 0x46];
// utimes と突き合わせるための固定の現在時刻(秒)
const NOW_SEC = 2000000000;
const DAY_SEC = 24 * 60 * 60;
const META = {
  tagName: '1.2.16',
  downloadUrl: 'https://example.invalid/agy_cli_linux_arm64.tar.gz',
  sha256Tar: 'aa',
  sha256Binary: 'bb',
};

// 一時ディレクトリを作り、テスト終了時に削除する
function mkTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir() || process.env.TMPDIR, 'agy-bc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// name → { sec, size } で、指定の大きさと更新時刻の実ファイルを作る
function writeSized(dir, entries) {
  for (const [name, { sec, size }] of Object.entries(entries)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(size));
    fs.utimesSync(p, sec, sec);
  }
  return dir;
}

// prune 用の依存。実ファイルに触れ、呼び出しを記録する
function pruneDeps(over = {}) {
  const seen = { stat: [], unlink: [], killPid: [] };
  const deps = {
    readdirSync: (d) => fs.readdirSync(d),
    statSync: (p) => { seen.stat.push(p); return fs.statSync(p); },
    unlinkSync: (p) => { seen.unlink.push(p); fs.unlinkSync(p); },
    killPid: (pid) => { seen.killPid.push(pid); return 'alive'; },
    now: () => NOW_SEC * 1000,
    ...over,
  };
  return { deps, seen };
}

// isCacheValid 用の偽 fsDeps。実ファイルには触れない
function fakeFsDeps({ exists = true, size = MIN_SIZE, head = ELF_HEAD } = {}) {
  return {
    existsSync: () => exists,
    statSync: () => ({ size }),
    openSync: () => 3,
    readSync: (fd, buf, off, len) => {
      Buffer.from(head).copy(buf, off, 0, len);
      return len;
    },
    closeSync: () => {},
  };
}

// syncBinary 用の依存。呼び出し順と出力を記録する
function syncDeps(over = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const deps = {
    meta: { ...META },
    dir: '/virtual/cache',
    isPatch: true,
    hasConsent: (key) => { calls.push('hasConsent:' + key); return true; },
    loaderExists: () => { calls.push('loaderExists'); return true; },
    confirmCompat: async () => { calls.push('confirmCompat'); return true; },
    install: async (file) => { calls.push('install:' + file); },
    fsDeps: fakeFsDeps({ exists: false }),
    prune: (pinTag) => { calls.push('prune:' + pinTag); return { files: [], count: 0, bytes: 0 }; },
    listManualCleanup: () => { calls.push('listManualCleanup'); return { files: [], total: 0 }; },
    out: (m) => out.push(m),
    err: (m) => err.push(m),
    ...over,
  };
  return { deps, calls, out, err };
}

// installBinary 用の依存。実ファイルへの書き込みは一時ディレクトリ内に限る
function installDeps(over = {}) {
  return {
    download: async () => Buffer.from('NEW-BINARY'),
    patch: () => ({ ubfx: 0, lsl: 0, mask: 0, mmap: 0, word: 0 }),
    fs: {
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      rmSync: fs.rmSync,
    },
    pid: 1234,
    randomHex: () => 'abcdef',
    ...over,
  };
}

// --- prune ---

test('prune: 旧形式の agy.va39・.bin・.version は10分より古ければ消し、files・count・bytes に入る', (t) => {
  const old = NOW_SEC - 3600;
  const dir = writeSized(mkTmp(t), {
    'agy.va39': { sec: old, size: 100 },
    '.bin': { sec: old, size: 11 },
    '.version': { sec: old, size: 7 },
  });
  const { deps } = pruneDeps();
  const r = bc.prune(deps, { dir, pinTag: '1.2.16' });
  assert.deepEqual(r.files.sort(), ['.bin', '.version', 'agy.va39']);
  assert.equal(r.count, 3);
  assert.equal(r.bytes, 118);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('prune: .bin.tmp は24時間以上前のときだけ消し、24時間未満(10分より古い)は残す', (t) => {
  const keptDir = writeSized(mkTmp(t), {
    '.bin.tmp': { sec: NOW_SEC - (DAY_SEC - 1), size: 5 },
  });
  const kept = bc.prune(pruneDeps().deps, { dir: keptDir, pinTag: '1.2.16' });
  assert.deepEqual(kept.files, []);
  assert.deepEqual(fs.readdirSync(keptDir), ['.bin.tmp']);

  const midDir = writeSized(mkTmp(t), {
    '.bin.tmp': { sec: NOW_SEC - 3600, size: 5 },
  });
  const mid = bc.prune(pruneDeps().deps, { dir: midDir, pinTag: '1.2.16' });
  assert.deepEqual(mid.files, []);
  assert.deepEqual(fs.readdirSync(midDir), ['.bin.tmp']);

  const oldDir = writeSized(mkTmp(t), {
    '.bin.tmp': { sec: NOW_SEC - DAY_SEC, size: 5 },
  });
  const old = bc.prune(pruneDeps().deps, { dir: oldDir, pinTag: '1.2.16' });
  assert.deepEqual(old.files, ['.bin.tmp']);
  assert.deepEqual(fs.readdirSync(oldDir), []);
});

test('prune: mtime が現在から10分以内のファイルは、旧形式・古いタグの版別ファイル・.bin.tmp のどれも消さない', (t) => {
  const recent = NOW_SEC - 60;
  const dir = writeSized(mkTmp(t), {
    'agy.va39': { sec: recent, size: 1 },
    '.bin.tmp': { sec: recent, size: 1 },
    // 古いタグ(pin でも最新でもない)で、10分以内なので残る
    'agy-1.0.0.bin': { sec: recent, size: 1 },
    // 残すべき最新の版
    'agy-2.0.0.bin': { sec: recent + 30, size: 1 },
  });
  const { deps } = pruneDeps();
  const r = bc.prune(deps, { dir, pinTag: '9.9.9' });
  assert.deepEqual(r.files, []);
  assert.equal(r.count, 0);
  assert.equal(r.bytes, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.bin.tmp', 'agy-1.0.0.bin', 'agy-2.0.0.bin', 'agy.va39']);
});

test('prune: 10分ちょうど前のファイルは残し、10分より1秒でも古ければ消す', (t) => {
  const keepDir = writeSized(mkTmp(t), {
    'agy.va39': { sec: NOW_SEC - 600, size: 1 },
  });
  const kept = bc.prune(pruneDeps().deps, { dir: keepDir, pinTag: '1.2.16' });
  assert.deepEqual(kept.files, []);
  assert.deepEqual(fs.readdirSync(keepDir), ['agy.va39']);

  const delDir = writeSized(mkTmp(t), {
    'agy.va39': { sec: NOW_SEC - 601, size: 1 },
  });
  const del = bc.prune(pruneDeps().deps, { dir: delDir, pinTag: '1.2.16' });
  assert.deepEqual(del.files, ['agy.va39']);
  assert.deepEqual(fs.readdirSync(delDir), []);
});

test('prune: 複数ファイルを消したとき count は件数、bytes は削除前 size の合計になる', (t) => {
  const old = NOW_SEC - 3600;
  const dir = writeSized(mkTmp(t), {
    'agy.va39': { sec: old, size: 100 },
    '.version': { sec: old, size: 7 },
    '.bin': { sec: old, size: 11 },
    // 古いタグ 1.0.0 は両拡張子とも削除対象
    'agy-1.0.0.bin': { sec: NOW_SEC - 7200, size: 250 },
    'agy-1.0.0.va39': { sec: NOW_SEC - 7200, size: 50 },
    // 残す版(最新)
    'agy-2.0.0.bin': { sec: NOW_SEC - 3600, size: 999 },
    // 削除対象の古いタグ(2.0.0 より古い)
    'agy-0.5.0.bin': { sec: NOW_SEC - 9000, size: 30 },
  });
  const { deps } = pruneDeps();
  const r = bc.prune(deps, { dir, pinTag: '9.9.9' });
  assert.deepEqual(r.files.sort(), [
    '.bin', '.version', 'agy-0.5.0.bin', 'agy-1.0.0.bin', 'agy-1.0.0.va39', 'agy.va39',
  ]);
  assert.equal(r.count, 6);
  assert.equal(r.bytes, 100 + 7 + 11 + 250 + 50 + 30);
  assert.deepEqual(fs.readdirSync(dir), ['agy-2.0.0.bin']);
});

test('prune: unlink が失敗したファイルは files・count・bytes に含めず、残りは集計する', (t) => {
  const old = NOW_SEC - 3600;
  const dir = writeSized(mkTmp(t), {
    'agy.va39': { sec: old, size: 100 },
    '.version': { sec: old, size: 7 },
    'agy-1.0.0.bin': { sec: NOW_SEC - 7200, size: 250 },
    'agy-2.0.0.bin': { sec: NOW_SEC - 3600, size: 999 },
  });
  const { deps } = pruneDeps({
    unlinkSync: (p) => {
      if (p.endsWith('agy-1.0.0.bin')) throw new Error('EPERM');
      fs.unlinkSync(p);
    },
  });
  const r = bc.prune(deps, { dir, pinTag: '9.9.9' });
  assert.deepEqual(r.files.sort(), ['.version', 'agy.va39']);
  assert.equal(r.count, 2);
  assert.equal(r.bytes, 107);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['agy-1.0.0.bin', 'agy-2.0.0.bin']);
});

// --- syncBinary ---

test('syncBinary: キャッシュが有効なら current。出力は空', async () => {
  const { deps, out, err } = syncDeps({ fsDeps: fakeFsDeps() });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, {
    status: 'current', detail: '', tag: '1.2.16',
    file: path.join('/virtual/cache', 'agy-1.2.16.va39'),
    deleted: { count: 0, bytes: 0 },
  });
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
});

test('syncBinary: 取得が成功したら synced。出力は空', async () => {
  const { deps, out, err } = syncDeps({ isPatch: false });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, {
    status: 'synced', detail: '', tag: '1.2.16',
    file: path.join('/virtual/cache', 'agy-1.2.16.bin'),
    deleted: { count: 0, bytes: 0 },
  });
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
});

test('syncBinary: 初回の同意が拒否されたら skipped(consent_declined)。出力は空', async () => {
  const { deps, out, err } = syncDeps({ hasConsent: () => false });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, {
    status: 'skipped', reason: 'consent_declined', detail: '', tag: '1.2.16',
    deleted: { count: 0, bytes: 0 },
  });
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
});

test('syncBinary: 互換の確認を拒否されたら skipped(compat_declined)。取得はしない', async () => {
  const { deps, calls, out, err } = syncDeps({
    hasConsent: (key) => key === 'download',
    confirmCompat: async () => false,
  });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, {
    status: 'skipped', reason: 'compat_declined', detail: '', tag: '1.2.16',
    deleted: { count: 0, bytes: 0 },
  });
  assert.equal(calls.includes('install:' + path.join('/virtual/cache', 'agy-1.2.16.va39')), false);
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
});

test('syncBinary: loader が無ければ error(loader)。出力は空', async () => {
  const { deps, out, err } = syncDeps({ loaderExists: () => false });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, {
    status: 'error', reason: 'loader', detail: '', tag: '1.2.16',
    deleted: { count: 0, bytes: 0 },
  });
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
});

test('syncBinary: 取得の失敗で error.code があれば reason にその code を入れる', async () => {
  const { deps, out, err } = syncDeps({
    install: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
  });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, {
    status: 'error', reason: 'ENOSPC', detail: 'disk full', tag: '1.2.16',
    deleted: { count: 0, bytes: 0 },
    error: { code: 'ENOSPC', detail: 'disk full' },
  });
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
});

test('syncBinary: 取得の失敗で error.code が無ければ reason は install。出力は空', async () => {
  const { deps, out, err } = syncDeps({
    install: async () => { throw new Error('net down'); },
  });
  const r = await bc.syncBinary(deps);
  assert.deepEqual(r, {
    status: 'error', reason: 'install', detail: 'net down', tag: '1.2.16',
    deleted: { count: 0, bytes: 0 },
    error: { detail: 'net down' },
  });
  assert.deepEqual(out, []);
  assert.deepEqual(err, []);
});

// --- installBinary の onPhase ---

test('installBinary: パッチ版は 互換調整 → 保存 の順に onPhase を呼ぶ', async (t) => {
  const dir = mkTmp(t);
  const file = path.join(dir, 'agy-1.2.16.va39');
  const phases = [];
  await bc.installBinary(installDeps({ onPhase: (m) => phases.push(m) }), {
    meta: META, isPatch: true, file,
  });
  assert.deepEqual(phases, ['互換調整をしています...', '保存しています...']);
});

test('installBinary: 非パッチ版は 保存 だけを onPhase で呼ぶ', async (t) => {
  const dir = mkTmp(t);
  const file = path.join(dir, 'agy-1.2.16.bin');
  const phases = [];
  await bc.installBinary(installDeps({ onPhase: (m) => phases.push(m) }), {
    meta: META, isPatch: false, file,
  });
  assert.deepEqual(phases, ['保存しています...']);
});

test('installBinary: onPhase が未定義でも例外にならず、ファイルを配置する', async (t) => {
  const dir = mkTmp(t);
  const file = path.join(dir, 'agy-1.2.16.bin');
  const result = await bc.installBinary(installDeps(), { meta: META, isPatch: false, file });
  assert.equal(result, file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'NEW-BINARY');
});

// --- afterSuccess ---

test('syncBinary: 成功後の掃除で listManualCleanup を呼ばず、案内も出さない', async () => {
  for (const over of [{ fsDeps: fakeFsDeps() }, {}]) {
    const { deps, calls, out, err } = syncDeps({ isPatch: false, ...over });
    const r = await bc.syncBinary(deps);
    assert.ok(['current', 'synced'].includes(r.status));
    assert.equal(calls.includes('listManualCleanup'), false);
    assert.ok(calls.includes('prune:1.2.16'));
    assert.deepEqual(out, []);
    assert.deepEqual(err, []);
  }
});

test('syncBinary: prune が例外のときは deleted が { count: 0, bytes: 0 } になる', async () => {
  for (const over of [{ fsDeps: fakeFsDeps() }, {}]) {
    const { deps } = syncDeps({
      isPatch: false,
      ...over,
      prune: () => { throw new Error('prune boom'); },
    });
    const r = await bc.syncBinary(deps);
    assert.deepEqual(r.deleted, { count: 0, bytes: 0 });
  }
});

// --- installBinary: download への onPhase / progress / stallMs の受け渡し ---

test('installBinary: download の第4引数に deps.onPhase・deps.progress・deps.stallMs が渡る', async (t) => {
  const dir = mkTmp(t);
  const file = path.join(dir, 'agy-1.2.16.bin');
  const onPhase = () => {};
  const progress = () => {};
  const stallMs = 12345;
  let captured;
  const deps = installDeps({
    download: async (...args) => { captured = args; return Buffer.from('NEW-BINARY'); },
    onPhase,
    progress,
    stallMs,
  });
  await bc.installBinary(deps, { meta: META, isPatch: false, file });
  assert.equal(captured.length, 4);
  assert.deepEqual(captured.slice(0, 3), [META.downloadUrl, META.sha256Tar, META.sha256Binary]);
  assert.equal(captured[3].onPhase, onPhase);
  assert.equal(captured[3].progress, progress);
  assert.equal(captured[3].stallMs, stallMs);
});

test('installBinary: download に渡す項目が未定義でも例外にならず、第4引数は渡る(中身は undefined)', async (t) => {
  const dir = mkTmp(t);
  const file = path.join(dir, 'agy-1.2.16.bin');
  let captured;
  const deps = installDeps({
    download: async (...args) => { captured = args; return Buffer.from('NEW-BINARY'); },
  });
  const result = await bc.installBinary(deps, { meta: META, isPatch: false, file });
  assert.equal(result, file);
  assert.equal(captured.length, 4);
  assert.equal(typeof captured[3], 'object');
  assert.notEqual(captured[3], null);
  assert.equal(captured[3].onPhase, undefined);
  assert.equal(captured[3].progress, undefined);
  assert.equal(captured[3].stallMs, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), 'NEW-BINARY');
});

test('installBinary: 呼出し順は download → 互換調整 → 保存 の onPhase のまま変わらない', async (t) => {
  const dir = mkTmp(t);
  const file = path.join(dir, 'agy-1.2.16.bin');
  const calls = [];
  const deps = installDeps({
    download: async () => { calls.push('download'); return Buffer.from('NEW-BINARY'); },
    patch: () => { calls.push('patch'); return { ubfx: 0, lsl: 0, mask: 0, mmap: 0, word: 0 }; },
    onPhase: (m) => calls.push(`phase:${m}`),
    progress: () => {},
    stallMs: 1000,
  });
  await bc.installBinary(deps, { meta: META, isPatch: true, file });
  assert.deepEqual(calls, [
    'download',
    'phase:互換調整をしています...',
    'patch',
    'phase:保存しています...',
  ]);
});
