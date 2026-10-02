import { test } from "node:test";
import assert from "node:assert/strict";
import { d1 } from "./helpers/d1.js";
import { autoUsername } from "../src/text.js";
import { ensureSchema } from "../src/store.js";

test("auto usernames are well-formed and unique", async () => {
  const db = d1();
  await ensureSchema(db);
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const u = await autoUsername(db);
    assert.match(u, /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/, `well-formed: ${u}`);
    assert.ok(!seen.has(u), `unique: ${u}`);
    seen.add(u);
    await db.prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES (?,?,?,?,?)")
      .bind(`w${i}`, "wallet", `w${i}`, u, new Date().toISOString()).run();
  }
  // never returns a name that's taken, even after many users exist
  const last = await autoUsername(db);
  assert.ok(!seen.has(last));
});

test("auto usernames compare case-insensitively, like the unique index does", async () => {
  const db = d1();
  await ensureSchema(db);
  await db.prepare("INSERT INTO users (wallet, provider, provider_id, handle, created_at) VALUES ('w1', 'wallet', 'w1', 'swiftharbor10', ?)").bind(new Date().toISOString()).run();
  const real = Math.random;
  let calls = 0;
  Math.random = () => (calls++ < 3 ? 0 : 0.5); // the first draw is SwiftHarbor10
  try {
    const name = await autoUsername(db);
    assert.notEqual(name.toLowerCase(), "swiftharbor10");
    assert.match(name, /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/);
  } finally { Math.random = real; }
});
