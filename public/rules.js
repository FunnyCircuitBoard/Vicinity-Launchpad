// Rules page: fills in every number from the live rules (/api/policy), so the page can't drift from the code.
(() => {
  "use strict";
  const { $, $$, el, api, fmt, ago } = window.V;
  (async () => {
    const d = await api("/api/policy");
    if (!d.policy) return;
    const p = d.policy, f = p.founder, m = p.manager, mod = p.moderation;
    const values = {
      version: p.version, effectiveAt: p.effectiveAt,
      founderAmount: f.tiers.length === 1 ? fmt(f.tiers[0].amount) : f.tiers.map((t) => `${fmt(t.amount)} (${fmt(t.minPopulation)}+ people)`).join(" / "),
      qualifyingDays: f.qualifyingDays, localDays: f.localDays, windowHours: f.windowHours, appealHours: f.appealHours,
      graceDays: f.graceDays, maxGraces: f.maxGraces, cooldownDays: f.cooldownDays,
      minFounderDays: m.minFounderDays, electionDays: m.electionDays, termDays: m.termDays,
      hideHours: mod.hideHours, reportsToConfirm: mod.reportsToConfirm, reportsToAutoHide: mod.reportsToAutoHide, banDays: mod.banDays,
      challengeHours: p.supporters.challengeHours, attestationMinutes: p.attestation.minutes, freshProofMinutes: p.freshProofMinutes,
    };
    for (const [k, v] of Object.entries(values)) $$(`[data-rule="${k}"]`).forEach((e) => (e.textContent = v));
    const w = f.weights;
    $("#founder-formula").textContent = `score = ${w.endorsement * 100}% × endorsement share + ${w.contribution * 100}% × contribution + ${w.stake * 100}% × holdings
holdings count from the amount up to ${f.stakeCap}× the amount (more counts the same)
ties: lowest sha256("vicinity-seat|window|wallet")`;
    $("#never-list").replaceChildren(...p.never.map((t) => el("li", null, t)));
    $("#cutoff").textContent = d.snapshotCutoff ? new Date(d.snapshotCutoff).toUTCString() : "not scheduled yet";
    const h = d.balanceHistory || {};
    $("#health-text").textContent = !d.launched ? "Balance checks start the moment $VICINITY launches."
      : h.lastSample ? `Balance checks running: last check ${ago(h.lastSample.taken_at)} (slot ${h.lastSample.slot ?? "—"}, ${fmt(h.lastSample.holders)} holders), ${h.samplesLast24h} in the last 24 hours.`
      : "Balance checks haven't recorded anything yet.";
  })();
})();
