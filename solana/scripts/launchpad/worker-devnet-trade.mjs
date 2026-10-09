// Buys and then sells a launchpad demo coin on DEVNET through the website's own routes, exactly as the Buy & swap panel
// does: /api/launchpad/trade/quote and /tx build the transaction in the Worker (src/lptrade.js, no web3.js), the throwaway
// trader key signs it here (a wallet would), /api/swap/send relays it, /api/swap/status watches it, /api/swap/balances
// reads the result. The landed transaction is then read back from the chain and compared with the quote to the raw unit.
// Refuses mainnet. Keys stay in --keys and are never printed.
//   NODE_USE_ENV_PROXY=1 node scripts/launchpad/worker-devnet-trade.mjs --keys <dir> [--rpc https://api.devnet.solana.com] [--mint <coin>] [--amount 0.005] [--slippage 100] [--json out.json]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import web3 from "@solana/web3.js";
import { connect, loadKeypair, explorer, json } from "./lib.mjs";
import { handleApi } from "../../../src/index.js";
import { newWorld } from "../../../test/helpers/world.js";
import { seedCoin } from "../../../test/helpers/launchpad.js";

const { VersionedTransaction, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = web3;
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"] : null)).filter(Boolean));
const KEYS = args.keys || process.env.LAUNCHPAD_KEYS;
if (!KEYS) throw new Error("--keys <dir> (the folder with demo-trader-1-keypair.json and devnet-deployer.json)");
const RPC = args.rpc || "https://api.devnet.solana.com";
const MINT = args.mint || "EAXzD7eEJuFr8kfmqrrPBVuUNsd53PWHfsHuYFD8nPby"; // DEMOV (LAUNCHPAD-DEVNET.md, city 999000003)
const CITY = Number(args.city || 999000003);
const AMOUNT = args.amount || "0.005";
const SLIPPAGE = Number(args.slippage || 100);
const ORIGIN = "https://vicinity.city";
const log = (...a) => console.log(...a);

const { connection, cluster } = await connect(RPC);
if (cluster !== "devnet") throw new Error(`this script trades on devnet only (the RPC is ${cluster})`);
const trader = loadKeypair(join(KEYS, "demo-trader-1-keypair.json"));
const deployer = existsSync(join(KEYS, "devnet-deployer.json")) ? loadKeypair(join(KEYS, "devnet-deployer.json")) : null;
const TAKER = trader.publicKey.toBase58();
log(`trader ${TAKER} on ${cluster} (${RPC})`);
const out = { cluster, rpc: RPC, mint: MINT, taker: TAKER, at: new Date().toISOString(), steps: [] };

/* ---- the Worker, with a throwaway database that knows the demo coin (the live site reads it from its D1) ---- */
const env = { ...newWorld(), LAUNCHPAD_TRADING: "on", LAUNCHPAD_CLUSTER: "devnet", LAUNCHPAD_RPC_URL: RPC, SOLANA_RPC_URL: RPC };
await seedCoin(env.DB, { city: CITY, name: "Demo Village", coin: "Demo Village", pair: "SOL", mint: MINT, user: 0 });
async function call(path, body) {
  const headers = new Headers({ "cf-connecting-ip": "127.0.0.1", origin: ORIGIN });
  if (body !== undefined) headers.set("content-type", "application/json");
  const res = await handleApi(new Request(ORIGIN + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, fetch);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const balances = () => call(`/api/swap/balances?owner=${TAKER}&mints=${MINT}&cluster=devnet`);

/* ---- the trader needs a little devnet SOL: topped up from the throwaway deployer when short ---- */
const lamports = await connection.getBalance(trader.publicKey, "confirmed");
log(`trader balance ${lamports / LAMPORTS_PER_SOL} SOL`);
if (lamports < 0.02 * LAMPORTS_PER_SOL) {
  if (!deployer) throw new Error("the trader has no SOL and there is no devnet-deployer.json to top it up from");
  const topUp = Math.round(Number(args.topup || 0.03) * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: trader.publicKey, lamports: topUp }));
  const signature = await sendAndConfirmTransaction(connection, tx, [deployer], { commitment: "confirmed" });
  log(`topped up ${topUp / LAMPORTS_PER_SOL} SOL from the deployer: ${explorer("tx", signature, cluster)}`);
  out.steps.push({ step: "top-up", lamports: topUp, signature, explorer: explorer("tx", signature, cluster) });
}

/* ---- one trade through the routes: quote → tx → sign here → relay → status → read back from the chain ---- */
async function trade(side, amount) {
  const before = await balances();
  const q = await call("/api/launchpad/trade/quote", { mint: MINT, side, amount, slippageBps: SLIPPAGE, taker: TAKER });
  log(`\n${side}: quote ${q.inUi} ${side === "buy" ? "SOL" : "DEMOV"} → ${q.outUi} ${side === "buy" ? "DEMOV" : "SOL"} (min ${q.minOutUi}, impact ${q.priceImpactPct}%, fee ${q.fees.curveFeeBps} bps${q.partialFill ? ", PARTIAL FILL" : ""})`);
  const t = await call("/api/launchpad/trade/tx", { mint: MINT, side, amount, slippageBps: SLIPPAGE, taker: TAKER, quoteId: q.quoteId });
  log(`  tx built by the Worker: version ${t.version}, ${t.bytes} bytes, cu ${t.fees ? t.fees.computeUnitLimit : "?"}, blockhash ${t.blockhash.slice(0, 8)}…, lvbh ${t.lastValidBlockHeight}`);
  const vtx = VersionedTransaction.deserialize(Buffer.from(t.tx, "base64"));
  vtx.sign([trader]); // the wallet's part
  const sent = await call("/api/swap/send", { tx: Buffer.from(vtx.serialize()).toString("base64"), lastValidBlockHeight: t.lastValidBlockHeight, cluster: "devnet" });
  log(`  relayed: ${sent.signature}`);
  let status = null;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    status = await call(`/api/swap/status?sig=${sent.signature}&lvbh=${t.lastValidBlockHeight}&cluster=devnet&via=curve`);
    if (["confirmed", "finalized", "failed", "expired"].includes(status.status)) break;
  }
  if (!status || !["confirmed", "finalized"].includes(status.status)) throw new Error(`${side}: not confirmed: ${JSON.stringify(status)}`);
  log(`  ${status.status} (${status.solscan})`);
  // read back from the chain: the exact amounts that moved
  let chain = null;
  for (let i = 0; i < 10 && !chain; i++) { chain = await connection.getTransaction(sent.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); if (!chain) await new Promise((r) => setTimeout(r, 1500)); }
  if (!chain) throw new Error("the landed transaction could not be read back");
  const tb = (list) => (list || []).find((b) => b.mint === MINT && b.owner === TAKER);
  const coinBefore = BigInt(tb(chain.meta.preTokenBalances)?.uiTokenAmount.amount || 0), coinAfter = BigInt(tb(chain.meta.postTokenBalances)?.uiTokenAmount.amount || 0);
  const keys = chain.transaction.message.getAccountKeys({ accountKeysFromLookups: chain.meta.loadedAddresses });
  const idx = keys.staticAccountKeys.findIndex((k) => k.toBase58() === TAKER);
  const solBefore = BigInt(chain.meta.preBalances[idx]), solAfter = BigInt(chain.meta.postBalances[idx]);
  const after = await balances();
  const step = {
    step: side, amount, quote: { inAmount: q.inAmount, outAmount: q.outAmount, minOut: q.minOut, mode: q.mode, partialFill: q.partialFill, priceImpactPct: q.priceImpactPct, fees: q.fees.split, curveFeeBps: q.fees.curveFeeBps },
    tx: { version: t.version, bytes: t.bytes, computeUnitLimit: t.fees && t.fees.computeUnitLimit }, signature: sent.signature, explorer: explorer("tx", sent.signature, cluster), solscan: status.solscan, status: status.status,
    landed: { fee: chain.meta.fee, computeUnitsConsumed: chain.meta.computeUnitsConsumed, coinDelta: (coinAfter - coinBefore).toString(), coinAfter: coinAfter.toString(), solDelta: (solAfter - solBefore).toString(), slot: chain.slot },
    balances: { before: { sol: before.sol.ui, coin: before.tokens[MINT].ui }, after: { sol: after.sol.ui, coin: after.tokens[MINT].ui } },
  };
  if (side === "buy") {
    step.check = { coinReceivedEqualsQuote: (coinAfter - coinBefore).toString() === q.outAmount, solSpentWithinQuotePlusFeesAndRent: solBefore - solAfter >= BigInt(q.inAmount) && solBefore - solAfter <= BigInt(q.inAmount) + BigInt(chain.meta.fee) + 2n * 2_039_280n + 1n };
  } else {
    const solReceived = solAfter - solBefore + BigInt(chain.meta.fee); // the unwrap returns the temporary WSOL account's rent with the proceeds, net of the fee
    step.check = { solReceivedEqualsQuote: solReceived.toString() === q.outAmount, solReceivedAtLeastMinOut: solReceived >= BigInt(q.minOut), coinSpentEqualsQuote: (coinBefore - coinAfter).toString() === q.inAmount };
    step.landed.solReceived = solReceived.toString();
  }
  log(`  landed: fee ${chain.meta.fee} lamports, ${chain.meta.computeUnitsConsumed} CU, coin ${step.landed.coinDelta}, sol ${step.landed.solDelta}; checks ${JSON.stringify(step.check)}`);
  out.steps.push(step);
  return step;
}

const buy = await trade("buy", AMOUNT);
if (!Object.values(buy.check).every(Boolean)) throw new Error("the buy did not match its quote: " + JSON.stringify(buy.check));
// sell everything held, from the raw unit of the landed transaction (never a floating-point string: the route refuses more than 6 decimals)
const heldRaw = BigInt(buy.landed.coinAfter);
const held = `${heldRaw / 1_000_000n}.${(heldRaw % 1_000_000n).toString().padStart(6, "0")}`.replace(/\.?0+$/, "");
const sell = await trade("sell", held);
if (!Object.values(sell.check).every(Boolean)) throw new Error("the sell did not match its quote: " + JSON.stringify(sell.check));
out.ok = true;
if (args.json) writeFileSync(args.json, json(out) + "\n");
log("\nRESULT " + json({ ok: out.ok, buy: { signature: buy.signature, coin: buy.landed.coinDelta, sol: buy.landed.solDelta }, sell: { signature: sell.signature, coin: sell.landed.coinDelta, sol: sell.landed.solDelta } }));
