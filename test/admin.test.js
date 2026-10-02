// The admin console's readiness numbers: admins only, yes/no and counts, never a secret's value.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { IN_UTICA, MINT, browser, newWorld, person, realClock, useClock } from "./helpers/world.js";

let env;
beforeEach(() => { useClock("2026-10-01T12:00:00Z"); env = newWorld(); });
after(() => realClock());

test("admin status: only admins; says which launch settings are missing, in plain words", async () => {
  const admin = await person(env, { home: IN_UTICA });
  const member = await person(env, { home: IN_UTICA });
  env.ADMIN_WALLETS = admin.w.address;

  assert.equal((await browser(env).get("/api/admin/status")).error, "sign_in");
  assert.equal((await member.get("/api/admin/status")).error, "not_allowed");

  const s = await admin.get("/api/admin/status");
  assert.equal(s.ok, true);
  assert.equal(s.launched, false);
  const by = Object.fromEntries(s.checks.map((c) => [c.id, c]));
  assert.equal(by.mint.ok, false);
  assert.match(by.mint.fix, /VICINITY_MINT/);
  assert.equal(by.rpc.ok, false);
  assert.match(by.rpc.fix, /SOLANA_RPC_URL/);
  assert.equal(by.admins.ok, true);
  assert.equal(by.google.ok, true, "the test world has Google set up");
  assert.equal(by.x.ok, false);
  assert.match(by.x.fix, /X_CLIENT_ID/);
  assert.equal(by.cutoff.ok, false);
  assert.equal(by.sampling.ok, true, "not needed before launch");
  assert.equal(s.counts.users, 2);
  assert.equal(s.counts.homes, 2);
});

test("admin status never reveals a secret's value", async () => {
  const admin = await person(env, { home: IN_UTICA });
  Object.assign(env, { ADMIN_WALLETS: admin.w.address, SOLANA_RPC_URL: "https://rpc.example/api-key-q7Zv1", X_CLIENT_ID: "xid-q7Zv2",
    X_CLIENT_SECRET: "xsec-q7Zv3", GOOGLE_CLIENT_SECRET: "gsec-q7Zv4", VICINITY_MINT: MINT, SNAPSHOT_CUTOFF: "2026-10-08T00:00:00Z", ATTEST_KEY: "attest-q7Zv5" });
  const res = await admin.send("/api/admin/status");
  const text = await res.text();
  assert.equal(/q7Zv|rpc\.example/.test(text), false, "only yes / no: no value of any setting is ever sent");
  const s = JSON.parse(text);
  const by = Object.fromEntries(s.checks.map((c) => [c.id, c]));
  assert.deepEqual([by.mint.ok, by.rpc.ok, by.x.ok, by.cutoff.ok], [true, true, true, true]);
  assert.equal(s.snapshotCutoff, "2026-10-08T00:00:00.000Z");
});
