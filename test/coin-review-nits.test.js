// City coins step 3 (COIN_V2_REVIEW), review nits, through the real API and real SQL with the launchpad's fake chain: a description the
// checks found nothing in says so once on the admin's card, with one sentence to read every word (COPY-2); and a screener that cannot
// load (src/screen.js is imported lazily) never breaks the founder's card or the review queue, and never makes anything current,
// sendable or approved (LAZY-ERR-1).
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { person, realClock } from "./helpers/world.js";
import { _resetLpKit } from "../src/lpkit.js";
import { _resetLpAdmin } from "../src/lpadmin.js";
import { _resetLpCoins } from "../src/lpcoins.js";
import { _setArtRenderer } from "../src/coinready.js";
import { _resetReview, _setScreener, _setScreenLoader } from "../src/coinreview.js";
import { nodeRenderer } from "../scripts/coin-art/render.mjs";
import { UTICA, world } from "./helpers/readyworld.js";

before(async () => { const r = await nodeRenderer(); _setArtRenderer(r); });
after(() => { _setArtRenderer(null); _setScreener(null); _setScreenLoader(null); realClock(); });
beforeEach(() => { _resetLpKit(); _resetLpAdmin(); _resetLpCoins(); _resetReview(); _setScreener(null); _setScreenLoader(null); realClock(); });

const DEF = "The city coin of Utica, New York, United States.";
const PLAIN = "The Handshake City on the Mohawk River, home of tomato pie.";
const FLAGGED = "Utica coin: guaranteed profit, 100x to the moon soon.";
const UNEXPLAINED = "We couldn't explain this check just now. Nothing changed. Try again in a minute.";

async function reviewWorld() {
  const w = await world();
  w.env.COIN_V2_REVIEW = "on";
  const at = new Date(Date.now()).toISOString();
  w.admin = await person(w.env);
  await w.env.DB.prepare("INSERT INTO admin_roles (wallet, role, granted_by, granted_at) VALUES (?, 'admin', ?, ?)").bind(w.admin.w.address, w.owner.w.address, at).run();
  w.rv = (path, body = {}, who = w.f) => w.post(who, `/api/coins/review/${path}`, { cityId: UTICA, ...body });
  /** a GET with its status: the founder's card, the admin's queue */
  w.fetch = async (who, path) => { const r = await who.send(path, { fetchImpl: w.both }); return { status: r.status, ...(await r.json()) }; };
  w.ready = (who = w.f) => w.fetch(who, `/api/coins/ready?city=${UTICA}`);
  w.queue = (who = w.admin) => w.fetch(who, "/api/admin/coins/reviews");
  return w;
}
/** What the admin's card writes for a check (public/admin.js): its sentence, then one sentence per kind of issue. */
const cardLine = (c) => [c.text, ...new Set((c.issues || []).map((i) => i.message || i.code))].join(" ");
const failing = () => Promise.reject(new Error("screen.js failed to load"));

test("COPY-2: a description the checks found nothing in says 'found nothing to point out' once on the admin's card, and to read every word", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const plain = await w.rv("description", { text: PLAIN });
  assert.deepEqual([plain.screening.result, plain.screening.issues.map((x) => x.code)], ["flag", ["review"]]);
  const sent = await w.rv("description/review", { screeningId: plain.screening.id });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const q = await w.queue();
  assert.equal(q.status, 200);
  const check = q.reviews.find((x) => x.id === sent.review.request.id).checks.find((x) => x.check === "description_screening");
  assert.equal(check.ok, false, "still a flag: a person reads it");
  const line = cardLine(check);
  assert.equal(line.match(/found nothing to point out/g).length, 1, line);
  assert.equal(line, "The automatic checks found nothing to point out. Read every word: no check can tell an honest sentence from a threat, a scam or hate written in ordinary words.");
  // a description the checks did flag still lists what they found
  const cancel = await w.rv("cancel", { requestId: sent.review.request.id });
  assert.equal(cancel.ok, true, JSON.stringify(cancel));
  const fl = await w.rv("description", { text: FLAGGED });
  const sent2 = await w.rv("description/review", { screeningId: fl.screening.id });
  assert.equal(sent2.ok, true, JSON.stringify(sent2));
  const check2 = (await w.queue()).reviews.find((x) => x.id === sent2.review.request.id).checks.find((x) => x.check === "description_screening");
  assert.equal(check2.text, "The checks flagged the description.");
  assert.ok(check2.issues.length && check2.issues.every((x) => x.code === "financial" && /City coins can't promise returns/.test(x.message)), JSON.stringify(check2.issues));
});

test("LAZY-ERR-1: the screener cannot load: the founder's card and the queue still answer, the issues keep their codes, nothing is current, sendable or approved", async () => {
  const w = await reviewWorld();
  await w.useCoin();
  const fl = await w.rv("description", { text: FLAGGED });
  assert.equal(fl.screening.result, "flag");
  const ok = await w.ready();
  assert.equal(ok.status, 200);
  assert.match(ok.review.rulesVersion, /^s1-[0-9a-f]{12}$/);
  assert.equal(ok.review.description.screening.current, true);
  // src/screen.js fails to load (a deploy that broke it, an isolate out of memory): the card still renders
  _setScreenLoader(failing);
  const v = await w.ready();
  assert.equal(v.status, 200, JSON.stringify(v));
  assert.equal(v.review.on, true);
  assert.equal(v.review.rulesVersion, null);
  const sc = v.review.description.screening;
  assert.deepEqual([sc.id, sc.result, sc.text, sc.current], [fl.screening.id, "flag", FLAGGED, false]);
  assert.ok(sc.issues.length && sc.issues.every((x) => x.code === "financial" && x.message === UNEXPLAINED), JSON.stringify(sc.issues));
  assert.deepEqual(sc.issues.map((x) => [x.start, x.end]), fl.screening.issues.map((x) => [x.start, x.end]), "the marked words stay marked");
  assert.equal(v.coin.description, DEF, "the coin keeps Vicinity's sentence");
  assert.equal(v.review.description.source, "default");
  // nothing is sendable or screened while it cannot load: the flag can't be sent, a new description is an error, nothing changes
  const cant = await w.rv("description/review", { screeningId: fl.screening.id });
  assert.deepEqual([cant.status, cant.error], [409, "cannot_review"]);
  const er = await w.rv("description", { text: "Utica is a lovely old city on the Erie Canal." });
  assert.deepEqual([er.status, er.error], [503, "screening_error"]);
  const erRow = await w.env.DB.prepare("SELECT result, rules_version FROM coin_screenings ORDER BY id DESC LIMIT 1").first();
  assert.deepEqual([erRow.result, erRow.rules_version], ["error", "unloaded"], "the audit keeps the attempt; no rules version is made up");
  assert.equal((await w.card()).pitch, DEF);
  // back: the same flag is current and sendable again; sent, then the screener fails again: the queue still answers, nothing approved
  _setScreenLoader(null);
  const sent = await w.rv("description/review", { screeningId: fl.screening.id });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  _setScreenLoader(failing);
  const q = await w.queue();
  assert.equal(q.status, 200, JSON.stringify(q));
  const row = q.reviews.find((x) => x.id === sent.review.request.id);
  assert.deepEqual([row.kind, row.status], ["description", "pending"]);
  const check = row.checks.find((x) => x.check === "description_screening");
  assert.equal(check.ok, false);
  assert.equal(check.text, "The checks flagged the description.");
  assert.ok(check.issues.length && check.issues.every((x) => x.code === "financial" && x.message === UNEXPLAINED), JSON.stringify(check.issues));
  const v2 = await w.ready();
  assert.equal(v2.status, 200, JSON.stringify(v2));
  assert.deepEqual([v2.review.request.kind, v2.review.request.status, v2.review.hold.code], ["description", "pending", "paused_description"]);
  assert.equal(v2.coin.description, DEF);
  assert.equal((await w.card()).ok, false, "a waiting description pauses the launch; nothing is treated as approved");
});
