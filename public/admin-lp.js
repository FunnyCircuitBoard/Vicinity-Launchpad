// The admin "City coins" tab (window.AdminLP): the launchpad's setup after the programs are deployed, approving cities, and the
// buttons that replace a keeper (collect fees, holder rewards, platform fees, pause). Needs site.js (window.V), lp-sign.js
// (window.LP) and admin.js, which calls AdminLP.mount(panel, deps) when the owner opens the tab. Every step is one wallet
// signature: the Worker builds and simulates the transaction (/api/admin/lp/*), this page shows what will be signed and the exact
// SOL change BEFORE the wallet opens, lp-sign.js has any one-time key sign first, then the wallet signs and sends it itself (or,
// a wallet that only signs, signs and the site's relay sends), then this page records the result. Only textContent here: nothing from the server is ever HTML.
(() => {
  "use strict";
  const PENDING = "vicinity_lp_pending"; // a transaction that landed but was not recorded yet (per browser; retried on the next visit)
  const SAY_STATUS = { signing: "Waiting for your wallet…", sending: "Sending…", confirming: "Sent. Waiting for the network to confirm…", done: "Confirmed on the blockchain.",
    // the send's outcome is not known yet (lp-sign.js: the relay's unclear: true, or no answer from the site): watched, never sent twice
    unclear: "Sent, but the network's answer did not come back. Watching the blockchain for it: do not send it again." };
  const STAGE = { curve: "On the price curve", full: "Curve full: ready to move to the open market", graduated: "On the open market (Meteora pool)", unknown: "Its curve could not be read" };
  let D = null, cluster = null, root = null, probe = null;

  const el = (...a) => D.el(...a);
  const sol = (lamports) => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 6 })} SOL`;
  const words = (r) => (r && (r.message || (window.LP ? window.LP.say(r.error, r) : r.error))) || "Something went wrong.";
  const q = (path) => `${path}${path.includes("?") ? "&" : "?"}cluster=${encodeURIComponent(cluster)}`;
  function btn(label, onClick, cls = "btn btn--sm") {
    const b = el("button", cls, label); b.type = "button";
    b.addEventListener("click", async () => { if (b.disabled) return; b.disabled = true; try { await onClick(b); } finally { if (b.isConnected) b.disabled = false; } });
    return b;
  }
  const addr = (a) => el("span", "mono lp-addr", a || "—");
  const fact = (dl, label, value) => { dl.append(el("dt", null, label)); const dd = el("dd"); if (value && typeof value === "object") dd.append(value); else dd.textContent = value == null ? "—" : String(value); dl.append(dd); };
  const section = (title, intro) => { const s = el("section", "lp-section"); s.append(el("h3", null, title)); if (intro) s.append(el("p", "muted small", intro)); return s; };
  const loading = () => el("p", "muted", "Loading…");

  /* ---------------------------------------------------------------- remembering a transaction until it is recorded */
  const readPending = () => { try { const v = JSON.parse(localStorage.getItem(PENDING) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
  const writePending = (list) => { try { localStorage.setItem(PENDING, JSON.stringify(list.slice(-20))); } catch { /* private window: the page still records right away */ } };
  const forget = (signature) => writePending(readPending().filter((x) => x.signature !== signature));
  async function record(entry, tries = 6) {
    let r = null;
    for (let i = 0; i < tries; i++) {
      r = await D.post("/api/admin/lp/record", { step: entry.step, signature: entry.signature, params: entry.params || {}, cluster });
      if (r && r.ok) { forget(entry.signature); return r; }
      if (!r || !["not_confirmed", "not_done", "rpc_unavailable", "offline"].includes(r.error)) break;
      await new Promise((ok) => setTimeout(ok, 2500));
    }
    if (r && ["bad_signature", "failed", "wrong_transaction", "not_yours", "bad_step"].includes(r.error)) forget(entry.signature);
    return r;
  }
  async function retryPending() {
    for (const p of readPending().filter((x) => x.cluster === cluster)) await record(p, 1);
  }

  /* ---------------------------------------------------------------- one signature: prepare, show, sign, record */
  /**
   * In `box`: build through `path` (the Worker checks the step and simulates it), show the decoded list and the SOL change, then
   * "Approve in your wallet". The build answer says what to record once it is confirmed (record: { step, params }).
   */
  async function signFlow(box, { path, body = {}, ephemeral = 0, after = null, check = null }) {
    box.replaceChildren(el("p", "muted", "Preparing: the site builds this transaction and tries it on the blockchain first (nothing is sent)."));
    let h;
    try {
      if (ephemeral && !(await window.LP.supported())) throw Object.assign(new Error(window.LP.say("unsupported")), { code: "unsupported" });
      const wallet = await D.wallet();
      h = await window.LP.prepare({ wallet, ephemeral, cluster, build: (keys) => D.post(path, { ...body, cluster, ephemeral: keys }) });
    } catch (e) {
      box.replaceChildren(el("p", "lp-error", e && e.message ? e.message : "Couldn't prepare this step."));
      if (e && e.detail && Array.isArray(e.detail.reasons)) box.append(reasonList(e.detail.reasons));
      return;
    }
    // a step can check the built transaction against what its card showed, and put what matters most above the list
    const head = check ? check(h.response) : null;
    if (head && head.stop) { box.replaceChildren(head.node); return; }
    const sum = el("div", "lp-sum");
    window.LP.renderSummary(sum, h.response);
    const line = el("p", "lp-status");
    line.setAttribute("role", "status");
    const go = btn("Approve in your wallet", async () => {
      cancel.disabled = true;
      try {
        const r = await h.sign({ onStatus: (s, _sig, extra) => { line.textContent = s === "confirming" && extra && extra.unclear ? SAY_STATUS.unclear : SAY_STATUS[s] || s; } });
        const what = h.response.record || {};
        const entry = { step: what.step, signature: r.signature, params: what.params || {}, cluster, at: Date.now() };
        writePending([...readPending(), entry]);
        line.textContent = "Confirmed on the blockchain. Recording it here…";
        const rec = await record(entry);
        line.textContent = rec && rec.ok ? "Done and recorded." : `Done on the blockchain. ${words(rec)} This page will try to record it again next time.`;
        if (r.solscan) { const a = el("a", "lp-link", "See it on Solscan"); a.href = r.solscan; a.target = "_blank"; a.rel = "noopener"; line.append(" ", a); }
        go.remove(); cancel.remove();
        D.toast(rec && rec.ok ? "Done and recorded ✓" : "Done on the blockchain ✓");
        if (after && rec && rec.ok) await after(r); // not recorded yet: the message stays, and the tab offers to record it again
      } catch (e) {
        line.textContent = e && e.message ? e.message : "Something went wrong. Nothing was sent.";
        if (e && e.signature && e.solscan) { const a = el("a", "lp-link", "Check it on Solscan"); a.href = e.solscan; a.target = "_blank"; a.rel = "noopener"; line.append(" ", a); }
        cancel.disabled = false;
        // it went out and may still land, or it may have gone out with no id to watch (lp-sign.js `unclear`): never offered twice
        // (the tab shows the step's state on the next visit)
        if (e && (e.signature || e.unclear)) go.remove();
      }
    }, "btn btn--primary");
    const cancel = btn("Cancel", () => box.replaceChildren());
    const row = el("div", "admin-row"); row.append(go, cancel);
    box.replaceChildren(...(head ? [head.node] : []), sum, row, line);
    go.focus();
  }
  const reasonList = (reasons) => { const ul = el("ul", "lp-reasons"); for (const r of reasons) ul.append(el("li", null, r)); return ul; };
  /**
   * The approval's own arguments, read back from the transaction's bytes by the site (summary entry approve_launch, .fields): they
   * must be the card's name, ticker, founder and city, or nothing is offered. Shown big, because the wallet does not show them.
   */
  function approveCheck(c) {
    return (res) => {
      const ix = (res.summary || []).find((x) => x.ix === "approve_launch");
      const f = ix && ix.fields;
      if (!f || f.cityId !== c.cityId || f.name !== c.name || f.symbol !== c.symbol || f.founder !== c.founder) {
        return { stop: true, node: el("p", "lp-error", "The transaction the site built does not match this card. Nothing was sent. Reload the page; if it happens again, tell the team.") };
      }
      const wrap = el("div", "lp-note lp-approve");
      wrap.append(el("p", "lp-strong", "You are approving, for ever on the blockchain:"));
      const dl = el("dl", "lp-facts");
      fact(dl, "Coin name", f.name);
      fact(dl, "Ticker", `$${f.symbol}`);
      fact(dl, "Founder wallet (only it can launch)", addr(f.founder));
      fact(dl, "Can launch until", `${new Date(f.expiresAt).toLocaleString()} (${f.expiresAt.slice(0, 16).replace("T", " ")} UTC)`);
      wrap.append(dl, el("p", "muted small", "Check the name and the founder wallet once more. Your wallet will not show them: it only shows the accounts and the SOL."));
      return { node: wrap };
    };
  }

  /* ---------------------------------------------------------------- setup */
  const BADGE = { done: "Done", ready: "Ready", blocked: "Waiting" };
  function programCard(name, p, wallet, vault) {
    const c = el("div", "lp-card");
    c.append(el("h4", null, name));
    const dl = el("dl", "lp-facts");
    fact(dl, "Address", addr(p.id));
    fact(dl, "Deployed", !p.exists ? "Not on this network yet" : !p.upgradeable ? "Yes, but not with the upgradeable loader" : p.executable ? "Yes" : "Not executable");
    const who = p.upgradeAuthority === wallet ? " (your wallet)" : vault && p.upgradeAuthority === vault ? " (your Squads vault)" : p.immutable ? "" : p.upgradeAuthority ? " (someone else)" : "";
    fact(dl, "Upgrade authority", p.immutable ? "None: the program is final" : p.upgradeAuthority ? `${p.upgradeAuthority}${who}` : "—");
    if (p.size) fact(dl, "Size", `${Number(p.size).toLocaleString("en-US")} bytes`);
    if (p.sha256) fact(dl, "Fingerprint (SHA-256)", addr(p.sha256));
    c.append(dl);
    if (p.sha256) c.append(el("p", "muted small", "Compare the fingerprint with the one the team sent you; they must be identical."));
    return c;
  }
  async function setupSection(s, st) {
    const steps = el("ol", "lp-steps");
    for (const x of st.steps) {
      const li = el("li", `lp-step lp-step--${x.state}`);
      const head = el("div", "lp-step__head");
      head.append(el("span", "lp-step__n", String(x.n)), el("strong", null, x.title), el("span", `lp-badge lp-badge--${x.state}`, BADGE[x.state] || x.state));
      li.append(head, el("p", "lp-step__why", x.reason));
      const box = el("div", "lp-step__box");
      if (x.id === "handoff" && (x.state === "ready" || x.adoptable)) li.append(handoffForm(box, x));
      else if (x.state === "ready") li.append(btn(`Prepare step ${x.n}`, () => signFlow(box, { path: "/api/admin/lp/tx", body: { step: x.id }, ephemeral: x.ephemeral || 0, after: rerender })));
      li.append(box);
      steps.append(li);
    }
    const last = el("li", "lp-step");
    const head = el("div", "lp-step__head");
    head.append(el("span", "lp-step__n", "8"), el("strong", null, "Send this to the team"), el("span", `lp-badge lp-badge--${st.complete ? "done" : "blocked"}`, st.complete ? "Ready to send" : "After steps 1-7"));
    last.append(head, summaryBox());
    steps.append(last);
    s.append(steps);
  }
  function handoffForm(box, x) {
    const wrap = el("div", "lp-handoff");
    const input = el("input", "lp-input"); input.placeholder = "Your Squads multisig account address"; input.autocomplete = "off"; input.spellcheck = false;
    input.setAttribute("aria-label", "Squads multisig account address");
    const out = el("div", "lp-handoff__out");
    const check = btn("Check", async () => {
      out.replaceChildren(el("p", "muted", "Reading it from the blockchain…"));
      const a = input.value.trim();
      const r = await D.api(q(`/api/admin/lp/squads?address=${encodeURIComponent(a)}`));
      if (!r || !r.ok) { out.replaceChildren(el("p", "lp-error", words(r))); return; }
      const dl = el("dl", "lp-facts");
      fact(dl, "Approvals needed", `${r.threshold} of ${r.members.length} members`);
      fact(dl, "Members", (() => { const ul = el("ul", "lp-plain"); for (const m of r.members) ul.append(el("li", "mono lp-addr", `${m.key}${m.vote ? "" : " (cannot vote)"}`)); return ul; })());
      fact(dl, "Vault (the new upgrade authority)", addr(r.vault));
      out.replaceChildren(dl);
      for (const wmsg of r.warnings || []) out.append(el("p", "lp-warn", wmsg));
      out.append(el("p", "lp-strong", "Open app.squads.so, pick this multisig, and check that its vault address is exactly the one above. Only then go on."));
      const ok = el("input"); ok.type = "checkbox"; ok.id = "lp-vault-ok";
      const lab = el("label", "lp-check"); lab.append(ok, el("span", null, " The vault above is the vault in my Squads app."));
      out.append(lab);
      const go = r.alreadyHandedOver
        ? btn("Record it", async () => {
          const rec = await D.post("/api/admin/lp/record", { step: "handoff", signature: null, params: { multisig: r.multisig }, cluster });
          if (rec && rec.ok) { D.toast("Recorded ✓"); await rerender(); } else out.append(el("p", "lp-error", words(rec)));
        }, "btn btn--primary")
        : btn("Prepare step 2", () => signFlow(box, { path: "/api/admin/lp/tx", body: { step: "handoff", params: { multisig: r.multisig, vault: r.vault } }, after: rerender }), "btn btn--primary");
      go.disabled = true;
      ok.addEventListener("change", () => { go.disabled = !ok.checked; });
      if (r.alreadyHandedOver) out.append(el("p", "muted small", "Both programs already belong to this vault: this only records it here."));
      out.append(go);
    });
    const row = el("div", "admin-row"); row.append(input, check);
    wrap.append(row, out);
    if (x.state !== "ready") wrap.prepend(el("p", "muted small", "If the programs already belong to your Squads vault, check your multisig here to record it."));
    return wrap;
  }

  function summaryBox() {
    const box = el("div", "lp-summary");
    const pre = el("pre", "lp-json", "Loading…");
    const copy = btn("Copy", async () => {
      try { await navigator.clipboard.writeText(pre.textContent); D.toast("Copied ✓"); } catch { D.toast("Select the text and copy it by hand."); }
    });
    box.append(pre, copy);
    const next = el("ol", "lp-next");
    for (const t of [
      "Copy this box and send it to the team (it holds only public addresses and transaction ids, nothing secret).",
      "The team checks every address against the blockchain, read only.",
      "The team switches on city-coin trading with a change you approve (it names the price curve and the speed table above).",
      "Then approve your first city below. Its founder launches the coin from their Founder tab.",
    ]) next.append(el("li", null, t));
    box.append(el("p", "lp-strong", "What happens next"), next);
    D.api(q("/api/admin/lp/summary")).then((r) => { pre.textContent = r && r.ok ? JSON.stringify(r.summary, null, 2) : words(r); });
    return box;
  }

  /* ---------------------------------------------------------------- cities */
  async function citiesSection(s) {
    const body = el("div"); body.append(loading()); s.append(body);
    const r = await D.api(q("/api/admin/lp/candidates"));
    if (!r || !r.ok) { body.replaceChildren(el("p", "lp-error", words(r))); return; }
    body.replaceChildren();
    if (r.global && r.global.length) { const g = el("div", "lp-note"); g.append(el("p", "lp-strong", "Approving is not possible yet:"), reasonList(r.global)); body.append(g); }
    if (r.paused) body.append(el("p", "lp-warn", "Launches are paused: approved founders cannot launch until you resume them (below)."));
    body.append(el("h4", null, "Approve a city coin"));
    if (!r.candidates.length) body.append(el("p", "muted", "No city has a coin design waiting."));
    for (const c of r.candidates) {
      const card = el("div", `lp-card${c.ok ? "" : " lp-card--blocked"}`);
      card.append(el("h4", null, `${c.cityName}${c.country ? ` (${c.country})` : ""}`));
      const dl = el("dl", "lp-facts");
      fact(dl, "Coin", `${c.name} · $${c.ticker || "?"} · paired with ${c.pair}`);
      fact(dl, "Founder", c.founder ? addr(`${c.handle ? `@${c.handle} · ` : ""}${c.founder}`) : "No founder seat");
      fact(dl, "Description (wallets and Jupiter show it for ever)", c.pitch || "None: the standard text is used");
      // the picture is checked separately (Moderation › Pictures): only an approved one is ever shown; the launch does not wait for it.
      // The badge lines speak of the chain's image URL (/coin-meta/<mint>.png, what wallets show); the site shows the city's initials.
      fact(dl, "Picture", c.approved && c.logoStatus !== "approved" ? `An approved picture shows; a newer one ${c.logoStatus === "rejected" ? "was not approved" : "waits for a check (Moderation › Pictures)"}`
        : c.logoStatus === "approved" ? "Approved (on the coin page; you can still take it down later)"
          : c.logoStatus === "rejected" ? "Not approved: wallets show the Vicinity badge until the founder sends another"
            : c.logo ? "Waiting for a check (Moderation › Pictures): wallets show the Vicinity badge until it is approved" : "None: the Vicinity badge is used");
      card.append(dl);
      for (const wmsg of c.warnings || []) card.append(el("p", "lp-warn", wmsg));
      const box = el("div", "lp-step__box");
      if (c.ok) {
        const sel = el("select", "lp-select"); sel.setAttribute("aria-label", "How long the approval lasts");
        for (const d of [1, 3, 7, 14, 30]) { const o = el("option", null, `${d} day${d === 1 ? "" : "s"}`); o.value = String(d); sel.append(o); }
        sel.value = "7";
        const lab = el("label", "field"); lab.append(el("span", "fieldset__label", "The founder can launch within"), sel);
        const row = el("div", "admin-row");
        // the card sends what it shows: the site builds nothing if the design changed since (reload and look again)
        const seen = { cityId: c.cityId, name: c.name, symbol: c.symbol, founder: c.founder, designAt: c.designAt };
        row.append(lab, btn("Approve on chain", () => signFlow(box, { path: "/api/admin/lp/approve/tx", body: { ...seen, expiryDays: Number(sel.value) }, check: approveCheck(c), after: rerender }), "btn btn--primary"));
        card.append(row, el("p", "muted small", "Your wallet pays the approval's rent (about 0.0016 SOL); it comes back when the founder launches or you revoke. From the moment you prepare it, the founder can no longer change this design."));
      } else card.append(el("p", "lp-strong", "Not yet:"), reasonList(c.reasons));
      card.append(box);
      body.append(card);
    }
    body.append(el("h4", null, "Approved, waiting for the founder"));
    if (!r.approvals.length) body.append(el("p", "muted", "None."));
    for (const a of r.approvals) {
      const card = el("div", "lp-card");
      card.append(el("h4", null, `${a.cityName} · $${a.approval.symbol}`));
      const dl = el("dl", "lp-facts");
      fact(dl, "Name on chain", a.approval.name);
      fact(dl, "Founder", addr(a.approval.founder));
      fact(dl, "Expires", `${new Date(a.approval.expiresAt).toLocaleString()}${a.approval.expired ? " (expired)" : ""}`);
      card.append(dl);
      for (const wmsg of a.warnings || []) card.append(el("p", "lp-warn", wmsg));
      const box = el("div", "lp-step__box");
      card.append(btn("Revoke", () => signFlow(box, { path: "/api/admin/lp/revoke/tx", body: { cityId: a.cityId }, after: rerender })), box);
      body.append(card);
    }
  }

  /* ---------------------------------------------------------------- launched coins */
  async function coinsSection(s) {
    const body = el("div"); body.append(loading()); s.append(body);
    const r = await D.api(q("/api/admin/lp/coins"));
    if (!r || !r.ok) { body.replaceChildren(el("p", "lp-error", words(r))); return; }
    body.replaceChildren();
    if (!r.coins.length) { body.append(el("p", "muted", "No city coin is launched yet.")); return; }
    for (const c of r.coins) {
      const card = el("div", "lp-card");
      card.append(el("h4", null, `${c.cityName || `City ${c.cityId}`}${c.name ? ` · ${c.name}` : ""}`));
      const dl = el("dl", "lp-facts");
      fact(dl, "Stage", `${STAGE[c.stage] || c.stage}${c.stage === "curve" && c.progressPct != null ? ` (${c.progressPct}% of the target)` : ""}`);
      fact(dl, "City fees waiting on the curve", sol(c.curveFees));
      if (c.surplusDue) fact(dl, "Curve surplus", "Waiting to be collected");
      fact(dl, "Holders pot", sol(c.holdersPot));
      fact(dl, "Founder's vault", sol(c.founderVault));
      fact(dl, "Holder rewards", c.rewards ? (c.rewards.ok ? "Set up (holders only)" : "Set up differently: tell the team") : "Not set up yet");
      const link = el("a", "lp-link", "Coin page"); link.href = c.coinPage;
      fact(dl, "Coin", link);
      card.append(dl);
      const box = el("div", "lp-step__box");
      const row = el("div", "admin-row");
      const cityBody = { cityId: c.cityId };
      if (BigInt(c.curveFees) > 0n || c.surplusDue || c.stage === "graduated") row.append(btn("Collect city fees", () => signFlow(box, { path: "/api/admin/lp/collect/tx", body: cityBody, after: rerender })));
      if (!c.rewards) row.append(btn("Set up holder rewards", () => signFlow(box, { path: "/api/admin/lp/init-city/tx", body: cityBody, after: rerender })));
      if (c.rewards && c.rewards.ok && BigInt(c.holdersPot) > 0n) row.append(btn("Forward holders' share", () => signFlow(box, { path: "/api/admin/lp/forward/tx", body: cityBody, after: rerender })));
      if (c.stage === "full") { const a = el("a", "btn btn--sm", "Move to the open market"); a.href = c.coinPage; row.append(a); }
      card.append(row);
      if (c.stage === "full") card.append(el("p", "muted small", "Anyone can move a full curve to the open market from its coin page; the wallet that does it pays about 0.03 SOL."));
      card.append(box);
      body.append(card);
    }
  }

  /* ---------------------------------------------------------------- platform fees and pause */
  async function platformSection(s) {
    const body = el("div"); body.append(loading()); s.append(body);
    const r = await D.api(q("/api/admin/lp/platform/plan"));
    if (!r || !r.ok) { body.replaceChildren(el("p", "lp-error", words(r))); return; }
    body.replaceChildren();
    const dl = el("dl", "lp-facts");
    fact(dl, "Launch fees waiting", sol(r.totals.lamports));
    fact(dl, "Trading fees and surplus waiting", sol(r.totals.quote));
    fact(dl, "Pool positions", `${r.claims.filter((c) => c.kind === "poolPositionFee").length} (their fees are known only when collected)`);
    body.append(dl);
    if (!r.transactions) { body.append(el("p", "muted", "Nothing is waiting.")); return; }
    if (!r.isDevWallet) { body.append(el("p", "muted", `Only the dev wallet ${probe && probe.devWallet ? probe.devWallet : "13qRam…"} can collect these. Sign in with it to collect.`)); return; }
    const box = el("div", "lp-step__box");
    body.append(btn(`Collect (${r.transactions} transaction${r.transactions === 1 ? "" : "s"}, one at a time)`, () => signFlow(box, { path: "/api/admin/lp/platform/tx", body: {}, after: rerender }), "btn btn--primary"), box);
  }
  function pauseSection(s, st) {
    if (!st.launchpad) { s.append(el("p", "muted", "The launchpad is not started yet.")); return; }
    const paused = st.launchpad.launchesPaused;
    s.append(el("p", null, paused ? "Launches are PAUSED: approved founders cannot launch." : "Launches are running."));
    const box = el("div", "lp-step__box");
    s.append(btn(paused ? "Resume launches" : "Pause launches", () => signFlow(box, { path: "/api/admin/lp/pause/tx", body: { launches: !paused }, after: rerender })), box);
  }

  /* ---------------------------------------------------------------- the tab */
  async function rerender() { await render(); }
  async function render() {
    const top = el("div", "lp");
    const banner = el("p", `lp-banner${cluster === "mainnet" ? " lp-banner--main" : ""}`, cluster === "mainnet"
      ? "MAINNET: real SOL. Every step here spends real money and cannot be undone."
      : `Solana ${cluster} (test network): nothing here is real money.`);
    banner.setAttribute("role", "note");
    top.append(banner, el("h2", null, "City coins"),
      el("p", "muted", "Set up the launchpad once, then approve cities. Every step asks your wallet for one signature. Before your wallet opens, this page shows exactly what you will sign and how much SOL it costs; compare it with your wallet's screen."));
    root.replaceChildren(top);
    await retryPending();
    const left = readPending().filter((x) => x.cluster === cluster);
    if (left.length) {
      const n = el("div", "lp-note lp-note--warn");
      n.append(el("p", "lp-strong", `${left.length} confirmed transaction${left.length === 1 ? " is" : "s are"} not recorded here yet.`),
        el("p", "muted small", "They happened on the blockchain; this page only needs to note them. It tries again each time you open this tab."),
        btn("Try recording again", () => rerender()));
      top.append(n);
    }
    const st = await D.api(q("/api/admin/lp/status"));
    if (!st || !st.ok) { top.append(el("p", "lp-error", words(st))); return; }
    if (st.problems && st.problems.length) { const p = el("div", "lp-note lp-note--warn"); p.append(el("p", "lp-strong", "Check these first:"), reasonList(st.problems)); top.append(p); }
    const vault = st.squads && st.squads.vault ? st.squads.vault : null;
    const cards = el("div", "lp-cards");
    cards.append(programCard("Launchpad program", st.programs.launchpad, st.wallet, vault), programCard("Rewards program", st.programs.rewards, st.wallet, vault));
    const setup = section("Setup", "Do the steps in order. Step 1 needs both programs' upgrade authority in your wallet (the guide's step 10); step 2 hands them to your Squads right after.");
    setup.append(cards);
    await setupSection(setup, st);
    const cities = section("Cities", "A founder can launch only after you approve their city on chain. The name and ticker are fixed at approval.");
    const coins = section("Launched coins", "These buttons do what a keeper would do. Anyone may pay for them; nobody can move the city's money anywhere else.");
    const platform = section("Platform fees", "Vicinity's share of every trade and launch waits on Meteora until the dev wallet collects it.");
    const pause = section("Launches", "Pausing stops new launches only. Trading and fees go on.");
    pauseSection(pause, st);
    top.append(setup, cities, coins, platform, pause);
    await Promise.all([citiesSection(cities), coinsSection(coins), platformSection(platform)]);
  }

  async function mount(panel, deps) {
    D = deps; root = panel;
    probe = await D.api("/api/admin/lp");
    if (!probe || !probe.ok) { panel.replaceChildren(el("p", "muted", "City coins are not switched on for this site.")); return; }
    cluster = probe.cluster;
    probe.devWallet = "13qRam63xqqd8KNUoAmHWQu7ro71oHqEsYHYaG5MsRiN";
    await render();
  }

  window.AdminLP = { mount };
})();
