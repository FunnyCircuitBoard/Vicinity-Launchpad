/**
 * Jupiter's /swap/v2/build answer, NOT trusted: a dependency-free port of the SDK's checkJupiterBuild (solana/sdk/launchpad/
 * jupiter.mts) for the Worker. Before anything Jupiter returned is compiled for a wallet to sign, it must do exactly what we
 * asked and nothing else:
 *   * ExactIn between the asked mints for the asked amount, a positive guaranteed output no higher than the quote, slippage
 *     at most 50 %, no tip instruction, nobody but the taker signs anywhere;
 *   * the swap instruction calls Jupiter's program with one of its two ExactIn routes (route_v2, shared_accounts_route_v2),
 *     read by position: the taker authorises it, the input leaves the taker's own account of the input mint, the output lands
 *     only in the taker's own account of the output mint, the amount in / quoted out / slippage equal the JSON, the minimum it
 *     enforces on chain is the JSON's otherAmountThreshold, the platform fee is what we configured (0) and there is no
 *     positive-slippage cut;
 *   * every setup, cleanup and other instruction is allow-listed by program, opcode and accounts: create-idempotent of the
 *     taker's own associated account of a mint on the route; a System transfer of at most the amount from the taker to the
 *     taker's WSOL account, only when paying with SOL; sync-native and close of the taker's WSOL account back to the taker.
 * A new discriminator or layout from Jupiter is refused (fail closed), never guessed at. Every refusal is an Error with a short
 * `code` for the log; the body never reaches a log or an answer.
 */
import { ADDRESSES, PROGRAM_IDS, ata } from "./sol/pda.js";
import { fromBase64, hex, readU16, readU64 } from "./sol/bytes.js";
import { base58Encode } from "./solana.js";
import { maxCuPrice, setComputeUnitLimit, setComputeUnitPrice } from "./sol/ix.js";

export const JUPITER_PROGRAM = PROGRAM_IDS.jupiter;
export const JUPITER_SWAP_DISCRIMINATORS = Object.freeze({ route_v2: "bb64facc31c4af14", shared_accounts_route_v2: "d19853937cfed8e9" });
const TOKEN_PROGRAMS = [PROGRAM_IDS.token, PROGRAM_IDS.token2022];
const refuse = (code) => { const e = new Error("jupiter_refused:" + code); e.code = code; e.refused = true; return e; };
const isAddr = (s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const u64str = (s) => typeof s === "string" && /^\d{1,20}$/.test(s);

/** A Jupiter API instruction ({ programId, accounts: [{ pubkey, isSigner, isWritable }], data: base64 }) as the kit shape. */
export function jupiterIx(i) {
  if (!i || !isAddr(i.programId) || !Array.isArray(i.accounts) || typeof i.data !== "string") throw refuse("bad_instruction");
  return { programAddress: i.programId, accounts: i.accounts.map((a) => { if (!isAddr(a.pubkey)) throw refuse("bad_account"); return { address: a.pubkey, role: (a.isSigner ? 2 : 0) | (a.isWritable ? 1 : 0) }; }), data: fromBase64(i.data) };
}
/** Jupiter's blockhash (32 bytes as numbers) and its last valid block height. */
export function jupiterBlockhash(build) {
  const m = build.blockhashWithMetadata;
  if (!m || !Array.isArray(m.blockhash) || m.blockhash.length !== 32 || !Number.isInteger(m.lastValidBlockHeight)) throw refuse("bad_blockhash");
  return { blockhash: base58Encode(Uint8Array.from(m.blockhash)), lastValidBlockHeight: m.lastValidBlockHeight };
}
/** The compute-unit price Jupiter asked for (micro-lamports), 0n when it set none. Its limit is ignored: we set our own. */
export function jupiterCuPrice(build) {
  let price = 0n;
  for (const i of build.computeBudgetInstructions || []) {
    if (i.programId !== PROGRAM_IDS.computeBudget || (i.accounts || []).length) throw refuse("compute_budget_program");
    const d = fromBase64(i.data);
    if (d[0] === 3 && d.length === 9) { const p = readU64(d, 1); if (p > price) price = p; }
    else if (!(d[0] === 2 && d.length === 5)) throw refuse("compute_budget_opcode");
  }
  return price;
}

/** The swap instruction read by position (SDK decodeJupiterSwap). */
export function decodeJupiterSwap(ix) {
  const d = fromBase64(ix.data);
  const disc = hex(d.subarray(0, 8));
  const acc = (i) => { const a = ix.accounts[i]; if (!a || !isAddr(a.pubkey)) throw refuse("swap_account_" + i); return a.pubkey; };
  const args = (o) => {
    if (d.length < o + 26) throw refuse("swap_data_short"); // the same bound as the SDK's port (jupiter.mts): the two must refuse alike
    const quoted = readU64(d, o + 8), slip = readU16(d, o + 16);
    return { inAmount: readU64(d, o), quotedOutAmount: quoted, slippageBps: slip, minOut: quoted - (quoted * BigInt(slip)) / 10_000n, platformFeeBps: readU16(d, o + 18), positiveSlippageBps: readU16(d, o + 20) };
  };
  if (disc === JUPITER_SWAP_DISCRIMINATORS.route_v2) {
    // user_transfer_authority, user_source, user_destination, source_mint, destination_mint, source_token_program,
    // destination_token_program, an optional account (the program id = none: it is where a platform fee would be paid to, so
    // with a fee it must be OUR fee account and without one it may only be the taker's own destination), event_authority, program
    const optional = acc(7);
    return { kind: "route_v2", authority: acc(0), source: acc(1), destinations: optional === JUPITER_PROGRAM ? [acc(2)] : [acc(2), optional], optional: optional === JUPITER_PROGRAM ? null : optional,
      sourceMint: acc(3), destinationMint: acc(4), sourceTokenProgram: acc(5), destinationTokenProgram: acc(6), ...args(8) };
  }
  if (disc === JUPITER_SWAP_DISCRIMINATORS.shared_accounts_route_v2) {
    // program_authority, user_transfer_authority, source, program_source, program_destination, destination, source_mint,
    // destination_mint, source_token_program, destination_token_program, event_authority, program; data: id u8 first
    return { kind: "shared_accounts_route_v2", authority: acc(1), source: acc(2), destinations: [acc(5)],
      sourceMint: acc(6), destinationMint: acc(7), sourceTokenProgram: acc(8), destinationTokenProgram: acc(9), ...args(9) };
  }
  throw refuse("unknown_swap_" + disc.slice(0, 8));
}

/**
 * Refuse everything that is not exactly the swap we asked for (see the top of the file). Resolves to the decoded swap.
 * `inAmount` is the raw amount we asked Jupiter for; `platformFeeBps` what SWAP_PLATFORM_FEE_BPS says (0 by default) and
 * `feeAccount` SWAP_FEE_ACCOUNT: with a fee on, the swap's optional account must be THAT account (nobody else is paid), and
 * only the route_v2 layout is accepted (where the fee account sits in shared_accounts_route_v2 is not known to this port:
 * such a build is refused, fail closed, until a recorded fee-on answer teaches it).
 */
export async function checkJupiterBuild(build, { taker, inputMint, outputMint, inAmount, platformFeeBps = 0, feeAccount = null, maxSlippageBps = 5000 }) {
  if (!build || typeof build !== "object") throw refuse("not_an_object");
  if (build.swapMode !== "ExactIn") throw refuse("swap_mode");
  if (build.inputMint !== inputMint) throw refuse("input_mint");
  if (build.outputMint !== outputMint) throw refuse("output_mint");
  if (!u64str(build.inAmount) || !u64str(build.outAmount) || !u64str(build.otherAmountThreshold)) throw refuse("amounts");
  const jsonIn = BigInt(build.inAmount), out = BigInt(build.outAmount), threshold = BigInt(build.otherAmountThreshold);
  if (inAmount !== undefined && jsonIn !== BigInt(inAmount)) throw refuse("in_amount");
  if (threshold <= 0n) throw refuse("zero_min_out");
  if (threshold > out) throw refuse("min_above_out");
  if (!(Number.isInteger(build.slippageBps) && build.slippageBps >= 0 && build.slippageBps <= maxSlippageBps)) throw refuse("slippage");
  if (!build.swapInstruction || build.swapInstruction.programId !== JUPITER_PROGRAM) throw refuse("swap_program");
  if (build.tipInstruction) throw refuse("tip");
  if (!Array.isArray(build.setupInstructions) || !Array.isArray(build.otherInstructions) || !Array.isArray(build.computeBudgetInstructions) || !Array.isArray(build.routePlan)) throw refuse("shape");
  const helpers = [...build.setupInstructions, ...(build.cleanupInstruction ? [build.cleanupInstruction] : []), ...build.otherInstructions];
  for (const i of [...build.computeBudgetInstructions, ...helpers, build.swapInstruction]) {
    if (!i || !Array.isArray(i.accounts)) throw refuse("bad_instruction");
    for (const a of i.accounts) if (a.isSigner && a.pubkey !== taker) throw refuse("foreign_signer");
  }
  jupiterCuPrice(build); // refuses a compute-budget instruction that is not Jupiter's price or limit
  jupiterBlockhash(build);

  // the swap, by position
  const sw = decodeJupiterSwap(build.swapInstruction);
  if (sw.authority !== taker) throw refuse("authority");
  if (sw.sourceMint !== inputMint) throw refuse("source_mint");
  if (sw.destinationMint !== outputMint) throw refuse("destination_mint");
  if (!TOKEN_PROGRAMS.includes(sw.sourceTokenProgram) || !TOKEN_PROGRAMS.includes(sw.destinationTokenProgram)) throw refuse("token_program");
  if (sw.source !== await ata(taker, inputMint, sw.sourceTokenProgram)) throw refuse("source_account");
  const outAta = await ata(taker, outputMint, sw.destinationTokenProgram);
  if (!sw.destinations.length || sw.destinations[0] !== outAta) throw refuse("destination_account");
  if (platformFeeBps > 0) {
    // a fee on: the optional account is the fee's destination and must be ours (and the layout one this port knows the fee's place in)
    if (sw.kind !== "route_v2") throw refuse("platform_fee_layout");
    if (!feeAccount || sw.optional !== feeAccount) throw refuse("platform_fee_account");
  } else if (!sw.destinations.every((d) => d === outAta)) throw refuse("destination_account");
  if (sw.inAmount !== jsonIn) throw refuse("swap_in_amount");
  if (sw.quotedOutAmount !== out) throw refuse("swap_quoted_out");
  if (sw.slippageBps !== build.slippageBps) throw refuse("swap_slippage");
  if (sw.minOut !== threshold) throw refuse("swap_min_out");
  if (sw.platformFeeBps !== platformFeeBps) throw refuse("platform_fee");
  if (sw.positiveSlippageBps !== 0) throw refuse("positive_slippage");

  // every helper, by opcode and accounts
  const wsolAta = await ata(taker, ADDRESSES.wsol);
  const routeMints = new Set([inputMint, outputMint]);
  for (const r of build.routePlan) { const s = r && r.swapInfo; if (!s || !isAddr(s.inputMint) || !isAddr(s.outputMint)) throw refuse("route_plan"); routeMints.add(s.inputMint); routeMints.add(s.outputMint); }
  for (const i of helpers) {
    const d = fromBase64(i.data), a = (k) => i.accounts[k] && i.accounts[k].pubkey;
    if (i.programId === PROGRAM_IDS.ata) {
      // CreateIdempotent: funder, account, owner, mint, system program, token program
      if (!(d.length === 1 && d[0] === 1) || i.accounts.length !== 6) throw refuse("ata_opcode");
      if (a(0) !== taker || a(2) !== taker) throw refuse("ata_owner");
      if (a(4) !== PROGRAM_IDS.system || !TOKEN_PROGRAMS.includes(a(5))) throw refuse("ata_programs");
      if (!routeMints.has(a(3))) throw refuse("ata_mint");
      if (a(1) !== await ata(taker, a(3), a(5))) throw refuse("ata_account");
    } else if (i.programId === PROGRAM_IDS.system) {
      // Transfer: u32 2, u64 lamports; only to wrap the SOL being paid
      if (!(d.length === 12 && d[0] === 2 && d[1] === 0 && d[2] === 0 && d[3] === 0) || i.accounts.length !== 2) throw refuse("system_opcode");
      if (inputMint !== ADDRESSES.wsol) throw refuse("sol_transfer_without_sol");
      if (a(0) !== taker || a(1) !== wsolAta) throw refuse("sol_transfer_destination");
      if (readU64(d, 4) > jsonIn) throw refuse("sol_transfer_amount");
    } else if (i.programId === PROGRAM_IDS.token) {
      if (d.length === 1 && d[0] === 17) { if (i.accounts.length !== 1 || a(0) !== wsolAta) throw refuse("sync_native_account"); }
      else if (d.length === 1 && d[0] === 9) { if (i.accounts.length !== 3 || a(0) !== wsolAta || a(1) !== taker || a(2) !== taker) throw refuse("close_account"); }
      else throw refuse("token_opcode");
    } else throw refuse("helper_program");
  }
  return sw;
}

/**
 * The instruction list of a checked build: our compute budget (limit from the simulation, Jupiter's price capped so the
 * priority fee never passes `maxPriorityFee` lamports), then Jupiter's setup, swap, cleanup and other instructions as given.
 */
export function composeJupiter(build, { cuLimit, maxPriorityFee = 10_000_000n }) {
  const asked = jupiterCuPrice(build), cap = maxCuPrice(cuLimit, maxPriorityFee);
  const price = asked < cap ? asked : cap;
  const ixs = [setComputeUnitLimit(cuLimit)];
  if (price > 0n) ixs.push(setComputeUnitPrice(price));
  ixs.push(...build.setupInstructions.map(jupiterIx), jupiterIx(build.swapInstruction));
  if (build.cleanupInstruction) ixs.push(jupiterIx(build.cleanupInstruction));
  ixs.push(...build.otherInstructions.map(jupiterIx));
  return { instructions: ixs, cuPrice: price };
}
/** The lookup tables a build names: [{ key, addresses }] (what Jupiter claims; the Worker checks them on chain before compiling). */
export function claimedLookupTables(build) {
  const t = build.addressesByLookupTableAddress;
  if (t == null) return [];
  if (typeof t !== "object" || Array.isArray(t)) throw refuse("lookup_tables");
  return Object.entries(t).map(([key, addresses]) => {
    if (!isAddr(key) || !Array.isArray(addresses) || addresses.length > 256 || !addresses.every(isAddr)) throw refuse("lookup_table_" + key.slice(0, 4));
    return { key, addresses };
  });
}
