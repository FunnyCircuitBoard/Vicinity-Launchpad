# Vicinity

**One city. One coin. One community.** Every real city on one map, with real boundaries. Each community gets one official coin, local leaders, and its own feed of memes, check-ins, discussions and weekly votes. $VICINITY holders get in first; the Vicinity Launchpad opens October 10, 2026 at 10:10:10 AM New York time.

Live: https://vicinity.city (vicinitycity.net and the www addresses forward there).

> **No token exists yet.** $VICINITY has not launched. No presale, no airdrop, no contract address. When it launches, the official address will be published in this README and on the website. Use the site's "Is this link really Vicinity?" checker if in doubt.

## What's on the site
Separate pages, one shared menu (top menu on computers, bottom menu bar on phones), dark / light theme:
- **/** How it works: the problem, a step-by-step walkthrough on the real New York City boundaries (73 places, one coin), why joining early matters (straight from the rules), how the app works, incentives for holders and for the Launchpad, how to get $VICINITY, roles, roadmap, FAQ (including why $VICINITY launches on Raydium LaunchLab).
- **/token** Token and holders: live facts from the blockchain (minting/freezing off, supply, price), every holder in a table that scrolls on its own, "where does this wallet stand?" (paste any address: rank, percentile, gap to the next wallet), the official token list and link checker.
- **/cities** The live map: 8,000+ communities in 244 countries with real boundaries that never overlap; claimed vs open; the communities filling up. The claim button leads to the dashboard.
- **/launchpad** Countdown to October 10 (10:10:10 AM New York time), the planned phases, who gets in first, add-to-calendar.
- **/connect** Log in or sign up. Returning members log in with Google or e-mail (the header button says **Log in** when you're signed out). New members: any Solana wallet (Wallet Standard + older ones; app links for phones), "wallet on my phone" (QR code + 2-digit check number), and a tiny-transfer proof for app wallets that can't connect (FOMO, exchanges). Then Google or e-mail (Google is hidden inside a wallet app's browser, where it can't run; e-mail works everywhere). One account per wallet and per login (a best-effort limit: it does not prove one person). **/locate** is the page a wallet app's browser sends you to for a location check it can't do itself (GPS often isn't shared there).
- **/rules** Every rule and formula, the "never" list, and whether the balance checks are running (filled live from `/api/policy`).
- **/dashboard** Your role's home (member, holder, founder or steward, country manager, admin), the Vicinity Pass (member card), Buy & swap ($VICINITY, your city's coin, city coin ⇄ $VICINITY: straight to Jupiter or Raydium, where people sign in their own wallet; estimates from live prices), your city's coin (the founder's coin studio: name, pitch, colour, logo, pair SOL/USDC/RAY). Onboarding (live rank + home community from one location check; people in empty land pick one of the three nearest communities), then: role and badges re-checked live (selling removes them), founder race with a progress bar and claiming, community and country cards, local and national feeds (memes with pictures, check-ins, discussions, weekly votes weighted 1 / 2 founders / 3 managers), reports, moderator tools, "add my town" requests, roles and responsibilities.

## Fair launch (why nobody can buy, rush or bully their way in)
All rules live in `src/policy.js` with a version number; seats, elections and snapshots store the version they were decided under.
- **Balance history** (`src/ledger.js`): every 10 minutes the scheduled job *may* record every holder's balance, on average once an hour at unpredictable moments (at least every 3 hours). Borrowing tokens for a few minutes doesn't help anyone.
- **City founders** (`src/seats.js`): hold the city's founder amount in every check for 7 days (the Stake Ladder: 100K to 1M by city size, `src/policy.js`), have your home set 7+ days, apply from inside the city (a signed location attestation). The first qualified claimer becomes **Seed Steward** at once: a 90-day bonded probation, confirmed early by 50 verified local holders, challengeable by locals (10 endorsements force a 72-hour election the steward runs in). If several claim together, a 72-hour window scores them: 50% endorsements, 30% contribution, 20% holdings capped at 2× the amount; ties by a public hash. Result + hash published. 48 hours for objections (an admin who didn't object decides). 3 to 5 verified locals can pool as a **squad**. Below the amount → grace (powers paused), 7 days to fix it (48 hours for a steward); more than 2 graces in 90 days, or an unfixed grace → released, and a 30-day cooldown. The database allows one live seat per city and per person.
- **Country managers** (`src/elections.js`): elected for 90 days by the country's verified locals (50% votes, 30% service, 20% capped holdings), from founders active 30+ days, at most two terms in a row.
- **Moderation** (`src/moderation.js`): hides need a reason and last 24 hours unless a second moderator (or 3 reports) confirms; bans are proposed by one person and approved by another, last 30 days, and can be appealed to someone uninvolved. Everything is in the public log (`/api/audit`).
- **Founding Supporters** (`src/snapshot.js`): eligible = min(balance at the cutoff, 14-day average); pools and team wallets excluded; Merkle root + input hash; 48-hour challenge period.
- **Location** (`src/attest.js`): read in one place only, turned into a 5-minute single-use signed "city attestation"; coordinates are never stored or logged. Risk checks answer generically.
- **Fresh proof**: applying, endorsing, voting and moderating need the wallet proven in the last 30 minutes.

## Project layout
```
public/             Website: generated pages (*.html), style.css, page scripts (site.js shared; home, token, cities,
                    launchpad, connect, dashboard, rules, wallets.js), data/ (cities, boundaries, NYC example, stats)
scripts/pages/      Page sources + shared layout: edit here, then `npm run pages` (a test checks public/*.html match)
scripts/demo/       nyc.mjs builds the New York City example + site numbers (`npm run demo:nyc`)
scripts/boundaries/ Builds the city boundaries; scripts/cities/ builds the city list
src/index.js        Backend (Cloudflare Worker): routes, the scheduled job, forwarding old addresses
src/policy.js       Every rule, versioned
src/jobs.js         The every-10-minutes job: balance checks, seats, elections, moderation expiry, snapshots
src/ledger.js       Balance history (random-time samples, 14-day streaks and averages)
src/seats.js        City founders · src/elections.js country managers · src/moderation.js moderation + town requests
src/snapshot.js     Founding Supporters (Merkle proofs) · src/attest.js location attestations
src/auth.js         Accounts: wallet sign-in, Google / e-mail codes, phone pairing, tiny-transfer proof, re-proving, sessions
src/admin.js        The /admin console API (/api/admin/*): roles, content, snapshots, config; every change needs a fresh wallet proof and is logged
src/signup.js       The new sign-up (only while SIGNUP_FLOW=v2): state, location, Terms, Google / e-mail + password, and the one atomic `finish` · src/signup-core.js its cookie and tidy-up · src/pwlogin.js password log-in
src/password.js     Password hashing (PBKDF2-SHA256) and rules · src/limits.js atomic attempt counters · src/flags.js the SIGNUP_FLOW, PROFILES, LAUNCHPAD_V2 and DASHBOARD_V2 switches
src/launchpad.js    The Launchpad's coin list (only while LAUNCHPAD_V2=on): one answer with a card per coin, and the job's holder counts · src/market.js market data from DexScreener, asked by the Worker
src/profiles.js     Member profiles (only while PROFILES=on): profile, search, follow, block, bio, bio report · src/profile-core.js their shared rules (bio, exact counts, who is visible) · src/portfolio.js the portfolio: only $VICINITY and launched city coins, with live dollar values
src/handoff.js      Location hand-off: the wallet app's browser can't share GPS, the phone's own browser does it (coordinates are never stored)
src/tickers.js      City coin tickers, one per community everywhere, read from public/data/tickers.json (npm run tickers builds it)
src/me.js           Dashboard data · src/social.js feeds · src/roles.js roles · src/access.js who may do what
src/chain.js        Read-only Solana data: token facts, every holder + ranks, balances, transfer lookup
src/community.js    Which community a point is in (or the three nearest) · src/cities.js + src/geo.js city data
src/store.js        Database schema + migrations (Cloudflare D1; applied automatically) · src/blobs.js big stored values
test/               Automated tests (npm test); the browser pages are checked by hand (see docs/AUDIT.md); helpers/world.js is a small test world with a clock tests can move; helpers/fakedom.js runs the sign-up page's script (public/signup.js) without a browser
wrangler.jsonc      Cloudflare settings (addresses, database, the 10-minute schedule, build = copy files + pages + tests)
```

## Settings (Cloudflare → Workers → vicinity-map → Settings → Variables and secrets)
Keys and passwords (`SOLANA_RPC_URL`, `GOOGLE_CLIENT_SECRET`, the mail keys) are **Secrets**: a deploy never touches them. Public settings (`SITE_MODE`, `GOOGLE_CLIENT_ID`, `EMAIL_FROM`) live in `wrangler.jsonc`; other plain variables added in the dashboard (for example `ADMIN_WALLETS`) are kept by a deploy. See [docs/DEPLOY.md](docs/DEPLOY.md).
| Name | What it's for |
|---|---|
| `SOLANA_RPC_URL` | A Helius (or similar) RPC URL. Needed for the full holder list, ranks and the balance history; without it only the top 20 show and nobody can qualify as founder. |
| `VICINITY_MINT` | The token address, the moment it launches (or edit `src/official.js`). |
| `ADMIN_WALLETS` | Admin wallet address(es), comma-separated. Two admins let appeals of an admin's own decisions be judged by the other. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in. Redirect URI: `https://vicinity.city/api/auth/google/callback` |
| `SNAPSHOT_CUTOFF` | The Founding Supporter cutoff, always 00:00 UTC, e.g. `2026-10-08T00:00:00Z`. Announce it first. |
| `ATTEST_KEY` | Optional: the key that signs location attestations (otherwise one is made once and kept in the database). |
| `JUPITER_API_BASE`, `JUPITER_API_KEY` | Optional: where prices come from and the key for it (`https://api.jup.ag` with a free key from portal.jup.ag). Unset = the keyless address Jupiter is retiring. See [docs/DEPLOY.md](docs/DEPLOY.md). |
| `RPC_TIMEOUT_MS` | Optional: how long one blockchain call may take before the site gives up on it (default 8000). |
| `SIGNUP_FLOW` | `v2` switches on the new sign-up (see below); anything else or missing = the old sign-up. Set to `v2` in `wrangler.jsonc` since 3 Oct 2026, so every deploy applies it; change it there to switch back. |
| `PROFILES` | `on` switches on member profiles (see below); anything else = no profiles. Set to `on` in `wrangler.jsonc` since 3 Oct 2026; change it there to switch back. |
| `LAUNCHPAD_V2` | `on` switches on the Launchpad's city-coin list (see below); anything else = the old Launchpad page. Set to `on` in `wrangler.jsonc` since 3 Oct 2026; change it there to switch back. |
| `DASHBOARD_V2` | `on` switches on the tabbed dashboard (Home, City, Community, Rankings, Founder, Moderate, Profile; Founder Status against the real steps; the Founder card); anything else or missing = today's dashboard. Only `/api/me` says `dashboardV2: true`; the page then loads `public/dashboard-v2.js`. See "Dashboard v2 switch" in [docs/DEPLOY.md](docs/DEPLOY.md). |
| `PASSWORD_PEPPER` | Secret for the new sign-up: mixed into every password hash. Create it before the first password exists and never change it. See [docs/DEPLOY.md](docs/DEPLOY.md). |

The scheduled job and the full holder list need more CPU time than Cloudflare's free plan allows once there are many holders: use the Workers Paid plan.

**The new sign-up (dark until `SIGNUP_FLOW=v2`).** Location first, then the account, then the wallet: a new person's location is checked with the same rules as `/api/locate` (only the community is kept, never the coordinates; a person in empty land picks one of the three nearest communities, or finishes the check in their phone's own browser), then they accept the Terms of Use and sign in with Google, or with an e-mail address, a password and the 6-digit code that proves the mailbox, then they prove their wallet; one atomic database step then creates the account (nothing is half-made if anything fails or two taps arrive together) and they land on the dashboard. Returning members log in with their wallet, Google, or e-mail + password and repeat nothing. Passwords are salted PBKDF2-SHA256 hashes (100,000 rounds, the most Cloudflare's runtime allows, which needs the Workers Paid plan: about 50 ms of CPU per check), plus an optional secret `PASSWORD_PEPPER`, a blocklist of common passwords and strict attempt counters (`src/password.js`, `src/limits.js`). While the switch is off the new routes answer `404 not_enabled`, the old sign-up is untouched and no new table exists; with it on, the old routes can only sign people in. Code: `src/signup.js` (the sign-up and its single `finish`), `src/signup-core.js`, `src/pwlogin.js`. How to flip it on and off, and what to do before: the "Sign-up v2 switch" section of [docs/DEPLOY.md](docs/DEPLOY.md).

**Member profiles (dark until `PROFILES=on`).** A 100-character bio on the Vicinity pass, a portfolio of what a wallet holds of **only** $VICINITY and the launched city coins (live dollar values; every other token in a wallet is never asked about), and public member profiles with open follow and block. There is **no messaging of any kind** and no notifications. **What other members can see** (signed-in members only; a signed-out visitor sees nothing): username, member-since date, level and badges, home community, bio, the **full wallet address**, the **exact** $VICINITY amount with rank and percentile, the exact city-coin holdings with their dollar values, follower and following counts, and the feed posts they could see in the feeds anyway. Never: real name, sign-in method, contact e-mail, phone number, IP address, location, sessions, anybody's block list. This is a deliberate choice (everything public, like a trading app): it ties a wallet address and its balances to a username for every signed-in member, so members are told before it happens (see "Profiles switch" in [docs/DEPLOY.md](docs/DEPLOY.md)). Bios are one line, at most 100 characters (counted as Unicode characters), no links, wallet addresses, e-mail addresses or phone numbers, 10 changes a day. Following is open (any member can follow anyone, at most 1,000 people); the followed member can block, which removes the follow both ways and stops that member following again without telling them it was a block; admins and moderators cannot be blocked. Test-lab accounts and members under an active ban are not found, listed or counted. A bio can be reported; moderators see reported bios in their queue and clear one with a reason and a fresh wallet proof, and the clearing is a public line in `/api/audit` (it says that a bio was cleared and why, never whose it was or what it said). Code: `src/profiles.js`, `src/profile-core.js`, `src/portfolio.js`. While the switch is off the new routes answer `404 not_enabled`, `/api/me` is unchanged, and no new table exists.

**The Launchpad's coin list (dark until `LAUNCHPAD_V2=on`).** The Launch page becomes the place to find city coins: Live | New | Upcoming | Trending, with search, sort and filters, all computed in the browser from one public answer, `GET /api/launchpad`. It carries a card for $VICINITY (live once `VICINITY_MINT` is set, before that "upcoming" with the opening time for the countdown) and one for every city coin a founder designed: status (**live** = an admin recorded the contract, **waiting** = the contract is being checked, the address itself is never shown, **designed** = design only), city and country, the fixed ticker, name, pitch, colour, logo, the pair it was designed for, the founder by username and **masked** wallet (the dashboard's mask; never the full address), member and $VICINITY-holder counts of the community (from `/api/members`), price, market cap, fully diluted value, liquidity, 24-hour volume and change from **DexScreener** (asked by the Worker, only for $VICINITY and recorded city coins, the pair with the most liquidity, every field null when unknown), the coin's own holder count written by the 10-minute job into `coin_stats` (at most 40 coins a run, `getProgramAccounts` like the holder list), and links to Raydium LaunchLab, Jupiter, DexScreener and Solscan built from the same templates as the dashboard's Buy & swap card. Tab rules are defaults the page labels: New = live for less than 7 days; Upcoming = waiting + designed (+ $VICINITY before its mint); Trending = live coins by 24-hour volume. `rewardModel` is always `null`: no reward model exists in the data yet. One upstream round per server every 30 seconds plus the edge cache; a failed DexScreener round is kept only 5 seconds. Code: `src/launchpad.js`, `src/market.js`. While the switch is off the route answers `404 not_enabled`, `/api/official` is unchanged, the job runs nothing new and no new table exists. How to flip it: the "Launchpad v2 switch" section of [docs/DEPLOY.md](docs/DEPLOY.md).

## API
| Route | What it does |
|---|---|
| `GET /api/health` · `/api/official` · `/api/check?q=` · `/api/policy` | Status · official links · is this link official? · the rules + job health |
| `GET /api/token` · `/api/holders` · `/api/rank?address=` | Live token facts + price · every holder (top 1,000) · one wallet's rank |
| `GET /api/message?address=&action=verify/login` · `POST /api/verify` | The text a wallet signs · check a signature (nothing stored) |
| `GET /api/seats` (also `/api/claims`) · `/api/seats/results/:id` | Founder seats + open windows · a window's published result and hash |
| `GET /api/moderator?country=` · `/api/elections/results/:id` | A country's manager · an election's published result |
| `GET /api/members` · `/api/audit?country=` | Members per community · every moderation decision |
| `GET /api/snapshots` · `/api/snapshots/:id/proof?wallet=` · `/api/snapshots/:id/data` | Founding Supporters, Merkle proofs, all inputs |
| `POST /api/auth/wallet` · `/api/auth/transfer` (+`/check`) · `/api/auth/reprove` · `/api/pair` (+`/finish`) · `GET /api/pair?code=` | Prove a wallet |
| `GET /api/auth/google/start` (and `/callback`) · `POST /api/auth/logout` | Google sign-in |
| `/api/signup/*` (start, state, location, terms, email, finish ...) · `POST /api/auth/email/login` · `/api/auth/password/*` · `/api/me/password` | The new sign-up and password log-in: only while `SIGNUP_FLOW=v2`, otherwise `404 not_enabled` |
| `GET /api/me` · `POST /api/home` · `POST /api/locate` | Dashboard data · home community · where a location is read |
| `GET /api/profile?u=` · `/api/members/search?q=` · `POST /api/follow` · `GET /api/follows?u=&list=` · `POST /api/block` · `GET /api/me/blocks` · `POST /api/me/bio` · `POST /api/profile/report` · `GET /api/me/portfolio` · `POST /api/mod/bio/clear` | Member profiles, signed-in members only: only while `PROFILES=on`, otherwise `404 not_enabled` |
| `POST /api/locate/handoff` (+`/info`, `/complete`, `/claim`) | Location check finished in the phone's own browser, collected by the wallet app |
| `GET\|POST /api/posts` · `POST /api/posts/vote` · `/api/posts/report` · `GET /api/media/:id` | Feeds |
| `POST /api/seats/apply` · `/withdraw` · `/endorse` · `/object` · `/objections/decide` · `/api/elections/vote` | Founders and managers |
| `GET /api/coins` (`?city=`, admins `?waiting=1`) · `POST /api/coins/design` · `/mint` · `/mint/decide` · `/takedown` · `GET /api/prices?mints=` | City coins designed by founders (src/coins.js); prices for the swap panel |
| `GET /api/launchpad` | The Launchpad's coin list: $VICINITY and every city coin as cards with market data, holder and member counts, trade links. Only while `LAUNCHPAD_V2=on`, otherwise `404 not_enabled` |
| `GET /api/mod` · `POST /api/mod/hide` · `/unhide` · `/ban` · `/ban/approve` · `/ban/reject` · `/api/appeals` (+`/decide`) | Moderation |
| `GET\|POST /api/towns` · `POST /api/towns/decide` · `POST /api/snapshots/cancel` | Town requests · correcting a snapshot |

## Moderating
Moderation happens on the dashboard, under the two-person rules above, and every action is public at `/api/audit`. For anything else: Cloudflare dashboard → Storage & databases → D1 → `vicinity-claims` → Console.
- Approved "add my town" requests: `SELECT * FROM town_requests WHERE status = 'approved';` (add them to the city list at the next map build)
- A founder's seat can only be ended by an upheld objection (dashboard) or by the rules (grace), never by editing the database quietly.
- Bios (only while `PROFILES=on`): members report a bio from its profile; the founder of that city, the manager of that country or an admin sees the reported bios in `GET /api/mod` and clears one with `POST /api/mod/bio/clear` (a reason from the same list as a hide, a fresh wallet proof; the member may write a new bio).

## Run it locally
Requires Node.js 22.13+ (the tests use the built-in SQLite).
```
npm install
npm test          # automated tests
npm run pages     # rebuild public/*.html after editing scripts/pages/
npm run dev       # local copy at http://localhost:8787
```

## City boundaries
Every listed city gets one area, and areas never overlap:
- **Official boundary** (solid line): the city's own boundary from OpenStreetMap, matched by Wikidata item or by name, and only if it contains the city's point. Where two only partly overlap, the smaller city keeps the shared part. Boundaries that are mostly sea are trimmed to the coastline.
- **Communities**: a place with 4,000+ people (and every country's three biggest places) is a community with its own coin and area. A smaller place is part of the community around it (search "Mohawk" → part of Herkimer), or "outside" in empty land; people there are offered the three nearest communities. Missing towns will be requestable from where you stand, approved by the country manager.
- **Part of a bigger community**: inside its official boundary, Wikidata says it's located in it, or at the same spot (Manhattan, Brooklyn, East New York, Financial District → New York City; Mirpur, Motijheel → Dhaka). Not if it's far from the centre of a very large boundary (15 / 25 / 35 km for cities under 1M / 1–5M / 5M+).
- **The bigger the place, the farther it reaches**: each community reaches 4 + 12 × log10(people / 5,000) km (≈ 4 km at 5,000 people, 16 km at 50,000, 28 km at 500,000, 40 km at 5M). A community inside a bigger one's reach joins it when the bigger one has 500k+ people (Denver keeps Aurora; Dhaka keeps Narayanganj), when it's at most half the size (Syracuse + Clay, Albany + Troy), or when it's right next door (within 40% of the reach, at least 5 km: Herkimer + Ilion). Other 500k+ cities keep their own coin (Gazipur next to Dhaka), and nothing merges across a country border. When merged towns are about the same size, the county seat names the coin. Hand corrections (the country manager's changes, for now) go in `scripts/boundaries/metro-overrides.json` (`officialOnly`: a city keeps only its official boundary, as New York City does with its five boroughs; `keepSeparate`; `merge`).
- **Nearest land** fills the gaps between cities: every city also gets the land nearest to it, cut to its country's borders and around official boundaries. Cities with an official boundary keep it as their core and add nearest land up to about 25 km beyond its edge (solid line on the map); cities without one get up to 25 km around their centre, 50 km for 1M+ cities (dashed line). Only land farther than that from every city stays empty (people there pick one of the three nearest communities; where towns of 4,000+ people sit in empty land, they are added to the list: `scripts/cities/added-towns.json`). A place kept separate inside a bigger city's official boundary (Levittown inside the Town of Hempstead) gets its nearest land both inside and outside that boundary. A founder can claim from anywhere in the city's area.

The files in `public/data/bounds/` are generated. To rebuild them (takes 1–2 hours, mostly downloading):
```
node scripts/cities/build-list.mjs      # (optional) the city list: every place with 1,000+ people (GeoNames)
node scripts/cities/add-towns.mjs       # (optional) add towns listed in scripts/cities/added-towns.json (e.g.
                                        # Long Island's east end, which had no community) from the full list
node scripts/boundaries/1-links.mjs     # GeoNames id → Wikidata item (Wikidata query service)
node scripts/boundaries/1b-located-in.mjs  # which listed places Wikidata puts inside another (Brooklyn → NYC)
node scripts/boundaries/2-shapes.mjs    # boundary shapes from OpenStreetMap (Overpass API); add --server=1 or
                                        # --reverse to run extra workers side by side
node scripts/boundaries/3-build.mjs     # non-overlapping areas → public/data/bounds/, public/data/world.json
```
Downloads are cached in `.cache/boundaries/` (not committed), so re-running step 3 with different rules is quick.

**No overlaps.** Step 3 rounds every area to the stored precision (about 11 m) and then cuts any overlap bigger than 1 m² out of one side (an official boundary beats a nearest-land area, otherwise the smaller area keeps it), across all countries. To check the files yourself:
```
npm run check:boundaries   # exact geometry, every pair of neighbouring areas; exit code 1 if anything overlaps
```
The test suite runs the same check, so a build with overlapping areas can't deploy.

## Deploy
Everything is launched from GitHub: a pull request is tested automatically (`.github/workflows/ci.yml`), and merging it into `main` deploys it (`.github/workflows/deploy.yml`: build, every test, `wrangler deploy`, then a check of the live security headers). One-time setup, the launch checklist and rollback: [docs/DEPLOY.md](docs/DEPLOY.md). Nothing should be deployed from anyone's computer.

## Security
- One account per wallet and per login (Google account or e-mail address), enforced by the database. That makes fake accounts harder but does not prove one person: one inbox can have many addresses. What we keep: your wallet address; for Google sign-in only the Google account id and your first name; for e-mail sign-in the e-mail address itself (it is your account id) and a hash of the 6-digit code (codes expire after 10 minutes); a made-up username (changeable, 3 times a day at most); your home community; and, only if you add them, a contact e-mail and a phone number, which you can remove any time (the phone number is not verified and not used for anything yet). When member profiles are switched on (`PROFILES=on`) we also keep an optional bio of at most 100 characters, and who you follow and block; and then **other signed-in members can see your username, community, bio, wallet address and your exact $VICINITY and city-coin balances** (never your real name, sign-in method, contact e-mail, phone number or location). Check-in coordinates are never stored. Passwords: none today; when the new sign-up is switched on (`SIGNUP_FLOW=v2`), an e-mail account keeps a salted, deliberately slow hash of its password (never the password itself), and a half-finished sign-up keeps your community, your network provider and country, and the verified Google id or e-mail address for at most 3 hours. Only a hash of the session cookie is stored (HttpOnly, Secure, SameSite=Lax, 30 days); requests that change something must come from this site (Origin check).
- Wallet proof is message signing (can't move funds; bound to this site; expires after 10 minutes), a phone approving a computer's sign-in (one-time code + 2-digit check number), or a tiny exact SOL transfer the wallet sends to itself (only the owner can send from a wallet).
- Locations are never stored: they're used once to find a community, check in, claim, or request a town (requests keep a point rounded to about 5 km). VPNs, proxies and far-away connections are refused.
- Feeds never show wallets (with `PROFILES=on` a member's profile does, to signed-in members: see above); contract addresses can't be posted; pictures are checked (JPEG / PNG / WebP only) and served with a locked-down policy.
- Strict Content-Security-Policy: pages load nothing from other websites (fonts and the QR library are self-hosted; the price is fetched by the server).
- Found a security problem? Please report it privately via GitHub's "Security" tab.

## Risk disclosure
Meme coins are highly speculative, and most lose all or nearly all their value. Nothing here is financial advice or a promise of profit.

## License
Code: MIT. Fonts: Inter and Space Grotesk, SIL Open Font License 1.1. City data: GeoNames (geonames.org), CC BY 4.0. City boundaries: © OpenStreetMap contributors, ODbL 1.0. Country outlines: Natural Earth (public domain).
