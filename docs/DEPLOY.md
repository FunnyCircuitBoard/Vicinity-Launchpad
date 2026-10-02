# Deploying vicinity.city from GitHub

**The rule: GitHub `main` is what is live.** A pull request is built and tested automatically. When it is merged into `main`, the *Deploy* workflow ships it to Cloudflare. Nobody deploys from a laptop, a chat tool or an old script, because anything deployed that way is invisible to GitHub and is overwritten by the next deploy.

```
pull request ──► CI: build pages + every test            (.github/workflows/ci.yml)
merge to main ─► Deploy: build + tests + wrangler deploy  (.github/workflows/deploy.yml)
                 then: security headers on the live site   (scripts/check-live.mjs)
```

## One-time setup (about 10 minutes, needs you, not me)
1. **Cloudflare API token.** Cloudflare dashboard → *My Profile* → *API Tokens* → *Create Token* → template **Edit Cloudflare Workers**. Account resources: the account that owns vicinity.city. Zone resources: `vicinity.city`. Also add *Account → D1 → Edit*. Use a token made only for this; do not reuse one that other tools hold. (If the first deploy complains, the error names the missing permission.)
2. **Give it to GitHub.** Repository → *Settings* → *Secrets and variables* → *Actions* → *New repository secret* → name `CLOUDFLARE_API_TOKEN`, value the token.
3. **Make deploys wait for you (recommended).** *Settings* → *Environments* → *New environment* → `production` → tick *Required reviewers* → add yourself. Every deploy then stops and waits for your *Approve* click, so nothing goes live unless you said so. Also *Settings* → *Branches* → protect `main` (require a pull request), so nothing reaches `main` without one.
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
| `VICINITY_MINT` | add to `wrangler.jsonc` → `vars` (pull request) right after the token exists | picked up with no code change |
| `EMAIL_MAX_PER_HOUR` (optional) | `wrangler.jsonc` → `vars` | site-wide cap on sign-in e-mails per hour, default 2000 |

**Security headers on pages.** Pages and files are served straight from Cloudflare's static assets and get their headers from `public/_headers` (the Worker only runs first for `/api/*`, see `wrangler.jsonc`). That keeps page views off the Worker request quota. Today's production sends no headers on pages because the previous deploy script left this out; `npm run check:live` proves it is fixed after a deploy. Not done by this setup: forcing https and forwarding `www.vicinity.city` to the main address. Do both in the Cloudflare dashboard (*SSL/TLS* → *Edge Certificates* → *Always Use HTTPS*, and a redirect rule), or set `"run_worker_first": true` and let the Worker do it (then every request counts as a Worker request).

The database needs nothing at deploy time: the code creates and upgrades its tables when they are first used.

## Launch checklist (each item needs your go-ahead)
- [ ] Google sign-in: in the Google Cloud console set the OAuth consent screen to **In production**. While it says *Testing*, real users cannot sign in with Google (e-mail sign-in still works).
- [ ] E-mail sending: check the plan of the mail service (Resend's free plan allows about 100 e-mails a day). Add a Cloudflare rate-limiting rule on `POST /api/auth/email/*` (*Security* → *WAF* → *Rate limiting rules*), for example 5 requests per 10 minutes per IP.
- [ ] Wipe the test data: sign in to `/admin` with the owner wallet → *Test lab* → *Reset* (needs a fresh wallet signature). It deletes only the rows the test lab created.
- [ ] Go live: pull request changing `SITE_MODE` to `"live"` in `wrangler.jsonc`, merge, approve the deploy. (In `live` mode the test lab can no longer be seeded.)
- [ ] After the token launch: pull request adding `VICINITY_MINT`.
- [ ] Decide about the two `workers.dev` addresses (they serve the whole site, admin included). Setting `"workers_dev": false` in `wrangler.jsonc` turns them off.

## Rolling back
- Fastest: Cloudflare dashboard → *Workers & Pages* → `vicinity-map` → *Deployments* → pick the previous version → *Rollback*. Then fix `main` with a pull request that reverts the bad change, so GitHub and Cloudflare agree again.
- Or: revert the pull request on GitHub and merge the revert; the Deploy workflow ships it.
