/**
 * Vicinity — backend (Cloudflare Worker). Every 10 minutes the scheduled job (src/jobs.js) keeps the
 * balance history, founder seats, elections, moderation and snapshots moving.
 *
 * Public:
 *   GET  /api/health · /api/official · /api/check?q= · /api/policy (the rules, their version, and job health)
 *   GET  /api/token · /api/holders · /api/rank?address=      live token facts, holders, one wallet's rank
 *   GET  /api/message?address&action=verify|login            the exact text a wallet signs
 *   POST /api/verify                                         check a signed message (nothing stored)
 *   GET  /api/seats (also /api/claims) · /api/seats/results/:id   founder seats, open windows, published results
 *   GET  /api/moderator?country= · /api/elections/results/:id     country managers
 *   GET  /api/members · /api/audit?country=                  members per community; every moderation decision
 *   GET  /api/snapshots · /api/snapshots/:id/proof?wallet= · /api/snapshots/:id/data   Founding Supporters
 * Accounts (src/auth.js): /api/auth/wallet · /api/auth/transfer(/check) · /api/auth/reprove · /api/pair(/finish)
 *   · /api/auth/google/start|callback · /api/auth/email/{start,verify} · /api/auth/logout
 * New sign-up, only while SIGNUP_FLOW=v2 (otherwise 404 not_enabled; src/signup.js, src/pwlogin.js):
 *   /api/signup/{start,state,terms,finish} · /api/signup/location(/choice) · /api/signup/location/handoff(/info,/complete,/claim)
 *   · /api/signup/account/reset · /api/signup/email(/verify) · /api/auth/google/start?signup=1
 *   · /api/auth/email/login · /api/auth/password/reset(/start) · /api/me/password
 * Member profiles, only while PROFILES=on (otherwise 404 not_enabled; src/profiles.js):
 *   GET /api/profile?u= · /api/members/search?q= · POST /api/follow · GET /api/follows · POST /api/block · GET /api/me/blocks
 *   · POST /api/me/bio · POST /api/profile/report · GET /api/me/portfolio · POST /api/mod/bio/clear
 * The Launchpad's coin list, only while LAUNCHPAD_V2=on (otherwise 404 not_enabled; src/launchpad.js, src/marketlive.js):
 *   GET /api/launchpad   every city coin and $VICINITY as cards with market data, holder and member counts, trade links
 *   GET /api/coin?mint=  one allow-listed coin: facts, live market, holders, recent trades, links, sources (src/coin.js)
 *   GET /api/coin/chart?mint=&tf=1h|24h|7d|30d|all   its price history (src/pricehistory.js)
 * Signed in: /api/me · /api/me/{terms,username,phone} · /api/me/contact/email/{verify,remove} · /api/home
 *   · /api/locate (the place a location is read, with /api/locate/handoff/* when a wallet app's browser can't
 *   share GPS: src/handoff.js) · /api/posts(/vote, /report)
 *   · /api/seats/{apply,withdraw,endorse,object,resign} · /api/elections/vote · /api/appeals · /api/towns
 *   · /api/seats/squad/{create,join,leave,apply} · /api/seats/squad/:id (readiness)
 * Admins: /api/admin/* (src/admin.js: fresh wallet proof on every change)
 * Moderators: /api/mod · /api/mod/{hide,unhide,ban,ban/approve,ban/reject} · /api/appeals/decide
 *   · /api/towns/decide · /api/seats/objections/decide · /api/snapshots/cancel
 *
 * Everything else is served from /public by Cloudflare's static asset handler.
 * Settings: SOLANA_RPC_URL, VICINITY_MINT, ADMIN_WALLETS, GOOGLE_CLIENT_ID/SECRET, the e-mail sender settings (see docs/DEPLOY.md),
 * SNAPSHOT_CUTOFF, ATTEST_KEY, JUPITER_API_BASE/KEY, RPC_TIMEOUT_MS (optional).
 */
import { activeMint, checkOfficial, marketLink, officialFor, withMint } from "./official.js";
import { handleAdmin } from "./admin.js";
import { getHolding, getTokenFacts, getTopHolders, holderSnapshot, rankOf } from "./chain.js";
import { base58Encode, buildMessage, isSolanaAddress, statementFor } from "./solana.js";
import { SECURITY_HEADERS, json } from "./http.js";
import { readSigned } from "./signed.js";
import { ensureSchema } from "./store.js";
import { POLICY, founderAmount } from "./policy.js";
import { ledgerStatus } from "./ledger.js";
import { handleEmailStart, handleEmailVerify, handleLogout, handleOAuthCallback, handleOAuthStart, handlePairFinish, handlePairStart, handlePairStatus,
  handleReprove, handleTransferCheck, handleTransferStart, handleWalletLogin } from "./auth.js";
import { handleContactEmailRemove, handleContactEmailVerify, handleHome, handleMe, handleMembers, handlePhone, handleTermsAgree, handleUsername } from "./me.js";
import { handleLocate } from "./attest.js";
import { handleHandoffClaim, handleHandoffComplete, handleHandoffInfo, handleHandoffStart } from "./handoff.js";
import { handleMedia, handleNewPost, handlePosts, handleReport, handleVote } from "./social.js";
import { handleApply, handleDecideObjection, handleEndorse, handleObject, handleResign, handleResult, handleSeats, handleSquadApply, handleSquadCreate, handleSquadGet, handleSquadJoin, handleSquadLeave, handleWithdraw } from "./seats.js";
import { handleElectionResult, handleElectionVote } from "./elections.js";
import { handleAppeal, handleAudit, handleBanDecision, handleDecideAppeal, handleHide, handleModQueue, handleMyTowns, handleProposeBan,
  handleTownDecision, handleTownRequest, handleUnhide } from "./moderation.js";
import { handleCancelSnapshot, handleProof, handleSnapshotData, handleSnapshots, snapshotCutoff } from "./snapshot.js";
import { managerOf } from "./roles.js";
import { handleCoins, handleDecideMint, handleDesign, handlePrices, handleProposeMint, handleTakedown, jupiterPrices, officialCityCoin, wantedMints } from "./coins.js";
import { runJobs } from "./jobs.js";
import { launchpadV2On, profilesOn, v2On } from "./flags.js";
import { routeV2 } from "./signup.js";
import { PROFILE_PATHS, routeProfiles } from "./profiles.js";
import { handleLaunchpad } from "./launchpad.js";
import { CHART_TTL, handleCoin, handleCoinChart } from "./coin.js";
import { CHART_TFS } from "./pricehistory.js";
import { publicLimit } from "./guards.js";

export { json, activeMint, cached as _cached };

/** Cache small JSON answers for a short time so we don't hammer the blockchain. An answer that names a shorter
 *  max-age of its own (the Launchpad list after a failed market call) is kept only that long.
 *  The visitor gets the same `public, max-age=<that long>` on a miss and on a hit. On a hit the header is set again
 *  here: Cloudflare's zone Browser Cache TTL rewrites the copy cache.match() returns (measured 3 Oct 2026: every hit
 *  went out as `public, max-age=14400`, so a browser kept a price or holder list for 4 hours). The intended lifetime
 *  travels with the stored copy in an internal header that never reaches the visitor. */
const KEEP_HEADER = "x-vicinity-max-age";
function withMaxAge(res, maxAge) {
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", `public, max-age=${maxAge}`);
  out.headers.delete(KEEP_HEADER);
  return out;
}
async function cached(key, seconds, produce) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const req = new Request("https://cache.vicinity.internal/" + key);
  if (cache) {
    const hit = await cache.match(req);
    if (hit) {
      const kept = Number(hit.headers.get(KEEP_HEADER));
      return withMaxAge(hit, Number.isInteger(kept) && kept > 0 && kept <= seconds ? kept : seconds);
    }
  }
  const res = await produce();
  if (res.status !== 200) return res;
  const own = /\bmax-age=(\d+)/.exec(res.headers.get("Cache-Control") || "");
  const maxAge = own ? Math.min(seconds, Number(own[1])) : seconds;
  const out = withMaxAge(res, maxAge);
  if (cache) {
    const copy = new Response(out.clone().body, out);
    copy.headers.set(KEEP_HEADER, String(maxAge));
    await cache.put(req, copy);
  }
  return out;
}

export async function handleVerify(request, env = {}, now = Date.now(), fetchImpl = fetch) {
  const r = await readSigned(request, now, ["verify"], "verified", undefined, env.DB || null); // one-time: a replayed body is 409, not another RPC call
  if (r.error) return r.error;
  const address = r.parsed.address;
  console.log("wallet verified", address.slice(0, 4) + "…" + address.slice(-4));
  const out = { verified: true, address, verifiedAt: new Date(now).toISOString(), launched: false };
  const mint = activeMint(env);
  if (mint) {
    out.launched = true;
    try {
      const amount = await getHolding(env, address, mint, fetchImpl);
      out.holder = amount > 0;
      out.amount = amount;
      out.tier = amount > 0 ? "Holder" : null;
    } catch (e) {
      console.error("holding lookup failed", String(e));
      out.holderCheck = "unavailable";
    }
  }
  return json(out);
}

/** USD price from Jupiter (asked by the server, so the page loads nothing from other sites; the last good price during an outage). null if unknown. */
async function tokenPrice(env, mint, fetchImpl) {
  return (await jupiterPrices(env, [mint], fetchImpl)).prices[mint];
}

/**
 * Live holders: every holder from the one-minute snapshot, 1,000 at a time (?offset=N; `more` says whether there is a next
 * page, `count` how many rows there are in all), or the top 20 when the RPC can't list them all. The token page asks page
 * after page until `more` is false, so every holder ends up in its table however many there are.
 */
const HOLDERS_PAGE = 1000;
async function holdersResponse(env, mint, offset, fetchImpl) {
  try {
    const snap = await holderSnapshot(env, mint, fetchImpl);
    const end = offset + HOLDERS_PAGE;
    return json({ launched: true, mint, supply: snap.facts.supply, total: snap.people, count: snap.rows.length, full: true,
      holders: snap.rows.slice(offset, end), more: end < snap.rows.length, updatedAt: snap.at });
  } catch (e) {
    console.error("full holder list failed, using the top 20", String(e));
  }
  try {
    const { facts, holders } = await getTopHolders(env, mint, fetchImpl);
    return json({ launched: true, mint, supply: facts.supply, total: null, count: holders.length, full: false, holders: offset ? [] : holders, more: false, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("holders failed", String(e));
    return json({ launched: true, error: "chain_unavailable" }, 503);
  }
}

/** Where does a wallet stand? Read-only; the address is not stored. */
async function rankResponse(env, mint, address, fetchImpl) {
  const founderMin = founderAmount(0);
  try {
    const snap = await holderSnapshot(env, mint, fetchImpl);
    return json({ launched: true, full: true, address, ...rankOf(snap, address), supply: snap.facts.supply, founderMin, updatedAt: snap.at });
  } catch { /* fall back to the balance alone */ }
  try {
    const amount = await getHolding(env, address, mint, fetchImpl);
    return json({ launched: true, full: false, address, amount, rank: null, total: null, founderMin, updatedAt: new Date().toISOString() });
  } catch {
    return json({ launched: true, error: "chain_unavailable" }, 503);
  }
}

// Routes that exist only in the new sign-up (SIGNUP_FLOW=v2), besides everything under /api/signup/.
const V2_EXACT = new Set(["/api/auth/email/login", "/api/auth/password/reset/start", "/api/auth/password/reset", "/api/me/password"]);

export async function handleApi(request, env = {}, fetchImpl = fetch, ctx = null) {
  const url = new URL(request.url);
  const method = request.method;
  const only = (m) => (method === m ? null : json({ error: "method_not_allowed" }, 405));
  const path = url.pathname;
  const needsDb = () => (env.DB ? null : json({ ok: false, error: "unavailable" }, 503));
  const db = async (fn) => needsDb() || (await ensureSchema(env.DB), fn());

  // the new sign-up and password log-in: with the switch off they are simply not there (before any method check, so nothing can be probed)
  if (path.startsWith("/api/signup/") || V2_EXACT.has(path)) {
    if (!v2On(env)) return json({ ok: false, error: "not_enabled" }, 404);
    return routeV2(request, env, fetchImpl, ctx);
  }

  // member profiles: with the switch off they are simply not there either (before any method check, so nothing can be probed)
  if (PROFILE_PATHS.has(path)) {
    if (!profilesOn(env)) return json({ ok: false, error: "not_enabled" }, 404);
    return routeProfiles(request, env, fetchImpl, ctx);
  }

  // the Launchpad's coin list (LAUNCHPAD_V2=on): same rule; one answer per region every 30 seconds (edge cache + a copy per server)
  if (path === "/api/launchpad") {
    if (!launchpadV2On(env)) return json({ ok: false, error: "not_enabled" }, 404);
    return only("GET") || needsDb() || cached("launchpad-" + (activeMint(env) || "pre"), 30, () => handleLaunchpad(env, fetchImpl));
  }
  // one coin's page and chart (LAUNCHPAD_V2=on): allow-listed mints only (src/coin.js), edge-cached, counted on a cache miss
  if (path === "/api/coin" || path === "/api/coin/chart") {
    if (!launchpadV2On(env)) return json({ ok: false, error: "not_enabled" }, 404);
    const blocked = only("GET") || needsDb();
    if (blocked) return blocked;
    const mint = url.searchParams.get("mint");
    if (!isSolanaAddress(mint)) return json({ ok: false, error: "bad_mint" }, 400);
    if (path === "/api/coin") return cached(`coin-${mint}`, 30, async () => (await publicLimit(env, request, "coin")) || handleCoin(env, mint, fetchImpl));
    const tf = url.searchParams.get("tf") || "24h";
    if (!CHART_TFS.includes(tf)) return json({ ok: false, error: "bad_tf" }, 400);
    return cached(`coin-chart-${mint}-${tf}`, CHART_TTL[tf], async () => (await publicLimit(env, request, "coin_chart")) || handleCoinChart(env, mint, tf, fetchImpl));
  }

  // paths with an id in them
  if (path.startsWith("/api/admin/")) return db(() => handleAdmin(request, env));
  const oauth = path.match(/^\/api\/auth\/(google)\/(start|callback)$/);
  if (oauth) return only("GET") || (oauth[2] === "start" ? handleOAuthStart(request, env, oauth[1]) : handleOAuthCallback(request, env, oauth[1], fetchImpl));
  if (path === "/api/auth/email/start") return only("POST") || db(() => handleEmailStart(request, env, fetchImpl));
  if (path === "/api/auth/email/verify") return only("POST") || db(() => handleEmailVerify(request, env, fetchImpl));
  let m = path.match(/^\/api\/media\/([0-9]{1,10})$/);
  if (m) return only("GET") || handleMedia(request, env, m[1], fetchImpl);
  m = path.match(/^\/api\/seats\/results\/([0-9]{1,10})$/);
  if (m) return only("GET") || db(() => handleResult(env, m[1]));
  m = path.match(/^\/api\/seats\/squad\/([0-9]{1,10})$/);
  if (m) return only("GET") || db(() => handleSquadGet(env, m[1], Date.now(), fetchImpl));
  m = path.match(/^\/api\/elections\/results\/([0-9]{1,10})$/);
  if (m) return only("GET") || db(() => handleElectionResult(env, m[1]));
  m = path.match(/^\/api\/snapshots\/([0-9]{1,10})\/(proof|data)$/);
  if (m) return only("GET") || db(() => (m[2] === "proof" ? handleProof(env, m[1], url.searchParams.get("wallet")) : handleSnapshotData(env, m[1])));

  switch (path) {
    case "/api/health":
      return only("GET") || json({ ok: true, service: "vicinity-map", milestone: 2 });
    case "/api/official":
      return only("GET") || json(officialFor(env));
    case "/api/policy":
      return only("GET") || json({ policy: POLICY, snapshotCutoff: snapshotCutoff(env), launched: Boolean(activeMint(env)),
        balanceHistory: env.DB ? await ledgerStatus(env, Date.now()) : { running: false } });
    case "/api/check": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const q = url.searchParams.get("q");
      const verdict = checkOfficial(q, isSolanaAddress, env);
      // the list alone knows $VICINITY and the team wallets; a city coin an admin recorded is official for its city
      if (verdict.verdict === "not_official" && verdict.kind === "address") {
        const coin = await officialCityCoin(env, String(q || "").trim());
        if (coin) return json(coin);
      }
      // a Raydium, Jupiter, DEX Screener or Solscan link that carries one recorded city coin opens that official coin
      const market = verdict.verdict === "not_official" && verdict.kind === "market" ? marketLink(q, isSolanaAddress) : null;
      if (market && market.addresses.length === 1) {
        const coin = await officialCityCoin(env, market.addresses[0]);
        if (coin) return json({ ...coin, kind: "market", message: `This ${market.name} link opens ${coin.message.replace(/^This is /, "")}` });
      }
      return json(verdict);
    }
    case "/api/verify":
      return only("POST") || (await publicLimit(env, request, "verify")) || handleVerify(request, env, Date.now(), fetchImpl);
    case "/api/token": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, registry: withMint(env).tokens });
      return cached("token-" + mint, 60, async () => {
        try {
          const [facts, price] = await Promise.all([getTokenFacts(env, mint, fetchImpl), tokenPrice(env, mint, fetchImpl)]);
          return json({ launched: true, registry: withMint(env).tokens, facts, price, marketCap: price && facts.supply ? price * facts.supply : null });
        // the contract comes from the settings, not the chain: the page still shows it (and the official list) while the chain is busy
        } catch (e) { console.error("token facts failed", String(e)); return json({ launched: true, error: "chain_unavailable", mint, registry: withMint(env).tokens }, 503); }
      });
    }
    case "/api/holders": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, holders: [] });
      // pages start at a multiple of 1,000, so the edge cache holds one answer per page and nothing else; the first page keeps its old key
      const offset = Math.floor(Math.min(Math.max(0, Number(url.searchParams.get("offset")) || 0), 10_000_000) / HOLDERS_PAGE) * HOLDERS_PAGE;
      return cached("holders-v2-" + mint + (offset ? "-" + offset : ""), 60, () => holdersResponse(env, mint, offset, fetchImpl));
    }
    case "/api/rank": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const address = url.searchParams.get("address");
      if (!isSolanaAddress(address)) return json({ error: "bad_address" }, 400);
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, address, founderMin: founderAmount(0) });
      // the attempt is counted only when the 30-second cache has no answer: looking at the same wallet again is free
      return cached(`rank-${mint}-${address}`, 30, async () => (await publicLimit(env, request, "rank")) || rankResponse(env, mint, address, fetchImpl));
    }
    case "/api/message": {
      // Helper so the browser builds exactly the same text the server expects.
      const blocked = only("GET");
      if (blocked) return blocked;
      const q = url.searchParams;
      const address = q.get("address");
      if (!isSolanaAddress(address)) return json({ error: "bad_address" }, 400);
      const action = q.get("action") || "verify";
      let statement;
      if (action === "verify") statement = statementFor("verify");
      else if (action === "login" && (!q.get("pin") || /^[0-9]{2}$/.test(q.get("pin")))) statement = statementFor("login", { pin: q.get("pin") || undefined });
      else return json({ error: "bad_request" }, 400);
      const nonce = base58Encode(crypto.getRandomValues(new Uint8Array(16)));
      return json({ message: buildMessage({ host: url.host, address, nonce, issuedAt: new Date().toISOString(), statement }) });
    }

    // founder seats (and the map)
    case "/api/seats":
    case "/api/claims": {
      const blocked = only("GET");
      if (blocked) return blocked;
      if (!env.DB) return json({ launched: Boolean(activeMint(env)), seats: [], windows: [] });
      // the map polls this every 30 seconds from every open tab: one answer per 30 seconds per server
      return cached("seats", 30, async () => {
        await ensureSchema(env.DB);
        const res = await handleSeats(env);
        const body = await res.json();
        return json({ ...body, launched: Boolean(activeMint(env)), founderAmount: founderAmount(0) });
      });
    }
    case "/api/seats/apply":
      return only("POST") || handleApply(request, env, fetchImpl);
    case "/api/seats/withdraw":
      return only("POST") || handleWithdraw(request, env);
    case "/api/seats/endorse":
      return only("POST") || handleEndorse(request, env);
    case "/api/seats/object":
      return only("POST") || handleObject(request, env);
    case "/api/seats/resign":
      return only("POST") || handleResign(request, env);
    case "/api/seats/objections/decide":
      return only("POST") || handleDecideObjection(request, env, fetchImpl);
    case "/api/seats/squad/create":
      return only("POST") || handleSquadCreate(request, env);
    case "/api/seats/squad/join":
      return only("POST") || handleSquadJoin(request, env);
    case "/api/seats/squad/leave":
      return only("POST") || handleSquadLeave(request, env);
    case "/api/seats/squad/apply":
      return only("POST") || handleSquadApply(request, env, fetchImpl);

    // city coins (designed by City Founders) and prices for the swap panel
    case "/api/coins": {
      const blocked = only("GET");
      if (blocked) return blocked;
      // the whole list is public and the same for everyone: cached. One city's coin (the founder's studio) and the admin queue are live.
      if (url.searchParams.get("city") || url.searchParams.get("waiting")) return handleCoins(request, env, fetchImpl);
      return cached("coins", 30, () => handleCoins(request, env, fetchImpl));
    }
    case "/api/coins/design":
      return only("POST") || handleDesign(request, env, fetchImpl);
    case "/api/coins/mint":
      return only("POST") || handleProposeMint(request, env, fetchImpl);
    case "/api/coins/mint/decide":
      return only("POST") || handleDecideMint(request, env, fetchImpl);
    case "/api/coins/takedown":
      return only("POST") || handleTakedown(request, env, fetchImpl);
    case "/api/prices":
      return only("GET") || cached("prices-" + wantedMints(request).slice().sort().join(","), 30, () => handlePrices(request, env, fetchImpl));

    // country managers
    case "/api/moderator": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const cc = url.searchParams.get("country") || "";
      if (!/^[A-Z]{2}$/.test(cc)) return json({ error: "bad_country" }, 400);
      const rule = "Elected for 90 days by the country's verified locals (votes 50%, service 30%, capped holdings 20%). Until then, the admin covers it.";
      if (!env.DB) return json({ country: cc, manager: null, rule });
      await ensureSchema(env.DB);
      const mgr = await managerOf(env, cc);
      return json({ country: cc, rule, manager: mgr ? { name: mgr.name, city: mgr.city, endsAt: mgr.term.ends_at, since: mgr.term.starts_at } : null });
    }
    case "/api/elections/vote":
      return only("POST") || handleElectionVote(request, env);

    // accounts
    case "/api/auth/wallet":
      return only("POST") || handleWalletLogin(request, env);
    case "/api/auth/reprove":
      return only("POST") || handleReprove(request, env);
    case "/api/auth/transfer":
      return only("POST") || (await publicLimit(env, request, "transfer")) || handleTransferStart(request, env);
    case "/api/auth/transfer/check":
      return only("POST") || (await publicLimit(env, request, "transfer_check")) || handleTransferCheck(request, env, Date.now(), fetchImpl);
    case "/api/auth/logout":
      return only("POST") || handleLogout(request, env);
    case "/api/pair":
      if (method === "POST") return (await publicLimit(env, request, "pair")) || handlePairStart(request, env);
      return only("GET") || handlePairStatus(request, env);
    case "/api/pair/finish":
      return only("POST") || handlePairFinish(request, env);

    // dashboard
    case "/api/me":
      return only("GET") || handleMe(request, env, fetchImpl);
    case "/api/me/terms":
      return only("POST") || handleTermsAgree(request, env);
    case "/api/me/username":
      return only("POST") || handleUsername(request, env);
    case "/api/me/phone":
      return only("POST") || handlePhone(request, env);
    case "/api/me/contact/email/verify":
      return only("POST") || handleContactEmailVerify(request, env);
    case "/api/me/contact/email/remove":
      return only("POST") || handleContactEmailRemove(request, env);
    case "/api/home":
      return only("POST") || handleHome(request, env);
    case "/api/locate":
      return only("POST") || handleLocate(request, env);
    case "/api/locate/handoff":
      return only("POST") || db(() => handleHandoffStart(request, env));
    case "/api/locate/handoff/info":
      return only("POST") || db(() => handleHandoffInfo(request, env));
    case "/api/locate/handoff/complete":
      return only("POST") || db(() => handleHandoffComplete(request, env));
    case "/api/locate/handoff/claim":
      return only("POST") || db(() => handleHandoffClaim(request, env));
    case "/api/members":
      return only("GET") || cached("members", 60, () => handleMembers(env));

    // feeds
    case "/api/posts":
      if (method === "POST") return handleNewPost(request, env, fetchImpl);
      return only("GET") || handlePosts(request, env, fetchImpl);
    case "/api/posts/vote":
      return only("POST") || handleVote(request, env, fetchImpl);
    case "/api/posts/report":
      return only("POST") || handleReport(request, env, fetchImpl);

    // moderation
    case "/api/mod":
      return only("GET") || handleModQueue(request, env, fetchImpl);
    case "/api/mod/hide":
      return only("POST") || handleHide(request, env, fetchImpl);
    case "/api/mod/unhide":
      return only("POST") || handleUnhide(request, env, fetchImpl);
    case "/api/mod/ban":
      return only("POST") || handleProposeBan(request, env, fetchImpl);
    case "/api/mod/ban/approve":
      return only("POST") || handleBanDecision(request, env, true, fetchImpl);
    case "/api/mod/ban/reject":
      return only("POST") || handleBanDecision(request, env, false, fetchImpl);
    case "/api/appeals":
      return only("POST") || handleAppeal(request, env);
    case "/api/appeals/decide":
      return only("POST") || handleDecideAppeal(request, env, fetchImpl);
    case "/api/audit":
      return only("GET") || db(() => handleAudit(env, url));
    case "/api/towns":
      if (method === "POST") return handleTownRequest(request, env);
      return only("GET") || handleMyTowns(request, env);
    case "/api/towns/decide":
      return only("POST") || handleTownDecision(request, env, fetchImpl);

    // Founding Supporters
    case "/api/snapshots":
      return only("GET") || (env.DB ? db(() => handleSnapshots(env)) : json({ scheduledCutoff: snapshotCutoff(env), snapshots: [] }));
    case "/api/snapshots/cancel":
      return only("POST") || handleCancelSnapshot(request, env);
    default:
      return json({ error: "not_found" }, 404);
  }
}

export function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== "Cache-Control") res.headers.set(k, v);
  return res;
}

/** vicinity.city is the address; the old one and the www versions forward there, keeping the path.
 *  Plain http:// visits are sent to https:// (except on this computer, for `wrangler dev`). */
const CANONICAL_HOST = "vicinity.city";
const FORWARD_HOSTS = new Set(["www.vicinity.city", "vicinitycity.net", "www.vicinitycity.net"]);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/;
// `wrangler dev` presents local visits as http://vicinity.city, but from this computer's own address.
const isLocal = (request, url) =>
  LOCAL_HOST.test(url.hostname) || ["127.0.0.1", "::1"].includes(request.headers.get("cf-connecting-ip"));

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const insecure = url.protocol === "http:" && !isLocal(request, url);
      if (FORWARD_HOSTS.has(url.hostname) || insecure) {
        if (FORWARD_HOSTS.has(url.hostname)) url.hostname = CANONICAL_HOST;
        url.protocol = "https:"; url.port = "";
        return new Response(null, { status: 301, headers: { Location: url.toString(), ...SECURITY_HEADERS, "Cache-Control": "public, max-age=3600" } });
      }
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, fetch, ctx);
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return json({ error: "internal_error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJobs(env, Date.now()).then((r) => console.log("jobs", JSON.stringify(r))).catch((e) => console.error("jobs failed", String(e))));
  },
};
