// Honest claims (fact-check of the live site, 17 Oct 2026). The site said things that were not true:
//   - "$VICINITY holders get in first" / "buy new city coins before the public": no early-buy gating exists (src/lptrade.js,
//     src/lplaunch.js and src/swap.js open a city coin's curve to everyone at launch) and no snapshot is scheduled;
//   - "the pool's liquidity is locked" / "Liquidity can't be pulled" as present fact: $VICINITY is still on its Raydium LaunchLab
//     bonding curve, and LaunchLab burns or locks the pool's liquidity only when the curve fills (the site does not check it on chain);
//   - "rules version 5" in the dashboard's Roles box (the rules are version 6) and Founding Supporters' "early access to city coins"
//     (not built; the snapshot rules are published, no date is set and no benefit is promised);
//   - city coins "paired with on Raydium LaunchLab (SOL, USDC or RAY)": they launch on Meteora's bonding curve, and only SOL pairs launch.
// What is pinned here: none of those words come back on the home page or the dashboard, and the copy that replaced them stays true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POLICY } from "../src/policy.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** The words people read: a no-break space is a space, and a phrase split by markup still reads as one. */
const readable = (s) => [s.replace(/&nbsp;| /g, " "), s.replace(/<[^>]+>/g, "").replace(/&nbsp;| /g, " ")];

const HOME = ["scripts/pages/src/index.html", "public/index.html", "public/home.js"];
const DASHBOARD = ["scripts/pages/src/dashboard.html", "public/dashboard.html", "public/dashboard.js", "public/dashboard-v2.js", "public/dashboard-roles.js"];
const UNTRUE = [
  [/\bgets?\s+(?:\w+\s+)?in\s+first\b/i, "\"get in first\" (no early-buy gating exists)"],
  [/\bbefore\s+the\s+public\b/i, "\"before the public\" (city-coin curves are open to everyone at launch)"],
  [/\bearly[\s-]+access\b/i, "\"early access\" (not built, and nothing is promised to Founding Supporters)"],
];

test("honest claims: \"get in first\", \"before the public\" and \"early access\" never come back on the home page or the dashboard", () => {
  for (const f of [...HOME, ...DASHBOARD]) {
    for (const text of readable(read(f))) {
      for (const [re, why] of UNTRUE) assert.doesNotMatch(text, re, `${f}: ${why}`);
    }
  }
});

test("honest claims: the home page says what $VICINITY is for (founding a city), not a head start", () => {
  for (const f of ["scripts/pages/src/index.html", "public/index.html"]) {
    const h = read(f);
    assert.match(h, /<p class="lead hero4__lead">Every real city can get one official coin, run by the people who live there\. Locals hold \$VICINITY to found their&nbsp;city\.<\/p>/, f);
    assert.match(h, /<h3>Hold to&nbsp;found<\/h3>\s*<p>Hold your city's founder amount of \$VICINITY, set by its size, through random balance checks for seven days\.<\/p>\s*<a class="how4__link" href="\/rules#founders">How founding works/, f);
    assert.doesNotMatch(h, /Launchpad snapshot to buy|buy new city coins/i, f);
  }
  assert.match(read("public/index.html"), /<meta name="description" content="[^"]*Locals hold \$VICINITY to found their city\.">/);
});

test("honest claims: liquidity is never said to be locked or burned today while $VICINITY is still on its LaunchLab curve", () => {
  for (const f of ["scripts/pages/src/index.html", "public/index.html", "scripts/pages/src/token.html", "public/token.html"]) {
    const h = read(f);
    assert.doesNotMatch(h, /liquidity can.t be pulled|nobody, including us, can pull it/i, `${f}: nothing the site checks says so`);
    // a sentence may say the liquidity is burned or locked only as what happens when the curve fills
    const sentences = h.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").split(/(?<=[.!?])\s+/);
    for (const s of sentences.filter((x) => /liquidity (is|are|gets) (burned|locked)|liquidity is burned or locked|(burned|locked) liquidity/i.test(x))) {
      assert.match(s, /when (the curve|it) fills/i, `${f}: "${s.trim()}" must say it happens only when the curve fills`);
    }
  }
  for (const f of ["scripts/pages/src/index.html", "public/index.html"]) {
    assert.match(read(f), /<summary>Is this a rug pull\?<\/summary><p>No\. There's no presale, minting and freezing are already switched off for good, and every team wallet is listed: the <a href="\/token">Token page<\/a> shows the proof live from the blockchain\. Until its curve fills, \$VICINITY trades on LaunchLab's bonding curve; when it fills, LaunchLab burns or locks the new pool's liquidity\.<\/p>/, f);
  }
  for (const f of ["scripts/pages/src/token.html", "public/token.html"]) {
    // the card keeps its place in the grid and its "LaunchLab standard" tag: a rule of LaunchLab's, not a reading of the chain
    assert.match(read(f), /<h3>Liquidity locks at graduation<\/h3><p>Until its curve fills, \$VICINITY trades on Raydium LaunchLab's bonding curve\. When it fills, it moves into a Raydium pool and LaunchLab burns or locks that pool's liquidity for good\.<\/p><span class="proof__live">LaunchLab standard<\/span>/, f);
  }
});

test("honest claims: the Roles box and the rules page show the rules' own version, even before the live answer fills it", () => {
  for (const f of ["scripts/pages/src/dashboard.html", "public/dashboard.html"]) {
    assert.ok(read(f).includes(`rules version <span data-policy-version>${POLICY.version}</span>`), `${f}: the Roles box says version ${POLICY.version}`);
  }
  for (const f of ["scripts/pages/src/rules.html", "public/rules.html"]) {
    assert.ok(read(f).includes(`version <span data-rule="version">${POLICY.version}</span> · in effect since <span data-rule="effectiveAt">${POLICY.effectiveAt}</span>`), `${f}: the hero says version ${POLICY.version}`);
  }
  // both are then filled from the same POLICY: /api/me's policyVersion on the dashboard, /api/policy on the rules page
  assert.match(read("src/me.js"), /policyVersion: POLICY\.version/);
  assert.match(read("public/dashboard.js"), /\$\$\("\[data-policy-version\]"\)\.forEach\(\(e\) => \(e\.textContent = d\.policyVersion\)\);/);
  assert.match(read("public/rules.js"), /version: p\.version, effectiveAt: p\.effectiveAt,/);
});

test("honest claims: Founding Supporters are promised nothing, and city coins pair with SOL (no USDC or RAY in the rules' words)", () => {
  for (const f of ["scripts/pages/src/dashboard.html", "public/dashboard.html"]) {
    const h = read(f);
    const roles = h.slice(h.indexOf('<section class="section section--panel" id="roles">'));
    assert.ok(roles.length < h.length, `${f}: the Roles box`);
    assert.match(roles, /<li>Founding Supporters are the holders by 14-day average balance at the snapshot\. Its rules are published; no date is set yet and no benefit is promised\.<\/li>/, f);
    assert.match(roles, /<li>Design the city's coin: name, logo, colour and a short pitch; it launches paired with SOL\. Public, logged, and locked once it launches\.<\/li>/, f);
    assert.doesNotMatch(roles, /USDC|\bRAY\b/, `${f}: the Roles box names no pair a city coin cannot launch with`);
  }
  for (const f of ["scripts/pages/src/rules.html", "public/rules.html"]) {
    const h = read(f);
    assert.match(h, /<li id="coins"><strong>The city's coin:<\/strong> the active founder designs it: its name, a short pitch, a colour and a logo\. It launches on the Vicinity Launchpad, on Meteora's bonding curve, paired with SOL\./, f);
    assert.doesNotMatch(h, /USDC|\bRAY\b|paired with on Raydium LaunchLab/, `${f}: city coins do not launch on Raydium LaunchLab, and only SOL pairs launch`);
  }
});
