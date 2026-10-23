# The ready-made city coin (stage 1, `COIN_V2_READY`)

Stage 1 of the new city-coin flow. It is built behind `COIN_V2_READY` in `wrangler.jsonc`, which is **off**. Only the exact value `on` turns
it on. With any other value the site stays exactly as it was before. The switch row in `docs/DEPLOY.md` says what it does for people. This
page covers how it works and what was measured.

## How a coin is made

1. **The facts.** `src/coindefaults.js` reads the city from the Vicinity city list (`src/cities.js` `cityRecord`): the registry ticker
   (`public/data/tickers.json`), the coin name (the city's name, with three hand overrides), city, region, country and a default description
   ("The city coin of Utica, New York, United States."). The pair is SOL. Nobody types any of these, the founder included.
2. **The picture.** `src/coinart.js` builds an SVG from template version `t1`. It is a vector redraw of the owner's Utica coin: the
   ticker, the city name and "VICINITY CITY" on an arc. The text sizes are computed from a width table of the two committed fonts
   (`src/coinart-metrics.js`), so the browser, the Worker and the tests all get the same layout without a renderer. resvg-wasm 2.6.2 renders
   the SVG to a 512×512 PNG inside the Worker (`src/coinart-wasm.js`, `src/coinart-render.js`). The fonts are Space Grotesk Bold and Medium
   static subsets under the SIL OFL (`src/assets/fonts`).
3. **The version.** The content hash is the SHA-256 of `canonicalContent()` in `src/coinready.js`: the city, name, symbol, description, the
   picture's SHA-256 and template version, and the pair. When the founder taps **Use this coin**, the page sends this hash. The server
   records it only if it still matches what the server computes at that moment. Otherwise it answers `coin_changed` with the current version.

## Storage and serving

- `coin_art`: the PNG bytes, keyed by their own SHA-256, with one row per (SVG SHA-256, template version). A picture is drawn only by the
  founder's own POSTs: `POST /api/coins/ready/art` (the first time the founder's page asks for it; 20 an hour per account) and, when it was
  never drawn, `POST /api/coins/ready/use` (10 a day per account); both counted atomically before the work. A GET never draws, and no page
  view draws either. A first drawing costs about 260 to 470 ms of CPU in the Worker (the wasm starts, then the picture): more than the Free
  plan's 10 ms per request allows, so this switch needs the Workers Paid plan. The `coin art drawn` log line times the drawing with
  `Date.now()`, which does not advance during CPU work in production, so it under-reports there.
- `coin_versions`: one row per (city, content hash). `coin_ready` holds the city's chosen version (one per city), with UNIQUE constraints
  on `symbol` and `mint`. `coin_legacy_designs` keeps a whole copy of an earlier studio design, taken before "Use this coin" replaces it.
  The tables are created by the first write (migration `2026-10-18-coin-ready`), and nothing is dropped. `coin_ready.approved_hash` is the
  version the owner's approval was built from (`src/lpadmin.js` approveTx, only with the switch on; a new "Use this coin" clears it).
- `GET /coin-meta/art/<sha256>.png` serves a stored picture with `Cache-Control: public, max-age=31536000, immutable`. It re-hashes the
  bytes before serving them. It serves **whatever the switch says**, and so does a launched coin's `/coin-meta/<mint>.json`. When the launch
  is recorded (`src/lpcoins.js`) the version is bound to the mint, but only if the switch is on at that moment, the choice is still the
  city's design, the owner's approval was built from that very version, and the chain's name and symbol are the version's. From then on that
  JSON names the hash-addressed picture, whatever the switch says. Anything else gets the old JSON (the Vicinity badge): a version that was
  chosen while the switch was on is never published after it is turned off. A bind that fails with a database error decides nothing: no JSON
  is stored, the record answers without it and the first `/coin-meta/<mint>.json` read answers a short 503, so the next record (the page or
  the sweep) or read binds it; a JSON stored without the version would be served for ever. A bound coin's description is the version's own
  sentence, so a moderator's text takedown of it is refused (`system_text`) and never logged as a removal.

## Templates are immutable

`TEMPLATES` in `src/coinart.js` is frozen. Changing the look, the fonts or the layout means adding a new version (`t2`, for example a
painted base supplied by the owner: `coinSvg` already accepts `base: "painted"` with a pinned `baseSha256`). A coin that launched with `t1`
keeps its `t1` picture forever, because the picture is stored by its own hash and bound to the mint.

## Tickers stay put

`scripts/cities/ticker-pins.json` pins every launched coin's on-chain symbol. `npm run tickers` fails, and writes nothing, if a rebuilt list
would move a pinned ticker or hand it to another city, if a coin on the official list of launched city coins (`/api/official-coins`, read
from the chain; `--official <file>` for a saved copy) is not pinned to its own symbol, or if a live approval on chain (every Approval of
`wrangler.jsonc`'s `LAUNCHPAD_PROGRAM_ID`, one `getProgramAccounts`; `--approvals <file>` for a saved copy) would lose its symbol to
another city or leave the list: `approve_launch` already fixes the ticker on chain, so pin it first (`test/ticker-pins.test.js`). The file is empty today
because the live site lists no launched city coin. The pins are published at `public/data/ticker-pins.json` for the Cities page's fallback.
With the switch on, the server checks a ticker again, each route against its own list. Launched and approved coins count on this site's
launchpad only (`lpSetup`'s cluster and program: a row of another network can neither be read here nor launch here), and every coin whose
symbol was never read counts as a possible clash until it is read, all of them, not only the 20 read at a time:
- "Use this coin" (`src/coinready.js`): coins recorded in `lp_coins` (one whose symbol was never read is read from the chain by the POSTs,
  or blocks; a GET reads nothing from the chain for it), approvals in `lp_approvals_log` not revoked since, and other cities' chosen coins
  (`coin_ready`, unique by symbol). A choice counts only while it can still launch: bound, approved, or still its city's registry ticker.
  One the city list moved away from (unlaunched tickers are not pinned) is released by the next "Use this coin" of the city that has the
  ticker now (its symbol becomes `~<city id>`, never a ticker), and it is nobody's preview any more.
- The owner's candidates and approval (`src/lpadmin.js`): `lp_coins` (same rule for an unread symbol) and EVERY approval on chain (one
  `getProgramAccounts`, not only those of the 200 newest design rows).
- The launch (`src/lplaunch.js`): `lp_coins` (same rule).

## What the founder is told about an approval on chain

"Approved" (and "It launches exactly as approved") only when the approval is for the founder's own wallet and was built from the coin they
chose, still their design: exactly what the launch record binds. An approval for another wallet (a seat that changed hands before the owner
revoked it) is `approved_other`; one built from anything else (a studio design approved before the switch, or the ready-made coin approved
with the switch off) is `approved_earlier`, which names the approved name and ticker. In both cases the card shows no coin of its own and
no preview: what launches is that approval. While a version is approved or launched, the card shows that version, not the defaults as the
city list reads today. The coin card and the Launchpad say "made by Vicinity" / "Chosen" for a design row that is the
ready-made coin (`madeBy` in `/api/coins?city=` and on Launchpad cards), never "designed by the City Founder". `chosen` says whether that
choice still holds (`src/coinready.js` `choiceHolds`): its ticker and name are the city list's now, or an approval on chain was given from
it, or the list cannot be read. One the list moved away from is `chosen: false`: still Vicinity's design, but the pages say "Not chosen
yet" (or "Not launched" with no founder) and no "chosen <date>", as the owner's list ("no longer matches the city list") and the founder's
card (a new version to use) do. The founder's Today line is worded from the same answer's flags as their card: a new version of their
choice, a former founder's choice, their own earlier studio design kept aside (`earlier`: the design row was saved by their account), a
former founder's studio design (`earlierOther`), or a coin ready. The coin card's preview says "the coin you chose" only for the founder's
own choice (`chosen.mine`); after a seat change it says a former founder chose it.

## Measured (18 Oct 2026)

| | before (`008a1ca`) | after | |
|---|---|---|---|
| Worker bundle (`wrangler deploy --dry-run`) | 1,109.49 KiB (gzip 289.82 KiB) | 3,672.88 KiB (gzip 1,277.25 KiB) | +2,563 KiB: the wasm is 2,478,606 bytes, the fonts 31,784 + 31,872 bytes. That is about 5.6 % of the 64 MiB uncompressed limit, and 12.5 % of the paid plan's 10 MiB gzip limit (42 % of the free plan's 3 MiB) |
| Startup (`wrangler check startup`, local workerd CPU profile, 4 runs) | 73, 118, 92, 89 ms (median ≈ 90) | 96, 85, 95, 103 ms (median ≈ 95) | within noise. The wasm module itself is compiled when the isolate starts (the bundler hoists its import; about 5 ms for this size, so a much larger wasm would show here); only its instantiation and the first drawing are lazy, so ordinary requests never pay for initWasm |
| One coin drawn, Node (warm) | | 35–40 ms (the first one is about 200 ms with wasm start), PNG 87–95 KB | byte-identical runs |
| One coin drawn, real Worker (wrangler dev, first call, wasm start included) | | 262 ms, the `POST /api/coins/ready/art` answer in 444 ms | the PNG is byte-identical to the Node golden (`UTICA` → `8108d332…`) |

## Rebuilding the pieces

- `node scripts/coin-art/fonts.mjs --check` checks that the committed fonts are the pinned ones. `fonts.mjs <SpaceGrotesk[wght].ttf>`
  rebuilds them (Python with fontTools 4.67.0). Any change to them is a new template version.
- `node scripts/coin-art/metrics.mjs` rebuilds `src/coinart-metrics.js`. `test/coinart.test.js` fails if the committed table differs.
- `node scripts/coin-art/render.mjs <out-dir> <cityId>…` writes the SVG and PNG for any city, to look at them on a computer.

## Not in stage 1

A city with a Raydium LaunchLab contract still waiting is stage 0's (`fix/close-launchlab-path`, merged first): its candidates skip it, an
admin can only reject the contract, and nothing launches while it waits. There is no upload of any kind. Requesting a change (another picture, ticker or name) with a person's review, and writing your own description
with screening, come in later stages. The site's launchpad cards and coin page do not show the template picture yet. They keep the city's
initials on its colour, while wallets and explorers get the picture from the launched coin's metadata. The template look and the rules text
(`docs/RULES-V7-DRAFT.md`) wait for the owner.
