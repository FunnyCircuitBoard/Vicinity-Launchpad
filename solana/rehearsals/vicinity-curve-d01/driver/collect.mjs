// Re-reads every transaction of the D01 log from the chain and prints the markdown table of the report (signature,
// compute units in total and per top-level program, fee, size, events, result). Public data only.
import { readFileSync, writeFileSync } from 'node:fs';
const L = await import('./lib.mjs');
const c = await L.devnet(L.RPC_A);
const lines = readFileSync(L.LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const NAMES = {
  nhgCmApbVPVeAkhpQZeoBkrKkNWfkoyKDzeUxSYS7tk: 'vicinity_curve', ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'ATA', TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token',
  Fncx4qBhEK3xEFN2gGkNCEaUz1r8W9DprHUt83mDrcx7: 'old launchpad', Hm14pFPABUUGVxX7HZhTBoFV3aCkKXmDY54WnGAjJrYi: 'vicinity_rewards', SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: 'Squads v4',
  ComputeBudget111111111111111111111111111111: 'ComputeBudget', '11111111111111111111111111111111': 'System',
};
const rows = [];
const seen = new Set();
// figures read before the validator's ledger was bounded (old slots are pruned since): used when a transaction is gone
let cache = {};
try { cache = Object.fromEntries(JSON.parse(readFileSync(`${L.TOOLS}/table-${L.TARGET}-cache.json`, 'utf8')).map((r) => [r.sig, r])); } catch { cache = {}; }
for (const e of lines) {
  if (!e.sig || seen.has(e.sig)) continue;
  seen.add(e.sig);
  const t = await c.getTransaction(e.sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!t) { rows.push(cache[e.sig] ? { ...cache[e.sig], label: e.label, phase: e.phase } : { ...e, missing: true }); continue; }
  const per = L.topLevelCu(t.meta.logMessages ?? []).map((x) => `${NAMES[x.program] ?? x.program.slice(0, 6)} ${x.consumed}`).join(', ');
  const err = t.meta.err ? (e.error ?? JSON.stringify(t.meta.err)) : '';
  let events = [];
  try { events = L.S.decodeTransactionEvents(t).map((x) => x.name); } catch { events = []; }
  rows.push({ phase: e.phase, label: e.label, sig: e.sig, slot: t.slot, cu: t.meta.computeUnitsConsumed, per, fee: t.meta.fee, bytes: e.bytes ?? '', events: events.join(' '), err, note: e.note ?? '' });
}
rows.sort((a, b) => (Number(a.slot ?? 0) - Number(b.slot ?? 0)));
const md = ['| # | phase | step | signature | slot | CU (total) | CU per top-level program | fee (lamports) | bytes | events | result |', '|---|---|---|---|---|---|---|---|---|---|---|'];
rows.forEach((r, i) => md.push(`| ${i + 1} | ${r.phase} | ${r.label}${r.note ? ` (${r.note})` : ''} | \`${r.sig}\` | ${r.slot ?? ''} | ${r.cu ?? ''} | ${r.per ?? ''} | ${r.fee ?? ''} | ${r.bytes} | ${r.events ?? ''} | ${r.missing ? 'not found' : r.err ? `refused: ${r.err}` : 'ok'} |`));
writeFileSync(`${L.TOOLS}/table-${L.TARGET}.md`, md.join('\n') + '\n');
writeFileSync(`${L.TOOLS}/table-${L.TARGET}.json`, JSON.stringify(rows, null, 1));
console.log(md.join('\n'));
