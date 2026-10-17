// "Launch your city coin" (the dashboard's Founder tab) and "Move to the open market" (the coin page): window.LPLaunch. Needs
// site.js (window.V), wallets.js (window.VW) and lp-sign.js (window.LP). Everything here is switched off with the launchpad's
// settings: /api/official has no cityCoins key, the probe (GET /api/lp/launch/status, no city) is not even asked and nothing is
// shown, so the Raydium LaunchLab copy the dashboard always had stays (public/dashboard.js decides that from probe()).
// The Worker builds each transaction UNSIGNED for the signed-in wallet and simulates it (src/lplaunch.js); this page shows what will
// be signed and the exact SOL change BEFORE the wallet opens (LP.renderSummary); lp-sign.js has the one-time key(s) made in this
// browser (the coin's address, the two position NFTs) sign first, then the wallet signs and sends it (or, a wallet that only
// signs, signs and the site's relay sends).
// Only textContent here: nothing from the server is ever HTML. No inline script, no inline style, no element ids made.
//   LPLaunch.probe()                         -> Promise<{ on, cluster, configsSet, speedTable } | null>
//   LPLaunch.founder(card, { cityId, design })  the founder card: approved / signing / done / expired / paused / not approved
//   LPLaunch.graduate(box, { mint, ticker })    the coin page's "Move to the open market" (then the leftover step)
//   The launched founder card also shows the coin's founder fees read from the chain (GET /api/fee-status, src/feestatus.js): where
//   they go, earned, collected (or paid out), what is in the fee vault, what is still in the curve or the pool, and what the Collect
//   button takes now, each with the accounts it was read from and the time. Its figures replace the "waiting for you" line, which
//   stays only when that read fails (then nothing else is shown: never a zero that looks real). After graduation the estimate of
//   what is still in the pool alone may be withheld by the server ("can't be worked out right now"); every other figure stays,
//   the fee vault too. A reading older than money the card knows has left is never shown: older than this tab's last Collect of the
//   coin (by chain slot, kept in sessionStorage across reloads), or than the no-store status answer read just now (its Coin-record
//   counters, which only grow: a lower earned or collected is an older reading, in a new tab or after a reload too; and its own
//   vault and curve figures), and neither is the "waiting for you" line of a status read before that Collect. A Collect whose
//   outcome the page cannot tell (sent, not confirmed in time, or sent with no id to follow) takes the figures from before it off
//   the page as a landed one does, the button stays away until a reload, and this tab's sessionStorage keeps the viewer's clock
//   time of that moment by coin (so does a Collect that landed with no slot given), so the coin page (public/coin.js) shows no
//   "Fees so far" of that coin for 5 minutes after it, and neither does this card in that tab when its status cannot tell an older
//   reading (the status's fee read failed). The time words are drawn again when the tab is seen again (a day may have passed).
//   LPLaunch.pure                              the helpers test/lp-launch-ui.test.js runs in node
(() => {
  "use strict";
  const MAX_FIRST_BUY = 10_000_000_000n; // lamports (src/lplaunch.js MAX_FIRST_BUY_LAMPORTS)
  const FIRST_BUY_SLIPPAGE_BPS = 50;

  /* =====================================================================
     Pure helpers
     ===================================================================== */
  /** An amount of SOL the founder typed -> { lamports } ("" is 0), { tooLarge } past 10 SOL, or null when it is not an amount. */
  function parseSol(text) {
    const t = String(text == null ? "" : text).trim().replace(",", ".");
    if (t === "" || t === "0") return { lamports: "0" };
    const m = /^(\d{1,3})(?:\.(\d{0,9}))?$/.exec(t) || /^()\.(\d{1,9})$/.exec(t);
    if (!m) return null;
    const v = BigInt(m[1] || "0") * 1_000_000_000n + BigInt((m[2] || "").padEnd(9, "0") || "0");
    if (v > MAX_FIRST_BUY) return { tooLarge: true };
    return { lamports: v.toString() };
  }
  const solText = (lamports, max = 6) => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: max })} SOL`;
  const coinsText = (ui) => { const n = Number(ui); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(ui); };
  function dateText(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""; }
  function leftText(seconds) {
    const s = Number(seconds) || 0, d = Math.floor(s / 86400), h = Math.floor(s / 3600);
    return d >= 2 ? `${d} days left` : h >= 1 ? `${h} hours left` : `${Math.max(1, Math.ceil(s / 60))} minutes left`;
  }
  const NOT_APPROVED = "An admin approves your coin on chain first; your pair must be SOL.";
  /**
   * "the X% fee included", X from the status answer's fee split (the config's figure, src/fees.js); "a fee of about X% included" when
   * the schedule says "about"; without one, no figure.
   */
  const feeNote = (st) => {
    const t = st && st.fees && typeof st.fees.totalText === "string" ? st.fees.totalText : "";
    return !t ? "the price curve's fee included" : t.startsWith("about ") ? `a fee of ${t} included` : `the ${t} fee included`;
  };
  /**
   * "0.25% of every trade, from your coin's price-curve settings and Vicinity's program", the founder's part from the coin's config
   * (founderFees.sharePct), halved between the founder and the holder pot by our program (not a field of the settings, so both are
   * named); "up to 0.25% …" once the coin trades in its pool (shareUpTo: other liquidity takes part of it); without a figure, none.
   */
  const shareNote = (f) => (f && typeof f.sharePct === "string" && f.sharePct ? `${f.shareUpTo === true ? "up to " : ""}${f.sharePct} of every trade, from your coin's price-curve settings and Vicinity's program` : "your share of every trade");
  /** "EZVH…1kSP": an address shortened for the eye. */
  const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : String(a || ""));
  /**
   * Where the launch card's fee figures were read: the price curve the approval names (status answer approval.dbcConfig), then the
   * one rule that is our program's, not the settings' (fees.halves, src/fees.js halvesWords: the founder / holder-pot halving).
   */
  const feesFrom = (st) => {
    const at = st && st.approval && typeof st.approval.dbcConfig === "string" && st.approval.dbcConfig ? ` Read from your approved price-curve settings on Solana (${short(st.approval.dbcConfig)}).` : "";
    const halves = st && st.fees && typeof st.fees.halves === "string" && st.fees.halves ? ` ${st.fees.halves}` : "";
    return `${at}${halves}`;
  };
  /** "HH:MM" in the viewer's own clock ("" when the time is not one): "from the chain at 14:05". */
  function hhmm(isoText) {
    const t = Date.parse(String(isoText || "")); if (!Number.isFinite(t)) return "";
    const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** "14:05" when the time is today in the viewer's own clock, else "14:05 on 19 Oct"; "" when it is not a time. */
  function whenText(isoText, now = Date.now()) {
    const at = hhmm(isoText); if (!at) return "";
    const d = new Date(Date.parse(String(isoText))), today = new Date(now);
    const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    return same ? at : `${at} on ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  /** An exact amount from its raw integer (a decimal string) and the token's decimals: "0.042172807"; null when it is not one. */
  function exactAmount(raw, decimals) {
    const s = typeof raw === "string" ? raw : "";
    if (!/^\d{1,30}$/.test(s) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    const v = BigInt(s), base = 10n ** BigInt(decimals);
    const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${(v / base).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
  }
  /** A Solana address as the answers give one (base58, 32 to 44 characters). */
  const isAddr = (a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  /** A chain slot as the answers give one. */
  const isSlot = (n) => Number.isSafeInteger(n) && n > 0;
  /** A time of the viewer's clock in ms (Date.now()). */
  const isTime = (t) => Number.isSafeInteger(t) && t > 0;
  /**
   * How long after a Collect of a coin in this tab whose outcome the page could not tell, or that landed with no slot given (the
   * viewer's clock time this tab keeps: noteUnclear), the card shows no fee reading of that coin when its status cannot tell an
   * older one; the coin page waits the same (public/coin.js UNCLEAR_MS). The viewer's clock is only ever compared with itself.
   */
  const UNCLEAR_MS = 300000;
  /** Is `now` inside the wait after such a Collect at `unclearAt` (0: none)? A clock moved back past that moment waits too. */
  const unclearWait = (unclearAt, now) => Boolean(unclearAt) && (now < unclearAt || now - unclearAt < UNCLEAR_MS);
  /**
   * What this tab keeps after its Collects (the text under sessionStorage's "lp-collected-slot", or null), parsed defensively:
   * { slots: { mint: chain slot }, unclear: { mint: ms } }; an entry that is not a mint with a slot (a time) is dropped, and text that
   * is not that shape reads as nothing kept. Only this file writes it, always in that shape.
   */
  function keptOf(text) {
    let v = null;
    try { v = JSON.parse(typeof text === "string" && text ? text : "{}"); } catch { v = null; }
    const obj = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : {});
    const part = (o, ok) => { const out = {}; for (const [k, x] of Object.entries(obj(o))) if (isAddr(k) && ok(x)) out[k] = x; return out; };
    return { slots: part(obj(v).slots, isSlot), unclear: part(obj(v).unclear, isTime) };
  }
  /** A wallet as the site's public answers mask it (src/feestatus.js maskWallet): the first 5 and the last 3 characters. */
  const maskOf = (w) => (typeof w === "string" && w.length > 8 ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null);
  /** What still waits outside the vault moves there only when someone runs a harvest (anyone can; nothing runs one on a schedule). */
  const HARVEST_NOTE = "it moves to your fee vault when someone runs a harvest; anyone can, and there is no set time";
  /** Collected is more than earned: what someone sent straight to the fee vault left with a claim (it is never booked as earned). */
  const MORE_THAN_EARNED = "(more than earned: it includes extra someone sent straight to the fee vault)";
  /** "a, b and c". */
  const listText = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] || "");
  /**
   * The coin's founder fee card for a GET /api/fee-status answer `r` and the launched status `st`: { title, readAt, slot, rows: [[label,
   * value, source]] } (source null: no figure on that row), or null (then nothing is shown and the old line stays): an answer that did
   * not come, is about another coin, names a unit the page cannot write or another founder wallet than the one signed in, a status
   * with no wallet, or any account a figure or a sentence rests on that is not an address. Every figure carries the accounts it was
   * read from and the time. The counters are the coin's since launch (after a hand-over they include an earlier founder's: the rows
   * say "this coin's founder" and "since launch").
   * "In your fee vault" is always there, before graduation and after (an exact figure stays whenever its account read cleanly).
   * Before graduation the Collect button first runs harvest_curve_fees when the curve holds the city's fees (src/lplaunch.js
   * founderClaimTx), which books the founder's half into the vault before the claim: "Ready to collect now" is then the vault plus
   * that half. After graduation the button only claims the vault, so "Ready to collect now" is the vault alone; what is still in the
   * pool waits for someone's harvest, and the server may withhold that one estimate (pool.estimate "unavailable": its positions could
   * not all be read), which the card then says instead of a figure. `canCollect`: the card shows the Collect button. Without it no
   * figure above 0 is called ready to collect (the row says it can't be collected from this page right now; the vault's own row
   * still shows it), and what is still in the curve waits for a harvest like any other. "Collected since launch" names payouts too
   * ("Collected or paid out") only when one was paid or the founder agreed to one, and says so when it is more than was earned (what
   * someone sent straight to the fee vault leaves with the next claim and counts as collected, never as earned). After graduation
   * the row of what is still out is "Still in the curve and the pool" while the curve still holds the city's fees or its completion
   * surplus (the figure includes them), else "Still in the pool"; "the pools" when the city also has positions in other pools of the
   * pair.
   */
  function feeCardView(r, st, now = Date.now(), canCollect = true) {
    if (!r || r.ok !== true || !st || !isAddr(st.mint) || !isAddr(st.wallet) || r.mint !== st.mint || !r.coin || !r.coin.quote || !r.founder || !r.pool || !r.source || !r.source.accounts) return null;
    const q = r.coin.quote, f = r.founder, acc = r.source.accounts, at = whenText(r.source.readAt, now), grad = r.coin.graduated;
    if (typeof grad !== "boolean" || !isSlot(r.source.slot) || typeof f.payoutAgreed !== "boolean") return null;
    if (!at || typeof q.symbol !== "string" || !q.symbol || f.wallet !== maskOf(st.wallet)) return null;
    // the estimate of what is still in the curve or the pool: whole, or (after graduation only) withheld with no figure
    const known = r.pool.estimate === "whole", withheld = grad && r.pool.estimate === "unavailable" && f.pendingInPool === null;
    if (!known && !withheld) return null;
    // every account a figure or a sentence below rests on must be an address
    const cited = [acc.coin, acc.founderVault, acc.dbcPool, acc.dbcConfig, acc.payoutOptIn, ...(grad ? [acc.dammPool] : [])];
    if (grad && known) {
      if (!Array.isArray(acc.positions) || acc.positions.length === 0 || !Array.isArray(acc.otherDammPools)) return null;
      cited.push(...acc.positions, ...acc.otherDammPools);
    }
    if (!cited.every(isAddr)) return null;
    if ([f.earned, f.collected, f.paidOut, f.claimable, r.pool.curve, r.pool.surplus, ...(known ? [f.pendingInPool] : [])].some((x) => exactAmount(x, q.decimals) === null)) return null;
    const amt = (raw) => `${exactAmount(raw, q.decimals)} ${q.symbol}`;
    const from = (what) => `from the chain at ${at} · ${what}`;
    const recordName = `coin record ${short(acc.coin)}`, record = from(recordName);
    const vault = `your fee vault ${short(acc.founderVault)}`;
    // the curve's figure includes DBC's completion surplus once the curve is full: that share is worked out from its settings too
    const curve = [`the coin's curve ${short(acc.dbcPool)}`, ...(BigInt(r.pool.surplus) > 0n ? [`its price-curve settings ${short(acc.dbcConfig)}`] : [])];
    // who can take the vault rests on the record's founder and on the payout agreement's address (none there, or one of this wallet)
    const goes = from(f.payoutAgreed ? `${recordName} and payout agreement ${short(acc.payoutOptIn)}` : `${recordName}; no payout agreement for this wallet at ${short(acc.payoutOptIn)}`);
    const paid = BigInt(f.paidOut) > 0n;
    const rows = [
      ["Goes to", `${short(st.wallet)} (${f.payoutAgreed ? "only this wallet can collect, or a payout it agreed to" : "only this wallet can collect"})`, goes],
      ["Earned by this coin's founder since launch", amt(f.earned), record],
      [paid || f.payoutAgreed ? "Collected or paid out since launch" : "Collected since launch", `${amt(f.collected)}${BigInt(f.collected) > BigInt(f.earned) ? ` ${MORE_THAN_EARNED}` : ""}`, record],
    ];
    if (paid) rows.push(["Of that, paid out", `${amt(f.paidOut)} (sent to the payout wallet the founder agreed to)`, record]);
    // what is still outside the vault, with a word on how it moves only when there is something to move
    const waiting = (raw, note) => (BigInt(raw) > 0n ? `${amt(raw)} (${note})` : amt(raw));
    // "Ready to collect now" is what the Collect button on this card moves; with no button, no figure above 0 is called ready
    const ready = (raw, src) => (canCollect || BigInt(raw) === 0n ? [amt(raw), src] : ["can't be collected from this page right now; reload it to try again", null]);
    // the vault, read on its own: shown whenever it read cleanly, with or without a Collect button, before graduation and after
    rows.push(["In your fee vault", amt(f.claimable), from(vault)]);
    if (!grad) {
      const takes = BigInt(r.pool.curve) > 0n; // a Collect harvests first (src/lplaunch.js founderClaimTx)
      rows.push(["Still in the curve", waiting(f.pendingInPool, takes && canCollect ? "the Collect button takes it too" : HARVEST_NOTE), from(listText(curve))]);
      rows.push(["Ready to collect now", ...ready(takes ? String(BigInt(f.claimable) + BigInt(f.pendingInPool)) : f.claimable, from(takes ? listText([vault, ...curve]) : vault))]);
    } else {
      // the curve's fees not harvested yet, or its completion surplus, are in the figure too, and the city's positions in other pools
      // of the pair: the label says so
      const pools = known && acc.otherDammPools.length > 0 ? "the pools" : "the pool";
      const label = BigInt(r.pool.curve) > 0n || BigInt(r.pool.surplus) > 0n ? `Still in the curve and ${pools}` : `Still in ${pools}`;
      if (known) {
        const where = [...curve, `its pool ${short(acc.dammPool)}`, ...acc.otherDammPools.map((p) => `pool ${short(p)}`)];
        where.push(`${acc.positions.length > 1 ? "positions" : "position"} ${acc.positions.map(short).join(", ")}`);
        rows.push([label, waiting(f.pendingInPool, HARVEST_NOTE), from(listText(where))]);
      } else {
        rows.push([label, "can't be worked out right now", null]);
      }
      // after graduation Collect claims the vault alone (it never harvests the pool)
      rows.push(["Ready to collect now", ...ready(f.claimable, from(vault))]);
    }
    return { title: "This coin's founder fees, read from the chain", readAt: r.source.readAt, slot: r.source.slot, rows };
  }
  /**
   * May a fee reading `r` be shown after this page's Collect landed at chain slot `collectedSlot` (0: no Collect yet)? Only when the
   * reading is at that slot or later, so it already shows the money gone. Slots, never clocks: the viewer's clock can be far off the
   * server's. A Collect whose slot is unknown (Infinity) lets no reading through again on this page.
   */
  const freshAfterCollect = (r, collectedSlot) => !collectedSlot || Boolean(r && r.ok === true && r.source && isSlot(r.source.slot) && r.source.slot >= collectedSlot);
  /**
   * May the launched status's own "waiting for you" line (its fee figures `f`, st.founderFees) show after this page's Collect landed
   * at chain slot `collectedSlot` (0: no Collect yet)? Only when the status read them at that slot or later: a node behind the Collect
   * still shows the money that left. No slot to tell, or a Collect whose slot is unknown (Infinity): not on this page.
   */
  const statusFresh = (f, collectedSlot) => Boolean(f) && (!collectedSlot || (isSlot(f.slot) && f.slot >= collectedSlot));
  const isRaw = (x) => typeof x === "string" && /^\d{1,30}$/.test(x);
  /**
   * Can the launched status's own reading `f` (st.founderFees) tell an older fee reading at all? Its vault, its curve and its two
   * Coin-record counters must be figures (src/lplaunch.js founderFees sets the counters to null when the record did not read). No
   * status reading at all (null) tells nothing and hides nothing.
   */
  const statusTells = (f) => !f || [f.inVaultLamports, f.onCurveLamports, f.earnedLamports, f.collectedLamports].every(isRaw);
  /**
   * Is the fee reading `r` older than the launched status's own reading `f` (st.founderFees, no-store, src/lplaunch.js founderFees:
   * the vault, half the curve's creator fee before graduation, the Coin record's counters, all from one answer, and its chain slot)?
   * Either rule hides it:
   *   the counters: the record's founder_accrued (f.earnedLamports) and founder_claimed + founder_paid_out (f.collectedLamports) only
   *   ever grow (launch sets them to 0; a harvest, a claim and a payout add to them; trades do not change them), so a reading with a
   *   lower earned or collected than the status is older than a harvest, a Collect or a payout, whatever its slot says. This is what
   *   catches a reading from before a Collect once a harvest has filled the vault again (a new tab, a reload).
   *   the balances: the vault only shrinks through a claim or a payout, and before graduation the curve's creator fee only through a
   *   harvest: a reading that shows more than the status in either is older than one of them, unless it is at the status's slot or
   *   later (then it is the newer of the two: the vault grew with a harvest or a gift, the curve with trades).
   * Every doubt hides: a figure of either that is not one (a status whose counters did not read: statusTells), or no slot to tell
   * (then any reading that shows more). A status with no fee figures at all (its read failed) tells nothing (false).
   */
  function olderThanStatus(r, f) {
    if (!f) return false;
    if (!statusTells(f)) return true;
    if (!r || r.ok !== true || !r.founder || !r.pool || !r.coin || !r.source) return true;
    if (![r.founder.claimable, r.pool.curve, r.founder.earned, r.founder.collected].every(isRaw)) return true;
    if (BigInt(r.founder.earned) < BigInt(f.earnedLamports) || BigInt(r.founder.collected) < BigInt(f.collectedLamports)) return true;
    const more = BigInt(r.founder.claimable) > BigInt(f.inVaultLamports) || (r.coin.graduated !== true && BigInt(r.pool.curve) / 2n > BigInt(f.onCurveLamports));
    if (!more) return false;
    return !(isSlot(f.slot) && isSlot(r.source.slot) && r.source.slot >= f.slot);
  }
  /** What the card says for a status answer: { state, tag: [text, class], lines: [...], canLaunch }. */
  function view(st, design = null) {
    const s = st && st.ok ? st.state : "error";
    const ticker = st && st.coin && st.coin.symbol ? `$${st.coin.symbol}` : st && st.ticker ? `$${st.ticker}` : "your coin";
    switch (s) {
      case "ready": return { state: s, tag: ["Approved", "tag--gold"], canLaunch: true, lines: [`An admin approved ${ticker}. Launch it whenever you are ready: one signature in your wallet.`] };
      case "launched": return { state: s, tag: ["● Live", "tag--ok"], canLaunch: false, lines: [`${ticker} is live on the Vicinity launchpad.`] };
      case "expired": return { state: s, tag: ["Approval expired", "tag--warn"], canLaunch: false, lines: [st.message || "Your approval expired. Ask an admin to approve your coin again."] };
      case "paused": return { state: s, tag: ["Paused", "tag--warn"], canLaunch: false, lines: [st.message || "Launches are paused for now. Your approval stays; try again later."] };
      case "not_approved": {
        const lines = [st.message || NOT_APPROVED];
        if (design && design.pair && design.pair !== "SOL") lines.push(`Your design is paired with ${design.pair}. Pick SOL in the coin studio and save, then ask an admin to approve it.`);
        if (!design) lines.push("Design your coin first in the coin studio (its name, logo and colour), then ask an admin to approve it.");
        return { state: s, tag: ["Not approved yet", ""], canLaunch: false, lines };
      }
      default: return { state: "error", tag: [st && st.error === "founder_mismatch" ? "Wrong wallet" : "Not available", "tag--warn"], canLaunch: false,
        lines: [(st && st.message) || (window.LP ? window.LP.say(st && st.error, st || undefined) : "Something went wrong. Try again in a minute.")] };
    }
  }
  /**
   * The coin page's graduation box for a /api/lp/graduate/status answer: { action: migrate|leftover|null, title, text, cost, button }.
   * The move's text is short: the curve card right above already says the curve is full and that nobody can trade until the move.
   */
  const MIGRATE_TEXT = "Anyone signed in with a wallet can make the move now.";
  function gradView(g) {
    if (!g || !g.ok) return { action: null, title: null, text: null };
    if (g.canMigrate) return { action: "migrate", title: "Move to the open market", text: MIGRATE_TEXT, cost: g.cost && g.cost.words, button: "Move to the open market" };
    if (g.leftoverDue) return { action: "leftover", title: "One step left", text: g.message, cost: "Only the network fee (about 0.000005 SOL), plus about 0.002 SOL of rent once if the dev wallet has no account for this coin yet.", button: "Return the unsold coins" };
    return { action: null, title: g.stage === "full" ? "Moving to the open market" : null, text: g.stage === "full" ? g.message : null };
  }
  const STATUS = { signing: "Waiting for your wallet…", sending: "Sending…", confirming: "Sent. Waiting for the network to confirm…", done: "Confirmed on the blockchain.",
    // the send's outcome is not known yet (lp-sign.js: the relay's unclear: true, or no answer from the site): watched, never sent twice
    unclear: "Sent, but the network's answer did not come back. Watching the blockchain for it: do not send it again." };
  /** The status line for lp-sign.js's onStatus(state, signature, extra). */
  const statusText = (s, extra) => (s === "confirming" && extra && extra.unclear ? STATUS.unclear : STATUS[s] || s);

  const pure = { parseSol, solText, coinsText, dateText, leftText, feeNote, shareNote, feesFrom, view, gradView, statusText, hhmm, whenText, exactAmount, maskOf, isAddr, feeCardView, freshAfterCollect, statusFresh, olderThanStatus, statusTells, keptOf, unclearWait, UNCLEAR_MS, NOT_APPROVED, STATUS, MIGRATE_TEXT };
  const root = typeof window !== "undefined" ? window : globalThis;
  root.LPLaunch = { pure };
  if (typeof document === "undefined" || !root.V) return; // node: the helpers are enough

  /* =====================================================================
     The page
     ===================================================================== */
  const V = root.V, el = V.el;
  const words = (r) => (r && r.message) || (root.LP ? root.LP.say(r && r.error, r || undefined) : "Something went wrong.");
  const enc = encodeURIComponent;
  let probeMemo = null;
  /**
   * Is the launch switched on here? { on, cluster, ... } or null. /api/official (asked by every page anyway, site.js V.official) says
   * cityCoins only while the settings are there; only then is the probe asked (a site without them sends no request and logs no 404).
   * Asked once per page.
   */
  function probe() {
    if (!probeMemo) {
      probeMemo = Promise.resolve(V.official).then((o) => (o && o.cityCoins ? V.api("/api/lp/launch/status") : null))
        .then((r) => (r && r.ok && r.on ? r : null)).catch(() => null);
    }
    return probeMemo;
  }
  const link = (text, href, external = false) => { const a = el("a", "lp-link", text); a.href = href; if (external) { a.target = "_blank"; a.rel = "noopener"; } return a; };
  function button(label, cls, onClick) {
    const b = el("button", cls, label); b.type = "button";
    b.addEventListener("click", async () => { if (b.disabled) return; b.disabled = true; try { await onClick(b); } finally { if (b.isConnected) b.disabled = false; } });
    return b;
  }
  const fact = (dl, label, value) => { dl.append(el("dt", null, label)); const dd = el("dd"); if (value && typeof value === "object") dd.append(value); else dd.textContent = value == null ? "—" : String(value); dl.append(dd); };
  function netLine(target, cluster) {
    if (!target) return;
    target.hidden = false;
    target.className = `lp-net${cluster === "mainnet" ? " lp-net--main" : ""}`;
    target.textContent = cluster === "mainnet" ? "Solana MAINNET: real SOL" : `Solana ${cluster || "devnet"} (test network): no real money`;
  }

  /* ----- the wallet that signs: the one this account is signed in with ----- */
  /**
   * The wallet of this browser whose address is `expected` (the session's wallet), connected. With several wallets the person picks one
   * in `box`. Throws Error(plain words) when there is none here, or when the connected account is another one.
   */
  async function walletFor(expected, box) {
    const W = root.VW;
    const list = W ? W.list().filter((w) => w.canSign !== false) : [];
    if (!list.length) {
      const phantom = W && W.KNOWN ? W.KNOWN.find((k) => k.id === "phantom") : null;
      const e = new Error(W && W.isMobile ? "No wallet in this browser. Open this page in your wallet app (Phantom) and sign there." : "No wallet found in this browser. Install Phantom (or another Solana wallet that can sign), or open this page in your wallet app.");
      if (phantom && W.isMobile) e.open = phantom.open(location.href);
      throw e;
    }
    const ready = list.find((w) => w.account && w.account.address === expected);
    if (ready) return ready;
    const check = async (w) => {
      const a = await w.connect();
      if (a !== expected) throw new Error(`Your wallet is on ${short(a)}, but you are signed in with ${short(expected)}. Switch accounts in your wallet, then start again.`);
      return w;
    };
    if (list.length === 1) return check(list[0]);
    return new Promise((resolve, reject) => {
      const row = el("div", "lp-wallets");
      row.append(el("p", "small", `Pick the wallet that holds ${short(expected)}:`));
      for (const w of list) row.append(button(`Use ${w.name}`, "btn btn--glass btn--sm", async () => { try { resolve(await check(w)); } catch (e) { reject(e); } }));
      row.append(button("Cancel", "link-btn", () => reject(new Error("Stopped. Nothing was sent."))));
      box.replaceChildren(row);
    });
  }

  /**
   * One signature, in `box`: build through `build(keys)` (the Worker checks and simulates), show the decoded list and the SOL change,
   * then "Approve in your wallet". Resolves to lp-sign.js's result (the confirmed signature, sent by the wallet itself or, for a
   * wallet that only signs, by the site's relay) after `onDone`, or null when it stopped (the reason is on screen). `onUnclear(e)`
   * runs, before that null, when it went out and may have landed but this page cannot tell (not confirmed in time, the wallet's
   * or the relay's send with no answer to follow): never when the chain said it failed or ran out of time (nothing moved then).
   */
  const NOT_LANDED = new Set(["failed", "expired"]); // lp-sign.js: the chain's own answer, so its outcome is known
  async function runStep(box, { expected, cluster, ephemeral = 0, build, approve = "Approve in your wallet", onDone, onUnclear }) {
    box.replaceChildren(el("p", "muted small", "Preparing: the site builds this transaction and tries it on the blockchain first. Nothing is sent yet."));
    let h;
    try {
      if (ephemeral && !(await root.LP.supported())) throw new Error(root.LP.say("unsupported"));
      const wallet = await walletFor(expected, box);
      box.replaceChildren(el("p", "muted small", "Preparing: the site builds this transaction and tries it on the blockchain first. Nothing is sent yet."));
      h = await root.LP.prepare({ wallet, ephemeral, cluster, build });
    } catch (e) {
      const p = el("p", "lp-error", e && e.message ? e.message : "This could not be prepared. Nothing was sent.");
      box.replaceChildren(p);
      if (e && e.open) box.append(link("Open in Phantom", e.open));
      return null;
    }
    const sum = el("div", "lp-sum");
    root.LP.renderSummary(sum, h.response);
    const line = el("p", "lp-status"); line.setAttribute("role", "status");
    return new Promise((resolve) => {
      const cancel = button("Cancel", "btn btn--glass btn--sm", () => { box.replaceChildren(el("p", "muted small", "Stopped. Nothing was sent.")); resolve(null); });
      const go = button(approve, "btn btn--primary", async () => {
        cancel.disabled = true;
        try {
          const r = await h.sign({ onStatus: (s, _sig, extra) => { line.textContent = statusText(s, extra); } });
          go.remove(); cancel.remove();
          if (r.solscan) line.append(" ", link("See it on Solscan", r.solscan, true));
          if (onDone) await onDone(r, h.response);
          resolve(r);
        } catch (e) {
          line.textContent = e && e.message ? e.message : "Something went wrong. Nothing was sent.";
          if (e && e.signature && e.solscan) line.append(" ", link("Check it on Solscan", e.solscan, true));
          cancel.disabled = false;
          // it may have landed, or gone out with no id to watch (lp-sign.js `unclear`): never offer to send it twice, and no Cancel
          // that would put "Stopped. Nothing was sent." over these words
          if (e && (e.signature || e.unclear)) {
            go.remove(); cancel.remove();
            if (onUnclear && !NOT_LANDED.has(e.code)) { try { await onUnclear(e); } catch { /* the words above stay */ } }
            resolve(null);
          }
        }
      });
      const row = el("div", "lp-row"); row.append(go, cancel);
      box.replaceChildren(sum, row, line);
      try { go.focus(); } catch { /* not on screen yet */ }
    });
  }

  /* =====================================================================
     The founder card (dashboard)
     ===================================================================== */
  /** Record the launched coin on the site (it reads the chain; a few tries while the network settles). */
  async function record(cityId) {
    for (let i = 0; i < 6; i++) {
      const r = await V.api("/api/lp/record", { cityId: String(cityId) });
      if (r && r.ok) return r;
      if (!r || !["not_launched", "rpc_unavailable", "offline", "unavailable"].includes(r.error)) return r;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    return null;
  }

  /**
   * Fill `card` (#lp-launch: [data-lp-state], [data-lp-net], [data-lp-body]) for the signed-in founder of `cityId`. { on, state }.
   * `onChange(result)` runs after the card refreshed itself because something landed (a launch, a fee collection), or because the
   * browser brought the page back from its back/forward cache while the card showed a launched coin (restored).
   */
  async function founder(card, opts = {}) {
    const { cityId, design = null } = opts;
    restored.delete(card);
    const p = await probe();
    if (!p) { card.hidden = true; return { on: false }; }
    const body = card.querySelector("[data-lp-body]"), tag = card.querySelector("[data-lp-state]");
    const st = await V.api(`/api/lp/launch/status?city=${enc(cityId)}&cluster=${enc(p.cluster)}`);
    if (st && st.error === "not_enabled") { card.hidden = true; return { on: false }; }
    card.hidden = false;
    netLine(card.querySelector("[data-lp-net]"), p.cluster);
    const v = view(st, design);
    tag.textContent = v.tag[0]; tag.className = `tag ${v.tag[1]}`.trim();
    const title = card.querySelector("h2");
    if (title) title.textContent = v.state === "launched" ? "Your city coin" : "Launch your city coin";
    body.replaceChildren(...v.lines.map((t) => el("p", v.state === "error" ? "lp-error" : "small", t)));
    const again = async () => { const r = await founder(card, opts); if (typeof opts.onChange === "function") opts.onChange(r); return r; };
    if (v.state === "ready") readyView(body, st, p, again);
    else if (v.state === "launched") restored.set(card, { ...launchedView(body, st, p, again), again });
    return { on: true, state: v.state };
  }
  /**
   * The launched cards on this page, for the page the browser brings back from its back/forward cache (Back or Forward in this
   * tab): it comes back as it was left, with figures from before whatever the tab did meanwhile, a Collect of the coin on a later
   * dashboard page among them (its slot, or the moment of one whose outcome that page could not tell, is in this tab's
   * sessionStorage). Then each card takes off at once what such a Collect made old (its fee figures, the old line and the Collect
   * button) and reads the chain again (founder, as after a Collect here); not a card whose own Collect ended with an outcome it could
   * not tell (its words say what to check, and the button stays away until a reload).
   */
  const restored = new Map();
  if (typeof root.addEventListener === "function") {
    root.addEventListener("pageshow", (e) => {
      if (!e || !e.persisted) return;
      for (const [card, r] of [...restored]) {
        if (!card.isConnected) { restored.delete(card); continue; }
        r.hush();
        if (r.held()) continue;
        restored.delete(card);
        Promise.resolve().then(r.again).catch(() => { /* the card keeps what hush left; the next visit reads afresh */ });
      }
    });
  }

  function readyView(body, st, p, again) {
    const ticker = `$${st.coin.symbol}`;
    const head = el("p", "lp-coin");
    head.append(el("strong", "lp-coin__name", st.coin.name), " ", el("span", "lp-coin__tk", ticker), " ", el("span", "muted", "· paired with SOL"));
    const dl = el("dl", "lp-facts");
    if (st.fees && st.fees.words) fact(dl, "Fees", `${st.fees.words}${feesFrom(st)}`); // the config's own figures and where they were read; none when it was not read
    fact(dl, "Approved until", `${dateText(st.approval.expiresAt)} (${leftText(st.approval.secondsLeft)})`);
    fact(dl, "What it costs you", st.cost.words);
    fact(dl, "Your wallet", short(st.wallet));
    body.append(head, dl);
    // the optional first buy, with its exact quote (the curve's start is fixed, so the quote is exact)
    let buy = { lamports: "0" };
    const quote = el("p", "small lp-quote"); quote.setAttribute("role", "status");
    if (st.firstBuy && st.firstBuy.allowed) {
      const label = el("label", "lp-buy");
      const input = el("input", "field lp-buy__input");
      input.setAttribute("type", "text"); input.setAttribute("inputmode", "decimal"); input.setAttribute("autocomplete", "off"); input.placeholder = "0";
      label.append(el("span", null, `Buy some ${ticker} right away (optional, up to 10 SOL)`), input);
      body.append(label, quote);
      let seq = 0, timer = 0;
      input.addEventListener("input", () => {
        clearTimeout(timer);
        const mine = ++seq;
        buy = parseSol(input.value);
        if (!buy) { quote.textContent = "Type an amount of SOL, like 0.5."; return; }
        if (buy.tooLarge) { quote.textContent = "The first buy is at most 10 SOL."; return; }
        if (buy.lamports === "0") { quote.textContent = ""; return; }
        quote.textContent = "Working out the exact amount…";
        timer = setTimeout(async () => {
          const r = await V.api(`/api/lp/launch/status?city=${enc(st.cityId)}&cluster=${enc(p.cluster)}&buy=${enc(buy.lamports)}&slippageBps=${FIRST_BUY_SLIPPAGE_BPS}`);
          if (mine !== seq) return; // a newer amount was typed meanwhile
          // the fee named is the config's (the status answer's fees come from src/fees.js), never a literal
          if (r && r.ok && r.quote) quote.textContent = `You get exactly ${coinsText(r.quote.coinsOutUi)} ${ticker} for ${solText(r.quote.amountInLamports)} (${feeNote(st)}), in the same transaction as the launch.`;
          else quote.textContent = (r && (r.quoteError || r.message)) || words(r);
        }, 400);
      });
    } else if (st.firstBuy && st.firstBuy.reason) body.append(el("p", "small muted", st.firstBuy.reason));
    const flow = el("div", "lp-flow");
    const go = button(`Launch ${ticker}`, "btn btn--primary lp-go", async () => {
      if (!buy) { quote.textContent = "Type an amount of SOL, like 0.5, or leave it empty."; return; }
      if (buy.tooLarge) { quote.textContent = "The first buy is at most 10 SOL."; return; }
      go.hidden = true;
      const r = await runStep(flow, {
        expected: st.wallet, cluster: p.cluster, ephemeral: 1, approve: `Approve the launch in your wallet`,
        build: (keys) => V.api("/api/lp/launch/tx", { cityId: st.cityId, cluster: p.cluster, mint: keys[0], firstBuyLamports: buy.lamports, slippageBps: FIRST_BUY_SLIPPAGE_BPS }),
        onDone: async () => {
          flow.append(el("p", "lp-status", "Your coin is live. Recording it on vicinity.city…"));
          const rec = await record(st.cityId);
          if (V.toast) V.toast(`${ticker} is live`);
          await again();
          if (!rec || !rec.ok) body.append(el("p", "small muted", "vicinity.city records it by itself within 30 minutes."));
        },
      });
      if (!r) go.hidden = false;
    });
    body.append(go, flow);
  }

  function launchedView(body, st, p, again) {
    // the chain's symbol, else the city's ticker (the launched status names it as `ticker`); never "Your coin Your coin is live."
    const sym = (st.coin && st.coin.symbol) || st.ticker || null;
    body.replaceChildren(el("p", "lp-live", sym ? `Your coin $${sym} is live.` : "Your coin is live."));
    const mint = el("p", "small mono lp-addr", st.mint);
    const links = el("p", "lp-links");
    links.append(link("Open your coin's page", st.coinPage), " · ", link("See it on Solscan", st.explorer, true));
    body.append(mint, links);
    const f = st.founderFees;
    if (!st.yours) { body.append(el("p", "small muted", "The coin's founder on chain is another wallet, so its founder fees are not collected from here.")); return { hush() {}, held: () => false }; }
    // the founder's part of every trade is the coin's config's figure (src/fees.js through the status answer), never a literal; not
    // shown when the status read it before this tab's last Collect of the coin landed (statusFresh)
    const line = f ? el("p", "small", `Your founder fees: ${solText(f.totalLamports)} waiting for you (${shareNote(f)}).`) : null;
    if (line) { line.hidden = !statusFresh(f, collectedSlot(st.mint)); body.append(line); }
    // the fees read from the chain (GET /api/fee-status): hidden until that answer is here, and for good when it fails; while shown,
    // its figures replace the line above (one set of numbers on the card)
    const fees = el("div", "lp-fees"); fees.hidden = true;
    body.append(fees);
    const canCollect = Boolean(f) && BigInt(f.totalLamports || "0") > 0n;
    feeCard(fees, st, line, canCollect);
    // what this tab knew of its Collects of the coin when the card was drawn: on a page the browser brings back, a change means one
    // landed (or may have) on a later page of this tab, and everything on the card from before it goes at once (restored)
    const noted = () => { const k = keptOf(readKept()); return `${k.slots[st.mint] || 0}:${k.unclear[st.mint] || 0}`; };
    const seen = noted();
    let go = null, unclear = false;
    const kept = {
      hush() { if (noted() === seen) return; fees.hidden = true; fees.replaceChildren(); if (line) line.hidden = true; if (go) go.hidden = true; },
      held: () => unclear,
    };
    if (!f) return kept;
    if (canCollect) {
      const flow = el("div", "lp-flow");
      // the figures on the card are from before the claim: gone at once; readings before `slot` still show the money that left
      const gone = (slot) => { fees.hidden = true; fees.replaceChildren(); if (line) line.hidden = true; noteCollected(st.mint, slot); };
      go = button("Collect your fees", "btn btn--glass btn--sm", async () => {
        go.hidden = true;
        const r = await runStep(flow, {
          expected: st.wallet, cluster: p.cluster, approve: "Approve in your wallet",
          build: () => V.api("/api/lp/founder-claim/tx", { cityId: st.cityId, cluster: p.cluster }),
          onDone: async (done) => {
            // the slot the claim landed in (lp-sign.js, from the status answer); gone before the status round-trip below. With no slot
            // to tell a reading after it, this tab keeps the moment for the coin page, which then waits as after an unclear Collect
            const slot = done && isSlot(done.slot) ? done.slot : Infinity;
            gone(slot);
            if (slot === Infinity) noteUnclear(st.mint, Date.now());
            if (V.toast) V.toast("Fees collected");
            await again();
          },
          // it may have landed and this page cannot tell: the figures from before it go as for a landed one, no reading is shown
          // again on this page (a reload reads the chain afresh and the status's counters tell a reading from before it), the button
          // stays away (the words on screen say to check first), and this tab keeps the moment for the coin page (noteUnclear)
          onUnclear: () => { unclear = true; gone(Infinity); noteUnclear(st.mint, Date.now()); },
        });
        if (!r && !unclear) go.hidden = false;
      });
      body.append(go, flow);
    }
    return kept;
  }

  /**
   * The chain slot of this tab's last Collect of each coin (freshAfterCollect), by mint: 0 before any, Infinity when the status did
   * not give the slot (then no reading is shown again on this page). A known slot is kept in this tab's sessionStorage too, so a reload
   * or the dashboard opened again in this tab keeps the rule; a private window that refuses storage keeps it for the page alone.
   * The same key keeps, by mint, the viewer's clock time of a Collect whose outcome this page could not tell (noteUnclear), or of one
   * that landed with no slot given: the coin page (public/coin.js soFarView) shows no "Fees so far" of that coin for 5 minutes after
   * it, and feeCard no reading of it then when the status cannot tell an older one. One shape, read and written here
   * only: { slots: { mint: chain slot }, unclear: { mint: ms } }, at most KEEP coins in each.
   */
  const collected = new Map();
  const COLLECTED_KEY = "lp-collected-slot";
  const KEEP = 20;
  function readKept() {
    try { return root.sessionStorage.getItem(COLLECTED_KEY); } catch { return null; } // storage refused: nothing kept
  }
  function writeKept(k) {
    // a few coins at most in each: the oldest notes go first (a note is moved to the end when it is written again)
    const cap = (o) => { const keys = Object.keys(o); for (const x of keys.slice(0, Math.max(0, keys.length - KEEP))) delete o[x]; return o; };
    try { root.sessionStorage.setItem(COLLECTED_KEY, JSON.stringify({ slots: cap(k.slots), unclear: cap(k.unclear) })); } catch { /* storage refused: this page's memory only */ }
  }
  function collectedSlot(mint) {
    return Math.max(collected.get(mint) || 0, keptOf(readKept()).slots[mint] || 0);
  }
  function noteCollected(mint, slot) {
    const n = isSlot(slot) ? slot : Infinity;
    collected.set(mint, Math.max(collected.get(mint) || 0, n));
    if (n === Infinity) return;
    const k = keptOf(readKept());
    const was = k.slots[mint] || 0;
    delete k.slots[mint];
    k.slots[mint] = Math.max(was, n); // only chain slots go here
    writeKept(k);
  }
  /** A Collect of `mint` whose outcome this page cannot tell, at the viewer's clock time `at`: kept for the coin page, in this tab. */
  function noteUnclear(mint, at) {
    if (!isTime(at)) return;
    const k = keptOf(readKept());
    delete k.unclear[mint];
    k.unclear[mint] = at; // only the viewer's clock times go here
    writeKept(k);
  }
  const FEE_RETRY_MS = 30000, FEE_RETRIES = 8;
  /**
   * The fee boxes drawn on this page, each with how to draw its time words again ("14:05", or "14:05 on 19 Oct" once it is not
   * today): when the tab is seen again (visibilitychange), since a card is not redrawn on a timer and a day may have passed.
   */
  const redraws = new Map();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") return;
    for (const [box, redraw] of [...redraws]) { if (!box.isConnected) redraws.delete(box); else redraw(); }
  });
  /**
   * Fill `box` with the founder's fees read from the chain (feeCardView) and hide `line` (the old "waiting for you" figure), or leave
   * the box hidden and empty and the line shown (unless the status read it before this tab's last Collect of the coin: statusFresh).
   * A reading older than money known to have left is not shown: older than this tab's last Collect of the coin (by chain slot), or
   * than the launched status `st` read just now (olderThanStatus: the fee answer is kept up to a minute at the edge and a minute per
   * server, so a new tab or a reload could otherwise show a figure from before a Collect). The box then waits and asks again every
   * 30 seconds while it is on the page, at most FEE_RETRIES times, until a reading has caught up; not when nothing can ever pass on
   * this page (a Collect whose slot is unknown, or a status whose figures cannot tell: statusTells).
   * When the status cannot tell an older reading (its fee read failed, or its counters did not read) and this tab kept the moment of
   * a Collect of the coin whose outcome the page could not tell, or that landed with no slot given (noteUnclear: no slot to tell a
   * reading by), no reading is shown within the coin page's wait after it (unclearWait, by the viewer's clock against itself), and
   * nothing is asked again on this page: any of them may be the copy from before that Collect. A reload after the wait reads afresh.
   */
  async function feeCard(box, st, line = null, canCollect = true, tries = 0) {
    const r = await V.api(`/api/fee-status?mint=${enc(st.mint)}`);
    // the status's own line instead, unless the status read it before this tab's last Collect of the coin landed
    const hide = () => { redraws.delete(box); box.hidden = true; box.replaceChildren(); if (line) line.hidden = !statusFresh(st.founderFees, collectedSlot(st.mint)); };
    const after = collectedSlot(st.mint);
    const blind = (!st.founderFees || !statusTells(st.founderFees)) && unclearWait(keptOf(readKept()).unclear[st.mint] || 0, Date.now());
    if (blind || !freshAfterCollect(r, after) || olderThanStatus(r, st.founderFees)) {
      hide();
      const older = !blind && r && r.ok === true && after !== Infinity && statusTells(st.founderFees);
      if (older && tries < FEE_RETRIES) setTimeout(() => { if (box.isConnected) feeCard(box, st, line, canCollect, tries + 1); }, FEE_RETRY_MS);
      return null;
    }
    const v = feeCardView(r, st, Date.now(), canCollect);
    if (!v) { hide(); return null; }
    const dl = el("dl", "lp-facts"), spans = [];
    for (const [label, value, src] of v.rows) {
      dl.append(el("dt", null, label));
      const dd = el("dd");
      dd.append(el("span", "lp-fees__val", value));
      const from = src ? el("span", "lp-fees__src", src) : null;
      if (from) {
        from.setAttribute("title", `Read from the chain at ${v.readAt}`);
        dd.append(" ", from);
      }
      spans.push(from);
      dl.append(dd);
    }
    box.replaceChildren(el("p", "lp-fees__title", v.title), dl);
    box.hidden = false;
    if (line) line.hidden = true;
    // the same reading's words with the time worked out again; nothing when the figures went meanwhile (a Collect)
    redraws.set(box, () => {
      if (box.hidden || !dl.isConnected) return;
      const w = feeCardView(r, st, Date.now(), canCollect);
      if (w) w.rows.forEach(([, , src], i) => { if (src && spans[i]) spans[i].textContent = src; });
    });
    return v;
  }

  /* =====================================================================
     "Move to the open market" (coin page)
     ===================================================================== */
  /** Fill `box` ([data-lp-grad-title], [data-lp-grad-text], [data-lp-grad-body]) for a launchpad coin; hidden when there is nothing to do. */
  async function graduate(box, { mint, ticker = null } = {}) {
    const p = await probe();
    if (!p) { box.hidden = true; return null; }
    const g = await V.api(`/api/lp/graduate/status?mint=${enc(mint)}&cluster=${enc(p.cluster)}`);
    const v = gradView(g);
    const title = box.querySelector("[data-lp-grad-title]"), text = box.querySelector("[data-lp-grad-text]"), body = box.querySelector("[data-lp-grad-body]");
    if (!v.title) { box.hidden = true; return g; }
    box.hidden = false;
    title.textContent = v.title; text.textContent = v.text || "";
    body.replaceChildren();
    if (!v.action) return g;
    body.append(el("p", "small muted", `Cost: ${v.cost}`));
    const flow = el("div", "lp-flow");
    const go = button(v.button, v.action === "migrate" ? "btn btn--primary" : "btn btn--glass", async () => {
      const me = await V.api("/api/me?lite=1"); // asked on the tap: signed in a moment ago in another tab counts
      if (!me || !me.signedIn) { flow.replaceChildren(el("p", "small", "Sign in with your wallet first: the wallet you signed in with pays."), link("Sign in", `/connect?mode=login&next=${enc(location.pathname + location.search)}`)); return; }
      if (!me.user || !me.user.wallet) { flow.replaceChildren(el("p", "small", "Link a wallet to your account first (Dashboard, Home): that wallet pays."), link("Go to the dashboard", "/dashboard#wallet-card")); return; }
      go.hidden = true;
      const r = await runStep(flow, {
        expected: me.user.wallet, cluster: p.cluster, ephemeral: v.action === "migrate" ? 2 : 0,
        approve: v.action === "migrate" ? "Approve the move in your wallet" : "Approve in your wallet",
        build: (keys) => V.api("/api/lp/graduate/tx", { mint, cluster: p.cluster, step: v.action, ...(v.action === "migrate" ? { nft1: keys[0], nft2: keys[1] } : {}) }),
        onDone: async () => { if (V.toast) V.toast(v.action === "migrate" ? `${ticker ? `$${ticker}` : "The coin"} is on the open market` : "Done"); await graduate(box, { mint, ticker }); },
      });
      if (!r) go.hidden = false;
    });
    body.append(go, flow);
    return g;
  }

  Object.assign(root.LPLaunch, { probe, founder, graduate, _walletFor: walletFor, _runStep: runStep });
})();
