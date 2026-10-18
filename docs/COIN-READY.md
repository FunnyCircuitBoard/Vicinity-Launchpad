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

- `coin_art`: the PNG bytes, keyed by their own SHA-256, with one row per (SVG SHA-256, template version). A picture is drawn only by
  `POST /api/coins/ready/art`, the first time the founder's page asks for it. A GET never draws, and no page view draws either. Drawing
  is limited to 20 an hour per account, counted atomically before the work.
- `coin_versions`: one row per (city, content hash). `coin_ready` holds the city's chosen version (one per city), with UNIQUE constraints
  on `symbol` and `mint`. `coin_legacy_designs` keeps a whole copy of an earlier studio design, taken before "Use this coin" replaces it.
  The tables are created by the first write (migration `2026-10-18-coin-ready`), and nothing is dropped.
- `GET /coin-meta/art/<sha256>.png` serves a stored picture with `Cache-Control: public, max-age=31536000, immutable`. It re-hashes the
  bytes before serving them. It serves **whatever the switch says**, and so does a launched coin's `/coin-meta/<mint>.json`. At launch
  (`src/lpcoins.js`) the version is bound to the mint, and from then on that JSON names the hash-addressed picture.

## Templates are immutable

`TEMPLATES` in `src/coinart.js` is frozen. Changing the look, the fonts or the layout means adding a new version (`t2`, for example a
painted base supplied by the owner: `coinSvg` already accepts `base: "painted"` with a pinned `baseSha256`). A coin that launched with `t1`
keeps its `t1` picture forever, because the picture is stored by its own hash and bound to the mint.

## Tickers stay put

`scripts/cities/ticker-pins.json` pins every launched coin's on-chain symbol. `npm run tickers` fails, and writes nothing, if a rebuilt list
would move a pinned ticker or hand it to another city (`test/ticker-pins.test.js`). The file is empty today because the live site lists no
launched city coin. Before an approval and before a launch, the server also checks the symbol against `lp_coins`, approvals that were not
revoked, and other chosen coins.

## Measured (18 Oct 2026)

| | before (`008a1ca`) | after | |
|---|---|---|---|
| Worker bundle (`wrangler deploy --dry-run`) | 1,109.49 KiB (gzip 289.82 KiB) | 3,672.88 KiB (gzip 1,277.25 KiB) | +2,563 KiB: the wasm is 2,478,606 bytes, the fonts 31,784 + 31,872 bytes. That is about 5.6 % of the 64 MiB uncompressed limit, and 12.5 % of the paid plan's 10 MiB gzip limit (42 % of the free plan's 3 MiB) |
| Startup (`wrangler check startup`, local workerd CPU profile, 4 runs) | 73, 118, 92, 89 ms (median ≈ 90) | 96, 85, 95, 103 ms (median ≈ 95) | within noise. The wasm is loaded lazily on the first drawing, so startup does not parse it |
| One coin drawn, Node (warm) | | 35–40 ms (the first one is about 200 ms with wasm start), PNG 87–95 KB | byte-identical runs |
| One coin drawn, real Worker (wrangler dev, first call, wasm start included) | | 262 ms, the `POST /api/coins/ready/art` answer in 444 ms | the PNG is byte-identical to the Node golden (`UTICA` → `8108d332…`) |

## Rebuilding the pieces

- `node scripts/coin-art/fonts.mjs --check` checks that the committed fonts are the pinned ones. `fonts.mjs <SpaceGrotesk[wght].ttf>`
  rebuilds them (Python with fontTools 4.67.0). Any change to them is a new template version.
- `node scripts/coin-art/metrics.mjs` rebuilds `src/coinart-metrics.js`. `test/coinart.test.js` fails if the committed table differs.
- `node scripts/coin-art/render.mjs <out-dir> <cityId>…` writes the SVG and PNG for any city, to look at them on a computer.

## Not in stage 1

There is no upload of any kind. Requesting a change (another picture, ticker or name) with a person's review, and writing your own description
with screening, come in later stages. The site's launchpad cards and coin page do not show the template picture yet. They keep the city's
initials on its colour, while wallets and explorers get the picture from the launched coin's metadata. The template look and the rules text
(`docs/RULES-V7-DRAFT.md`) wait for the owner.
