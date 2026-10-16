/**
 * City coin pictures are checked by a person before anyone sees them (city identity protections, step 2; the owner's rule: human
 * approval first, automated checks may come later).
 *
 *   Founder   saving a picture (src/coins.js handleDesign) stores it as the WORKING picture (city_coins.media_id) with logo_status
 *             'pending'. Only the founder and the staff (owner, admin, moderator) can see a working picture; everyone else sees no
 *             picture until it is approved (the site shows the city's initials, /coin-meta/<mint>.png serves the Vicinity badge to
 *             wallets). Replacing it starts a new check; removing it clears everything.
 *   Admin     GET /api/admin/logos lists what waits (and what was decided lately); POST /api/admin/logos/decide approves or rejects
 *             (src/admin.js wires both). Approving copies the working picture to approved_media_id and stores the sha256 of its bytes
 *             in logo_hash. Rejecting records a reason from POLICY.moderation.reasons and a note the founder sees. Every decision is
 *             one public mod-log line (city, action, reason: never the note). A logo takedown (src/coins.js) is a rejection that
 *             also removes the public picture at once.
 *   Public    every public surface shows approved_media_id or nothing (src/coins.js coinView, /coin-meta/<mint>.png). /api/media/<id>
 *             serves a coin picture to everyone only when it is some coin's approved picture AND its bytes still hash to that coin's
 *             logo_hash: a swapped or tampered row is "not found". Coin pictures are cached an hour, not a year, so a removed one
 *             lingers at most an hour.
 * Schema: src/store.js ensureLogoSchema (lazy, additive, idempotent).
 */
import { POLICY, iso } from "./policy.js";
import { sha256hex, toBytes } from "./blobs.js";
import { cleanText } from "./text.js";
import { ensureLogoSchema } from "./store.js";

export const STATUSES = ["pending", "approved", "rejected"];
export const PICTURE_MAX_AGE = 3600; // seconds a public coin picture may sit in a cache
export const NOTE_MIN = 3, NOTE_MAX = 300;
/** The picture types readImage (src/social.js) lets in; nothing else is ever approved or served as a coin picture. */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const RECENT_DAYS = 30; // decided pictures stay in the admin list this long

export const mediaUrl = (id) => (id ? `/api/media/${id}` : null);
/** sha256 hex of a picture's bytes, however D1 hands them back. */
export const hashOf = (bytes) => sha256hex(toBytes(bytes));
// an approved picture is approved_media_id with its hash, whatever the WORKING picture's state (a replacement that waits for a check
// does not take the approved one down; a rejection, a takedown or a removal clears both fields)
const isApproved = (row) => Boolean(row && row.approved_media_id && row.logo_hash);

/** What everyone may know: the approved picture's URL and the hash of its bytes (both null without an approved picture). */
export function publicLogo(row) {
  const ok = isApproved(row);
  return { logo: ok ? mediaUrl(row.approved_media_id) : null, logoHash: ok ? row.logo_hash : null };
}
/** What the founder and the staff see on top of that: the working picture and where its check stands. */
export function reviewView(row) {
  return {
    logoStatus: row.media_id ? row.logo_status || "pending" : row.logo_status === "rejected" ? "rejected" : null,
    logoDraft: mediaUrl(row.media_id),
    logoReason: row.logo_status === "rejected" ? row.logo_reason || null : null,
    logoNote: row.logo_status === "rejected" ? row.logo_note || null : null,
    logoReviewedAt: row.logo_reviewed_at || null,
  };
}

/** The founder saved a new picture: the working picture changes and a new check starts (an earlier approved picture keeps showing). */
export const pendingStatement = (db, cityId) =>
  db.prepare("UPDATE city_coins SET logo_status = 'pending', logo_reason = NULL, logo_note = NULL, logo_reviewed_at = NULL, logo_reviewed_by = NULL WHERE city_id = ?").bind(String(cityId));
/** The founder removed the picture: nothing is shown anywhere and nothing waits. */
export const clearedStatement = (db, cityId) =>
  db.prepare(`UPDATE city_coins SET media_id = NULL, approved_media_id = NULL, logo_hash = NULL, logo_status = NULL, logo_reason = NULL, logo_note = NULL,
    logo_reviewed_at = NULL, logo_reviewed_by = NULL WHERE city_id = ?`).bind(String(cityId));

/**
 * Approve the working picture `mediaId` of a city: it becomes the public picture, with the hash of its bytes. The row is matched on
 * media_id too, so a picture the founder replaced after the admin looked is never approved unseen.
 * Returns the hash, or "changed" (another picture is the working one now) or "gone" (no such media row, or not a picture: only
 * readImage makes coin media rows today, so this is a second check, not the first).
 */
export async function approveLogo(db, cityId, mediaId, { by, at }) {
  const m = await db.prepare("SELECT type, bytes FROM media WHERE id = ?").bind(mediaId).first();
  if (!m || !IMAGE_TYPES.has(m.type)) return "gone";
  const hash = await hashOf(m.bytes);
  const r = await db.prepare(`UPDATE city_coins SET approved_media_id = ?, logo_hash = ?, logo_status = 'approved', logo_reason = NULL, logo_note = NULL,
      logo_reviewed_at = ?, logo_reviewed_by = ? WHERE city_id = ? AND media_id = ?`)
    .bind(mediaId, hash, iso(at), by, String(cityId), mediaId).run();
  return r.meta.changes ? hash : "changed";
}
/**
 * Reject the working picture of a city with a reason and a note for the founder. The public picture goes only when it is this very
 * picture. `mediaId` (when given) must still be the working one. Returns true, or false when the working picture changed meanwhile.
 * `takedown` (POST /api/coins/takedown): the PUBLIC picture is what breaks the rules, so it always goes; when a newer working picture
 * waits for its check (or was decided on its own), that picture's state, reason and note are left as they are: nobody has looked at
 * it, and it stays in the admin's queue. The caller makes sure the coin has a picture at all.
 */
export async function rejectLogo(db, cityId, { mediaId = null, reason, note, by, at, takedown = false }) {
  const t = takedown ? 1 : 0;
  // true only for a takedown whose public picture is not the working one: then the working picture's review is untouched
  const keep = "(? AND approved_media_id IS NOT NULL AND media_id IS NOT approved_media_id)";
  const r = await db.prepare(`UPDATE city_coins SET
      logo_status = CASE WHEN ${keep} THEN logo_status ELSE 'rejected' END,
      logo_reason = CASE WHEN ${keep} THEN logo_reason ELSE ? END,
      logo_note = CASE WHEN ${keep} THEN logo_note ELSE ? END,
      logo_reviewed_at = CASE WHEN ${keep} THEN logo_reviewed_at ELSE ? END,
      logo_reviewed_by = CASE WHEN ${keep} THEN logo_reviewed_by ELSE ? END,
      approved_media_id = CASE WHEN ? OR approved_media_id = media_id THEN NULL ELSE approved_media_id END,
      logo_hash = CASE WHEN ? OR approved_media_id = media_id THEN NULL ELSE logo_hash END
    WHERE city_id = ? AND (? IS NULL OR media_id = ?)`)
    .bind(t, t, reason, t, note, t, iso(at), t, by, t, t, String(cityId), mediaId, mediaId).run();
  return Boolean(r.meta.changes);
}
/** A reason the rules know and a note of 3 to 300 characters, or null. */
export function checkReason(body) {
  const reason = body && POLICY.moderation.reasons.includes(body.reason) ? body.reason : null;
  const note = cleanText(body && body.note, NOTE_MAX);
  if (!reason || note == null || note.length < NOTE_MIN) return null;
  return { reason, note };
}

/** Same masking style as mask() in src/me.js: a founder's wallet is never listed whole here. */
const maskWallet = (w) => (w ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null);

/**
 * The admin's list: every working picture that waits (oldest first), then the ones decided in the last 30 days (newest first).
 * `preview` is the working picture through /api/media, which serves it to the staff and the founder only.
 */
export async function listPictures(db, now = Date.now()) {
  await ensureLogoSchema(db);
  const since = iso(now - RECENT_DAYS * 86400_000);
  const rows = (await db.prepare(`SELECT c.city_id, c.city_name, c.country, c.name, c.mint, c.media_id, c.approved_media_id, c.logo_status, c.logo_reason, c.logo_note,
        c.logo_reviewed_at, c.logo_hash, m.type, length(m.bytes) AS size, m.created_at AS uploaded_at, u.handle, u.wallet
      FROM city_coins c JOIN media m ON m.id = c.media_id LEFT JOIN users u ON u.id = c.user_id
      WHERE c.logo_status IS NOT NULL AND (c.logo_status = 'pending' OR c.logo_reviewed_at >= ?)
      ORDER BY CASE WHEN c.logo_status = 'pending' THEN 0 ELSE 1 END, CASE WHEN c.logo_status = 'pending' THEN m.created_at END ASC, c.logo_reviewed_at DESC
      LIMIT 200`).bind(since).all()).results;
  const logos = rows.map((r) => ({
    city: { id: String(r.city_id), name: r.city_name, country: r.country }, coin: r.name, launched: Boolean(r.mint),
    founder: { handle: r.handle || null, wallet: maskWallet(r.wallet) },
    mediaId: r.media_id, preview: mediaUrl(r.media_id), type: r.type, size: r.size, uploadedAt: r.uploaded_at,
    status: r.logo_status, reason: r.logo_reason || null, note: r.logo_note || null, reviewedAt: r.logo_reviewed_at || null,
    approved: Boolean(r.approved_media_id), current: r.approved_media_id != null && r.approved_media_id === r.media_id, hash: isApproved(r) ? r.logo_hash : null,
  }));
  return { logos, waiting: logos.filter((l) => l.status === "pending").length };
}
/** How many pictures wait for a check (the admin Overview). */
export async function waitingPictures(db) {
  await ensureLogoSchema(db);
  return (await db.prepare("SELECT COUNT(*) AS n FROM city_coins WHERE logo_status = 'pending' AND media_id IS NOT NULL").first()).n;
}

/**
 * An admin's decision on a city's working picture: { city, action: "approve" | "reject", mediaId?, reason?, note? }.
 * Returns { error, status } or { ok: true, action, coin (the row before), hash?, reason?, note? }. The caller logs it.
 */
export async function decidePicture(db, body, { by, at }) {
  await ensureLogoSchema(db);
  const action = body && body.action;
  const cityId = body && /^\d{1,20}$/.test(String(body.city || "")) ? String(body.city) : null;
  if (!cityId || !["approve", "reject"].includes(action)) return { error: "bad_request", status: 400 };
  const coin = await db.prepare("SELECT * FROM city_coins WHERE city_id = ?").bind(cityId).first();
  if (!coin || !coin.media_id) return { error: "not_found", status: 404 };
  const mediaId = body.mediaId == null ? coin.media_id : Number(body.mediaId);
  if (mediaId !== coin.media_id) return { error: "picture_changed", status: 409 }; // the founder replaced it since the admin looked
  if (action === "approve") {
    const hash = await approveLogo(db, cityId, mediaId, { by, at });
    if (hash === "gone") return { error: "not_found", status: 404 };
    if (hash === "changed") return { error: "picture_changed", status: 409 };
    return { ok: true, action, coin, hash };
  }
  const why = checkReason(body);
  if (!why) return { error: "reason_required", status: 400 };
  if (!(await rejectLogo(db, cityId, { mediaId, ...why, by, at }))) return { error: "picture_changed", status: 409 };
  return { ok: true, action, coin, ...why };
}

/**
 * The public log line of a decision: the city, the action and the reason. The note stays with the founder (the dashboard shows it to
 * them alone); the mod log's note field carries the city's name only, like the other coin lines.
 */
export function logDecision(db, { by, action, coin, reason, at }) {
  return db.prepare(`INSERT INTO mod_actions (actor_id, actor_role, action, target_type, target_id, target_user, country, place, reason, note, created_at, state)
      VALUES (?, 'admin', ?, 'city_coin', NULL, ?, ?, ?, ?, ?, ?, 'done')`)
    .bind(by, action === "approve" ? "coin_logo_approved" : "coin_logo_rejected", coin.user_id, coin.country, String(coin.city_id), reason, coin.city_name, iso(at)).run();
}

/**
 * For /api/media and /coin-meta: a media row is served to everyone only when it is a coin's approved picture and its bytes still hash
 * to that coin's logo_hash. `approvedHash` is the coin's stored hash (or null); the answer is true only when the bytes match it.
 */
export async function bytesApproved(bytes, approvedHash) {
  return Boolean(approvedHash) && (await hashOf(bytes)) === approvedHash;
}
