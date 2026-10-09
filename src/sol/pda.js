/**
 * Every Solana address the Worker derives itself, exactly as the programs derive them (solana/sdk/launchpad/pda.mjs is the
 * web3.js version; the parity test solana/tests-launchpad/15-worker-builder.test.mjs checks every function here against it).
 *   findProgramAddress   Solana's PDA search (SHA-256 through WebCrypto, so every function is async); memoised per seeds+program
 *   ata                  the associated token account of an owner for a mint (Token or Token-2022)
 *   dbc.*                Meteora DBC: a pool, its token vaults, its event authority
 *   launchpad(programId) our program: the global account, a config's allow-list entry, a city's Coin record
 * Fixed addresses (PROGRAM_IDS, ADDRESSES) are the same on devnet and mainnet (Meteora's programs, the token programs, the
 * dev wallet which is a constant inside our program). Our program's id and the DBC configs come from the settings (src/cluster.js).
 */
import { isOnCurve } from "./oncurve.js";
import { base58Decode, base58Encode } from "../solana.js";
import { concat, u64le } from "./bytes.js";

export const PROGRAM_IDS = Object.freeze({
  dbc: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  damm: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  system: "11111111111111111111111111111111",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  upgradeableLoader: "BPFLoaderUpgradeab1e11111111111111111111111",
  lookupTable: "AddressLookupTab1e1111111111111111111111111",
  jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  // the devnet deployment (LAUNCHPAD-DEVNET.md); on mainnet the id is a setting, never this
  launchpadDevnet: "Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7",
});
export const ADDRESSES = Object.freeze({
  /** the dev wallet: the program constant FEE_RECIPIENT (every platform fee goes here) */
  feeRecipient: "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN",
  wsol: "So11111111111111111111111111111111111111112",
  dbcPoolAuthority: "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM",
  dammPoolAuthority: "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC",
  dammCustomizableConfig: "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
});

const enc = new TextEncoder();
const PDA_TAIL = enc.encode("ProgramDerivedAddress");
const memo = new Map(); // "<program>|<seeds hex>" -> Promise<[address, bump]>
const MEMO_MAX = 20_000;
const key = (seeds, programId) => `${programId}|${seeds.map((s) => [...s].map((b) => b.toString(16).padStart(2, "0")).join("")).join("/")}`;

/** Solana's findProgramAddress: the first bump from 255 down whose SHA-256 is OFF the ed25519 curve. [address, bump]. Memoised. */
export function findProgramAddress(seeds, programId) {
  const k = key(seeds, programId);
  let p = memo.get(k);
  if (!p) {
    p = (async () => {
      const tail = concat([base58Decode(programId), PDA_TAIL]);
      for (let bump = 255; bump >= 0; bump--) {
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", concat([...seeds, Uint8Array.of(bump), tail])));
        if (!isOnCurve(hash)) return [base58Encode(hash), bump];
      }
      throw new Error("no_program_address");
    })();
    p.catch(() => memo.delete(k));
    memo.set(k, p);
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  }
  return p;
}
const addr = async (seeds, programId) => (await findProgramAddress(seeds, programId))[0];
const b = (a) => base58Decode(a);

/** The associated token account of `owner` for `mint` under `tokenProgram` (Token by default). */
export const ata = (owner, mint, tokenProgram = PROGRAM_IDS.token) => addr([b(owner), b(tokenProgram), b(mint)], PROGRAM_IDS.ata);

/** Meteora DBC addresses (programs/dynamic-bonding-curve seeds). */
export const dbc = {
  eventAuthority: () => addr([enc.encode("__event_authority")], PROGRAM_IDS.dbc),
  pool(config, baseMint, quoteMint) {
    const x = b(baseMint), y = b(quoteMint);
    let cmp = 0;
    for (let i = 0; i < 32 && cmp === 0; i++) cmp = x[i] - y[i];
    const [hi, lo] = cmp > 0 ? [x, y] : [y, x];
    return addr([enc.encode("pool"), b(config), hi, lo], PROGRAM_IDS.dbc);
  },
  tokenVault: (mint, pool) => addr([enc.encode("token_vault"), b(mint), b(pool)], PROGRAM_IDS.dbc),
};

/** vicinity_launchpad addresses under `programId`. */
export function launchpad(programId) {
  const P = programId;
  return {
    launchpad: () => addr([enc.encode("launchpad")], P),
    launchConfig: (dbcConfig) => addr([enc.encode("launch_config"), b(dbcConfig)], P),
    approval: (cityId) => addr([enc.encode("approval"), u64le(cityId)], P),
    coin: (cityId) => addr([enc.encode("coin"), u64le(cityId)], P),
    holdersPot: (coin) => addr([enc.encode("holders_pot"), b(coin)], P),
    founderVault: (coin) => addr([enc.encode("founder_vault"), b(coin)], P),
  };
}

/** The ProgramData account of an upgradeable program (holds the upgrade authority). */
export const programDataAddress = (programId) => addr([b(programId)], PROGRAM_IDS.upgradeableLoader);
