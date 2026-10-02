// src/official.js: recovered from the code deployed on Cloudflare (Worker "vicinity-map", 2026-10-02).
// The original comments and formatting were lost in the bundle; the code is the deployed code, byte for byte after bundling.
var VICINITY_MINT = null;
var LAUNCHPAD_OPENS_AT = "2026-10-10T10:10:10-04:00";
var OFFICIAL = {
  updated: "2026-09-27",
  // vicinity.city is the main address; vicinitycity.net forwards to it
  websites: ["vicinity.city", "vicinitycity.net", "vicinity-map.sakibul-noyon.workers.dev", "vicinity-map.noyonsakibul.workers.dev"],
  github: [],
  // code is private
  socials: ["@VicinityCitySOL"],
  // official X account (verified 2026-09-30)
  tokenContract: VICINITY_MINT,
  teamWallets: [],
  // every wallet the team controls, listed publicly
  launchpadOpensAt: LAUNCHPAD_OPENS_AT,
  // Every official Vicinity token on every network. Anything not listed here is fake.
  tokens: [
    { network: "Solana", name: "Vicinity", symbol: "VICINITY", contract: VICINITY_MINT, platform: "Raydium LaunchLab", status: "Launching October 3, 2026" },
    { network: "Solana", name: "City coins (one per city)", symbol: "e.g. $UTICA", contract: null, platform: "Vicinity Launchpad", status: "Phase 3" }
  ]
};
var clean = (s) => String(s || "").trim().slice(0, 300);
function checkOfficial(input, isSolanaAddress2) {
  const raw = clean(input);
  if (!raw) return { verdict: "empty", message: "Paste a link, address or @handle to check it." };
  if (isSolanaAddress2(raw)) {
    if (OFFICIAL.tokenContract && raw === OFFICIAL.tokenContract)
      return { verdict: "official", kind: "contract", message: "This is the official $VICINITY contract address." };
    if (OFFICIAL.teamWallets.includes(raw))
      return { verdict: "official", kind: "wallet", message: "This is a published Vicinity team wallet." };
    return {
      verdict: "not_official",
      kind: "address",
      message: OFFICIAL.tokenContract ? "This address is NOT the official $VICINITY contract or a team wallet." : "$VICINITY has not launched, so there is no official contract address yet. Any token using this name right now is fake."
    };
  }
  if (/^@[A-Za-z0-9_.]{1,40}$/.test(raw)) {
    const ok = OFFICIAL.socials.map((h) => h.toLowerCase()).includes(raw.toLowerCase());
    return ok ? { verdict: "official", kind: "social", message: "This is an official Vicinity account." } : { verdict: "not_official", kind: "social", message: "Vicinity has no official social accounts yet, so this account is not us." };
  }
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch {
    url = null;
  }
  if (url && url.hostname.includes(".")) {
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const hostPath = (host + url.pathname.toLowerCase()).replace(/\/+$/, "");
    if (url.protocol === "http:" && OFFICIAL.websites.includes(host))
      return { verdict: "warning", kind: "website", message: "Right site, but the link uses http. Use the https version." };
    if (OFFICIAL.websites.includes(host))
      return { verdict: "official", kind: "website", message: "This is the official Vicinity website." };
    if (host === "github.com" && OFFICIAL.github.some((g) => hostPath === g || hostPath.startsWith(g + "/")))
      return { verdict: "official", kind: "github", message: "This is the official Vicinity code repository." };
    const lookalike = /v[i1l]c[i1l]n[i1l]ty/i.test(host);
    return {
      verdict: "not_official",
      kind: "website",
      message: lookalike ? "Careful: this looks like a copy of our name, but it is NOT an official Vicinity site. Don't connect your wallet there." : "This link is not on our official list."
    };
  }
  return { verdict: "unknown", message: "That doesn't look like a link, Solana address or @handle." };
}
var activeMint = (env) => env && env.VICINITY_MINT || VICINITY_MINT;
function officialFor(env) {
  if (env && env.SITE_MODE === "preview") {
    return {
      ...OFFICIAL,
      siteMode: "preview",
      announcedOpensAt: OFFICIAL.launchpadOpensAt,
      launchpadOpensAt: new Date(Date.now() - 864e5).toISOString()
      // "opened yesterday"
    };
  }
  return { ...OFFICIAL, siteMode: "live" };
}
var SUPPORTER_SNAPSHOT_AT = null;
export { LAUNCHPAD_OPENS_AT, OFFICIAL, SUPPORTER_SNAPSHOT_AT, activeMint, checkOfficial, officialFor };
