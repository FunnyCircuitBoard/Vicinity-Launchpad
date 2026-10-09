/**
 * The cluster settings of the in-app swap and the launchpad's curve trades, read per request like src/flags.js (a dashboard
 * variable change applies to the next request). Devnet has recorded defaults (solana/LAUNCHPAD-DEVNET.md); mainnet has NO
 * defaults for the launchpad: the program id and the Meteora configs are REQUIRED settings the team sets after deploying, and
 * until they are set launchpadTrading is off and `npm run mainnet:preflight` fails its program rows. No mainnet address of the
 * launchpad appears anywhere in the code.
 *
 *   SWAP                  on|off   the Jupiter swap panel and /api/swap/* (default off)
 *   LAUNCHPAD_TRADING     on|off   curve trades of city coins and /api/launchpad/trade/* (default off)
 *   LAUNCHPAD_CLUSTER     devnet|mainnet (default devnet)
 *   LAUNCHPAD_RPC_URL     secret; default https://api.devnet.solana.com on devnet, = SOLANA_RPC_URL on mainnet
 *   LAUNCHPAD_PROGRAM_ID  devnet default Fncx4q…; REQUIRED on mainnet
 *   LAUNCHPAD_DBC_CONFIGS comma-separated Meteora configs our program allow-lists; devnet default the two recorded; REQUIRED on mainnet
 *   LAUNCHPAD_LOOKUP_TABLE optional address lookup table (devnet default 5tPTiz…)
 *   JUPITER_API_BASE      https://api.jup.ag (the keyed Swap V2 host); JUPITER_LITE_BASE https://lite-api.jup.ag (keyless quotes)
 *   JUPITER_API_KEY       secret (x-api-key); JUPITER_RPS the plan's requests per second for the per-server bucket (default 1)
 *   SWAP_PLATFORM_FEE_BPS, SWAP_FEE_ACCOUNT  a platform fee on Jupiter swaps (default 0 and none: an owner decision)
 * Fixed in code (the same on both clusters): Meteora's programs, the dev wallet (a constant inside our program), Jupiter's program.
 */
import { isSolanaAddress } from "./solana.js";
import { ADDRESSES, PROGRAM_IDS } from "./sol/pda.js";

const on = (v) => String(v ?? "").trim().toLowerCase() === "on";
export const swapOn = (env) => on(env && env.SWAP);
export const launchpadTradingOn = (env) => on(env && env.LAUNCHPAD_TRADING) && Boolean(launchpadCluster(env).ready);

export const DEVNET = Object.freeze({
  rpc: "https://api.devnet.solana.com",
  programId: PROGRAM_IDS.launchpadDevnet,
  dbcConfigs: ["4ZLtvU1zieGwbexVScEpEyrPV4uz53ZXVaT6fQoonrD7", "8ZcsWij7BWkhrkvoJuGULN3XreHT9De4dj4ZEVgRMi8J"],
  lookupTable: "5tPTizNodKvKEo8k7a9NjRDucMNVQsQvHrqjEmwXCXhe",
});
const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const str = (v) => (v == null ? "" : String(v).trim());
const list = (v) => str(v).split(",").map((s) => s.trim()).filter(Boolean);

/** What the launchpad trades run against: { cluster, rpc, programId, dbcConfigs, lookupTable, ready, missing[] }. */
export function launchpadCluster(env = {}) {
  const cluster = str(env.LAUNCHPAD_CLUSTER).toLowerCase() === "mainnet" ? "mainnet" : "devnet";
  const dev = cluster === "devnet";
  const programId = str(env.LAUNCHPAD_PROGRAM_ID) || (dev ? DEVNET.programId : "");
  const dbcConfigs = list(env.LAUNCHPAD_DBC_CONFIGS).length ? list(env.LAUNCHPAD_DBC_CONFIGS) : dev ? DEVNET.dbcConfigs : [];
  const lookupTable = str(env.LAUNCHPAD_LOOKUP_TABLE) || (dev ? DEVNET.lookupTable : "") || null;
  const rpc = str(env.LAUNCHPAD_RPC_URL) || (dev ? DEVNET.rpc : str(env.SOLANA_RPC_URL) || PUBLIC_MAINNET_RPC);
  const missing = [];
  if (!isSolanaAddress(programId)) missing.push("LAUNCHPAD_PROGRAM_ID");
  if (!dbcConfigs.length || !dbcConfigs.every(isSolanaAddress)) missing.push("LAUNCHPAD_DBC_CONFIGS");
  if (lookupTable && !isSolanaAddress(lookupTable)) missing.push("LAUNCHPAD_LOOKUP_TABLE");
  return { cluster, chain: `solana:${cluster}`, rpc, programId: isSolanaAddress(programId) ? programId : null, dbcConfigs: dbcConfigs.filter(isSolanaAddress), lookupTable: lookupTable && isSolanaAddress(lookupTable) ? lookupTable : null, ready: missing.length === 0, missing, feeRecipient: ADDRESSES.feeRecipient };
}

/** Jupiter settings: the keyed base for /swap/v2/build, the keyless lite base for /swap/v1/quote, the key, the plan's rps. */
export function jupiterConfig(env = {}) {
  const base = (str(env.JUPITER_API_BASE) || "https://api.jup.ag").replace(/\/+$/, "");
  const lite = (str(env.JUPITER_LITE_BASE) || "https://lite-api.jup.ag").replace(/\/+$/, "");
  const key = str(env.JUPITER_API_KEY);
  const rps = Number(env.JUPITER_RPS);
  const feeBps = Number(env.SWAP_PLATFORM_FEE_BPS);
  return {
    base, lite, key: key || null, keyed: Boolean(key), rps: Number.isFinite(rps) && rps > 0 ? Math.min(150, rps) : 1,
    platformFeeBps: Number.isInteger(feeBps) && feeBps > 0 && feeBps <= 1000 ? feeBps : 0,
    feeAccount: isSolanaAddress(str(env.SWAP_FEE_ACCOUNT)) ? str(env.SWAP_FEE_ACCOUNT) : null,
    headers: key ? { "x-api-key": key } : {},
  };
}
/** The swap's own cluster: $VICINITY and every Jupiter route live on mainnet. */
export const swapCluster = () => ({ cluster: "mainnet", chain: "solana:mainnet" });
/** Solscan link for a signature on a cluster. */
export const solscanTx = (sig, cluster = "mainnet") => `https://solscan.io/tx/${sig}${cluster === "mainnet" ? "" : `?cluster=${cluster}`}`;
