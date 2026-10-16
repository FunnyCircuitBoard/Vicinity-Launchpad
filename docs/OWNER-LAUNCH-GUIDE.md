# City coins on mainnet: your step-by-step guide

This guide is for you, the owner. It takes you from nothing to the first city coin on Solana mainnet. You do every step
yourself, on your Mac, in Squads and in your Phantom wallet. Nobody else ever holds your keys.

* **On your Mac** you install one tool, make your own keys, and put the two Vicinity programs on Solana (steps 1 to 10).
  There is no Node, no git and no code to run: only the `solana` command, which you copy and paste.
* **On app.squads.so** you create the 2-of-3 multisig that will control the programs (step 11).
* **On vicinity.city** you do everything else with Phantom: starting the launchpad, handing the programs to your
  Squads multisig, approving cities, collecting fees (steps 12 to 14 and the everyday buttons).
* **We** build the two program files for your addresses, check every step from the outside (read only), and change
  the website settings through pull requests that you approve. We never send a mainnet transaction and never touch
  your keys.

It takes about 3 to 4 hours in total, spread over two or three days (much of it is waiting for us between parts, and the
uploads of step 8). In SOL it uses about **4.91 SOL**, almost all of it rent that stays inside the two programs; on top
of that, one month of a fast connection to Solana costs about $49 by card (step 4). The tables at the end have every
number.

## Before you start

Have these ready before step 1:

1. **5.0 SOL in your Phantom dev wallet** (`13qRam…`). 4.9 SOL goes to the deploy in step 7; about 0.12 SOL of it comes
   back in step 10 and, with the 0.1 SOL left in Phantom, pays for the Squads multisig (step 11, about 0.103 SOL) and the
   website steps (about 0.02 SOL). With 5.1 SOL you have room for a retry.
2. **Two more wallets that you control**, with their public addresses written down, for your Squads multisig: best a
   Ledger hardware wallet, otherwise Phantom on a second phone with its own recovery phrase; the third in another place
   (a second Ledger in a safe, or the wallet of a person you trust completely). You need the addresses in step 11.
3. **A payment card** for one month of the Helius Developer plan (step 4, about $49; you can cancel it after step 10).
4. **Your Mac, plugged in**, and one to two hours of quiet for steps 6 to 10 (most of it is waiting for step 8).
5. Optional: **a free practice run.** If you want to see every website screen before real SOL moves, tell us: we put a
   test copy of the website on Solana's test network, and you do website steps 1 to 4 there with Phantom in Testnet Mode
   (Phantom → Settings → Developer Settings → Testnet Mode). Nothing there is real money.

> **Never send anyone, and never type anywhere else:**
> * a `.json` key file (from the `vicinity-keys` folder),
> * the 12 words `solana-keygen` shows you,
> * Phantom's recovery phrase or private key, or the words of any Squads member's wallet.
>
> We will never ask for any of these. The only things you ever send us are **public addresses** (long strings of
> letters and digits, 32 to 44 characters), the word "done", and the box from website step 8. If anyone asks you for
> anything else, even "to help", it is a scam: stop and talk to us on a channel you already trust.

How to paste a command: copy the grey block exactly, click into Terminal, paste (Cmd+V), press Enter, and wait until
the prompt comes back. One block at a time. Where you see `<something like this>`, replace the whole thing,
including `<` and `>`, with the real value. When we send you the files, we also send these commands with your own
addresses already filled in. Every block starts with `cd ~/vicinity-keys`: paste that line too, even if Terminal is
already there. It makes each block work in a new Terminal window, after a restart, or on another day.

---------------------------------------------------------------------------------------------------------------------

## Part 1: today (no money moves)

### Step 1. Install the Solana command line, version 4.3.0

1. Open Terminal: press Cmd+Space, type `Terminal`, press Enter.
2. Paste this and press Enter:

   ```
   sh -c "$(curl -sSfL https://release.anza.xyz/v4.3.0/install)"
   ```
3. Close Terminal completely (Cmd+Q) and open it again.
4. Check it:

   ```
   solana --version
   ```
   It must start with `solana-cli 4.3.0`.

If it says `command not found`, paste these two lines, then close and reopen Terminal and try again:

```
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.zprofile
source ~/.zprofile
```

### Step 2. Make your five key files

These are the keys of the deployment. They live in one folder on your Mac, `vicinity-keys` in your home folder.

```
mkdir -p ~/vicinity-keys && cd ~/vicinity-keys
```

Then these five commands, one at a time:

```
cd ~/vicinity-keys
solana-keygen new --no-bip39-passphrase -o deployer.json
solana-keygen new --no-bip39-passphrase -o launchpad-program.json
solana-keygen new --no-bip39-passphrase -o rewards-program.json
solana-keygen new --no-bip39-passphrase -o launchpad-buffer.json
solana-keygen new --no-bip39-passphrase -o rewards-buffer.json
```

What each one is:

| file | what it does | how long it matters |
|---|---|---|
| `deployer.json` | pays for the deploy (you send it 4.9 SOL in step 7) | until step 10; afterwards it has no power and is empty |
| `launchpad-program.json` | the address of the launchpad program | only for the first deploy |
| `rewards-program.json` | the address of the rewards program | only for the first deploy |
| `launchpad-buffer.json`, `rewards-buffer.json` | the temporary upload space of each deploy; with them a stopped deploy continues where it stopped | only during step 8 |

Each command shows a `pubkey:` line and 12 words. **Write the 12 words of `deployer.json` on paper** and keep it with
your other recovery phrases. You do not need to write down the words of the other four; the files are enough.
If a command says the file already exists, do not force it: you already made that key.

Make a backup copy of the folder on a USB stick and keep the stick in a drawer. Never upload the folder anywhere.

### Step 3. Send us three public addresses

```
cd ~/vicinity-keys
solana-keygen pubkey deployer.json
solana-keygen pubkey launchpad-program.json
solana-keygen pubkey rewards-program.json
```

Send us the three lines, saying which is which (deployer, launchpad, rewards). Only these three. Never a `.json` file,
never the words.

We write the two program addresses into the program files we build for you and into the website settings (a pull
request you approve). After that change, only you see a new **City coins** tab in vicinity.city/admin. Visitors see
nothing new yet.

### Step 4. Your own fast connection to Solana (an "RPC address")

Step 8 uploads the two programs in about 970 small pieces. Solana's public address is too slow for that, and so is a
free provider plan: it accepts one upload per second, so step 8 would run for hours and stop again and again (we
measured it on Solana's test network). Solana's own instructions for this kind of upload ask for a "staked"
connection, which the paid plans have.

1. Make an account at **helius.dev** and choose the **Developer** plan (about $49 for a month). You can cancel it after
   step 10; nothing on vicinity.city uses it.
2. Create an API key and copy its **mainnet RPC URL** (it looks like `https://mainnet.helius-rpc.com/?api-key=…`). It is
   not a wallet key, but keep it to yourself; you do not need to send it to us.

### Step 5. Get your Squads members ready (nothing to create yet)

From website step 2 on, nobody can change the two programs alone: every change needs 2 of 3 approvals in Squads. You
create the multisig in step 11, when the SOL that comes back in step 10 pays for it. Today, only write down the three
member addresses:

* your Phantom dev wallet `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN`;
* a second wallet that only you control, on another device: best a Ledger hardware wallet, otherwise Phantom on a
  second phone with its own recovery phrase;
* a third key in another place: a second Ledger in a safe, or the wallet of a person you trust completely.

Why 2 of 3: a lost or stolen phone cannot change the programs, and losing one key still leaves two.

### Then we send you

* two files: `vicinity_launchpad.so` and `vicinity_rewards.so`, and a third small file `SHA256SUMS` with their
  fingerprints;
* the same two fingerprints in the message itself;
* the commands of part 2 with your addresses filled in;
* "the website is ready": the City coins tab shows both programs as "Not on this network yet".

How the files are made (for your auditors): `solana/scripts/launchpad/build-mainnet.sh` first rebuilds the audited
source unchanged and checks that it gives exactly the audited fingerprints, then changes only the program address
line of each program, rebuilds, and checks that the only bytes that changed are your addresses. It runs with the
pinned toolchain (cargo-build-sbf 4.4.0, platform-tools v1.57); there is no Docker "verifiable build".

---------------------------------------------------------------------------------------------------------------------

## Part 2: put the programs on Solana (on your Mac; about 1 to 2 hours)

### Step 6. Check the files and point the tool at mainnet

1. Move the three files from your Downloads folder into `vicinity-keys`:

   ```
   mv ~/Downloads/vicinity_launchpad.so ~/Downloads/vicinity_rewards.so ~/Downloads/SHA256SUMS ~/vicinity-keys/
   ```
   If it says `No such file or directory`, your browser saved them somewhere else: in Finder, press Shift+Cmd+H (your
   home folder), open `vicinity-keys` in one window and drag the three files into it.
2. Check them:

   ```
   cd ~/vicinity-keys
   shasum -a 256 -c SHA256SUMS
   ```
   Both lines must end with `OK`. Then run `shasum -a 256 vicinity_*.so` and compare the two long numbers with the
   ones in our message, all characters. **If anything says FAILED or differs: stop and tell us.** Nothing is lost.
3. Point the tool at mainnet, through your RPC address from step 4, with the deployer as the paying key (keep the
   quotes around the URL):

   ```
   solana config set --url "<your RPC URL from step 4>" --keypair ~/vicinity-keys/deployer.json
   ```
4. Check:

   ```
   solana address
   solana genesis-hash
   ```
   The first must print your deployer address (the one you sent us). The second must print
   `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`: that is Solana mainnet.

### Step 7. Send 4.9 SOL to the deployer

In Phantom: Send → SOL → paste the deployer address (from `solana address`) → **4.9** → check the first and last
four characters of the address → Send. Then:

```
solana balance
```
It must show `4.9 SOL`. (Why 4.9 when the rent is 4.78: before it uploads anything, each deploy command checks that the
deployer could pay the highest possible network fee on top of the rent, about 0.040 SOL for the rewards file and 0.034
SOL for the launchpad file at the priority fee of step 8. It really spends only about 0.003 SOL each. What is left
over, about 0.12 SOL, comes back in step 10.)

### Step 8. Deploy the two programs

Keep the Mac plugged in. `caffeinate -i` in front keeps it awake while the command runs. First the rewards program:

```
cd ~/vicinity-keys
caffeinate -i solana program deploy vicinity_rewards.so --program-id rewards-program.json --buffer rewards-buffer.json --use-rpc --with-compute-unit-price 50000 --max-sign-attempts 100
```

It shows a progress line and takes about 30 minutes (up to an hour). It is done when it prints
`Program Id: <your rewards address>` and `Signature: …`. Then the launchpad program, the same way with its own files:

```
cd ~/vicinity-keys
caffeinate -i solana program deploy vicinity_launchpad.so --program-id launchpad-program.json --buffer launchpad-buffer.json --use-rpc --with-compute-unit-price 50000 --max-sign-attempts 100
```

While it runs you may see lines like `Blockhash expired. 99 retries remaining`. That is normal: some pieces did not
land in time, and the tool sends them again by itself. Pressing Ctrl+C stops it safely; nothing is lost.

**If a command stops with an error** (`Max retries exceeded`, `timed out`, a network error, `insufficient funds`),
first check whether that program is on chain already:

```
cd ~/vicinity-keys
solana program show <the address of the program you were deploying>
```

* It shows `Data Length: 505864` (rewards) or `Data Length: 433960` (launchpad) and `Authority:` your deployer
  address: **that deploy is done.** Do not run it again (a second run would try to replace it and need another 2.2 to
  2.6 SOL). Go on.
* It says `Error: Unable to find the account`: run **the same deploy command again**. It continues where it stopped
  (that is what the buffer file is for).

Part 5 lists the other messages you might see.

### Step 9. Check what is on chain

For each program (replace the address):

```
cd ~/vicinity-keys
solana program show <rewards address>
solana program show <launchpad address>
```

| | rewards | launchpad |
|---|---|---|
| `Authority:` | your deployer address | your deployer address |
| `Data Length:` | `505864 (0x7b808) bytes` | `433960 (0x69f28) bytes` |
| `Balance:` | about `2.57066796 SOL` | about `2.20539564 SOL` |

The authority and the data length must be exactly these. The balance may differ a little if Solana changed its rent
after 10 Oct 2026; that alone is fine.

Then download each program back from the chain and compare its fingerprint with `SHA256SUMS`:

```
cd ~/vicinity-keys
solana program dump <rewards address> check-rewards.so && shasum -a 256 check-rewards.so
solana program dump <launchpad address> check-launchpad.so && shasum -a 256 check-launchpad.so
```

Each number must be exactly the one in `SHA256SUMS` for that program. **If not: stop and tell us.**

Also open **vicinity.city/admin → City coins** (signed in with Phantom, `13qRam…`): both programs show
"Deployed: Yes", the same size and the same fingerprint.

### Step 10. Give control to your Phantom for a few minutes, and send the rest back

Website step 1 starts both programs, and Solana only lets the key that controls a program start it. That key is the
deployer now; these two commands make it your Phantom dev wallet. Website step 2 then hands both programs to your
Squads. **Do steps 10, 11 and 12 in one sitting** (about 30 minutes), so the programs sit under one key for minutes only.

```
cd ~/vicinity-keys
solana program set-upgrade-authority <rewards address> --new-upgrade-authority 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN --skip-new-upgrade-authority-signer-check
solana program set-upgrade-authority <launchpad address> --new-upgrade-authority 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN --skip-new-upgrade-authority-signer-check
```

(`--skip-new-upgrade-authority-signer-check` is needed because Phantom cannot sign in Terminal. Check the address
twice: it is your dev wallet.) `solana program show <address>` now says `Authority: 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN`.

Send what is left back to Phantom. First make sure no half-used upload space is left: the first command lists it,
the second closes it and returns its SOL to the deployer. Normally both print only an empty table
(`Buffer Address | Authority | Balance`), which is fine. Then send everything:

```
cd ~/vicinity-keys
solana program show --buffers
solana program close --buffers
solana transfer 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN ALL
```

`solana balance` then shows 0, and Phantom shows about 0.12 SOL more. From now on the deployer and the program key
files have no power over anything. Keep the folder anyway; you never need it again for daily work. You can cancel the
Helius plan now.

---------------------------------------------------------------------------------------------------------------------

## Part 3: Squads and the website (Phantom; about 30 minutes; about 0.13 SOL)

### Step 11. Create your Squads multisig (2 of 3)

1. Open **app.squads.so** in your browser, press **Connect Wallet** and connect Phantom (your dev wallet `13qRam…`).
2. Press **Create a Squad** and give it a name, for example "Vicinity programs".
3. Members: the three addresses from step 5 (your dev wallet `13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN` and your two
   other wallets).
4. Threshold (approvals needed): **2**.
5. Leave the advanced options as they are (no "config authority", no "controlled" multisig: the website refuses a
   multisig whose members can be changed without a vote). A time lock is allowed; the website shows it.
6. Press **Next**, check the summary, press **Confirm** and approve in Phantom. Squads charges a one-time deployment fee
   of 0.1 SOL plus about 0.003 SOL for the multisig's own accounts.
7. Open the multisig's **Settings**. Copy the address labelled **Multisig account** (not the one labelled Vault):
   that is the one website step 2 asks for. Keep the Squads tab open: in website step 2 you compare its **Vault**
   address with what the page shows. (If you paste the vault by mistake, the page says so and nothing happens.)

### Step 12. The City coins tab, steps 1 to 7

Use a computer with the Phantom browser extension (not the phone), signed in at **vicinity.city/admin** with the dev
wallet `13qRam…`, which should hold at least 0.06 SOL. Open **City coins**. A red banner says "MAINNET: real SOL":
every step here is real. (The **Log in** button in the site's header is for the member pages; on /admin you are signed
in when the tabs show. Ignore it.)

Each step works the same way:

1. Press **Prepare step N**. The page builds the transaction and shows, in plain words, every instruction in it and
   the exact SOL change of your wallet. If Phantom first asks you to **sign a message** (no SOL moves, nothing is sent),
   that is vicinity.city checking it is still you, which it does every 30 minutes: approve it. Only a transaction
   moves SOL.
2. Press **Approve in your wallet**. Phantom opens. Check that Phantom names **vicinity.city** and shows about the
   same SOL change. Then approve.
3. The page says **Done and recorded.** and the next step becomes Ready.

If you press Cancel, or reject in Phantom, nothing is sent and nothing changes. The page only offers a step when it
is safe to do; a step that is "Waiting" says why.

| website step | what it does | what Phantom should show |
|---|---|---|
| 1. Start the launchpad | starts the rewards registry and the launchpad in one transaction; your wallet becomes the admin of both | about −0.0026 SOL (rent for two small records). Phantom may warn that the program is new or unknown: it is your own program from step 8; check that the page names "Vicinity rewards" and "Vicinity launchpad" at your two addresses |
| 2. Hand the programs to your Squads | paste the **Multisig account** address from step 11, press **Check**. The page reads it from the blockchain and shows "2 of 3 members", the three members and the **Vault**. Compare that vault with the vault in the Squads app, every character. Tick "The vault above is the vault in my Squads app", then **Prepare step 2** | only the network fee. The page lists two "Program loader (upgradeable): hand over control of a program (set_authority)" lines: open "3 accounts" under each; the one marked "your Squads vault (the new upgrade authority)" must be the vault you compared. Phantom may warn that the transaction changes who controls an account: that is exactly this step |
| 3. Create the Meteora price curve | the price curve every city coin uses, with Vicinity's defaults (85 SOL target, 1.25% fee per trade and 0.05 SOL launch fee on the live config today; the website reads the figures it shows from the config itself), fees to the dev wallet. A one-time key made in your browser signs together with you | about −0.006 SOL |
| 4. Allow the price curve | puts the curve on the launchpad's allow-list; the program checks every Vicinity rule again | about −0.0012 SOL |
| 5. Fee accounts | the dev wallet's fee accounts for SOL and $VICINITY. They already exist on mainnet, so this step is probably shown as Done | about −0.0015 SOL per missing account |
| 6. Speed table | an address list that makes a launch with a first buy fit in one transaction. If the page offers step 6 again afterwards, press it again until it says Done | about −0.0044 SOL |
| 7. Name Vicinity on Meteora | gives Meteora and Jupiter the name "Vicinity", the website and the logo. Only the dev wallet can sign it | about −0.002 SOL |

After step 2, `solana program show <address>` on your Mac says `Authority: <your vault>`: only 2 of your 3 Squads
members together can change the programs from now on.

What the page refuses on purpose: steps out of order (after step 2, step 1 could never run), a pasted vault, wallet
or wrong address in step 2, a multisig that needs only 1 approval or whose members can be changed without a vote.

### Step 13. Website step 8: send the box to us

Press **Copy** under "Send this to the team" and send us the text. It holds only public addresses and transaction
ids, nothing secret. We then:

1. check every address in it against the blockchain, read only (`npm run mainnet:preflight -- --setup …`, see
   docs/MAINNET.md section 4);
2. open the second settings change (it names the price curve and the speed table, and switches city-coin trading
   on). You approve it;
3. check the live site again once it is deployed (its coin metadata files and logo must answer before any coin
   exists, because each coin points to them for ever).

Then we tell you "ready for the first city".

### Step 14. The first city

1. City coins → **Approve a city coin**: each city whose founder has a coin design ready is listed with its coin name,
   ticker, founder wallet, description and logo; one that cannot be approved says why (for example: not a SOL pair, a
   name longer than 32 bytes, a ticker that is not the city's). Read the name and the description: once the coin
   launches, both are public for ever (wallets and Jupiter show them).
2. Pick the city, keep the expiry at 7 days (30 at most), press **Approve on chain**. Above the list of what you sign,
   the page shows **You are approving**: the coin name, the ticker, the founder wallet and the date until which the
   founder can launch. Phantom will not show these, so check them here. Then approve in Phantom (about −0.0016 SOL of
   rent, which comes back when the founder launches or when you revoke). From the moment you prepare it, the founder
   can no longer change the design; if they changed it while your page was open, the page says so: reload and look
   again.
3. Tell the founder. They open their dashboard → **Founder** tab → "Launch your city coin" → **Launch**, in their own
   wallet (it costs them the config's launch fee plus rent: about 0.08 SOL with the 0.05 SOL launch fee of the live config
   today). Their coin is live at once.

If an approval later shows "The approved wallet no longer holds the founder seat … Revoke it" (the founder lost or
left the seat before launching), press **Revoke**: the program itself would still let that wallet launch until the
approval expires.

---------------------------------------------------------------------------------------------------------------------

## Part 4: the everyday buttons (City coins tab)

| button | who can press it | what it does |
|---|---|---|
| Approve on chain / Revoke | you (the admin wallet) | lets a founder launch, or takes the approval back before the launch (the rent comes back) |
| Collect city fees | you (anyone may pay for this, but the button is on your tab) | moves the city's share of trading fees from Meteora into the city's accounts |
| Set up holder rewards | you | once per launched coin: creates the coin's holder-rewards vault |
| Forward holders' share | you (anyone may pay for this, but the button is on your tab) | moves the holders' share into that vault, where it waits for reward rounds |
| Move to the open market | anyone, on the coin's page | when the curve is full, moves the coin to its Meteora pool (about 0.03 SOL, paid by whoever presses) |
| Collect (platform fees) | only the dev wallet `13qRam…` | collects Vicinity's own share of trades and launches |
| Pause launches / Resume launches | you | stops or allows new launches (trades on existing coins cannot be stopped) |

Founders collect their own share (half of the city's part of each trade: 0.25% on the live config today, shown on the coin
page's Fees card from the config) on their Founder tab ("Collect your fees"). Reward rounds to holders are not on the
website yet: the holders' money waits safely in each city's vault until they are.

Later, when you want, the admin role can move from your Phantom to the Squads vault too (the program supports it;
we prepare the transaction for the Squads app). Until then your Phantom approves cities; it cannot move any coin,
pot or fee money.

---------------------------------------------------------------------------------------------------------------------

## Part 5: what can go wrong

| what you see | what it means | what to do |
|---|---|---|
| step 8 shows `Blockhash expired. N retries remaining` | some pieces did not land in time; the tool sends them again by itself | nothing: wait. Ctrl+C is safe if you have to stop |
| step 8 stops with an error (`Max retries exceeded`, `timed out`, a network error) | some pieces did not land after many tries | first `solana program show <address>` (step 8): if it shows the right Data Length and your deployer as Authority, that deploy is done; go on. If it says `Unable to find the account`, run **the same command again**: it continues where it stopped. To give up instead, `solana program close --buffers` returns the SOL held in the half-done upload to the deployer |
| `insufficient funds` or `Account … has insufficient funds` | either that deploy already landed, or the deployer needs a little more SOL | first `solana program show <address>` as above: if that program is there, do not run its command again. If it is not there, send 0.1 SOL more from Phantom to the deployer (`solana address`), then run the same command again |
| `429 Too Many Requests` | your RPC plan accepts fewer uploads than step 8 sends | check that step 4's key is on the Developer plan, then run the same command again |
| `shasum` says FAILED, or a fingerprint differs from ours | the file is not the one we built | **stop**, tell us. Do not deploy (or, after step 8, do not do step 10) |
| `Data Length` or the fingerprint in step 9 differs from the table | the program on chain is not what we expect | stop, tell us. (A slightly different `Balance` alone is fine) |
| step 10 says the authority does not match | the command already ran, or `solana config get` shows another keypair | run `solana program show <address>` and tell us what it says |
| Phantom asks you to "Sign message" before a website step | vicinity.city checks it is still you (every 30 minutes); no SOL moves | approve it. Only a transaction moves SOL |
| Phantom warns about an unknown or new program (website step 1) | Phantom has never seen your brand-new program | check the page's list (your two addresses, about −0.0026 SOL) and approve. If Phantom refuses to sign at all: stop, nothing happened, the programs stay safe under your wallet; tell us |
| Phantom warns that the transaction changes an authority or owner (website step 2) | that is exactly what step 2 does | check the new authority is the vault you compared with Squads, then approve. If Phantom refuses to sign: stop; the programs stay under your Phantom wallet (safe, but one key controls them); tell us the same day |
| Phantom shows "Request blocked" or says vicinity.city may be malicious | Phantom's own warning list; nothing was signed | do not approve. Tell us: we ask Phantom to review the site, and you do the step once it is cleared |
| Phantom says the transaction will fail | something on chain changed since the page prepared it | reject, reload the page and prepare the step again; if it repeats, tell us |
| step 3 says "Meteora has updated its bonding-curve program" | Meteora changed its program after we tested it; the price curve it would make now could differ from the tested one | nothing was spent: stop and tell us. We re-check Meteora's new program and update the website; then step 3 is offered again |
| step 2 refuses the address you pasted | it is the vault, a wallet, a typo, or a multisig that needs only 1 approval | in Squads Settings copy the **Multisig account** address; make the threshold 2 if needed |
| step 1 says "Waiting: … not the wallet you are signed in with" | step 10 is not done for that program, or you are signed in with another wallet | do step 10 for both programs; sign in with `13qRam…` |
| "Approve on chain" says the design changed since the page showed it | the founder edited their coin while your page was open | reload the page, read the city's card again, then approve |
| "Done on the blockchain. … This page will try to record it again next time." | the transaction landed but the website could not note it | nothing to do; the page records it on your next visit |
| you lose the deployer or program key files after step 10 | they have no power anymore | nothing to do |
| you lose them before step 8 | the programs are not on chain yet | make new ones (step 2) and send us the new addresses; we rebuild |
| you lose one Squads member key | 2 of the 3 still work | replace that member in Squads soon |

---------------------------------------------------------------------------------------------------------------------

## Costs

| what | SOL |
|---|---|
| rent of the rewards program (505,909 bytes of program data) | 2.57066796 |
| rent of the launchpad program (434,005 bytes of program data) | 2.20539564 |
| rent of the two program accounts (2 × 0.00083312) | 0.00166624 |
| **rent for both programs** | **4.77772984** |
| network fees of the about 970 uploads, with the priority fee | about 0.006 |
| the deploy command's up-front check of the highest possible network fee (not spent) | about 0.040 for the rewards file, 0.034 for the launchpad file |
| **send to the deployer in step 7** | **4.9** (what is left, about 0.12, comes back in step 10) |
| creating the Squads multisig (step 11) | about 0.103 (Squads' one-time 0.1 fee plus the multisig's accounts) |
| website steps 1 to 7, from Phantom | about 0.02 (keep at least 0.06 in Phantom) |
| each approval | about 0.0016, refunded at launch or revoke |
| **used in all** | **about 4.91** |
| one month of the Helius Developer plan (step 4) | about $49, by card |

Start with **at least 5.0 SOL** in Phantom; 5.1 SOL leaves room for a retry. The rent is not spent: it stays inside
the program accounts for as long as the programs exist (the rent figures were read from mainnet on 10 Oct 2026; the
programs are sized exactly to the files, and Solana CLI 4.3 grows a program's space by itself if it is ever upgraded
to a bigger file).
