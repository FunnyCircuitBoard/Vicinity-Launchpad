// Persistent identifiers never change with the rebrand (Citycoin.dev master v5, BR-01, stage S02; rebrand-inventory.md sections 3.3 and
// 3.4). Each value below is on chain, in a deployed build, in stored data, in a member's browser or in a signed text, so renaming it breaks
// something that already exists. If one of these tests fails, the change renamed a persistent identifier: put the old value back.
// The brand and site adapters (src/brand.js, src/site-config.js) must never feed any of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const wranglerText = read("wrangler.jsonc");
const wrangler = JSON.parse(wranglerText.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
/** `needle` occurs in the file at `path`, written exactly so. */
const pinned = (path, needle, why) => assert.ok(read(path).includes(needle), `${path} must keep ${JSON.stringify(needle)}${why ? ` (${why})` : ""}`);

/* ---------------------------------------------------------------- programs */
test("program IDs, program and crate names, IDL names and the mainnet release binaries are unchanged (P01)", () => {
  // the live mainnet programs (settings the Worker runs with)
  assert.equal(wrangler.vars.LAUNCHPAD_PROGRAM_ID, "AkMP9qvAYmb8Vyu63Qhw8Z4ee1fgQbCRKkXWy5r5A1Ai");
  assert.equal(wrangler.vars.LAUNCHPAD_REWARDS_PROGRAM_ID, "EVwxp3V9YSvsyDEjp39B9wRDQxHR2xF2CNeR8AMRYrgG");
  // the source and IDL ids (devnet builds) and the names compiled into the programs
  pinned("solana/programs/vicinity-launchpad/src/lib.rs", 'declare_id!("Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7");');
  pinned("solana/programs/vicinity-rewards/src/lib.rs", 'declare_id!("Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi");');
  pinned("solana/programs/vicinity-launchpad/Cargo.toml", 'name = "vicinity-launchpad"');
  pinned("solana/programs/vicinity-launchpad/Cargo.toml", 'name = "vicinity_launchpad"');
  pinned("solana/programs/vicinity-rewards/Cargo.toml", 'name = "vicinity-rewards"');
  pinned("solana/programs/vicinity-rewards/Cargo.toml", 'name = "vicinity_rewards"');
  const idl = (p) => JSON.parse(read(p));
  assert.deepEqual([idl("solana/sdk/idl/vicinity_launchpad.json").address, idl("solana/sdk/idl/vicinity_launchpad.json").metadata.name], ["Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7", "vicinity_launchpad"]);
  assert.deepEqual([idl("solana/sdk/idl/vicinity_rewards.json").address, idl("solana/sdk/idl/vicinity_rewards.json").metadata.name], ["Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi", "vicinity_rewards"]);
  // the verified mainnet release: the bytes and their published sums
  const rel = "solana/release/mainnet-2026-10-10/";
  const sums = { "vicinity_launchpad.so": "32906e19238372af42b6032275f2cceed9e998fac1a59eabad069bbeadc1621a", "vicinity_rewards.so": "8ab9b047d2c69317d7764c1dfd81bfee24bbdadea0ba605120120dc7c151219d" };
  for (const [f, h] of Object.entries(sums)) {
    assert.equal(sha256(readFileSync(new URL(rel + f, root))), h, `${rel}${f}`);
    pinned(`${rel}SHA256SUMS`, `${h}  ${f}`);
  }
});

test("the devnet launchpad id the Worker knows is unchanged", async () => {
  const { PROGRAM_IDS } = await import("../src/sol/pda.js");
  assert.equal(PROGRAM_IDS.launchpadDevnet, "Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7");
});

/* ---------------------------------------------------------------- metadata URLs and the legacy brand image */
test("the live coin metadata URI prefix https://vicinity.city/coin-meta/ is unchanged everywhere it is compiled or mirrored (P02, C05)", async () => {
  const PREFIX = "https://vicinity.city/coin-meta/";
  pinned("solana/programs/vicinity-launchpad/src/constants.rs", `pub const METADATA_URI_PREFIX: &str = "${PREFIX}";`, "compiled into the deployed program");
  const { LAYOUT } = await import("../src/sol/layout.js");
  assert.equal(LAYOUT.constants.METADATA_URI_PREFIX, PREFIX);
  const { VICINITY_BRAND } = await import("../src/coinmeta.js");
  assert.equal(VICINITY_BRAND.metadataPrefix, PREFIX);
  pinned("solana/sdk/launchpad/metadata.mts", `metadataPrefix: '${PREFIX}'`);
  // coin art written into coins of the live launchpad (src/coinart-store.js; rebrand-inventory.md U09 and C05)
  const { artUrl } = await import("../src/coinart-store.js");
  const sha = "ab".repeat(32);
  assert.equal(artUrl(sha), `${PREFIX}art/${sha}.png`);
});

test("/brand/vicinity-512.png keeps its path and bytes, and the frozen legacy brand and partner entry still name it (C04, C06, C07)", async () => {
  const png = new URL("public/brand/vicinity-512.png", root);
  assert.ok(existsSync(png), "public/brand/vicinity-512.png is named on chain (Meteora partner metadata) and must stay");
  assert.equal(sha256(readFileSync(png)), "c871c0f2a98c2cb105677835eaf741e9e7fa5e4d299b896c46d450709f597c37");
  const { VICINITY_BRAND } = await import("../src/coinmeta.js");
  assert.deepEqual({ ...VICINITY_BRAND }, { name: "Vicinity", site: "https://vicinity.city", logo: "https://vicinity.city/brand/vicinity-512.png", network: "Solana", metadataPrefix: "https://vicinity.city/coin-meta/" });
  const { VICINITY_PARTNER } = await import("../src/sol/lpadmin-ix.js");
  assert.deepEqual({ ...VICINITY_PARTNER }, { name: "Vicinity", website: "https://vicinity.city", logo: "https://vicinity.city/brand/vicinity-512.png" });
  pinned("solana/sdk/launchpad/metadata.mts", "logo: 'https://vicinity.city/brand/vicinity-512.png'");
});

/* ---------------------------------------------------------------- stored and API values */
test("stored and API enum values stay \"vicinity\" (P08), the rewards city tag stays vicinity:city:<id> (P09), the notice kind election stays (P12)", async () => {
  pinned("src/coin.js", 'kind: "vicinity", mint, pairMint: SOL, pair: "SOL", ticker: "VICINITY"');
  pinned("src/launchpad.js", 'kind: "vicinity", status: vicMint ? "live" : "upcoming"');
  pinned("src/portfolio.js", 'list.push({ kind: "vicinity", mint: live, symbol: "VICINITY", name: "Vicinity" });');
  pinned("src/swap.js", 'kind: "vicinity", stage: "jupiter"');
  pinned("src/coinart-store.js", '{ by: "vicinity", chosen: true }');
  pinned("src/coinreview.js", '["keep", "vicinity", "upload"].includes(b.picture)', "coin_requests.draft_picture values");
  pinned("src/coinreview.js", 'req.draft_picture === "vicinity"');
  pinned("src/lpadmin.js", '? "vicinity" : "founder" };', "descriptionBy");
  pinned("src/lpcoins.js", 'm.launchpad = "vicinity";');
  pinned("src/fees.js", "launchSplit: { vicinity: 100 - creationFeeProtocolPercent, meteora: creationFeeProtocolPercent }");
  for (const [f, word] of [["public/coin.js", '"vicinity"'], ["public/launchpad.js", '"vicinity"'], ["public/swap.js", '"vicinity"']]) pinned(f, word, "the page reads the API value");
  const { cityTag } = await import("../src/sol/lpadmin-ix.js");
  const tag = Buffer.from(cityTag("5128581"));
  assert.equal(tag.length, 32);
  assert.equal(tag.subarray(0, 21).toString("latin1"), "vicinity:city:5128581", "written into each vicinity_rewards CityConfig account");
  assert.ok(tag.subarray(21).every((x) => x === 0));
  const { KINDS } = await import("../src/notify.js");
  assert.deepEqual([...KINDS], ["reply", "moderation", "picture", "founder", "election"], "stored notice preferences are keyed by these");
});

/* ---------------------------------------------------------------- signed messages and hash domains */
test("the signed-message format and every wallet statement are unchanged (C08: accepted for the legacy window; P14: past digests)", async () => {
  const S = await import("../src/solana.js");
  assert.equal(S.MESSAGE_STATEMENT, "Verify wallet ownership for Vicinity. This is free, is not a transaction, and cannot move funds.");
  const FREE = "Free, not a transaction, cannot move funds.";
  assert.equal(S.statementFor("verify"), S.MESSAGE_STATEMENT);
  assert.equal(S.statementFor("claim", { cityId: "5128581", country: "US" }), `Claim city #5128581 (US) for this wallet on Vicinity. ${FREE}`);
  assert.equal(S.statementFor("add", { name: "Utica", country: "US" }), `Add the city "Utica" (US) and claim it for this wallet on Vicinity. ${FREE}`);
  assert.equal(S.statementFor("login"), `Sign in to Vicinity with this wallet. ${FREE}`);
  assert.equal(S.statementFor("login", { pin: "42" }), `Sign in to Vicinity on my other device (check number 42). ${FREE}`);
  assert.equal(S.statementFor("link", { handle: "ada" }), `Link this wallet to my Vicinity account @ada. ${FREE}`);
  assert.equal(S.statementFor("link", { handle: "ada", pin: "07" }), `Link this wallet to my Vicinity account @ada on my other device (check number 07). ${FREE}`);
  const msg = S.buildMessage({ host: "vicinity.city", address: "Wallet1111111111111111111111111111111111111", nonce: "n0nce", issuedAt: "2026-10-24T00:00:00.000Z", statement: S.statementFor("login") });
  assert.equal(msg, [
    "vicinity.city wants you to sign in with your Solana account:", "Wallet1111111111111111111111111111111111111", "",
    `Sign in to Vicinity with this wallet. ${FREE}`, "", "URI: https://vicinity.city", "Version: 1", "Chain ID: mainnet", "Nonce: n0nce",
    "Issued At: 2026-10-24T00:00:00.000Z",
  ].join("\n"));
});

test("hash domains stay vicinity-seat|, vicinity-election| and vicinity-supporter| (P07: past results stay reproducible)", async () => {
  pinned("src/seats.js", "sha256hex(`vicinity-seat|${w.id}|${x.wallet}`)");
  pinned("src/elections.js", "sha256hex(`vicinity-election|${e.id}|${c.wallet}`)");
  const { leafHash } = await import("../src/snapshot.js");
  assert.equal(await leafHash("snap-1", "Wallet1", "1000000", 2), sha256("vicinity-supporter|snap-1|Wallet1|1000000|2"), "Founding Supporters Merkle leaves");
});

/* ---------------------------------------------------------------- browser storage keys and cookies */
test("browser storage keys are unchanged (P10: renaming one forgets what a member's browser remembers)", () => {
  const KEYS = [
    ["public/site.js", "vicinity-account"], ["public/connect.js", "vicinity-account"], ["public/signup.js", "vicinity-account"], ["public/theme.js", "vicinity-account"],
    ["public/signup.js", "vicinity-carry"], ["public/signup.js", "vicinity-link"], ["public/site.js", "vicinity-link"],
    ["public/cities.js", "vicinity-map-card"], ["public/cities.js", "vicinity-map-style"], ["public/theme.js", "vicinity-motion"],
    ["public/connect.js", "vicinity-pair"], ["public/profile.js", "vicinity-profiles-notice"], ["public/site.js", "vicinity-terms-later"],
    ["public/theme.js", "vicinity-theme"], ["public/site.js", "vicinity.walletApp"], ["public/swap.js", "vicinity.walletApp"],
    ["public/swap.js", "vicinity.swapAuto"], ["public/swap.js", "vicinity.swapWallet"], ["public/dashboard.js", "vicinity:dash-v2"],
    ["public/dashboard-v2.js", "vicinity:dash-v2"], ["public/site.js", "vicinity:dash-v2"], ["public/dashboard.js", "vicinity:inapp-tip"],
    ["public/dashboard.js", "vicinity:wcard-skip"], ["public/admin-lp.js", "vicinity_lp_batch_one"], ["public/admin-lp.js", "vicinity_lp_pending"],
    ["public/site.js", "vicinity_terms"],
  ];
  for (const [f, k] of KEYS) pinned(f, `"${k}"`, "browser storage key");
});

test("cookie names are unchanged (P11 and the session cookies)", async () => {
  const { SESSION_COOKIE } = await import("../src/session.js");
  assert.equal(SESSION_COOKIE, "vs");
  const { PREVIEW_COOKIE } = await import("../src/admin.js");
  assert.equal(PREVIEW_COOKIE, "vicinity_preview_role");
  pinned("src/auth.js", 'const OAUTH_COOKIE = "vo";');
});

/* ---------------------------------------------------------------- resources and setting names */
test("Cloudflare resource names and the setting names stay (P03, P04, P06)", () => {
  assert.equal(wrangler.name, "vicinity-map");
  assert.deepEqual(wrangler.d1_databases.map((d) => [d.binding, d.database_name, d.database_id]), [["DB", "vicinity-claims", "e0e01286-ca8f-49dd-82c0-638fa24abb40"]]);
  pinned("src/index.js", 'json({ ok: true, service: "vicinity-map", milestone: 2 })', "/api/health");
  assert.ok(Object.hasOwn(wrangler.vars, "VICINITY_MINT"), "VICINITY_MINT keeps its name (it holds the legacy $VICINITY mint)");
  assert.equal(wrangler.vars.VICINITY_MINT, "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray");
});

/* ---------------------------------------------------------------- the adapters never feed a persistent identifier */
// Every module that makes a value pinned above (directly, or as the API's stored and enum values: src/swap.js, src/coin.js, src/launchpad.js
// and src/portfolio.js make `kind: "vicinity"`, the launchpad modules make the coin-meta URLs and the descriptions' "vicinity").
const PRODUCERS = ["src/coinmeta.js", "src/coinart-store.js", "src/sol/layout.js", "src/sol/lpadmin-ix.js", "src/sol/pda.js", "src/solana.js", "src/seats.js",
  "src/elections.js", "src/snapshot.js", "src/session.js", "src/admin.js", "src/auth.js", "src/notify.js", "src/swap.js", "src/coin.js", "src/launchpad.js",
  "src/portfolio.js", "src/coinreview.js", "src/lpadmin.js", "src/lpcoins.js", "src/fees.js", "public/site.js", "public/theme.js"];
const ADAPTERS = ["src/brand.js", "src/site-config.js", "src/footer-social.js"];
// The only imports of an adapter that a producer may reach, each with exactly the names it takes and why none of them feeds an identifier.
const ALLOWED_EDGES = {
  "src/mail.js>src/brand.js": ["brandOf"],                         // the display name of outgoing mail (senderName), a label
  "src/sources.js>src/site-config.js": ["USER_AGENT"],             // the User-Agent of outside calls, never stored or signed
  "src/swap.js>src/site-config.js": ["USER_AGENT"],                // the same User-Agent
  "src/v5policy.js>src/brand.js": ["brandOf"],                     // the MAIN_TOKEN_V5 check compares the label set's name; no label is read
  "src/v5policy.js>src/site-config.js": ["DEFAULT_SITE_ORIGIN", "DEFAULT_SITE_ORIGINS", "normalizeOrigin", "siteConfig"], // the configuration check
  // stage S04, session and challenge host binding (master section 05 BR-03 requires the session host, the challenge host and the hand-off
  // hosts to come from the configuration): the host a request is served as, looked up in the allowlist. It renames nothing pinned above: the
  // cookie names, the signed text's format and its single-use digest stay; with SITE_ORIGIN and SITE_ORIGINS unset every value is today's
  // (test/host-binding.test.js), and the only stored value it feeds is the new nullable host column (NULL = vicinity.city).
  "src/hostbind.js>src/site-config.js": ["DEFAULT_SITE", "LOCAL_HOST", "acceptedHost", "siteConfig"],
};
/** The relative modules a file imports (static import and export-from, and import()): [{ to, names }] (names null for a namespace or a call). */
function importsOf(file) {
  const text = read(file), out = [];
  const join = (rel) => new URL(rel, new URL(file, root)).pathname.slice(new URL(".", root).pathname.length);
  for (const m of text.matchAll(/^\s*(?:import|export)\s+([^;]*?)\s+from\s+["'](\.{1,2}\/[^"']+)["']/gm)) {
    const names = /^\{([\s\S]*)\}$/.test(m[1].trim()) ? m[1].trim().slice(1, -1).split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean) : null;
    out.push({ to: join(m[2]), names });
  }
  for (const m of text.matchAll(/import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) out.push({ to: join(m[1]), names: null });
  for (const m of text.matchAll(/^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm)) out.push({ to: join(m[1]), names: null });
  return out.filter((e) => existsSync(new URL(e.to, root)));
}

test("no module that makes a persistent identifier reaches the brand or site adapters, except through pinned label-only imports (review SEC-10)", () => {
  const seen = new Map(); // edge "a>b" -> names, for every edge into an adapter found from any producer
  for (const start of PRODUCERS) {
    const visited = new Set([start]), queue = [start];
    while (queue.length) {
      const f = queue.shift();
      if (ADAPTERS.includes(f)) continue; // an adapter's own imports are not a producer's
      for (const e of importsOf(f)) {
        if (ADAPTERS.includes(e.to)) {
          const key = `${f}>${e.to}`;
          assert.ok(Object.hasOwn(ALLOWED_EDGES, key), `${start} reaches ${e.to} through ${f}: not a pinned, label-only import`);
          assert.ok(e.names && e.names.every((n) => ALLOWED_EDGES[key].includes(n)), `${key} takes ${JSON.stringify(e.names)}, only ${ALLOWED_EDGES[key].join(", ")} is allowed`);
          seen.set(key, e.names);
        }
        if (!visited.has(e.to)) { visited.add(e.to); queue.push(e.to); }
      }
    }
  }
  // the walk is real: it finds the indirect routes (a producer through src/auth.js to src/mail.js, src/coinmeta.js through src/sources.js)
  assert.ok(seen.has("src/mail.js>src/brand.js") && seen.has("src/sources.js>src/site-config.js") && seen.has("src/swap.js>src/site-config.js"), JSON.stringify([...seen.keys()]));
  // and no producer imports an adapter itself, except src/swap.js for the User-Agent
  for (const f of PRODUCERS) {
    for (const e of importsOf(f)) if (ADAPTERS.includes(e.to)) assert.equal(`${f}>${e.to}`, "src/swap.js>src/site-config.js", `${f} imports ${e.to}`);
  }
  // the page footer's rewrite (src/footer-social.js) is the Worker entry's and the page build's only
  for (const f of ["src/index.js", "scripts/pages/build.mjs"]) assert.ok(importsOf(f).some((e) => e.to === "src/footer-social.js"), f);
});

test("BRAND and the site settings change no persistent identifier (an unknown BRAND keeps today's labels)", async () => {
  const { brandOf, LEGACY_BRAND } = await import("../src/brand.js");
  for (const BRAND of ["citycoin", "CityCoin", "x", "__proto__"]) {
    const b = brandOf({ BRAND });
    assert.equal(b.problem, "BRAND_UNKNOWN");
    assert.equal(b.productName, LEGACY_BRAND.productName);
  }
  const { siteConfig } = await import("../src/site-config.js");
  const s = siteConfig({ SITE_ORIGIN: "https://example.test", SITE_ORIGINS: "https://example.test https://vicinity.city" });
  assert.equal(s.origin, "https://example.test", "a fixture origin (clearly fake), not a real one");
  const { artUrl } = await import("../src/coinart-store.js");
  assert.ok(artUrl("cd".repeat(32)).startsWith("https://vicinity.city/coin-meta/art/"), "live-launchpad coin art never follows SITE_ORIGIN");
});
