/** Text people type: control characters and runs of blank lines removed. null if longer than `max`. */
export function cleanText(s, max) {
  const t = String(s || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? null : t;
}

/** Anything that looks like a Solana address (blocked in posts: the only official contract is on the Token page). */
export const HAS_ADDRESS = /(^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}($|[^1-9A-HJ-NP-Za-km-z])/;
