// Writes sdk/fixtures/launch-batch.json: the launch-batch test vectors shared by the SDK (sdk/curve/batch.test.mjs) and
// the program's unit test U13 (programs/vicinity-curve/src/batch.rs), VICINITY-CURVE-DESIGN.md 3.12 and 12.1.
//
//   * workedExample: 3.12's three cities under batch 7, with every preimage, leaf, the root and each proof;
//   * trees: for n = 1 to 70 and 512, the entries of the rule below under batch 3 of the localnet program id: the root,
//     the depth, a SHA-256 over every leaf (in order) and over every proof (each as a length byte and its hashes), and
//     the first, middle and last proofs in full. Each side regenerates every leaf and proof and compares.
//   * entry i: city_id 1000 + 7 i, founder SHA-256("founder:i"), config i mod 3, meta_hash SHA-256("meta:i"),
//     name "City i", symbol "C" + i in base 36 (upper case).
//
// Usage: node sdk/curve/gen-launch-batch-fixture.mjs [--check]   (--check: compare with the committed file, exit 1 on any difference)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toHex } from '../merkle.mjs';
import { CURVE_PROGRAM_ID } from './constants.mjs';
import { buildLevels, launchLeaf, launchLeafPreimage, proofAt, treeDepth } from './batch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'fixtures', 'launch-batch.json');
const sha = (s) => createHash('sha256').update(s).digest();

export function fixtureEntry(i) {
  return {
    cityId: 1000n + 7n * BigInt(i), founder: Uint8Array.from(sha(`founder:${i}`)), configId: i % 3, metaHash: Uint8Array.from(sha(`meta:${i}`)),
    name: `City ${i}`, symbol: `C${i.toString(36).toUpperCase()}`,
  };
}

export function launchBatchFixture() {
  const programId = CURVE_PROGRAM_ID;
  const worked = [
    { cityId: 2_643_743n, name: 'London', symbol: 'LONDON', f: 0x11 },
    { cityId: 2_988_507n, name: 'Paris', symbol: 'PARIS', f: 0x22 },
    { cityId: 5_128_581n, name: 'New York City', symbol: 'NYC', f: 0x33 },
  ].map(({ f, ...e }) => ({ ...e, founder: new Uint8Array(32).fill(f), configId: 0, metaHash: Uint8Array.from(sha(`{"name":"${e.name}","symbol":"${e.symbol}"}`)) }));
  const wLeaves = worked.map((e) => launchLeaf({ programId, batchSeq: 7n, ...e }));
  const wLevels = buildLevels(wLeaves);
  const workedExample = {
    batchSeq: '7',
    entries: worked.map((e, i) => ({
      cityId: e.cityId.toString(), founder: toHex(e.founder), configId: 0, name: e.name, symbol: e.symbol, metaHash: toHex(e.metaHash),
      preimage: toHex(launchLeafPreimage({ programId, batchSeq: 7n, ...e })), leaf: toHex(wLeaves[i]), proof: proofAt(wLevels, i).map(toHex),
    })),
    root: toHex(wLevels[wLevels.length - 1][0]),
  };
  const trees = [];
  for (const n of [...Array.from({ length: 70 }, (_, k) => k + 1), 512]) {
    const leaves = Array.from({ length: n }, (_, i) => launchLeaf({ programId, batchSeq: 3n, ...fixtureEntry(i) }));
    const levels = buildLevels(leaves);
    const proofs = leaves.map((_, i) => proofAt(levels, i));
    const proofBytes = Buffer.concat(proofs.map((p) => Buffer.concat([Buffer.from([p.length]), ...p.map((h) => Buffer.from(h))])));
    const samples = [...new Set([0, Math.floor(n / 2), n - 1])].map((i) => ({ index: i, leaf: toHex(leaves[i]), proof: proofs[i].map(toHex) }));
    trees.push({
      leaves: n, depth: treeDepth(n), root: toHex(levels[levels.length - 1][0]), leavesDigest: toHex(sha(Buffer.concat(leaves.map((l) => Buffer.from(l))))),
      proofsDigest: toHex(sha(proofBytes)), samples,
    });
  }
  return { about: 'VICINITY-CURVE-DESIGN.md 3.12 launch leaves (written by sdk/curve/gen-launch-batch-fixture.mjs)', programId, batchSeq: 3, workedExample, trees };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = `${JSON.stringify(launchBatchFixture(), null, 1)}\n`;
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== text) { console.error(`${OUT} differs from the generator`); process.exit(1); }
    console.log(`${OUT} matches the generator`);
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
