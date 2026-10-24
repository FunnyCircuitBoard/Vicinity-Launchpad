/**
 * Send from the Wallet tab (only while WALLET_SEND=on, src/flags.js walletSendOn): SOL, $VICINITY or a launched city coin from the
 * person's LINKED wallet to an address they type. The Worker holds no key and signs nothing: it checks, builds an UNSIGNED transaction
 * and issues the relay ticket (src/relay.js issueTicket); the person's own wallet signs it and either sends it itself or hands the
 * signed bytes to the relay. Nothing is written to the database but the attempt counters.
 *   POST /api/wallet/send/build  { to, asset: "SOL" | <mint>, amount: "<whole units>" }, or { to, asset, all: true } for everything
 *                                signed in, a linked wallet, this site's Origin; counted before any work, the connection first
 *                                (src/guards.js PUBLIC_LIMITS wallet_send_build, 20 a minute), then the account (SEND_LIMIT, 30 an
 *                                hour). The page's live check, made by itself while the person types, calls with ?live=1 and is
 *                                counted apart (wallet_send_build_live, 60 a minute per connection; LIVE_LIMIT, 60 an hour per
 *                                account), so what a page checks on its own never uses up the builds a Review or Max tap needs
 *                                -> { ok, tx (base64, UNSIGNED), ticket, blockhash, lastValidBlockHeight, chain, cluster, taker, version,
 *                                     amount, amountRaw, fees, summary } — the page shows `summary` as it is, every number from here
 *   POST /api/wallet/send/relay  = src/relay.js handleSend (the ticket proves this Worker built these bytes; the node's preflight error
 *                                in plain words; never an open sendTransaction proxy)
 *   GET  /api/wallet/send/status = src/relay.js handleStatus
 * The checks, in this order. The asset: SOL, the live $VICINITY mint or a launched city coin (src/portfolio.js mintsFor), and on the
 * chain a classic SPL Token mint (a Token-2022 mint is refused: its extensions could change what arrives). The destination: a base58
 * key, not the sender, on the ed25519 curve (a PDA is a program's address, never a person's: src/sol/oncurve.js), not a known pool,
 * program, lock or mint; then as the chain sees it: an account that does not exist is an address nobody has used yet (allowed, and said
 * on the confirm screen in so many words: that is how a mistyped address usually looks), an account that exists must be a plain System
 * account with no data (a mint, a token account, a program or any program-owned account is refused). Each account is read as its first
 * 166 bytes (DATA_SLICE): a mint is 82 bytes, a token account 165, and byte 165 of a Token-2022 account says which of the two it is;
 * nothing here looks further, so an address with megabytes of data costs the same read as any other. The amount: a decimal string
 * within the mint's decimals, no more than the balance read live from the sender's associated token account (the account this page
 * sends from, said so when it holds less than the person expects; one frozen by the issuer is refused by name). SOL follows the
 * network's rent rule: after the amount and the fee the sender keeps either nothing at all (an explicit `all`) or at least the
 * rent-exempt minimum of a wallet (890,880 lamports); anything in between is refused here, with plain words, because the network would
 * refuse it too; and a recipient below that minimum (no account yet, or an old rent-paying one) must be brought to at least it. A
 * recipient's missing token account is created in the same transaction, paid by the sender (2,039,280 lamports, less any SOL already
 * sitting at that address; said in the summary). The compute budget rides along as on every transaction built here (a priority fee
 * from LAUNCHPAD_CU_PRICE: a transaction without one is rewritten by some wallets, and rewritten bytes have no ticket).
 */
import { json, readJson } from "./http.js";
import { access } from "./access.js";
import { keyLimit, publicLimit } from "./guards.js";
import { knownProgramAccount, rpc } from "./chain.js";
import { base58Decode, base58Encode, isSolanaAddress } from "./solana.js";
import { isOnCurve } from "./sol/oncurve.js";
import { ADDRESSES, PROGRAM_IDS, ata } from "./sol/pda.js";
import { createAtaIdempotent, maxCuPrice, priorityFeeLamports, setComputeUnitLimit, setComputeUnitPrice, systemTransfer, transferChecked } from "./sol/ix.js";
import { MAX_TX_BYTES, compileLegacy, decodeHeader, wrapUnsigned } from "./sol/message.js";
import { fromBase64, readU64, toBase64 } from "./sol/bytes.js";
import { formatAmount, parseAmount } from "./sol/input.js";
import { issueTicket, simulate, simulationError } from "./relay.js";
import { mintsFor } from "./portfolio.js";
import { OFFICIAL } from "./official.js";
import { mainTokenV5 } from "./v5policy.js";
import { launchpadCluster, lpSetup } from "./cluster.js";
import { codeOf } from "./sources.js";

export const SOL = "SOL";
/** The rent-exempt minimum of an empty account (a wallet): (128 + 0 bytes) × 6,960 lamports per byte-year × 2 years. */
export const RENT_MIN_LAMPORTS = 890_880n;
/** The rent-exempt minimum of a token account (165 bytes): (128 + 165) × 6,960 × 2. */
export const RENT_ATA_LAMPORTS = 2_039_280n;
/** The network fee of one signature. */
export const NETWORK_FEE_LAMPORTS = 5_000n;
/** Compute-unit limits, measured against the real programs (solana/tests-launchpad/19-wallet-send.test.mjs) with room to spare. */
export const CU = Object.freeze({ sol: 10_000, token: 30_000, tokenWithAccount: 60_000 });
/** Micro-lamports per compute unit when LAUNCHPAD_CU_PRICE is not set (the live setting is 100000: at these limits 1,000 to 6,000 lamports, under 0.00001 SOL). */
export const DEFAULT_CU_PRICE = 100_000n;
/** Builds per account per hour: the taps (Review, Max, the refresh of the details on the confirm screen). */
export const SEND_LIMIT = { max: 30, windowMs: 60 * 60_000 };
/** The page's own live checks (?live=1) per account per hour, counted apart so typing never uses up a tap. */
export const LIVE_LIMIT = { max: 60, windowMs: 60 * 60_000 };
/** How much of each account is read: a mint (82 bytes), a token account (165) and Token-2022's type byte at 165 all fit; nothing here reads further. */
export const DATA_SLICE = 166;
export const NOTICE = "A send cannot be undone.";
/** On the confirm screen when the recipient has no account on the chain: the usual look of a mistyped address. */
export const FRESH_LINE = "This address has not been used on Solana before. Check it twice.";
const noStore = { "Cache-Control": "no-store" };
const SYSTEM = PROGRAM_IDS.system, TOKEN = PROGRAM_IDS.token, TOKEN_2022 = PROGRAM_IDS.token2022;
/** The loaders that own every program's account (a node that does not report `executable` still names the owner). */
const LOADERS = new Set([PROGRAM_IDS.upgradeableLoader, "BPFLoader2111111111111111111111111111111111", "BPFLoader1111111111111111111111111111111111", "NativeLoader1111111111111111111111111111111", "LoaderV411111111111111111111111111111111111"]);

/* ---------------------------------------------------------------- words and numbers */
/** "25,000.5": the exact amount (src/sol/input.js formatAmount), the whole part grouped. */
export const pretty = (raw, decimals) => { const s = formatAmount(raw, decimals); const [w, f] = s.split("."); return `${BigInt(w).toLocaleString("en-US")}${f ? `.${f}` : ""}`; };
/** Lamports as SOL in about three figures ("0.000005", "0.00204"): for a fee or a rent, never for an amount. */
export const solText = (lamports) => (Number(lamports) / 1e9).toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });
const REASONS = {
  pda: "This address belongs to a program, not to a person. Check the address.",
  program: "This is a program's address, not a wallet.",
  pool: "This is a pool or program account, not a wallet.",
  team_lock: "This is the team lock's address, not a wallet.",
  mint: "This is a token's contract address, not a wallet.",
  token_account: "This is a token account, not a wallet. Send to its owner's wallet address instead.",
  program_owned: "This account is controlled by a program, not by a person.",
  system_data: "This account is not a plain wallet.",
};
const refuse = (error, status, extra = {}) => ({ ok: false, error, status, ...extra });

/* ---------------------------------------------------------------- what the chain says, decoded */
/** One getMultipleAccounts entry as { owner, lamports, executable, data (bytes) }; null for an account that does not exist. */
export function accountOf(v) {
  if (!v || typeof v !== "object") return null;
  let data = new Uint8Array(0);
  const d = v.data;
  try {
    if (Array.isArray(d) && typeof d[0] === "string") data = fromBase64(d[0]);
    else if (typeof d === "string") data = fromBase64(d);
    else if (d instanceof Uint8Array) data = d;
  } catch { data = new Uint8Array(0); }
  let lamports = 0n;
  try { lamports = BigInt(v.lamports ?? 0); } catch { lamports = 0n; }
  return { owner: String(v.owner || ""), lamports, executable: Boolean(v.executable), data };
}
/** A classic SPL Token mint's decimals, or null (not a mint, not initialised, another program's mint). */
export function mintOf(acc) {
  if (!acc || acc.owner !== TOKEN || acc.data.length < 82 || acc.data[45] !== 1) return null;
  return { decimals: acc.data[44] };
}
/** A token account's mint, owner, raw amount and whether the issuer froze it (state byte 2), or null (not one, or not initialised). */
export function tokenAccountOf(acc) {
  if (!acc || (acc.owner !== TOKEN && acc.owner !== TOKEN_2022) || acc.data.length < 165 || (acc.data[108] !== 1 && acc.data[108] !== 2)) return null;
  return { mint: base58Encode(acc.data.subarray(0, 32)), owner: base58Encode(acc.data.subarray(32, 64)), amount: readU64(acc.data, 64), frozen: acc.data[108] === 2 };
}
/** A Token program account's bytes say which it is: a mint is 82 bytes; with Token-2022 extensions both kinds are 165 bytes plus a type byte at 165 (1 = mint). */
const isMintData = (data) => data.length === 82 || (data.length > 165 && data[165] === 1);

/**
 * Why `to` is not a person's wallet: { error: "bad_address" | "same_wallet" | "not_a_wallet", reason?, message }, or null when it may be
 * one. The static checks cost nothing (the sender, the curve, the known pools, programs, locks and mints); with `account` (the
 * destination as the chain read it, null = no account) the chain's own facts are checked too.
 */
export function destinationProblem(to, sender, env = {}, { account = undefined, mints = [] } = {}) {
  if (!isSolanaAddress(to)) return { error: "bad_address", message: "That is not a Solana address." };
  if (to === sender) return { error: "same_wallet", message: "That is your own wallet address." };
  let bytes;
  try { bytes = base58Decode(to); } catch { bytes = null; }
  if (!bytes || bytes.length !== 32) return { error: "bad_address", message: "That is not a Solana address." };
  const not = (reason) => ({ error: "not_a_wallet", reason, message: REASONS[reason] });
  // the named lists first (a lock or a pool authority is a PDA too: its own name says more than "a program's address")
  if (Object.values(PROGRAM_IDS).includes(to)) return not("program");
  const lc = launchpadCluster(env), lp = lpSetup(env);
  if ([lc.programId, lc.lookupTable, lp.programId, lp.rewardsProgramId, ...lc.dbcConfigs, ...lp.dbcConfigs].filter(Boolean).includes(to)) return not("program");
  if ([ADDRESSES.dbcPoolAuthority, ADDRESSES.dammPoolAuthority, ADDRESSES.dammCustomizableConfig].includes(to) || knownProgramAccount(to)) return not("pool");
  if ((OFFICIAL.teamLocks || []).some((l) => l.address === to)) return not("team_lock");
  if (to === ADDRESSES.wsol || mints.includes(to)) return not("mint");
  if (!isOnCurve(bytes)) return not("pda");
  if (account) {
    if (account.executable || LOADERS.has(account.owner)) return not("program");
    if (account.owner === TOKEN || account.owner === TOKEN_2022) return not(isMintData(account.data) ? "mint" : "token_account");
    if (account.owner !== SYSTEM) return not("program_owned");
    if (account.data.length > 0) return not("system_data");
  }
  return null;
}

/* ---------------------------------------------------------------- the supported assets */
/**
 * What can be sent: SOL, then the live $VICINITY mint and every launched city coin (src/portfolio.js mintsFor), each
 * { id, mint, kind, symbol, name, label, tickerSource, city }. The label follows the Wallet tab's rule: "$VICINITY", a city coin's
 * ticker from the chain or the city list with its "$", a coin with neither by its name (nothing here makes a ticker up). Decimals
 * are read from the chain when a send is built (null here). Throws when the database cannot be read.
 */
export async function supportedAssets(env, now = Date.now()) {
  const list = await mintsFor(env, { now });
  return [
    { id: SOL, mint: null, kind: "sol", symbol: "SOL", name: "Solana", label: "SOL", decimals: 9, tickerSource: null, city: null },
    ...list.map((m) => ({
      id: m.mint, mint: m.mint, kind: m.kind, symbol: m.symbol, name: m.name, decimals: null, tickerSource: m.tickerSource || null, city: m.city || null,
      label: m.kind === "vicinity" ? (mainTokenV5(env) ? m.name : "$VICINITY") : m.kind === "legacy" ? "$VICINITY (legacy)" : m.tickerSource ? `$${String(m.symbol).replace(/^\$/, "")}` : m.name || "city coin",
    })),
  ];
}
/** The priority fee's price: the LAUNCHPAD_CU_PRICE setting (micro-lamports per unit; the city-coin transactions' too), else the default. */
export const cuPriceOf = (env) => (/^\d{1,12}$/.test(String((env && env.LAUNCHPAD_CU_PRICE) ?? "")) ? BigInt(env.LAUNCHPAD_CU_PRICE) : DEFAULT_CU_PRICE);

/* ---------------------------------------------------------------- the plan: pure, from what the chain said */
/**
 * One send, planned from the accounts as the chain read them. No network here (solana/tests-launchpad/19-wallet-send.test.mjs runs
 * the result against the real programs).
 *   sender, to     base58 addresses
 *   asset          { id: "SOL", label, decimals: 9 } or { id: mint, mint, label, symbol, name, decimals }
 *   amount         a whole-units string ("0.25"); with `all` true the amount is everything the wallet holds of the asset
 *   chain          { sender, to, mint, senderAta, toAta }: accountOf() of each (the first DATA_SLICE bytes are enough), null when the account does not exist
 *   addresses      { senderAta, toAta } for a token (the associated token accounts)
 *   cuPrice        micro-lamports per compute unit (BigInt; capped so the priority fee stays under src/sol/ix.js MAX_PRIORITY_FEE_LAMPORTS)
 * Returns { ok: true, instructions, amountRaw, cuLimit, cuPrice, fee, rent, remaining, remainingSol, summary } or
 * { ok: false, error, status, message, ... } with the plain words the page shows.
 */
export async function planSend({ sender, to, asset, amount = null, all = false, chain, addresses = {}, cuPrice = DEFAULT_CU_PRICE }) {
  const isSol = asset.id === SOL;
  const decimals = isSol ? 9 : asset.decimals;
  const label = asset.label || (isSol ? "SOL" : asset.symbol || "tokens");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return refuse("unsupported_asset", 400, { reason: "decimals", message: "This token's decimals could not be read." });
  const sol = chain.sender ? chain.sender.lamports : 0n;
  let raw = null;
  if (!all) {
    const p = parseAmount(amount, decimals);
    if (!p) return refuse("bad_amount", 400, { message: "Type an amount above zero, with a point for decimals (like 0.5)." });
    if (p.tooPrecise) return refuse("too_many_decimals", 400, { decimals, message: `${label} has ${decimals} decimal${decimals === 1 ? "" : "s"}: use at most that many.` });
    raw = p.raw;
  }
  // the recipient's token account as the chain has it (null: none yet, or not a token account): it decides the instructions, so the compute limit too
  const toAta = isSol ? null : tokenAccountOf(chain.toAta);
  const cuLimit = isSol ? CU.sol : toAta ? CU.token : CU.tokenWithAccount;
  const cap = maxCuPrice(cuLimit);
  const price = BigInt(cuPrice) > cap ? cap : BigInt(cuPrice);
  const fee = NETWORK_FEE_LAMPORTS + priorityFeeLamports(price, cuLimit);
  const budget = [setComputeUnitLimit(cuLimit), ...(price > 0n ? [setComputeUnitPrice(price)] : [])];
  const feeLine = `No Vicinity fee. Network fee about ${solText(fee)} SOL.`;
  const freshLine = chain.to ? [] : [FRESH_LINE]; // no account at this address: said where the person decides
  const base = { asset: { id: asset.id, mint: isSol ? null : asset.mint, label, symbol: asset.symbol || label, name: asset.name || label, decimals }, to, notice: NOTICE };
  if (isSol) {
    if (all) { raw = sol - fee; if (raw <= 0n) return refuse("insufficient_sol", 409, { have: formatAmount(sol, 9), message: `Not enough SOL: you have ${pretty(sol, 9)} SOL and the network fee is about ${solText(fee)} SOL.` }); }
    // the recipient's side of the rent rule: an account below the minimum (none yet, or an old rent-paying one) can only be brought to at least it
    const has = chain.to ? chain.to.lamports : 0n;
    if (has < RENT_MIN_LAMPORTS && has + raw < RENT_MIN_LAMPORTS) {
      const min = RENT_MIN_LAMPORTS - has;
      return refuse("amount_below_rent", 409, { min: formatAmount(min, 9), message: chain.to
        ? `That wallet holds less than the ${pretty(RENT_MIN_LAMPORTS, 9)} SOL the network needs to keep an account open, and a send must bring it to at least that: send at least ${pretty(min, 9)} SOL, or check the address.`
        : `That wallet has not been used yet: the network needs at least ${pretty(RENT_MIN_LAMPORTS, 9)} SOL to open it. Send at least that, or check the address.` });
    }
    const remaining = sol - raw - fee;
    // the most that can go while the wallet stays open; "everything" is Max
    const keepMax = sol - fee - RENT_MIN_LAMPORTS;
    const maxLine = keepMax > 0n ? ` The most you can send and keep your wallet open is ${pretty(keepMax, 9)} SOL; Max sends everything.` : "";
    if (remaining < 0n) return refuse("insufficient_sol", 409, { have: formatAmount(sol, 9), fee: formatAmount(fee, 9), ...(keepMax > 0n ? { max: formatAmount(keepMax, 9) } : {}), message: `Not enough SOL: you have ${pretty(sol, 9)} SOL and the network fee is about ${solText(fee)} SOL.${maxLine}` });
    if (remaining > 0n && remaining < RENT_MIN_LAMPORTS) return refuse("leaves_dust", 409, { remaining: formatAmount(remaining, 9), min: formatAmount(RENT_MIN_LAMPORTS, 9), ...(keepMax > 0n ? { max: formatAmount(keepMax, 9) } : {}), message: `This would leave ${pretty(remaining, 9)} SOL in your wallet, less than the ${pretty(RENT_MIN_LAMPORTS, 9)} SOL the network needs to keep an account open.${maxLine}` });
    if (remaining === 0n && !all) return refuse("all_required", 409, { message: "This would send every lamport you have. Tap Max if that is what you want." });
    const instructions = [...budget, systemTransfer(sender, to, raw)];
    const summary = {
      ...base, amount: formatAmount(raw, 9), amountRaw: String(raw),
      fee: { lamports: String(fee), sol: formatAmount(fee, 9) }, rent: null,
      remaining: { amount: formatAmount(remaining, 9), label }, remainingSol: formatAmount(remaining, 9),
      destination: { exists: Boolean(chain.to), tokenAccount: null },
      lines: [`Send ${pretty(raw, 9)} SOL`, feeLine, ...freshLine, remaining === 0n ? "You keep no SOL after this send: your wallet is emptied." : `You keep ${pretty(remaining, 9)} SOL after this send.`],
    };
    return { ok: true, instructions, amountRaw: raw, cuLimit, cuPrice: price, fee, rent: 0n, remaining, remainingSol: remaining, summary };
  }
  // a token: from the sender's associated token account (the one this page sends from) to the recipient's, created first when missing
  const mint = asset.mint;
  const senderAta = tokenAccountOf(chain.senderAta);
  const mine = senderAta && senderAta.mint === mint && senderAta.owner === sender ? senderAta : null;
  if (mine && mine.frozen) return refuse("account_frozen", 409, { message: `Your ${label} account is frozen by the token's issuer. Nothing can be sent from it.` });
  const held = mine ? mine.amount : 0n;
  const from = "this wallet's main token account", only = "This page sends from that account only.";
  if (all) { raw = held; if (raw <= 0n) return refuse("insufficient_balance", 409, { have: "0", message: `You hold no ${label} in ${from}. ${only}` }); }
  if (raw > held) return refuse("insufficient_balance", 409, { have: formatAmount(held, decimals), max: formatAmount(held, decimals), message: held > 0n ? `You hold ${pretty(held, decimals)} ${label} in ${from}, less than ${pretty(raw, decimals)}. ${only}` : `You hold no ${label} in ${from}. ${only}` });
  if (toAta && toAta.frozen) return refuse("account_frozen", 409, { message: `The recipient's ${label} account is frozen by the token's issuer. Nothing can be sent to it.` });
  // the recipient's account rent: the full amount for a new account, less any SOL already sitting at that address (the account is made around it)
  const pre = !toAta && chain.toAta && chain.toAta.owner === SYSTEM ? chain.toAta.lamports : 0n;
  const rent = toAta ? 0n : RENT_ATA_LAMPORTS > pre ? RENT_ATA_LAMPORTS - pre : 0n;
  const remainingSol = sol - fee - rent;
  if (remainingSol < RENT_MIN_LAMPORTS) return refuse("insufficient_sol", 409, { have: formatAmount(sol, 9), need: formatAmount(fee + rent + RENT_MIN_LAMPORTS, 9), message: `Not enough SOL for this send: you have ${pretty(sol, 9)} SOL and need about ${solText(fee + rent)} SOL for the network fee${rent ? " and the recipient's account rent" : ""}, keeping at least ${pretty(RENT_MIN_LAMPORTS, 9)} SOL in your wallet.` });
  const instructions = [
    ...budget,
    ...(toAta ? [] : [await createAtaIdempotent({ payer: sender, owner: to, mint })]),
    transferChecked({ source: addresses.senderAta, mint, destination: addresses.toAta, owner: sender, amount: raw, decimals }),
  ];
  const remaining = held - raw;
  const summary = {
    ...base, amount: formatAmount(raw, decimals), amountRaw: String(raw),
    fee: { lamports: String(fee), sol: formatAmount(fee, 9) }, rent: rent ? { lamports: String(rent), sol: formatAmount(rent, 9) } : null,
    remaining: { amount: formatAmount(remaining, decimals), label }, remainingSol: formatAmount(remainingSol, 9),
    destination: { exists: Boolean(chain.to), tokenAccount: Boolean(toAta) },
    lines: [
      `Send ${pretty(raw, decimals)} ${label}`, feeLine,
      ...(rent ? [`+${solText(rent)} SOL one-time account rent for the recipient.`] : []),
      ...freshLine,
      `You keep ${pretty(remaining, decimals)} ${label} after this send.`,
      `Your SOL after the fee${rent ? " and the rent" : ""}: about ${pretty(remainingSol, 9)} SOL.`,
    ],
  };
  return { ok: true, instructions, amountRaw: raw, cuLimit, cuPrice: price, fee, rent, remaining, remainingSol, summary };
}

/* ---------------------------------------------------------------- the route */
/** `?live=1`: a check the page made by itself while the person typed (counted apart from the taps). */
const isLive = (request) => { try { return new URL(request.url).searchParams.get("live") === "1"; } catch { return false; } };
/** POST /api/wallet/send/build (the route has checked the switch, the method, the Origin and the database). */
export async function handleSendBuild(request, env, fetchImpl = fetch, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const { u } = a;
  if (!u.wallet || !isSolanaAddress(u.wallet)) return json({ ok: false, error: "no_wallet", message: "Link a wallet to your account first." }, 400, noStore);
  // counted before any work (one build = three RPC calls): the connection first, then the account; the page's own live check (?live=1) apart from the taps
  const live = isLive(request);
  const kind = live ? "wallet_send_build_live" : "wallet_send_build";
  const busy = await publicLimit(env, request, kind, now);
  if (busy) return busy;
  const slow = await keyLimit(env, kind, String(u.id), live ? LIVE_LIMIT : SEND_LIMIT, now);
  if (slow) return slow;
  const body = await readJson(request, 2048);
  if (!body) return json({ ok: false, error: "bad_json" }, 400, noStore);
  const assetId = typeof body.asset === "string" ? body.asset.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  const all = body.all === true;
  if (!all && typeof body.amount !== "string") return json({ ok: false, error: "bad_amount", message: "Type an amount above zero, with a point for decimals (like 0.5)." }, 400, noStore);
  let list;
  try { list = await supportedAssets(env, now); } catch (e) { console.error("send assets failed", codeOf(e)); return json({ ok: false, error: "unavailable" }, 503, noStore); }
  let asset = list.find((x) => x.id === assetId) || null;
  if (!asset) return json({ ok: false, error: "unsupported_asset", message: mainTokenV5(env) ? "Only SOL, the main token, your legacy $VICINITY and Vicinity city coins can be sent from here." : "Only SOL, $VICINITY and Vicinity city coins can be sent from here." }, 400, noStore);
  // the destination's free checks before any chain call
  const mints = list.map((x) => x.mint).filter(Boolean);
  const first = destinationProblem(to, u.wallet, env, { mints });
  if (first) return json({ ok: false, ...first }, 400, noStore);
  const isSol = asset.id === SOL;
  const addresses = isSol ? {} : { senderAta: await ata(u.wallet, asset.mint), toAta: await ata(to, asset.mint) };
  const keys = isSol ? [u.wallet, to] : [u.wallet, to, asset.mint, addresses.senderAta, addresses.toAta];
  let read, bh;
  try {
    [read, bh] = await Promise.all([
      rpc(env, "getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: DATA_SLICE } }], fetchImpl),
      rpc(env, "getLatestBlockhash", [{ commitment: "confirmed" }], fetchImpl),
    ]);
  } catch (e) { console.error("send build read failed", codeOf(e)); return json({ ok: false, error: "rpc_unavailable" }, 503, noStore); }
  const vals = read && Array.isArray(read.value) ? read.value : null;
  const blockhash = bh && bh.value && isSolanaAddress(bh.value.blockhash) ? bh.value : null;
  if (!vals || vals.length !== keys.length || !blockhash) return json({ ok: false, error: "rpc_unavailable" }, 503, noStore);
  const chain = { sender: accountOf(vals[0]), to: accountOf(vals[1]), mint: isSol ? null : accountOf(vals[2]), senderAta: isSol ? null : accountOf(vals[3]), toAta: isSol ? null : accountOf(vals[4]) };
  const second = destinationProblem(to, u.wallet, env, { account: chain.to, mints });
  if (second) return json({ ok: false, ...second }, 409, noStore);
  if (!isSol) {
    const m = mintOf(chain.mint);
    if (!m) return json({ ok: false, error: "unsupported_asset", reason: chain.mint ? (chain.mint.owner === TOKEN_2022 ? "token2022" : "not_a_mint") : "no_mint", message: "This token cannot be sent from here." }, 400, noStore);
    asset = { ...asset, decimals: m.decimals };
  }
  const plan = await planSend({ sender: u.wallet, to, asset, amount: body.amount, all, chain, addresses, cuPrice: cuPriceOf(env) });
  if (!plan.ok) { const { status, ...rest } = plan; return json(rest, status, noStore); }
  const tx = wrapUnsigned(compileLegacy({ payer: u.wallet, instructions: plan.instructions, blockhash: blockhash.blockhash }));
  if (tx.length > MAX_TX_BYTES) return json({ ok: false, error: "tx_too_large", bytes: tx.length }, 400, noStore);
  // simulated first, as the swap builder does: the node's own refusal in plain words before the wallet opens (a node that cannot
  // simulate right now does not stop a send the checks above passed)
  let simulated = false;
  try {
    const sim = await simulate(env, tx, fetchImpl);
    simulated = true;
    if (!sim.ok) {
      const m = simulationError(sim.err, sim.logs, decodeHeader(tx)) || { error: "program_error" };
      console.error("send would fail", m.error, m.name || "");
      return json({ ok: false, ...m, program: m.program || undefined, stage: "simulation" }, 409, noStore);
    }
  } catch (e) { console.error("send simulation unavailable", codeOf(e)); }
  return json({
    ok: true, tx: toBase64(tx), version: "legacy", bytes: tx.length, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight,
    chain: "solana:mainnet", cluster: "mainnet", taker: u.wallet, simulated,
    ticket: await issueTicket(env, tx, now), // for /api/wallet/send/relay: proof that this Worker built these very bytes
    amount: plan.summary.amount, amountRaw: plan.summary.amountRaw,
    fees: { computeUnitLimit: plan.cuLimit, computeUnitPrice: plan.cuPrice.toString(), priorityLamports: Number(plan.fee - NETWORK_FEE_LAMPORTS), networkLamports: Number(NETWORK_FEE_LAMPORTS), feeLamports: Number(plan.fee), rentLamports: Number(plan.rent) },
    summary: plan.summary,
  }, 200, noStore);
}
