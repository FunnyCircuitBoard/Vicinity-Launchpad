/**
 * https://vicinity.city/coin-meta/<mint>.json and .png: what wallets, explorers and Jupiter read for a city coin launched on our
 * launchpad. Our program writes each coin's Metaplex metadata once, at launch, immutable, with uri = METADATA_URI_PREFIX + mint +
 * ".json" (src/sol/layout.js constants), so this URL must answer for every coin, for ever.
 *
 *   GET|HEAD /coin-meta/<mint>.json  the JSON of solana/sdk/launchpad/metadata.mts coinMetadataJson (a pure-JS port below, kept in
 *                                    parity by solana/sdk/launchpad/metadata.test.mts). Name and symbol come from the coin's
 *                                    ON-CHAIN Metaplex metadata (so a design edit can never make the JSON disagree with the chain);
 *                                    the description, the city and its country from the city's coin design. The coin is found in
 *                                    lp_coins (src/lpcoins.js) or, on a miss, by getProgramAccounts on our program (which also
 *                                    records it); the on-chain uri must be exactly this URL, or 404. Built once, kept in
 *                                    lp_coins.meta_json. 200: max-age 3600; 404: max-age 60. Access-Control-Allow-Origin: *.
 *   GET|HEAD /coin-meta/<mint>.png   the founder's logo with its real type (webp, png, jpeg), or 302 to /brand/vicinity-512.png
 *                                    (no logo, or one taken down)
 * Dark (404) unless lpSetup(env) is on; a coin recorded once keeps answering from the database even if the settings change.
 * An unknown mint costs at most one RPC call per 5 minutes (src/lpcoins.js negative memo) and counts against coin_meta; so does a
 * recorded coin whose JSON is not built yet (its metadata could not be read when it was recorded): every chain read this public
 * URL causes is memoised on a miss and counted per connection.
 */
import { SECURITY_HEADERS } from "./http.js";
import { isSolanaAddress } from "./solana.js";
import { codeOf } from "./sources.js";
import { lpSetup } from "./cluster.js";
import { toBytes } from "./blobs.js";
import { ensureLogoSchema, ensureSchema } from "./store.js";
import { iso } from "./policy.js";
import { IMAGE_TYPES, PICTURE_MAX_AGE, bytesApproved } from "./logos.js";
import { LAYOUT } from "./sol/layout.js";
import { publicLimit } from "./guards.js";
import { chainMetadata, findCoin, knownMissing, rememberMissing } from "./lpcoins.js";

/* ---------------------------------------------------------------- the JSON (a port of metadata.mts, kept byte-for-byte in parity) */
export const VICINITY_BRAND = Object.freeze({
  name: "Vicinity",
  site: "https://vicinity.city",
  logo: "https://vicinity.city/brand/vicinity-512.png",
  network: "Solana",
  metadataPrefix: LAYOUT.constants.METADATA_URI_PREFIX, // https://vicinity.city/coin-meta/ (the program constant)
});
export const MAX_NAME_BYTES = 32;
export const MAX_SYMBOL_BYTES = 10;
export const metadataUriFor = (mint) => `${VICINITY_BRAND.metadataPrefix}${mint}.json`;
export const coinImageUrl = (mint) => `${VICINITY_BRAND.metadataPrefix}${mint}.png`;
export const coinPageUrl = (mint) => `${VICINITY_BRAND.site}/coin?mint=${mint}`;
const utf8Len = (s) => new TextEncoder().encode(s).length;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
export function checkName(name) {
  if (name.length === 0 || utf8Len(name) > MAX_NAME_BYTES) return `name must be 1 to ${MAX_NAME_BYTES} bytes (UTF-8)`;
  if (CONTROL.test(name)) return "name must not contain control characters";
  return null;
}
export const checkSymbol = (symbol) => (/^[A-Z0-9]{1,10}$/.test(symbol) ? null : `symbol must be 1 to ${MAX_SYMBOL_BYTES} characters of A-Z and 0-9`);
const PITCH_BAD = /https?:|www\.|[1-9A-HJ-NP-Za-km-z]{32,44}/;
/** The JSON served at /coin-meta/<mint>.json: the same object coinMetadataJson in solana/sdk/launchpad/metadata.mts builds. */
export function coinMetadataJson(i) {
  const nameErr = checkName(i.name), symErr = checkSymbol(i.symbol);
  if (nameErr) throw new Error(nameErr);
  if (symErr) throw new Error(symErr);
  if (i.symbol !== i.city.ticker) throw new Error(`symbol ${i.symbol} must be the city ticker ${i.city.ticker}`);
  if (i.pitch && PITCH_BAD.test(i.pitch)) throw new Error("the pitch must not contain links or addresses");
  const cityId = Number(i.city.id);
  const lead = i.pitch ? `${i.pitch.trim()} ` : `The city coin of ${i.city.name}. `;
  const out = {
    name: i.name,
    symbol: i.symbol,
    description: `${lead}Launched on Vicinity (${VICINITY_BRAND.site}) on Solana.`,
    image: i.image ?? coinImageUrl(i.mint),
    external_url: coinPageUrl(i.mint),
    createdOn: VICINITY_BRAND.site,
    launchpad: VICINITY_BRAND.name,
    launchpadLogo: VICINITY_BRAND.logo,
    network: VICINITY_BRAND.network,
    city: { id: cityId, name: i.city.name, ...(i.city.country ? { country: i.city.country } : {}), ticker: i.city.ticker },
    showName: true,
    attributes: [
      { trait_type: "Launchpad", value: VICINITY_BRAND.name },
      { trait_type: "Network", value: VICINITY_BRAND.network },
      { trait_type: "City", value: i.city.name },
    ],
    website: coinPageUrl(i.mint),
  };
  if (i.twitter) out.twitter = i.twitter;
  if (i.telegram) out.telegram = i.telegram;
  return out;
}
/**
 * The JSON of a recorded coin (`row`: lp_coins) from its on-chain metadata (`md`: { name, symbol }) and its city's design row:
 * the chain's name and symbol (the symbol is the city's ticker by the program's own rule), the design's pitch (dropped when it
 * would break the no-links rule), the city's name and country (the coin's own name when the city has no design row).
 */
export async function metaJsonFor(env, row, md) {
  await ensureSchema(env.DB);
  const city = await env.DB.prepare("SELECT city_name, country, pitch FROM city_coins WHERE city_id = ?").bind(String(row.city_id)).first();
  const pitch = city && city.pitch && !PITCH_BAD.test(city.pitch) ? city.pitch : undefined;
  return coinMetadataJson({ mint: row.mint, name: md.name, symbol: md.symbol, pitch,
    city: { id: row.city_id, name: city ? city.city_name : md.name, ...(city && city.country ? { country: city.country } : {}), ticker: md.symbol } });
}

/* ---------------------------------------------------------------- the route */
const PATH = /^\/coin-meta\/([1-9A-HJ-NP-Za-km-z]{32,44})\.(json|png)$/;
const base = { ...SECURITY_HEADERS, "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" };
const answer = (request, body, status, headers) => new Response(request.method === "HEAD" ? null : body, { status, headers: { ...base, ...headers } });
const jsonAnswer = (request, data, status, maxAge) => answer(request, typeof data === "string" ? data : JSON.stringify(data), status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` });
const notFound = (request) => jsonAnswer(request, { ok: false, error: "not_found" }, 404, 60);
/** Another module's answer (a 429 of publicLimit) with this route's CORS header and HEAD rule. */
const passOn = (request, res) => new Response(request.method === "HEAD" ? null : res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), "Access-Control-Allow-Origin": "*" } });

/** GET|HEAD /coin-meta/* (src/index.js sends every /coin-meta/ path here, before the static files). */
export async function handleCoinMeta(request, env, fetchImpl = fetch, now = Date.now()) {
  if (request.method !== "GET" && request.method !== "HEAD") return answer(request, JSON.stringify({ ok: false, error: "method_not_allowed" }), 405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD", "Cache-Control": "no-store" });
  const m = PATH.exec(new URL(request.url).pathname);
  if (!m || !isSolanaAddress(m[1]) || !env.DB) return notFound(request);
  const [, mint, kind] = m;
  let f;
  try { f = await findCoin(request, env, mint, fetchImpl, now, "coin_meta"); }
  catch (e) { console.error("coin-meta lookup failed", codeOf(e)); return jsonAnswer(request, { ok: false, error: "unavailable" }, 503, 10); }
  if (f.response) return passOn(request, f.response);
  if (f.error) return jsonAnswer(request, { ok: false, error: "unavailable" }, 503, 10);
  const row = f.row;
  if (!row) return notFound(request);
  return kind === "png" ? image(request, env, row) : metadata(request, env, row, fetchImpl, now);
}

async function metadata(request, env, row, fetchImpl, now) {
  if (row.meta_json) return jsonAnswer(request, row.meta_json, 200, 3600);
  // recorded, but the JSON is not built yet (the metadata could not be read at that moment): only with the settings on, from the chain
  const s = lpSetup(env);
  if (!s.on || row.cluster !== s.cluster || row.program_id !== s.programId) return notFound(request);
  // a chain read caused by a public URL, like findCoin's for an unknown mint: a miss is remembered for 5 minutes per server, and
  // the reads count against coin_meta per connection (a read that fails is not remembered, so the counter is what bounds those)
  if (knownMissing(row.mint, now)) return notFound(request);
  const slow = await publicLimit(env, request, "coin_meta");
  if (slow) return passOn(request, slow);
  let md;
  try { md = await chainMetadata(env, row.mint, fetchImpl); } catch (e) { console.error("coin-meta metadata read failed", codeOf(e)); return jsonAnswer(request, { ok: false, error: "unavailable" }, 503, 10); }
  if (!md || md.uri !== metadataUriFor(row.mint)) { rememberMissing(row.mint, now); return notFound(request); }
  let meta;
  try { meta = JSON.stringify(await metaJsonFor(env, row, md)); } catch (e) { console.error("coin-meta JSON refused", codeOf(e)); return notFound(request); }
  await env.DB.prepare("UPDATE lp_coins SET meta_json = ?, meta_at = ? WHERE mint = ?").bind(meta, iso(now), row.mint).run();
  return jsonAnswer(request, meta, 200, 3600);
}

/** The APPROVED picture (src/logos.js), only while its bytes still hash to the coin's logo_hash; else the badge (no picture, waiting, taken down). */
async function image(request, env, row) {
  try {
    await ensureLogoSchema(env.DB);
    const logo = await env.DB.prepare(`SELECT m.type, m.bytes, c.logo_hash FROM city_coins c JOIN media m ON m.id = c.approved_media_id
        WHERE c.city_id = ? AND c.mint = ?`).bind(String(row.city_id), row.mint).first();
    if (logo && IMAGE_TYPES.has(logo.type) && (await bytesApproved(logo.bytes, logo.logo_hash))) {
      return answer(request, toBytes(logo.bytes), 200, { "Content-Type": logo.type, "Cache-Control": `public, max-age=${PICTURE_MAX_AGE}`, "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline" });
    }
  } catch (e) { console.error("coin-meta logo read failed", codeOf(e)); }
  return new Response(null, { status: 302, headers: { ...base, Location: "/brand/vicinity-512.png", "Cache-Control": "public, max-age=300" } });
}
