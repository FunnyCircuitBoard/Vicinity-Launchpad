/**
 * Feature switches, read from the environment on every request (a dashboard variable change applies to
 * the next request, no deploy). Deliberately NOT in wrangler.jsonc "vars": a deploy would reset it.
 *
 * SIGNUP_FLOW=v2 turns on the new sign-up (location, account with terms, wallet, dashboard).
 * Anything else (unset, empty, "v1", a typo) is the sign-up as it has always been.
 */
export const signupFlow = (env) => (String((env && env.SIGNUP_FLOW) ?? "").trim().toLowerCase() === "v2" ? "v2" : "v1");
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
