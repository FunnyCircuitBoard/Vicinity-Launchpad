// The Feedback / Support widget on the pages (public/feedback.js, public/feedback.css, built in by scripts/pages/build.mjs):
// where it sits in every page, what it builds, how it opens and closes for a finger and for the keyboard, what it sends and
// what it says afterwards, and that it stays inert while the Terms gate is open. Runs the real script on the real built pages
// in the just-enough DOM of test/helpers/pagedom.js; how it looks is checked in real Chromium (the end-to-end run).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, readdirSync } from "node:fs";
import { dispatch, newEvent, openPage } from "./helpers/pagedom.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const FEEDBACK_JS = read("public/feedback.js"), FEEDBACK_CSS = read("public/feedback.css"), BUILD = read("scripts/pages/build.mjs");
const PAGES = readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html"));
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/**
 * A built page with site.js and then feedback.js running on it. `answer(body)` is what POST /api/feedback replies
 * (default { ok: true, id: 1 }); every request is recorded in `calls`.
 */
async function widget(file = "index.html", { agreed = "2026-10-01", answer = () => ({ ok: true, id: 1 }) } = {}) {
  const page = await openPage(file, { agreed });
  const win = page.window;
  const calls = [];
  win.location = { pathname: "/cities", search: "?city=5128581" };
  win.fetch = async (path, init = {}) => {
    const body = String(path).startsWith("/api/me") ? { ok: true, signedIn: false } : answer(init.body ? JSON.parse(init.body) : null);
    calls.push({ path, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    const status = body.ok === false ? body._status || 400 : 200;
    return { ok: status < 400, status, json: async () => body };
  };
  vm.runInContext(FEEDBACK_JS, win, { filename: "public/feedback.js" });
  await tick();
  return { ...page, calls };
}
const submit = (form, win) => dispatch(form, newEvent("submit"), win);

test("every built page loads feedback.css after the site's stylesheet and runs feedback.js last, after site.js", () => {
  assert.ok(PAGES.length >= 12);
  for (const f of PAGES) {
    const h = read("public/" + f);
    assert.match(h, /<link rel="stylesheet" href="\/style\.css">\n  <link rel="stylesheet" href="\/feedback\.css">/, `${f}: the widget's stylesheet right after the site's`);
    const scripts = [...h.matchAll(/<script src="\/([a-z/-]+)\.js" defer><\/script>/g)].map((m) => m[1]);
    assert.equal(scripts[0], "site", f);
    assert.equal(scripts.at(-1), "feedback", `${f}: feedback.js runs last`);
    assert.equal(scripts.filter((s) => s === "feedback").length, 1, f);
  }
  assert.match(BUILD, /\["site", \.\.\.scripts, "feedback"\]/, "the build puts it there, not the page sources");
  assert.match(BUILD, /<link rel="stylesheet" href="\/feedback\.css">/);
});

test("the widget: a round button in the corner with a name, state and the panel it controls; the panel is a named dialog, closed at first", async () => {
  const { $, doc } = await widget();
  const root = $("#fb");
  assert.ok(root && root.parentNode === doc.body, "a child of the body");
  assert.equal(doc.body.children.at(-1), root, "the last thing in the page");
  const btn = $("#fb-open");
  assert.equal(btn.tagName, "BUTTON");
  assert.equal(btn.getAttribute("aria-label"), "Feedback and support");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(btn.getAttribute("aria-haspopup"), "dialog");
  assert.equal(btn.getAttribute("aria-controls"), "fb-panel");
  assert.ok(btn.querySelector("svg"), "an icon, not words, on the round button");
  const panel = $("#fb-panel");
  assert.equal(panel.hidden, true);
  assert.equal(panel.getAttribute("role"), "dialog");
  assert.equal(panel.getAttribute("aria-labelledby"), "fb-title");
  assert.equal($("#fb-title").textContent, "Talk to us");
  // the three kinds are one tab stop (a tablist with roving tabindex), Question first
  const tabs = $("#fb-kinds").querySelectorAll("[role=tab]");
  assert.deepEqual(tabs.map((t) => [t.dataset.kind, t.textContent, t.getAttribute("aria-selected"), t.tabIndex]),
    [["question", "Question", "true", 0], ["bug", "Report a bug", "false", -1], ["city", "Request a city", "false", -1]]);
  assert.equal($("#fb-city-row").hidden, true, "city and country only for a city request");
  assert.equal($("#fb-msg").tagName, "TEXTAREA");
  assert.equal($("#fb-left").textContent, "1000");
  assert.equal($("#fb-email").getAttribute("type"), "email");
  // the honeypot: out of the tab order and hidden from screen readers
  const hp = $("#fb-hp");
  assert.equal(hp.getAttribute("name"), "website");
  assert.equal(hp.tabIndex, -1);
  assert.equal(hp.getAttribute("aria-hidden"), "true");
  assert.ok(!doc.tabStops().includes(hp));
  assert.equal($("#fb-send").textContent, "Send");
  assert.match($("#fb-meta").textContent, /Sent with the page you're on \(\/cities\?city=5128581\) and your browser type, not signed in\./);
});

test("open and close: a tap opens the panel and puts the keyboard on the chosen kind; Escape, the close button or the round button close it and give the keyboard back", async () => {
  const { $, doc, press, window: win } = await widget();
  const btn = $("#fb-open"), panel = $("#fb-panel");
  btn.click();
  assert.equal(panel.hidden, false);
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.equal(btn.getAttribute("aria-label"), "Close feedback");
  assert.equal(doc.activeElement.dataset.kind, "question", "the keyboard is on the first kind");
  press("Escape");
  assert.equal(panel.hidden, true);
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(btn.getAttribute("aria-label"), "Feedback and support");
  assert.equal(doc.activeElement, btn, "the keyboard is back on the button");
  btn.click();
  $("#fb-close").click();
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, btn);
  btn.click(); btn.click();
  assert.equal(panel.hidden, true, "the round button toggles");
  // a tap anywhere else closes it without stealing the keyboard
  btn.click();
  dispatch(doc.body, newEvent("pointerdown"), win);
  assert.equal(panel.hidden, true);
  assert.notEqual(doc.activeElement, btn);
});

test("kinds: a tap or the arrow keys pick one; a city request shows city and country and makes the message optional", async () => {
  const { $, doc, press } = await widget();
  $("#fb-open").click();
  const tabs = $("#fb-kinds").querySelectorAll("[role=tab]");
  press("ArrowRight");
  assert.equal(doc.activeElement, tabs[1]);
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(tabs[0].getAttribute("aria-selected"), "false");
  assert.equal(tabs[0].tabIndex, -1); assert.equal(tabs[1].tabIndex, 0);
  assert.match($("#fb-lead").textContent, /what you did, what you expected/);
  press("ArrowLeft"); press("ArrowLeft");
  assert.equal(doc.activeElement, tabs[2], "the arrows wrap round");
  assert.equal($("#fb-city-row").hidden, false);
  assert.equal($("#fb-msg").required, false);
  assert.match($("#fb-msg").placeholder, /optional/);
  press("Home");
  assert.equal(doc.activeElement, tabs[0]);
  assert.equal($("#fb-city-row").hidden, true);
  assert.equal($("#fb-msg").required, true);
  tabs[2].click();
  assert.equal(tabs[2].getAttribute("aria-selected"), "true");
  assert.equal(doc.activeElement, tabs[2]);
});

test("sending a question: one POST to /api/feedback with the kind, the message, the page and an empty honeypot; then the thank-you, and 'Send another' starts afresh", async () => {
  const { $, doc, calls, window: win } = await widget();
  $("#fb-open").click();
  const msg = $("#fb-msg");
  msg.value = "Where do I see who founded my city?  ";
  dispatch(msg, newEvent("input"), win);
  assert.equal($("#fb-left").textContent, String(1000 - msg.value.length));
  submit($("#fb-form"), win);
  await tick();
  const sent = calls.filter((c) => c.path === "/api/feedback");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "POST");
  assert.deepEqual(sent[0].body, { kind: "question", message: "Where do I see who founded my city?", page: "/cities?city=5128581", website: "" });
  assert.equal($("#fb-form").hidden, true);
  assert.equal($("#fb-kinds").hidden, true);
  assert.equal($("#fb-done").hidden, false);
  assert.equal($("#fb-done").querySelector(".fb__done-title").textContent, "Thanks, we read every message.");
  assert.match($("#fb-done-note").textContent, /Leave an e-mail next time/);
  assert.equal(doc.activeElement, $("#fb-done").querySelector(".fb__done-title"), "the thank-you is read out");
  assert.equal($("#fb-err").hidden, true);
  $("#fb-again").click();
  assert.equal($("#fb-form").hidden, false);
  assert.equal($("#fb-done").hidden, true);
  assert.equal(msg.value, "");
  assert.equal($("#fb-left").textContent, "1000");
  assert.equal(doc.activeElement.dataset.kind, "question");
});

test("sending with an e-mail and a city request: the optional fields travel only when given", async () => {
  const { $, calls, window: win } = await widget();
  $("#fb-open").click();
  $("#fb-kinds").querySelectorAll("[role=tab]")[2].click();
  $("#fb-city").value = " Little Falls ";
  $("#fb-country").value = "United States";
  $("#fb-email").value = " jo@example.com ";
  submit($("#fb-form"), win);
  await tick();
  const [sent] = calls.filter((c) => c.path === "/api/feedback");
  assert.deepEqual(sent.body, { kind: "city", message: "", page: "/cities?city=5128581", website: "", email: "jo@example.com", city: "Little Falls", country: "United States" });
  assert.match($("#fb-done-note").textContent, /We'll look at Little Falls and get back to you at jo@example\.com/);
});

test("what is checked before anything is sent: a message of a few words, a city with its country, a plausible e-mail; the error is spoken and the keyboard goes to the field", async () => {
  const { $, doc, calls, window: win } = await widget();
  $("#fb-open").click();
  const form = $("#fb-form"), err = $("#fb-err");
  assert.equal(err.getAttribute("role"), "alert");
  $("#fb-msg").value = "hi";
  submit(form, win); await tick();
  assert.equal(err.hidden, false); assert.equal(err.textContent, "Please write at least a few words.");
  assert.equal(doc.activeElement, $("#fb-msg"));
  $("#fb-msg").value = "The holder table never loads for me";
  $("#fb-email").value = "not an address";
  submit(form, win); await tick();
  assert.equal(err.textContent, "That e-mail address doesn't look right.");
  assert.equal(doc.activeElement, $("#fb-email"));
  $("#fb-email").value = "";
  $("#fb-kinds").querySelectorAll("[role=tab]")[2].click();
  submit(form, win); await tick();
  assert.equal(err.textContent, "Please give the city and its country.");
  assert.equal(doc.activeElement, $("#fb-city"));
  assert.equal(calls.filter((c) => c.path === "/api/feedback").length, 0, "nothing was sent");
});

test("the server's answers: too many messages, a bad e-mail, an outage, offline; the form stays so nothing typed is lost", async () => {
  for (const [answer, text] of [
    [{ ok: false, error: "slow_down", _status: 429 }, "That's plenty for now. Please try again in an hour."],
    [{ ok: false, error: "bad_email", _status: 400 }, "That e-mail address doesn't look right."],
    [{ ok: false, error: "unavailable", _status: 503 }, "Couldn't send right now. Please try again in a minute."],
    [{ ok: false, error: "wrong_origin", _status: 403 }, "Couldn't send. Please reload the page and try again."],
  ]) {
    const { $, window: win } = await widget("token.html", { answer: () => answer });
    $("#fb-open").click();
    $("#fb-msg").value = "Something I typed with care";
    submit($("#fb-form"), win); await tick();
    assert.equal($("#fb-err").textContent, text, answer.error);
    assert.equal($("#fb-form").hidden, false, answer.error);
    assert.equal($("#fb-done").hidden, true, answer.error);
    assert.equal($("#fb-msg").value, "Something I typed with care", answer.error);
    assert.equal($("#fb-send").textContent, "Send", "the button is itself again");
    assert.equal($("#fb-send").disabled, false);
  }
  // the network is down: site.js's api() answers offline
  const { $, window: win } = await widget();
  win.fetch = async () => { throw new TypeError("Failed to fetch"); };
  $("#fb-open").click();
  $("#fb-msg").value = "Something I typed with care";
  submit($("#fb-form"), win); await tick();
  assert.equal($("#fb-err").textContent, "You seem to be offline. Check the connection and try again.");
});

test("the Terms gate: while it is open the whole widget is inert (no Tab stop, nothing to tap); a visitor who agreed before gets it live", async () => {
  const first = await widget("index.html", { agreed: null });
  assert.equal(first.$("#termsgate").hidden, false, "the gate is open for a first visit");
  assert.equal(first.$("#fb").inert, true);
  assert.ok(!first.doc.tabStops().includes(first.$("#fb-open")));
  const back = await widget("index.html", { agreed: "2026-10-01" });
  assert.equal(back.$("#fb").inert, false);
  assert.ok(back.doc.tabStops().includes(back.$("#fb-open")));
});

test("security policy and hygiene: no inline style or script, the only innerHTML is the two fixed icons, nothing leaves the page, the stylesheet keeps clear of the phone bars", () => {
  const inner = [...FEEDBACK_JS.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(inner, ["ICON_CHAT + ICON_X"], "static icons only, never data");
  assert.doesNotMatch(FEEDBACK_JS, /\.style\.|setAttribute\("style"|eval\(|new Function|document\.write/);
  assert.doesNotMatch(FEEDBACK_JS, /https?:\/\//, "no outside address");
  assert.doesNotMatch(FEEDBACK_JS, /window\.open|location\.(assign|href\s*=)/, "nothing opens or leaves the page: it must work inside wallet apps' browsers");
  assert.match(FEEDBACK_JS, /api\("\/api\/feedback", body\)/, "one call, through site.js's api()");
  assert.match(FEEDBACK_CSS, /\.fb \{ position: fixed; right: max\(16px, env\(safe-area-inset-right\)\); bottom: max\(20px, env\(safe-area-inset-bottom\)\); z-index: 70;/);
  assert.match(FEEDBACK_CSS, /@media \(max-width: 900px\) \{ \.fb \{ bottom: calc\(82px \+ env\(safe-area-inset-bottom\)\); \} \}/, "above the phone menu bar");
  assert.match(FEEDBACK_CSS, /body\.has-coin-buybar \.fb \{ bottom: calc\(150px \+ env\(safe-area-inset-bottom\)\); \}/, "above the coin page's Buy bar");
  assert.match(FEEDBACK_CSS, /\.fb__btn \{[^}]*width: 52px; height: 52px;/, "a 44+ px target");
  assert.match(FEEDBACK_CSS, /\.fb__hp \{ position: absolute; left: -9999px;/, "the honeypot is off screen, not display: none (some bots skip those)");
  assert.match(FEEDBACK_CSS, /@media \(prefers-reduced-motion: no-preference\)/, "motion only for those who want it");
  assert.doesNotMatch(FEEDBACK_CSS, /#[0-9a-fA-F]{6}\b/, "colours come from the site's variables (both themes), no fixed hex colour");
});
