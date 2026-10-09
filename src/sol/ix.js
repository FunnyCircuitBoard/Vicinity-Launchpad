/**
 * The handful of instructions the Worker builds for a curve trade, byte-identical to the SDK's builders (checked in
 * solana/tests-launchpad/15-worker-builder.test.mjs): Meteora DBC swap2, the associated-token "create idempotent", a System
 * transfer, SPL Token sync-native and close (wrap and unwrap SOL), and the two compute-budget instructions. Every function is
 * async because the token accounts and PDAs it names come from WebCrypto (src/sol/pda.js). Shape: @solana/kit-like
 * { programAddress, accounts: [{ address, role }], data } with role 0 read-only, 1 writable, 2 read-only signer, 3 both.
 */
import { ADDRESSES, PROGRAM_IDS, ata, dbc } from "./pda.js";
import { concat, u32le, u64le } from "./bytes.js";

export const Role = Object.freeze({ R: 0, W: 1, RS: 2, WS: 3 });
/** DBC swap2 modes (the IDL's SwapMode): exact in, partial fill (exact in that stops at the graduation price), exact out. */
export const SwapMode = Object.freeze({ ExactIn: 0, PartialFill: 1, ExactOut: 2 });
/** sha256("global:swap2")[..8], as in the DBC IDL. */
export const SWAP2_DISCRIMINATOR = Uint8Array.from([65, 75, 63, 76, 235, 91, 91, 136]);
/** Compute limits the SDK measured for a curve trade (LAUNCHPAD-AUDIT.md 5.1), with headroom. */
export const CU = Object.freeze({ swap: 120_000 });
/** The most priority fee a transaction built here may carry: 0.01 SOL. */
export const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n;

export const setComputeUnitLimit = (units) => ({ programAddress: PROGRAM_IDS.computeBudget, accounts: [], data: concat([Uint8Array.of(2), u32le(units)]) });
export const setComputeUnitPrice = (microLamports) => ({ programAddress: PROGRAM_IDS.computeBudget, accounts: [], data: concat([Uint8Array.of(3), u64le(microLamports)]) });
/** What a priority fee costs in lamports: price (micro-lamports per unit) × limit, rounded up. */
export const priorityFeeLamports = (microLamportsPerCu, cuLimit) => (BigInt(microLamportsPerCu) * BigInt(cuLimit) + 999_999n) / 1_000_000n;
/** The highest compute-unit price that keeps the priority fee within `maxFee` at `cuLimit`. */
export const maxCuPrice = (cuLimit, maxFee = MAX_PRIORITY_FEE_LAMPORTS) => (BigInt(maxFee) * 1_000_000n) / BigInt(Math.max(1, cuLimit));

export const systemTransfer = (from, to, lamports) => ({
  programAddress: PROGRAM_IDS.system,
  accounts: [{ address: from, role: Role.WS }, { address: to, role: Role.W }],
  data: concat([u32le(2), u64le(lamports)]),
});
export const syncNative = (account) => ({ programAddress: PROGRAM_IDS.token, accounts: [{ address: account, role: Role.W }], data: Uint8Array.of(17) });
export const closeTokenAccount = (account, destination, owner) => ({
  programAddress: PROGRAM_IDS.token,
  accounts: [{ address: account, role: Role.W }, { address: destination, role: Role.W }, { address: owner, role: Role.RS }],
  data: Uint8Array.of(9),
});
/** Associated-token "create idempotent": makes owner's account for mint if missing, else nothing. */
export async function createAtaIdempotent({ payer, owner, mint, tokenProgram = PROGRAM_IDS.token }) {
  return {
    programAddress: PROGRAM_IDS.ata,
    accounts: [
      { address: payer, role: Role.WS }, { address: await ata(owner, mint, tokenProgram), role: Role.W },
      { address: owner, role: Role.R }, { address: mint, role: Role.R },
      { address: PROGRAM_IDS.system, role: Role.R }, { address: tokenProgram, role: Role.R },
    ],
    data: Uint8Array.of(1),
  };
}
/** Wrap `lamports` of the trader's SOL into their WSOL account (created if missing): three instructions. */
export async function wrapSol(owner, lamports) {
  const w = await ata(owner, ADDRESSES.wsol);
  return [await createAtaIdempotent({ payer: owner, owner, mint: ADDRESSES.wsol }), systemTransfer(owner, w, lamports), syncNative(w)];
}
/** Close the trader's WSOL account: everything in it comes back as plain SOL. */
export const unwrapSol = async (owner) => closeTokenAccount(await ata(owner, ADDRESSES.wsol), owner, owner);

/**
 * Meteora DBC swap2. side 'buy' pays quote for coins, 'sell' pays coins for quote. mode (SwapMode): exact in and partial fill
 * take amount0 = in, amount1 = least out; exact out takes amount0 = out, amount1 = most in. `referral` = the dev wallet's
 * quote-token account on vicinity.city trades (optional: the program id, read-only, when absent, which is Anchor's "None").
 * The 15 accounts are in the IDL's order.
 */
export async function swap2({ trader, pool, config, baseMint, quoteMint, side, mode = SwapMode.ExactIn, amount0, amount1, referral = null, tokenBaseProgram = PROGRAM_IDS.token, tokenQuoteProgram = PROGRAM_IDS.token }) {
  const buy = side === "buy";
  const [input, output, baseVault, quoteVault, eventAuthority] = await Promise.all([
    ata(trader, buy ? quoteMint : baseMint, buy ? tokenQuoteProgram : tokenBaseProgram),
    ata(trader, buy ? baseMint : quoteMint, buy ? tokenBaseProgram : tokenQuoteProgram),
    dbc.tokenVault(baseMint, pool), dbc.tokenVault(quoteMint, pool), dbc.eventAuthority(),
  ]);
  if (!(mode === 0 || mode === 1 || mode === 2)) throw new Error("bad_swap_mode");
  return {
    programAddress: PROGRAM_IDS.dbc,
    accounts: [
      { address: ADDRESSES.dbcPoolAuthority, role: Role.R }, { address: config, role: Role.R }, { address: pool, role: Role.W },
      { address: input, role: Role.W }, { address: output, role: Role.W }, { address: baseVault, role: Role.W }, { address: quoteVault, role: Role.W },
      { address: baseMint, role: Role.R }, { address: quoteMint, role: Role.R }, { address: trader, role: Role.RS },
      { address: tokenBaseProgram, role: Role.R }, { address: tokenQuoteProgram, role: Role.R },
      referral ? { address: referral, role: Role.W } : { address: PROGRAM_IDS.dbc, role: Role.R },
      { address: eventAuthority, role: Role.R }, { address: PROGRAM_IDS.dbc, role: Role.R },
    ],
    data: concat([SWAP2_DISCRIMINATOR, u64le(amount0), u64le(amount1), Uint8Array.of(mode)]),
  };
}
