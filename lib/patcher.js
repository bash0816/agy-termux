'use strict';

function applyVA39Patch(buf) {
  const counts = { ubfx: 0, lsl: 0, mask: 0, mmap: 0, word: 0, faccessat2: 0 };
  const len = buf.length;
  function getU32(off) { return buf.readUInt32LE(off); }
  function putU32(off, val) { buf.writeUInt32LE(val >>> 0, off); }

  for (let off = 0; off + 4 <= len; off += 4) {
    const w = getU32(off);
    if ((w & 0x7F800000) === 0x53000000) {
      const immr = (w >> 16) & 0x3F;
      const imms = (w >> 10) & 0x3F;
      if (immr === 42 && imms === 44) {
        putU32(off, (w & ~((0x3F << 16) | (0x3F << 10))) | (35 << 16) | (37 << 10));
        counts.ubfx++;
      } else if (immr === 22 && imms === 21) {
        putU32(off, (w & ~((0x3F << 16) | (0x3F << 10))) | (29 << 16) | (28 << 10));
        counts.lsl++;
      }
    }
  }
  for (let off = 0; off + 8 <= len; off += 4) {
    if (getU32(off) === 0x92D3800A && getU32(off + 4) === 0xF2E0000A) {
      putU32(off, 0x9280000A); putU32(off + 4, 0xD35DFD4A); counts.mask++;
    }
  }
  for (let off = 0; off + 4 <= len; off += 4) {
    if (getU32(off) === 0xF2E00029) { putU32(off, 0xD3596129); counts.mmap++; }
  }
  const wordRewrites = new Map([
    [0xD2C20009, 0xD2C00409], [0xD2C2000A, 0xD2C0040A], [0xF2C20008, 0xF2DFF408],
    [0xF2C20009, 0xF2DFF409], [0xD2C10009, 0xD2C00209], [0xD2C1000A, 0xD2C0020A],
    [0xF2C38008, 0xF2DFF708], [0xF2C38009, 0xF2DFF709], [0x92560A6C, 0x925D0A6C],
    [0x92560A6A, 0x925D0A6A], [0xD2C3000D, 0xD2C0060D], [0xD2C3000C, 0xD2C0060C],
    [0xD2C08008, 0xD2C00108],
  ]);
  for (let off = 0; off + 4 <= len; off += 4) {
    const w = getU32(off);
    const rep = wordRewrites.get(w >>> 0);
    if (rep !== undefined) { putU32(off, rep); counts.word++; }
  }
  for (let off = 0; off + 16 <= len; off += 4) {
    if (getU32(off) === 0xAA1F03E5 && getU32(off+4) === 0xAA1F03E6 &&
        getU32(off+8) === 0xD28036E0 && (getU32(off+12) & 0xFC000000) === 0x94000000) {
      putU32(off+8, 0xD2800600); counts.faccessat2++;
    }
  }
  return counts;
}

module.exports = { applyVA39Patch };
