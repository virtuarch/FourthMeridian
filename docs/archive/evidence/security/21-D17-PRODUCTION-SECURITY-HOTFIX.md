# 21 — D17: Production security hotfix (dependency-only)

**Date:** 2026-10-22/23.

**Mode:** prepare, verify, stage. **Not merged, not deployed.**

**PR:** [#6](https://github.com/virtuarch/FourthMeridian/pull/6) (draft): `hotfix/d17-security-deps` → `main`.

**Recommendation: GO for this security-only hotfix**, subject to the owner's merge approval and the §7 verification. This is independent of the v2.6 release, which stays **NO-GO** (doc 20).

> ⚠️ **Merging PR #6 *is* the Production deployment.** `fintracker1`'s production branch is `main`, with `autoAssignCustomDomains: true`. A merge triggers a Production build and, on success, assigns `fourthmeridian.com`.

## 1. Starting state (verified)

| Item | Value |
|---|---|
| `main` HEAD | `87e4df795b0cc3c433f664efa55ac25dfc16637c` ("fix(plaid): derive OAuth redirect URI…") |
| Production deployment | `dpl_JcZ52DcQdMgCbZvS9zRGSSxhzKxp`: `main` `87e4df7`, READY, 2026-07-27, `fourthmeridian.com` |
| Locked versions on `main` | `next` 16.2.7 · `next-auth` 4.24.14 · `@sentry/nextjs` / `@sentry/core` 10.67.0 · `react`/`react-dom` 19.2.4 · `@prisma/client` 5.22 |
| Runtime | Vercel project `nodeVersion` 24.x. `main` CI uses Node 22. No `engines` / `.nvmrc` on `main` |
| `npm audit --omit=dev` on `main` | **3 critical, 9 high, 3 moderate** |
| Production schema | 88 migrations, newest `20260727_v26pre_b4_btc_identity_backstop` (cutover plan §1; reproduced locally from `main`'s own migrations) |

## 2. Advisories and reachability in Production (`87e4df7`)

Advisory data is from `npm audit` (GitHub Advisory Database), read 2026-10-22.

| Package | Advisory | Severity | Affected → patched | Reachable on Production? |
|---|---|---|---|---|
| `next` | GHSA-2464-fhr4-w9xw (RCE, Image Optimization with SVG) | critical | 16.0.0–16.4.0 → 16.4.1 | **Potentially:** `next/image` used in 5 files; `/_next/image` responds |
| `next` | GHSA-2xp9-vwfh-vxw4 (RCE, Image Optimization with AVIF) | critical | < 16.3.3 | **Potentially** (same surface) |
| `next` | GHSA-cjq9-62q9-8jv4 (SSRF in Image Optimization) | high | < 16.3.8 | **Potentially** |
| `next` | GHSA-673q-mjm6-r5xr (RCE, `use cache`) | critical | ≤ 16.4.0 | No: no `"use cache"` |
| `next` | GHSA-vcvr-r3jv-pc5j (RCE, `next/og` ImageResponse) | critical | 16.2.0 – < 16.3.6 | No: no `next/og` |
| `next` | GHSA-p293-qw3h-jr36 (RCE, Windows hosting) | critical | < 16.3.3 | No: Vercel/Linux |
| `next` | GHSA-p3m5-59mp-jv5r, GHSA-m99w-x7hq-7vfj (DoS, Server Actions); GHSA-89xv-2m56-2m9x (SSRF, Server Actions, custom server) | high | ≤ 16.4.0 / < 16.2.11 | No: no `"use server"`, no custom server |
| `next` | GHSA-6gpp-xcg3-4w24 (proxy bypass, Turbopack + single locale) | high | < 16.2.11 | No: no i18n config |
| `next` | GHSA-p9j2-gv94-2wf4 (SSRF in rewrites) | high | < 16.2.11 | No: no rewrites |
| `next-auth` | **GHSA-xmf8-cvqr-rfgj** (`getToken()` throws on a malformed Bearer header) | high | ≤ 4.24.14 → 4.24.15 | **Yes, reproduced** (§4): `proxy.ts:43` calls `getToken` on every matched request; `Authorization: Bearer %%%` → **HTTP 500** (unauthenticated) |
| `next-auth` | GHSA-7rqj-j65f-68wh (email normaliser homoglyph) | critical | 4.10.3 – < 4.24.15 | No: Credentials provider only, no Email provider |
| `@sentry/nextjs` | GHSA-mchm-gjx6-7h55 (middleware bypass via tunnel route) | critical | < 10.75.2 | No: no `withSentryConfig` / tunnel route |
| `sharp` (via `next`) | GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w (libvips / libheif / librsvg) | high | < 0.35.5 | Potentially: the Image Optimization path |
| `postcss` (via `next`) | GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849 | high | ≤ 8.5.17 | Build-time |
| `axios` (via `plaid`) | 7 high + 5 moderate (HTTP/2, proxy, prototype-pollution gadgets) | high | < 1.20.0 | Server-side Plaid calls; exploitation needs attacker-controlled config or redirects. Low, but runtime |
| `follow-redirects`, `fast-uri` | credential-header stripping; URI host confusion / SSRF | high | < 1.16.1; < 3.1.9 | Runtime-transitive, low |
| `nanoid`, `browserslist`, `brace-expansion`, `source-map-js`, `baseline-browser-mapping` | DoS-class | high/mod | — | Build-time tooling |
| `uuid` (via `exceljs`) | GHSA-w5hq-g745-h8pq | moderate | < 11.1.1 | **Not fixed**: the fix is a breaking major (D10) |

## 3. The change (`cb09ee7`)

**Files: `package.json` and `package-lock.json` only.**

| Package | `main` | Hotfix | Note |
|---|---|---|---|
| `next` | 16.2.7 (exact) | **16.4.2** (exact) | same as v2.6 |
| `eslint-config-next` (dev) | 16.2.7 | **16.4.2** | follows `next` |
| `next-auth` | ^4.24.14 → 4.24.14 | **^4.24.15 → 4.24.15** | same as v2.6 |
| `@sentry/nextjs` (+ `@sentry/core` transitively) | ^10.67.0 → 10.67.0 | **^10.76.2 → 10.76.2** | same as v2.6 |
| Transitive (lockfile only, `npm audit fix`, **no `--force`**) | — | `axios` 1.20.0, `follow-redirects` 1.16.1, `fast-uri` 3.1.9, `sharp` 0.35.5, `postcss` 8.5.23, `nanoid` 3.3.20, `browserslist` 4.29.4, `source-map-js` 1.2.2, `brace-expansion` 1.1.21 / 5.0.12 | All production-tree packages **equal v2.6's validated lock**, except browser-data packages and nested copies that differ by a patch (`caniuse-lite`, `node-releases`, `baseline-browser-mapping`) |

**Lockfile:** 88 entries changed, 4 added, 19 removed. Every `resolved` URL is `registry.npmjs.org`. The diff contains no credentials and no PII; the only URLs are package funding links.

**Not included:** no source, schema, migration, Prisma, `next.config.ts`, `vercel.json`, env, provider or feature change. `react` / `react-dom` stay 19.2.4; `@prisma/client` stays 5.22.

## 4. Evidence

### 4.1 CI and build

| Check | Result |
|---|---|
| `npm audit --omit=dev` | **0 critical, 0 high** (2 moderate: `uuid` via `exceljs`) |
| `main`'s CI on GitHub (PR #6: `test` ×2, Node 22: unit + `tsc` + lint) | **pass** |
| Local (Node 24.21, as Vercel): `npm ci`, `prisma generate`, unit | **393/393** |
| Local `tsc --noEmit` | clean |
| Local lint | 0 errors. 10 warnings vs 7 on `main`: the 3 new ones are a new `eslint-config-next` 16.4 rule (`no-location-assign-relative-destination`) on existing code |
| Local `next build` | OK: Next.js 16.4.2 (Turbopack), 138/138 static pages, proxy present |
| **Route table vs `87e4df7`** (built the same way) | **identical**: 203 entries, same static/dynamic classes |
| Vercel build of `cb09ee7` (`fintracker1` Preview, Node 24.x) | READY `dpl_H5Yszt76…` |

### 4.2 Production-mode runtime smoke (local)

**Why local, not Preview.** `main`'s `lib/env.ts` treats every Vercel deployment as production (`NODE_ENV`). On Preview, where `PLAID_ENV=sandbox`, its boot guard throws, so **any `main`-lineage build returns 500 on every dynamic route on Preview**.
- Proven pre-existing: the untouched `87e4df7` build and the hotfix fail identically under that env.
- v2.6 fixed this with `deploymentEnvironment()`.
- So Preview cannot validate Production compatibility for `main`, and was not used as evidence.

**Setup.**
- Both builds were served with `next start`, `NODE_ENV=production`, Node 24.21.
- Same database: a disposable `postgres:17.6` container on `127.0.0.1` with `main`'s 88 migrations (= Production's schema) and one seeded user.
- Production's required variable *names* were set to local dummy values: `RESEND_API_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_SENTRY_DSN` → `127.0.0.1`.
- Plaid unconfigured (a mode `main` supports).
- The container was removed with its volume afterwards.

| Check | `87e4df7` | **`cb09ee7`** |
|---|---|---|
| `/api/health` | 200 `ok` / `db ok` | 200 `ok` / `db ok` |
| `/`, `/login`, `/register` (`next/image` on `/`) | 200 | 200 |
| `/_next/image?url=/fm-mark-dark.png&w=64` | 200 image/png | 200 image/png (`sharp` 0.35.5 native binary works) |
| Security headers (HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, CSP-Report-Only) | present | present |
| Anonymous `/dashboard` | 307 → `/login` | 307 → `/login` |
| Credentials sign-in: wrong / right / session / `/dashboard` | 401 / 200 / user / 200 | 401 / 200 / user / 200 |
| **`Authorization: Bearer %%%` → `/dashboard`** (GHSA-xmf8) | **500, server error "URI malformed"** | **307 → `/login`, no server error** |
| Other malformed Bearer forms (`Bearer`, `Bearer a.b`, 3 KB) | 307 | 307 |
| Server errors during the run | `Error: URI malformed` | **none** |

## 5. Compatibility review

| Area | Assessment |
|---|---|
| Next.js 16.2 → 16.4 | Same major. `proxy.ts` (16.x middleware) builds and runs; routing table identical; Turbopack build in both. No server actions, `use cache`, rewrites, i18n or `images` config, so the changed surfaces are not in use. |
| NextAuth 4.24.15 | Patch. Credentials flow, JWT session, `getToken` in the proxy, sign-in/out verified. `NEXTAUTH_SECRET` unchanged ⇒ **existing sessions remain valid**. |
| React | Unchanged (19.2.4). |
| Sentry 10.76.2 | Minor within 10.x. `main` has no `withSentryConfig` wrapper or build plugin; `Sentry.init` runs in `instrumentation.ts` (node and edge), `instrumentation-client.ts` and `app/global-error.tsx`. Build and run verified with a DSN set (local sink). |
| Caching / static | 138 static pages, identical route classes. |
| Prisma / DB | Untouched (5.22, no migrations). |
| Production env | Unchanged. `lib/env.ts` / `instrumentation.ts` unchanged, so the same variables that boot `87e4df7` today boot the hotfix. Plaid in Production must stay `PLAID_ENV=production` (as now). |
| Node | Vercel 24.x (unchanged); local runtime 24.21; CI 22. |

## 6. Expected user impact

- No functional change.
- A normal Production redeploy (zero-downtime alias swap).
- Signed-in users stay signed in.
- Unauthenticated malformed-Bearer requests now redirect instead of returning 500.

## 7. Deployment and verification (owner-approved only)

1. **Approve and merge PR #6** (mark it ready for review first). This triggers the Production build.
   - The `fourth-meridian-site` project will also attempt a Production build of `main` and fail. That is harmless: it has no `site/` directory on `main` and has never had a Production deployment.
2. Watch the Vercel Production build reach **READY**, and confirm `fourthmeridian.com` → the new `dpl_…` with commit = the merge SHA.
3. Within 10 minutes:
   - `GET /api/health` → 200 `status ok`, `db ok`;
   - `/`, `/login` → 200;
   - security headers present;
   - `GET /dashboard` signed out → 307 `/login`;
   - `GET /dashboard` with `Authorization: Bearer %%%` → **307**, not 500;
   - one owner sign-in (TOTP) reaching the dashboard;
   - one image via `/_next/image` → 200;
   - Vercel runtime logs: no new error class for 30 minutes;
   - Sentry: events still arrive (one benign error event).
4. Record the result in `docs/operations/production-cutover-checklist.md` as a hotfix entry.

## 8. Rollback

- **Fastest:** Vercel → `fintracker1` → Deployments → **Instant Rollback / Promote** `dpl_JcZ52DcQdMgCbZvS9zRGSSxhzKxp` (`87e4df7`). It is immutable and still present, with no rebuild. **Note:** this re-exposes the advisories.
- **Durable:** `git revert` of the merge on `main` (redeploys `87e4df7`'s dependencies).
- **Data:** none. No migration and no data path change, so no database rollback is ever needed.

## 9. Remaining risks

1. **Production-only configuration was not exercised:** real `PLAID_ENV=production` Plaid calls, the real Resend key, the real Sentry DSN, and Production-scale traffic. Mitigation: §7 checks, plus the Plaid and e-mail code paths are unchanged.
2. **Image Optimization on Vercel** is served by Vercel's image infrastructure in Production. The local run exercised Next's own optimizer. Both are verified to return images; reachability of the Next-side RCE on Vercel is therefore uncertain, but the fix removes the question.
3. **`uuid` / `exceljs` moderate** remains (D10).
4. **The broader Production issues in doc 20 are unaffected:**
   - the SEC-001 pattern in `87e4df7:lib/auth.ts` (code, not a dependency);
   - no RLS;
   - no AI cost controls;
   - the stale old app.

   This hotfix closes the framework/library exposure only.
5. **Future `v2.6` → `main` promotion** will conflict in `package.json` / `package-lock.json`. Resolve by taking `v2.6`'s versions, which are equal or newer.
6. **Preview cannot smoke `main`** (the §4.2 env guard). This is pre-existing and fixed only in v2.6.

## 10. GO / NO-GO

**GO for the hotfix.** The reasons:
- it removes 3 critical and 9 high advisories, including one **reproduced, unauthenticated, reachable** 500 in the proxy and the Image Optimization RCE/SSRF class on a surface Production exposes;
- the change is dependency-only;
- it matches versions already validated on v2.6;
- it is CI-green and builds on Vercel;
- the production-mode runtime parity with `87e4df7` holds on every checked path;
- the rollback is instant and data-free.

**Gate:** the owner's approval to merge PR #6, which deploys Production.
