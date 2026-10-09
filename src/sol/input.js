/**
 * What a swap or curve-trade request may carry, checked the same way on every route (src/swap.js, src/lptrade.js):
 *   amount      a decimal STRING in whole tokens ("0.25", "1500"): at most 15 digits before the point and 12 after, > 0; turned
 *               into raw units with the mint's decimals, exactly (BigInt, no float). Fewer than one raw unit is amount_too_small.
 *   slippageBps an integer 1..5000 (0.01 % to 50 %), default 100.
 *   taker       a 32-byte on-curve key (a person's wallet, never a program account). Anything else is bad_wallet.
 * Every failure is { error: <plain code>, status: 400 }; never a thrown exception a route could forget to catch.
 */
import { isOnCurve } from "./oncurve.js";
import { base58Decode, isSolanaAddress } from "../solana.js";

export const MAX_SLIPPAGE_BPS = 5000, DEFAULT_SLIPPAGE_BPS = 100;
const AMOUNT = /^(\d{1,15})(?:\.(\d{1,12}))?$/;
export const bad = (error, extra = {}) => ({ error, status: 400, ...extra });

/** "12.5" with 6 decimals -> 12500000n; null for anything that is not a positive decimal, or more precise than the mint allows. */
export function parseAmount(text, decimals) {
  if (typeof text === "number" && Number.isFinite(text) && text > 0) text = text.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 12 });
  const m = typeof text === "string" ? AMOUNT.exec(text.trim()) : null;
  if (!m || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const whole = m[1], frac = (m[2] || "").replace(/0+$/, "");
  if (frac.length > decimals) return { tooPrecise: true };
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + (frac ? BigInt(frac.padEnd(decimals, "0")) : 0n);
  return raw > 0n ? { raw } : null;
}
/** raw units -> a whole-token decimal string ("0.25"), exact. */
export function formatAmount(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0", frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}
export function checkSlippage(v) {
  if (v == null || v === "") return DEFAULT_SLIPPAGE_BPS;
  const n = typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 1 && n <= MAX_SLIPPAGE_BPS ? n : null;
}
export function checkTaker(v) {
  if (!isSolanaAddress(v)) return null;
  try { return isOnCurve(base58Decode(v)) ? v : null; } catch { return null; }
}
/** Read { inputMint, outputMint, amount, slippageBps, taker? } from a body; { error } on the first problem. */
export function readSwapInput(body, { takerRequired = false } = {}) {
  if (!body || typeof body !== "object") return bad("bad_json");
  const { inputMint, outputMint } = body;
  if (!isSolanaAddress(inputMint) || !isSolanaAddress(outputMint)) return bad("bad_mint");
  if (inputMint === outputMint) return bad("same_mint");
  if (!(typeof body.amount === "string" || typeof body.amount === "number")) return bad("bad_amount");
  const slippageBps = checkSlippage(body.slippageBps);
  if (slippageBps == null) return bad("bad_slippage");
  let taker = null;
  if (body.taker != null && body.taker !== "") { taker = checkTaker(body.taker); if (!taker) return bad("bad_wallet"); }
  if (takerRequired && !taker) return bad("bad_wallet");
  return { inputMint, outputMint, amount: body.amount, slippageBps, taker, legacy: body.v === "legacy" };
}
