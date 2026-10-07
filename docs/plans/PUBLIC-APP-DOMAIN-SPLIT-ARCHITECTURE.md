# Public site / authenticated app domain split: architecture investigation

| | |
|---|---|
| **Status** | Investigation complete. Verdict: **ARCHITECTURE READY FOR IMPLEMENTATION** (Stages A and B). **Stage A implemented 2026-10-03, partially** (§16.0). **Stage B implemented 2026-10-04** (§18): `site/`, not yet a Vercel project. Stages C and D are gated on §16.7 and §18.6. **Stages C, D and F rehearsed end to end on Preview 2026-10-07** (`preview.` = public site, `preview-app.` = app; `docs/operations/domain-split-preview.md`, which also lists the exact Production steps). Production unchanged. |
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
- **`preview.fourthmeridian.com`** = current **Preview** Fourth Meridian environment: the **intentional, stable pre-production environment**, not an alias for an ephemeral deployment. It stays (§16.1).

The investigation (§3, §10) derived Production-on-apex from repo evidence. That is now **confirmed**.

The investigation's Preview design (§10) assumed Previews live only on `*.vercel.app`. **That assumption is false.** Preview is served under the Production registrable domain. The consequences are analysed in the addendum (§16.1), which supersedes §10 where they conflict. The recommended model is the stable parallel one: `fourthmeridian.com` / `app.` for Production, `preview.` / `preview-app.` for Preview. Neither domain is being modified as part of this document.

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
  - `fintracker_space` (`ACTIVE_SPACE_COOKIE`, `lib/space.ts:31`; the investigation called it `fm_active_space`, which is wrong): not HttpOnly, readable by page scripts (`app/api/space/switch/route.ts:106-112`)
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
   - Optionally expire `fintracker_space`.
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
4. C2: make the app's proxy 308 the apex's auth and app paths to `app.`, and rotate the Production `NEXTAUTH_SECRET`. §16.2 classifies the rotation as **REQUIRED** before Stage D: apex-era `__Host-` session cookies would otherwise be sent to the public site.

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
8. Rotate the Production `NEXTAUTH_SECRET` at Stage C2, and Preview's at Preview's C2 (§16.2: REQUIRED).
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

## 16. Addendum (2026-10-03): Stage A as built, stable Preview, secret rotation, Plaid cutover

This addendum records what changed after the investigation. Where it conflicts with §1–§15, it supersedes them.

### 16.0 Stage A as implemented

| Commit | Item | What changed |
|---|---|---|
| `4728c72` | A1 + A4 | `lib/auth/return-to.ts` is now the one validator for return targets. `/login` is now a server entry: a signed-in visitor goes straight to the validated target, and the client form moved to `LoginForm.tsx`. |
| `e1ea9c2` | A2 | The session and callback-url cookies are now `__Host-` (`lib/auth/session-cookie.ts`). NextAuth and `proxy.ts` share one name and one Secure decision. Legacy `__Secure-` auth cookies are expired whenever the proxy sees them. |
| `89d7a7f` | A3 | Browser-write Origin boundary (`lib/security/write-origin.ts`), enforced by `proxy.ts` on `/api/:path*` |
| `63ee425` | A3a | Fix-up: two PO-1A pins in `lib/admin-totp-enrollment-surface.test.ts` still asserted a page-only matcher, so `89d7a7f` landed with that test red. Corrected in a separate commit, not by rewriting history. |
| `0a82dd3` | A5 | Deep-link carrier (`x-fm-return-to`) plus `redirectToLogin()`. Two call sites converted; **seven deferred**. |

**Where this differs from the §12 plan:**

- **A3: the trusted origin is not configured.**
  - §8 C.2 proposed "an Origin equal to the app origin" and exemptions for `/api/auth/*` and `/api/access-request`.
  - As built, every deployment trusts **only the origin the browser addressed** (Host / X-Forwarded-Host). There is no trusted-origin env var to copy between environments, so Production and Preview cannot be configured to trust each other.
  - The only exemption is the exact path `/api/plaid/webhook`. NextAuth's own POSTs and `/api/access-request` are judged like any other browser write. Both are same-origin today, and a cross-site POST to the credentials callback is login CSRF, so neither needed an exemption.
  - `req.nextUrl.origin` was deliberately **not** used. A self-hosted Next server builds it from its own bind hostname (`next/dist/server/next-server.js` `attachRequestMeta`). The live check showed the Host-derived origin works on both `localhost` and `127.0.0.1`.
- **A5 is partial.** Of nine bare `redirect("/login")` sites, seven are in files the RLS tenant-authority work still owns:
  - `lib/settings/loaders.ts` ×4, `dashboard/spaces/page.tsx` and `dashboard/platform/[area]/page.tsx`, all in `scripts/lib/db-authority-baseline.json`;
  - `dashboard/settings/archived-assets/page.tsx`, pinned by `lib/rls-server-component-authority.test.ts`.

  Each is a one-line change to `return redirectToLogin()`. `lib/auth/login-redirect.test.ts` allows those seven by name and fails on any new bare site. The common case is unaffected: no JWT at all is already handled by the proxy, which keeps the deep link.
- **A6 (CSP): no change.** None of the Stage A fixes needs one.
  - The CSP is report-only. Turnstile's absence from it produces reports, not breakage.
  - Adding `challenges.cloudflare.com` belongs with the cutover CSP work below, not with a security fix.
  - The public site will need its own CSP: `connect-src` to the app origin for the access-request form, plus Turnstile.
  - The app's `connect-src 'self'` stays correct after the split, because the app never calls the public site.
  - None of this can be activated safely before the hosts exist, so it is documented for Stages C/D rather than enabled now.
- **A7 (request-access): no code.**
  - Today the form posts same-origin, and A3 accepts it.
  - Once the form is on `fourthmeridian.com` and its API is on `app.fourthmeridian.com`, the app needs a **per-route** rule. It would answer the CORS preflight for exactly the configured public-site origin, with no credentials, and let that origin past the Origin boundary for this one exact path.
  - That rule names an origin that does not exist yet. It also touches `app/api/access-request/route.ts`, which RLS owns (it runs on `db`). Both make it a **cutover dependency**, not Stage A work.
  - Do not use a Vercel rewrite instead until the client-IP question in §7 is answered.
- **The old `__Secure-` cookie.** After the rename it is never read. It is still a signed, unrevoked JWT in the browser, and a rollback would bring it back to life. `proxy.ts` therefore expires every `__Secure-next-auth.*` cookie it sees, including chunked ones. This happens only on requests the proxy matches (`/dashboard`, `/admin`, `/api`), which covers essentially every returning user.

**Proof:**
- `lib/auth/return-to.test.ts`: 82 checks, including 11 accept and 47 reject cases.
- `lib/auth/session-cookie.test.ts`: 67 checks. These use NextAuth's own `defaultCookies`, `SessionStore` and `cookie` serializer, plus an RFC 6265bis model and the real proxy.
- `lib/security/write-origin.test.ts`: 84 checks.
- `lib/auth/login-redirect.test.ts`: 19 checks.
- A live `next dev` on an isolated worktree (dummy env pointing at nothing, no database):
  - same-origin writes reached the handler on both `localhost` and `127.0.0.1`;
  - sibling, foreign and `null` origins, and `Sec-Fetch-Site: same-site`, received `403 {"error":"cross_origin_write_refused"}`;
  - `/api/plaid/webhook` reached its own signature check;
  - `/api/jobs/dispatch` reached its own bearer check.

**Consequence the owner must expect:** deploying Stage A signs every user out once, because of the cookie rename. `NEXTAUTH_SECRET` is **not** rotated in Stage A.

### 16.1 The stable Preview environment

The owner has confirmed that `preview.fourthmeridian.com` is the **intentional, stable pre-production environment**. It is not a convenience alias. §10's advice to avoid `*.fourthmeridian.com` preview aliases is **withdrawn**: it optimised for browser-site isolation alone and ignored the operational value of a named staging environment.

**Two different things:**

| | Stable Preview / Staging | Ephemeral Vercel Preview deployments |
|---|---|---|
| Hosts | `preview.fourthmeridian.com` today; `preview.` + `preview-app.` after the split | `*.vercel.app`, one per branch or commit |
| Purpose | Validate a release against Preview infrastructure before Production | Look at a branch |
| Browser site | **Same site** as Production (`fourthmeridian.com`) | Own site each (`vercel.app` is on the Public Suffix List) |
| Env vars | Must be Preview values, never Production values | Whatever Vercel's "Preview" environment holds (see the risk below) |

**Candidate evaluated:**

```
                     PRODUCTION                 PREVIEW / STAGING
Public website       fourthmeridian.com         preview.fourthmeridian.com
Authenticated app    app.fourthmeridian.com     preview-app.fourthmeridian.com
```

**Recommendation: A, keep the stable parallel domain model,** under the conditions below. Three of its four security properties are already enforced in code by Stage A, and the fourth is an owner-verifiable configuration fact:

1. **Sessions are host-only.**
   - A Production session issued by `app.` reaches only `app.`. A Preview session issued by `preview-app.` reaches only `preview-app.`.
   - No sibling can plant a `__Host-` session cookie.
   - Shown mechanically in `lib/auth/session-cookie.test.ts` §2–§3. The `Set-Cookie` header comes from NextAuth's own write path, run through an RFC 6265bis acceptance-and-sending model across all four hosts. The same model shows that the *old* `__Secure-` name **could** be planted from any sibling.
2. **Browser writes are bound to their own origin.**
   - Production `app.` refuses writes whose Origin is `fourthmeridian.com`, `preview.`, `preview-app.` or anything else. Preview `preview-app.` refuses `app.`.
   - Shown in `lib/security/write-origin.test.ts` §1 and §4 (real proxy).
   - Nothing is configured, so nothing can be misconfigured.
3. **Return targets are paths, never hosts.**
   - A login on `preview-app.` can only return to a path on `preview-app.`. Cross-environment and cross-host `callbackUrl`s are refused (`lib/auth/return-to.ts`).
   - NextAuth detects its origin from the request host, so its own callbacks stay on the host the user is on.
4. **Separate secrets and resources per environment (owner-verified, §16.5).**
   - Preview and Production must not share `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, any database URL or role credential, Plaid keys, or provider keys.
   - **A shared `NEXTAUTH_SECRET` would break the boundary.** Anyone able to read the Preview secret (for example, anyone who can deploy branch code to Preview) could mint a JWT that Production accepts. Host-only cookies do not help, because the attacker would set the cookie in their own browser.

**Why not B (a different Preview app host)?**
- The only plausible alternative is nesting, e.g. `app.preview.fourthmeridian.com`.
- Nesting makes the Preview public site a *parent* of the Preview app. That gives the public site more cookie reach (`Domain=preview.fourthmeridian.com`) and no less exposure.
- A flat sibling (`preview-app.`) is equal or better on every property above.

**Why not C (retire the custom-domain Preview)?**
- It would trade a working staging environment for a property (site isolation) that Stage A now provides by other means for the cookies and writes that matter.

**What same-site still allows** (the residual risks of model A, listed rather than hidden):

- **Cross-origin GETs carry cookies.** A sibling page can trigger credentialed GETs to the app (images, top-level navigations). Without CORS it cannot read the responses, so this is harmless *as long as no GET changes state*. A heuristic scan of `app/api/**` GET handlers for direct Prisma writes found none; the three hits were `Map.set`. It cannot see writes reached through helper functions. Before Stage D, the RLS-aware owner of each route should confirm "GET is safe".
- **Non-`__Host-` app cookies can still be planted by a sibling:**
  - `fintracker_space`: not HttpOnly, host-only today, no prefix. A planted parent-domain value can steer which Space is "active". The server re-checks membership (a named Space mismatch is a 403, per the V26 promotion), so this is a nuisance, not authority.
  - `fm_ai_transcript`: a client hint cookie.
  - `fm_ai_state`: sealed with `ENCRYPTION_KEY`, so a planted value fails to open and the turn starts without state.

  Recommendation: move `fintracker_space` to `__Host-` during Stage C. Low urgency.
- **Preview code is Production's sibling.** Today, branch code deployed to `preview.fourthmeridian.com` is same-site with Production on `fourthmeridian.com`. Stage A closes the two ways that mattered: planting a session and cross-origin writes. The residual risks above apply equally to this pre-split arrangement.

**Ephemeral `*.vercel.app` deployments:**
- **Isolation from the stable hosts is structural.** They are on the Public Suffix List, so they cannot plant cookies on `*.fourthmeridian.com` or make same-site requests to it. Each trusts only its own origin for writes, and its session cookie is host-only to its own URL.
- **⚠️ The real risk is configuration, and the repo cannot prove it either way.**
  - Vercel's "Preview" environment variables apply to *every* non-production deployment. That normally includes the deployment the stable `preview.fourthmeridian.com` domain points at.
  - So unless the owner has used branch-scoped variables or a Vercel Custom Environment, every branch push runs with the full stable-Preview authority: Preview database, Preview `NEXTAUTH_SECRET`, Preview Plaid keys.
  - That is acceptable only if the stable Preview environment holds nothing you would not hand to every branch.
  - **Recommended:** a Vercel Custom Environment (e.g. `staging`) for the stable `preview.` / `preview-app.` hosts, holding the stable-Preview values. Plain ephemeral previews then run with reduced authority: a disposable or seeded database and no real Plaid credentials.
  - Owner question in §16.5.
- **Reduced functionality on ephemeral previews is acceptable and expected:**
  - Plaid OAuth will not work, because their URLs are not on Plaid's allowlist.
  - Emails link to whatever `NEXT_PUBLIC_APP_URL` the environment holds. Under Custom Environments that would be the stable Preview host, which is environment-local and correct.
  - Ephemeral deployments must never receive Production values.

**Preview authentication and callback design:**

| Flow | Production | Preview |
|---|---|---|
| Public CTA | `fourthmeridian.com` → `https://app.fourthmeridian.com/dashboard` | `preview.` → `https://preview-app.fourthmeridian.com/dashboard` (`NEXT_PUBLIC_APP_ORIGIN` per environment, never shared) |
| NextAuth origin | Request host (`app.`) | Request host (`preview-app.`) |
| `NEXTAUTH_URL` / `NEXT_PUBLIC_APP_URL` | `https://app.fourthmeridian.com` | `https://preview-app.fourthmeridian.com` |
| Return target | Path only, on `app.` | Path only, on `preview-app.` |
| Logout | Revokes the `app.` session row; clears the `app.` cookie | The same, on `preview-app.`; there is no cross-environment state to clear |
| Plaid `redirect_uri` | `https://app.fourthmeridian.com/plaid-oauth-return` on Production's Plaid allowlist | `https://preview-app.fourthmeridian.com/plaid-oauth-return` on Preview's (sandbox/development) allowlist |
| Plaid webhook | `https://app.fourthmeridian.com/api/plaid/webhook` | `https://preview-app.fourthmeridian.com/api/plaid/webhook` |
| OAuth login providers | None (credentials only) | None |

**No open redirect can bridge environments.** Return targets are paths. The only absolute URLs are built from each environment's own `NEXT_PUBLIC_APP_URL`. NextAuth's default `redirect` callback refuses an absolute URL from another origin.

**Cutover order:** cut Preview over first, as a dress rehearsal for Production, with the same steps in §12 applied to `preview.` / `preview-app.`.

**Rollback:** keeping `preview.fourthmeridian.com` means there is no removal to roll back. At its own Stage D it changes role from *Preview app* to *Preview public site*; rolling back means pointing it at the app deployment again. The same session caveat as §16.2 applies to Preview.

### 16.2 `NEXTAUTH_SECRET` rotation: classification

**Every use in the code** (`git grep NEXTAUTH_SECRET`, excluding docs and tests):
- `lib/auth.ts` `authOptions.secret`;
- `proxy.ts` `getToken({ secret })`;
- `lib/env.ts` (required-variable list, and a getter that nothing calls).

Inside NextAuth v4 the secret does two things:
- It derives the key that encrypts the session JWT (JWE).
- It hashes the CSRF double-submit token (`next-auth/core/lib/csrf-token.js`).

It does **not** protect:
- `fm_ai_state`, which uses `ENCRYPTION_KEY` via `sealWithPurpose`;
- Plaid tokens, TOTP secrets or recovery codes, which use `ENCRYPTION_KEY` or bcrypt;
- reset, verify or invite tokens, which are random database rows;
- the Plaid webhook, which is verified against Plaid's own keys.

**Rotating it invalidates:**
- every live session (everyone signs in again);
- outstanding CSRF tokens, which NextAuth reissues transparently.

Nothing else in the repo depends on it.

**Classification: REQUIRED, or an equivalent revocation, once per environment, before that environment's apex host is attached to the public-site deployment (Stage D, and Preview's own Stage D).**

The reason is a consequence the original plan did not spell out:
- After Stage A deploys, and until Stage C, the app still runs on `fourthmeridian.com` (and on `preview.fourthmeridian.com` for Preview). Every session issued there is a `__Host-` cookie that is host-only to **the apex**.
- At Stage D the apex moves to the public-site deployment. Every browser that still holds such a cookie will send a **live Production session credential** to the public site on every visit.
- The public site holds no secret, so it cannot decode or forge the cookie. But a compromised public deployment could log the cookie value and replay it against `app.fourthmeridian.com`: the JWT is a bearer token, valid on any host that shares the secret.
- That breaks invariant §12 "public site compromise does not grant app authentication".

**What the `__Host-` transition does and does not do:**
- It does **not** close this. It retires only the *pre*-Stage-A `__Secure-` cookies.
- It does not help with sessions issued on the apex between Stage A and Stage C.

**Acceptable ways to neutralise those cookies** before the apex changes hands:
- (a) rotate `NEXTAUTH_SECRET` at C2, as originally planned. Simplest: every apex-era JWT becomes undecryptable.
- (b) revoke every `UserSession` row issued before C2. The proxy would still pass the page (it checks the signature only), but every page and API read rejects the session. This is weaker than (a), because the stolen cookie remains a correctly signed token.

Use (a). The C2 proxy step can additionally expire the apex session cookie while it redirects, but that only reaches browsers that visit during the window. So it is hygiene, not the control.

### 16.3 Plaid webhook cutover: plan only

Nothing has been changed at Plaid.

- **Population:** every Production Plaid Item created while `NEXT_PUBLIC_APP_URL` (or an explicit `PLAID_WEBHOOK_URL`, which overrides it: `app/api/plaid/link-token/route.ts` `resolvePlaidWebhookUrl`) pointed at the apex. The repo does **not** store the webhook URL per Item (no column in `prisma/schema.prisma`). The current value lives at Plaid and is readable per Item via `/item/get` (`item.webhook`).
- **Dry run:** for each active Item, read `item.webhook` and report counts grouped by destination. Write nothing.
- **Old destinations:** whatever the dry run shows. Expected `https://fourthmeridian.com/api/plaid/webhook`; possibly others if `PLAID_WEBHOOK_URL` was ever set. **Owner: is `PLAID_WEBHOOK_URL` set in Production or Preview?**
- **New destination:** `https://app.fourthmeridian.com/api/plaid/webhook` for Production, and `https://preview-app.fourthmeridian.com/api/plaid/webhook` for Preview Items.
- **Mechanism:** a one-off operator script calling `/item/webhook/update` per Item.
  - Runs as `fm_system` with Plaid credentials and `ENCRYPTION_KEY`, from the owner's terminal, against one environment per run.
  - Idempotent: skip any Item already at the target.
  - Writes a per-Item result log.
- **Verification:**
  - Plaid sends `WEBHOOK_UPDATE_ACKNOWLEDGED` to the new URL, observed in the app logs at the new host.
  - A re-run of the dry run shows zero Items on the old destination.
- **Compatibility period:** the apex keeps serving the webhook until the dry run shows zero. During Stage C the apex is still the app, so this is automatic. The polling crons (`/api/jobs/sync-banks`) cover any gap.
- **Transitional rewrite on the public site (`/api/plaid/webhook` → app): UNPROVEN, owner/platform verification required.**
  - The handler verifies `sha256(rawBody)` against the `plaid-verification` JWT (`app/api/plaid/webhook/route.ts:47-51`, `lib/plaid/webhook-verify.ts`), and rejects an `iat` older than 300 s.
  - A rewrite is therefore usable only if Vercel's external rewrite preserves:
    - the method (POST);
    - the body **byte-for-byte**;
    - the `plaid-verification` header;
    - `Content-Type`.
  - Nothing in the repo can establish that. **Preferred:** finish the per-Item update *before* Stage D, so the rewrite is never needed. If it is needed, verify it first with a signed Plaid sandbox webhook on Preview.

### 16.4 What the RLS workstream should know (collisions and dependencies)

- **Done concurrently without touching any RLS-owned file:** `proxy.ts`, `lib/auth.ts` (two-line `cookies` / `useSecureCookies` addition, outside the authorize and session callbacks the RLS slices edit), the login pages, the settings index, admin security, and new `lib/auth/*` and `lib/security/*` modules.
- **Deferred to the RLS owner:** the seven `redirect("/login")` sites (§16.0). `lib/session.ts:189-192` says the proxy "never runs on /api/*". That is no longer literally true: it now runs there for the Origin boundary only, never authorization. The comment's conclusion still holds. `lib/session.ts` is RLS-touched, so the wording fix is left to its owner.
- **`/api/access-request` still runs on `db`** (`postgres`, BYPASSRLS). This is unchanged and remains an RLS item.
- **Interaction to be aware of:** a browser write refused by the Origin boundary returns `403 {"error":"cross_origin_write_refused"}` before any handler runs. It cannot be confused with an RLS outcome (handler 401/403/404/500), and RLS route-authority tests call handlers directly, so the boundary does not affect them.

### 16.5 Revised owner actions (supersedes §14 where they differ)

1. **Confirm separation, without sharing values:** for each of the following, are the Production and Preview values *different*?
   - `NEXTAUTH_SECRET`
   - `ENCRYPTION_KEY`
   - `DATABASE_URL`, `DATABASE_URL_APP`, `DATABASE_URL_AUTH`, `DATABASE_URL_SYSTEM`
   - `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`
   - `OPENAI_API_KEY`
   - `CRON_SECRET`
2. **Which Vercel environment serves `preview.fourthmeridian.com`?** The generic "Preview" environment shared with every branch deployment, or a Custom Environment? (§16.1)
3. **Presence only:** are `PLAID_WEBHOOK_URL`, `PLAID_REDIRECT_URI`, `DIRECT_URL` or `SHADOW_DATABASE_URL` set in either Vercel environment?
4. Current values of `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` per environment: say whether each is the apex, `preview.`, or something else.
5. Whether `www.fourthmeridian.com` exists, who hosts DNS, and whether Cloudflare proxies traffic.
6. **At cutover (not now):**
   - Plaid allowlist entries for `app.` and `preview-app.`
   - Turnstile hostnames
   - Sentry allowed domains
   - the per-Item webhook script (§16.3)
   - `NEXTAUTH_SECRET` rotation per environment before that environment's Stage D (§16.2)
   - domain moves, Preview first

### 16.6 Open questions added

- Do Vercel external rewrites preserve body bytes and headers? (§16.3)
- Is `PLAID_WEBHOOK_URL` set anywhere?
- Is the stable Preview a Custom Environment?
- Should ephemeral previews keep full Preview authority?

### 16.7 Gate for Stages C and D (unchanged in spirit, now explicit)

1. The 33 tenant-authority-path work is closed.
2. Stage A is reviewed, including the seven deferred `redirectToLogin` conversions once RLS releases those files.
3. Repository gates are green.
4. Exact-SHA GitHub CI is green.
5. Owner facts §16.5 items 1–5 are answered.
6. Preview is cut over before Production.

---

## 17. Environment authority separation: owner action plan (2026-10-03)

### 17.0 Owner-confirmed configuration facts

| Shared between Preview and Production | Separate |
|---|---|
| `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, `PLAID_CLIENT_ID`, `OPENAI_API_KEY`, `CRON_SECRET` | Database and database credentials; `PLAID_SECRET` |

No value was read, printed or changed for this section. Every classification below rests on code paths in the repo.

### 17.1 🚨 Application defect found: a session JWT with no `sessionToken` skips revocation and carries its own role

`lib/auth.ts`, `callbacks.session`:
- The revocation lookup runs **only `if (sessionToken)`**. A JWT without that claim is accepted with no database check at all.
- `session.user.id` and `session.user.role` come straight from the token.
- `lib/session.ts` `requireUser()` and `requireSystemAdmin()` trust that role. Only `requireFresh*()` insists on a `sessionToken`.
- The revocation lookup is `userSession.findFirst({ where: { sessionToken, revokedAt: null } })`. It does **not** require the row's `userId` to equal `token.id`.

Consequence: **anyone holding `NEXTAUTH_SECRET` can mint a Production-valid session for any user id, with any role (including `SYSTEM_ADMIN`), with `requireTotpSetup` unset, and with no live session row.** Alternatively, they can attach their own live `sessionToken` to someone else's id.

Tokens from real logins always carry a `sessionToken`: `authorize()` creates the `UserSession` row and the UUID together.

Because `NEXTAUTH_SECRET` is shared, every principal able to read Preview's runtime env holds this capability against Production. That includes every branch deployment if Preview is Vercel's generic Preview environment (§17.9).

**Status: P1 implemented in `0ac1012` (2026-10-03).** See §17.14. The original prerequisite text follows.

**Application prerequisite P1:**
- Fail closed when `sessionToken` is absent.
- Bind the revocation lookup to `userId = token.id`.
- Optionally take `role` from the matched row's user rather than the token.

After P1, the secret alone no longer opens an account: a forger also needs a live session id belonging to that same user. P1 does not touch any RLS-owned file. Its tests must cover the forged-token cases.

### 17.2 Environment authority matrix

| Credential / authority | Current | Target | Must separate? | Why (repo evidence) | Rotation consequence | App prerequisite | Owner action | Verification |
|---|---|---|---|---|---|---|---|---|
| `NEXTAUTH_SECRET` | SHARED | Per environment | **YES, highest priority** | Keys the session JWE and CSRF hash (`lib/auth.ts:700`, `proxy.ts` `getToken`). With §17.1, the holder can mint any Production session. | All sessions in that environment end; CSRF tokens reissue transparently; no stored data depends on it | None to rotate. P1 to make a future leak survivable | Preview now (A-2); Production with explicit authorisation (E-1), plus again before Stage D (§16.2) | §17.13 D-1 |
| `ENCRYPTION_KEY` | SHARED | Per environment | **YES** | HKDF root for every stored ciphertext (§17.4) and for the `fm_ai_state` seal | **Stored ciphertext becomes unreadable** unless re-encrypted first | P2 re-encryption script, **only if** Preview data must be preserved | Preview only (B/C). Production untouched | §17.13 D-3 |
| `DATABASE_URL` | SEPARATE | Separate | Already | Legacy client (`lib/db.ts`) | — | — | Confirm points at the Preview project | Presence/host check only |
| `DATABASE_URL_APP` (fm_app) | SEPARATE (owner) | Separate | Already | `lib/db.ts:92` | — | — | Confirm points at the Preview project | — |
| `DATABASE_URL_AUTH` (fm_auth) | SEPARATE (owner) | Separate | Already | `lib/db.ts:93` | — | — | Confirm | — |
| `DATABASE_URL_SYSTEM` (fm_system) | SEPARATE (owner) | Separate | Already | `lib/db.ts:94` | — | — | Confirm | — |
| `DIRECT_URL` / `SHADOW_DATABASE_URL` | Unknown | **Absent from every Vercel runtime env** | n/a | Migration principal (`postgres`). Vercel does not run migrations | — | — | Confirm absent (A-1) | — |
| `FM_RLS_STRICT`, `FM_DB_GUARD` | Unknown | Per environment, per the RLS cutover doc | n/a | `lib/db.ts:60-72`, `lib/db/live-guard.ts` | — | RLS workstream owns | No action here | — |
| `PLAID_CLIENT_ID` | SHARED | Shared | **No, safe to share** | Identifies the Plaid team. Plaid authority = `client_id` + the **environment's** secret + `PLAID_ENV` (`lib/plaid/client.ts`). The repo states Preview runs `PLAID_ENV="sandbox"` (`lib/env.ts:216`); Production refuses to boot otherwise (`lib/env.ts:431-447`) | — | — | Confirm Preview `PLAID_ENV=sandbox` | — |
| `PLAID_SECRET` | SEPARATE | Separate | Already | Sandbox secret cannot call `production.plaid.com` | — | — | Confirm Preview holds the **sandbox** secret | — |
| `PLAID_ENV` | Unknown | Preview `sandbox`, Production `production` | Yes | As above | — | — | Confirm | — |
| `PLAID_WEBHOOK_URL` | Unknown (presence) | Unset (derived from `NEXT_PUBLIC_APP_URL`), or per environment | If set, yes | Overrides the derived webhook URL (`app/api/plaid/link-token/route.ts` `resolvePlaidWebhookUrl`) | New Items only; existing Items keep theirs (§16.3) | — | Confirm presence per environment | — |
| `PLAID_REDIRECT_URI` | Unknown (presence) | **Unset** (`lib/plaid/redirect-uri.ts:34-38`) | n/a | Derived from `NEXT_PUBLIC_APP_URL` | — | — | Confirm absent | — |
| `OPENAI_API_KEY` | SHARED | Separate OpenAI **project** for Preview | **Recommended hardening, before private beta** | Only `chat.completions.create` (`lib/ai/provider.ts`); no files, vector stores, assistants or `store:` | Preview AI fails until the new key is set; Production unaffected | — | A-4 | AI turn on Preview succeeds; Preview usage appears only in the new project |
| `CRON_SECRET` | SHARED | Per environment | **YES** (cheap) | Bearer guard on 6 `/api/jobs/*` routes, fail-closed when unset. Vercel cron runs **only on Production deployments** | Preview: none (nothing calls it automatically) | — | Preview now (A-3); Production later (E-2) | §17.13 D-4 |
| `RESEND_API_KEY` | **Unknown** | Separate, restricted Preview key or none | **Owner check** | Sends mail as `@fourthmeridian.com` (`lib/email/senders.ts`) | — | — | Report shared/separate | — |
| `TURNSTILE_SECRET_KEY` | Unknown | Either | Low | Verifies challenge tokens only | — | — | Report | — |
| `ALCHEMY_API_KEY`, `ETHERSCAN_API_KEY`, `HELIUS_API_KEY`, `TIINGO_API_KEY`, `COINGECKO_API_KEY`, `OXR_APP_ID`, `ETH_RPC_URL`, `SOL_RPC_URL` | Unknown | Separate where the provider bills or rate-limits per key | Cost/quota only | Market and chain data reads | — | — | Report | — |
| `MERCHANT_OPS_SPACE_ID`, `DISABLE_SYSTEM_ADMIN`, feature flags | Config | Per environment | n/a | Not credentials | — | — | — | — |

### 17.3 `NEXTAUTH_SECRET`: rotation consequences

**Every use:** `lib/auth.ts` `authOptions.secret`, `proxy.ts` `getToken({ secret })`, and `lib/env.ts` (required list; its getter is unused).

| NextAuth function | Depends on the secret? |
|---|---|
| JWE encryption of the session token | Yes (key derived by HKDF) |
| `__Host-next-auth.csrf-token` hash (`core/lib/csrf-token.js`) | Yes |
| Callback-url cookie | No: it carries a URL and is neither signed nor encrypted |
| Revocation | No: it uses the `sessionToken` claim, so it is only as strong as §17.1 allows |

Nothing outside NextAuth uses the secret.

**Rotating Preview's value: effect on Production is none.** Production reads only its own environment variable. The only cross-environment effect is that tokens minted with the old shared value stop working *on Preview*. Production tokens are never sent to Preview anyway, because the cookies are host-only.

**What Preview rotation does not do:** it does **not** reduce the Production exposure. The current Production value has already been readable from Preview, and from every branch deployment if Preview is generic. Only rotating Production's value (E-1) revokes that, and P1 contains it in the meantime.

**Combine Preview rotation with the Stage A deploy:** Stage A's cookie rename already signs every Preview user out once, so doing both in one Preview deploy costs a single sign-out.

**Production rotation:** every Production session ends; there is no data effect.
- It serves one purpose: ending the Preview-exposure window. It is recommended soon after Preview proves the procedure.
- A **separate** invalidation is required before Production Stage D (§16.2). It handles a different problem: sessions still live for the old apex host when `fourthmeridian.com` becomes the public site. It is not needed because the new secret was compromised. It can be another rotation or an authoritative mass revocation, decided at cutover (§17.15).
- If the first rotation happens close enough to the cutover that no apex sessions are issued after it, one rotation can serve both purposes. That is the owner's timing call.

### 17.4 `ENCRYPTION_KEY`: data inventory

Mechanism: `lib/plaid/encryption.ts`. One 32-byte root key, with an HKDF subkey per purpose. `v2:` is the current format; the legacy `v1` root-key branch is still read. There is **no key versioning or multi-key rotation**. `scripts/audit-ciphertext-versions.ts` audits the format, not the key.

| Purpose | Stored at | Writers | Readers (decrypt) | If the key changes without migration | Class |
|---|---|---|---|---|---|
| `PLAID_ACCESS_TOKEN` | `PlaidItem.encryptedToken` | `lib/plaid/exchangeToken.ts` | `jobs/sync-banks.ts`, `lib/plaid/refresh.ts`, `syncTransactions.ts`, `disconnect.ts`, `lib/account-deletion/purge.ts`, link-token update mode, ops scripts | Every sync, refresh, update-mode Link and **`/item/remove` on disconnect or deletion fails** (Items are stranded at Plaid) | Preview (sandbox): **A** (recreate) or **B**; **C** (re-link) if not migrated |
| `CONNECTION_CREDENTIAL` | `Connection.credential`, **PLAID rows only** | `exchangeToken.ts` | link-token update mode | Update-mode Link fails | Same as above. WALLET rows hold a plaintext public descriptor or address (`lib/crypto/btc-sync.ts:759`) and are unaffected |
| `TOTP_SECRET` | `User.totpSecret` | `app/api/user/totp/setup` | `lib/auth.ts` authorize (fail-safe `return null`), `totp/verify`, `totp/disable`, `totp/recovery-codes` | **Enrolled users cannot sign in with TOTP.** Recovery codes (bcrypt) still work, but disable/regenerate then fail; SYSTEM_ADMIN (TOTP mandatory) depends on recovery codes or another admin's `2fa-reset` | **B**, or clear before rotating |
| `DATE_OF_BIRTH` | `User.dateOfBirthEncrypted` | register, profile | `lib/export/assemble.ts` (try/catch) | Export silently omits the date of birth | **A**/**B** (re-enter) |
| `AI_RUNTIME_STATE` | **Not stored**: the `fm_ai_state` cookie (`lib/ai/conversation/runtime-state.ts`) | chat route | chat route | In-flight scenario state is discarded, as designed | **D**: naturally transient |

There are **no** deterministic hashes or other derived keys from this root.

### 17.5 `ENCRYPTION_KEY`: Preview separation design

Production key and Production ciphertext stay **untouched**. Separation is achieved by giving Preview a *new* value.

1. **Owner-A (read-only):** count the Preview population in the Preview Supabase SQL editor. These statements are read-only and select no secret column values:
   ```sql
   SELECT status, count(*) FROM "PlaidItem" GROUP BY status;
   SELECT count(*) FROM "Connection" WHERE provider = 'PLAID' AND credential IS NOT NULL;
   SELECT count(*) FROM "User" WHERE "totpSecret" IS NOT NULL;
   SELECT count(*) FROM "User" WHERE "dateOfBirthEncrypted" IS NOT NULL;
   ```
   Also answer: **was the Preview database ever loaded from a Production dump?** If yes, those rows are Production ciphertext protected only by the shared key, and they must be purged, not migrated.
2. **Decide: recreate or preserve.**
   - **Recreate** (recommended if Preview is sandbox test data). No app prerequisite. *While the old key is still in place:*
     1. Disconnect each sandbox Plaid connection through the app (it calls `/item/remove`).
     2. Have each TOTP user disable 2FA (or use admin `2fa-reset`).
     3. Clear date-of-birth via the profile page.
     4. Re-run the counts and confirm they are zero.
     5. Then set the new key (C-2).
   - **Preserve:** needs **P2**, a dual-key re-encryption script that is not yet written. It reads `ENCRYPTION_KEY_PREVIOUS` and `ENCRYPTION_KEY`:
     1. Back up Preview.
     2. Dry run: exact population per class.
     3. Per row: decrypt with the old key, encrypt with the new, then decrypt the new ciphertext and compare plaintext equality in-process. Commit per class in one transaction; abort the class on any mismatch.
     4. Re-count.
     5. Deploy with the new key.
     6. Remove `ENCRYPTION_KEY_PREVIOUS`.
3. **Rollback:** before any rows change, set the old value back and redeploy. After recreate or re-encrypt, rollback means restoring the backup and the old key together.

### 17.6 `CRON_SECRET`

- **Consumers** (each `GET`, fail-closed `if (!cronSecret || authHeader !== \`Bearer ${cronSecret}\`) 401`):
  - `/api/jobs/dispatch`
  - `/api/jobs/resume-stale-imports` (both scheduled in `vercel.json`)
  - `/api/jobs/sync-banks`
  - `/api/jobs/fetch-fx-rates`
  - `/api/jobs/fetch-security-prices`
  - `/api/jobs/process-deletions` (fallback routes)
- **Required:** Production only (`lib/env.ts:283-290`).
- **Elsewhere:** tests use their own constants, no operator script calls these routes, and no external service stores the value. Vercel injects it into its own cron requests from the deployment's environment, and Vercel runs crons only for Production deployments.
- **Preview change:** set a new value in Preview, then redeploy. Nothing breaks, because nothing calls Preview crons automatically.
- **Production change:** set a new value, then redeploy. Vercel's next cron uses it. The comparison is not constant-time (minor). Monitor the next scheduled `JobRun`.

### 17.7 Plaid, OpenAI, database

- **Plaid client ID: SAFE TO SHARE.** A shared `client_id` with a per-environment secret is Plaid's own model: the secret selects the environment.
  - Preview authority is sandbox-only *if* Preview's `PLAID_ENV` is `sandbox` with the sandbox secret. The repo states it is; the owner should confirm.
  - Allowed redirect URIs and the webhook are configured at Plaid. Whether they are per environment or team-wide must be checked in the Plaid dashboard (§17.11).
- **OpenAI: RECOMMENDED HARDENING, before private beta.**
  - A Preview compromise gives spend, model access, and the ability to exhaust the shared rate limit and budget, taking Production AI down.
  - It gives no stored data: chat completions only, no `store`, no files, vector stores or assistants.
  - It gives no Fourth Meridian Production authority.
  - A **separate OpenAI project** is materially better than a second key in the same project: projects have separate rate limits, budgets and usage. Keys within one project share all three.
- **Database:** the app reads `DATABASE_URL`, `DATABASE_URL_APP`, `DATABASE_URL_AUTH` and `DATABASE_URL_SYSTEM` from each deployment's own environment (`lib/db.ts`). Nothing in code crosses environments. The owner confirms all four point at the Preview project on Preview. Nothing here connects to either database. The RLS role credentials remain the RLS workstream's.

### 17.8 `fintracker_space`: classification

- **Writer:** `POST /api/space/switch` sets it after verifying ACTIVE membership. Options: Path=/, SameSite=Lax, not HttpOnly, Secure keyed on `NODE_ENV` (true on Vercel builds), host-only, 30 days.
- **Readers:**
  - `lib/space.ts` `getSpaceContextUncached` → `resolveSpaceContext`, which re-checks ACTIVE membership and a non-archived Space, otherwise falls back to the user's PERSONAL Space.
  - `dashboard/spaces/page.tsx`, which only uses it to highlight the active Space.
- Nothing treats it as proof of access.

**Classification: SECURITY-RELEVANT HINT.** It grants no authority and cannot expose another user's Space. But a sibling-planted parent-domain value can switch a victim's *active* Space among Spaces they already belong to. New data the victim enters could then land in a shared Space they did not intend.

Move it to `__Host-` at Stage C. Its writer and readers include RLS-owned files (`spaces/page.tsx`), so not now.

### 17.9 Vercel: Custom Environment or generic Preview?

**How to check (read-only):**
- **Project → Settings → Domains:** each domain row states what it is connected to: Production, Preview with a Git branch, or a named custom environment.
- **Project → Settings → Environments:** lists Production, Preview, Development and any Custom Environments.
- **Project → Settings → Environment Variables:** each variable shows its scope, e.g. "Preview", "Preview (branch: v2.6)", or a custom environment name.

**If `preview.fourthmeridian.com` is generic Preview:** every branch and PR deployment inherits every Preview-scoped variable. That means the Preview database credentials, `PLAID_SECRET` (sandbox), `OPENAI_API_KEY`, `CRON_SECRET`, `ENCRYPTION_KEY`, and **`NEXTAUTH_SECRET`, today equal to Production's.** Any code pushed to any branch can read and exfiltrate them.

This does not change recommendation A (§16.1). It changes its precondition:
- Stable-Preview credentials move to a **Custom Environment** (e.g. `staging`) or to **branch-scoped** Preview variables for the stable branch only.
- Generic Preview gets reduced authority: its own throwaway `NEXTAUTH_SECRET` and `ENCRYPTION_KEY`, and no database URL or a disposable one.

### 17.10 Threat model: Preview compromised today

| Shared value | Production impact | Category |
|---|---|---|
| `NEXTAUTH_SECRET` | Mint a Production session for any user id and any role, including SYSTEM_ADMIN, bypassing TOTP and revocation (§17.1). Full read/write of any user's financial data through the app | **DIRECT PRODUCTION AUTHORITY: critical** |
| `CRON_SECRET` | Trigger Production jobs at will: bank syncs (Plaid calls), price/FX fetches (provider quota), resume-imports, dispatch. `process-deletions` only runs deletions already due (`deletionScheduledAt <= now`), so none can be forced early | **DIRECT PRODUCTION AUTHORITY: operational** (load, cost, quota; no data access) |
| `ENCRYPTION_KEY` | Alone: forge `fm_ai_state` cookies that Production accepts. The state is bound to user, Space and the last-assistant digest, so this only affects the attacker's own conversation. Combined with any copy of Production ciphertext (dump, backup, DB read): decrypt TOTP seeds (2FA defeated given the password), dates of birth, and Plaid access tokens (unusable without Production's separate `PLAID_SECRET`) | **CONDITIONAL**: escalates any Production data leak |
| `OPENAI_API_KEY` | Spend, quota exhaustion (Production AI outage), model access | **SHARED PROVIDER / COST BLAST RADIUS** |
| `PLAID_CLIENT_ID` | None with a sandbox-only Preview secret | **NO MATERIAL CROSS-ENVIRONMENT AUTHORITY** |

### 17.11 Owner checklists

Conventions for every action:
- Generate values locally, for example `openssl rand -base64 32` (`NEXTAUTH_SECRET`, `CRON_SECRET`) or `openssl rand -hex 32` (`ENCRYPTION_KEY`, exactly 64 hex characters).
- Paste the value straight into the Vercel field, never into chat or a file. Mark it **Sensitive**.
- Never edit a variable shared across scopes in place. Create the Preview-scoped value and remove Preview from the shared variable's scope.

**PHASE OWNER-A: safe now** (no app prerequisite; Production untouched)

| # | Environment | Variable / action | New value? | Keep old? | Redeploy | Sessions | Data | Verify | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| A-1 | Both (read-only) | Inspect §17.9; confirm `PLAID_ENV` per environment; confirm all four DB URLs per environment; confirm `DIRECT_URL`, `SHADOW_DATABASE_URL`, `PLAID_REDIRECT_URI`, `PLAID_WEBHOOK_URL` presence; report shared/separate for `RESEND_API_KEY` and the provider keys in §17.2 | — | — | — | — | — | Answers recorded | — |
| A-2 | Preview only | `NEXTAUTH_SECRET` | Yes | No | Yes (Preview) | **All Preview sessions end.** Production unaffected | None | D-1, D-2 | Set another new value. Never restore the shared one |
| A-3 | Preview only | `CRON_SECRET` | Yes | No | Yes (Preview) | None | None | D-4 | Set another new value |
| A-4 | Preview only | `OPENAI_API_KEY` from a new OpenAI **project** with a budget cap | Yes | No | Yes (Preview) | None | None | D-5 | Point Preview back at any working key |
| A-5 | Preview (read-only SQL) | §17.5 step 1 population counts; Production-dump question | — | — | — | — | — | Counts recorded | — |

A-2 is best deployed together with Stage A on Preview (one sign-out). On its own it is equally safe.

**PHASE OWNER-B: after application prerequisites**

| # | Prerequisite | Then |
|---|---|---|
| B-1 | **P1** (§17.1), reviewed and green | Deploy to Preview, then Production. A normal deploy with no env change. Contains the shared-secret exposure until E-1 |
| B-2 | Recreate path: none. Preserve path: **P2** (§17.5) | Recreate: the old-key clean-up steps in §17.5. Preserve: backup plus a P2 dry run on Preview |
| B-3 | Stage A merged | Deploy Stage A to Preview |

**PHASE OWNER-C: Preview cutover**

| # | Environment | Variable / action | New value? | Keep old? | Redeploy | Sessions | Data | Verify | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| C-1 | Vercel | If generic Preview: create a Custom Environment for the stable host (or branch-scope the stable values), then give generic Preview its own throwaway `NEXTAUTH_SECRET` and `ENCRYPTION_KEY` and no stable DB URL | Yes | — | Yes | Stable Preview: per C-2. Branch previews: lose stable authority | None | Branch deployment cannot reach the stable Preview DB | Re-scope the variables back |
| C-2 | Stable Preview | `ENCRYPTION_KEY` (and `ENCRYPTION_KEY_PREVIOUS` only on the P2 path, removed after D-3) | Yes | **Only during P2** | Yes | None | **Recreate path:** counts must already be zero. **Preserve path:** P2 run against the backup-protected DB | D-3 | Restore the old key (and the backup if rows changed) |

**PHASE OWNER-D: Preview verification** (after each relevant change)

- **D-1 (session):**
  - Sign in on Preview; the cookie is `__Host-next-auth.session-token`, Secure, no Domain.
  - Sign out; the `/dashboard` deep link survives a fresh sign-in.
  - Revoke the session from the security settings; the next page goes to `/login?callbackUrl=…`.
  - A Production cookie value pasted into the Preview host is rejected.
- **D-2 (CSRF and Origin):** a write from the browser console on Preview succeeds. A `fetch` to Preview's `/api` from `https://fourthmeridian.com` gets `403 cross_origin_write_refused`.
- **D-3 (encryption):**
  - TOTP sign-in works for a newly enrolled test user.
  - A sandbox Plaid connection links, syncs and disconnects (`/item/remove` succeeds).
  - Data export includes date of birth when set.
  - An AI chat turn keeps scenario state across two turns.
  - Re-run the §17.5 counts; P2 path: zero decrypt failures in logs.
- **D-4 (cron):** `curl -H "Authorization: Bearer <old value>"` against Preview `/api/jobs/fetch-fx-rates` gets 401. The new value gets 200. Generate the header locally and do not paste it anywhere shared.
- **D-5 (OpenAI):** one AI turn on Preview succeeds, and usage appears only in the new OpenAI project.

**PHASE OWNER-E: Production later** (each step needs explicit owner authorisation after Preview passes D)

| # | Variable / action | New value? | Redeploy | Sessions | Data | Verify | Rollback |
|---|---|---|---|---|---|---|---|
| E-1 | Production `NEXTAUTH_SECRET` (recommended soon after B-1; required again before Stage D, §16.2) | Yes | Yes | **All Production sessions end** | None | D-1 on Production | Another new value; never the old shared value |
| E-2 | Production `CRON_SECRET` (its old value was readable from Preview) | Yes | Yes | None | None | Next scheduled `JobRun` succeeds (Platform Ops) | Another new value |
| E-3 | Production `OPENAI_API_KEY` in its own project | Yes | Yes | None | None | AI turn; usage in the Production project | Previous key |
| E-4 | Production `ENCRYPTION_KEY`: **not needed for separation** (Preview moves away). Rotate only if Production ciphertext exposure is suspected; requires P2 run against Production with a backup | Optional | Yes | None | **Re-encryption required** | D-3 on Production | Backup plus old key |
| E-5 | Domain cutover (§12 Stages C–F) after §16.7 | — | — | — | — | — | §13 |

### 17.12 Items the owner inspects

- **Vercel:**
  - domain-to-environment mapping;
  - Custom Environments;
  - each variable's scope;
  - presence of `DIRECT_URL`, `SHADOW_DATABASE_URL`, `PLAID_REDIRECT_URI`, `PLAID_WEBHOOK_URL`;
  - Sensitive flags;
  - team-level Shared Environment Variables.
- **Plaid:**
  - which secret and environment each Vercel environment uses;
  - allowed redirect URIs (per environment or team-wide);
  - per-Item webhook destinations (§16.3 dry run, later).
- **OpenAI:** project layout and budget caps.
- **Resend:** whether Preview can send as `@fourthmeridian.com`.
- **DNS:** host and whether Cloudflare proxies traffic (unchanged from §16.5).

### 17.13 Application prerequisites blocking owner actions

- **P1** blocks nothing mechanically. It is the containment that makes deferring E-1 defensible.
- **P2** blocks C-2 **only if** Preview data must be preserved.
- **Stage A** must deploy to Preview before D-1 and D-2 can show the `__Host-` and Origin behaviour.
- Nothing blocks A-1 to A-5.

### 17.14 P1 implemented, and the three separate `NEXTAUTH_SECRET` actions

**P1 (`0ac1012`).** `lib/auth/session-proof.ts` is applied by the session callback (`lib/auth.ts`) and by the fresh re-check (`lib/session.ts`). A request is authenticated only when all of the following hold:
- the token carries a well-formed `id` **and** `sessionToken`;
- the `UserSession` row exists and is unrevoked;
- the row's `userId` equals the token's `id`;
- the row's user exists, with a known role.

The role acted on is the user's **current** role from the store. The 30-second cache stores the row's facts (owner and role), not a boolean, and ownership is judged per request.

**Proof:** `lib/auth/session-proof.test.ts` runs tokens encrypted with the configured secret through NextAuth's real `AuthHandler` and the real `authOptions`. On P1's parent it fails 23 checks: every forged case authenticates, including SYSTEM_ADMIN with no `sessionToken`. On P1 it passes 51 of 51.

**Role authority (answered).** Before P1, `token.role` (a login-time snapshot) was the role every server-side guard used: `requireUser`, `requireSystemAdmin`, the admin layouts and `useSession()`. The application has no in-app role change; only `scripts/admin-promote.ts` promotes, and it does not revoke sessions. After P1:
- Every guard sees the store's current role, so promotion and demotion take effect within the cache TTL.
- `requireFreshSystemAdmin` re-judges on the role it has just read.
- `proxy.ts` still reads `token.role`, but only to choose a redirect; it grants nothing.

**These are three separate security actions. None substitutes for another:**

| | What it does | What it does not do |
|---|---|---|
| **A. P1** (done) | Possession of `NEXTAUTH_SECRET` **alone** no longer yields a session. Forging now also requires a live `sessionToken` belonging to the impersonated user | Does not make the historically shared Production secret safe to keep. See residual 1 below: the secret plus SYSTEM_ADMIN API access still yields any user's `sessionToken` |
| **B. Preview rotation** (owner A-2) | Stops Preview, and every branch deployment if Preview is generic, from receiving Production's authentication secret from now on | Does nothing for copies already taken |
| **C. Production rotation** (owner E-1) | Invalidates the credential that was shared with Preview. Ends every Production session | — |

**Recommended Production rotation point (current state).** Stage A and P1 are committed on `v2.6` and not yet deployed anywhere.
1. Deploy Stage A and P1 to Preview, rotating Preview's secret (B) in the same deploy: one Preview sign-out. Run §17.11 D-1 and D-2.
2. Deploy the same commit to Production **and rotate Production's secret (C) in that same deploy.** Stage A's `__Host-` rename already signs every Production user out once, so the rotation costs nothing extra.
3. Do not leave the shared secret in Production for an open-ended period on the strength of P1. P1 narrows what the secret is worth; it does not make the secret private again.
4. The domain-cutover invalidation before Stage D (§16.2) is still required, for the apex-session reason in §17.15. It is not a response to any compromise of the new secret. Either a rotation or an authoritative mass revocation of every `UserSession` row satisfies it.

**Remaining authentication risks after P1:**
1. **Raw `sessionToken` values are returned by two list endpoints.**
   - `GET /api/admin/security/users/[userId]/sessions` spreads every row (`...s`), so any SYSTEM_ADMIN can read any user's live `sessionToken`s. This route is in `scripts/lib/db-authority-baseline.json`, so it is RLS-owned and was not changed.
   - `GET /api/user/sessions` returns the caller's own tokens. It was converted in RLS-11.
   - `components/security/SessionsList.tsx` only declares the field and never uses it.
   - **Consequence:** the secret plus an admin session (or plus XSS on the app origin, for the caller's own devices) is enough to mint tokens for live sessions.
   - **Fix:** select explicit columns without `sessionToken` in both routes (P1b). Schedule it with the RLS owner, or once those files are released.
2. `requireTotpSetup` and `username` still come from the token. Forging them now requires a live `sessionToken` of the same user plus the secret; the worst case is a user skipping their own forced TOTP enrolment. Deriving `requireTotpSetup` from the store is a follow-up.
3. `proxy.ts` routes on `token.role`. After a demotion without re-login, the proxy sends `/dashboard` to `/admin`, and the admin layout (store role) sends it back: a redirect loop until sign-out. `scripts/admin-promote.ts` should revoke the user's sessions when it changes a role.
4. P1 does not check `User.deactivatedAt`. Deactivation and deletion already call `revokeAllUserSessions`, which P1 honours.
5. The existing cache trade-off is unchanged. Another warm instance can serve verified facts for up to 30 s after a revocation or role change (120 s more only during a store outage). Sensitive routes use `requireFresh*`.

### 17.15 P1b (`ab6b063`): session-token exposure, token-claim authority, role change, deactivation

**Every `sessionToken` serialisation surface found:**

| Surface | Before | Now |
|---|---|---|
| `GET /api/auth/session` (`useSession()`, and any server component handing `session` to a client) | P1's session callback set `session.sessionToken`, so every signed-in browser received its own token | **Closed.** The callback does not set it, and `Session` no longer declares it. `lib/session.ts` reads it on the server from the request's own cookie, bound to the id that was just verified |
| `GET /api/user/sessions` | Spread every row (`...s`), returning every device's token | **Closed.** Explicit `toSessionView()` projection of exactly the rendered fields |
| `GET /api/admin/security/users/[userId]/sessions` | Spreads every row to any SYSTEM_ADMIN | **Deferred.** RLS-owned file. Pinned by name in `lib/auth/session-token-exposure.test.ts` (the fix is the same projection) |
| `DELETE /api/user/sessions/[sessionId]` | Returns `{success, isCurrent}` | Never exposed |
| Logs, capture, audit metadata | — | None found (scanned `app`, `lib`, `jobs`, `scripts`, `proxy.ts`) |
| Client types | `SessionRow.sessionToken` declared, never read | Removed |

**Token-claim authority classification:**

| Claim | Class | Basis |
|---|---|---|
| `id` | **A. Authority** | Proven against the session row (P1) |
| `sessionToken` | **A. Authority** | Must be a live row owned by `id` (P1). Never serialised (P1b) |
| `role` | **A. Authority** | Session and guards use the store's current role (P1). The token copy is **C. navigation hint** for `proxy.ts` |
| `requireTotpSetup` | **A. Authority**, previously sourced from a **client-writable** claim | The jwt callback copies it on `trigger: "update"`, i.e. from `useSession().update()`, so a user pending forced enrolment could clear it with no secret at all. Now derived from current state by `authorize()`'s own rule. The token copy is **C. navigation hint** |
| `username` | **B. Presentation** | Display and invite-email wording only. Grants nothing |
| `email`, `name` | **B. Presentation** | Display only |

**Role change:**
- `scripts/admin-promote.ts` is the only code that writes `User.role`.
- It now revokes the user's live sessions in the same transaction as the role write and its audit row.
- So no session outlives its role, and the proxy's token-role hint cannot disagree with the store. No redirect loop can arise from a scripted role change.
- A manual database edit of `role` must revoke sessions the same way. This is pinned for all code paths by the exposure test.

**Deactivation:** all three paths that set `deactivatedAt` call `revokeAllUserSessions` after the write:
- self-deactivate
- self-delete (pending deletion)
- operator

This is now a census-pinned invariant, not an assumption. P1 therefore needs no `deactivatedAt` term of its own.

**Residual bounded exposure (policy unchanged):**
- Another warm instance can serve verified facts (owner, role, TOTP requirement) for up to `SESSION_CACHE_TTL_MS` (30 s) after a revocation, role or setting change.
- During a store outage it can serve them for up to `SESSION_STALE_GRACE_MS` (120 s) more.
- `requireFresh*` guards always re-read.

**The three `NEXTAUTH_SECRET` / session actions, stated precisely:**
1. **P1 / P1b (done):** possession of `NEXTAUTH_SECRET` alone is insufficient, and the material that would complete a forgery is no longer handed to browsers. The RLS-owned admin route is the one exception until it is released.
2. **First Production rotation:** invalidates the secret historically shared with Preview.
3. **Domain-cutover invalidation:** addresses sessions still live for the old apex host before `fourthmeridian.com` becomes the public site. It may be another rotation or an authoritative mass session revocation, depending on the final cutover architecture. It is **not** a response to any compromise of the new secret.

---

## 18. Stage B as built (2026-10-04): `site/`, the zero-authority public site

Built at `v2.6` `16c638a`. Stage A′ and the root application's request-access implementation were deliberately **not** touched, because the account/Plaid/RLS workstream was active in the root application. The re-audit of 2026-10-04 is the baseline (§1–§17 hold, with the corrections it recorded).

### 18.1 Archaeology: the marketing tree, classified

| Class | Items |
|---|---|
| **A. Safe to move or copy** | Landing page markup; about, security and legal pages; `Reveal` (client island: IntersectionObserver only); `PageHeader`, `Container`, `LegalDocument`, footer; `content/marketing/copy.ts` and the three legal `.md` files; `landing`/`motion`/`Reveal` CSS modules. None imports anything outside the marketing seam (`lib/marketing-boundary.test.ts` already held). |
| **B. Safe after decoupling** | `MarketingNav`: `lucide-react` icons → inline SVG; relative `/login`, `/request-access` → absolute app links passed as props. `Wordmark`: 1.4 MB mark via the image optimiser → 19 KB derived PNG. Landing CTAs: relative → app origin. `legal-content.ts`: `process.cwd()/content/marketing` → site-local. Tailwind utilities (Container, PageHeader, footer, legal, about, security) → CSS modules plus a preflight subset, which drops Tailwind entirely. **Semantic design tokens came from the app's bare `html` selector and could be flipped by the app's `ThemeProvider` (light tokens on a fixed dark page); the site owns a fixed dark token set.** Root metadata (`metadataBase = NEXT_PUBLIC_APP_URL`, app description) → site's own. |
| **C. App only** | `RequestAccessForm` + `lib/marketing/request-access.ts` (posts to `/api/access-request`; **404 ⇒ "queued"**), both `TurnstileWidget`s, root `Providers` (`SessionProvider` fetches `/api/auth/session` on every marketing view; `PlaidProvider`; `ThemeProvider`), `public/manifest.json` (PWA, `start_url: /dashboard`), the request-access **form** itself. |
| **D. Duplication risk** | Design tokens; legal Markdown; `copy.ts`; brand marks. Resolved as guarded copies: byte/declaration parity is enforced by `lib/public-site-boundary.test.ts` until Stage F retires the app's copies. The derived images are documented in `site/README.md`; the app's originals stay the source. |

No site file needed any application module. The boundary was clean, so implementation proceeded.

### 18.2 Architecture

- **`site/` is an independent Next 16.2.7 project** with its own `package.json` (`"type": "module"`), `package-lock.json`, `tsconfig.json` (alias `@site/*`, deliberately not `@/`), `eslint.config.mjs`, `next.config.ts`, `.gitignore`, `.nvmrc` and `vercel.json`.
- **Static export** (`output: "export"`, `images.unoptimized`). There is no server runtime: no route handler, middleware, server action or image optimiser.
- `turbopack.root` and `outputFileTracingRoot` are pinned to `site/`. The config refuses to build if Next's transpilation ever moves `import.meta.url` away from `site/`.
- **Configuration authority:** `site/lib/public-config.ts` is the only `process.env` reader. It reads:
  - `NEXT_PUBLIC_SITE_ORIGIN` and `NEXT_PUBLIC_APP_ORIGIN` (public);
  - `NODE_ENV` and `VERCEL_ENV` (build facts).

  It fails closed:
  - a production build with a missing, http, loopback, path-carrying or credentialed origin fails;
  - a Preview/development Vercel build naming a Production origin fails;
  - the app and site origins must be different hosts;
  - `next dev` defaults to `localhost:3000` (the app) and `localhost:3001` (the site), never Production.
- **Navigation:** "Sign in" → `<app>/login`, "Get Started" → `<app>/request-access`, "Open Fourth Meridian" → `<app>/dashboard`, as plain top-level links.
  - The site never reads a cookie or asks about the session.
  - `/request-access` on the site is a static hand-off page; it keeps old inbound links working.
- **No CORS, no Turnstile, no request-access API** on the site.
- **SEO:**
  - canonical, Open Graph and Twitter metadata on the site origin;
  - `robots.txt` and `sitemap.xml` are static;
  - **only the Production site origin on a Production build is indexable**; Preview and local builds emit `Disallow: /` and `noindex`.
- **Headers** (`site/vercel.json`):
  - an enforced CSP: `default-src 'self'`, `connect-src 'self'`, `form-action 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`;
  - HSTS `includeSubDomains`, which the apex keeps emitting after Stage D;
  - XFO DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP.
- **No crons, rewrites, redirects, functions or env** in `vercel.json`.

### 18.3 Root changes (isolation only)

| File | Change | Why |
|---|---|---|
| `tsconfig.json` | `exclude` += `"site"` | `**/*.ts` pulled 469 site files into the app's typecheck, 435 of them from `site/node_modules` (the `node_modules` exclude matches only the top level) |
| `eslint.config.mjs` | ignore `site/**` | The site has its own config |
| `app/globals.css` | `@source not "../site";` | Tailwind's automatic scan read 46 site files and added 85 site-only class candidates to the **app's** CSS input; now 0 of 2,391 scanned files |
| `lib/public-site-boundary.test.ts` (new) | Converse proof + parity | Covers the root tsc/eslint/Tailwind/test discovery, no app import of `site/`, no workspace/lock coupling, legal/copy byte parity and 19-token parity |
| `scripts/lib/ci-contract.ts`, `scripts/ci-local.ts`, `scripts/ci-local.test.ts`, `.github/workflows/ci.yml` | A third CI job, `site` | `npm ci` + `npm run verify` in `site/`. No secrets, no env, no services; Node from `site/.nvmrc` (same major); the local runner passes only PATH/HOME/TMPDIR |

Nothing in auth, session, RLS, Prisma, Plaid, account code, financial APIs, the root `next.config.ts` or root environment authorities changed.

### 18.4 Proofs

All site proofs run in `site/` (`npm run verify`, CI job `site`); the converse runs in the root suite.

- **Imports:** each import resolves inside `site/` or to an allowlisted, declared package (TypeScript AST). Mutation-tested: `@/lib/db`, `../../lib/auth`, `next/headers` → red.
- **Packages:** no denied package at any lockfile depth. Mutation-tested: an injected transitive `@prisma/client` → red.
- **Environment:** exactly one env reader, four allowlisted names. Mutation-tested: `process.env.DATABASE_URL`, `process.env["…"]` → red.
- **Surface:** no `/api`, route handler, middleware, server action, `fetch`, form, cookie or storage access; every absolute URL comes from the config. Mutation-tested: an `app/api/x/route.ts`, `fetch(...)`, `document.cookie`, a hard-coded app URL → red.
- **Clean-environment build:** `next build` with only PATH/HOME + two origins. The output audit checks for secret-shaped strings, `/api` references, foreign origins, server functions and middleware, and that no workspace root above `site/` was inferred.
- **Fail-closed builds:**
  - no origins → exit 1;
  - Preview naming `https://app.fourthmeridian.com` → exit 1;
  - Production origins → indexable robots plus sitemap, `index, follow`, canonical `https://fourthmeridian.com`, links to `https://app.fourthmeridian.com`.
- **Root converse proof:** mutation-tested by removing `site` from the root `tsconfig` exclude → red; token drift → red; legal-text drift → red.

### 18.5 Owner actions for Stage B

These are listed in `site/README.md` § "Owner actions". In summary:
- create a second Vercel project with Root Directory `site`;
- "include files outside root" OFF;
- exactly two plain environment variables per environment;
- no Shared Environment Variables;
- no crons;
- Ignored Build Step scoped to `site/`;
- **no domain**.

Verify on `*.vercel.app`. Nothing touches the application project, DNS, Plaid or any secret.

### 18.6 New facts for later stages

- **Stage D redirects need a decision.** With a static export there is no server, and `vercel.json` cannot vary by environment. The apex's 308s for `/login`, `/reset-password`, `/dashboard/*` and so on (§9) must preserve path and query to a **per-environment** app origin. Options:
  - (a) Vercel middleware or a function on the site, which adds a server runtime holding only the public app origin;
  - (b) a build-time-generated `vercel.json` per environment, which requires a build step that rewrites it before Vercel reads it, and is unverified;
  - (c) separate Production/Preview site projects.

  Decide before Stage D. (a) is the smallest and keeps zero secrets.
- **Ignored Build Step for the application project:** a `site/`-only commit should not rebuild the app (e.g. `git diff --quiet HEAD^ HEAD -- . ':!site'`). This is an owner setting; it is not configured in the repo.
- **Legal copy:** `terms.md` and `privacy.md` say requests go "through the request-access form on this site". On `fourthmeridian.com` the form is now one click away on the app. That is a copy/legal decision, left unchanged because the parity test requires both trees to change together.
- **No Open Graph image.** The app's `public/og-image.png` is a stale lockup per the root layout's own comment. A branded social image is a design follow-up.

