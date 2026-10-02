/**
 * The admin console's numbers: is Vicinity set up for launch? Admins only.
 *
 *   GET /api/admin/status → { checks: [{ id, ok, label, fix }], counts, snapshots }
 *
 * Only yes / no and counts. A secret's value is never read out, never sent, never shown: the Worker only asks
 * "is it set?". Each failed check says which Cloudflare setting to add (Workers → vicinity-map → Settings →
 * Variables and secrets). This is what turns "sign-in doesn't work" into a named missing setting.
 */
import { json } from "./http.js";
import { access } from "./access.js";
import { providers } from "./auth.js";
import { activeMint } from "./official.js";
import { adminWallets } from "./roles.js";
import { ledgerStatus } from "./ledger.js";
import { snapshotCutoff } from "./snapshot.js";

export async function handleAdminStatus(request, env, now = Date.now()) {
  const a = await access(request, env, now, { write: false });
  if (a.error) return a.error;
  const admins = adminWallets(env);
  if (!admins.includes(a.u.wallet)) return json({ ok: false, error: "not_allowed" }, 403);
  const db = env.DB;
  const launched = Boolean(activeMint(env));
  const prov = providers(env);
  const history = await ledgerStatus(env, now);
  const one = async (sql) => (await db.prepare(sql).first())?.n || 0;
  const checks = [
    { id: "mint", ok: launched, label: "$VICINITY contract address", fix: "Add the secret VICINITY_MINT the moment the token exists. Until then nothing that needs holdings can start." },
    { id: "rpc", ok: Boolean(env.SOLANA_RPC_URL), label: "Solana RPC (full holder list)", fix: "Add the secret SOLANA_RPC_URL (a Helius URL). Without it only the top 20 holders show and nobody can qualify as a founder." },
    { id: "admins", ok: admins.length > 0, label: `Admin wallets (${admins.length})`, fix: "Add the secret ADMIN_WALLETS. Two or more admins let an admin's own decisions be judged by the other." },
    { id: "google", ok: prov.google, label: "Log in with Google", fix: "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, and the redirect address https://vicinity.city/api/auth/google/callback." },
    { id: "x", ok: prov.x, label: "Log in with X", fix: "Add X_CLIENT_ID and X_CLIENT_SECRET, and the callback address https://vicinity.city/api/auth/x/callback." },
    { id: "cutoff", ok: Boolean(snapshotCutoff(env)), label: "Founding Supporter cutoff announced", fix: "Add SNAPSHOT_CUTOFF (00:00 UTC, e.g. 2026-10-08T00:00:00Z) and announce it first." },
    { id: "sampling", ok: !launched || history.running, label: "Balance checks running", fix: launched ? "No balance sample has been recorded yet. Check the 10-minute schedule and the RPC." : "Starts the moment the token launches." },
  ];
  const [users, homes, steward, seats, windows, towns, objections] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM users"), one("SELECT COUNT(*) AS n FROM users WHERE home_city IS NOT NULL"),
    one("SELECT COUNT(*) AS n FROM seats WHERE status = 'steward'"), one("SELECT COUNT(*) AS n FROM seats WHERE status IN ('provisional', 'active', 'grace', 'steward')"),
    one("SELECT COUNT(*) AS n FROM windows WHERE status = 'open'"), one("SELECT COUNT(*) AS n FROM town_requests WHERE status IN ('waiting', 'recommended', 'not_recommended')"),
    one("SELECT COUNT(*) AS n FROM objections WHERE status = 'open'"),
  ]);
  const snaps = (await db.prepare("SELECT id, cutoff_at, status, activates_at, holders FROM snapshots ORDER BY id DESC LIMIT 5").all()).results
    .map((s) => ({ id: s.id, cutoff: s.cutoff_at, status: s.status, activatesAt: s.activates_at, holders: s.holders }));
  return json({ ok: true, launched, checks, counts: { users, homes, seats, stewards: steward, windows, towns, objections },
    balanceHistory: history, snapshotCutoff: snapshotCutoff(env), snapshots: snaps });
}
