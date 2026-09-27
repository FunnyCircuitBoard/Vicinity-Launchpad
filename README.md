# Vicinity

**One city. One coin. One community.** Every real city on one map, with real boundaries. Each community gets one official coin, local leaders, and its own feed of memes, check-ins, discussions and weekly votes. $VICINITY holders get in first; the Vicinity Launchpad opens October 10, 2026 at 10:10:10 AM New York time.

Live: https://vicinity.city (vicinitycity.net and the www addresses forward there).

> **No token exists yet.** $VICINITY has not launched. No presale, no airdrop, no contract address. When it launches, the official address will be published in this README and on the website. Use the site's "Is this link really Vicinity?" checker if in doubt.

## What's on the site
Separate pages, one shared menu (top menu on computers, bottom menu bar on phones), dark / light theme:
- **/** How it works: the problem, a step-by-step walkthrough on the real New York City boundaries (73 places, one coin), how the app works, incentives for holders and for the Launchpad, roles, roadmap, FAQ (including why $VICINITY launched on pump.fun).
- **/token** Token and holders: live facts from the blockchain (minting/freezing off, supply, price), every holder in a table that scrolls on its own, "where does this wallet stand?" (paste any address: rank, percentile, gap to the next wallet), the official token list and link checker.
- **/cities** The live map: 8,000+ communities in 244 countries with real boundaries that never overlap; claimed vs open; the communities filling up. The claim button leads to the dashboard.
- **/launchpad** Countdown to October 10 (10:10:10 AM New York time), the planned phases, who gets in first, add-to-calendar.
- **/connect** Sign in: any Solana wallet (Wallet Standard + older ones; app links for phones), "wallet on my phone" (QR code + 2-digit check number), and a tiny-transfer proof for app wallets that can't connect (FOMO, exchanges). Then X or Google. One wallet + one login = one account.
- **/rules** Every rule and formula, the "never" list, and whether the balance checks are running (filled live from `/api/policy`).
- **/dashboard** Onboarding (live rank + home community from one location check; people in empty land pick one of the three nearest communities), then: role and badges re-checked live (selling removes them), founder race with a progress bar and claiming, community and country cards, local and national feeds (memes with pictures, check-ins, discussions, weekly votes weighted 1 / 2 founders / 3 managers), reports, moderator tools, "add my town" requests, roles and responsibilities.

## Fair launch (why nobody can buy, rush or bully their way in)
All rules live in `src/policy.js` with a version number; seats, elections and snapshots store the version they were decided under.
- **Balance history** (`src/ledger.js`): every 10 minutes the scheduled job *may* record every holder's balance, on average once an hour at unpredictable moments (at least every 3 hours). Borrowing tokens for a few minutes doesn't help anyone.
- **City founders** (`src/seats.js`): hold the founder amount in every check for 14 days, have your home set 7+ days, apply from inside the city (a signed location attestation). The first application opens a 72-hour window; verified locals endorse (one person, one endorsement); the winner is scored 50% endorsements, 30% contribution, 20% holdings capped at 2× the amount; ties by a public hash. Result + hash published. 48 hours for objections (an admin who didn't object decides). Below the amount → grace (powers paused), 7 days to fix it; more than 2 graces in 90 days, or an unfixed grace → released, and a 30-day cooldown. The database allows one live seat per city and per person.
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
src/auth.js         Accounts: wallet sign-in, X / Google, phone pairing, tiny-transfer proof, re-proving, sessions
src/me.js           Dashboard data · src/social.js feeds · src/roles.js roles · src/access.js who may do what
src/chain.js        Read-only Solana data: token facts, every holder + ranks, balances, transfer lookup
src/community.js    Which community a point is in (or the three nearest) · src/cities.js + src/geo.js city data
src/store.js        Database schema + migrations (Cloudflare D1; applied automatically) · src/blobs.js big stored values
test/               Automated tests (npm test); helpers/world.js is a small test world with a clock tests can move
wrangler.jsonc      Cloudflare settings (addresses, database, the 10-minute schedule, build = copy files + pages + tests)
```

## Settings (Cloudflare → Workers → vicinity-map → Settings → Variables and secrets)
Add each one as a **Secret**, so later deploys never wipe it.
| Name | What it's for |
|---|---|
| `SOLANA_RPC_URL` | A Helius (or similar) RPC URL. Needed for the full holder list, ranks and the balance history; without it only the top 20 show and nobody can qualify as founder. |
| `VICINITY_MINT` | The token address, the moment it launches (or edit `src/official.js`). |
| `ADMIN_WALLETS` | Admin wallet address(es), comma-separated. Two admins let appeals of an admin's own decisions be judged by the other. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in. Redirect URI: `https://vicinity.city/api/auth/google/callback` |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | X sign-in. Callback: `https://vicinity.city/api/auth/x/callback` |
| `SNAPSHOT_CUTOFF` | The Founding Supporter cutoff, always 00:00 UTC, e.g. `2026-10-08T00:00:00Z`. Announce it first. |
| `ATTEST_KEY` | Optional: the key that signs location attestations (otherwise one is made once and kept in the database). |

The scheduled job and the full holder list need more CPU time than Cloudflare's free plan allows once there are many holders: use the Workers Paid plan.

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
| `GET /api/auth/google/start` (and `/x/`, `/callback`) · `POST /api/auth/logout` | X / Google sign-in |
| `GET /api/me` · `POST /api/home` · `POST /api/locate` | Dashboard data · home community · the only place a location is read |
| `GET\|POST /api/posts` · `POST /api/posts/vote` · `/api/posts/report` · `GET /api/media/:id` | Feeds |
| `POST /api/seats/apply` · `/withdraw` · `/endorse` · `/object` · `/objections/decide` · `/api/elections/vote` | Founders and managers |
| `GET /api/mod` · `POST /api/mod/hide` · `/unhide` · `/ban` · `/ban/approve` · `/ban/reject` · `/api/appeals` (+`/decide`) | Moderation |
| `GET\|POST /api/towns` · `POST /api/towns/decide` · `POST /api/snapshots/cancel` | Town requests · correcting a snapshot |

## Moderating
Moderation happens on the dashboard, under the two-person rules above, and every action is public at `/api/audit`. For anything else: Cloudflare dashboard → Storage & databases → D1 → `vicinity-claims` → Console.
- Approved "add my town" requests: `SELECT * FROM town_requests WHERE status = 'approved';` (add them to the city list at the next map build)
- A founder's seat can only be ended by an upheld objection (dashboard) or by the rules (grace), never by editing the database quietly.

## Run it locally
Requires Node.js 20+.
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
- **The bigger the place, the farther it reaches**: each community reaches 4 + 12 × log10(people / 5,000) km (≈ 4 km at 5,000 people, 16 km at 50,000, 28 km at 500,000, 40 km at 5M). A community inside a bigger one's reach joins it when the bigger one has 500k+ people (New York City keeps Newark, Jersey City, Yonkers; Denver keeps Aurora; Dhaka keeps Narayanganj), when it's at most half the size (Syracuse + Clay, Albany + Troy), or when it's right next door (within 40% of the reach, at least 5 km: Herkimer + Ilion). Other 500k+ cities keep their own coin (Gazipur next to Dhaka), and nothing merges across a country border. When merged towns are about the same size, the county seat names the coin. Hand corrections (the country manager's changes, for now) go in `scripts/boundaries/metro-overrides.json` (`keepSeparate`, `merge`).
- **Nearest land** fills the gaps between cities: every city also gets the land nearest to it, cut to its country's borders and around official boundaries. Cities with an official boundary keep it as their core and add nearest land up to about 25 km beyond its edge (solid line on the map); cities without one get up to 25 km around their centre, 50 km for 1M+ cities (dashed line). Only land farther than that from every city stays empty. A founder can claim from anywhere in the city's area.

The files in `public/data/bounds/` are generated. To rebuild them (takes 1–2 hours, mostly downloading):
```
node scripts/cities/build-list.mjs      # (optional) the city list: every place with 1,000+ people (GeoNames)
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
Code: https://github.com/FunnyCircuitBoard/Vicinity-Launchpad · Cloudflare account: the one that owns vicinity.city.
- By hand: `npx wrangler deploy` (runs `npm run build` first: files copied in, pages built, every test must pass).
- Automatically on every push to `main`: Cloudflare → Workers & Pages → vicinity-map → Settings → Builds → connect the GitHub repository.

## Security
- One account per person: one wallet + one X or Google login, enforced by the database. From Google we keep the account id and first name; from X the id, @handle and name. No e-mail, no passwords. Only a hash of the session cookie is stored (HttpOnly, Secure, SameSite=Lax, 30 days); requests that change something must come from this site (Origin check).
- Wallet proof is message signing (can't move funds; bound to this site; expires after 10 minutes), a phone approving a computer's sign-in (one-time code + 2-digit check number), or a tiny exact SOL transfer the wallet sends to itself (only the owner can send from a wallet).
- Locations are never stored: they're used once to find a community, check in, claim, or request a town (requests keep a point rounded to about 5 km). VPNs, proxies and far-away connections are refused.
- Feeds never show wallets; contract addresses can't be posted; pictures are checked (JPEG / PNG / WebP only) and served with a locked-down policy.
- Strict Content-Security-Policy: pages load nothing from other websites (fonts and the QR library are self-hosted; the price is fetched by the server).
- Found a security problem? Please report it privately via GitHub's "Security" tab.

## Risk disclosure
Meme coins are highly speculative, and most lose all or nearly all their value. Nothing here is financial advice or a promise of profit.

## License
Code: MIT. Fonts: Inter and Space Grotesk, SIL Open Font License 1.1. City data: GeoNames (geonames.org), CC BY 4.0. City boundaries: © OpenStreetMap contributors, ODbL 1.0. Country outlines: Natural Earth (public domain).
