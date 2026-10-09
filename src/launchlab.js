/**
 * A Raydium LaunchLab bonding curve, read straight from the chain (only while LAUNCHPAD_V2=on, see src/marketlive.js).
 *
 * Pool identity  The pool of a coin is the program-derived address of the seeds ["pool", mint, pair mint] under the LaunchLab
 *                program: computed here, with no network call (for $VICINITY and WSOL it is 3E32cHh3aA4KrAH1ShLbHcdTsTs2EyLKLtpWQNiNySZo,
 *                checked against the chain on 6 Oct 2026). A pool id that comes from an API is never trusted: it must equal this one.
 * The account    429 bytes owned by LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj, discriminator f7ede3f5d7c3de46, little-endian
 *                (raydium-sdk-v2 0.2.73-alpha, src/raydium/launchpad/layout.ts): status u8 @17, decimals A @18 and B @19,
 *                supply u64 @21, totalSellA @29, virtualA @37, virtualB @45, realA @53, realB @61, totalFundRaisingB @69,
 *                mintA @205, mintB @237. Every u64 is read as a BigInt.
 * What it gives  priceNative = (virtualB + realB) / (virtualA − realA) × 10^(decA − decB), the curve's spot price in the pair
 *                token (the SDK's getPoolPrice; equal to Raydium's own chart close), how much of the pair token the curve
 *                holds (realB) against what graduation needs (totalFundRaisingB: the pool migrates when realB reaches it),
 *                the tokens sold, the supply, and the status (0 on the curve, 1 migrating, 2 graduated).
 * Validation     the owner, the size, the discriminator, both mints, the decimals (6 for a LaunchLab coin, the pair's own for
 *                the pair), totalFundRaisingB > 0 and virtualA > realA. Anything else is "no curve" (null), never a guess.
 * Cost           one getMultipleAccounts for up to 100 pools, kept 30 seconds per server; after a failed read nothing is asked
 *                for 5 seconds (src/sources.js).
 */
import { rpc } from "./chain.js";
import { base58Decode, base58Encode, isSolanaAddress } from "./solana.js";
import { findProgramAddress } from "./sol/pda.js";
import { Source } from "./sources.js";

export const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
export const POOL_SIZE = 429;
const DISCRIMINATOR = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
const COIN_DECIMALS = 6;
/** The tokens a LaunchLab coin can be paired with here (src/coins.js PAIRS), and their decimals on the chain. */
export const PAIR_DECIMALS = {
  So11111111111111111111111111111111111111112: { symbol: "SOL", decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": { symbol: "RAY", decimals: 6 },
};
const STAGES = { 0: "curve", 1: "migrating", 2: "graduated" };

// findProgramAddress lives in src/sol/pda.js now (memoised, shared by the swap and the curve trades); the export is kept for its callers
export { findProgramAddress };

const pools = new Map(); // "mint|pair" -> pool address (pure math, kept for the life of the server)
/** The LaunchLab pool of a coin and its pair, or null when either is not an address. */
export async function poolAddress(mint, pairMint) {
  if (!isSolanaAddress(mint) || !isSolanaAddress(pairMint)) return null;
  const key = `${mint}|${pairMint}`;
  if (!pools.has(key)) {
    pools.set(key, (await findProgramAddress([new TextEncoder().encode("pool"), base58Decode(mint), base58Decode(pairMint)], LAUNCHLAB_PROGRAM))[0]);
    if (pools.size > 5_000) pools.delete(pools.keys().next().value);
  }
  return pools.get(key);
}

const b64bytes = (s) => { try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; } };

/**
 * One pool account (as getAccountInfo / getMultipleAccounts give it with encoding base64) decoded and checked against the
 * coin it must belong to. Returns the curve or null. `slot` is the read's slot, `poolId` the address it was read from.
 */
export function decodePool(account, { mint, pairMint, poolId = null, slot = null }) {
  if (!account || account.owner !== LAUNCHLAB_PROGRAM || !Array.isArray(account.data) || account.data[1] !== "base64" || typeof account.data[0] !== "string") return null;
  const pair = PAIR_DECIMALS[pairMint];
  if (!pair) return null;
  const b = b64bytes(account.data[0]);
  if (!b || b.length !== POOL_SIZE || !DISCRIMINATOR.every((x, i) => b[i] === x)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u64 = (o) => v.getBigUint64(o, true);
  const key = (o) => base58Encode(b.subarray(o, o + 32));
  const status = b[17], decA = b[18], decB = b[19];
  if (!(status in STAGES) || decA !== COIN_DECIMALS || decB !== pair.decimals) return null;
  if (key(205) !== mint || key(237) !== pairMint) return null;
  const supply = u64(21), totalSellA = u64(29), virtualA = u64(37), virtualB = u64(45), realA = u64(53), realB = u64(61), target = u64(69);
  if (target <= 0n || virtualA <= realA || supply <= 0n || totalSellA <= 0n) return null;
  const priceNative = (Number(virtualB + realB) / Number(virtualA - realA)) * 10 ** (decA - decB);
  if (!Number.isFinite(priceNative) || priceNative <= 0) return null;
  const a = 10 ** decA, q = 10 ** decB;
  return {
    poolId, stage: STAGES[status], status, symbol: pair.symbol, priceNative,
    raised: Number(realB) / q, target: Number(target) / q, progressPct: Math.min(100, (Number(realB) / Number(target)) * 100),
    tokensSold: Number(realA) / a, tokensForSale: Number(totalSellA) / a, supply: Number(supply) / a,
    slot: Number.isSafeInteger(slot) ? slot : null,
  };
}

const curves = new Source("chain_curve", { ttlMs: 30_000, staleMs: 5 * 60_000, negativeMs: 5_000 });
export const _resetLaunchlab = () => { curves.reset(); };
export const _curveSource = curves;

/**
 * The curves of some coins: coins = [{ mint, pairMint }]. Returns { curves: Map(mint -> curve | null | undefined), ok, stale,
 * error }: null = no LaunchLab pool for that coin (no account, or not one of ours), undefined = the chain could not be read.
 * Never throws.
 */
export async function readCurves(env, coins, fetchImpl = fetch, { now = Date.now(), timeoutMs = 4_000 } = {}) {
  const byPool = new Map();
  for (const c of coins) {
    const pool = await poolAddress(c.mint, c.pairMint);
    if (pool) byPool.set(pool, c);
  }
  const out = new Map(coins.map((c) => [c.mint, null]));
  if (!byPool.size) return { curves: out, ok: true, stale: false, error: null };
  const r = await curves.get([...byPool.keys()], now, async (want) => {
    const got = new Map();
    for (let i = 0; i < want.length; i += 100) {
      const chunk = want.slice(i, i + 100);
      const res = await rpc(env, "getMultipleAccounts", [chunk, { encoding: "base64" }], fetchImpl, { timeoutMs });
      const list = res && Array.isArray(res.value) ? res.value : null;
      if (!list || list.length !== chunk.length) throw new Error("rpc_bad_answer");
      const slot = Number.isSafeInteger(res.context?.slot) ? res.context.slot : null;
      chunk.forEach((pool, j) => { const c = byPool.get(pool); got.set(pool, decodePool(list[j], { mint: c.mint, pairMint: c.pairMint, poolId: pool, slot })); });
    }
    return got;
  });
  for (const [pool, c] of byPool) out.set(c.mint, r.values.get(pool));
  return { curves: out, ok: r.ok, stale: r.stale, error: r.error };
}
