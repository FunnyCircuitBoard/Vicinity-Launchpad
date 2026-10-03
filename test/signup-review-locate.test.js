// Found by the independent review of sign-up v2 (fails without the fix): when the sign-up's location check is finished on a phone for a
// computer, a different network gave advice written for a wallet app ("use mobile internet on the same phone as your wallet app").
// The other purposes of /locate keep today's wording exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");


/** public/locate.js against a fake page. `purpose` is what the link is for, `answer` what the check at the server says. */
async function locatePage({ purpose, answer }) {
  const els = new Map(), handlers = {};
  const make = (sel) => ({ sel, textContent: "", hidden: false, parentElement: { replaceChildren() {} }, replaceChildren() {}, addEventListener(t, f) { handlers[`${sel}:${t}`] = f; } });
  const $ = (sel) => { if (!els.has(sel)) els.set(sel, make(sel)); return els.get(sel); };
  const bullets = ["Used once to find your community. It's never saved.", "Use your normal mobile or home internet, with no VPN, on the same phone as your wallet app.", "This link works for 10 minutes and only for the account that asked."].map((t) => ({ textContent: t }));
  const V = {
    $, $$: (sel) => (sel === ".safety li" ? bullets : []), getLocation: async () => ({ lat: 43.1, lon: -75.23 }),
    api: async (path) => (path === "/api/locate/handoff/info" ? { ok: true, purpose, done: false } : answer),
  };
  vm.runInContext(read("locate.js"), vm.createContext({ window: { V }, location: { search: "?code=abcdefghijklmnop" }, URLSearchParams }));
  await new Promise((r) => setImmediate(r));
  const go = $("#l-go");
  await handlers["#l-go:click"]({ currentTarget: go });
  return { error: $("#l-error").textContent, bullets: bullets.map((b) => b.textContent) };
}

test("/locate for a sign-up started on a computer: a different network gets advice that fits (same Wi-Fi as the computer), not 'same phone as your wallet app'", async () => {
  const r = await locatePage({ purpose: "signup", answer: { ok: false, error: "location_unverified" } });
  assert.match(r.error, /same network as the device where you started/);
  assert.match(r.error, /computer's Wi-Fi/);
  assert.doesNotMatch(r.error, /same phone as your wallet app/);
  assert.doesNotMatch(r.bullets[1], /same phone as your wallet app/, "the page's own bullet says the same");
  assert.match(r.bullets[1], /same network as the device where you started/);
  assert.equal(r.bullets[0], "Used once to find your community. It's never saved.", "the other bullets stay");
});

test("/locate for every other purpose keeps today's wording exactly (the old flow is untouched)", async () => {
  const r = await locatePage({ purpose: "home", answer: { ok: false, error: "location_unverified" } });
  assert.equal(r.error, "We couldn't confirm your location. Turn on precise location, use your normal mobile or home internet (no VPN) on the same phone as your wallet app, and try again.");
  assert.match(r.bullets[1], /same phone as your wallet app/);
});

test("/locate for a sign-up: other errors read as before", async () => {
  const r = await locatePage({ purpose: "signup", answer: { ok: false, error: "slow_down" } });
  assert.equal(r.error, "That's a lot of attempts. Take a break and try again later.");
});

