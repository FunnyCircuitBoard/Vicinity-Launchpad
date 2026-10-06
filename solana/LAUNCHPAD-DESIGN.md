# Vicinity Launchpad: design of `vicinity_launchpad`

Status: built, not deployed (6 Oct 2026). The design was revised after the
design review (changes listed right below), then the program, its SDK and its
in-process tests were built from it on branch `feat/launchpad-program`. The
graduation and holder-rewards paths were then finished (the keeper, the
surplus, the snapshot tooling and their tests; second list below).
`LAUNCHPAD-AUDIT.md` records the build, the test results and the measurements.
The existing program `vicinity_rewards` is not changed by anything here; it
still builds to the same hash and its tests stay green.

Who reads what:

* **The owner**: sections 1, 2, 11, 12, 13 and 21 (the decisions list, in plain English).
  Decisions D2 (what people pay with) and D21 (one coin per city, forever) need you first.
* **Implementers**: everything. When this file and the code disagree, the code is
  wrong or this file must be updated in the same commit.
* **The outside auditor**: sections 3 to 18.

Words used throughout:

* **coin** or **city coin**: the token launched for one city.
* **quote token**: what people pay with on the curve. The default is SOL, held
  as wrapped SOL (WSOL, `So11111111111111111111111111111111111111112`, classic
  SPL, 9 decimals). A second launch config priced in $VICINITY
  (`2aVkhRfAEm44tMhFo8oamWvumGGvweFqnUwukRMBkray`, classic SPL, 6 decimals) can
  be added later; decision D2 lists what that would mean.
* **curve**: the bonding curve. The price rises as people buy and falls as they sell.
* **graduation**: when the curve has raised its target, it closes and all its
  money plus a reserve of coins moves into a normal trading pool.
* **dev wallet**: `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN`, the owner's
  wallet, which receives every platform fee. It is written into the program as
  the constant `FEE_RECIPIENT`; no key can change it without a program upgrade.
* **raw units**: the smallest unit of a token. 1 SOL = 1,000,000,000 lamports.
  1 coin = 1,000,000 raw units. 1 VICINITY = 1,000,000 raw units.
* **DBC**: Meteora's Dynamic Bonding Curve program
  `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, which is audited and has the
  same address on mainnet and devnet.
* **DAMM v2**: Meteora's trading-pool program
  `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`. Graduated coins trade here.
* **Test ids** start with `T` (`TA01`, `TB02` …) so they never clash with the
  decision ids `D1` … `D21` of section 21.

### Changes after the design review (6 Oct 2026)

1. **The default quote token is SOL**, not $VICINITY. A VICINITY config stays
   possible as a second config; D2 lists the facts to weigh first (a VICINITY
   target is a raise of about $189 today).
2. **The dev wallet is a constant in the program** (`FEE_RECIPIENT`).
   `set_fee_recipient`, `Launchpad.fee_recipient` and `FeeRecipientChanged` are
   gone. A stolen admin key can no longer send future platform fees elsewhere.
3. **`forward_holders_fees` checks the city's rewards config** before moving
   money: model Holders, 0% founder share, reward token = the coin's quote
   token, vault = the derived vault. Sections 12.1 and 14 now say plainly that
   the rewards authority decides who receives the holders' money.
4. **Rule 7.2(9) is complete**: after graduation there must be no dynamic fee,
   no market-cap fee scheduler and no compounding fee, so the 2% cap holds.
5. **Mainnet checklist order**: `vicinity_rewards` is deployed before
   `init_launchpad`, which checks that the rewards program exists.
6. **Harvests no longer burn coins.** Fees are paid in the quote token only, so
   nothing ever needs burning. The city's share of DBC's rounding "surplus" at
   completion stays in DBC (a few lamports; section 10, point 5).
7. **Jupiter and "one transaction" claims carry their caveats** (sections 1, 2
   and 9.6).
8. **The metadata URL is keyed by the coin's mint**
   (`https://vicinity.city/coin-meta/<mint>.json`), so nobody can copy it
   before the real coin exists.
9. **`set_payout_config`** also refuses a payout wallet equal to the payout key
   or the admin.
10. **Harvest, forward, claim and payout succeed and do nothing when there is
    nothing to move**, so a keeper can batch many coins in one transaction.
11. **`Launchpad.coin_count` is gone** (it made every launch lock the global
    account; an indexer can count coins).
12. **Smaller fixes**: D11 wording, the letsbonk.fun comparison, the surplus
    contradiction between 9.4 and 11.3, test ids renamed.
13. **New owner decision D21**: one coin per city, forever. D15 now asks for
    the admin multisig before the first public approval.

### Changes while building graduation and holder rewards (6 Oct 2026)

Reality forced two changes; the rest fills in what this file already planned.

1. **The city now collects its share of Meteora's graduation "surplus".**
   This file said that share was "a few lamports" and could stay inside DBC
   for ever. Measured against the real program, it is not a fixed few
   lamports: every trade rounds a fraction of a lamport in the curve's
   favour, so the surplus grows with trading (43 lamports after 240 trades,
   117 to 125 after about 600; about 0.2 lamport per trade). It is still tiny,
   but "nothing owed to the city stays behind" is a requirement, so
   `harvest_curve_fees` now also calls DBC `creator_withdraw_surplus`, once,
   the first time it runs after the curve completes. The money lands in the
   holders pot and is split like a fee. This adds the coin's `dbc_config`
   account to `harvest_curve_fees` (section 6.4 already listed it) and a
   `surplus` field to `FeesHarvested`. Cost: 5,232 bytes of program and one
   more CPI for the auditor (sections 5.4, 6.4, 10.5, 11.1).
2. **Graduation is a single instruction.** In DBC 0.2.1
   `migration_damm_v2_create_metadata` is deprecated and does nothing, so the
   crank sends only `migration_damm_v2`. Vicinity configs have no locked
   vesting (rule 7.2(11)), so completion moves the curve straight to the
   "ready to migrate" stage and there is no `create_locker` step either. There
   is therefore no half-graduated state to get stuck in (section 10.2, test TG11).
3. **The keeper is built**: `scripts/launchpad/crank.mjs` with its logic in
   `sdk/launchpad/keeper.mjs` (section 10.2). It never forwards a coin whose
   rewards config would make `forward_holders_fees` fail; it reports it, so one
   coin cannot break a batch.
4. **Rewards rounds are built**: `initRewardsForCoin` in the SDK (12.1) and
   `scripts/launchpad/snapshot.mjs` with its logic in
   `sdk/launchpad/snapshot.mjs` (12.2, 12.3). Section 12.3 now states the
   exact rules as coded.
5. **Invariant 8 is checked on every transaction of every test** from the
   token instructions that actually ran, including inside CPIs (section 15).

---

## 1. In one page (for the owner)

| You asked for | What gets built |
|---|---|
| "our own launchpad … launching token making it available onchain, and swapping between token" | A small Vicinity program, `vicinity_launchpad`, decides **who** may launch **which** city's coin (one coin per city, ever) and collects the city's share of fees. Under it, the coin, its price curve, buying, selling and graduation into a normal pool run on Meteora's audited bonding-curve code, which our program calls. Coins can be bought and sold on vicinity.city from the first second, and swapped coin to coin in one transaction when both are priced in the same token. Jupiter already routes coins on Meteora curves, with caveats: it drops a curve coin that has not graduated within 30 days, and it re-runs a $500 liquidity test every 30 minutes, so a thin curve can drop out. |
| "show as Vicinity using Vicinity logo and network Solana" | Every coin carries its own name, the city's ticker and a metadata file hosted on vicinity.city that says "Launched on Vicinity", with the Vicinity logo, `createdOn: https://vicinity.city` and network Solana. The metadata can never be changed on chain. The "Vicinity" launchpad label that Jupiter and others show must be requested from them; section 8.4 lists the requests. |
| "paid with tokenized stock like stonk and btc, ethereum and solana" | On the website a buyer picks what to pay with (SOL, USDC, BTC, ETH, tokenized stocks such as xStocks, $STONK, $VICINITY). Jupiter swaps it into SOL and the buy follows in the **same transaction**, signed once, whenever both fit into one Solana transaction (they usually do for SOL-priced coins); otherwise the site sends two transactions, swap then buy. Selling works the other way round. Nobody holds the buyer's money in between. "Stonk" is StonkFun, a launchpad whose coins are priced in tokenized stocks. Tokenized stocks are only ever paid **with**; they never sit inside a curve, because their issuer can freeze or move them. |
| "a way to send the token reward to holders" | The holders' share of every trade collects in a per-coin pot. It moves into the existing `vicinity_rewards` vault, where holders claim their share with the Merkle claim already built and audited. Who receives how much in each round is set by that city's rewards authority from a published snapshot, so that key must be a multisig (section 12.1). A snapshot tool picks the holders (it leaves out pools, your dev wallet and the founder) and says to wait until a round can pay at least 20 holders 0.01 SOL each; a keeper moves the money along daily and graduates coins the moment their curve fills. To send tokens straight to every holder from your own wallet, the standard Solana tool `solana-tokens` does it in batches you sign, with a dry run first. |
| "the X money" (like UsePaid: founder's fees paid in US dollars to X Money) | The founder's 0.25% collects in a per-coin founder vault. The founder can claim it in crypto at any time. They can also **opt in**: they sign on chain, can withdraw at any time, and then a Vicinity payout key can send their fees only to one payout account fixed in the settings, so a payout service can turn them into dollars and send them to the founder's X Money account. X Money has no public API and no business accounts, so the dollar leg needs a licensed off-ramp partner and legal advice. The on-chain part is built now and **switched off** until you set that up (section 13). |
| "fee … should go to my dev wallet" | Every platform fee goes to the dev wallet: 0.5% of every trade, the launch fee, half of the trading-pool fees after graduation, the dust left over at graduation, and a referral share of Meteora's cut on trades made on vicinity.city. The dev wallet's address is written into the program, so no key can redirect it; changing it needs a program upgrade. Before our program accepts any launch settings, it checks on chain that their fee receiver is that wallet. |

**Fees on every buy and sell** (default; you confirmed the three-way split):

| goes to | share of the trade | how |
|---|---|---|
| dev wallet `13qRam…` | 0.50% | Meteora earmarks it for the dev wallet; the dev wallet claims it in batches (section 11.3) |
| that city's holder rewards | 0.25% | our program moves it to the city's holders pot, then into `vicinity_rewards` for claims |
| that city's founder | 0.25% | our program moves it to the city's founder vault; the founder claims it, or opts in to dollar payouts |
| Meteora (protocol) | 0.25% | Meteora's fixed cut: always 20% of the trading fee. On trades made on vicinity.city, a fifth of it (0.05% of the trade) comes back to the dev wallet as a referral fee |
| **total paid by the trader** | **1.25%** | within what LaunchLab platforms charge (1.0% to 1.5% including Raydium's 0.25%; letsbonk.fun is 1.5%); pump.fun charges about 1% |

The alternative is a 1.00% total, where Meteora's 20% comes out of your three
shares (0.40% / 0.20% / 0.20% / 0.20%). See decision D3.

With the default target of 85 SOL, a coin that fills its curve has paid about
1.08 SOL of fees by graduation: about 0.43 SOL to the dev wallet, 0.215 SOL to
its holders, 0.215 SOL to its founder and 0.215 SOL to Meteora (section 9.5).

**Why Meteora underneath instead of our own curve:** our code never holds anyone's
curve money. The curve code has already been audited by three firms. Jupiter
can route the coins from day one, with the caveats above. A safe devnet version
takes about a week instead of 3 to 6 weeks. The cost is Meteora's cut.

**What you need to do now:** top up the devnet test wallet with about 2 SOL
(section 19), and read the decisions in section 21. Every decision has a default,
so building can start without waiting.

---

## 2. The decision: option B (Meteora DBC plus a thin Vicinity program)

Research 2 compared two options:

* **A.** Our own bonding-curve program, which holds every curve's money and migrates to Raydium.
* **B.** A thin Vicinity program on top of Meteora's audited Dynamic Bonding Curve.

**We choose B.**

| question | A: own curve | B: thin program on Meteora DBC (chosen) |
|---|---|---|
| Who holds buyers' money on the curve | our code | Meteora's code (audited by OtterSec, Offside Labs and Zenith; live on mainnet) |
| Size of our audit | custody-level: curve math, rounding, migration CPI | small: approvals, fee splitting, two token accounts per coin |
| Tradable on Jupiter before graduation | no, until Jupiter integrates us case by case (audit plus traction needed) | yes for SOL-priced coins: Jupiter already routes DBC curve coins from SOL, USDC, xStocks and cbBTC. Caveats: curve coins that have not graduated within 30 days are dropped; a $500 liquidity test runs every 30 minutes; a route from VICINITY's own curve into a VICINITY-priced curve coin has never been observed |
| Graduation | our CPI into Raydium CPMM, with pool-pre-creation griefing to defend against | built into DBC and permissionless; only DBC can create the target pool (section 10.4) |
| Time to a safe devnet version | 3 to 6 weeks | about a week (program, in-process tests, devnet demo) |
| Cost | none | Meteora takes 20% of the trading fee, plus 0.2% of the liquidity at graduation |
| Proven here | no | yes: research 2 launched, bought, filled and graduated a DBC coin from an Anchor 0.31 program in litesvm |

**Where B differs from the brief, honestly:**

1. **Pausing buys is a website switch, not an on-chain one.** DBC has no pause
   that a partner can use, and our program holds no curve money, so an on-chain
   buy pause would protect nothing of ours. The on-chain pause stops new
   launches (and payouts, separately). The website reads the same flag and hides
   Buy while paused. Sells and every claim keep working.
2. **The total trade fee is 1.25%, not 1%.** Meteora's 0.25% comes on top of your
   1%; see the table above and decision D3.
3. **The pool's liquidity is locked forever instead of burned.** At graduation the
   liquidity goes into DAMM v2 positions that are permanently locked: nobody,
   including us, can ever withdraw it. Unlike burning, the fees keep flowing:
   50% of them to the dev wallet and 50% to the city (holders and founder).
4. **Graduated coins move to Meteora DAMM v2, not Raydium CPMM.**
5. **Platform fees wait inside Meteora's pools until the dev wallet signs a
   claim.** They are earmarked on chain so that only the dev wallet can ever
   claim them, and a script builds the claims in batches (section 11.3).
6. **A fee change means a new launch config.** Meteora configs cannot be changed.
   New launches use the new config, and each existing coin keeps the fees it
   launched with. The brief asked for exactly this ("frozen per coin").
7. **Anyone can create a coin directly under the Vicinity config by going around
   our program.** Meteora configs have no allow-list of creators. Such coins never
   get a Vicinity `Coin` record, so our program and the website ignore them, and
   their platform fees still go to the dev wallet. The on-chain `Coin` registry
   is the only source of truth for "this is a Vicinity coin".
8. **The dev wallet is fixed in the program.** It is a constant, not a
   setting, so a stolen admin key cannot redirect platform fees. Changing it
   needs a program upgrade, which sits with the upgrade multisig.

---

## 3. What `vicinity_launchpad` does and does not do

It does:

* **Keep the launch gate.** The admin approves one founder per city on chain.
  Only that founder can launch, and only once: each city id gets exactly one
  coin, forever.
* **Accept only launch settings shaped the Vicinity way.** Before a Meteora
  config can be used, the program reads it on chain and checks that:
  * every platform fee goes to the dev wallet (the program constant `FEE_RECIPIENT`);
  * the coin's metadata is immutable;
  * the supply is 1,000,000,000 coins at 6 decimals;
  * the pool's liquidity is locked forever;
  * the quote token is plain SPL with no freeze or mint authority;
  * the fee is within its cap, and after graduation the pool keeps a flat fee
    in the quote token, with no extra dynamic or compounding fee.

  It checks the same things again at every launch.
* **Create each coin** through DBC by CPI, with the coin's own program address as
  the pool "creator". That makes the creator half of the trading fee belong to
  the city.
* **Split the city's fees.** It collects the creator half of the trading fees,
  both from the curve and, after graduation, from the trading pool. It splits
  that amount 50/50 into the coin's **holders pot** and **founder vault**.
* **Forward the holders pot** to that city's `vicinity_rewards` vault. Anyone
  can trigger this. It first checks that the city's rewards config pays holders
  only (model Holders, 0% founder share) in the coin's quote token.
* **Let the founder claim**, and run the **opt-in payout** (X Money / UsePaid
  style) under strict limits.

It does not:

* hold, price or move any curve money, run swaps, or do the graduation (DBC
  does; graduation is permissionless);
* hold the platform fees (they go from DBC straight to the dev wallet);
* mint, burn or freeze coins, or change metadata;
* have **any** instruction that sends money to the admin. Nothing can move the
  holders pot except toward that city's rewards vault, and nothing can move the
  founder vault except toward that founder or their opted-in payout account;
* talk to X Money, an exchange or a bank. Section 13 covers the off-chain parts.

---

## 4. Money map

```
                         BEFORE GRADUATION (Meteora DBC curve)
 trader pays 1.25% on each buy/sell, always in the quote token (SOL by default, held as WSOL)
   |
   +-- 0.25% Meteora protocol --------------------------------> Meteora
   |      (0.05% of it -> dev wallet's WSOL account when the trade carries the vicinity.city referral)
   +-- 0.50% partner share  -- earmarked in the DBC pool -----> dev wallet 13qRam... (claims by signing)
   +-- 0.50% creator share  -- earmarked in the DBC pool for the creator = Coin PDA
                                   |
                     harvest_curve_fees (anyone may call)
                                   v
                 +-----------------+-----------------+
                 | holders pot (half, odd unit here) | founder vault (half, rounded down)
                 v                                   v
     forward_holders_fees (anyone; checks         claim_founder_fees (founder)   or
     Holders model, 0% founder, quote token)     payout_founder_fees (payout key, only if the
                 v                                founder opted in; only to the fixed payout account)
   vicinity_rewards vault ["vault", city]
                 v
   fund_epoch_from_vault (rewards authority, a multisig) -> Merkle claims by holders

 launch fee (default 0.05 SOL, paid by the founder at launch): 90% dev wallet, 10% Meteora

                         AT GRADUATION (anyone may crank)
 curve completes when the raised quote reaches the target -> DBC creates a DAMM v2 pool at the
 curve's last price with the reserved coins + all raised quote (minus Meteora's 0.2%);
 liquidity 100% permanently locked: about half in a position owned by the dev wallet, about half
 in a position owned by the Coin PDA. Unsold dust (about 9 coins on the default curve) -> dev wallet.
 Rounding surplus (about 0.2 lamport per trade): 40% city (harvest_curve_fees, into the pot),
 40% dev wallet (claims by signing), 20% Meteora.

                         AFTER GRADUATION (DAMM v2 pool, fee 1.25%, fees in the quote token)
 pool fees -> the dev wallet's position (claims by signing) and the Coin PDA's position
 (harvest_pool_fees, anyone) -> holders pot / founder vault, exactly as above
```

---

## 5. Accounts

All sizes include Anchor's 8-byte discriminator. Rent is the rent-exempt
minimum, `(bytes + 128) × 5,080` lamports, at today's mainnet and devnet
parameters. Rent can change (SIMD-0437), so the program never reads lamports
to make a decision.

| account | seeds (program `vicinity_launchpad`) | bytes | rent (lamports) | one per | paid by |
|---|---|---|---|---|---|
| `Launchpad` | `["launchpad"]` | 171 | 1,518,920 | program | deployer, once |
| `LaunchConfig` | `["launch_config", dbc_config]` | 106 | 1,188,720 | allowed Meteora config | admin |
| `Approval` | `["approval", city_id as u64 LE]` | 179 | 1,559,560 | pending approval (closed at launch or revoke) | admin; refunded to it |
| `Coin` | `["coin", city_id as u64 LE]` | 243 | 1,884,680 | city, forever | founder at launch |
| holders pot (SPL token account) | `["holders_pot", coin]` | 165 | 1,488,440 | coin | founder at launch |
| founder vault (SPL token account) | `["founder_vault", coin]` | 165 | 1,488,440 | coin | founder at launch |
| coin's city-coin account (ATA of the `Coin` PDA for the coin mint; DBC and DAMM v2 need it as the base-fee account, but base fees are always 0) | associated token address | 165 | 1,488,440 | coin | first harvester |
| `PayoutOptIn` | `["payout_opt_in", coin]` | 145 | 1,386,840 | coin, while opted in | founder; refunded on revoke |

`city_id` is the site's GeoNames id (`public/data/tickers.json`, 8,030 cities,
ids up to 13,680,586), as a `u64`. Example: New York City is `5128581`, ticker `NYC`.

### 5.1 `Launchpad` (one, global)

| field | type | meaning |
|---|---|---|
| `admin` | Pubkey | approves launches, allow-lists configs, sets the payout key and pauses. Starts as the deployer (devnet) or the dev wallet (mainnet), and moves to a Squads multisig before the first public approval (D15) |
| `pending_admin` | Pubkey | second step of an admin transfer; zero means none |
| `payout_authority` | Pubkey | key allowed to run opted-in founder payouts; zero means payouts are off (the default) |
| `payout_destination` | Pubkey | wallet whose quote-token account receives opted-in payouts; zero means off |
| `rewards_program` | Pubkey | the `vicinity_rewards` program id, set once at init and never changeable (devnet `Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi`) |
| `launches_paused` | bool | blocks `launch` |
| `payouts_paused` | bool | blocks `payout_founder_fees` |
| `bump` | u8 | |

The dev wallet is not stored here: it is the program constant `FEE_RECIPIENT`.
There is no coin counter; an indexer counts `Coin` accounts.

### 5.2 `LaunchConfig` (allow-list entry; one per Meteora DBC config)

| field | type | meaning |
|---|---|---|
| `dbc_config` | Pubkey | the Meteora `PoolConfig` account |
| `quote_mint` | Pubkey | copied from the DBC config (the allow-listed quote token) |
| `migration_quote_threshold` | u64 | raise target F in quote raw units (copied, for display) |
| `trade_fee_numerator` | u64 | DBC fee numerator out of 1,000,000,000 (copied, for display) |
| `pool_creation_fee` | u64 | launch fee in lamports (copied, for display) |
| `enabled` | bool | admin can switch it off for new approvals and launches |
| `added_at` | i64 | |
| `bump` | u8 | |

### 5.3 `Approval` (one per city, while pending)

| field | type | meaning |
|---|---|---|
| `city_id` | u64 | |
| `founder` | Pubkey | the only wallet that may launch this city's coin |
| `dbc_config` | Pubkey | which allowed config (quote token, raise target, fees) the coin must use |
| `rent_payer` | Pubkey | receives this account's rent when it is closed |
| `name` | String, at most 32 bytes | on-chain coin name (Metaplex limit) |
| `symbol` | String, at most 10 bytes, `A-Z0-9` | the city ticker from `tickers.json` |
| `approved_at`, `expires_at` | i64 | at most 30 days apart |
| `bump` | u8 | |

There is no `uri` argument. The program builds the metadata URL itself from
the new coin's mint: `https://vicinity.city/coin-meta/<mint>.json` (about 81
characters; Metaplex allows 200). A typo is impossible, every coin points at
vicinity.city, and the URL cannot be known before the coin exists, so nobody
watching `approve_launch` can create a look-alike coin under our config with
the same name, symbol and URL first (section 8.2).

### 5.4 `Coin` (one per city, permanent; there is no close instruction)

| field | type | meaning |
|---|---|---|
| `city_id` | u64 | |
| `founder` | Pubkey | receives the founder share; changes only by `transfer_founder`, which the founder signs |
| `mint` | Pubkey | the coin mint (created by DBC) |
| `quote_mint` | Pubkey | |
| `dbc_config` | Pubkey | |
| `dbc_pool` | Pubkey | the DBC virtual pool; its `creator` field equals this `Coin` PDA |
| `launched_at` | i64 | |
| `holders_accrued` | u64 | lifetime amount booked into the holders pot by harvests |
| `holders_forwarded` | u64 | lifetime amount moved from the pot to the rewards vault |
| `founder_accrued` | u64 | lifetime amount booked into the founder vault by harvests |
| `founder_claimed` | u64 | lifetime amount claimed by the founder |
| `founder_paid_out` | u64 | lifetime amount sent by opted-in payouts |
| `payout_seq` | u64 | payout counter; never resets, so `(city_id, seq)` is a unique receipt key |
| `last_payout_at` | i64 | for the 24-hour cooldown; kept on `Coin`, so revoking and opting in again cannot reset it |
| `bump`, `holders_pot_bump`, `founder_vault_bump` | u8 | |

The `Coin` PDA signs exactly these CPIs and nothing else:

* the DBC launch;
* DBC `claim_creator_trading_fee` and `creator_withdraw_surplus`, both paying
  into the holders pot (inside `harvest_curve_fees`);
* DAMM v2 `claim_position_fee`;
* SPL transfers out of its two token accounts, to the destinations named in section 6.

It never burns, never transfers its city-coin account and never calls DBC's
`transfer_pool_creator`.

### 5.5 `PayoutOptIn` (one per coin while the founder is opted in)

| field | type | meaning |
|---|---|---|
| `coin` | Pubkey | |
| `founder` | Pubkey | who signed; must still equal `coin.founder` at every payout |
| `agreed_destination` | Pubkey | copy of `launchpad.payout_destination` at signing; every payout must match it **and** the current setting |
| `ref_hash` | [u8; 32] | SHA-256 of the off-chain reference (for example the partner's customer id plus a salt); never a name, X handle or bank number |
| `opted_in_at` | i64 | |
| `bump` | u8 | |

### 5.6 Policy constants (`#[constant]`, in the IDL)

| constant | value | meaning |
|---|---|---|
| `FEE_RECIPIENT` | `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` | the dev wallet; every allowed Meteora config must name it as `fee_claimer` and `leftover_receiver`. Devnet uses the same wallet |
| `COIN_SUPPLY_RAW` | 1,000,000,000,000,000 | 1,000,000,000 coins at 6 decimals |
| `COIN_DECIMALS` | 6 | |
| `MAX_TRADE_FEE_NUMERATOR` | 20,000,000 | 2.00% cap (DBC denominator 1,000,000,000); DBC's own minimum is 0.25% |
| `REQUIRED_CREATOR_FEE_PERCENT` | 50 | creator (city) half / partner (dev wallet) half of the non-Meteora fee |
| `REQUIRED_PARTNER_LOCKED_LP_PERCENT` / `REQUIRED_CREATOR_LOCKED_LP_PERCENT` | 50 / 50 | all liquidity permanently locked at graduation |
| `MAX_MIGRATED_POOL_FEE_BPS` | 200 | 2% cap on the post-graduation pool fee |
| `MAX_POOL_CREATION_FEE_LAMPORTS` | 500,000,000 | 0.5 SOL cap on the launch fee |
| `APPROVAL_MAX_SECS` | 2,592,000 | approvals last at most 30 days |
| `PAYOUT_COOLDOWN_SECS` | 86,400 | at most one opted-in payout per coin per 24 hours |
| `METADATA_URI_PREFIX` | `https://vicinity.city/coin-meta/` | followed by the mint and `.json` |
| `MAX_NAME_LEN` / `MAX_SYMBOL_LEN` | 32 / 10 | bytes |

---

## 6. Instructions

There are 18 instructions. The format for each: who must sign, the accounts
(PDAs are checked by seeds), the arguments, the checks, the effects, the event.
All arithmetic is checked: every add and subtract uses `checked_*`, and
`overflow-checks = true` stays on in the workspace release profile. Every
counter is a u64. No quote mint's supply can approach u64's maximum: $VICINITY
is 10^15 raw units and SOL about 6×10^17 lamports, both below 1.8×10^19. The
only division is the fee split (section 9.4, "Our split").

Token accounts are always classic SPL Token, checked with
`Program<'info, Token>`. External programs are checked by address:

* DBC and DAMM v2, through `declare_program!` types;
* Metaplex `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`;
* the Associated Token program and the System program.

No sysvar account is passed in; the time comes from `Clock::get()`.

### 6.1 Setup and admin

**`init_launchpad()`**

* **Signers:** `payer`, `admin`, `upgrade_authority`.
* **Accounts:** `launchpad` (init), `program_data`, `rewards_program`, `system_program`.
* **Checks:**
  * `program_data` is this program's ProgramData address and its stored upgrade
    authority equals `upgrade_authority`. Parse the 45-byte header by hand
    (`u32` tag = 3, `u64` slot, `u8` = 1, 32-byte authority) rather than with
    Anchor's `ProgramData` type: that codec added about 120 KB to
    `vicinity_rewards` (AUDIT.md limitation 10).
  * `rewards_program` is executable (`InvalidAddress`). It can never be changed
    later, so this catches a typo; it also means `vicinity_rewards` must be
    deployed first (section 20).
* **Effects:** stores `admin` and `rewards_program`, with payouts off and
  nothing paused.
* **Event:** `LaunchpadInitialized`.
* **Errors:** `NotUpgradeAuthority`, `InvalidAddress`.
* **Why:** nobody can race the deployer to the global account, and the admin
  must sign, so it is a live key. This is the same pattern as `vicinity_rewards`.

**`propose_admin(new: Pubkey)` / `accept_admin()`**

* **Signers:** the admin to propose, the proposed key to accept.
* Two steps. Proposing the zero address cancels a pending transfer.
* **Events:** `AdminProposed`, `AdminChanged`.
* **Errors:** `Unauthorized`, `NoPendingAdmin`, `NotPendingAdmin`.

**`set_payout_config(payout_authority: Pubkey, payout_destination: Pubkey)`**

* **Signer:** the admin.
* **Checks:** either both are zero (payouts off), or both are non-zero and:
  * `payout_authority` is neither `admin` nor `FEE_RECIPIENT`;
  * `payout_destination` is neither `payout_authority` nor `admin`, so a stolen
    payout key is never also the wallet that receives the money.
* **Effect:** stores both. Existing opt-ins whose `agreed_destination` differs
  stop working until the founder signs again; they are never redirected.
* **Event:** `PayoutConfigChanged { old_authority, new_authority, old_destination, new_destination }`.
* **Errors:** `PayoutKeyNotSeparate`, `InvalidAddress` (only one of the two is zero).
* **Deliberately not built:** a per-payout maximum and a global daily cap.
  Caps would be in raw units of the quote token, and configs can use different
  quote tokens (SOL now, maybe VICINITY later), so one number would mean very
  different amounts. The 24-hour cooldown per coin, the fixed destination, the
  payout key's own pause and the founder's direct claim bound the damage
  instead, and the payout service enforces dollar caps off chain.

**`set_pause(launches: Option<bool>, payouts: Option<bool>)`**

* **Signer:** the admin or the payout authority.
* The admin may set either flag either way.
* The payout authority may only send `launches = None, payouts = Some(true)`;
  it can pause payouts but not resume them.
* **Event:** `PauseChanged { launches_paused, payouts_paused, by }`.
* **Error:** `Unauthorized`.

**`add_launch_config()`**

* **Signers:** the admin, `payer`.
* **Accounts:** `launchpad`, `dbc_config` (`AccountLoader` of DBC `PoolConfig`:
  the owner must be DBC and the discriminator must match), `quote_mint`
  (`Account<Mint>` of classic SPL Token), `launch_config` (init).
* **Checks:** `dbc_config.quote_mint == quote_mint` (`LaunchConfigMismatch`),
  plus every rule in section 7.2 (`validate_vicinity_config`).
* **Effects:** creates the entry with `enabled = true`.
* **Event:** `LaunchConfigAdded { dbc_config, quote_mint, migration_quote_threshold, trade_fee_numerator, pool_creation_fee }`.

**`set_launch_config_enabled(enabled: bool)`**

* **Signer:** the admin.
* **Event:** `LaunchConfigEnabled { dbc_config, enabled }`.

### 6.2 City gate

**`approve_launch(city_id: u64, founder: Pubkey, name: String, symbol: String, expires_at: i64)`**

* **Signers:** the admin, who is also the payer.
* **Accounts:** `launchpad`, `launch_config` (must be enabled), `approval`
  (init), `coin` (`UncheckedAccount` at `["coin", city_id]`), `system_program`.
* **Checks:**
  * `coin` holds no data and is System-owned (`CoinAlreadyLaunched`). Lamports
    alone are fine: Anchor `init` copes with a pre-funded address.
  * `founder` is not zero.
  * `name` is 1 to 32 bytes with no control characters (`BadName`).
  * `symbol` is 1 to 10 bytes of `A-Z0-9` (`BadSymbol`).
  * `now < expires_at <= now + APPROVAL_MAX_SECS` (`BadExpiry`).
* **Effect:** stores the approval. A second approval for the same city fails at
  `init` until the first is revoked or used.
* **Event:** `LaunchApproved { city_id, founder, dbc_config, name, symbol, expires_at }`.
* **Why the admin must be a multisig before the first public approval:** a
  stolen admin key could approve itself as founder of every city that has no
  coin yet and launch them all. `Coin` accounts are permanent, so those cities
  would be squatted for good (D15, D21).

**`revoke_approval(city_id: u64)`**

* **Signer:** the admin.
* Closes the approval and refunds the rent to `rent_payer`.
* **Event:** `ApprovalRevoked { city_id }`.

How approval is proven: the admin's signature on `approve_launch` creates a
PDA only this program can write, and the founder's signature on `launch`
consumes it. Nobody else can create an approval or launch with someone else's.

### 6.3 Launch

**`launch(city_id: u64)`**

* **Signers:**
  * `founder` (must equal `approval.founder`);
  * `payer` (usually the founder; pays all rent and the launch fee);
  * `base_mint` (a fresh keypair: the new coin's address).
* **Accounts:**
  * `launchpad`;
  * `approval` (closed to `rent_payer`);
  * `rent_payer` (address must equal `approval.rent_payer`);
  * `launch_config` (seeds from `approval.dbc_config`; must be enabled);
  * `coin` (init);
  * `holders_pot` (init, token account: mint `quote_mint`, authority `coin`);
  * `founder_vault` (same);
  * DBC accounts: `dbc_config` (must equal `approval.dbc_config`; `AccountLoader<PoolConfig>`),
    `dbc_pool_authority`, `dbc_pool`, `dbc_base_vault`, `dbc_quote_vault`,
    `mint_metadata`, `metadata_program`, `quote_mint` (must equal the config's),
    `dbc_event_authority`, `dbc_program`;
  * `token_program`, `system_program`.
* **Checks:**
  * `!launchpad.launches_paused` (`LaunchesPaused`);
  * `now <= approval.expires_at` (`ApprovalExpired`);
  * the founder matches (`WrongFounder`);
  * `validate_vicinity_config` runs again on the DBC config, in case a vendor
    upgrade ever made configs mutable.
* **Effects:**
  1. CPI `initialize_virtual_pool_with_spl_token`:
     * `creator` = the `coin` PDA (signed with its seeds), `payer` = `payer`;
     * `params = { name, symbol, uri }`, with `uri` built from
       `METADATA_URI_PREFIX + base58(base_mint) + ".json"`.

     DBC creates the mint (6 decimals, no freeze authority), mints exactly
     1,000,000,000 coins into its base vault, removes the mint authority,
     creates Metaplex metadata with `is_mutable = false` and the update
     authority set to the System program, and charges the launch fee to
     `payer`.
  2. Load the DBC pool and require `creator == coin`, `config == dbc_config`
     and `base_mint == base_mint` (`PoolCreatorMismatch`).
  3. Fill in `Coin`.
* **Event:** `CoinLaunched { city_id, founder, mint, dbc_pool, dbc_config, quote_mint }`.
* **Cost to the founder:** about 0.075 SOL in total:

  | item | SOL |
  |---|---|
  | `Coin` + two token accounts | 0.0049 |
  | DBC pool, vaults, mint, metadata | about 0.011 |
  | Metaplex protocol fee | 0.01 |
  | launch fee | 0.05 |
  | network fee | tiny |

  The approval's rent goes back to the admin.
* **Compute:** measured 155,000 to 174,000 CU for the whole instruction
  (LAUNCHPAD-AUDIT.md 5.1). Request 300,000. The site may append the founder's first buy in the same v0
  transaction (with the launchpad lookup table); if that is too large, it sends
  the buy straight after. Because DBC's initialize runs inside our program (a
  CPI), DBC's "first swap at the minimum fee" exemption can never apply to that
  first buy (DBC only grants it when its initialize sits at the top level of the
  transaction). With the default flat fee this changes nothing.

### 6.4 Fees

**`harvest_curve_fees(city_id: u64)`**

* **Signer:** anyone, as `payer`. It is permissionless.
* **Accounts:**
  * `coin`;
  * `dbc_pool` (must equal `coin.dbc_pool`); `dbc_config` (`AccountLoader` of DBC
    `PoolConfig`, must equal `coin.dbc_config`, else `LaunchConfigMismatch`);
  * `dbc_pool_authority`, `dbc_base_vault`, `dbc_quote_vault`;
  * `base_mint` (must equal `coin.mint`); `quote_mint` (must equal `coin.quote_mint`);
  * `coin_base_account` (ATA of the `coin` PDA for `base_mint`; `init_if_needed`, paid by `payer`);
  * `holders_pot`, `founder_vault`;
  * the token, associated-token and system programs;
  * `dbc_event_authority`, `dbc_program`.
* **Effects:**
  1. Read `b0 = holders_pot.amount`.
  2. CPI `claim_creator_trading_fee(max_base = u64::MAX, max_quote = u64::MAX)`,
     with `creator` = `coin` (signed), `token_a_account` = `coin_base_account`
     and `token_b_account` = `holders_pot`.
  3. Reload (`b1`). If the curve is complete (DBC's own test: the pool's
     `quote_reserve >= config.migration_quote_threshold`) and DBC has not yet
     paid the creator's surplus (`is_creator_withdraw_surplus == 0`), CPI
     `creator_withdraw_surplus` with `creator` = `coin` (signed) and
     `token_quote_account` = `holders_pot`, and reload. DBC pays it at most
     once (its flag), so this happens on exactly one harvest per coin, before
     or after graduation (section 10.5).
  4. `c = holders_pot.amount - b0` and `surplus = holders_pot.amount - b1`. If
     `c == 0`, stop here: nothing moves, no event, and the instruction still
     succeeds (so one keeper transaction can harvest many coins).
  5. `to_founder = c / 2` (rounded down) and `to_holders = c - to_founder`. Move
     `to_founder` from the pot to `founder_vault` (signed by `coin`).
  6. `holders_accrued += to_holders`; `founder_accrued += to_founder`.
* `coin_base_account` only exists because DBC asks for a base-token account. It
  would receive base-token fees, and those are always 0: rule 7.2(4) forces
  every fee into the quote token. Nothing ever moves it.
* **Event:** `FeesHarvested { city_id, source: 0, claimed: c, surplus, to_holders, to_founder }`
  (`claimed` includes `surplus`).
* Money that strangers send into the pot or vault beforehand is not counted in
  `c`; it stays where it is and goes out with the next forward or claim.

**`harvest_pool_fees(city_id: u64)`**: after graduation.

* Same signer and split as `harvest_curve_fees`.
* **Accounts:** `coin`; `damm_pool` (DAMM v2 `Pool`, with `token_a_mint == coin.mint`
  and `token_b_mint == coin.quote_mint`, else `WrongPool`); `position` (DAMM v2
  `Position` with `position.pool == damm_pool`); `position_nft_account`
  (Token-2022 account: owner = `coin` PDA, amount = 1, mint = `position.nft_mint`,
  else `WrongPosition`); `damm_pool_authority`, `token_a_vault`, `token_b_vault`,
  `token_a_mint`, `token_b_mint`; `coin_base_account`; `holders_pot`;
  `founder_vault`; the token programs (SPL for both mints); `damm_event_authority`
  and `damm_program`.
* **Effect:** CPI `claim_position_fee`, with `signer` = `coin`, `token_a_account` =
  `coin_base_account` and `token_b_account` = `holders_pot`. Then the same delta,
  split and event as above, with `source: 1` and `surplus: 0`. (DBC creates the pool with
  "fees in token B only", and token B is the quote token, so no base fee
  appears here either.)
* Only positions owned by the `Coin` PDA can be claimed. If someone sends that
  PDA another position, its quote fees simply go to the same city. That is
  harmless.

**`forward_holders_fees(city_id: u64)`**

* **Signer:** anyone (permissionless).
* **Accounts:**
  * `launchpad`, `coin`, `holders_pot`, `quote_mint`;
  * `rewards_city_config`: `UncheckedAccount`, seeds `["city", coin.mint]` under
    `launchpad.rewards_program`; its owner must be `launchpad.rewards_program`;
  * `rewards_vault`: token account, seeds `["vault", rewards_city_config]` under
    `launchpad.rewards_program`, with `token::mint = quote_mint`,
    `token::authority = rewards_city_config` and `token::token_program = token_program`;
  * `token_program`.
* **Checks** on `rewards_city_config`, read by hand from its bytes
  (`vicinity_rewards` `CityConfig` layout) before any money moves:
  * the first 8 bytes are the Anchor discriminator of `CityConfig`;
  * `city_coin_mint == coin.mint`;
  * `reward_model == Holders` and `founder_bps == 0`;
  * `reward_mint == coin.quote_mint`;
  * `vault == rewards_vault`.

  Any failure is `WrongRewardsConfig`. Why: under the Creator or Split model,
  `fund_epoch_from_vault` pays 25% to 100% of what lands in the vault to
  `config.founder`, and the rewards authority can change that founder with
  `set_founder`. Without the check, a city set up with the wrong model would let
  that authority take the holders' share.
* **Effects:** moves the pot's **whole** balance `a` to `rewards_vault`, signed
  by `coin`; `holders_forwarded += a`. If `a == 0`, nothing happens and the
  instruction still succeeds.
* **Event:** `HoldersFeesForwarded { city_id, amount, rewards_vault }`.
* **Errors:** `WrongRewardsConfig`, `WrongRewardsVault`, or Anchor's seeds, owner
  and mint errors.
* This works while launches or payouts are paused.
* If a city's rewards config fails the checks, its pot simply keeps collecting.
  Rewards configs cannot be closed or changed, so freeing that pot needs a
  program upgrade (section 12.1).

### 6.5 Founder

**`claim_founder_fees(city_id: u64)`**

* **Signer:** `founder`, who must equal `coin.founder` (`WrongFounder`).
* **Accounts:** `coin`, `founder_vault`, `quote_mint`, and `founder_token_account`
  (the founder's ATA for the quote token, `init_if_needed`, paid by the founder).
* **Effects:** moves the vault's whole balance; `founder_claimed += amount`.
  When the vault is empty, nothing happens and the instruction still succeeds.
* **Event:** `FounderFeesClaimed { city_id, founder, amount }`.
* This works while anything is paused and whether or not the founder has opted in.

**`transfer_founder(city_id: u64)`**

* **Signers:** `founder` (must equal `coin.founder`) and `new_founder`. Both sign,
  which proves the new key is live.
* **Effect:** `coin.founder = new_founder`. Money already in the vault goes with
  the seat, so the founder should claim first.
* **Event:** `FounderTransferred { city_id, old, new }`.
* The admin has **no** way to change a founder (decision D9).

### 6.6 Opt-in payouts (X Money / UsePaid style; off by default)

**`opt_in_payout(city_id: u64, expected_destination: Pubkey, ref_hash: [u8; 32])`**

* **Signer:** `founder`, who must equal `coin.founder`.
* **Checks:**
  * `payout_authority` and `payout_destination` are set (`PayoutsNotConfigured`);
  * `expected_destination == launchpad.payout_destination` (`DestinationMismatch`).
    This stops a settings change made while the founder was signing from
    swapping the destination.
* **Effect:** creates `PayoutOptIn`, copying the destination into `agreed_destination`.
* **Event:** `PayoutOptedIn { city_id, founder, destination, ref_hash }`.

**`revoke_payout_opt_in(city_id: u64)`**

* **Signer:** `coin.founder` or `opt_in.founder`.
* Closes the opt-in and refunds the rent to `opt_in.founder`.
* **Event:** `PayoutOptInRevoked { city_id, founder, by }`.
* This always works, paused or not.

**`payout_founder_fees(city_id: u64)`**

* **Signer:** `payout_authority`, which must equal `launchpad.payout_authority`.
* **Accounts:** `launchpad`, `coin`, `opt_in`, `founder_vault`, `quote_mint`,
  `destination_wallet` (address must equal `launchpad.payout_destination`), and
  `destination_token_account` (its ATA for the quote token, `init_if_needed`,
  paid by `payout_authority`).
* **Checks:**
  * `!payouts_paused` (`PayoutsPaused`);
  * `opt_in.founder == coin.founder` (`OptInFounderMismatch`);
  * `opt_in.agreed_destination == launchpad.payout_destination` (`DestinationMismatch`);
  * `now >= coin.last_payout_at + PAYOUT_COOLDOWN_SECS` (`PayoutTooSoon`).
* **Effects:** moves the vault's whole balance; `founder_paid_out += amount`;
  `payout_seq += 1`; `last_payout_at = now`. When the vault is empty, nothing
  happens (no transfer, no sequence number, no cooldown) and the instruction
  still succeeds.
* **Event:** `FounderPaidOut { city_id, founder, destination, amount, seq, ref_hash }`.

---

## 7. The Vicinity launch config (Meteora DBC `PoolConfig`)

### 7.1 Default parameters (mainnet, quote SOL, target 85 SOL)

Anyone can create the config with DBC `create_config`: the config is a fresh
keypair and only the payer signs. `fee_claimer` and `leftover_receiver` do not
sign. `solana/sdk/launchpad/config.mjs` builds the parameters with Meteora's own
curve helper `buildCurve` (npm `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13, the
package our IDLs come from) instead of hand-written curve math, and
`solana/scripts/launchpad/create-dbc-config.mjs` sends it.

| `ConfigParameters` field | value | why |
|---|---|---|
| `quote_mint` (account) | WSOL `So11111111111111111111111111111111111111112` (the same on devnet) | people pay SOL |
| `fee_claimer` / `leftover_receiver` (accounts) | `FEE_RECIPIENT` = `13qRam…` | every platform fee and the leftover dust go to the dev wallet |
| `pool_fees.base_fee` | `cliff_fee_numerator = 12,500,000` (1.25%), `first_factor = 0`, `second_factor = 0`, `third_factor = 0`, `base_fee_mode = 0` | a flat fee, with no anti-sniper schedule |
| `pool_fees.dynamic_fee` | `None` | |
| `collect_fee_mode` | 0 (quote token) | all fees are paid in SOL |
| `migration_option` | 1 (DAMM v2) | DAMM v1 is deprecated in DBC |
| `activation_type` | 1 (timestamp) | trading opens at launch |
| `token_type` / `token_decimal` | 0 (classic SPL) / 6 | |
| `partner_liquidity_percentage` / `creator_liquidity_percentage` | 0 / 0 | no withdrawable LP |
| `partner_permanent_locked_liquidity_percentage` / `creator_permanent_locked_liquidity_percentage` | 50 / 50 | LP locked forever; fees split between the dev wallet and the city |
| `partner_liquidity_vesting_info` / `creator_liquidity_vesting_info` | all zero | |
| `locked_vesting` | all zero | no team allocation |
| `migration_fee_option` | 6 (customizable) | |
| `migrated_pool_fee` | `{ collect_fee_mode: 0, dynamic_fee: 0, pool_fee_bps: 125 }` | after graduation: a 1.25% fee, collected in SOL only |
| `migrated_pool_base_fee_mode` / market-cap scheduler params / `compounding_fee_bps` | 0 / all zero / 0 | flat |
| `token_supply` | `{ pre_migration_token_supply: 10^15, post_migration_token_supply: 10^15 }` | exactly 1,000,000,000 coins, never more |
| `creator_trading_fee_percentage` | 50 | the city's half |
| `token_update_authority` | 1 (immutable) | metadata can never change |
| `migration_fee` | `{ fee_percentage: 0, creator_fee_percentage: 0 }` | no graduation fee (D6) |
| `pool_creation_fee` | 50,000,000 lamports (0.05 SOL; devnet 10,000,000) | the launch fee: 90% to the dev wallet, 10% to Meteora |
| `enable_first_swap_with_min_fee` | false | |
| `migration_quote_threshold` | 85,000,000,000 lamports (85 SOL) | the raise target F (D4) |
| `sqrt_start_price` | 97539716077334678 | `buildCurve`, section 9.2 |
| `curve` | `[{ sqrt_price: 373894382314756693, liquidity: 104662611932995410955326609817160 }, { sqrt_price: 79226673521066979257578248091, liquidity: 3405004168437416685648628 }]` | the first point is the pump.fun-shaped curve up to the graduation price; the second only holds coins above the graduation price, which buys can never reach |

The values DBC computes and stores at `create_config`, read back by the tests
(LAUNCHPAD-AUDIT.md 5.3): `swap_base_amount` = 793,099,988.517386 coins,
`migration_base_threshold` = 206,900,002.375753 coins, `migration_sqrt_price` =
373894382314756693 (equal to `curve[0].sqrt_price`).

Fallback: if test TG01 shows that the customizable migration does not produce a
quote-only pool with a 1.25% fee, switch both the config script and rule 7.2(9)
to fixed option 2 (DAMM v2 config `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp`,
1%) and record the change in this file.

**Optional second config, priced in $VICINITY.** The same parameters with quote
$VICINITY (6 decimals) and a target in VICINITY (table 9.3). It passes every
rule in 7.2. Read decision D2 before adding it.

### 7.2 What `validate_vicinity_config` requires (on chain, at `add_launch_config` and at every `launch`)

This is a pure function over the loaded `PoolConfig`, unit-tested rule by rule.
Each rule has its own error, so tests can name the rule they hit.

1. `fee_claimer == FEE_RECIPIENT` (`ConfigFeeClaimer`) and
   `leftover_receiver == FEE_RECIPIENT` (`ConfigLeftoverReceiver`).
2. The quote mint is owned by the classic SPL Token program, with
   `freeze_authority == None`, `mint_authority == None` and 6 to 9 decimals
   (`QuoteMintNotAllowed`). WSOL and $VICINITY pass. USDC (freeze and mint
   authority), every Token-2022 mint and every xStock fail. A Token-2022 quote
   is therefore impossible, and none of its extensions (permanent delegate,
   pause, transfer hook, transfer fee) can reach a curve.
3. `token_type == 0`, `token_decimal == 6`, `fixed_token_supply_flag == 1`, and
   `pre_migration_token_supply == post_migration_token_supply == COIN_SUPPLY_RAW`
   (`ConfigTokenType`, `ConfigDecimalsOrSupply`).
4. `collect_fee_mode == 0` (`ConfigCollectFeeMode`).
5. The base fee is a fee scheduler (`base_fee_mode` 0 or 1) with
   `first_factor == 0`, `second_factor == 0` and `third_factor == 0` (flat), and
   `cliff_fee_numerator <= MAX_TRADE_FEE_NUMERATOR`; the dynamic fee is not
   initialised (`ConfigFee`).
6. `creator_trading_fee_percentage == 50` (`ConfigFeeSplit`).
7. `token_update_authority == 1` (`ConfigMetadataMutable`).
8. Partner and creator liquidity are 0 / 0 withdrawable, 50 / 50 permanently
   locked and 0 / 0 vesting (`ConfigLiquidityLock`).
9. After graduation the pool keeps a flat fee in the quote token of at most 2%
   (`ConfigMigration`):
   * `migration_option == 1` (DAMM v2) and `migration_fee_option == 6`;
   * `migrated_collect_fee_mode == 0` (DBC's "quote token", which DBC turns
     into DAMM v2's "fees in token B only");
   * `migrated_pool_fee_bps <= 200`;
   * `migrated_dynamic_fee == 0`: DBC's dynamic-fee option would add a
     volatility fee on top of `migrated_pool_fee_bps`;
   * `migrated_pool_base_fee_mode == 0` and all 16 bytes of
     `migrated_pool_base_fee_bytes` are zero: no market-cap fee scheduler;
   * `migrated_compounding_fee_bps == 0`.

   Without the last three, the "2% after graduation" cap would not be true.
10. `migration_fee_percentage == 0` and `creator_migration_fee_percentage == 0`
    (`ConfigMigrationFee`).
11. The locked vesting amounts are all zero (`ConfigVesting`).
12. `pool_creation_fee <= MAX_POOL_CREATION_FEE_LAMPORTS` (`ConfigLaunchFee`).

The raise target and the curve shape are deliberately **not** constrained, so
the owner can choose the target per config. The price and supply mathematics
are DBC's own validation.

---

## 8. The coin and its branding

### 8.1 Token facts (all enforced on chain, by DBC plus rule 7.2(3))

* Classic SPL Token. Total supply exactly 1,000,000,000 coins (raw 10^15) at 6 decimals.
* Mint authority: none, removed by DBC in the launch transaction.
* Freeze authority: none, never set.
* Metaplex metadata with `name` = the founder's coin name (32 bytes at most),
  `symbol` = the city ticker, and
  `uri` = `https://vicinity.city/coin-meta/<mint>.json`. `is_mutable = false`,
  the update authority is the System program, and there are no `creators`.
  RugCheck's "mutable metadata" warning therefore never fires.
* Supply split for the default curve (85 SOL):
  * about 793,100,000 coins can be bought on the curve (filling it in one buy
    gives 793,099,988.517385 coins, section 9.5);
  * about 206,900,000 coins go into the trading pool at graduation (Meteora
    keeps 0.2% of them);
  * the rest, a few coins at most, is leftover that goes to the dev wallet.

### 8.2 Hosted metadata JSON (served later by the site at the URI above)

```json
{
  "name": "New York City Coin",
  "symbol": "NYC",
  "description": "The city coin of New York City. Launched on Vicinity (https://vicinity.city) on Solana.",
  "image": "https://vicinity.city/coin-meta/<mint>.png",
  "external_url": "https://vicinity.city/c/5128581",
  "createdOn": "https://vicinity.city",
  "launchpad": "Vicinity",
  "launchpadLogo": "https://vicinity.city/brand/vicinity-512.png",
  "network": "Solana",
  "city": { "id": 5128581, "name": "New York City", "country": "US", "ticker": "NYC" },
  "showName": true,
  "attributes": [
    { "trait_type": "Launchpad", "value": "Vicinity" },
    { "trait_type": "Network", "value": "Solana" },
    { "trait_type": "City", "value": "New York City" }
  ]
}
```

URL scheme. The site serves all of these later; the launchpad work only fixes
the scheme.

| path | content |
|---|---|
| `https://vicinity.city/coin-meta/<mint>.json` | the JSON above, generated from the city's coin design. `name` and `symbol` must equal the on-chain values for ever. Served **only** for mints that have an on-chain `Coin` record, so a copy made under our config gets no Vicinity metadata |
| `https://vicinity.city/coin-meta/<mint>.png` | the coin's icon, square, at least 512 px: the founder's approved logo if there is one, otherwise the Vicinity logo (D12) |
| `https://vicinity.city/brand/vicinity-512.png` | the Vicinity logo as a PNG on a solid background, rendered from `public/logo.svg` (research 3 made a test render, `lpc-research/logo/vicinity-logo-512.png`). Wallets do not render SVG |
| `https://vicinity.city/c/<city_id>` | the coin page |

These URLs must never break, because the on-chain `uri` can never change. The
JSON itself is hosted by Vicinity and could be edited. Vicinity's public
commitment, to be written in the docs and terms: name, symbol and city never
change, and the image changes only to fix a broken logo.

### 8.3 Showing as Vicinity on Meteora and Jupiter

* The dev wallet signs DBC `create_partner_metadata` once, with name
  "Vicinity", website `https://vicinity.city` and logo
  `https://vicinity.city/brand/vicinity-512.png`. It is stored at
  `["partner_metadata", fee_claimer]` (rent about 0.002 SOL).
* Until Meteora names the config for Jupiter, Jupiter shows coins as
  launchpad `met-dbc`. A named label ("Vicinity") is requested through the
  Meteora team (section 8.4). Jupiter keys labels by config, not by on-chain
  names, so coins that strangers create under our config directly would get
  the label too (section 2, point 7). Two things tell real coins apart: the
  on-chain `Coin` registry, and Jupiter's free token verification
  (verified.jup.ag), which should be requested for every real coin.

### 8.4 Listing requests the owner files after the first mainnet launch (decision D17)

* Meteora: Vicinity label for the config(s) on Jupiter. Labels are keyed by
  config address, so every new DBC config (a fee or target change, or a
  VICINITY config) needs its own label request.
* Jupiter: token verification. The free standard route is verified.jup.ag; VRFD
  Express costs 1000 JUP per coin and is optional.
* DEX Screener: Discord request. Coins on a curve do not appear there; graduated
  pools appear under `meteora/DYN2`.
* Birdeye: add a `platform_name`.
* GMGN and Axiom: partnership contact.
* Solscan: publish the IDL on chain, send them the program id, and request a
  label at support@solscan.io.
* CoinGecko, and Blockaid if Phantom ever flags a coin.

Vanity mint addresses ending in `city` are optional (decision D19). They would
be ground off chain, about 11 million tries per key, from a server pool; a
leaked unused key can at worst be pre-empted, never misused.

---

## 9. Curve math and trading

### 9.1 The shape (same as pump.fun and LaunchLab)

This is a constant-product curve with virtual reserves. With supply S = 1,000,000,000,
T = 793,100,000 coins sold on the curve, R = S − T = 206,900,000 coins kept for
the pool, and raise target F:

* virtual coins `x0 = T² / (2T − S)` = 1,073,025,605.595359 (the same for every F);
* virtual quote `y0 = F·(S − T)/(2T − S)` = 0.352941·F;
* every trade keeps `x · y = x0 · y0`, with `x` and `y` the current virtual reserves;
* price = `y / x`. Start price = `y0/x0`. End price = `F/R`, which is exactly
  the price at which the pool opens, so there is no gap for snipers at graduation;
* start market cap = 0.32893·F, end market cap = 4.8333·F, a price rise of 14.69×.

### 9.2 How it maps onto DBC (one liquidity segment)

A concentrated-liquidity segment with constant liquidity L between two prices is
exactly a virtual-reserve constant-product curve. DBC stores square-root prices
as Q64.64 (√price × 2^64) and liquidity scaled by 2^64, both computed on raw
units. For SOL (9 decimals) and a 6-decimal coin, the raw price is the displayed
price × 1000.

`sdk/launchpad/config.mjs` calls Meteora's `buildCurve` with
`percentageSupplyOnMigration = 20.69` (R/S) and `migrationQuoteThreshold = F`.
It returns:

* `sqrt_start_price`, the start of the curve;
* `curve[0]`: one segment from the start price to the graduation price, holding
  the coins sold on the curve: the pump.fun shape of 9.1;
* `curve[1]`: a point at DBC's maximum price whose liquidity only accounts for
  the rest of the fixed supply. Buys stop at the graduation price, so it is
  never traded.

DBC then checks at `create_config` that the coins sold up to the graduation
price, plus the coins the full-range DAMM v2 pool needs, fit in the fixed
supply. For F = 85 SOL the values are in the 7.1 table. The values DBC stores
(`swap_base_amount`, `migration_base_threshold`, `migration_sqrt_price`) are
recorded by test TG01; test TD10 checks that `config.mjs` reproduces the table.

(The first version of this file solved for an "effective supply" by hand with
DBC's rounding. Meteora's helper does the same job and is what Meteora's own
launchpads use, so that hand-written iteration was dropped.)

### 9.3 Raise targets (decision D4). Prices use SOL = $120.83 and $VICINITY = $0.000007577 (Jupiter, 6 Oct 2026)

| target F | start market cap | end market cap | pool opens with |
|---|---|---|---|
| **85 SOL (default, pump.fun size)** | **27.96 SOL ($3,378)** | **410.83 SOL ($49,640)** | **206.5M coins + 84.83 SOL** |
| 40 SOL | 13.16 SOL ($1,590) | 193.33 SOL ($23,360) | 206.5M coins + 39.92 SOL |
| 20 SOL | 6.58 SOL ($795) | 96.67 SOL ($11,680) | 206.5M coins + 19.96 SOL |
| 25,000,000 VICINITY (only with the optional VICINITY config, D2) | 8.22M VIC ($62) | 120.83M VIC ($916) | 206.5M coins + 24.95M VIC |
| 100,000,000 VICINITY (same) | 32.89M VIC ($249) | 483.33M VIC ($3,662) | 206.5M coins + 99.8M VIC |

The "pool opens with" figures are after Meteora's 0.2% migration fee on both
sides. Meteora's keepers migrate mainnet pools whose target meets their
minimum (research 2: 10 SOL, 750 USDC, 1,500 JUP, or about $750), so every SOL
row above is graduated by Meteora as well as by our own keeper; VICINITY rows
are graduated only by our keeper.

### 9.4 Exact rounding (DBC's, applied to every trade; DBC computes in 256-bit integers)

* **Fee:** `fee = ceil(amount × 12,500,000 / 1,000,000,000)`, rounded **up**,
  in the pool's favour.
  * On a **buy** the fee is taken from the quote paid in.
  * On a **sell** it is taken from the quote paid out (collect mode 0).
* **Fee split inside DBC:**
  * `protocol = floor(fee × 20%)`;
  * `referral = floor(protocol × 20%)` when a referral account is passed;
  * `protocol −= referral`;
  * `trading = fee − protocol − referral`;
  * `creator = floor(trading × 50%)`;
  * `partner = trading − creator` (the partner gets the odd unit).
* **Coins out** of a buy and **quote out** of a sell are rounded **down**.
  **Input needed** for an exact-out buy is rounded **up**.
* Buys can never push the price past the graduation price. The quote reserve
  counter, not the vault balance, decides completion, so tokens donated to a
  DBC vault change nothing.
* **Our split:** `to_founder = floor(c / 2)`, `to_holders = c − to_founder`.

### 9.5 Worked examples (default config: F = 85 SOL, curve at its start)

All of these are reproduced to the raw unit by tests TD01–TD04 against the real
DBC program. The numbers come from `sdk/launchpad/curve.mjs`, an exact BigInt
mirror of DBC's swap math.

* **Buy 1 SOL, exact in.** Fee 0.0125 SOL:
  * Meteora 0.002;
  * referral 0.0005 to the dev wallet's WSOL account (on-site trade);
  * dev wallet (partner) 0.005;
  * city (creator) 0.005, which later splits 0.0025 to holders and 0.0025 to the founder.

  The remaining 0.9875 SOL buys **34,193,903.663504 coins**. The average price
  is 2.8879e-8 SOL per coin against a start price of 2.7959e-8, so the price
  impact is 3.3%. With 1% slippage the site sends `minimum_amount_out` =
  33,851,964.626868 coins.
* **Sell those 34,193,903.663504 coins straight back.** Gross out 0.987499999
  SOL, fee 0.01234375 SOL, net **0.975156249 SOL**. The round trip costs 2.48%
  (two fees).
* **Buy exactly 10,000,000 coins (exact out).** It needs 0.282221366 SOL before
  the fee and **0.285793789 SOL** with it. The site sends `maximum_amount_in` =
  that × (1 + slippage).
* **Fill the whole curve** (partial fill). Net 85 SOL plus fees = **86.075949368
  SOL** in total, for 793,099,988.517385 coins.
* **Fee split per 1 SOL of trading volume:** dev wallet 0.005 (+0.0005 referral
  on site trades), holders 0.0025, founder 0.0025, Meteora 0.0025 (−0.0005 referral).
* **All fees up to graduation, per coin** (curve filled in one buy, no
  referral): 1.0759 SOL, of which 0.4304 to the dev wallet, 0.2152 to holders,
  0.2152 to the founder and 0.2152 to Meteora. Trading back and forth before
  graduation adds more.

### 9.6 Trading paths (SDK `solana/sdk/launchpad/client.mjs`; our program is not involved)

The swap modes all use DBC `swap2` with `SwapParameters2 { amount_0, amount_1, swap_mode }`:

| mode | `amount_0` | `amount_1` |
|---|---|---|
| exact in (0) | amount in | minimum out |
| partial fill (1) | amount in | minimum out; fills up to the graduation price and refunds the rest |
| exact out (2) | amount out | maximum in |

* **Buy or sell on the curve.** The SDK uses partial fill whenever a quoted buy
  would reach the graduation price. Zero amounts are refused (`AmountIsZero`),
  and so are slippage misses (`ExceededSlippage`).
* **Referral.** Every swap built by the site passes the dev wallet's ATA for the
  quote token (its WSOL account) as `referral_token_account`, worth 0.05% of
  each trade to the dev wallet.
* **Graduated coin.** The SDK routes through Jupiter (mainnet) or a direct DAMM v2 `swap`.
* **Coin to coin (v1: both coins priced in the same quote token).** One transaction:
  1. sell A, exact in, with `minimum_amount_out = q_min`;
  2. buy B, exact in, with `amount_in = q_min` and `minimum_amount_out = b_min`.

  Any quote above `q_min` stays in the user's quote account. If B's minimum is
  missed, the whole transaction fails and A is untouched (test TD06). Jupiter
  returns "No routes found" between two curve coins, which is why this is
  built by hand. If the two coins use different quote tokens, the site sends two
  transactions (sell A; then Jupiter from A's quote to B's quote plus buy B),
  because a DBC sell, a Jupiter route and a DBC buy do not fit in 1,232 bytes.
* **Pay with anything** (mainnet only; Jupiter does not exist on devnet). This
  is website and SDK code only, built after v1; the program only ever sees the
  quote token.
  1. If Jupiter has a direct route from the user's asset into the coin with
     acceptable price impact, use it as is (only while Jupiter lists the curve,
     see section 1).
  2. Otherwise build one v0 transaction:
     * `GET https://api.jup.ag/swap/v2/build`: ExactIn, from the user's asset
       to the coin's quote token, `wrapAndUnwrapSol=true`, `taker` = the user,
       the user's slippage. For SOL-priced coins ask for `maxAccounts=40` (then
       32, then 24). For a VICINITY-priced coin Jupiter routes into VICINITY
       only at `maxAccounts=64` (the saved quotes at 20 and 30 say "No routes
       found"), and any such route plus the DBC buy overflows 1,232 bytes, so
       the SDK asks for 64 and plans two transactions from the start;
     * then DBC `swap2` buying the coin with
       `amount_in = Jupiter's otherAmountThreshold` (the guaranteed minimum) and
       the user's `minimum_amount_out`;
     * then Jupiter's `cleanupInstruction`.
  3. Any amount Jupiter delivers above its guaranteed minimum stays in the
     buyer's wallet: as SOL for a SOL-priced coin (the cleanup unwraps it), but
     **as VICINITY** for a VICINITY-priced coin.
  4. Use the launchpad address lookup table, which holds the static accounts:
     the DBC program, its event and pool authorities, the Vicinity configs, the
     WSOL mint, the token, ATA and system programs, and the dev wallet's
     referral ATA. Drop no-op ATA setup instructions.
  5. Simulate and set the compute limit to 1.2× the simulation.
  6. If the transaction is still over 1,232 bytes, fall back to two
     transactions: swap, then buy.
  7. A Jupiter API key goes in a Worker secret, because keyless access allows
     only 0.5 requests per second.

  Pay-with list on the site: SOL, USDC, USDT, cbBTC, WBTC, ETH (Wormhole),
  xStocks, STONK and $VICINITY. Stock tokens are hidden for visitors from the
  US, UK, Canada and Australia (`request.cf.country`), with a "no shareholder
  rights" note (decision D13).
* **Sell into anything** (the other direction): DBC sell, exact in, into the
  quote token, then Jupiter ExactIn from the quote token into what the seller
  wants (BTC, ETH, a stock token), in one transaction when it fits, else two.
* **MEV.** Slippage bounds are always set. The SDK may add Jito's
  `jitodontfront` account on mainnet; it does not work on devnet.

Caution for the owner, only if you add a VICINITY config: VICINITY's own
liquidity is thin (about $1,800). Paying with SOL, BTC or stocks for a
VICINITY-priced coin routes through VICINITY's LaunchLab pool, where a $1,000
purchase moves VICINITY's price by about 40%. A route from VICINITY's curve into
a VICINITY-priced curve coin has never been observed on Jupiter. Section 21, D2,
covers this.

---

## 10. Graduation

1. **Trigger.** The curve is complete when the pool's `quote_reserve` reaches F.
   This happens exactly when the price reaches the graduation price, because
   buys cannot go past it. From then on DBC refuses swaps (`PoolIsCompleted`)
   until migration.
2. **Crank** (permissionless). Anyone sends one instruction, DBC
   `migration_damm_v2`, with the customizable DAMM v2 config
   `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` as the remaining account,
   two fresh position-NFT keypairs as signers and a 400,000 CU limit (measured
   237,000 to 266,000 CU; 1,109 bytes). The older first step
   `migration_damm_v2_create_metadata` is deprecated in DBC 0.2.1 and does
   nothing, so it is not sent. Graduation is all or nothing: an attempt that
   runs out of compute, or whose payer cannot repay DBC's rent loan, leaves no
   pool and no state change, and anyone can retry (test TG11).

   The cranker pays the DAMM v2 accounts' rent. DBC borrows it from its pool
   authority, which holds 68 SOL on mainnet, and makes the payer repay it:
   0.0325 SOL measured (TG08).

   Meteora's own keepers migrate the default 85 SOL coins (section 9.3).
   Vicinity also runs the **keeper**, `scripts/launchpad/crank.mjs` (logic in
   `sdk/launchpad/keeper.mjs`), from a wallet holding a little SOL, as a backup
   and for any VICINITY-priced config, whose targets Meteora's keepers ignore.
   It reads only coins in our `Coin` registry and, for each:
   * graduates it as soon as its curve is complete (the "minute pass");
   * calls `withdraw_leftover` (creating the dev wallet's coin account first,
     about 0.002 SOL once per coin), which can only pay the dev wallet;
   * calls `harvest_curve_fees` when the city has curve fees or its surplus
     share waiting;
   * daily, calls `harvest_pool_fees` for every DAMM v2 position the `Coin`
     PDA holds, found by owner, so it works whoever ran the graduation and
     with whatever NFT keys (TI03);
   * calls `forward_holders_fees` when the pot has or will have money, but only
     if the city's rewards config passes the same checks the program makes;
     otherwise it reports the coin for a person to fix and never sends it, so
     one coin cannot make a batch fail (TI01);
   * packs these steps, in order, into as few transactions as fit 1,232 bytes
     (ten coins' harvest and forward in seven transactions, TI05).

   It prints a plan unless given `--send`, refuses to send on mainnet without
   `--mainnet`, and never prints its key. `--loop` runs the minute pass every
   minute and the full pass once a day. The keeper wallet only ever signs as
   fee payer (plus the fresh NFT keys of a graduation) and receives nothing
   (TI04); its costs are graduation rent, the dev wallet's coin account and
   network fees.
3. **The pool.**
   * DAMM v2 full range; `token_a` = the coin, `token_b` = SOL (WSOL).
   * It opens at the curve's last price with about 206.5M coins and 84.83 SOL.
     Meteora keeps 0.2% of each side.
   * Fee 1.25%, collected in SOL only. DAMM v2's protocol share comes off
     that; test TG01 records it.
   * Liquidity: half in a permanently locked position whose NFT belongs to the
     dev wallet, and half in a permanently locked position whose NFT belongs to
     the `Coin` PDA. Nobody can ever remove it (test TG02). DBC adds the pool's
     small "dead liquidity" to the first position, which with equal shares is
     the `Coin` PDA's, so the city's position is slightly larger and the fee
     split is close to half, not exactly half; TG02 records both figures.
     DBC rounds the lock down, so the `Coin` PDA's position keeps 1 unit of
     unlocked liquidity (about 10^-32 of the pool); our program has no
     instruction that removes liquidity, so it can never move.
   * Then `withdraw_leftover` (permissionless) sends the unsold dust to the dev wallet.
4. **Anti-griefing.**
   * Our pool is created under a DAMM v2 config whose `pool_creator_authority`
     is DBC's pool authority `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`.
     This was read on mainnet on 6 Oct 2026, and DBC checks it in
     `migrate_damm_v2_initialize_pool.rs`, so nobody else can create or
     pre-create that pool.
   * The only addresses a griefer can predict are the pool and its two token
     vaults. Sending SOL to them in advance (the only thing anyone can do to an
     address they cannot sign for) does not block or change graduation: DAMM
     v2 creates its accounts over pre-funded addresses, and the pool opens
     exactly as without the donation (test TG10). The position accounts derive
     from NFT keys the cranker makes fresh, so nobody can predict them.
   * Someone could open a *different* pool for the same pair before graduation.
     It cannot block or skew ours (test TG06); the site lists only the canonical
     pool.
   * The pool price is set from the curve, not from any balance, so donations
     do nothing.
   * There is no flash-loan or oracle path: the only price is the curve's own.
5. **Rounding surplus.** Every trade rounds in the curve's favour, so a busy
   curve ends a little above its target. DBC keeps that "surplus"
   (`quote_reserve - migration_quote_threshold`): 80% of it is split between
   partner and creator like the trading fee, 20% goes to Meteora, and each side
   can withdraw its share once. Measured: 0 when one buy fills the curve from
   the start, 1 lamport after a few buys, 43 lamports after 240 random trades
   and 117 to 125 after about 600, so about 0.2 lamport per trade. On an
   active coin that is still well under a cent, but it would otherwise be lost
   to the city, so:
   * the city's share is collected by `harvest_curve_fees` (CPI
     `creator_withdraw_surplus` into the holders pot, signed by the `Coin` PDA,
     once; section 6.4). It works before or after graduation (TG09), and
     graduation still works after it;
   * the dev wallet's share is claimed with `partner_withdraw_surplus` (it signs;
     SDK `partnerWithdrawSurplus`, TG14);
   * a stranger cannot take the city's share: DBC accepts only the pool's
     creator, the `Coin` PDA, as signer (TG12).
6. **Nothing is left behind.** After graduation, every claim and the leftover,
   what remains in DBC's vaults is exactly Meteora's own protocol fee, its
   surplus share and its 0.2% migration fee (test TG13). The only amounts our
   side can never move are: the 1 unit of unlocked liquidity in the `Coin`
   PDA's position (about 10^-32 of the pool); anything a stranger donates to
   the `Coin` PDA's city-coin account; and quote tokens donated straight to a
   DBC vault (DBC never counts them). DAMM v2 farming rewards could only be set
   up by the pool's creator (DBC's pool authority, which never does) or
   Meteora's admin, so none accrue to the city's position.

---

## 11. Fees: rates, caps, changes, claims

### 11.1 Every fee and where it lands

| fee | rate (default) | cap enforced on chain | recipient | moved by |
|---|---|---|---|---|
| curve trade fee | 1.25% (flat) | 2.00% (`MAX_TRADE_FEE_NUMERATOR`) | split as below | DBC |
| from it: platform (partner) | 0.50% | the split is fixed: 50/50 creator/partner, rule 7.2(6) | dev wallet | dev wallet signs DBC `claim_trading_fee` |
| from it: city (creator) | 0.50% | | Coin PDA, then 0.25% holders pot and 0.25% founder vault | `harvest_curve_fees` (anyone) |
| from it: Meteora | 0.25% (20% of the fee, set by Meteora) | | Meteora; on site trades 0.05% of the trade comes back as a referral | DBC, at swap time |
| launch fee | 0.05 SOL | 0.5 SOL | 90% dev wallet, 10% Meteora | dev wallet signs `claim_partner_pool_creation_fee` |
| graduation fee | 0 | must be 0 (rule 7.2(10)) | n/a | n/a |
| post-graduation pool fee | 1.25% | 2.00% (rule 7.2(9): flat, no dynamic or compounding fee) | about half to the dev wallet's position, about half to the Coin PDA's position (then split equally between holders and founder), less DAMM v2's protocol share | dev wallet signs DAMM v2 `claim_position_fee`; `harvest_pool_fees` |
| leftover dust | about 9 coins on the default curve | | dev wallet | `withdraw_leftover` (anyone; the keeper does it) |
| rounding surplus at completion | about 0.2 lamport per trade | | 40% dev wallet, 40% city (then holders and founder), 20% Meteora (section 10, point 5) | dev wallet signs `partner_withdraw_surplus`; `harvest_curve_fees` (anyone) for the city |

### 11.2 Changing fees

* DBC configs are immutable. To change a rate for **future** launches, the
  admin creates a new DBC config with `create-dbc-config.mjs`, calls
  `add_launch_config` (validated against the caps, `LaunchConfigAdded` event)
  and disables the old one (`LaunchConfigEnabled`).
* Each coin keeps the fees it launched with, for ever.
* The recipient is the program constant `FEE_RECIPIENT`. Changing it needs a
  program upgrade (the upgrade multisig), and every config is checked against
  it at `add_launch_config` and again at every `launch`.
* Every new config needs its own Jupiter label request (section 8.4).

### 11.3 How the dev wallet collects (it is the only key that can)

`scripts/launchpad/claim-platform-fees.mjs`:

1. Lists every DBC pool under every Vicinity config, plus every DAMM v2 position
   owned by the dev wallet.
2. Builds unsigned transactions in batches of about 4 claims each:
   * `claim_trading_fee` (max = all);
   * `claim_partner_pool_creation_fee`;
   * DAMM v2 `claim_position_fee` for the dev wallet's positions;
   * `partner_withdraw_surplus` for the dev wallet's share of the rounding
     surplus a curve collects (section 10, point 5).

The script itself is not written yet (website and operations work); the SDK
already builds every one of these claims (`claimPartnerTradingFee`,
`claimPartnerPoolCreationFee`, `partnerWithdrawSurplus`, `dammClaimPositionFee`)
and test TG13/TG14 runs them against the real programs.
3. Writes a plan file. Then it either signs with `--keypair <path>`, or emits
   base64 transactions for a signing page that calls Phantom's
   `signAllTransactions`.

It records each signature so that reruns skip finished batches. Fees wait
safely in the pools until claimed. Nobody else can claim them, but whoever holds
the dev wallet's key can, which is a single-key risk (section 14).

---

## 12. Holder rewards

### 12.1 Claims (main path)

The flow, per coin:

1. **Once, right after the launch** (an admin click on the site; the
   `vicinity_rewards` registry admin signs): `vicinity_rewards.init_city` with:
   * `city_coin_mint` = the coin;
   * `reward_mint` = the coin's quote token (WSOL for the default config), which
     is allowed because it is not the coin;
   * model **Holders** (`founder_bps = 0`), so the holders' 0.25% is never split
     with the founder (decision D10);
   * `authority` = the Vicinity ops multisig.

   The SDK helper `initRewardsForCoin` (`sdk/launchpad/client.mjs`) builds
   exactly this. `forward_holders_fees` refuses any other model, founder share, reward token
   or vault (`WrongRewardsConfig`). A rewards config is permanent, so a wrong
   `init_city` strands that city's pot (it keeps collecting, nothing is lost)
   until a program upgrade adds a way out.
2. Daily, by the keeper (10.2) or anyone: `harvest_curve_fees` /
   `harvest_pool_fees`, then `forward_holders_fees`. Coins with nothing to move
   are skipped without failing the batch; a coin whose rewards config is
   missing or wrong is reported and its pot keeps collecting.
3. Per epoch, every 30 days by default: `scripts/launchpad/snapshot.mjs
   --rpc <url> --mint <coin>` (read-only, logic in `sdk/launchpad/snapshot.mjs`)
   applies the 12.3 rules, plans the round and writes the file to publish; then
   the rewards authority signs `fund_epoch_from_vault(root, leaves, slot, hash,
   window)`, which books the vault's surplus into the epoch. Holders claim on the site with the existing
   proof API and `claim`. Unclaimed money carries over, as `vicinity_rewards`
   already does. Fund an epoch only when the vault can pay at least 20 eligible
   holders the minimum payout (0.01 SOL each, so 0.2 SOL); otherwise wait,
   instead of spending epoch rent (about 0.0016 SOL) and fees to send cents.

**Who controls the holders' money, plainly.** Until it is forwarded, it sits in
our pot, and the pot can only move to the city's checked rewards vault. Once it
is in the rewards vault, **it goes wherever the city's rewards authority says**:
that key publishes each epoch's Merkle root, and a root can list any wallet,
including its own (`vicinity_rewards` SECURITY.md 3.1). Therefore:

* the rewards authority must be a Squads multisig, never one person's wallet;
* every snapshot file and its SHA-256 (`snapshot_hash`) must be published, so
  anyone can recompute the root and check that only real holders are in it.

### 12.2 "Send to all holders" (push; promotional, from the admin's own wallet)

Use the standard Solana tool `solana-tokens distribute-spl-tokens` (installed
with Agave 4.3.0) instead of a custom script. It has a dry run and a tracking
database, so a rerun never pays anyone twice.

1. `scripts/launchpad/snapshot.mjs --rpc <url> --mint <coin> --total <raw amount>`
   applies the 12.3 rules and writes `holders-<mint>-<slot>.csv`
   (`recipient,amount`, amounts in whole tokens) next to the round file.
   Amounts are pro rata, rounded down; the dust stays with the sender.
2. `solana-tokens distribute-spl-tokens --input-csv holders-<mint>-<slot>.csv
   --db-path airdrop-<mint>-<slot>.db --from <your token account>
   --owner <keypair> --fee-payer <keypair> --dry-run` prints the totals; run it
   again without `--dry-run` to send.

* Creating a missing token account costs about 0.0015 SOL per holder; the dry
  run shows how many are missing.
* Every transfer comes from the admin's own token account. The rewards vault
  cannot push, because claims need the holder's signature.

### 12.3 Snapshot rules (both paths; published with every file)

As coded in `sdk/launchpad/snapshot.mjs` (`holderBalances`, `planRound`,
`roundFile`, `prepareRound`; tests `sdk/launchpad/snapshot.test.mjs` and TE13):

* Read the coin's `Coin` record (it must be in our registry; the founder and
  the reward token come from there) and every classic SPL token account of the
  coin (`getProgramAccounts`, 165 bytes, mint at offset 0) at one recorded
  slot, and sum the balances by owner.
* Exclude:
  * every owner that is not on the ed25519 curve, i.e. a program address: DBC's
    and DAMM v2's vault authorities, the `Coin` PDA, any pool or vault;
  * the dev wallet `13qRam…` (it is in `OFFICIAL.teamWallets`; pass any other
    team wallet with `--exclude`);
  * the city's founder.
* Circulating supply = the balances of the owners still in. Minimum balance:
  0.01% of that, rounded up.
* The round total defaults to what the rewards vault can pay now: its surplus
  over what open rounds still owe, plus the carry-over. It is split pro rata,
  rounded down. Anyone who would get less than the minimum payout (0.01 SOL)
  is dropped and the rest is split again, until everyone left gets at least
  the minimum. What does not divide stays for the next round.
* A round is worth funding only when at least 20 holders get the minimum
  (0.2 SOL in the vault); otherwise the script says to wait.
* Holders are ordered largest first, then by address, so the same chain state
  always gives the same file and root.
* Time-weighting (the smaller of the balance at the cutoff and the 14-day
  sampled average, as in `src/snapshot.js`) starts once balance sampling covers
  city coins.
* At most 2^22 leaves per epoch.
* Publish the file and its SHA-256, which becomes `snapshot_hash`. The file
  lists the rules, the circulating supply, the minimum balance, every leaf and
  every excluded owner with its reason, so anyone can rebuild the root.

---

## 13. Founder fees and the X Money (UsePaid-style) payout

### 13.1 What UsePaid does, and why we do not copy its money path

UsePaid claims pump.fun creator fees into its own treasury, sells the SOL on
Kraken, moves the dollars by ACH into its own X Money account, and sends
person-to-person X Money payments to X handles. Originally 80% went to the
handle and 20% to buying back $PAID; since 29 Sep it has been 65/10/25.

* X Money has **no public API**, **no business accounts** and **no crypto**. It
  is for US residents only (18+, US phone, ID check).
* Its acceptable-use policy bans "Unauthorized Commercial Use" and lets X freeze
  an account for up to 180 days.
* UsePaid's X Money payouts have been **paused since 27 Sep 2026**, and its
  terms now say the fees in its treasury belong to UsePaid.

Vicinity's rule: **the founder's 0.25% always belongs to the founder.** It
never expires and is never swept.

### 13.2 On chain now (built in v1, switched off)

* Per-coin founder vault (`["founder_vault", coin]`), filled only by harvests.
* `claim_founder_fees`: the founder takes everything, at any time, paused or
  not, opted in or not.
* `opt_in_payout(expected_destination, ref_hash)`:
  * the founder signs;
  * it can be revoked at any time (`revoke_payout_opt_in`, which also returns its rent);
  * events are recorded on chain;
  * no personal data goes on chain, only a hash.
* `payout_founder_fees`. Only the payout key can call it, and only:
  * into the quote-token account (WSOL by default) of the **one payout wallet
    fixed in `Launchpad.payout_destination`**, which must also equal the
    destination the founder agreed to;
  * at most once per 24 hours per coin;
  * when not paused. Pausing: the admin or the payout key can pause; only the
    admin can resume.

  Each payout carries a sequence number for matching off-chain receipts.
* If the admin changes the payout wallet, every existing opt-in **stops**; it is
  never redirected. A founder handover also stops it.
* The payout key must differ from the admin and the dev wallet, and the payout
  wallet must differ from the payout key and the admin.
* Worst case if the payout key is stolen: opted-in founders' balances move early
  into Vicinity's payout wallet, at most once a day per coin. They can never go
  anywhere else.

### 13.3 The off-chain flow once you switch it on

1. The founder chooses "Get paid in dollars to my X Money account" on
   vicinity.city.
   * They complete the payout partner's own identity check, on the partner's
     page.
   * They give the partner their X Money account and routing numbers. Every
     X Money account has US account and routing numbers and accepts ACH.
   * Vicinity stores only the partner's customer id.
2. The founder signs `opt_in_payout` with
   `ref_hash = sha256(partner_customer_id ‖ salt)`.
3. Once a day the payout service:
   * calls `payout_founder_fees` for every opted-in coin above a minimum
     (suggested: $50, like UsePaid). The SOL (as WSOL) lands in Vicinity's
     payout wallet;
   * swaps it to USDC through Jupiter with a slippage limit (SOL/USDC is one of
     the deepest markets on Solana);
   * sends the USDC to the partner, naming the founder's registered bank
     account. The partner sends the dollars by ACH (1 to 3 business days; slow
     over weekends) into the founder's X Money balance.
4. The service publishes a ledger, keyed by `(city_id, seq)`, with the Solscan
   signature, the Jupiter signature, the partner transfer id and the ACH trace
   number.
5. If the partner fails, the service returns the funds to the founder's own
   wallet (`coin.founder`).

### 13.4 What the owner must set up before switching it on (decision D14)

* **Legal.**
  * Choose the operating company and its country.
  * Get a lawyer's opinion: taking crypto in and paying dollars out for others
    is generally money transmission under US rules (FinCEN guidance
    FIN-2019-G001), which means registration and state licences unless a
    licensed partner carries it. The owner's home country may add its own rules.
  * Tax paperwork: in this custodial model Vicinity itself pays US founders, so
    it will likely need a W-9 from each and have to file 1099s. Ask an
    accountant before the first payout.
* **Partner.** Bridge (owned by Stripe) is the strongest candidate:
  * per-customer "liquidation addresses" take Solana USDC in and send dollars
    by bank transfer, with a $1 minimum and daily batches;
  * it reports each step by webhook and gives a bank trace number;
  * Vicinity can add its own developer fee. That fee would go to the dev
    wallet's bank account, not on chain.
  * Bridge needs Vicinity's business verification (KYB) and each founder's KYC.
  * It does not serve New York residents, and Texas is limited.
  * Its prices are not published.

  Coinbase, MoonPay, Transak and Ramp were not checked in detail.
* **Which founders qualify.** US residents with an active X Money account.
  Everyone else claims crypto.
* **Keys and servers.**
  * A payout key on a small server, never the admin or the dev wallet key.
  * The payout wallet, which is where custody risk sits.
  * A Jupiter API key, monitoring, and the public ledger page.
* **Costs and timing.**
  * The SOL-to-USDC swap (small: deep liquidity). If a VICINITY config is ever
    added, its payouts would sell VICINITY through about $1,800 of liquidity.
  * The partner's fees.
  * 1 to 3 business days for ACH.
  * Kraken charges 0.15% if an exchange is used instead.
* **What is impossible today.**
  * Paying through an X Money API: there is none.
  * Sending X Money payments programmatically from a business: no business
    accounts exist, and the acceptable-use policy forbids it.
  * Any crypto inside X Money.
* **What to do meanwhile.** Founders claim directly. The site shows a guide:
  claim, swap to USDC, sell on Coinbase or Kraken, then send the dollars to your
  X Money account and routing numbers.

### 13.5 Later, if coins are quoted in USDC

USDC would need relaxing rule 7.2(2), because USDC has freeze and mint
authorities. Then the payout destination could be each founder's *own*
partner liquidation address, signed by the founder and co-signed by the payout
key. That needs no custody by Vicinity, and only the destination field moves
into the opt-in.

---

## 14. Keys, pause and trust

| key | can | cannot |
|---|---|---|
| **program upgrade authority** (devnet: throwaway deployer; mainnet: owner-generated, then Squads) | replace the program, and with it take whatever sits in holders pots and founder vaults, or change the `FEE_RECIPIENT` constant | touch curve money or pool liquidity (Meteora's programs hold those), or platform fees waiting in DBC |
| **admin** (devnet: deployer; mainnet: `13qRam…`, then Squads **before the first public approval**) | approve or revoke launches; add or enable configs (only Vicinity-shaped ones that pay the fixed dev wallet); set the payout key and wallet (existing opt-ins then stop); pause or resume launches and payouts | move any token, change the dev wallet, change any existing coin, its founder or its fees, redirect an opted-in founder, or create a second coin for a city. **But** a stolen admin key could approve itself as founder of every city that has no coin yet and launch them, permanently (hence the multisig first) |
| **fee recipient** (`13qRam…`, the program constant `FEE_RECIPIENT`) | claim platform fees from every Vicinity DBC pool and its own DAMM v2 positions | anything in our program |
| **rewards city authority** (`vicinity_rewards`, one per city; Vicinity ops, must be a Squads multisig) | publish each epoch's Merkle root, which decides who receives the holders' money in the rewards vault, **including itself**; pause the city's claims | touch our pot or founder vault; change the city's model, founder share or reward token after `init_city` |
| **payout key** (off by default) | move an opted-in founder's vault to the fixed payout wallet, once a day per coin; pause payouts | resume payouts, pay anywhere else, or touch the holders pot |
| **founder** (per coin) | claim the founder vault; opt in or out of payouts; hand the seat to a key that co-signs | touch the holders pot or anything of another coin |
| **keeper wallet** (Vicinity's crank, `scripts/launchpad/crank.mjs`) | exactly what "anyone" can do, on a schedule; it pays fees and rent | receive anything, or sign as anything but fee payer (test TI04) |
| **anyone** | harvest (fees and, once, the city's surplus share), forward (only to a checked Holders-model vault), crank graduation, send the leftover to the dev wallet, trade, and create a coin directly under the Vicinity config (which never becomes a Vicinity `Coin`) | everything else |

**Pause.**

* `launches_paused` stops `launch`. The website also hides Buy and the
  pay-with-anything flows.
* Sells, every harvest, forward, claim, revoke and graduation keep working.
* `payouts_paused` stops only `payout_founder_fees`.
* There is no admin withdrawal of anything, ever (test TH12).

**Remaining trust, stated plainly.**

* Whoever holds our program's upgrade authority could ship new code that takes
  the money waiting in holders pots and founder vaults, or points
  `FEE_RECIPIENT` elsewhere for future configs. The keeper forwards daily and
  founders can claim any time, so that waiting balance stays small.
  Mitigation: a Squads multisig before mainnet launches, a verified build, and
  later `--final`.
* Each city's rewards authority decides, through its Merkle roots, who receives
  the holders' money once it reaches the rewards vault. Mitigation: a Squads
  multisig, and every snapshot file and its hash published so anyone can
  recompute the root (section 12.1).
* Meteora can upgrade DBC and DAMM v2 (mainnet upgrade authority `JADaUV8k…`),
  and that is where curve money and liquidity live. Mitigation:
  * pinned binary hashes in the test fixtures, so a vendor upgrade shows up as
    a failing fixture check and the tests are rerun;
  * re-validating the config at every launch.
* The dev wallet is admin, fee recipient and $VICINITY creator in one phone
  wallet. Move the admin to a Squads multisig before the first public approval
  (D15).

---

## 15. Invariants (asserted after every successful transaction of every test)

`assertInvariants` checks 1 to 7, 9, 10 and 12 from account state;
`assertMoneyFlows` checks 8 from the token instructions that actually ran in
the transaction, at the top level and inside every CPI (both in
`tests-launchpad/helpers.mjs`). Invariant 11 is checked by TG02.

For every `Coin`:

1. `holders_pot.amount >= holders_accrued − holders_forwarded`. (Donations can
   only make the left side larger.)
2. `founder_vault.amount >= founder_accrued − founder_claimed − founder_paid_out`.
3. Over all non-empty harvests, `to_founder = floor(c/2)` and
   `to_holders = c − to_founder`, so
   `founder_accrued <= holders_accrued <= founder_accrued + number_of_non_empty_harvests`.
4. Harvests never move base tokens: `coin_base_account.amount` changes only by
   outside donations (base fees are always 0 under rule 7.2(4)).
5. DBC `pool.creator == coin PDA`, `pool.config == coin.dbc_config` and
   `pool.base_mint == coin.mint`.
6. The coin mint's supply is 10^15 with no mint or freeze authority, and its
   metadata is immutable.
7. At most one `Coin` exists per `city_id`; an `Approval` and a `Coin` never
   exist for the same city at once.
8. Every token movement out of the holders pot goes to the founder vault (inside
   a harvest, exactly `floor(c/2)`) or to the derived rewards vault of a
   rewards config that passed the Holders / 0% founder / quote token / vault
   check. Every movement out of the founder vault goes to `ATA(coin.founder)` or
   to `ATA(launchpad.payout_destination)` when a matching opt-in exists. No
   instruction has the admin, the fee recipient or the payout key as a
   destination (the payout key is only a signer). No approve, set-authority,
   burn, close, freeze or thaw ever touches the pot or the vault. What happens
   after money reaches the rewards vault is decided by the rewards authority's
   Merkle roots (section 14); the tests additionally check that money leaves a
   Holders-only rewards vault only inside a holder's own `claim`, to that
   claim's token account.

For every DBC pool in tests (Meteora's properties, checked so that a vendor
change is caught):

9. `quote_vault.amount == quote_reserve + protocol_quote_fee + partner_quote_fee + creator_quote_fee`,
   plus any donations, minus the surplus shares already paid out (each side
   once, after completion; section 10.5).
10. `base_vault.amount + coins outside the vault == 10^15` before graduation.
11. After graduation, both DAMM v2 positions' liquidity is fully permanently
    locked, and no position can withdraw.

Global:

12. `Launchpad.rewards_program` never changes. Whenever payouts are configured,
    `payout_authority` is neither `admin` nor `FEE_RECIPIENT`, and
    `payout_destination` is neither `payout_authority` nor `admin` (checked at
    the moment they are set).

---

## 16. Events and errors

**Events** (Anchor `emit!`; indexers must also reconcile from account state,
because logs can be cut short):

* `LaunchpadInitialized`, `AdminProposed`, `AdminChanged`
* `PayoutConfigChanged`, `PauseChanged`, `LaunchConfigAdded`, `LaunchConfigEnabled`
* `LaunchApproved`, `ApprovalRevoked`, `CoinLaunched`
* `FeesHarvested`, `HoldersFeesForwarded`, `FounderFeesClaimed`, `FounderTransferred`
* `PayoutOptedIn`, `PayoutOptInRevoked`, `FounderPaidOut`

Fields are as named in section 6. Every event carries `city_id` where there is
one. Instructions that find nothing to move emit nothing.

**Errors** (`LaunchpadError`):

* **Keys:** `Unauthorized`, `NotUpgradeAuthority`, `InvalidAddress`,
  `NoPendingAdmin`, `NotPendingAdmin`.
* **Pause and payout settings:** `LaunchesPaused`, `PayoutsPaused`,
  `PayoutsNotConfigured`, `PayoutKeyNotSeparate`.
* **Launch configs:** `LaunchConfigDisabled`, `LaunchConfigMismatch`.
* **Config rules (section 7.2):** `QuoteMintNotAllowed`, `ConfigFeeClaimer`,
  `ConfigLeftoverReceiver`, `ConfigTokenType`, `ConfigDecimalsOrSupply`,
  `ConfigCollectFeeMode`, `ConfigFee`, `ConfigFeeSplit`,
  `ConfigMetadataMutable`, `ConfigLiquidityLock`, `ConfigMigration`,
  `ConfigMigrationFee`, `ConfigVesting`, `ConfigLaunchFee`.
* **Approvals and launch:** `BadName`, `BadSymbol`, `BadExpiry`,
  `ApprovalExpired`, `CoinAlreadyLaunched`, `WrongFounder`, `PoolCreatorMismatch`.
* **Fees, claims and payouts:** `WrongPool`, `WrongPosition`,
  `WrongRewardsConfig`, `WrongRewardsVault`, `DestinationMismatch`,
  `OptInFounderMismatch`, `PayoutTooSoon`.
* **Arithmetic:** `MathOverflow`.

---

## 17. Test plan

All tests run **in process**, with no validator and no ports:

* Node's `node:test` with npm `litesvm` 1.5 and `@solana/kit` 8, the setup
  research 2 proved (`lpc-research/r2/lsvm/probe-grad.mjs`).
* Instruction data is encoded from the IDLs with `@coral-xyz/anchor`'s
  `BorshCoder`, which makes no network calls.
* Loaded programs:
  * our `vicinity_launchpad.so`, through the upgradeable loader with a test key
    as upgrade authority (so `init_launchpad` is tested for real);
  * the real `vicinity_rewards.so` from `target/deploy`;
  * mainnet dumps of DBC, DAMM v2 and Metaplex, fetched by
    `scripts/launchpad/fetch-fixtures.sh` with `solana program dump -u m` into
    `tests-launchpad/fixtures/programs/` (gitignored). The script checks the pinned SHA-256:

    | dump | SHA-256 |
    |---|---|
    | `dbc.so` | `4c26a8a5da99f8ce932fa0300c46675b527090021fbb74214c9486bedda9f23b` |
    | `damm_v2.so` | `4d5b920baebc090f89b2e8796a3452ed067c9667a143058c96a312f2c1e6848b` |
    | `mpl_token_metadata.so` | `31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011` |

    A mismatch means Meteora upgraded: stop, review their changelog, re-pin.
* Fixture accounts:
  * the customizable DAMM v2 config `A8gMrE…` as JSON;
  * the WSOL mint (litesvm's native mint);
  * a stand-in VICINITY-like quote mint created in the test (6 decimals, classic
    SPL, no mint or freeze authority after minting) for the optional config;
  * the DBC pool authority funded with 2 SOL for flash rent;
  * the clock set to real time.
* The dev wallet `13qRam…` is a program constant, and the tests have no key for
  it. The few steps where it must sign (TE09, TG02 claims) run with litesvm's
  signature check switched off for that one transaction; every other
  transaction is signature-checked.

`assertInvariants` (section 15) runs after every step. File `tests-launchpad/NN-*.test.mjs`:

**01 admin**
- TA01 `init_launchpad` refuses a signer that is not the upgrade authority (`NotUpgradeAuthority`).
- TA02 `init_launchpad` refuses another program's real ProgramData.
- TA03 `init_launchpad` requires the admin's signature, refuses a rewards program that is not executable; a second init fails.
- TA04 propose and accept admin: a stranger cannot accept; zero cancels.
- TA05 the IDL constant `FEE_RECIPIENT` is `13qRam…`, and the IDL has no instruction that changes it (no `set_fee_recipient`) and no withdraw.
- TA06 `set_payout_config` is admin-only; refuses a payout key equal to the admin or the fee recipient, a payout wallet equal to the payout key or the admin, and an authority without a destination.
- TA07 `set_pause`: the admin sets both flags; the payout key can only pause payouts; its attempt to resume is refused; a stranger is refused.

**02 launch configs**: the default config is accepted (TB01). Each of rules
7.2(1) to (12) is broken by exactly one field and refused with its own error:
- TB02 fee claimer;
- TB03 leftover receiver;
- TB04 creator fee percentage ≠ 50;
- TB05 fee above 2%, a non-flat scheduler, or the dynamic fee on;
- TB06 mutable metadata;
- TB07 Token-2022 base;
- TB08 Token-2022 quote mint with a permanent delegate (xStock-like);
- TB09 quote mint with a freeze authority (USDC-like), or with a live mint authority;
- TB10 LP not 50/50 permanently locked;
- TB11 migration fee or locked vesting;
- TB12 supply ≠ 10^15, or not fixed;
- TB13 launch fee above 0.5 SOL;
- TB14 not DAMM v2 customizable with quote-only fees, plus one case each for
  `migrated_dynamic_fee = 1`, `migrated_pool_base_fee_mode ≠ 0`, a non-zero
  byte in `migrated_pool_base_fee_bytes`, and `migrated_compounding_fee_bps ≠ 0`.

Rules that DBC itself refuses at `create_config` are tested on hand-edited
config bytes (a real config account with one field changed), which is exactly
what the on-chain check sees.

Then:
- TB15 type cosplay: a byte-identical config owned by another program, and a DBC pool passed as a config.
- TB16 a disabled config blocks `approve_launch` and `launch`.

**03 city gate and launch**
- TC01 `approve_launch` is admin-only and stores its fields.
- TC02 refuses a bad expiry, a lower-case or over-long symbol, and a 33-byte name.
- TC03 refuses a city that already has a coin.
- TC04 `revoke_approval` closes it and refunds the rent; `launch` afterwards fails.
- TC05 a non-founder launch is refused (`WrongFounder`).
- TC06 a launch after expiry is refused.
- TC07 `launch` is refused while launches are paused; approving still works.
- TC08 a successful launch:
  - the pool creator is the `Coin` PDA;
  - supply 10^15, 6 decimals, mint and freeze authority none;
  - metadata name, symbol and URI (`https://vicinity.city/coin-meta/<mint>.json`)
    exact, `is_mutable = false`, update authority `11111111111111111111111111111111`;
  - pot and vault owned by `Coin`;
  - approval closed, rent back to the admin;
  - the launch fee reached the pool account.
- TC09 a second launch for the same city fails.
- TC10 a launch with a config other than the approval's is refused.
- TC11 a stranger creates a pool directly under the Vicinity config:
  - DBC accepts it;
  - no `Coin` exists;
  - `harvest_curve_fees` for it is impossible (`PoolCreatorMismatch` / seeds);
  - the SDK's `listCoins` leaves it out.

**04 trading** (SDK against the real DBC)
- TD01 an exact-in buy gives the section 9.5 numbers to the unit (34,193,903.663504 coins for 1 SOL).
- TD02 the fee split of that buy (protocol 0.002, referral 0.0005 into the referral ATA, partner 0.005, creator 0.005 SOL) is read from the pool fields.
- TD03 the sell-back gives 0.975156249 SOL.
- TD04 an exact-out buy for 10,000,000 coins costs 0.285793789 SOL; with `maximum_amount_in` too low it is refused (`ExceededSlippage`).
- TD05 a missed minimum out and a zero amount are refused.
- TD06 coin-to-coin in one transaction; when B's minimum is missed, everything reverts and A's balance is unchanged.
- TD07 a partial-fill buy at the end completes the curve exactly at the graduation price; the next swap is refused (`PoolIsCompleted`).
- TD08 invariants 9 and 10 hold after every trade.
- TD09 donating quote tokens to the DBC quote vault changes neither the price nor completion.
- TD10 `config.mjs` (Meteora's `buildCurve`) reproduces the 7.1 parameters and the 9.3 table.
- TD11 property test: random sequences of buys and sells (exact in, exact out,
  partial fill) against the real DBC. After every trade: the `curve.mjs` mirror
  matches DBC to the raw unit; the curve stays solvent (the quote reserve covers
  the curve's integral from the start price, and the coins sold never exceed
  what the curve owes at that price); a buy followed by selling the same coins
  never returns more than was paid; every fee equals `ceil(amount × rate)` and
  splits exactly; every rounding favours the pool against exact rational math.

**05 fees and rewards**
- TE01 `harvest_curve_fees` is permissionless; its split and counters match; it emits its event.
- TE02 a harvest with nothing to claim succeeds and changes nothing (no event).
- TE03 an odd claim of 1,001 units gives founder 500 and holders 501.
- TE04 donations to the pot or vault leave the counters unchanged, and the forward or claim moves the full balance.
- TE05 forward to the derived `vicinity_rewards` vault, then (with the real rewards program, Holders model) `fund_epoch_from_vault` books it, and a holder claims it.
- TE06 forward refuses another city's vault, a fake program's vault, a token
  account with the wrong mint or authority, and a rewards config with model
  Split or Creator, or another reward token (`WrongRewardsConfig`).
- TE07 harvest, forward and claim all work while launches and payouts are paused.
- TE08 coin A cannot claim coin B's DBC fees, and B's pot cannot be passed to A.
- TE09 the dev wallet claims the partner trading fee and 90% of the launch fee; a stranger's claim is refused by DBC.

**06 founder and payout**
- TF01 `claim_founder_fees` works only for the founder, moves the full balance, and emits its event.
- TF02 a claim of zero succeeds and moves nothing.
- TF03 `transfer_founder` needs both signatures; afterwards the old founder is refused and the new one can claim.
- TF04 `opt_in_payout`:
  - refused while payouts are not configured;
  - refused when `expected_destination` differs;
  - stores the copied destination and the hash.
- TF05 a payout:
  - works only for the payout key;
  - pays only the ATA of the destination;
  - moves the full balance;
  - increments `seq` and emits its event.
- TF06 a second payout within 24 hours is refused, including after revoking and opting in again.
- TF07 the admin changes the destination: the old opt-in's payout is refused (`DestinationMismatch`); after the founder opts in again, it works.
- TF08 after a founder handover, the stale opt-in is refused (`OptInFounderMismatch`), and the new founder can close it.
- TF09 while payouts are paused, a payout is refused and the founder's own claim still works.
- TF10 the founder can claim directly while opted in.
- TF11 `revoke_payout_opt_in` closes the opt-in and refunds the rent; no payout works afterwards.

**07 graduation**
- TG01 the crank migrates permissionlessly. The DAMM v2 pool has:
  - `token_a` = the coin and `token_b` = SOL (WSOL);
  - a price equal to the curve's end price within rounding;
  - a 1.25% fee, collected in quote only.

  The stored DBC config values are recorded, and DAMM v2's protocol share is recorded.
- TG02 the dev wallet owns one position NFT and the `Coin` PDA the other; both are permanently locked (at most 1 unit of rounding left unlocked), `remove_liquidity` is refused for both, and each position's liquidity is recorded (the first, the `Coin` PDA's, includes DBC's dead liquidity).
- TG03 supply after migration is still 10^15; `withdraw_leftover` sends the dust to the fee recipient.
- TG04 `harvest_pool_fees` after trades on the pool splits the quote fees; no base fees appear.
- TG05 `harvest_curve_fees` after graduation collects the remaining curve fees.
- TG06 griefing:
  - a stranger creating a pool under `A8gMrE…` for the pair is refused;
  - a stranger's pool for the pair under a public config does not stop our migration.
- TG07 migrating before completion is refused by DBC (`NotPermitToDoThisAction` in 0.2.1).
- TG08 the CU and the rent paid by the cranker are recorded.

**08 attack classes** (Sealevel list, table-driven over every instruction)
- TH01 signer authorization.
- TH02 account data matching (wrong mint, quote, pool, config, vault, position).
- TH03 owner checks.
- TH04 type cosplay (a `Coin` passed as an `Approval`, a `LaunchConfig` or a `PayoutOptIn`).
- TH05 re-initialisation.
- TH06 arbitrary CPI (fake DBC, DAMM v2 or token program ids).
- TH07 duplicate mutable accounts (pot = vault; vault = destination).
- TH08 non-canonical bumps.
- TH09 PDA sharing (one coin's PDA cannot act for another).
- TH10 closed-account revival (a closed approval, a closed opt-in).
- TH11 no sysvar accounts are accepted.
- TH12 no instruction can pay the admin. Two parts:
  - a review table over the IDL: every token transfer our program signs (as
    `coin`) has a destination constrained to the founder vault, the derived
    rewards vault of a checked config, `ATA(coin.founder)` or
    `ATA(launchpad.payout_destination)`; there is no other signed token action;
  - a negative test per instruction with the admin's ATA (and the fee
    recipient's) substituted for each destination, which must be refused.

**09 graduation defences** (added while building graduation)
- TG09 the city's share of the completion surplus reaches the holders pot with
  the first harvest after completion, before graduation (a) or after it (b),
  exactly DBC's `creator` share, once; a curve that ends exactly on target
  has none (c).
- TG10 SOL sent in advance to the pool and both vault addresses does not block
  or change graduation (the pool is identical to an undisturbed one).
- TG11 graduation is atomic: running out of compute, or a payer that cannot
  repay DBC's rent loan, leaves no pool and changes nothing; a retry works.
- TG12 nothing twice: a second graduation, a second leftover, a second surplus;
  a stranger cannot take the city's surplus, point the harvest elsewhere or
  pass another config.
- TG13 after every claim, what is left in DBC's vaults is exactly Meteora's
  protocol fee, surplus share and migration fee; the city's accounts are empty.
- TG14 the dev wallet receives its surplus share and the leftover.

**10 keeper** (`sdk/launchpad/keeper.mjs`, the logic of `scripts/launchpad/crank.mjs`)
- TI01 plans only what is due; a coin with a missing or wrong rewards config is reported, not sent, and forwarded once fixed.
- TI02 a whole life cycle: graduate, leftover, harvest with surplus, forward; nothing on the next pass; pool fees on the daily pass.
- TI03 finds the city's position after a stranger graduated the coin with its own NFT keys.
- TI04 the keeper wallet only signs as fee payer (and fresh NFT keys) and receives nothing.
- TI05 ten coins in seven transactions, each within 1,232 bytes.
- TI06 the RPC code path of the script plans exactly what the test reader plans.

**11 holders pot** (added while building rewards)
- TE10 the per-transaction money check (invariant 8) is live and refuses every forbidden movement fed to it.
- TE11 every token account of a busy world as the destination of a forward, a harvest, a founder claim and a payout: only the designed one works, nothing moves otherwise.
- TE12 every field of the city's rewards config changed one at a time: forward refuses exactly the fields it relies on.
- TE13 end to end: real holders, graduation, harvest, forward, the snapshot (through the script's code path) without pools, vaults, dev wallet or founder, the default 20-holder gate, a funded round, every claim, only dust left.

**Rust unit tests** (`cargo test`):
- `validate_vicinity_config` table (one case per rule, including each 7.2(9) gap);
- `split_fee`, with a property loop over random and edge amounts;
- name and symbol checks;
- the URI builder;
- the ProgramData header parser;
- the `vicinity_rewards` `CityConfig` reader and its checks.

**SDK tests** (`node --test sdk/launchpad/*.test.mjs`):
- `config.mjs` against the 7.1 values;
- `curve.mjs`: properties on its own (fees exact, rounding towards the pool,
  round trips never profit, solvency), and the 9.5 numbers;
- PDA derivations against the program's seeds;
- `keeper.mjs` planning rules on hand-made states;
- `snapshot.mjs` rules: exclusions, minimum balance, pro rata with the minimum
  payout, the 20-holder gate, the round file and the CSV.

Later, with the website work: the pay-with-anything composer with recorded
Jupiter responses (`lpc-research/q*.json`).

**Research 1 risks and where each is answered:**

| risk | answer |
|---|---|
| privileged withdraw (pump.fun, May 2024) | none exists (TH12) |
| stolen admin key (Raydium, 2022) | the admin has no money powers and cannot change the dev wallet; Squads before the first approval (D15) |
| balances instead of counters | TE04, TD09 |
| rounding | DBC's (TD01–TD04, TD11), our split TE03 |
| completion on all tokens sold | TD07 |
| griefable migration | TG06, TG10 (pre-funded addresses), TG11 (atomic, retryable) |
| quote allow-list | TB08, TB09 |
| hostile Token-2022 | TB07–TB09 |
| donations and rent changes | TE04 and TD09; no lamport-based logic anywhere |
| sniping | decision D11 and the founder's first buy in the launch transaction |
| sandwiches | TD05 slippage, optional Jito |
| oracles and flash loans | no oracle; the price comes only from the curve |
| accidental `program close` (OptiFi) | mainnet checklist: never run `solana program close` on mainnet; the program becomes immutable after the audit |

The existing checks stay green and unchanged: `cargo test` and clippy for both
crates, `npm run sdk-test`, `npm run typecheck`, and the `vicinity_rewards`
Anchor suite.

---

## 18. Repository layout, build and size

```
solana/
  Cargo.toml                                  workspace (programs/*), release overflow-checks = true (unchanged)
  Anchor.toml                                 + [programs.localnet/devnet] vicinity_launchpad = "<new id>"
  idls/dynamic_bonding_curve.json             DBC 0.2.1 IDL from npm @meteora-ag/dynamic-bonding-curve-sdk@1.5.13
                                              sha256 beedc8c869bc04865c26349a72a3ba9c773e61f48be2d33093c591a015fe82fd
  idls/cp_amm.json                            DAMM v2 0.2.4 IDL (same package)
                                              sha256 ccbe93966accca0693790fd3a35b06ed4ca3758cd4d8675c31df92703b9a974d
  programs/vicinity-launchpad/
    Cargo.toml                                anchor-lang 0.31.1 (init-if-needed), anchor-spl 0.31.1 (token, associated_token),
                                              bytemuck 1 (derive, min_const_generics) for the zero-copy DBC/DAMM accounts
    src/lib.rs, constants.rs, state.rs, errors.rs, events.rs, validate.rs (7.2), math.rs (split, URI, headers)
    src/instructions/<one file per instruction>.rs
  sdk/launchpad/                              pda.mjs, config.mjs, curve.mjs, client.mjs, keeper.mjs, snapshot.mjs, *.test.mjs
  sdk/idl/vicinity_launchpad.json             committed production IDL (CI diff, like vicinity_rewards)
  scripts/launchpad/                          fetch-fixtures.sh, crank.mjs (the keeper), snapshot.mjs (rewards rounds);
                                              create-dbc-config.mjs, init-launchpad.mjs, devnet-demo.mjs and
                                              claim-platform-fees.mjs with the devnet step
  tests-launchpad/                            NN-*.test.mjs, helpers.mjs (assertInvariants, assertMoneyFlows), fixtures/ (accounts JSON; programs/ gitignored)
  LAUNCHPAD-DESIGN.md (this file), LAUNCHPAD-AUDIT.md (build hashes, CU, rent, devnet record; written by implementers)
```

* `declare_program!(dynamic_bonding_curve)` and `declare_program!(cp_amm)` read
  the IDLs from `solana/idls/`. Research 2 compiled both with Anchor 0.31.2 and
  cargo-build-sbf 4.4.0.
* The program's own keypair is generated with `solana-keygen new --no-bip39-passphrase --silent --outfile <scratch solana-keys>/vicinity_launchpad-program-keypair.json`,
  copied to `target/deploy/vicinity_launchpad-keypair.json` (gitignored) and never printed.
* npm scripts:
  * `test:launchpad` runs `node --test tests-launchpad/`;
  * `sdk-test:launchpad` runs `node --test sdk/launchpad/`;
  * `launchpad:fixtures` runs the dump script;
  * `launchpad:crank` runs the keeper.
* Size: the target was 300 KB or less; the built program is 432,408 bytes
  (427,176 before the surplus collection), 2.20 SOL of rent at `--max-len` =
  size (LAUNCHPAD-AUDIT.md section 3).
  * Built with `opt-level = "z"` for this crate only, `anchor-spl` without
    default features, and no Anchor `ProgramData` type (6.1).
  * `Box` for large account structs keeps the stack frames small.
  * The remaining size is the 18 account structs and Anchor's on-chain IDL
    instructions, which Solscan needs (8.4), so they stay.
* Effort, trimmed for "quick". v1 is: the program (18 instructions), its Rust
  and in-process tests, and the devnet demo, about 4 to 6 focused days.
  The pay-with-anything composer and lookup table, the batch fee-claim signing
  page, the scheduled snapshot job (its tool exists) and the stock-token geo-gating are website work for
  afterwards; none of them can be shown on devnet anyway (no Jupiter there).

---

## 19. Devnet plan

Devnet has the same DBC, DAMM v2 and Metaplex addresses, and the customizable
DAMM v2 config `A8gMrE…` exists there. Jupiter does not exist on devnet, so
pay-with-anything cannot be shown there.

1. **SOL.** The throwaway deployer `9pYCvdmiYXBsBEWVoyrSnEQwPkQpVoSzzcU3ndWG8nVa`
   holds 1.395 SOL. Airdrops from this machine are rate-limited.
   * Need: 2.20 SOL for the program (432 KB) and, during the deploy, a buffer
     of the same size that is refunded afterwards; plus about 0.3 SOL for
     accounts, demo wallets and fees, plus the demo curve's target.
   * **Owner: send about 2 devnet SOL to that address from faucet.solana.com.**
   * The `vicinity_rewards` devnet deployment (2.57 SOL of rent) is the recorded
     audit deployment and is not closed.
2. **Check Meteora's devnet binaries first.** Dump the devnet DBC and DAMM v2
   programs and compare their SHA-256 with the pinned mainnet hashes (17). The
   devnet DBC has a different upgrade authority and deploy slot (503,167,099)
   and may not be 0.2.1. If they differ, run the in-process suite against the
   devnet dumps too before the demo, or stop and report.
3. Build. Record the size and SHA-256 in LAUNCHPAD-AUDIT.md. Check
   `solana rent <size> -u devnet`.
4. Deploy with an explicit buffer keypair created beforehand:

   ```
   solana program deploy target/deploy/vicinity_launchpad.so \
     --program-id <keys>/vicinity_launchpad-program-keypair.json \
     --buffer <keys>/launchpad-buffer-keypair.json \
     -k <keys>/devnet-deployer.json -u devnet --max-len <size> --use-rpc \
     > <keys>/launchpad-deploy.log 2>&1
   ```

   Report only the signature and addresses; never show the log.
5. `create-dbc-config.mjs`:
   * quote WSOL;
   * a demo target of 1 SOL (a devnet wallet cannot fill 85 SOL; our crank
     graduates it, since Meteora's keepers do not run on devnet);
   * fee claimer and leftover receiver = `13qRam…` (the program constant; its
     devnet fees build up and the owner can claim them with his own wallet on
     devnet);
   * launch fee 0.01 SOL.

   Then `init-launchpad.mjs`: admin = deployer, rewards program = `Hm14pFPAB…`.
   Then `add_launch_config`.
6. `devnet-demo.mjs`, using throwaway founder, trader and payout keys from the
   scratch `solana-keys` folder:
   * approve and launch two demo cities (`city_id` 999000001 "Demo City" DEMO,
     and 999000002 "Demo Town" DEMOT; neither is a real GeoNames id);
   * buy, sell, and swap DEMO to DEMOT in one transaction;
   * fill DEMO with a partial-fill buy and crank graduation;
   * trade on the DAMM v2 pool;
   * `harvest_curve_fees` and `harvest_pool_fees`;
   * on the devnet rewards registry, where the deployer is admin, call
     `init_city` with reward mint WSOL and the Holders model;
   * forward, `fund_epoch_from_vault` with a 2-leaf tree, and one holder's claim;
   * `claim_founder_fees`;
   * `set_payout_config` with a throwaway payout key and payout wallet;
     `opt_in_payout`; `payout_founder_fees`; a second payout that is refused
     (24 hours); revoke.
   * Print every address and signature as JSON.
7. Record everything in LAUNCHPAD-AUDIT.md: addresses, signatures, explorer
   links, CU, rent and balances.
8. The upgrade authority stays with the throwaway deployer on devnet.
9. No local ledger is used. If one is ever started, use the ports in the rules
   and delete the ledger afterwards.

---

## 20. Mainnet checklist (the owner, on his own machine; nothing here touches mainnet)

1. **Outside audit** of `vicinity_launchpad`: a small scope, plus a review of
   the config script and the SDK's transaction composition. DBC and DAMM v2
   are already audited. Rerun the tests on freshly dumped binaries first.
2. **Program keypairs** generated by the owner. Update `declare_id!` and
   `Anchor.toml`. Build with `anchor build --verifiable`, record the hash, and
   publish the IDL on chain. Add `security.txt` (`solana-security-txt`).
3. **Deploy `vicinity_rewards` to mainnet first** and run its registry steps
   (README.md "Mainnet deployment"), with the registry admin moving to Squads.
   It must exist before step 5: `init_launchpad` refuses a rewards program
   that is not deployed, and the id it stores can never be changed.
4. **Deploy `vicinity_launchpad`.** Rent is about 2.2 SOL at `--max-len` =
   size (432 KB), plus about 0.01 SOL of fees; the deploy briefly needs the
   same again for its buffer, which is refunded.
5. **Create the Vicinity DBC config** (about 0.006 SOL; any payer), then
   `init_launchpad` (the upgrade authority signs; admin = `13qRam…`; rewards
   program = the **mainnet** `vicinity_rewards` id) and `add_launch_config`.
6. **The dev wallet signs `create_partner_metadata`** once ("Vicinity",
   website, logo; about 0.002 SOL).
7. **Keys.**
   * Upgrade authority to a Squads multisig (suggested 2-of-3) before public
     launches.
   * Admin to Squads with `propose_admin` / `accept_admin` **before the first
     public approval** (D15).
   * Each city's rewards authority is the ops Squads multisig.
   * After the audit and a quiet period, make the program immutable with `--final`.
   * Never run `solana program close` on mainnet.
8. **Fund a keeper wallet** (about 0.5 SOL) for daily harvests and forwards and
   for any graduation Meteora's keepers miss (about 0.03 SOL each, plus about
   0.002 SOL per graduated coin for the dev wallet's coin account), and run
   `scripts/launchpad/crank.mjs --send --loop` with it (section 10.2).
9. **Website** (separate work):
   * "Approve on chain" for founders who have a saved design and no recorded mint;
   * the founder launch wizard;
   * metadata, image and coin pages at the URLs in 8.2, served only for
     registry mints;
   * buy and sell, coin-to-coin and pay-with-anything panels, with the
     referral account;
   * reading `launches_paused`;
   * the program id in `src/chain.js` program labels;
   * curve market data;
   * the rewards snapshot job, proof API and claim UI;
   * the stock-token geo-gate;
   * retiring the old "launch on LaunchLab, then record the mint" path for
     new cities.
10. **Listing requests** (8.4), one Jupiter label request per config.

---

## 21. OWNER DECISIONS (plain English; the default is what gets built)

| # | Question | Default (built) | Your other options |
|---|---|---|---|
| D1 | Build on Meteora's curve, or write our own? | **Meteora's curve plus our small Vicinity program.** Your city coins, your fees, your rules; Meteora's audited code holds the money. | Our own curve: 3 to 6 weeks, a big audit, and invisible to Jupiter until it graduates. |
| D2 | What do people pay with on the curve? | **SOL.** Deep liquidity, Meteora's keepers graduate the coins, paying with BTC, ETH or stocks fits in one transaction, and the X Money payout can sell SOL for dollars easily. | **$VICINITY** as an optional second config (each city's approval picks one config). It creates demand for VICINITY, but weigh these facts first, at today's prices: a 25M VICINITY target is a total raise of about $189, and filling the whole curve costs about $192, so one wallet (or the founder in the launch transaction) can take 79% of a coin's supply for under $200. All fees up to graduation total about $2.40 per coin ($0.96 to you, $0.48 to holders, $0.48 to the founder); the holders' share is far below the 0.01 SOL minimum payout, so no holders' payout round could ever pay anyone. Our own graduation crank costs about 0.03 SOL (about $3.60) per coin, because Meteora's keepers ignore targets under about $750. Jupiter routes into VICINITY only at its largest route size, so paying with BTC, ETH or stocks always needs two transactions, and a route from VICINITY's own curve into a VICINITY-priced coin has never been seen. Jupiter's $500 test trade would fill a $189 curve, so its liquidity test likely fails. The X Money payout would sell VICINITY through about $1,800 of liquidity every day. |
| D3 | Fee per trade | **1.25%: 0.5% you, 0.25% holders, 0.25% founder, 0.25% Meteora.** On trades made on vicinity.city, 0.05% of Meteora's part comes back to you. | 1.00% in total, with Meteora's cut taken from your three shares (0.4/0.2/0.2/0.2). |
| D4 | Graduation target per coin | **85 SOL** (pump.fun size): start market cap about 28 SOL ($3,378), end about 411 SOL ($49,640). | 20 or 40 SOL for small cities (table 9.3), or a VICINITY target if you add that config (D2). Can differ per city by adding configs. |
| D5 | Launch fee | **0.05 SOL per launch**: 0.045 to you, 0.005 to Meteora. It also makes spam launches under our config cost money. | 0, or anything up to 0.5 SOL (the cap in code). |
| D6 | Graduation fee | **None**, so the pool opens at exactly the curve's last price. | A percentage of the raise to you, but it would make the pool smaller. |
| D7 | Liquidity after graduation | **Locked forever**: half of its fees to you, half to the city (holders and founder); pool fee 1.25%. | Burned (no more fees to anyone), or a different pool fee up to 2%. |
| D8 | Who approves launches | **The admin wallet** (your 13qRam… wallet now, a Squads multisig later), clicking "Approve on chain" for the city's active founder. Approvals expire after at most 30 days. | Another ops key as admin. |
| D9 | If a city's founder seat changes on the site | **The founder share stays with the wallet that launched the coin** unless that wallet hands it over itself. You cannot reassign it, so nobody can take a founder's money. | Let the admin reassign future founder fees. This needs a program change and gives the admin a money lever. |
| D10 | Holder rewards | **Holders' 0.25% goes to holders only** (rewards model "Holders"; our program refuses to forward to any other model). An epoch is paid every 30 days by Merkle claim, with the snapshot rules in 12.3, once the pot can pay at least 20 holders 0.01 SOL each. | Monthly or weekly epochs. Splitting with the founder (Split model) would need a program change, because forwarding now requires the Holders model. |
| D11 | Anti-sniper launch fee | **None** (flat 1.25%). The founder can make the first buy in the launch transaction, at the normal fee. | A decaying launch fee (for example 10% falling to 1.25% over 60 seconds); the extra goes to you and the city. Needs a change to our config rules (rule 7.2(5) requires a flat fee). Because our program creates the pool by CPI, DBC's "first swap at the minimum fee" exemption never applies, so with a decaying fee the founder's own first buy would pay the high fee too. |
| D12 | Coin icon and name | **Name = the founder's coin name, symbol = the city ticker.** The icon is the founder's logo, or the Vicinity logo if none. "Launched on Vicinity" with the Vicinity logo appears in the metadata and, after the label requests, on Jupiter and elsewhere. | The Vicinity logo on every coin, or the city name as the coin name. |
| D13 | Paying with tokenized stocks | **Allowed through Jupiter on mainnet; hidden for US, UK, Canada and Australia visitors**, with a "no shareholder rights" note. Get a lawyer's view before advertising it. | Not offered at all. |
| D14 | Founder paid in dollars to X Money | **The on-chain part is built and switched off.** Founders claim crypto, and the site shows a "cash out to X Money" guide. Switch it on after: a lawyer's opinion, a licensed partner (Bridge suggested), a payout key and wallet, and US-only eligibility (section 13.4). | Run it like UsePaid (Kraken, then personal X Money payments). Not recommended: no API, against X Money's rules, and paused for UsePaid since 27 Sep. |
| D15 | Keys | **Upgrade authority to a Squads multisig before public launches; admin to Squads before the first public approval; immutable after the audit.** | Keep the single phone wallet (not recommended: a stolen admin key could approve itself for every city that has no coin yet and launch them, and those cities would be taken for good). |
| D16 | Graduation crank | **A Vicinity keeper wallet with about 0.5 SOL** running `npm run launchpad:crank -- --rpc <url> --keypair <keeper key> --send --loop`: it graduates any coin within a minute of its curve filling (Meteora's keepers usually do it first), sends the leftover to you, and harvests and forwards daily. The wallet can only pay fees; it receives nothing and controls nothing. | Rely on Meteora's keepers and anyone else calling it (it is permissionless). |
| D17 | Labels | **File the requests in 8.4** after the first mainnet launch. | Also Jupiter VRFD Express (1000 JUP per coin). |
| D18 | Old launch path | **Retire "launch on LaunchLab and record the mint" for new cities** once this is live. | Keep both (risk: two coins recorded for one city off chain). |
| D19 | Vanity coin addresses ending in "city" | **Off for v1.** | On: a server grinds key pools. |
| D20 | Coins created around our program under our Meteora config | **Accept.** They cannot be blocked on chain, and their fees still reach you. The site lists only registry coins, serves metadata only for them, and they get Jupiter verification. | None available on Meteora today. |
| D21 | One coin per city, forever? | **Yes.** Each city id gets one coin record that can never be closed or replaced, even if the coin dies or its founder walks away. Nobody can ever launch a second "official" coin for a city. | Allow a replacement (for example after a year without trading, or by a vote). That needs a program change, and it gives whoever controls it the power to retire a live coin. |

---

## 22. Sources and scratch evidence

The research summaries are in the task brief that produced this file (research
reports 1 to 4). The primary sources used here:

* **Meteora DBC source** (HEAD f552f20). In `programs/dynamic-bonding-curve/src`:
  * `constants.rs`: fee constants, the 25% swap buffer, the protocol fee of 20% and referral of 20%;
  * `instructions/partner/create_config/process_create_config.rs`: config validation and the supply check;
  * `state/config.rs`: fee rounding, split, leftover and burn;
  * `params/liquidity_distribution.rs`: migration price;
  * `migration_handler/concentrated_liquidity.rs`: migration base;
  * `instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs`:
    position owners, `pool_creator_authority`, completion checks;
  * `instructions/swap/*.rs`: swap modes, buys capped at the migration price;
  * `instructions/initialize_pool/process_create_token_metadata.rs`: immutable metadata.
* **IDLs and curve helper:** DBC 0.2.1 and DAMM v2 0.2.4 IDLs and `buildCurve`
  from npm `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13` (MIT); local copies in
  `lpc-research/r2/idl/`.
* **Design review** (6 Oct 2026): the changes listed at the top of this file.
* **Mainnet read (6 Oct 2026, read-only):** DAMM v2 config
  `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck`: owner `cpamdp…`, 328 bytes,
  `pool_creator_authority` = `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`,
  `config_type` 1 (dynamic).
* **Repository:** `solana/README.md`, `AUDIT.md`, `SECURITY.md`,
  `NOTES-integration.md`, and `programs/vicinity-rewards/src/{state.rs,constants.rs,instructions/fund_epoch_from_vault.rs}`.
* **Scratch calculations**, in this session's scratch folder `lpc-design/`:
  * `nums.py`: worked examples, start/end prices and market caps (VICINITY);
  * `dbcexact2.py`: the first, hand-written DBC config parameters (superseded
    by `buildCurve`, 9.2). The SOL figures in 7.1 and 9.5 come from
    `sdk/launchpad/curve.mjs` and `config.mjs`.

  Research tools are in `lpc-research/tools/curve.py` and `curve-params.txt`.
