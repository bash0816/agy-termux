'use strict'

// テスト専用: 最小の AArch64 ELF64 リトルエンディアンを組み立てる(配布物には含めない)

const EHDR_SIZE = 64
const PHDR_SIZE = 56
const SHDR_SIZE = 64
const SHT_NOBITS = 8

function alignUp(n, align) {
  return Math.ceil(n / align) * align
}

// u64 を下位・上位の 32bit に分けて書く(値は安全整数の範囲で使う)
function writeU64(buf, pos, value) {
  buf.writeUInt32LE(value % 2 ** 32, pos)
  buf.writeUInt32LE(Math.floor(value / 2 ** 32), pos + 4)
}

// sections: [{ type, flags, data(Buffer) | nobitsSize }]、segments: [{ type, flags, sectionIndexes }]
// 配置: ehdr と phdr 表の直後に各セクションを align 境界で置き、末尾に shdr 表(先頭はヌルセクション)
// 戻り値: { buf, layout }。layout[i] は sections[i] の { offset, size }
function buildElf({ sections = [], segments = [], type = 2, machine = 183, align = 16 } = {}) {
  const phoff = EHDR_SIZE
  let cursor = phoff + segments.length * PHDR_SIZE
  const layout = []
  for (const s of sections) {
    const offset = alignUp(cursor, align)
    if (s.type === SHT_NOBITS) {
      // NOBITS はファイル上に実体を置かない(offset+size はファイル長を超えてよい)
      layout.push({ offset, size: s.nobitsSize })
    } else {
      layout.push({ offset, size: s.data.length })
      cursor = offset + s.data.length
    }
  }

  const shoff = alignUp(cursor, 8)
  const shnum = sections.length + 1
  const total = shoff + shnum * SHDR_SIZE
  const buf = Buffer.alloc(total)

  // ELF ヘッダ
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0)
  buf.writeUInt16LE(type, 16)
  buf.writeUInt16LE(machine, 18)
  buf.writeUInt32LE(1, 20)
  writeU64(buf, 24, 0)
  writeU64(buf, 32, phoff)
  writeU64(buf, 40, shoff)
  buf.writeUInt16LE(EHDR_SIZE, 52)
  buf.writeUInt16LE(PHDR_SIZE, 54)
  buf.writeUInt16LE(segments.length, 56)
  buf.writeUInt16LE(SHDR_SIZE, 58)
  buf.writeUInt16LE(shnum, 60)
  buf.writeUInt16LE(0, 62)

  // セクションの中身と節ヘッダ(index 0 はヌル)
  sections.forEach((s, i) => {
    const { offset, size } = layout[i]
    if (s.type !== SHT_NOBITS) s.data.copy(buf, offset)
    const sh = shoff + (i + 1) * SHDR_SIZE
    buf.writeUInt32LE(s.type, sh + 4)
    writeU64(buf, sh + 8, s.flags)
    writeU64(buf, sh + 24, offset)
    writeU64(buf, sh + 32, size)
    writeU64(buf, sh + 48, 1)
  })

  // プログラムヘッダ: p_offset/p_filesz は対象セクション(NOBITS 除く)のファイル範囲を覆う
  segments.forEach((seg, i) => {
    let lo = Infinity
    let hi = 0
    for (const idx of seg.sectionIndexes) {
      if (sections[idx].type === SHT_NOBITS) continue
      lo = Math.min(lo, layout[idx].offset)
      hi = Math.max(hi, layout[idx].offset + layout[idx].size)
    }
    const off = lo === Infinity ? 0 : lo
    const filesz = lo === Infinity ? 0 : hi - lo
    const ph = phoff + i * PHDR_SIZE
    buf.writeUInt32LE(seg.type, ph)
    buf.writeUInt32LE(seg.flags, ph + 4)
    writeU64(buf, ph + 8, off)
    writeU64(buf, ph + 16, off)
    writeU64(buf, ph + 24, off)
    writeU64(buf, ph + 32, filesz)
    writeU64(buf, ph + 40, filesz)
    writeU64(buf, ph + 48, align)
  })

  return { buf, layout }
}

module.exports = { buildElf }
