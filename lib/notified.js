'use strict'

// 「監査済み版 Y が npm の latest Z と一致しない」通知の表示履歴(JSON 配列)を読み書きする
// 同じ組合せ(使用中 X・監査済み Y・latest Z)の通知を繰り返し表示しないために使う
// 注入する fs は { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } を持つもの

const path = require('path')

// 履歴に保持する最大件数(超えた分は古い順に削除する)
const MAX_ENTRIES = 50

// 組合せを一意に表すキーを作る
function makeKey(current, audited, latest) {
  return current + '|' + audited + '|' + latest
}

// 履歴ファイルを読む。無い・読めない・不正な JSON・配列でない場合は [] を返す(例外は投げない)
function loadNotified(file, fs = require('node:fs')) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_) {
    return []
  }
  if (!Array.isArray(parsed)) return []
  // 文字列以外の要素は捨てる
  return parsed.filter((item) => typeof item === 'string')
}

// 履歴に key が含まれるかを返す
function hasNotified(list, key) {
  return Array.isArray(list) && list.includes(key)
}

// 履歴に key を追加して保存する。保存に成功したら true、失敗したら false を返す(例外は投げない)
function recordNotified(file, key, fs = require('node:fs'), { pid = process.pid } = {}) {
  try {
    const list = loadNotified(file, fs)
    // すでに記録済みなら書き込まずに成功扱いにする
    if (list.includes(key)) return true
    list.push(key)
    while (list.length > MAX_ENTRIES) list.shift()

    fs.mkdirSync(path.dirname(file), { recursive: true })

    // 一時ファイルへ書いてから rename で置き換え、途中で壊れたファイルを残さない
    const tmp = file + '.' + pid + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(list))
      fs.renameSync(tmp, file)
      return true
    } catch (_) {
      // 一時ファイルの後始末が失敗しても無視する
      try {
        fs.unlinkSync(tmp)
      } catch (_ignored) {
        // 無視
      }
      return false
    }
  } catch (_) {
    return false
  }
}

module.exports = { MAX_ENTRIES, makeKey, loadNotified, hasNotified, recordNotified }
