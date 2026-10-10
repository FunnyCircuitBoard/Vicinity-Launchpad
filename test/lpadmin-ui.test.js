// The admin "City coins" tab in the page (public/admin-lp.js, wired by public/admin.js, loaded by the built admin page): the tab
// exists only for the owner and only when the server answers GET /api/admin/lp; the red MAINNET banner; every setup step with its
// state and plain reason, a button only where the session wallet can act; step 2 asks for the MULTISIG account, shows its vault and
// lets the owner go on only after confirming it matches the Squads app; approving sends the city and the expiry; a signed step is
// recorded with what the build answer said to record (and kept in the browser until it is); textContent only. Runs the real script
// in the just-enough DOM of test/helpers/pagedom.js with a stand-in API and a stand-in window.LP; real Chromium checks the looks.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { openPage } from "./helpers/pagedom.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const ADMIN_LP = read("public/admin-lp.js"), ADMIN_JS = read("public/admin.js"), ADMIN_HTML = read("public/admin.html"), CSS = read("public/admin.css");
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects made inside the page's realm
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const OWNER = "Own3r1111111111111111111111111111111111111", VAULT = "VauLt111111111111111111111111111111111111111", MS = "MuLti11111111111111111111111111111111111111";
const step = (id, n, state, reason, extra = {}) => ({ id, n, title: `Title ${id}`, state, reason, ...extra });

function statusOf({ cluster = "mainnet", steps, problems = [], launchesPaused = false } = {}) {
  return {
    ok: true, cluster, wallet: OWNER, devWallet: "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN", isDevWallet: false,
    programs: {
      launchpad: { id: "LaunchPad111111111111111111111111111111111", exists: true, executable: true, upgradeable: true, upgradeAuthority: OWNER, size: 433960, sha256: "ab".repeat(32) },
      rewards: { id: "Rewards1111111111111111111111111111111111111", exists: true, executable: true, upgradeable: true, upgradeAuthority: OWNER, size: 505864, sha256: "cd".repeat(32) },
    },
    launchpad: { admin: OWNER, launchesPaused }, problems, complete: false,
    steps: steps || [
      step("start", 1, "done", "The launchpad and the rewards registry are running."),
      step("handoff", 2, "ready", "Paste your Squads multisig account."),
      step("config", 3, "blocked", "Do step 2 first (hand the programs to your Squads)."),
      step("allow", 4, "blocked", "Do step 3 first (create the price curve)."),
      step("referral", 5, "blocked", "Do step 2 first (hand the programs to your Squads)."),
      step("lookup", 6, "blocked", "Do step 3 first: the speed table holds the price curve's address."),
      step("partner", 7, "blocked", "Only the dev wallet 13qRam… can sign this."),
    ],
  };
}
const CANDIDATES = {
  ok: true, global: [], paused: false,
  candidates: [
    { cityId: "5128581", cityName: "New York City", country: "US", name: "Big Apple", ticker: "NYC", symbol: "NYC", pair: "SOL", founder: "F0under1111111111111111111111111111111111111", handle: "nyc", pitch: "The city that never sleeps.", logo: true, designAt: "2026-10-09T08:00:00.000Z", ok: true, reasons: [], warnings: ["The founder is the launchpad admin's own wallet."] },
    { cityId: "5140405", cityName: "Syracuse", country: "US", name: "Salt City", ticker: "SYRACUSE", pair: "USDC", founder: "F1under1111111111111111111111111111111111111", ok: false, reasons: ["The coin is paired with USDC; only SOL-paired coins can launch on the Vicinity curve for now. The founder must pick SOL."], warnings: [] },
  ],
  approvals: [{ cityId: "5106834", cityName: "Albany", approval: { founder: "F2under1111111111111111111111111111111111111", name: "Albany", symbol: "ALBANY", expiresAt: "2026-10-17T12:00:00.000Z", expired: false },
    warnings: ["The approved wallet no longer holds the founder seat (the city has no founder now), but it can still launch this city's coin on chain until the approval expires. Revoke it."] }],
  launched: [],
};

/** The admin page with site.js, a stand-in window.LP, then admin-lp.js; `answers[path]` is what each API path returns. */
async function tab({ answers = {}, probe = { ok: true, cluster: "mainnet" }, lp = {} } = {}) {
  const page = await openPage("admin.html", { agreed: "2026-10-01" });
  const win = page.window;
  win.setTimeout = (fn) => { setImmediate(fn); return 0; };
  const calls = [], prepared = [];
  const reply = (path, body) => {
    const p = path.replace(/[?&]cluster=[a-z]+/, "").replace(/\?$/, "");
    const a = p === "/api/admin/lp" ? probe : answers[p.split("?")[0]];
    return typeof a === "function" ? a(body, path) : a || { ok: false, error: "not_found" };
  };
  const api = async (path, body) => { calls.push({ path, body: body ?? null }); return reply(path, body); };
  const post = async (path, body) => { calls.push({ path, body, post: true }); return reply(path, body); };
  win.LP = {
    supported: async () => lp.supported ?? true,
    say: (code, extra) => (extra && extra.message) || `said:${code}`,
    renderSummary: (el, res) => { el.textContent = `summary of ${res.step}`; },
    prepare: async ({ wallet, ephemeral, cluster, build }) => {
      const keys = Array.from({ length: ephemeral }, (_, i) => `Eph${i}`);
      const res = await build(keys);
      prepared.push({ wallet, ephemeral, cluster, res });
      if (!res || !res.ok) throw Object.assign(new Error(res && res.message ? res.message : "refused"), { code: res && res.error, detail: res });
      return { response: res, keys, sign: async ({ onStatus }) => { onStatus("signing"); if (lp.reject) throw new Error("You cancelled in your wallet. Nothing was sent."); onStatus("done"); return { signature: "Sig111", status: "confirmed", solscan: "https://solscan.io/tx/Sig111" }; } };
    },
  };
  vm.runInContext(ADMIN_LP, win, { filename: "public/admin-lp.js" });
  const panel = page.doc.createElement("div");
  page.doc.body.append(panel);
  const toasts = [];
  const deps = { api, post, toast: (m) => toasts.push(m), el: win.V.el, short: win.V.short, me: { wallet: OWNER, role: "owner" }, wallet: async () => ({ address: OWNER, signTransaction() {} }) };
  await win.AdminLP.mount(panel, deps);
  await tick();
  const text = () => panel.textContent;
  const button = (label) => panel.querySelectorAll("button").find((b) => b.textContent === label);
  return { ...page, panel, calls, prepared, toasts, text, button, win, deps };
}

test("the built admin page loads lp-sign.js and admin-lp.js before admin.js; admin.js shows the tab only for the owner when the server answers", () => {
  const order = ["/wallets.js", "/lp-sign.js", "/admin-lp.js", "/admin.js"].map((s) => ADMIN_HTML.indexOf(`<script src="${s}" defer></script>`));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(ADMIN_JS, /\["citycoins", "City coins", 3\]/);
  // asked only when /api/admin/config says the settings are there (cityCoins): a site without them sends no request and logs no 404
  assert.match(ADMIN_JS, /lpOn = me\.role === "owner" && Boolean\(config && config\.cityCoins\) && Boolean\(\(await api\("\/api\/admin\/lp"\)/);
  assert.match(ADMIN_JS, /\(id !== "citycoins" \|\| lpOn\)/);
  assert.match(ADMIN_JS, /window\.AdminLP\.mount\(p, \{ api, post, toast, el, short, me, wallet: lpWallet \}\)/);
  assert.doesNotMatch(ADMIN_LP, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(/, "textContent only");
  for (const cls of ["lp-banner--main", "lp-step", "lp-badge--done", "lp-sum__net--main", "lp-sum__accts", "lp-json"]) assert.match(CSS, new RegExp(`\\.${cls}\\b`), cls);
});

test("not switched on: the tab says so and reads nothing else", async () => {
  const t = await tab({ probe: { ok: false, error: "not_enabled" } });
  assert.match(t.text(), /City coins are not switched on for this site/);
  assert.deepEqual(t.calls.map((c) => c.path), ["/api/admin/lp"]);
});

test("mainnet: a red banner, both programs with their fingerprints, each step's state and reason, and a button only where you can act", async () => {
  const t = await tab({ answers: { "/api/admin/lp/status": statusOf(), "/api/admin/lp/candidates": CANDIDATES, "/api/admin/lp/coins": { ok: true, coins: [] }, "/api/admin/lp/platform/plan": { ok: true, claims: [{ kind: "poolCreationFee", amount: "45000000", unit: "lamports" }], totals: { quote: "0", lamports: "45000000" }, transactions: 1, isDevWallet: false }, "/api/admin/lp/summary": { ok: true, summary: { cluster: "mainnet", squadsVault: null } } } });
  const banner = t.panel.querySelector(".lp-banner");
  assert.ok(banner.classList.contains("lp-banner--main"));
  assert.equal(banner.textContent, "MAINNET: real SOL. Every step here spends real money and cannot be undone.");
  assert.match(t.text(), /Launchpad program.*433,960 bytes.*abab/);
  assert.match(t.text(), /Compare the fingerprint with the one the team sent you/);
  const steps = t.panel.querySelectorAll(".lp-step");
  assert.equal(steps.length, 8);
  assert.deepEqual(steps.slice(0, 7).map((s) => s.querySelector(".lp-badge").textContent), ["Done", "Ready", "Waiting", "Waiting", "Waiting", "Waiting", "Waiting"]);
  assert.match(steps[2].textContent, /Do step 2 first/);
  assert.equal(steps[2].querySelector("button"), null, "no button on a step you cannot do");
  assert.ok(steps[1].querySelector("input"), "step 2 asks for the multisig account");
  assert.match(steps[7].textContent, /"cluster": "mainnet"/, "step 8: the summary for the team");
  assert.match(steps[7].textContent, /nothing secret/);
  // every request echoes the cluster
  assert.ok(t.calls.filter((c) => c.path !== "/api/admin/lp").every((c) => /[?&]cluster=mainnet/.test(c.path)), JSON.stringify(t.calls.map((c) => c.path)));
  // cities: the blocked one says why; the founder-is-admin warning
  assert.match(t.text(), /paired with USDC; only SOL-paired coins/);
  assert.match(t.text(), /The founder is the launchpad admin's own wallet/);
  assert.match(t.text(), /Only the dev wallet 13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN can collect these/);
});

test("devnet: the banner says it is a test network", async () => {
  const t = await tab({ probe: { ok: true, cluster: "devnet" }, answers: { "/api/admin/lp/status": statusOf({ cluster: "devnet" }) } });
  const banner = t.panel.querySelector(".lp-banner");
  assert.equal(banner.classList.contains("lp-banner--main"), false);
  assert.match(banner.textContent, /Solana devnet \(test network\)/);
});

test("step 2: the pasted multisig is checked, its vault shown, and Prepare stays off until the owner confirms it matches the Squads app", async () => {
  let built = null;
  const t = await tab({ answers: {
    "/api/admin/lp/status": statusOf(),
    "/api/admin/lp/squads": (b, path) => (path.includes(MS) ? { ok: true, multisig: MS, vault: VAULT, threshold: 2, members: [{ key: "M1", vote: true }, { key: "M2", vote: true }, { key: "M3", vote: false }], warnings: [] } : { ok: false, error: "not_multisig", message: "This is a wallet or a Squads vault, not the multisig account." }),
    "/api/admin/lp/tx": (b) => { built = b; return { ok: true, step: "handoff", cluster: "mainnet", record: { step: "handoff", params: { multisig: MS } } }; },
    "/api/admin/lp/record": () => ({ ok: true }),
  } });
  const s2 = t.panel.querySelectorAll(".lp-step")[1];
  const input = s2.querySelector("input");
  input.value = VAULT;
  t.button("Check").click(); await tick();
  assert.match(s2.textContent, /This is a wallet or a Squads vault, not the multisig account/);
  input.value = ` ${MS} `;
  t.button("Check").click(); await tick();
  assert.match(s2.textContent, /2 of 3 members/);
  assert.match(s2.textContent, new RegExp(`Vault \\(the new upgrade authority\\)${VAULT}`));
  assert.match(s2.textContent, /M3 \(cannot vote\)/);
  assert.match(s2.textContent, /check that its vault address is exactly the one above/);
  const prep = t.button("Prepare step 2");
  assert.equal(prep.disabled, true);
  prep.click(); await tick();
  assert.equal(built, null, "nothing built before the owner confirms the vault");
  const box = s2.querySelector("#lp-vault-ok");
  box.checked = true; box.dispatchEvent({ type: "change", bubbles: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(prep.disabled, false);
  prep.click(); await tick();
  assert.deepEqual(plain(built), { step: "handoff", params: { multisig: MS, vault: VAULT }, cluster: "mainnet", ephemeral: [] });
  assert.match(s2.textContent, /summary of handoff/, "the decoded list before the wallet opens");
  t.button("Approve in your wallet").click(); await tick(30);
  const rec = t.calls.filter((c) => c.path === "/api/admin/lp/record");
  assert.deepEqual(plain(rec.map((c) => c.body)), [{ step: "handoff", signature: "Sig111", params: { multisig: MS }, cluster: "mainnet" }]);
  assert.deepEqual(t.toasts, ["Done and recorded ✓"]);
  assert.deepEqual(JSON.parse(t.storage.get("vicinity_lp_pending") || "[]"), [], "nothing left to record");
});

test("a step with a one-time key: built with the browser key, recorded with the address the build answer names; kept until recorded", async () => {
  let n = 0;
  const steps = statusOf().steps.map((s) => (s.id === "config" ? { ...s, state: "ready", ephemeral: 1 } : s));
  const t = await tab({ answers: {
    "/api/admin/lp/status": statusOf({ steps }),
    "/api/admin/lp/tx": (b) => ({ ok: true, step: b.step, cluster: "mainnet", record: { step: "config", params: { address: b.ephemeral[0] } } }),
    "/api/admin/lp/record": () => (++n < 99 ? { ok: false, error: "rpc_unavailable" } : { ok: true }),
  } });
  t.button("Prepare step 3").click(); await tick();
  assert.equal(t.prepared[0].ephemeral, 1);
  t.button("Approve in your wallet").click(); await tick(60);
  assert.match(t.text(), /Done on the blockchain\..*try to record it again next time/);
  const pending = JSON.parse(t.storage.get("vicinity_lp_pending"));
  assert.deepEqual(pending.map((p) => [p.step, p.signature, p.params, p.cluster]), [["config", "Sig111", { address: "Eph0" }, "mainnet"]]);
  assert.deepEqual(t.toasts, ["Done on the blockchain ✓"]);
  // the next time the tab draws itself it offers to record it again, and drops it once recorded
  assert.equal(t.button("Try recording again"), undefined, "the message stays in the step until the tab draws itself again");
  assert.match(t.text(), /Done on the blockchain\..*try to record it again next time/);
  await t.win.AdminLP.mount(t.panel, t.deps); await tick(60);
  assert.match(t.text(), /1 confirmed transaction is not recorded here yet/);
});

/** The approve_launch entry of a build answer's list, as src/lpkit.js decodes it from the instruction's bytes. */
const approveEntry = (over = {}) => ({ programName: "Vicinity launchpad", ix: "approve_launch", say: "approve a city coin", detail: "the coin ...", accounts: [],
  fields: { cityId: "5128581", founder: "F0under1111111111111111111111111111111111111", name: "Big Apple", symbol: "NYC", expiresAt: "2026-11-08T12:00:00.000Z", ...over } });

test("approving a city sends what its card showed and the chosen expiry; the approval's own name, ticker, founder and expiry are shown big; a refusal is plain words", async () => {
  const bodies = [];
  const t = await tab({ answers: {
    "/api/admin/lp/status": statusOf(), "/api/admin/lp/candidates": CANDIDATES,
    "/api/admin/lp/approve/tx": (b) => { bodies.push(b); return bodies.length === 1 ? { ok: false, error: "blocked", message: "The founder's seat is in its grace period." } : { ok: true, step: "approve", cluster: "mainnet", summary: [approveEntry()], record: { step: "approve", params: { cityId: b.cityId } } }; },
    "/api/admin/lp/record": () => ({ ok: true }),
  } });
  // the card shows the description and the logo the owner approves along with the name
  assert.match(t.text(), /Description \(wallets and Jupiter show it for ever\)The city that never sleeps\./);
  assert.match(t.text(), /LogoYes/);
  const sel = t.panel.querySelector(".lp-select");
  assert.equal(sel.value, "7", "7 days by default");
  t.button("Approve on chain").click(); await tick();
  assert.match(t.text(), /The founder's seat is in its grace period/);
  assert.equal(t.button("Approve in your wallet"), undefined);
  sel.value = "30";
  t.button("Approve on chain").click(); await tick();
  assert.deepEqual(plain(bodies[1]), { cityId: "5128581", name: "Big Apple", symbol: "NYC", founder: "F0under1111111111111111111111111111111111111", designAt: "2026-10-09T08:00:00.000Z", expiryDays: 30, cluster: "mainnet", ephemeral: [] });
  const box = t.panel.querySelector(".lp-approve");
  assert.ok(box, "the approval's own arguments, above the list");
  assert.match(box.textContent, /You are approving, for ever on the blockchain:/);
  assert.match(box.textContent, /Coin nameBig Apple/);
  assert.match(box.textContent, /Ticker\$NYC/);
  assert.match(box.textContent, /Founder wallet \(only it can launch\)F0under1111111111111111111111111111111111111/);
  assert.match(box.textContent, /2026-11-08 12:00 UTC/);
  t.button("Approve in your wallet").click(); await tick(30);
  assert.deepEqual(plain(t.calls.filter((c) => c.path === "/api/admin/lp/record").map((c) => c.body.params)), [{ cityId: "5128581" }]);
  assert.ok(t.button("Revoke"), "the waiting approval can be revoked");
  assert.match(t.text(), /Albany · \$ALBANY/);
  assert.match(t.text(), /no longer holds the founder seat.*Revoke it\./, "a stale approval is flagged");
});

test("approving: a build whose approval is not the card's (another name or founder) offers nothing to sign", async () => {
  for (const over of [{ name: "Vicinity Official Airdrop" }, { founder: "F9under1111111111111111111111111111111111111" }, { symbol: "NY" }, { cityId: "5140405" }]) {
    const t = await tab({ answers: {
      "/api/admin/lp/status": statusOf(), "/api/admin/lp/candidates": CANDIDATES,
      "/api/admin/lp/approve/tx": () => ({ ok: true, step: "approve", cluster: "mainnet", summary: [approveEntry(over)], record: { step: "approve", params: { cityId: "5128581" } } }),
    } });
    t.button("Approve on chain").click(); await tick();
    assert.match(t.text(), /does not match this card\. Nothing was sent/, JSON.stringify(over));
    assert.equal(t.button("Approve in your wallet"), undefined);
  }
  // no approve_launch in the answer at all: the same
  const t = await tab({ answers: { "/api/admin/lp/status": statusOf(), "/api/admin/lp/candidates": CANDIDATES, "/api/admin/lp/approve/tx": () => ({ ok: true, step: "approve", cluster: "mainnet", summary: [], record: { step: "approve", params: {} } }) } });
  t.button("Approve on chain").click(); await tick();
  assert.equal(t.button("Approve in your wallet"), undefined);
});

test("a cancelled wallet: the page says so and records nothing", async () => {
  const steps = statusOf().steps.map((s) => (s.id === "referral" ? { ...s, state: "ready" } : s));
  const t = await tab({ lp: { reject: true }, answers: { "/api/admin/lp/status": statusOf({ steps }), "/api/admin/lp/tx": () => ({ ok: true, step: "referral", cluster: "mainnet", record: { step: "referral", params: {} } }) } });
  t.button("Prepare step 5").click(); await tick();
  t.button("Approve in your wallet").click(); await tick(20);
  assert.match(t.text(), /You cancelled in your wallet\. Nothing was sent\./);
  assert.equal(t.calls.some((c) => c.path === "/api/admin/lp/record"), false);
  assert.ok(t.button("Cancel"), "the owner can close it");
});
