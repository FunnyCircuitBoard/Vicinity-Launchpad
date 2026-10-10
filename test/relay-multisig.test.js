// The relay (/api/swap/send) with the city-coin pages' transactions: 1 to 4 signers when EVERY slot is filled (the wallet plus
// up to 3 one-time keys made in the browser), the ticket still required (it proves this Worker built the very message), and the
// relay routes there for the city-coin gate even with the swap switch off. src/relay.js, src/lpkit.js.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { _resetLpKit, buildTx } from "../src/lpkit.js";
import { _resetRelay } from "../src/relay.js";
import { compileLegacy, wrapUnsigned } from "../src/sol/message.js";
import { fromBase64, toBase64 } from "../src/sol/bytes.js";
import { PROGRAM_IDS } from "../src/sol/pda.js";
import { browser, newWorld } from "./helpers/world.js";
import { LP_ON, addr, lpChain } from "./helpers/lpchain.js";

const PAYER = addr(1), K1 = addr(2), K2 = addr(3), K3 = addr(4), K4 = addr(5);
const createAccount = (from, to) => ({ programAddress: PROGRAM_IDS.system, accounts: [{ address: from, role: 3 }, { address: to, role: 3 }], data: Uint8Array.of(0, 0, 0, 0, ...new Uint8Array(8).fill(1), ...new Uint8Array(8), ...new Uint8Array(32)) });
/** Fill signature slots (all, or those listed) with non-zero bytes, as signers would. */
const sign = (b64, slots = null) => { const tx = fromBase64(b64); const n = tx[0]; for (let i = 0; i < n; i++) if (!slots || slots.includes(i)) tx.fill(i + 7, 1 + 64 * i, 65 + 64 * i); return toBase64(tx); };
beforeEach(() => { _resetLpKit(); _resetRelay(); });

async function setup(extra = {}) {
  const env = { ...newWorld(), ...LP_ON, ...extra };
  const chain = lpChain();
  const b = browser(env);
  const send = async (body) => { const r = await b.send("/api/swap/send", { method: "POST", body, fetchImpl: chain.fetchImpl }); return { status: r.status, data: await r.json() }; };
  return { env, chain, b, send };
}

test("relay: 2 and 3 signers, every slot filled, with this Worker's ticket, go through (on devnet, with the swap switch off)", async () => {
  const { env, chain, send } = await setup();
  const two = await buildTx(env, { payer: PAYER, instructions: [createAccount(PAYER, K1)], extraSigners: [K1] }, chain.fetchImpl);
  assert.equal(two.ok, true, JSON.stringify(two));
  const r2 = await send({ tx: sign(two.tx), ticket: two.ticket, lastValidBlockHeight: two.lastValidBlockHeight, cluster: "devnet" });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  assert.equal(r2.data.cluster, "devnet");
  const three = await buildTx(env, { payer: PAYER, instructions: [createAccount(PAYER, K1), createAccount(PAYER, K2)], extraSigners: [K1, K2] }, chain.fetchImpl);
  const r3 = await send({ tx: sign(three.tx), ticket: three.ticket, cluster: "devnet" });
  assert.equal(r3.status, 200, JSON.stringify(r3.data));
  const four = await buildTx(env, { payer: PAYER, instructions: [createAccount(PAYER, K1), createAccount(PAYER, K2), createAccount(PAYER, K3)], extraSigners: [K1, K2, K3] }, chain.fetchImpl);
  assert.equal((await send({ tx: sign(four.tx), ticket: four.ticket, cluster: "devnet" })).status, 200, "4 signers is the most");
  const sends = chain.calls("sendTransaction");
  assert.equal(sends.length, 3);
  assert.ok(sends.every((c) => c.url === LP_ON.LAUNCHPAD_RPC_URL), "sent to the launchpad cluster's own node");
  assert.deepEqual(chain.S.sent.map((t) => t[0]), [2, 3, 4]);
});

test("relay: an empty slot, 5 signers, no ticket, a forged ticket and another message's ticket are all refused before any node is asked", async () => {
  const { env, chain, send } = await setup();
  const three = await buildTx(env, { payer: PAYER, instructions: [createAccount(PAYER, K1), createAccount(PAYER, K2)], extraSigners: [K1, K2] }, chain.fetchImpl);
  // the wallet signed, one browser key did not
  assert.deepEqual((await send({ tx: sign(three.tx, [0, 1]), ticket: three.ticket, cluster: "devnet" })).data, { ok: false, error: "unsigned" });
  assert.deepEqual((await send({ tx: sign(three.tx, [1, 2]), ticket: three.ticket, cluster: "devnet" })).data, { ok: false, error: "unsigned" }, "the fee payer's slot empty");
  // five signers: never something this Worker builds
  const five = wrapUnsigned(compileLegacy({ payer: PAYER, blockhash: chain.S.blockhash,
    instructions: [createAccount(PAYER, K1), createAccount(PAYER, K2), createAccount(PAYER, K3), createAccount(PAYER, K4)] }));
  assert.equal(five[0], 5);
  const r5 = await send({ tx: sign(toBase64(five)), ticket: three.ticket, cluster: "devnet" });
  assert.deepEqual([r5.status, r5.data.error, r5.data.reason], [400, "bad_tx", "too_many_signers"]);
  // the ticket
  assert.equal((await send({ tx: sign(three.tx), cluster: "devnet" })).data.error, "bad_ticket");
  const [exp, mac] = three.ticket.split(".");
  assert.equal((await send({ tx: sign(three.tx), ticket: `${exp}.${mac.slice(0, -2)}AA`, cluster: "devnet" })).data.error, "bad_ticket", "a forged HMAC");
  assert.equal((await send({ tx: sign(three.tx), ticket: `${Number(exp) + 60_000}.${mac}`, cluster: "devnet" })).data.error, "bad_ticket", "a moved expiry");
  const other = await buildTx(env, { payer: PAYER, instructions: [createAccount(PAYER, K3)], extraSigners: [K3] }, chain.fetchImpl);
  assert.equal((await send({ tx: sign(three.tx), ticket: other.ticket, cluster: "devnet" })).data.error, "bad_ticket", "another message's ticket");
  // a message changed after the build (as a wallet that rewrote it would): the ticket no longer matches
  const changed = fromBase64(sign(three.tx)); changed[changed.length - 1] ^= 1;
  assert.equal((await send({ tx: toBase64(changed), ticket: three.ticket, cluster: "devnet" })).data.error, "bad_ticket");
  assert.equal(chain.calls("sendTransaction").length, 0, "no node was asked to send anything");
});

test("relay: without the city-coin gate (and the swap off) the relay routes are not there; cluster=devnet is honoured only with the gate on devnet", async () => {
  const off = { ...newWorld() };
  const chain = lpChain();
  const b = browser(off);
  assert.equal((await b.send("/api/swap/send", { method: "POST", body: { tx: "AA==" }, fetchImpl: chain.fetchImpl })).status, 404);
  assert.equal((await b.send("/api/swap/status?sig=" + "1".repeat(64), { fetchImpl: chain.fetchImpl })).status, 404);
  // SWAP on, gate off: a devnet status poll is answered from mainnet (no devnet node is ever asked)
  const swapOnly = browser({ ...newWorld(), SWAP: "on" });
  const st = await swapOnly.send("/api/swap/status?sig=5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk&cluster=devnet", { fetchImpl: chain.fetchImpl });
  assert.equal((await st.json()).cluster, "mainnet");
  assert.ok(!chain.S.log.some((l) => l.url === LP_ON.LAUNCHPAD_RPC_URL));
  // the gate on devnet: the poll goes to the launchpad's node
  const { b: on, chain: c2 } = await setup();
  const st2 = await on.send("/api/swap/status?sig=5ctr2RXcTzQ4XfHfFmjTaFPYxSMBw1Zp2WgVgXnvwDeMb7Yg7nE1xWxXq2k4mbKTrDJDDWJnBHe3bDB7uCqUWbk&cluster=devnet", { fetchImpl: c2.fetchImpl });
  assert.equal((await st2.json()).cluster, "devnet");
  assert.equal(c2.calls("getSignatureStatuses")[0].url, LP_ON.LAUNCHPAD_RPC_URL);
  // the balances and the swap's own routes stay off with only the gate on
  assert.equal((await on.send("/api/swap/balances?owner=" + PAYER, { fetchImpl: c2.fetchImpl })).status, 404);
  assert.equal((await on.send("/api/swap/quote", { method: "POST", body: {}, fetchImpl: c2.fetchImpl })).status, 404);
});
