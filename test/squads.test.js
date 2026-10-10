// Squads v4 multisigs as the admin "City coins" tab reads them (src/sol/squads.js): the decoder and the vault PDA against
// @sqds/multisig 2.1.4 (test/fixtures/squads/vectors.json, made in a scratch directory; the SDK is never a repo dependency) and
// against one real mainnet multisig read read-only; then what the hand-over step accepts and refuses, in plain words.
// SQUADS_LIVE=1 also reads the mainnet multisig again from the public RPC (read only) and checks it still decodes the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MULTISIG_DISCRIMINATOR, SQUADS_V4_PROGRAM, checkMultisig, decodeMultisig, vaultAddress } from "../src/sol/squads.js";

const V = JSON.parse(readFileSync(new URL("./fixtures/squads/vectors.json", import.meta.url), "utf8"));
const asAccount = (v, data = v.data) => ({ owner: v.owner, data: [data, "base64"], executable: false });
const plain = (m) => ({
  createKey: m.createKey, configAuthority: m.configAuthority, threshold: m.threshold, timeLock: m.timeLock,
  transactionIndex: m.transactionIndex.toString(), staleTransactionIndex: m.staleTransactionIndex.toString(), rentCollector: m.rentCollector, bump: m.bump,
  members: m.members.map((x) => ({ key: x.key, mask: x.mask })),
});

test("the program id and the account discriminator are Squads v4's", () => {
  assert.equal(SQUADS_V4_PROGRAM, V.programId);
  assert.deepEqual([...MULTISIG_DISCRIMINATOR], V.discriminator);
});

test("every vector decodes exactly as @sqds/multisig decodes it, and its vaults are the SDK's getVaultPda", async () => {
  for (const v of [...V.synthetic, V.mainnet]) {
    const m = decodeMultisig(asAccount(v));
    assert.ok(m, v.address);
    const { vaults, ...want } = v.expected;
    assert.deepEqual(plain(m), want, v.address);
    assert.deepEqual(await Promise.all([0, 1, 2, 255].map((i) => vaultAddress(v.address, i))), vaults, v.address);
  }
});

test("a real mainnet multisig (read read-only): 2 of 8, no config authority; its vault 0", async () => {
  const r = await checkMultisig(V.mainnet.address, asAccount(V.mainnet));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.threshold, r.members.length, r.vault], [2, 8, V.mainnet.expected.vaults[0]]);
  assert.match(r.says, new RegExp(`^2 of 8: .*; vault ${r.vault}$`));
});

test("what the hand-over refuses, in plain words; what it accepts", async () => {
  const [good, oneOfTwo, controlled, padded, fewVoters] = V.synthetic;
  const ok = await checkMultisig(good.address, asAccount(good));
  assert.deepEqual([ok.ok, ok.threshold, ok.voters, ok.vault, ok.warnings], [true, 2, 3, good.expected.vaults[0], []]);
  assert.equal((await checkMultisig(padded.address, asAccount(padded))).ok, true, "an account with room for more members");
  const no = async (address, account) => checkMultisig(address, account);
  assert.equal((await no("nope", null)).error, "bad_address");
  assert.equal((await no(good.address, null)).error, "not_found");
  const wallet = await no(good.expected.vaults[0], { owner: "11111111111111111111111111111111", data: ["", "base64"] });
  assert.equal(wallet.error, "not_multisig");
  assert.match(wallet.message, /wallet or a Squads vault, not the multisig account/);
  assert.match((await no(good.address, { ...asAccount(good), owner: "Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7" })).message, /another program/);
  const other = Buffer.from(good.data, "base64"); other[0] ^= 1;
  assert.match((await no(good.address, asAccount(good, other.toString("base64")))).message, /not the multisig itself/);
  const cut = Buffer.from(good.data, "base64").subarray(0, 150);
  assert.equal((await no(good.address, asAccount(good, cut.toString("base64")))).error, "not_multisig", "cut short");
  assert.match((await no(oneOfTwo.address, asAccount(oneOfTwo))).message, /needs only 1 approval/);
  assert.match((await no(controlled.address, asAccount(controlled))).message, /config authority/);
  assert.match((await no(fewVoters.address, asAccount(fewVoters))).message, /Only 1 member can vote but 2 approvals are needed/);
  // a time lock is allowed but said
  const tl = Buffer.from(good.data, "base64"); tl.writeUInt32LE(3600, 74);
  assert.deepEqual((await checkMultisig(good.address, asAccount(good, tl.toString("base64")))).warnings, ["Each approved change waits 3600 seconds before it can run (the multisig's time lock)."]);
});

test("live (SQUADS_LIVE=1): the mainnet multisig read again from the public RPC decodes the same way", { skip: !process.env.SQUADS_LIVE }, async () => {
  const r = await fetch("https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [V.mainnet.address, { encoding: "base64" }] }) });
  const v = (await r.json()).result.value;
  const m = decodeMultisig(v);
  assert.equal(v.owner, SQUADS_V4_PROGRAM);
  assert.deepEqual([m.threshold, m.createKey], [V.mainnet.expected.threshold, V.mainnet.expected.createKey]);
});
