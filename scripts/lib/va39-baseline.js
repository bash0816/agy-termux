'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COUNT_KEYS = ['ubfx', 'lsl', 'mask', 'mmap', 'word'];
const CONTAINER_KINDS = ['main', 'embedded'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

function isPosInt(v) {
  return Number.isInteger(v) && v > 0;
}

function hasCounts(c) {
  return isPlainObject(c) && COUNT_KEYS.every((k) => isNonNegInt(c[k]));
}

function pickCounts(src) {
  const out = {};
  for (const k of COUNT_KEYS) out[k] = src[k];
  return out;
}

/**
 * patcher-rev.json の rev(整数)を読む。
 */
function readPatcherRev(file = path.join(__dirname, '..', '..', 'lib', 'patcher-rev.json')) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`patcher-rev.json を読めません (${file}): ${e.message}`);
  }
  if (!isPlainObject(obj) || !Number.isInteger(obj.rev)) {
    throw new Error(`patcher-rev.json の rev が整数ではありません (${file})`);
  }
  return obj.rev;
}

/**
 * VA39 期待値の 5 欄だけを持つ新しいオブジェクトを返す。
 */
function buildExpectation({ patchResult, patchedBuf, rev } = {}) {
  if (!isPlainObject(patchResult)) {
    throw new Error('patchResult がオブジェクトではありません');
  }
  for (const k of COUNT_KEYS) {
    if (!Number.isInteger(patchResult[k])) {
      throw new Error(`patchResult.${k} が整数ではありません`);
    }
  }
  if (!Array.isArray(patchResult.containers)) {
    throw new Error('patchResult.containers が配列ではありません');
  }
  if (!Buffer.isBuffer(patchedBuf)) {
    throw new Error('patchedBuf が Buffer ではありません');
  }
  const breakdown = patchResult.containers.map((c) => ({
    kind: c.kind,
    offset: c.offset,
    size: c.size,
    counts: pickCounts(c.counts),
  }));
  return {
    va39_patcher_rev: rev,
    va39_patch_counts: pickCounts(patchResult),
    va39_patch_breakdown: breakdown,
    va39_patched_sha256: crypto.createHash('sha256').update(patchedBuf).digest('hex'),
    va39_patched_size: patchedBuf.length,
  };
}

/**
 * 5 欄すべてが存在し、型が正しいときだけ true。
 */
function isCompleteExpectation(obj) {
  if (!isPlainObject(obj)) return false;
  if (!isPosInt(obj.va39_patcher_rev)) return false;
  if (!hasCounts(obj.va39_patch_counts)) return false;
  const bd = obj.va39_patch_breakdown;
  if (!Array.isArray(bd)) return false;
  for (const e of bd) {
    if (!isPlainObject(e)) return false;
    if (!CONTAINER_KINDS.includes(e.kind)) return false;
    if (!isNonNegInt(e.offset) || !isNonNegInt(e.size)) return false;
    if (!hasCounts(e.counts)) return false;
  }
  if (typeof obj.va39_patched_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(obj.va39_patched_sha256)) {
    return false;
  }
  if (!isPosInt(obj.va39_patched_size)) return false;
  return true;
}

/**
 * baseline と candidate を比較する。patched_sha256 / patched_size は比較しない。
 */
function compareExpectation(baseline, candidate) {
  if (!isCompleteExpectation(candidate)) {
    throw new Error('candidate が不完全です');
  }
  if (!isCompleteExpectation(baseline)) {
    return { status: 'baseline_missing', differences: ['基準値が不完全または未記録'] };
  }
  const differences = [];
  const diff = (label, a, b) => {
    if (a !== b) differences.push(`${label}: ${a} -> ${b}`);
  };

  diff('rev', baseline.va39_patcher_rev, candidate.va39_patcher_rev);
  for (const k of COUNT_KEYS) {
    diff(`counts.${k}`, baseline.va39_patch_counts[k], candidate.va39_patch_counts[k]);
  }

  const bb = baseline.va39_patch_breakdown;
  const cb = candidate.va39_patch_breakdown;
  if (bb.length !== cb.length) {
    differences.push(`breakdown: コンテナ数 ${bb.length} -> ${cb.length}`);
  }
  const n = Math.min(bb.length, cb.length);
  for (let i = 0; i < n; i++) {
    const p = `breakdown[${i}]`;
    diff(`${p}.kind`, bb[i].kind, cb[i].kind);
    diff(`${p}.offset`, bb[i].offset, cb[i].offset);
    diff(`${p}.size`, bb[i].size, cb[i].size);
    for (const k of COUNT_KEYS) {
      diff(`${p}.counts.${k}`, bb[i].counts[k], cb[i].counts[k]);
    }
  }

  return { status: differences.length === 0 ? 'same' : 'changed', differences };
}

module.exports = {
  readPatcherRev,
  buildExpectation,
  isCompleteExpectation,
  compareExpectation,
};
