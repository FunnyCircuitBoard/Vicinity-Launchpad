# Vicinity Launchpad

This is the short guide to Vicinity's own launchpad on Solana. Part 1 is for
the owner, in plain English. Part 2 is for an outside auditor.

The detailed specification is `LAUNCHPAD-DESIGN.md`. The build and test
record is `LAUNCHPAD-AUDIT.md`. What runs on devnet, with every address and
signature, is in `LAUNCHPAD-DEVNET.md`.

Nothing here touches mainnet. Mainnet is the owner's decision, made on his own
machine, after an outside audit (section 9).

---

# Part 1: for the owner

## 1. What it does

* **One coin per city, launched only by the founder you approve.** You (the
  admin wallet) approve a founder for a city. Only that founder can launch the
  city's coin, and only once. Each city gets one coin, forever.
* **Every coin is born the same way:** 1,000,000,000 coins, 6 decimals, no
  one can ever mint more or freeze anyone's coins, and the name, ticker and
  metadata can never change.
* **People buy and sell on a price curve.** The price goes up as people buy
  and down as they sell. When the curve has raised its target (85 SOL by
  default), the coin "graduates": all the money raised plus a reserve of coins
  moves into a normal trading pool whose liquidity is locked forever.
* **People can swap one city coin for another** in one step.
* **People can pay with almost anything**: SOL, USDC, USDT, BTC, ETH,
  tokenized stocks, STONK or $VICINITY (section 5).
* **Every platform fee goes to your dev wallet**
  `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN`. That address is written into
  the program itself. No key can redirect it.
* **Each city's holders and founder get a share of every trade** (section 3).
  Holders are paid through the existing `vicinity_rewards` claim program, or
  by a push from your own wallet (section 6). The founder can claim at any
  time, or opt in to be paid in US dollars to their X Money account once you
  set that up (section 7).

Under the hood, the price curve, buying, selling and graduation run on
Meteora's audited bonding-curve program. Vicinity's own small program decides
who may launch which city's coin and splits the city's share of the fees. Our
program never holds anybody's curve money.

## 2. How a city coin is born and grows

1. The city's founder is chosen on vicinity.city as today.
2. You click "Approve on chain" (the admin wallet signs). The approval names
   the founder, the coin name, the city ticker and the price settings, and it
   expires after at most 30 days.
3. The founder clicks "Launch" and signs. The coin, its metadata and its curve
   are created. The founder can buy the first coins in the same transaction.
4. Anyone trades on vicinity.city (and on Jupiter while Jupiter lists the
   curve; see section 4).
5. When the curve is full, anyone can trigger graduation (Vicinity's keeper
   does it within a minute). The coin then trades in a Meteora pool.
6. Every day the keeper collects the city's share of fees and moves the
   holders' part to the city's rewards vault.

## 3. Fees: who gets what

On every buy and sell the trader pays **1.25%**:

| goes to | share of the trade | how it gets there |
|---|---|---|
| your dev wallet | 0.50% | waits in Meteora's pool, earmarked for the dev wallet; you collect it in batches (below) |
| that city's holders | 0.25% | our program moves it to the city's holders pot, then into the rewards vault |
| that city's founder | 0.25% | our program moves it to the city's founder vault; the founder claims it |
| Meteora | 0.25% | Meteora's fixed cut. On trades made on vicinity.city, a fifth of it (0.05% of the trade) comes back to your dev wallet as a referral fee, paid straight into it |

Also to your dev wallet:

* **the launch fee**: 0.05 SOL per coin, of which 0.045 SOL is yours (Meteora keeps 0.005);
* **half of the fees earned by the locked graduation liquidity** (the pool's
  fee is also 1.25%; the other half goes to the city: holders and founder).
  Anyone may add their own liquidity to that pool later; it earns its own
  share of the pool's fees;
* **the unsold dust** at graduation (about 9 coins per coin; the program
  refuses any price-curve setting that would leave more than 1,000 coins, so
  nobody can turn this into a hidden share of every coin);
* **your share of a curve's rounding "surplus"** (a few lamports).

A coin that fills its 85 SOL curve has paid about 1.08 SOL of fees by
graduation: about 0.43 SOL to you, 0.215 SOL to its holders, 0.215 SOL to its
founder and 0.215 SOL to Meteora. Trading after graduation adds more.

**Keep your dev wallet's WSOL account open.** The 0.05% referral share is
paid into your dev wallet's WSOL account (address `FGdoiY…` on mainnet,
created at setup), and Meteora refuses every site trade if that account does
not exist. Your wallet closes it whenever you "unwrap" SOL, swap from SOL with
Jupiter, or trade on vicinity.city with the dev wallet itself. The site and
the keeper recreate it automatically (a trader or the keeper pays about
0.002 SOL of deposit, which comes back to you when the account closes), but
do not rely on it: to move the WSOL out, send it to another wallet, or claim
into a separate account, and do not trade from the dev wallet.

**How you collect.** Fees wait safely in Meteora's accounts; only your dev
wallet can claim them. `npm run launchpad:claim-fees -- --rpc <url> --out plan.json`
lists everything waiting and writes ready-made, unsigned transactions (a few
claims each). A small signing page (website work) shows them to your phone
wallet, which signs them all at once. The referral share needs no claim: it
arrives directly.

**Changing fees** affects only coins launched afterwards: you create a new
Meteora config with the new rate and allow-list it. Each coin keeps the fees
it launched with. The program refuses any config whose fees are not paid to
your dev wallet, or whose trade fee is above 2%.

## 4. How coins show as "Vicinity"

What is automatic, from the first second:

* Each coin's on-chain metadata points to
  `https://vicinity.city/coin-meta/<coin address>.json`. That file says
  "Launched on Vicinity", carries the Vicinity logo, `createdOn:
  https://vicinity.city`, the network (Solana), the city and its ticker.
  Wallets such as Phantom and explorers read it. (The website must serve this
  file and the coin's icon; the SDK builds the file:
  `coinMetadataJson` in `sdk/launchpad/metadata.mts`.)
* The name and ticker can never be changed on chain, and the metadata link can
  never be pointed elsewhere.

What needs a request from you after the first mainnet launch (aggregators
keep their own lists; nobody can force them):

* **Meteora**: your dev wallet signs one transaction that registers "Vicinity",
  the website and the logo with Meteora (`buildPartnerMetadata`; about 0.002
  SOL). Then ask Meteora to label the Vicinity config for Jupiter. Until then
  Jupiter shows coins as launched on Meteora's generic "met-dbc". Each new
  config (a new fee or target) needs its own label request.
* **Jupiter**: free token verification at verified.jup.ag for each real coin
  (VRFD Express costs 1000 JUP; optional).
* **DEX Screener** (Discord), **Birdeye**, **GMGN** and **Axiom**, **Solscan**
  (publish the program interface on chain; send them the program id), CoinGecko.

Be aware: anyone can create a coin directly under the Vicinity Meteora config
by going around our program. Such coins never get a Vicinity record, the
website ignores them, and their platform fees still go to you. Jupiter's
labels are per config, so these look-alike coins would also show as
"Vicinity" on Jupiter. Jupiter's token verification and the on-chain Vicinity
registry are what tell the real coins apart; the registry is the only proof
that a coin is a real Vicinity city coin.

**Before the first mainnet launch (a blocker):** the website must serve each
coin's metadata file and the Vicinity logo, because the address written into
each coin can never change. That means `/coin-meta/*` handled by the website's
code (served as JSON that any site may read) and the logo at
`https://vicinity.city/brand/vicinity-512.png`. Approve the first city only
after those addresses answer.

Meteora's own per-coin page (a website and logo per pool) is deliberately not
set: only the "Vicinity" name and logo above show on Meteora. It can be added
later by a program upgrade if you want it.

## 5. Paying with stocks, BTC, ETH, SOL and more

The curve only ever takes SOL (the default). When someone pays with something
else, their own transaction first swaps it to SOL through Jupiter, then buys
the coin with exactly the SOL Jupiter guarantees. Anything Jupiter delivers
above that guarantee stays in the buyer's wallet. One signature; nobody,
including Vicinity, holds the buyer's money in between. If the swap and the
buy are too big for one Solana transaction, the website sends two (swap, then
buy, rebuilt from the curve as it is at that moment). Selling works the other
way round (coin to SOL, then SOL to BTC, a stock token, and so on).

Safety: Jupiter's answer is checked instruction by instruction before the
buyer sees it. Anything beyond "swap the buyer's own asset into the buyer's
own account for the amount they typed" (sending SOL elsewhere, approving a
stranger to spend tokens, closing an account to someone else, a priority fee
above 0.01 SOL) is refused. Every buy also stops at the curve's target and
refunds the rest, so the last buyer of a curve is never refused, and a full
or graduated curve is refused before anything is swapped.

What people can pay with (mainnet; the list and its sources are in
`sdk/launchpad/pay-assets.mts`):

| asset | note |
|---|---|
| SOL | direct, no swap |
| USDC, USDT | |
| BTC: cbBTC (Coinbase), WBTC (Wormhole) | |
| ETH (Wormhole) | |
| Tokenized stocks: TSLAx, AAPLx, NVDAx, SPYx, QQQx, GOOGLx, MSTRx, COINx, HOODx, CRCLx (xStocks) | offered **only** in the countries on an allow-list (for now the EEA and Switzerland, where the issuer offers them; a lawyer must confirm or replace the list before mainnet), never in the US, UK, Canada, Australia or a sanctioned country, and hidden when the country is unknown; shown with a "no shareholder rights" note |
| STONK | StonkFun's token. "Stonk" is StonkFun, a launchpad whose coins are priced in tokenized stocks |
| $VICINITY | thin liquidity (about $1,800): large payments move its price a lot |

Tokenized stocks are only ever paid **with**. They never sit inside a curve,
because their issuer can freeze or move them.

Tested: three live Jupiter quotes (cbBTC, ETH and SPYx to SOL) and a live
"pay with cbBTC" plan: usually one transaction with the Vicinity lookup table,
two without it (the size changes with Jupiter's route of the moment).
Jupiter does not exist on devnet, so this part can only be shown on mainnet;
it is tested with recorded Jupiter answers and, in process, with a real swap
standing in for Jupiter's.

For production the website needs a free Jupiter API key (keyless access is
limited to one request every two seconds).

## 6. Rewards to holders

**Main path: claims.** The holders' 0.25% collects in each coin's holders pot.
Daily, the keeper moves it to the city's `vicinity_rewards` vault. About every
30 days, the city's rewards authority (a Squads multisig on mainnet) publishes
a snapshot of holders and books a round; each holder then claims their own
amount on vicinity.city (paid as SOL). Snapshot rules: pools, vaults, your dev
wallet and the founder are left out; a holder needs at least 0.01% of the
coins in circulation; nobody gets less than 0.01 SOL (for a coin priced in
another token, you set the minimum in that token); and a round is only worth
funding once at least 20 holders would get that minimum.

**Fair to real holders.** A wallet must not be able to buy just before the
snapshot and sell just after to take part of the month's pot. So the tool
takes at least six balance samples at random, unannounced times during the
month (`snapshot.mjs --sample`, run by a scheduler), and each holder counts
with the smaller of their balance at the cutoff and their average over the
samples. Never run the snapshot at a fixed or published time.

**Who is left out.** Coins held in a program address (pools, vaults, and also
a Squads multisig vault or another smart wallet) do not count, and the
published rules say so. A multisig that holds coins for real people can be
added by hand (`--include`).

The snapshot tool (`scripts/launchpad/snapshot.mjs`) does all of this and
writes the file to publish. The SDK books the round (`buildFundRound`) and
builds each claim (`buildClaim`).

**Who controls the holders' money, plainly:** until it is forwarded, only our
program can move it, and only to that city's rewards vault. Once it is in the
rewards vault, the city's rewards authority decides each round who is paid,
so that key must be a multisig and every snapshot file must be published.

**"Send to all holders" (push).** For a promotion from your own wallet:
`buildAirdropBatches` turns the holder list into ready-made, unsigned
transactions (about nine holders each) that your wallet signs; each holder is
paid exactly once. Creating a token account for a holder who has none costs
about 0.0015 SOL each. (The standard `solana-tokens distribute-spl-tokens`
command does the same from a key file, with a double-send guard.)

## 7. The founder's 0.25% and X Money

**What X Money is.** X's payments product: a US-dollar account inside X, for
US residents only (18+, US phone, ID check) with an **X Premium or Premium+
subscription** (from about $8 a month), live since late July 2026 (an
invite-only beta from late June). X's payment company is licensed in 41
states and Washington, D.C., but **not in New York or Massachusetts**. It has
no public API, no business accounts and no crypto, and its rules forbid
"unauthorized commercial use". So no app can pay into it automatically.

**What UsePaid does.** It claims pump.fun creator fees into its own treasury,
sells the SOL on Kraken, moves the dollars by bank transfer into its own X
Money account, and sends person-to-person X Money payments to X handles. Its X
Money payouts have been paused since 27 September 2026, and its terms now say
the fees in its treasury belong to UsePaid. We do not copy that money path.

**What is built now (on chain, switched off):**

* The founder's 0.25% collects in the coin's own founder vault. It always
  belongs to the founder: it never expires and is never swept. The flip side:
  you cannot replace a founder (decision D9), so a founder who loses their
  key loses the 0.25% for good, unless they had opted in to dollar payouts.
* The founder can claim it to their own wallet at any time, whatever else is
  switched on or off (`buildFounderClaim`).
* The founder can opt in to dollar payouts (`buildOptIn`): they sign, they can
  withdraw at any time (`buildRevokeOptIn`), and every step is recorded on
  chain. Only a scrambled reference (a hash of the payout partner's customer
  id) goes on chain; never a name, an X handle or a bank number.
* Once opted in, Vicinity's payout key can move that founder's vault, at most
  once a day, **only** into the one payout wallet fixed in the settings and
  agreed by the founder when they signed. If you ever change the payout
  wallet, every opt-in stops until the founder signs again; nothing is ever
  redirected. The payout key cannot touch anything else.
* `planPayouts` shows the payout service which founders can be paid now and
  why the others wait.

**The dollar leg (off chain; not built).** Once switched on, once a day the
payout service would: call the payout for each opted-in founder; swap the SOL
to USDC through Jupiter; send the USDC to a licensed off-ramp partner, which
pays US dollars by bank transfer (1 to 3 business days) into the founder's X
Money account (every X Money account has US account and routing numbers). It
publishes a ledger of every payout. If the partner fails, the money goes back
to the founder's own wallet.

**What you must set up first (decision D14):**

* **Company and lawyer.** Taking crypto in and paying dollars out for others
  is generally money transmission under US rules (FinCEN guidance
  FIN-2019-G001): registration and state licences, unless a licensed partner
  carries it. Your home country may add its own rules. Get a written opinion.
* **Partner.** Bridge (owned by Stripe) is the strongest candidate: it turns
  Solana USDC into US-dollar bank transfers (minimum $1, daily batches) and
  reports each step. Bridge must verify your business (KYB) and each founder
  (KYC). It does not serve New York residents and limits Texas. Its prices are
  not published. Coinbase, MoonPay, Transak and Ramp are alternatives not yet
  checked.
* **Who qualifies.** Only US residents with an active X Money account (which
  needs X Premium). Founders in New York and Massachusetts are excluded or
  limited (X is not licensed there), and with Bridge's limits founders in New
  York, Massachusetts and Texas may not qualify. Everyone else claims crypto.
* **Keys.** A payout key on a small server (never your admin or dev wallet
  key) and a payout wallet. The program keeps the admin, the payout key and
  the payout wallet three different keys, also when the admin is handed
  over, and refuses the dev wallet as payout key or payout wallet (founders'
  dollars never mix with your fees).
* **Tax.** In this model Vicinity pays US founders, so it will likely need a
  W-9 from each and must file 1099s. Ask an accountant.
* **Meanwhile:** founders claim directly, and the website shows a "cash out to
  X Money" guide: claim, swap to USDC, sell on Coinbase or Kraken, then send
  the dollars to your X Money account and routing numbers.

## 8. What is on devnet

See `LAUNCHPAD-DEVNET.md`, with an explorer link for every address and
transaction.

* **On devnet now (7 Oct 2026):** the test token tVIC standing in for
  $VICINITY, the two Vicinity Meteora configs (priced in SOL and in tVIC,
  every platform fee to your dev wallet) and the Vicinity lookup table. A
  test replays those exact accounts through our program and Meteora's devnet
  programs: launch, trades, fees and graduation all work.
* **Waiting for devnet SOL:** our program itself (rebuilt on 7 October with
  the review fixes), then the demo coins with their Vicinity metadata, the
  trades, coin to coin, graduation, the rewards round and the founder payout.
  The free faucet still refuses the build machine. **Please send 1.5 devnet
  SOL** (free, from https://faucet.solana.com) to
  `9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa`; the rest then takes about
  ten minutes (`LAUNCHPAD-DEVNET.md` section 5).

## 9. What mainnet needs, and what it costs

| step | cost |
|---|---|
| Outside audit of `vicinity_launchpad` (small: about 2,400 lines of Rust, plus about 700 lines of its unit tests) plus a review of the SDK's transaction building | quote from the auditor |
| Program keypairs generated by you on your own machine; verified build; `security.txt` | free |
| Deploy `vicinity_rewards` (if not yet on mainnet) | about 2.57 SOL of rent |
| Deploy `vicinity_launchpad` | about 2.20 SOL of rent (434 KB), plus about 0.01 SOL of fees: about 2.23 SOL in the paying wallet at the peak |
| The Vicinity Meteora config, `init_launchpad`, allow-list | about 0.01 SOL |
| Your dev wallet's referral accounts for SOL and $VICINITY (`setup.mjs referral-accounts`) and the Vicinity lookup table | about 0.008 SOL |
| Before the first approval: the website serves `/coin-meta/…` files and `/brand/vicinity-512.png` (a blocker: the address in each coin can never change), and a lawyer confirms the stock-token country list | development time; legal fees |
| Your dev wallet registers "Vicinity" with Meteora | about 0.002 SOL |
| Squads multisigs: program upgrade authority and launchpad admin (before the first public approval), each city's rewards authority | small |
| Keeper wallet (graduations Meteora's own keepers miss, daily fee runs) | about 0.5 SOL to start; about 0.03 SOL per graduation it runs |
| Jupiter API key | free tier |
| Website work: approve and launch pages, coin pages and metadata files, buy/sell/pay-with panels, rewards claim page, fee signing page | development time |
| Listing requests (section 4) | free (VRFD Express optional) |

Per launch, the founder pays about 0.076 SOL (0.05 SOL launch fee, Metaplex's
0.01 SOL fee and rent).

## 10. OWNER DECISIONS (each has a default, already built)

Decided by the owner on 7 Oct 2026: build on Meteora (D1), coins priced in
SOL (D2), and a 1.25% fee per trade (D3). These are what is built.

| # | question | default | other options |
|---|---|---|---|
| D2 | What do people pay with on the curve? | SOL (**decided 7 Oct 2026**) | an extra config priced in $VICINITY (read design D2 first: a 25M VICINITY target is a raise of about $189 today) |
| D3 | Fee per trade | 1.25%: 0.5% you, 0.25% holders, 0.25% founder, 0.25% Meteora (**decided 7 Oct 2026**) | 1.00% total, with Meteora's cut taken from the three shares |
| D4 | Graduation target | 85 SOL | 20 or 40 SOL for small cities (one config each) |
| D5 | Launch fee | 0.05 SOL | 0 to 0.5 SOL |
| D7 | Liquidity after graduation | locked forever, fees split between you and the city | burned |
| D10 | Holder rewards | holders only (founder gets nothing from the holders' share), a round about every 30 days once 20 holders can get 0.01 SOL | weekly rounds |
| D11 | Anti-sniper fee at launch | none | a decaying launch fee (needs a rule change) |
| D13 | Paying with tokenized stocks | offered only where the issuer allows; a lawyer sets the country list (for now the EEA and Switzerland; never the US, UK, Canada, Australia or sanctioned countries; hidden when unknown) | not offered |
| D14 | Founder paid in dollars to X Money | built and switched off | switch on after section 7 |
| D15 | Keys | upgrade authority and admin on Squads multisigs before public launches | keep the phone wallet (not recommended) |
| D21 | One coin per city, forever | yes | allow a replacement (program change) |
| new | Coin-to-coin swaps between coins priced in different tokens | two transactions (sell, then pay with anything) | none needed while every coin is priced in SOL |
| new | Push airdrops | from your own wallet, signed on a signing page | the `solana-tokens` command with a key file |
| new | Holder snapshot timing | at least 6 balance samples a month at random times; each holder counts with the smaller of their cutoff balance and their average | more samples (fairer, more RPC reads) |
| new | Coins held in multisig vaults | left out of holder rewards unless added by hand | none on chain (a program address cannot be told from a vault) |

The full list (D1 to D21) is in `LAUNCHPAD-DESIGN.md` section 21.

---

# Part 2: auditor notes

## A. Scope

| part | what it is | where |
|---|---|---|
| `vicinity_launchpad` (Anchor 0.31) | launch gate, config allow-list, fee split, pots, founder payouts | `programs/vicinity-launchpad/src` |
| Meteora DBC 0.2.1 and DAMM v2 0.2.4 | the curve, swaps, graduation, the pool (audited by others; called, not changed) | pinned binaries in `scripts/launchpad/fetch-fixtures.sh` |
| `vicinity_rewards` | the Merkle claim distributor (audited separately: `AUDIT.md`) | `programs/vicinity-rewards` |
| the TypeScript SDK | account decoding, quotes, every transaction the website and operators send | `sdk/launchpad/*.mts` (on top of the JavaScript modules `*.mjs`) |
| scripts | setup, keeper, snapshot, platform-fee claims, devnet demo | `scripts/launchpad/` |

## B. Threat model

| actor | can | cannot (enforced by) |
|---|---|---|
| program upgrade authority | replace the program (and with it take what waits in pots and vaults, or change `FEE_RECIPIENT`) | touch curve money or pool liquidity (Meteora holds them). Mitigation: Squads multisig, verified build, `--final` after the audit |
| admin | approve or revoke launches; allow-list Vicinity-shaped configs; set the payout key and wallet; pause launches and payouts | move any token, change the dev wallet, change a coin, its founder or fees, redirect an opted-in founder, create a second coin for a city (instruction set; TH12; invariant 8), allow-list a config that leaves more than 1,000 coins to the dev wallet (rule 13, TB17), or become the payout key or payout wallet through an admin hand-over (TA08). A stolen admin key could approve itself for every city without a coin (hence the multisig before the first approval) |
| payout key | move an opted-in founder's vault to the fixed payout wallet, once a day per coin; pause payouts | resume payouts, pay anywhere else, touch the holders pot (TF05-TF09, TK03) |
| founder | claim; opt in or out; hand the seat to a co-signing key | touch the holders pot or another coin |
| rewards authority (per city) | publish each round's Merkle root, including to itself | touch our pot or vault; change the model after `init_city`. Mitigation: multisig, published snapshots |
| keeper / anyone | harvest, forward (only to a checked Holders-only vault), graduate, send the leftover to the dev wallet, trade | receive anything from these steps (TI04) |
| Jupiter's API (website trust) | return a route | do anything but the asked swap: `checkJupiterBuild` decodes the swap instruction by position (`route_v2` / `shared_accounts_route_v2` only; authority, source, destination and mints, `in_amount`, `quoted_out_amount`, `slippage_bps`, no platform fee) and requires it to match the JSON and the buyer; every helper instruction is allow-listed by opcode and accounts (ATA create of the buyer's own account, a System transfer only to wrap the buyer's own SOL, sync-native and close of the buyer's own WSOL account back to the buyer); no extra signers, no tip; the priority fee is capped at 0.01 SOL (design 9.6; hostile-answer tests in `sdk/launchpad/jupiter.test.mts`); the curve buy then spends exactly `otherAmountThreshold` with the buyer's own `minimum_amount_out` |
| lookup-table authority | add addresses or freeze the table | change what an instruction does: a v0 transaction names its accounts by index into the table, and the wallet shows the resolved accounts; a malicious extension could only make transactions fail or be refused. Mitigation: keep the authority on the ops multisig and freeze the table once stable |
| website / signing page | show a transaction | sign it: the user's or the dev wallet's wallet signs; every builder returns unsigned transactions |

## C. Invariants

The program's invariants (design section 15) are asserted after every
successful transaction of every in-process test: per coin, the pot and vault
cover their counters; the 50/50 split (`to_founder = floor(c/2)`); no base
fees; the DBC pool's creator is the Coin PDA; supply exactly 10^15 with no
authorities and immutable metadata; at most one coin per city; and,
from the token instructions that actually ran (including inside CPIs), money
leaves a holders pot only for its founder vault or its checked rewards vault,
and a founder vault only for the founder or the agreed payout wallet.

Client-side properties the SDK tests assert:

* quotes equal the chain to the raw unit: coins out, quote in, new price,
  each fee share and the referral, over random trades (TJ03);
* the slippage bounds the SDK sends are exactly tight: one unit tighter and
  Meteora refuses (TJ03);
* the city share the SDK sums is what Meteora books, and a harvest splits it
  exactly as `splitHarvest` predicts (TJ03/TJ04);
* pay with anything spends exactly Jupiter's guaranteed minimum; the surplus
  stays with the buyer; one-transaction and two-transaction plans end in the
  same state (TJ07);
* a push pays every recipient exactly once, exactly its amount (TK01); the
  payout planner proposes only payouts the program accepts (TK03/TK04); the
  platform-fee planner leaves nothing claimable behind (TK05).

## D. Test map

| suite | command (from `solana/`) | covers |
|---|---|---|
| Rust unit tests | `cargo test` | config rules 7.2, the split, names, URI, headers, the rewards-config reader |
| in-process, program | `npm run test:launchpad` (files 01-11) | TA admin, TB configs, TC launch, TD trading and curve properties, TE fees and rewards, TF founder and payout, TG graduation, TH attack classes, TI keeper |
| in-process, client SDK | `npm run test:launchpad` (files 12-13) | TJ decoders, quote parity, builders, SOL wrapping, coin to coin, pay with anything, sell into anything, graduation builders; TK airdrops, rewards rounds, payout hooks, platform-fee claims |
| same suite on devnet builds | `NETWORK=devnet npm run launchpad:fixtures`, then `LAUNCHPAD_PROGRAMS_DIR=tests-launchpad/fixtures/programs-devnet npm run test:launchpad` | Meteora's devnet binaries differ from mainnet's; the suite passes on both |
| SDK unit tests | `npm run sdk-test:launchpad` | config, curve, keeper and snapshot rules; quote numbers of design 9.5; metadata; Jupiter composition from recorded answers; airdrop batching; payout planning; lookup table |
| types | `npm run typecheck:launchpad` | the TypeScript SDK |
| live, read-only | `npm run test:jupiter-live` | three live Jupiter quotes and one live pay-with plan (no transaction sent) |
| live, read-only, devnet | `npm run test:devnet-accounts` (file 14) | TL: the devnet demo's test token and Vicinity configs, read from devnet and replayed through our program on Meteora's devnet builds: config rules, launch, trades, fees, graduation (no transaction sent) |
| devnet | `scripts/launchpad/deploy-devnet.sh`, then `scripts/launchpad/devnet-demo.mjs` | the whole flow on a public cluster (`LAUNCHPAD-DEVNET.md`; the program deploy waits for devnet SOL) |

## E. Client-side notes for the review

* **Instruction encoding** comes from the IDLs with Anchor's `BorshCoder`;
  `buildIx` refuses a missing argument (Borsh would otherwise encode zero).
* **WSOL handling.** Buys with SOL wrap exactly the amount in (or the maximum
  for exact out) into the trader's WSOL account and close it afterwards; a
  pre-existing WSOL balance is unwrapped too.
* **Referral account.** Swaps pass the dev wallet's quote-token account as
  the referral, and Meteora refuses a swap whose referral account does not
  exist. Every builder prepends an idempotent creation of it (paid by the
  trader only when it is missing), setup creates it, and the keeper recreates
  it (TJ11, TI07).
* **Partial fill.** Every curve buy is sent in DBC's partial-fill mode; below
  the graduation price it is the same trade as exact in (TJ03, TJ05); at the
  end it refunds instead of failing (TJ10). Pay with anything refuses a full or
  graduated curve before the swap, and the second transaction of the
  two-transaction mode is rebuilt from the live pool (`buildBuyAfterSwap`).
* **Payout records.** `FounderPaidOut`, `PayoutOptedIn` and
  `PayoutOptInRevoked` are plain log events, which RPC providers can truncate.
  The payout service must reconcile from `Coin.payout_seq`,
  `Coin.founder_paid_out` and each payout's token transfer, not from logs.
* **Snapshots** are time-weighted (min of the cutoff balance and the average
  of random samples; at least 6 samples per round), read the reward token's
  decimals from its mint, and need an explicit minimum payout for any reward
  token but SOL (design 12.3).
* **Unsigned transactions** (airdrops, platform-fee claims) carry a blockhash
  and must be signed within about a minute; signing pages fetch a fresh
  blockhash before showing them.
* **Keys.** Scripts read key files and never print them; `--send` is needed
  to send, and mainnet needs `--mainnet` as well. The devnet demo refuses
  mainnet outright.
* **Known limits.** See `LAUNCHPAD-AUDIT.md` section 7 (one unit of unlocked
  liquidity, error order, unreachable checks kept on purpose, size), section
  9 (client SDK and devnet) and section 10 (the first code review: what was
  fixed and what was deliberately left as is).
