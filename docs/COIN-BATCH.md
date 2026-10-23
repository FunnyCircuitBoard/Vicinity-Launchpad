# The owner's daily launch-approval round (`COIN_V2_BATCH`)

Built dark on 23 Oct 2026 (`src/lpbatch.js`, the City coins tab in `public/admin-lp.js`, multi-transaction signing in
`public/lp-sign.js`). It needs `COIN_V2_READY=on` too. Nothing about the live launchpad program changes: every `approve_launch`
still needs the admin's signature, and the admin is the owner's own wallet. What changes is that the owner signs every ready city
in one round instead of one card at a time (DESIGN.md 6.5 and 9.4; owner decisions D1 A, D2, D3).

## What the owner does

1. Open **admin → City coins**. The card **Launch approvals to sign** is at the top.
2. Read the four groups:
   - **Approve**: a founder whose chosen Vicinity coin passes every check (the seat, the wallet, the founder amount read live,
     no ban, the ticker from the city list and not launched or approved for another city, no change request or description waiting,
     the description passing the current rules, the city has no coin). The approval lasts 14 days.
   - **Renew**: an approval with under 48 hours left (or expired). It is withdrawn and made again in the same transaction.
   - **Revoke**: an approval that should no longer stand: the approved wallet lost the seat, the founder is banned, a change request
     or description waits for review, or the coin may no longer launch as it is. The program would let that wallet launch until it
     expires, so it is withdrawn; its rent comes back.
   - **Blocked**: nothing is built; each row says why.
3. Untick any city to leave it out of today's round (it comes back in the next one).
4. Press **Sign today's approvals**. The site checks every city again and builds the transactions (up to 5 cities each). The page
   shows each transaction and checks the list of its instructions (the one this site worked out when it built them) against the
   rows you saw. The page does not decode the transaction bytes itself: your wallet's own screen is the last look at what you sign.
5. Sign: one prompt for all if the wallet can; otherwise one at a time (each next transaction is built again just before, so it does
   not run out of time). Each landed transaction is recorded and the founder is told they can launch.

## What the founder sees

"Your launch opens after the owner's next approval round." No time is promised anywhere. Once approved, the founder launches from
their Founder tab as today, with no per-launch admin step.

## Safety

- The website never signs and never holds a key: every transaction is built UNSIGNED and signed by the owner's wallet.
- A row is built only when the fresh list has exactly what the card showed (action, founder, name, ticker, version); anything else
  is left out with the reason, never replaced.
- Each design is held while its approval is built, and the version the approval stands for is the one the launch publishes.
- Owner only (`ADMIN_WALLETS`, and the launchpad's admin on chain), a wallet proof from the last 30 minutes, this site's pages only,
  30 builds an hour.
- No new table or column. With the switch off the routes answer like any unknown path.
