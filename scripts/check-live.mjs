// After a deploy: does the live site send the security headers on pages and files, not only on /api/*?
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
const paths = ["/", "/connect", "/dashboard", "/rules", "/terms", "/admin", "/style.css", "/connect.js", "/api/me", "/no-such-page"];
let bad = 0;
for (const p of paths) {
  const res = await fetch(base + p, { redirect: "manual" });
  const missing = Object.entries(need).filter(([h, re]) => !re.test(res.headers.get(h) || "")).map(([h]) => h);
  console.log(`${missing.length ? "MISSING" : "ok     "} ${res.status} ${p}${missing.length ? "  " + missing.join(", ") : ""}`);
  if (missing.length) bad++;
}
console.log(bad ? `${bad} of ${paths.length} addresses are missing security headers` : "every checked address sends the security headers");
process.exit(bad ? 1 : 0);
