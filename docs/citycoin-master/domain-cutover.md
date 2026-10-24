# Domain cutover: vicinity.city to citycoin.dev

Master change order v5, section 04 (BR-02) and section 05 (BR-03). Started in stage S03 (host-safe routing and redirects, local branch
`cc/s03`, not merged); finished in S56. Each later stage adds its part.

**Status on 24 October 2026: nothing here is applied.** No DNS record, Cloudflare setting, route, custom domain or switch was changed.
citycoin.dev is registered on the same Cloudflare nameservers as vicinity.city and is **not attached** to the Worker: the Worker's routes
are `vicinity.city` and `www.vicinity.city` only (wrangler.jsonc `routes`). Nothing in the code assumes it is attached.

## 1. What stage S03 built (dark)

One switch, `HOST_REDIRECT`, read like every other switch (exactly `on`, trimmed, any letter case). The Worker applies it only through
`src/v5policy.js` `hostRedirect`, which counts it only while **every** precondition holds:

| Refusal code (logged once per isolate, never a value) | Holds the switch off while |
|---|---|
| `HOST_REDIRECT_PAGES_BYPASS_WORKER` | the deployed `wrangler.jsonc` does not send every request through the Worker first (its `assets.run_worker_first` is not `true`). The page build records this in `src/pages-built.js` (`pagesReachWorker`), and refuses to build when `wrangler.jsonc` sets `HOST_REDIRECT=on` without it. |
| `HOST_REDIRECT_SITE_REFUSED` | `SITE_ORIGIN` and `SITE_ORIGINS` are unset, or `src/site-config.js` refuses them |
| `HOST_REDIRECT_POLICY_REFUSED` | the v5 configuration check refuses the deployment: `DEPLOYMENT_ENV` unset (`ENVIRONMENT_UNSET`), `SITE_ORIGIN` missing (`MISSING_SITE_ORIGIN`) or not `https://citycoin.dev` (`HOST_REDIRECT_TARGET_NOT_CANONICAL`), or any other named error |

With the switch off (unset, any value but `on`, or refused) the Worker answers exactly as before, for every host, scheme, method and path:
`www.vicinity.city`, `vicinitycity.net` and `www.vicinitycity.net` answer 301 to the same path on `https://vicinity.city`, plain `http://`
answers 301 to `https://` on the same host, both for every method, and every other host is served in place. Because pages bypass the
Worker today, that 301 applies only to `/api/*`, `/coin-meta/*` and `/official-coins.csv`; pages on `www.vicinity.city` are served without
a redirect, as today. (The plan in `implementation-report.md` once allowed S03 to change today's hosts at merge; the order for this stage
requires no change with every new switch unset, so S03 changes nothing live.)

### 1.1 The route contract while the switch counts (`src/hostroute.js`)

The canonical origin is `SITE_ORIGIN` (`https://citycoin.dev`, the only value the v5 check accepts for the switch). "Accepted hosts" are
the hosts of `SITE_ORIGINS` plus the four legacy hosts (`vicinity.city`, `www.vicinity.city`, `vicinitycity.net`, `www.vicinitycity.net`,
`src/site-config.js` `LEGACY_HOSTS`), which stay accepted whatever `SITE_ORIGINS` lists.

| Request | Answer |
|---|---|
| `https://citycoin.dev`, any method, any path | served exactly as today |
| a local host (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`): `wrangler dev` | served exactly as today |
| an unknown host (not accepted; look-alikes such as `vicinity.city.evil.example`, `evilcitycoin.dev`, a trailing dot, an IP; a `workers.dev` or preview address if one were ever turned on) | `421 {"error":"wrong_host"}`, no `Location`, never served, never a redirect target |
| an accepted non-canonical host (or `http://` on any accepted host), any method but GET and HEAD | `421 {"error":"wrong_host"}`, no `Location`: a signed POST, an API write or a webhook delivery is never replayed on another origin |
| same, GET or HEAD of an immutable legacy file: `/coin-meta/*`, `/brand/vicinity-512.png`, `/official-coins.csv` | served in place, the same bytes as on the canonical host (over `http://`: 308 to `https://` on the same host, never to another host) |
| same, GET or HEAD of a wallet challenge, sign-in, pairing or other hand-off, callback or webhook: `/api/message`, `/api/auth/*`, `/api/pair*`, `/api/signup/*`, `/api/me/wallet/*`, `/api/locate*`, any path with a `callback(s)` or `webhook(s)` segment | `421 {"error":"wrong_host"}`, no `Location` |
| same, GET or HEAD of any other `/api/*` route (read-only answers, inventory C10) | served in place (over `http://`: 308 to `https://` on the same host) |
| same, GET or HEAD of anything else (the pages and their files) | `308` to `https://citycoin.dev` + the same path + only the safe query keys |

The 308 carries today's redirect headers (the security headers and `Cache-Control: public, max-age=3600`, so turning the switch off undoes a
cached redirect within the hour), no body and no cookie. The 421 is JSON with the security headers and `Cache-Control: no-store`.

**Safe query keys** (`SAFE_QUERY_KEYS`): `city`, `mint`, `u`, `address`, `tab`, `q`, `tf`, `range`, `unit`, `style`, `mode`, `step`,
`welcome`, `claim`, `swap_in`, `swap_out`, `swap_amt`, `swap_slip`, `swap_open`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
`utm_content`. Each kept pair is copied byte for byte, in order. **Every other key is dropped**, unknown keys included, first of all the
hand-off, sign-in and one-time-code keys of inventory C02 and the sign-in callbacks (`link`, `pair`, `code`, `register`, `carry`, `state`,
`ref`, `next`, `error`, `login`, `google`, `linked`, `token`, `pin`, `on`, `app`, `with`). A fragment never reaches the server.

**No open redirect.** The target is `SITE_ORIGIN` (validated by `src/site-config.js` and the v5 check) with the request's path appended as
text, never resolved against it, and the result is checked to name that origin before it is sent (`//evil.example/x` becomes
`https://citycoin.dev//evil.example/x`). The request's `Host` header never builds a target: for `http://` to an accepted host the target is
that host's own allowlist entry over `https://`.

## 2. The Cloudflare settings the switch needs (not changed in S03)

1. **Every page must reach the Worker.** Today `wrangler.jsonc` has `"run_worker_first": ["/api/*", "/coin-meta/*", "/official-coins.csv"]`
   with `not_found_handling: "404-page"`: every page and file (the 404 page and `/brand/vicinity-512.png` included) is served straight
   from the static assets on every routed host, and the Worker never sees it. The Worker therefore cannot redirect an old host's page, and
   switching `HOST_REDIRECT` on alone would leave a half-moved site (pages still loading on vicinity.city while their writes answered 421).
   The setting needed is `"run_worker_first": true` in the `assets` block of `wrangler.jsonc`, deployed together with `HOST_REDIRECT=on` (or
   before it). It is a deploy setting, not a dashboard one. Consequences to accept in that pull request:
   - every page view becomes a Worker request (wrangler.jsonc's own comment on `run_worker_first` notes the cost);
   - the pages of the canonical host then come through the Worker's asset fallback (`src/index.js`: `env.ASSETS.fetch`, then the security
     headers of `src/http.js`). Verify on the preview environment (S05) before production that the answers keep every header
     `public/_headers` gives today (for example `Cache-Control: public, max-age=31536000, immutable` on `/fonts/*`); whether Cloudflare
     applies `_headers` to an asset the Worker fetches through the binding is not verified here.
   Zone Redirect Rules on the vicinity.city zone could move old-host pages without making them Worker requests, but they keep or drop the
   whole query string (they cannot drop only the hand-off keys), and the Worker would still refuse the switch, so its 421 for writes on the
   old hosts would not apply. They are not the supported path.
2. **Attach citycoin.dev** (stage S06): add `citycoin.dev` and `www.citycoin.dev` as custom domains of the Worker (wrangler.jsonc `routes`)
   and let Cloudflare issue the certificates; add both to `SITE_ORIGINS`. Until then no request for citycoin.dev reaches the Worker, and
   `HOST_REDIRECT` must stay off: a 308 to an unattached host would break every old link. (S06 also wants `www.citycoin.dev` to 308 to the
   apex while `HOST_REDIRECT` is off; S03 does not build that. Under `HOST_REDIRECT` it is the general rule above.)
3. **Plain http.** No zone change is needed: with every request reaching the Worker, an `http://` page answers 308 to the canonical origin
   and an immutable file 308 to `https://` on its own host. `.dev` is on the HSTS preload list, so browsers never ask citycoin.dev over http.
4. **Keep the vicinity.city routes** for at least 12 months after `HOST_REDIRECT=on` (master section 04), with a named renewal and
   monitoring responsibility (recorded in S56). The immutable files keep serving for as long as anything names them (inventory C04, C05).
5. **vicinitycity.net** is not routed to the Worker today (wrangler.jsonc comment on `routes`). If it is re-attached, it is a legacy host
   and follows the same rules.

## 3. Order of the cutover (each a configuration pull request; none is part of S03)

1. S04: sessions, hand-off links, QR codes and wallet challenges bound to their host (from `SITE_ORIGINS`, never the request).
2. S05: the preview environment, where the run of step 5 is rehearsed first.
3. S06: attach citycoin.dev (section 2, item 2), `HOST_REDIRECT` off.
4. S55: `SITE_ORIGIN=https://citycoin.dev` and the rest of the website cutover, `HOST_REDIRECT` off.
5. S56: `HOST_REDIRECT=on`, `"run_worker_first": true` and `DEPLOYMENT_ENV=production` in one pull request. The page build refuses
   `HOST_REDIRECT=on` without `run_worker_first: true` or with a configuration the Worker refuses.

## 4. Checks before and after step 5 (to run then; not run in S03)

- Byte hashes of the immutable files on `https://vicinity.city` and `https://citycoin.dev`, before and after: `/brand/vicinity-512.png`,
  `/official-coins.csv`, and every `/coin-meta/<mint>.json`, `/coin-meta/<mint>.png` and `/coin-meta/art/<sha>.png` a coin names.
- `curl -sI https://vicinity.city/launchpad?tab=new` answers 308 with `location: https://citycoin.dev/launchpad?tab=new`.
- `curl -sI "https://vicinity.city/connect?link=x&mode=login"` answers 308 to `https://citycoin.dev/connect?mode=login`.
- `curl -s -X POST https://vicinity.city/api/feedback` answers 421 `{"error":"wrong_host"}` with no `location`.
- `curl -sI https://vicinity.city/api/health` answers 200 (read-only API in place). An unknown host cannot reach the Worker through
  Cloudflare (it has no route); the Worker would answer it 421.
- The synthetic probes of S54 stay green through the observation period (external E15).

## 5. Rollback

Set `HOST_REDIRECT` to `off` (change the value; do not delete the line, `keep_vars` would keep a dashboard value) and deploy: every answer is
today's again at once. Browsers keep a 308 they already followed for at most one hour (`max-age=3600`). `run_worker_first: true` may stay
or go back to the list; with the switch off it changes no answer the Worker gives, only which requests are Worker requests.

## 6. Sessions during the window

S03 does not touch sessions. A session row made today (no host) keeps working on the host whose cookie it is: with the switch on, a member
signed in on vicinity.city stays signed in there for the read-only API, and a write from an old tab is refused with 421 and changes no row.
Browsers never send a vicinity.city cookie to citycoin.dev, so there the member signs in again with the same wallet (master section 05).
Until S04 binds a session row to its host, a cookie copied by hand to another host would still be accepted (`src/auth.js` finds a session by
its token hash alone); S04 closes that.
