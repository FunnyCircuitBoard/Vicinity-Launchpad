/** Text people type: control characters and runs of blank lines removed. null if longer than `max`. */
export function cleanText(s, max) {
  const t = String(s || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? null : t;
}

/** Anything that looks like a Solana address (blocked in posts: the only official contract is on the Token page). */
export const HAS_ADDRESS = /(^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}($|[^1-9A-HJ-NP-Za-km-z])/;

/**
 * Auto-generated public usernames, so nobody's wallet address is their identity.
 * AdjectiveNoun + two digits, e.g. SwiftHarbor42. The handle column doubles as the
 * username: OAuth users keep their provider handle, everyone else gets one of these.
 */
const NAME_ADJ = ["Swift", "Bright", "Bold", "Calm", "Keen", "Vivid", "Noble", "Brave", "Clever", "Gentle", "Daring", "Eager", "Fair", "Grand", "Happy", "Ivory", "Jolly", "Kind", "Lively", "Merry", "Nimble", "Oaken", "Proud", "Quick", "Radiant", "Sturdy"];
const NAME_NOUN = ["Harbor", "Beacon", "Comet", "River", "Summit", "Meadow", "Ember", "Tide", "Falcon", "Willow", "Canyon", "Drift", "Flint", "Grove", "Haven", "Inlet", "Juniper", "Kite", "Lark", "Maple", "North", "Opal", "Pine", "Quill", "Ridge", "Sable"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** A username nobody has yet (checks the users table, retries, then falls back). */
export async function autoUsername(db) {
  for (let i = 0; i < 12; i++) {
    const name = `${pick(NAME_ADJ)}${pick(NAME_NOUN)}${10 + Math.floor(Math.random() * 90)}`;
    const taken = await db.prepare("SELECT id FROM users WHERE handle = ?").bind(name).first();
    if (!taken) return name;
  }
  return `Citizen${Date.now().toString(36)}`;
}
