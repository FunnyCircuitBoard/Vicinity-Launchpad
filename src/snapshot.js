/**
 * Founding Supporters: who held $VICINITY before the Launchpad, counted fairly.
 *
 * A single moment can be gamed by renting tokens for an hour. So for every wallet:
 *     eligible = the LOWER of (its balance at the cutoff) and (its average over the 14 days before)
 * using the unpredictable balance samples (src/ledger.js). Pools, bonding curves and team wallets
 * are excluded. Nobody has to sign up.
 *
 * The cutoff is always 00:00 UTC, announced ahead (SNAPSHOT_CUTOFF setting or src/official.js).
 * The result is published with a Merkle root and a hash of every input (sample times, slots, data
 * hashes), then there are 48 hours to challenge it before it becomes final. If it's wrong, an admin
 * cancels it and it's computed again under a new id.
 *
 * Merkle leaf = sha256("vicinity-supporter|<snapshot id>|<wallet>|<amount in base units>|<tier>"),
 * pairs hashed in sorted order, so a future on-chain program can verify claims with a proof.
 */
import { json, readJson } from "./http.js";
import { access } from "./access.js";
import { DAY, HOUR, POLICY, iso } from "./policy.js";
import { averages, dayOf } from "./ledger.js";
import { OFFICIAL, SUPPORTER_SNAPSHOT_AT } from "./official.js";
import { getBlob, putBlob, sha256hex } from "./blobs.js";
import { adminWallets } from "./roles.js";
import { isSolanaAddress } from "./solana.js";
import { cleanText } from "./text.js";

const S = POLICY.supporters;

/** The scheduled cutoff (iso, 00:00 UTC) or null. */
export function snapshotCutoff(env) {
  const v = (env && env.SNAPSHOT_CUTOFF) || SUPPORTER_SNAPSHOT_AT;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
}

/* ---------------- Merkle tree ---------------- */
const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
export const leafHash = (id, wallet, amount, tier) => sha256hex(`vicinity-supporter|${id}|${wallet}|${amount}|${tier}`);
async function pairHash(a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const both = new Uint8Array(64); both.set(bytesOf(x), 0); both.set(bytesOf(y), 32);
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", both)));
}
/** All levels of the tree, leaves first (sorted). */
export async function merkleLevels(leaves) {
  const levels = [[...leaves].sort()];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1], next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? await pairHash(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return levels;
}
export function merkleProof(levels, leaf) {
  let i = levels[0].indexOf(leaf);
  if (i < 0) return null;
  const proof = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const sib = i ^ 1;
    if (sib < levels[l].length) proof.push(levels[l][sib]);
    i = Math.floor(i / 2);
  }
  return proof;
}
export async function verifyProof(leaf, proof, root) {
  let h = leaf;
  for (const p of proof) h = await pairHash(h, p);
  return h === root;
}

/* ---------------- computing ---------------- */

export async function computeSnapshot(env, cutoffIso, now = Date.now()) {
  const db = env.DB;
  const cutoff = Date.parse(cutoffIso), endDay = dayOf(cutoff - DAY);
  const { averages: avg, samples, days } = await averages(env, endDay, S.averageDays, null);
  if (!samples) throw new Error("no balance history before the cutoff");
  let last = null;
  for (let i = 0; i < 3 && !last; i++) last = await getBlob(db, `day:${dayOf(cutoff - (i + 1) * DAY)}`);
  if (!last) throw new Error("no balances just before the cutoff");
  const excluded = new Set([...Object.keys(last.labels || {}), ...(OFFICIAL.teamWallets || [])]);
  const scale = 10 ** (last.decimals ?? 6);
  const rows = [];
  let total = 0;
  for (const [wallet, average] of avg) {
    if (excluded.has(wallet)) continue;
    const eligible = Math.min(last.last[wallet] || 0, average);
    if (eligible < S.minAmount) continue;
    rows.push([wallet, Math.floor(eligible * scale), "supporter"]);
    total += eligible;
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const sampleList = (await db.prepare(`SELECT taken_at, slot, hash FROM balance_samples WHERE day IN (${days.map(() => "?").join(",")}) ORDER BY id`).bind(...days.map((d) => d.day)).all()).results;
  const inputs = { cutoff: cutoffIso, averageDays: S.averageDays, days, samples: sampleList, excluded: [...excluded].sort(), rule: "min(balance at cutoff, average over the days)" };
  const inputHash = await sha256hex(JSON.stringify(inputs));
  const ins = await db.prepare("INSERT INTO snapshots (cutoff_at, policy, created_at, status, activates_at, holders, total, samples, input_hash, merkle_root) VALUES (?, ?, ?, 'provisional', ?, ?, ?, ?, ?, '')")
    .bind(cutoffIso, POLICY.version, iso(now), iso(now + S.challengeHours * HOUR), rows.length, total, samples, inputHash).run();
  const id = ins.meta.last_row_id;
  const leaves = await Promise.all(rows.map(([w, amt, tier]) => leafHash(id, w, amt, tier)));
  const levels = await merkleLevels(leaves);
  const root = levels[levels.length - 1][0] || await sha256hex("empty");
  await putBlob(db, `snapshot:${id}`, { rows, inputs });
  await db.prepare("UPDATE snapshots SET merkle_root = ? WHERE id = ?").bind(root, id).run();
  console.log("supporter snapshot", id, rows.length, "wallets");
  return { id, holders: rows.length, root };
}

/** The scheduled job's part: compute the snapshot once the cutoff has passed; make it final after 48 h. */
export async function advanceSnapshots(env, now = Date.now()) {
  const db = env.DB;
  const act = await db.prepare("UPDATE snapshots SET status = 'active' WHERE status = 'provisional' AND activates_at <= ?").bind(iso(now)).run();
  const cutoff = snapshotCutoff(env);
  if (!cutoff || now < Date.parse(cutoff)) return { activated: act.meta.changes || 0 };
  if (await db.prepare("SELECT id FROM snapshots WHERE cutoff_at = ? AND status <> 'cancelled'").bind(cutoff).first()) return { activated: act.meta.changes || 0 };
  return { activated: act.meta.changes || 0, computed: await computeSnapshot(env, cutoff, now) };
}

/* ---------------- public ---------------- */

const view = (s) => ({ id: s.id, cutoff: s.cutoff_at, status: s.status, activatesAt: s.activates_at, holders: s.holders, total: s.total,
  samples: s.samples, inputHash: s.input_hash, merkleRoot: s.merkle_root, note: s.note, createdAt: s.created_at });

/** GET /api/snapshots */
export async function handleSnapshots(env) {
  const rows = (await env.DB.prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT 20").all()).results;
  return json({ scheduledCutoff: snapshotCutoff(env), rule: "eligible = min(balance at the cutoff, 14-day average); pools and team wallets excluded", snapshots: rows.map(view) });
}

const trees = new Map();
/** GET /api/snapshots/:id/proof?wallet= → amount, tier and a Merkle proof. */
export async function handleProof(env, id, wallet) {
  if (!isSolanaAddress(wallet)) return json({ error: "bad_address" }, 400);
  const s = await env.DB.prepare("SELECT * FROM snapshots WHERE id = ?").bind(Number(id)).first();
  if (!s) return json({ error: "not_found" }, 404);
  const data = await getBlob(env.DB, `snapshot:${s.id}`);
  const row = data.rows.find((r) => r[0] === wallet);
  if (!row) return json({ snapshot: view(s), wallet, eligible: false });
  let levels = trees.get(s.id);
  if (!levels) {
    levels = await merkleLevels(await Promise.all(data.rows.map(([w, a, t]) => leafHash(s.id, w, a, t))));
    trees.clear(); trees.set(s.id, levels);
  }
  const leaf = await leafHash(s.id, row[0], row[1], row[2]);
  const proof = merkleProof(levels, leaf);
  return json({ snapshot: view(s), wallet, eligible: true, amount: row[1], tier: row[2], leaf, proof, verified: await verifyProof(leaf, proof, s.merkle_root) });
}

/** GET /api/snapshots/:id/data → every row and every input, to recompute and check it yourself. */
export async function handleSnapshotData(env, id) {
  const s = await env.DB.prepare("SELECT * FROM snapshots WHERE id = ?").bind(Number(id)).first();
  if (!s) return json({ error: "not_found" }, 404);
  const data = await getBlob(env.DB, `snapshot:${s.id}`);
  return json({ snapshot: view(s), leafFormat: "sha256('vicinity-supporter|' + id + '|' + wallet + '|' + amount + '|' + tier)", ...data });
}

/** POST /api/snapshots/cancel { id, note } — an admin cancels a provisional snapshot; it's recomputed with a new id. */
export async function handleCancelSnapshot(request, env, now = Date.now()) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a.error;
  if (!adminWallets(env).includes(a.u.wallet)) return json({ ok: false, error: "not_allowed" }, 403);
  const body = await readJson(request);
  const s = body && await env.DB.prepare("SELECT * FROM snapshots WHERE id = ? AND status = 'provisional'").bind(Number(body.id) || 0).first();
  if (!s) return json({ ok: false, error: "not_found" }, 404);
  const note = cleanText(body.note, 300);
  if (!note) return json({ ok: false, error: "reason_required" }, 400);
  await env.DB.batch([
    env.DB.prepare("UPDATE snapshots SET status = 'cancelled', note = ? WHERE id = ?").bind(note, s.id),
    env.DB.prepare("INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, reason, note, created_at, state) VALUES (?, 'admin', 'cancel_snapshot', 'snapshot', ?, 'correction', ?, ?, 'done')").bind(a.u.id, s.id, note, iso(now)),
  ]);
  return json({ ok: true, status: "cancelled" });
}
