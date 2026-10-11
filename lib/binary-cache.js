'use strict';

// 版付きバイナリキャッシュ。ファイル名にタグを含め、古い版の掃除は agy update が成功したときだけ行う
// 依存(fs・プロセス確認・時刻・通信・パッチ)は注入可能にして、単体テストで実ファイルや通信に触れないようにしている

const fs = require('fs');
const path = require('path');

const NUMERIC = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MIN_BINARY_SIZE = 10 * 1024 * 1024;
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// 掃除の対象になるバージョン付きファイル名(完全一致のみ)
const PRUNE_NAME = /^agy-(\d+\.\d+\.\d+)\.(va39|bin)$/;
// 中断された書き込みの一時ファイル名(pid と乱数を含む)
const TMP_NAME = /^agy-\d+\.\d+\.\d+\.(va39|bin)\.(\d+)\.[0-9a-f]+\.tmp$/;
// 旧版の命名規則で残りうるファイル(手動掃除の候補としてだけ表示する)
const LEGACY_NAMES = ['agy.va39', '.bin', '.version', '.bin.tmp'];

// 先頭の 'v' を1文字だけ許容し、x.y.z の形式なら正規化した文字列を返す。不正なら例外
function normalizeCacheTag(raw) {
  if (typeof raw !== 'string') throw new Error('タグが文字列ではありません');
  const s = raw.startsWith('v') ? raw.slice(1) : raw;
  if (!NUMERIC.test(s)) throw new Error("タグの形式が不正です: '" + raw + "'");
  return s;
}

// agy-<tag>.va39 (パッチ版) または agy-<tag>.bin (非パッチ版)
function cacheFileName(tag, isPatch) {
  return 'agy-' + normalizeCacheTag(tag) + (isPatch ? '.va39' : '.bin');
}

// unverified 指定時は dir/unverified 配下を返す(監査前の取得物を分けて置くため)
function cachePaths({ dir, tag, isPatch, unverified }) {
  const d = unverified ? path.join(dir, 'unverified') : dir;
  return { dir: d, file: path.join(d, cacheFileName(tag, isPatch)) };
}

// 書き込み用の一時ファイル名。同じ dir 内に置くことで rename を原子的にする
function tmpPathFor(file, pid, rand) {
  return file + '.' + pid + '.' + rand + '.tmp';
}

// 実行中プロセスのアドレス空間が 39bit 以下ならパッチが必要。判定できなければ安全側(パッチあり)
function needsPatch(readFileSync = fs.readFileSync) {
  try {
    const maps = readFileSync('/proc/self/maps', 'utf8').trim().split('\n');
    const highest = Math.max(...maps.map(l => parseInt(l.split('-')[0], 16)));
    return highest.toString(2).length <= 39;
  } catch { return true; }
}

// キャッシュが使えるか。存在・10MiB 以上・ELF マジックバイトを確認する。例外はすべて false
function isCacheValid(fsDeps = fs, file) {
  let fd;
  try {
    if (!fsDeps.existsSync(file)) return false;
    if (fsDeps.statSync(file).size < MIN_BINARY_SIZE) return false;
    fd = fsDeps.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fsDeps.readSync(fd, head, 0, 4, 0);
    return head[0] === 0x7F && head.toString('ascii', 1, 4) === 'ELF';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fsDeps.closeSync(fd); } catch {} }
  }
}

// ダウンロード → (必要ならパッチ) → 一時ファイルへ書き込み → rename で配置する
// 失敗時は自分の一時ファイルだけを消し、既存の file や他のファイルには触れない
async function installBinary(deps, { meta, isPatch, file }) {
  const buf = await deps.download(meta.downloadUrl, meta.sha256Tar, meta.sha256Binary);
  // applyVA39Patch は in-place で書き換えて counts を返すため、戻り値ではなく buf を書き出す
  if (isPatch) deps.patch(buf);
  const tmp = tmpPathFor(file, deps.pid, deps.randomHex());
  try {
    deps.fs.mkdirSync(path.dirname(file), { recursive: true });
    deps.fs.writeFileSync(tmp, buf, { mode: 0o700 });
    deps.fs.renameSync(tmp, file);
  } catch (e) {
    // 掃除の失敗で元のエラーを隠さないようにする
    try { deps.fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  return file;
}

// 版の比較。数値として比べるので 1.10.0 は 1.9.0 より新しい
function compareVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// 古いキャッシュを掃除する。pinTag と、残りの中で最も新しい1版だけを残す。
// 中断された一時ファイルは、所有プロセスが存在せず24時間以上経過したものだけ消す
// 例外は投げず、実際に消したファイル名の配列を返す
function prune(deps, { dir, pinTag }) {
  const deleted = [];
  let pin;
  try {
    pin = normalizeCacheTag(pinTag);
  } catch {
    return deleted;
  }
  let entries;
  try {
    entries = deps.readdirSync(dir);
  } catch {
    return deleted;
  }

  // (i) バージョン付きファイルをタグごとにまとめ、タグの更新時刻(両拡張子の最大)を求める
  const tags = new Map();
  for (const name of entries) {
    const m = PRUNE_NAME.exec(name);
    if (!m) continue;
    const tag = m[1];
    if (!tags.has(tag)) tags.set(tag, { names: [], mtime: -Infinity, ok: true });
    const info = tags.get(tag);
    info.names.push(name);
    try {
      info.mtime = Math.max(info.mtime, deps.statSync(path.join(dir, name)).mtimeMs);
    } catch {
      // 時刻が分からないタグは、残す判断にも消す判断にも使わない
      info.ok = false;
    }
  }

  let keeper = null;
  for (const [tag, info] of tags) {
    if (!info.ok || tag === pin) continue;
    if (keeper === null) { keeper = tag; continue; }
    const cur = tags.get(keeper);
    if (info.mtime > cur.mtime || (info.mtime === cur.mtime && compareVersion(tag, keeper) > 0)) {
      keeper = tag;
    }
  }

  for (const [tag, info] of tags) {
    if (!info.ok || tag === pin || tag === keeper) continue;
    for (const name of info.names) {
      try {
        deps.unlinkSync(path.join(dir, name));
        deleted.push(name);
      } catch {}
    }
  }

  // (ii) 中断された一時ファイルの掃除。pid が 'esrch' かつ 24時間以上前のものだけ対象
  for (const name of entries) {
    const m = TMP_NAME.exec(name);
    if (!m) continue;
    try {
      if (deps.killPid(Number(m[2])) !== 'esrch') continue;
      const full = path.join(dir, name);
      if (deps.now() - deps.statSync(full).mtimeMs < TEMP_MAX_AGE_MS) continue;
      deps.unlinkSync(full);
      deleted.push(name);
    } catch {}
  }

  return deleted;
}

// 自動では消さず、手動 rm の候補として一覧にする。何も削除しない
// 旧版のファイル・unverified 配下・agy- で始まり掃除の対象外の名前が対象
function listManualCleanup(deps, { dir }) {
  const empty = { files: [], total: 0 };
  let entries;
  try {
    entries = deps.readdirSync(dir);
  } catch {
    return empty;
  }

  const candidates = [];
  for (const name of entries) {
    if (LEGACY_NAMES.includes(name)) {
      candidates.push(path.join(dir, name));
    } else if (name.startsWith('agy-') && !PRUNE_NAME.test(name) && !TMP_NAME.test(name)) {
      candidates.push(path.join(dir, name));
    }
  }
  const unverifiedDir = path.join(dir, 'unverified');
  try {
    for (const name of deps.readdirSync(unverifiedDir)) {
      candidates.push(path.join(unverifiedDir, name));
    }
  } catch {}

  const files = [];
  for (const p of candidates) {
    try {
      files.push({ path: p, size: deps.statSync(p).size });
    } catch {}
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, total: files.reduce((sum, f) => sum + f.size, 0) };
}

// agy update から呼ばれる同期処理。結果の status と reason を返す
// 掃除と案内は status が current / synced のときだけ行う
async function syncBinary(deps) {
  const { meta, dir, isPatch } = deps;

  if (!deps.hasConsent('download')) {
    deps.out('[agy] 今回はバイナリ同期を省略しました: 初回の同意が必要です。agy を一度起動して同意してください');
    return { status: 'skipped', reason: 'consent' };
  }

  if (!deps.loaderExists()) {
    deps.err('[agy] glibc loader が見つかりません。');
    deps.err('  pkg install glibc-repo && pkg install glibc');
    return { status: 'error', reason: 'loader' };
  }

  // タグ不正時の例外は握りつぶさず呼び出し元へ伝える
  const { file } = cachePaths({ dir, tag: meta.tagName, isPatch });

  if (isCacheValid(deps.fsDeps, file)) {
    deps.out('[agy] バイナリは最新です (' + meta.tagName + ')');
    afterSuccess(deps);
    return { status: 'current' };
  }

  if (isPatch && !deps.hasConsent('compat')) {
    const agreed = await deps.confirmCompat();
    if (!agreed) {
      deps.out('[agy] 今回はバイナリ取得を省略しました: 互換調整に同意されませんでした');
      return { status: 'skipped', reason: 'compat' };
    }
  }

  try {
    await deps.install(file);
  } catch (e) {
    deps.err('[agy] バイナリの取得に失敗しました: ' + ((e && e.message) || String(e)));
    deps.err('ネットワークを確認して agy update を再実行するか、agy を起動してください');
    return { status: 'error', reason: 'install' };
  }

  deps.out('[agy] バイナリを ' + meta.tagName + ' に更新しました');
  afterSuccess(deps);
  return { status: 'synced', file };
}

// 掃除と手動掃除の案内。失敗しても同期結果には影響させない
function afterSuccess(deps) {
  try {
    deps.prune(deps.meta.tagName);
  } catch {}
  try {
    const manual = deps.listManualCleanup();
    if (!manual || manual.files.length === 0) return;
    deps.out('[agy] 手動で削除できる古いファイルがあります:');
    for (const f of manual.files) {
      deps.out('  ' + f.path + ' (' + f.size + ' bytes)');
    }
    deps.out('[agy] 合計: ' + manual.total + ' bytes');
    deps.out('[agy] 実行中の agy が無いことを確認してから rm で削除できます');
  } catch {}
}

module.exports = {
  normalizeCacheTag,
  cacheFileName,
  cachePaths,
  tmpPathFor,
  needsPatch,
  isCacheValid,
  installBinary,
  prune,
  listManualCleanup,
  syncBinary,
};
