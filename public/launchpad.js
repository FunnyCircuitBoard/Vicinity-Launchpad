// Launchpad page: live countdown to the opening, and an "add to my calendar" file.
(() => {
  "use strict";
  const { $, $$, official, opensAt, reduced } = window.V;
  const START = Date.parse("2026-09-26T00:00:00Z"); // countdown bar starts here
  const pad = (n) => String(n).padStart(2, "0");
  let last = {};

  function tick() {
    const at = opensAt(), ms = Math.max(0, at - Date.now());
    const parts = { days: Math.floor(ms / 86400000), hours: Math.floor((ms % 86400000) / 3600000), minutes: Math.floor((ms % 3600000) / 60000), seconds: Math.floor((ms % 60000) / 1000) };
    for (const [k, v] of Object.entries(parts)) {
      const e = $(`[data-cd="${k}"]`); if (!e) continue;
      const txt = k === "days" ? String(v) : pad(v);
      if (last[k] !== txt) { e.textContent = txt; if (!reduced && last[k] !== undefined) { e.classList.remove("is-tick"); void e.offsetWidth; e.classList.add("is-tick"); } last[k] = txt; }
    }
    $("#countdown")?.classList.toggle("is-open", ms === 0);
    const bar = $("#lp-bar"); if (bar) bar.style.width = `${Math.min(100, Math.max(0, ((Date.now() - START) / (at - START)) * 100)).toFixed(2)}%`;
    const d = new Date(at);
    $("#lp-date").textContent = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    $("#lp-local").textContent = ms === 0 ? "The Launchpad is open." : `Opens ${d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })} (your time).`;
  }
  official.then(tick); tick(); setInterval(tick, 1000);

  // A standard calendar file, made right here in the browser.
  $("#lp-cal")?.addEventListener("click", () => {
    const at = new Date(opensAt()), stamp = (t) => t.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Vicinity//Launchpad//EN", "BEGIN:VEVENT", `UID:launchpad-${at.getTime()}@vicinity.city`,
      `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(at)}`, `DTEND:${stamp(new Date(at.getTime() + 3600000))}`,
      "SUMMARY:Vicinity Launchpad opens", "DESCRIPTION:Every city gets its own coin. Details: https://vicinity.city/launchpad", "URL:https://vicinity.city/launchpad",
      "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a");
    a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    a.download = "vicinity-launchpad.ics";
    document.body.append(a); a.click(); a.remove();
  });
  void $$;
})();

// Founding Supporter snapshot: status, and any wallet's amount + Merkle proof.
(() => {
  "use strict";
  const { $, el, api, fmt, isAddr } = window.V;
  let snap = null;
  (async () => {
    const d = await api("/api/snapshots");
    snap = (d.snapshots || []).find((s) => s.status !== "cancelled") || null;
    const st = $("#snap-status"); if (!st) return;
    if (snap) st.textContent = `Snapshot #${snap.id} (cutoff ${new Date(snap.cutoff).toUTCString()}): ${snap.status === "active" ? "final" : `challenge period until ${new Date(snap.activatesAt).toLocaleString()}`} · ${fmt(snap.holders)} wallets · Merkle root ${snap.merkleRoot.slice(0, 16)}…`;
    else st.textContent = d.scheduledCutoff ? `Cutoff scheduled for ${new Date(d.scheduledCutoff).toUTCString()}.` : "The cutoff hasn't been announced yet. It will be, here, well ahead of time.";
  })();
  $("#snap-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("#snap-result"), w = $("#snap-input").value.trim();
    if (!isAddr(w)) { out.replaceChildren(el("p", "wallet__error", "That doesn't look like a Solana wallet address.")); return; }
    if (!snap) { out.replaceChildren(el("p", "muted", "No snapshot has been published yet.")); return; }
    const r = await api(`/api/snapshots/${snap.id}/proof?wallet=${encodeURIComponent(w)}`);
    if (!r.eligible) { out.replaceChildren(el("p", null, "This wallet isn't in the snapshot.")); return; }
    const proof = el("pre", "formula", JSON.stringify({ leaf: r.leaf, proof: r.proof, root: r.snapshot.merkleRoot }, null, 1));
    out.replaceChildren(el("p", null, `✓ Founding Supporter: ${fmt(r.amount / 1e6)} $VICINITY counted${r.verified ? " · proof verified" : ""}.`), proof);
  });
})();
