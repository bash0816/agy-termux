'use strict';
const https = require('https');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { typedError, classifyTarStderr, diagnoseLowSpace } = require('./errors');

const RELEASES_API = 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest';
const ASSET_NAME = 'agy_cli_linux_arm64.tar.gz';
const VERIFIED_VERSIONS = require('../config/agy-verified-versions.json');
const REDIRECT_CODES = [301, 302, 303, 307, 308];
const MB = 1024 * 1024;

const toMb = (n) => (n / MB).toFixed(1);

// 応答を取得する。タイマーは request 発行前から動かし、接続・ヘッダ待ち・受信停止を stallMs で検出する。
// 進捗(progress が真のとき)と heartbeat は標準エラーに出す。
function httpsGet(url, opts = {}) {
  const {
    label = 'ダウンロード',
    progress = false,
    stallMs = 60000,
    heartbeatMs = 5000,
    progressMs = 2000,
    tickMs = 500,
    maxRedirects = 5,
    headers,
    deps = {},
  } = opts;
  const d = {
    https,
    setInterval,
    clearInterval,
    now: Date.now,
    err: (s) => process.stderr.write(s),
    isTTY: !!process.stderr.isTTY,
    ...deps,
  };

  return new Promise((resolve, reject) => {
    const t0 = d.now();
    let finished = false;
    let bytes = 0;
    let total = 0;
    let lastData = t0;
    let lastPrint = t0;
    let lastProgress = t0;
    let progressOpen = false;
    let curReq = null;
    let timer = null;

    // TTY で開いたままの進捗行を閉じる
    const closeProgressLine = () => {
      if (progressOpen) {
        d.err('\n');
        progressOpen = false;
      }
    };

    const printProgress = (now) => {
      const text = '[agy] ' + label + '中... ' + toMb(bytes) +
        (total ? ' / ' + toMb(total) + ' MB (' + Math.floor((bytes * 100) / total) + '%)' : ' MB');
      if (d.isTTY) {
        d.err('\r' + text);
        progressOpen = true;
      } else {
        d.err(text + '\n');
      }
      lastPrint = now;
      lastProgress = now;
    };

    const heartbeat = (now) => {
      closeProgressLine();
      d.err('  ...' + label + ' (経過 ' + Math.floor((now - t0) / 1000) + ' 秒)\n');
      lastPrint = now;
    };

    // 成功・失敗のどちらか最初の 1 回だけ有効。以後のイベントとタイマーは無視する
    const finish = (err, value) => {
      if (finished) return;
      finished = true;
      d.clearInterval(timer);
      closeProgressLine();
      if (err) {
        if (curReq) curReq.destroy();
        return reject(err);
      }
      if (progress && bytes > 0) d.err('[agy] ' + label + '完了\n');
      resolve(value);
    };

    const failNet = (detail, errno) => finish(typedError('E_NET', { detail, errno }));

    const tick = () => {
      if (finished) return;
      const now = d.now();
      if (now - lastData >= stallMs) {
        finish(typedError('E_STALL', { stage: 'download' }));
        return;
      }
      if (progress && bytes > 0 && now - lastProgress >= progressMs) printProgress(now);
      if (now - lastPrint >= heartbeatMs) heartbeat(now);
    };

    const onResponse = (res, target, hop) => {
      const code = res.statusCode;
      const location = res.headers && res.headers.location;

      if (REDIRECT_CODES.includes(code) && location) {
        // 旧 res は本文を読まずに破棄する
        res.resume();
        if (hop + 1 > maxRedirects) return finish(typedError('E_NET', { detail: 'リダイレクトが多すぎます' }));
        let next;
        try {
          next = new URL(location, target);
        } catch (e) {
          return finish(typedError('E_NET', { detail: 'リダイレクト先の URL が不正です' }));
        }
        if (next.protocol !== 'https:') return finish(typedError('E_NET', { detail: 'HTTPS 以外へのリダイレクトは受け付けません' }));
        curReq.destroy();
        return issue(next.href, hop + 1);
      }

      if (code < 200 || code >= 300) {
        res.resume();
        return finish(typedError('E_HTTP', { httpStatus: code, stage: 'download' }));
      }

      const cl = String((res.headers && res.headers['content-length']) ?? '');
      total = /^\d+$/.test(cl) && Number(cl) > 0 ? Number(cl) : 0;

      const chunks = [];
      let ended = false;
      res.on('data', (c) => {
        if (finished) return;
        chunks.push(c);
        bytes += c.length;
        lastData = d.now();
      });
      res.on('end', () => {
        ended = true;
        if (res.complete === false) return failNet('通信が途中で切れました');
        finish(null, Buffer.concat(chunks));
      });
      res.on('aborted', () => failNet('通信が途中で切れました'));
      res.on('error', (e) => failNet((e && e.message) || '通信が途中で切れました', e && e.code));
      res.on('close', () => {
        if (!ended) failNet('通信が途中で切れました');
      });
    };

    // 同じ状態・同じタイマーのまま request を発行する(リダイレクトもここを通る)
    const issue = (target, hop) => {
      lastData = d.now();
      bytes = 0;
      let req;
      try {
        req = d.https.get(target, { headers: { 'User-Agent': 'agy-termux', ...headers } }, (res) => onResponse(res, target, hop));
      } catch (e) {
        return finish(typedError('E_NET', { detail: e.message, errno: e.code }));
      }
      curReq = req;
      req.on('error', (e) => {
        if (req !== curReq) return;
        failNet(e.code ? e.code + ' ' + e.message : e.message, e.code);
      });
    };

    timer = d.setInterval(tick, tickMs);
    issue(url, 0);
  });
}

async function fetchLatestMeta() {
  const meta = JSON.parse((await httpsGet(RELEASES_API)).toString());
  const asset = meta.assets.find(a => a.name === ASSET_NAME);
  if (!asset) throw new Error(`${ASSET_NAME} が最新リリースに見つかりません`);
  // AGY_TERMUX_FORCE_LATEST 経路は検証済みバージョンではないため sha256Tar/sha256Binary は
  // 付与しない (downloadBinary 側で照合をスキップさせる)
  return { tagName: meta.tag_name, downloadUrl: asset.browser_download_url, sha256Tar: null, sha256Binary: null };
}

// VA39 期待値として config から透過する欄（名前はそのまま）
const VA39_EXPECTATION_KEYS = [
  'va39_patcher_rev',
  'va39_patch_counts',
  'va39_patch_breakdown',
  'va39_patched_sha256',
  'va39_patched_size',
];

async function fetchPinnedMeta() {
  if (!VERIFIED_VERSIONS.sha256_tar) {
    throw new Error('config/agy-verified-versions.json に sha256_tar がありません（pinned mode の整合性検証に必須です）');
  }
  if (!VERIFIED_VERSIONS.sha256_binary) {
    throw new Error('config/agy-verified-versions.json に sha256_binary がありません（pinned mode の整合性検証に必須です）');
  }
  // 5欄すべて undefined（旧記録）なら expectation は undefined。一部だけあれば存在する欄だけを渡す（検証は ensureBinary 側）
  const presentKeys = VA39_EXPECTATION_KEYS.filter((k) => VERIFIED_VERSIONS[k] !== undefined);
  const expectation = presentKeys.length > 0
    ? Object.fromEntries(presentKeys.map((k) => [k, VERIFIED_VERSIONS[k]]))
    : undefined;
  return {
    tagName: VERIFIED_VERSIONS.tag_name,
    downloadUrl: VERIFIED_VERSIONS.download_url,
    sha256Tar: VERIFIED_VERSIONS.sha256_tar,
    sha256Binary: VERIFIED_VERSIONS.sha256_binary,
    expectation,
  };
}

// 取得・検証・展開を行い、バイナリを返す。onPhase(label) は処理の境界で段階ラベルを渡す(表示は呼び出し側)。
// opts.deps は テスト用の注入。既定は実物。
async function downloadBinary(downloadUrl, expectedSha256Tar, expectedSha256Binary, opts = {}) {
  const { onPhase = () => {}, progress = false, stallMs, deps = {} } = opts;
  const d = {
    httpsGet,
    fs,
    os,
    path,
    spawnSync,
    statfsSync: fs.statfsSync,
    crypto,
    ...deps,
  };

  const tarBuf = await d.httpsGet(downloadUrl, { label: 'ダウンロード', progress, stallMs });

  onPhase('検証しています...');
  // pinned mode（fetchPinnedMeta 経由）では、展開前に tarball 自体の sha256 を
  // sha256_tar と照合する。不一致なら展開すら行わずエラーにする。
  // AGY_TERMUX_FORCE_LATEST=1 経由（fetchLatestMeta）の場合は expectedSha256Tar が
  // null のため照合をスキップする（検証済みバージョンではないため）。
  if (expectedSha256Tar) {
    const actualTarSha256 = d.crypto.createHash('sha256').update(tarBuf).digest('hex');
    if (actualTarSha256 !== expectedSha256Tar) {
      throw typedError('E_SHA', {
        stage: 'verify',
        detail: `SHA256 検証失敗: ダウンロードした tarball が pin されたハッシュと一致しません ` +
          `(expected: ${expectedSha256Tar}, actual: ${actualTarSha256})`,
      });
    }
  }

  let tmpDir;
  try {
    tmpDir = d.fs.mkdtempSync(d.path.join(d.os.tmpdir(), 'agy-'));
  } catch (e) {
    e.stage = 'extract';
    e.path = d.os.tmpdir();
    throw e;
  }
  try {
    try {
      d.fs.writeFileSync(d.path.join(tmpDir, 'agy.tar.gz'), tarBuf);
    } catch (e) {
      e.stage = 'extract';
      e.path = tmpDir;
      throw e;
    }

    onPhase('展開しています...');
    const r = d.spawnSync('tar', ['-xzf', 'agy.tar.gz'], {
      cwd: tmpDir,
      env: Object.assign({}, process.env, { LC_ALL: 'C' }),
      encoding: 'utf8',
    });
    if (r.error) {
      throw typedError(r.error.code || 'E_TAR_UNKNOWN', {
        stage: 'extract',
        path: tmpDir,
        detail: r.error.message,
      });
    }
    if (r.status !== 0) {
      const c = classifyTarStderr(r.stderr || '');
      let code = c.code;
      let free;
      // 確定した原因(ENOSPC・EACCES など)は診断で上書きしない。認識できなかった失敗だけ空き容量を調べる
      if (code === 'E_TAR_UNKNOWN') {
        try {
          const s = d.statfsSync(tmpDir);
          free = s.bavail * s.bsize;
        } catch (e) {
          free = undefined;
        }
        if (free !== undefined && diagnoseLowSpace({ free })) code = 'E_NOSPACE_MAYBE';
      }
      throw typedError(code, {
        stage: 'extract',
        path: c.path || tmpDir,
        detail: c.line || c.lastLine || 'tar が失敗しました',
        free,
      });
    }

    onPhase('検証しています...');
    const binName = d.fs.existsSync(d.path.join(tmpDir, 'antigravity')) ? 'antigravity' : 'agy';
    let binBuf;
    try {
      binBuf = d.fs.readFileSync(d.path.join(tmpDir, binName));
    } catch (e) {
      e.stage = 'extract';
      e.path = d.path.join(tmpDir, binName);
      throw e;
    }
    if (binBuf.length < 10 * 1024 * 1024 || binBuf[0] !== 0x7F || binBuf.toString('ascii', 1, 4) !== 'ELF') {
      throw typedError('E_ELF', {
        stage: 'verify',
        detail: 'ダウンロードしたバイナリが無効です（ELF ヘッダー検証失敗）',
      });
    }
    // pinned mode（fetchPinnedMeta 経由）では sha256_binary との一致を必須で検証する。
    // AGY_TERMUX_FORCE_LATEST=1 経由（fetchLatestMeta）の場合は expectedSha256Binary が
    // null のため照合をスキップする（検証済みバージョンではないため）。
    if (expectedSha256Binary) {
      const actualSha256 = d.crypto.createHash('sha256').update(binBuf).digest('hex');
      if (actualSha256 !== expectedSha256Binary) {
        throw typedError('E_SHA', {
          stage: 'verify',
          detail: `SHA256 検証失敗: ダウンロードしたバイナリが pin されたハッシュと一致しません ` +
            `(expected: ${expectedSha256Binary}, actual: ${actualSha256})`,
        });
      }
    }
    return binBuf;
  } finally {
    try {
      d.fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      // 後始末の失敗で元のエラーを上書きしない
    }
  }
}

module.exports = { fetchLatestMeta, fetchPinnedMeta, downloadBinary, httpsGet };
