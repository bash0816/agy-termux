'use strict';

// 監査済み版(config/agy-verified-versions.json の tag_name)を基準に agy update を判定する
// 依存(通信・npm・ファイル操作・出力)は注入可能にして、単体テストしやすくしている

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

// 監査済み版の tag_name を取得する。https 以外・タイムアウト・サイズ超過・不正な JSON はすべて reject
function fetchAuditedVersion({ url, timeoutMs = 15000, maxBytes = 65536, get = require('https').get, timers = { setTimeout, clearTimeout } }) {
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
    // 完了は1回だけ。失敗時は通信を打ち切る
    const finish = (err, tag) => {
      if (finished) return;
      finished = true;
      timers.clearTimeout(timer);
      if (err) {
        if (req) req.destroy();
        reject(err);
      } else {
        resolve(tag);
      }
    };

    req = get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(new Error('HTTP ' + res.statusCode));
        return;
      }
      res.setEncoding('utf8');
      let body = '';
      let size = 0;
      res.on('data', (chunk) => {
        if (finished) return;
        size += Buffer.byteLength(chunk);
        if (size > maxBytes) {
          finish(new Error('too large'));
          return;
        }
        body += chunk;
      });
      res.on('error', (e) => finish(e));
      res.on('aborted', () => finish(new Error('aborted')));
      res.on('close', () => {
        if (!res.complete) finish(new Error('closed before end'));
      });
      res.on('end', () => {
        if (finished) return;
        let obj;
        try {
          obj = JSON.parse(body);
        } catch (e) {
          finish(new Error('JSON の解析に失敗しました'));
          return;
        }
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
          finish(new Error('JSON のルートがオブジェクトではありません'));
          return;
        }
        const tag = normalizeTag(obj.tag_name);
        if (tag === null) {
          finish(new Error('invalid tag_name'));
          return;
        }
        finish(null, tag);
      });
    });
    req.on('error', (e) => finish(e));
    // 全体期限は要求全体で1本。data が届き続けても打ち切る
    if (!finished) timer = timers.setTimeout(() => finish(new Error('timeout')), timeoutMs);
  });
}

// agy update 本体。終了コード(0 または 1)を返す
async function runUpdate(deps) {
  // URL 設定が不正なら、取得には到達させない
  if (deps.urlError !== null && deps.urlError !== undefined) {
    deps.err('[agy] AGY_TERMUX_VERIFIED_URL が不正です(https の URL のみ指定できます): ' + deps.urlError);
    return 1;
  }

  const cur = normalizeTag(deps.pkgVersion);
  if (cur === null) {
    deps.err("[agy] バージョン形式を比較できません: '" + deps.pkgVersion + "'。手動で確認してください。");
    return 1;
  }

  deps.err('[agy] 監査済み版を確認中...');
  let aud;
  try {
    aud = await deps.fetchAudited(deps.url);
  } catch (e) {
    deps.err('[agy] 監査済み版の確認に失敗しました: ' + e.message);
    return 1;
  }

  // 監査済み版が現在より新しくない場合は、npm には問い合わせない
  if (!isNewer(aud, cur)) {
    deps.out('[agy] Already on latest audited version: ' + cur);
    if (isNewer(cur, aud)) deps.out('[agy] (監査済みの最新は ' + aud + ' です)');
    return 0;
  }

  const r = deps.npmViewLatest();
  if (!r.ok) {
    deps.err('[agy] registry の確認に失敗しました: ' + r.reason);
    return 1;
  }
  // npm の latest が監査済み版と違う場合は、どちらが正しいか判断できないので更新しない
  if (r.version !== aud) {
    deps.out('[agy] 監査済み版 ' + aud + ' と npm の latest (' + r.version + ') が一致しないため、更新しません。');
    return 0;
  }

  // 自分自身の場所が分からないまま更新すると、別の prefix を更新してしまうため中止する
  const prefix = deps.detectPrefix();
  if (!prefix) {
    deps.err('[agy] 自身の実際のインストール位置を検出できませんでした。');
    deps.err('[agy] このまま更新すると、別の場所(npmのデフォルトprefix)を誤って更新してしまう恐れがあるため中止します。');
    deps.err('[agy] 実行中のスクリプトの実体: ' + deps.realFilePath());
    deps.err('[agy] 手動で更新するには、上記パスから推定されるprefixを指定して以下を実行してください:');
    deps.err('[agy]   npm install -g --prefix <検出したprefix> @bash0816/agy-termux@' + aud);
    return 1;
  }

  deps.err('[agy] ' + cur + ' → ' + aud + ' に更新します... (prefix: ' + prefix + ')');
  const ri = deps.runInstall(prefix, aud);
  if (!ri.ok) {
    deps.err('[agy] 更新に失敗しました。前のバージョンに戻すには: npm install -g --prefix ' + prefix + ' @bash0816/agy-termux@' + cur);
    return 1;
  }
  deps.out('[agy] 更新完了');
  return 0;
}

// 実環境の依存を組み立てる
function createDeps({ spawnSync, realpathSync, filename, https, env, out, err, computePrefix, pkgVersion }) {
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

  const fetchAudited = (u) => fetchAuditedVersion({ url: u, get: https.get });

  const npmViewLatest = () => {
    const r = spawnSync('npm', ['view', '@bash0816/agy-termux@latest', 'version'], { shell: false, encoding: 'utf8', timeout: 15000 });
    if (r.error || r.status !== 0) {
      return { ok: false, reason: r.error ? r.error.message : 'exit ' + r.status };
    }
    const stdout = typeof r.stdout === 'string' ? r.stdout.trim() : '';
    const version = normalizeTag(stdout);
    if (version === null) return { ok: false, reason: '不正な出力: ' + stdout };
    return { ok: true, version };
  };

  const runInstall = (prefix, version) => {
    const r = spawnSync('npm', ['install', '-g', '--prefix', prefix, '@bash0816/agy-termux@' + version], { shell: false, stdio: 'inherit', timeout: 60000 });
    return { ok: !r.error && r.status === 0 };
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

  return { pkgVersion, url, urlError, fetchAudited, npmViewLatest, detectPrefix, realFilePath, runInstall, out, err };
}

module.exports = { DEFAULT_URL, normalizeTag, isNewer, fetchAuditedVersion, runUpdate, createDeps };
