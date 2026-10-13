// The owner's wallet 13qRam…sRiN created $VICINITY and holds a large share: it is listed publicly as a team wallet, so the
// checker, the holder list and the supporter snapshot all treat it as the team's (5 Oct 2026, at the owner's request).
import { test } from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL, checkOfficial } from "../src/official.js";
import { isSolanaAddress } from "../src/solana.js";

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
