# Domain cutover: vicinity.city to citycoin.dev

Master change order v5, section 04 (BR-02) and section 05 (BR-03). Started in stage S03 (host-safe routing and redirects, local branch
`cc/s03`, not merged); stage S04 (session and challenge host binding, the same local branch, not merged) added section 1.2 and section 6;
the S03/S04 review fixes (same branch) added section 1.3 and the S06 rules in section 2; finished in S56. Each later stage adds its part.

**Status on 24 October 2026: nothing here is applied.** No DNS record, Cloudflare setting, route, custom domain or switch was changed.
citycoin.dev is registered on the same Cloudflare nameservers as vicinity.city and is **not attached** to the Worker: the Worker's routes
are `vicinity.city` and `www.vicinity.city` only (wrangler.jsonc `routes`). Nothing in the code assumes it is attached.

## 1. What stage S03 built (dark)

One switch, `HOST_REDIRECT`, read like every other switch (exactly `on`, trimmed, any letter case). The Worker applies it only through
`src/v5policy.js` `hostRedirect`, which counts it only while **every** precondition holds:

| Refusal code (logged once per isolate, never a value) | Holds the switch off while |
|---|---|
| `HOST_REDIRECT_PAGES_BYPASS_WORKER` | the deployed `wrangler.jsonc` does not send every request through the Worker first: its `assets.run_worker_first` is neither exactly `true` nor a list that holds `"/*"` and no negative (`!`) pattern. Any other form (for example a list of prefixes, or `"true"` as a string) keeps the switch refused with only this log line. The page build records this in `src/pages-built.js` (`pagesReachWorker`), and refuses to build when `wrangler.jsonc` sets `HOST_REDIRECT=on` without it. |
| `HOST_REDIRECT_SITE_REFUSED` | `SITE_ORIGIN` and `SITE_ORIGINS` are unset, or `src/site-config.js` refuses them |
| `HOST_REDIRECT_POLICY_REFUSED` | the v5 configuration check refuses the deployment: `DEPLOYMENT_ENV` unset (`ENVIRONMENT_UNSET`), `SITE_ORIGIN` missing (`MISSING_SITE_ORIGIN`) or not `https://citycoin.dev` (`HOST_REDIRECT_TARGET_NOT_CANONICAL`), or any other named error |

With the switch off (unset, any value but `on`, or refused) the Worker answers exactly as before, for every host, scheme, method and path:
`www.vicinity.city`, `vicinitycity.net` and `www.vicinitycity.net` answer 301 to the same path on `https://vicinity.city`, plain `http://`
answers 301 to `https://` on the same host, both for every method, and every other host is served in place (except the cutover's own two
hosts, `citycoin.dev` and `www.citycoin.dev`, which answer 421 until `SITE_ORIGINS` lists citycoin.dev: section 1.3; neither reaches the
Worker today). Because pages bypass the
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
| a local host (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`): `wrangler dev` | outside production only (`DEPLOYMENT_ENV` anything but `production`): served exactly as today. In production it is an unknown host (next row): the Worker never serves it or builds anything from it |
| an unknown host (not accepted; look-alikes such as `vicinity.city.evil.example`, `evilcitycoin.dev`, a trailing dot, an IP; a `workers.dev` or preview address if one were ever turned on) | `421 {"error":"wrong_host","origin":…}`, no `Location`, never served, never a redirect target |
| an accepted non-canonical host over `https://`, `POST /api/auth/logout` | served in place: it only ends the session this host's cookie names and clears that cookie (the Origin check applies), so a member can always sign out of an old host, for example on a shared computer |
| an accepted non-canonical host (or `http://` on any accepted host), any other method but GET and HEAD | `421 {"error":"wrong_host","origin":…}`, no `Location`: a signed POST, an API write or a webhook delivery is never replayed on another origin |
| same, GET or HEAD of an immutable legacy file: `/coin-meta/*`, `/brand/vicinity-512.png`, `/official-coins.csv` | served in place, the same bytes as on the canonical host (over `http://`: 308 to `https://` on the same host, never to another host) |
| same, GET or HEAD of a sign-in trip: `/api/auth/<provider>/start` or `/api/auth/<provider>/callback` (Google coming back to an old host for a trip started before the switch, an old bookmark) | `302` to `https://citycoin.dev/connect?error=login_expired`, the query dropped (no provider code or state travels), `Cache-Control: no-store`, no cookie: the sign-in page of the new host says the sign-in took too long and offers it again |
| same, GET or HEAD of a wallet challenge, any other sign-in route, pairing or other hand-off, callback or webhook: `/api/message`, `/api/auth/*`, `/api/pair*`, `/api/signup/*`, `/api/me/wallet/*`, `/api/locate*`, any path with a `callback(s)` or `webhook(s)` segment | `421 {"error":"wrong_host","origin":…}`, no `Location` |
| same, GET or HEAD of any other `/api/*` route (read-only answers, inventory C10) | served in place (over `http://`: 308 to `https://` on the same host) |
| same, GET or HEAD of anything else (the pages and their files) | `308` to `https://citycoin.dev` + the same path + only the safe query keys |

The 308 carries today's redirect headers (the security headers and `Cache-Control: public, max-age=3600`, so turning the switch off undoes a
cached redirect within the hour), no body and no cookie. The 421 is JSON with the security headers and `Cache-Control: no-store`; its body
names the canonical origin from the configuration, never from the request: `{"error":"wrong_host","origin":"https://citycoin.dev"}`. (The
pages' own scripts do not read `origin` yet: they show their generic error on a 421. Mapping `wrong_host` to a "Vicinity moved to
citycoin.dev, reload and sign in there" notice changes `public/site.js`, so it waits for the stage that may change the pages: today every
file in `public/` must stay byte for byte.)

**Safe query keys** (`SAFE_QUERY_KEYS`): `city`, `mint`, `u`, `address`, `tab`, `q`, `tf`, `range`, `unit`, `style`, `mode`, `step`,
`welcome`, `claim`, `swap_in`, `swap_out`, `swap_amt`, `swap_slip`, `swap_open`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
`utm_content`. Each kept pair is copied byte for byte, in order. **Every other key is dropped**, unknown keys included, first of all the
hand-off, sign-in and one-time-code keys of inventory C02 and the sign-in callbacks (`link`, `pair`, `code`, `register`, `carry`, `state`,
`ref`, `next`, `error`, `login`, `google`, `linked`, `token`, `pin`, `on`, `app`, `with`). A fragment never reaches the server.

**No open redirect.** The target is `SITE_ORIGIN` (validated by `src/site-config.js` and the v5 check) with the request's path appended as
text, never resolved against it, and the result is checked to name that origin before it is sent (`//evil.example/x` becomes
`https://citycoin.dev//evil.example/x`). The request's `Host` header never builds a target: for `http://` to an accepted host the target is
that host's own allowlist entry over `https://`.

### 1.2 Sessions, hand-offs and challenges bound to their host (stage S04, `src/hostbind.js`)

Master section 05 (BR-03): "Domain migration must preserve account ownership, not assume that a cookie or wallet signature valid for
vicinity.city is valid for citycoin.dev", and its acceptance: wrong-origin signatures, copied cookies, replayed hand-offs and untrusted
return URLs fail safely.

**When it counts.** There is no new switch. The binding counts once `SITE_ORIGINS` (accepted by `src/site-config.js`) lists a host other
than `vicinity.city`: the moment a second host can serve the site (the S06 configuration pull request that attaches citycoin.dev is the
first that does). A `SITE_ORIGIN` or `SITE_ORIGINS` that is set but refused counts too, with today's site: a broken setting fails closed
(every host outside the allowlist refused) instead of serving a second host unbound. **Setting `SITE_ORIGIN` or `SITE_ORIGINS`, even
wrongly (a typo in the dashboard: `keep_vars` keeps it), runs the additive host migrations on first use and turns on 421 for every host
outside the allowlist.** Members see nothing on vicinity.city (their rows have host NULL), but the schema gains the `host` columns and new
sessions record `vicinity.city`; a refusal also logs one `policy config refused SITE_ORIGIN_…` line per isolate. With both unset, or naming
only `vicinity.city`, nothing changes on any host that reaches the Worker: no column is added, no host is written or compared, and the
links and the signed text name the request's own host as they always have (on vicinity.city that is exactly the configuration's value;
Cloudflare routes no other host to this Worker today: wrangler.jsonc `routes`, `workers_dev` and `preview_urls` false). The cutover's own
two hosts are the one exception (section 1.3). It does not depend on `HOST_REDIRECT` and works with it on or off.

**What it does while it counts.** The request's host is looked up in the allowlist: the hosts of `SITE_ORIGINS` plus the four legacy hosts
(the same "accepted hosts" as section 1.1; exact, lower case, never a suffix match). The value used is the allowlist's own entry, never the
request's text (a port or another spelling of the name does not change it). Outside production only (`DEPLOYMENT_ENV` anything but
`production`), a local development host (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`: `wrangler dev`, never a Cloudflare route) is
served as its own host, and `wrangler dev`'s visit of a route's name over `http://` from this computer (`http://vicinity.city` with
`cf-connecting-ip` 127.0.0.1) keeps `http://` in its links and Google return address, bound to the allowlist entry. In production both are
refused like any other host outside the allowlist. Local development under `SITE_ORIGINS`: a session made before the binding (host NULL,
which is vicinity.city) is signed out on `http://localhost:8787` (its key is `localhost`); sign in again there, or use the route's name.

| What | While the binding counts |
|---|---|
| A host outside the allowlist (`evil.example`, `citycoin.dev.evil.example`, a trailing dot, an IP, `www.citycoin.dev`, a host attached but not listed) | For every request that reaches the Worker: `421 {"error":"wrong_host","origin":…}`, no `Location`, no cookie, before any route and before the `http://` and old-name 301s (so no address is built from its `Host`). With today's `run_worker_first` list only `/api/*`, `/coin-meta/*` and `/official-coins.csv` reach the Worker: **an attached host's pages are served straight from the static assets (200) and only those paths answer 421**, a half-working site. Never attach a host the allowlist does not list (section 2). Once `run_worker_first` is `true` (S56) the asset fallback answers 421 too. |
| A session (the `vs` cookie) | A new session records the host it is made on (`sessions.host`: the allowlist entry, or the local host's name), in the same D1 transaction as its row, by every way a session is made (wallet sign-in, pairing, Google, the e-mail code, a password log-in or reset, the new sign-up's finish, the wallet app's carry claim, a pending transfer proof). `getSession` refuses a row of another host: a cookie copied by hand to another host is signed out there (`/api/me` says `signedIn: false`, a sensitive action answers `401 sign_in`). Signing out, or signing in, there deletes only a session of that host: a copied cookie never ends the session on the host that made it (`src/hostbind.js` `sessionDelete`). A row made before the binding counted (host NULL) belongs to `vicinity.city`. |
| The cookie itself | Unchanged: `vs=<token>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=…`, host-only (no `Domain` attribute), today's name; it is never shared across domains. (The `__Host-` prefix arrives with `WALLET_ONLY`, stage S10.) |
| The wallet challenge (`GET /api/message`) and every signed text (`/api/auth/wallet`, `/api/auth/reprove`, `/api/verify`, the wallet link and its carry claim) | The text names the allowlist entry (lower case, no port), and `src/signed.js` accepts a text only on the host it names: a signature made for vicinity.city is refused on citycoin.dev (`wrong_site`) and the other way round. That binding exists today (the text must name the request's host); S04 keeps it, takes the host from the allowlist, and tests it. A text is still single use (`replayed`). |
| A "sign in with my phone" pairing (`/api/pair*`), the wallet link's carry code (`/api/me/wallet/carry*`), the location hand-offs (`/api/locate/handoff*`, `/api/signup/location/handoff*`) and a sign-up (the `vsu` cookie) | Each row records its host (`pairs.host`, `handoffs.host`, `signups.host`). On another host it is unknown: `pair_expired` / `expired` / `carry_expired` / `no_signup`, and nothing is read, marked, approved, consumed or deleted there (a copied `vsu` cookie is cleared on that host, the sign-up it names stays: `signupDelete`); a pairing approved on its own host cannot be collected on another (no session is made). |
| A request that changes something (every POST route's Origin check, `src/http.js` `sameSite`) | The `Origin` must be exactly the allowlist entry's origin the request is served as (scheme and host): `http://citycoin.dev`, or `https://vicinity.city:8443`, is refused (403) on `https://citycoin.dev` and `https://vicinity.city`. While the binding does not count: today's rule (the Origin's host equals the request's host). |
| Links: the QR code and pairing link, the carry link, the location hand-off links, the Google return address (`redirect_uri`) | Built on the allowlist entry's origin. The request's `Host` never builds a link, a QR code or a redirect target; the server's own redirects stay relative paths of this site, and no request parameter (`next`, `return`, `redirect_uri`) is ever followed. |
| A Google callback replayed on another host | The return address on that host differs from the one Google issued the code for, so the code exchange fails (`/connect?error=login_failed`); the `vo` cookie is host-only besides. |

**Schema.** Four lazy additive migrations in `src/store.js`, one per table, each run only while the binding counts and only by the paths
that use its table, the first time such a row is read or written: `2026-10-24-host-binding-sessions` (`sessions.host`),
`2026-10-24-host-binding-pairs` (`pairs.host`), `2026-10-24-host-binding-handoffs` (`handoffs.host`) and `2026-10-24-host-binding-signups`
(`signups.host`, once the sign-up tables exist). Nullable `TEXT` columns, each `ALTER` on its own ("duplicate column" ignored), then the
record. No row is rewritten. A request with no cookie and no write touches nothing. A failing `ALTER` breaks only its own table's routes
(a hand-off column never stops a sign-in); a wallet sign-in or carry claim adds `sessions.host` before it uses up the signed text, so a
failure there answers 500 and the same signature works on the retry; while bound, sign-out clears the cookie even when the database fails.

### 1.3 The cutover's own hosts before `SITE_ORIGINS` lists them (S03/S04 review)

`citycoin.dev` and `www.citycoin.dev` (`src/site-config.js` `CUTOVER_HOSTS`: the v5 policy's canonical host and its www; a test keeps the
two in step) answer `421 {"error":"wrong_host","origin":"https://vicinity.city"}` before any route while `SITE_ORIGINS` does not list
citycoin.dev (unset, naming only vicinity.city, or refused). They are not attached today, so no answer that anyone receives changes. The
reason: the binding is turned on by configuration, not by the host a request arrives on. Without this rule, citycoin.dev attached as a
custom domain before `SITE_ORIGINS` lists it (in the dashboard, or by an out-of-order deploy) would serve the whole site unbound: its
sessions, pairings and hand-offs would get host NULL, which later reads as vicinity.city (signed out on citycoin.dev, accepted on
vicinity.city if copied), and its challenge text, QR links and Google return address would come from its `Host` header. With the rule,
such a window answers 421 on the Worker paths and makes no row; its pages still come from the static assets, so it is still a half-working
site: keep the order in section 2. Other hosts outside the allowlist keep today's in-place serving while unset (refusing all of them would
change today's answers, which is the owner's call; Cloudflare routes none of them to this Worker).

**Owner actions it implies (none taken here).** Google sign-in on citycoin.dev works only if the Google OAuth console lists
`https://citycoin.dev/api/auth/google/callback` (external E12; master section 05 keeps Google out of the new dashboard login path, so add it
only if the legacy window needs it). Without it Google refuses the trip (`redirect_uri_mismatch`): it fails safely and signs nobody in.

## 2. The Cloudflare settings the switch needs (not changed in S03)

1. **Every page must reach the Worker.** Today `wrangler.jsonc` has `"run_worker_first": ["/api/*", "/coin-meta/*", "/official-coins.csv"]`
   with `not_found_handling: "404-page"`: every page and file (the 404 page and `/brand/vicinity-512.png` included) is served straight
   from the static assets on every routed host, and the Worker never sees it. The Worker therefore cannot redirect an old host's page, and
   switching `HOST_REDIRECT` on alone would leave a half-moved site (pages still loading on vicinity.city while their writes answered 421).
   The setting needed is `"run_worker_first": true` in the `assets` block of `wrangler.jsonc` (exactly the boolean, or a list that holds
   `"/*"` and no `!` pattern; any other form keeps the switch refused silently), deployed together with `HOST_REDIRECT=on` (or before it).
   It is a deploy setting, not a dashboard one. Consequences to accept in that pull request:
   - every page view becomes a Worker request (wrangler.jsonc's own comment on `run_worker_first` notes the cost);
   - the pages of the canonical host then come through the Worker's asset fallback (`src/index.js`: `env.ASSETS.fetch`, then the security
     headers of `src/http.js`). The fallback keeps the asset's own `Content-Security-Policy` when the binding applied `public/_headers`
     (it adds `font-src 'self'`); without it the page gets `src/http.js`'s policy, which has no `font-src` (equivalent through
     `default-src 'self'`). Local workerd applied `_headers` (`Cache-Control: public, max-age=31536000, immutable` on `/fonts/*`); verify
     on the preview environment (S05) before production that the answers keep every header `public/_headers` gives today, since local
     workerd is not proof for production.
   Zone Redirect Rules on the vicinity.city zone could move old-host pages without making them Worker requests, but they keep or drop the
   whole query string (they cannot drop only the hand-off keys), and the Worker would still refuse the switch, so its 421 for writes on the
   old hosts would not apply. They are not the supported path.
2. **Attach citycoin.dev** (stage S06): add `citycoin.dev` as a custom domain of the Worker (wrangler.jsonc `routes`), let Cloudflare issue
   the certificate, and add it to `SITE_ORIGINS` (`https://citycoin.dev https://vicinity.city`; `SITE_ORIGIN` stays unset until S55).
   Rules for that pull request:
   - **`SITE_ORIGINS` lists citycoin.dev in the same deploy that attaches it, or an earlier one; never after.** Attaching first gives a
     half-working site: its pages load from the static assets while every `/api/*` answers 421 (section 1.3), until the setting is
     deployed. Add the custom domain through the pull request's `routes`, not in the dashboard ahead of it.
   - **Do not list `www.citycoin.dev` in `SITE_ORIGINS`.** Listed, it becomes an origin of its own: its own sessions, its own challenge
     text and a Google return address `https://www.citycoin.dev/api/auth/google/callback` that is not registered. Unlisted but attached, its
     pages load from the assets and its `/api/*` answers 421. Either leave it unattached until S56, or attach it with a zone Single Redirect
     (Rules, Redirect Rules) from `www.citycoin.dev` to `https://citycoin.dev`, keeping the path and the query string (there are no legacy
     hand-off links on www.citycoin.dev, so a whole-query redirect is safe); the redirect runs before the Worker, which then never sees www.
     Master section 04's "canonicalize www.citycoin.dev to the apex" is met by that redirect; under `HOST_REDIRECT` (S56) the Worker's
     general rule would also move it, but only if www is listed, so keep the zone redirect instead.
   - **No preview or staging host under citycoin.dev** (for example `preview.citycoin.dev`) until the session cookie carries the `__Host-`
     prefix (`WALLET_ONLY`, stage S10): until then such a host, running other code, could set a `Domain=citycoin.dev` `vs` cookie and log a
     visitor into the setter's own account. Use a separate domain for previews (S05).
   - Set `DEPLOYMENT_ENV=production` with it (the v5 check wants an environment for any changed switch anyway): it also turns off the local
     development exemption (section 1.2) on the production Worker.
   Until then no request for citycoin.dev reaches the Worker, and `HOST_REDIRECT` must stay off: a 308 to an unattached host would break
   every old link.
3. **Plain http.** No zone change is needed: with every request reaching the Worker, an `http://` page answers 308 to the canonical origin
   and an immutable file 308 to `https://` on its own host. `.dev` is on the HSTS preload list, so browsers never ask citycoin.dev over http.
4. **Keep the vicinity.city routes** for at least 12 months after `HOST_REDIRECT=on` (master section 04), with a named renewal and
   monitoring responsibility (recorded in S56). The immutable files keep serving for as long as anything names them (inventory C04, C05).
5. **vicinitycity.net** is not routed to the Worker today (wrangler.jsonc comment on `routes`). If it is re-attached, it is a legacy host
   and follows the same rules.

## 3. Order of the cutover (each a configuration pull request; none is part of S03)

1. S04 (built on local branch `cc/s03`, not merged): sessions, hand-offs, hand-off links, QR codes and wallet challenges bound to their
   host (the allowlist entry, never the request), counting from the S06 configuration on (section 1.2).
2. S05: the preview environment, where the run of step 5 is rehearsed first.
3. S06: attach citycoin.dev and list it in `SITE_ORIGINS` in the same pull request (section 2, item 2: never www, no preview host under
   citycoin.dev), with `DEPLOYMENT_ENV=production`, `HOST_REDIRECT` off.
4. S55: `SITE_ORIGIN=https://citycoin.dev` and the rest of the website cutover, `HOST_REDIRECT` off.
5. S56: `HOST_REDIRECT=on`, `"run_worker_first": true` (exactly the boolean) and `DEPLOYMENT_ENV=production` (if S06 did not set it) in
   one pull request. The page build refuses `HOST_REDIRECT=on` without `run_worker_first: true` or with a configuration the Worker refuses.

## 4. Checks before and after step 5 (to run then; not run in S03)

- Byte hashes of the immutable files on `https://vicinity.city` and `https://citycoin.dev`, before and after: `/brand/vicinity-512.png`,
  `/official-coins.csv`, and every `/coin-meta/<mint>.json`, `/coin-meta/<mint>.png` and `/coin-meta/art/<sha>.png` a coin names.
- `curl -sI https://vicinity.city/launchpad?tab=new` answers 308 with `location: https://citycoin.dev/launchpad?tab=new`.
- `curl -sI "https://vicinity.city/connect?link=x&mode=login"` answers 308 to `https://citycoin.dev/connect?mode=login`.
- `curl -s -X POST https://vicinity.city/api/feedback` answers 421 `{"error":"wrong_host","origin":"https://citycoin.dev"}` with no
  `location`.
- `curl -sI "https://vicinity.city/api/auth/google/callback?code=x&state=y"` answers 302 with `location:
  https://citycoin.dev/connect?error=login_expired`.
- A member signed in on vicinity.city before step 5 can still sign out there (the account menu's Log out: `POST /api/auth/logout` answers
  200 and clears `vs`).
- `curl -sI https://vicinity.city/api/health` answers 200 (read-only API in place). An unknown host cannot reach the Worker through
  Cloudflare (it has no route); the Worker would answer it 421.
- The synthetic probes of S54 stay green through the observation period (external E15).

## 5. Rollback

Set `HOST_REDIRECT` to `off` (change the value; do not delete the line, `keep_vars` would keep a dashboard value) and deploy: every answer is
today's again at once. Browsers keep a 308 they already followed for at most one hour (`max-age=3600`). `run_worker_first: true` may stay
or go back to the list; with the switch off it changes no answer the Worker gives, only which requests are Worker requests.

The host binding (section 1.2) rolls back with `SITE_ORIGINS`: set it back to `https://vicinity.city` (or blank both settings) and deploy.
Every session, pairing, hand-off and sign-up row is then found by its token alone again, on any host, as today; the `host` columns stay,
nullable and unread. citycoin.dev then answers 421 on every Worker path (section 1.3: never served unbound) while its pages still load from
the assets, so detach citycoin.dev in the same rollback. A member's citycoin.dev session row stays until it expires.

## 6. Sessions during the window

- **Until S06** (`SITE_ORIGINS` unset): one host, nothing changes. Every existing session row has host NULL.
- **From S06** (`SITE_ORIGINS` lists citycoin.dev; section 1.2): a member signed in today stays signed in on vicinity.city (host NULL
  is vicinity.city), with the same session, dashboard and roles. Browsers never send a vicinity.city cookie to citycoin.dev, so there the
  member signs in again with the same wallet and reaches the same account (`users.wallet`); no location check is asked (master section 05).
  A cookie carried by hand between the hosts is signed out on the other one. A Google- or e-mail-only member uses the legacy window (S14).
- **With `HOST_REDIRECT` on** (S56): the vicinity.city session keeps answering the read-only API there; a write from an old tab is refused
  with 421 and changes no row (section 1.1), except sign-out, which is served there so the old session can always be ended; a sign-in
  trip that comes back to vicinity.city lands on citycoin.dev's sign-in page; pages move to citycoin.dev, where the member signs in.

**Expiry and retirement of what exists today** (master section 05: "Document the safe expiry/retirement of old sessions, handoff tokens and
signing keys"). Nothing is deleted by S04; every row below ends by itself, and the scheduled job (`src/jobs.js`) deletes expired rows:

| Row | Lifetime (unchanged) | So, after the binding starts |
|---|---|---|
| Session (`sessions`) | 30 days (`src/session.js`); a session a wallet made in a wallet app's own browser is renewed while used, never past 90 days from when it was made (`src/auth.js` `renewSession`, `SESSION_MAX_DAYS`) | every host-NULL session has ended 90 days after the last one was made |
| Pending wallet proof (a session without an account) | 30 minutes (`PENDING_SECONDS`) | gone within the hour |
| Pairing (`pairs`) | 10 minutes | gone within the hour |
| Hand-off code (`handoffs`: carry, location) | 10 minutes | gone within the hour |
| Sign-up (`signups`) | an hour from the last request, at most 3 hours | gone within 3 hours |

A row made before the binding is bound to vicinity.city, so none of these can be used on citycoin.dev at any point. Signing keys: the wallet
challenge is not keyed (the wallet signs it, and the text names its host); the location attestation key (`ATTEST_KEY`, or the generated
`attest_key` setting, `src/attest.js`) and the relay-ticket key (the limits salt, `src/limits.js`) name no host, so the domain change needs
no rotation. R1-09 plans the `ATTEST_KEY` rotation once the check-in and apply attestations are retired (after `WALLET_ONLY`, S15).
