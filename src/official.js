/**
 * The ONE list of official Vicinity places. The website and the
 * "Is this link official?" checker both read from here.
 * Change it only by a public commit so everyone can see the history.
 */
import { coinV2ReadyOn, launchpadV2On } from "./flags.js";
import { mainTokenV5 } from "./v5policy.js";
import { launchpadCluster, launchpadTradingOn, lpSetup, swapOn } from "./cluster.js";
import { ADDRESSES } from "./sol/pda.js";
import { LEGACY_TOKENS, LEGACY_X_URL, MAIN_TOKEN_LABEL, isLegacyMint, mainMint, officialLinks } from "./maintoken.js";

// The $VICINITY mint address. Paste it here the moment the token launches (one line change).
export const VICINITY_MINT = null;

// When each real $VICINITY contract went live: the block time of its creation transaction on Raydium LaunchLab (InitializeV2 and
// the first buy, signature 5ctr2RXc…uCqUWbk, block time 1791046092). Keyed by the mint, so a test mint in VICINITY_MINT has none.
export const VICINITY_LAUNCHED = { "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray": "2026-10-03T16:48:12.000Z" };
export const launchedAtOf = (mint) => (mint && Object.hasOwn(VICINITY_LAUNCHED, mint) ? VICINITY_LAUNCHED[mint] : null);

// When the Vicinity Launchpad opens (the countdown on /launchpad). 10:10:10 AM New York time (EDT, UTC-4), Oct 10 2026.
export const LAUNCHPAD_OPENS_AT = "2026-10-10T10:10:10-04:00";

// Where each official social account lives, so a full profile link (https://x.com/VicinityCitySOL, a post on it, t.me/…)
// is checked like its @handle. Exact hosts only (www. and mobile. allowed); the account is the link's first path segment.
// A Telegram entry goes here too, with hosts ["t.me", "telegram.me"], once the owner names the official group.
export const SOCIAL_PROFILES = [
  { network: "X", handle: "@VicinityCitySOL", hosts: ["x.com", "twitter.com"] }, // verified 2026-09-30
];

export const OFFICIAL = {
  updated: "2026-09-27", // vicinity.city is the main address; vicinitycity.net forwards to it
  // Only addresses we control for sure. (The two workers.dev addresses were listed before: a workers.dev name can be
  // claimed by anyone once it is released, so a name on this list that is not ours would vouch for a fake site.)
  websites: ["vicinity.city", "vicinitycity.com", "vicinitycity.net"],
  github: [],             // code is private
  socials: [...new Set(SOCIAL_PROFILES.map((p) => p.handle))], // the official accounts' @handles (see SOCIAL_PROFILES)
  tokenContract: VICINITY_MINT,
  // Every wallet the team controls, listed publicly. 13qRam…sRiN is the owner's wallet: it created $VICINITY on Raydium
  // LaunchLab on 3 Oct 2026 (its buy was in the creation transaction) and is the site's admin wallet; listed at the owner's
  // request on 5 Oct 2026. Listed wallets are labelled "Team wallet (public)" in the holder list and listed right after the
  // pools and the team lock (src/chain.js holderOrder), the checker calls them official team wallets, and they are left out of
  // the Founding Supporter snapshot.
  // 8dQ5Rb…CxP5 is the team's account for its FOMO profile, listed at the owner's request on 13 Oct 2026 (it then held about
  // 5.8M $VICINITY and was ranked as a person until listed). It is labelled "Team wallet (FOMO)" (TEAM_WALLET_NAMES below).
  teamWallets: ["13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN", "8dQ5Rb2Y7jYWCEgyKKVMrhboEgMFvFXKNZw1KBeCxP5"],
  // The team's locked tokens. On 13 Oct 2026 the team wallet above locked 60,000,000 $VICINITY on Jupiter Lock (escrow CnRn…ejB6 of
  // the Jupiter Lock program LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn, creation transaction XYkk74…cCgNf). Read on-chain the same
  // day: cliff 2027-04-13 16:00 UTC with nothing unlocked at it, then 500,000 every 24 hours for 120 days (the first 2027-04-14
  // 16:00 UTC, the last 2027-08-11 16:00 UTC), each claimable only by the team wallet (the recipient); nobody can cancel it or change
  // who receives it (both modes 0, "none").
  // (Jupiter can still upgrade its Lock program: the site states the lock's rules and never calls it immutable.) The escrow is
  // labelled "Team lock (Jupiter Lock)" in the holder list and never ranked, the checker calls it the team lock, the token page's
  // "60M team tokens locked" card links its page, and it is left out of the Founding Supporter snapshot.
  teamLocks: [{
    address: "CnRn4NiHSfezUHxh7EUytzcoJv98yeH5CpbCgsvyejB6",
    platform: "Jupiter Lock",
    url: "https://lock.jup.ag/escrow/CnRn4NiHSfezUHxh7EUytzcoJv98yeH5CpbCgsvyejB6",
    mint: "2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray",
    recipient: "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN",
    amount: 60_000_000,
    cliff: "2027-04-13T16:00:00Z",
    end: "2027-08-11T16:00:00Z",
    perDay: 500_000,
    cancel: "none",
    changeRecipient: "none",
  }],
  launchpadOpensAt: LAUNCHPAD_OPENS_AT,
  // Every official Vicinity token on every network. Anything not listed here is fake.
  tokens: [
    { network: "Solana", name: "Vicinity", symbol: "VICINITY", contract: VICINITY_MINT, platform: "Raydium LaunchLab", status: "Launching October 3, 2026" },
    // each city coin has its own contract, listed on /launchpad once it launches (the Launchpad opened on 10 Oct 2026; "Phase 3" said
    // they did not exist yet): the list points there rather than repeating every contract
    { network: "Solana", name: "City coins (one per city)", symbol: "e.g. $UTICA", contract: null, platform: "Vicinity Launchpad", status: "Launching city by city" },
  ],
};

/**
 * A team wallet's own name, for the ones that have one (the owner, 13 Oct 2026: "mention the fomo team wallet as fomo in
 * [parenthesis]"): `tag` goes in the holder list's brackets ("Team wallet (FOMO)"), `what` in the checker's answer. Any other
 * wallet of teamWallets is "Team wallet (public)". Kept apart from teamWallets, which stays a plain list of addresses.
 */
export const TEAM_WALLET_NAMES = {
  "8dQ5Rb2Y7jYWCEgyKKVMrhboEgMFvFXKNZw1KBeCxP5": { tag: "FOMO", what: "the team's FOMO account" },
};
const teamWalletName = (address) => (Object.hasOwn(TEAM_WALLET_NAMES, address) ? TEAM_WALLET_NAMES[address] : null);
/** The holder list's label for a team wallet: "Team wallet (FOMO)" for a named one, "Team wallet (public)" for the rest. */
export const teamWalletLabel = (address) => `Team wallet (${teamWalletName(address)?.tag || "public"})`;
/** The holder list's label for a team lock of teamLocks: "Team lock (Jupiter Lock)". */
export const teamLockLabel = (lock) => `Team lock (${lock.platform})`;

// Who can upgrade our two Solana programs on mainnet (vicinity_launchpad and vicinity_rewards, deployed 10 Oct 2026): the owner's
// Squads vault, a multisig of 3 signers that needs 2 of them (multisig 6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV), set back on
// 12 Oct 2026 (solana/release/mainnet-2026-10-10/BUILD.md, setup step 2). Read on chain on 16 Oct 2026: both programs' ProgramData
// accounts (A6xs…3N1a, 8M6e…pdUN) name it as their upgrade authority. Listed on /official (officialAddresses below). If it ever
// changes, this line changes in the same public commit.
export const PROGRAM_UPGRADE_AUTHORITY = "AB5qB1iAukPB7p1dkukQ1qSke3yQBDeSd5o69dLFGs7X";
// The Squads v4 multisig that vault belongs to (the vault is its index 0: ["multisig", this, "vault", 0] under
// SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf). Read on chain on 16 Oct 2026: threshold 2, 3 members, no config authority, no time
// lock. The vault's own Solscan page does not show the 2-of-3 rule, this account's does, so /official links it next to the vault.
export const PROGRAM_UPGRADE_MULTISIG = "6v8hwKYSAWXXx6ZGGmvbg87n8eVy9MAgNruFgVqRFjYV";

const clean = (s) => String(s || "").trim().slice(0, 300);
/** "April 13, 2027": the day of a UTC time, in words. */
const longDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const lockMessage = (lock) => `This is the Vicinity team lock on ${lock.platform}. The team locked ${lock.amount.toLocaleString("en-US")} $VICINITY here: nothing unlocks before ${longDate(lock.cliff)}, and nobody can cancel it or change who receives it.`;

// Where $VICINITY is traded and looked up: the four sites the token page itself links to (public/token.js: Buy on Raydium,
// Jupiter, DEX Screener, Solscan). The real site is not enough: a link there is judged by the token it carries, because the
// same raydium.io page shows any coin, fakes included.
export const MARKETS = { "raydium.io": "Raydium", "jup.ag": "Jupiter", "dexscreener.com": "DEX Screener", "solscan.io": "Solscan" };

/** A link to one of MARKETS: { host, name, addresses } with every Solana address in its path and query (jup.ag/swap/SOL-<mint>
 *  and raydium.io/...?mint=<mint> included), or null for any other link. Exact host only (www. allowed): raydium.io.evil.io is not it. */
export function marketLink(input, isSolanaAddress) {
  let url;
  const raw = clean(input);
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!Object.hasOwn(MARKETS, host)) return null;
  const parts = [url.pathname, ...url.searchParams.values()].join("/");
  let words;
  try { words = decodeURIComponent(parts).split(/[^1-9A-HJ-NP-Za-km-z]+/); } catch { words = parts.split(/[^1-9A-HJ-NP-Za-km-z]+/); }
  const addresses = [...new Set(words.filter((w) => isSolanaAddress(w)))];
  return { host, name: MARKETS[host], addresses };
}

/** A link to a social network we have an official account on: { network, profile } where profile is the official account the
 *  link opens (its first path segment is the handle, any case) or null for anyone else's, and account: whether the link names one
 *  at all; null for any other host. */
function socialLink(url) {
  const host = url.hostname.toLowerCase().replace(/^(www|mobile)\./, "");
  const onHost = SOCIAL_PROFILES.filter((p) => p.hosts.includes(host));
  if (!onHost.length) return null;
  const first = (url.pathname.split("/")[1] || "").toLowerCase();
  const profile = onHost.find((p) => p.handle.slice(1).toLowerCase() === first) || null;
  return { network: onHost[0].network, profile, account: Boolean(first) };
}

/** Decide whether something a visitor pasted is an official Vicinity place (the list as it is now: see withMint). */
export function checkOfficial(input, isSolanaAddress, env) {
  if (mainTokenV5(env)) return checkOfficialV5(input, isSolanaAddress, env);
  const OFFICIAL = withMint(env);
  const raw = clean(input);
  if (!raw) return { verdict: "empty", message: "Paste a link, address or @handle to check it." };

  // Solana address (token contract or wallet)
  if (isSolanaAddress(raw)) {
    if (OFFICIAL.tokenContract && raw === OFFICIAL.tokenContract)
      return { verdict: "official", kind: "contract", message: "This is the official $VICINITY contract address." };
    if (OFFICIAL.teamWallets.includes(raw)) {
      const name = teamWalletName(raw);
      return { verdict: "official", kind: "wallet", message: `This is a published Vicinity team wallet${name ? ` (${name.what})` : ""}.` };
    }
    const lock = (OFFICIAL.teamLocks || []).find((l) => l.address === raw);
    if (lock) return { verdict: "official", kind: "lock", message: lockMessage(lock) };
    return {
      verdict: "not_official", kind: "address",
      message: OFFICIAL.tokenContract
        ? "This address is NOT the official $VICINITY contract or a team wallet."
        : "$VICINITY has not launched, so there is no official contract address yet. Any token using this name right now is fake.",
    };
  }

  // Social handle like @vicinity
  if (/^@[A-Za-z0-9_.]{1,40}$/.test(raw)) {
    const ok = OFFICIAL.socials.map((h) => h.toLowerCase()).includes(raw.toLowerCase());
    if (ok) return { verdict: "official", kind: "social", message: "This is an official Vicinity account." };
    const ours = OFFICIAL.socials;
    return {
      verdict: "not_official", kind: "social",
      message: ours.length
        ? `This account is not us. Vicinity's only official account${ours.length > 1 ? "s are" : " is"} ${ours.join(" and ")}.`
        : "Vicinity has no official social accounts, so this account is not us.",
    };
  }

  // Website link
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch { url = null; }
  if (url && url.hostname.includes(".")) {
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const hostPath = (host + url.pathname.toLowerCase()).replace(/\/+$/, "");
    if (url.protocol === "http:" && OFFICIAL.websites.includes(host))
      return { verdict: "warning", kind: "website", message: "Right site, but the link uses http. Use the https version." };
    if (OFFICIAL.websites.includes(host))
      return { verdict: "official", kind: "website", message: "This is the official Vicinity website." };
    // the team lock's own page (the token page's "See the lock"): exact host and path, the address in it case and all
    const lockPage = (OFFICIAL.teamLocks || []).find((l) => { const u = new URL(l.url); return host === u.hostname && url.pathname.replace(/\/+$/, "") === u.pathname; });
    if (lockPage && url.protocol === "http:") return { verdict: "warning", kind: "lock", message: "Right lock page, but the link uses http. Use the https version." };
    if (lockPage) return { verdict: "official", kind: "lock", message: lockMessage(lockPage) };
    const social = socialLink(url);
    if (social) {
      if (social.profile) return { verdict: "official", kind: "social", message: `This is Vicinity's official account on ${social.profile.network}.` };
      const ours = SOCIAL_PROFILES.filter((p) => p.network === social.network).map((p) => p.handle).join(" and ");
      return {
        verdict: "not_official", kind: "social",
        message: social.account
          ? `This ${social.network} account is not us. Vicinity's official ${social.network}: ${ours}.`
          : `That link doesn't open an account. Vicinity's official ${social.network}: ${ours}.`,
      };
    }
    if (host === "github.com" && OFFICIAL.github.some((g) => hostPath === g || hostPath.startsWith(g + "/")))
      return { verdict: "official", kind: "github", message: "This is the official Vicinity code repository." };
    const market = OFFICIAL.tokenContract ? marketLink(raw, isSolanaAddress) : null;
    if (market) {
      const mint = OFFICIAL.tokenContract;
      if (!market.addresses.length)
        return { verdict: "warning", kind: "market", message: `This is the real ${market.name} (${market.host}). Before you buy, check that the token there has the official $VICINITY contract: ${mint}.` };
      if (market.addresses.every((a) => a === mint))
        return { verdict: "official", kind: "market", message: `This link opens the official $VICINITY on ${market.name} (contract ${mint}).` };
      return { verdict: "not_official", kind: "market", message: `This ${market.name} link is for a different token, NOT the official $VICINITY. The official contract is ${mint}.` };
    }
    const lookalike = /v[i1l]c[i1l]n[i1l]ty/i.test(host);
    return {
      verdict: "not_official", kind: "website",
      message: lookalike
        ? "Careful: this looks like a copy of our name, but it is NOT an official Vicinity site. Don't connect your wallet there."
        : "This link is not on our official list.",
    };
  }

  return { verdict: "unknown", message: "That doesn't look like a link, Solana address or @handle." };
}

/**
 * The addresses the "Official addresses" page lists (/official: scripts/pages/build.mjs builds it from this, with the settings of
 * wrangler.jsonc, which are what the Worker runs with). Every address comes from where the site already keeps it: our two programs
 * and the price-curve settings from the city-coin settings (lpSetup, src/cluster.js; only while they name mainnet), who can upgrade
 * the programs (PROGRAM_UPGRADE_AUTHORITY), the fee wallet (the program's constant, src/sol/pda.js), $VICINITY (activeMint), the team
 * lock and the team wallets (OFFICIAL, with the token page's labels). The official city coins are not here: the page reads them from
 * the chain through GET /api/official-coins (src/officialcoins.js).
 *   [{ id, title, rows: [{ label, address, kind: "account" | "token", note, link?: { href, text } }] }]
 */
export function officialAddresses(env = {}, mainToken = mainTokenV5(env)) {
  const lp = lpSetup(env), groups = [];
  const mainnet = lp.on && lp.cluster === "mainnet";
  // the fee wallet is also a team wallet today: each row says so, so nobody counts two wallets (or reads two labels for one address)
  const feeIsTeam = OFFICIAL.teamWallets.includes(ADDRESSES.feeRecipient);
  if (mainnet) {
    groups.push({ id: "programs", title: "Programs", rows: [
      { label: "Launchpad program", address: lp.programId, kind: "account", note: "vicinity_launchpad. It creates every official city coin." },
      { label: "Rewards program", address: lp.rewardsProgramId, kind: "account", note: "vicinity_rewards." },
      { label: "Upgrade authority of both programs", address: PROGRAM_UPGRADE_AUTHORITY, kind: "account",
        note: "A Squads multisig vault. Its multisig, linked here, needs 2 of its 3 signers to upgrade a program.",
        link: { href: `https://solscan.io/account/${PROGRAM_UPGRADE_MULTISIG}`, text: "Squads multisig" } },
    ] });
    groups.push({ id: "fees", title: "Fees and price curve", rows: [
      { label: "Fee wallet", address: ADDRESSES.feeRecipient, kind: "account", note: `Vicinity's share of city-coin fees goes to this wallet. The launchpad program has this address built in.${feeIsTeam ? " It is also the team's public wallet, listed under Team." : ""}` },
      ...lp.dbcConfigs.map((address) => ({ label: "Price-curve setting (Meteora)", address, kind: "account",
        note: "The Meteora settings the price curve of an official city coin runs on. Anyone can open a pool on these settings, so they alone do not make a coin official." })),
    ] });
  }
  if (mainToken) return [...groups, ...mainTokenAddressGroups(env, mainnet && feeIsTeam)];
  const mint = activeMint(env), launched = launchedAtOf(mint);
  if (mint) groups.push({ id: "vicinity", title: "$VICINITY", rows: [
    { label: "$VICINITY token", address: mint, kind: "token", note: `The platform token${launched ? `, launched on Raydium LaunchLab on ${longDate(launched)}` : ""}. It is not a city coin.` },
  ] });
  groups.push({ id: "team", title: "Team", rows: [
    ...(OFFICIAL.teamLocks || []).map((lock) => ({ label: teamLockLabel(lock), address: lock.address, kind: "account",
      note: `${lock.amount.toLocaleString("en-US")} $VICINITY locked: nothing unlocks before ${longDate(lock.cliff)}, and nobody can cancel the lock or change who receives it.`,
      link: { href: lock.url, text: `${lock.platform} page` } })),
    ...OFFICIAL.teamWallets.map((address) => {
      const named = teamWalletName(address) ? `${teamWalletName(address).what[0].toUpperCase()}${teamWalletName(address).what.slice(1)}.` : null;
      const fee = mainnet && address === ADDRESSES.feeRecipient ? "It is also the fee wallet, listed above." : null;
      return { label: teamWalletLabel(address), address, kind: "account", note: [named, fee].filter(Boolean).join(" ") || null };
    }),
  ] });
  return groups;
}

/** The live mint: the Cloudflare setting VICINITY_MINT wins over the line above (so launch needs no code change). */
export const activeMint = (env) => (env && env.VICINITY_MINT) || VICINITY_MINT;

/* ---------------------------------------------------------------- the main token (owner amendment 01, stage S02A) */
/**
 * THE mint every main-token consumer reads (the token page, /api/token, the holder list and ranks, /api/verify, balance sampling, roles,
 * profiles, seats, the portfolio, the price history, the swap's token list, the Launchpad's first card, the coin page's allow-list and
 * the edge-cache keys built from it). While MAIN_TOKEN_V5 does not count (src/v5policy.js mainTokenV5: off, or on with any precondition
 * missing) it is exactly activeMint(env), the VICINITY_MINT setting, as before. While it counts it is mainMint(env), the configured
 * MAIN_TOKEN_MINT, which the switch needs (an unset or refused mint keeps the switch from counting, so this never turns into "not
 * launched" and is never the legacy mint under the switch).
 * VICINITY_MINT keeps its name and stays the legacy $VICINITY mint: the early-member flags (src/signup-finish.js, src/auth.js) keep
 * reading it through activeMint, because "early" means "joined before $VICINITY launched on 3 Oct 2026", a fact of history.
 */
export const tokenMint = (env) => (mainTokenV5(env) ? mainMint(env) : activeMint(env));

/**
 * The part of an edge-cache key that names the main token's mode: "" while MAIN_TOKEN_V5 does not count (so every key is exactly
 * today's), and "-v5-<mint>" while it does, so an answer cached for one token is never served as the other's after the switch flips
 * (src/index.js, src/cointakedown.js).
 */
export const mainCacheTag = (env) => (mainTokenV5(env) ? `-v5-${tokenMint(env) || "pre"}` : "");

/** The published team wallets and team locks, as facts of a token's holder list: { wallets, locks }. */
export const TEAM = Object.freeze({ wallets: OFFICIAL.teamWallets, locks: OFFICIAL.teamLocks });
export const NO_TEAM = Object.freeze({ wallets: Object.freeze([]), locks: Object.freeze([]) });
/**
 * Whose team facts label the holder list of `mint`. The team wallets ("Team wallet (public)", "Team wallet (FOMO)") and the 60M
 * Jupiter Lock were published for $VICINITY: with MAIN_TOKEN_V5 on they never label, unrank or exclude anyone in the NEW main token's
 * list (its team wallets and locks are labelled once the owner supplies and verifies them, amendment section 4.1 step 7). Every other
 * list (with the switch off, the legacy token's and the city coins') keeps them, as before.
 */
export const teamFor = (env, mint) => (mint != null && mainTokenV5(env) && mint === mainMint(env) ? NO_TEAM : TEAM);

/** The former official X account (policy.official_links.legacy) as a social profile: refused as official, answered as legacy. */
const LEGACY_HANDLE = (/^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})$/.exec(LEGACY_X_URL) || [])[1] || null;
const LEGACY_SOCIAL = LEGACY_HANDLE ? Object.freeze({ network: "X", handle: `@${LEGACY_HANDLE}`, hosts: ["x.com", "twitter.com"] }) : null;
/**
 * The official social accounts as profiles ({ network, handle, hosts, url? }): while MAIN_TOKEN_V5 does not count, SOCIAL_PROFILES above,
 * as before; while it counts, only what OFFICIAL_X_URL and OFFICIAL_TELEGRAM_URL hold after the policy's shape check (src/maintoken.js
 * officialLinks), so an unset or refused link is simply not there and the legacy account is never one of them. The page footers
 * (scripts/pages/build.mjs and the Worker's response-time rewrite, src/footer-social.js) and the link checker read this one list. `on`:
 * the page build passes its own decision (the switch in wrangler.jsonc, once the build accepts it), because the pages it is writing are
 * what makes the switch count at run time.
 */
export function socialProfiles(env, on = mainTokenV5(env)) {
  if (!on) return SOCIAL_PROFILES;
  const l = officialLinks(env), out = [];
  if (l.xUrl) out.push(Object.freeze({ network: "X", handle: `@${l.xUrl.slice("https://x.com/".length)}`, hosts: ["x.com", "twitter.com"], url: l.xUrl }));
  if (l.telegramUrl) out.push(Object.freeze({ network: "Telegram", handle: `@${l.telegramUrl.slice("https://t.me/".length)}`, hosts: ["t.me", "telegram.me"], url: l.telegramUrl }));
  return Object.freeze(out);
}

/**
 * $VICINITY as a legacy token (MAIN_TOKEN_V5 on only): its mint (for checking), its launch, its team wallets and its lock, all labelled
 * legacy. No swap and no purchase link is ever built for it; holders keep their tokens (nothing is swapped, migrated or moved).
 */
export function legacyTokens() {
  return LEGACY_TOKENS.map((t) => ({
    symbol: t.symbol, name: "Vicinity", mint: t.mint, status: "legacy", history: "History only. It is not the main token, and no swap or purchase is offered for it. Holders keep their tokens.",
    platform: "Raydium LaunchLab", launchedAt: launchedAtOf(t.mint), swap: false,
    teamWallets: [...OFFICIAL.teamWallets], teamLocks: OFFICIAL.teamLocks.filter((l) => l.mint === t.mint).map((l) => ({ ...l })),
  }));
}

/** The official list under MAIN_TOKEN_V5: the main token from configuration, $VICINITY under legacyTokens, the configured links only. */
function withMainToken(env) {
  const main = mainMint(env), links = officialLinks(env);
  return {
    ...OFFICIAL,
    socials: [...new Set(socialProfiles(env).map((p) => p.handle))],
    tokenContract: main,
    // the published team wallets and the Jupiter Lock describe $VICINITY holdings: they live under legacyTokens, never as the new token's
    teamWallets: [],
    teamLocks: [],
    tokens: [
      // shape-checked and configured, not verified by this code: "Configured", never "Live" on the strength of a shape check
      { network: "Solana", name: MAIN_TOKEN_LABEL, symbol: "", contract: main, platform: null, status: main ? "Configured" : "Not published yet" },
      { network: "Solana", name: "Vicinity, legacy token", symbol: "VICINITY", contract: null, platform: "Raydium LaunchLab", status: "Legacy (history only)", legacy: true },
      OFFICIAL.tokens[1],
    ],
    legacyTokens: legacyTokens(),
    officialLinks: { x: links.xUrl, telegram: links.telegramUrl },
  };
}

/** The /official page's token, team and legacy groups under MAIN_TOKEN_V5 (officialAddresses above keeps today's groups with it off). */
function mainTokenAddressGroups(env, feeIsTeamWallet) {
  const groups = [], main = mainMint(env);
  if (main) groups.push({ id: "main-token", title: MAIN_TOKEN_LABEL, rows: [
    { label: MAIN_TOKEN_LABEL, address: main, kind: "token", note: "The main token's contract, from the site's configuration. It is not a city coin." },
  ] });
  groups.push({ id: "team", title: "Team", rows: OFFICIAL.teamWallets.map((address) => {
    const named = teamWalletName(address) ? `${teamWalletName(address).what[0].toUpperCase()}${teamWalletName(address).what.slice(1)}.` : null;
    const fee = feeIsTeamWallet && address === ADDRESSES.feeRecipient ? "It is also the fee wallet, listed above." : null;
    return { label: teamWalletLabel(address), address, kind: "account", note: [named, fee, "Published for the legacy $VICINITY token."].filter(Boolean).join(" ") };
  }) });
  groups.push({ id: "legacy", title: "Legacy", rows: LEGACY_TOKENS.flatMap((t) => [
    { label: "$VICINITY (legacy token)", address: t.mint, kind: "token",
      note: `History only${launchedAtOf(t.mint) ? `: launched on Raydium LaunchLab on ${longDate(launchedAtOf(t.mint))}` : ""}. It is not the main token, and no swap is offered for it. Holders keep their tokens.` },
    ...OFFICIAL.teamLocks.filter((l) => l.mint === t.mint).map((lock) => ({ label: `${teamLockLabel(lock)}, legacy`, address: lock.address, kind: "account",
      note: `${lock.amount.toLocaleString("en-US")} $VICINITY (the legacy token) locked: nothing unlocks before ${longDate(lock.cliff)}, and nobody can cancel the lock or change who receives it.`,
      link: { href: lock.url, text: `${lock.platform} page` } })),
  ]) });
  return groups;
}

const LEGACY_CONTRACT = "This is the legacy $VICINITY contract (history only). It is not the main token: no swap or purchase is offered for it, and holders keep their tokens.";
const legacyLockMessage = (lock) => `This is the Vicinity team lock on ${lock.platform} for the legacy $VICINITY token. The team locked ${lock.amount.toLocaleString("en-US")} $VICINITY here: nothing unlocks before ${longDate(lock.cliff)}, and nobody can cancel it or change who receives it.`;
const accountsText = (list) => list.map((p) => p.handle).join(" and ");

/** The link checker under MAIN_TOKEN_V5 (checkOfficial above keeps today's answers with it off). Plain text answers, never markup. */
function checkOfficialV5(input, isSolanaAddress, env) {
  const main = mainMint(env), socials = socialProfiles(env);
  const raw = clean(input);
  if (!raw) return { verdict: "empty", message: "Paste a link, address or @handle to check it." };
  const legacyMint = (a) => isLegacyMint(a) || (Boolean(activeMint(env)) && a === activeMint(env));

  if (isSolanaAddress(raw)) {
    if (main && raw === main) return { verdict: "official", kind: "contract", message: "This is the official main token contract address." };
    if (legacyMint(raw)) return { verdict: "warning", kind: "contract", legacy: true, message: LEGACY_CONTRACT };
    if (OFFICIAL.teamWallets.includes(raw)) {
      const name = teamWalletName(raw);
      return { verdict: "official", kind: "wallet", message: `This is a published Vicinity team wallet${name ? ` (${name.what})` : ""}, listed for the legacy $VICINITY token.` };
    }
    const lock = OFFICIAL.teamLocks.find((l) => l.address === raw);
    if (lock) return { verdict: "official", kind: "lock", legacy: true, message: legacyLockMessage(lock) };
    return {
      verdict: "not_official", kind: "address",
      message: main ? "This address is NOT the official main token contract or a team wallet."
        : "The main token's contract is not published here yet, so no address is the official main token. Any token presented as it right now is not ours.",
    };
  }

  if (/^@[A-Za-z0-9_.]{1,40}$/.test(raw)) {
    const lower = raw.toLowerCase();
    if (socials.some((p) => p.handle.toLowerCase() === lower)) return { verdict: "official", kind: "social", message: "This is an official Vicinity account." };
    const current = socials.length ? ` Vicinity's official account${socials.length > 1 ? "s are" : " is"} ${accountsText(socials)}.` : "";
    if (LEGACY_SOCIAL && LEGACY_SOCIAL.handle.toLowerCase() === lower) return { verdict: "warning", kind: "social", legacy: true, message: `This is the former Vicinity account (legacy), not the current official account.${current}` };
    return { verdict: "not_official", kind: "social", message: socials.length ? `This account is not us.${current}` : "Vicinity lists no official social accounts right now, so this account is not us." };
  }

  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch { url = null; }
  if (url && url.hostname.includes(".")) {
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const hostPath = (host + url.pathname.toLowerCase()).replace(/\/+$/, "");
    if (url.protocol === "http:" && OFFICIAL.websites.includes(host)) return { verdict: "warning", kind: "website", message: "Right site, but the link uses http. Use the https version." };
    if (OFFICIAL.websites.includes(host)) return { verdict: "official", kind: "website", message: "This is the official Vicinity website." };
    const lockPage = OFFICIAL.teamLocks.find((l) => { const u = new URL(l.url); return host === u.hostname && url.pathname.replace(/\/+$/, "") === u.pathname; });
    if (lockPage && url.protocol === "http:") return { verdict: "warning", kind: "lock", message: "Right lock page, but the link uses http. Use the https version." };
    if (lockPage) return { verdict: "official", kind: "lock", legacy: true, message: legacyLockMessage(lockPage) };
    const social = socialLinkOf(url, [...socials, ...(LEGACY_SOCIAL ? [LEGACY_SOCIAL] : [])]);
    if (social) {
      const ours = socials.filter((p) => p.network === social.network);
      const current = ours.length ? `Vicinity's official ${social.network}: ${accountsText(ours)}.` : `Vicinity lists no official ${social.network} account right now.`;
      if (social.profile && social.profile !== LEGACY_SOCIAL) return { verdict: "official", kind: "social", message: `This is Vicinity's official account on ${social.profile.network}.` };
      if (social.profile) return { verdict: "warning", kind: "social", legacy: true, message: `This is the former Vicinity account on ${social.network} (legacy), not the current official account. ${current}` };
      return { verdict: "not_official", kind: "social", message: social.account ? `This ${social.network} account is not us. ${current}` : `That link doesn't open an account. ${current}` };
    }
    if (host === "github.com" && OFFICIAL.github.some((g) => hostPath === g || hostPath.startsWith(g + "/")))
      return { verdict: "official", kind: "github", message: "This is the official Vicinity code repository." };
    const market = marketLink(raw, isSolanaAddress);
    if (market && market.addresses.length && market.addresses.every(legacyMint))
      return { verdict: "warning", kind: "market", legacy: true, message: `This ${market.name} link is for the legacy $VICINITY token (history only), not the main token. No swap or purchase is offered for it here.` };
    if (market && main) {
      if (!market.addresses.length)
        return { verdict: "warning", kind: "market", message: `This is the real ${market.name} (${market.host}). Before you buy, check that the token there has the official main token contract: ${main}.` };
      if (market.addresses.every((a) => a === main))
        return { verdict: "official", kind: "market", message: `This link opens the official main token on ${market.name} (contract ${main}).` };
      return { verdict: "not_official", kind: "market", message: `This ${market.name} link is for a different token, NOT the official main token. The official contract is ${main}.` };
    }
    const lookalike = /v[i1l]c[i1l]n[i1l]ty/i.test(host);
    return {
      verdict: "not_official", kind: "website",
      message: lookalike
        ? "Careful: this looks like a copy of our name, but it is NOT an official Vicinity site. Don't connect your wallet there."
        : "This link is not on our official list.",
    };
  }
  return { verdict: "unknown", message: "That doesn't look like a link, Solana address or @handle." };
}

/** socialLink for an explicit list of profiles: { network, profile, account } or null for a host none of them lives on. */
function socialLinkOf(url, profiles) {
  const host = url.hostname.toLowerCase().replace(/^(www|mobile)\./, "");
  const onHost = profiles.filter((p) => p.hosts.includes(host));
  if (!onHost.length) return null;
  const first = (url.pathname.split("/")[1] || "").toLowerCase();
  const profile = onHost.find((p) => p.handle.slice(1).toLowerCase() === first) || null;
  return { network: onHost[0].network, profile, account: Boolean(first) };
}

/**
 * The official list as it is right now: the contract from the VICINITY_MINT setting (or the line at the top of
 * this file) is on it, so the link checker, the token registry and /api/official all know the real contract the
 * moment the setting is saved. No code change at launch.
 */
export function withMint(env) {
  if (mainTokenV5(env)) return withMainToken(env);
  const mint = activeMint(env);
  if (!mint) return OFFICIAL;
  return {
    ...OFFICIAL,
    tokenContract: mint,
    tokens: OFFICIAL.tokens.map((t, i) => (i === 0 ? { ...t, contract: mint, status: "Live" } : t)),
  };
}

/** SITE_MODE=preview: the site behaves as if the launchpad already opened, so every
 *  post-launch flow can be tested. The real announced date is kept as announcedOpensAt.
 *  With LAUNCHPAD_V2=on the answer also carries launchpadV2:true (the Launchpad page shows its coin list
 *  only then); with the switch off the key does not exist, so the answer is exactly as it always was. */
export function officialFor(env) {
  const OFFICIAL = withMint(env);
  const out = env && env.SITE_MODE === "preview"
    ? {
      ...OFFICIAL,
      siteMode: "preview",
      announcedOpensAt: OFFICIAL.launchpadOpensAt,
      launchpadOpensAt: new Date(Date.now() - 86400000).toISOString(), // "opened yesterday"
    }
    : { ...OFFICIAL, siteMode: "live" };
  const withV2 = launchpadV2On(env) ? { ...out, launchpadV2: true } : out;
  // the in-app swap and the launchpad's curve trades (src/cluster.js): the pages render Buy here instead of a link to raydium.io
  // only when a switch is on; with both off these keys do not exist and the answer is exactly as it always was
  const withSwap = swapOn(env) ? { ...withV2, swap: true } : withV2;
  const withTrading = launchpadTradingOn(env) ? { ...withSwap, launchpadTrading: { cluster: launchpadCluster(env).cluster } } : withSwap;
  // the city-coin launch (lpSetup, src/cluster.js): the pages ask /api/lp/* only when this key is there, so a site without its
  // settings sends no request for it and gets no 404 in the browser's console; off, the key does not exist
  const lp = lpSetup(env);
  const withLp = lp.on ? { ...withTrading, cityCoins: { cluster: lp.cluster } } : withTrading;
  // the ready-made city coin (COIN_V2_READY=on, src/coinready.js): the Launchpad page words a coin that is not live yet as chosen by the
  // founder and launched on the Vicinity launchpad, not designed and launched on Raydium LaunchLab; off, the key does not exist
  return coinV2ReadyOn(env) ? { ...withLp, coinV2Ready: true } : withLp;
}

// Founding Supporter snapshot cutoff (always 00:00 UTC), announced ahead of time. The setting
// SNAPSHOT_CUTOFF in Cloudflare wins over this line. null = not scheduled yet.
export const SUPPORTER_SNAPSHOT_AT = null;
