/**
 * Small text helpers shared by the posting, profile and account code: cleaning what people type, spotting
 * pasted Solana addresses, and inventing a friendly default username for a brand-new account.
 */

/** Text people type: control characters and runs of blank lines removed. null if longer than `max`. */
export function cleanText(s, max) {
  const t = String(s || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? null : t;
}

/** Anything that looks like a Solana address (blocked in posts: the only official contract is on the Token page). */
export const HAS_ADDRESS = /(^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}($|[^1-9A-HJ-NP-Za-km-z])/;

/** Word lists for default usernames: one adjective plus one noun plus two digits, e.g. "SwiftHarbor42". */
const NAME_ADJ = ["Swift", "Bright", "Bold", "Calm", "Keen", "Vivid", "Noble", "Brave", "Clever", "Gentle", "Daring", "Eager", "Fair", "Grand", "Happy", "Ivory", "Jolly", "Kind", "Lively", "Merry", "Nimble", "Oaken", "Proud", "Quick", "Radiant", "Sturdy"];
const NAME_NOUN = ["Harbor", "Beacon", "Comet", "River", "Summit", "Meadow", "Ember", "Tide", "Falcon", "Willow", "Canyon", "Drift", "Flint", "Grove", "Haven", "Inlet", "Juniper", "Kite", "Lark", "Maple", "North", "Opal", "Pine", "Quill", "Ridge", "Sable"];

/** A random element of a list. */
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/**
 * Make a default username for a new account that arrives without a handle of its own (a sign-in that gives
 * none, or the admin's own user row the first time it is created). Tries a random "AdjectiveNoun##" up to 12
 * times and returns the first one no user has as a handle; if all 12 are taken it falls back to "Citizen"
 * plus the current time in base 36. The check is an exact, case-sensitive match, and the fallback name is
 * not checked against the database at all.
 */
export async function autoUsername(db) {
  for (let i = 0; i < 12; i++) {
    const name = `${pick(NAME_ADJ)}${pick(NAME_NOUN)}${10 + Math.floor(Math.random() * 90)}`;
    const taken = await db.prepare("SELECT id FROM users WHERE handle = ?").bind(name).first();
    if (!taken) return name;
  }
  return `Citizen${Date.now().toString(36)}`;
}
