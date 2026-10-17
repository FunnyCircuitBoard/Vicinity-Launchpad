// Reading the G01 golden vectors exported by the Rust crate
// (crates/vicinity-curve-math/reference/g01-vectors.json, written by
// crates/vicinity-curve-math/tests/g01_vectors.rs): the line format, the state
// digest and the payout bookkeeping, shared by sdk/curve/g01.test.mjs (the
// JavaScript port) and tests-curve/22-g01-onchain.test.mjs (the program).
// Test support only; not exported by index.mjs.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as S from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const G01_PATH = join(here, '..', '..', 'crates', 'vicinity-curve-math', 'reference', 'g01-vectors.json');

/** FNV-1a 64 (16 hex digits) of the 24 state fields as decimal numbers joined by commas (tests/g01_vectors.rs). */
export function stateDigest(st) {
  const text = S.STATE_KEYS.map((k) => String(st[k])).join(',');
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(text, 'utf8')) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}
/** The config params of a vector life. */
export function lifeConfig(l) {
  const c = l.config;
  return {
    liquidityBps: BigInt(c.bps[0]), platformBps: BigInt(c.bps[1]), founderBps: BigInt(c.bps[2]), holdersBps: BigInt(c.bps[3]), buybackBps: BigInt(c.bps[4]),
    virtualSol: BigInt(c.x0), virtualTokens: BigInt(c.y0), curveSupply: BigInt(c.S), poolSupply: BigInt(c.P), graduationSol: BigInt(c.R), launchFeeLamports: BigInt(c.fee),
  };
}
/** One vector line parsed: `{ kind, ...fields }` with BigInt amounts. */
export function parseOp(line) {
  const f = line.split(' ');
  const n = (i) => BigInt(f[i]);
  const splitAt = (i) => ({ fee: n(i), liquidity: n(i + 1), liquidityFloor: n(i + 2), platform: n(i + 3), founder: n(i + 4), holders: n(i + 5), buyback: n(i + 6) });
  switch (f[0]) {
    case 'B': return f[3] === 'E' ? { kind: 'buy', holder: Number(f[1]), solIn: n(2), error: f[4] }
      : { kind: 'buy', holder: Number(f[1]), solIn: n(2), charged: n(3), net: n(4), tokensOut: n(5), split: splitAt(6), drip: n(13), partial: f[14] === '1', graduates: f[15] === '1', digest: f[16] };
    case 'S': return f[3] === 'E' ? { kind: 'sell', holder: Number(f[1]), tokensIn: n(2), error: f[4] }
      : { kind: 'sell', holder: Number(f[1]), tokensIn: n(2), gross: n(3), solOut: n(4), split: splitAt(5), drip: n(12), digest: f[13] };
    case 'K': return f[2] === 'N' ? { kind: 'buyback', slot: n(1), noop: true } : { kind: 'buyback', slot: n(1), spent: n(2), coins: n(3), cap: n(4), digest: f[5] };
    case 'P': return { kind: 'pay', which: Number(f[1]), amount: n(2), digest: f[3] };
    default: throw new Error(`unknown vector line ${line}`);
  }
}
/** The payout bookkeeping of withdraw (0), claim (1) and forward (2) on a state: `[amount, newState]`. */
export function payState(st, which) {
  const k = ['platformPending', 'founderPending', 'holdersPending'][which];
  return [st[k], { ...st, [k]: 0n }];
}
