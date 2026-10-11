'use strict';

// 監査済み版(config/agy-verified-versions.json の tag_name)を基準に agy update を判定する
// 依存(通信・npm・ファイル操作・出力)は注入可能にして、単体テストしやすくしている

const path = require('path');

const DEFAULT_URL = 'https://raw.githubusercontent.com/bash0816/agy-termux/main/config/agy-verified-versions.json';
const NUMERIC = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// 先頭の 'v' を1文字だけ許容し、x.y.z(各成分は安全な整数)なら正規化した文字列を返す。不正なら null
function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.startsWith('v') ? raw.slice(1) : raw;
  if (!NUMERIC.test(s)) return null;
  if (!s.split('.').map(Number).every(Number.isSafeInteger)) return null;
  return s;
}

// a が b より新しければ true。形式が不正なら例外
function isNewer(a, b) {
  const na = normalizeTag(a);
  const nb = normalizeTag(b);
  if (na === null || nb === null) {
    throw new Error("バージョン形式を比較できません: '" + a + "' vs '" + b + "'");
  }
  const pa = na.split('.').map(Number);
  const pb = nb.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

// 原因分類つきの Error を作る(code で分類し、props を付与する)
function causedError(code, message, props) {
  const err = new Error(message);
  err.code = code;
  if (props) Object.assign(err, props);
  return err;
}

// 通信層の Error から E_NET を作る。元の message と、Node の code(ECONNREFUSED など)を errno として残す
function netError(e) {
  const message = e && e.message ? e.message : String(e);
  return causedError('E_NET', message, { errno: e && e.code });
}

// 監査済み版の tag_name を取得する。https 以外・タイムアウト・サイズ超過・不正な JSON はすべて reject
// 失敗の Error には code が付く: E_HTTP(非2xx、httpStatus 付き)/ E_NET(通信エラー、errno 付き。全体期限は message 'timeout')/
// E_STALL(応答開始後、data が stallMs 届かない)/ E_FORMAT(JSON・ルート・tag_name・サイズ超過)
// heartbeatMs ごとに onHeartbeat(要求開始からの経過秒) を呼ぶ。経過はタイマーの刻みで数える
function fetchAuditedVersion({ url, timeoutMs = 15000, maxBytes = 65536, stallMs = 60000, heartbeatMs = 5000, onHeartbeat = () => {}, get = require('https').get, timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  return new Promise((resolve, reject) => {
    if (typeof url !== 'string') {
      reject(new Error('url が文字列ではありません'));
      return;
    }
    let protocol;
    try {
      protocol = new URL(url).protocol;
    } catch (e) {
      reject(new Error('url を解析できません'));
      return;
    }
    if (protocol !== 'https:') {
      reject(new Error('https の URL のみ指定できます'));
      return;
    }

    let finished = false;
    let req = null;
    let timer = null;
    let ticker = null;
    let elapsedMs = 0;   // 要求開始からの経過(ticker の刻みで加算)
    let responded = false;
    let lastDataMs = 0;  // 最後に応答または data が届いた時点の経過
    const setIv = timers.setInterval || setInterval;
    const clearIv = timers.clearInterval || clearInterval;
    // 完了は1回だけ。失敗時は通信を打ち切り、タイマー(全体期限・刻み)をすべて外す
    const finish = (err, tag) => {
      if (finished) return;
      finished = true;
      timers.clearTimeout(timer);
      clearIv(ticker);
      if (err) {
        if (req) req.destroy();
        reject(err);
      } else {
        resolve(tag);
      }
    };

    // 刻み(heartbeatMs ごと)。経過の加算、stall 判定、heartbeat 通知を行う
    const tick = () => {
      if (finished) return;
      elapsedMs += heartbeatMs;
      if (responded && elapsedMs - lastDataMs >= stallMs) {
        finish(causedError('E_STALL', 'データが ' + stallMs + 'ms 届きませんでした', { stallMs: stallMs }));
        return;
      }
      onHeartbeat(Math.floor(elapsedMs / 1000));
    };

    req = get(url, (res) => {
      responded = true;
      lastDataMs = elapsedMs;
      if (!(res.statusCode >= 200 && res.statusCode <= 299)) {
        res.resume();
        finish(causedError('E_HTTP', 'HTTP ' + res.statusCode, { httpStatus: res.statusCode }));
        return;
      }
      res.setEncoding('utf8');
      let body = '';
      let size = 0;
      res.on('data', (chunk) => {
        if (finished) return;
        lastDataMs = elapsedMs;
        size += Buffer.byteLength(chunk);
        if (size > maxBytes) {
          finish(causedError('E_FORMAT', 'too large'));
          return;
        }
        body += chunk;
      });
      res.on('error', (e) => finish(netError(e)));
      res.on('aborted', () => finish(causedError('E_NET', 'aborted')));
      res.on('close', () => {
        if (!res.complete) finish(causedError('E_NET', 'closed before end'));
      });
      res.on('end', () => {
        if (finished) return;
        let obj;
        try {
          obj = JSON.parse(body);
        } catch (e) {
          finish(causedError('E_FORMAT', 'JSON の解析に失敗しました'));
          return;
        }
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
          finish(causedError('E_FORMAT', 'JSON のルートがオブジェクトではありません'));
          return;
        }
        const tag = normalizeTag(obj.tag_name);
        if (tag === null) {
          finish(causedError('E_FORMAT', 'invalid tag_name'));
          return;
        }
        finish(null, tag);
      });
    });
    req.on('error', (e) => finish(netError(e)));
    // 全体期限は要求全体で1本。data が届き続けても打ち切る
    if (!finished) {
      timer = timers.setTimeout(() => finish(causedError('E_NET', 'timeout')), timeoutMs);
      ticker = setIv(tick, heartbeatMs);
    }
  });
}

// runInstall の失敗結果({ ok, code, signal, timedOut, stderrTail })を原因別に分類する
// stderrTail は大文字小文字を区別せず調べる。freeMB は空き容量(MB)または null
// 戻り値は { kind, message, remedy }。kind は 'nospace' | 'perm' | 'network' | 'unknown'
function classifyInstallFailure(res, freeMB) {
  const tail = res && typeof res.stderrTail === 'string' ? res.stderrTail : '';
  const upper = tail.toUpperCase();

  if (upper.includes('ENOSPC') || upper.includes('NO SPACE LEFT')) {
    let message = '空き容量が足りません';
    if (typeof freeMB === 'number') message += '(空き 約 ' + freeMB + ' MB)';
    return { kind: 'nospace', message, remedy: '空きを作ってから' };
  }

  const permCodes = ['EACCES', 'EPERM', 'EROFS'];
  if (permCodes.some((c) => upper.includes(c))) {
    let message = '権限エラー';
    // コード名を含む行のうち、シングルクォートで囲まれたパスがある最初の行を使う
    for (const line of tail.split('\n')) {
      const lu = line.toUpperCase();
      if (!permCodes.some((c) => lu.includes(c))) continue;
      const m = /'([^']+)'/.exec(line);
      if (m) {
        message += '(' + m[1] + ')';
        break;
      }
    }
    return { kind: 'perm', message, remedy: '権限を確認してから' };
  }

  const netCodes = ['ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'];
  if (netCodes.some((c) => upper.includes(c)) || (res && res.timedOut)) {
    return { kind: 'network', message: '通信できませんでした', remedy: 'ネットワークを確認してから' };
  }

  const lines = tail.split('\n').filter((line) => line.trim() !== '');
  let message;
  if (lines.length > 0) {
    message = lines[lines.length - 1].trim();
  } else if (res && res.signal) {
    message = 'signal ' + res.signal;
  } else {
    message = 'exit ' + (res ? res.code : null);
  }
  return { kind: 'unknown', message, remedy: '' };
}

// agy update 本体。{ code, installed, pkgDir, from, to, aud, notice, preflight } を返す
// code は終了コード(0 または 1)。installed は npm install が成功した場合だけ true
// pkgDir は installed が true のときだけ自身のパッケージ実体のパス、それ以外は null
// from は現在の版(形式が不正なら null)、to と aud は取得した監査済み版(取得前に返す経路では null)
// notice は registry 不一致の通知を表示したときだけ 'mismatch'、それ以外は null
// preflight は preflight が失敗したときだけ { ok:false, status, reason }(表示は呼び出し側が行う)
// 「更新完了」は表示しない(後続工程の renderFinal が行う)
async function runUpdate(deps) {
  const { makeKey } = require('./notified');
  const cur = normalizeTag(deps.pkgVersion);

  // URL 設定が不正なら、取得には到達させない
  if (deps.urlError !== null && deps.urlError !== undefined) {
    deps.err('[agy] AGY_TERMUX_VERIFIED_URL が不正です(https の URL のみ指定できます): ' + deps.urlError);
    return { code: 1, installed: false, pkgDir: null, from: cur, to: null, aud: null, notice: null };
  }

  if (cur === null) {
    deps.err("[agy] バージョン形式を比較できません: '" + deps.pkgVersion + "'。手動で確認してください。");
    return { code: 1, installed: false, pkgDir: null, from: null, to: null, aud: null, notice: null };
  }

  deps.err('[agy] 監査済み版を確認中...');
  let aud;
  try {
    aud = await deps.fetchAudited(deps.url);
  } catch (e) {
    deps.err('[agy] 監査済み版の確認に失敗しました: ' + e.message);
    return { code: 1, installed: false, pkgDir: null, from: cur, to: null, aud: null, notice: null };
  }

  // 監査済み版が現在より新しくない場合は、npm には問い合わせない
  if (!isNewer(aud, cur)) {
    deps.out('[agy] Already on latest audited version: ' + cur);
    if (isNewer(cur, aud)) deps.out('[agy] (監査済みの最新は ' + aud + ' です)');
    return { code: 0, installed: false, pkgDir: null, from: cur, to: aud, aud, notice: null };
  }

  deps.err('[agy] 公開状況を確認中...');
  const r = await deps.npmViewLatest();
  if (!r.ok) {
    deps.err('[agy] registry の確認に失敗しました: ' + r.reason);
    return { code: 1, installed: false, pkgDir: null, from: cur, to: aud, aud, notice: null };
  }

  // npm の latest が監査済み版と違う場合は更新しない。同じ組合せの通知は履歴にあれば出さない
  if (r.version !== aud) {
    const key = makeKey(cur, aud, r.version);
    let notice = null;
    if (!deps.notified.has(key) && deps.notified.record(key)) {
      deps.out('[agy] 監査済み版 ' + aud + ' は npm の latest (' + r.version + ') と一致しないため、更新を見送りました(使用中: ' + cur + ')');
      notice = 'mismatch';
    }
    return { code: 0, installed: false, pkgDir: null, from: cur, to: aud, aud, notice };
  }

  // 自分自身の場所が分からないまま更新すると、別の prefix を更新してしまうため中止する
  const prefix = deps.detectPrefix();
  if (!prefix) {
    deps.err('[agy] 自身の実際のインストール位置を検出できませんでした。');
    deps.err('[agy] このまま更新すると、別の場所(npmのデフォルトprefix)を誤って更新してしまう恐れがあるため中止します。');
    deps.err('[agy] 実行中のスクリプトの実体: ' + deps.realFilePath());
    deps.err('[agy] 手動で更新するには、上記パスから推定されるprefixを指定して以下を実行してください:');
    deps.err('[agy]   npm install -g --prefix <検出したprefix> @bash0816/agy-termux@' + aud);
    return { code: 1, installed: false, pkgDir: null, from: cur, to: aud, aud, notice: null };
  }

  // 配置前の事前確認。失敗時は何も表示せず、パッケージも更新しない(表示は呼び出し側が行う)
  const pf = await deps.preflight();
  if (!pf.ok) {
    return {
      code: pf.status === 'error' ? 1 : 0,
      installed: false,
      pkgDir: null,
      from: cur,
      to: aud,
      aud,
      notice: null,
      preflight: { ok: false, status: pf.status, reason: pf.reason },
    };
  }

  deps.err('[agy] ' + cur + ' → ' + aud + ' に更新します... (prefix: ' + prefix + ')');
  const ri = await deps.runInstall(prefix, aud, { timeoutMs: 60000 });
  if (!ri.ok) {
    // 失敗後は実状態を読み直して結果を決める(自動復旧は1回だけ)
    const pkgDir = path.join(prefix, 'lib', 'node_modules', '@bash0816', 'agy-termux');
    const cause = classifyInstallFailure(ri, deps.freeMB ? deps.freeMB(prefix) : null);
    const keepCurrent = () => {
      deps.err('[agy] 更新に失敗しました(' + cause.message + ')。バージョンは ' + cur + ' のままです。もう一度 agy update を実行してください');
      return { code: 1, installed: false, pkgDir: null, from: cur, to: aud, aud, notice: null };
    };

    // (a) 元の版 cur が無事
    const pl = deps.checkPlacement(pkgDir, prefix, cur);
    if (pl.complete) return keepCurrent();

    // (b) npm は配置を終えてから失敗した(新しい版 aud が完全)
    const pl2 = deps.checkPlacement(pkgDir, prefix, aud);
    if (pl2.complete) {
      return {
        code: 0,
        installed: true,
        pkgDir,
        from: cur,
        to: aud,
        aud,
        notice: null,
        installWarning: cause.message,
      };
    }

    // (c) どちらも不完全。元の版 cur を1回だけ入れ直す
    deps.err('[agy] パッケージが不完全です。元の版 ' + cur + ' を入れ直します...');
    const rr = await deps.runInstall(prefix, cur, { timeoutMs: 120000 });
    const pl3 = deps.checkPlacement(pkgDir, prefix, cur);
    if (pl3.complete) return keepCurrent();

    const rc = classifyInstallFailure(rr, deps.freeMB ? deps.freeMB(prefix) : null);
    deps.err('[agy] パッケージが不完全な状態です(元の版 ' + cur + ' の入れ直しも失敗しました: ' + rc.message + ')。' + (rc.remedy ? rc.remedy + '、' : '') + '次のコマンドを実行してください:');
    deps.err('  npm install -g --prefix ' + prefix + ' @bash0816/agy-termux@' + cur);
    return { code: 1, installed: false, pkgDir: null, from: cur, to: aud, aud, notice: null };
  }
  return {
    code: 0,
    installed: true,
    pkgDir: path.join(prefix, 'lib', 'node_modules', '@bash0816', 'agy-termux'),
    from: cur,
    to: aud,
    aud,
    notice: null,
  };
}

// 実環境の依存を組み立てる
function createDeps({
  spawnSync,
  realpathSync,
  filename,
  https,
  env,
  out,
  err,
  computePrefix,
  pkgVersion,
  notifiedFile = null,
  runNpm = require('./run-npm').runNpm,
  checkPlacementImpl = require('./install-state').checkPlacement,
  fsImpl = require('fs'),
  randomHex = () => require('crypto').randomBytes(8).toString('hex'),
  preflight = async () => ({ ok: true }),
}) {
  // AGY_TERMUX_VERIFIED_URL が未定義なら既定 URL。定義済み(空文字を含む)なら https の URL のみ受け付ける
  let url = DEFAULT_URL;
  let urlError = null;
  const v = env.AGY_TERMUX_VERIFIED_URL;
  if (v !== undefined) {
    let ok = false;
    try {
      ok = new URL(v).protocol === 'https:';
    } catch (e) {
      ok = false;
    }
    if (ok) {
      url = v;
    } else {
      url = null;
      urlError = v;
    }
  }

  const fetchAudited = (u) =>
    fetchAuditedVersion({
      url: u,
      get: https.get,
      onHeartbeat: (s) => err('  ...監査済み版の確認 (経過 ' + s + ' 秒)'),
    });

  // 公開状況(npm の latest)を問い合わせる。stdout は結果の stdout から読む(forward:false)
  const npmViewLatest = async () => {
    const r = await runNpm(['view', '@bash0816/agy-termux@latest', 'version'], {
      label: '公開状況の確認',
      timeoutMs: 15000,
      forward: false,
      write: (stream, text) => {
        // forward:false では stdout は転送されず、heartbeat(stderr)だけが届く
        if (stream === 'stderr') err(text.replace(/\n$/, ''));
      },
    });
    if (!r.ok) {
      let reason;
      if (r.timedOut) {
        reason = 'timeout';
      } else {
        const lines = r.stderrTail.split('\n').filter((line) => line.trim() !== '');
        reason = lines.length > 0 ? lines[lines.length - 1] : 'exit ' + r.code;
      }
      return { ok: false, reason };
    }
    const stdout = (typeof r.stdout === 'string' ? r.stdout : '').trim();
    const version = normalizeTag(stdout);
    if (version === null) return { ok: false, reason: '不正な出力: ' + stdout };
    return { ok: true, version };
  };

  // npm install を実行する。結果({ ok, code, signal, timedOut, stderrTail })をそのまま返す
  const runInstall = async (prefix, version, opts) =>
    runNpm(['install', '-g', '--prefix', prefix, '@bash0816/agy-termux@' + version], {
      label: '更新',
      timeoutMs: (opts && opts.timeoutMs) || 60000,
      termGraceMs: 10000,
      forward: true,
      write: (stream, text) => (stream === 'stdout' ? out : err)(text.replace(/\n$/, '')),
    });

  // 配置完了の判定。nonce は呼び出しごとに新しく作る
  const checkPlacement = (pkgDir, prefix, expectedVersion) =>
    checkPlacementImpl({
      pkgDir,
      prefix,
      expectedVersion,
      nonce: randomHex(),
      fs: fsImpl,
      realpath: fsImpl.realpathSync,
    });

  // 通知履歴。notifiedFile が null なら履歴を使えないので、通知は出さない(record は偽)
  const { loadNotified, hasNotified, recordNotified } = require('./notified');
  const notified =
    notifiedFile === null
      ? { has: () => false, record: () => false }
      : {
          has: (key) => hasNotified(loadNotified(notifiedFile, fsImpl), key),
          record: (key) => recordNotified(notifiedFile, key, fsImpl),
        };

  // 空き容量(MB)。statfsSync が無い・失敗したときは null
  const freeMB = (p) => {
    try {
      if (typeof fsImpl.statfsSync !== 'function') return null;
      const s = fsImpl.statfsSync(p);
      return Math.floor((s.bavail * s.bsize) / 1048576);
    } catch {
      return null;
    }
  };

  const detectPrefix = () => {
    try {
      return computePrefix(realpathSync(filename));
    } catch {
      return null;
    }
  };

  const realFilePath = () => {
    try {
      return realpathSync(filename);
    } catch {
      return filename;
    }
  };

  return {
    pkgVersion,
    url,
    urlError,
    fetchAudited,
    npmViewLatest,
    detectPrefix,
    realFilePath,
    runInstall,
    checkPlacement,
    notified,
    preflight,
    freeMB,
    out,
    err,
  };
}

module.exports = { DEFAULT_URL, normalizeTag, isNewer, fetchAuditedVersion, classifyInstallFailure, runUpdate, createDeps };
