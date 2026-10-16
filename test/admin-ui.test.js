// The admin control centre (public/admin.js, public/admin-charts.js, the built admin page), run in the just-enough DOM of
// test/helpers/pagedom.js with a stand-in API. What this pins: the sections each role sees are the ones the server lets it read (the
// same sets as before the redesign, "Content" now "Moderation"); the owner-only growth answer is asked for by the owner only; every
// number on the Overview is the API's own (a missing one is "—" with the API's reason, never a 0); Moderation shows the claims queue to
// admins only and keeps every decision behind a question; the live filter; nothing from the server becomes HTML. Real Chromium checks
// the looks (scratchpad harness).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { openPage } from "./helpers/pagedom.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const ADMIN_JS = read("public/admin.js"), CHARTS_JS = read("public/admin-charts.js"), HTML = read("public/admin.html"), SRC = read("scripts/pages/src/admin.html");
const tick = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const W = "Own3r1111111111111111111111111111111111111";
const MINT = "DmsT8fDJx5KuToivsKUwFErpSWosdWHRBfNyRTugYKiw";
const today = new Date().toISOString().slice(0, 10);
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

function answers(role, over = {}) {
  return {
    "/api/me": { ok: true, signedIn: true, user: { handle: "boss", wallet: W } },
    "/api/admin/me": { ok: true, wallet: W, role },
    "/api/admin/config": role === "moderator" ? { ok: false, error: "forbidden" } : { ok: true, siteMode: "live", policyVersion: 3, grantedRoles: 1, auditRows: 9, flags: { ADMIN_WALLETS: true } },
    "/api/admin/lp": { ok: false, error: "not_enabled" },
    "/api/admin/overview": { ok: true, users: 1234, seats: { active: 3, grace: 1 }, openElections: 2, pendingReports: 4, pendingObjections: 1, pendingLogos: 1, registeredTokens: 0, launchedCityCoins: 5, snapshots: 0, latestSnapshot: null },
    "/api/admin/feedback/count": { ok: true, new: 3, counts: { new: 3, seen: 1, done: 0 } },
    "/api/official": { launchpadV2: true, tokenContract: MINT },
    "/api/launchpad": { ok: true, vicinity: { mint: MINT, holders: { count: 142, asOf: ago(4) },
      market: { priceUsd: 0.000421, priceChange24hPct: -1.25, volume24hUsd: 536.2, marketCapUsd: null, stale: false,
        sources: { price: "Jupiter (last trade)", volume24h: "Jupiter", change24h: "Jupiter" }, missing: { marketCap: "no supply to multiply" } } },
      attribution: [{ text: "Price, market cap, 24 h volume & change: Jupiter · Powered by Jupiter", url: "https://jup.ag" }] },
    "/api/policy": { policy: { sampling: { maxGapMinutes: 180 } }, balanceHistory: { running: true, lastSample: { taken_at: ago(12) }, samplesLast24h: 7 } },
    "/api/admin/growth": { ok: true, asOf: ago(0), since: "2026-07-15", holders: [{ day: "2026-10-11", holders: 10, at: ago(2900) }, { day: "2026-10-12", holders: 12, at: ago(1400) }],
      members: [{ day: "2026-10-01", joined: 1, total: 1230 }, { day: today, joined: 2, total: 1232 }], countries: [{ country: "US", members: 900 }, { country: "other", members: 20 }] },
    "/api/coin/chart": { ok: true, line: { interval: "4h", points: [[Math.floor(Date.now() / 1000) - 7200, 0.0004, "Jupiter", null], [Math.floor(Date.now() / 1000), 0.000421, "Jupiter", null]] }, missing: {} },
    "/api/admin/audit": { ok: true, audit: [{ id: 2, actor: W, action: "users/ban", target: "47ugnHuxsmgNZu8KEv1VXW7wPVVwMWti8vVrK4ADDxWa", detail: "spam", created_at: ago(30) }, { id: 1, actor: W, action: "roles/grant", target: "x", detail: null, created_at: ago(90) }] },
    "/api/admin/claims": { ok: true, claims: [{ id: 7, city_name: "Albany", country: "US", handle: "newhere", pitch: "Makers meetup", total: 0.62 }] },
    "/api/admin/reports": { ok: true, reports: [{ post_id: 3, body: "spam spam", handle: "jo", reports: 2, last_report: ago(60) }] },
    "/api/admin/logos": { ok: true, waiting: 1, logos: [
      { city: { id: "5142056", name: "Utica", country: "US" }, coin: "Utica Coin", launched: false, founder: { handle: "uticafounder", wallet: "Own3r*****111" }, mediaId: 7, preview: "/api/media/7",
        type: "image/webp", size: 34000, uploadedAt: ago(20), status: "pending", reason: null, note: null, reviewedAt: null, approved: false, current: false, hash: null },
      { city: { id: "5106834", name: "Albany", country: "US" }, coin: "Albany", launched: false, founder: { handle: null, wallet: "Abcde*****xyz" }, mediaId: 5, preview: "/api/media/5",
        type: "image/png", size: 120000, uploadedAt: ago(900), status: "rejected", reason: "scam", note: "Copies the city seal", reviewedAt: ago(300), approved: false, current: false, hash: null },
    ] },
    "/api/admin/objections": { ok: true, objections: [] },
    "/api/admin/appeals": { ok: true, appeals: [] },
    "/api/admin/users": { ok: true, users: [{ id: 1, handle: "nycsteward", wallet: W, home_name: "New York City", home_country: "US", created_at: ago(500), banned: 0 }] },
    ...over,
  };
}

/** The admin page signed in as `role`: site.js, admin-charts.js, then admin.js, with every /api answer from `answers`. */
async function open(role, { over = {}, hash = "" } = {}) {
  const page = await openPage("admin.html", { agreed: "2026-10-01" });
  const win = page.window, doc = page.doc;
  const A = answers(role, over), calls = [];
  win.fetch = async (path) => {
    const p = String(path).split("?")[0];
    calls.push(String(path));
    const body = A[p] ?? { ok: false, error: "not_found" };
    return { ok: body.ok !== false, status: body.ok === false ? 404 : 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  win.setTimeout = (fn) => { setImmediate(fn); return 0; };
  win.location = { hash, pathname: "/admin", href: `https://vicinity.test/admin${hash}` };
  win.VW = { list: () => [], isMobile: false, KNOWN: [], onChange() {}, safeIcon: () => null, mark: () => doc.createElement("span") };
  doc.createElementNS = (_ns, tag) => doc.createElement(tag); // the charts' SVG (no layout here: drawn at a guessed width)
  vm.runInContext(CHARTS_JS, win, { filename: "public/admin-charts.js" });
  vm.runInContext(ADMIN_JS, win, { filename: "public/admin.js" });
  await tick();
  const tabs = () => doc.querySelectorAll("[data-tab]").map((b) => b.getAttribute("data-tab"));
  const card = (label) => doc.querySelectorAll(".adm-metric").find((c) => c.querySelector(".adm-metric__label").textContent === label);
  return { ...page, win, doc, calls, tabs, card, asked: (p) => calls.some((c) => c.split("?")[0] === p) };
}

test("the built page loads the charts before admin.js, keeps every hook admin.js reads, and nothing from the server becomes HTML", () => {
  const order = ["/wallets.js", "/lp-sign.js", "/admin-lp.js", "/admin-charts.js", "/admin.js"].map((s) => HTML.indexOf(`<script src="${s}" defer></script>`));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  for (const id of ["admin-banner", "admin-gate", "admin-wallets", "admin-addr", "admin-msg", "admin-sign", "admin-error", "admin-main", "admin-role", "admin-who", "admin-tabs", "admin-panel", "admin-title", "admin-search", "admin-updated", "admin-refresh"]) {
    assert.match(SRC, new RegExp(`id="${id}"`), id);
  }
  assert.match(HTML, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(SRC, /<label class="sr-only" for="admin-search">/, "the filter has a name");
  for (const js of [ADMIN_JS, CHARTS_JS]) assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(/);
  assert.match(CHARTS_JS, /document\.createElementNS|doc\.createElementNS\(NS/);
  assert.doesNotMatch(SRC + CHARTS_JS + ADMIN_JS, /\sstyle="/, "no inline style attribute (the security policy)");
});

test("each role sees the sections it saw before (Content is now Moderation); the owner-only answers are asked for by the owner only", async () => {
  // before the redesign: TABS levels 1 (overview inbox users seats elections tokens content snapshots audit), 2 (config), 3 (roles testlab citycoins)
  const level1 = ["overview", "inbox", "audit", "moderation", "users", "seats", "elections", "tokens", "snapshots"];
  const sets = { moderator: level1, admin: [...level1, "config"], owner: [...level1, "config", "roles", "testlab"] };
  for (const [role, want] of Object.entries(sets)) {
    const t = await open(role);
    assert.deepEqual([...t.tabs()].sort(), [...want].sort(), role);
    assert.equal(t.doc.querySelector("#admin-role").textContent, role);
    assert.equal(t.asked("/api/admin/growth"), role === "owner", `${role}: growth (owner only)`);
    assert.equal(t.asked("/api/admin/config"), role !== "moderator", `${role}: config (admins and the owner)`);
    assert.equal(t.doc.querySelector("[aria-current]").getAttribute("data-tab"), "overview");
    // grouped under Monitor / Moderate / Launch / System labels, each group named for screen readers
    const groups = t.doc.querySelectorAll(".adm-nav__group").map((g) => g.querySelector(".adm-nav__label").textContent);
    assert.deepEqual(groups, role === "moderator" ? ["Monitor", "Moderate", "Launch"] : ["Monitor", "Moderate", "Launch", "System"]);
  }
  // City coins: still the owner's, and only when the server answers for it
  const lp = await open("owner", { over: { "/api/admin/config": { ok: true, siteMode: "live", flags: {}, cityCoins: true }, "/api/admin/lp": { ok: true, cluster: "devnet" } } });
  assert.ok(lp.tabs().includes("citycoins"));
});

test("Overview: every number is the API's own; a missing one is '—' with the API's reason; '+N today' and the charts for the owner only", async () => {
  const t = await open("owner");
  const num = (label) => t.card(label).querySelector(".adm-metric__num").textContent;
  const src = (label) => t.card(label).querySelector(".adm-metric__src").textContent;
  assert.equal(num("Members"), "1,234");
  assert.equal(t.card("Members").querySelector(".adm-metric__delta").textContent, "+2 today", "today's accounts from /api/admin/growth");
  assert.equal(num("$VICINITY holders"), "142");
  assert.match(src("$VICINITY holders"), /^People only, pools and team wallets left out · counted 4m ago$/);
  assert.equal(num("$VICINITY price"), "$0.000421");
  assert.equal(t.card("$VICINITY price").querySelector(".adm-metric__delta").textContent, "▼ 1.3% · 24 h");
  assert.equal(src("$VICINITY price"), "Jupiter (last trade)");
  assert.equal(num("24h volume"), "$536");
  assert.equal(num("Market cap"), "—", "no market cap in the answer: no number");
  assert.equal(src("Market cap"), "no supply to multiply", "the API's own reason");
  assert.equal(num("City coins live"), "5");
  assert.equal(num("Open elections"), "2");
  assert.equal(num("Balance samples, 24 h"), "7");
  assert.match(src("Balance samples, 24 h"), /^Last sample 12m ago$/);
  assert.equal(t.card("Balance samples, 24 h").querySelector(".tag").textContent, "Running");
  assert.equal(num("Reported posts"), "4");
  assert.equal(num("Pictures waiting"), "1", "coin pictures waiting for a check (src/logos.js)");
  assert.equal(src("Pictures waiting"), "Coin pictures waiting for a check");
  assert.ok(t.card("Pictures waiting").classList.contains("is-hot"), "lit while something waits");
  assert.equal(num("Seat objections"), "1");
  assert.equal(num("Founder seats"), "4");
  assert.equal(src("Founder seats"), "3 active · 1 grace");
  assert.equal(num("Inbox: new"), "3", "the Inbox poll's count");
  assert.match(t.doc.querySelector(".adm-attrib").textContent, /^Powered by Jupiter$/, "Jupiter's data carries its line");
  // the charts: titled honestly ("wallets", never "holders"), each with a table
  const titles = t.doc.querySelectorAll(".chart__title").map((h) => h.textContent);
  assert.deepEqual(titles, ["Wallets holding $VICINITY", "New members per day", "Members by country", "$VICINITY price, 30 days"]);
  assert.equal(t.doc.querySelectorAll(".chart__table").length, 4);
  assert.match(t.doc.querySelector(".chart__table").textContent, /Oct 12, 2026.*12 wallets/);
  // the live activity: the log's rows, newest first
  const feed = t.doc.querySelectorAll(".adm-feed__item").map((li) => li.querySelector(".adm-feed__what").textContent);
  assert.deepEqual(feed, ["Banned an account 47ug…DxWa", "Granted a role x"]);

  for (const role of ["admin", "moderator"]) {
    const o = await open(role);
    assert.equal(o.card("Members").querySelector(".adm-metric__delta").hidden, true, `${role}: no '+N today' (its source is the owner's)`);
    assert.equal(o.doc.querySelectorAll(".chart").length, 0, `${role}: cards only`);
    assert.ok(o.doc.querySelector(".adm-feed"), `${role}: the live activity`);
  }
});

test("Overview with nothing to say: no market, no sampler, no sample: dashes and reasons, never a 0", async () => {
  const t = await open("owner", { over: {
    "/api/launchpad": { ok: true, vicinity: { mint: MINT, holders: null, market: { priceUsd: null, volume24hUsd: null, marketCapUsd: null, sources: {}, missing: { price: "Jupiter has no price for it", volume24h: "Jupiter has no 24 h trades for it" } } }, attribution: [] },
    "/api/policy": { policy: { sampling: { maxGapMinutes: 180 } }, balanceHistory: { running: false } },
    "/api/admin/growth": { ok: true, asOf: ago(0), since: "2026-07-15", holders: [], members: [], countries: [] },
    "/api/coin/chart": { ok: true, line: { interval: "4h", points: [] }, missing: { line: "Not recorded yet" } },
  } });
  const num = (label) => t.card(label).querySelector(".adm-metric__num").textContent;
  const src = (label) => t.card(label).querySelector(".adm-metric__src").textContent;
  for (const l of ["$VICINITY holders", "$VICINITY price", "24h volume", "Balance samples, 24 h"]) assert.equal(num(l), "—", l);
  assert.equal(src("$VICINITY price"), "Jupiter has no price for it");
  assert.match(src("$VICINITY holders"), /^Not counted yet/);
  assert.equal(src("Balance samples, 24 h"), "No balance sample yet");
  assert.equal(t.doc.querySelector(".adm-attrib").hidden, true, "no Jupiter number shown: no Jupiter line");
  const empties = t.doc.querySelectorAll(".chart__empty").map((p) => p.textContent);
  assert.deepEqual(empties, ["No balance samples yet: the sampler records about once an hour.", "No accounts made in the last 90 days.", "No member has a home city yet.", "Not recorded yet"]);
  assert.equal(t.card("$VICINITY price").querySelector(".adm-spark"), null, "no sparkline beside a missing price");
});

test("Moderation: claims for admins and the owner only, the other queues for every role; each decision asks first", async () => {
  const admin = await open("admin", { hash: "#moderation" });
  const subs = admin.doc.querySelectorAll(".adm-subtab").map((b) => b.id);
  assert.deepEqual(subs, ["mod-tab-claims", "mod-tab-reports", "mod-tab-logos", "mod-tab-objections", "mod-tab-appeals"]);
  assert.equal(admin.doc.querySelector("#mod-tab-claims").getAttribute("aria-selected"), "true", "the first queue with something waiting");
  assert.match(admin.doc.querySelector("#mod-panel").textContent, /Albany \(US\).*newhere.*Makers meetup/);
  assert.deepEqual(admin.doc.querySelectorAll("#mod-panel button").map((b) => b.textContent), ["Approve", "Reject"]);
  admin.doc.querySelector("#mod-tab-reports").click();
  assert.deepEqual(admin.doc.querySelectorAll("#mod-panel button").map((b) => b.textContent), ["Hide", "Dismiss"]);
  assert.equal(admin.doc.querySelector("#mod-tab-reports").getAttribute("tabindex"), "0");
  assert.equal(admin.doc.querySelector("#mod-tab-claims").getAttribute("tabindex"), "-1", "one tab stop for the queue tabs");
  // Pictures (src/logos.js): the count is what waits (1, not the 2 rows), the preview comes only from our own media route, a rejected
  // one shows its reason in plain words, an admin gets Approve / Reject with a reason and a note for the founder
  admin.doc.querySelector("#mod-tab-logos").click();
  assert.equal(admin.doc.querySelector("#mod-tab-logos .adm-count").textContent, "1");
  const pics = admin.doc.querySelector("#mod-panel");
  assert.deepEqual(pics.querySelectorAll("img.adm-thumb").map((i) => i.src), ["/api/media/7", "/api/media/5"]);
  assert.deepEqual(pics.querySelectorAll("img.adm-thumb").map((i) => i.alt), ["Picture sent for Utica by @uticafounder", "Picture sent for Albany by Abcde*****xyz"], "the picture is what the reviewer looks at, so it has a name");
  assert.ok(!pics.textContent.includes("Vicinity badge") && !ADMIN_JS.includes("the coin shows the Vicinity badge"), "the site shows the city's initials, not the badge; nothing here says otherwise");
  assert.match(pics.textContent, /Utica \(US\).*@uticafounder.*webp · 33 KB.*Waiting/);
  assert.match(pics.textContent, /Albany \(US\).*Abcde\*\*\*\*\*xyz.*Not approved: Scam or impersonation/);
  assert.ok(!pics.textContent.includes("Copies the city seal"), "the founder's note is not in the table (it is theirs)");
  assert.deepEqual(pics.querySelectorAll("button").map((b) => b.textContent), ["Approve", "Reject", "Approve", "Reject"]);
  assert.deepEqual(pics.querySelectorAll("select option").map((o) => o.value).slice(0, 6), ["scam", "abuse", "illegal", "spam", "off_topic", "other"], "the rules' reasons");
  const mod = await open("moderator", { hash: "#moderation" });
  assert.equal(mod.doc.querySelector("#mod-tab-claims"), null, "no claims queue for a moderator");
  assert.equal(mod.asked("/api/admin/claims"), false);
  assert.equal(mod.doc.querySelector("#mod-tab-reports").getAttribute("aria-selected"), "true");
  mod.doc.querySelector("#mod-tab-logos").click();
  assert.deepEqual(mod.doc.querySelectorAll("#mod-panel button").map((b) => b.textContent), [], "a moderator looks, admins decide");
  assert.match(mod.doc.querySelector("#mod-panel").textContent, /admin only/);
  // every decision is behind sure() (window.confirm) in the source: the buttons moved, they did not change
  for (const label of ["Approve", "Reject", "Hide", "Dismiss", "Uphold", "Revoke", "Unban"]) assert.match(ADMIN_JS, new RegExp(`btn\\("${label}[^"]*", async \\(\\) => \\{ if \\(sure\\(`), label);
});

test("the live filter shows the matching rows and 'n of m'; Escape clears it; Users asks the server instead", async () => {
  const t = await open("owner", { hash: "#audit" });
  const search = t.doc.querySelector("#admin-search");
  assert.equal(t.doc.querySelector("#admin-search-box").hidden, false);
  assert.equal(search.placeholder, "Filter the log");
  search.value = "ban";
  search.dispatchEvent({ type: "input", bubbles: true, stopped: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
  await tick();
  const rows = t.doc.querySelectorAll(".admin-table tbody tr");
  assert.deepEqual(rows.map((r) => r.hidden), [false, true]);
  assert.equal(t.doc.querySelector("#admin-count").textContent, "1 of 2");
  search.dispatchEvent({ type: "keydown", key: "Escape", bubbles: true, stopped: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} });
  await tick();
  assert.equal(search.value, "");
  assert.deepEqual(t.doc.querySelectorAll(".admin-table tbody tr").map((r) => r.hidden), [false, false]);
  assert.equal(t.doc.querySelector("#admin-count").textContent, "");
  // the Overview has nothing to filter
  const o = await open("owner");
  assert.equal(o.doc.querySelector("#admin-search-box").hidden, true);
  // Users: the server searches (at least 2 characters), the moderator's box says what it can search
  const u = await open("moderator", { hash: "#users" });
  const s = u.doc.querySelector("#admin-search");
  assert.equal(s.placeholder, "Search handle");
  s.value = "n";
  s.dispatchEvent({ type: "input", bubbles: true, stopped: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
  await tick();
  assert.equal(u.calls.filter((c) => c.startsWith("/api/admin/users")).length, 1, "one character: no new search");
  s.value = "nyc";
  s.dispatchEvent({ type: "input", bubbles: true, stopped: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
  await tick();
  assert.ok(u.calls.includes("/api/admin/users?q=nyc&limit=100"), JSON.stringify(u.calls));
});

test("a finger's 44 px for the Overview cards' and the feed's links (integration QA: the coarse-pointer rule came before their base rules and lost the cascade, 32 px on phones)", () => {
  const css = read("public/admin.css");
  const coarse = css.lastIndexOf("@media (pointer: coarse) { .adm-metric__go, .adm-feed__foot .adm-metric__go { min-height: 44px; } }");
  assert.ok(coarse > 0, "the coarse-pointer rule for the cards' links");
  for (const base of [".adm-metric__go { align-self: flex-start; min-height: 32px;", ".adm-feed__foot .adm-metric__go { margin: 0; min-height: 40px; }"]) {
    const at = css.indexOf(base);
    assert.ok(at > 0 && at < coarse, `${base} comes before the 44 px rule, so a finger gets 44 px`);
  }
});
