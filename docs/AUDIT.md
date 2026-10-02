# Vicinity audit · 2 October 2026

Co-founder / developer audit of the whole repository (backend `src/`, site `public/` + `scripts/pages/`, build
scripts, tests, README, Cloudflare config). Written the day before the $VICINITY token launch (Oct 3) and eight days
before the Launchpad opens (Oct 10).

**How this was done**
- Read every file in `src/`, every page source and page script, the schema/migrations, the build scripts and the tests.
- Ran the test suite (82/82 pass once `scripts/copy-assets.mjs` has copied the fonts and QR library in; the one
  failure on a fresh clone is just that git-ignored copy step).
- Ran the real Worker locally (`wrangler dev`) and took phone and desktop screenshots of `/connect` and `/dashboard`.
- Wrote three throw-away probes against the real API in the repo's own test world (Seed Steward, zero-balance quorum,
  ticker comparison over the full city list). Numbers below come from those runs, not from guesses.
- Checked the Cloudflare account through the connector (read-only): Workers `vicinity-map`, `vicinity-countdown`,
  `cosmos`; D1 `vicinity-claims` (the id in `wrangler.jsonc`) and `vicinity-countdown`. The connector does **not**
  expose secret names, so I could not confirm which Worker secrets are set.

**What I could not verify** (needs you or a real device): sign-in with real Google and e-mail credentials, wallet apps'
in-app browsers on a real phone, and the production Worker's secrets. Items that depend on those say "needs
real-device test".

Severity: **P0** breaks a core flow or fairness, fix before/at launch · **P1** serious inconsistency · **P2** polish or debt.

---

## Where this stands (PR [#5](https://github.com/FunnyCircuitBoard/Vicinity-Launchpad/pull/5), rebased onto the live code)

The live code is now in git (PRs #7 and #8), and these fixes were merged on top of it, so the branch no longer replaces
what is running. Two things from the first version of the fixes were dropped on purpose when that merge was done:
the **sign-up link hand-off** (finishing sign-up in the phone's own browser), because e-mail sign-in works inside wallet
apps and Google is hidden there; and my **admin "launch readiness" console**, because the live `/admin` console (and its
config route, which reports which settings are present) covers it. The **location** hand-off stays.

Fixed and tested: log in (A1, A2, A9), location in wallet app browsers (B1–B3), a dashboard per level with Seed Steward,
squads, challenge and Resign (C1–C3, C5, C8–C10), the steward-quorum hole (D1), the stale 1M copy and README (D2, D3),
tickers (D5), private pictures (D7). Covered by the live code instead of mine: C7, E3 (the `/admin` console). Dropped on
purpose: A4 (sign-up link hand-off). Still open and mostly waiting on a decision from you: A3/A5 (settings,
`workers.dev`), D4, D6, E1, E2.
Everything marked "needs a real-device test" works in real Chromium with a simulated wallet-app browser, but has not
run inside Phantom or Solflare on a phone yet.

## Live vs repo (found on 2 Oct, after the first version of this report; since resolved)

**What is running at vicinity.city is not what is in GitHub.** Everything above was audited against `main`. Checked afterwards, read-only:

- 13 of the 23 top-level site files the live site serves differ from `main` (`site.js`, `connect.js`, `dashboard.js`, `dashboard.html`, `style.css`, and eight pages).
- Live has features `main` doesn't: **e-mail code sign-in** (`/api/auth/email/start|verify`; the live provider list is `google` + `email`, X is gone), a **profile modal**, a **terms gate** and a `/terms` page, an `/admin` page, and a `siteMode: "preview"` that shows a "TEST ENVIRONMENT" banner and slides the Launchpad opening time to a moment in the past (the real date is kept as `announcedOpensAt: 2026-10-10T10:10:10-04:00`).
- The production database has tables the repo's schema doesn't (`admin_roles`, `admin_tokens`, `admin_audit`, `admin_test`, `email_codes`) and three migrations the repo doesn't have (`2026-09-30-admin-dashboard`, `2026-10-01-terms-agree`, `2026-10-01-profile`). The Worker was last modified on 1 Oct 19:37 UTC, after `main`'s last commit (30 Sep).
- Production holds 10 accounts: 1 Google, 1 e-mail, and **8 `testlab` accounts** in a made-up community ("Testville", country `XX`). They are counted in the public `/api/members` numbers.

**Update:** the deployed code has since been recovered into git (PRs #7 and #8: e-mail code sign-in, profile modal, terms gate, `/admin`, preview mode, security hotfixes, GitHub CI and deploy workflows), and the fixes in this report were merged on top of it instead of replacing it. The notes below are what I found at the time; what they meant for the work is in the status column of each finding. Still true and still for you to do: remove the 8 `testlab` accounts and switch `siteMode` to live (see `docs/DEPLOY.md`).

What this meant for the rest of this report (kept for the record):

- Findings **A1** (no Log in) and **A2** hold on live too: the live header still says "Connect". But the sign-in methods differ (e-mail instead of X), so the new Log in block, the hand-off and the X-specific advice must be reworked on top of the live code, not on `main`.
- **Do not merge or deploy the fixes branch as it stands.** Deploying `main`, or this branch, would replace the live Worker and drop e-mail sign-in, the terms gate, the profile modal and the admin work.
- First step: get the deployed code into git (it was deployed from somewhere that isn't GitHub: another machine, another session, or the Cloudflare dashboard), then rebase the fixes onto it. The backend fixes (D1, C2, C9, D7, D5, B-series) are mostly independent of the sign-in changes and should port cleanly; the login/connect/dashboard UI work will need real merging.
- Clean up before launch: remove the 8 `testlab` accounts and turn `siteMode` back to live. I haven't touched either.

## Headline

1. **There was no way to log in** (fixed). The header said "Connect", the connect page only offered wallets, and the
   server-side "log in with your linked account" path had no button anywhere (A1). The header now says "Log in".
2. **Sign-up was a single point of failure** (now two providers). A new account needs a wallet *and* a Google or e-mail
   login. If neither is configured the person is stuck, and on phones Google refuses to run inside wallet in-app
   browsers, which is why e-mail sign-in matters there (A3, A4).
3. **Location is built for desktop browsers.** Wallet in-app browsers often don't pass geolocation to web pages, and
   the only message tells people to change a browser setting that doesn't exist there (B1).
4. **Everyone gets the same dashboard.** Seed Steward (new in policy v5) is invisible in the UI, Squad Founding has
   four API endpoints and no screen, and admins/managers have no console (C1–C7).
5. **A fairness hole in Seed Steward confirmation.** 49 accounts holding nothing confirm a steward instantly and
   erase the 90-day probation and the challenge route (D1). Small fix, high impact.
6. **Policy v5 changed the founder stake to a 100K–1M ladder, but eight places still say "1,000,000"**, and a test
   locks that text in (D2). The README still says 14 days and a 72-hour window (D3).
7. **Coin tickers disagree between pages**: 248 of 8,030 communities show a different ticker on the dashboard than on
   the map, and 70 map tickers contain digits (D5). A ticker is a coin's identity.
8. **The "Launchpad" itself is not built.** What exists: design a city coin, record its contract, link out to
   Jupiter/Raydium. Nothing launches a coin (E1). Decide what goes live on Oct 10.

---

## A · Sign-in and accounts

| ID | Sev | Finding | Evidence | Fix | Status |
|---|---|---|---|---|---|
| A1 | P0 | No "Log in" anywhere. Header button is labelled "Connect"; signed-out dashboard says "Connect & sign in"; no log-out outside the dashboard card. | Screenshots of `/connect` and `/dashboard` at 390 px; `scripts/pages/build.mjs` header | The one header account button reads "Log in" when signed out (and is the profile button when signed in; Log out is in the profile modal) | ✅ Fixed |
| A2 | P0 | Returning users can't use their linked login alone. `handleOAuthCallback` supports it and `test/accounts.test.js` covers it, but the buttons only appear *after* a wallet is proven (`showSocial`). A person on a laptop with no wallet extension cannot get back in. | `src/auth.js` callback; `public/connect.js` `renderPick`/`showSocial` | Log-in panel on `/connect` with Google or e-mail (Google hidden inside wallet-app browsers), plus honest errors | ✅ Fixed |
| A3 | P0 | Sign-up requires a Google or e-mail login (X sign-in was removed in the live code). If neither is configured (or the Google app isn't approved for production, or no e-mail sender is set) new users hit "being switched on" after signing a message and can't finish. Nothing tells you which provider is missing. | `src/auth.js` `PROVIDERS.configured`; `connect.js` `social-off` | Per-provider status for admins (E3); keep the message honest. **Needs you:** confirm secrets + redirect URI | 🟡 Partly: the live `/admin` config route reports which settings are present; your secrets and the Google approval are still on you |
| A4 | P0 (phones) | Google blocks OAuth in embedded WebViews (`disallowed_useragent`), and wallet in-app browsers are WebViews. Social sign-in may also hop to the native app or system browser, where the half-finished sign-up cookie doesn't exist, which ends in `wallet_first`. | Platform behaviour (needs real-device test); `src/auth.js` keeps the pending wallet only in a cookie | Detect the in-app browser and hide Google there. My first fix, a "finish in your browser" sign-up hand-off, was **dropped on purpose**: e-mail sign-in works inside wallet apps, so nobody needs to leave them | ✅ Fixed by e-mail sign-in + hiding Google in wallet apps (needs a real-device test) |
| A5 | P1 | Two different `workers.dev` hostnames are listed as *official websites*, `workers_dev` is on, and they are not forwarded to vicinity.city. OAuth redirect URIs are registered for vicinity.city only, so sign-in fails there. A Cloudflare account has one workers.dev subdomain, so one of the two listed is wrong, and a wrong "official" entry is a trust hole. | `src/official.js` `websites`; `wrangler.jsonc` | Verify which subdomain is yours, drop the other, forward workers.dev to vicinity.city | ⬜ Open, needs you |
| A6 | P1 | The 30-minute "confirm it's you" modal has no phone path. The phone-pairing flow only exists for login, so a computer user whose wallet is on their phone must send an on-chain transfer every 30 minutes. | `public/dashboard.js` `askProof`; `src/auth.js` `handleReprove` | Reuse pairing for re-proof | ⬜ Open |
| A7 | P1 | Logging in with Google or e-mail alone leaves `proven_at` empty, so the first applying/endorsing/voting/moderating action always interrupts with a wallet proof. Correct for safety, but the UI never says so up front. | `src/auth.js` `start()` | Say it on the log-in panel; ties to A6 | 🟡 Partly: the Log in block says it |
| A8 | P2 | No rate limit on unauthenticated writes: `/api/pair`, `/api/auth/transfer`. Cleanup runs 2–5 % of the time. | `src/auth.js` | Cloudflare rate-limit rule or per-IP counter | ⬜ Open |
| A9 | P2 | `inWalletApp()` in `wallets.js` is never used; wallet detection waits 350 ms before scanning legacy providers. | `public/wallets.js` | Use it to switch the page to in-app-browser mode (hides Google there) | ✅ Fixed |

## B · Location

| ID | Sev | Finding | Evidence | Fix | Status |
|---|---|---|---|---|---|
| B1 | P0 (phones) | Wallet in-app browsers often deny or never prompt for geolocation. The error says "Allow location for this site in your browser settings", which doesn't exist inside a wallet app. Every location-gated action (home, check-in, apply, add-town, map "locate me") fails there. | `public/site.js` `getLocation`; needs real-device test | Detect, explain correctly, and offer a hand-off to the phone's normal browser that returns a single-use attestation | ✅ Fixed (needs a real-device test) |
| B2 | P1 | Always `enableHighAccuracy: true, maximumAge: 0, timeout 20 s`, but the server accepts up to 20 km accuracy (`MAX_LOCATION_ACCURACY_M`). A coarse retry would succeed on many more phones and desktops. | `public/site.js`; `src/cities.js` | Retry once with network-based location | ✅ Fixed |
| B3 | P1 | Three divergent copies of the location helper (`site.js`, `cities.js`). | grep `getLocation` | One shared helper | ✅ Fixed |
| B4 | P2 | Failed `/api/locate` calls count toward the 20-per-hour limit before the check runs, so flaky WebView retries lock people out. | `src/attest.js` | Count only after the request is well-formed | ⬜ Open |

## C · Dashboards and roles

| ID | Sev | Finding | Evidence | Fix | Status |
|---|---|---|---|---|---|
| C1 | P0 | One dashboard for every level. Admin, manager, founder, holder and member see the same page with a coloured pill; the only role-specific panel is one moderator card. | `public/dashboard.js`, `dashboard.html` | A "Your role" card (and a squad card) in the live dashboard: ordinary cards, so the live drag-to-arrange layout moves them like the others; "What my role can do" opens the matching row of the live roles accordion | ✅ Fixed |
| C2 | P0 | **Seed Steward is invisible.** Probe output: `level: founder`, `roles.founder: false`, `city_founder` badge not earned, no 👑 on their posts, progress stuck at 83 %, and `renderPath` has no branch for `status: "steward"`. The steward can moderate (the API allows it) but the page shows nothing about probation, bond, challenge or grace. | Probe run; `src/me.js`, `src/social.js` (`status = 'active'`), `dashboard.js` | Steward panel, badge, consistent role flags | ✅ Fixed |
| C3 | P0 | Squad Founding: `create / join / leave / apply / :id` endpoints and 3 tests, but no UI. | `dashboard.js` has zero mentions of "squad" | Squad panel | ✅ Fixed |
| C4 | P1 | A qualified local can't challenge a steward (UI says "already has a founder"); no Resign button; no dark-city adoption UI. APIs exist. | `eligibility()` returns `challenging`; `dashboard.js` `why` map | Buttons + explanations | 🟡 Partly: challenge + Resign done; dark-city adoption screen still open |
| C5 | P1 | Founder-path copy and progress steps are pre-v5 ("Apply in your city's 72-hour window", "others have 72 hours to apply too"). A lone qualified claimer now becomes steward immediately. | `src/me.js` steps; `dashboard.js` `renderPath` | Rewrite for v5 | ✅ Fixed |
| C6 | P1 | Country manager has no console. | — | Manager panel: election, town advice, country queue | 🟡 Partly: term, tools and queue; no country statistics yet |
| C7 | P1 | Admin has no console. Snapshot cancel exists only as an API; no readiness/health view; coin checks and objections are tucked into the sidebar. | `src/snapshot.js` `handleCancelSnapshot` | Admin console. My own readiness console was dropped: the live `/admin` console (snapshots, config, roles, content, with a fresh wallet proof on every change) covers it; the dashboard's admin panel links to it | ✅ Covered by the live `/admin` console |
| C8 | P2 | The always-visible roles table never mentions the Stake Ladder, stewards or squads, and prints "rules version 3" when signed out (actual: 5). The rules page prints "2" before its script runs. | `dashboard.html`, `rules.html` | Update text and defaults | ✅ Fixed |
| C9 | P2 | Role flags disagree: `roles.founder` is false for a steward while `level` is `founder`; vote weight is 2 in `powersOf` but 1 in `/api/me` for an admin who is also a founder. | `src/me.js` vs `src/roles.js` | One source of truth | ✅ Fixed |
| C10 | P1 (scale) | Each `/api/me` loads up to 5,000 + 20,000 member rows and re-ranks them. The page polls every 60 s. Fine for 50 users, a CPU and D1-read problem at launch-week volume. | `src/me.js` `ranked()` | Precompute leaderboards in the 10-minute job and cache | ✅ Fixed |

## D · Policy, fairness and consistency

| ID | Sev | Finding | Evidence | Fix | Status |
|---|---|---|---|---|---|
| D1 | P0 | **Steward early-confirmation counts accounts, not holders.** `localMembers()` is `COUNT(*) FROM users WHERE home_city = ?`. Probe: a steward plus 49 accounts holding 0 $VICINITY → status `active`, `probation_until` cleared on the next job run. That skips the 90-day probation and the challenge window. Rules text: "50 verified local holders". | `src/seats.js` `localMembers`, `advanceSeats` | Count only members who hold > 0 and have checked in | ✅ Fixed (see D9 for what's left) |
| D2 | P1 | Flat **1,000,000** still shown: `index.html` ×4, `cities.html` ×2, `launchpad.html`, `token.html`, `public/token.js` (`FOUNDER = 1_000_000`), dead `CLAIM_MIN_HOLD`. `test/site.test.js` asserts the stale cities text. | grep | Show the ladder (100K–1M by city size) everywhere; fix the test | ✅ Fixed |
| D3 | P1 | README: "hold … for 14 days", "first application opens a 72-hour window". Code: 7 days, steward on first claim. | `README.md` L22 | Update | ✅ Fixed |
| D4 | P1 | "Hold through the 14 days before the snapshot": the token launches Oct 3 and the Launchpad opens Oct 10, so at most 7 days of history can exist. | `launchpad.html`, `index.html`, `rules.html` | **Needs you:** shorten the window, or reword | ⬜ Open, needs you |
| D5 | P1 | Tickers are computed in the browser, differently on different pages: map uses `assign()` (resolves name clashes), dashboard/home use `baseTicker()`. Measured over the real list: **248 / 8,030 communities mismatch; 70 map tickers contain digits** (e.g. `$DONDOAO05`). No server-side source of truth. | Probe over `public/data/*` | One server-side ticker, served with `/api/me` and `/api/coins` | ✅ Fixed (digits in 70 tickers: your call) |
| D6 | P2 | `/api/seats` returns founders' full wallet addresses; the dashboard masks wallets. Decide the policy, then make both agree. | `src/seats.js` `handleSeats` | Policy decision | ⬜ Open, needs you |
| D7 | P1 | `/api/media/:id` has no auth, ids are sequential, and responses are `public, immutable`. City feeds say "only people from X see this", but their pictures can be fetched by guessing ids. | `src/social.js` `handleMedia` | Visibility check for post images (coin logos stay public) | ✅ Fixed |
| D8 | P2 | Stale leftovers: `/api/health` says `milestone: 2`, `OFFICIAL.updated` 2026-09-27, `.dev.vars.example` ("Milestone 1"), `claims`/`added_cities`/`requests` tables and `migrations/0001_city_claims.sql`. | — | Clean up | ⬜ Open |

## E · Product gaps and operations

| ID | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| E1 | P0 (decision) | The **Launchpad is not built**. A founder can design a coin and paste the contract of a coin they launched on Raydium LaunchLab; trading is links to Jupiter/Raydium. Nothing in the repo launches a city coin. What exactly opens on Oct 10 needs defining. | **Needs you** | ⬜ Open, needs you |
| E2 | P1 | No shareable city page (`/city/<id>`); invites copy `/connect`. Growth loop is weak. | Public city pages + OG cards | ⬜ Open |
| E3 | P1 | Launch depends on several Cloudflare settings (`VICINITY_MINT`, `SOLANA_RPC_URL`, `ADMIN_WALLETS`, `GOOGLE_*`, an e-mail sender, `SNAPSHOT_CUTOFF`) with no in-app way to see which are missing. A missing one fails silently or gets blamed on users. | The live admin config route reports which settings are present (never values). My separate readiness panel was dropped | ✅ Covered by the live `/admin` console |
| E4 | P2 | No CI (tests only run inside the Cloudflare build), `package-lock.json` not committed, no browser-level tests: `dashboard.js` (930 lines) is untested. | GitHub Action, lockfile, a few Playwright smoke tests | 🟡 Partly: new tests; the CI and deploy workflows and the lockfile are now in the repo (`docs/DEPLOY.md`); browser-level tests still open |

## New findings while fixing

| ID | Sev | Finding | Status |
|---|---|---|---|
| D9 | P1 | The home page still tells the story "locals choose their City Founder / no race", while policy v5 seats the first qualified claimer immediately as Seed Steward and only then lets locals challenge. The numbers are fixed; the narrative is a product call. | ⬜ Open, needs you |
| D10 | P1 | Steward early confirmation now needs 50 local holders who checked in, but a holder can hold dust (1 token) and check-ins only prove someone stood in the city once. One person with 50 phones' worth of accounts and a few cents each can still confirm early. A minimum holding per quorum member (say 1% of the bar) would close it, but that is a rule change, so a new policy version. | ⬜ Open, needs you |
| D11 | P2 | Squads can't form in a city that already has a steward (create/join refuse), though the apply path supports a squad challenging one. Pick one behaviour. | ⬜ Open |
| D12 | P2 | 70 city tickers contain digits (`$DONDOAO05`) from the clash fallback. None has launched, so this is the cheapest moment to choose a letters-only rule. | ⬜ Open, needs you |
| D13 | P2 | After launch only holders can post, and check-ins are posts, so a new member holding nothing cannot check in, which means they can never become a voter or endorse. Fine as a rule, surprising as an experience; worth a line in the onboarding. | ⬜ Open |

## What is already solid (keep)

- Fair-launch design is coherent and enforced in the database (one live seat per city and per person, one open window, unique accounts).
- 99 backend tests (82 at the start of the audit) exercising real flows end to end; deploy is gated on them.
- Strict CSP, Origin checks on writes, hashed sessions, no third-party requests, locations never stored, generic risk answers.
- Boundary data: 244 countries, 8,030 communities, overlap check runs in the test suite and matches the README's numbers.

---

## Test this on real phones (what I could not do)

1. Phantom or Solflare inside the app: open vicinity.city/connect → connect → the Google button should be hidden and e-mail sign-in shown → sign in with an e-mail code, all inside the app.
2. Same app, new account, dashboard → "Find my community": if the app can't share GPS you should see "Share your location in your browser" → copy the link → open it in Safari/Chrome → share → the app continues by itself.
3. Log in on a laptop with no wallet extension, using Google or e-mail only (header button "Log in"). Then try applying or voting: it should ask you to confirm with the wallet (that is intentional; see A6/A7).
4. Open `/admin` as an admin wallet and read the config tab. Anything missing is a Cloudflare setting to add.

## Launch checklist (Oct 3)

1. `VICINITY_MINT` secret set the moment the token exists (balance sampling and every holder feature start from this).
2. `SOLANA_RPC_URL` is a paid RPC that allows `getProgramAccounts` (Helius). Without it only 20 holders show and nobody can qualify.
3. `ADMIN_WALLETS` set; each admin has signed in once (admins need an account too).
4. Google app in production mode with redirect URI `https://vicinity.city/api/auth/google/callback`, and an e-mail sender configured (see `docs/DEPLOY.md`).
5. Workers Paid plan (the 10-minute job and full holder list exceed free-plan CPU).
6. Decide the Founding Supporters cutoff and announce it (`SNAPSHOT_CUTOFF`, 00:00 UTC) — see D4.
7. Test sign-up end to end on a real phone inside Phantom and Solflare (e-mail code), and on desktop with a phone wallet.

## Questions for you

1. What must be live on **Oct 10** for the Launchpad: only design + record contracts, or an actual launch flow (E1)?
2. Founding Supporters: keep "14 days" (cutoff would need to be later than Oct 10) or move to 7 (D4)?
3. Which `workers.dev` subdomain is yours (A5)? Is the Google app already live, and which e-mail sender will you use (A3)?
4. Should founder wallets be public on the map (D6)?
5. What are `vicinity-countdown` and `cosmos` — still serving anything, or can they be retired?
6. Steward quorum (D10): require a minimum holding per quorum member? It needs a new policy version, published first.
7. City tickers (D12): letters only? None has launched, so changing the clash rule costs nothing today.
8. Home-page story (D9): reword it for "first qualified claimer becomes Seed Steward, locals can challenge"?
9. Squads vs stewards (D11): may a squad challenge a steward, or only found an empty city?
