// Request changes, the review status and the founder's own description on the real dashboard (public/coin-review.js through coin-ready.js;
// COIN_V2_REVIEW=on): with the switch off (no `review` in the answer) the page never asks for it and the card is stage 1's exactly; on, the
// founder gets Request changes and Write your own; the draft saves and submits exactly the version the server keeps (the question first);
// every status (Pending, Approved, Changes needed) shows its words in the tag, its reason and note, and its actions; the description's
// results (pass, flag with Send for review and Keep the default, block, error) with the flagged words marked; nothing is built from text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADDR, memberMe, openDashboard } from "./helpers/dashpage.js";

const JS = readFileSync(new URL("../public/coin-review.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../public/coin-review.css", import.meta.url), "utf8");
const HASH = "3f9a2c1b" + "a".repeat(56), HASH2 = "77aa11bb" + "c".repeat(56), ART = `/coin-meta/art/${"b".repeat(64)}.png`;
const CITY = { id: "5142056", name: "Utica", region: "New York", regionCode: "NY", country: "US", countryName: "United States" };
const COIN = { ticker: "UTICA", name: "Utica", description: "The city coin of Utica, New York, United States.", pair: "SOL", templateVersion: "t1", source: "Vicinity city list", art: ART, contentHash: HASH, version: HASH.slice(0, 8) };
const CHOSEN = { contentHash: HASH, version: HASH.slice(0, 8), at: "2026-10-18T10:00:00Z", current: true, art: ART, launched: false, ticker: "UTICA", name: "Utica", mine: true };
const REVIEW = (over = {}) => ({
  on: true, rulesVersion: "s1-test", nextRound: "at the owner's next approval round",
  defaults: { name: "Utica", symbol: "UTICA", description: COIN.description },
  selected: { origin: "default", contentHash: HASH, version: HASH.slice(0, 8), name: "Utica", symbol: "UTICA", description: COIN.description, art: ART, descriptionSource: "default", upload: false },
  request: null, description: { source: "default", text: COIN.description, screening: null }, hold: null,
  can: { request: true, describe: true, reset: false, cancel: false, edit: false }, blocked: null, ...over,
});
const answer = (over = {}, review = REVIEW()) => ({ ok: true, mode: "founder", city: CITY, coin: COIN, chosen: CHOSEN, inUse: true, earlier: false, gate: null,
  preview: { label: "Preview, not launched", ticker: "UTICA", name: "Utica", description: COIN.description, chosen: true, city: { name: "Utica", region: "New York", countryName: "United States" }, art: ART },
  ...(review ? { review } : {}), ...over });

function founderMe() {
  const me = memberMe({ wallet: ADDR, launched: true, amount: 2_000_000, rank: 3 });
  const seat = { id: 7, cityId: "5142056", city: "Utica", country: "US", status: "active", since: "2026-10-01T12:00:00Z", appealUntil: null, graceUntil: null, probationUntil: null, threshold: 100000, policy: 5 };
  me.roles.founder = true; me.level = "founder"; me.founder.seat = seat;
  me.community.seat = { id: 7, status: "active", name: "SwiftHarbor10", wallet: "7Np41*****4K2", since: seat.since, appealUntil: null, graceUntil: null, probationUntil: null, you: true, openObjections: 0, threshold: 100000, policy: 5, cofounders: [], quorum: null };
  me.coinV2Ready = true;
  return me;
}
/** The dashboard with the review step: `server(path, body)` answers the coin and review routes (a founder answer each time). */
async function open(server) {
  const posts = [];
  const page = await openDashboard({ me: founderMe(), api: async (path, body) => {
    if (path.startsWith("/api/coins/ready") || path.startsWith("/api/coins/review")) { if (body) posts.push([path, body]); return server(path, body); }
    return undefined;
  } });
  await page.advance(1000);
  return { page, posts };
}
const buttons = (page, sel) => page.$$(`${sel} button`).map((b) => b.textContent);
/** The same, on the Founder tab (where the card is shown, so the keyboard can land on it). */
async function openFounder(server) {
  const posts = [];
  const page = await openDashboard({ hash: "founder", me: founderMe(), api: async (path, body) => {
    if (path.startsWith("/api/coins/ready") || path.startsWith("/api/coins/review")) { if (body) posts.push([path, body]); return server(path, body); }
    return undefined;
  } });
  await page.advance(1000);
  return { page, posts };
}

test("switch off: an answer without `review` never loads the step; the card is stage 1's (one action, its caption)", async () => {
  const { page } = await open(() => answer({}, null));
  assert.equal(page.calls.some((c) => /coin-review/.test(c.path)), false);
  assert.equal(page.$("#crv"), null, "nothing of the step on the page");
  assert.match(page.text(".coin-ready__caption"), /so nothing here can be edited\./);
  assert.ok(!page.doc.querySelectorAll('link[rel="stylesheet"]').some((l) => /coin-review/.test(l.getAttribute("href") || "")), "no stylesheet either");
});

test("switch on: Request changes and Write your own description; the caption says how changes happen; the draft saves and submits exactly what the server keeps", async () => {
  let view = answer();
  const { page, posts } = await open((path, body) => {
    if (path === "/api/coins/review/draft") {
      const updatedAt = "2026-10-23T10:00:00.000Z";
      view = answer({}, REVIEW({ request: { id: 4, kind: "change", status: "draft", label: "Draft", message: "Your draft is private. Your coin stays as it is until a reviewer approves the change. Submitting pauses your launch until they decide.",
        version: null, contentHash: null, diff: [{ field: "name", from: "Utica", to: body.name }], proposed: { name: body.name, symbol: "UTICA" }, registryState: null,
        draft: { name: body.name, symbol: null, picture: "vicinity", art: "/api/media/9", reason: body.reason, updatedAt }, nameIssues: [] }, can: { request: false, describe: true, reset: false, cancel: true, edit: false } }));
      return { ...view, saved: true };
    }
    if (path === "/api/coins/review/submit") {
      view = answer({}, REVIEW({ request: { id: 4, kind: "change", status: "pending", label: "Pending", message: `Version ${HASH2.slice(0, 8)} · a reviewer checks exactly this version. Launch is paused until they decide.`,
        version: HASH2.slice(0, 8), contentHash: HASH2, submittedAt: "2026-10-23T10:01:00Z", diff: [{ field: "picture", from: ART, to: "/api/media/9" }, { field: "name", from: "Utica", to: "Utica Falls" }],
        proposed: { name: "Utica Falls" }, registryState: null, draft: null, nameIssues: [] },
        hold: { code: "paused_request", message: "Launch is paused while your change request is reviewed. Cancelling the request ends the pause." },
        can: { request: false, describe: false, reset: false, cancel: true, edit: true } }));
      return { ...view, submitted: true };
    }
    return view;
  });
  assert.equal(page.calls.filter((c) => c.path === "/coin-review.js").length, 0, "(a script tag, not an API call)");
  assert.ok(page.$("#crv"), "the step is on the card");
  assert.equal(page.$("#crv").parentNode.id, "coin-ready");
  assert.match(page.text(".coin-ready__caption"), /You can't edit these yourself: request changes and a reviewer decides\./);
  assert.deepEqual(buttons(page, "#crv-actions"), ["Request changes", "Write your own description"]);
  assert.equal(page.$("#crv-form").hidden, true);
  // the draft form
  await page.tap(page.$$("#crv-actions button")[0]);
  assert.equal(page.$("#crv-form").hidden, false);
  assert.match(page.text("#crv-form"), /Change request · draft/);
  assert.match(page.text("#crv-form"), /Your draft is private\. Your coin stays as it is until a reviewer approves the change\. Submitting pauses your launch until they decide\./);
  assert.match(page.text("#crv-form"), /A person checks every picture\. Logos or photos you don't own can't be used\./);
  assert.match(page.text("#crv-form"), /Tickers come from the Vicinity city list\. An approved change is added to the list in a site update before you can launch with it\./);
  assert.deepEqual(page.$$("#crv-form input[type=radio]").map((i) => i.value), ["vicinity", "upload"], "no 'keep this picture' for the Vicinity design");
  const name = page.$("#crv-name");
  name.value = "Utica Falls"; name.dispatchEvent({ type: "input", bubbles: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(page.text("#crv-name-count"), "11 of 32 bytes (accents count 2)");
  name.value = "Herāt Herāt Herāt Herāt Herāt Herāt"; name.dispatchEvent({ type: "input", bubbles: true, preventDefault() {}, stopPropagation() {} });
  assert.ok(page.$("#crv-name-count").classList.contains("crv-over"), "over 32 bytes is marked");
  name.value = "Utica Falls"; name.dispatchEvent({ type: "input", bubbles: true, preventDefault() {}, stopPropagation() {} });
  const why = page.$("#crv-reason");
  why.value = "Locals call it the falls city since 1850."; why.dispatchEvent({ type: "input", bubbles: true, preventDefault() {}, stopPropagation() {} });
  // Submit: the draft is saved first, then the question, then exactly the saved version
  await page.tap(page.$("#crv-submit"));
  assert.deepEqual(posts[0], ["/api/coins/review/draft", { cityId: "5142056", name: "Utica Falls", symbol: null, picture: "vicinity", reason: "Locals call it the falls city since 1850." }]);
  assert.equal(page.$("#crv-confirm").hidden, false);
  assert.match(page.text("#crv-confirm"), /Submit this change for review\?.*Coin name.*Utica.*Utica Falls.*Submitting pauses your launch until a reviewer decides\./);
  assert.equal(posts.length, 1, "nothing is submitted before the founder says so");
  await page.tap(page.$("#crv-confirm-go"));
  assert.deepEqual(posts[1], ["/api/coins/review/submit", { cityId: "5142056", draftUpdatedAt: "2026-10-23T10:00:00.000Z" }]);
  // Pending: the words in the tag, the version, what changes, the hold; Cancel and Edit
  assert.equal(page.text("#crv-req-tag"), "Pending");
  assert.match(page.text("#crv-req-msg"), /a reviewer checks exactly this version\. Launch is paused until they decide\./);
  assert.equal(page.text("#crv-hold"), "Launch is paused while your change request is reviewed. Cancelling the request ends the pause.");
  assert.deepEqual(buttons(page, "#crv-status"), ["Cancel request", "Edit"]);
  assert.equal(page.$$(".crv-diff img").map((i) => i.getAttribute("src")).join(" "), `${ART} /api/media/9`);
  assert.deepEqual(page.$$(".crv-diff img").map((i) => i.alt), ["The coin's picture now", "The proposed picture"]);
  assert.equal(page.$("#crv-form").hidden, true);
  assert.deepEqual(buttons(page, "#crv-actions"), [], "nothing else while it waits");
  assert.ok(page.toasts.includes("Sent for review"));
});

test("every status: Approved and Changes needed with the reason and note; Revise, Cancel and keep, one Request changes; Edit asks first", async () => {
  const approved = REVIEW({ selected: { ...REVIEW().selected, origin: "change", name: "Utica Falls" }, request: { id: 4, kind: "change", status: "approved", label: "Approved",
    message: "Version 77aa11bb was approved. It is now your coin. It launches after the owner approves it on the blockchain, at the owner's next approval round.", version: "77aa11bb", contentHash: HASH2,
    diff: [{ field: "name", from: "Utica", to: "Utica Falls" }], proposed: {}, registryState: null, draft: null, nameIssues: [] }, can: { request: true, describe: true, reset: true, cancel: false, edit: false } });
  const needs = REVIEW({ request: { id: 5, kind: "change", status: "changes_needed", label: "Changes needed", reasonCode: "name_misleading",
    reason: "The name could be mistaken for another city, a company, a public body or Vicinity.", note: "Please drop the word Official.",
    message: "Changes needed: The name could be mistaken for another city, a company, a public body or Vicinity. Note from the reviewer: Please drop the word Official. Your coin stays as it was.",
    version: "77aa11bb", contentHash: HASH2, diff: [], proposed: {}, registryState: null, draft: null, nameIssues: [] }, can: { request: true, describe: true, reset: false, cancel: false, edit: true } });
  let view = answer({}, approved);
  const { page, posts } = await open((path) => (path.startsWith("/api/coins/ready") ? view : { ...view, ok: true }));
  assert.equal(page.text("#crv-req-tag"), "Approved");
  assert.match(page.text("#crv-req-msg"), /It launches after the owner approves it on the blockchain, at the owner's next approval round\./);
  assert.doesNotMatch(page.text("#coin-ready"), /24 hours|within a day|tomorrow|launch now/i, "no time promised; nothing says launch now");
  assert.deepEqual(buttons(page, "#crv-status"), [], "one Request changes button, not two");
  assert.deepEqual(buttons(page, "#crv-actions"), ["Request changes", "Write your own description", "Reset to Vicinity defaults"]);
  await page.tap(page.$$("#crv-actions button").find((b) => b.textContent === "Reset to Vicinity defaults"));
  assert.deepEqual(posts.at(-1), ["/api/coins/review/reset", { cityId: "5142056" }]);
  // changes needed
  view = answer({}, needs);
  await page.advance(61_000); // the minute refresh
  page.win.dispatchEvent({ type: "focus" });
  const { page: p2, posts: posts2 } = await open(() => view);
  assert.equal(p2.text("#crv-req-tag"), "Changes needed");
  assert.match(p2.text("#crv-req-msg"), /^Changes needed: The name could be mistaken for another city, a company, a public body or Vicinity\. Note from the reviewer: Please drop the word Official\./);
  assert.deepEqual(buttons(p2, "#crv-status"), ["Revise", "Cancel and keep the coin as it is"]);
  await p2.tap(p2.$$("#crv-status button")[0]);
  assert.deepEqual(posts2.at(-1), ["/api/coins/review/edit", { cityId: "5142056", requestId: 5 }]);
  await p2.tap(p2.$$("#crv-status button")[1]);
  assert.deepEqual(posts2.at(-1), ["/api/coins/review/cancel", { cityId: "5142056", requestId: 5 }]);
  // pending: Edit asks first (a "no" sends nothing)
  view = answer({}, REVIEW({ request: { id: 6, kind: "change", status: "pending", label: "Pending", message: "x", version: "77aa11bb", contentHash: HASH2, diff: [], proposed: {}, draft: null, nameIssues: [] }, can: { request: false, describe: false, reset: false, cancel: true, edit: true } }));
  const p3 = await openDashboard({ me: founderMe(), confirm: false, api: async (path, body) => (path.startsWith("/api/coins") ? (body ? { ...view, sentBody: body } : view) : undefined) });
  await p3.advance(1000);
  const before = p3.calls.filter((c) => c.path === "/api/coins/review/edit").length;
  await p3.tap(p3.$$("#crv-status button").find((b) => b.textContent === "Edit"));
  assert.equal(p3.calls.filter((c) => c.path === "/api/coins/review/edit").length, before, "the founder said no: nothing sent");
});

test("the founder's own description: a flag shows the reasons with the words marked, Revise / Send for review / Keep the default; a pass, a block and an error", async () => {
  const flagged = { id: 31, result: "flag", text: "Utica coin: guaranteed profit, 100x to the moon soon.",
    issues: [{ code: "financial", severity: "flag", start: 12, end: 22, message: "This sounds like a promise about price or profit. City coins can't promise returns." },
      { code: "financial", severity: "flag", start: 31, end: 35, message: "This sounds like a promise about price or profit. City coins can't promise returns." }] };
  let next = null, view = answer();
  const { page, posts } = await open((path) => {
    if (path === "/api/coins/review/description") return { ...view, screening: next };
    if (path === "/api/coins/review/description/review") {
      view = answer({}, REVIEW({ request: { id: 8, kind: "description", status: "pending", label: "Pending", message: "Version 1234abcd · a reviewer checks exactly this version. Launch is paused until they decide.", version: "1234abcd", contentHash: HASH2, diff: [{ field: "description", from: COIN.description, to: flagged.text }], proposed: {}, draft: null, nameIssues: [] },
        hold: { code: "paused_description", message: "Launch is paused while your description is reviewed. Going back to the default description ends the pause." }, can: { request: false, describe: false, reset: false, cancel: true, edit: false } }));
      return view;
    }
    return view;
  });
  assert.equal(page.text("#crv-desc-info"), "Description: Vicinity's default.");
  await page.tap(page.$$("#crv-actions button").find((b) => b.textContent === "Write your own description"));
  const ta = page.$("#crv-desc-text");
  assert.equal(ta.placeholder, "What makes Utica worth a coin? No links, prices or promises.");
  ta.value = flagged.text; ta.dispatchEvent({ type: "input", bubbles: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(page.text("#crv-desc-count"), `${Array.from(flagged.text).length} of 200 characters`);
  next = flagged;
  await page.tap(page.$("#crv-desc-check"));
  assert.deepEqual(posts.at(-1), ["/api/coins/review/description", { cityId: "5142056", text: flagged.text }]);
  assert.equal(page.text("#crv-desc-verdict"), "This needs a person to look at it:");
  assert.match(page.text("#crv-desc-result"), /This sounds like a promise about price or profit\. City coins can't promise returns\./);
  assert.match(page.text("#crv-desc-result"), /You can revise it, or send it to Vicinity for review; your launch waits until they decide\. Or keep the default description, which needs no review\./);
  assert.doesNotMatch(page.text("#coin-ready"), /launch now|24 hours|within a day/i, "no time promised");
  assert.deepEqual(page.$$("#crv-desc-result mark").map((m) => m.textContent), ["guaranteed", "100x"]);
  assert.deepEqual(buttons(page, "#crv-desc-result"), ["Revise", "Send for review", "Keep the default"]);
  await page.tap(page.$$("#crv-desc-result button").find((b) => b.textContent === "Send for review"));
  assert.deepEqual(posts.at(-1), ["/api/coins/review/description/review", { cityId: "5142056", screeningId: 31 }]);
  assert.equal(page.text("#crv-req-tag"), "Pending");
  assert.equal(page.text("#crv-hold"), "Launch is paused while your description is reviewed. Going back to the default description ends the pause.");
  // a block offers Revise only; an error says nothing changed and offers Try again; a pass is used at once
  for (const [res, verdict, btns] of [["block", "This can't be used:", ["Revise"]], ["error", "We couldn't check your description just now. Nothing changed: your coin keeps its current description. Try again in a minute.", ["Try again"]]]) {
    const { page: p, posts: ps } = await open((path) => (path === "/api/coins/review/description" ? (res === "error" ? { ok: false, error: "screening_error", message: "x" } : { ...answer(), screening: { id: 2, result: "block", text: "Visit utica.io now please", issues: [{ code: "link", severity: "block", start: 6, end: 14, message: "Links and web addresses can't go in a coin description." }] } }) : answer()));
    await p.tap(p.$$("#crv-actions button").find((b) => b.textContent === "Write your own description"));
    p.$("#crv-desc-text").value = "Visit utica.io now please";
    await p.tap(p.$("#crv-desc-check"));
    assert.equal(p.text("#crv-desc-verdict"), verdict, res);
    assert.deepEqual(buttons(p, "#crv-desc-result"), btns, res);
    if (res === "block") assert.deepEqual(p.$$("#crv-desc-result mark").map((m) => m.textContent), ["utica.io"]);
    assert.equal(ps.filter(([path]) => path === "/api/coins/review/description").length, 1);
  }
});

test("no markup from text, 44 px targets, every tag has words, the live regions", () => {
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(CSS, /\.coin-review \.btn \{ min-height: 44px; \}/);
  assert.match(CSS, /\.crv-choice \{[^}]*min-height: 44px/);
  assert.match(JS, /status\.setAttribute\("aria-live", "polite"\)/);
  assert.match(JS, /desc\.setAttribute\("aria-live", "polite"\)/);
  assert.match(JS, /err\.setAttribute\("role", "alert"\)/);
  for (const label of ["Draft", "Pending", "Approved", "Changes needed"]) assert.ok(!/class=/.test(label), label);
  assert.doesNotMatch(JS + CSS, /24 hours|within a day|tomorrow/i, "no time is ever promised");
});

test("the keyboard stays with the result of each action, however often the card is drawn again (the route's answer, then the dashboard's reload)", async () => {
  const pending = answer({ gate: { code: "request_pending", message: "Your change request is waiting for review. Launch and other changes wait until a reviewer decides; you can cancel the request." } }, REVIEW({
    request: { id: 4, kind: "change", status: "pending", label: "Pending", message: "Version 77aa11bb · a reviewer checks exactly this version. Launch is paused until they decide.", version: "77aa11bb", contentHash: HASH2,
      submittedAt: "2026-10-23T10:01:00Z", diff: [{ field: "name", from: "Utica", to: "Utica Falls" }], proposed: {}, registryState: null, draft: null, nameIssues: [] },
    hold: { code: "paused_request", message: "x" }, can: { request: false, describe: false, reset: false, cancel: true, edit: true } }));
  const draft = answer({}, REVIEW({ request: { id: 4, kind: "change", status: "draft", label: "Draft", message: "d", version: null, contentHash: null, diff: [{ field: "name", from: "Utica", to: "Utica Falls" }],
    proposed: {}, registryState: null, draft: { name: "Utica Falls", symbol: null, picture: "vicinity", art: null, reason: "Locals call it the falls city since 1850.", updatedAt: "2026-10-23T10:00:00.000Z" }, nameIssues: [] },
  can: { request: false, describe: true, reset: false, cancel: true, edit: false } }));
  let view = draft;
  const { page } = await openFounder((path) => {
    if (path === "/api/coins/review/submit") view = pending;
    if (path === "/api/coins/review/cancel") view = answer();
    return view;
  });
  await page.tap(page.$("#crv-submit"));
  await page.tap(page.$("#crv-confirm-go"));
  await page.advance(1000); // the dashboard reads the coin again and the card is drawn again
  assert.equal(page.doc.activeElement && page.doc.activeElement.id, "crv-req-tag", "on the new status, not back at the top");
  // the coin card names a waiting review as one ("Pending review"), and the review card says it once, not the gate line too
  assert.equal(page.text("#cr-state"), "Pending review");
  assert.equal(page.$("#cr-gate").hidden, true);
  await page.tap(page.$$("#crv-status button").find((b) => b.textContent === "Cancel request"));
  await page.advance(1000);
  assert.equal(page.doc.activeElement && page.doc.activeElement.textContent, "Request changes", "after Cancel: on the next action");
});

test("the request card follows the coin: Before / Approved once decided; the caption says a reviewer approved the name; a draft that changes nothing is said before the question", async () => {
  const renamed = { ...REVIEW().selected, origin: "change", name: "Utica Falls", symbol: "UTICANY" };
  const approved = REVIEW({ selected: renamed, request: { id: 4, kind: "change", status: "approved", label: "Approved", message: "Version 77aa11bb was approved. It is now your coin. It is approved on the blockchain too.",
    version: "77aa11bb", contentHash: HASH2, diff: [{ field: "name", from: "Utica", to: "Utica Falls" }], proposed: {}, registryState: null, draft: null, nameIssues: [] },
  can: { request: true, describe: true, reset: true, cancel: false, edit: false } });
  const { page } = await open(() => answer({}, approved));
  assert.deepEqual(page.$$("#crv-status thead th").map((h) => h.textContent), ["", "Before", "Approved"]);
  assert.match(page.text(".coin-ready__caption"), /with the changes a reviewer approved for your coin/);
  assert.equal(page.text(".coin-ready__src"), "The place comes from the Vicinity city list; the ticker and the name are the ones a reviewer approved for your coin.");
  // a draft with no change: refused before the question, nothing submitted
  const noop = answer({}, REVIEW({ request: { id: 5, kind: "change", status: "draft", label: "Draft", message: "d", version: null, contentHash: null, diff: [], proposed: {}, registryState: null,
    draft: { name: null, symbol: null, picture: "vicinity", art: null, reason: "Locals call it the falls city since 1850.", updatedAt: "2026-10-23T10:00:00.000Z" }, nameIssues: [] },
  can: { request: false, describe: true, reset: false, cancel: true, edit: false } }));
  const { page: p2, posts } = await open(() => noop);
  await p2.tap(p2.$("#crv-submit"));
  assert.equal(p2.$("#crv-confirm").hidden, true, "no question for nothing");
  assert.equal(p2.text("#crv-err"), "Your draft changes nothing yet. Pick another picture, ticker or name first.");
  assert.equal(posts.some(([path]) => path === "/api/coins/review/submit"), false);
});

test("NEW-1: after an admin's takedown the description line says what happened, in the server's words (until the founder changes the coin again)", async () => {
  const message = "Vicinity took down your description (abuse or hate). Your coin uses Vicinity's own description now. If you send the same words again, a person reviews them first.";
  const { page } = await open(() => answer({}, REVIEW({ description: { source: "default", text: COIN.description, screening: null, takenDown: { at: "2026-10-20T12:00:00Z", message } } })));
  assert.equal(page.text("#crv-desc-info"), `Description: Vicinity's default. ${message}`);
  assert.equal(page.$("#crv-desc-info").children.length, 0, "text only");
});
