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

/** A username nobody has yet (checks the users table the way its unique index does: ignoring case; retries, then falls back). */
export async function autoUsername(db) {
  for (let i = 0; i < 12; i++) {
    const name = `${pick(NAME_ADJ)}${pick(NAME_NOUN)}${10 + Math.floor(Math.random() * 90)}`;
    const taken = await db.prepare("SELECT id FROM users WHERE lower(handle) = lower(?)").bind(name).first();
    if (!taken) return name;
  }
  return `Citizen${Date.now().toString(36)}`;
}

// Invisible characters (shared by src/lpadmin.js nameProblem and src/screen.js): every Unicode default-ignorable code point and the other format characters, then blank characters:
// spaces other than U+0020, line and paragraph separators, the braille blank and the musical null notehead. Security review FA-1:
// "Paris" followed by a Hangul filler looked exactly like "Paris" and would have been written into the coin's permanent name.
export const FORMAT_CHARS = [[0xad, 0xad], [0x34f, 0x34f], [0x600, 0x605], [0x61c, 0x61c], [0x6dd, 0x6dd], [0x70f, 0x70f], [0x890, 0x891], [0x8e2, 0x8e2],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a], [0xe0000, 0xe0fff]];
export const BLANK_CHARS = [[0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x2800, 0x2800],
  [0x3000, 0x3000], [0x1d159, 0x1d159]];
