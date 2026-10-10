/**
 * The admin "City coins" tab's routes, /api/admin/lp/* (owner only; src/admin.js routes here behind the owner guard, with a fresh
 * wallet proof on every POST, and only while lpSetup(env).on). STUB: the admin track replaces this file; until then every route
 * answers 404 not_enabled.
 *   handleLpAdmin(request, ctx, sub, now)   ctx = { session, user, wallet, role, db, now, env, fetchImpl }, sub = the path after lp/
 */
import { json } from "./http.js";

export async function handleLpAdmin(request, ctx, sub, now = Date.now()) { // eslint-disable-line no-unused-vars
  return json({ ok: false, error: "not_enabled" }, 404);
}
