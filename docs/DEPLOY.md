# Deploying vicinity.city from GitHub

**The rule: GitHub `main` is what is live.** A pull request is built and tested automatically. When it is merged into `main`, the *Deploy* workflow ships it to Cloudflare. Nobody deploys from a laptop, a chat tool or an old script, because anything deployed that way is invisible to GitHub and is overwritten by the next deploy.

```
pull request ──► CI: build pages + every test            (.github/workflows/ci.yml)
merge to main ─► Deploy: build + tests + wrangler deploy  (.github/workflows/deploy.yml)
                 then: security headers on the live site   (scripts/check-live.mjs)
```

## One-time setup (about 10 minutes, needs you, not me)
1. **Cloudflare API token.** Cloudflare dashboard → *My Profile* → *API Tokens* → *Create Token* → template **Edit Cloudflare Workers**. Account resources: the account that owns vicinity.city. Zone resources: `vicinity.city`. Also add *Account → D1 → Edit*. Use a token made only for this; do not reuse one that other tools hold. (If the first deploy complains, the error names the missing permission.)
2. **Give it to GitHub.** Best: put it where only the deploy can read it. Repository → *Settings* → *Environments* → *New environment* → `production` → under *Deployment branches and tags* choose *Selected branches* → add `main` → under *Environment secrets* add `CLOUDFLARE_API_TOKEN` (the token). That way no other branch or workflow file can read it. (Simpler but weaker: *Settings* → *Secrets and variables* → *Actions* → *New repository secret*, same name; any workflow on any branch could then read it.)
3. **Make deploys wait for you (recommended).** In the same `production` environment tick *Required reviewers* → add yourself. Every deploy then stops and waits for your *Approve* click, so nothing goes live unless you said so. Also *Settings* → *Branches* → protect `main` (require a pull request), so nothing reaches `main` without one.
4. **Stop every other way of deploying.** The previous AI's `deploy.py` and its Cloudflare connector, and any API token it used, must be switched off (revoke the token in Cloudflare → *My Profile* → *API Tokens*). Do not turn on Cloudflare's own *Workers Builds* (Git integration) as well: two deployers would overwrite each other.

## Everyday flow
1. Work on a branch, open a pull request. CI runs; red means do not merge.
2. Merge into `main`. The *Deploy* workflow runs (and waits for your approval if you set that up in step 3).
3. Look at the green tick, and at the output of "Check the live site sends its security headers".
- Run the header check yourself any time: `npm run check:live` (read-only).

## Where each setting lives
| What | Where | Why |
|---|---|---|
| `SITE_MODE`, `GOOGLE_CLIENT_ID`, `EMAIL_FROM` | `wrangler.jsonc` → `vars` | public, and changes (like going live) should be a reviewed pull request |
| `ADMIN_WALLETS` | Cloudflare dashboard (plain variable) | kept by `keep_vars: true`; not needed in a public repo |
| `SOLANA_RPC_URL`, `RESEND_API_KEY`, `GOOGLE_CLIENT_SECRET`, `GMAIL_*` | Cloudflare *Secrets* | never in GitHub; a deploy never touches them |
| `VICINITY_MINT` | fastest: Cloudflare dashboard → Workers → `vicinity-map` → Settings → Variables → add it (live at once, kept by `keep_vars`). Then add it to `wrangler.jsonc` → `vars` in a pull request so GitHub stays the truth | picked up with no code change |
| `EMAIL_MAX_PER_HOUR` (optional) | `wrangler.jsonc` → `vars` | site-wide cap on sign-in e-mails per hour, default 2000 |
| `SIGNUP_FLOW` | Cloudflare dashboard (plain variable), **not** `wrangler.jsonc` | the switch for the new sign-up: `v2` = on, anything else or missing = today's sign-up. See "Sign-up v2 switch" below |
| `PASSWORD_PEPPER` (v2, recommended) | Cloudflare *Secrets* | a secret mixed into every password hash; see below, set it BEFORE the first password exists |
| `LIMIT_SALT` (v2, optional), `PASSWORD_ITERATIONS` (v2, tests only) | Cloudflare *Secrets* / not set in production | `LIMIT_SALT` scrambles the keys of the attempt counters (without it a random one is made once and kept in the database); `PASSWORD_ITERATIONS` can only LOWER the hashing cost, never raise it, so leave it unset |
| `JUPITER_API_BASE` (optional) | Cloudflare dashboard (plain variable) | where prices come from. Unset = `https://lite-api.jup.ag`, the keyless address Jupiter is retiring. Set it to `https://api.jup.ag` together with the key below. The site asks Jupiter at most once per 30 seconds per set of tokens and keeps the last price for 5 minutes when Jupiter fails (the swap panel then shows it as an estimate, nothing goes blank) |
| `JUPITER_API_KEY` (optional) | Cloudflare *Secrets* | the key from portal.jup.ag, sent as `x-api-key`. Without it the free, slower allowance applies |
| `RPC_TIMEOUT_MS` (optional) | Cloudflare dashboard (plain variable) | how long one blockchain call may take before the site gives up on it, in milliseconds. Unset = 8000. Raise it only if the holder list grows so large that ranks keep falling back to "the full ranking is loading" |

## Attempt limits on the public routes (launch week)
The code counts attempts itself (src/guards.js) and answers `429 slow_down` over the limit; the pages show "too many tries from your network" and try again later. These are the first line. Add the same rules in Cloudflare (*Security* → *WAF* → *Rate limiting rules*, per IP) as the second line, so a flood is stopped before it reaches the Worker. Numbers at or above the code's, never below, or the WAF rule becomes the one that locks real people out:

| Path (method) | In the code | WAF rule (per IP) | Why this number |
|---|---|---|---|
| `POST /api/verify` | 30 per 10 min per connection | 30 per 10 min | one blockchain call each |
| `POST /api/auth/transfer` (exactly this path) | 30 per 10 min per connection | 30 per 10 min | phones on one mobile network share one address; 10 would lock out the 11th person |
| `POST /api/auth/transfer/check` | 90 per 10 min per **session** | 200 per 10 min, or no rule | the page asks every 10 seconds (60 per person per 10 min); two people behind one address need 120. Do not put this path under the 30-rule above |
| `POST /api/pair` | 20 per 10 min per connection | 20 per 10 min | one database row each; `GET /api/pair` (a phone polling for its code) is not counted |
| `GET /api/rank` | 60 per minute per connection, cache hits free | 60 per minute | an RPC call when the snapshot is down |
| `GET /api/prices` | answered from a 30-second cache | 60 per minute | one Jupiter call per 30 seconds per set of tokens |

A "connection" is an IPv4 address, or an IPv6 address cut to its /64. Nothing identifying is stored: the counter keys are HMACs. A database problem never blocks these routes (the request goes through and a short code is logged).

**Security headers on pages.** Pages and files are served straight from Cloudflare's static assets and get their headers from `public/_headers` (the Worker only runs first for `/api/*`, see `wrangler.jsonc`). That keeps page views off the Worker request quota. Today's production sends no headers on pages because the previous deploy script left this out; `npm run check:live` proves it is fixed after a deploy. Not done by this setup: forcing https and forwarding `www.vicinity.city` to the main address. Do both in the Cloudflare dashboard (*SSL/TLS* → *Edge Certificates* → *Always Use HTTPS*, and a redirect rule), or set `"run_worker_first": true` and let the Worker do it (then every request counts as a Worker request).

The database needs nothing at deploy time: the code creates and upgrades its tables when they are first used.

## Sign-up v2 switch (new sign-up: location, account with a password, wallet, dashboard)
The new sign-up is built and tested but **dark**: while `SIGNUP_FLOW` is not `v2` the site behaves exactly as before (the new routes answer "not_enabled", `/connect` is unchanged, and not one new thing is created in the database). One person goes through: **1 location** (the same checks as today's location check; only the community is kept, never the coordinates), **2 account** (tick the Terms of Use, then Google, or e-mail + a password proved with a 6-digit code), **3 wallet** (proved as today), and then the account is created in one step and they land on the dashboard. Returning members do not repeat anything: wallet, Google, or e-mail + password log them in. In v2 the old sign-in routes can only sign people in; accounts are only created by the new flow.

**Before you flip it (each item needs you):**
1. **Workers Paid plan.** Checking a password takes about 50 ms of processor time (100,000 rounds of PBKDF2, the most Cloudflare allows). The Free plan allows 10 ms, so there every sign-up and password log-in would fail with error 1102. (The 10-minute job already needs the Paid plan once there are many holders.) Confirm the plan first.
2. **`PASSWORD_PEPPER`** (recommended): a Cloudflare *Secret* of 32 random bytes, for example the output of `openssl rand -base64 32`. Create it **before the first password is made** and never change or delete it: it is part of every password hash, so a lost pepper means nobody can log in with a password (they can still use the e-mail code to set a new one). Without it passwords still work, only less protected if the database is ever stolen; adding it later is safe (old hashes are upgraded at each person's next log-in). Never put it in GitHub.
3. **Rate-limit rule.** Extend the Cloudflare rate-limiting rule from the launch checklist (*Security* → *WAF* → *Rate limiting rules*) to these paths, all `POST`: `/api/signup/email*`, `/api/auth/email/*`, `/api/auth/password/*` (for example 10 requests per 10 minutes per IP). The code has its own counters, this is the outer wall that stops a flood before it reaches the Worker.
4. **Mail** must work (Resend or Gmail, see above): the e-mail path needs the 6-digit code.
5. **Test in a quiet hour** with throw-away accounts (one on a phone, one on a computer), then watch *Workers & Pages* → `vicinity-map` → *Metrics* for errors and CPU time.

**Flip it on:** Cloudflare dashboard → *Workers & Pages* → `vicinity-map` → *Settings* → *Variables and secrets* → add the plain-text variable `SIGNUP_FLOW` with the value `v2` → *Deploy*. It applies to the very next request, no code deploy. Do **not** add it to `wrangler.jsonc`: a deploy would then reset it.

**Switch back (instant, any time):** set `SIGNUP_FLOW` to `v1` or delete the variable. Everything is as it was. Accounts made while it was on keep working: wallet, Google and the e-mail code log-in all still work; the password log-in answers "not enabled" until the switch is on again (the passwords stay saved, unused). People in the middle of a sign-up at the moment of a flip lose only their unfinished step (a proven wallet lasts 30 minutes): flip at a quiet hour, either way. A page that was already open may show an error once; a reload fixes it.

**What the first v2 request changes in the database:** it adds two tables (`signups`, `auth_limits`) and two empty columns (`users.password_hash`, `handoffs.signup_id`). Nothing existing is changed or removed, and it runs only once the switch is on. If that ever fails, only the new sign-up says "unavailable"; every other page keeps working, and the next request tries again.

**How the password log-in protects itself** (nothing for you to set up): five wrong tries from one connection at one address shut that connection out of that address's password log-in for 15 minutes, 60 tries from one connection (any addresses) shut the connection out, and 15 tries at one address from all connections together close the password route for that address until the 15 minutes end (a real owner can still use the e-mail code, or the wallet). A right password gives its try back. Every answer is the same for an address that has no account, a wrong password and an account that has no password, so nobody can find out who is a member. "Forgot or never set a password" e-mails a 6-digit code (its own code, a sign-in code cannot be used for it), then sets the new password, signs the person in and ends all their other sessions. If you ever see people unable to log in with a password during an attack, they can use "e-mail me a code"; the counters clear themselves.

**What a half-done sign-up keeps** (up to 3 hours, then the 10-minute job deletes it): the community, the visitor's network operator and country (like `US|7922`), the Terms version and time, a Google id or an e-mail address, and a password *hash*. Never a coordinate, an IP address, or a clear password. If you write a privacy notice later, mention it.

**Check on the first real deploy:** the 100,000-round limit and the 50 ms cost come from measurements and secondary sources, not from Cloudflare's own page. The first test sign-up with a password will fail visibly if either is wrong.

## Launch checklist (each item needs your go-ahead)
- [ ] Google sign-in: in the Google Cloud console set the OAuth consent screen to **In production**. While it says *Testing*, real users cannot sign in with Google (e-mail sign-in still works).
- [ ] E-mail sending: check the plan of the mail service (Resend's free plan allows about 100 e-mails a day). Add a Cloudflare rate-limiting rule on `POST /api/auth/email/*` (*Security* → *WAF* → *Rate limiting rules*), for example 5 requests per 10 minutes per IP (when the new sign-up goes on, also `/api/signup/email*` and `/api/auth/password/*`: see "Sign-up v2 switch").
- [ ] Wipe the test data: sign in to `/admin` with the owner wallet → *Test lab* → *Reset* (needs a fresh wallet signature). It deletes only the rows the test lab created.
- [ ] Go live: pull request changing `SITE_MODE` to `"live"` in `wrangler.jsonc`, merge, approve the deploy. (In `live` mode the test lab can no longer be seeded.)
- [ ] After the token launch: pull request adding `VICINITY_MINT`.
- [ ] Prices: create a free Jupiter API key (portal.jup.ag), set the secret `JUPITER_API_KEY` and the variable `JUPITER_API_BASE` = `https://api.jup.ag` (see the settings table). Until then the retiring keyless address is used.
- [ ] Rate-limiting rules for the public routes, per IP, as listed in "Attempt limits on the public routes" above.
- [x] The `workers.dev` addresses are switched off (`"workers_dev": false` in `wrangler.jsonc`, applied by the next deploy) and removed from the official-links list. Set it back to `true` only for a short test.

## Rolling back
- Fastest: Cloudflare dashboard → *Workers & Pages* → `vicinity-map` → *Deployments* → pick the previous version → *Rollback*. Then fix `main` with a pull request that reverts the bad change, so GitHub and Cloudflare agree again.
- Or: revert the pull request on GitHub and merge the revert; the Deploy workflow ships it.
