// src/text.js: recovered from the code deployed on Cloudflare (Worker "vicinity-map", 2026-10-02).
// The original comments and formatting were lost in the bundle; the code is the deployed code, byte for byte after bundling.
function cleanText(s, max) {
  const t = String(s || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? null : t;
}
var HAS_ADDRESS = /(^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}($|[^1-9A-HJ-NP-Za-km-z])/;
var NAME_ADJ = ["Swift", "Bright", "Bold", "Calm", "Keen", "Vivid", "Noble", "Brave", "Clever", "Gentle", "Daring", "Eager", "Fair", "Grand", "Happy", "Ivory", "Jolly", "Kind", "Lively", "Merry", "Nimble", "Oaken", "Proud", "Quick", "Radiant", "Sturdy"];
var NAME_NOUN = ["Harbor", "Beacon", "Comet", "River", "Summit", "Meadow", "Ember", "Tide", "Falcon", "Willow", "Canyon", "Drift", "Flint", "Grove", "Haven", "Inlet", "Juniper", "Kite", "Lark", "Maple", "North", "Opal", "Pine", "Quill", "Ridge", "Sable"];
var pick = (a) => a[Math.floor(Math.random() * a.length)];
async function autoUsername(db) {
  for (let i = 0; i < 12; i++) {
    const name = `${pick(NAME_ADJ)}${pick(NAME_NOUN)}${10 + Math.floor(Math.random() * 90)}`;
    const taken = await db.prepare("SELECT id FROM users WHERE handle = ?").bind(name).first();
    if (!taken) return name;
  }
  return `Citizen${Date.now().toString(36)}`;
}
export { HAS_ADDRESS, autoUsername, cleanText };
