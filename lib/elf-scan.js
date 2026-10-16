'use strict'

const { VA39_CODES, va39Error } = require('./errors')

// AArch64 ELF64 リトルエンディアンの読み取り専用スキャン。バッファは書き換えない

const MAX_PHNUM = 256
const MAX_SHNUM = 4096
const MAX_EMBEDDED_CANDIDATES = 256
const MAX_EMBEDDED_VALID = 8

const LIMITS = Object.freeze({ MAX_PHNUM, MAX_SHNUM, MAX_EMBEDDED_CANDIDATES, MAX_EMBEDDED_VALID })

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const EHDR_SIZE = 64
const PHDR_SIZE = 56
const SHDR_SIZE = 64
const ELFCLASS64 = 2
const ELFDATA2LSB = 1
const EV_CURRENT = 1
const EM_AARCH64 = 183
const ET_EXEC = 2
const ET_DYN = 3
const PT_LOAD = 1
const PF_X = 1
const SHT_PROGBITS = 1
const SHT_NOBITS = 8
const SHF_EXECINSTR = 4

function fail(reason) {
  return { ok: false, reason }
}

// u64 を Number にする。安全整数を超えるなら null
function readU64(buf, pos) {
  const v = buf.readUInt32LE(pos) + buf.readUInt32LE(pos + 4) * 2 ** 32
  return Number.isSafeInteger(v) ? v : null
}

// [off, off+len) が [0, limit) に収まるか。加算後も安全整数であること
function fits(off, len, limit) {
  const end = off + len
  return Number.isSafeInteger(end) && end <= limit
}

// buf の [start, end) を親コンテナとして ELF64 を検査する。全オフセットは start からの相対
// 成功: { ok:true, imageSize, execRanges, sections }(範囲は buf 全体での絶対オフセット)、失敗: { ok:false, reason }
function parseElf64(buf, start, end) {
  const size = end - start
  if (size < EHDR_SIZE) return fail('ELF ヘッダ(64バイト)が格納範囲に収まりません')
  if (!buf.subarray(start, start + 4).equals(ELF_MAGIC)) return fail('ELF マジックがありません')
  if (buf[start + 4] !== ELFCLASS64) return fail('ELF64 ではありません')
  if (buf[start + 5] !== ELFDATA2LSB) return fail('リトルエンディアンではありません')
  if (buf[start + 6] !== EV_CURRENT) return fail('ELF の ident version が不正です')

  const eType = buf.readUInt16LE(start + 16)
  if (eType !== ET_EXEC && eType !== ET_DYN) return fail(`e_type が未対応です: ${eType}`)
  if (buf.readUInt16LE(start + 18) !== EM_AARCH64) return fail('e_machine が AArch64 ではありません')
  if (buf.readUInt32LE(start + 20) !== EV_CURRENT) return fail('e_version が不正です')

  const phoff = readU64(buf, start + 32)
  const shoff = readU64(buf, start + 40)
  if (buf.readUInt16LE(start + 52) !== EHDR_SIZE) return fail('e_ehsize が 64 ではありません')
  const phentsize = buf.readUInt16LE(start + 54)
  const phnum = buf.readUInt16LE(start + 56)
  const shentsize = buf.readUInt16LE(start + 58)
  const shnum = buf.readUInt16LE(start + 60)

  if (phnum > 0 && phentsize !== PHDR_SIZE) return fail('e_phentsize が 56 ではありません')
  if (phnum === 0 && phentsize !== 0 && phentsize !== PHDR_SIZE) return fail('e_phentsize が不正です')
  if (shentsize !== SHDR_SIZE) return fail('e_shentsize が 64 ではありません')
  if (phnum > MAX_PHNUM) return fail(`e_phnum が上限 ${MAX_PHNUM} を超えています: ${phnum}`)
  if (shnum === 0) return fail('e_shnum が 0 です(セクション表がありません)')
  if (shnum > MAX_SHNUM) return fail(`e_shnum が上限 ${MAX_SHNUM} を超えています: ${shnum}`)

  if (phoff === null) return fail('e_phoff が安全整数を超えています')
  if (shoff === null) return fail('e_shoff が安全整数を超えています')
  if (!fits(phoff, phnum * PHDR_SIZE, size)) return fail('プログラムヘッダ表が格納範囲外です')
  if (!fits(shoff, shnum * SHDR_SIZE, size)) return fail('セクションヘッダ表が格納範囲外です')

  const phdrs = []
  for (let i = 0; i < phnum; i++) {
    const p = start + phoff + i * PHDR_SIZE
    const pOffset = readU64(buf, p + 8)
    const pFilesz = readU64(buf, p + 32)
    if (pOffset === null || pFilesz === null) return fail(`プログラムヘッダ ${i} の u64 が安全整数を超えています`)
    phdrs.push({ type: buf.readUInt32LE(p), flags: buf.readUInt32LE(p + 4), offset: pOffset, filesz: pFilesz })
  }
  const execLoads = phdrs.filter((p) => p.type === PT_LOAD && (p.flags & PF_X) !== 0)

  const sections = []
  const execRanges = []
  let imageSize = Math.max(EHDR_SIZE, phoff + phnum * PHDR_SIZE, shoff + shnum * SHDR_SIZE)
  for (let i = 0; i < shnum; i++) {
    const s = start + shoff + i * SHDR_SIZE
    const shType = buf.readUInt32LE(s + 4)
    const shFlags = buf.readUInt32LE(s + 8)
    const shOffset = readU64(buf, s + 24)
    const shSize = readU64(buf, s + 32)
    if (shOffset === null || shSize === null) return fail(`セクション ${i} の u64 が安全整数を超えています`)
    // NOBITS はファイル上に実体が無いので、範囲は検査しない
    if (shType === SHT_NOBITS) continue
    if (!fits(shOffset, shSize, size)) return fail(`セクション ${i} が格納範囲外です`)

    sections.push({
      type: shType,
      flags: shFlags,
      start: start + shOffset,
      end: start + shOffset + shSize,
    })
    imageSize = Math.max(imageSize, shOffset + shSize)

    if (shType === SHT_PROGBITS && (shFlags & SHF_EXECINSTR) !== 0 && shSize > 0) {
      const inLoad = execLoads.some((p) => shOffset >= p.offset && shOffset + shSize <= p.offset + p.filesz)
      if (inLoad) execRanges.push({ start: start + shOffset, end: start + shOffset + shSize })
    }
  }

  // 実行範囲の重なりは不正
  const sorted = [...execRanges].sort((a, b) => a.start - b.start)
  let maxEnd = -Infinity
  for (const r of sorted) {
    if (r.start < maxEnd) return fail(`実行範囲が重なっています: start=${r.start}`)
    maxEnd = Math.max(maxEnd, r.end)
  }

  return { ok: true, imageSize, execRanges, sections }
}

// main の非実行 PROGBITS セクションの中から埋込み ELF を探す。結果は start 昇順
function findEmbeddedElfs(buf, mainParse) {
  const parents = mainParse.sections
    .filter((s) => s.type === SHT_PROGBITS && (s.flags & SHF_EXECINSTR) === 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start)

  const seen = new Set()
  const adopted = []
  for (const sec of parents) {
    // セクションの範囲だけを検索する(範囲外まで走査しない)
    const body = buf.subarray(sec.start, sec.end)
    let idx = body.indexOf(ELF_MAGIC)
    while (idx !== -1) {
      const pos = sec.start + idx
      if (!seen.has(pos)) {
        seen.add(pos)
        if (seen.size > MAX_EMBEDDED_CANDIDATES) {
          throw va39Error(VA39_CODES.PATCH_UNSUPPORTED, {
            detail: `埋込み ELF の候補が上限 ${MAX_EMBEDDED_CANDIDATES} を超えました`,
          })
        }
        // 採用済みの埋込み ELF の内側にある候補は無視する(入れ子は対象外)
        const nested = adopted.some((a) => pos >= a.start && pos < a.start + a.size)
        if (!nested) {
          const r = parseElf64(buf, pos, sec.end)
          if (r.ok) {
            adopted.push({ start: pos, size: r.imageSize, execRanges: r.execRanges })
            if (adopted.length > MAX_EMBEDDED_VALID) {
              throw va39Error(VA39_CODES.PATCH_UNSUPPORTED, {
                detail: `有効な埋込み ELF が上限 ${MAX_EMBEDDED_VALID} を超えました`,
              })
            }
          }
        }
      }
      idx = body.indexOf(ELF_MAGIC, idx + 1)
    }
  }
  return adopted.sort((a, b) => a.start - b.start)
}

// 本体と埋込み ELF のパッチ対象範囲を返す。書換えはしない
function scanTargets(buf) {
  const main = parseElf64(buf, 0, buf.length)
  if (!main.ok) {
    throw va39Error(VA39_CODES.PATCH_UNSUPPORTED, { detail: main.reason })
  }
  const embedded = findEmbeddedElfs(buf, main)
  return {
    main: { start: 0, size: buf.length, execRanges: main.execRanges },
    embedded: embedded.map((e) => ({ start: e.start, size: e.size, execRanges: e.execRanges })),
  }
}

module.exports = {
  parseElf64,
  findEmbeddedElfs,
  scanTargets,
  LIMITS,
}
