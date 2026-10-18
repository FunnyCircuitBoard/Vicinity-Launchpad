// A tiny TrueType reader: just enough of a font file to know every character it draws and how far each one advances
// (head.unitsPerEm, OS/2 sCapHeight, hhea.numberOfHMetrics, hmtx, and the Unicode cmap in format 4 or 12). Used by
// scripts/coin-art/metrics.mjs and test/coinart.test.js, so the width table the coin picture is fitted with is always
// regenerated from the committed font files themselves, never typed in.
export function readTtf(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o) => dv.getUint16(o), i16 = (o) => dv.getInt16(o), u32 = (o) => dv.getUint32(o);
  const tables = {};
  const n = u16(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3]);
    tables[tag] = { offset: u32(r + 8), length: u32(r + 12) };
  }
  for (const t of ["head", "hhea", "hmtx", "cmap", "OS/2"]) if (!tables[t]) throw new Error(`font has no ${t} table`);
  const unitsPerEm = u16(tables.head.offset + 18);
  const capHeight = u16(tables["OS/2"].offset) >= 2 ? i16(tables["OS/2"].offset + 88) : null;
  const weightClass = u16(tables["OS/2"].offset + 4);
  const nH = u16(tables.hhea.offset + 34);
  const advance = (gid) => u16(tables.hmtx.offset + 4 * Math.min(gid, nH - 1));

  // the best Unicode subtable: (3,10) format 12, else (3,1) or (0,x) format 4
  const c = tables.cmap.offset, subs = [];
  for (let i = 0; i < u16(c + 2); i++) subs.push({ pid: u16(c + 4 + i * 8), eid: u16(c + 6 + i * 8), off: c + u32(c + 8 + i * 8) });
  const pick = subs.find((s) => u16(s.off) === 12 && (s.pid === 3 || s.pid === 0)) || subs.find((s) => u16(s.off) === 4 && (s.pid === 3 || s.pid === 0));
  if (!pick) throw new Error("font has no Unicode cmap");
  const cmap = new Map();
  if (u16(pick.off) === 12) {
    const groups = u32(pick.off + 12);
    for (let g = 0; g < groups; g++) {
      const o = pick.off + 16 + g * 12;
      const start = u32(o), end = u32(o + 4), gid = u32(o + 8);
      for (let cp = start; cp <= end; cp++) cmap.set(cp, gid + (cp - start));
    }
  } else {
    const o = pick.off, segX2 = u16(o + 6);
    const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = u16(ends + 2 * s), start = u16(starts + 2 * s), delta = i16(deltas + 2 * s), ro = u16(ranges + 2 * s);
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        let gid;
        if (ro === 0) gid = (cp + delta) & 0xffff;
        else {
          const at = ranges + 2 * s + ro + 2 * (cp - start);
          gid = u16(at);
          if (gid) gid = (gid + delta) & 0xffff;
        }
        if (gid) cmap.set(cp, gid);
      }
    }
  }
  const widths = {};
  for (const cp of [...cmap.keys()].sort((x, y) => x - y)) widths[String.fromCodePoint(cp)] = advance(cmap.get(cp));
  return { unitsPerEm, capHeight, weightClass, widths };
}
