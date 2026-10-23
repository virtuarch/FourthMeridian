# Domain split rehearsed on Preview: public site and app on separate origins (2026-10-07)

**Scope:** the final public/app topology, set up and proven on Preview so that Production becomes "repeat this with Production authorities". This doc covers the topology, configuration (names only, never values), the code it needed, the evidence, and the exact Production steps that remain.

**Production was not touched.** No Production domain, DNS record, env record, deployment, secret, database or Plaid setting changed. The Plaid redirect-URI allowlist is account-wide; the owner made the one additive entry there (§2).

Design reasoning lives in `docs/plans/PUBLIC-APP-DOMAIN-SPLIT-ARCHITECTURE.md` (§9, §11, §12, §16.1, §18.6). This doc is what was actually built and proven.

## 1. Topology

```
                      PRODUCTION (unchanged)        PREVIEW (this lane)
public website        fourthmeridian.com →          preview.fourthmeridian.com
                      still the APP today           → fourth-meridian-site, branch v2.6
authenticated app     app.fourthmeridian.com        preview-app.fourthmeridian.com
                      (not yet attached)            → fintracker1, branch v2.6
```

- DNS is hosted at **NameBright** (third-party nameservers), not Vercel. `*.fourthmeridian.com` is a NameBright wildcard to a "coming soon" page, so an unconfigured subdomain resolves but does not reach Vercel.
- Both stable Preview hosts are custom domains attached with `gitBranch: v2.6`. Each follows its project's newest v2.6 deployment.
- **Vercel deployment protection covers both** (`ssoProtection: all_except_custom_domains` exempts only *Production* custom domains). An unauthenticated request gets a 302 to `vercel.com/sso-api`. Live probes therefore run from an owner browser that holds the Vercel SSO cookie. No protection bypass was created or used. fintracker1 already holds one bypass token that predates this lane; it was not used.
- `vercel.app` is on the Public Suffix List. The stable hosts are **same-site siblings** under `fourthmeridian.com`, as Production will be, so this rehearsal exercises the real same-site threat (Lax cookies travel between siblings; the Origin boundary is what stops writes).

## 2. Configuration

### 2.1 Owner actions (done)

| Where | Change | Scope |
|---|---|---|
| NameBright DNS | `CNAME preview-app → cname.vercel-dns.com` | Preview host only; no other record changed |
| Plaid Dashboard → API → Allowed redirect URIs | added `https://preview-app.fourthmeridian.com/plaid-oauth-return` | additive; `fourthmeridian.com/…` and `preview.fourthmeridian.com/…` entries unchanged (read back 2026-10-07) |

### 2.2 Vercel (all Preview-scoped)

| Project | Change |
|---|---|
| fintracker1 | domain `preview-app.fourthmeridian.com` added, `gitBranch: v2.6`; certificate issued (`vercel certs issue`) |
| fintracker1 | env, `target: preview`, `gitBranch: v2.6`: `NEXTAUTH_URL` = `NEXT_PUBLIC_APP_URL` = `https://preview-app.fourthmeridian.com`; `NEXT_PUBLIC_SITE_URL` = `https://preview.fourthmeridian.com` (public origins, not secrets) |
| fourth-meridian-site | env, `target: preview`, `gitBranch: v2.6`: `NEXT_PUBLIC_SITE_ORIGIN` = `https://preview.fourthmeridian.com`, `NEXT_PUBLIC_APP_ORIGIN` = `https://preview-app.fourthmeridian.com` |
| fourth-meridian-site | domain `preview.fourthmeridian.com` moved here from fintracker1, `gitBranch: v2.6` (§5), 2026-10-07 ~01:55Z |
| fintracker1 | `NEXTAUTH_SECRET` (Preview, `gitBranch: v2.6` record only) rotated after the move, then redeployed (§4.4) |

The branch-scoped records override the generic Preview records for v2.6 only. Generic Preview (any other branch) is unchanged.

### 2.3 Public-site secret inventory (names and scope only)

`fourth-meridian-site` holds exactly six env records, all public origins:

| Name | Records |
|---|---|
| `NEXT_PUBLIC_SITE_ORIGIN` | Production; generic Preview; Preview v2.6 |
| `NEXT_PUBLIC_APP_ORIGIN` | Production; generic Preview; Preview v2.6 |

No `DATABASE_URL*`, `PLAID_*`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET`, Supabase, OpenAI, Resend or any other credential. The team has no shared env vars. The site is a static export with no route handlers, middleware, server actions, forms, cookies, storage or network calls (pinned by `site/tests/surface.test.mts`), and `site/lib/public-config.ts` is the only reader of `process.env` (`site/tests/public-env.test.mts`). Compromise of the public site exposes no financial authority: it can serve wrong pages, and nothing else.

### 2.4 App Preview authority (names only, unchanged by this lane)

v2.6 Preview runs on the Preview database through `DATABASE_URL_APP` / `_AUTH` / `_SYSTEM` (`fm_app` / `fm_auth` / `fm_system`) with `FM_RLS_STRICT`. It has its own branch-scoped `NEXTAUTH_SECRET` and `CRON_SECRET`, and Plaid Sandbox. `ENCRYPTION_KEY` and `PLAID_CLIENT_ID` remain one shared record (see `environment-separation.md`). Nothing was rotated.

## 3. Code (`6c7cea5`, `3c12c47` shipped in `cf7323a`; `c7e72ed`)

| Finding | Fix |
|---|---|
| `/` on the app origin served the marketing landing page, so "/" meant two things | `lib/marketing/public-site.ts` + `proxy.ts`: with `NEXT_PUBLIC_SITE_URL` set, `/` → 307 `/dashboard` (the auth gate then keeps the deep link), and `/about`, `/legal/*`, `/privacy`, `/security`, `/terms` → 308 to the same path + query on the public site. The destination origin comes only from the build-time env, never the request. Unset ⇒ inert (Production on the apex, local dev). Served as the site origin ⇒ inert (no loop). |
| After a Plaid OAuth return the app sent the user to `/` (marketing) | `app/plaid-oauth-return`: `/dashboard` |
| A 404 from `/api/access-request` was shown as success ("degraded", a Wave-1 shim) | only a 2xx is success. A misrouted post can no longer thank the visitor while the lead is lost. |
| 7 page-level `redirect("/login")` dropped the deep link after a revoked session | `return redirectToLogin()`; census ratchet 7 → 0 |
| Old links to app paths on the public host (reset/verify/invite emails, bookmarks) would 404 once it becomes the site | `site/lib/legacy-app-paths.ts`: the static 404 page forwards `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`, `/confirm-email-change`, `/dashboard/*`, `/admin/*`, `/plaid-oauth-return`, `/merchant-ops` to the build's app origin with path, query and fragment. `/api/*` is not forwarded. |
| Marketing nav/footer on the app's remaining `/request-access` page linked relative | site-owned pages link absolutely to the public site when configured |
| 🚨 Found live: a REVOKED session (validly signed JWT, row revoked) got the 500 error page on most shell pages. The proxy only verifies the signature, and every page's `getSpaceContext()` threw "Not authenticated". `/admin` sent it to `/dashboard`, i.e. the same error page. | `c7e72ed`: the dashboard and admin layouts make the revocation-aware session read first and `return redirectToLogin()`. Live after deploy: every shell page → `/login?callbackUrl=<same page>`, issued by the function (Vercel log source `serverless`), not the proxy. |

Kept on purpose: `/request-access` stays an app page (its form posts same-origin to `/api/access-request`, so the Origin boundary and rate limit apply unchanged). The public site's `/request-access` page links to it. No CORS was added. Logout lands on the app's `/login`. The authenticated shell's logo is not a link. No app→public navigation was added.

## 4. Proof

### 4.1 Gates

| Gate | Result |
|---|---|
| Clean-copy CI, combined tip `cf7323a` (contains `6c7cea5` + `3c12c47` unchanged; ancestry and file-level provenance verified) | `[ci] PASSED`: test (unit, typecheck, lint), architecture (audits + all RLS acceptance suites), site (verify) |
| GitHub CI on `cf7323a` | run 37547752414, success |
| App Preview deployment | `dpl_7nR5YCmRtR33XRzU2gbX1rgUDHqS` (cf7323a) |
| Site Preview deployment | `dpl_E2VsQ2w6LiVJnXU2EzFRfGoRpBaX` (cf7323a, exact SHA via API; see §6.3) |
| Clean-copy CI, `c7e72ed` (revoked-session fix, on top of origin `049c669`) | `[ci] PASSED`, every job ✓ |
| App Preview deployment `c7e72ed` | `dpl_Xt71E6boV7ucTWXnwbfpNU9uiF9S` |

### 4.2 Production-mode probes with forged headers (local `next start` of cf7323a, Preview-shaped public origins, dummy secrets, no database)

A browser cannot forge `Host`, `Origin` or `X-Forwarded-Host` across origins, so these run against a local production build with Vercel-style forwarded headers:

| Probe | Result |
|---|---|
| `GET /` | 307 `/dashboard` |
| `GET /about`, `/terms?v=1`, `/legal/ai` | 308 `https://preview.fourthmeridian.com/<same path+query>` |
| `GET /terms` with `X-Forwarded-Host: evil.example` | 308 to the public site; the forged host never becomes the destination |
| `GET /terms` served as the site origin | 200 (inert, no loop) |
| `GET /dashboard/assets?tab=x`, `/dashboard/ai`, `/dashboard/connections`, `/admin` (logged out) | 307 `/login?callbackUrl=<the same path+query>` |
| Writes with Origin = public site, `evil.example`, `app.fourthmeridian.com`, `fourthmeridian.com`, `null`, `preview-app.fourthmeridian.com.evil.example`, `http://preview-app…` | 403 `cross_origin_write_refused` (`origin-mismatch` / `origin-null`) |
| Writes with no Origin and `Sec-Fetch-Site: cross-site` or `same-site` (a sibling) | 403 `cross-site-fetch` |
| `/api/ai/chat`, `/api/user/profile`, `/api/user/sessions/x`, `/api/auth/callback/credentials`, `/api/auth/signout`, `/api/access-request` from the public origin | 403 before any handler |
| `/api/plaid/webhook` (the only machine exemption) | 401 invalid signature |
| `/login?callbackUrl=` `https://evil.example`, `//evil.example`, `/%2F%2Fevil.example`, `/%5Cevil.example`, `/\evil.example`, `https://preview.fourthmeridian.com/dashboard`, `https://preview-app.fourthmeridian.com.evil.example/`, `javascript:alert(1)`, `/login?callbackUrl=//evil.example`, `/%252F%252Fevil.example` | return target `/dashboard/brief` (refused) |
| `/login?callbackUrl=/dashboard/assets?tab=x`, `/dashboard/ai` | kept |
| `/api/auth/signin?callbackUrl=https://evil.example` | NextAuth rewrites to its own base URL |

A non-browser caller that forges both `Origin` and `X-Forwarded-Host` passes the Origin check, as designed. That caller holds no victim cookie, and a browser cannot send `X-Forwarded-Host` cross-origin without a CORS preflight the app never grants.

### 4.3 Live on the stable Preview origins

Run from the owner's Chrome, which holds the Vercel SSO cookie. Accounts: the Preview test user `bjj` (TOTP enabled by the owner for this proof) and, on the sibling host, a different test user. Evidence: page state, `AuditLog`/`UserSession` rows (read-only queries), and Vercel request logs.

**App origin (`preview-app`, deployment cf7323a):**

| Check | Result |
|---|---|
| `/` signed in | lands in `/dashboard` (no marketing page on the app origin) |
| Assets (`/dashboard?tab=overview&metric=assets`), Connections, Conversations (`/dashboard/analyze`), Brief, Spaces | 200 |
| Same-origin write (`PATCH /api/user/notification-preferences`, idempotent value) | 200 `{"ok":true}` |
| Plaid link token from the app origin | 200, token issued (redirect_uri = preview-app, allowlisted) |
| Plaid Link launch | Link opens (Sandbox) in the app; closed without creating an Item |
| Logout | lands on `/login`; `/api/auth/session` empty; `UserSession.revokedAt` set (every logout); Back → `/login?callbackUrl=/dashboard/brief`; writes and link-token 401 |
| Logged-out deep link: Assets | `/login?callbackUrl=/dashboard?tab=overview&metric=assets` → after sign-in, back on Assets with the query intact |
| Password + TOTP | `AuditLog LOGIN {mfa: totp, result: SUCCESS}` (00:56:29Z, 00:57:28Z) |
| Logged-out deep link: Conversations, through TOTP | `/login?callbackUrl=/dashboard/analyze` → TOTP sign-in → `/dashboard/analyze` |
| Reload | session persists |
| Revocation: current session row revoked server-side while the browser keeps sending its still validly signed cookie (= a copied/replayed cookie) | `/api/auth/session` empty; every API 401, including writes; `/dashboard/spaces` and `/dashboard/settings/archived-assets` → `/login?callbackUrl=<same page>` |
| 🚨 Revocation on the other shell pages (cf7323a) | `/dashboard`, Brief, Conversations, Connections, Credit **500 "Something went wrong"** (fail-closed: no data, APIs 401). Fixed in `c7e72ed` (§3) |
| Revocation, same browser cookie, after `c7e72ed` deployed | `/dashboard`, Assets, Brief, Conversations, Connections, Credit, Spaces → `/login?callbackUrl=<same page+query>` |
| Request access: legitimate submission | "You're on the list"; one `BetaAccessRequest` row (PENDING) + `BETA_ACCESS_REQUESTED` audit. Truthful. |
| Request access: abuse control | 5 per window per IP, then 429 (verified with invalid emails, which write nothing). Turnstile is not configured on Preview (no `TURNSTILE_*` env); the server skips CAPTCHA when unconfigured. |

**Sibling origin → app (from a page on `preview.fourthmeridian.com`, a real browser, real `Origin`, Lax cookies sent same-site):**

| Attempt | Result |
|---|---|
| CORS `PATCH` (JSON) to the app | blocked by the browser: no CORS grant (preflight fails) |
| `GET /api/auth/session` cross-origin | response unreadable (no CORS) |
| No-CORS "simple" `POST /api/ai/chat` and `/api/access-request` (the classic CSRF shape) | **403 in the middleware** (Vercel log `serverless-middleware`); no serverless handler invocation |
| Same-origin write with a forged `X-Forwarded-Host` (`preview.`, `evil.example`) and `X-Forwarded-Proto: http` | 200: Vercel overwrites client-sent forwarding headers, so the self-origin cannot be steered from a browser |

**Cookie boundary:** in the same browser, at the same moment, `preview-app` held one test user and `preview.` (same deployment, same `NEXTAUTH_SECRET`) held a different test user. Logging out or revoking on one host left the other untouched. The session cookie is `__Host-` (no `Domain`, path `/`, Secure), so no sibling can read, set or shadow it (`lib/auth/session-cookie.test.ts`).

**Public origin (`preview.fourthmeridian.com` after the move → fourth-meridian-site `dpl_E2Vs…`, cf7323a; `site/` unchanged through e8fc400):**

| Check | Result |
|---|---|
| `/`, `/about`, `/security`, `/terms`, `/privacy`, `/legal/ai`, `/request-access`, `/robots.txt`, `/sitemap.xml` | 200; canonical `https://preview.fourthmeridian.com/`; `noindex, nofollow` |
| Header Sign In / Get Started; request-access "Continue" / "Already have access? Sign in"; home "Open Fourth Meridian" | clicked: `preview-app…/login`, `preview-app…/request-access`, `…/dashboard` (absolute, top-level navigation) |
| Every application API path on the public host: `GET` `/api/health`, `/api/auth/session`, `/api/auth/csrf`, `/api/accounts`, `/api/spaces`, `/api/user/sessions`, `/api/sync/status`, `/api/plaid/link-token`, `/api/platform/platform-ops/db-authority`; `POST` `/api/auth/callback/credentials`, `/api/auth/pre-login`, `/api/ai/chat`, `/api/plaid/exchange-token`, `/api/plaid/webhook`, `/api/access-request`, `/api/auth/signout` | all 404 (the site's static HTML 404), no data |
| Legacy links on the public host: `/login?callbackUrl=/dashboard/analyze`, `/reset-password?token=…#frag`, `/dashboard/connections` | forwarded to `preview-app` with path, query and fragment; the app's gate then keeps the deep link (`/login?callbackUrl=/dashboard/connections`) |
| `//evil.example/login`, `/loginx`, `/api/auth/session` (top-level) | stay on the public host (404); nothing forwarded |
| A script on the public site attempting a credentialed write to the app | blocked before sending by the site's enforced CSP (`connect-src 'self'`). Independently, the app refuses that Origin (403 in middleware, proven from the same origin before the move). |
| Response headers | enforced CSP (`connect-src 'self'`, `form-action 'none'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, nosniff, Referrer-Policy, Permissions-Policy, COOP. ⚠️ `Strict-Transport-Security` from `site/vercel.json` is **not** served on this Preview host; check on Production. `Access-Control-Allow-Origin: *` is Vercel's static default (public content; `*` never allows credentials). |
| App session on the public host | none: the host serves no `/api/auth/*`, reads no cookie, holds no secret |

### 4.4 Session authority across the role change (Preview `NEXTAUTH_SECRET` rotated)

While `preview.` served the app it issued `__Host-` session cookies, host-only to `preview.`. After the move browsers keep sending those cookies to the **public-site project**. The static site cannot read them, but anyone able to deploy that project could add a function that logs them and replay them on `preview-app`: same secret, live session rows. So the move is not finished until those cookies are worthless. This is the Preview rehearsal of plan §16.2.

| Step | Evidence |
|---|---|
| Before: live `UserSession` rows | 1 (last active 01:57:35Z) |
| Rotated **only** the branch-scoped Preview record (`NEXTAUTH_SECRET`, target `preview`, `gitBranch: v2.6`, id `CmbkcdBD…`); value generated and sent without being printed | record `updatedAt` 2026-10-07 02:03:37Z; the shared Production+generic-Preview record `140sAi8S…` unchanged (`updatedAt` identical before/after) |
| Redeployed the app at the exact tip `e8fc400` | `dpl_B7j6N3cTMtkRwkLokUTyXY56qNjP`, ready 02:05:28Z, aliased `preview-app` |
| Old sessions after the redeploy | 0 pre-deploy rows used after it (`lastActiveAt`); every old JWT now fails the signature check in the proxy |
| Fresh login under the new secret: password + TOTP, Connections deep link | `AuditLog LOGIN {mfa: totp, SUCCESS}` 02:18:46Z; landed on `/dashboard/connections`; link token 200; write 200 |

## 5. Cutover order used on Preview

1. DNS for the new app host; attach it to the app project (branch-scoped); certificate.
2. Plaid allowlist entry for the new app host, **before** the app's URL env changes (otherwise every link-token creation fails: the 146a0dd outage).
3. App env (`NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`) → deploy. The app now serves both hosts; on the old host the public-site redirects are inert (self-origin).
4. Prove the app on the new host.
5. Site env → site deployment at the exact SHA.
6. Move the old host from the app project to the site project (remove from the app project, add to the site project with the same branch). The DNS record does not change: both projects are on the same Vercel team.
7. Prove the boundary from the public origin.
8. Rotate the app environment's `NEXTAUTH_SECRET` and redeploy, so sessions issued while the old host was the app are worthless (§4.4). Then prove a fresh login.

**Rollback** for step 6: remove the host from the site project and re-add it to the app project with `gitBranch: v2.6`. No DNS change, no data change.

## 6. Production: what remains (NOT done)

### 6.1 Prerequisites outside this lane

- Production still serves `main` (2026-07-27, pre-P1, pre-Stage A). The app code proven here exists only on v2.6. Production needs the v2.6 promotion first (`docs/operations/production-cutover-plan.md`).
- **`NEXTAUTH_SECRET`:** the Production record is today ONE record shared with generic Preview, and Production predates P1 (`environment-separation.md` §6). Promotion of v2.6 needs its own Production rotation for that reason. The domain move needs one more, right after the apex moves (§6.2 step 10; plan §16.2). Apex-era `__Host-` cookies are host-only to `fourthmeridian.com` and would otherwise be sent to the public-site project for their whole lifetime.

### 6.2 Steps (Production equivalents of §5)

1. NameBright: `CNAME app → cname.vercel-dns.com` (the wildcard currently catches `app.`). Attach `app.fourthmeridian.com` to fintracker1 (Production, no branch) and issue the certificate.
2. Plaid allowlist: add `https://app.fourthmeridian.com/plaid-oauth-return`.
3. Production env on fintracker1: `NEXTAUTH_URL` = `NEXT_PUBLIC_APP_URL` = `https://app.fourthmeridian.com`, `NEXT_PUBLIC_SITE_URL` = `https://fourthmeridian.com`. Deploy. The app serves both hosts; on the apex the public-site redirects are inert (self-origin).
4. Prove the app on `app.fourthmeridian.com` (the §4.3 matrix).
5. Decide the apex window: between step 3 and step 7, users can still sign in on the apex, and those cookies would follow the apex to the site. Keep the window short, or 308 the apex's auth/app paths to `app.` first (plan §12 C2).
6. fourth-meridian-site Production env already names `https://fourthmeridian.com` / `https://app.fourthmeridian.com` (records exist; values must be checked at that time). Its production branch is `main`, so `site/` must be on `main`. Deploy to Production.
7. Move `fourthmeridian.com` (and `www` if wanted) from fintracker1 to fourth-meridian-site. Mail DNS (MX/SPF/DKIM/DMARC) is NameBright-side and is not touched by a Vercel project move; verify after.
8. Existing Plaid Items keep their per-Item webhook URL `https://fourthmeridian.com/api/plaid/webhook`. After step 7 that path is the static site (404). Plan §16.3: run `/item/webhook/update` for every Production Item **before** step 7 (no tooling exists yet). Polling crons back it up meanwhile.
9. Crons are bound to the fintracker1 project, not a host: unaffected.
10. **Immediately after step 7:** rotate the Production `NEXTAUTH_SECRET` and redeploy fintracker1 (the §4.4 rehearsal, in the same order: after the move, so no apex-issued cookie survives it). Every user signs in again. Then prove a fresh login + TOTP on `app.`. This is in addition to any rotation done earlier at the v2.6 promotion for the shared-secret reason (§6.1).

### 6.3 Known operational gaps found here

- **Preview "rehearsal" ≠ Production in four respects:** Production custom domains are NOT behind Vercel SSO (Preview ones are), so Production's public host faces the open internet. Production's site project builds from `main`. Production Plaid webhooks are live (Preview's are blocked by SSO; accepted). Production has real users whose sessions the rotation ends.
- The Preview probe row `fm-preview-domain-split-probe@example.com` (BetaAccessRequest, PENDING) was left in place; delete it if wanted.
- Failed `/api/auth/pre-login` attempts (wrong password) write no `LOGIN_FAILED` audit row; only the credentials callback audits. Observability gap, not a boundary issue.

- **FIXED 2026-10-07: the site's Ignored Build Step looked only at the tip commit** (`git diff --quiet HEAD^ HEAD -- .`). A push whose last commit did not touch `site/` skipped the site build even when earlier commits in the push did (it happened here: `cf7323a` was deployed by the API with a per-deployment override). fourth-meridian-site (only; fintracker1 has no ignore step and was not changed) now uses:

  ```sh
  [ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- . 2>/dev/null; [ $? -eq 0 ] && exit 0 || exit 1
  ```

  - **Vercel semantics (docs, confirmed live):**
    - The command runs in the Root Directory (`site`), so `-- .` is the `site/` scope; `-- site/` would mean `site/site`.
    - Exit `0` ⇒ CANCELED; exit `1` ⇒ build.
    - `VERCEL_GIT_PREVIOUS_SHA` is the last *successful* deployment for this project and branch, and is empty on a branch's first deployment. It counts API-created deployments: the first live run reported `cf7323a`.
    - The clone is shallow (`--depth=10`).
  - **🚨 Any other non-zero exit marks the deployment ERROR, not "build"**, contrary to Vercel's KB ("1 or greater builds"). The plain `git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- .` hit this live: previous `cf7323a` was not in the 10-deep clone of `3ff9e0f` ⇒ `fatal: bad object` (128) ⇒ ERROR. The final form maps every git failure to exit 1 ⇒ build. It fails safe: an unknown previous SHA, an empty one, or one older than the clone depth all build.
  - **Live proofs (Preview, site project, API deployments on ref v2.6):**

    | Deployment | Previous SHA | Range | Result |
    |---|---|---|---|
    | `60af144` (four times) | `cf7323a` | no `site/` change | CANCELED, "the Ignored Build Step command returned exit code 0" |
    | `3ff9e0f` | `cf7323a`, not in clone | — | first form: **ERROR**; final form: READY (fail-safe build) |
    | `6c7cea5` | `3ff9e0f` (its parent, in clone) | `site/` changed | READY (diff-path build) |
    | `60af144` | `6c7cea5`, outside depth 10 | contains `site/` changes, tip commit does not | READY (fail-safe build); `preview.` back on the tip, `dpl_ECSQL23GRQdKZoc1qu8REJjwWWsv` |
    | `60af144` | `60af144` | empty | CANCELED |

    Local, same command in a depth-10 clone: `cf7323a..60af144` ⇒ 0; `553d9b3..3c12c47` (`site/` changed in `6c7cea5`, the tip does not touch `site/`) ⇒ 1, where the old tip-only command gave 0; `6c7cea5..3c12c47` ⇒ 0; empty ⇒ 1; unknown SHA ⇒ 1.
  - **Cost:** after more than 10 app-only commits since the last successful site deployment, the next push rebuilds the site once (fail-safe), and that build resets the previous SHA.
  - **Note:** this project setting is not per-environment. It also governs the site project's Production builds from `main`, which today has no Production deployment or domain.
- The legacy-path forwarder is client-side (static export). It covers browsers following old links, not API clients. Server-side 308s on the public host would need a runtime on the site (plan §18.6 option a).
- `GET /api/plaid/link-token` is a GET that calls Plaid. A sibling page can trigger it with the victim's Lax cookie but cannot read the response (no CORS). This is not a data or authority leak. It is the plan §16.1 "GET must be safe" residual, now named.
