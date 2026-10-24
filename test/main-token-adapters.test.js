// Owner amendment 01 (Citycoin.dev master v5, stage S02A): the MAIN_TOKEN_V5 switch, the adapters mainMint / officialLinks (src/maintoken.js),
// tokenMint / teamFor / socialProfiles (src/official.js), the configuration check, and the footer's social links from one source for the
// page build and the Worker's response-time rewrite (src/footer-social.js). With the switch unset everything is today's, byte for byte.
// The switch counts only while every precondition holds (src/v5policy.js mainTokenV5, test/main-token-gate.test.js); this file stands in
// for a page build made with it (test/helpers/mainswitch.js) and gives the settings the configuration checks accept (ACCEPTED).
// Every mint, handle and channel below is a clearly fake test fixture: the owner has supplied none of the three values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mainTokenV5On } from "../src/flags.js";
import { LEGACY_MINTS, LEGACY_X_URL, MAIN_TOKEN_LABEL, _resetDeploymentCheck, checkDeploymentConfig, mainMint, mainTokenFeatures, mainTokenStatus, officialLinks } from "../src/maintoken.js";
import { NO_TEAM, OFFICIAL, SOCIAL_PROFILES, TEAM, activeMint, socialProfiles, teamFor, tokenMint } from "../src/official.js";
import { escBrand, officialLinksInPage, rewriteSocialLinks, socialItems, socialList } from "../src/footer-social.js";
import { LEGACY_BRAND, brandLabels } from "../src/brand.js";
import { buildPages, buildStandalonePages, pageSocials } from "../scripts/pages/build.mjs";
import worker from "../src/index.js";
import { ACCEPTED, pagesBuiltWithSwitch } from "./helpers/mainswitch.js";

pagesBuiltWithSwitch();

// clearly fake test fixtures (valid shapes only; never a real mint, account or channel)
const FAKE_MINT = "FakeMainTokenMint111111111111111111111111111";
const FAKE_X = "https://x.com/ZqFakeTestX", FAKE_TG = "https://t.me/zq_fake_test_tg";
const OTHER_FAKE = "FakeMainTokenMint11111111111111111111111111";
const LEGACY = "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray";
const ON = ACCEPTED; // the switch with the settings the checks need; it counts once MAIN_TOKEN_MINT is accepted too
const RAW_ON = { MAIN_TOKEN_V5: "on" };
const L = brandLabels(escBrand(LEGACY_BRAND));
const PAGES = readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html")).sort();
const page = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

test("MAIN_TOKEN_V5 follows the flag rule: exactly \"on\" (trimmed, any letter case); anything else, unset included, is off", () => {
  for (const v of ["on", "ON", " On ", "\ton\n"]) assert.equal(mainTokenV5On({ MAIN_TOKEN_V5: v }), true, JSON.stringify(v));
  for (const v of [undefined, null, "", " ", "off", "yes", "true", "1", "onn", "o n", "enabled"]) assert.equal(mainTokenV5On({ MAIN_TOKEN_V5: v }), false, JSON.stringify(v));
  assert.equal(mainTokenV5On({}), false);
  assert.equal(mainTokenV5On(null), false);
  assert.equal(mainTokenV5On(undefined), false);
});

test("mainMint reads MAIN_TOKEN_MINT only: never VICINITY_MINT, never the legacy mint, never a malformed or all-zero key", () => {
  _resetDeploymentCheck();
  assert.equal(mainMint({ VICINITY_MINT: LEGACY }), null, "VICINITY_MINT is never read");
  assert.equal(mainMint({ VICINITY_MINT: FAKE_MINT }), null, "not even a valid key in VICINITY_MINT");
  assert.equal(mainMint({ MAIN_TOKEN_MINT: FAKE_MINT, VICINITY_MINT: LEGACY }), FAKE_MINT);
  assert.equal(mainMint({ MAIN_TOKEN_MINT: `  ${FAKE_MINT} ` }), FAKE_MINT, "trimmed");
  for (const bad of [LEGACY, "", "   ", "11111111111111111111111111111111", "not-a-mint", "0OIl" + FAKE_MINT.slice(4), FAKE_MINT + "1", 42, {}, []])
    assert.equal(mainMint({ MAIN_TOKEN_MINT: bad }), null, JSON.stringify(bad));
  assert.deepEqual([...LEGACY_MINTS], [LEGACY]);
  assert.equal(MAIN_TOKEN_LABEL, "Main token");
  // the memo follows the value
  assert.equal(mainMint({ MAIN_TOKEN_MINT: OTHER_FAKE }), OTHER_FAKE);
  assert.equal(mainMint({ MAIN_TOKEN_MINT: FAKE_MINT }), FAKE_MINT);
});

test("officialLinks: normalized configured links, the legacy X account refused, an unset or malformed link is null (not shown)", () => {
  assert.deepEqual({ ...officialLinks({}) }.xUrl, null);
  const l = officialLinks({ OFFICIAL_X_URL: "https://twitter.com/ZqFakeTestX/", OFFICIAL_TELEGRAM_URL: `${FAKE_TG}/` });
  assert.equal(l.xUrl, FAKE_X);
  assert.equal(l.telegramUrl, FAKE_TG);
  for (const legacy of [LEGACY_X_URL, "https://x.com/vicinitycitysol", "https://twitter.com/VICINITYCITYSOL"]) {
    const r = officialLinks({ OFFICIAL_X_URL: legacy });
    assert.equal(r.xUrl, null, legacy);
    assert.equal(r.problems.xUrl, "LEGACY_SOCIAL_LINK_AS_OFFICIAL");
  }
  for (const bad of ["http://x.com/ZqFakeTestX", "https://x.com/home", "https://x.com/a/b", "https://x.com/ZqFakeTestX?x=1", "javascript:alert(1)", "https://t.me/+abc"]) {
    const r = officialLinks({ OFFICIAL_X_URL: bad, OFFICIAL_TELEGRAM_URL: bad });
    assert.equal(r.xUrl, null, bad);
    assert.equal(r.telegramUrl, null, bad);
  }
});

test("tokenMint: switch not counting = activeMint exactly (VICINITY_MINT); counting = mainMint; an unset or refused mint keeps it from counting", () => {
  for (const env of [{}, { VICINITY_MINT: LEGACY }, { VICINITY_MINT: FAKE_MINT }, { VICINITY_MINT: "" }, { VICINITY_MINT: LEGACY, MAIN_TOKEN_MINT: FAKE_MINT },
    { VICINITY_MINT: LEGACY, MAIN_TOKEN_V5: "yes", MAIN_TOKEN_MINT: FAKE_MINT },
    { ...RAW_ON, VICINITY_MINT: LEGACY, MAIN_TOKEN_MINT: FAKE_MINT }, // no environment named, legacy seats not frozen: refused
    { ...ON, VICINITY_MINT: LEGACY }, { ...ON, VICINITY_MINT: LEGACY, MAIN_TOKEN_MINT: LEGACY }, { ...ON, VICINITY_MINT: LEGACY, MAIN_TOKEN_MINT: "garbage" }])
    assert.equal(tokenMint(env), activeMint(env), `${JSON.stringify(env)}: today's mint, never "not launched" (review finding SWON-4)`);
  assert.equal(tokenMint({ ...ON, VICINITY_MINT: LEGACY, MAIN_TOKEN_MINT: FAKE_MINT }), FAKE_MINT);
});

test("teamFor: the published team wallets and the Jupiter Lock label every list as before, except the new main token's list under the switch", () => {
  assert.deepEqual([...TEAM.wallets], OFFICIAL.teamWallets);
  assert.equal(TEAM.locks, OFFICIAL.teamLocks);
  for (const m of [LEGACY, FAKE_MINT, OTHER_FAKE, null]) assert.equal(teamFor({ VICINITY_MINT: LEGACY, MAIN_TOKEN_MINT: FAKE_MINT }, m), TEAM, "off: always today's");
  const on = { ...ON, VICINITY_MINT: LEGACY, MAIN_TOKEN_MINT: FAKE_MINT };
  assert.equal(teamFor(on, FAKE_MINT), NO_TEAM, "the new main token's holders: no $VICINITY team fact");
  assert.equal(teamFor(on, OTHER_FAKE), TEAM, "a city coin keeps them");
  assert.equal(teamFor(on, LEGACY), TEAM, "the legacy token keeps its own facts");
  assert.deepEqual([...NO_TEAM.wallets, ...NO_TEAM.locks], []);
});

test("socialProfiles: today's list while the switch does not count; while it counts only the configured, checked links; the legacy account never", () => {
  const ONM = { ...ON, MAIN_TOKEN_MINT: FAKE_MINT };
  assert.equal(socialProfiles({}), SOCIAL_PROFILES);
  assert.equal(socialProfiles({ OFFICIAL_X_URL: FAKE_X }), SOCIAL_PROFILES, "a value without the switch changes nothing");
  assert.equal(socialProfiles({ ...ON, OFFICIAL_X_URL: FAKE_X }), SOCIAL_PROFILES, "no main token configured: the switch does not count");
  assert.equal(socialProfiles({ ...ONM, OFFICIAL_X_URL: LEGACY_X_URL }), SOCIAL_PROFILES, "a refused link keeps the whole switch off: today's list");
  assert.deepEqual(socialProfiles(ONM), [], "counting, no link configured: nothing is shown");
  assert.deepEqual(socialProfiles({ ...ONM, OFFICIAL_X_URL: FAKE_X, OFFICIAL_TELEGRAM_URL: FAKE_TG }).map((p) => [p.network, p.handle, p.url]),
    [["X", "@ZqFakeTestX", FAKE_X], ["Telegram", "@zq_fake_test_tg", FAKE_TG]]);
  assert.deepEqual(socialProfiles({ ...ONM, OFFICIAL_TELEGRAM_URL: FAKE_TG }).map((p) => p.network), ["Telegram"]);
  // the page build's own decision (`on` passed in): the legacy account is refused there too, so nothing is shown
  assert.deepEqual(socialProfiles({ ...RAW_ON, OFFICIAL_X_URL: LEGACY_X_URL }, true), []);
  assert.equal(socialProfiles({ ...ONM, OFFICIAL_X_URL: FAKE_X }, false), SOCIAL_PROFILES);
});

test("the configuration check: nothing reported with the switch off; on, each named error once per isolate, codes and key names only, never a value", () => {
  const lines = [], log = (...a) => lines.push(a.join(" "));
  _resetDeploymentCheck();
  assert.deepEqual(mainTokenFeatures({}), []);
  assert.deepEqual(mainTokenFeatures(RAW_ON), ["token_page", "purchase_links"]);
  for (const env of [{}, { MAIN_TOKEN_MINT: "garbage", OFFICIAL_X_URL: LEGACY_X_URL }, { MAIN_TOKEN_V5: "off", MAIN_TOKEN_MINT: LEGACY }])
    assert.deepEqual(checkDeploymentConfig(env, { log }), { ok: true, codes: [] }, JSON.stringify(env));
  assert.deepEqual(lines, [], "off: not a line, whatever the values");

  assert.deepEqual(checkDeploymentConfig(RAW_ON, { log }), { ok: false, codes: ["MAIN_TOKEN_MINT_MISSING"] });
  assert.deepEqual(checkDeploymentConfig(RAW_ON, { log }).codes, ["MAIN_TOKEN_MINT_MISSING"], "the job start asks again");
  assert.deepEqual(lines, ["deployment config refused MAIN_TOKEN_MINT_MISSING env.MAIN_TOKEN_MINT"], "logged once per isolate");

  const secretish = "zzzNotAMintButMaybeSomethingPrivate";
  const r = checkDeploymentConfig({ ...RAW_ON, MAIN_TOKEN_MINT: secretish, OFFICIAL_X_URL: LEGACY_X_URL, OFFICIAL_TELEGRAM_URL: "https://t.me/+invite" }, { log });
  assert.deepEqual(r.codes.sort(), ["LEGACY_SOCIAL_LINK_AS_OFFICIAL", "MAIN_TOKEN_MINT_INVALID", "OFFICIAL_TELEGRAM_URL_INVALID"]);
  assert.ok(lines.every((x) => !x.includes(secretish) && !x.includes("invite") && !x.includes("VicinityCitySOL")), "no value in a log line");
  assert.deepEqual(checkDeploymentConfig({ ...RAW_ON, MAIN_TOKEN_MINT: LEGACY }, { log }).codes, ["MAIN_TOKEN_IS_LEGACY_MINT"]);
  assert.deepEqual(checkDeploymentConfig({ ...RAW_ON, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: FAKE_X }, { log }), { ok: true, codes: [] });
  assert.doesNotThrow(() => checkDeploymentConfig({ ...RAW_ON }, { log: () => { throw new Error("log down"); } }));
  _resetDeploymentCheck();
});

test("the admin view: no key while the switch and the three settings are unset; presence and error codes only otherwise", () => {
  assert.equal(mainTokenStatus({}), null);
  assert.equal(mainTokenStatus({ MAIN_TOKEN_V5: "off", MAIN_TOKEN_MINT: "  " }), null);
  assert.deepEqual(mainTokenStatus(RAW_ON), { MAIN_TOKEN_V5: true, MAIN_TOKEN_MINT: false, OFFICIAL_X_URL: false, OFFICIAL_TELEGRAM_URL: false, errors: ["MAIN_TOKEN_MINT_MISSING"] });
  const s = mainTokenStatus({ MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: LEGACY_X_URL });
  assert.deepEqual(s, { MAIN_TOKEN_V5: false, MAIN_TOKEN_MINT: true, OFFICIAL_X_URL: true, OFFICIAL_TELEGRAM_URL: false, errors: ["LEGACY_SOCIAL_LINK_AS_OFFICIAL"] });
  assert.ok(!JSON.stringify(s).includes(FAKE_MINT), "never the value");
});

/* ---------------------------------------------------------------- the footer: one source for the build and the Worker */

test("switch off: the build's footer block is today's, and rewriting a committed page with today's list gives its exact bytes", () => {
  assert.equal(pageSocials(), SOCIAL_PROFILES);
  for (const f of PAGES) {
    const html = page(f);
    assert.ok(html.includes(socialList(SOCIAL_PROFILES, L)), `${f}: the block the layout writes`);
    assert.equal(rewriteSocialLinks(html, SOCIAL_PROFILES, L), html, `${f}: the rewrite is the identity with today's list`);
  }
});

test("switch off: the Worker's hook hands back the asset's own response object, untouched", async () => {
  const res = new Response(page("404.html"), { status: 404, headers: { "content-type": "text/html; charset=utf-8", etag: '"x"' } });
  for (const env of [{}, { MAIN_TOKEN_V5: "off" }, { OFFICIAL_X_URL: FAKE_X }, { MAIN_TOKEN_V5: "yes", OFFICIAL_TELEGRAM_URL: FAKE_TG }]) assert.equal(await officialLinksInPage(res, env), res);
  const answer = await worker.fetch(new Request("https://vicinity.city/no-such-page"), { ASSETS: { fetch: async () => new Response(page("404.html"), { status: 404, headers: { "content-type": "text/html; charset=utf-8", etag: '"x"' } }) } }, { waitUntil() {} });
  assert.equal(answer.status, 404);
  assert.equal(await answer.text(), page("404.html"));
  assert.equal(answer.headers.get("etag"), '"x"', "the asset's headers stay");
});

test("switch on: every page's footer carries exactly the configured links, from the same function the build uses (build bytes = rewrite bytes)", async () => {
  const profiles = socialProfiles({ ...ON, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: FAKE_X, OFFICIAL_TELEGRAM_URL: FAKE_TG });
  const built = new Map([...buildPages({ socials: profiles }), ...buildStandalonePages({ socials: profiles })]);
  for (const f of PAGES) {
    const out = rewriteSocialLinks(page(f), profiles, L);
    assert.equal(out, built.get(f), `${f}: the response-time rewrite and the page build agree byte for byte`);
    assert.ok(out.includes(`href="${FAKE_X}"`) && out.includes(`href="${FAKE_TG}"`), f);
    assert.ok(!hrefs(out).some((h) => /vicinitycitysol/i.test(h)), `${f}: no link to the former account`);
    assert.match(out, /aria-label="Vicinity on Telegram \(@zq_fake_test_tg\), opens in a new tab"/);
  }
  const dash = rewriteSocialLinks(page("dashboard.html"), profiles, L);
  assert.match(dash, /<li><a href="https:\/\/x\.com\/ZqFakeTestX" target="_blank" rel="noopener">Contact us on X \(@ZqFakeTestX\)<\/a><\/li>/, "the dashboard's help link follows the configured X");
});

test("switch on: an unset link is removed (never the legacy handle), and with no link at all the footer list goes", () => {
  const tgOnly = socialProfiles({ ...ON, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_TELEGRAM_URL: FAKE_TG });
  for (const f of PAGES) {
    const out = rewriteSocialLinks(page(f), tgOnly, L);
    assert.ok(!hrefs(out).some((h) => /x\.com|twitter\.com/.test(h)), `${f}: no X link while none is configured`);
    assert.ok(out.includes(`href="${FAKE_TG}"`), f);
  }
  assert.doesNotMatch(rewriteSocialLinks(page("dashboard.html"), tgOnly, L), /Contact us on X/, "its help item goes with it");
  for (const f of PAGES) {
    const out = rewriteSocialLinks(page(f), socialProfiles({ ...ON, OFFICIAL_X_URL: LEGACY_X_URL }, true), L); // the build's view: no accepted link
    assert.doesNotMatch(out, /site-footer__social/, `${f}: no list at all`);
    assert.ok(!hrefs(out).some((h) => /vicinitycitysol/i.test(h)), `${f}: the legacy account refused as official is not shown`);
    assert.match(out, /<footer class="site-footer">[\s\S]*site-footer__theme[\s\S]*site-footer__safe/, `${f}: the rest of the footer stays`);
  }
});

test("switch on: the Worker rewrites the HTML it serves, keeps the status, drops the stale length and ETag, and leaves other files alone", async () => {
  const env = { ...ON, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: FAKE_X };
  const html = page("404.html");
  const res = await officialLinksInPage(new Response(html, { status: 404, headers: { "content-type": "text/html; charset=utf-8", etag: '"x"', "content-length": String(Buffer.byteLength(html)) } }), env);
  const body = await res.text();
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("etag"), null);
  assert.equal(res.headers.get("content-length"), null);
  assert.ok(body.includes(`href="${FAKE_X}"`) && !body.includes("x.com/VicinityCitySOL"));
  const css = new Response("a{}", { headers: { "content-type": "text/css" } });
  assert.equal(await officialLinksInPage(css, env), css, "not HTML: untouched");
  const head = await officialLinksInPage(new Response(null, { status: 200, headers: { "content-type": "text/html", "content-length": "99" } }), env);
  assert.equal(head.headers.get("content-length"), null, "a HEAD answer does not announce the old length");
  const viaWorker = await worker.fetch(new Request("https://vicinity.city/no-such-page"), { ...env, ASSETS: { fetch: async () => new Response(html, { status: 404, headers: { "content-type": "text/html" } }) } }, { waitUntil() {} });
  const text = await viaWorker.text();
  assert.equal(viaWorker.status, 404);
  assert.ok(text.includes(`href="${FAKE_X}"`));
  assert.equal(viaWorker.headers.get("x-content-type-options"), "nosniff", "the security headers still apply");
});

test("everything written into markup is escaped, and an address that is not a plain https:// link is refused", () => {
  const out = socialItems([{ network: '<b>"N', handle: '@"<i>', hosts: ["example.test"], url: "https://example.test/a" }], L);
  assert.doesNotMatch(out, /<b>|<i>/);
  assert.match(out, /&lt;b&gt;&quot;N/);
  assert.throws(() => socialItems([{ network: "X", handle: "@a", hosts: ["x.com"], url: 'https://x.com/a" onclick="x' }], L), /https:\/\//);
  assert.throws(() => socialItems([{ network: "X", handle: "@a", hosts: ["x.com"], url: "javascript:alert(1)" }], L));
  // a rewrite that cannot be done (a refused address) takes the links out instead of leaving the former account up
  const broken = [{ network: "X", handle: "@a", hosts: ["x.com"], url: "http://x.com/a" }];
  assert.throws(() => rewriteSocialLinks(page("404.html"), broken, L));
});

test("the page build refuses MAIN_TOKEN_V5=on before the brand rollout (S48): the pages still name $VICINITY as the token", () => {
  assert.throws(() => pageSocials({ ...ON, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: FAKE_X }), /MAIN_TOKEN_V5=on in wrangler\.jsonc.*S48/);
  assert.throws(() => pageSocials({ ...ON, MAIN_TOKEN_MINT: FAKE_MINT, MAIN_TOKEN_V5: "ON", BRAND: "citycoin" }), /S48/, "BRAND=citycoin has no label set yet either");
  // and, first, it never builds pages for a switch the Worker would refuse
  for (const env of [RAW_ON, { ...ON }, { ...ON, MAIN_TOKEN_MINT: LEGACY }, { ...RAW_ON, MAIN_TOKEN_MINT: FAKE_MINT }, { ...ON, MAIN_TOKEN_MINT: FAKE_MINT, OFFICIAL_X_URL: LEGACY_X_URL }])
    assert.throws(() => pageSocials(env), /configuration the Worker refuses/, JSON.stringify(env));
  assert.equal(pageSocials({ MAIN_TOKEN_V5: "off", OFFICIAL_X_URL: FAKE_X }), SOCIAL_PROFILES);
  assert.equal(pageSocials({}), SOCIAL_PROFILES);
});
