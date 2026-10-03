/**
 * The ONE list of official Vicinity places. The website and the
 * "Is this link official?" checker both read from here.
 * Change it only by a public commit so everyone can see the history.
 */
import { launchpadV2On } from "./flags.js";

// The $VICINITY mint address. Paste it here the moment the token launches (one line change).
export const VICINITY_MINT = null;

// When the Vicinity Launchpad opens (the countdown on /launchpad). 10:10:10 AM New York time (EDT, UTC-4), Oct 10 2026.
export const LAUNCHPAD_OPENS_AT = "2026-10-10T10:10:10-04:00";

export const OFFICIAL = {
  updated: "2026-09-27", // vicinity.city is the main address; vicinitycity.net forwards to it
  // Only addresses we control for sure. (The two workers.dev addresses were listed before: a workers.dev name can be
  // claimed by anyone once it is released, so a name on this list that is not ours would vouch for a fake site.)
  websites: ["vicinity.city", "vicinitycity.com", "vicinitycity.net"],
  github: [],             // code is private
  socials: ["@VicinityCitySOL"], // official X account (verified 2026-09-30)
  tokenContract: VICINITY_MINT,
  teamWallets: [],        // every wallet the team controls, listed publicly
  launchpadOpensAt: LAUNCHPAD_OPENS_AT,
  // Every official Vicinity token on every network. Anything not listed here is fake.
  tokens: [
    { network: "Solana", name: "Vicinity", symbol: "VICINITY", contract: VICINITY_MINT, platform: "Raydium LaunchLab", status: "Launching October 3, 2026" },
    { network: "Solana", name: "City coins (one per city)", symbol: "e.g. $UTICA", contract: null, platform: "Vicinity Launchpad", status: "Phase 3" },
  ],
};

const clean = (s) => String(s || "").trim().slice(0, 300);

/** Decide whether something a visitor pasted is an official Vicinity place (the list as it is now: see withMint). */
export function checkOfficial(input, isSolanaAddress, env) {
  const OFFICIAL = withMint(env);
  const raw = clean(input);
  if (!raw) return { verdict: "empty", message: "Paste a link, address or @handle to check it." };

  // Solana address (token contract or wallet)
  if (isSolanaAddress(raw)) {
    if (OFFICIAL.tokenContract && raw === OFFICIAL.tokenContract)
      return { verdict: "official", kind: "contract", message: "This is the official $VICINITY contract address." };
    if (OFFICIAL.teamWallets.includes(raw))
      return { verdict: "official", kind: "wallet", message: "This is a published Vicinity team wallet." };
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
    return ok
      ? { verdict: "official", kind: "social", message: "This is an official Vicinity account." }
      : { verdict: "not_official", kind: "social", message: "Vicinity has no official social accounts yet, so this account is not us." };
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
    if (host === "github.com" && OFFICIAL.github.some((g) => hostPath === g || hostPath.startsWith(g + "/")))
      return { verdict: "official", kind: "github", message: "This is the official Vicinity code repository." };
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

/** The live mint: the Cloudflare setting VICINITY_MINT wins over the line above (so launch needs no code change). */
export const activeMint = (env) => (env && env.VICINITY_MINT) || VICINITY_MINT;

/**
 * The official list as it is right now: the contract from the VICINITY_MINT setting (or the line at the top of
 * this file) is on it, so the link checker, the token registry and /api/official all know the real contract the
 * moment the setting is saved. No code change at launch.
 */
export function withMint(env) {
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
  return launchpadV2On(env) ? { ...out, launchpadV2: true } : out;
}

// Founding Supporter snapshot cutoff (always 00:00 UTC), announced ahead of time. The setting
// SNAPSHOT_CUTOFF in Cloudflare wins over this line. null = not scheduled yet.
export const SUPPORTER_SNAPSHOT_AT = null;
