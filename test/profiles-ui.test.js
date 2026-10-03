// Member profiles, browser side: the pure helpers of public/profile.js (run in node, no DOM) and checks that the page markup,
// the dashboard hooks and the script agree with each other and with the backend contract (FEATURES.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildPages, buildStandalonePages } from "../scripts/pages/build.mjs";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const src = read("profile.js");
const win = {};
vm.runInNewContext(src, { window: win, Intl }); // the file only defines things; nothing touches a page unless there is one
const P = win.VProfile.pure;
const plain = (x) => JSON.parse(JSON.stringify(x)); // the script runs in its own realm: compare plain copies

/* ---------- the bio counter ---------- */
test("the bio is counted in code points, one line, trimmed: the way the server counts it", () => {
  assert.equal(P.BIO_MAX, 100);
  assert.equal(P.cpLen(""), 0);
  assert.equal(P.cpLen("abc"), 3);
  assert.equal(P.cpLen("😀😀😀"), 3, "an emoji is one character, not two");
  assert.equal(P.cpLen("é"), 1);
  assert.equal(P.cpLen(null), 0);
  assert.equal(P.bioClean("  hello\nworld \r\n again  "), "hello world again");
  assert.equal(P.bioClean("a\n\n\nb"), "a b", "any run of line breaks is one space");
  assert.equal(P.bioClean("a  \n  b"), "a b", "blanks around a line break go with it");
  assert.equal(P.bioClean("a   b"), "a b", "every run of blanks is one space, as on the server");
  assert.equal(P.bioClean("a\u200Bb\u00ADc"), "abc", "invisible characters are dropped before counting");
  assert.equal(P.bioClean("a\u0080\u009F\u2061b" + String.fromCodePoint(0xe0073, 0xe007f) + "c"), "abc", "C1 controls, invisible operators and TAG characters too, as on the server");
  assert.equal(P.bioClean("e\u0301"), "\u00e9", "counted after NFC, so a letter and its accent is one character");
  assert.equal(P.bioCheck("e\u0301".repeat(100)).over, false);
  assert.equal(P.bioCheck("😀".repeat(100)).over, false, "100 emoji is exactly the limit");
  assert.equal(P.bioCheck("😀".repeat(101)).over, true);
  assert.equal(P.bioCheck("😀".repeat(101)).count, 101);
  assert.equal(P.bioCheck("x".repeat(100) + "\n\n   ").over, false, "trailing blanks do not count");
  assert.equal(P.bioCheck("Line one\nline two  ").count, 17);
});

test("the bio hint warns early about links, addresses, e-mail and phone numbers (the server has the last word)", () => {
  const problem = (t) => P.bioCheck(t).problem;
  assert.equal(problem("Coffee, subways and bad puns."), null);
  assert.equal(problem("Born in Queens. 🚇 Founder of London, est. 2026"), null);
  assert.equal(problem("see https://example.com"), "link");
  assert.equal(problem("find me at www.example.org"), "link");
  assert.equal(problem("my site: cool.io"), "link");
  assert.equal(problem("write to ada@example.com"), "email", "an e-mail is an e-mail, not a link");
  assert.equal(problem("send to 4Nd1mYQzvgdmqRHxCbpGuYUdwWqCuFqt9fb4NAd1yDhY now"), "address");
  assert.equal(problem("call +1 (555) 123-4567"), "phone");
  assert.equal(problem("call 5551234567"), "phone");
  assert.equal(problem("since 2026"), null, "a year is not a phone number");
  for (const k of ["link", "address", "email", "phone"]) assert.match(P.BIO_HINT[k], /^That looks like .*\.$/);
  // the server refuses every unbroken run of 26+ letters or digits as address-like (src/profile-core.js ADDRESS_LIKE): the hint says so while typing, and the refusal names it
  assert.equal(problem("Donaudampfschifffahrtsgesellschaft fan"), "longword");
  assert.equal(problem("A".repeat(26)), "longword");
  assert.equal(problem("Supercalifragilistic is 20"), null, "25 letters or fewer in a row are a word");
  assert.match(P.BIO_HINT.longword, /26 or more letters or digits/);
  assert.match(P.ERR.bio_not_allowed, /unbroken word of 26\+ letters or digits/, "the message after a refusal names the long-word rule too");
});

/* ---------- names and links ---------- */
test("handles: the username rule of the dashboard, and the search text", () => {
  for (const ok of ["abc", "CityWalker42", "a_b", "Long_Name_Member_12", "x".repeat(20)]) assert.equal(P.validHandle(ok), true, ok);
  for (const bad of ["", "ab", "1abc", "_abc", "has space", "x".repeat(21), "a-b", "<b>", "a@b", null, undefined, 42]) assert.equal(P.validHandle(bad), false, String(bad));
  assert.equal(P.cleanQuery("  @Bri ght! "), "Bright");
  assert.equal(P.cleanQuery("@@br"), "br");
  assert.equal(P.cleanQuery("a".repeat(40)).length, 20);
  assert.equal(P.cleanQuery(null), "");
  assert.equal(P.profileHref("CityWalker42"), "/profile?u=CityWalker42");
  assert.equal(P.profileHref("no way"), "/profile", "a name that is not a username never goes into an address");
  assert.equal(P.profileHref("<script>"), "/profile");
});

/* ---------- time ---------- */
test("'Updated N s ago': counted from the answer, plus what the server's cache had already aged; a wrong clock cannot make it worse", () => {
  const t = 1_800_000_000_000;
  const asOf = (agoMs) => new Date(t - agoMs).toISOString();
  assert.equal(P.ageSeconds({ asOf: asOf(3000), receivedAt: t, now: t }), 3, "the server said the prices were 3 s old");
  assert.equal(P.ageSeconds({ asOf: asOf(3000), receivedAt: t, now: t + 9000 }), 12, "nine seconds later");
  assert.equal(P.ageSeconds({ asOf: asOf(0), receivedAt: t, now: t + 4000 }), 4);
  assert.equal(P.ageSeconds({ asOf: "not a date", receivedAt: t, now: t + 7000 }), 7, "no usable time from the server: since it arrived");
  assert.equal(P.ageSeconds({ asOf: asOf(-86_400_000), receivedAt: t, now: t + 2000 }), 2, "this device's clock is a day behind the server: ignored");
  assert.equal(P.ageSeconds({ asOf: asOf(3 * 86_400_000), receivedAt: t, now: t + 2000 }), 2, "or days ahead");
  assert.equal(P.ageSeconds({ asOf: asOf(0), receivedAt: t, now: t - 5000 }), 0, "never negative");
  assert.equal(P.agoText(0), "just now"); assert.equal(P.agoText(4), "just now");
  assert.equal(P.agoText(5), "5 s ago"); assert.equal(P.agoText(12), "12 s ago"); assert.equal(P.agoText(59), "59 s ago");
  assert.equal(P.agoText(60), "1 min ago"); assert.equal(P.agoText(150), "2 min ago"); assert.equal(P.agoText(3599), "59 min ago");
  assert.equal(P.agoText(3600), "1 h ago"); assert.equal(P.agoText(-1), "");
});

test("refresh timing: every 30 s, twice as long after each failure, none after the fourth in a row", () => {
  assert.deepEqual([0, 1, 2, 3].map((n) => P.nextDelay(n)), [30_000, 60_000, 120_000, 240_000]);
  assert.equal(P.nextDelay(4), null); assert.equal(P.nextDelay(9), null);
  assert.deepEqual([0, 1, 2].map((n) => P.nextDelay(n, 60_000)), [60_000, 120_000, 240_000], "a profile page starts from a minute");
});

/* ---------- numbers ---------- */
test("money, amounts and shares: a dash where there is no price", () => {
  assert.equal(P.fmtUsd(null), "—"); assert.equal(P.fmtUsd(undefined), "—"); assert.equal(P.fmtUsd(NaN), "—");
  assert.equal(P.fmtUsd(0), "$0.00"); assert.equal(P.fmtUsd(0.004), "<$0.01"); assert.equal(P.fmtUsd(1234.5), "$1,234.50"); assert.equal(P.fmtUsd(982.65), "$982.65");
  assert.equal(P.fmtUsdShort(982.65), "$982.65"); assert.equal(P.fmtUsdShort(12_345.6), "$12,346"); assert.equal(P.fmtUsdShort(1_250_000), "$1.25M"); assert.equal(P.fmtUsdShort(null), "—");
  assert.equal(P.fmtAmount(1_250_000), "1,250,000"); assert.equal(P.fmtAmount(12.3456), "12.35"); assert.equal(P.fmtAmount(0.000123), "0.000123"); assert.equal(P.fmtAmount(null), "—");
  assert.equal(P.fmtPct(null), "—"); assert.equal(P.fmtPct(0.02), "<0.1%"); assert.equal(P.fmtPct(62.34), "62.3%"); assert.equal(P.fmtPct(100), "100.0%");
  assert.equal(P.symbolOf({ symbol: "NYC" }), "$NYC"); assert.equal(P.symbolOf({ symbol: "$NYC" }), "$NYC"); assert.equal(P.symbolOf({}), "$?");
});

/* ---------- the colours coins wear ---------- */
const coin = (symbol, valueUsd, kind = "city", amount = 1) => ({ kind, mint: `mint-${symbol}`, symbol, name: symbol, amount, priceUsd: valueUsd == null ? null : 1, valueUsd, sharePct: null });
test("items are listed biggest value first, coins without a price after them", () => {
  const list = P.sortItems([coin("B", 5), coin("N", null, "city", 99), coin("A", 50), coin("M", null, "city", 5)]);
  assert.deepEqual(plain(list.map((i) => i.symbol)), ["A", "B", "N", "M"]);
});
test("$VICINITY is always the first colour and a coin keeps its colour while it stays in the list", () => {
  const first = P.assignSlots(new Map(), [coin("NYC", 90), coin("VICINITY", 10, "vicinity"), coin("LDN", 50)]);
  assert.equal(first.get("mint-VICINITY"), 0, "even when it is the smallest");
  assert.deepEqual([first.get("mint-NYC"), first.get("mint-LDN")].sort(), [1, 2]);
  // the values change and the order flips: nobody is repainted
  const again = P.assignSlots(first, [coin("LDN", 99), coin("VICINITY", 1, "vicinity"), coin("NYC", 5)]);
  for (const k of first.keys()) assert.equal(again.get(k), first.get(k), k);
  // a new coin takes the lowest free colour; a coin that left frees its colour
  const more = P.assignSlots(again, [coin("LDN", 99), coin("VICINITY", 1, "vicinity"), coin("PAR", 5)]);
  assert.equal(more.get("mint-PAR"), first.get("mint-NYC"), "NYC left, PAR takes its colour");
  assert.equal(P.assignSlots(new Map(), [coin("NYC", 1)]).get("mint-NYC"), 1, "slot 0 stays for $VICINITY");
});
test("past 8 colours the rest share the grey slice (-1); no two coins share a colour", () => {
  const items = ["VICINITY", ...Array.from({ length: 12 }, (_, i) => `C${i}`)].map((s, i) => coin(s, 1000 - i * 10, s === "VICINITY" ? "vicinity" : "city"));
  const slots = P.assignSlots(new Map(), items);
  const used = [...slots.values()].filter((s) => s >= 0);
  assert.equal(new Set(used).size, used.length, "all different");
  assert.equal(used.length, 8); assert.equal(Math.max(...used), 7); assert.equal([...slots.values()].filter((s) => s === -1).length, 5);
  assert.equal(slots.get("mint-VICINITY"), 0);
  assert.equal(slots.get("mint-C0"), 1, "the biggest coins get the first colours");
});

test("chart slices: only priced coins, thin ones and the tail folded into one 'Other', fractions add up to 1", () => {
  const items = [coin("A", 600), coin("B", 300), coin("C", 98), coin("T", 1.5), coin("U", 0.5), coin("NP", null)];
  const slots = P.assignSlots(new Map(), items);
  const s = P.chartSlices(items, slots);
  assert.deepEqual(plain(s.map((x) => x.key)), ["mint-A", "mint-B", "mint-C", "other"]);
  assert.equal(s[3].count, 2, "T and U are under half a percent each");
  assert.ok(Math.abs(s.reduce((t, x) => t + x.frac, 0) - 1) < 1e-12);
  assert.equal(s[3].slot, -1);
  assert.deepEqual(plain(P.chartSlices([coin("NP", null)], new Map())), [], "nothing priced, no slices");
  assert.deepEqual(plain(P.chartSlices([], new Map())), []);
  const lone = P.chartSlices([coin("A", 100), coin("T", 0.1)], P.assignSlots(new Map(), [coin("A", 100), coin("T", 0.1)]));
  assert.equal(lone[1].label, "$T", "a single small coin is named, not 'smaller holdings'");
});

/* ---------- the ring ---------- */
const nums = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);
test("ring geometry: starts at 12 o'clock, runs clockwise, slices touch end to start, one full turn in all", () => {
  const slices = [{ key: "a", frac: 0.5 }, { key: "b", frac: 0.25 }, { key: "c", frac: 0.25 }];
  const g = P.donutSlices(slices);
  assert.equal(g.length, 3);
  assert.ok(Math.abs(g[0].a0 + Math.PI / 2) < 1e-12, "starts at the top");
  for (let i = 1; i < g.length; i++) assert.ok(Math.abs(g[i].a0 - g[i - 1].a1) < 1e-12, "no overlap, no hole in the angles");
  assert.ok(Math.abs(g[2].a1 - g[0].a0 - 2 * Math.PI) < 1e-12, "a full turn");
  assert.ok(Math.abs(g[0].a1 - g[0].a0 - Math.PI) < 1e-12, "half is half a turn");
  for (const x of g) {
    assert.match(x.d, /^M[\d. -]+A[\d. -]+L[\d. -]+A[\d. -]+Z$/);
    const n = nums(x.d); assert.ok(n.every(Number.isFinite));
    assert.ok(n.every((v) => v >= -0.01 && v <= 200.01), "inside the 200 x 200 box");
  }
  // every outer corner sits on the outer circle, every inner corner on the inner one
  const n = nums(g[1].d);
  assert.ok(Math.abs(Math.hypot(n[0] - 100, n[1] - 100) - 92) < 0.02, "the start is on the outer circle");
  assert.ok(Math.abs(Math.hypot(n[9] - 100, n[10] - 100) - 60) < 0.02, "the line back goes to the inner circle");
});
test("ring geometry: the arc flag is 'large' only past half a turn; a gap separates neighbours", () => {
  const g = P.donutSlices([{ key: "big", frac: 0.75 }, { key: "small", frac: 0.25 }]);
  assert.equal(nums(g[0].d)[5], 1, "three quarters is a large arc"); assert.equal(nums(g[1].d)[5], 0);
  const hi = P.donutSlices([{ key: "x", frac: 0.5 }, { key: "y", frac: 0.5 }]);
  assert.equal(nums(hi[0].d)[5], 0, "half a turn minus the gap is not past half");
  const withGap = P.donutSlices([{ key: "x", frac: 0.5 }, { key: "y", frac: 0.5 }], { gap: 4 }), noGap = P.donutSlices([{ key: "x", frac: 0.5 }, { key: "y", frac: 0.5 }], { gap: 0 });
  assert.notEqual(withGap[0].d, noGap[0].d);
  assert.equal(P.donutSlices([{ key: "tiny", frac: 0.001 }, { key: "rest", frac: 0.999 }]).every((x) => nums(x.d).every(Number.isFinite)), true, "a sliver never makes a broken path");
});
test("ring geometry: one slice is a whole ring (two circles, even-odd), nothing to separate", () => {
  const [g] = P.donutSlices([{ key: "only", frac: 1 }]);
  assert.equal(g.full, true);
  assert.equal((g.d.match(/A/g) || []).length, 4, "two half circles outside, two inside");
  assert.equal((g.d.match(/Z/g) || []).length, 2);
  assert.deepEqual(plain(P.donutSlices([])), []);
});
test("the sentence for screen readers names the biggest slices and the total", () => {
  const items = [coin("A", 600), coin("B", 400)];
  const slices = P.chartSlices(items, P.assignSlots(new Map(), items));
  assert.equal(P.describePortfolio(slices, 1000), "Portfolio chart, worth $1,000.00: $A 60.0%, $B 40.0%.");
  assert.equal(P.describePortfolio([], null), "Portfolio chart: no priced coins yet.");
  assert.match(P.describePortfolio(slices, null), /total unknown/);
});

/* ---------- plain sentences ---------- */
const CONTRACT_CODES = ["not_enabled", "login_required", "not_found", "slow_down", "self", "cannot_follow", "too_many_following", "cannot_block", "unblock_first", "too_many_blocks", "no_bio", "profiles_unavailable", "unavailable",
  "bio_too_long", "bio_not_allowed", "bad_request", "wrong_origin", "offline", "reprove", "sign_in"];
test("errText: every code of the contract has its own plain sentence", () => {
  for (const code of CONTRACT_CODES) {
    const t = P.errText({ ok: false, error: code });
    if (code !== "slow_down") assert.notEqual(t, P.ERR.generic, `${code} has its own sentence`);
    assert.match(t, /[.!?]$/, `${code} ends like a sentence`);
    assert.ok(t.length < 120, `${code} is short`);
    assert.doesNotMatch(t, /<|>|\$\{|undefined|null|NaN|\p{Extended_Pictographic}/u, code);
    assert.equal(P.errText(code), t, "a bare code works too");
  }
  assert.equal(P.errText({ error: "something_new" }), P.ERR.generic);
  assert.equal(P.errText(undefined), P.ERR.generic);
});
test("errText: each rate limit says what it is about; refusing a follow never mentions a block", () => {
  for (const ctx of ["bio", "follow", "search", "profile", "report"]) assert.notEqual(P.errText("slow_down", ctx), P.errText("slow_down"), ctx);
  assert.match(P.errText("slow_down", "bio"), /10 times a day/);
  assert.doesNotMatch(P.errText("cannot_follow"), /block/i);
  assert.match(P.errText("too_many_following"), /1,000/);
  assert.equal(P.errText("slow_down", "unknown place"), P.ERR.slow_down);
});

/* ---------- the pages, the script and the contract agree ---------- */
const profileHtml = read("profile.html");
const dashHtml = read("dashboard.html");
const dashJs = read("dashboard.js");
const css = read("style.css");
const ids = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const lookups = (code) => new Set([...code.matchAll(/["'`]#([A-Za-z][\w-]*)\b/g)].map((m) => m[1])); // every "#id" string in the code
const between = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b));
const dashPart = between(src, "  function dashboard(ctx) {", "  /* =====================================================================\n     The /profile page");
const pagePart = src.slice(src.indexOf("  function page() {"), src.indexOf("  window.VProfile = "));

test("every element the dashboard part of profile.js looks up exists in dashboard.html, and is hidden until the script shows it", () => {
  const have = ids(dashHtml), used = lookups(dashPart);
  assert.ok(used.size >= 20, "the scan found the lookups: " + used.size);
  for (const id of used) assert.ok(have.has(id), `#${id} is used by profile.js but missing from dashboard.html`);
  for (const id of ["pf-notice", "portfolio", "bio-sec", "profile-net-sec", "profile-public-note", "me-bio"]) {
    assert.match(dashHtml, new RegExp(`<[a-z]+ [^>]*\\bid="${id}"[^>]*\\bhidden\\b`), `#${id} is hidden in the page itself: with the switch off nothing shows`);
  }
  assert.match(dashHtml, /<span class="tiny muted" id="pf-updated">/);
});
test("every element the /profile page part of profile.js looks up exists in profile.html", () => {
  const have = ids(profileHtml), used = lookups(pagePart);
  assert.ok(used.size >= 60, "the scan found the lookups: " + used.size);
  for (const id of used) assert.ok(have.has(id), `#${id} is used by profile.js but missing from profile.html`);
  for (const id of ["pf-out", "pf-off", "pf-main", "pf-view", "pf-intro", "pf-error", "pf-lists", "pf-dialog", "pf-menu", "pf-blocks"]) {
    assert.match(profileHtml, new RegExp(`\\bid="${id}"[^>]*\\bhidden\\b`), `#${id} starts hidden`);
  }
});
test("every pf- / prof- class the page or the script uses is styled", () => {
  const used = new Set();
  for (const m of profileHtml.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) used.add(c);
  for (const m of dashHtml.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) used.add(c);
  for (const m of src.matchAll(/\bel\("[a-z0-9]+",\s*"([^"]+)"/g)) for (const c of m[1].split(/\s+/)) used.add(c);
  for (const m of src.matchAll(/`(pf-[a-z0-9]+)/g)) used.add(m[1]);
  const stateOnly = new Set(["is-hot", "is-over", "is-warn", "is-err", "is-empty", "pf-s", "pf-sn", "pf-sx"]);
  const mine = [...used].filter((c) => /^(pf|prof|portfolio)[-_]/.test(c) && !stateOnly.has(c));
  assert.ok(mine.length > 40);
  for (const c of mine) assert.ok(css.includes(`.${c}`), `.${c} has no style`);
  for (const c of ["is-hot", "is-over", "is-warn", "is-err", "pf-sn", "pf-sx"]) assert.ok(css.includes(`.${c}`), `${c} is styled`);
});

test("only the endpoints of the contract are used (FEATURES.md)", () => {
  const contract = new Set(["/api/me", "/api/me/portfolio", "/api/me/bio", "/api/me/blocks", "/api/profile", "/api/profile/report", "/api/members/search", "/api/follow", "/api/follows", "/api/block"]);
  const used = new Set([...src.matchAll(/["'`](\/api\/[^"'`?$]+)/g)].map((m) => m[1]));
  assert.ok(used.size >= 9, [...used].join());
  for (const u of used) assert.ok(contract.has(u), `${u} is not in the contract`);
  assert.doesNotMatch(src, /\/api\/[^"'`]*(message|inbox|dm|chat)/i, "no messaging of any kind");
  // the exact shapes of the calls
  assert.match(src, /api\("\/api\/follow", \{ handle: cur\.handle, follow: !was \}\)/);
  assert.match(src, /api\("\/api\/block", \{ handle: cur\.handle, block: (true|on) \}\)/);
  assert.match(src, /setAttribute\("aria-disabled", "true"\)/, "a follow in flight marks the button busy without disabling it (the keyboard keeps its place)");
  assert.match(src, /api\("\/api\/me\/bio", \{ bio: c\.text \}\)/);
  assert.match(src, /api\("\/api\/profile\/report", \{ handle: cur\.handle, reason \}\)/, "a report is { handle, reason }: the server keeps up to 140 characters of it");
  assert.match(src, /\/\^\\\/api\\\/media\\\/\\d\+\$\/\.test\(x\.image\)/, "a post's picture is shown only from our own media route");
  assert.match(src, /\/api\/follows\?u=\$\{encodeURIComponent\(l\.handle\)\}&list=\$\{l\.kind\}\$\{l\.next \? `&after=\$\{encodeURIComponent\(l\.next\)\}` : ""\}/);
  assert.match(src, /\/api\/members\/search\?q=\$\{encodeURIComponent\(text\)\}/);
  assert.match(src, /api\("\/api\/me\/portfolio"\)/);
  // the dashboard side adds no endpoint of its own
  const hooks = between(dashJs, "  /* ---------- member profiles", "  const actBtn");
  assert.deepEqual([...hooks.matchAll(/["'`](\/api\/[^"'`]+)/g)].map((m) => m[1]), []);
});

test("the moderator tools list reported bios with a way to clear one, and count them in what is waiting", () => {
  const mod = between(dashJs, "  async function loadMod() {", '    $("#mod-sections").replaceChildren(...sections);');
  assert.match(mod, /towns: d\.towns\.length, bios: d\.bios \? d\.bios\.length : 0 \}\);/, "counted in the queue (0 when the server sends no bios: the switch is off)");
  assert.match(mod, /if \(d\.bios\) sections\.push\(section\("Reported bios", d\.bios\.length \? d\.bios\.map\(\(x\) => \{/, "a section only when the server sent the key");
  assert.match(mod, /memberLink\(x\.handle, x\.handle, "a"\)/, "the member's username, as a profile link");
  assert.match(mod, /`“\$\{x\.bio\}” · \$\{x\.reports\} report\$\{x\.reports === 1 \? "" : "s"\} · last \$\{ago\(x\.lastAt\)\}`/, "the bio text and the report count, as text");
  assert.match(mod, /actBtn\("Clear bio", \(\) => reasonForm\(li, "Clear the bio", async \(reason, note\) => \{\n\s+const r = await sensitive\(\(\) => api\("\/api\/mod\/bio\/clear", \{ handle: x\.handle, reason, note \}\)\);/,
    "clearing asks for a reason and a note and needs a fresh wallet proof, like a hide; the call is the contract's");
  assert.match(mod, /\[empty\("No reported bios\."\)\]/);
  assert.match(read("dashboard-roles.js"), /bios: \["reported bio", "reported bios"\]/, "the role card can name them");
  assert.doesNotMatch(mod, /innerHTML/);
});

test("nothing is requested for anyone but members with the switch on", () => {
  // the dashboard fetches profile.js in one place, behind the flag; it is not one of the page's scripts
  const order = [...dashHtml.matchAll(/<script src="\/([a-z/-]+)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["theme", "site", "ticker", "wallets", "dashboard-roles", "dashboard"], "profile.js is not a script tag of the dashboard");
  assert.equal((dashJs.match(/\/profile\.js/g) || []).length, 1, "named once");
  assert.match(dashJs, /if \(d\.profilesFlag\) \{ profilesSync\(d\);/, "asked for only when /api/me says so");
  assert.match(dashJs, /const memberLink = \(name, handle, tag = "b"\) => \{\n\s+if \(!\(me && me\.profilesFlag && typeof handle === "string" && HANDLE\.test\(handle\)\)\) return el\(tag, null, name\);/,
    "names stay plain text without the switch, and with it only the server's `handle` makes a link: a display name never does");
  assert.match(dashJs, /a\.href = `\/profile\?u=\$\{encodeURIComponent\(handle\)\}`/, "the link goes to the username, not to the text shown");
  assert.match(dashJs, /meta\.append\(memberLink\(p\.author\.name, p\.author\.handle\)\);/, "a feed author is linked by author.handle");
  assert.match(dashJs, /linkName\(\$\("#cc-founder"\), c && c\.seat && !c\.seat\.you \? c\.seat : null\); linkName\(\$\("#nc-manager"\), n && n\.manager && !n\.manager\.you \? n\.manager : null\);/, "the founder and the manager by seat.handle / manager.handle");
  assert.match(dashJs, /function linkName\(host, who\) \{\n\s+if \(!host \|\| !who \|\| !who\.name \|\| !\(me && me\.profilesFlag && typeof who\.handle === "string" && HANDLE\.test\(who\.handle\)\)\) return;/);
  assert.match(dashJs, /if \(profiles\) profiles\.openModal\(me\);/);
  // the /profile page asks for members only after /api/me said the viewer is signed in and the switch is on
  const start = between(pagePart, "    async function start() {", "    function landing()");
  assert.ok(start.indexOf("window.V.ready") < start.indexOf("show(\"#pf-out\")"));
  assert.ok(start.indexOf("show(\"#pf-off\")") < start.indexOf("wireSearch()"), "no member call is wired before the checks");
  assert.ok(start.indexOf("profilesFlag === true") > 0);
  for (const other of ["site.js", "cities.js", "home.js", "token.js", "launchpad.js", "connect.js", "wallets.js", "dashboard-roles.js"]) assert.doesNotMatch(read(other), /profile\.js|VProfile/, `${other} does not load it`);
});

test("the pages: noindex, the same menu, our own files only, nothing inline", () => {
  const std = new Map(buildStandalonePages());
  assert.deepEqual([...std.keys()], ["profile.html"], "profile.html is the one standalone page");
  assert.equal(profileHtml, std.get("profile.html"), "profile.html is out of date: run npm run pages");
  assert.ok(!new Map(buildPages()).has("profile.html"), "the main list (test/site.test.js) is unchanged");
  assert.match(profileHtml, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(profileHtml, /<body data-page="profile">/);
  assert.deepEqual([...profileHtml.matchAll(/<script src="\/([a-z/-]+)\.js"/g)].map((m) => m[1]), ["theme", "site", "ticker", "profile"]);
  const nav = profileHtml.match(/<nav class="nav"[\s\S]*?<\/nav>/)[0], tabs = profileHtml.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)[0];
  for (const n of [nav, tabs]) assert.deepEqual([...n.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ["/", "/token", "/cities", "/launchpad", "/dashboard"]);
  assert.match(profileHtml, /<span data-account-label>Log in<\/span>/);
  assert.doesNotMatch(profileHtml, /\sstyle="/); assert.doesNotMatch(profileHtml, /<style[\s>]/); assert.doesNotMatch(profileHtml, /\son[a-z]+="/); assert.doesNotMatch(profileHtml, /<script(?![^>]*\bsrc=)[^>]*>/);
  const loads = [...profileHtml.matchAll(/<(?:script|img|link|iframe|source)\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(loads.filter((t) => /(src|href)="(https?:)?\/\//.test(t)), []);
  assert.equal((profileHtml.match(/<h1\b/g) || []).length, 3, "one headline per state: signed out, switch off, signed in");
  assert.match(profileHtml, /<a class="btn btn--primary" href="\/connect\?mode=login">Log in<\/a>/, "the signed-out view has the Log in button");
  assert.match(profileHtml, /Log in to view member profiles\./);
  // the dashboard keeps no inline style or handler either
  assert.doesNotMatch(dashHtml, /\sstyle="/); assert.doesNotMatch(dashHtml, /\son[a-z]+="/);
});

test("the strict security policy holds: no markup built from text, no style attributes, nothing logged", () => {
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\.style\.|cssText|setAttribute\(["']style/);
  assert.doesNotMatch(src, /console\./, "never logs anything (addresses must not reach a log)");
  assert.doesNotMatch(src.replace("http://www.w3.org/2000/svg", "").replace("`https://solscan.io/account/${p.wallet}`", ""), /https?:\/\//, "no other website: only the SVG namespace (a name, not something loaded) and the Solscan link people click");
  assert.match(profileHtml, /<a class="btn btn--glass btn--sm" id="pf-solscan" href="#" target="_blank" rel="noopener">/, "the outside link opens in a new tab without handing over the window");
  assert.doesNotMatch(src, /document\.cookie|sessionStorage|indexedDB/);
  const fetches = [...src.matchAll(/\bfetch\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(fetches, ['"/data/tickers.json", { credentials: "same-origin" }'], "the only direct fetch is the tickers file; everything else goes through V.api");
  // the one thing remembered in the browser is the notice, behind try/catch
  assert.equal((src.match(/localStorage/g) || []).length, 2);
  assert.match(src, /try \{ return localStorage\.getItem\(NOTICE_KEY\) === "1"; \} catch \{ return false; \}/);
  assert.match(src, /try \{ localStorage\.setItem\(NOTICE_KEY, "1"\); \} catch \{/);
  assert.match(src, /const NOTICE_KEY = "vicinity-profiles-notice";/);
  assert.doesNotMatch(between(dashJs, "  /* ---------- member profiles", "  const actBtn"), /localStorage|innerHTML/);
});

test("no way to message anyone, anywhere", () => {
  assert.doesNotMatch(profileHtml, /<(button|a)\b[^>]*>\s*(Message|Send message|Chat|DM|Direct message)/i);
  assert.doesNotMatch(src, /["'`](Message|Send message|Chat|DM)["'`]/);
  assert.match(profileHtml, /There is no messaging\./);
  assert.match(dashHtml, /There is no messaging\./);
});

test("accessibility: the ring has a text alternative AND the real table beside it; the menu, dialog and lists are marked up for a keyboard", () => {
  assert.match(src, /role: "img", "aria-labelledby": `pf-t\$\{id\} pf-d\$\{id\}`/);
  assert.match(src, /el\("table", "pf-table"\)/); assert.match(src, /el\("caption", "sr-only"/); assert.match(src, /th\.scope = "col"/); assert.match(src, /c1\.scope = "row"/);
  assert.match(profileHtml, /id="pf-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="pf-menu"/);
  assert.match(profileHtml, /<ul class="prof-menu__list" id="pf-menu" role="menu"/);
  assert.equal((profileHtml.match(/role="menuitem"/g) || []).length, 2);
  assert.match(profileHtml, /id="pf-dialog" role="dialog" aria-modal="true" aria-labelledby="pf-dialog-title" aria-describedby="pf-dialog-text"/);
  assert.match(profileHtml, /id="pf-search" role="search"/); assert.match(profileHtml, /<label class="sr-only" for="pf-q">/);
  assert.match(profileHtml, /id="pf-live" role="status" aria-live="polite"/);
  assert.match(profileHtml, /id="pf-followers-btn" aria-expanded="false" aria-controls="pf-lists"/);
  assert.match(dashHtml, /<label class="sr-only" for="bio-input">/); assert.match(dashHtml, /id="bio-input"[^>]*aria-describedby="bio-count bio-hint"/);
  assert.doesNotMatch(dashHtml.match(/<textarea id="bio-input"[^>]*>/)[0], /maxlength/, "the counter counts code points; a maxlength would count UTF-16 units and cut emoji short");
  for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab"]) assert.ok(src.includes(`"${k}"`), `${k} is handled`);
});

test("styles: the ring colours are the validated palette in both themes, no animation outside 'no-preference', 44 px controls", () => {
  const block = css.slice(css.indexOf("Member profiles (PROFILES=on)"));
  assert.ok(block.length > 3000);
  const dark = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  const light = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
  const root = block.match(/:root \{ (--pf-0[^}]*)\}/)[1], lroot = block.match(/:root\[data-theme="light"\] \{ (--pf-0[^}]*)\}/)[1];
  assert.deepEqual([...root.matchAll(/--pf-\d: (#[0-9a-f]{6})/g)].map((m) => m[1]), dark);
  assert.deepEqual([...lroot.matchAll(/--pf-\d: (#[0-9a-f]{6})/g)].map((m) => m[1]), light);
  for (let i = 0; i < 8; i++) assert.match(block, new RegExp(`\\.pf-s${i} \\{ fill: var\\(--pf-${i}\\); background: var\\(--pf-${i}\\); \\}`));
  assert.doesNotMatch(block, /@keyframes|animation\s*:/, "nothing moves by itself");
  for (const m of block.matchAll(/transition\s*:/g)) {
    const before = block.slice(0, m.index), open = before.lastIndexOf("@media");
    assert.ok(open >= 0 && /prefers-reduced-motion: no-preference/.test(block.slice(open, m.index)), "a transition only for people who have not asked for less motion");
  }
  assert.match(block, /\.pf__refresh \{ min-height: 44px;/);
  assert.match(block, /\.prof \.btn--sm \{ min-height: 44px; \}/);
  assert.match(block, /\.prof-menu__list button \{[^}]*min-height: 44px/);
  assert.match(block, /\.prof-count \{[^}]*min-height: 56px/);
  // a 320 px phone: the coin disc leaves the pass's id column room for the username on one line, and the role pill does not break in two
  const tiny = block.match(/@media \(max-width: 359px\) \{([^}]*\}\s*)+?\n\}/);
  assert.ok(tiny, "a rule set for the smallest phones");
  assert.match(tiny[0], /\.prof-pass \.pass__coin \{ display: none; \}/);
  assert.match(tiny[0], /\.prof-pass \.pass__name \{ font-size: 1\.05rem; \}/);
  assert.match(tiny[0], /\.prof-pass \.pass__top \{ flex-wrap: wrap;/);
  assert.match(tiny[0], /\.prof-pass \.role-pill \{ white-space: nowrap; \}/);
  assert.match(block, /\.prof-pass \.pass__name \{ margin: 0; white-space: normal; overflow-wrap: anywhere; \}/, "wrapping mid-word stays the last resort for a username wider than the column");
});

test("the notice, the field and the page say what others can see, in the owner's words", () => {
  assert.match(dashHtml, /Other signed-in members can see your username, community, bio, wallet address and your \$VICINITY and city-coin balances\./);
  assert.match(dashHtml, /Other signed-in members can now open your profile and see your username, home community, bio, wallet address and your \$VICINITY and city-coin balances\./);
  assert.match(dashHtml, /Only \$VICINITY and city coins are counted here\. Anything else in your wallet is never shown\./);
  assert.match(profileHtml, /Everything on a profile is visible to signed-in members/);
  assert.match(profileHtml, /Only \$VICINITY and city coins are shown\. Other tokens in a wallet never are\./);
});

test("copy about what other members can see is in the pages, hidden until the switch is on, and nothing else was reworded", () => {
  const SENT = "Other signed-in members can see your username, community, bio, wallet address and your $VICINITY and city-coin balances.";
  const connect = read("connect.html"), index = read("index.html"), rules = read("rules.html"), site = read("site.js");
  assert.match(connect, new RegExp(`<p class="tiny muted" id="su-profiles-note" data-profiles-only hidden>${SENT.replace(/[$.]/g, "\\$&")}</p>`), "the line under the sign-up account step");
  assert.match(index, /<span data-profiles-only hidden>Member profiles: other signed-in members can open your profile and see your username, home community, bio, wallet address, member-since date, badges and your \$VICINITY and city-coin balances\./);
  assert.match(index, /They never see your real name, how you signed in, your e-mail or phone, or your location\./);
  assert.match(rules, /<li data-profiles-only hidden>Member profiles: /);
  // the sentences the older tests pin are all still there, word for word
  assert.match(index, /With Google sign-in, only your Google account id and first name/);
  assert.match(index, /A made-up username, which is the only name feeds show, never your wallet\./);
  assert.match(rules, /We never keep a password anyone could read \(an e-mail account that has one keeps only a salted hash of it\), and check-in coordinates are never stored\./);
  for (const [name, html] of [["connect", connect], ["index", index], ["rules", rules]]) for (const tag of html.match(/<[a-z]+ [^>]*data-profiles-only[^>]*>/g)) assert.match(tag, /\bhidden\b/, `${name}: every switch-gated line starts hidden: ${tag}`);
  assert.match(site, /if \(d && d\.profilesFlag\) \$\$\("\[data-profiles-only\]"\)\.forEach\(\(e\) => \(e\.hidden = false\)\);/, "site.js shows them only when /api/me says profilesFlag");
  assert.equal((site.match(/profilesFlag/g) || []).length, 1, "the only thing site.js knows about profiles");
  assert.doesNotMatch(site, /profile\.js|VProfile/);
});
