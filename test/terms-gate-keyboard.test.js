// The first-visit terms dialog (#termsgate, opened by public/site.js) with a keyboard or a screen reader: it opens with
// the keyboard on its heading, Tab and Shift+Tab stay inside it, Escape does nothing, the page behind it is inert, and
// closing it gives the keyboard a sensible place. These run the real site.js on the real built pages in a just-enough
// DOM (test/helpers/pagedom.js). How it looks, and that nothing changes for a mouse, was checked in real Chromium at
// 390px and 1280px, in light and dark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openPage } from "./helpers/pagedom.js";

const GATED = ["index.html", "token.html", "cities.html", "launchpad.html", "connect.html", "locate.html", "dashboard.html", "rules.html", "404.html", "admin.html"];
const LINK = 'a[href="/terms"]', AGREE = "#termsgate-agree", DECLINE = "#termsgate-decline", HEADING = "#termsgate-title";

/** Where the keyboard is, as a selector-like name. */
const where = (p) => {
  const a = p.doc.activeElement;
  if (a === p.doc.body) return "body";
  if (a.id) return "#" + a.id;
  return a.tagName.toLowerCase() + (a.hasAttribute("href") ? `[href="${a.getAttribute("href")}"]` : "");
};
const inDialog = (p) => p.$(".termsgate__card").contains(p.doc.activeElement);
const keys = (p, key, n, shift = false) => Array.from({ length: n }, () => { p.press(key, { shift }); return { at: where(p), inside: inDialog(p) }; });
const liveParts = (p) => p.doc.body.children.filter((e) => e.tagName !== "SCRIPT" && !e.inert).map((e) => e.id).sort();

test("first visit: the keyboard starts on the dialog's heading and everything behind it is inert, on every page with the gate", async () => {
  for (const f of GATED) {
    const p = await openPage(f);
    assert.equal(p.$("#termsgate").hidden, false, `${f}: the gate opens`);
    assert.equal(where(p), HEADING, `${f}: the keyboard starts on the heading, not on the page behind`);
    assert.equal(p.$(HEADING).getAttribute("tabindex"), "-1", `${f}: the heading takes focus without becoming a Tab stop`);
    assert.deepEqual(liveParts(p), ["termsgate", "toast"], `${f}: only the dialog and the toast's live region stay outside the inert part`);
    assert.deepEqual(p.doc.tabStops().map((e) => (e.id ? "#" + e.id : LINK)), [LINK, AGREE, DECLINE], `${f}: the dialog's three controls are the page's only Tab stops`);
  }
});

test("Tab and Shift+Tab go round the dialog's controls and never reach the page behind", async () => {
  const p = await openPage("connect.html");
  const forward = keys(p, "Tab", 15);
  assert.ok(forward.every((k) => k.inside), `15 Tabs: ${forward.map((k) => k.at).join(" > ")}`);
  assert.deepEqual(forward.slice(0, 4).map((k) => k.at), [LINK, AGREE, DECLINE, LINK], "terms link, I agree, Decline, then round again");
  const back = keys(p, "Tab", 15, true);
  assert.ok(back.every((k) => k.inside), `15 Shift+Tabs: ${back.map((k) => k.at).join(" < ")}`);
  assert.deepEqual(back.slice(0, 3).map((k) => k.at), [AGREE, LINK, DECLINE], "from Decline back to I agree, the link, then round to Decline");

  const fresh = await openPage("connect.html");
  fresh.press("Tab", { shift: true });
  assert.equal(where(fresh), DECLINE, "Shift+Tab from the heading goes to the last control, not out of the dialog");
  fresh.$(".site-header a").focus(); // something behind the dialog can't take the keyboard while it is open
  assert.equal(where(fresh), DECLINE);
});

test("Escape does nothing harmful: the dialog stays open, the keyboard stays put, the page behind never hears it", async () => {
  const p = await openPage("connect.html");
  let heard = 0;
  p.window.addEventListener("keydown", (e) => { if (e.key === "Escape") heard++; });
  p.doc.addEventListener("keydown", (e) => { if (e.key === "Escape") heard++; });
  p.press("Tab");
  p.press("Escape");
  assert.equal(p.$("#termsgate").hidden, false, "agreeing is the only way in");
  assert.equal(where(p), LINK);
  assert.equal(heard, 0);
  assert.equal(p.storage.get("vicinity_terms"), undefined, "nothing was agreed to");
});

test("agreeing with the keyboard: the page comes back to life and the keyboard lands at the start of its content", async () => {
  const p = await openPage("connect.html");
  keys(p, "Tab", 2);
  assert.equal(where(p), AGREE);
  p.press("Enter");
  assert.equal(p.$("#termsgate").hidden, true, "the gate closes");
  assert.equal(p.storage.get("vicinity_terms"), "2026-10-01", "the agreement is remembered");
  assert.deepEqual(p.doc.body.children.filter((e) => e.inert), [], "nothing is inert any more");
  assert.equal(where(p), "#main", "the keyboard lands where 'Skip to content' goes, not on <body> or the browser's toolbar");
  assert.equal(p.$("#main").getAttribute("tabindex"), "-1", "main takes the keyboard without becoming a Tab stop");

  p.press("Tab");
  assert.ok(p.$("#main").contains(p.doc.activeElement), `the next Tab goes into the page's content (got ${where(p)})`);
  assert.equal(p.$("#main").hasAttribute("tabindex"), false, "main gives its temporary tabindex back once the keyboard moves on");
  keys(p, "Tab", 2, true);
  assert.ok(p.$(".site-header").contains(p.doc.activeElement), `Shift+Tab reaches the header again (got ${where(p)})`);
  assert.equal(p.press("Escape").defaultPrevented, false, "Escape is the page's own again");
});

test("if something already had the keyboard when the gate opened, agreeing gives it back", async () => {
  const p = await openPage("index.html", { focus: ".account-btn" });
  assert.equal(where(p), HEADING);
  p.$(AGREE).click();
  assert.ok(p.doc.activeElement.classList.contains("account-btn"), `focus went back to the header button (got ${where(p)})`);
  assert.equal(p.$("#main").hasAttribute("tabindex"), false);
});

test("declining: the keyboard moves to the new message's heading, the dialog keeps its name, and Tab stays inside", async () => {
  const p = await openPage("connect.html");
  keys(p, "Tab", 3);
  assert.equal(where(p), DECLINE);
  p.press("Enter");
  const heading = p.$(".termsgate__done h2");
  assert.equal(heading.textContent, "You’ll need to agree to enter");
  assert.equal(p.doc.activeElement, heading, "the pressed button is gone, so the keyboard goes to the new heading (not <body>)");
  const dialog = p.$('[role="dialog"]');
  assert.equal(p.doc.getElementById(dialog.getAttribute("aria-labelledby")), heading, "aria-labelledby still names the dialog");
  const round = [...keys(p, "Tab", 3), ...keys(p, "Tab", 3, true)];
  assert.ok(round.every((k) => k.inside && k.at === LINK), `the one link left is the only stop: ${round.map((k) => k.at).join(" ")}`);
  p.press("Escape");
  assert.equal(p.$("#termsgate").hidden, false);
  assert.deepEqual(liveParts(p), ["termsgate", "toast"], "the page behind stays inert");
});

test("returning visitors and the terms page itself: no gate, nothing inert, the keyboard untouched", async () => {
  for (const [f, agreed] of [["connect.html", "2026-10-01"], ["dashboard.html", "2026-10-01"], ["terms.html", null]]) {
    const p = await openPage(f, { agreed });
    assert.ok(!p.$("#termsgate") || p.$("#termsgate").hidden, `${f}: no gate`);
    assert.deepEqual(p.doc.body.children.filter((e) => e.inert), [], `${f}: nothing inert`);
    assert.equal(where(p), "body", `${f}: focus untouched`);
    p.press("Tab");
    assert.ok(p.doc.activeElement.classList.contains("skip"), `${f}: the first Tab is still "Skip to content"`);
  }
});
