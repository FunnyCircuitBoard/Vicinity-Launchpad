// Builds the site's pages: public/<name>.html = the shared layout (head, floating header, phone tab bar, footer) + the page's own
// content from scripts/pages/src/<name>.html. Design v4 (12 Oct 2026): a slim floating glass header (the brand, four links, Log in and
// one orange "Sign up"; signed in, one avatar that opens the account sheet), a five-tab bar on phones, and a minimal footer (the copyright line, Terms / Rules / Official addresses / Data / Check a link, the
// official social accounts from src/official.js, and one security line: Vicinity never asks for a recovery phrase; not a risk line). Every page loads style.css and then polish.css. No page carries a
// site-entry Terms of Use modal any more: the Terms are accepted at account creation and on /terms, and the footer links them everywhere.
// The product's names in the layout (titles, the header's brand, the copyright line, the social labels, the security line) come from
// src/brand.js with the BRAND setting of wrangler.jsonc: unset is today's labels, byte for byte (test/build-parity.test.js).
//   npm run pages
// Edit the files in scripts/pages/, never the generated public/*.html (a test checks they match).
//
// Each source file starts with one line of settings:
//   <!--{"title": "...", "description": "...", "page": "home", "scripts": ["home"], "styles": ["extra"], "main": "class"}-->
// ("noindex": true keeps a page out of search engines; "styles" are extra stylesheets from public/, e.g. "admin" -> /admin.css; never an inline <style>, the security policy blocks it;
//  "nav": "launchpad" marks that menu entry as the current page for a page that is not in the menu itself (the coin page /coin);
//  "standalone": true builds the page like any other, but buildPages() leaves it out: test/site.test.js lists the main pages one by one and says only the admin console is noindex.
//  The standalone pages come from buildStandalonePages() and are written by the same command; the tests of their own cover them.)
// A source may hold a fill, <!--@name-->, which the build replaces with markup made from the site's own data (FILLS below); an
// unknown name stops the build. Today: <!--@official-addresses--> on /official, the address list of src/official.js officialAddresses()
// with the settings of wrangler.jsonc (what the Worker runs with), so no address is typed into a page.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SOCIAL_PROFILES, officialAddresses, socialProfiles } from "../../src/official.js";
import { brandLabels, brandOf } from "../../src/brand.js";
import { esc, escBrand, rewriteSocialLinks, socialList } from "../../src/footer-social.js";
import { mainTokenV5On } from "../../src/flags.js";
import { isSolanaAddress } from "../../src/solana.js";
import { settingsFrom } from "../mainnet-preflight.mjs";

const SRC = fileURLToPath(new URL("./src/", import.meta.url));
const OUT = fileURLToPath(new URL("../../public/", import.meta.url));

// The header's links (computers; prompt item 1: Launchpad, Live map, App preview, Dashboard) and the phone tab bar's five tabs (the
// Token page keeps a thumb slot; the app teaser does not earn one). [page, href, label]  /  [page, href, label, icon]
const HEADER_NAV = [
  ["launchpad", "/launchpad", "Launchpad"],
  ["cities", "/cities", "Live map"],
  ["app", "/app", "App preview"],
  ["dashboard", "/dashboard", "Dashboard"],
];
const TABS = [
  ["home", "/", "Home", '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>'],
  ["launchpad", "/launchpad", "Launchpad", '<path d="M12 3c3 2.2 4.5 5.6 4.5 9.3l-1.8 3.2H9.3l-1.8-3.2C7.5 8.6 9 5.2 12 3z"/><circle cx="12" cy="9.8" r="1.6"/><path d="M9.3 15.5 7 19l3-1M14.7 15.5 17 19l-3-1M12 17.5V21"/>'],
  ["cities", "/cities", "Map", '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>'],
  ["token", "/token", "Token", '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M9.5 9.5h3.75a1.75 1.75 0 0 1 0 3.5h-2.5a1.75 1.75 0 0 0 0 3.5h3.75"/>'],
  ["dashboard", "/dashboard", "Me", '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.8-3.8 3.9-6 7.5-6s6.7 2.2 7.5 6"/>'],
];
// The account sheet (signed in): the header's one avatar opens it (site.js accountSheet), a bottom sheet on a phone and a small popover
// on a computer. The member's username and home community at the top, then Profile, Account and Settings, each an existing place of the
// dashboard (the Profile tab, its Wallet and sign-in rows, the notification settings), and Log out. Static markup filled with textContent.
const SHEET_ICON = (paths) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ACCOUNT_LINKS = [
  ["profile", "/dashboard#profile", "Profile", "Username, bio and how members see you", '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="11" r="2.2"/><path d="M5.9 16c.5-1.5 1.7-2.4 3.1-2.4s2.6.9 3.1 2.4M14.5 10h3.5M14.5 13.5h2.5"/>'],
  ["account", "/dashboard#profile-account", "Account", "Wallet, sign-in, e-mail and phone", '<circle cx="8" cy="15.5" r="3.5"/><path d="M10.5 13 19 4.5M15.5 8l2.5 2.5M17.5 6l2 2"/>'],
  ["settings", "/dashboard#notice-prefs", "Settings", "Notifications: what you get told about", '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'],
];
const ACCOUNT_SHEET = `  <div class="acct" id="acct-sheet" data-acct hidden>
    <div class="acct__scrim" data-acct-close></div>
    <div class="acct__panel" id="acct-panel" role="dialog" aria-modal="true" aria-label="Your account" tabindex="-1">
      <span class="acct__grab" aria-hidden="true"></span>
      <div class="acct__who">
        <span class="acct__av" data-acct-initial aria-hidden="true"></span>
        <div class="acct__id">
          <p class="acct__name" data-acct-name>Your account</p>
          <p class="acct__home">${SHEET_ICON('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>')}<span data-acct-home></span></p>
        </div>
        <button class="acct__x" type="button" data-acct-close aria-label="Close">${SHEET_ICON('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>')}</button>
      </div>
      <nav class="acct__nav" aria-label="Account menu">
        <ul class="acct__links">
${ACCOUNT_LINKS.map(([k, href, label, hint, paths]) => `          <li><a class="acct__link" href="${href}" data-acct-go="${k}"><span class="acct__ico">${SHEET_ICON(paths)}</span><span class="acct__text"><strong>${label}</strong><span>${hint}</span></span><span class="acct__chev" aria-hidden="true">${SHEET_ICON('<path d="M9.5 6l6 6-6 6"/>')}</span></a></li>`).join("\n")}
        </ul>
      </nav>
      <button class="acct__out" type="button" data-acct-logout>${SHEET_ICON('<path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14"/><path d="M10 8l-4 4 4 4M6 12h9.5"/>')}<span>Log out</span></button>
    </div>
  </div>`;
const icon = (paths) => `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const current = (page, p) => (page === p ? ' aria-current="page"' : "");
// the theme switch: a moon in the dark theme, a sun in the light one (style.css shows one); in the header, and in the footer on phones
const THEME_ICONS = '<svg class="moon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.6A8 8 0 0 1 9.4 4a8 8 0 1 0 10.6 10.6z"/></svg>' +
  '<svg class="sun" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>';
const themeToggle = (cls) => `<button class="${cls}" type="button" data-theme-toggle aria-label="Switch to light mode" aria-pressed="false">${THEME_ICONS}</button>`;

// The official social accounts (rule R3: only real ones): src/official.js socialProfiles() becomes one round icon link each in the
// footer (src/footer-social.js, shared with the Worker's response-time rewrite), so a new network shows on the next build the moment
// it is listed there; a network without an icon shows its name. With MAIN_TOKEN_V5 off that is SOCIAL_PROFILES, as before.
// `L`: the labels of src/brand.js brandLabels(), made from an escaped label set (escBrand below), so each is safe in markup as it is
function layout({ title, description, page, nav: navPage = page, scripts = [], styles = [], main = "", noindex = false }, body, L, socials) {
  const nav = HEADER_NAV.map(([p, href, label]) => `        <a href="${href}"${current(navPage, p)}>${label}</a>`).join("\n");
  const tabs = TABS.map(([p, href, label, paths]) => `    <a href="${href}"${current(navPage, p)}>${navPage === p ? '<span class="tabbar__ind" aria-hidden="true"></span>' : ""}${icon(paths)}<span>${label}</span></a>`).join("\n");
  // feedback.js (the floating Feedback / Support widget) runs last on every page: it needs window.V from site.js and nothing else needs it
  const js = ["site", ...scripts, "feedback"].map((s) => `  <script src="/${s}.js" defer></script>`).join("\n");
  const fullTitle = page === "home" ? L.homeTitle : L.pageTitle(title);
  return `<!doctype html>
<!-- Generated by scripts/pages/build.mjs from scripts/pages/src/${page === "home" ? "index" : page}.html. Edit those, then run: npm run pages -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${fullTitle}</title>
  <meta name="description" content="${description}">
${noindex ? '  <meta name="robots" content="noindex, nofollow">\n' : ""}  <meta name="theme-color" content="#070E19">
  <meta name="color-scheme" content="dark">
  <meta property="og:title" content="${fullTitle}">
  <meta property="og:description" content="${description}">
  <meta property="og:type" content="website">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preload" href="/fonts/space-grotesk.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/polish.css">
  <link rel="stylesheet" href="/feedback.css">${styles.map((c) => `\n  <link rel="stylesheet" href="/${c}.css">`).join("")}
  <script src="/theme.js"></script>
</head>
<body data-page="${page}">
  <a class="skip" href="#main">Skip to content</a>

  <header class="site-header" data-header>
    <div class="site-header__inner">
      <a class="brand" href="/" aria-label="${L.homeLink}">
        <img src="/logo.svg" alt="" width="28" height="28">
        <span>${L.headerName}</span>
      </a>
      <nav class="nav" aria-label="Main">
${nav}
      </nav>
      <div class="site-header__actions">
        ${themeToggle("theme-toggle")}
        <a class="btn btn--ghost btn--sm account-btn" href="/connect?mode=login" data-account><span class="btn__dot" aria-hidden="true"></span><span data-account-label>Log in</span></a>
        <button class="hdr-avatar" type="button" data-account-avatar aria-haspopup="dialog" aria-expanded="false" aria-controls="acct-panel" aria-label="Profile, account and settings" hidden><span class="hdr-avatar__face" data-account-initial aria-hidden="true"></span></button>
        <a class="btn btn--primary btn--sm hdr-signup has-ring" href="/connect" data-signup>Sign up</a>
      </div>
    </div>
  </header>
${ACCOUNT_SHEET}

  <main id="main"${main ? ` class="${main}"` : ""}>
${body.trimEnd()}
  </main>

  <footer class="site-footer">
    <div class="wrap site-footer__inner">
      <p class="site-footer__copy"><img src="/logo.svg" alt="" width="20" height="20"> ${L.copyright}</p>
      <nav class="site-footer__links" aria-label="Legal and data">
        <a href="/terms">Terms</a><a href="/rules">Rules</a><a href="/official">Official addresses</a><a href="/credits">Data</a><a href="/token#check">Check a link</a>
      </nav>
${socialList(socials, L)}      ${themeToggle("theme-toggle site-footer__theme")}
      <p class="site-footer__safe">${L.safety}</p>
    </div>
  </footer>

  <nav class="tabbar" aria-label="Main (phone)">
${tabs}
  </nav>

  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
${js}
</body>
</html>
`;
}

/* ---------------------------------------------------------------- fills */
/** The settings the Worker runs with: the "vars" of wrangler.jsonc (nothing from this shell, so every build of a commit is the same). */
export const deployedVars = () => settingsFrom({ wranglerPath: new URL("../../wrangler.jsonc", import.meta.url), env: {} });
const solscan = (r) => `https://solscan.io/${r.kind === "token" ? "token" : "account"}/${r.address}`;
/**
 * One address: its label, the address itself, a note, a Copy button (site JS shows it) and its Solscan page (and one more page, e.g. the
 * lock's). Its classes are off-row*, never the bare "addr": that is style.css's round address pill, which would clip the whole row.
 */
function addressRow(r) {
  if (!isSolanaAddress(r.address)) throw new Error(`official addresses: "${r.label}" is not a Solana address (${r.address})`);
  const out = (href, text) => {
    if (!/^https:\/\/[^\s"'<>]+$/.test(href)) throw new Error(`official addresses: "${r.label}" links ${href}`);
    return `<a class="btn btn--ghost btn--sm" href="${href}" target="_blank" rel="noopener">${esc(text)}<span class="sr-only">: ${esc(r.label)} (opens in a new tab)</span></a>`;
  };
  return [
    `            <div class="credits__row off-row" data-address="${r.address}">`,
    `              <dt>${esc(r.label)}</dt>`,
    `              <dd>`,
    `                <p><code class="off-row__value">${r.address}</code></p>`,
    ...(r.note ? [`                <p class="credits__note">${esc(r.note)}</p>`] : []),
    `                <p class="off-row__acts"><button class="btn btn--ghost btn--sm" type="button" data-copy="${r.address}" aria-label="Copy the address (${esc(r.label)})" hidden>Copy</button>${out(solscan(r), "Solscan")}${r.link ? out(r.link.href, r.link.text) : ""}</p>`,
    `              </dd>`,
    `            </div>`,
  ].join("\n");
}
/** Groups of addresses (src/official.js officialAddresses) as the page's sections. */
export const addressSections = (groups) => groups.map((g) => [
  `        <section class="credits__group" aria-labelledby="off-${g.id}">`,
  `          <h2 class="credits__h" id="off-${g.id}">${esc(g.title)}</h2>`,
  `          <dl class="credits__list">`,
  ...g.rows.map(addressRow),
  `          </dl>`,
  `        </section>`,
].join("\n")).join("\n\n");
const FILLS = { "official-addresses": () => addressSections(officialAddresses(deployedVars())) };
const fill = (f, body) => body.replace(/<!--@([a-z-]+)-->/g, (_, name) => {
  if (!Object.hasOwn(FILLS, name)) throw new Error(`${f}: unknown fill <!--@${name}-->`);
  return FILLS[name]();
});

/** The label set the pages are built with: BRAND from wrangler.jsonc (never from this shell). An unknown value stops the build. */
export function pageBrand(vars = deployedVars()) {
  const b = brandOf(vars);
  if (b.problem) throw new Error(`BRAND=${JSON.stringify(vars.BRAND)} is not a label set of src/brand.js (${b.problem})`);
  return b;
}
/**
 * The official social accounts the footers are built with: src/official.js socialProfiles() for the settings of wrangler.jsonc (never this
 * shell). MAIN_TOKEN_V5 off: SOCIAL_PROFILES, today's footer byte for byte. MAIN_TOKEN_V5=on in wrangler.jsonc stops the build until the
 * brand rollout exists (owner amendment 01 section 3: the switch "rolls out with the brand rollout (BRAND=citycoin, stage S48) or after
 * it"): the pages still name $VICINITY as the token (the token page's copy, its 60M lock card, the client scripts' labels), so building
 * them under the switch would show $VICINITY wording next to the new mint. Tests build the switched footers with `socials`.
 */
export function pageSocials(vars = deployedVars()) {
  if (!mainTokenV5On(vars)) return socialProfiles(vars);
  const b = brandOf(vars);
  if (b.problem || b.value === "") throw new Error("MAIN_TOKEN_V5=on in wrangler.jsonc: the main-token switch rolls out with or after the brand rollout (BRAND=citycoin, stage S48); the pages still name $VICINITY as the token");
  return socialProfiles(vars);
}

function build(standalone, brand, socials) {
  const L = brandLabels(escBrand(brand));
  const out = [];
  for (const f of readdirSync(SRC).filter((x) => x.endsWith(".html")).sort()) {
    const src = readFileSync(SRC + f, "utf8").replace(/\r\n/g, "\n");
    const m = src.match(/^<!--(\{.*\})-->\n/);
    if (!m) throw new Error(`${f}: first line must be <!--{settings}-->`);
    const settings = JSON.parse(m[1]);
    if (Boolean(settings.standalone) !== standalone) continue;
    const html = layout(settings, fill(f, src.slice(m[0].length)), L, socials);
    // other configured lists (MAIN_TOKEN_V5 on): the page's other links to the former X account follow too (the dashboard's "Contact us on
    // X"), by the same function the Worker rewrites with, so a built page and a rewritten one are the same bytes; today's list: untouched
    out.push([f, socials === SOCIAL_PROFILES ? html : rewriteSocialLinks(html, socials, L)]);
  }
  return out;
}

/** The main pages: [output file, html]. `brand` (a label set of src/brand.js shape) and `socials` (profiles of src/official.js
 *  socialProfiles shape) are for tests; the defaults are pageBrand() and pageSocials(). */
export const buildPages = ({ brand, socials } = {}) => build(false, brand ?? pageBrand(), socials ?? pageSocials());
/** Pages that carry "standalone": true (see the top of this file). */
export const buildStandalonePages = ({ brand, socials } = {}) => build(true, brand ?? pageBrand(), socials ?? pageSocials());

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [f, html] of [...buildPages(), ...buildStandalonePages()]) { writeFileSync(OUT + f, html); console.log("page ready:", f); }
}
