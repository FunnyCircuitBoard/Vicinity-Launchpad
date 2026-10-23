// Dashboard design v2 (the owner's phone screenshots of 10 Oct 2026): no band between the header and the tab strip, a strip whose every
// tab is whole (short visible words, the full word in the accessible name), the Pass without "Sign out" and with one line of facts, ONE
// standing card instead of four tiles, a new member's welcome and wallet card as one first card, a phone's Safari with one buy path,
// tickers never cut. Static checks pin the markup, the stylesheet's scope and the scripts' contract; the runtime ones run the real page
// in node (test/helpers/dashpage.js). How it looks is checked in real Chromium (the scratch screenshot sweep).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADDR, UA, memberMe, openDashboard } from "./helpers/dashpage.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = read("public/dashboard.html"), src = read("scripts/pages/src/dashboard.html"), css = read("public/polish-dash.css");
const dash = read("public/dashboard.js"), v2 = read("public/dashboard-v2.js"), roles = read("public/dashboard-roles.js"), profile = read("public/profile.js");
const tag = (id) => { const m = html.match(new RegExp(`<a [^>]*id="${id}"[^>]*>[\\s\\S]*?</a>`)); assert.ok(m, id); return m[0]; };
const textOf = (h) => h.replace(/<[^>]+aria-hidden="true"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "").trim();

/* ---------- the stylesheet ---------- */
test("polish-dash.css is the dashboard's last stylesheet, and every rule in it is scoped to the tabbed dashboard or the dashboard page", () => {
  const settings = JSON.parse(src.match(/^<!--(\{.*\})-->/)[1]);
  // lp-launch.css (the founder's "Launch your city coin" card, public/lp-launch.js) loads before it: polish-dash.css still has the last word
  assert.deepEqual(settings.styles, ["onboard", "swap", "lp-launch", "polish-dash"], "loads after style.css, polish.css, onboard.css, swap.css and lp-launch.css");
  const links = [...html.matchAll(/<link rel="stylesheet" href="\/([a-z-]+)\.css">/g)].map((m) => m[1]);
  assert.equal(links[links.length - 1], "polish-dash", "the last stylesheet of the page");
  for (const f of ["index.html", "token.html", "cities.html", "launchpad.html", "coin.html", "connect.html"]) assert.doesNotMatch(read("public/" + f), /polish-dash\.css/, `${f} does not load it`);
  // every selector of every rule (inside @media too) starts at .dv2, .dv2-skel, body.is-dv2 or the dashboard page
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const sels = [];
  // a selector list split at its top-level commas (not the ones inside :is(...))
  const topLevel = (h) => { const out = []; let d = 0, cur = ""; for (const ch of h) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && !d) { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out.filter(Boolean); };
  const walk = (s) => {
    let k = 0;
    while (k < s.length) {
      const open = s.indexOf("{", k); if (open < 0) break;
      const head = s.slice(k, open).trim();
      let d = 0, close = open; for (let j = open; j < s.length; j++) { if (s[j] === "{") d++; else if (s[j] === "}") { d--; if (d === 0) { close = j; break; } } }
      if (head.startsWith("@media")) walk(s.slice(open + 1, close));
      else if (!head.startsWith("@keyframes") && head) sels.push(...topLevel(head));
      k = close + 1;
    }
  };
  walk(clean);
  assert.ok(sels.length > 150, `${sels.length} selectors`);
  // (and the signed-out page's example dashboard, .dpv / .dash-out: only this page has them; they moved here from style.css, review PERF-1)
  for (const s of sels) assert.match(s, /^(:root\[data-theme="light"\] )?(\.dv2(-skel)?\b|body\.is-dv2\b|body\[data-page="dashboard"\]|\[data-page="dashboard"\]|\.dpv(__[\w-]+)?\b|\.dash-out\.is-pending \.dpv__)/, `"${s}" could reach another page or the flag-off dashboard`);
  // motion: only transform and opacity, only when motion is welcome
  for (const m of clean.matchAll(/@keyframes [\w-]+ \{([^}]*\})\s*\}/g)) for (const p of m[1].matchAll(/([a-z-]+)\s*:/g)) assert.ok(["transform", "opacity"].includes(p[1]), `keyframes move ${p[1]}`);
  const motion = clean.indexOf("@media (prefers-reduced-motion: no-preference)");
  assert.ok(motion > 0, "a no-preference block");
  for (const m of clean.matchAll(/\b(animation|transition)\s*:\s*([^;}]*)/g)) if (m[2].trim() !== "none") assert.ok(m.index > motion, `${m[0]}: only when motion is welcome`);
  assert.doesNotMatch(clean, /text-overflow:\s*ellipsis/, "nothing on the dashboard is cut with an ellipsis");
});

test("D1: no band above the strip: the dashboard's top padding goes, the header's line too, the strip sits flush under the header and is at most 56 px", () => {
  assert.match(css, /body\.is-dv2 #dash-main \{ padding-top: 0; padding-bottom: 20px; \}/);
  assert.match(css, /body\.is-dv2 \.site-header \{ border-bottom-color: transparent; \}/);
  assert.match(css, /body\.is-dv2 \.dash::before \{ content: none; \}/, "no glow stripe");
  assert.match(css, /\.dv2 \.dtabs \{ top: var\(--header-h, 67px\);/);
  assert.match(css, /\.dv2 \.dtabs__list \{ gap: 2px; padding: 4px 8px;/, "4 + 44 + 4 + its 1 px line: 53 px");
  assert.match(css, /\.dv2 \.dtab \{ flex: 1 0 auto; justify-content: center; gap: 4px; min-width: 44px; min-height: 44px; padding: 0 8px; font: 600 \.84rem\/1 var\(--body\); white-space: nowrap;/);
  assert.match(v2, /document\.body\.classList\.add\("is-dv2"\)/, "dashboard-v2.js marks the page when the tabbed dashboard shows");
});

/* ---------- the strip ---------- */
test("D2: short visible words where the strip needs them; each accessible name contains (starts with) the visible word; roles, panels and keys unchanged", () => {
  const feed = tag("tab-community");
  assert.match(feed, /aria-label="Community feed"/); assert.equal(textOf(feed), "Feed");
  const rank = tag("tab-rankings");
  assert.match(rank, /aria-label="Rankings"/); assert.match(rank, /<span class="dtab__text dtab__long">Rankings<\/span><span class="dtab__text dtab__short" aria-hidden="true">Rank<\/span>/);
  assert.ok("Rankings".startsWith("Rank"), "the short word starts the name (WCAG 2.5.3)");
  const mod = tag("tab-moderate");
  assert.match(mod, /aria-label="Moderate" hidden>/); assert.match(mod, /<span class="dtab__text dtab__short" aria-hidden="true">Mod<\/span>/);
  assert.match(v2, /\$\("#tab-moderate"\)\.setAttribute\("aria-label", total \? `Moderate, \$\{total\} to review` : "Moderate"\);/, "the count stays in the name");
  // Profile (owner, 17 Oct 2026): its line icon like every tab; the person's initial is the header's one avatar now, not a second one here
  const me = tag("tab-profile");
  assert.match(me, /aria-label="Profile"><span class="dtab__ico" aria-hidden="true"><svg [^>]*>[\s\S]*?<\/svg><\/span><span class="dtab__text dtab__long">Profile<\/span><\/a>/);
  assert.doesNotMatch(html, /dtab__av/, "no initial in the strip");
  // the stylesheet: a phone shows icons (the chosen tab's whole name under its icon, never a short word); the short words remain for
  // a crowded tablet strip (the fit steps)
  assert.doesNotMatch(css, /\.dv2 #tab-(rankings|moderate) \.dtab__short \{ display: inline; \}/, "no phone word-shortening any more (Rank, Mod)");
  assert.match(css, /\.dv2 \.dtabs \.dtab__short \{ display: none; \}/);
  assert.match(css, /\.dv2 \.dtabs\.is-short #tab-rankings \.dtab__short \{ display: inline; \}/);
  // a crowded strip (nine tabs on a 320 px phone, review VUX-09): no tab steps out any more; Founder, Moderate (and Wallet, test/wallet-tab.test.js;
  // Notifications, test/notify.test.js) show as icons, named
  assert.doesNotMatch(css, /is-tight/, "no tab is hidden to make room");
  assert.match(css, /\.dv2 \.dtabs\.is-compact :is\(#tab-founder, #tab-moderate\) \.dtab__text \{ display: none; \}/);
  assert.match(tag("tab-founder"), /aria-label="Founder"><span class="dtab__ico" aria-hidden="true"><svg /, "the icon-only Founder tab keeps its name");
  assert.match(mod, /aria-label="Moderate" hidden><span class="dtab__ico" aria-hidden="true"><svg /);
  // the router: the fit check (a phone's icons only scroll or fit), the nearest scroll, keyboard skips a tab that stepped out
  assert.match(v2, /const steps = \["is-snug", "is-short", "is-compact", "is-scrollable"\];\n\s+strip\.classList\.remove\(\.\.\.steps, "is-flush"\);\n\s+for \(const step of icons \? \["is-flush", "is-scrollable"\] : steps\) \{ if \(!over\(\)\) break; strip\.classList\.add\(step\); \}/);
  assert.doesNotMatch(v2, /\(lr\.width - tr\.width\) \/ 2/, "never centred: Home is never pushed out");
  assert.match(v2, /\.filter\(\(t\) => inStrip\(t\) && t\.getClientRects\(\)\.length\)/);
  assert.match(v2, /function inStrip\(t\) \{ return Boolean\(t\) && !t\.hidden && !\(t\.dataset\.tab === "profile" && iconMode\(\)\); \}/, "a hidden tab, or a phone's Profile (the avatar opens it)");
  // a short visible word stays the start of the strip's titles too
  assert.match(v2, /const LABEL = \{ home: "Home", wallet: "Wallet", city: "City", community: "Community", notify: "Notifications", rankings: "Rankings", founder: "Founder", moderate: "Moderate", profile: "Profile" \};/);
});

test("D2 at runtime: the header's one avatar shows the person's initial, the Moderate tab's name carries its count, and the page is marked is-dv2", async () => {
  const p = await openDashboard({ me: memberMe({ wallet: ADDR, handle: "jo_utica" }), api: async (path) => (path === "/api/mod" ? { ok: true, moderator: true, role: "founder", scope: "Utica", posts: [{ id: 1, kind: "meme", body: "x", score: 0, replies: 0, voted: false, mine: false, hidden: true, at: new Date().toISOString(), author: { name: "a" }, canModerate: true }], proposals: [], appeals: [], objections: [], towns: [] } : undefined) });
  assert.ok(p.doc.body.classList.contains("is-dv2"));
  assert.equal(p.text("[data-account-avatar] [data-account-initial]"), "J", "the header's avatar (owner, 17 Oct 2026: one avatar, top right)");
  assert.equal(p.$("#tab-profile .dtab__av"), null, "and no second one in the strip");
  assert.equal(p.$("#tab-moderate").hidden, false);
  assert.equal(p.$("#tab-moderate").getAttribute("aria-label"), "Moderate, 1 to review");
  assert.equal(p.text("#tab-moderate-n"), "1");
  // flag off: no class, nothing moved
  const q = await openDashboard({ me: memberMe({ wallet: ADDR, dashboardV2: false }) });
  assert.equal(q.doc.body.classList.contains("is-dv2"), false);
});

/* ---------- the Pass and the standing card ---------- */
test("D4: the Pass has no Sign out (Log out lives in Profile, the same action) and one line of facts: masked wallet, a copy button, how you sign in, Live", () => {
  assert.doesNotMatch(src, /id="me-logout"|Sign out/);
  assert.match(src, /<button class="btn btn--glass btn--block profile__logout" type="button" id="profile-logout">Log out<\/button>/);
  assert.match(dash, /\$\("#profile-logout"\)\.addEventListener\("click", \(\) => logout\("\/"\)\);/, "the same action as the Pass's old Sign out (site.js V.logout: the request, then the home page)");
  const bottom = src.match(/<div class="pass__bottom">[\s\S]*?\n            <\/div>/)[0];
  assert.match(bottom, /<span class="pass__wallet"><span class="mono" data-me-wallet><\/span><button class="pass__copy" type="button" id="me-copy" aria-label="Copy your wallet address" title="Copy"><svg /);
  assert.match(bottom, /<span class="pass__provider" data-me-login><\/span>/);
  assert.match(bottom, /<span class="live-note"><span class="live-dot" aria-hidden="true"><\/span> <span id="me-checked">live<\/span><\/span>/);
  assert.match(css, /\.dv2 \.pass__copy \{[^}]*width: 44px; height: 44px;/, "a 44 px target");
  assert.match(css, /\.dv2 \.pass \.live-dot, \.dv2 \.pass \.live-dot::after \{ background: #7CF0C5; \}/);
  assert.match(css, /\.dv2 #me-checked \{ min-width: 6\.4em; \}/, "the room of its longest text: no jump");
});

test("D4: one standing card keeps every id the scripts fill; one line and at most one button when there is nothing to rank", async () => {
  for (const id of ["d-amount", "d-amount-sub", "d-rank", "d-rank-sub", "d-crank", "d-crank-sub", "d-nrank", "d-nrank-sub", "d-city-label", "d-country-label", "d-worth"]) assert.equal((html.match(new RegExp(`\\bid="${id}"`, "g")) || []).length, 1, id);
  const top = src.slice(src.indexOf('<div class="dash-top" id="dash-top">'), src.indexOf('<section class="wcard"'));
  assert.doesNotMatch(top, /stat-row--dash|💰|🏆|🏙️|🌎|📍/, "the four emoji tiles are gone (and the Pass's pin is the icon set's)");
  // no wallet: one line, no second Connect button (the wallet card is the first card)
  const a = await openDashboard({ me: memberMe() });
  assert.equal(a.$("#standing").getAttribute("data-state"), "nowallet");
  assert.equal(a.$("#standing .standing__hold").hidden, true); assert.equal(a.$("#standing .standing__ranks").hidden, true);
  assert.equal(a.text("#standing .standing__why"), "Link a wallet to see your rank.");
  assert.equal(a.$("#standing .standing__go").hidden, true);
  // launched, a wallet, nothing held: "Not ranked yet" and Get $VICINITY (to the Buy card)
  const b = await openDashboard({ me: memberMe({ wallet: ADDR, launched: true }) });
  assert.equal(b.text("#standing .standing__why"), "Not ranked yet.");
  assert.equal(b.$("#standing .standing__go").hidden, false); assert.equal(b.text("#standing .standing__go"), "Get $VICINITY"); assert.equal(b.$("#standing .standing__go").dataset.go, "#trade");
  // ranked: the amount big, the exact one only when the short one rounds it, a chip per rank that exists (never a dash)
  const me = memberMe({ wallet: ADDR, launched: true, amount: 62_718_153, rank: 2 });
  me.holding.total = 35; me.community.rank = 1; me.community.holders = 1;
  const c = await openDashboard({ me });
  assert.equal(c.$("#standing").getAttribute("data-state"), "ranked");
  assert.equal(c.text("#d-amount"), "62.7M"); assert.equal(c.$("#d-amount-sub").hidden, false); assert.equal(c.text("#d-amount-sub"), "62,718,153 $VICINITY");
  assert.equal(c.text("#d-rank"), "#2"); assert.equal(c.text("#d-rank-sub"), "of 35 holders");
  assert.equal(c.text("#d-crank"), "#1"); assert.equal(c.$("#d-crank").parentNode.hidden, false); assert.equal(c.text("#d-crank-sub"), "of 1 holder here");
  assert.equal(c.$("#d-nrank").parentNode.hidden, true, "no country rank: no chip");
  assert.equal(c.$("#standing .standing__empty").hidden, true);
  const small = memberMe({ wallet: ADDR, launched: true, amount: 50, rank: 9 }); small.holding.total = 35;
  const d = await openDashboard({ me: small });
  assert.equal(d.text("#d-amount"), "50"); assert.equal(d.$("#d-amount-sub").hidden, true, "50 and 50: said once");
});

/* ---------- a new member ---------- */
test("D5: a member without a wallet: the welcome and the wallet card are ONE first card; Today, the role card and the Buy card do not repeat the link", async () => {
  const p = await openDashboard({ search: "welcome=1", me: memberMe() });
  const panel = p.$("#panel-home"), kids = panel.children.filter((n) => !n.hidden).map((n) => n.id);
  assert.deepEqual(kids.slice(0, 3), ["welcome", "wallet-card", "dash-top"], "the welcome, then the wallet card, then the Pass");
  assert.ok(p.$("#welcome").classList.contains("is-merged") && p.$("#wallet-card").classList.contains("is-merged"), "drawn as one card");
  assert.equal(p.text("#wcard-go"), "Connect wallet"); assert.equal(p.$("#wcard-go").getAttribute("href"), "/connect?mode=link");
  assert.match(p.text("#wcard-lead"), /never asks for your recovery phrase or private key/, "the safety line stays");
  assert.equal(p.$("#wcard-skip").hidden, false);
  assert.ok(!p.$$("#today-list a").some((a) => /Link your wallet/.test(a.textContent)), "no second Link your wallet in Today");
  assert.ok(!p.$$("#role-home a").some((a) => /Link my wallet/.test(a.textContent)), "no Link button in the role card");
  assert.ok(p.$("#trade").classList.contains("is-locked")); assert.equal(p.$("#trade .trade__lock").hidden, false);
  assert.equal(p.text("#trade .trade__lock-text"), "Buying needs a wallet");
  // dismissed: the wallet card stays first, on its own
  await p.tap(p.$("#welcome-close"));
  assert.equal(p.$("#welcome").hidden, true);
  assert.equal(p.$("#wallet-card").classList.contains("is-merged"), false);
  assert.deepEqual(panel.children.filter((n) => !n.hidden).map((n) => n.id).slice(0, 2), ["wallet-card", "dash-top"]);
  // the welcome close: 44 px, "Dismiss", visible in both themes
  assert.match(src, /<button class="icon-btn welcome__close" type="button" id="welcome-close" aria-label="Dismiss"><svg /);
  assert.match(css, /\.dv2 \.welcome__close \{ top: 6px; right: 6px; width: 44px; height: 44px; color: var\(--text\); border: 1px solid var\(--line-2\); background: var\(--card-2\);/);
});

test("D5: tickers are never cut: no .slice(0, 5) on a ticker; the disc gets the length and the stylesheet steps the size down", async () => {
  for (const [name, code] of [["dashboard.js", dash], ["profile.js", profile]]) {
    assert.doesNotMatch(code, /\.slice\(0, ?5\)/, `${name}: no ticker cut to five letters`);
    assert.match(code, /const discText = \(span, tk\) => \{ span\.textContent = tk; const disc = span\.parentNode; if \(disc && disc\.dataset\) disc\.dataset\.len = String\(Math\.min\(String\(tk\)\.length, 12\)\); \};/);
  }
  for (const sel of ["#cc-face", "#pass-coin"]) assert.match(dash, new RegExp(`discText\\(\\$\\("${sel}"\\), tk\\)`));
  assert.match(dash, /if \(c\) discText\(\$\("#welcome-disc"\), coinDisc\(c\)\);/);
  for (const code of [dash, v2]) assert.doesNotMatch(code, /vicinityTicker|baseTicker\(/, "the dashboard never makes a ticker up from the city name: the server's ticker or the city name");
  for (const sel of [".welcome__disc", ".pass__coin", ".coin-disc"]) assert.ok(css.includes(`.dv2 ${sel}[data-len="5"]`), `${sel} has a size for 5 letters`);
  assert.match(css, /\.dv2 \.coin-disc span, \.dv2 \.pass__coin span \{ max-width: none; overflow: visible; white-space: nowrap; \}/);
  const me = memberMe(); me.community = { ...me.community, ticker: "SAOPAULO", name: "São Paulo" };
  const p = await openDashboard({ search: "welcome=1", me });
  assert.equal(p.text("#welcome-disc"), "SAOPAULO"); assert.equal(p.$(".welcome__disc").dataset.len, "8");
  assert.equal(p.text("#pass-coin"), "SAOPAULO"); assert.equal(p.$(".pass__coin").dataset.len, "8");
});

/* ---------- Buy on the dashboard ---------- */
test("D6: a phone's Safari with the wallet linked has ONE buy path: the Buy card steps back (no panel mounted in it), the wallet card says Buy in Phantom", async () => {
  const me = memberMe({ wallet: ADDR, launched: true }); me.user.walletApp = "phantom";
  const p = await openDashboard({ ua: UA.iphone, me, storage: { "vicinity.walletApp": "phantom" } });
  assert.equal(p.$("#trade").hidden, true, "no Buy card that cannot sign here");
  assert.equal(p.$("#wallet-card").hidden, false); assert.equal(p.$("#wallet-card").dataset.place, "buy");
  const kids = p.$("#panel-home").children.map((n) => n.id);
  assert.equal(kids.indexOf("wallet-card"), kids.indexOf("trade") + 1, "it stands where the Buy card was");
  assert.equal(p.text("#wcard-kicker"), "Buy $VICINITY"); assert.equal(p.text("#wcard-title"), "Buy in Phantom"); assert.equal(p.text("#wcard-go"), "Open Phantom");
  assert.equal(p.text("#wcard-lead"), "Opens Vicinity inside Phantom, logged in. You buy there.");
  assert.equal(p.$("#tr-swap"), null, "no swap panel was mounted where nobody sees it");
  // "Get $VICINITY" anywhere lands on the wallet card there
  p.win.VDash.goTo("#trade"); await p.flush();
  assert.ok(p.$("#wallet-card").classList.contains("is-target"));
  // a computer keeps the Buy card
  const q = await openDashboard({ ua: UA.desktop, me });
  assert.equal(q.$("#trade").hidden, false); assert.equal(q.$("#wallet-card").hidden, true);
  // the panel is never mounted while the card is away, so a trade link (swap_*) opens the sheet instead (public/swap.js settleLink)
  assert.match(dash, /const tradeAway = \(\) => Boolean\(v2 && me && me\.user && me\.signupFlow === "v2" && \(!me\.user\.wallet \|\| phoneBrowser\(\)\)\);\n\s+function mountSwap\(a, b, missing\) \{\n\s+if \(!swapOn \|\| !window\.VSwap \|\| tradeAway\(\)\) return false;/);
  assert.match(css, /\.dv2 :is\(\.swap, \.swap__wallets\) \{ scroll-margin-top: calc\(var\(--header-h, 67px\) \+ var\(--dd-strip\) \+ 12px\); \}/);
  assert.match(css, /\.dv2 #trade\.has-panel \.trade__head, \.dv2 #trade\.has-panel #trade-title \{ display: none; \}/, "one heading: the panel's");
});

/* ---------- the other cards ---------- */
test("D8: the role card's Resign sits in the Founder tab's Danger zone with the same confirm; the Profile tab's rows and the moved privacy text", async () => {
  const me = memberMe({ wallet: ADDR, launched: true, amount: 300_000, rank: 3 });
  me.level = "founder"; me.roles = { ...me.roles, founder: true };
  me.founder = { ...me.founder, seat: { id: 9, cityId: "5142056", city: "Utica", country: "US", status: "active", since: new Date().toISOString(), threshold: 100000 } };
  const p = await openDashboard({ me });
  assert.equal(p.$("#danger-zone").hidden, false);
  const resign = p.$("#danger-body button");
  assert.equal(resign.textContent, "Resign as City Founder");
  assert.ok(!p.$$("#role-home button").some((b) => /Resign/.test(b.textContent)), "not one of the everyday tools");
  await p.tap(resign);
  assert.deepEqual(p.confirms, ["Resign as City Founder? The city reopens, and you wait 30 days before applying anywhere."], "the same confirm");
  assert.match(roles, /if \(!confirm\(steward \? "Resign as Seed Steward\? Your bond is released and the city reopens for someone else\."/);
  // the role tools: equal tiles with an icon each; with an odd number, "What my role can do" fills the half row (the same button, same action)
  const tiles = p.$$("#role-home .role-tools--grid > button");
  assert.ok(tiles.length >= 2);
  const more = tiles.find((b) => b.textContent === "What my role can do") || p.$$("#role-home .role-more button").find((b) => b.textContent === "What my role can do");
  assert.ok(more, "the roles link is still there");
  if (tiles.includes(more)) assert.equal(tiles.length % 2, 0, "it only joins the grid to fill an odd row");
  // Profile: one row per setting; Unlink is its own row; the full profiles text lives here now, word for word
  for (const id of ["profile-username-meta", "profile-wallet-meta", "profile-email-meta", "profile-phone-meta", "profile-bio-meta"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(src, /<button class="profile__danger" type="button" id="profile-unlink" hidden>Unlink wallet<\/button>/);
  const net = src.match(/<details class="fold profile__row" id="profile-net-sec" hidden>[\s\S]*?<\/details>/)[0];
  assert.match(net, /Other signed-in members can now open your profile and see your username, home community, bio, wallet address and your \$VICINITY and city-coin balances\. They can follow you, and you can block anyone\. There is no messaging\./);
  const notice = src.match(/<div class="pf-notice" id="pf-notice"[\s\S]*?<\/div>/)[0];
  assert.match(notice, /Members can see your wallet and balances\./, "the banner still says what others see, before Got it");
  assert.match(notice, /id="pf-notice-ok" aria-label="Got it"/);
  assert.doesNotMatch(src, /profile-theme-note/);
  p.win.V.openProfile(); await p.flush();
  assert.equal(p.text("#profile-username-meta"), "@SwiftHarbor10"); assert.equal(p.text("#profile-wallet-meta"), "7Np41*****4K2"); assert.equal(p.text("#profile-email-meta"), "Not added");
});

test("D8: Moderate says All clear when every queue is empty and folds each queue; a contract to check is a small card with Record it / Reject", async () => {
  const p = await openDashboard({ me: memberMe({ wallet: ADDR }), api: async (path) => (path === "/api/mod" ? { ok: true, moderator: true, role: "founder", scope: "Utica", posts: [], proposals: [], appeals: [], objections: [], towns: [] } : undefined) });
  assert.equal(p.text("#mod-sections .mod-clear"), "All clear. Nothing is waiting for you.");
  assert.ok(p.$$("#mod-sections details.mod-section").length >= 3);
  assert.match(dash, /actBtn\("Record it", async \(\) => \{ const x = await decide\(true, "Checked on the blockchain"\);/, "the same decision call");
  assert.match(dash, /const decide = \(approve, note\) => sensitive\(\(\) => api\("\/api\/coins\/mint\/decide", \{ city: w\.city, mint: w\.pendingMint, approve, note \}\)\);/, "it still carries the address the admin looked at");
});

test("D8: the composer says why posting is closed (the server's holders_only rule, unchanged) with one line and one button", async () => {
  const p = await openDashboard({ me: memberMe({ launched: true }) });
  assert.equal(p.$("#composer").hidden, true);
  assert.equal(p.$("#feed .composer-lock").hidden, false);
  assert.equal(p.text("#feed .composer-lock__text"), "Link a wallet and hold any $VICINITY to post.");
  assert.equal(p.text("#feed .composer-lock__go"), "Connect wallet");
  const q = await openDashboard({ me: memberMe({ launched: true, wallet: ADDR }) });
  assert.equal(q.text("#feed .composer-lock__text"), "Hold any $VICINITY to post and vote."); assert.equal(q.text("#feed .composer-lock__go"), "Get $VICINITY");
  const r = await openDashboard({ me: memberMe({ launched: true, wallet: ADDR, amount: 10, rank: 4 }) });
  assert.equal(r.$("#composer").hidden, false); assert.equal(r.$("#feed .composer-lock").hidden, true, "a holder posts as before");
  assert.match(dash, /const postLocked = \(\) => Boolean\(v2 && me && me\.launched && me\.roles && !me\.roles\.holder && !me\.roles\.admin\);/, "the same rule as src/social.js");
});

test("profile.js: without a wallet there is no portfolio card and no portfolio request; it starts once a wallet is linked", () => {
  const part = profile.slice(profile.indexOf("  function dashboard(ctx) {"), profile.indexOf("  function page() {"));
  assert.match(part, /const linked = Boolean\(d\.user && d\.user\.wallet\);\n\s+\$\("#portfolio"\)\.hidden = !linked;\n\s+if \(linked && !started\) \{/);
  assert.match(part, /\} else if \(!linked && started\) \{ started = false; pv\.stop\(\); pv = null; paintWorth\(null\); \}/);
  assert.match(part, /onAnswer: paintWorth/, "the holding's dollar value on the standing card comes from the same answer");
  // the card's answer first: the total (hidden while unknown; a partial sum says so), the ring and the table folded under "Breakdown"
  assert.match(part, /const label = t != null && r\.portfolio\.pricesComplete === false \? " total of the coins with a price" : " total, live";/);
  assert.match(part, /total\.hidden = t == null;/);
  assert.ok(!/"pf-total__/.test(part), "the ring's own SVG classes (pf-total__label/value) are not reused for the big total");
  assert.match(html, /<p class="pf-sum" id="pf-total" hidden><\/p>\s*<details class="fold pf-fold">\s*<summary>Breakdown <span class="fold__meta">/);
});
