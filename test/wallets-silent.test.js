// public/wallets.js connectSilently(): the account a wallet ALREADY shares with this site, never a question to the person (the Buy
// panel uses it inside a wallet app's own browser, test/swap-inwallet.test.js). Wallet Standard: the accounts the wallet lists already,
// else "standard:connect" with { silent: true } and nothing else; older wallets: the one connected already, else
// connect({ onlyIfTrusted: true }), asked only of Phantom and Backpack (known to keep that promise). No account, a refusal, an error or
// no answer within 2.5 s is null, never a throw; a later answer is dropped. The tap's connect() is unchanged (no silent flag).
// The last tests run the real wallets.js AND swap.js together in a wallet app's browser (test/helpers/swappage.js walletsJs).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { newEvent } from "./helpers/pagedom.js";
import { VIC, CONFIG, QUOTE, TX, swapPage, byPath, click, text } from "./helpers/swappage.js";

const WALLETS_JS = readFileSync(new URL("../public/wallets.js", import.meta.url), "utf8");
const ADDR = "CnQMR167gRRXcPYrDZkwbW6moYKmxd7gZNGSN6BNzz6p", OTHER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const UA = {
  phantomIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Phantom/ios",
  desktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
};

/**
 * A Wallet Standard wallet. trust: "yes" (this site was allowed before: a silent connect answers the account), "no" (it answers
 * none), "refuse" (it refuses: Phantom's way), "hang" (no answer until answer()), "ignores" (it ignores the silent flag and would ask
 * the person: no answer while "asking"). Every connect input is recorded in ctl.inputs.
 */
function standardWallet({ name = "Phantom", trust = "yes", listed = false, address = ADDR } = {}) {
  const ctl = { inputs: [], sends: [], answer: null };
  const account = { address, publicKey: new Uint8Array(32), chains: ["solana:mainnet", "solana:devnet"], features: ["solana:signMessage", "solana:signAndSendTransaction"] };
  const wallet = {
    version: "1.0.0", name, icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", chains: ["solana:mainnet", "solana:devnet"], accounts: listed ? [account] : [],
    features: {
      "standard:connect": { version: "1.0.0", connect: async (input) => {
        ctl.inputs.push(input === undefined ? "none" : JSON.parse(JSON.stringify(input)));
        const silent = Boolean(input && input.silent);
        const ok = () => { wallet.accounts = [account]; return { accounts: [account] }; };
        if (!silent || trust === "yes") return ok();
        if (trust === "no") return { accounts: [] };
        if (trust === "refuse") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        return new Promise((resolve) => { ctl.answer = () => resolve(ok()); }); // hang / ignores (asking the person)
      } },
      "solana:signMessage": { version: "1.0.0", signMessage: async () => [{ signature: new Uint8Array(64).fill(1) }] },
      "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: new Set(["legacy", 0]), signAndSendTransaction: async (input) => { ctl.sends.push(input.account.address); return [{ signature: new Uint8Array(64).fill(2) }]; } },
    },
  };
  return { wallet, ctl };
}
/** An older wallet that only puts an object on the page. flags: isPhantom / isBackpack / isSolflare; trusted: answers onlyIfTrusted. */
function legacyProvider({ flags = { isPhantom: true }, trusted = true, connected = false } = {}) {
  const pk = { toString: () => ADDR };
  const ctl = { inputs: [] };
  const p = { ...flags, publicKey: connected ? pk : null, isConnected: connected,
    async connect(opts) { ctl.inputs.push(opts === undefined ? "none" : JSON.parse(JSON.stringify(opts))); if (opts && opts.onlyIfTrusted && !trusted) throw Object.assign(new Error("User rejected the request."), { code: 4001 }); this.publicKey = pk; this.isConnected = true; return { publicKey: pk }; },
    async signMessage() { return { signature: new Uint8Array(64) }; }, async disconnect() {} };
  return { p, ctl };
}
/** wallets.js alone in a browser with `ua`; `globals` go on window (older wallets); timers run when advance() moves the clock. */
function load({ ua = UA.phantomIos, webView = true, globals = {} } = {}) {
  let now = 0;
  const timers = [], listeners = {};
  const win = {
    navigator: { userAgent: ua, maxTouchPoints: /iPhone/.test(ua) ? 5 : 0 }, V: { webView }, console,
    addEventListener: (t, f) => (listeners[t] ||= []).push(f), dispatchEvent: () => true,
    setTimeout: (fn, ms = 0) => { timers.push({ at: now + ms, fn }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    document: { hidden: false, addEventListener() {}, createElement: () => ({ style: {} }) }, location: { origin: "https://vicinity.test" },
    ...globals,
  };
  win.window = win;
  vm.runInContext(WALLETS_JS, vm.createContext(win), { filename: "public/wallets.js" });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => { const until = now + ms; for (;;) { await settle(); const t = timers.filter((x) => x.fn && x.at <= until).sort((a, b) => a.at - b.at)[0]; if (!t) break; now = t.at; const fn = t.fn; t.fn = null; fn(); } now = until; await settle(); };
  const register = (w) => (listeners["wallet-standard:register-wallet"] || []).forEach((f) => f({ detail: (api) => api.register(w) }));
  return { VW: win.VW, register, advance };
}

test("Wallet Standard: a site allowed before gets its account back from standard:connect { silent: true } (and nothing else); the adapter then signs with that account", async () => {
  const { wallet, ctl } = standardWallet({ trust: "yes" });
  const B = load(); B.register(wallet);
  const a = B.VW.list()[0];
  assert.equal(typeof a.connectSilently, "function");
  assert.equal(await a.connectSilently(), ADDR);
  assert.deepEqual(ctl.inputs, [{ silent: true }], "one call, with the standard's silent flag");
  assert.equal(a.account.address, ADDR, "the account is kept for signing");
  await a.signAndSendTransaction(new Uint8Array(300), "solana:mainnet");
  assert.deepEqual(ctl.sends, [ADDR]);
  assert.equal(B.VW.inWalletApp(), true, "a wallet app's browser");
});

test("Wallet Standard: accounts the wallet lists already are used without any call", async () => {
  const { wallet, ctl } = standardWallet({ trust: "no", listed: true });
  const B = load(); B.register(wallet);
  assert.equal(await B.VW.list()[0].connectSilently(), ADDR);
  assert.deepEqual(ctl.inputs, [], "not even a silent call");
});

test("Wallet Standard: a site never allowed (no account, a refusal), a junk answer, or a throw is null, never an error and never a second call", async () => {
  for (const trust of ["no", "refuse"]) {
    const { wallet, ctl } = standardWallet({ trust });
    const B = load(); B.register(wallet);
    const a = B.VW.list()[0];
    assert.equal(await a.connectSilently(), null, trust);
    assert.deepEqual(ctl.inputs, [{ silent: true }], `${trust}: asked silently once, never the connect that prompts`);
    assert.equal(a.account, undefined);
  }
  for (const junk of [undefined, null, {}, { accounts: [{}] }, { accounts: [{ address: 42 }] }, { accounts: "x" }]) {
    const { wallet } = standardWallet();
    wallet.features["standard:connect"].connect = async () => junk;
    const B = load(); B.register(wallet);
    assert.equal(await B.VW.list()[0].connectSilently(), null, JSON.stringify(junk));
  }
  const { wallet } = standardWallet();
  wallet.features["standard:connect"].connect = () => { throw new Error("boom"); };
  const B = load(); B.register(wallet);
  assert.equal(await B.VW.list()[0].connectSilently(), null, "a synchronous throw too");
});

test("Wallet Standard: no answer within 2.5 s (a wallet asking the person after all) is null, and the answer that comes later is dropped", async () => {
  for (const trust of ["hang", "ignores"]) {
    const { wallet, ctl } = standardWallet({ trust });
    const B = load(); B.register(wallet);
    const a = B.VW.list()[0];
    let got = "pending";
    a.connectSilently().then((v) => { got = v; });
    await B.advance(2400);
    assert.equal(got, "pending");
    await B.advance(200);
    assert.equal(got, null, `${trust}: given up after 2.5 s`);
    ctl.answer(); await B.advance(10);
    assert.deepEqual([got, a.account], [null, undefined], "the late answer connects nothing");
  }
});

test("the tap's connect() is unchanged: standard:connect without the silent flag", async () => {
  const { wallet, ctl } = standardWallet({ trust: "no" });
  const B = load(); B.register(wallet);
  assert.equal(await B.VW.list()[0].connect(), ADDR);
  assert.deepEqual(ctl.inputs, ["none"]);
});

test("older wallets: connected already → that account; Phantom / Backpack are asked connect({ onlyIfTrusted: true }); any other is not asked at all", async () => {
  const cases = [
    [{ flags: { isPhantom: true }, trusted: true }, "phantom", ADDR, [{ onlyIfTrusted: true }]],
    [{ flags: { isPhantom: true }, trusted: false }, "phantom", null, [{ onlyIfTrusted: true }]],
    [{ flags: { isBackpack: true }, trusted: true }, "backpack", ADDR, [{ onlyIfTrusted: true }]],
    [{ flags: { isSolflare: true }, trusted: true }, "solflare", null, []],
    [{ flags: {}, trusted: true }, "solana", null, []],
    [{ flags: { isSolflare: true }, connected: true }, "solflare", ADDR, []],
  ];
  for (const [o, where, want, inputs] of cases) {
    const { p, ctl } = legacyProvider(o);
    const globals = where === "phantom" ? { phantom: { solana: p } } : where === "backpack" ? { backpack: { solana: p } } : where === "solflare" ? { solflare: p } : { solana: p };
    const B = load({ globals });
    await B.advance(400); // the first look for older wallets (350 ms)
    const a = B.VW.list()[0];
    assert.equal(a.kind, "legacy");
    assert.equal(await a.connectSilently(), want, `${where} ${JSON.stringify(o)}`);
    assert.deepEqual(ctl.inputs, inputs, `${where} ${JSON.stringify(o)}: what the wallet was asked`);
  }
  // no answer within 2.5 s: null
  const { p } = legacyProvider();
  p.connect = () => new Promise(() => {});
  const B = load({ globals: { phantom: { solana: p } } });
  await B.advance(400);
  let got = "pending";
  B.VW.list()[0].connectSilently().then((v) => { got = v; });
  await B.advance(2600);
  assert.equal(got, null);
});

/* ------------------------------------------------- the real wallets.js and swap.js together, in Phantom's own browser */
const LATER = () => new Date(Date.now() + 3_600_000).toISOString();
const answers = () => ({ "/api/swap/config": CONFIG, "/api/swap/quote": () => QUOTE({ expiresAt: LATER() }), "/api/swap/balances": { ok: true, sol: { lamports: 1e9, ui: 1 }, tokens: {} }, "/api/swap/tx": () => TX({ quote: QUOTE({ expiresAt: LATER() }) }), "/api/swap/status": { ok: true, status: "confirmed" } });
const ME = (wallet) => ({ signedIn: true, user: { id: 7, wallet, walletApp: "phantom" } });

test("real wallets.js + swap.js in Phantom's browser, signed in with that wallet: connected on load (one silent connect), amount → price ready → ONE tap → the wallet sends", async () => {
  const { wallet, ctl } = standardWallet({ trust: "yes" });
  const P = await swapPage({ clock: true, me: ME(ADDR), answers: answers(), walletsJs: { ua: UA.phantomIos, webView: true, standard: [wallet] } });
  assert.deepEqual([text(P.$(".swap__go")), text(P.$(".swap__status"))], ["Buy $VICINITY", "Connected CnQM…zz6p"]);
  assert.deepEqual(ctl.inputs, [{ silent: true }]);
  const i = P.$(".swap__amt"); i.value = "0.25"; i.dispatchEvent(newEvent("input"));
  await P.advance(1100);
  assert.deepEqual([text(P.$(".swap__state")), byPath(P.calls, "/api/swap/tx")[0].body.taker], ["Price ready", ADDR]);
  click(P.$(".swap__go"));
  await P.flush(); await P.advance(1500);
  assert.deepEqual([ctl.sends, text(P.$(".swap__state")), ctl.inputs], [[ADDR], "Swapped ✓", [{ silent: true }]], "one tap bought; the wallet was never asked to connect with a prompt");
});

test("real wallets.js + swap.js: the wallet comes late (injected after the scripts), a site the wallet never allowed, another account, or a computer: 'Connect wallet' as today", async () => {
  // late, allowed: connected once it is there
  const late = standardWallet({ trust: "yes" });
  const L = await swapPage({ clock: true, me: ME(ADDR), answers: answers(), walletsJs: { ua: UA.phantomIos, webView: true } });
  assert.equal(text(L.$(".swap__go")), "Connect wallet");
  await L.advance(1500); L.register(late.wallet); await L.flush();
  assert.deepEqual([text(L.$(".swap__go")), late.ctl.inputs], ["Buy $VICINITY", [{ silent: true }]]);
  // never allowed: nothing shared, nothing prompted; the tap connects as today
  const no = standardWallet({ trust: "no" });
  const N = await swapPage({ clock: true, me: ME(ADDR), answers: answers(), walletsJs: { ua: UA.phantomIos, webView: true, standard: [no.wallet] } });
  await N.advance(3000);
  assert.deepEqual([text(N.$(".swap__go")), no.ctl.inputs], ["Connect wallet", [{ silent: true }]]);
  click(N.$(".swap__go")); await N.flush();
  click(N.$(".swap__wallets .wallet-option")); await N.flush();
  assert.deepEqual([N.VSwap.wallet.address, no.ctl.inputs], [ADDR, [{ silent: true }, "none"]], "the person's tap: the ordinary connect");
  // another account signed in here
  const other = standardWallet({ trust: "yes" });
  const O = await swapPage({ clock: true, me: ME(OTHER), answers: answers(), walletsJs: { ua: UA.phantomIos, webView: true, standard: [other.wallet] } });
  await O.advance(3000);
  assert.deepEqual([text(O.$(".swap__go")), O.VSwap.wallet.address], ["Connect wallet", null]);
  // a computer with the same wallet as an extension: never asked
  const ext = standardWallet({ trust: "yes" });
  const C = await swapPage({ clock: true, me: ME(ADDR), answers: answers(), walletsJs: { ua: UA.desktop, standard: [ext.wallet] } });
  await C.advance(5000);
  assert.deepEqual([text(C.$(".swap__go")), ext.ctl.inputs], ["Connect wallet", []]);
});
