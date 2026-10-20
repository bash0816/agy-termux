'use strict';

const { scanTargets } = require('./elf-scan');

// 書換えの対象は scanTargets が確定した実行範囲の内側だけ(範囲外のバイトには触れない)

const COUNT_KEYS = ['ubfx', 'lsl', 'mask', 'mmap', 'word'];

const WORD_REWRITES = new Map([
  [0xD2C20009, 0xD2C00409], [0xD2C2000A, 0xD2C0040A], [0xF2C20008, 0xF2DFF408],
  [0xF2C20009, 0xF2DFF409], [0xD2C10009, 0xD2C00209], [0xD2C1000A, 0xD2C0020A],
  [0xF2C38008, 0xF2DFF708], [0xF2C38009, 0xF2DFF709], [0x92560A6C, 0x925D0A6C],
  [0x92560A6A, 0x925D0A6A], [0xD2C3000D, 0xD2C0060D], [0xD2C3000C, 0xD2C0060C],
  [0xD2C08008, 0xD2C00108],
]);

function emptyCounts() {
  return { ubfx: 0, lsl: 0, mask: 0, mmap: 0, word: 0 };
}

function putU32(buf, off, val) {
  buf.writeUInt32LE(val >>> 0, off);
}

// 1 つの実行範囲 [start, end) の内側だけを書き換える。走査は start から 4 バイト刻み
function patchRange(buf, start, end, counts) {
  // ubfx / lsl: 64bit 形 UBFM(sf=1, opc=10, N=1)のみ対象
  for (let off = start; off + 4 <= end; off += 4) {
    const w = buf.readUInt32LE(off);
    if (((w & 0xFFC00000) >>> 0) === 0xD3400000) {
      const immr = (w >>> 16) & 0x3F;
      const imms = (w >>> 10) & 0x3F;
      if (immr === 42 && imms === 44) {
        putU32(buf, off, (w & ~((0x3F << 16) | (0x3F << 10))) | (35 << 16) | (37 << 10));
        counts.ubfx++;
      } else if (immr === 22 && imms === 21) {
        putU32(buf, off, (w & ~((0x3F << 16) | (0x3F << 10))) | (29 << 16) | (28 << 10));
        counts.lsl++;
      }
    }
  }

  // mask: 2 語連続。範囲をまたぐ照合はしない
  for (let off = start; off + 8 <= end; off += 4) {
    if (buf.readUInt32LE(off) === 0x92D3800A && buf.readUInt32LE(off + 4) === 0xF2E0000A) {
      putU32(buf, off, 0x9280000A);
      putU32(buf, off + 4, 0xD35DFD4A);
      counts.mask++;
    }
  }

  // mmap
  for (let off = start; off + 4 <= end; off += 4) {
    if (buf.readUInt32LE(off) === 0xF2E00029) {
      putU32(buf, off, 0xD3596129);
      counts.mmap++;
    }
  }

  // word 置換表
  for (let off = start; off + 4 <= end; off += 4) {
    const rep = WORD_REWRITES.get(buf.readUInt32LE(off));
    if (rep !== undefined) {
      putU32(buf, off, rep);
      counts.word++;
    }
  }
}

function applyVA39Patch(buf) {
  // 先に全対象範囲を確定する。ここで PATCH_UNSUPPORTED が出ても buf には書き込まない
  const targets = scanTargets(buf);

  const plan = [
    { kind: 'main', offset: targets.main.start, size: targets.main.size, execRanges: targets.main.execRanges },
    ...targets.embedded.map((e) => ({
      kind: 'embedded',
      offset: e.start,
      size: e.size,
      execRanges: e.execRanges,
    })),
  ];

  const total = emptyCounts();
  const containers = [];
  for (const c of plan) {
    const counts = emptyCounts();
    for (const r of c.execRanges) {
      patchRange(buf, r.start, r.end, counts);
    }
    for (const k of COUNT_KEYS) total[k] += counts[k];
    containers.push({ kind: c.kind, offset: c.offset, size: c.size, counts });
  }

  return { ...total, containers };
}

module.exports = { applyVA39Patch };
