# Security model of `vicinity_rewards`

Plain-English threat model for the owner and the auditor, then the table that
maps each risk the owner listed to the mechanism in the program and the test
that proves it. Test names are the `it(...)` titles in `tests/*.ts` (Anchor
tests against a validator) or `#[test]` names in the Rust sources.

## 1. Who can do what

| key | can | cannot |
|---|---|---|
| **Program upgrade authority** (the deployer; must become a multisig or be removed after the audit) | replace the program with any code (and therefore do anything, including draining vaults); create the registry once | nothing is denied to it while it exists, which is why `README.md` step 6 to 8 move or remove it |
| **Registry admin** (`Registry.admin`, recommended: Squads multisig) | create a city's config and vault, choosing the authority, founder, model and split at creation; hand the admin role on (two-step) | change anything about an existing city; touch money |
| **City authority** (`CityConfig.authority` per city; recommended: multisig) | publish epochs (deposit or vault surplus + Merkle root), pause/unpause, sweep after the deadline, cancel before any claim, change the founder, lock, hand the role on (two-step) | move vault money to itself or anyone except through a published root; change model, split, mints or vault after lock; shorten a claim window; sweep before the (pause-extended) deadline; cancel once anyone has claimed |
| **Funder** (any token account owner, often the authority) | deposit money into an epoch it co-signs with the authority | anything else |
| **Founder** | receive the founder share (passively) | block anything except by making its own token account unusable (see 3.4) |
| **Claimant** (any wallet) | claim exactly the leaf that names it, once per epoch, while the epoch is open; close its claim status after sweep or cancel | claim twice, claim another leaf, claim more than the leaf or than the epoch holds, claim after the deadline |
| **Anyone** | send tokens to the vault (they become distributable through `fund_epoch_from_vault`); read everything | create a config (needs the registry admin), create the registry (needs the upgrade authority), take money out |

Money can leave the vault in exactly two ways, both booked in the totals:
`claim` to the claimant's associated token account, and the founder share of
`fund_epoch_from_vault` to the founder's associated token account. There is no
withdraw, no set_root, no emergency path.

## 2. What the chain guarantees and what it cannot know

Guaranteed on chain: the root of an epoch never changes; every claim is a valid
Merkle proof of `(index, claimant, amount)` against that root, with the
claimant's signature; a wallet claims at most once per epoch; the sum of claims
of an epoch never exceeds its `holders_amount`; the vault never pays more than
it was given for holders; the founder share is exactly `floor(amount * bps / 10000)`
and the remainder goes to holders; model and split are permanent after the
first epoch; pauses never shorten a claim window; all arithmetic is checked.

Not knowable on chain: whether the snapshot behind a root is fair (who was a
holder, with what balance, whether pools, team wallets or Sybil wallets were
excluded, whether the amounts are pro rata). The program makes this
**verifiable instead of trusted**: every Holders/Split epoch must carry a
non-zero `snapshot_hash` (SHA-256 of the published snapshot file) and the
`snapshot_slot`; anyone can download the file, check its hash, recompute the
holders at that slot, rebuild the tree with `sdk/merkle.mjs` and compare the
root. A wrong root can be cancelled by the authority while nobody has claimed
(`cancel_epoch`); after a claim it stands until the deadline and the unclaimed
part is carried over.

## 3. Trust assumptions and their limits

### 3.1 The authority is trusted for the roots of new money, and only that
It can publish a root that pays the wrong people, including itself. It cannot
take back money a published root promised and holders can still claim
(`cancel_epoch` needs zero claims; `sweep_epoch` needs the deadline to have
passed, and pausing does not make the deadline come sooner: the pause time is
added to the deadline, `math::effective_deadline`). What it swept or cancelled
goes to `carry_over`, which is distributed by the next root, which again is
public and checkable. Recommended: Squads multisig, every `fund_epoch*`
transaction reviewed against the snapshot file before signing.

### 3.2 `set_founder` is the one economic lever the authority keeps
Founder seats change under Vicinity's rules, so the authority can redirect all
future founder shares. It cannot touch already paid shares or vault money. The
`FounderChanged` event carries old and new founder. Multisig recommended.

### 3.3 Registry admin and config squatting
Without the registry anyone could create the config for a freshly launched coin
with themselves as authority and founder, and nothing could ever replace it
(PDA addresses are fixed, there is no close). `init_city` therefore requires the
registry admin's signature. The registry itself can only be created by the
program's upgrade authority, so nobody can race the deployer to it. If the
upgrade authority is removed before the registry exists, no city can ever be
configured under that program id: `README.md` makes `init_registry` the first
transaction after deploy.

### 3.4 The founder's token account can block funding
`fund_epoch` and `fund_epoch_from_vault` create or use the founder's associated
token account. A founder can re-own that account (classic SPL Token
`SetAuthority`) or the reward mint's freeze authority (Circle for USDC) can
freeze it; then every funding for that city fails until the authority calls
`set_founder` with a usable wallet. No money is lost; holders are delayed.
Runbook: alert on a failing `fund_epoch`, call `set_founder`, retry. A
structural alternative (accrue the founder share in the config and let the
founder pull it) was not implemented to keep the spec's design.

### 3.5 The reward mint's issuer
A freeze authority can freeze the founder's or a claimant's token account (see
3.4; a frozen claimant simply cannot receive) and could freeze the **vault**
itself, after which no claim can succeed and the program has no remedy. WSOL
has no freeze authority; USDC has. Token-2022 mints are accepted only without
amount-changing or existence-changing extensions (transfer fee, transfer hook,
permanent delegate, non-transferable, confidential transfers, default account
state, mint close authority, or anything unknown to the program: allow-list,
fails closed). PRODUCT DECISION: WSOL avoids the issuer risk; USDC accepts it.

### 3.6 Upgradeability
While the upgrade authority exists, its holder can replace the code and drain
every vault. The deployment steps move it to a multisig and, after the audit,
to none (`--final`). On devnet the throwaway deployer stays the authority so
the program can be redeployed if the audit finds something (`AUDIT.md`
section 7 has the devnet state).

### 3.7 Logs
Events are `emit!` logs. Solana truncates logs in large transactions, so an
indexer must reconcile from account state (config totals, epochs, claim
statuses), which is always exact; events are a convenience.

### 3.8 Pause semantics (changed from the first draft after review)
A pause blocks `fund_epoch`, `fund_epoch_from_vault` and `claim`. It does not
block `cancel_epoch` (needs zero claims anyway) and it does not shorten a claim
window: the seconds spent paused are added to the deadline of every epoch
funded before the pause, for both `claim` and `sweep_epoch`. So the first draft's
problem (pause, wait out the deadline, sweep, carry the money to a new root) is
closed; the test "a pause extends the deadline" proves it against a real clock.

### 3.9 Findings of the internal review, and how each was closed
The program was reviewed once before this pack was assembled. Every finding and
its outcome:

1. **Config squatting.** `init_city` was permissionless per mint, so a bot could
   have owned the `["city", mint]` PDA of every new coin forever. Closed by the
   registry (3.3): `init_city` needs `registry.admin`, `init_registry` needs the
   upgrade authority. Tests: 01 "a stranger cannot create the config for a coin
   Vicinity has not configured (Unauthorized)", "a key that is not the upgrade
   authority cannot create the registry (NotUpgradeAuthority)", "two-step admin
   transfer: propose, wrong accept, accept; the old admin loses the power and
   the new one has it".
2. **Tokens sent straight to the vault were stuck.** There is no withdraw by
   design and `fund_epoch` only booked a funder's deposit. Closed by
   `fund_epoch_from_vault`: the unaccounted surplus (vault minus what open
   epochs and carry-over are owed) is distributed with exactly the rules of
   `fund_epoch`; the founder share leaves the vault signed by the config PDA
   and is booked in `total_to_founder`. Tests: 02 "only the surplus counts:
   money owed to open epochs and carry-over is never distributed twice",
   "carry-over and surplus add up; a surplus of 0 with carry-over is a
   carry-only epoch", "Creator model: the whole surplus goes to the founder out
   of the vault; the epoch is recorded empty"; Rust
   `fund_epoch_from_vault::tests`.
3. **Pause could capture a claim window.** The authority could pause, wait out
   the deadline, sweep, and carry the money to a root of its choosing. Closed
   by pause-extended deadlines (3.8). Test: 04 "a pause extends the deadline:
   holders lose no claim time and the authority cannot pause, wait and sweep"
   (real clock).
4. **A re-owned or frozen founder token account blocks funding.** Accepted with
   a runbook (3.4). Anchor's `init_if_needed` on an associated token account
   re-checks the mint and the owner of an existing account, so a re-owned
   account is refused, never paid. Test: 02 "founder token account must be the
   founder's ATA of the reward mint"; 05 "founder ATA of another city's founder
   is refused".
5. **Founder = config PDA or vault.** The founder share would land in a token
   account that no key can ever sign for. Closed by `FounderIsProgramAccount`
   (and the zero address by `InvalidFounder`) in `init_city` and `set_founder`.
   Test: 01 "rejects the config PDA and the vault as founder" (both
   instructions).
6. **Token-2022 `MintCloseAuthority`.** A closable reward mint could be closed
   while its supply is 0 (before the first funding) and recreated at the same
   address with other extensions. Closed by removing it from the allow-list.
   Tests: Rust `closable_mint_is_rejected`, `deny_list_covers_the_dangerous_extensions`;
   05 "a Token-2022 mint with a close authority is refused at init_city".
7. **Reward-mint freeze authority (USDC).** Circle can freeze the vault or any
   token account; the program has no remedy. Accepted and documented (3.5,
   `AUDIT.md` known limitation 3 and product decision 15): WSOL has no freeze
   authority.
8. **`init_if_needed` and constraint order.** Anchor creates `init` and
   `init_if_needed` accounts before it evaluates the other accounts'
   constraints. Consequences, all benign: (a) in `init_registry` a wrong signer
   is refused with `NotUpgradeAuthority` while the registry does not exist and
   with the system program's "already in use" once it does (both refuse,
   nothing changes); (b) a refused `fund_epoch` or `claim` leaves no token
   account behind, because a failed instruction rolls back the whole
   transaction; (c) `init_if_needed` is used only for the recipients'
   associated token accounts, never for program state, so the
   re-initialisation attack the feature is known for has no target here (every
   program-owned account uses plain `init`).
9. **Transaction size caps the proof.** A legacy transaction carries at most a
   22-element proof (2^22 = 4,194,304 leaves per epoch); the on-chain cap of
   32 is unreachable defence in depth. Accepted: the snapshot job keeps an
   epoch at or below 2^22 leaves. Tests: 03 "a 33-element proof cannot even be
   put into a transaction (1232-byte runtime limit)"; 06 compute units at depth
   20 and 22.

## 4. The owner's list, item by item

| risk | mechanism | proven by |
|---|---|---|
| **Double claims** | `ClaimStatus` is created with plain `init` at `["claim", epoch, claimant]`; a second claim fails in the system program before any logic runs. Closing the status is only possible after sweep or cancel, when `claim` refuses the epoch anyway. | 03 "double claim fails at account creation (ClaimStatus already exists)"; 04 "close_claim_status: only the claimant, only an existing status; rent returns to the claimant" (its last step claims again after closing and is refused with EpochNotOpen); 03 "claim status cannot be closed while the epoch is open (EpochStillOpen)" |
| **Replay** (same proof again, same proof on another epoch or city, proof for another wallet) | the leaf is `sha256(0x00, index, claimant, amount)` and the claimant must sign; the epoch is bound to the config and index by PDA seeds; the claim status to the epoch and claimant; 0x00/0x01 domain separation stops an inner node from posing as a leaf | 03 "another wallet cannot use my leaf", "another leaf's proof is rejected", "the claimant must sign..."; 05 "config of another city is refused (epoch and vault seeds no longer match)", "epoch of another city with the same index is refused", "claim status PDA of another claimant is refused"; `merkle.test.mjs` inner-node-as-leaf; Rust `merkle::tests` |
| **Incorrect snapshots** (wrong root) | the root is write-once; `snapshot_hash` and `snapshot_slot` are mandatory for Holders/Split so anyone can recompute it; `cancel_epoch` before any claim returns the money to carry-over; the cap `claimed_amount + amount <= holders_amount` bounds the damage of a wrong root to that epoch's own money | 02 "an all-zero snapshot_hash is rejected", "epoch fields are write-once"; 04 "cancel with zero claims...", "cancel after a claim is refused (EpochHasClaims)"; 03 "the first claim within the cap succeeds, the next one fails at the cap" |
| **Manipulated eligibility** | off chain by nature (see section 2); on chain the root is public, hashed to a published file and immutable; the authority is a multisig; `MissingSnapshotHash` refuses unverifiable roots | 02 "an all-zero snapshot_hash is rejected"; documentation of the snapshot job in `README.md` |
| **Rounding** | `split_amount` floors the founder share in u128 and gives the remainder to holders, so the two parts always sum to the deposit; pro-rata leaves are floored off chain and the dust stays in the vault as carry-over | Rust `math::tests` (every bps 0..10000 at u64::MAX, allowed splits on a sample set); 02 "Split 25%/50%/75%: founder share is floored, remainder goes to holders; two epochs add up exactly" (one test per allowed split, exact expected numbers); 02 "tiny amounts..." |
| **Dust** | nothing is burned or lost: dust below one base unit stays in the vault and is counted in `holders_amount - claimed_amount`, swept into `carry_over`, distributed by the next epoch | 03 "the remaining leaf (holder 2) claims; dust of 100 stays in the vault for carry-over"; 04 "the swept carry-over flows into the next epoch"; `assertInvariants` after every test (`vault == open unclaimed + carry_over`) |
| **Sybil** | off chain (eligibility rules); on chain each wallet is one leaf and one claim, so splitting a balance over many wallets only multiplies rent and fees, not rewards, as long as the snapshot is pro rata | `sdk/merkle.test.mjs` "rejects duplicate claimants (bytes, base58 and mixed forms)"; 06 large tree (2,000 wallets, each one leaf) |
| **Duplicate distributions** | an epoch index can only be funded once (`init` at `["epoch", config, epoch_count]`); carry-over is zeroed when taken; `fund_epoch_from_vault` distributes only `vault - (total_to_holders - total_claimed)`, never money an open epoch still owes | 02 "the epoch account must be the PDA for the current epoch_count"; 04 "the carry-over flows into the next epoch exactly..."; 02 "only the surplus counts: money owed to open epochs and carry-over is never distributed twice" |
| **Failed claims** | a claim either fully succeeds or changes nothing (one transaction); the claimant's token account is created if missing (`init_if_needed`, rent paid by the claimant); claims are accepted until the pause-extended deadline, then the money is carried over, never lost; claim status rent is returned after sweep | 03 "holder 0 claims 100: ATA created...", "a claimant with an existing ATA keeps the old balance"; 04 "after the deadline: claim is refused", "a pause extends the deadline...", "close_claim_status: ... rent returns to the claimant" |
| **Accounting inconsistencies** | four lifetime totals and `carry_over` updated in the same instruction as the transfer, all checked arithmetic, `overflow-checks = true`; six invariants asserted after every test, including `vault == total_to_holders - total_claimed` (plus any not-yet-booked direct deposits) and `sum(epoch.claimed) == total_claimed` | `assertInvariants` in `tests/helpers.ts`, called in every `afterEach`; 02 `fund_epoch_from_vault` tests state the unaccounted amount explicitly before booking it; Rust `fund_epoch_from_vault::tests` |
| **Account substitution** (wrong vault, other city's accounts, forged PDAs, wrong mint or token program, someone else's founder ATA) | every PDA is re-derived from seeds, `has_one` ties authority, mints, vault and founder to the config, token accounts are bound to the mint and token program, recipients are associated token accounts of the stored keys | all of 05; 02 "founder token account must be the founder's ATA...", "reward mint account must be config.reward_mint" |
| **Config squatting** | `init_city` requires the registry admin; `init_registry` requires the upgrade authority | 01 "a stranger cannot create the config for a coin Vicinity has not configured", "a key that is not the upgrade authority cannot create the registry", "two-step admin transfer..." |
| **Money stuck in the vault** | `fund_epoch_from_vault` books direct deposits with the same rules as `fund_epoch` | 02 "Split 50%: the unaccounted vault balance becomes an epoch..." and the rest of that block; demo step "A fee wallet sends 100 straight to the vault; fund_epoch_from_vault turns it into epoch 3" |
| **Lost founder share** | the founder may not be the zero address, the config PDA or the vault (their token accounts could never be emptied) | 01 "rejects the config PDA and the vault as founder" (init and set_founder) |
| **Oversized or malicious proofs** | proof length checked before any hashing (cap 32); a legacy transaction cannot even carry 23 elements; a 2,000-leaf tree needs 11 | 03 "overlong proof is rejected...", "a 33-element proof cannot even be put into a transaction"; 06 compute at depth 11, 20 and 22 |

## 5. Known limitations (also in AUDIT.md)

* Eligibility, exclusions and Sybil resistance are off chain and must be
  published with every snapshot.
* A frozen vault (reward mint with a freeze authority) has no remedy.
* A founder with an unusable token account delays funding until `set_founder`.
* Events are logs and can be truncated; indexers reconcile from accounts.
* The program is upgradeable until the owner removes the authority.
* `fund_epoch_from_vault` is the second outflow of the vault; it is bounded by
  `founder_bps` of money that no epoch has booked and it is recorded in
  `total_to_founder`.

## 6. Reporting

Security findings go to the owner directly (no public issue). The program is
not deployed to mainnet at the time of writing.
