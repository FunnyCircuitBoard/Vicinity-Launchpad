/**
 * The instructions of the founder's "Launch your city coin" and of "Move to the open market" (src/lplaunch.js), built in the Worker
 * without anchor or web3.js: our program's `launch` (the founder creates the city's coin through Meteora DBC, the Coin record as
 * its creator) with an optional first buy (the curve-trade instructions of src/sol/ix.js), our `claim_founder_fees`, and Meteora
 * DBC's permissionless graduation (`migration_damm_v2` into the coin's DAMM v2 pool) and `withdraw_leftover` (the unsold coins go
 * to the dev wallet, the config's leftover receiver). Every builder is async (PDAs through WebCrypto) and returns
 * { programAddress, accounts: [{ address, role }], data } with role 0 read-only, 1 writable, 2 read-only signer, 3 writable signer,
 * in the account order of the IDLs. The discriminators are the IDLs' own (sha256("global:<name>")[..8]); test/lplaunch.test.js
 * checks them against the IDL files and solana/tests-launchpad/18 checks every builder against the SDK's anchor-built instruction
 * and runs what the routes build against the real programs in litesvm.
 * Our program id comes from the settings (src/cluster.js lpSetup), never from here.
 */
import { concat, u64le } from "./bytes.js";
import { ADDRESSES, PROGRAM_IDS, ata, dbc, launchpad as launchpadPdas } from "./pda.js";
import { metadataAddress, METAPLEX_PROGRAM } from "./metaplex.js";
import { damm } from "./lpadmin-ix.js";
import { SwapMode, createAtaIdempotent, swap2, unwrapSol, wrapSol } from "./ix.js";

export const Role = Object.freeze({ R: 0, W: 1, RS: 2, WS: 3 });
const meta = (address, role) => ({ address, role });
const U64_MAX = (1n << 64n) - 1n;

/** sha256("global:<name>")[..8] of every instruction built here, as in the IDLs (test/lplaunch.test.js checks them). */
export const DISCRIMINATORS = Object.freeze({
  launch: [153, 241, 93, 225, 22, 69, 74, 61],
  claim_founder_fees: [12, 232, 155, 24, 29, 218, 112, 189],
  migration_damm_v2: [156, 169, 230, 103, 53, 228, 80, 64],
  withdraw_leftover: [20, 198, 202, 237, 235, 243, 183, 66],
});
const disc = (name) => Uint8Array.from(DISCRIMINATORS[name]);

/** Compute limits the SDK measured (solana/sdk/launchpad/trade.mts CU, LAUNCHPAD-AUDIT.md 5.1), with headroom. */
export const CU = Object.freeze({ launch: 300_000, launchWithBuy: 400_000, graduate: 400_000, leftover: 80_000 });

/* ---------------------------------------------------------------- launch */
/** Every account `launch` needs, for a coin whose fresh mint (a one-time key made in the founder's browser) is `baseMint`. */
export async function launchAccounts({ programId, cityId, baseMint, dbcConfig, quoteMint }) {
  const L = launchpadPdas(programId);
  const coin = await L.coin(cityId);
  const pool = await dbc.pool(dbcConfig, baseMint, quoteMint);
  const [holdersPot, founderVault, baseVault, quoteVault, metadata, launchpad, approval, launchConfig, eventAuthority] = await Promise.all([
    L.holdersPot(coin), L.founderVault(coin), dbc.tokenVault(baseMint, pool), dbc.tokenVault(quoteMint, pool), metadataAddress(baseMint),
    L.launchpad(), L.approval(cityId), L.launchConfig(dbcConfig), dbc.eventAuthority(),
  ]);
  return { coin, pool, holdersPot, founderVault, baseVault, quoteVault, metadata, launchpad, approval, launchConfig, eventAuthority };
}
/**
 * vicinity_launchpad `launch`: the approved founder signs (and pays every rent and the launch fee), the new mint signs (a one-time
 * key); the approval closes and its rent goes back to `rentPayer` (the approval's rent_payer, the admin who approved).
 */
export async function launch({ programId, founder, payer = founder, baseMint, cityId, dbcConfig, quoteMint, rentPayer }) {
  const a = await launchAccounts({ programId, cityId, baseMint, dbcConfig, quoteMint });
  return {
    programAddress: programId,
    accounts: [
      meta(founder, Role.RS), meta(payer, Role.WS), meta(baseMint, Role.WS), meta(a.launchpad, Role.R), meta(a.approval, Role.W), meta(rentPayer, Role.W),
      meta(a.launchConfig, Role.R), meta(a.coin, Role.W), meta(a.holdersPot, Role.W), meta(a.founderVault, Role.W), meta(dbcConfig, Role.R),
      meta(ADDRESSES.dbcPoolAuthority, Role.R), meta(a.pool, Role.W), meta(a.baseVault, Role.W), meta(a.quoteVault, Role.W), meta(a.metadata, Role.W),
      meta(METAPLEX_PROGRAM, Role.R), meta(quoteMint, Role.R), meta(a.eventAuthority, Role.R), meta(PROGRAM_IDS.dbc, Role.R), meta(PROGRAM_IDS.token, Role.R),
      meta(PROGRAM_IDS.system, Role.R),
    ],
    data: concat([disc("launch"), u64le(cityId)]),
  };
}
/**
 * The founder's first buy right after the launch, in the same transaction: exactly the SDK's buildBuy (and the site's curve trade,
 * src/lptrade.js): the dev wallet's referral account (idempotent), wrap the SOL, the founder's coin account, DBC swap2 partial
 * fill (below the graduation price it is an exact-in buy), unwrap what is left. SOL-paired coins only.
 */
export async function firstBuy({ founder, mint, pool, dbcConfig, quoteMint = ADDRESSES.wsol, amountIn, minOut }) {
  if (quoteMint !== ADDRESSES.wsol) throw new Error("first_buy_sol_only");
  if (BigInt(amountIn) <= 0n || BigInt(minOut) <= 0n) throw new Error("bad_first_buy");
  const referral = await ata(ADDRESSES.feeRecipient, quoteMint);
  return [
    await createAtaIdempotent({ payer: founder, owner: ADDRESSES.feeRecipient, mint: quoteMint }),
    ...(await wrapSol(founder, BigInt(amountIn))),
    await createAtaIdempotent({ payer: founder, owner: founder, mint }),
    await swap2({ trader: founder, pool, config: dbcConfig, baseMint: mint, quoteMint, side: "buy", mode: SwapMode.PartialFill, amount0: BigInt(amountIn), amount1: BigInt(minOut), referral }),
    await unwrapSol(founder),
  ];
}

/* ---------------------------------------------------------------- the founder's fees */
/** vicinity_launchpad `claim_founder_fees`: the founder takes the whole founder vault into their own token account for the quote token. */
export async function claimFounderFees({ programId, founder, coin }) {
  const L = launchpadPdas(programId);
  const c = await L.coin(coin.cityId);
  return {
    programAddress: programId,
    accounts: [
      meta(founder, Role.WS), meta(c, Role.W), meta(await L.founderVault(c), Role.W), meta(coin.quoteMint, Role.R), meta(await ata(founder, coin.quoteMint), Role.W),
      meta(PROGRAM_IDS.token, Role.R), meta(PROGRAM_IDS.ata, Role.R), meta(PROGRAM_IDS.system, Role.R),
    ],
    data: concat([disc("claim_founder_fees"), u64le(coin.cityId)]),
  };
}

/* ---------------------------------------------------------------- graduation (Meteora DBC, permissionless) */
/** The DAMM v2 accounts a graduation creates: the coin's pool (customizable config, coin, quote token) and two positions. */
export async function migrationAccounts({ coinMint, quoteMint, firstNftMint, secondNftMint, dammConfig = ADDRESSES.dammCustomizableConfig }) {
  const pool = await damm.pool(dammConfig, coinMint, quoteMint);
  const [firstPosition, firstNftAccount, secondPosition, secondNftAccount, tokenAVault, tokenBVault] = await Promise.all([
    damm.position(firstNftMint), damm.positionNftAccount(firstNftMint), damm.position(secondNftMint), damm.positionNftAccount(secondNftMint),
    damm.tokenVault(coinMint, pool), damm.tokenVault(quoteMint, pool),
  ]);
  return { pool, firstPosition, firstNftAccount, secondPosition, secondNftAccount, tokenAVault, tokenBVault };
}
/**
 * Meteora DBC `migration_damm_v2`: the full curve moves into the coin's DAMM v2 pool with locked liquidity. Anyone pays (about 0.03
 * SOL of rent); the two position-NFT mints are one-time keys made in the payer's browser (they hold no power afterwards: the
 * positions belong to the coin's creator and the partner). No migration metadata (the program id = Anchor's "None"); the DAMM v2
 * config goes last, as a remaining account.
 */
export async function migrateToDammV2({ payer, dbcPool, dbcConfig, coinMint, quoteMint, firstNftMint, secondNftMint, dammConfig = ADDRESSES.dammCustomizableConfig }) {
  const m = await migrationAccounts({ coinMint, quoteMint, firstNftMint, secondNftMint, dammConfig });
  const [baseVault, quoteVault, dammEvents] = await Promise.all([dbc.tokenVault(coinMint, dbcPool), dbc.tokenVault(quoteMint, dbcPool), damm.eventAuthority()]);
  return {
    programAddress: PROGRAM_IDS.dbc,
    accounts: [
      meta(dbcPool, Role.W), meta(PROGRAM_IDS.dbc, Role.R), meta(dbcConfig, Role.R), meta(ADDRESSES.dbcPoolAuthority, Role.W), meta(m.pool, Role.W),
      meta(firstNftMint, Role.WS), meta(m.firstNftAccount, Role.W), meta(m.firstPosition, Role.W),
      meta(secondNftMint, Role.WS), meta(m.secondNftAccount, Role.W), meta(m.secondPosition, Role.W),
      meta(ADDRESSES.dammPoolAuthority, Role.R), meta(PROGRAM_IDS.damm, Role.R), meta(coinMint, Role.W), meta(quoteMint, Role.W),
      meta(m.tokenAVault, Role.W), meta(m.tokenBVault, Role.W), meta(baseVault, Role.W), meta(quoteVault, Role.W), meta(payer, Role.WS),
      meta(PROGRAM_IDS.token, Role.R), meta(PROGRAM_IDS.token, Role.R), meta(PROGRAM_IDS.token2022, Role.R), meta(dammEvents, Role.R), meta(PROGRAM_IDS.system, Role.R),
      meta(dammConfig, Role.R),
    ],
    data: disc("migration_damm_v2"),
  };
}
/** Meteora DBC `withdraw_leftover` after graduation: the coins the curve never sold go to the config's leftover receiver (the dev wallet). */
export async function withdrawLeftover({ dbcPool, dbcConfig, coinMint, receiverAccount, leftoverReceiver = ADDRESSES.feeRecipient }) {
  return {
    programAddress: PROGRAM_IDS.dbc,
    accounts: [
      meta(ADDRESSES.dbcPoolAuthority, Role.R), meta(dbcConfig, Role.R), meta(dbcPool, Role.W), meta(receiverAccount, Role.W),
      meta(await dbc.tokenVault(coinMint, dbcPool), Role.W), meta(coinMint, Role.R), meta(leftoverReceiver, Role.R), meta(PROGRAM_IDS.token, Role.R),
      meta(await dbc.eventAuthority(), Role.R), meta(PROGRAM_IDS.dbc, Role.R),
    ],
    data: disc("withdraw_leftover"),
  };
}
/** The leftover transaction: the dev wallet's coin account (idempotent, the payer pays its rent once), then withdraw_leftover. */
export async function leftoverInstructions({ payer, coin }) {
  const receiverAccount = await ata(ADDRESSES.feeRecipient, coin.mint);
  return [
    await createAtaIdempotent({ payer, owner: ADDRESSES.feeRecipient, mint: coin.mint }),
    await withdrawLeftover({ dbcPool: coin.dbcPool, dbcConfig: coin.dbcConfig, coinMint: coin.mint, receiverAccount }),
  ];
}

/** A city id as the program's u64 (a positive integer below 2^64), or null. */
export const cityIdOf = (v) => ((typeof v === "string" || typeof v === "number") && /^\d{1,20}$/.test(String(v)) && BigInt(v) > 0n && BigInt(v) < U64_MAX ? BigInt(v) : null);
