/**
 * The founder's launch and the open-market move: GET /api/lp/launch/status, POST /api/lp/launch/tx, POST /api/lp/graduate/tx,
 * POST /api/lp/founder-claim/tx (src/index.js routes /api/lp/launch/*, /api/lp/graduate/* and /api/lp/founder-claim/* here, only
 * while lpSetup(env).on). STUB: the founder track replaces this file; until then every route answers 404 not_enabled.
 */
import { json } from "./http.js";

export async function handleLaunchApi(request, env, fetchImpl = fetch, now = Date.now()) { // eslint-disable-line no-unused-vars
  return json({ ok: false, error: "not_enabled" }, 404);
}
