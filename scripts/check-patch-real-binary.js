#!/usr/bin/env node
'use strict';

// VA39 パッチを実バイナリに適用して検査する入口（検証専用。配布物(bin/ lib/ config/)には含めない）
// 使い方: node scripts/check-patch-real-binary.js <原本バイナリのパス>
// 出力: 標準出力に結果の JSON。検査に違反があれば理由を標準エラーへ出す
// 終了コード: 0 = 成功 / 1 = 検査違反または予期しない例外 / 2 = 引数の誤り・読込不能
// 副作用: ファイルへの書込みはしない（原本は読むだけ。書換えは Buffer のコピーに対して行う）

const fs = require('node:fs');
const crypto = require('node:crypto');

const { applyVA39Patch } = require('../lib/patcher');
const { scanTargets } = require('../lib/elf-scan');

const USAGE = '使い方: node scripts/check-patch-real-binary.js <原本バイナリのパス>';
const COUNT_KEYS = ['ubfx', 'lsl', 'mask', 'mmap', 'word'];
const WORD_BYTES = 4;

// 4 バイト単位で原本と異なる語の先頭オフセットを列挙する
function changedWordOffsets(original, patched) {
  const offs = [];
  for (let off = 0; off < original.length; off += WORD_BYTES) {
    const end = Math.min(off + WORD_BYTES, original.length);
    if (!original.subarray(off, end).equals(patched.subarray(off, end))) offs.push(off);
  }
  return offs;
}

// 原本と異なるバイトのうち、どの実行範囲([start, end))にも入っていないものの offset を返す
function bytesOutsideRanges(original, patched, ranges) {
  const outside = [];
  for (let i = 0; i < original.length; i++) {
    if (original[i] === patched[i]) continue;
    if (!ranges.some((r) => r.start <= i && i < r.end)) outside.push(i);
  }
  return outside;
}

function main(argv) {
  if (argv.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const p = argv[0];

  let raw;
  try {
    raw = fs.readFileSync(p);
  } catch (err) {
    console.error(USAGE);
    console.error(`読み込めません: ${p}: ${err.message}`);
    return 2;
  }

  // 対象範囲は書換え前の原本から取る（scanTargets は読み取りのみ）
  const targets = scanTargets(raw);
  const allRanges = [targets.main, ...targets.embedded].flatMap((c) => c.execRanges);

  const work = Buffer.from(raw);
  const t0 = performance.now();
  const first = applyVA39Patch(work);
  const ms = Math.round(performance.now() - t0);

  const changedOffs = changedWordOffsets(raw, work);
  const total = {};
  for (const k of COUNT_KEYS) total[k] = first[k];

  const result = {
    ms,
    total,
    containers: first.containers,
    patchedSha256: crypto.createHash('sha256').update(work).digest('hex'),
    changedWords: changedOffs.length,
  };
  console.log(JSON.stringify(result, null, 2));

  const violations = [];

  // 検査1: 書き換えられた全てのバイトが、いずれかのコンテナの実行範囲に収まっている（整列に依存しない）
  for (const off of bytesOutsideRanges(raw, work, allRanges)) {
    violations.push(`書換えが実行範囲の外にあります: offset=0x${off.toString(16)}`);
  }

  // 検査2: 2回目の適用は全キー 0 件で、バッファは変化しない
  const snapshot = Buffer.from(work);
  const second = applyVA39Patch(work);
  for (const k of COUNT_KEYS) {
    if (second[k] !== 0) violations.push(`2回目の適用で ${k} が 0 件ではありません: ${second[k]}`);
  }
  if (!work.equals(snapshot)) violations.push('2回目の適用でバッファが変化しました');

  // 検査3: total が containers の合計と一致する
  for (const k of COUNT_KEYS) {
    const sum = first.containers.reduce((acc, c) => acc + c.counts[k], 0);
    if (sum !== total[k]) violations.push(`total.${k} (${total[k]}) がコンテナ合計 (${sum}) と一致しません`);
  }

  if (violations.length > 0) {
    for (const v of violations) console.error(`違反: ${v}`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`予期しない例外: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

module.exports = { changedWordOffsets, bytesOutsideRanges };
