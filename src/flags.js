/**
 * Feature switches, read from the environment on every request (a dashboard variable change applies to
 * the next request, no deploy). Deliberately NOT in wrangler.jsonc "vars": a deploy would reset it.
 *
 * SIGNUP_FLOW=v2 turns on the new sign-up (location, account with terms, then the dashboard; the wallet is linked later, from
 * the dashboard: onboarding v3 evolved the same switch in place, so "v3" is accepted as another name for "v2").
 * Anything else (unset, empty, "v1", a typo) is the sign-up as it has always been.
 */
export const signupFlow = (env) => (["v2", "v3"].includes(String((env && env.SIGNUP_FLOW) ?? "").trim().toLowerCase()) ? "v2" : "v1");
export const v2On = (env) => signupFlow(env) === "v2";

/**
 * PROFILES=on turns on member profiles (a bio on the Vicinity pass, the portfolio chart, public member profiles with
 * follow and block). Exactly "on" (trimmed, any letter case); anything else, unset included, is the site as it has always been.
 */
export const profilesOn = (env) => String((env && env.PROFILES) ?? "").trim().toLowerCase() === "on";

/**
 * LAUNCHPAD_V2=on turns on the Launchpad's city-coin list (GET /api/launchpad, market data from DexScreener, holder counts
 * from the scheduled job, and the key launchpadV2:true in /api/official that tells the page to show the list). Exactly "on"
 * (trimmed, any letter case); anything else, unset included, is the Launchpad page as it has always been.
 */
export const launchpadV2On = (env) => String((env && env.LAUNCHPAD_V2) ?? "").trim().toLowerCase() === "on";

/**
 * DASHBOARD_V2=on turns on the tabbed dashboard (Home, City, Community, Rankings, Founder, Moderate, Profile; the Founder
 * Status checklist and the Founder card). The server only tells the page (/api/me carries dashboardV2: true); the page then
 * asks for the extra code. Exactly "on" (trimmed, any letter case); anything else is the dashboard as it has always been.
 */
export const dashboardV2On = (env) => String((env && env.DASHBOARD_V2) ?? "").trim().toLowerCase() === "on";

/**
 * CARRY_RELAY is an EMERGENCY switch, on by default: unset (or anything but "off") = behind iCloud Private Relay (or Cloudflare WARP) a
 * phone's "Connect wallet" still opens the wallet app on a one-time link bound to the first browser that opens it and to the country
 * (src/walletlink.js). CARRY_RELAY=off (trimmed, any letter case), set in the Cloudflare dashboard and never in wrangler.jsonc, sends
 * relay connections back to the pairing ("approve in Phantom, finish in Safari") as before 10 Oct 2026, from the next request on.
 */
export const carryRelayOn = (env) => String((env && env.CARRY_RELAY) ?? "").trim().toLowerCase() !== "off";

/**
 * SWAP=on turns on the in-app swap (the Jupiter-routed panel and /api/swap/*); LAUNCHPAD_TRADING=on the curve trades of city
 * coins (/api/launchpad/trade/*). Both live in src/cluster.js with the cluster settings they need; re-exported here so every
 * switch is listed in one place. Exactly "on"; anything else, unset included, is the site as it has always been.
 */
export { swapOn, launchpadTradingOn } from "./cluster.js";
