'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { applyVA39Patch } = require('../lib/patcher')
const { buildElf } = require('./helpers/elf-fixture')

const MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const NOP = 0xD503201F
const PT_LOAD = 1
const PF_X = 1
const PF_R = 4
const PROGBITS = 1
const EXEC = 6 // SHF_ALLOC | SHF_EXECINSTR
const DATA = 2 // SHF_ALLOC

const u = (x) => x >>> 0
// 64bit 形 UBFM(sf=1, opc=10, N=1)
const ubfmWord = (immr, imms) => u(0xD3400000 | (immr << 16) | (imms << 10))
// 32bit 形 UBFM(sf=0)
const ubfm32Word = (immr, imms) => u(0x53000000 | (immr << 16) | (imms << 10))

function words(list) {
  const b = Buffer.alloc(list.length * 4)
  list.forEach((w, i) => b.writeUInt32LE(u(w), i * 4))
  return b
}

function readWord(buf, off) {
  return buf.readUInt32LE(off)
}

// 本体 ELF。sections[0] が .text(実行、PF_X の PT_LOAD に含まれる)
function buildMain(textData, extraSections = []) {
  return buildElf({
    sections: [{ type: PROGBITS, flags: EXEC, data: textData }, ...extraSections],
    segments: [{ type: PT_LOAD, flags: PF_X | PF_R, sectionIndexes: [0] }],
  })
}

// 埋込み用の小さい ELF。.text は PF_X の PT_LOAD 内
function embeddedElf(textWords) {
  return buildElf({
    sections: [{ type: PROGBITS, flags: EXEC, data: words(textWords) }],
    segments: [{ type: PT_LOAD, flags: PF_X | PF_R, sectionIndexes: [0] }],
  })
}

function zeroCounts() {
  return { ubfx: 0, lsl: 0, mask: 0, mmap: 0, word: 0 }
}

test('64bit lsl(22,21) を (29,28) に書き換える', () => {
  const { buf, layout } = buildMain(words([ubfmWord(22, 21)]))
  const r = applyVA39Patch(buf)
  assert.equal(readWord(buf, layout[0].offset), 0xD35D7000)
  assert.equal(r.lsl, 1)
  assert.equal(r.ubfx, 0)
  assert.equal(r.containers[0].counts.lsl, 1)
})

test('64bit ubfx(42,44) を (35,37) に書き換える', () => {
  const { buf, layout } = buildMain(words([ubfmWord(42, 44)]))
  const r = applyVA39Patch(buf)
  assert.equal(readWord(buf, layout[0].offset), 0xD3639400)
  assert.equal(r.ubfx, 1)
  assert.equal(r.lsl, 0)
})

test('32bit 形と sf=1 N=0 の形は書き換えない', () => {
  const list = [
    ubfm32Word(22, 21),
    ubfm32Word(42, 44),
    u(0xD3000000 | (22 << 16) | (21 << 10)),
    u(0xD3000000 | (42 << 16) | (44 << 10)),
  ]
  const { buf, layout } = buildMain(words(list))
  const before = Buffer.from(buf)
  const r = applyVA39Patch(buf)
  assert.deepStrictEqual(r.containers[0].counts, zeroCounts())
  assert.deepStrictEqual(buf, before)
  assert.equal(readWord(buf, layout[0].offset), ubfm32Word(22, 21))
})

test('非実行 PROGBITS と PF_X の PT_LOAD 外の実行セクションは書き換えない', () => {
  const textWords = [NOP]
  const rodata = words([ubfmWord(22, 21), ubfmWord(42, 44), 0xF2E00029, 0xD2C20009])
  const outside = words([ubfmWord(22, 21), 0xF2E00029])
  // .text は PF_R のみの PT_LOAD に入れるので実行ロードではない。outside はどの PT_LOAD にも入らない
  const { buf, layout } = buildElf({
    sections: [
      { type: PROGBITS, flags: EXEC, data: words(textWords) },
      { type: PROGBITS, flags: DATA, data: rodata },
      { type: PROGBITS, flags: EXEC, data: outside },
    ],
    segments: [{ type: PT_LOAD, flags: PF_R, sectionIndexes: [0] }],
  })
  const before = Buffer.from(buf)
  const r = applyVA39Patch(buf)
  assert.deepStrictEqual(r.containers[0].counts, zeroCounts())
  assert.deepStrictEqual(buf, before)
  assert.equal(layout.length, 3)
})

test('非実行 PROGBITS のみにある lsl/ubfx は書き換えない', () => {
  const rodata = words([ubfmWord(22, 21), ubfmWord(42, 44)])
  const { buf } = buildElf({
    sections: [
      { type: PROGBITS, flags: EXEC, data: words([NOP]) },
      { type: PROGBITS, flags: DATA, data: rodata },
    ],
    segments: [{ type: PT_LOAD, flags: PF_X | PF_R, sectionIndexes: [0] }],
  })
  const before = Buffer.from(buf)
  const r = applyVA39Patch(buf)
  assert.deepStrictEqual(r.containers[0].counts, zeroCounts())
  assert.deepStrictEqual(buf, before)
})

test('mmap 0xF2E00029 を 0xD3596129 に書き換える', () => {
  const { buf, layout } = buildMain(words([0xF2E00029]))
  const r = applyVA39Patch(buf)
  assert.equal(readWord(buf, layout[0].offset), 0xD3596129)
  assert.equal(r.mmap, 1)
  assert.equal(r.word, 0)
})

test('word 置換表の 13 件をすべて書き換える', () => {
  const table = [
    [0xD2C20009, 0xD2C00409], [0xD2C2000A, 0xD2C0040A], [0xF2C20008, 0xF2DFF408],
    [0xF2C20009, 0xF2DFF409], [0xD2C10009, 0xD2C00209], [0xD2C1000A, 0xD2C0020A],
    [0xF2C38008, 0xF2DFF708], [0xF2C38009, 0xF2DFF709], [0x92560A6C, 0x925D0A6C],
    [0x92560A6A, 0x925D0A6A], [0xD2C3000D, 0xD2C0060D], [0xD2C3000C, 0xD2C0060C],
    [0xD2C08008, 0xD2C00108],
  ]
  const { buf, layout } = buildMain(words(table.map(([from]) => from)))
  const r = applyVA39Patch(buf)
  table.forEach(([, to], i) => {
    assert.equal(readWord(buf, layout[0].offset + i * 4), to, `index ${i}`)
  })
  assert.equal(r.word, 13)
  assert.equal(r.mmap, 0)
})

test('mask の 2 語が範囲の途中にあれば書き換える', () => {
  const { buf, layout } = buildMain(words([NOP, 0x92D3800A, 0xF2E0000A, NOP]))
  const r = applyVA39Patch(buf)
  assert.equal(readWord(buf, layout[0].offset + 4), 0x9280000A)
  assert.equal(readWord(buf, layout[0].offset + 8), 0xD35DFD4A)
  assert.equal(r.mask, 1)
})

test('mask の先頭語が範囲の最後の語で後続語が範囲外なら書き換えない', () => {
  // .text(16 バイト)の最後の語に mask の前半、後半は直後の非実行セクション
  const { buf, layout } = buildElf({
    sections: [
      { type: PROGBITS, flags: EXEC, data: words([NOP, NOP, NOP, 0x92D3800A]) },
      { type: PROGBITS, flags: DATA, data: words([0xF2E0000A, NOP, NOP, NOP]) },
    ],
    segments: [{ type: PT_LOAD, flags: PF_X | PF_R, sectionIndexes: [0] }],
  })
  assert.equal(layout[1].offset, layout[0].offset + 16)
  const before = Buffer.from(buf)
  const r = applyVA39Patch(buf)
  assert.equal(r.mask, 0)
  assert.deepStrictEqual(buf, before)
})

test('mask の前半が範囲の最後の語なら書き換えない(範囲内に後半が無い)', () => {
  const { buf } = buildMain(words([NOP, NOP, NOP, 0x92D3800A]))
  const before = Buffer.from(buf)
  const r = applyVA39Patch(buf)
  assert.equal(r.mask, 0)
  assert.deepStrictEqual(buf, before)
})

test('2 回目の適用は全キー 0 でバッファは変わらない(冪等)', () => {
  const list = [
    ubfmWord(22, 21), ubfmWord(42, 44), 0xF2E00029, 0xD2C20009,
    0x92D3800A, 0xF2E0000A, 0x92560A6C,
  ]
  const { buf } = buildMain(words(list))
  const first = applyVA39Patch(buf)
  assert.equal(first.lsl, 1)
  assert.equal(first.ubfx, 1)
  assert.equal(first.mmap, 1)
  assert.equal(first.word, 2)
  assert.equal(first.mask, 1)
  const afterFirst = Buffer.from(buf)
  const second = applyVA39Patch(buf)
  assert.deepStrictEqual(second.containers[0].counts, zeroCounts())
  assert.equal(second.ubfx + second.lsl + second.mask + second.mmap + second.word, 0)
  assert.deepStrictEqual(buf, afterFirst)
})

test('埋込み ELF の lsl を書き換え、コンテナ別件数と合計が一致する', () => {
  const inner = embeddedElf([ubfmWord(22, 21)])
  const rodata = Buffer.concat([Buffer.alloc(16), inner.buf])
  const { buf, layout } = buildMain(words([ubfmWord(22, 21)]), [
    { type: PROGBITS, flags: DATA, data: rodata },
  ])
  const r = applyVA39Patch(buf)

  assert.equal(r.containers.length, 2)
  assert.equal(r.containers[1].kind, 'embedded')
  assert.equal(r.containers[1].offset, layout[1].offset + 16)
  assert.equal(r.containers[1].size, inner.buf.length)
  assert.equal(r.containers[1].counts.lsl, 1)
  assert.equal(r.containers[0].counts.lsl, 1)
  assert.equal(r.lsl, 2)

  const innerTextOff = layout[1].offset + 16 + inner.layout[0].offset
  assert.equal(readWord(buf, innerTextOff), 0xD35D7000)
})

test('偽マジックの後にある同じ語は書き換えない', () => {
  const rodata = Buffer.alloc(128)
  MAGIC.copy(rodata, 0)
  rodata.writeUInt32LE(ubfmWord(22, 21), 64)
  const { buf, layout } = buildMain(words([NOP]), [{ type: PROGBITS, flags: DATA, data: rodata }])
  const before = Buffer.from(buf)
  const r = applyVA39Patch(buf)
  assert.equal(r.containers.length, 1)
  assert.deepStrictEqual(r.containers[0].counts, zeroCounts())
  assert.deepStrictEqual(buf, before)
  assert.equal(readWord(buf, layout[1].offset + 64), ubfmWord(22, 21))
})

test('本体が ELF でない(ゼロ埋め)なら PATCH_UNSUPPORTED を投げバッファは変えない', () => {
  const buf = Buffer.alloc(4096)
  buf.writeUInt32LE(ubfmWord(22, 21), 1024)
  const before = Buffer.from(buf)
  assert.throws(() => applyVA39Patch(buf), (e) => e.code === 'VA39_PATCH_UNSUPPORTED')
  assert.deepStrictEqual(buf, before)
})

test('本体が短いバッファなら PATCH_UNSUPPORTED を投げバッファは変えない', () => {
  const buf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])
  const before = Buffer.from(buf)
  assert.throws(() => applyVA39Patch(buf), (e) => e.code === 'VA39_PATCH_UNSUPPORTED')
  assert.deepStrictEqual(buf, before)
})

test('埋込み ELF が上限(8 個)を超えると書込み前に例外、バッファは変えない', () => {
  const parts = []
  for (let i = 0; i < 9; i++) {
    parts.push(Buffer.alloc(16))
    parts.push(embeddedElf([ubfmWord(22, 21)]).buf)
  }
  const { buf } = buildMain(words([ubfmWord(22, 21)]), [
    { type: PROGBITS, flags: DATA, data: Buffer.concat(parts) },
  ])
  const before = Buffer.from(buf)
  assert.throws(() => applyVA39Patch(buf), (e) => e.code === 'VA39_PATCH_UNSUPPORTED')
  assert.deepStrictEqual(buf, before)
})

test('埋込み候補のマジックが上限(256)を超えると書込み前に例外、バッファは変えない', () => {
  const rodata = Buffer.alloc(257 * 4)
  for (let i = 0; i < 257; i++) MAGIC.copy(rodata, i * 4)
  const { buf } = buildMain(words([ubfmWord(22, 21)]), [
    { type: PROGBITS, flags: DATA, data: rodata },
  ])
  const before = Buffer.from(buf)
  assert.throws(() => applyVA39Patch(buf), (e) => e.code === 'VA39_PATCH_UNSUPPORTED')
  assert.deepStrictEqual(buf, before)
})

test('戻り値の形: トップ 5 キーと containers(件数 0 のコンテナも含む)', () => {
  const inner = embeddedElf([NOP])
  const rodata = Buffer.concat([Buffer.alloc(16), inner.buf])
  const { buf, layout } = buildMain(words([ubfmWord(22, 21)]), [
    { type: PROGBITS, flags: DATA, data: rodata },
  ])
  const r = applyVA39Patch(buf)

  assert.deepStrictEqual(Object.keys(r).sort(), ['containers', 'lsl', 'mask', 'mmap', 'ubfx', 'word'])
  assert.equal(r.ubfx, 0)
  assert.equal(r.lsl, 1)
  assert.equal(r.mask, 0)
  assert.equal(r.mmap, 0)
  assert.equal(r.word, 0)

  assert.equal(r.containers.length, 2)
  assert.deepStrictEqual(r.containers[0], {
    kind: 'main',
    offset: 0,
    size: buf.length,
    counts: { ubfx: 0, lsl: 1, mask: 0, mmap: 0, word: 0 },
  })
  assert.equal(r.containers[0].size, buf.length)
  assert.deepStrictEqual(r.containers[1], {
    kind: 'embedded',
    offset: layout[1].offset + 16,
    size: inner.buf.length,
    counts: zeroCounts(),
  })
})
