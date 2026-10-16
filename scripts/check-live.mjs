// After a deploy: does the live site send the security headers on pages and files, not only on /api/*? And do the addresses that must
// be answered with a given kind of file get it (the official city-coin list: never the HTML 404 page, which is what the static files
// would answer if run_worker_first lost /official-coins.csv)?
//   node scripts/check-live.mjs [https://vicinity.city]      (npm run check:live)
// Exit code 1 lists what is missing. Nothing is changed on the site (GET requests only).
const base = (process.argv[2] || "https://vicinity.city").replace(/\/$/, "");
const need = {
  "content-security-policy": /default-src 'self'/,
  "x-content-type-options": /nosniff/i,
  "x-frame-options": /deny/i,
  "referrer-policy": /strict-origin/i,
  "permissions-policy": /geolocation=\(self\)/,
  "strict-transport-security": /max-age=/,
};
const paths = ["/", "/connect", "/dashboard", "/rules", "/terms", "/official", "/admin", "/style.css", "/connect.js", "/api/me", "/official-coins.csv", "/no-such-page"];
// [status, content type] pairs an address may answer; anything else is a failure. /official-coins.csv: the list (200 text/csv) or,
// when the chain could not be read, 503 plain text; never HTML.
const kinds = {
  "/official": [[200, /^text\/html/]],
  "/official-coins.csv": [[200, /^text\/csv; charset=utf-8$/], [503, /^text\/plain/]],
};
let bad = 0;
for (const p of paths) {
  const res = await fetch(base + p, { redirect: "manual" });
  const missing = Object.entries(need).filter(([h, re]) => !re.test(res.headers.get(h) || "")).map(([h]) => h);
  const type = res.headers.get("content-type") || "";
  if (kinds[p] && !kinds[p].some(([status, re]) => res.status === status && re.test(type))) missing.push(`answer (${res.status} ${type || "no content type"})`);
  console.log(`${missing.length ? "MISSING" : "ok     "} ${res.status} ${p}${missing.length ? "  " + missing.join(", ") : ""}`);
  if (missing.length) bad++;
}
console.log(bad ? `${bad} of ${paths.length} addresses are missing security headers or the right answer` : "every checked address sends the security headers and the right answer");
process.exit(bad ? 1 : 0);
