// Rules page: fills in every number from the live rules (/api/policy), so the page can't drift from the code.
(() => {
  "use strict";
  const { $, $$, el, api, fmt, ago } = window.V;
  // each rule is a fold: open on a computer, closed on a phone (one card at a time); a link to a rule (/rules#founders) opens its fold
  const folds = $$(".rules-grid details");
  if (window.matchMedia && window.matchMedia("(min-width: 800px)").matches) folds.forEach((d) => (d.open = true));
  const openTarget = () => { let t = null; try { t = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null; } catch {} const d = t && t.closest ? t.closest("details") : null; if (d) d.open = true; };
  openTarget(); window.addEventListener("hashchange", openTarget);
  (async () => {
    const d = await api("/api/policy");
    if (!d.policy) return;
    const p = d.policy, f = p.founder, m = p.manager, mod = p.moderation;
    const L = f.ladder;
    const values = {
      version: p.version, effectiveAt: p.effectiveAt,
      // v5: the Stake Ladder — no more flat 1M. Compact form here; the full formula is on the page.
      founderAmount: `${fmt(L.base)}–${fmt(L.max)} by city size`,
      qualifyingDays: f.qualifyingDays, localDays: f.localDays, windowHours: f.windowHours, appealHours: f.appealHours,
      graceDays: f.graceDays, maxGraces: f.maxGraces, cooldownDays: f.cooldownDays,
      stewardProbationDays: f.stewardProbationDays, stewardQuorum: f.stewardQuorum,
      stewardChallengeEndorsements: f.stewardChallengeEndorsements, stewardGraceHours: f.stewardGraceHours,
      darkCityDays: f.darkCityDays, squadMin: f.squadMin, squadMax: f.squadMax,
      minFounderDays: m.minFounderDays, electionDays: m.electionDays, termDays: m.termDays,
      hideHours: mod.hideHours, reportsToConfirm: mod.reportsToConfirm, reportsToAutoHide: mod.reportsToAutoHide, banDays: mod.banDays,
      challengeHours: p.supporters.challengeHours, attestationMinutes: p.attestation.minutes, freshProofMinutes: p.freshProofMinutes,
    };
    for (const [k, v] of Object.entries(values)) $$(`[data-rule="${k}"]`).forEach((e) => (e.textContent = v));
    const w = f.weights;
    // The Stake Ladder, rendered from the live policy so the examples can't drift from the code.
    const ex = (pop) => {
      const raw = L.base * Math.cbrt(Math.max(pop, 1) / L.refPop);
      return Math.floor(Math.min(L.max, Math.max(L.base, raw)) / L.rung) * L.rung;
    };
    const eg = (pop) => `${pop >= 1e6 ? (pop / 1e6) + "M" : Math.round(pop / 1e3) + "K"} people → ${fmt(ex(pop))}`;
    const ladderEl = $("#ladder-formula");
    if (ladderEl) ladderEl.textContent =
      `stake = ${fmt(L.base)} × (population ÷ ${fmt(L.refPop)})^(1/3), clamped ${fmt(L.base)}–${fmt(L.max)}, rounded down to ${fmt(L.rung)}\n` +
      `rule of eight: 8× the people → 2× the stake\n` +
      [10_000, 80_000, 640_000, 5_120_000, 10_000_000].map(eg).join(" · ");
    $("#founder-formula").textContent = `score = ${w.endorsement * 100}% × endorsement share + ${w.contribution * 100}% × contribution + ${w.stake * 100}% × holdings
holdings count from the amount up to ${f.stakeCap}× the amount (more counts the same)
ties: lowest sha256("vicinity-seat|window|wallet")`;
    $("#never-list").replaceChildren(...p.never.map((t) => el("li", null, t)));
    $("#cutoff").textContent = d.snapshotCutoff ? new Date(d.snapshotCutoff).toUTCString() : "not scheduled yet";
    const h = d.balanceHistory || {};
    $("#health-text").textContent = !d.launched ? "Balance checks start the moment $VICINITY launches."
      : h.lastSample ? `Balance checks running: last check ${ago(h.lastSample.taken_at)} (slot ${h.lastSample.slot ?? "—"}, ${fmt(h.lastSample.holders)} holding wallets, pools and team wallets included), ${h.samplesLast24h} in the last 24 hours.`
      : "Balance checks haven't recorded anything yet.";
  })();
})();
