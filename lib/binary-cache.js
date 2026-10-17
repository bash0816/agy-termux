'use strict';

// 版付きバイナリキャッシュ。ファイル名にタグを含め、古い版の掃除は agy update が成功したときだけ行う
// 依存(fs・プロセス確認・時刻・通信・パッチ)は注入可能にして、単体テストで実ファイルや通信に触れないようにしている

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateExpectation, matchRuntime } = require('./va39-expectation');
const { VA39_CODES, va39Error } = require('./errors');
const PATCHER_REV = require('./patcher-rev.json').rev;

const NUMERIC = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MIN_BINARY_SIZE = 10 * 1024 * 1024;
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// 掃除の対象になるバージョン付きファイル名(完全一致のみ)。新世代 va39r2・旧世代 va39・原本 bin をタグ単位で扱う
const PRUNE_NAME = /^agy-(\d+\.\d+\.\d+)\.(va39r2|va39|bin)$/;
// 中断された書き込みの一時ファイル名(pid と乱数を含む)。ロック作成用の一時ファイルも含む
const TMP_NAME = /^agy-\d+\.\d+\.\d+\.(va39r2|va39|bin|lock)\.(\d+)\.[0-9a-f]+\.tmp$/;
// ロックファイル名(prune は消さず、手動掃除の候補からも除外する)
const LOCK_NAME = /^agy-\d+\.\d+\.\d+\.lock$/;
// 旧版の命名規則で残りうるファイル(手動掃除の候補としてだけ表示する)
const LEGACY_NAMES = ['agy.va39', '.bin', '.version', '.bin.tmp'];

// 先頭の 'v' を1文字だけ許容し、x.y.z の形式なら正規化した文字列を返す。不正なら例外
function normalizeCacheTag(raw) {
  if (typeof raw !== 'string') throw new Error('タグが文字列ではありません');
  const s = raw.startsWith('v') ? raw.slice(1) : raw;
  if (!NUMERIC.test(s)) throw new Error("タグの形式が不正です: '" + raw + "'");
  return s;
}

// agy-<tag>.va39r2 (パッチ版) または agy-<tag>.bin (非パッチ版)
function cacheFileName(tag, isPatch) {
  return 'agy-' + normalizeCacheTag(tag) + (isPatch ? '.va39r2' : '.bin');
}

// 未パッチの原本。isPatch に関係なく常に agy-<tag>.bin
function originalFileName(tag) {
  return 'agy-' + normalizeCacheTag(tag) + '.bin';
}

// 旧世代のパッチ版 agy-<tag>.va39(掃除の対象としてだけ扱う)
function legacyPatchedFileName(tag) {
  return 'agy-' + normalizeCacheTag(tag) + '.va39';
}

// ロックファイル agy-<tag>.lock
function lockFileName(tag) {
  return 'agy-' + normalizeCacheTag(tag) + '.lock';
}

// unverified 指定時は dir/unverified 配下を返す(監査前の取得物を分けて置くため)
// file は従来どおりの意味(isPatch に応じた名前)。original・legacy・lock は同じ d 内の絶対パス
function cachePaths({ dir, tag, isPatch, unverified }) {
  const d = unverified ? path.join(dir, 'unverified') : dir;
  return {
    dir: d,
    file: path.join(d, cacheFileName(tag, isPatch)),
    original: path.join(d, originalFileName(tag)),
    legacy: path.join(d, legacyPatchedFileName(tag)),
    lock: path.join(d, lockFileName(tag)),
  };
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
  const buf = await deps.download(meta.downloadUrl, meta.sha256Tar, meta.sha256Binary, { onPhase: deps.onPhase, progress: deps.progress, stallMs: deps.stallMs });
  // applyVA39Patch は in-place で書き換えて counts を返すため、戻り値ではなく buf を書き出す
  if (isPatch) {
    deps.onPhase?.('互換調整をしています...');
    deps.patch(buf);
  }
  const tmp = tmpPathFor(file, deps.pid, deps.randomHex());
  deps.onPhase?.('保存しています...');
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

// 旧形式の名前のうち、経過時間に関係なく消すもの
const LEGACY_ALWAYS = ['agy.va39', '.bin', '.version'];
// 削除の直前に再 stat し、mtime が現在から10分以内のものは消さない(書込み中の可能性があるため)
const RECENT_GUARD_MS = 10 * 60 * 1000;

// 削除の直前に stat し直して判定し、消す。extraOk が渡されたら経過時間がそれを満たすときだけ消す
// 消したときは削除前の size を返し、消さなかった・失敗したときは null を返す
function removeNow(deps, full, extraOk) {
  let st;
  try { st = deps.statSync(full); } catch { return null; }
  const age = deps.now() - st.mtimeMs;
  if (age <= RECENT_GUARD_MS) return null;
  if (extraOk && !extraOk(age)) return null;
  try { deps.unlinkSync(full); } catch { return null; }
  return typeof st.size === 'number' ? st.size : 0;
}

// 古いキャッシュを掃除する。pinTag と、残りの中で最も新しい1版だけを残す。
// 旧形式の名前(agy.va39・.bin・.version)は常に消し、.bin.tmp は24時間以上前のものだけ消す。
// 中断された一時ファイルは、所有プロセスが存在せず24時間以上経過したものだけ消す
// 例外は投げず、{ files, count, bytes } を返す(files は実際に消したファイル名、bytes は削除前の size の合計)
function prune(deps, { dir, pinTag }) {
  const deleted = [];
  let bytes = 0;
  const result = () => ({ files: deleted, count: deleted.length, bytes });
  const take = (name, size) => { deleted.push(name); bytes += size; };
  let pin;
  try {
    pin = normalizeCacheTag(pinTag);
  } catch {
    return result();
  }
  let entries;
  try {
    entries = deps.readdirSync(dir);
  } catch {
    return result();
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
      const size = removeNow(deps, path.join(dir, name));
      if (size !== null) take(name, size);
    }
  }

  // (ii) 旧形式の名前の掃除。.bin.tmp だけは24時間以上前のものに限る
  for (const name of entries) {
    if (LEGACY_ALWAYS.includes(name)) {
      const size = removeNow(deps, path.join(dir, name));
      if (size !== null) take(name, size);
    } else if (name === '.bin.tmp') {
      const size = removeNow(deps, path.join(dir, name), (age) => age >= TEMP_MAX_AGE_MS);
      if (size !== null) take(name, size);
    }
  }

  // (iii) 中断された一時ファイルの掃除。pid が 'esrch' かつ 24時間以上前のものだけ対象
  for (const name of entries) {
    const m = TMP_NAME.exec(name);
    if (!m) continue;
    try {
      if (deps.killPid(Number(m[2])) !== 'esrch') continue;
    } catch {
      continue;
    }
    const size = removeNow(deps, path.join(dir, name), (age) => age >= TEMP_MAX_AGE_MS);
    if (size !== null) take(name, size);
  }

  return result();
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
    } else if (name.startsWith('agy-') && !PRUNE_NAME.test(name) && !TMP_NAME.test(name) && !LOCK_NAME.test(name)) {
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

// 例外から構造化情報を取り出す。値は同名のフィールドをコピーし、detail は message
const ERROR_FIELDS = ['code', 'httpStatus', 'errno', 'path', 'stage'];
function errorInfo(e) {
  const info = {};
  if (e && typeof e === 'object') {
    for (const k of ERROR_FIELDS) {
      if (e[k] !== undefined && e[k] !== null) info[k] = e[k];
    }
  }
  const msg = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e ?? '');
  if (msg !== '') info.detail = msg;
  return info;
}

// syncBinary の戻り値。reason・file・error は該当するときだけ含める
function syncResult(status, tag, { reason, detail = '', file, deleted, error } = {}) {
  const r = { status };
  if (reason !== undefined) r.reason = reason;
  r.detail = detail;
  r.tag = tag;
  r.deleted = deleted || { count: 0, bytes: 0 };
  if (file !== undefined) r.file = file;
  if (error !== undefined) r.error = error;
  return r;
}

// agy update から呼ばれる同期処理。表示はせず、型付きの結果を返す(進捗の onPhase だけは呼ぶ)
// 掃除は status が current / synced のときだけ行い、その結果を deleted に入れる
async function syncBinary(deps) {
  const { meta, dir, isPatch } = deps;
  const tag = meta.tagName;

  if (!deps.hasConsent('download')) {
    return syncResult('skipped', tag, { reason: 'consent_declined' });
  }

  if (!deps.loaderExists()) {
    return syncResult('error', tag, { reason: 'loader' });
  }

  // タグ不正時の例外は握りつぶさず呼び出し元へ伝える
  const { file } = cachePaths({ dir, tag, isPatch });

  // deps.ensure があれば取得と判定を ensure に任せる(事前の isCacheValid と install は使わない)
  if (deps.ensure) {
    if (isPatch && !deps.hasConsent('compat')) {
      const agreed = await deps.confirmCompat();
      if (!agreed) {
        return syncResult('skipped', tag, { reason: 'compat_declined' });
      }
    }
    let r;
    try {
      r = await deps.ensure({ forceRefresh: false });
    } catch (e) {
      return failureResult(tag, e);
    }
    const status = r.source === 'cache' ? 'current' : 'synced';
    return syncResult(status, tag, { file: r.file, deleted: afterSuccess(deps) });
  }

  if (isCacheValid(deps.fsDeps, file)) {
    return syncResult('current', tag, { file, deleted: afterSuccess(deps) });
  }

  if (isPatch && !deps.hasConsent('compat')) {
    const agreed = await deps.confirmCompat();
    if (!agreed) {
      return syncResult('skipped', tag, { reason: 'compat_declined' });
    }
  }

  deps.onPhase?.('取得します...');
  try {
    await deps.install(file);
  } catch (e) {
    return failureResult(tag, e);
  }

  return syncResult('synced', tag, { file, deleted: afterSuccess(deps) });
}

// 取得の失敗を error の結果にする(install と ensure の両方で使う)
function failureResult(tag, e) {
  const error = errorInfo(e);
  const reason = e && typeof e.code === 'string' && e.code !== '' ? e.code : 'install';
  return syncResult('error', tag, { reason, detail: error.detail || '', error });
}

// 掃除を行い、削除の件数と合計バイトを返す。失敗しても同期結果には影響させない
// 手動掃除の案内は出さない(listManualCleanup は関数として残す)
function afterSuccess(deps) {
  try {
    const r = deps.prune(deps.meta.tagName);
    return { count: r?.count ?? 0, bytes: r?.bytes ?? 0 };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

// ---- ensureBinary (原本 .bin と VA39 パッチ済み成果物 .va39r2 を用意する単一の入口) ----
// 制約: unverified 指定時は期待値(expectation)による検査を行わない。構造検証(patch 成功・サイズ・ELF)のみ。
// 失敗を投げ直す前に findUsableArtifact で再確認し、有効な成果物があれば 'recovered' で成功にする。
// 例外: 入口の EXPECTATION_MISSING は救済しない。

function defaultSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 先頭が ELF マジックかどうか。例外は false
function hasElfHead(fsDeps, file) {
  let fd;
  try {
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

// 使える成果物のパスを返し、無ければ null。例外は投げない
// VA39 pin は .bin の存在では成功にせず、.va39r2 の期待サイズと ELF マジックで判定する
// unverified は期待値を見ず isCacheValid だけで判定する
function findUsableArtifact(deps, ctx) {
  try {
    const { meta, dir, isPatch, unverified } = ctx;
    const paths = cachePaths({ dir, tag: meta.tagName, isPatch, unverified });
    if (unverified) return isCacheValid(deps.fs, paths.file) ? paths.file : null;
    if (isPatch) {
      if (!deps.fs.existsSync(paths.file)) return null;
      if (deps.fs.statSync(paths.file).size !== meta.expectation?.va39_patched_size) return null;
      return hasElfHead(deps.fs, paths.file) ? paths.file : null;
    }
    return isCacheValid(deps.fs, paths.original) ? paths.original : null;
  } catch {
    return null;
  }
}

// 一意名の一時ファイルへ書いてから rename で配置する。失敗時は自分の一時ファイルだけを消す
function writeAtomic(deps, file, buf) {
  const tmp = tmpPathFor(file, deps.pid, deps.randomHex());
  try {
    deps.fs.writeFileSync(tmp, buf, { flag: 'wx', mode: 0o700 });
    deps.fs.renameSync(tmp, file);
  } catch (e) {
    // 同名の一時ファイルが既にある場合(EEXIST)は他者のものかもしれないので消さない
    if (e?.code !== 'EEXIST') { try { deps.fs.unlinkSync(tmp); } catch {} }
    throw e;
  }
}

// ロック取得後の本体。原本の用意・パッチ・配置を行う
async function produceArtifact(deps, { meta, isPatch, unverified, forceRefresh, paths, fctx }) {
  const va39Pin = isPatch && !unverified;
  const sha256 = deps.sha256 ?? defaultSha256;
  const patcherRev = deps.patcherRev ?? PATCHER_REV;

  // 3. ロック取得直後の再確認
  if (!forceRefresh) {
    const f = findUsableArtifact(deps, fctx);
    if (f !== null) return { file: f, source: 'waited' };
  }

  // 4. 入力の原本。VA39 pin のみ既存の .bin を再利用する(SHA 不一致なら採用せず、ファイルには触れない)
  let buf = null;
  let source = 'downloaded';
  if (va39Pin && !forceRefresh) {
    try {
      const cand = deps.fs.readFileSync(paths.original);
      if (sha256(cand) === meta.sha256Binary) { buf = cand; source = 'regenerated'; }
    } catch {
      // 読めない・無い場合は無い扱い
    }
  }
  if (buf === null) {
    await deps.hooks?.at('before-download');
    if (!forceRefresh) {
      const f = findUsableArtifact(deps, fctx);
      if (f !== null) return { file: f, source: 'waited' };
    }
    deps.onPhase?.('取得します...');
    buf = await deps.download(meta.downloadUrl, meta.sha256Tar, meta.sha256Binary, { onPhase: deps.onPhase, progress: deps.progress, stallMs: deps.stallMs });
  }

  // VA48 pin / unverified 非パッチ: 原本をそのまま保存して終了
  if (!isPatch) {
    writeAtomic(deps, paths.original, buf);
    return { file: paths.original, source: 'downloaded' };
  }

  // VA39 pin: パッチの前に原本 .bin を保存する(再利用した場合は保存し直さない)
  if (va39Pin && source === 'downloaded') {
    writeAtomic(deps, paths.original, buf);
    await deps.hooks?.at('after-original-saved');
  }

  // 5. パッチと検証。buf は in-place で書き換わる
  deps.onPhase?.('互換調整をしています...');
  const result = deps.patch(buf);
  if (va39Pin) {
    const actual = {
      rev: patcherRev,
      counts: { ubfx: result.ubfx, lsl: result.lsl, mask: result.mask, mmap: result.mmap, word: result.word },
      containers: result.containers,
      patchedSha256: sha256(buf),
      patchedSize: buf.length,
    };
    const m = matchRuntime(meta.expectation, actual);
    if (!m.ok) throw va39Error(VA39_CODES.COUNT_MISMATCH, { detail: m.mismatches.join('; ') });
  } else {
    // unverified: 期待値は見ず、構造的な検証のみ
    const elf = buf.length >= 4 && buf[0] === 0x7F && buf.toString('ascii', 1, 4) === 'ELF';
    if (buf.length < MIN_BINARY_SIZE || !elf) throw va39Error(VA39_CODES.PATCH_UNSUPPORTED, { detail: '構造検証に失敗' });
  }

  // 6. 配置。VA39 pin は直前に再確認し、他者が有効な成果物を置いていればそれを採用する
  await deps.hooks?.at('before-place');
  // forceRefresh のときは再確認を行わず、取得した検証済みの新しい成果物で上書きする
  if (va39Pin && !forceRefresh) {
    const f = findUsableArtifact(deps, fctx);
    if (f !== null) return { file: f, source: 'waited' };
  }
  writeAtomic(deps, paths.file, buf);
  if (va39Pin) {
    // 旧世代 .va39 は best-effort で消す。原本 .bin は消さない
    try { deps.fs.unlinkSync(paths.legacy); } catch {}
  }
  return { file: paths.file, source };
}

// 成果物を用意して { file, source } を返す。source は cache / regenerated / downloaded / waited / recovered
// forceRefresh は既存の成果物と .bin を使わず取得を試みる(失敗時は再確認で既存の有効な成果物を救済する)
async function ensureBinary(deps, ctx) {
  const { meta, dir, isPatch = false, unverified = false, forceRefresh = false } = ctx;
  const fctx = { meta, dir, isPatch: !!isPatch, unverified: !!unverified };
  const paths = cachePaths({ dir, tag: meta.tagName, isPatch: !!isPatch, unverified: !!unverified });

  // 0. VA39 pin の入口検査。失敗は成功扱いに救済しない
  if (isPatch && !unverified) {
    const v = validateExpectation(meta.expectation, { allowLegacy: false });
    if (!v.ok) throw va39Error(VA39_CODES.EXPECTATION_MISSING, { detail: v.errors.join('; ') });
  }

  // 1. 既存の有効な成果物
  if (!forceRefresh) {
    const f = findUsableArtifact(deps, fctx);
    if (f !== null) return { file: f, source: 'cache' };
  }

  // 2. ロック取得。待機中に他者が完成させたら 'waited'。以降の失敗は再確認で救済する
  let lock;
  try {
    if (!deps.fs.existsSync(paths.dir)) deps.fs.mkdirSync(paths.dir, { recursive: true });
    lock = await deps.acquireLock(paths.lock, {
      checkDone: () => findUsableArtifact(deps, fctx) !== null,
      onWait: ({ ownerPid } = {}) => deps.onPhase?.('他の agy が準備中です(pid ' + (ownerPid ?? '不明') + ')'),
    });
  } catch (e) {
    const f = findUsableArtifact(deps, fctx);
    if (f !== null) return { file: f, source: 'recovered' };
    throw e;
  }
  if (!lock.acquired) {
    const f = findUsableArtifact(deps, fctx);
    if (f === null) throw new Error('完成した成果物を確認できませんでした');
    return { file: f, source: 'waited' };
  }

  try {
    return await produceArtifact(deps, { meta, isPatch: !!isPatch, unverified: !!unverified, forceRefresh, paths, fctx });
  } catch (e) {
    // 失敗を投げ直す前に再確認し、有効な成果物があれば救済する
    const f = findUsableArtifact(deps, fctx);
    if (f !== null) return { file: f, source: 'recovered' };
    throw e;
  } finally {
    // 解放の失敗は結果を覆さない
    try { lock.release(); } catch {}
  }
}

module.exports = {
  normalizeCacheTag,
  cacheFileName,
  originalFileName,
  legacyPatchedFileName,
  lockFileName,
  cachePaths,
  tmpPathFor,
  needsPatch,
  isCacheValid,
  installBinary,
  prune,
  listManualCleanup,
  syncBinary,
  ensureBinary,
};
