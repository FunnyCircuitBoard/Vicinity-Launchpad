// The owner's wallet 13qRam…sRiN created $VICINITY and holds a large share: it is listed publicly as a team wallet, so the
// checker, the holder list and the supporter snapshot all treat it as the team's (5 Oct 2026, at the owner's request). The team's
// FOMO account 8dQ5Rb…CxP5 joined it on 13 Oct 2026, and is named in brackets (the owner: "mention the fomo team wallet as fomo in
// [parenthesis]"): "Team wallet (FOMO)" in the holder list, "the team's FOMO account" in the checker's answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL, TEAM_WALLET_NAMES, checkOfficial, teamWalletLabel } from "../src/official.js";
import { isSolanaAddress } from "../src/solana.js";
import { browser, newWorld } from "./helpers/world.js";

const OWNER = "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN";
const FOMO = "8dQ5Rb2Y7jYWCEgyKKVMrhboEgMFvFXKNZw1KBeCxP5"; // the team's FOMO account, listed 13 Oct 2026
const MINT = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";

test("the listed team wallets: the owner's creator wallet first, then the team's FOMO account", () => {
  assert.deepEqual(OFFICIAL.teamWallets, [OWNER, FOMO]);
  assert.ok(isSolanaAddress(OWNER) && isSolanaAddress(FOMO));
});

test("the checker calls it an official team wallet, and still calls any other wallet not official", () => {
  const env = { VICINITY_MINT: MINT };
  assert.deepEqual(
    [checkOfficial(OWNER, isSolanaAddress, env).verdict, checkOfficial(OWNER, isSolanaAddress, env).kind],
    ["official", "wallet"]);
  assert.deepEqual([checkOfficial(FOMO, isSolanaAddress, env).verdict, checkOfficial(FOMO, isSolanaAddress, env).kind], ["official", "wallet"]);
  assert.equal(checkOfficial("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", isSolanaAddress, env).verdict, "not_official");
  assert.equal(checkOfficial(MINT, isSolanaAddress, env).kind, "contract");
});

test("the labels: the FOMO account is 'Team wallet (FOMO)', the owner's wallet (and any other listed one) 'Team wallet (public)'", () => {
  assert.equal(teamWalletLabel(FOMO), "Team wallet (FOMO)");
  assert.equal(teamWalletLabel(OWNER), "Team wallet (public)");
  assert.equal(teamWalletLabel("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), "Team wallet (public)", "a wallet without a name of its own");
  assert.equal(teamWalletLabel("constructor"), "Team wallet (public)", "only the names written in official.js, nothing inherited");
  // every name belongs to a listed wallet, and every label still starts "Team wallet" (the pages' /^Team wallet/ finds the row)
  for (const a of Object.keys(TEAM_WALLET_NAMES)) assert.ok(OFFICIAL.teamWallets.includes(a), a);
  for (const a of OFFICIAL.teamWallets) assert.match(teamWalletLabel(a), /^Team wallet \((public|FOMO)\)$/);
  // the list itself stays plain addresses: every caller asks it .includes(address)
  assert.ok(OFFICIAL.teamWallets.every((w) => typeof w === "string"));
});

test("the checker names the FOMO account: 'This is a published Vicinity team wallet (the team's FOMO account).'", async () => {
  const env = { VICINITY_MINT: MINT };
  assert.deepEqual(checkOfficial(FOMO, isSolanaAddress, env),
    { verdict: "official", kind: "wallet", message: "This is a published Vicinity team wallet (the team's FOMO account)." });
  assert.deepEqual(checkOfficial(OWNER, isSolanaAddress, env),
    { verdict: "official", kind: "wallet", message: "This is a published Vicinity team wallet." }, "the owner's wallet: as before");
  assert.equal(checkOfficial(` ${FOMO} `, isSolanaAddress, {}).message, "This is a published Vicinity team wallet (the team's FOMO account).", "before the contract is set too");
  // through the route the token page's checker asks; /api/official is unchanged (the names are not a key of it)
  const b = browser(newWorld(env));
  assert.deepEqual(await b.get(`/api/check?q=${FOMO}`), { verdict: "official", kind: "wallet", message: "This is a published Vicinity team wallet (the team's FOMO account)." });
  const o = await b.get("/api/official");
  assert.deepEqual(o.teamWallets, [OWNER, FOMO]);
  assert.ok(!Object.keys(o).some((k) => /name/i.test(k)));
});
