// Every address vicinity_curve uses, derived exactly as the program derives it
// (VICINITY-CURVE-DESIGN.md 3.2, 3.3, 3.10, 4.8, 4.10, 4.15, 14.1). Addresses
// are returned as base58 strings; inputs may be base58 strings, @solana/kit
// addresses or web3.js PublicKeys.
import web3 from '@solana/web3.js';
import { ADDRESSES, CLUSTERS, CURVE_PROGRAM_ID, SEEDS } from './constants.mjs';

const { PublicKey } = web3;

export const toKey = (a) => (a instanceof PublicKey ? a : new PublicKey(String(a)));
const enc = new TextEncoder();
const seed = (s) => enc.encode(s);

export function u64le(n) {
  const v = BigInt(n);
  if (v < 0n || v >= 1n << 64n) throw new RangeError(`u64 out of range: ${n}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
export function u16le(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${n}`);
  return new Uint8Array([v & 0xff, v >> 8]);
}

/** `[address, bump]` of a PDA. */
export function findPda(seeds, programId) {
  const [k, bump] = PublicKey.findProgramAddressSync(seeds, toKey(programId));
  return [k.toBase58(), bump];
}
const pda = (seeds, programId) => findPda(seeds, programId)[0];

/** The cluster's compiled ids ('mainnet' for the default build, 'devnet' for the `devnet` feature), or a custom set. */
export function clusterIds(cluster = 'mainnet') {
  if (typeof cluster === 'object' && cluster) return cluster;
  const c = CLUSTERS[cluster];
  if (!c) throw new Error(`unknown cluster ${cluster} (mainnet or devnet)`);
  return c;
}

/**
 * The PDAs of one deployment. `programId` is the vicinity_curve id (the
 * throwaway localnet/devnet key by default); `cluster` picks the compiled ids
 * of vicinity_rewards and the old vicinity_launchpad.
 */
export function curvePdas({ programId = CURVE_PROGRAM_ID, cluster = 'mainnet' } = {}) {
  const P = String(programId);
  const ids = clusterIds(cluster);
  const coinOf = (x) => toKey(x).toBuffer();
  return Object.freeze({
    programId: P,
    cluster: ids,
    launchpad: () => pda([seed(SEEDS.launchpad)], P),
    config: (configId) => pda([seed(SEEDS.config), u16le(configId)], P),
    approval: (cityId) => pda([seed(SEEDS.approval), u64le(cityId)], P),
    coin: (cityId) => pda([seed(SEEDS.coin), u64le(cityId)], P),
    coinWithBump: (cityId) => findPda([seed(SEEDS.coin), u64le(cityId)], P),
    mint: (coin) => pda([seed(SEEDS.mint), coinOf(coin)], P),
    coinVault: (coin) => pda([seed(SEEDS.coinVault), coinOf(coin)], P),
    /** `["ticker", symbol bytes]`: the symbol as given (approve_launch derives it before checking it). */
    ticker: (symbol) => pda([seed(SEEDS.ticker), seed(symbol)], P),
    payoutOptIn: (coin) => pda([seed(SEEDS.payoutOptIn), coinOf(coin)], P),
    eventAuthority: () => pda([seed(SEEDS.eventAuthority)], P),
    programData: () => pda([toKey(P).toBuffer()], ADDRESSES.upgradeableLoader),
    /** The coin, its mint and its vault for a city. */
    coinAccounts: (cityId) => {
      const coin = pda([seed(SEEDS.coin), u64le(cityId)], P);
      return { coin, mint: pda([seed(SEEDS.mint), coinOf(coin)], P), vault: pda([seed(SEEDS.coinVault), coinOf(coin)], P) };
    },
    // the old vicinity_launchpad (4.8, 8.5)
    legacyCoin: (cityId) => pda([seed('coin'), u64le(cityId)], ids.legacyProgram),
    legacyApproval: (cityId) => pda([seed('approval'), u64le(cityId)], ids.legacyProgram),
    legacyLaunchpad: () => pda([seed('launchpad')], ids.legacyProgram),
    // vicinity_rewards (4.15; the registry, 4.8, 4.10, OPS-1)
    rewardsRegistry: () => pda([seed('registry')], ids.rewardsProgram),
    rewardsCity: (mint) => pda([seed(SEEDS.rewardsCity), toKey(mint).toBuffer()], ids.rewardsProgram),
    rewardsVault: (cityConfig) => pda([seed(SEEDS.rewardsVault), toKey(cityConfig).toBuffer()], ids.rewardsProgram),
    rewardsAccounts: (mint) => {
      const config = pda([seed(SEEDS.rewardsCity), toKey(mint).toBuffer()], ids.rewardsProgram);
      return { config, vault: pda([seed(SEEDS.rewardsVault), toKey(config).toBuffer()], ids.rewardsProgram) };
    },
  });
}

/** Metaplex metadata PDA of a mint: `["metadata", METAPLEX_PROGRAM_ID, mint]` (4.10, T6). */
export const metadataAddress = (mint) =>
  pda([seed(SEEDS.metadata), toKey(ADDRESSES.metaplex).toBuffer(), toKey(mint).toBuffer()], ADDRESSES.metaplex);

/** Associated token account (classic SPL Token unless another token program is given). */
export const associatedTokenAddress = (owner, mint, tokenProgram = ADDRESSES.token) =>
  pda([toKey(owner).toBuffer(), toKey(tokenProgram).toBuffer(), toKey(mint).toBuffer()], ADDRESSES.associatedToken);

/** `METADATA_URI_PREFIX + mint + ".json"` (3.10). */
export const metadataUri = (mint) => `https://vicinity.city/coin-meta/${toKey(mint).toBase58()}.json`;
