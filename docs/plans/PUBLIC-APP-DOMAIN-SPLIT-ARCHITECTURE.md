# Public site / authenticated app domain split: architecture investigation

| | |
|---|---|
| **Status** | Investigation complete. Verdict: **ARCHITECTURE READY FOR IMPLEMENTATION** (Stages A and B). Stages C and D are gated on owner-confirmed dashboard facts (§15). |
| **Date** | 2026-10-02 |
| **Repo state investigated** | `v2.6` at `3d10fe7`, with the RLS tenant-authority conversion in flight in the working tree |
| **Method** | Read only. The repo was read with no edits, no app/test/DB/network runs, no Vercel/DNS/Supabase/Plaid changes, and no secret values read. |
| **Scope** | Separate `fourthmeridian.com` (public website) from `app.fourthmeridian.com` (authenticated wealth-management app) |
| **Not in scope** | The RLS readiness decision. This document does not judge it, and nothing here depends on it except where stated. |

File references (`path:line`) are as of `3d10fe7`. Line numbers in files the RLS conversion has since edited may have drifted.

---

## Owner-confirmed domain state (recorded 2026-10-02, after the investigation)

The owner has confirmed the following. They are authoritative and override any repo-derived guess below:

- **`fourthmeridian.com`** = current **Production** Fourth Meridian application.
- **`preview.fourthmeridian.com`** = current **Preview** Fourth Meridian environment.

The investigation (§3, §10) derived Production-on-apex from repo evidence. That is now **confirmed**.

The investigation's Preview design (§10) assumed Previews live only on `*.vercel.app`. **That assumption is false.** Preview is served under the Production registrable domain. The consequences are analysed in the addendum (§16), which supersedes §10 where they conflict. Neither domain is being modified as part of this document.

---

## Summary

**Recommendation:**
- Keep the existing Next app, and the backend it owns, exactly where it is, and attach it to `app.fourthmeridian.com`.
- Add a small, self-contained Next app in a new subdirectory of the same repo (proposed: `site/`). It gets its own Vercel project and **holds zero secrets**.
- The app's session cookie stays host-only on the app. The public site never receives it.
- The public site shows one static "Open Fourth Meridian" link, and the app decides where that link lands.
- An optional, non-secret "signed-in" hint cookie may change the button label. It grants nothing.
- No `api.fourthmeridian.com`.

**Five pre-existing defects must be fixed before any split (Stage A, §12):**
1. **Open redirect after login.** `/login?callbackUrl=//evil.com` sends the user to evil.com once they sign in.
2. **Session cookie can be overwritten from another subdomain.** Once `fourthmeridian.com` is a separate deployment, it could plant its own session cookie on `app.fourthmeridian.com` and log a victim into the attacker's account (login CSRF).
3. **API writes have no Origin check.** Once the public site is a separate deployment, it is a *same-site* origin whose requests carry the app's cookies.
4. **Existing Plaid Items store an apex webhook URL.** Plaid stores the webhook per Item at creation, so those webhooks would stop arriving once the apex moves.
5. **`/api/access-request` runs on the migration-capable `postgres` role.** This is the broadest database role (BYPASSRLS). It is an RLS-workstream item, not part of this split.

---

## 1. Current topology

**Stack:** Next 16.2.7, React 19.2.4, App Router, `next-auth` 4.24.14, Prisma 5.22 (`package.json`, `node_modules/next-auth/package.json:3`). There is no `middleware.ts`; `proxy.ts` replaces it (Next 16, `proxy.ts:2`).

**One Next app serves everything** from the repo root `app/`:

| Route group | What it serves |
|---|---|
| `app/(public)/` | Marketing: `/`, `/about`, `/security`, `/privacy`, `/terms`, `/legal/ai`, `/request-access` (`app/(public)/layout.tsx:1-15`) |
| `app/(auth)/` | `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`, `/confirm-email-change`. The layout is presentation only, with no session read (`app/(auth)/layout.tsx:9-11`). |
| `app/(shell)/dashboard/**` | The authenticated app. There is no top-level `/investments`; deep links are `/dashboard/...` plus query state (`proxy.ts:55-61`). |
| `app/admin/**` | SYSTEM_ADMIN area, with a server-side role check (`app/admin/layout.tsx:21-22`) |
| `app/merchant-ops`, `app/plaid-oauth-return` | Outside the proxy matcher |
| `app/api/**` | About 40 route families: AI, Plaid, jobs, auth, spaces, transactions and so on |

**A seam for splitting the marketing pages out already exists.** `lib/marketing-boundary.test.ts:1-60, 125-158` enforces an import allowlist so that `app/(public)`, `components/marketing`, `content/marketing` and `lib/marketing` never import Prisma, auth or app code. The file states this exists so the tree "can split into its own repo/deploy later". The marketing tree's only server dependency is `POST /api/access-request` (`lib/marketing/request-access.ts:25,65`).

**Middleware (`proxy.ts`):**
- The matcher covers only `/dashboard/:path*` and `/admin/:path*` (`proxy.ts:116-121`). It never runs on `/api/*`.
- It checks that the JWT signature is valid (`getToken`, `proxy.ts:43-46`). It does **not** check whether the session has been revoked.
- With no token, it redirects to `/login?callbackUrl=<path+query>` (`proxy.ts:52-63`).
- It also handles role routing (`:67-75`) and TOTP-enrolment routing (`:94-111`).
- API authorization is done separately, in `lib/session.ts` (`proxy.ts:25-31`).

**Database principals** (`lib/db.ts:42-120`, `lib/db/strict-mode.ts`):

| Client | Database role | Env var | Used for |
|---|---|---|---|
| `db` (legacy) | Currently `postgres`, which has BYPASSRLS (`docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md:265-272`) | `DATABASE_URL` | Still imported by many API route files at investigation time, including the Plaid webhook, jobs and `access-request`. The RLS conversion is reducing this. |
| `tenantDb` | `fm_app` | `DATABASE_URL_APP` | Requests subject to RLS, through `withTenantDb` |
| `authDb` | `fm_auth` | `DATABASE_URL_AUTH` | The pre-identity step: credential and revocation checks only (`lib/auth.ts:25-30`) |
| `systemDb` | `fm_system` | `DATABASE_URL_SYSTEM` | Cron, webhooks, operator consoles |
| Migrations | `postgres` | `DIRECT_URL` | Prisma `directUrl` (`prisma/schema.prisma:12`). Vercel does not run `migrate deploy` (`docs/operations/rls-preview-cutover.md` §1). |

Each role client falls back to `db` when its URL is unset, unless `FM_RLS_STRICT=true` (`lib/db.ts:60-66`).

**Background jobs:** `vercel.json` defines crons for `/api/jobs/dispatch` and `/api/jobs/resume-stale-imports`, region `sin1`. They are protected with `Authorization: Bearer CRON_SECRET` (`app/api/jobs/dispatch/route.ts:21-22,51`).

**External callbacks:**
- Plaid webhook: `app/api/plaid/webhook/route.ts`, verified by Plaid's JWT signature (`plaid-verification` header), so it does not depend on the hostname.
- Plaid OAuth return page: `app/plaid-oauth-return/page.tsx`, which relies on same-origin `localStorage` (`:51-53`).
- There are no OAuth login providers. Login is credentials only (`lib/auth.ts:6`).
- There are no server actions (none found in `app`, `lib` or `components`).

**Map:**
```
Browser ──> fourthmeridian.com (one Vercel project, one Next app)
  ├─ proxy.ts (JWT signature only; /dashboard, /admin)
  ├─ (public) marketing  ──fetch──> /api/access-request ──> db (postgres!) + Turnstile + Resend
  ├─ (auth) pages ──> /api/auth/pre-login, /api/auth/[...nextauth] ──> authDb(fm_auth)
  ├─ (shell)/dashboard, /admin RSC ──> lib/session.ts ──> tenantDb / db / systemDb
  └─ /api/** (same-origin fetch, cookie auth) ──> Postgres (Supabase pooler)
                                              ──> Plaid, OpenAI, Alchemy/Etherscan/Helius/RPC,
                                                  Tiingo/CoinGecko/OXR, Resend, Turnstile, Sentry
Inbound: Vercel Cron ──> /api/jobs/*   Plaid ──> /api/plaid/webhook   Plaid OAuth ──> /plaid-oauth-return
```

## 2. Current auth and cookie model

- **Sessions:** JWT strategy, 30-day max age (`lib/auth.ts:687-690`). Each login also writes a `UserSession` row with a random `sessionToken` (`:496-506`).
- **Revocation:** checked in the `session` callback with a 30-second cache (`:558-645`). It is enforced only where `getServerSession` runs, **not** in `proxy.ts`.
- **Logout:** `events.signOut` marks the session row revoked (`:657-679`). The UI calls `signOut({redirect:false})` and then navigates to `/login` (`components/ui/UserMenu.tsx:117-125`, `UserButton.tsx:82`).
- **Cookies:** there is no `cookies` override, so NextAuth defaults apply (`node_modules/next-auth/core/lib/cookie.js:18-61`):
  - session: `__Secure-next-auth.session-token`
  - callback URL: `__Secure-next-auth.callback-url`
  - CSRF: `__Host-next-auth.csrf-token`
  - All are HttpOnly, SameSite=Lax, Path=/, with **no Domain attribute** (host-only).
- **Secure-cookie decision:** based on whether `NEXTAUTH_URL` starts with `https://`, otherwise `!!VERCEL` (`node_modules/next-auth/jwt/index.js:65-66`, `core/init.js:60`).
- **Origin detection:** on Vercel, NextAuth takes its origin from `x-forwarded-host`, not `NEXTAUTH_URL` (`node_modules/next-auth/utils/detect-origin.js`). Auth therefore already works on any host attached to the project.
- **Default `redirect` callback (no override):** relative paths are allowed, and absolute URLs only if they share the current origin (`core/lib/default-callbacks.js:11-15`).
- **Login page** (`app/(auth)/login/page.tsx`):
  - Client component. Calls `/api/auth/pre-login`, then `signIn("credentials", {redirect:false})` (`:126, 281-291`).
  - Then `dest = callbackUrl.startsWith("/") ? callbackUrl : "/dashboard/brief"` and `router.push(dest)` (`:323-325`).
  - **🚨 This is an open redirect.** `//evil.com` and `/\evil.com` both pass `startsWith("/")`. The Next router treats the result as external and does a full navigation to it (`node_modules/next/dist/client/components/router-reducer/reducers/navigate-reducer.js:34-35`). No test covers it.
  - **A signed-in user visiting `/login` still sees the form.** There is no session check, and the proxy matcher excludes `/login`.
- **2FA (TOTP / recovery codes):** handled inside `authorize()`. Mandatory for SYSTEM_ADMIN (`lib/auth.ts:9-15`). Pending enrolment is routed by `proxy.ts:94-111`.
- **Other cookies, all host-only:**
  - `fm_ai_state`: HttpOnly, Lax, `Path=/api/ai/chat`, AES-GCM (`app/api/ai/chat/route.ts:223-229`)
  - `fm_active_space`: not HttpOnly, readable by page scripts (`app/api/space/switch/route.ts:106-112`)
  - `fm_ai_transcript`: hint cookie written by page scripts (`components/ai/transcript-cache.ts:59,276`)
- **CSRF on the app's own API:** relies only on SameSite=Lax. There are no Origin or Host checks and no CORS anywhere (grep found none). 65 route handlers call `req.json()` without checking the content type. `docs/operations/security-checklist.md:240-241` already lists "add Origin check" as needed work.
- **Revoked sessions lose the deep link.** A revoked-but-signed JWT passes `proxy.ts`. The page then calls `redirect("/login")` with no `callbackUrl`, e.g. `app/(shell)/dashboard/spaces/page.tsx:43` and `lib/settings/loaders.ts:62`.
- **The auth flow is same-origin throughout.** It cannot span `fourthmeridian.com` and `app.fourthmeridian.com` without explicit changes, and per §8 it should not.

## 3. Current domain assumptions

**Proven from the repo:**
- **Production is on `fourthmeridian.com`** (now owner-confirmed).
  - `docs/architecture/SPACE_MOUNT_DOCTRINE.md:200` names "production `fourthmeridian.com`".
  - `docs/plans/Sentry-Production-Health-Investigation.md:239` reports Sentry events carrying a `fourthmeridian.com` URL.
  - `lib/plaid/redirect-uri.ts:14` refers to the "fourthmeridian.com custom domains", plural.
- **No hostname is hardcoded in runtime code.** Every absolute URL comes from `NEXT_PUBLIC_APP_URL`:
  - `app/layout.tsx:6` (metadataBase)
  - `lib/env.ts:506`
  - Email links: reset, verify, email-change, beta-invite, space-invite, notification action URLs (`lib/notifications/channels/email.ts:24-27,43`), the access-request queue link (`app/api/access-request/route.ts:106`)
  - Plaid `redirect_uri` (`lib/plaid/redirect-uri.ts:108-114`) and Plaid webhook (`app/api/plaid/link-token/route.ts:46-53`)
- **Production refuses to boot** without `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `RESEND_API_KEY`, `CRON_SECRET` and `NEXT_PUBLIC_SENTRY_DSN`. Production is detected by `VERCEL_ENV`, not `NODE_ENV` (`lib/env.ts:233-241, 286-300`).
- **Headers** (`next.config.ts:26-63`):
  - HSTS with `includeSubDomains` (Production only)
  - X-Frame-Options DENY
  - CSP is **report-only**: `connect-src 'self'` plus Plaid and TradingView, and `form-action 'self'`. Turnstile (`challenges.cloudflare.com`) is not listed. That is harmless while the CSP is report-only.
- **No redirects or rewrites** in `next.config.ts`. `vercel.json` has only `regions` and `crons`.
- **Preview has its own Supabase project** (`docs/operations/rls-preview-cutover.md` §0).
- **Sender email domain** is `@fourthmeridian.com` (`lib/email/senders.ts:35-51`). This depends on DNS mail records, not the web host.
- **Stale doc:** `docs/operations/deployment.md:102-136` still tells you to set `PLAID_REDIRECT_URI` and `DIRECT_URL` in Vercel for Production and Preview. This contradicts `lib/plaid/redirect-uri.ts:34-38` ("must NOT be set in Vercel").

**Owner must check in dashboards** (the repo cannot show these):
- Current Production values of `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL`. The local `.env.preview` pull shows them empty, which is consistent with Sensitive variables.
- Whether `www.fourthmeridian.com` exists and where it points.
- Which domains are attached to the Vercel project. Owner has now confirmed `fourthmeridian.com` (Production) and `preview.fourthmeridian.com` (Preview).
- Who hosts DNS.
- Whether Cloudflare proxies traffic. `lib/api.ts:29` trusts `cf-connecting-ip`.
- Whether `DIRECT_URL` or `SHADOW_DATABASE_URL` exist in the Vercel runtime env.
- Whether team-level Shared Environment Variables exist.
- The Plaid allowed redirect URIs.
- The Turnstile hostname allowlist.
- Sentry allowed domains.
- Whether Preview's `PLAID_*` keys are sandbox keys.

## 4. Hostname-sensitive integrations

| Integration | Where in the repo | How the host is set |
|---|---|---|
| NextAuth base URL | `lib/auth.ts`, `NEXTAUTH_URL` | Detected from the request host on Vercel. Env decides the Secure prefix. |
| Email links (reset, verify, change, invite, notification, security alert) | `lib/email/*-url.ts`, `lib/security/anomaly-alerts.ts:198` | `NEXT_PUBLIC_APP_URL`, built at send time. Notification `href`s are stored relative (`lib/notifications/registry.ts:131`). |
| Plaid `redirect_uri` | `lib/plaid/redirect-uri.ts` | `NEXT_PUBLIC_APP_URL + /plaid-oauth-return`. Must be on Plaid's allowlist. |
| Plaid webhook | `app/api/plaid/link-token/route.ts:46-53,216` | `NEXT_PUBLIC_APP_URL + /api/plaid/webhook`. **Plaid stores it per Item when the connection is created.** Nothing in the repo calls `/item/webhook/update` (grep found none). |
| Plaid OAuth return | `app/plaid-oauth-return/page.tsx:51` | Needs the link token in **`localStorage` on the same origin** |
| Turnstile | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` on login, register, request-access | Cloudflare hostname allowlist |
| Access-request form | `lib/marketing/request-access.ts:25` | Relative `/api/access-request` |
| Register page legal links | `app/(auth)/register/page.tsx:245,412,414` | Relative `/request-access`, `/terms`, `/privacy` |
| PWA manifest | `public/manifest.json` `start_url: "/dashboard"` | Relative |
| Cron | `vercel.json` | Bound to the project, not a hostname |
| HSTS `includeSubDomains` | `next.config.ts:47-49` | Sent by whichever project serves the apex |

## 5. Recommended target architecture

```
fourthmeridian.com, www  ─> Vercel project "fm-site"  (Root Directory: site/; zero secrets)
                              static/SSG marketing, legal; redirects for app paths;
                              transitional rewrite: /api/plaid/webhook -> app (see §16.3: unproven)
app.fourthmeridian.com   ─> EXISTING Vercel project (repo root, unchanged layout)
                              all auth, all /api/**, crons, Plaid webhook + OAuth return,
                              tenantDb/authDb/systemDb; sole holder of financial authority
(no api.fourthmeridian.com)
Preview: see §16.1 (supersedes the original "*.vercel.app only" design in §10)
```

## 6. Why this fits the actual repo

**Options compared:**

- **Option 1: one Next app serving both hosts, routed by host in middleware. Rejected.**
  - The apex runtime would carry every secret, including `DATABASE_URL`, which today is `postgres` with BYPASSRLS.
  - A compromised marketing page would mean full authority. This is the opposite of least authority.
- **Option 2: monorepo with `apps/web` and `apps/app`. Rejected.**
  - It moves the whole existing app in the middle of the RLS conversion.
  - It breaks every root-relative path that scripts, audits and CI rely on: `scripts/run-tests.ts:30` searches `lib/ app/ components/ jobs/ scripts/`, and `scripts/ci-local.ts` and `.github/workflows/ci.yml` run steps at the root.
  - It changes the Root Directory of the production Vercel project.
  - All of that is churn for tidiness.
- **Option 3: a separate repo. Workable, but no better than Option 4.**
  - It loses the CI-enforced boundary (`lib/marketing-boundary.test.ts`).
  - It loses the single place where design tokens and marketing copy evolve.
  - It brings no security gain over Option 4, because secrets live per Vercel project, not per repo.
- **Option 4 (recommended): a self-contained Next app in `site/` with its own package.json, lockfile, tsconfig and vercel.json, and its own Vercel project with Root Directory = `site/`.**
  - The repo already has precedent: root `tsconfig.json` excludes `prototype`, which holds "standalone Next apps with their own tsconfig/package.json".
  - The marketing tree was built to move: there are no `@/lib` imports to untangle.
  - The root `vercel.json` (with crons) does not apply to a project rooted at a subdirectory.
  - CI impact is limited to:
    - excluding `site/` from root tsconfig and eslint;
    - repointing `MARKETING_ROOTS` in `lib/marketing-boundary.test.ts:125` to `site/` and asserting that no `site/` file imports anything outside `site/`;
    - optionally adding a `site/` build step.
  - Deployment independence comes from Vercel's Ignored Build Step being scoped per directory.

**No reason today for `api.fourthmeridian.com`:**
- Every API consumer is the app's own browser code making same-origin cookie requests.
- No mobile app, third-party client or CORS consumer exists.
- Webhooks and crons already live in the app.

A separate API host would add credentialed cross-origin requests, more cookie scope and more CSRF surface, for nothing in return. The app keeps owning its backend.

## 7. Public site authority and secret boundary

| Env names / authority class | Public site | Auth app (prod) | Migration (operator terminal only) | Background |
|---|---|---|---|---|
| `NEXT_PUBLIC_APP_ORIGIN` (new), `NEXT_PUBLIC_SITE_URL` (new), `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, optional separate Sentry DSN | **yes (only these)** | site URL only | – | – |
| `DATABASE_URL` (legacy; postgres today) | **NO** | yes, until RLS finishes | yes | (app) |
| `DATABASE_URL_APP` / `_AUTH` / `_SYSTEM`, `FM_RLS_STRICT` | **NO** | yes | – | system |
| `DIRECT_URL`, `SHADOW_DATABASE_URL`, `SEED_*_PASSWORD`, `FM_DB_GUARD` | **NO** | **should be NO** (owner verify) | yes | – |
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | **NO** | yes | – | – |
| `ENCRYPTION_KEY` (Plaid tokens, AI state cookie) | **NO** | yes | as needed | yes |
| `PLAID_CLIENT_ID` / `SECRET` / `ENV` / `WEBHOOK_URL` | **NO** | yes | – | yes |
| `OPENAI_API_KEY`, `AI_*` | **NO** | yes | – | – |
| `TIINGO_API_KEY`, `COINGECKO_*`, `OXR_APP_ID` | **NO** | yes | – | yes |
| `ALCHEMY` / `ETHERSCAN` / `HELIUS_API_KEY`, `ETH_RPC_URL`, `SOL_RPC_URL`, `BTC_*` | **NO** | yes | – | yes |
| `RESEND_API_KEY`, `*_EMAIL` | **NO** | yes | – | yes |
| `TURNSTILE_SECRET_KEY` | **NO** (access-request verification stays in the app) | yes | – | – |
| `CRON_SECRET` | **NO** (and no crons) | yes | – | yes |
| `MERCHANT_OPS_SPACE_ID`, `DISABLE_SYSTEM_ADMIN`, feature flags | **NO** | yes | – | – |

Background work stays in the app project. Nothing justifies a separate deployment for it.

**`/api/access-request` stays in the app.** The public form posts across origins to `https://app.fourthmeridian.com/api/access-request`:
- CORS allows exactly the site origin, with **no credentials**.
- Do not proxy it through a Vercel rewrite yet. A rewrite may replace the client IP with Vercel's egress IP, which would break `limitByIp` (`app/api/access-request/route.ts:42`). That is unproven, so verify before relying on either path.
- Separately, the RLS workstream should move this route off `db` (`:27,86`) onto a narrow principal. This is an RLS item, not part of this split.

## 8. Session design

**A. One session cookie on the parent domain (`Domain=fourthmeridian.com`). Rejected.**
- The public deployment would receive the full session JWT on every request.
- To check it, the public site would need `NEXTAUTH_SECRET`. Anyone holding that secret can mint a session for any user, which is full financial authority.
- Even if it only checked that the cookie exists, it would still receive the credential and could log or leak it.
- Logout and revocation semantics stay the same, but the attack surface spreads to every subdomain.

**B1. App-only cookie plus a static "Open Fourth Meridian" link to `https://app.fourthmeridian.com/dashboard`. Recommended baseline.**
- The public site holds no authority and needs no CORS.
- Signed-in users go straight to the dashboard. Signed-out users get the proxy redirect to `/login?callbackUrl=/dashboard`.
- Works the same on Preview.

**B2. B1 plus a non-sensitive hint cookie. Optional, after B1.**
- The app sets `fm_signed_in=1; Domain=fourthmeridian.com; Secure; SameSite=Lax; Max-Age ≤ session` at login and clears it on logout.
- The public site reads it only to switch the button label between "Sign in" and "Open dashboard". The link target is the same either way.
- It cannot be used to forge anything: a fake or stale value only changes a label, and the app re-checks the real session.
- No user id or email goes in it.
- Never set it on Preview. §16.1 covers the Preview domain question.

**B3. A credentialed CORS request from the public site to an app session endpoint. Rejected.**
- This creates an endpoint that public-origin JavaScript can read with the user's cookies, so an XSS on the public site could read whatever it returns.
- It gives strictly more surface than B2 for the same UX.

**C. Hardening that is required whichever option is chosen.** Because `fourthmeridian.com` and `app.fourthmeridian.com` are **same-site** (same registrable domain), SameSite=Lax does not protect the app from the public origin.

1. **Rename the session cookie to `__Host-next-auth.session-token`** via NextAuth's `cookies` option, and pass the same `cookieName` to `getToken` in `proxy.ts:43`.
   - The `__Host-` prefix forbids a Domain attribute, so the apex cannot plant a cookie with that name on the app host.
   - Without this, the apex could plant `__Secure-next-auth.session-token; Domain=fourthmeridian.com`. That would log a victim into the attacker's account, where the victim might then connect a real bank.
   - Do the same for the callback-url cookie.
2. **Add an Origin / `Sec-Fetch-Site` check for state-changing `/api/**` requests.**
   - Require `Sec-Fetch-Site: same-origin` or an Origin equal to the app origin.
   - Exempt `/api/plaid/webhook`, `/api/jobs/*`, `/api/auth/*` (NextAuth has its own CSRF protection) and the CORS-allowlisted `/api/access-request`.
   - Placing it in `proxy.ts` avoids touching the `app/api/**` files the RLS workstream is editing.
3. **Logout:**
   - Current revocation and cookie clearing stay as they are (`lib/auth.ts:657-679`).
   - Also clear `fm_signed_in` (if B2) and the existing `clearAllTranscripts()`.
   - Optionally expire `fm_active_space`.
   - The public site has nothing of its own to clear.

## 9. Exact logged-out and logged-in behaviour

| URL | Logged out | Logged in |
|---|---|---|
| `fourthmeridian.com/` | Marketing; buttons "Sign in" → `app.fourthmeridian.com/login`, "Get Started" → `/request-access` | Same page. Button "Open Fourth Meridian" → `app…/dashboard` (label switches only with B2). |
| `fourthmeridian.com/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`, `/confirm-email-change` | 308 to the same path and query on `app.` (keeps already-emailed links working) | same |
| `fourthmeridian.com/dashboard/*`, `/admin/*`, `/plaid-oauth-return`, `/merchant-ops` | 308 to the same path and query on `app.` | same |
| `fourthmeridian.com/logout` | Does not exist today; do not add it | – |
| `app.fourthmeridian.com/` | Proxy → `/login?callbackUrl=/dashboard/brief` | → `/dashboard/brief` |
| `app.fourthmeridian.com/login` | Form | A **server-side** check via `getServerSession`, which includes revocation, redirects to the safe `callbackUrl` or `/dashboard/brief`. Do not do this in `proxy.ts`: it only checks the JWT signature, so a revoked session would bounce between `/login` and `/dashboard` forever. |
| Protected deep link, e.g. `app…/dashboard/spaces?tab=x` | → `/login?callbackUrl=%2Fdashboard%2Fspaces%3Ftab%3Dx`, then back there after login and TOTP | Served |
| Expired JWT | Same as logged out (proxy), deep link kept | – |
| Revoked session (JWT still valid) | Page calls `redirect("/login")`. **Change it to include `callbackUrl`.** | – |
| Logout | Revoke the session row, clear the cookie and hints, go to `app…/login` (or the apex `/`) | – |

**Return-to validation.** One shared helper should:
- accept only a relative path;
- reject anything starting with `//`, `/\`, or containing control characters or encoded slashes/backslashes;
- confirm `new URL(dest, appOrigin).origin === appOrigin`;
- default to `/dashboard/brief`.

Cross-host `callbackUrl`s are never accepted. They are not needed, because the public site only links to app paths and the app adds `callbackUrl` itself. Optionally, the proxy can protect everything by default on the app host, so that new top-level routes are protected automatically.

## 10. Preview design (original; see §16.1 for the revision)

> **Superseded in part.** This section was written before the owner confirmed that Preview is served on `preview.fourthmeridian.com`. It is kept as the investigation's reasoning of record. §16.1 analyses the real Preview domain and replaces the recommendations below where they conflict.

- **Keep both projects' Previews on `*.vercel.app`.** `vercel.app` is on the Public Suffix List, so each preview deployment is its own site. It can neither plant cookies on nor send same-site requests to production `*.fourthmeridian.com` hosts.
- **Do not create `preview.fourthmeridian.com`-style aliases.** Any preview running branch code under `fourthmeridian.com` would be same-site with production. If stable preview hosts are wanted, put them under a separate registrable domain.
- **App Preview:** NextAuth picks up the request host on Vercel, so login works on each preview URL. Preview keeps its own `NEXTAUTH_SECRET`, Supabase project, sandbox Plaid keys and `NEXT_PUBLIC_APP_URL`. Owner should confirm every one of these differs from Production. Plaid's sandbox redirect allowlist must include the preview origin, which is already an open backlog item.
- **Public site Preview:** `NEXT_PUBLIC_APP_ORIGIN` = a stable app preview URL, **never** production. It holds no secrets, so it cannot leak any. It gets no hint cookie.

## 11. Callback and webhook migration matrix

| Item | Current behaviour | Target host | Code change? | Owner dashboard change? |
|---|---|---|---|---|
| NextAuth routes `/api/auth/*` | Same-origin, host detected | app | `__Host-` cookie rename; server-side check on `/login` | `NEXTAUTH_URL` = `https://app.fourthmeridian.com` (Prod) |
| Login `callbackUrl` | `startsWith("/")`, open redirect | app | **Yes**, safe-path helper | No |
| Reset / verify / email-change / invite / notification email links | `NEXT_PUBLIC_APP_URL` | app | No | `NEXT_PUBLIC_APP_URL` = `https://app.fourthmeridian.com`; public site redirects old links |
| Plaid `redirect_uri` | Derived from `NEXT_PUBLIC_APP_URL` | app | No | **Add `https://app.fourthmeridian.com/plaid-oauth-return` to Plaid allowed redirect URIs *before* changing the env.** Doing it the other way round repeats the 146a0dd outage. |
| Plaid webhook (new connections) | Derived from `NEXT_PUBLIC_APP_URL` | app | No | Env change only |
| **Plaid webhook (existing connections)** | Stored per Item at `fourthmeridian.com/api/plaid/webhook` | app | **Yes**: an operator script calling `/item/webhook/update` for every Item, run by the owner. Plus a possible transitional public-project rewrite (§16.3). Polling crons back this up. | Run the script; verify rewrite behaviour (§16.3) |
| Plaid OAuth return, in flight at cutover | `localStorage` on the apex | app | Public site redirects | Those few sessions must restart Link (`localStorage` does not cross origins) |
| Turnstile (login, register, request-access) | Site key on the apex | site + app | No | Add `app.fourthmeridian.com` to the Cloudflare hostname allowlist |
| Access-request POST | Relative, same-origin | app API, CORS from apex | **Yes** (CORS + `NEXT_PUBLIC_APP_ORIGIN` in the site) | No |
| Register page `/terms`, `/privacy`, `/request-access` | Relative | site | **Yes**, absolute links to `NEXT_PUBLIC_SITE_URL` | No |
| CSP | Report-only, `'self'` | both | Site needs its own CSP (connect-src app origin, Turnstile). App: add Turnstile. | No |
| HSTS `includeSubDomains` | Sent by the app on the apex | both | Site sends HSTS too | No |
| Vercel cron | Project-bound | app | No | Ensure the site project has no crons |
| Sentry | Single DSN | app (+ optional site DSN) | No | Allowed domains |
| metadataBase / OG | `NEXT_PUBLIC_APP_URL` | site: `NEXT_PUBLIC_SITE_URL` | Site sets its own | No |
| Email DNS (SPF / DKIM / DMARC, MX) | Apex DNS | unchanged | No | Verify that moving the apex between Vercel projects leaves mail records untouched |

## 12. Staged migration plan

**Stage A: inside the current deployment, nothing externally visible.**
1. Add a safe `callbackUrl` helper with a unit test (cases: `//`, `/\`, encoded variants).
2. Add a server-side redirect for signed-in users on `/login`.
3. Include `callbackUrl` in the page-level `redirect("/login")` calls.
4. Rename the session cookie to `__Host-` (one forced re-login for everyone).
5. Add an Origin / `Sec-Fetch-Site` check for state-changing `/api/**` requests.
6. Add CORS for `/api/access-request` from a configured site origin.
7. Add the Turnstile domain to the CSP.
8. Make the register page's legal links absolute.

**Stage B: build the public site with no financial authority.**
1. Create `site/` and move the marketing tree into it, including the needed `globals.css` tokens.
2. Repoint the boundary test at `site/`.
3. Exclude `site/` from the root tsconfig and eslint.
4. Create Vercel project `fm-site`:
   - Root Directory `site/`
   - "Include files outside root" **off**
   - Ignored Build Step limited to `site/`
   - Env holds only the `NEXT_PUBLIC_*` values
   - Confirm no Shared Environment Variables are linked
5. Add the §9 and §11 redirects in `site/vercel.json`.
6. Verify on its `vercel.app` URL.

**Stage C: attach `app.fourthmeridian.com` to the existing project.**
1. Add the Plaid allowlist entry and the Turnstile hostname **first**.
2. Set Production `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` to the app host. Redeploy.
3. Run the Plaid `/item/webhook/update` script.
4. C2: make the app's proxy 308 the apex's auth and app paths to `app.`. The original plan also rotates `NEXTAUTH_SECRET` here; §16.2 re-classifies that step.

**Stage D: move `fourthmeridian.com` (and `www`) to `fm-site`.** The apex then serves marketing plus redirects. The app project keeps only `app.`.

**Stage E: public CTA.** Ship B1. Optionally add the B2 hint cookie later, set and cleared by the app.

**Stage F: verify.** Check the following, then remove `app/(public)` from the app and make app `/` redirect into the app:
- login, TOTP, logout
- deep-link return, revoked-session return
- the open-redirect cases
- each email link type, old and new
- Plaid Link with an OAuth bank, in update mode and new connection
- webhook arrival on the app host (logs)
- cron runs
- Preview login and isolation
- that no secret is present in `fm-site`

Remove any transitional webhook rewrite and the apex redirects only after webhook traffic to the apex is zero and old reset or invite tokens have expired.

## 13. Rollback plan

- **Stage A:** revert the commit. Undoing the `__Host-` rename forces another re-login.
- **Stage B:** delete or pause `fm-site`. Nothing points at it yet.
- **Stage C:** restore the env values and redeploy. Both hosts keep working, because NextAuth detects the host. Plaid allowlist entries are additive. Item webhooks can be pointed back with the same script, and the apex still runs the app at this stage. C2 rollback: remove the proxy redirect.
- **Stage D:** move the apex domain back to the app project. The app still contains `app/(public)` until Stage F, so marketing keeps working. Users sign in again on the apex, because cookies are host-only.
- **Stage E:** remove the hint cookie code. It is purely cosmetic.
- **Stage F cleanup:** only after a stable period. Rollback means restoring `app/(public)` from git.

## 14. Owner actions required

1. Read the current Production `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL`, attached domains, `www`, the DNS host, and whether Cloudflare proxies traffic.
2. Confirm Preview and Production use different `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, Plaid keys and DB.
3. Remove `DIRECT_URL`, `SHADOW_DATABASE_URL`, `SEED_*` and `PLAID_REDIRECT_URI` from Vercel runtime env if present.
4. Plaid dashboard: add the app-host redirect URI for Production and the Preview origins for sandbox.
5. Run the existing-Item webhook update script.
6. Turnstile: add the app host. Sentry: allowed domains.
7. Create the `fm-site` project with the settings in Stage B.
8. Decide on `NEXTAUTH_SECRET` rotation at Stage C2 (§16.2).
9. Move the domains at Stages C and D.
10. Update the stale `docs/operations/deployment.md:102-136`.

## 15. Open questions that the repo cannot answer

1. Do Plaid webhooks follow 3xx redirects? Assume not; that is why a webhook update is planned.
2. Do Vercel external rewrites keep the raw body, the `plaid-verification` header and the client IP? (§16.3)
3. Current production hostnames: is `www` canonical, and is the apex the primary domain? (Apex = Production is now owner-confirmed; `www` is still unknown.)
4. Is `DIRECT_URL` present in the Vercel runtime env, and does `prisma generate` succeed without it?
5. Which Preview hostname does the public-site Preview point to? (Now partly answered: `preview.fourthmeridian.com` exists; see §16.1.)
6. Should app `/` render anything for logged-out visitors, or always go to `/login`? Recommended: `/login`.
7. B2 hint cookie: yes or no. A product decision with no security cost.
8. Reset and invite token lifetimes, which set how long the apex redirects must stay.

None of these blocks Stage A or B. Questions 1, 2 and 3 must be answered before Stages C and D.

**Verdict of the investigation:** ARCHITECTURE READY FOR IMPLEMENTATION.

### Critical files for implementation
- `proxy.ts`
- `lib/auth.ts`
- `app/(auth)/login/page.tsx`
- `lib/marketing-boundary.test.ts`
- `app/api/plaid/link-token/route.ts`

---

## 16. Addendum: owner-confirmed domains, secret rotation, Plaid webhook cutover

*To be completed in a follow-up documentation commit. This commit preserves the investigation as delivered.*
