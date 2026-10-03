# Launch-week hardening (3 October 2026)

What this change does to the live site, in plain words, and how it was checked before shipping. It ships without a switch: every item below is on for everyone the moment it is deployed.

## What a visitor or member can notice
- **The link checker knows city coins.** Pasting a recorded city coin's contract into the checker on the token page answers "This is the official $UTICA: the city coin of Utica, US, recorded by Vicinity" instead of "NOT the official $VICINITY contract". A contract still waiting for an admin's check is not official yet. With the database in trouble the checker still answers (the list's own verdict).
- **The checker names the one official X account** when someone pastes a look-alike handle.
- **Founders' wallets are masked on the map and in `/api/seats`** (`5*****3`), and the map no longer links a founder's wallet to a block explorer. "Yours" still works.
- **Sign-in messages work once.** A signed message that was already used answers "replayed" (409). Every page signs a fresh message on each attempt, so nobody notices unless they replay a capture.
- **Attempt limits on the public routes.** From one connection: 30 wallet checks (`/api/verify`) per 10 minutes, 30 tiny-transfer starts per 10 minutes, 20 phone-pairing codes per 10 minutes, 60 rank look-ups per minute (a look at the same wallet within 30 seconds is free). The tiny-transfer polling is counted per session (90 per 10 minutes; the page makes 60). Over the limit the answer is `429 slow_down`; the token page says "Too many checks from your network. Try again in a minute.", the sign-in page says "Too many tries from your network right now. Wait a few minutes and try again.", and the pages poll every 30 seconds instead of 10 until it clears.
- **Prices are cached for 30 seconds** per set of tokens and kept for 5 minutes when Jupiter fails (the swap panel then shows the last price, marked stale, instead of going blank). The trade panel says "● Live" only when both prices are known, calls the estimate a price ratio, and shows no Raydium button for a pair with no known pool.
- **The tiny-transfer re-proof runs out after the 30 minutes the page promised.** The dashboard then offers a new code instead of polling for ever.
- **Votes:** a banned person cannot vote; 60 votes an hour per person; votes go on posts, not replies; no replies to check-ins. None of these were offered by the page before.
- **Reports:** five reports hide a post as before. A moderator's unhide stands: hiding it again takes five people who have not reported it before (one more report does not undo the moderator; the review found that a row count would have).
- **Recording a city coin** (admins): the decision names the exact contract address the admin looked at; if the founder swapped it in between, the answer is "mint_changed" and nothing is recorded. The address must be a token mint with a supply on the blockchain (checked live); what the chain said is written into the public log. The admin console has words for every answer.
- **The admin's rejection of a founder application** is in the public log.
- **The Launchpad page never shows the admin's one-click test snapshot** as the Founding Supporter list; the token page says how many team wallets are listed ("No team wallets yet" while the list is empty).
- **Wallet buttons** appear when a wallet announces itself late or the tab comes back (in-app browsers).
- **Blockchain calls give up after 8 seconds** (`RPC_TIMEOUT_MS` changes it) and a failed holder snapshot is remembered for 5 seconds so a burst of dashboards does not stampede the RPC.

## Settings the owner may add (none required)
`JUPITER_API_BASE` + `JUPITER_API_KEY` (prices from `https://api.jup.ag` with a key), `RPC_TIMEOUT_MS`. The WAF rule list is in docs/DEPLOY.md, "Attempt limits on the public routes".

## Database
One lazily-run migration, `2026-10-03-auth-limits`: the `auth_limits` counter table and its index, created the first time a public route counts an attempt. It is the same table the (dark) sign-up v2 migration creates, statement for statement, so the two run in either order. Nothing existing is changed. If it fails, the public routes still answer (the attempt is not counted and a short code is logged).

## How it was checked
- `npm test`: 442 tests, all passing (the existing suite unchanged, plus `test/hardening-*.test.js`).
- A Miniflare run (`wrangler dev --local`, real D1, the Solana RPC and Jupiter faked at the fetch layer; scratch harness outside the repo): 33 checks, all passing.
  - The migration on a copy of today's production schema (the 39 tables of `test/helpers/prod-schema.js`), both orders: limits then sign-up, and sign-up then limits. Both recorded, one `auth_limits` table and one index each time, `users.password_hash` present only after the sign-up migration.
  - `/api/check` with the $VICINITY mint (official contract), a random address (not official), a recorded city coin (official $UTICA for Utica) and a withdrawn address (not official).
  - `/api/prices` twice in different order: one Jupiter call, the key sent as `x-api-key`, `max-age=30`; with Jupiter answering 429: the last good price, `stale: true`, status 200.
  - `/api/auth/wallet` with the same signed message twice: 200 then 409 replayed. `/api/verify` 31 times from one address: 30 verified, the 31st 429 slow_down, another address fine. `/api/pair` 21 times: 20 codes, the 21st 429.
  - `/api/rank` twice for one wallet: the second answered from the cache (`max-age=30`) and not counted.
  - `/api/seats`: the founder's wallet masked, the full address nowhere in the answer.
  - Recording a coin: the founder re-submits another address while the admin looks at the first: 409 mint_changed; an address that is a wallet on the chain: 400 not_a_mint, still waiting; a real mint: recorded, the public log says "SPL Token mint, supply 1,000,000,000, 6 decimals".
  - A banned member's vote: 403 banned; the vote lands once the ban is gone. Five reports hide a post (`UPDATE ... RETURNING` in real D1); after the admin's unhide one more report leaves it visible (reports 1, hidden 0).
  - `/api/token` (price and facts) and `/api/holders` (full list) from the fake chain; `/api/signup/*` answers 404 not_enabled with the switch unset.
