# Rules version 7: DRAFT for the owner

**Status: draft only. Not published.** The live rules stay version 6 (`src/policy.js` `POLICY.version` is 6, `/rules` is unchanged). Nothing here
is shown on the site. It describes the new city-coin flow that is built behind the `COIN_V2_READY` switch, which is **off**. Version 7 is
published (as a pull request that changes `src/policy.js` and `scripts/pages/src/rules.html`) only after the owner approves this text, and
before the switch goes on: "every change is a new version, published first".

Below: the text that would replace version 6's, then what changed and why, then what the owner still has to decide.

---

## 1. "The city's coin" (replaces rule 9, `#coins`)

> **The city's coin:** every city coin is made by Vicinity, the same way for every city: the Vicinity coin design with the city's ticker
> and name, and the coin's name, city, region, country and a short description, all taken from the Vicinity city list. Nobody types them,
> not even the founder. The city's active founder checks the coin and chooses it with one tap ("Use this coin"); that exact version is what
> the owner approves on the blockchain and what launches, on the Vicinity Launchpad, on Meteora's bonding curve, paired with SOL. Everyone
> in a city that has a founder can see the coin before it launches, marked "Preview, not launched". Once it launches, its name and ticker are
> on the blockchain for ever, and its picture and description are kept by Vicinity at a permanent address named after the picture's own
> fingerprint (a SHA-256 hash), so they can never be swapped afterwards.

## 2. "Never" (replaces the fourth line of the list)

> Pick or change a city coin's ticker, or change a launched coin's picture: the ticker is fixed by the Vicinity city list and copied on chain
> at launch, and once a coin launches its ticker stays its own for ever (the list can never give it to another city); a launched coin's
> picture lives at a permanent address named after its own fingerprint.

(The other lines of the list stay as they are, including "Change a city's official coin once it has launched.")

## 3. One sentence added under "Never"

> A city has one coin, for ever: a coin made anywhere else (for example on Raydium LaunchLab) can no longer be recorded as a city's coin.

---

## What changes from version 6, and why

| Version 6 says | Version 7 says | Why |
|---|---|---|
| "the active founder designs it: its name, a short pitch, a colour and a logo" | Vicinity makes every coin from the city list; the founder checks and chooses it | One design for every city, nothing to review by hand for the first coins, no logos the founder may not own |
| "An admin approves it on chain before launch" | The owner approves **the exact version the founder chose** (its content hash) | The approval and the launch stand for the very coin the founder saw |
| "once it launches the design is locked for good" | Name and ticker on chain for ever; picture and description at a permanent, hash-named address | A wallet or explorer reading the coin later always gets the same picture |
| ticker "fixed by the Vicinity city list" | ...and a launched ticker is pinned: rebuilding the list can never move it to another city | The list is rebuilt from the whole city list; a new town with the same name could otherwise take a launched ticker |
| (nothing) | A coin made elsewhere can no longer be recorded as a city's coin | One city, one coin: the old LaunchLab contract path could give a city a second coin |

What does **not** change: who can be a founder, the Stake Ladder, grace, the pair (SOL), the bonding curve, fees, that the owner signs every
approval on the blockchain, that the website holds no key that can approve a launch or move funds, and every existing user, balance and token.

## What is built today (behind the switch, off)

- The coin picture (template **t1**: the vector redraw of the owner's Utica coin), drawn on the server once per coin version and stored.
- The founder's card with the read-only coin and "Use this coin"; the preview for others in a city with a founder.
- Every check on the server; the owner's City coins tab approves only a chosen coin whose ticker no other city launched or holds an approval
  for; a launch with a ticker another city launched is refused.
- Launches publish the template picture and a description built on the server; the picture and the coin's metadata keep being served even
  if the switch is later turned off.
- The ticker list pins every launched ticker (none has launched yet: the list of pins is empty today).

## Not built yet (so version 7 does not promise them)

- Requesting changes (another picture, ticker or name) with a person's review, and writing your own description with automatic screening:
  later stages of the same design. Version 7 does **not** mention them; a later version adds them when they exist.
- Launching without the owner's daily signature: every launch still needs the owner's approval on the blockchain.

## Decisions the owner makes before the switch goes on

1. **The template look (D5).** t1 is a vector redraw of the owner's picture. If the painted look is wanted exactly, a later template version
   (t2) lays the same text on a blank painted coin supplied by the owner; t1 coins never change either way.
2. **This text.** Approve it as written, or say what to change; then it is published as version 7 before the switch goes on.
3. **Earlier studio designs.** Founders who designed a coin the old way keep their design (it is copied aside, whole, when they choose the
   ready-made coin); with the switch on it is no longer approved for launch. Say if any such design should be honoured instead.
