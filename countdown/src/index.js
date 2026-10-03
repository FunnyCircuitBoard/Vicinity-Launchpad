// vicinitycity.com: the countdown Worker ("vicinity-countdown"), recovered from the live deployment on 3 Oct 2026
// (the code below is the deployed bundle as Cloudflare returned it) plus one change: once the countdown ends
// (Saturday 3 Oct 2026, 3:10 PM New York) every request on this domain is sent to the live site, https://vicinity.city/.
// Deployed from GitHub by .github/workflows/deploy-countdown.yml with countdown/wrangler.jsonc.
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var HOST = "vicinitycity.com";
// The end of the countdown (the same moment as LAUNCH in public/teaser.js) and where visitors go after it.
var LAUNCH_AT = Date.parse("2026-10-03T15:10:00-04:00");
var REDIRECT_TO = "https://vicinity.city/";
var HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000"
};
var WANTS = ["things-to-do", "meeting-people", "local-pride", "local-business", "events", "memes"];
var MAX = { city: 60, word: 24, famous: 120 };
var PER_HOUR = 12;
var isLocal = /* @__PURE__ */ __name((request, url) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) || ["127.0.0.1", "::1"].includes(request.headers.get("cf-connecting-ip")), "isLocal");
var json = /* @__PURE__ */ __name((data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...HEADERS, ...extra } }), "json");
var clean = /* @__PURE__ */ __name((s, max) => {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? null : t;
}, "clean");
var fold = /* @__PURE__ */ __name((s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(), "fold");
var hex = /* @__PURE__ */ __name((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""), "hex");
var places = null;
async function placeList(env, url) {
  if (places) return places;
  const rows = await (await env.ASSETS.fetch(new Request(new URL("/places.json", url)))).json();
  const byName = /* @__PURE__ */ new Map();
  const folded = rows.map(([name], i) => {
    const f = fold(name);
    if (!byName.has(f)) byName.set(f, i);
    return f;
  });
  places = { rows, folded, byName };
  return places;
}
__name(placeList, "placeList");
var _resetPlaces = /* @__PURE__ */ __name(() => {
  places = null;
}, "_resetPlaces");
var view = /* @__PURE__ */ __name(([name, cc]) => ({ name, cc, key: `${name}|${cc}` }), "view");
var ready = null;
var ensure = /* @__PURE__ */ __name((db) => ready ??= db.batch([
  db.prepare(`CREATE TABLE IF NOT EXISTS answers (
    id TEXT PRIMARY KEY, city TEXT NOT NULL, city_key TEXT, city_name TEXT, city_cc TEXT,
    word TEXT, pride INTEGER, wants TEXT, famous TEXT, country TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
  db.prepare("CREATE INDEX IF NOT EXISTS answers_city ON answers (city_key)"),
  db.prepare("CREATE TABLE IF NOT EXISTS hits (key TEXT NOT NULL, at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS hits_key ON hits (key, at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
]).catch((e) => {
  ready = null;
  throw e;
}), "ensure");
var _resetDb = /* @__PURE__ */ __name(() => {
  ready = null;
}, "_resetDb");
async function spamKey(env, request, now) {
  let salt = env.SALT;
  if (!salt) {
    const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'salt'").first();
    salt = row?.v;
    if (!salt) {
      salt = hex(crypto.getRandomValues(new Uint8Array(32)));
      await env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('salt', ?)").bind(salt).run();
      salt = (await env.DB.prepare("SELECT v FROM settings WHERE k = 'salt'").first()).v;
    }
  }
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const day = new Date(now).toISOString().slice(0, 10);
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}|${day}`))).slice(0, 32);
}
__name(spamKey, "spamKey");
async function handlePlaces(request, env, url) {
  const q = fold(url.searchParams.get("q") || "").slice(0, 40);
  if (q.length < 2) return json({ places: [] });
  const { rows, folded } = await placeList(env, url);
  const starts = [], words = [];
  for (let i = 0; i < rows.length && starts.length < 8; i++) {
    if (folded[i].startsWith(q)) starts.push(i);
    else if (words.length < 8 && folded[i].includes(` ${q}`)) words.push(i);
  }
  return json({ places: [...starts, ...words].slice(0, 8).map((i) => view(rows[i])) }, 200, { "Cache-Control": "public, max-age=86400" });
}
__name(handlePlaces, "handlePlaces");
async function handleAnswers(request, env, url, now) {
  let from = null;
  try {
    from = new URL(request.headers.get("origin") || "").host;
  } catch {
  }
  if (!from || from !== url.host) return json({ ok: false, error: "wrong_origin" }, 403);
  const text = await request.text();
  if (text.length > 4e3) return json({ ok: false, error: "too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  if (!body || typeof body !== "object") return json({ ok: false, error: "bad_json" }, 400);
  const city = clean(body.city, MAX.city), word = clean(body.word, MAX.word), famous = clean(body.famous, MAX.famous);
  if (!city || city.length < 2) return json({ ok: false, error: "city_required" }, 400);
  if (word === null || famous === null) return json({ ok: false, error: "too_long" }, 400);
  const pride = body.pride == null ? null : Number(body.pride);
  if (pride !== null && !(Number.isInteger(pride) && pride >= 1 && pride <= 10)) return json({ ok: false, error: "bad_pride" }, 400);
  const wants = Array.isArray(body.wants) ? [...new Set(body.wants)] : [];
  if (wants.length > 3 || wants.some((w) => !WANTS.includes(w))) return json({ ok: false, error: "bad_wants" }, 400);
  const id = typeof body.id === "string" && /^[A-Za-z0-9_-]{16,40}$/.test(body.id) ? body.id : crypto.randomUUID().replace(/-/g, "");
  const { rows, byName } = await placeList(env, url);
  let place = null;
  if (Array.isArray(body.place) && body.place.length === 2) {
    const i = byName.get(fold(body.place[0]));
    if (i != null) {
      for (let j = i; j < rows.length && !place; j++) if (rows[j][0] === body.place[0] && rows[j][1] === body.place[1]) place = rows[j];
    }
  }
  if (!place && byName.has(fold(city))) place = rows[byName.get(fold(city))];
  const db = env.DB;
  await ensure(db);
  const key = await spamKey(env, request, now);
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM hits WHERE key = ? AND at > ?").bind(key, now - 36e5).first();
  if ((recent?.n || 0) >= PER_HOUR) return json({ ok: false, error: "slow_down" }, 429);
  const at = new Date(now).toISOString(), country = /^[A-Z]{2}$/.test(request.cf?.country || "") ? request.cf.country : null;
  const p = place ? view(place) : null;
  await db.batch([
    db.prepare("INSERT INTO hits (key, at) VALUES (?, ?)").bind(key, now),
    db.prepare(`INSERT INTO answers (id, city, city_key, city_name, city_cc, word, pride, wants, famous, country, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET city = excluded.city, city_key = excluded.city_key, city_name = excluded.city_name, city_cc = excluded.city_cc,
        word = excluded.word, pride = excluded.pride, wants = excluded.wants, famous = excluded.famous, country = excluded.country, updated_at = excluded.updated_at`).bind(id, city, p?.key || null, p?.name || null, p?.cc || null, word || null, pride, JSON.stringify(wants), famous || null, country, at, at)
  ]);
  if (Math.random() < 0.05) await db.prepare("DELETE FROM hits WHERE at < ?").bind(now - 864e5).run();
  const mine = p ? await db.prepare("SELECT COUNT(*) AS n FROM answers WHERE city_key = ?").bind(p.key).first() : await db.prepare("SELECT COUNT(*) AS n FROM answers WHERE city_key IS NULL AND lower(city) = lower(?)").bind(city).first();
  const rank = p ? await db.prepare("SELECT COUNT(*) + 1 AS r FROM (SELECT COUNT(*) AS n FROM answers WHERE city_key IS NOT NULL GROUP BY city_key) WHERE n > ?").bind(mine.n).first() : null;
  return json({ ok: true, id, place: p, city: p ? p.name : city, count: mine.n, rank: rank?.r ?? null });
}
__name(handleAnswers, "handleAnswers");
async function handlePulse(env) {
  await ensure(env.DB);
  const t = await env.DB.prepare("SELECT COUNT(*) AS people, COUNT(DISTINCT COALESCE(city_key, lower(city))) AS cities FROM answers").first();
  const top = (await env.DB.prepare(`SELECT city_key AS key, city_name AS name, city_cc AS cc, COUNT(*) AS n, ROUND(AVG(pride), 1) AS pride
    FROM answers WHERE city_key IS NOT NULL GROUP BY city_key ORDER BY n DESC, name LIMIT 8`).all()).results;
  return json({ people: t?.people || 0, cities: t?.cities || 0, top }, 200, { "Cache-Control": "public, max-age=15" });
}
__name(handlePulse, "handlePulse");
// The countdown is over: every page, file and API call on this domain goes to the live site. 302 and no-store, so
// no browser keeps the redirect for good and the domain can be given another use later. REDIRECT_AT_MS (a number,
// milliseconds since 1970) moves the moment for a local test only; it is not set in production.
var afterLaunch = /* @__PURE__ */ __name((env, now) => now >= (Number(env && env.REDIRECT_AT_MS) || LAUNCH_AT), "afterLaunch");
var toLiveSite = /* @__PURE__ */ __name(() => new Response(null, { status: 302, headers: { Location: REDIRECT_TO, "Cache-Control": "no-store", ...HEADERS } }), "toLiveSite");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (afterLaunch(env, Date.now())) return toLiveSite();
    if (!isLocal(request, url) && (url.protocol === "http:" || url.hostname === `www.${HOST}`)) {
      url.protocol = "https:";
      url.hostname = HOST;
      url.port = "";
      return new Response(null, { status: 301, headers: { Location: url.toString(), ...HEADERS } });
    }
    try {
      if (url.pathname === "/api/places" && request.method === "GET") return await handlePlaces(request, env, url);
      if (url.pathname === "/api/answers" && request.method === "POST") return await handleAnswers(request, env, url, Date.now());
      if (url.pathname === "/api/pulse" && request.method === "GET") return await handlePulse(env);
      if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "not_found" }, 404);
    } catch (e) {
      console.error("countdown api", String(e && e.stack ? e.stack : e));
      return json({ ok: false, error: "unavailable" }, 503);
    }
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
    return out;
  }
};
// For the tests only (a Worker module may export functions, never plain values): the moment and the target.
var _redirect = /* @__PURE__ */ __name(() => ({ at: LAUNCH_AT, to: REDIRECT_TO }), "_redirect");
export {
  _redirect,
  _resetDb,
  _resetPlaces,
  index_default as default
};
