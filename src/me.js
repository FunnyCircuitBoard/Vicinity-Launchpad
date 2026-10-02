// src/me.js: recovered from the code deployed on Cloudflare (Worker "vicinity-map", 2026-10-02).
// The original comments and formatting were lost in the bundle; the code is the deployed code, byte for byte after bundling.
import { activeMint } from "./official.js";
import { json, readJson } from "./http.js";
import { ensureSchema } from "./store.js";
import { getHolding, holderSnapshot, rankOf } from "./chain.js";
import { DAY, POLICY, iso } from "./policy.js";
import { cleanEmail, consumeEmailCode, getSession, isFresh, providers, validEmail } from "./auth.js";
import { VOTE_WEIGHT, activeBan, adminWallets, amountsFor, liveSeatOfUser, managerOf } from "./roles.js";
import { latestBalances } from "./ledger.js";
import { access } from "./access.js";
import { communityById } from "./community.js";
import { useAttestation } from "./attest.js";
import { cityPicture, cooldownUntil, eligibility } from "./seats.js";
import { countryPicture } from "./elections.js";
var HOME_LOCK_DAYS = 7;
var mask = (w) => w ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null;
var publicUser = (u) => ({
  id: u.id,
  wallet: u.wallet,
  provider: u.provider,
  handle: u.handle,
  name: u.name,
  contact_email: u.contact_email || null,
  phone: u.phone || null,
  home: u.home_city ? { id: u.home_city, name: u.home_name, country: u.home_country, since: u.home_at } : null,
  joined: u.created_at
});
var HOLDING_BADGES = /* @__PURE__ */ new Set(["holder", "founder_ready", "whale", "top100", "top10", "city_founder", "country_manager"]);
function badgesFor({ u, launched, amount, position, seat, manager, admin: admin2, checkins, posts, tenure: tenure2, threshold }) {
  const pct = (v, of) => Math.max(0, Math.min(1, v / of));
  const T = threshold || POLICY.founder.ladder.base;
  const list = [
    { id: "early", icon: "\u{1F331}", name: "Early member", detail: "Joined before $VICINITY launched. This one can never be earned again.", earned: Boolean(u.early) },
    { id: "verified", icon: "\u2705", name: "Verified account", detail: "One wallet + one X or Google login.", earned: true },
    { id: "local", icon: "\u{1F4CD}", name: "Local", detail: "Home community confirmed by location.", earned: Boolean(u.home_city) },
    { id: "holder", icon: "\u{1F3C5}", name: "Holder", detail: launched ? "Hold any $VICINITY." : "Hold $VICINITY once it launches.", earned: amount > 0, progress: amount > 0 ? 1 : 0 },
    {
      id: "founder_ready",
      icon: "\u{1F511}",
      name: "Founder-ready",
      detail: `Held ${T.toLocaleString("en-US")}+ $VICINITY for ${POLICY.founder.qualifyingDays} days: may apply to found your city.`,
      earned: Boolean(tenure2 && tenure2.qualified && amount >= T),
      progress: tenure2 ? pct(tenure2.days, tenure2.needed) : 0
    },
    { id: "whale", icon: "\u{1F40B}", name: "Big holder", detail: "Hold 10,000,000+ $VICINITY.", earned: amount >= 1e7, progress: pct(amount, 1e7) },
    { id: "top100", icon: "\u{1F4AF}", name: "Top 100", detail: "One of the 100 biggest holders (pools not counted).", earned: Boolean(position?.rank && position.rank <= 100) },
    { id: "top10", icon: "\u{1F3C6}", name: "Top 10", detail: "One of the 10 biggest holders.", earned: Boolean(position?.rank && position.rank <= 10) },
    {
      id: "city_founder",
      icon: "\u{1F451}",
      name: "City Founder",
      detail: seat && seat.status === "grace" ? "In grace: hold the founder amount again to keep the seat." : "Chosen by your city and still holding the founder amount.",
      earned: Boolean(seat && ["active", "grace"].includes(seat.status)),
      grace: Boolean(seat && seat.status === "grace")
    },
    { id: "country_manager", icon: "\u{1F6E1}\uFE0F", name: "Country Manager", detail: "Elected by your country for 90 days.", earned: manager },
    { id: "voice", icon: "\u{1F4AC}", name: "Local voice", detail: "Posted in your city or country feed.", earned: posts > 0 },
    { id: "streak", icon: "\u{1F525}", name: "On the streets", detail: "Checked in on 3 different days.", earned: checkins >= 3, progress: pct(checkins, 3) }
  ];
  if (admin2) list.unshift({ id: "admin", icon: "\u2699\uFE0F", name: "Admin", detail: "Runs Vicinity, within the published rules.", earned: true });
  return list;
}
async function liveStatus(env, s, fetchImpl, now) {
  const u = s.user, db = env.DB;
  const mint = activeMint(env), launched = Boolean(mint), wallet = u.wallet;
  let snap = null, chain = launched ? "live" : "prelaunch";
  if (launched) {
    try {
      snap = await holderSnapshot(env, mint, fetchImpl);
    } catch {
      chain = "partial";
    }
  }
  let amount = 0, position = null;
  if (snap) {
    position = rankOf(snap, wallet);
    amount = position.amount;
  } else if (launched) {
    try {
      amount = await getHolding(env, wallet, mint, fetchImpl);
    } catch {
      chain = "unavailable";
    }
  }
  const admin2 = adminWallets(env).includes(wallet);
  const seat = await liveSeatOfUser(db, u.id);
  const mgr = seat && seat.status === "active" ? await managerOf(env, seat.country, now) : null;
  const isManager = Boolean(mgr && mgr.userId === u.id);
  const level = admin2 ? "admin" : isManager ? "manager" : seat && (seat.status === "active" || seat.status === "steward") ? "founder" : amount > 0 ? "holder" : "member";
  const ban = await activeBan(db, u.id, u.home_country, now);
  const appealed = ban && ban.action_id ? await db.prepare("SELECT id FROM appeals WHERE action_id = ?").bind(ban.action_id).first() : null;
  const elig = await eligibility(env, u, now, fetchImpl);
  const app = await db.prepare("SELECT a.id, a.window_id, a.city_id, a.created_at, w.closes_at FROM applications a JOIN windows w ON w.id = a.window_id WHERE a.user_id = ? AND a.withdrawn = 0 AND w.status = 'open'").bind(u.id).first();
  const founder2 = {
    threshold: elig.threshold,
    tenure: elig.tenure,
    amount,
    eligible: elig.ok,
    why: elig.ok ? null : elig.error,
    homeReadyAt: elig.homeReadyAt,
    cooldownUntil: elig.cooldownUntil || await cooldownUntil(db, u.id, now),
    application: app ? { id: app.id, windowId: app.window_id, cityId: app.city_id, since: app.created_at, closesAt: app.closes_at } : null,
    seat: seat ? {
      id: seat.id,
      cityId: seat.city_id,
      city: seat.city_name,
      country: seat.country,
      status: seat.status,
      since: seat.activated_at || seat.created_at,
      appealUntil: seat.appeal_until,
      graceUntil: seat.grace_until,
      probationUntil: seat.probation_until,
      threshold: seat.threshold,
      policy: seat.policy
    } : null
  };
  const ranked = async (wallets) => {
    if (!launched || !snap) return { rank: null, holders: null, top: [] };
    const amounts = await amountsFor(env, wallets, fetchImpl);
    const list = wallets.map((w) => [w, amounts.get(w) || 0]).filter(([, a]) => a > 0).sort((a, b) => b[1] - a[1]);
    const i = list.findIndex(([w]) => w === wallet);
    return { rank: i >= 0 ? i + 1 : null, holders: list.length, top: list.slice(0, 5).map(([w, a]) => ({ wallet: mask(w), amount: a, you: w === wallet })) };
  };
  let community = null, national = null;
  if (u.home_city) {
    const members = (await db.prepare("SELECT wallet FROM users WHERE home_city = ? LIMIT 5000").bind(u.home_city).all()).results.map((r) => r.wallet);
    community = {
      id: u.home_city,
      name: u.home_name,
      country: u.home_country,
      members: members.length,
      ...await ranked(members),
      ...await cityPicture(env, u.home_city, u, now)
    };
  }
  if (u.home_country) {
    const members = (await db.prepare("SELECT wallet FROM users WHERE home_country = ? LIMIT 20000").bind(u.home_country).all()).results.map((r) => r.wallet);
    national = { country: u.home_country, members: members.length, ...await ranked(members), ...await countryPicture(env, u.home_country, u, now) };
  }
  const act = await db.prepare(
    "SELECT COUNT(*) AS posts, COUNT(DISTINCT CASE WHEN kind = 'checkin' THEN substr(created_at, 1, 10) END) AS days FROM posts WHERE user_id = ? AND hidden = 0"
  ).bind(u.id).first();
  const badges = badgesFor({ u, launched, amount, position, seat, manager: isManager, admin: admin2, checkins: act?.days || 0, posts: act?.posts || 0, tenure: elig.tenure, threshold: elig.threshold });
  const earned = badges.filter((b) => b.earned).map((b) => b.id);
  let lost = [];
  try {
    lost = JSON.parse(u.badges || "[]").filter((id) => HOLDING_BADGES.has(id) && !earned.includes(id));
  } catch {
  }
  if (JSON.stringify(earned) !== (u.badges || "")) await db.prepare("UPDATE users SET badges = ? WHERE id = ?").bind(JSON.stringify(earned), u.id).run();
  const days = elig.tenure ? Math.floor(elig.tenure.days) : 0;
  const steps = [
    { id: "account", label: "Wallet + account verified", done: true },
    {
      id: "home",
      label: u.home_city ? `Home: ${u.home_name} (${POLICY.founder.localDays} days before applying)` : "Set your home community",
      done: Boolean(u.home_city) && Date.parse(elig.homeReadyAt || iso(now + DAY)) <= now,
      detail: u.home_city && elig.homeReadyAt && Date.parse(elig.homeReadyAt) > now ? `ready ${elig.homeReadyAt.slice(0, 10)}` : null
    },
    {
      id: "hold",
      label: `Hold ${(elig.threshold || POLICY.founder.ladder.base).toLocaleString("en-US")}+ for ${POLICY.founder.qualifyingDays} days`,
      done: Boolean(elig.tenure && elig.tenure.qualified),
      progress: elig.tenure ? Math.min(1, elig.tenure.days / elig.tenure.needed) : 0,
      detail: launched ? `${Math.min(days, POLICY.founder.qualifyingDays)} / ${POLICY.founder.qualifyingDays} days` : "starts at launch"
    },
    { id: "apply", label: "Apply in your city's 72-hour window", done: Boolean(app || seat) },
    { id: "chosen", label: "Chosen by the formula, 48 hours for objections", done: Boolean(seat && seat.status !== "provisional") },
    { id: "founder", label: seat && seat.status === "grace" ? "Founder \u2014 in grace, top up to keep it" : "Founder", done: Boolean(seat && seat.status === "active") }
  ];
  const done = steps.filter((x) => x.done).length;
  return {
    launched,
    chain,
    checkedAt: iso(now),
    level,
    fresh: isFresh(s, now),
    policyVersion: POLICY.version,
    roles: { admin: admin2, manager: isManager, founder: Boolean(seat && seat.status === "active"), holder: amount > 0, weight: VOTE_WEIGHT[level] || 1 },
    holding: {
      amount,
      rank: position ? position.rank : null,
      total: position ? position.total : null,
      percent: position ? position.percent : null,
      percentile: position ? position.percentile : null,
      next: position ? position.next : null
    },
    founder: founder2,
    badges,
    lost,
    community,
    national,
    ban: ban ? { country: ban.country, until: ban.expires_at, actionId: ban.action_id, appealed: Boolean(appealed) } : null,
    progress: { percent: Math.round(done / steps.length * 100), steps }
  };
}
async function handleMe(request, env, fetchImpl = fetch, now = Date.now()) {
  const s = await getSession(env, request, now);
  const prov = providers(env);
  if (!s) return json({ signedIn: false, providers: prov });
  if (!s.user) {
    let proof = null;
    try {
      if (s.proof) {
        const p = JSON.parse(s.proof);
        proof = { address: p.address, lamports: p.lamports, sol: (p.lamports / 1e9).toFixed(6) };
      }
    } catch {
    }
    return json({ signedIn: false, providers: prov, pending: s.wallet ? { wallet: s.wallet } : null, proof });
  }
  const user = publicUser(s.user);
  if (new URL(request.url).searchParams.get("lite") === "1") return json({ signedIn: true, user, providers: prov, fresh: isFresh(s, now) });
  return json({ signedIn: true, user, providers: prov, ...await liveStatus(env, s, fetchImpl, now) });
}
async function handleTermsAgree(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const body = await readJson(request);
  const version = typeof body?.version === "string" ? body.version.slice(0, 32) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) return json({ ok: false, error: "bad_version" }, 400);
  await ensureSchema(env.DB);
  await env.DB.prepare("UPDATE users SET terms_version = ?, terms_agreed_at = ? WHERE id = ?").bind(version, new Date(now).toISOString(), a.u.id).run();
  return json({ ok: true, version });
}
var validUsername = (s) => /^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(String(s || ""));
async function handleUsername(request, env, now = Date.now()) {
  const a = await access(request, env, now, { fresh: true });
  if (a.error) return a.error;
  const body = await readJson(request);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  if (!validUsername(username)) return json({ ok: false, error: "bad_username" }, 400);
  await ensureSchema(env.DB);
  if (a.u.handle && a.u.handle.toLowerCase() === username.toLowerCase()) return json({ ok: true, username: a.u.handle });
  const taken = await env.DB.prepare("SELECT id FROM users WHERE lower(handle) = lower(?) AND id != ?").bind(username, a.u.id).first();
  if (taken) return json({ ok: false, error: "username_taken" }, 409);
  try {
    await env.DB.prepare("UPDATE users SET handle = ? WHERE id = ?").bind(username, a.u.id).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message ? e.message : e))) return json({ ok: false, error: "username_taken" }, 409);
    throw e;
  }
  return json({ ok: true, username });
}
async function handleContactEmailVerify(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const body = await readJson(request);
  const email = cleanEmail(body && body.email);
  const code = String(body && body.code || "").replace(/\D/g, "").slice(0, 6);
  if (!validEmail(email) || code.length !== 6) return json({ ok: false, error: "bad_code" }, 400);
  const v = await consumeEmailCode(env.DB, email, code, now);
  if (!v.ok) return json({ ok: false, error: v.error, ...v.left != null ? { left: v.left } : {} }, v.error === "too_many" ? 429 : 400);
  await ensureSchema(env.DB);
  const other = await env.DB.prepare("SELECT id FROM users WHERE provider = 'email' AND provider_id = ? AND id != ?").bind(email, a.u.id).first();
  if (other) return json({ ok: false, error: "email_taken" }, 409);
  await env.DB.prepare("UPDATE users SET contact_email = ? WHERE id = ?").bind(email, a.u.id).run();
  return json({ ok: true, email });
}
var validPhone = (s) => {
  const t = String(s || "").trim();
  const digits = t.replace(/\D/g, "");
  return /^\+?[0-9\s\-().]{7,24}$/.test(t) && digits.length >= 7 && digits.length <= 15;
};
async function handlePhone(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const body = await readJson(request);
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  if (phone && !validPhone(phone)) return json({ ok: false, error: "bad_phone" }, 400);
  await ensureSchema(env.DB);
  await env.DB.prepare("UPDATE users SET phone = ? WHERE id = ?").bind(phone || null, a.u.id).run();
  return json({ ok: true, phone: phone || null });
}
async function handleHome(request, env, now = Date.now()) {
  const a = await access(request, env, now);
  if (a.error) return a.error;
  const u = a.u, db = env.DB;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  if (u.home_at && now - Date.parse(u.home_at) < HOME_LOCK_DAYS * DAY) {
    return json({ ok: false, error: "home_locked", until: iso(Date.parse(u.home_at) + HOME_LOCK_DAYS * DAY) }, 409);
  }
  if (await liveSeatOfUser(db, u.id)) return json({ ok: false, error: "founder_home_locked" }, 409);
  if (await db.prepare("SELECT a.id FROM applications a JOIN windows w ON w.id = a.window_id WHERE a.user_id = ? AND a.withdrawn = 0 AND w.status = 'open'").bind(u.id).first()) {
    return json({ ok: false, error: "founder_home_locked" }, 409);
  }
  const at = await useAttestation(env, body.attestation, { userId: u.id, purpose: "home", now });
  if (!at.ok) return json({ ok: false, error: at.error }, 400);
  const att = at.att;
  let home = null;
  if (att.city) home = { id: att.city, name: att.cityName, country: att.country };
  else {
    const pick2 = body.choice != null && (att.nearby || []).find((c) => c.id === String(body.choice));
    if (!pick2) return json({ ok: false, error: "choose_nearby", nearby: att.nearby || [] }, 400);
    home = await communityById(env, att.country, pick2.id);
  }
  if (!home) return json({ ok: false, error: "unknown_city" }, 400);
  await db.prepare("UPDATE users SET home_city = ?, home_name = ?, home_country = ?, home_at = ? WHERE id = ?").bind(home.id, home.name, home.country, iso(now), u.id).run();
  return json({ ok: true, home, joinedNearby: !att.city });
}
async function handleMembers(env) {
  if (!env.DB) return json({ members: 0, communities: [] });
  await ensureSchema(env.DB);
  const [total, top, placed] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM users"),
    env.DB.prepare("SELECT home_city AS id, home_name AS name, home_country AS country, COUNT(*) AS members FROM users WHERE home_city IS NOT NULL GROUP BY home_city ORDER BY members DESC LIMIT 300"),
    env.DB.prepare("SELECT wallet, home_city FROM users WHERE home_city IS NOT NULL")
  ]);
  let balances = null;
  try {
    balances = (await latestBalances(env, Date.now()))?.balances || null;
  } catch {
    balances = null;
  }
  const holders = /* @__PURE__ */ new Map();
  if (balances) {
    for (const u of placed.results) {
      if ((balances[u.wallet] || 0) > 0) holders.set(u.home_city, (holders.get(u.home_city) || 0) + 1);
    }
  }
  return json({
    members: total.results[0]?.n || 0,
    communities: top.results.map((c) => ({ ...c, holders: holders.get(c.id) || 0 }))
  });
}
export { handleContactEmailVerify, handleHome, handleMe, handleMembers, handlePhone, handleTermsAgree, handleUsername };
