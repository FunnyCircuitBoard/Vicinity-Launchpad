// Solana wallets: finds every wallet installed in this browser (the "Wallet Standard" most wallets
// use, plus older built-in ones), and knows the popular wallets' app links for phones.
// Sets window.VW. Nothing is loaded from other sites: wallet icons come from the wallets themselves.
(() => {
  "use strict";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const enc = encodeURIComponent;
  const webView = Boolean(window.V && window.V.webView); // a wallet app's own browser (detected once, in site.js)

  // Popular Solana wallets. open(url) = link that opens a page inside the wallet app's browser (phones).
  const KNOWN = [
    // phantom.com: Phantom's current universal-link domain (phantom.app only redirects, and its Android app-link file is gone)
    { id: "phantom", name: "Phantom", color: "#AB9FF2", match: /phantom/i, site: "https://phantom.com/download",
      open: (u) => `https://phantom.com/ul/browse/${enc(u)}?ref=${enc(location.origin)}` },
    { id: "solflare", name: "Solflare", color: "#FC7227", match: /solflare/i, site: "https://solflare.com/download",
      open: (u) => `https://solflare.com/ul/v1/browse/${enc(u)}?ref=${enc(location.origin)}` },
    { id: "backpack", name: "Backpack", color: "#E33E3F", match: /backpack/i, site: "https://backpack.app/downloads",
      open: (u) => `https://backpack.app/ul/v1/browse/${enc(u)}?ref=${enc(location.origin)}` },
    { id: "okx", name: "OKX Wallet", color: "#1F1F1F", match: /okx/i, site: "https://www.okx.com/web3",
      open: (u) => `https://www.okx.com/download?deeplink=${enc("okx://wallet/dapp/url?dappUrl=" + enc(u))}` },
    { id: "coinbase", name: "Coinbase Wallet", color: "#0052FF", match: /coinbase/i, site: "https://www.coinbase.com/wallet/downloads",
      open: (u) => `https://go.cb-w.com/dapp?cb_url=${enc(u)}` },
    { id: "trust", name: "Trust Wallet", color: "#0500FF", match: /trust/i, site: "https://trustwallet.com/download",
      open: (u) => `https://link.trustwallet.com/open_url?coin_id=501&url=${enc(u)}` },
    { id: "bitget", name: "Bitget Wallet", color: "#00F0FF", match: /bitget|bitkeep/i, site: "https://web3.bitget.com/en/wallet-download" },
    { id: "magiceden", name: "Magic Eden", color: "#E42575", match: /magic ?eden/i, site: "https://wallet.magiceden.io/" },
    { id: "exodus", name: "Exodus", color: "#1D1B45", match: /exodus/i, site: "https://www.exodus.com/download/" },
    { id: "jupiter", name: "Jupiter", color: "#26A35E", match: /jupiter/i, site: "https://jup.ag/mobile" },
    { id: "binance", name: "Binance Wallet", color: "#F0B90B", match: /binance/i, site: "https://www.binance.com/en/web3wallet" },
    { id: "nightly", name: "Nightly", color: "#6067F9", match: /nightly/i, site: "https://nightly.app/download" },
    { id: "coin98", name: "Coin98", color: "#D9B432", match: /coin98/i, site: "https://coin98.com/wallet" },
    { id: "tokenpocket", name: "TokenPocket", color: "#2980FE", match: /tokenpocket/i, site: "https://www.tokenpocket.pro/en/download/app" },
    { id: "safepal", name: "SafePal", color: "#4A21EF", match: /safepal/i, site: "https://www.safepal.com/download" },
    { id: "brave", name: "Brave Wallet", color: "#FB542B", match: /brave/i, site: "https://brave.com/wallet/" },
  ];

  const found = new Map(); // name → adapter
  const listeners = new Set();
  const changed = () => listeners.forEach((f) => { try { f(); } catch {} });
  const toBytes = (sig) => (sig instanceof Uint8Array ? sig : sig?.signature ? toBytes(sig.signature) : new Uint8Array(sig));
  /** A wallet's answer to "sign this": the 64-byte signature, or an error the page can put in plain words (never a raw one). */
  function signatureOf(out) {
    const first = Array.isArray(out) ? out[0] : out; // the standard answers [{ signedMessage, signature }]; some wallets give the object itself
    let sig = null;
    try { sig = first == null ? null : toBytes(first); } catch { sig = null; }
    if (!sig || sig.length !== 64) throw Object.assign(new Error("The wallet gave back no signature."), { code: "no_signature" });
    return sig;
  }

  // Wallet Standard wallets
  function standard(w) {
    return {
      name: w.name, icon: w.icon, kind: "standard",
      async connect() {
        const { accounts } = await w.features["standard:connect"].connect();
        const acc = accounts.find((a) => (a.chains || []).some((c) => String(c).startsWith("solana:"))) || accounts[0];
        if (!acc) throw new Error("No account was shared.");
        this.account = acc; return acc.address;
      },
      async signMessage(bytes) {
        return signatureOf(await w.features["solana:signMessage"].signMessage({ account: this.account, message: bytes }));
      },
      async disconnect() { try { await w.features["standard:disconnect"]?.disconnect(); } catch {} },
    };
  }
  function register(...ws) {
    for (const w of ws) {
      const ok = w && w.name && w.features && w.features["standard:connect"] && w.features["solana:signMessage"] &&
        (w.chains || []).some((c) => String(c).startsWith("solana:"));
      if (ok && !found.has(w.name)) { found.set(w.name, standard(w)); changed(); }
    }
    return () => {};
  }
  // a wallet announcing itself late (in-app browsers often inject after our scripts ran) is also a moment to look for the older kind
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail({ register }); } catch {} scanLegacy(); });
  try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register } })); } catch {}

  // Older wallets that only put an object on the page
  function legacy(name, p) {
    return {
      name, icon: null, kind: "legacy",
      async connect() {
        const r = await p.connect();
        const pk = r?.publicKey || p.publicKey;
        if (!pk) throw new Error("No account was shared.");
        return pk.toString();
      },
      async signMessage(bytes) { return signatureOf(await p.signMessage(bytes, "utf8")); },
      async disconnect() { try { await p.disconnect(); } catch {} },
    };
  }
  function scanLegacy() {
    const cands = [
      ["Phantom", window.phantom?.solana], ["Solflare", window.solflare], ["Backpack", window.backpack?.solana || window.backpack],
      ["OKX Wallet", window.okxwallet?.solana], ["Coinbase Wallet", window.coinbaseSolana], ["Trust Wallet", window.trustwallet?.solana],
      ["Bitget Wallet", window.bitkeep?.solana], ["Exodus", window.exodus?.solana], ["Brave Wallet", window.braveSolana],
      ["Solana wallet", window.solana],
    ];
    for (let [name, p] of cands) {
      if (!p || typeof p.connect !== "function" || typeof p.signMessage !== "function") continue;
      // window.solana is usually a wallet listed already under its own name (Phantom sets both): one tile per wallet, not two
      if (name === "Solana wallet") name = p.isPhantom ? "Phantom" : p.isSolflare ? "Solflare" : p.isBackpack ? "Backpack" : name;
      const known = KNOWN.find((k) => k.match.test(name));
      const taken = [...found.keys()].some((n) => (known ? known.match.test(n) : n === name));
      if (!taken && ![...found.values()].some((a) => a._p === p)) { const a = legacy(name, p); a._p = p; found.set(name, a); }
    }
    changed();
  }
  setTimeout(scanLegacy, 350);
  window.addEventListener("load", () => setTimeout(scanLegacy, 200));
  // coming back to the tab (after installing a wallet, or when a wallet app's browser finished injecting): look again, no reload needed
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scanLegacy(); });

  /** The icon a wallet gave us (only safe data: images), or null. */
  const safeIcon = (src) => (typeof src === "string" && /^data:image\/(svg\+xml|png|webp|jpeg|gif);base64,/.test(src) ? src : null);
  /** A small coloured square with the wallet's first letter, for wallets that aren't installed. */
  function mark(name) {
    const k = KNOWN.find((x) => x.match.test(name));
    const s = document.createElement("span");
    s.className = "wallet-mark"; s.textContent = (name || "?")[0].toUpperCase();
    s.style.background = k ? k.color : "#445";
    return s;
  }
  /** Inside a wallet app's own browser? True when the user agent says so, or a phone browser already has a wallet on the page. */
  const inWalletApp = () => webView || (isMobile && found.size > 0);

  window.VW = {
    KNOWN, isMobile, inWalletApp, safeIcon, mark,
    list: () => [...found.values()],
    onChange: (f) => { listeners.add(f); return () => listeners.delete(f); },
    knownFor: (name) => KNOWN.find((k) => k.match.test(name)) || null,
    rescan: scanLegacy,
  };
})();
