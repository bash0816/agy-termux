'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { parseElf64, findEmbeddedElfs, scanTargets, LIMITS } = require('../lib/elf-scan')
const { VA39_CODES } = require('../lib/errors')
const { buildElf } = require('./helpers/elf-fixture')

// ---- 定数と小道具 ----

const PT_LOAD = 1
const PF_X = 1
const PF_R = 4
const PROGBITS = 1
const NOBITS = 8

// 実行可能な PROGBITS(AX) と、非実行の PROGBITS(A)
const EXEC = { type: PROGBITS, flags: 6 }
const DATA = { type: PROGBITS, flags: 2 }

const MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])

// .text(実行可)と .rodata(非実行)を持つ標準の ELF
function buildSimpleElf({ textSize = 64, rodata = Buffer.alloc(32) } = {}) {
  return buildElf({
    sections: [
      { ...EXEC, data: Buffer.alloc(textSize, 0x90) },
      { ...DATA, data: rodata },
    ],
    segments: [
      { type: PT_LOAD, flags: PF_R | PF_X, sectionIndexes: [0] },
      { type: PT_LOAD, flags: PF_R, sectionIndexes: [1] },
    ],
  })
}

// 非実行 PROGBITS(.rodata)に rodata を置いた本体 ELF
function mainWithRodata(rodata) {
  return buildElf({
    sections: [
      { ...EXEC, data: Buffer.alloc(64, 0x90) },
      { ...DATA, data: rodata },
    ],
    segments: [
      { type: PT_LOAD, flags: PF_R | PF_X, sectionIndexes: [0] },
      { type: PT_LOAD, flags: PF_R, sectionIndexes: [1] },
    ],
  })
}

// 正常な ELF を複製して書き換える
function patch(buf, fn) {
  const copy = Buffer.from(buf)
  fn(copy)
  return copy
}

// 節ヘッダ i の位置(e_shoff は小さい値なので下位 32bit だけ読む)
function shdrAt(buf, i) {
  return buf.readUInt32LE(40) + i * 64
}

// buf の [0, len) を親として parseElf64 が失敗し、reason が文字列であることを確認する
function assertInvalid(buf, pattern, end = buf.length) {
  let r
  assert.doesNotThrow(() => {
    r = parseElf64(buf, 0, end)
  })
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
  assert.ok(r.reason.length > 0)
  if (pattern) assert.match(r.reason, pattern)
}

// ---- parseElf64: 正常系 ----

test('正常: .text(実行可)だけが execRanges に入る', () => {
  const { buf, layout } = buildSimpleElf()
  const r = parseElf64(buf, 0, buf.length)
  assert.equal(r.ok, true)
  assert.deepEqual(r.execRanges, [{ start: layout[0].offset, end: layout[0].offset + layout[0].size }])
  // sections には SHT_NULL(index 0)も含まれるため、種別で探す
  const text = r.sections.find((s) => s.type === PROGBITS && s.flags === 6)
  assert.ok(text)
  assert.equal(text.start, layout[0].offset)
  assert.equal(text.end, layout[0].offset + layout[0].size)
  assert.ok(r.sections.some((s) => s.type === PROGBITS && s.flags === 2))
  assert.equal(r.imageSize, buf.length)
})

test('実行セクションでも PF_X の PT_LOAD に含まれなければ execRanges から外れる(エラーにならない)', () => {
  const { buf } = buildElf({
    sections: [{ ...EXEC, data: Buffer.alloc(64, 0x90) }],
    segments: [{ type: PT_LOAD, flags: PF_R, sectionIndexes: [0] }],
  })
  const r = parseElf64(buf, 0, buf.length)
  assert.equal(r.ok, true)
  assert.deepEqual(r.execRanges, [])
})

test('NOBITS セクションがファイル長を超える offset+size を持っていても ok', () => {
  const { buf, layout } = buildElf({
    sections: [
      { ...EXEC, data: Buffer.alloc(32, 0x90) },
      { type: NOBITS, flags: 3, nobitsSize: 0x100000 },
    ],
    segments: [{ type: PT_LOAD, flags: PF_R | PF_X, sectionIndexes: [0] }],
  })
  assert.ok(layout[1].offset + layout[1].size > buf.length)
  const r = parseElf64(buf, 0, buf.length)
  assert.equal(r.ok, true)
  // NOBITS は sections から除外される
  assert.equal(r.sections.some((s) => s.type === NOBITS), false)
  assert.deepEqual(r.execRanges, [{ start: layout[0].offset, end: layout[0].offset + 32 }])
})

// ---- parseElf64: 不正系(ok:false・reason あり・例外なし) ----

test('不正: マジックが違う', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => { b[0] = 0 }), /マジック/)
})

test('不正: ELF32(class32)', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => { b[4] = 1 }), /ELF64/)
})

test('不正: ビッグエンディアン', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => { b[5] = 2 }), /リトルエンディアン/)
})

test('不正: e_machine が 183 ではない', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => b.writeUInt16LE(62, 18)), /e_machine/)
})

test('不正: e_type が EXEC(2)/DYN(3) ではない', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => b.writeUInt16LE(1, 16)), /e_type/)
})

test('不正: ehdr(64バイト)が格納範囲に収まらない', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(buf, /ヘッダ/, 63)
})

test('不正: e_shnum が 0', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => b.writeUInt16LE(0, 60)), /e_shnum/)
})

test('不正: e_phnum が 256 を超える', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => b.writeUInt16LE(257, 56)), /e_phnum/)
})

test('不正: e_shnum が 4096 を超える', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => b.writeUInt16LE(4097, 60)), /e_shnum/)
})

test('不正: プログラムヘッダ表が格納範囲外', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => b.writeUInt32LE(buf.length + 1000, 32)), /プログラムヘッダ/)
})

test('不正: セクションヘッダ表が格納範囲外', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => b.writeUInt32LE(buf.length, 40)), /セクションヘッダ/)
})

test('不正: NOBITS 以外のセクションが格納範囲外', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => b.writeUInt32LE(0x10000000, shdrAt(b, 1) + 32)), /格納範囲外/)
})

test('不正: 実行範囲が重なる', () => {
  const { buf, layout } = buildElf({
    sections: [
      { ...EXEC, data: Buffer.alloc(32, 0x90) },
      { ...EXEC, data: Buffer.alloc(32, 0x91) },
    ],
    segments: [{ type: PT_LOAD, flags: PF_R | PF_X, sectionIndexes: [0, 1] }],
  })
  // 2 番目の実行セクションの offset を 1 番目と同じにして重ねる
  const bad = patch(buf, (b) => b.writeUInt32LE(layout[0].offset, shdrAt(b, 2) + 24))
  assertInvalid(bad, /重なって/)
})

test('不正: u64 が安全整数を超える(sh_size の上位 32bit)', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => b.writeUInt32LE(0x00200000, shdrAt(b, 1) + 32 + 4)), /安全整数/)
})

test('不正: u64 が安全整数を超える(e_phoff の上位 32bit)', () => {
  const { buf } = buildSimpleElf()
  assertInvalid(patch(buf, (b) => b.writeUInt32LE(0x00200000, 36)), /安全整数/)
})

test('不正: ELF でないバッファでも例外にならず ok:false', () => {
  assertInvalid(Buffer.alloc(100), /マジック/)
})

// ---- findEmbeddedElfs ----

test('findEmbeddedElfs: 非実行 PROGBITS 内の埋込み ELF 2 個を、不整列 offset を含めて start 昇順で検出する', () => {
  const a = buildSimpleElf({ textSize: 48 })
  const b = buildSimpleElf({ textSize: 96, rodata: Buffer.alloc(100, 1) })
  const rodata = Buffer.concat([Buffer.alloc(5, 0xaa), a.buf, Buffer.alloc(3, 0xbb), b.buf, Buffer.alloc(7)])
  const { buf, layout } = mainWithRodata(rodata)
  const main = parseElf64(buf, 0, buf.length)
  assert.equal(main.ok, true)

  const found = findEmbeddedElfs(buf, main)
  const aStart = layout[1].offset + 5
  const bStart = aStart + a.buf.length + 3
  assert.deepEqual(found.map((e) => e.start), [aStart, bStart])
  assert.deepEqual(found.map((e) => e.size), [a.buf.length, b.buf.length])

  // execRanges は絶対オフセット
  const aText = a.layout[0]
  assert.deepEqual(found[0].execRanges, [{ start: aStart + aText.offset, end: aStart + aText.offset + aText.size }])
  const bText = b.layout[0]
  assert.deepEqual(found[1].execRanges, [{ start: bStart + bText.offset, end: bStart + bText.offset + bText.size }])
})

test('findEmbeddedElfs: 偽マジック(7f 45 4c 46 の後がゴミ)は無視する', () => {
  const a = buildSimpleElf()
  const garbage = Buffer.concat([MAGIC, Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc])])
  const rodata = Buffer.concat([garbage, Buffer.alloc(8), a.buf])
  const { buf, layout } = mainWithRodata(rodata)
  const found = findEmbeddedElfs(buf, parseElf64(buf, 0, buf.length))
  assert.equal(found.length, 1)
  assert.equal(found[0].start, layout[1].offset + garbage.length + 8)
  assert.equal(found[0].size, a.buf.length)
})

test('findEmbeddedElfs: 実行セクション内の ELF マジックは探索しない', () => {
  const a = buildSimpleElf()
  const { buf } = buildElf({
    sections: [
      { ...EXEC, data: a.buf },
      { ...DATA, data: Buffer.alloc(32) },
    ],
    segments: [{ type: PT_LOAD, flags: PF_R | PF_X, sectionIndexes: [0] }],
  })
  const found = findEmbeddedElfs(buf, parseElf64(buf, 0, buf.length))
  assert.deepEqual(found, [])
})

test('findEmbeddedElfs: 入れ子の埋込み ELF は無視する', () => {
  const inner = buildSimpleElf({ textSize: 32 })
  const outer = buildElf({
    sections: [
      { ...EXEC, data: Buffer.alloc(32, 0x90) },
      { ...DATA, data: Buffer.concat([Buffer.alloc(16), inner.buf]) },
    ],
    segments: [
      { type: PT_LOAD, flags: PF_R | PF_X, sectionIndexes: [0] },
      { type: PT_LOAD, flags: PF_R, sectionIndexes: [1] },
    ],
  })
  const rodata = Buffer.concat([Buffer.alloc(4), outer.buf])
  const { buf, layout } = mainWithRodata(rodata)
  const found = findEmbeddedElfs(buf, parseElf64(buf, 0, buf.length))
  assert.equal(found.length, 1)
  assert.equal(found[0].start, layout[1].offset + 4)
  assert.equal(found[0].size, outer.buf.length)
})

test('findEmbeddedElfs: 候補が 257 個で PATCH_UNSUPPORTED', () => {
  const chunk = Buffer.concat([MAGIC, Buffer.alloc(4)])
  const rodata = Buffer.concat(Array(LIMITS.MAX_EMBEDDED_CANDIDATES + 1).fill(chunk))
  const { buf } = mainWithRodata(rodata)
  assert.throws(
    () => findEmbeddedElfs(buf, parseElf64(buf, 0, buf.length)),
    (err) => err.code === VA39_CODES.PATCH_UNSUPPORTED,
  )
})

test('findEmbeddedElfs: 候補が上限ちょうど(256 個)なら例外にならない', () => {
  const chunk = Buffer.concat([MAGIC, Buffer.alloc(4)])
  const rodata = Buffer.concat(Array(LIMITS.MAX_EMBEDDED_CANDIDATES).fill(chunk))
  const { buf } = mainWithRodata(rodata)
  assert.deepEqual(findEmbeddedElfs(buf, parseElf64(buf, 0, buf.length)), [])
})

test('findEmbeddedElfs: 有効な埋込み ELF が 9 個で PATCH_UNSUPPORTED', () => {
  const embs = Array.from({ length: LIMITS.MAX_EMBEDDED_VALID + 1 }, () => buildSimpleElf({ textSize: 32 }).buf)
  const { buf } = mainWithRodata(Buffer.concat(embs))
  assert.throws(
    () => findEmbeddedElfs(buf, parseElf64(buf, 0, buf.length)),
    (err) => err.code === VA39_CODES.PATCH_UNSUPPORTED,
  )
})

test('findEmbeddedElfs: 有効な埋込み ELF が上限ちょうど(8 個)なら例外にならない', () => {
  const embs = Array.from({ length: LIMITS.MAX_EMBEDDED_VALID }, () => buildSimpleElf({ textSize: 32 }).buf)
  const { buf } = mainWithRodata(Buffer.concat(embs))
  const found = findEmbeddedElfs(buf, parseElf64(buf, 0, buf.length))
  assert.equal(found.length, LIMITS.MAX_EMBEDDED_VALID)
})

test('findEmbeddedElfs: 親セクションの終端をまたぐ埋込み ELF は不採用', () => {
  const emb = buildSimpleElf().buf
  const rodata = emb.subarray(0, emb.length - 16)
  const { buf } = mainWithRodata(rodata)
  const found = findEmbeddedElfs(buf, parseElf64(buf, 0, buf.length))
  assert.deepEqual(found, [])
})

// ---- scanTargets ----

test('scanTargets: 本体が不正なら PATCH_UNSUPPORTED を投げる(フォールバックしない)', () => {
  const { buf } = buildSimpleElf()
  const bad = patch(buf, (b) => { b[0] = 0 })
  assert.throws(
    () => scanTargets(bad),
    (err) => {
      assert.equal(err.code, VA39_CODES.PATCH_UNSUPPORTED)
      assert.equal(typeof err.detail, 'string')
      return true
    },
  )
})

test('scanTargets: 正常系の形(main と embedded)', () => {
  const a = buildSimpleElf({ textSize: 48 })
  const { buf, layout } = mainWithRodata(a.buf)
  const t = scanTargets(buf)
  assert.equal(t.main.start, 0)
  assert.equal(t.main.size, buf.length)
  assert.deepEqual(t.main.execRanges, [{ start: layout[0].offset, end: layout[0].offset + 64 }])
  assert.equal(t.embedded.length, 1)
  assert.equal(t.embedded[0].start, layout[1].offset)
  assert.equal(t.embedded[0].size, a.buf.length)
})

test('scanTargets: バッファの内容を一切変更しない', () => {
  const a = buildSimpleElf({ textSize: 48 })
  const { buf } = mainWithRodata(Buffer.concat([Buffer.alloc(5), a.buf]))
  const before = Buffer.from(buf)
  scanTargets(buf)
  assert.equal(buf.equals(before), true)
})

test('LIMITS は凍結された定数', () => {
  assert.equal(Object.isFrozen(LIMITS), true)
  assert.equal(LIMITS.MAX_PHNUM, 256)
  assert.equal(LIMITS.MAX_SHNUM, 4096)
  assert.equal(LIMITS.MAX_EMBEDDED_CANDIDATES, 256)
  assert.equal(LIMITS.MAX_EMBEDDED_VALID, 8)
})

// ---- 性能の目安 ----

test('性能: 約 100MB のバッファで scanTargets が 20 秒以内', () => {
  const big = Buffer.alloc(100 * 1024 * 1024)
  const { buf } = mainWithRodata(big)
  const t0 = Date.now()
  const t = scanTargets(buf)
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 20000, `scanTargets が ${elapsed} ms かかりました`)
  assert.equal(t.embedded.length, 0)
})
