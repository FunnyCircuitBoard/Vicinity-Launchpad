// docs/OWNER-LAUNCH-GUIDE.md is what the owner follows on his Mac and on the website; this keeps it true to the code: the step
// the admin tab points to ("the guide's step 10"), the website step titles, the exact deploy commands, the dev wallet, the
// mainnet genesis hash, the rent figures (which build-mainnet.sh and the audit records must agree with), and the "never send
// anyone" box. The build script's pins must equal the audited records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADDRESSES } from "../src/sol/pda.js";
import { STEPS } from "../src/lpadmin.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const guide = read("docs/OWNER-LAUNCH-GUIDE.md");
const build = read("solana/scripts/launchpad/build-mainnet.sh");
const DEV = ADDRESSES.feeRecipient;
const section = (heading) => { const at = guide.indexOf(heading); assert.ok(at >= 0, heading); const next = guide.indexOf("\n### ", at + 1); return guide.slice(at, next < 0 ? undefined : next); };

test("guide: step 10 is the hand-over to Phantom the admin tab points to; steps 1 to 14 are in order", () => {
  for (const f of ["src/lpadmin.js", "public/admin-lp.js"]) assert.match(read(f), /the guide's step 10/, `${f} still points to step 10`);
  const s10 = section("### Step 10.");
  assert.match(s10, new RegExp(`solana program set-upgrade-authority <rewards address> --new-upgrade-authority ${DEV} --skip-new-upgrade-authority-signer-check`));
  assert.match(s10, new RegExp(`solana program set-upgrade-authority <launchpad address> --new-upgrade-authority ${DEV} --skip-new-upgrade-authority-signer-check`));
  assert.match(s10, new RegExp(`solana transfer ${DEV} ALL`));
  const order = [...guide.matchAll(/^### Step (\d+)\./gm)].map((m) => Number(m[1]));
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  // every Terminal block from step 2 on starts in the keys folder (a new Terminal window, a restart, another day), and the
  // downloaded files get there with one command
  const blocks = [...guide.slice(guide.indexOf("### Step 3.")).matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1].replace(/^ +/gm, ""))
    .filter((b) => /solana |shasum /.test(b) && !/^(solana (config set|address|balance)|mv )/.test(b)); // these need no folder
  assert.ok(blocks.length >= 7);
  for (const b of blocks) assert.match(b, /^cd ~\/vicinity-keys\n/, b);
  assert.match(section("### Step 6."), /mv ~\/Downloads\/vicinity_launchpad\.so ~\/Downloads\/vicinity_rewards\.so ~\/Downloads\/SHA256SUMS ~\/vicinity-keys\//);
});

test("guide: the website steps carry the admin tab's own titles, in its order", () => {
  const src = read("src/lpadmin.js");
  const titles = STEPS.map((id) => { const m = new RegExp(`\\b${id}: "([^"]+)"`).exec(src); assert.ok(m, id); return m[1]; });
  const rows = [...section("### Step 12.").matchAll(/^\| (\d)\. ([^|]+?) \|/gm)].map((m) => [Number(m[1]), m[2]]);
  // the words the page itself uses, and the message-signing prompt explained before anyone meets it
  assert.match(section("### Step 12."), /Program loader \(upgradeable\): hand over control of a program \(set_authority\)/);
  assert.match(read("src/lpkit.js"), /\[PROGRAM_IDS\.upgradeableLoader\]: "Program loader \(upgradeable\)"/);
  assert.match(read("src/lpkit.js"), /set_authority: "hand over control of a program"/);
  assert.match(read("src/lpadmin.js"), /"your Squads vault \(the new upgrade authority\)"/);
  assert.ok(section("### Step 12.").includes("your Squads vault (the new upgrade authority)"));
  assert.match(section("### Step 12."), /\*\*sign a message\*\* \(no SOL moves, nothing is sent\)/);
  assert.deepEqual(rows, titles.map((t, i) => [i + 1, t]));
  assert.match(guide, /\*\*Prepare step N\*\*/); assert.match(guide, /\*\*Approve in your wallet\*\*/); assert.match(guide, /\*\*Done and recorded\.\*\*/);
  for (const label of ["Approve on chain", "Collect city fees", "Set up holder rewards", "Forward holders' share", "Pause launches", "Resume launches", "Check", "Copy"]) {
    assert.match(read("public/admin-lp.js"), new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `the tab has a button "${label}"`);
    assert.ok(guide.includes(label), `the guide names "${label}"`);
  }
});

test("guide: the deploy commands, rewards first, each with its own program and buffer key and the resumable flags", () => {
  const s8 = section("### Step 8.");
  const flags = "--use-rpc --with-compute-unit-price 50000 --max-sign-attempts 100";
  const rw = s8.indexOf(`solana program deploy vicinity_rewards.so --program-id rewards-program.json --buffer rewards-buffer.json ${flags}`);
  const lp = s8.indexOf(`solana program deploy vicinity_launchpad.so --program-id launchpad-program.json --buffer launchpad-buffer.json ${flags}`);
  assert.ok(rw > 0 && lp > rw, "rewards, then the launchpad");
  assert.doesNotMatch(s8, /--max-len/, "CLI 4.3 sizes the program to the file");
  for (const f of ["deployer", "launchpad-program", "rewards-program", "launchpad-buffer", "rewards-buffer"]) assert.match(section("### Step 2."), new RegExp(`solana-keygen new --no-bip39-passphrase -o ${f}\\.json`));
  assert.match(section("### Step 1."), /sh -c "\$\(curl -sSfL https:\/\/release\.anza\.xyz\/v4\.3\.0\/install\)"/);
  assert.match(section("### Step 6."), /5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d/);
  assert.match(read("scripts/mainnet-preflight.mjs"), /MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"/);
  assert.match(section("### Step 6."), /shasum -a 256 -c SHA256SUMS/);
  // --use-rpc sends every upload through step 4's RPC: a paid ("staked") plan, never the free one (1 upload per second)
  assert.match(section("### Step 4."), /\*\*Developer\*\* plan/);
  // before running a deploy again, the owner checks it did not land already (a re-run of a landed deploy is an upgrade)
  assert.match(s8, /solana program show <the address of the program you were deploying>/);
  assert.match(s8, /Data Length: 505864` \(rewards\) or `Data Length: 433960` \(launchpad\)/);
  assert.match(s8, /Blockhash expired/);
});

test("guide: the rent adds up, equals the measured rate for the audited sizes, and build-mainnet.sh pins the audited records", () => {
  const lamports = (sol) => Math.round(Number(sol) * 1e9);
  const rate = Number(/RENT_LAMPORTS_PER_BYTE=(\d+)/.exec(build)[1]);
  const lpSize = Number(/EXPECTED_LAUNCHPAD_SIZE=(\d+)/.exec(build)[1]), rwSize = Number(/EXPECTED_REWARDS_SIZE=(\d+)/.exec(build)[1]);
  const rent = (bytes) => (bytes + 128) * rate;
  assert.equal(rent(rwSize + 45), lamports("2.57066796")); assert.equal(rent(lpSize + 45), lamports("2.20539564")); assert.equal(rent(36), lamports("0.00083312"));
  assert.equal(lamports("2.57066796") + lamports("2.20539564") + 2 * lamports("0.00083312"), lamports("4.77772984"));
  for (const v of ["2.57066796", "2.20539564", "0.00083312", "4.77772984", "5.0", "5.1"]) assert.ok(guide.includes(v), v);
  // the deployer amount survives `solana program deploy`'s up-front check of BOTH deploys, measured on devnet with CLI 4.3.0 and
  // an empty payer (nothing sent): at --with-compute-unit-price 50000 "insufficient funds for spend (2.57066796 SOL) + fee
  // (0.039685 SOL)" for the rewards file and "(2.20539564 SOL) + fee (0.034135 SOL)" for the launchpad file (at 200000 the fees
  // were 0.150775 and 0.129685); each deploy really spends about 0.003 SOL. The check grows with the priority fee.
  const send = lamports(/\| \*\*send to the deployer in step 7\*\* \| \*\*([0-9.]+)\*\*/.exec(guide)[1]);
  const checkRw = lamports("2.57066796") + lamports("0.039685"), checkLp = lamports("2.20539564") + lamports("0.034135");
  const spentRw = lamports("2.57066796") + lamports("0.00083312") + lamports("0.003");
  assert.ok(send >= checkRw, "the rewards deploy (first) passes its check");
  assert.ok(send - spentRw >= checkLp + lamports("0.05"), "the launchpad deploy (second) passes its check after the rewards deploy, with room to spare");
  assert.match(section("### Step 7."), /Send 4\.9 SOL to the deployer/);
  // the whole budget: Phantom starts with 5.0; the deployer gets `send`; what comes back pays Squads (0.1 fee + accounts) and
  // the website steps, and something is left
  const spentAll = lamports("4.77772984") + lamports("0.006");
  const back = send - spentAll;
  const phantomAfter = lamports("5.0") - send + back - lamports("0.103") - lamports("0.02") - lamports("0.0016");
  assert.ok(phantomAfter > lamports("0.05"), `about ${phantomAfter / 1e9} SOL left in Phantom after the first approval`);
  assert.match(guide, /Squads charges a one-time deployment fee\s+of 0\.1 SOL/);
  assert.match(guide, /\| creating the Squads multisig \(step 11\) \| about 0\.103/);
  assert.doesNotMatch(guide.slice(guide.indexOf("## Part 1"), guide.indexOf("## Part 2")), /app\.squads\.so|Create a Squad/, "no money moves in part 1: the Squad is made in step 11");
  assert.match(section("### Step 9."), new RegExp(`\`${rwSize} \\(0x${rwSize.toString(16)}\\) bytes\``));
  assert.match(section("### Step 9."), new RegExp(`\`${lpSize} \\(0x${lpSize.toString(16)}\\) bytes\``));
  // the audited fingerprints the build reproduces first are the recorded ones
  const lpSha = /AUDITED_LAUNCHPAD_SHA256="([0-9a-f]{64})"/.exec(build)[1], rwSha = /AUDITED_REWARDS_SHA256="([0-9a-f]{64})"/.exec(build)[1];
  assert.ok(read("solana/LAUNCHPAD-AUDIT.md").includes(lpSha)); assert.ok(read("solana/AUDIT.md").includes(rwSha));
  assert.match(read("solana/scripts/launchpad/deploy-devnet.sh"), new RegExp(`EXPECTED_SHA256:-${lpSha}`));
  assert.ok(read("solana/LAUNCHPAD-AUDIT.md").includes(`${lpSize.toLocaleString("en-US")} bytes`)); assert.ok(read("solana/AUDIT.md").includes(`${rwSize.toLocaleString("en-US")}`));
  assert.match(build, /PIN_CARGO_BUILD_SBF="4\.4\.0"/); assert.match(build, /PIN_PLATFORM_TOOLS="v1\.57"/);
  assert.match(read("solana/AUDIT.md"), /cargo-build-sbf \/ platform-tools \| 4\.4\.0 \/ v1\.57/);
  // no line of the script runs anchor (keys sync, build, deploy): comments and quoted text aside, the word never starts a command
  const code = build.split("\n").filter((l) => !/^\s*(#|\/\/)/.test(l)).map((l) => l.replace(/"[^"]*"|'[^']*'/g, "''"));
  assert.deepEqual(code.filter((l) => /(^|[;&|(]\s*)anchor\s/.test(l.trim())), [], "no anchor command runs");
});

test("guide: the never-send box, and only public addresses go out", () => {
  const box = guide.slice(guide.indexOf("> **Never send anyone"), guide.indexOf("How to paste a command"));
  for (const w of ["`.json` key file", "12 words", "recovery phrase or private key", "public addresses", "box from website step 8"]) assert.ok(box.includes(w), w);
  assert.match(section("### Step 3."), /solana-keygen pubkey deployer\.json\nsolana-keygen pubkey launchpad-program\.json\nsolana-keygen pubkey rewards-program\.json/);
  assert.match(section("### Step 11."), /\*\*Multisig account\*\* \(not the one labelled Vault\)/);
  assert.match(section("### Step 11."), /Threshold \(approvals needed\): \*\*2\*\*/);
});
