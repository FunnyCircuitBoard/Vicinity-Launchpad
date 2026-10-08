// iCloud Private Relay changes its exit network on its own: the owner's iPhone did the location step through Fastly (AS54113) and could
// finish through Cloudflare (AS13335) or Akamai a few minutes later, without moving. The finish used to compare "country|asn" exactly,
// so it answered location_unverified and sent the person back to "Where are you?". Now, when BOTH the network of the location step and
// the one that finishes are relays (src/network.js isRelayNetwork) in the same country, they count as the same network. Nothing else
// is relaxed: a relay against an ordinary network, another country, a hosting network or a far-away connection still fails, and the
// rest of the checks (src/network.js networkCheck) run as before.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { V2, browser, realClock, useClock } from "./helpers/world.js";
import { doLocation, finish, journey, one, outbox, stateOf } from "./helpers/signup.js";
import { sameLocationNetwork } from "../src/signup.js";

let env, box;
beforeEach(() => { useClock("2026-10-08T21:00:00Z"); env = V2(); box = outbox(); });
after(() => realClock());

// Where Cloudflare puts each connection: all of them near Utica, in the US, unless a test says otherwise.
const near = { country: "US", latitude: 43.1, longitude: -75.2 };
const FASTLY = { ...near, asn: 54113, asOrganization: "Fastly, Inc." };            // iCloud Private Relay (the owner's live loc_net: US|54113)
const CLOUDFLARE = { ...near, asn: 13335, asOrganization: "Cloudflare, Inc." };   // iCloud Private Relay / WARP
const AKAMAI = { ...near, asn: 36183, asOrganization: "Akamai Technologies, Inc." }; // iCloud Private Relay
const COMCAST = { ...near, asn: 7922, asOrganization: "Comcast Cable" };

/** A person at the wallet step, then the wallet proven, all from `cf`. Returns the browser (its next request may come from elsewhere). */
async function atFinish(cf, n) {
  const b = browser(env, { ip: `203.0.113.${n}`, cf });
  const j = await journey(b, box, { via: "email", email: `relay${n}@example.com`, until: "wallet" });
  assert.equal(j.wallet.ok, true, JSON.stringify(j.wallet));
  assert.equal((await stateOf(b)).next, "finish");
  return b;
}
const finishFrom = async (b, cf) => { const r = await b.send("/api/signup/finish", { method: "POST", body: {}, cf }); return { status: r.status, body: await r.json() }; };

test("the owner's case: location through Fastly (US|54113), finish through Cloudflare or Akamai (the relay moved): the account is made", async () => {
  let n = 10;
  for (const later of [CLOUDFLARE, AKAMAI, { ...near, asn: 209242, asOrganization: "Cloudflare London, LLC" }]) {
    const b = await atFinish(FASTLY, ++n);
    assert.equal((await one(env.DB, "SELECT loc_net FROM signups WHERE loc_net IS NOT NULL ORDER BY loc_at DESC LIMIT 1")).loc_net, "US|54113");
    const r = await finishFrom(b, later);
    assert.equal(r.status, 200, `${later.asn}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, { ok: true, next: "/dashboard?welcome=1", isNew: true });
  }
  // and the other way round (Cloudflare first, then Fastly)
  const b = await atFinish(CLOUDFLARE, 20);
  assert.equal((await finishFrom(b, FASTLY)).status, 200);
});

test("nothing else is relaxed: relay vs ordinary network, another country, a hosting network or a far-away relay still clears ONLY the location", async () => {
  const cases = {
    "relay at the location step, home internet at the finish": [FASTLY, COMCAST],
    "home internet at the location step, a relay at the finish": [COMCAST, CLOUDFLARE],
    "a relay in another country at the finish": [FASTLY, { ...CLOUDFLARE, country: "CA" }],
    "a hosting network that is named like a relay (Akamai Connected Cloud = Linode)": [FASTLY, { ...near, asn: 63949, asOrganization: "Akamai Connected Cloud" }],
    "a relay 500+ km from the community": [FASTLY, { ...CLOUDFLARE, latitude: 34.05, longitude: -118.24 }],
    // the location step keeps only "country|asn": a relay known only by its name there (an Akamai network not in RELAY_ASNS) is not
    // known to be a relay at the finish, so it still has to match exactly
    "a relay recognised only by its name at the location step": [{ ...near, asn: 20940, asOrganization: "Akamai International B.V." }, CLOUDFLARE],
  };
  let n = 30;
  for (const [name, [first, later]] of Object.entries(cases)) {
    const b = await atFinish(first, ++n);
    const r = await finishFrom(b, later);
    assert.equal(r.status, 403, name);
    assert.deepEqual(r.body, { ok: false, error: "location_unverified" }, name);
    const s = await stateOf(b);
    assert.equal(s.location.done, false, `${name}: the location is forgotten`);
    assert.equal(s.account.done, true, `${name}: the account stays`);
    assert.equal(s.wallet.done, true, `${name}: the wallet stays`);
    // redone from the connection it finishes from, it goes through
    assert.equal((await b.send("/api/signup/location", { method: "POST", body: { location: { lat: 43.1009, lon: -75.2327, accuracy: 30 }, country: "US" }, cf: later })).status,
      name.includes("hosting") || name.includes("country") || name.includes("500+") ? 403 : 200, name);
  }
});

test("the same network as before still finishes, relay or not (unchanged)", async () => {
  let n = 50;
  for (const cf of [FASTLY, COMCAST]) {
    const b = await atFinish(cf, ++n);
    assert.equal((await finish(b)).ok, true, cf.asOrganization);
  }
  // a location redone on the new network works as before
  const b = await atFinish(COMCAST, ++n);
  assert.equal((await finishFrom(b, { ...COMCAST, asn: 701 })).status, 403);
  assert.equal((await doLocation(b)).ok, true);
  assert.equal((await finish(b)).ok, true);
});

test("sameLocationNetwork: the rule on its own", () => {
  assert.equal(sameLocationNetwork("US|54113", FASTLY), true, "the very same network");
  assert.equal(sameLocationNetwork("US|54113", CLOUDFLARE), true, "relay to relay, same country");
  assert.equal(sameLocationNetwork("US|13335", AKAMAI), true);
  assert.equal(sameLocationNetwork("US|54113", COMCAST), false, "relay to an ordinary network");
  assert.equal(sameLocationNetwork("US|7922", CLOUDFLARE), false, "an ordinary network to a relay");
  assert.equal(sameLocationNetwork("US|7922", { ...COMCAST, asn: 701 }), false, "two ordinary networks");
  assert.equal(sameLocationNetwork("US|54113", { ...CLOUDFLARE, country: "CA" }), false, "another country");
  assert.equal(sameLocationNetwork("US|20940", CLOUDFLARE), false, "the stored network is not a known relay ASN");
  assert.equal(sameLocationNetwork("US|", CLOUDFLARE), false, "no ASN stored");
  assert.equal(sameLocationNetwork("|54113", { ...CLOUDFLARE, country: "" }), false, "no country: never the relay rule");
  assert.equal(sameLocationNetwork(null, COMCAST), true, "nothing stored (no Cloudflare at the location step): nothing to compare");
});
