'use strict';
// 同意（consent）の対話と保存を担当する。
// fs / stdin / stderr / readline は注入可能にしてあり、テストで差し替えられる。
// process.exit は呼ばず、拒否や入力なしの判断は戻り値で呼び出し側に伝える。

const path = require('path');

const DOWNLOAD_TEXT =
  '\n[agy] このツールは google-antigravity/antigravity-cli の公式バイナリを\n' +
  '      Google のサーバーからダウンロードします。\n' +
  '      利用には Google の利用規約 (antigravity.google/terms) への同意が必要です。\n';

const COMPAT_TEXT =
  '\n[agy] このデバイスでの起動には互換性のための技術的な調整が必要です。\n' +
  '      配布元のファイルは変更せず、この端末に保存するコピーだけを調整します。\n';

const QUESTION = '続けますか？ [Y/n] ';

function createConsent({
  file,
  fs = require('fs'),
  stdin = process.stdin,
  stderr = process.stderr,
  readline = require('readline'),
}) {
  // 同意ファイルの中身をオブジェクトとして読む。無い・壊れている・オブジェクトでない場合は {} を返す。
  function readConsentObject() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  // 指定キーの同意が保存済みかどうか。読めない・不正な場合は false。
  function hasConsent(key) {
    try {
      return !!JSON.parse(fs.readFileSync(file, 'utf8'))[key];
    } catch {
      return false;
    }
  }

  // 同意を保存する。一時ファイルへ書いてから rename で置換するので、元の同意ファイルは途中で壊れない。
  // 失敗時は自分の一時ファイルを削除し（削除の失敗は無視）、元の例外をそのまま投げ直す。
  function saveConsent(key) {
    const data = readConsentObject();
    data[key] = true;
    const tmp = file + '.' + process.pid + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 一時ファイルが無い、または削除できない場合は無視して元の例外を優先する
      }
      throw err;
    }
  }

  // 質問して1行受け取る。stdin が TTY でない場合は質問せず null を返す。
  // raw モードには入らない（terminal: false）。EOF などで回答が無いまま閉じた場合も null。
  function ask(question) {
    if (!stdin.isTTY) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rl = readline.createInterface({ input: stdin, output: stderr, terminal: false });
      // 回答を受けてから close する。先に close すると close 側で null に解決されてしまうため。
      // 回答が無いまま閉じた（EOF）場合だけ、質問の行を閉じる改行を 1 回出してから null を返す。
      rl.on('close', () => {
        if (settled) return;
        stderr.write('\n');
        done(null);
      });
      rl.question(question, (answer) => {
        done(answer.trim().toLowerCase());
        rl.close();
      });
    });
  }

  // 同意済みなら質問せず 'granted'。説明を出して質問し、入力が無ければ 'no_input'（保存しない）、
  // 'n' / 'no' なら 'declined'（保存しない）、それ以外は保存して 'granted'。
  async function gate(key, text) {
    if (hasConsent(key)) return 'granted';
    stderr.write(text + '\n');
    const answer = await ask(QUESTION);
    if (answer === null) return 'no_input';
    if (answer === 'n' || answer === 'no') return 'declined';
    saveConsent(key);
    return 'granted';
  }

  function gateDownload() {
    return gate('download', DOWNLOAD_TEXT);
  }

  function gateCompat() {
    return gate('compat', COMPAT_TEXT);
  }

  return { hasConsent, saveConsent, ask, gateDownload, gateCompat };
}

module.exports = { createConsent };
