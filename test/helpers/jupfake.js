// A fake Jupiter and a fake Solana RPC for the swap tests (and the real-Worker harness, which imports this file into the
// Worker): the recorded answers of 9 Oct 2026 (test/fixtures/jupiter/) rewritten for the asking wallet, pair, amount and
// slippage, so every address the Worker checks (the taker's own token accounts, the swap's source and destination, the
// WSOL wrap and unwrap) is what the real API would send for that wallet. Pure ESM, no node-only imports: it runs in node
// and in workerd. Never touches the network.
//   fakeJupiter(opts)  -> { fetch(url, init) | null, log, prices, setMode(mode) }  modes: ok | http429 | http500 | neterr | noroute | hostile:<code>
//   fakeRpc(opts)      -> { fetch, log, accounts, sim, send, statuses }            simulateTransaction / sendTransaction / statuses are programmable
//   rewriteBuild(...)  the rewrite itself, exported for the harness
import { ata, ADDRESSES, PROGRAM_IDS } from "../../src/sol/pda.js";
import { fromBase64, toBase64, u64le, u16le, concat } from "../../src/sol/bytes.js";
import { base58Encode } from "../../src/solana.js";
import { decodeHeader } from "../../src/sol/message.js";
import buildSol from "../fixtures/jupiter/build-sol-vicinity.json" with { type: "json" };
import buildUsdc from "../fixtures/jupiter/build-usdc-vicinity.json" with { type: "json" };
import altG3aq from "../fixtures/jupiter/alt-G3aq.json" with { type: "json" };

export const SOL = ADDRESSES.wsol, USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const REAL_VIC = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
export const RECORDED_TAKER = "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN";
export const ALT_KEY = "G3aqFFHFeeWTYnnPPaNHUvgLj8XSUCN95fQtJQosdqWp";
const DECIMALS = { [SOL]: 9, [USDC]: 6, [USDT]: 6 };
/** USD prices the fakes quote with (the harness's fake world uses the same for SOL, USDC, RAY). */
export const PRICES = { [SOL]: 150.25, [USDC]: 1, [USDT]: 1, [REAL_VIC]: 0.00042 };
const b64ToIx = (i) => ({ programId: i.programId, accounts: i.accounts.map((a) => ({ ...a })), data: i.data });
const apiIx = (programId, accounts, data) => ({ programId, accounts: accounts.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })), data: toBase64(data) });
const randomBlockhash = () => Array.from(crypto.getRandomValues(new Uint8Array(32)));

/** out raw units for `inRaw` of `inMint` into `outMint`, at the fake USD prices, minus a 0.3 % spread. */
export function fakeOut(inMint, outMint, inRaw, decimals = DECIMALS, prices = PRICES) {
  const pi = prices[inMint], po = prices[outMint];
  if (pi == null || po == null) return null;
  const di = decimals[inMint] ?? 6, dout = decimals[outMint] ?? 6;
  // out = in × (pi / po) × 10^(dout − di) × 0.997, in integers
  const num = BigInt(inRaw) * BigInt(Math.round(pi * 1e9)) * 10n ** BigInt(dout) * 997n;
  const den = BigInt(Math.round(po * 1e9)) * 10n ** BigInt(di) * 1000n;
  return num / den;
}

/**
 * A /swap/v2/build answer for (taker, inputMint, outputMint, amountRaw, slippageBps), shaped like the recorded one: setup
 * (wrap SOL when paying with SOL, the output account), the recorded route_v2 swap with the taker's accounts and the asked
 * amounts in its data, the WSOL cleanup when SOL is involved, one compute-unit price, Jupiter's blockhash. `hostile` names a
 * deliberate corruption the validator must catch. With `alt: true` the recorded lookup table is claimed (the USDC route).
 */
export async function rewriteBuild({ taker, inputMint, outputMint, amountRaw, slippageBps, outRaw, hostile = null, alt = false, cuPrice = 1220n, lastValidBlockHeight = 432_749_181, platformFeeBps = 0, feeAccount = null }) {
  const tpl = alt ? buildUsdc : buildSol;
  const sol = inputMint === SOL, solOut = outputMint === SOL;
  const inRaw = BigInt(amountRaw), out = BigInt(outRaw);
  const threshold = out - (out * BigInt(slippageBps)) / 10_000n;
  const inAta = await ata(taker, inputMint), outAta = await ata(taker, outputMint), wsolAta = await ata(taker, SOL);
  const create = (mint, acct) => apiIx(PROGRAM_IDS.ata, [[taker, true, true], [acct, false, true], [taker, false, false], [mint, false, false], [PROGRAM_IDS.system, false, false], [PROGRAM_IDS.token, false, false]], Uint8Array.of(1));
  const setup = [];
  if (sol) setup.push(create(SOL, wsolAta), apiIx(PROGRAM_IDS.system, [[taker, true, true], [wsolAta, false, true]], concat([Uint8Array.of(2, 0, 0, 0), u64le(inRaw)])), apiIx(PROGRAM_IDS.token, [[wsolAta, false, true]], Uint8Array.of(17)));
  setup.push(create(outputMint, outAta));
  // the recorded swap: positions 0..7 become the taker's; the rest (route accounts) stay, with the recorded taker replaced
  const rec = tpl.swapInstruction;
  const recWsol = rec.accounts[1].pubkey, recOut = rec.accounts[2].pubkey;
  const swap = b64ToIx(rec);
  const sub = (k) => (k === RECORDED_TAKER ? taker : k === recWsol ? (sol ? wsolAta : inAta) : k === recOut ? outAta : k);
  for (const a of swap.accounts) a.pubkey = sub(a.pubkey);
  swap.accounts[0].pubkey = taker; swap.accounts[1].pubkey = inAta; swap.accounts[2].pubkey = outAta;
  swap.accounts[3].pubkey = inputMint; swap.accounts[4].pubkey = outputMint;
  const d = fromBase64(rec.data);
  d.set(u64le(inRaw), 8); d.set(u64le(out), 16); d.set(u16le(slippageBps), 24); d.set(u16le(platformFeeBps), 26); d.set(u16le(0), 28);
  swap.data = toBase64(d);
  // a platform fee on (SWAP_PLATFORM_FEE_BPS + SWAP_FEE_ACCOUNT): the optional account of route_v2 is the fee's destination (what the Worker's validator insists on)
  if (platformFeeBps > 0 && feeAccount) swap.accounts[7] = { pubkey: feeAccount, isSigner: false, isWritable: true };
  const cleanup = sol || solOut ? apiIx(PROGRAM_IDS.token, [[wsolAta, false, true], [taker, false, true], [taker, true, false]], Uint8Array.of(9)) : null;
  const build = {
    inputMint, outputMint, inAmount: String(inRaw), outAmount: String(out), otherAmountThreshold: String(threshold), swapMode: "ExactIn", slippageBps,
    priceImpactPct: "0.0012", routePlan: [{ percent: 100, bps: 10000, swapInfo: { ...tpl.routePlan[tpl.routePlan.length - 1].swapInfo, inputMint, outputMint, inAmount: String(inRaw), outAmount: String(out) } }],
    computeBudgetInstructions: cuPrice > 0n ? [apiIx(PROGRAM_IDS.computeBudget, [], concat([Uint8Array.of(3), u64le(cuPrice)]))] : [],
    setupInstructions: setup, swapInstruction: swap, cleanupInstruction: cleanup, otherInstructions: [], tipInstruction: null,
    addressesByLookupTableAddress: alt ? { [ALT_KEY]: buildUsdc.addressesByLookupTableAddress[ALT_KEY] } : {},
    blockhashWithMetadata: { blockhash: randomBlockhash(), lastValidBlockHeight },
    transactionVersion: 0,
  };
  if (hostile) corrupt(build, hostile, { taker, outAta, wsolAta, inRaw });
  return build;
}
/** Deliberate corruptions, named by the validator code they must produce. */
function corrupt(b, code, { taker, outAta, wsolAta, inRaw }) {
  const other = "GjJyeC1r2RgkuoCWMyPYkCWSGSGLcz266EaAkLA27AhL"; // a stranger
  switch (code) {
    case "foreign_signer": b.setupInstructions[0].accounts[0] = { pubkey: other, isSigner: true, isWritable: true }; break;
    case "swap_program": b.swapInstruction.programId = PROGRAM_IDS.dbc; break;
    case "destination_account": b.swapInstruction.accounts[2].pubkey = other; break;
    case "authority": b.swapInstruction.accounts[0].pubkey = other; break;
    case "source_account": b.swapInstruction.accounts[1].pubkey = other; break;
    case "platform_fee": { const d = fromBase64(b.swapInstruction.data); d.set(u16le(50), 26); b.swapInstruction.data = toBase64(d); break; }
    case "positive_slippage": { const d = fromBase64(b.swapInstruction.data); d.set(u16le(10), 28); b.swapInstruction.data = toBase64(d); break; }
    case "swap_in_amount": { const d = fromBase64(b.swapInstruction.data); d.set(u64le(inRaw * 2n), 8); b.swapInstruction.data = toBase64(d); break; }
    case "swap_min_out": b.otherAmountThreshold = String(BigInt(b.otherAmountThreshold) - 1n); break;
    case "tip": b.tipInstruction = apiIx(PROGRAM_IDS.system, [[taker, true, true], [other, false, true]], concat([Uint8Array.of(2, 0, 0, 0), u64le(1000n)])); break;
    case "helper_program": b.otherInstructions.push(apiIx(other, [[taker, true, true]], Uint8Array.of(1))); break;
    case "sol_transfer_destination": { const t = b.setupInstructions.find((i) => i.programId === PROGRAM_IDS.system); if (t) t.accounts[1].pubkey = other; break; }
    case "sol_transfer_amount": { const t = b.setupInstructions.find((i) => i.programId === PROGRAM_IDS.system); if (t) t.data = toBase64(concat([Uint8Array.of(2, 0, 0, 0), u64le(inRaw * 3n)])); break; }
    case "close_account": if (b.cleanupInstruction) b.cleanupInstruction.accounts[1].pubkey = other; break;
    case "ata_owner": b.setupInstructions[b.setupInstructions.length - 1].accounts[2].pubkey = other; break;
    case "ata_mint": b.setupInstructions[b.setupInstructions.length - 1].accounts[3].pubkey = other; break;
    case "unknown_swap": { const d = fromBase64(b.swapInstruction.data); d.set(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), 0); b.swapInstruction.data = toBase64(d); break; }
    case "swap_mode": b.swapMode = "ExactOut"; break;
    case "slippage": b.slippageBps = 9000; { const d = fromBase64(b.swapInstruction.data); d.set(u16le(9000), 24); b.swapInstruction.data = toBase64(d); } break;
    case "alt_mismatch": b.addressesByLookupTableAddress = { [ALT_KEY]: [other, ...buildUsdc.addressesByLookupTableAddress[ALT_KEY].slice(1)] }; break;
    case "alt_missing": b.addressesByLookupTableAddress = { [other]: [taker] }; break;
    case "compute_budget_program": b.computeBudgetInstructions.push(apiIx(other, [], Uint8Array.of(3))); break;
    default: throw new Error("unknown hostile " + code);
  }
  void outAta; void wsolAta;
}

/** A fake Jupiter at the fetch layer: /swap/v2/build (keyed host), /swap/v1/quote, /tokens/v2/search, /price/v3. */
export function fakeJupiter({ prices = PRICES, decimals = DECIMALS, hostile = null, alt = false, cuPrice, platformFeeBps = 0, feeAccount = null } = {}) {
  const log = [];
  let mode = "ok";
  const err = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const F = {
    log, prices, decimals,
    setMode(m) { mode = m; }, get mode() { return mode; }, hostile, alt, cuPrice, platformFeeBps, feeAccount,
    async fetch(url, init = {}) {
      const u = new URL(String(url));
      if (!/(^|\.)jup\.ag$/.test(u.hostname)) return null;
      const keyed = Boolean(init.headers && (init.headers["x-api-key"] || (typeof init.headers.get === "function" && init.headers.get("x-api-key"))));
      log.push({ path: u.pathname, host: u.hostname, keyed, q: Object.fromEntries(u.searchParams), at: Date.now() });
      if (mode === "http429") return err(429, { error: "rate limited" }, { "retry-after": "7" });
      if (mode === "http500") return err(500, { error: "oops" });
      if (mode === "neterr") throw new TypeError("fetch failed");
      if (mode === "hang") await new Promise((r, j) => { const t = setTimeout(r, 10_000); init.signal?.addEventListener("abort", () => { clearTimeout(t); j(new DOMException("aborted", "AbortError")); }); });
      if (u.pathname === "/price/v3") {
        const ids = (u.searchParams.get("ids") || "").split(",").filter(Boolean);
        return ok(Object.fromEntries(ids.filter((m) => prices[m] != null).map((m) => [m, { usdPrice: prices[m], blockId: 1, decimals: decimals[m] ?? 6, priceChange24h: 0 }])));
      }
      if (u.pathname === "/tokens/v2/search") {
        const q = (u.searchParams.get("query") || "").toLowerCase();
        const all = [{ id: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, isVerified: true }, { id: USDT, symbol: "USDT", name: "Tether USD", decimals: 6, isVerified: true }, { id: SOL, symbol: "SOL", name: "Wrapped SOL", decimals: 9, isVerified: true }, { id: "kgERWXbLfq6MHcWLd86a5dpmSvM86QhQrQjL2gGPbnD", symbol: "USDC", name: "Not USDC", decimals: 6, isVerified: false }];
        return ok(all.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.id.toLowerCase() === q));
      }
      const inputMint = u.searchParams.get("inputMint"), outputMint = u.searchParams.get("outputMint"), amount = u.searchParams.get("amount"), slippageBps = Number(u.searchParams.get("slippageBps") || 100);
      const outRaw = fakeOut(inputMint, outputMint, BigInt(amount), decimals, prices);
      if (mode === "noroute" || outRaw == null) return err(400, { error: `The token ${outputMint} is not tradable`, errorCode: "TOKEN_NOT_TRADABLE" });
      if (u.pathname === "/swap/v1/quote") {
        const threshold = outRaw - (outRaw * BigInt(slippageBps)) / 10_000n;
        return ok({ inputMint, inAmount: amount, outputMint, outAmount: String(outRaw), otherAmountThreshold: String(threshold), swapMode: "ExactIn", slippageBps, platformFee: null, priceImpactPct: "0", routePlan: [{ swapInfo: { ammKey: "3E32cHh3aA4KrAH1ShLbHcdTsTs2EyLKLtpWQNiNySZo", label: "Raydium Launchlab", inputMint, outputMint, inAmount: amount, outAmount: String(outRaw) }, percent: 100 }], contextSlot: 1, timeTaken: 0.0001, transactionVersion: 0 });
      }
      if (u.pathname === "/swap/v2/build") {
        const taker = u.searchParams.get("taker");
        if (!taker) return err(400, { error: "taker is required" });
        if (outRaw <= 0n) return err(400, { error: "Amount too small", errorCode: "AMOUNT_TOO_SMALL" });
        // a fee the asker set in the query (what the Worker sends when SWAP_PLATFORM_FEE_BPS is on) is answered the way Jupiter would: in the data and the optional account
        const askedFee = Number(u.searchParams.get("platformFeeBps") || 0), askedAccount = u.searchParams.get("feeAccount") || null;
        return ok(await rewriteBuild({ taker, inputMint, outputMint, amountRaw: amount, slippageBps, outRaw, hostile: F.hostile, alt: F.alt, cuPrice: F.cuPrice, platformFeeBps: F.platformFeeBps || askedFee, feeAccount: F.feeAccount || askedAccount }));
      }
      return err(404, { error: "not found" });
    },
  };
  return F;
}

/**
 * A fake Solana RPC for the swap routes: mints (decimals), the recorded lookup table, balances, token accounts, blockhash,
 * simulation, send and statuses, all programmable. `sim` = () => ({ err, logs, unitsConsumed }) decides every simulation;
 * `send` = (txBase64) => signature | { error } decides every sendTransaction. Handles one call or a batch.
 */
export function fakeRpc({ mints = {}, lamports = {}, holdings = {}, slot = 1000, blockHeight = 432_749_000 } = {}) {
  const log = [];
  const accounts = { [ALT_KEY]: { owner: altG3aq.result.value.owner, lamports: altG3aq.result.value.lamports, data: altG3aq.result.value.data } };
  const statuses = {};
  const R = {
    log, accounts, statuses, mints: { [SOL]: { decimals: 9 }, [USDC]: { decimals: 6 }, [USDT]: { decimals: 6 }, ...mints }, lamports, holdings, slot, blockHeight,
    sim: () => ({ err: null, logs: ["Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success"], unitsConsumed: 180_000 }),
    send: () => base58Encode(crypto.getRandomValues(new Uint8Array(64))),
    sent: [],
    one({ method, params = [] }) {
      switch (method) {
        case "getAccountInfo": {
          const [addr, opts] = params;
          const acc = accounts[addr];
          if (acc) return { context: { slot }, value: { owner: acc.owner, lamports: acc.lamports, executable: false, rentEpoch: 0, data: acc.data } };
          const m = R.mints[addr];
          if (m === null) return { context: { slot }, value: null };
          if (m || opts?.encoding === "jsonParsed") return { context: { slot }, value: { owner: PROGRAM_IDS.token, lamports: 1461600, executable: false, rentEpoch: 0, data: { program: "spl-token", parsed: { type: "mint", info: { decimals: m ? m.decimals : 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null, isInitialized: true } } } } };
          return { context: { slot }, value: null };
        }
        case "getMultipleAccounts": return { context: { slot }, value: params[0].map((a) => (accounts[a] ? { owner: accounts[a].owner, lamports: accounts[a].lamports, executable: false, rentEpoch: 0, data: accounts[a].data } : null)) };
        case "getBalance": return { context: { slot }, value: lamports[params[0]] ?? 0 };
        case "getTokenAccountsByOwner": { const [owner, f] = params; const a = (holdings[f?.mint] || {})[owner] || 0; const dec = R.mints[f?.mint]?.decimals ?? 6; return { context: { slot }, value: a > 0 ? [{ pubkey: "x", account: { data: { parsed: { info: { mint: f.mint, owner, tokenAmount: { amount: String(BigInt(Math.round(a * 10 ** dec))), decimals: dec, uiAmount: a, uiAmountString: String(a) } } } } } }] : [] }; }
        case "getLatestBlockhash": return { context: { slot }, value: { blockhash: base58Encode(crypto.getRandomValues(new Uint8Array(32))), lastValidBlockHeight: blockHeight + 150 } };
        case "getBlockHeight": return R.blockHeight;
        case "simulateTransaction": { const r = R.sim(params[0], params[1]); return { context: { slot }, value: { err: r.err ?? null, logs: r.logs || [], unitsConsumed: r.unitsConsumed ?? 100_000, accounts: null } }; }
        case "sendTransaction": {
          const tx = params[0];
          decodeHeader(fromBase64(tx)); // malformed bytes never get this far in the Worker, but the fake insists too
          const r = R.send(tx);
          if (r && typeof r === "object" && r.error) throw { code: -32002, message: "Transaction simulation failed: " + r.message, data: { err: r.error, logs: r.logs || [] } };
          R.sent.push({ tx, signature: r });
          statuses[r] ||= { confirmationStatus: "confirmed", confirmations: 1, err: null, slot };
          return r;
        }
        case "getSignatureStatuses": return { context: { slot }, value: params[0].map((s) => statuses[s] ?? null) };
        default: throw { code: -32601, message: "Method not found (fake)" };
      }
    },
    async fetch(url, init = {}) {
      const u = String(url);
      if (!/rpc|solana\.com/.test(u)) return null;
      const body = JSON.parse(init.body);
      const list = Array.isArray(body) ? body : [body];
      log.push({ methods: list.map((b) => b.method), url: u });
      const ans = (b) => { try { return { jsonrpc: "2.0", id: b.id ?? 1, result: R.one(b) }; } catch (e) { return { jsonrpc: "2.0", id: b.id ?? 1, error: e && e.code ? e : { code: -32603, message: String((e && e.message) || e) } }; } };
      return new Response(JSON.stringify(Array.isArray(body) ? list.map(ans) : ans(body)), { headers: { "content-type": "application/json" } });
    },
  };
  return R;
}

/** One fetch for the Worker: Jupiter, then the RPC, then anything else is a recorded surprise answered 599. */
export function fakeWorld(opts = {}) {
  const jup = fakeJupiter(opts.jupiter), rpc = fakeRpc(opts.rpc);
  const others = [];
  const fetchImpl = async (url, init) => (await jup.fetch(url, init)) || (await rpc.fetch(url, init)) || (others.push(String(url)), new Response("blocked", { status: 599 }));
  return { jup, rpc, others, fetch: fetchImpl };
}
