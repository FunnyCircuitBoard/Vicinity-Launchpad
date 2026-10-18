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
 * FEED_V2=on turns on the community feed's second step: the post kind "update" (founder / manager / Vicinity announcements, an
 * "Updates" chip), deleting your own post, muting people (and blocks hiding posts both ways in the feeds), the author's city on
 * every national row, and one confirmation before an account's first national post. Exactly "on" (trimmed, any letter case);
 * anything else, unset included, is the feed as it has always been: no new route, key, column or table.
 */
export const feedV2On = (env) => String((env && env.FEED_V2) ?? "").trim().toLowerCase() === "on";

/**
 * NOTIFY=on turns on in-app notices (src/notify.js): one plain sentence per event on the dashboard's Notifications tab (a reply to your
 * post, a moderation outcome, your coin picture's review, a founder window or verdict, an election in your country), with per-kind
 * controls. The routes GET /api/notices, POST /api/notices/read and GET/POST /api/notices/prefs, the key `unread` on /api/me, the
 * notices table and users.notice_prefs (lazy, additive). No e-mail, no push, no messaging. Exactly "on" (trimmed, any letter case);
 * anything else, unset included, is the site exactly as before: no new route, key, column or table, and no notice is written.
 */
export const notifyOn = (env) => String((env && env.NOTIFY) ?? "").trim().toLowerCase() === "on";

/**
 * CARRY_RELAY is an EMERGENCY switch, on by default: unset (or anything but "off") = behind iCloud Private Relay (or Cloudflare WARP) a
 * phone's "Connect wallet" still opens the wallet app on a one-time link bound to the first browser that opens it and to the country
 * (src/walletlink.js). CARRY_RELAY=off (trimmed, any letter case), set in the Cloudflare dashboard and never in wrangler.jsonc, sends
 * relay connections back to the pairing ("approve in Phantom, finish in Safari") as before 10 Oct 2026, from the next request on: a
 * relay link handed out before the switch stops working too (opened or not), and Safari's next tap pairs.
 */
export const carryRelayOn = (env) => String((env && env.CARRY_RELAY) ?? "").trim().toLowerCase() !== "off";

/**
 * SWAP=on turns on the in-app swap (the Jupiter-routed panel and /api/swap/*); LAUNCHPAD_TRADING=on the curve trades of city
 * coins (/api/launchpad/trade/*). Both live in src/cluster.js with the cluster settings they need; re-exported here so every
 * switch is listed in one place. Exactly "on"; anything else, unset included, is the site as it has always been.
 */
export { swapOn, launchpadTradingOn } from "./cluster.js";

/**
 * WALLET_SEND=on turns on Send in the dashboard's Wallet tab (wallet onboarding, step 2): POST /api/wallet/send/build builds an UNSIGNED
 * transfer of SOL, $VICINITY or a launched city coin from the person's linked wallet (src/walletsend.js), the person's own wallet signs
 * it, /api/wallet/send/relay and /api/wallet/send/status are the swap's relay and status poll under new names, and /api/me carries
 * walletSend: true (the page then fetches public/wallet-send.js and shows the Send button). The builds are counted before any work: per
 * connection 20 taps and 60 of the page's own live checks (?live=1) a minute (src/guards.js PUBLIC_LIMITS), per account 30 taps and 60 live
 * checks an hour (src/walletsend.js SEND_LIMIT, LIVE_LIMIT), so typing never uses up a Review. Exactly "on" (trimmed, any letter case);
 * anything else, unset included, is the Wallet tab as it is: no Send control, and the three paths answer like any unknown path (404).
 */
export const walletSendOn = (env) => String((env && env.WALLET_SEND) ?? "").trim().toLowerCase() === "on";

/**
 * COIN_V2_READY=on turns on the first stage of the new city-coin flow (src/coinready.js): the founder's Founder tab shows a coin that is
 * already made (the Vicinity template drawn with the city's registry ticker and name, src/coinart.js; the name, city, region, country and
 * a default description from the Vicinity city list), read-only, with one action, "Use this coin", which records that exact version
 * (its content hash) as the city's design for the existing admin approval and launch; launches then publish the template picture and
 * the server-built metadata (only for a version the owner's approval was built from while it is on). Everyone else in a city that has a
 * founder sees it labelled "Preview, not launched". While on, the old studio (POST /api/coins/design) and a founder's Raydium LaunchLab
 * contract (POST /api/coins/mint) answer 409, and an admin can only reject a contract still waiting (POST /api/coins/mint/decide).
 * The routes GET /api/coins/ready, POST /api/coins/ready/art and POST /api/coins/ready/use, the key coinV2Ready on /api/me and /api/official, the
 * coin_art, coin_versions, coin_ready and coin_legacy_designs tables (lazy, additive) exist only then. Exactly "on" (trimmed, any letter
 * case); anything else, unset included, is the site exactly as before. Whatever this says, a recorded coin's picture
 * (/coin-meta/art/<sha256>.png) and its /coin-meta JSON keep being served (src/coinmeta.js): a launched coin's picture never goes away.
 */
export const coinV2ReadyOn = (env) => String((env && env.COIN_V2_READY) ?? "").trim().toLowerCase() === "on";
