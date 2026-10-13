// Builds the site's pages: public/<name>.html = the shared layout (head, floating header, phone tab bar, footer) + the page's own
// content from scripts/pages/src/<name>.html. Design v4 (12 Oct 2026): a slim floating glass header (the brand, four links, Log in and
// one orange "Sign up"), a five-tab bar on phones, and a minimal footer (the copyright line, Terms / Rules / Data / Check a link, the
// official social accounts from src/official.js, and one security line: Vicinity never asks for a recovery phrase; not a risk line). Every page loads style.css and then polish.css. No page carries a
// site-entry Terms of Use modal any more: the Terms are accepted at account creation and on /terms, and the footer links them everywhere.
//   npm run pages
// Edit the files in scripts/pages/, never the generated public/*.html (a test checks they match).
//
// Each source file starts with one line of settings:
//   <!--{"title": "...", "description": "...", "page": "home", "scripts": ["home"], "styles": ["extra"], "main": "class"}-->
// ("noindex": true keeps a page out of search engines; "styles" are extra stylesheets from public/, e.g. "admin" -> /admin.css; never an inline <style>, the security policy blocks it;
//  "nav": "launchpad" marks that menu entry as the current page for a page that is not in the menu itself (the coin page /coin);
//  "standalone": true builds the page like any other, but buildPages() leaves it out: test/site.test.js lists the main pages one by one and says only the admin console is noindex.
//  The standalone pages come from buildStandalonePages() and are written by the same command; the tests of their own cover them.)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SOCIAL_PROFILES } from "../../src/official.js";

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
const icon = (paths) => `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const current = (page, p) => (page === p ? ' aria-current="page"' : "");
// the theme switch: a moon in the dark theme, a sun in the light one (style.css shows one); in the header, and in the footer on phones
const THEME_ICONS = '<svg class="moon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.6A8 8 0 0 1 9.4 4a8 8 0 1 0 10.6 10.6z"/></svg>' +
  '<svg class="sun" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>';
const themeToggle = (cls) => `<button class="${cls}" type="button" data-theme-toggle aria-label="Switch to light mode" aria-pressed="false">${THEME_ICONS}</button>`;

// The official social accounts (rule R3: only real ones). Every entry of SOCIAL_PROFILES in src/official.js becomes a round icon link
// in the footer, so a new network shows on the next build the moment it is listed there; a network without an icon here shows its name.
// The paths are Simple Icons' (CC0), drawn in the text colour.
const SOCIAL_ICON = {
  x: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  telegram: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
  discord: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
  youtube: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  instagram: "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.668 1.0745-1.3367 1.3795-2.1272.2957-.7637.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077",
  tiktok: "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z",
};
// the network's name and the handle are written into the page as text: escaped, so an entry with a quote or "<" cannot break the markup
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const socialLinks = () => SOCIAL_PROFILES.map((p) => {
  const url = p.url || `https://${p.hosts[0]}/${p.handle.replace(/^@/, "")}`;
  if (!/^https:\/\/[^\s"'<>]+$/.test(url)) throw new Error(`SOCIAL_PROFILES: ${p.network} needs an https:// address (${url})`);
  const path = SOCIAL_ICON[p.network.toLowerCase()];
  const face = path ? `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="${path}"/></svg>` : `<span class="social-link__name">${esc(p.network)}</span>`;
  return `        <li><a class="social-link" href="${url}" target="_blank" rel="noopener me" aria-label="Vicinity on ${esc(p.network)} (${esc(p.handle)}), opens in a new tab">${face}</a></li>`;
}).join("\n");

function layout({ title, description, page, nav: navPage = page, scripts = [], styles = [], main = "", noindex = false }, body) {
  const nav = HEADER_NAV.map(([p, href, label]) => `        <a href="${href}"${current(navPage, p)}>${label}</a>`).join("\n");
  const tabs = TABS.map(([p, href, label, paths]) => `    <a href="${href}"${current(navPage, p)}>${navPage === p ? '<span class="tabbar__ind" aria-hidden="true"></span>' : ""}${icon(paths)}<span>${label}</span></a>`).join("\n");
  // feedback.js (the floating Feedback / Support widget) runs last on every page: it needs window.V from site.js and nothing else needs it
  const js = ["site", ...scripts, "feedback"].map((s) => `  <script src="/${s}.js" defer></script>`).join("\n");
  const fullTitle = page === "home" ? "Vicinity — One city. One coin. One community." : `${title} · Vicinity`;
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
      <a class="brand" href="/" aria-label="Vicinity home">
        <img src="/logo.svg" alt="" width="28" height="28">
        <span>Vicinity</span>
      </a>
      <nav class="nav" aria-label="Main">
${nav}
      </nav>
      <div class="site-header__actions">
        ${themeToggle("theme-toggle")}
        <a class="btn btn--ghost btn--sm account-btn" href="/connect?mode=login" data-account><span class="btn__dot" aria-hidden="true"></span><span data-account-label>Log in</span></a>
        <a class="btn btn--primary btn--sm hdr-signup has-ring" href="/connect" data-signup>Sign up</a>
      </div>
    </div>
  </header>

  <main id="main"${main ? ` class="${main}"` : ""}>
${body.trimEnd()}
  </main>

  <footer class="site-footer">
    <div class="wrap site-footer__inner">
      <p class="site-footer__copy"><img src="/logo.svg" alt="" width="20" height="20"> Vicinity.city © 2026. All rights reserved.</p>
      <nav class="site-footer__links" aria-label="Legal and data">
        <a href="/terms">Terms</a><a href="/rules">Rules</a><a href="/credits">Data</a><a href="/token#check">Check a link</a>
      </nav>
      <ul class="site-footer__social" aria-label="Vicinity on social media" data-fb-avoid>
${socialLinks()}
      </ul>
      ${themeToggle("theme-toggle site-footer__theme")}
      <p class="site-footer__safe">Vicinity never asks for your recovery phrase or private key.</p>
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

function build(standalone) {
  const out = [];
  for (const f of readdirSync(SRC).filter((x) => x.endsWith(".html")).sort()) {
    const src = readFileSync(SRC + f, "utf8").replace(/\r\n/g, "\n");
    const m = src.match(/^<!--(\{.*\})-->\n/);
    if (!m) throw new Error(`${f}: first line must be <!--{settings}-->`);
    const settings = JSON.parse(m[1]);
    if (Boolean(settings.standalone) === standalone) out.push([f, layout(settings, src.slice(m[0].length))]);
  }
  return out;
}

/** The main pages: [output file, html]. */
export const buildPages = () => build(false);
/** Pages that carry "standalone": true (see the top of this file). */
export const buildStandalonePages = () => build(true);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [f, html] of [...buildPages(), ...buildStandalonePages()]) { writeFileSync(OUT + f, html); console.log("page ready:", f); }
}
