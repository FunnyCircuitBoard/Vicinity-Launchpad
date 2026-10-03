// /api/holders answers 1,000 wallets at a time (?offset=N, `more`, `count`), against the real route with the test world's
// fake Solana: the token page asks page after page until every holder is in its table.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MINT, browser, newWorld, setHolding } from "./helpers/world.js";
import { base58Encode } from "../src/solana.js";
import { isOnCurve } from "../src/chain.js";

let env;
beforeEach(() => { env = newWorld(); env.VICINITY_MINT = MINT; });

test("/api/holders: 1,000 wallets at a time; ?offset=N continues, `more` says when to stop, every holder exactly once, odd offsets round down to a page", async () => {
  // people's wallets are points on the curve (an off-curve owner is a program's account and is listed as a pool, unranked)
  const key = () => { for (;;) { const b = randomBytes(32); if (isOnCurve(b)) return base58Encode(b); } };
  const wallets = Array.from({ length: 2500 }, key);
  wallets.forEach((w, i) => setHolding(w, 2500 - i));
  const b = browser(env);
  const first = await b.get("/api/holders");
  assert.equal(first.full, true); assert.equal(first.total, 2500); assert.equal(first.count, 2500); assert.equal(first.more, true);
  assert.equal(first.holders.length, 1000); assert.equal(first.holders[0].rank, 1); assert.equal(first.holders[999].rank, 1000);
  const second = await b.get("/api/holders?offset=1000");
  assert.equal(second.holders.length, 1000); assert.equal(second.holders[0].rank, 1001); assert.equal(second.more, true);
  const third = await b.get("/api/holders?offset=2000");
  assert.equal(third.holders.length, 500); assert.equal(third.holders[499].rank, 2500); assert.equal(third.more, false);
  const owners = [...first.holders, ...second.holders, ...third.holders].map((h) => h.owner);
  assert.equal(new Set(owners).size, 2500, "no wallet twice");
  assert.deepEqual(owners, wallets, "biggest first, the same order the snapshot has");
  assert.deepEqual((await b.get("/api/holders?offset=2300")).holders, third.holders, "2300 reads as the page that starts at 2000");
  assert.deepEqual((await b.get("/api/holders?offset=-7")).holders[0], first.holders[0]);
  assert.deepEqual((await b.get("/api/holders?offset=abc")).holders[0], first.holders[0]);
  const past = await b.get("/api/holders?offset=99000");
  assert.deepEqual([past.holders, past.more], [[], false]);
  delete env.VICINITY_MINT;
  assert.deepEqual(await b.get("/api/holders?offset=1000"), { launched: false, holders: [] }, "before launch the answer is the same as ever");
});
