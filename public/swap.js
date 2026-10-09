// The swap panel: buy $VICINITY, sell it, or swap any pair Jupiter can route, right here, signed in your own wallet. Lives on
// /token (Buy $VICINITY), the dashboard's Buy & swap card, /coin and the Launchpad cards (as a bottom sheet). Everything goes
// through this site's /api/swap/* (and /api/launchpad/trade/* for a city coin still on its bonding curve); the page never talks to
// Jupiter or a blockchain node itself, never needs a login, and never sees a key: the connected wallet signs the transaction the
// Worker built, and sends it itself ("solana:signAndSendTransaction") or hands the signed bytes to our relay.
//   window.VSwap = { mount(el, opts), open(opts), refresh() }; every element with data-swap mounts itself
//   (data-in / data-out = mints or "SOL"; data-mode = buy | trade | swap; data-title).
// Needs window.V (site.js) and window.VW (wallets.js). Nothing here runs when the switch is off (/api/official has no swap key).
(() => {
  "use strict";
  if (typeof window === "undefined" || !window.V) return;
  const { $, $$, el, api, toast, copy, burst, isAddr } = window.V;
  const W = () => window.VW;
  const SOL = "So11111111111111111111111111111111111111112", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const KEEP_SOL = 0.01; // MAX keeps this much SOL for fees and rent
  const QUOTE_MS = 450, REFRESH_MS = 12_000, POLL_MS = 2_000, POLL_MAX_MS = 90_000;
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  /** Bytes to base58 (a signature, 64 bytes). */
  function base58(bytes) {
    const digits = [0];
    for (const b of bytes) { let carry = b; for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; } while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; } }
    let out = ""; for (const b of bytes) { if (b === 0) out += "1"; else break; }
    for (let i = digits.length - 1; i >= 0; i--) if (!(i === digits.length - 1 && digits[i] === 0 && digits.length > 1)) out += B58[digits[i]];
    return out;
  }
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (b) => btoa(String.fromCharCode(...b));
  /** A token amount by magnitude: thousands get 2 decimals (178,332.44 fits a phone), units up to 4, fractions 6 significant digits (0.00474993, 0.000005). */
  const num = (v, max = 6) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    return a >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : a >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: Math.min(max, 4) }) : n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
  };
  const usd = (v) => (v == null ? "" : v >= 1000 ? "$" + Math.round(v).toLocaleString("en-US") : v >= 1 ? "$" + v.toFixed(2) : "$" + Number(v.toPrecision(3)));
  const sol = (lamports) => num(Number(lamports || 0) / 1e9, 6);
  /**
   * Did the build the wallet is about to sign come out WORSE than the quote on the screen? By the raw amounts (more than 0.5 %
   * less out, or a lower minimum) or by the price impact crossing the 3 % / 10 % lines. A better price never stops anyone.
   */
  function worseThan(prev, next) {
    if (!prev || !next) return null;
    const drop = (a, b) => { try { const A = BigInt(a), B = BigInt(b); return A > 0n ? Number(((A - B) * 10000n) / A) / 100 : 0; } catch { return 0; } };
    const impactOf = (q) => { const v = q && q.priceImpactPct != null ? Number(q.priceImpactPct) : 0; return Number.isFinite(v) ? v : 0; };
    const band = (v) => (v > 10 ? 2 : v > 3 ? 1 : 0);
    const outDrop = drop(prev.outAmount, next.outAmount), minDrop = drop(prev.minOut, next.minOut), crossed = band(impactOf(next)) > band(impactOf(prev));
    return { worse: outDrop > 0.5 || minDrop > 0.5 || crossed, outDrop, minDrop, crossed };
  }
  const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "");
  const COLORS = { [SOL]: "#9945FF", [USDC]: "#2775CA", [USDT]: "#26A17B" };

  /** Plain words for every code the routes or a wallet can answer with. */
  const WORDS = {
    rejected: "Cancelled in your wallet. Nothing was sent.",
    insufficient_sol: "Not enough SOL for this plus the network fee, the priority fee (up to 0.01 SOL) and about 0.002 SOL of rent for each token account that does not exist yet.",
    insufficient_balance: "You do not hold that much of this token.",
    slippage: "The price moved more than your slippage allows. Nothing was spent. Try again or raise slippage.",
    expired: "The network didn't include it in time. Nothing was spent. Try again.",
    blockhash_expired: "The network didn't include it in time. Nothing was spent. Try again.",
    unconfirmed: "We could not confirm it in time. Open the Solscan link or check your wallet: if it went through, your balance already shows it; if not, nothing was spent.",
    bad_ticket: "This transaction was not built here, or its ticket expired. Press Swap again.",
    misconfigured: "Curve trading is paused: a setting on our side does not match. Nothing was sent.",
    no_route: "No market can trade this pair right now.",
    jupiter_busy: "The price service is busy. Try again in a few seconds.",
    jupiter_unavailable: "The price service could not be reached. Try again in a minute.",
    jupiter_refused: "The price service sent something unexpected, so nothing was built. Try again in a minute.",
    rpc_unavailable: "The blockchain is busy. Try again in a minute.",
    rpc_busy: "The blockchain is busy. Try again in a minute.",
    tx_too_large: "This route is too big for one transaction: try a smaller amount.",
    amount_too_small: "That amount is too small to trade.",
    amount_too_large: "That amount is more than this market can take right now.",
    unknown_token: "That address is not a token.",
    bad_wallet: "That wallet address is not a person's wallet.",
    slow_down: "Too many tries from your network right now. Wait a minute and try again.",
    curve_full: "The curve is full and waiting for graduation. Trading resumes on the pool.",
    stage_graduated: "This coin has graduated: it trades on a pool now.",
    curve_not_found: "This coin is not listed for trading here.",
    curve_quote_only: "This coin is still on its bonding curve: it trades against its own pair token only.",
    needs_v0: "This route needs a version-0 transaction, which this wallet does not support here. Update the wallet, or use one that supports version-0 transactions.",
    not_enabled: "Swapping is switched off right now.",
    rejected_by_network: "The network refused this transaction. Nothing was spent.",
    program_error: "The market refused this trade. Nothing was spent.",
    alt_mismatch: "The route's account table did not match the chain, so nothing was built. Try again.",
    alt_missing: "The route's account table was not found on the chain, so nothing was built. Try again.",
    swap_unavailable: "Swapping is not available right now. Try again in a minute.",
    bad_origin: "Please open vicinity.city directly and try again.",
    wallet_devnet: "Switch your wallet to devnet for this test coin.",
    no_send: "This wallet can sign messages here but not transactions: open this page in Phantom, Solflare or Backpack.",
  };
  const words = (d) => (d && d.error === "program_error" && d.name ? `The market refused this trade (${d.name}). Nothing was spent.` : WORDS[d && d.error] || WORDS[d] || "Something went wrong. Nothing was spent. Try again.");
  const isReject = (e) => /reject|cancel|denied|declin|closed|dismiss/i.test(String((e && (e.message || e.code)) || e));

  /* ---------------------------------------------------------------- shared: the config, the connected wallet */
  let configP = null, config = null;
  const loadConfig = () => (configP ||= api("/api/swap/config").then((c) => (config = c && c.ok ? c : null)).catch(() => (config = null)));
  const tokenOf = (mint) => (config && config.tokens.find((t) => t.mint === mint)) || null;
  const symbolOf = (mint, fallback) => { const t = tokenOf(mint); return t ? (t.kind === "vicinity" ? "$VICINITY" : t.kind === "city" ? `$${(t.symbol || t.name || "COIN").toUpperCase().replace(/^\$/, "")}` : t.symbol) : fallback || shortAddr(mint); };
  const decimalsOf = (mint) => { const t = tokenOf(mint); return t ? t.decimals : 6; };
  const wallet = { adapter: null, address: null, listeners: new Set() };
  const onWallet = (f) => { wallet.listeners.add(f); return () => wallet.listeners.delete(f); };
  let helpIds = 0;
  function setWallet(adapter, address) { wallet.adapter = adapter; wallet.address = address; for (const f of wallet.listeners) { try { f(); } catch { /* one panel's trouble is its own */ } } }
  const panels = new Set();

  /** A coloured mark with the token's first letter (no outside images: the security policy allows only this site). */
  function mark(mint, label) {
    const s = el("span", "swap__mark", (label || "?").replace(/^\$/, "")[0].toUpperCase());
    const t = tokenOf(mint);
    s.style.background = COLORS[mint] || (t && t.kind === "vicinity" ? "linear-gradient(135deg,#FF5A36,#FFC857)" : t && t.kind === "city" ? "#5B8CFF" : "#445");
    return s;
  }

  /* ---------------------------------------------------------------- one panel */
  class Panel {
    constructor(root, opts = {}) {
      this.root = root; root.classList.add("swap"); root.setAttribute("data-swap-mounted", "1");
      this.mode = opts.mode || root.dataset.mode || "buy";
      this.fixedOut = this.mode === "buy" ? (opts.out || root.dataset.out || null) : null;
      this.s = {
        in: norm(opts.in || root.dataset.in || "SOL"), out: norm(opts.out || root.dataset.out || null), amount: "", slippage: 100, phase: "idle",
        quote: null, curve: null, error: null, sig: null, lvbh: null, cluster: "mainnet", chain: "solana:mainnet", understood: false, balances: null, picker: null, search: "", found: [],
      };
      this.title = opts.title || root.dataset.title || (this.mode === "buy" ? `Buy ${symbolOf(this.s.out, "this coin")}` : "Swap");
      this.timer = 0; this.refresh = 0; this.abort = null; this.poll = 0; this.seq = 0; this.dead = false;
      this.build(); this.render();
      this.offWallet = onWallet(() => { this.render(); this.loadBalances(); if (this.s.amount && ["quoted", "failed", "idle"].includes(this.s.phase)) { this.phase("quoting"); this.quote(); } });
      panels.add(this);
      if (!this.s.out && config) this.s.out = config.tokens.find((t) => t.kind === "vicinity")?.mint || null;
      this.loadBalances();
    }
    /** Retire the panel: timers, the in-flight quote, the status poll, the wallet and visibility listeners (a sheet opened on five cards leaves no five live panels behind). */
    destroy() {
      if (this.dead) return;
      this.dead = true;
      clearTimeout(this.timer); clearTimeout(this.refresh); clearTimeout(this.poll);
      if (this.abort) { this.abort.abort(); this.abort = null; }
      this.seq++; this.s.sig = null;
      if (this.offWallet) this.offWallet();
      document.removeEventListener("visibilitychange", this.onVisibility);
      panels.delete(this);
      if (this.root && this.root._swap === this) this.root._swap = null;
    }
    /* ----- markup ----- */
    build() {
      const r = this.root; r.replaceChildren();
      const head = el("div", "swap__head");
      head.append(el("p", "kicker swap__title", this.title), (this.state = el("span", "tag swap__state", "Ready")));
      const box = el("div", "swap__box");
      const row = (label, which) => {
        const d = el("div", `swap__row swap__row--${which}`);
        const lab = el("span", "swap__label", label);
        const line = el("div", "swap__line");
        let amt;
        if (which === "in") { amt = el("input", "swap__amt"); amt.inputMode = "decimal"; amt.autocomplete = "off"; amt.placeholder = "0.0"; amt.setAttribute("aria-label", "Amount to pay"); }
        else { amt = el("output", "swap__amt swap__amt--out", "—"); amt.setAttribute("aria-label", "Amount you get"); }
        const tok = el("button", "swap__token"); tok.type = "button"; tok.setAttribute("aria-haspopup", "listbox");
        line.append(amt, tok);
        const sub = el("div", "swap__sub");
        const usdEl = el("span", "swap__usd", "");
        sub.append(usdEl);
        if (which === "in") { const mx = el("button", "link-btn swap__max", "MAX"); mx.type = "button"; mx.hidden = true; sub.append(mx); this.maxBtn = mx; mx.addEventListener("click", () => this.setMax()); }
        else { const bal = el("span", "swap__bal", ""); sub.append(bal); this.outBal = bal; }
        d.append(lab, line, sub);
        this[which === "in" ? "inAmt" : "outAmt"] = amt; this[which === "in" ? "inTok" : "outTok"] = tok; this[which === "in" ? "inUsd" : "outUsd"] = usdEl; this[which === "in" ? "inLabel" : "outLabel"] = lab;
        tok.addEventListener("click", () => this.openPicker(which));
        return d;
      };
      const flip = el("button", "swap__flip", "⇅"); flip.type = "button"; flip.setAttribute("aria-label", "Switch direction");
      flip.addEventListener("click", () => this.flip());
      box.append(row("You pay", "in"), flip, row("You get", "out"));
      this.flipBtn = flip;
      // slippage
      const slip = el("div", "swap__slip");
      slip.append(el("span", "swap__slip-label", "Slippage"));
      for (const [bps, text] of [[50, "0.5%"], [100, "1%"], [300, "3%"]]) { const b = el("button", "swap__chip", text); b.type = "button"; b.dataset.bps = String(bps); b.addEventListener("click", () => this.setSlippage(bps)); slip.append(b); }
      const custom = el("input", "swap__chip swap__chip--custom"); custom.inputMode = "decimal"; custom.placeholder = "custom %"; custom.setAttribute("aria-label", "Custom slippage in percent"); custom.maxLength = 5;
      custom.addEventListener("change", () => { const p = Number(String(custom.value).replace(",", ".")); if (Number.isFinite(p) && p > 0) this.setSlippage(Math.min(5000, Math.max(1, Math.round(p * 100)))); else custom.value = ""; });
      slip.append(custom); this.customSlip = custom;
      // the three words a first-time buyer meets, in one sentence
      const help = el("p", "tiny muted swap__help", "Slippage is how much worse than this quote you still accept. If the price moves past Min received, the trade stops and nothing is spent; Price impact is how much your own trade moves the price."); help.setAttribute("id", `swap-help-${++helpIds}`);
      custom.setAttribute("aria-describedby", help.getAttribute("id"));
      // details
      const dl = el("dl", "swap__details");
      const kv = (k) => { const dt = el("dt", null, k), dd = el("dd", null, "—"); dl.append(dt, dd); return dd; };
      this.dMin = kv("Min received"); this.dImpact = kv("Price impact"); this.dFee = kv("Fee"); this.dRoute = kv("Route");
      this.rentDt = el("dt", null, "Account rent"); this.dRent = el("dd", null, ""); dl.append(this.rentDt, this.dRent); this.rentDt.hidden = this.dRent.hidden = true; // shown only when a trade will ask for rent
      // warnings, status, action
      const warn = el("label", "swap__warn"); warn.hidden = true;
      const cb = el("input"); cb.type = "checkbox"; this.understand = cb;
      cb.addEventListener("change", () => { this.s.understood = cb.checked; this.render(); });
      warn.append(cb, el("span", null, "This trade moves the price more than 10%. I understand I may get much less than the market price."));
      this.warn = warn;
      const status = el("p", "swap__status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); this.status = status;
      const go = el("button", "btn btn--primary btn--block swap__go", "Connect wallet"); go.type = "button"; this.go = go;
      go.addEventListener("click", () => this.primary());
      const links = el("p", "swap__links"); this.links = links;
      const foot = el("p", "tiny muted swap__foot"); this.foot = foot;
      const picker = el("div", "swap__picker"); picker.hidden = true; this.picker = picker;
      const walletBox = el("div", "swap__wallets"); walletBox.hidden = true; this.walletBox = walletBox;
      r.append(head, box, slip, help, dl, warn, status, go, links, foot, picker, walletBox);
      this.inAmt.addEventListener("input", () => this.onAmount());
      this.inAmt.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.primary(); } });
      // the 12-second refresh while the page is looked at (removed again by destroy())
      this.onVisibility = () => { if (document.hidden) clearTimeout(this.refresh); else if (this.s.phase === "quoted") this.scheduleRefresh(); };
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    /* ----- state ----- */
    phase(p, extra = {}) { Object.assign(this.s, { phase: p }, extra); this.render(); }
    get ready() { return Boolean(config && config.swap !== false && this.s.in && this.s.out && this.s.in !== this.s.out); }
    get connected() { return Boolean(wallet.adapter && wallet.address); }
    get canSendHere() { const a = wallet.adapter; return Boolean(a && (a.canSend || a.canSign)); }
    get accountChains() { const a = wallet.adapter; return (a && a.account && a.account.chains) || (a && a.chains) || []; }
    /** The quote's amounts in whole tokens, from the route's own strings (never recomputed from floats). */
    get outUi() { return this.s.quote ? this.s.quote.outUi : null; }
    onAmount() {
      const v = String(this.inAmt.value).replace(",", ".").replace(/[^\d.]/g, "");
      if (v !== this.inAmt.value) this.inAmt.value = v;
      this.s.amount = v; this.s.understood = false; this.understand.checked = false;
      clearTimeout(this.timer); clearTimeout(this.refresh);
      if (this.abort) { this.abort.abort(); this.abort = null; }
      if (!/^\d*\.?\d+$/.test(v) || Number(v) <= 0) { this.s.quote = null; this.s.curve = null; this.phase("idle", { error: null }); return; }
      this.phase("quoting", { error: null });
      this.timer = setTimeout(() => this.quote(), QUOTE_MS);
    }
    setSlippage(bps) { this.s.slippage = bps; this.s.understood = false; this.understand.checked = false; this.render(); if (this.s.amount) { this.phase("quoting"); clearTimeout(this.timer); this.timer = setTimeout(() => this.quote(), 100); } }
    flip() { if (this.fixedOut && this.mode === "buy" && !this.s.flipped) { this.s.flipped = true; } else if (this.fixedOut && this.s.flipped) this.s.flipped = false; [this.s.in, this.s.out] = [this.s.out, this.s.in]; this.s.quote = null; this.s.curve = null; this.s.amount = ""; this.inAmt.value = ""; this.phase("idle", { error: null }); this.loadBalances(); }
    scheduleRefresh() { clearTimeout(this.refresh); this.refresh = setTimeout(() => { if (!document.hidden && this.s.phase === "quoted" && this.s.amount) this.quote(true); }, REFRESH_MS); }
    async setMax() {
      const b = this.s.balances; if (!b) return;
      let v;
      if (this.s.in === SOL) v = Math.max(0, (b.sol ? b.sol.ui : 0) - KEEP_SOL);
      else v = (b.tokens && b.tokens[this.s.in] && b.tokens[this.s.in].ui) || 0;
      if (v <= 0) { toast(this.s.in === SOL ? `Keep at least ${KEEP_SOL} SOL for fees` : "Nothing to swap"); return; }
      this.inAmt.value = String(Number(v.toFixed(Math.min(9, decimalsOf(this.s.in))))); this.onAmount();
    }
    async loadBalances(fresh = false) {
      if (!this.connected || !config || this.dead) { this.s.balances = null; this.render(); return; }
      const mints = [this.s.in, this.s.out].filter((m) => m && m !== SOL).slice(0, 2);
      // fresh: right after a confirmed trade the chain is read again instead of the Worker's 10-second memo
      const d = await api(`/api/swap/balances?owner=${encodeURIComponent(wallet.address)}&mints=${mints.join(",")}&cluster=${this.s.cluster}${fresh ? "&fresh=1" : ""}`).catch(() => null);
      if (d && d.ok && !this.dead) { this.s.balances = d; this.render(); }
    }
    /* ----- quotes ----- */
    async quote(silent = false) {
      if (!this.ready || !this.s.amount) return;
      const seq = ++this.seq;
      const ctrl = new AbortController(); if (this.abort) this.abort.abort(); this.abort = ctrl;
      if (!silent) this.phase("quoting", { error: null });
      let d = await post("/api/swap/quote", { inputMint: this.s.in, outputMint: this.s.out, amount: this.s.amount, slippageBps: this.s.slippage, taker: wallet.address || undefined }, ctrl.signal);
      if (seq !== this.seq) return; // a newer amount took over
      if (d && d.ok && d.source === "curve") {
        this.s.curve = { mint: d.mint, side: d.side, chain: d.chain, cluster: d.cluster, quoteMint: d.quoteMint };
        d = await post("/api/launchpad/trade/quote", { mint: d.mint, side: d.side, amount: this.s.amount, slippageBps: this.s.slippage, taker: wallet.address || undefined }, ctrl.signal);
        if (seq !== this.seq) return;
      } else this.s.curve = null;
      if (!d || !d.ok) { this.s.quote = null; this.phase("failed", { error: d || { error: "swap_unavailable" }, soft: true }); return; }
      this.s.quote = d; this.s.cluster = d.cluster || "mainnet"; this.s.chain = d.chain || "solana:mainnet";
      this.phase("quoted", { error: null, moved: false });
      this.scheduleRefresh();
    }
    /* ----- the trade ----- */
    async primary() {
      if (this.s.phase === "building" || this.s.phase === "signing" || this.s.phase === "sending" || this.s.phase === "confirming") return; // a second click while busy is ignored
      if (this.s.phase === "done" || (this.s.phase === "failed" && !this.s.soft)) { this.s.sig = null; this.inAmt.value = ""; this.s.amount = ""; this.s.quote = null; this.phase("idle", { error: null }); this.inAmt.focus(); return; }
      if (!this.connected) return this.connect();
      if (this.s.phase === "failed" && this.s.soft && this.s.quote && this.s.amount) this.s.phase = "quoted"; // Try again: the same quote, one more go
      if (this.s.phase !== "quoted" || !this.s.quote) return this.inAmt.focus();
      if (!this.canSendHere) return this.phase("failed", { error: { error: "no_send" }, soft: true });
      if (this.impact() > 10 && !this.s.understood) return this.render();
      if (this.s.quote.expiresAt && Date.parse(this.s.quote.expiresAt) < Date.now()) { await this.quote(true); if (this.s.phase !== "quoted") return; }
      const chain = this.s.chain;
      if (chain !== "solana:mainnet" && this.accountChains.length && !this.accountChains.includes(chain)) return this.phase("failed", { error: { error: "wallet_devnet" }, soft: true });
      this.phase("building", { error: null, sig: null, moved: false });
      const legacy = !(wallet.adapter.txVersions || []).some((v) => v === 0 || v === "0");
      const body = this.s.curve
        ? { mint: this.s.curve.mint, side: this.s.curve.side, amount: this.s.amount, slippageBps: this.s.slippage, taker: wallet.address, quoteId: this.s.quote.quoteId, ...(legacy ? { v: "legacy" } : {}) }
        : { inputMint: this.s.in, outputMint: this.s.out, amount: this.s.amount, slippageBps: this.s.slippage, taker: wallet.address, quoteId: this.s.quote.quoteId, ...(legacy ? { v: "legacy" } : {}) };
      const t = await post(this.s.curve ? "/api/launchpad/trade/tx" : "/api/swap/tx", body);
      if (this.dead) return;
      if (!t || !t.ok) return this.phase("failed", { error: t || { error: "swap_unavailable" }, soft: true });
      // The quote of the build the wallet is about to sign is the truth, never the preview (the preview may be an estimate, or
      // its build may have expired and been made again): show THAT, and when it came out worse than what was on the screen, stop
      // here and let the person read it and press again (the 10 % guard is judged on it too).
      const built = t.quote && t.quote.outAmount ? { ...t.quote, fees: { ...(t.quote.fees || {}), ...(t.fees || {}) } } : null;
      const change = built ? worseThan(this.s.quote, built) : null;
      if (built) { this.s.quote = built; this.s.chain = t.chain || this.s.chain; }
      this.s.lvbh = t.lastValidBlockHeight; this.s.cluster = t.cluster || this.s.cluster;
      if (change && change.worse) { this.s.understood = false; this.understand.checked = false; this.phase("quoted", { error: null, moved: true }); this.scheduleRefresh(); return; }
      const bytes = fromB64(t.tx);
      let signature;
      try {
        this.phase("signing");
        if (wallet.adapter.canSend) {
          signature = base58(await wallet.adapter.signAndSendTransaction(bytes, t.chain || chain, { preflightCommitment: "confirmed", maxRetries: 3 }));
          this.phase("sending", { sig: signature });
        } else {
          const signed = await wallet.adapter.signTransaction(bytes, t.chain || chain);
          this.phase("sending");
          const r = await post("/api/swap/send", { tx: toB64(signed), ticket: t.ticket, lastValidBlockHeight: t.lastValidBlockHeight, cluster: this.s.cluster });
          if (!r || !r.ok) return this.phase("failed", { error: r || { error: "rpc_unavailable" } });
          signature = r.signature;
        }
      } catch (e) {
        return this.phase("failed", { error: { error: isReject(e) ? "rejected" : e && e.code === "no_send" ? "no_send" : /devnet|chain|network/i.test(String(e && e.message)) && chain !== "solana:mainnet" ? "wallet_devnet" : "rejected_by_network" }, soft: isReject(e) });
      }
      this.phase("confirming", { sig: signature, checking: false });
      this.watch(signature, t.lastValidBlockHeight);
    }
    /**
     * Poll the status every 2 s. A refused poll (429 from a crowded network address) is not silence: the line says "Still
     * checking…", the next poll waits for Retry-After (at most 15 s) and that wait never counts against the 90 s; only the
     * chain saying "expired" (the block height passed) or a failure ends it badly. After 90 s of real answers that are still
     * pending the words say "could not confirm", never "nothing was spent".
     */
    watch(sig, lvbh) {
      clearTimeout(this.poll);
      let deadline = Date.now() + POLL_MAX_MS;
      const tick = async () => {
        if (this.s.sig !== sig || this.dead) return;
        const d = await req(`/api/swap/status?sig=${sig}&lvbh=${lvbh || ""}&cluster=${this.s.cluster}&via=${this.s.curve ? "curve" : "jupiter"}`);
        if (this.s.sig !== sig || this.dead) return;
        if (d && d.ok && (d.status === "confirmed" || d.status === "finalized")) { this.phase("done"); setTimeout(() => this.loadBalances(true), 1000); try { const r = this.go.getBoundingClientRect(); burst(r.left + r.width / 2, r.top); } catch { /* no burst */ } return; }
        if (d && d.ok && d.status === "failed") return this.phase("failed", { error: { error: d.err || "rejected_by_network", name: d.name } });
        if (d && d.ok && d.status === "expired") return this.phase("failed", { error: { error: "expired" } });
        let wait = POLL_MS;
        if (d && d._status === 429) { wait = Math.min(15_000, Math.max(POLL_MS * 2, Number(d.retryAfterS || 0) * 1000)); deadline += wait; if (!this.s.checking) this.phase("confirming", { checking: true }); }
        else if (!d || !d.ok) wait = Math.min(10_000, POLL_MS * 2);
        if (Date.now() > deadline) return this.phase("failed", { error: { error: "unconfirmed" }, pending: true });
        this.poll = setTimeout(tick, wait);
      };
      this.poll = setTimeout(tick, 1200);
    }
    /* ----- wallet ----- */
    connect() {
      const w = W();
      if (!w) return;
      const list = w.list();
      const box = this.walletBox; box.replaceChildren(); box.hidden = false;
      if (!list.length) {
        if (w.isMobile) {
          // a phone with no wallet on the page: open this very page inside a wallet app (no sign-up, no login; the panel is ready there)
          box.append(el("p", "small muted", "Open this page in your wallet app to buy here:"));
          const row = el("div", "swap__deeplinks");
          for (const k of w.KNOWN.filter((x) => ["phantom", "solflare", "backpack"].includes(x.id))) { const a = el("a", "wallet-option", null); a.setAttribute("href", k.open(location.href)); a.append(w.mark(k.name), el("span", null, `Open in ${k.name}`), el("span", "go", "↗")); row.append(a); }
          box.append(row);
          if (this.s.out) { const ca = el("p", "tiny muted swap__ca"); ca.append("Contract: ", el("code", null, this.s.out), " "); const c = el("button", "link-btn", "Copy"); c.type = "button"; c.addEventListener("click", () => copy(this.s.out, "Address copied")); ca.append(c); box.append(ca); }
        } else {
          box.append(el("p", "small muted", "No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload."));
          const row = el("div", "swap__deeplinks");
          for (const k of w.KNOWN.slice(0, 3)) { const a = el("a", "wallet-option", null); a.setAttribute("href", k.site); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener"); a.append(w.mark(k.name), el("span", null, `Get ${k.name}`), el("span", "go", "↗")); row.append(a); }
          box.append(row);
        }
        const close = el("button", "link-btn swap__wallets-close", "Close"); close.type = "button"; close.addEventListener("click", () => { box.hidden = true; });
        box.append(close);
        return;
      }
      box.append(el("p", "small muted", "Choose the wallet that will sign:"));
      for (const a of list) {
        const b = el("button", "wallet-option"); b.type = "button";
        const icon = w.safeIcon(a.icon);
        if (icon) { const img = el("img"); img.alt = ""; img.src = icon; b.append(img); } else b.append(w.mark(a.name));
        b.append(el("span", null, a.name), el("span", a.canSend || a.canSign ? "detected" : "go", a.canSend ? "Connect" : a.canSign ? "Signs" : "No transactions"));
        b.addEventListener("click", async () => {
          try { const address = await a.connect(); box.hidden = true; setWallet(a, address); toast(`Connected ${shortAddr(address)}`); }
          catch (e) { this.phase("failed", { error: { error: isReject(e) ? "rejected" : "rejected_by_network" }, soft: true }); }
        });
        box.append(b);
      }
      const close = el("button", "link-btn swap__wallets-close", "Close"); close.type = "button"; close.addEventListener("click", () => { box.hidden = true; });
      box.append(close);
    }
    /* ----- token picker ----- */
    openPicker(which) {
      if (which === "out" && this.fixedOut && !this.s.flipped) return;
      if (which === "in" && this.fixedOut && this.s.flipped) return;
      const p = this.picker; p.replaceChildren(); p.hidden = false; this.s.picker = which;
      const head = el("div", "swap__picker-head");
      head.append(el("strong", null, which === "in" ? "You pay with" : "You get"));
      const close = el("button", "link-btn", "Close"); close.type = "button"; close.addEventListener("click", () => { p.hidden = true; this.s.picker = null; });
      head.append(close); p.append(head);
      const search = el("input", "swap__search"); search.placeholder = "Search a verified token (name or address)"; search.setAttribute("aria-label", "Search tokens"); search.autocomplete = "off";
      p.append(search);
      const list = el("div", "swap__picker-list"); list.setAttribute("role", "listbox"); p.append(list);
      const draw = (rows) => {
        list.replaceChildren(...rows.map((t) => {
          const b = el("button", "wallet-option swap__opt"); b.type = "button"; b.setAttribute("role", "option");
          b.append(mark(t.mint, t.symbol || t.name), el("span", null, t.kind === "vicinity" ? "$VICINITY" : t.kind === "city" ? `${t.name}` : t.symbol), el("span", "go", t.kind === "city" ? (t.city ? t.city.name : "city coin") : t.name));
          b.addEventListener("click", () => { this.s[which] = t.mint; if (this.s.in === this.s.out) this.s[which === "in" ? "out" : "in"] = t.mint === SOL ? USDC : SOL; p.hidden = true; this.s.picker = null; this.s.quote = null; this.render(); this.loadBalances(); if (this.s.amount) this.onAmount(); });
          return b;
        }));
        if (!rows.length) list.append(el("p", "small muted", "No verified token matches."));
      };
      const base = (config ? config.tokens : []).filter((t) => t.kind !== "city" || t.stage !== "unknown");
      draw(base);
      let t = 0;
      search.addEventListener("input", () => {
        clearTimeout(t);
        const q = search.value.trim();
        if (!q) return draw(base);
        const local = base.filter((x) => `${x.symbol || ""} ${x.name || ""} ${x.mint}`.toLowerCase().includes(q.toLowerCase()));
        draw(local);
        if (q.length >= 2 && /^[A-Za-z0-9 ._-]{2,44}$/.test(q)) t = setTimeout(async () => { const d = await api(`/api/swap/tokens?q=${encodeURIComponent(q)}`).catch(() => null); if (d && d.ok && search.value.trim() === q) draw([...local, ...d.tokens.filter((x) => !local.some((l) => l.mint === x.mint)).map((x) => ({ ...x, kind: "other" }))]); }, 350);
      });
      search.focus();
    }
    impact() { const q = this.s.quote; const v = q && q.priceImpactPct != null ? Number(q.priceImpactPct) : 0; return Number.isFinite(v) ? v : 0; }
    /* ----- render ----- */
    render() {
      const s = this.s, q = s.quote;
      const sym = (m) => symbolOf(m);
      const setTok = (btn, mint, fixed) => { btn.replaceChildren(mark(mint, sym(mint)), el("span", null, sym(mint)), fixed ? "" : el("span", "swap__caret", "▾")); btn.disabled = Boolean(fixed); };
      setTok(this.inTok, s.in, this.fixedOut && s.flipped);
      setTok(this.outTok, s.out, this.fixedOut && !s.flipped);
      this.inLabel.textContent = s.curve ? (s.curve.side === "buy" ? "You pay" : "You sell") : "You pay";
      this.outLabel.textContent = q && q.estimate ? "You get · estimate" : q && q.partialFill ? "You get · the rest comes back" : "You get";
      this.outAmt.textContent = q ? num(Number(q.outUi), 6) : s.phase === "quoting" ? "…" : "—";
      this.inUsd.textContent = q && q.inUsd != null ? `≈ ${usd(q.inUsd)}` : "";
      this.outUsd.textContent = q && q.outUsd != null ? `≈ ${usd(q.outUsd)}` : "";
      const b = s.balances;
      if (b && this.connected) {
        const inBal = s.in === SOL ? b.sol.ui : b.tokens && b.tokens[s.in] ? b.tokens[s.in].ui : null;
        this.maxBtn.hidden = inBal == null; this.maxBtn.textContent = inBal == null ? "MAX" : `MAX · ${num(inBal, 4)} ${sym(s.in)}`;
        const outBal = s.out === SOL ? b.sol.ui : b.tokens && b.tokens[s.out] ? b.tokens[s.out].ui : null;
        this.outBal.textContent = outBal != null ? `You hold ${num(outBal, 4)}` : "";
      } else { this.maxBtn.hidden = true; this.outBal.textContent = ""; }
      for (const c of $$(".swap__chip:not(.swap__chip--custom)", this.root)) c.setAttribute("aria-pressed", String(Number(c.dataset.bps) === s.slippage));
      if (![50, 100, 300].includes(s.slippage)) this.customSlip.value = String(s.slippage / 100); else if (document.activeElement !== this.customSlip) this.customSlip.value = "";
      // details
      const impact = this.impact();
      this.dMin.textContent = q ? `${num(Number(q.minOutUi), 6)} ${sym(s.out)}` : "—";
      this.dImpact.textContent = q ? (q.priceImpactPct == null ? "unknown" : `${impact < 0.01 ? "<0.01" : impact.toFixed(2)}%`) : "—";
      this.dImpact.className = impact > 10 ? "is-bad" : impact > 3 ? "is-warn" : "";
      // the fee line names every lamport the trade can cost: the network fee, the priority fee (the exact one once the
      // transaction is built, else the most the Worker allows), the curve or platform fee
      const f = q && q.fees ? q.fees : null;
      const prio = !f ? "" : f.priorityLamports != null ? (f.priorityLamports > 0 ? `priority ${sol(f.priorityLamports)} SOL` : "no priority fee") : f.priorityLamportsMax > 0 ? `priority ≤ ${sol(f.priorityLamportsMax)} SOL` : "";
      const net = f ? `network ≈ ${sol(f.networkLamports || 5000)} SOL${prio ? ` · ${prio}` : ""}` : "";
      const platform = f && f.platformFeeBps > 0 ? ` · ${(f.platformFeeBps / 100).toString()}% platform fee` : " · no platform fee";
      this.dFee.textContent = q ? (f && f.curveFeeBps != null ? `${(f.curveFeeBps / 100).toFixed(2)}% curve fee · ${net}` : `${net}${platform}`) : "—";
      this.dRoute.textContent = q ? (q.source === "curve" ? "Executed on the Meteora bonding curve" : q.routeText || "Routed by Jupiter") : "—";
      // rent: a token account of the person's that does not exist yet (returned when closed), and on a curve the platform's
      // referral account when it is missing (that one is not returned): said before the wallet opens, not after
      const rentBits = [];
      const outAcct = b && this.connected && s.out !== SOL && b.tokens && b.tokens[s.out] ? b.tokens[s.out].hasAccount : null;
      if (q && outAcct === false) rentBits.push(`about ${sol((f && f.rentLamports) || 2039280)} SOL once creates your ${sym(s.out)} account (returned when you close it)`);
      if (q && f && f.referralRentLamports > 0) rentBits.push(f.referralNote || `about ${sol(f.referralRentLamports)} SOL re-creates the platform's fee account (not returned)`);
      this.dRent.textContent = rentBits.join("; ");
      this.dRent.hidden = this.rentDt.hidden = !rentBits.length;
      this.root.classList.toggle("is-warn", impact > 3 && impact <= 10);
      this.root.classList.toggle("is-bad", impact > 10);
      this.warn.hidden = !(q && impact > 10 && s.phase === "quoted");
      // the state tag
      const tags = { idle: ["", this.ready ? "Ready" : "Loading…"], quoting: ["", "Quoting…"], quoted: ["tag--ok", q && q.estimate ? "Estimate" : s.curve ? (s.cluster === "devnet" ? "Devnet test coin" : "Live · curve") : "Live"], building: ["tag--warn", "Preparing…"], signing: ["tag--warn", "Confirm in wallet"], sending: ["tag--warn", "Sending…"], confirming: ["tag--warn", "Confirming…"], done: ["tag--ok", "Swapped ✓"], failed: ["tag--no", "Stopped"] };
      const [cls, text] = tags[s.phase] || ["", ""];
      this.state.className = `tag swap__state ${cls}`; this.state.textContent = text;
      // the status line
      const intro = this.mode === "buy" && !s.flipped ? `You pay ${sym(s.in)}, the market gives you ${sym(s.out)}; your own wallet asks you to confirm.` : "Pick the pair and an amount; your own wallet asks you to confirm.";
      const lines = {
        idle: this.connected ? `Connected ${shortAddr(wallet.address)}${wallet.adapter && !this.canSendHere ? " · " + WORDS.no_send : ""}` : intro,
        quoting: "Getting the best price…",
        quoted: s.moved && q ? `The price moved since your quote: you would now get ${num(Number(q.outUi), 6)} ${sym(s.out)} (at least ${num(Number(q.minOutUi), 6)}). Nothing was sent. Review it and press the button again.`
          : (q ? `${q.estimate ? "Estimate: the exact amount is fixed when you press Swap. " : ""}${q.partialFill ? `The curve takes only what it can still sell; the rest (${num(Number(q.refund) / 10 ** (q.decimals ? q.decimals.in : 9), 6)} ${sym(s.in)}) comes back. ` : ""}${impact > 3 ? `Price impact ${impact.toFixed(2)}%: a smaller amount gets a better price. ` : ""}` : "") || (this.connected ? `Connected ${shortAddr(wallet.address)}` : "Connect a wallet to swap."),
        building: "Preparing your transaction…",
        signing: "Confirm in your wallet.",
        sending: "Sending to the network…",
        confirming: s.checking ? "Still checking with the network… this can take a moment. Nothing more to sign." : "Waiting for the network to confirm…",
        done: q ? `Swapped ✓ ${num(Number(q.inUi), 6)} ${sym(s.in)} → ${num(Number(q.outUi), 6)} ${sym(s.out)}` : "Swapped ✓",
        failed: words(s.error),
      };
      this.status.textContent = lines[s.phase] || "";
      this.status.className = `swap__status${s.phase === "failed" ? " is-bad" : s.phase === "done" ? " is-ok" : s.phase === "quoted" && s.moved ? " is-moved" : ""}`;
      // links: the signature
      this.links.replaceChildren();
      if (s.sig) { const a = el("a", null, "View on Solscan ↗"); a.setAttribute("href", `https://solscan.io/tx/${s.sig}${s.cluster !== "mainnet" ? `?cluster=${s.cluster}` : ""}`); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener"); this.links.append(el("span", "mono tiny", shortAddr(s.sig)), " · ", a); }
      // the button
      const busy = ["building", "signing", "sending", "confirming"].includes(s.phase);
      const labels = { idle: this.connected ? (this.mode === "buy" && !s.flipped ? `Buy ${sym(s.out)}` : this.mode === "buy" ? `Sell ${sym(s.in)}` : "Swap") : "Connect wallet", quoting: "Quoting…", quoted: this.connected ? (s.curve ? (s.curve.side === "buy" ? `Buy ${sym(s.out)}` : `Sell ${sym(s.in)}`) : this.mode === "buy" && !s.flipped ? `Buy ${sym(s.out)}` : "Swap") : "Connect wallet", building: "Preparing…", signing: "Confirm in your wallet…", sending: "Sending…", confirming: "Confirming…", done: "Swap again", failed: s.soft ? (this.connected ? "Try again" : "Connect wallet") : "Start over" };
      this.go.textContent = labels[s.phase] || "Swap";
      this.go.disabled = busy || !this.ready || (s.phase === "quoting") || (s.phase === "quoted" && (!this.connected ? false : impact > 10 && !s.understood)) || (s.phase === "idle" && this.connected && !s.amount);
      this.go.classList.toggle("is-busy", busy);
      this.flipBtn.disabled = busy;
      this.inAmt.disabled = busy;
      // the footer: attribution, where it executes, honesty (the fee sentence follows the setting, never a fixed "no fee")
      const testNet = s.cluster === "devnet" ? " · Devnet test coin: this trade uses test SOL with no value." : "";
      const feeBps = config && config.platformFeeBps > 0 ? config.platformFeeBps : 0;
      this.foot.textContent = (q && q.source === "curve") ? `Prices by the Meteora bonding curve, exactly as the chain computes them. You sign in your own wallet; Vicinity never touches your funds.${testNet}` : `Powered by Jupiter. You sign in your own wallet; Vicinity never touches your funds${feeBps ? ` and takes a ${(feeBps / 100).toString()}% platform fee` : " and takes no fee"}.${testNet}`;
    }
  }
  const norm = (m) => (m === "SOL" ? SOL : m === "USDC" ? USDC : m === "USDT" ? USDT : isAddr(m) ? m : null);
  /** One request to this site: GET without a body, POST with one. The answer carries _status and, from a Retry-After header, retryAfterS. */
  async function req(path, body, signal) {
    try {
      const r = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && d.ok === undefined) d.ok = false;
      if (!r.ok && !d.error) d.error = r.status === 429 ? "slow_down" : "swap_unavailable";
      d._status = r.status;
      const ra = r.headers && typeof r.headers.get === "function" ? Number(r.headers.get("retry-after")) : NaN;
      if (Number.isFinite(ra) && ra > 0 && d.retryAfterS == null) d.retryAfterS = ra;
      return d;
    } catch (e) { if (e && e.name === "AbortError") return null; return { ok: false, error: "swap_unavailable", _status: 0 }; }
  }
  const post = (path, body, signal) => req(path, body === undefined ? {} : body, signal);

  /* ---------------------------------------------------------------- mounting and the bottom sheet */
  async function mount(root, opts = {}) {
    if (!root || root.getAttribute("data-swap-mounted")) return root && root._swap;
    await loadConfig();
    if (!config || config.swap === false) { root.hidden = true; return null; }
    if (root._swap) root._swap.destroy(); // a slot mounted again with another pair (the dashboard's routes) retires its old panel first
    const p = new Panel(root, opts); root._swap = p; return p;
  }
  let sheet = null;
  const closeSheet = () => { if (!sheet) return; if (typeof sheet.close === "function" && sheet.open) sheet.close(); else sheet.removeAttribute("open"); };
  /** The panel as a bottom sheet / dialog over any page: Escape (the dialog's own) and a tap outside close it. */
  async function open(opts = {}) {
    await loadConfig();
    if (!config || config.swap === false) return null;
    if (!sheet) {
      sheet = el("dialog", "swap-sheet");
      sheet.setAttribute("aria-label", "Buy or swap");
      const card = el("div", "swap-sheet__card");
      const close = el("button", "swap-sheet__close", "✕"); close.type = "button"; close.setAttribute("aria-label", "Close");
      close.addEventListener("click", closeSheet);
      const body = el("div", "swap-sheet__body"); body.dataset.swap = "";
      card.append(close, body); sheet.append(card);
      sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); }); // a tap outside the card
      sheet.addEventListener("close", () => { const b = sheet.querySelector(".swap-sheet__body"); if (b && b._swap) b._swap.destroy(); }); // a closed sheet keeps no panel alive
      document.body.append(sheet);
    }
    const body = sheet.querySelector(".swap-sheet__body");
    if (body._swap) body._swap.destroy(); // the previous card's panel: its timers, poll and listeners go with it
    body.replaceChildren(); body.removeAttribute("data-swap-mounted"); body.className = "swap-sheet__body";
    const p = new Panel(body, { mode: opts.mode || "buy", in: opts.in || "SOL", out: opts.out, title: opts.title || `Buy ${symbolOf(norm(opts.out), "this coin")}` });
    body._swap = p;
    if (typeof sheet.showModal === "function") sheet.showModal(); else sheet.setAttribute("open", "");
    setTimeout(() => { try { p.inAmt.focus(); } catch { /* no focus */ } }, 50);
    return p;
  }
  const refresh = () => { for (const p of panels) { p.loadBalances(); if (p.s.phase === "quoted") p.quote(true); } };

  /* ---------------------------------------------------------------- the words on the pages once the switch is on */
  // With the swap on nobody is sent to raydium.io any more, so the sentences that said "Buy on Raydium" say where buying happens
  // now: here, in the person's own wallet, routed by Jupiter and executed on Raydium LaunchLab (Meteora's curve for a city coin).
  // With the switch off the pages keep their words exactly. Each entry: the page (body[data-page]), the element, what its text must
  // still say today (a sentence someone rewrote is left alone), and the new text or a function that rewrites the element.
  const link = (href, text) => { const a = el("a", null, text); a.setAttribute("href", href); return a; };
  const OLD_TRADE_SENTENCE = /You trade in your own wallet on Raydium or Jupiter; Vicinity never touches your funds\./;
  const NEW_TRADE_SENTENCE = "You buy and sell here, in your own wallet (routed by Jupiter, executed on Raydium LaunchLab or the Meteora curve); Vicinity never touches your funds.";
  /** Replace a sentence inside an element's own text, leaving its links (Powered by Jupiter and the like) alone. */
  const replaceSentence = (e, from, to) => { for (const n of Array.from(e.childNodes)) if (!n.tagName && from.test(String(n.data))) n.data = String(n.data).replace(from, to); };
  const COPY = [
    ["home", ".buy-steps h3", /^Buy on Raydium$/, "Buy here"],
    ["home", ".buy-steps p", /Buy on Raydium/, (p) => p.replaceChildren("Right here, on our ", link("/token#buy-slot", "Token page"), ": the Buy panel quotes through Jupiter and executes on Raydium LaunchLab, signed in your own wallet, so you get the real $VICINITY without leaving vicinity.city.")],
    ["home", "#buy-faq p", /Buy on Raydium/, (p) => p.replaceChildren("Get a Solana wallet (Phantom, Solflare or Backpack), add SOL, then use the Buy panel on the ", link("/token#buy-slot", "Token page"), ". It quotes through Jupiter and executes on Raydium LaunchLab, signed in your own wallet; you never leave this site. Look-alike sites that copy Raydium are scams that empty wallets.")],
    ["token", "#buy li", /^Buy on Raydium\./, (li) => li.replaceChildren(el("strong", null, "Buy here."), " Use the Buy panel under the contract address at the top of this page: it quotes through Jupiter and executes on Raydium LaunchLab, signed in your own wallet. You never leave vicinity.city.")],
    ["launchpad", "#lp-honesty", OLD_TRADE_SENTENCE, (p) => replaceSentence(p, OLD_TRADE_SENTENCE, NEW_TRADE_SENTENCE)],
  ];
  function copySweep() {
    const page = document.body && document.body.dataset ? document.body.dataset.page : "";
    for (const [p, sel, test, apply] of COPY) {
      if (p !== page) continue;
      for (const e of Array.from($$(sel))) {
        if (e.dataset.swapCopy || !test.test(e.textContent)) continue;
        e.dataset.swapCopy = "1";
        if (typeof apply === "function") apply(e); else e.textContent = apply;
      }
    }
  }
  window.VSwap = { mount, open, close: closeSheet, refresh, words, base58, num, worseThan, copySweep, tradeSentence: NEW_TRADE_SENTENCE, get config() { return config; }, get wallet() { return { address: wallet.address, adapter: wallet.adapter }; }, _panels: panels };
  // Self-mount every [data-swap] on the page once the switch is known. Every page already reads /api/official (site.js), so the
  // switch costs no extra request: off = the slots are hidden and nothing else is asked; on = the words change and the panels mount.
  const start = async () => {
    const slots = Array.from($$("[data-swap]")).filter((e) => !e.closest(".swap-sheet"));
    const o = window.V.official && typeof window.V.official.then === "function" ? await window.V.official.catch(() => null) : undefined;
    const on = o === undefined ? null : Boolean(o && o.swap === true);
    if (on === false) { for (const e of slots) e.hidden = true; return; }
    if (on === true) copySweep();
    if (on === true && !slots.length) return; // a page that only needed its words changed (the home page)
    await loadConfig();
    for (const e of slots) { if (!config || config.swap === false) e.hidden = true; else mount(e); }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  // the connected wallet is remembered across panels; wallets.js may register late (in-app browsers)
  if (W()) W().onChange(() => { for (const p of panels) p.render(); });
})();
