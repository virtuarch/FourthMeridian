# 27 — Release 2: marketing / SaaS domain split (preparation and cutover gate)

**Date:** 2026-10-23, from 15:15 UTC.

**Target:**
- `fourthmeridian.com` → the public site (Vercel project `fourth-meridian-site`).
- `app.fourthmeridian.com` → the SaaS app (`fintracker1`).

**Status:** **preparation complete; apex cutover NOT performed; awaiting owner approval** (§6). Production stayed public throughout. The apex still serves the app (v2.6 `87e5ac8`).

Step log (private): `~/fm-rehearsal-private/prod-cutover/release.log`.

## 1. Phase A — application subdomain

**Domain and HTTPS:**

| Item | Evidence |
|---|---|
| DNS | NameBright `CNAME app → ba57262d42ca4daa.vercel-dns-017.com` (owner-created). Public resolvers return 216.150.1.1 / 216.150.16.1. The `*` wildcard is untouched |
| Vercel | `app.fourthmeridian.com` attached to fintracker1, production (no branch), verified, not misconfigured |
| TLS | Let's Encrypt, CN/SAN `app.fourthmeridian.com`, valid to 2027-01-21 |

**Routing on `app.`** (same deployment as the apex):
- `/api/health` 200 ok/db ok.
- `/api/spaces` 401.
- `/dashboard` 307 → `https://app.fourthmeridian.com/login?callbackUrl=%2Fdashboard`.
- HSTS and `X-Frame-Options: DENY` are present.

**The apex is unaffected:** `fourthmeridian.com` → fintracker1.

**URL-dependent configuration audit:**

| Concern | Source | Production now | After the switch |
|---|---|---|---|
| NextAuth base and callbacks | `NEXTAUTH_URL` | `https://fourthmeridian.com` (observed via `/api/auth/providers`) | `https://app.fourthmeridian.com` |
| App base: email links (verify, reset, invite, email change, beta invite), Plaid `redirect_uri`, new-Item webhook, `metadataBase` | `NEXT_PUBLIC_APP_URL` (build-time) | the apex (Sensitive; inferred) | `https://app.fourthmeridian.com` |
| Public-site redirects on the app origin (`/` → `/dashboard`; `/about`, `/legal/*`, … → site) | `NEXT_PUBLIC_SITE_URL` (build-time) | unset (inert) | `https://fourthmeridian.com` |
| Plaid overrides | `PLAID_REDIRECT_URI`, `PLAID_WEBHOOK_URL` | unset (derived; correct) | unset |
| Cookies | `__Host-` prefix: host-only, Secure, Lax | no `Domain` attribute, so no sibling can read or set them | unchanged |
| CORS | none granted | — | unchanged |
| Hard-coded apex in runtime code | none (comments only) | — | — |
| Inbound webhooks | Plaid only (`/api/plaid/webhook`) | see §2 | — |

**Plaid OAuth redirect allowlist:** read from the Plaid Dashboard (read-only). It already contains `https://app.fourthmeridian.com/plaid-oauth-return`, alongside the apex, `preview.` and `preview-app.` entries. **No owner action is needed.**

## 2. Phase B — existing Plaid Items' webhooks

**The problem:**
- Plaid stores the webhook URL per Item, fixed at link time.
- Production's 3 ACTIVE Items were linked under the apex, so after the move they would POST to the static site (404).
- Polling crons would still sync them, but transaction freshness would rely on cron cadence alone.

**Supported method:** Plaid `POST /item/webhook/update { access_token, webhook }`. Plaid then sends `ITEM / WEBHOOK_UPDATE_ACKNOWLEDGED` to the new URL.

**Utility:** PR #25 (`fix/plaid-webhook-migration` → v2.6). It must run inside the app, because Production's Plaid secret and the token encryption key are Vercel Sensitive.

| Piece | Behaviour |
|---|---|
| `lib/plaid/webhook-migration.core.ts` | Target derived only from `NEXT_PUBLIC_APP_URL` (public HTTPS, no credentials or query); per-Item plan `UPDATE` / `ALREADY_CURRENT` / `SKIP_STATUS` / `NO_TARGET`; redaction to origin+path |
| `lib/plaid/webhook-migration.ts` | `/item/get` (before) → no-op if already current → `/item/webhook/update` → `/item/get` (verify). It is `NOT_VERIFIED` unless Plaid holds the target. Errors carry the Plaid code only; the token never leaves the helper |
| `GET/POST /api/platform/platform-ops/connections/[id]/webhook` | CONTROL (POST: fresh, revocation-checked) + structured reason. The POST must echo the dry-run target, or it is refused (`TARGET_MISMATCH`). One Item per request. `systemDb` (fm_system) |
| `GET /api/platform/platform-ops/plaid-webhooks` | Roster (database only): ACTIVE / NEEDS_REAUTH Items |
| Audit | `PLAID_ITEM_WEBHOOK_UPDATED` (reason required, before/after origin+path, actor via PLATFORM_GRANT), in the Platform Ops and Security operator feeds |
| UI | Platform Ops → Policies → **Plaid webhook routing**: Check (dry run) / Repoint (reason + two-click confirm). Shows "Last acknowledged" (`WEBHOOK_UPDATE_ACKNOWLEDGED`) as the delivery proof |
| Rollback | Revert `NEXT_PUBLIC_APP_URL`, redeploy, Repoint again. There is no free-text URL path. After the apex move a webhook rollback is unnecessary, because `app.` stays attached |

**Tests:**
- `webhook-migration.core.test.ts` and `webhook-migration.test.ts`: 36 checks against a fake Plaid, including the token-never-in-output check.
- The CONTROL route census and the Platform Ops feed census were updated deliberately.
- `audit-db-authority` stays at baseline (163 / 49 / 58).
- **GitHub CI on `7fdc495`:** `test`, Architecture audits, `status-drift-guard` and the public-site boundary all pass. "Deployment health" is UNVERIFIED by design (Preview 401).
- PR #25 is ready for review and **not merged**; merging is cutover step C0.

**No live Item was touched.** The apex webhook route stays in service until all 3 Items show `ALREADY_CURRENT` and an acknowledgement has arrived.

## 3. Phase C — marketing deployment

**Deployment:** `fourth-meridian-site` Production `dpl_5JHyp77jQQiQ3RBZbQ4TAU23rLQU` (`87e5ac8`), served at `fourth-meridian-site.vercel.app`.

**Production env:**
- `NEXT_PUBLIC_SITE_ORIGIN=https://fourthmeridian.com`
- `NEXT_PUBLIC_APP_ORIGIN=https://app.fourthmeridian.com`

**Checks:**

| Check | Result |
|---|---|
| Public pages `/`, `/about`, `/security`, `/terms`, `/privacy`, `/legal/ai`, `/request-access` | 200 text/html |
| SEO | Production title and description; `robots: index, follow`; canonical and `og:url` = `https://fourthmeridian.com`; robots.txt `Sitemap: https://fourthmeridian.com/sitemap.xml`; sitemap lists 7 apex URLs |
| CTAs | `https://app.fourthmeridian.com/login` (×2), `/request-access` (×2), `/dashboard` |
| Assets | 28/28 referenced local assets 200 |
| App paths on the site (`/login`, `/dashboard`, `/reset-password`, `/api/health`, `/api/auth/session`) | 404 (static page; no API, no auth, no data) |
| Legacy links (browser) | `/reset-password?token=…#frag` → `https://app.fourthmeridian.com/reset-password?token=…#frag` (path, query and fragment intact) |
| Open-redirect probe | `//evil.example/login` stays on the site |
| Headers | Enforced CSP, HSTS (`max-age=15552000; includeSubDomains`; it was missing on Preview, now present), XFO DENY, nosniff, Referrer-Policy |

## 4. Phase D — authentication and session

**What the secret does:**
- `NEXTAUTH_SECRET` signs session JWTs only; it encrypts no stored data.
- TOTP secrets and Plaid tokens use `ENCRYPTION_KEY`, which is unchanged.
- Since P1 (`lib/auth/session-proof.ts`), a signed token alone authenticates nothing: it needs a live, owned `UserSession` row. That limits today's exposure from the secret being shared with Preview.

**Current records:**
- `140sAi8S`: target [production, preview], one shared value since 2026-06.
- v2.6 Preview has its own branch-scoped record `CmbkcdBD`.

**Separation and rotation plan (after the apex move):**
1. Retarget `140sAi8S` to `[preview]` only. Generic Preview keeps its value.
2. Add a new Production-only Sensitive `NEXTAUTH_SECRET`, generated locally and sent on stdin, never printed.
3. Redeploy fintracker1 Production.

**Expected invalidation:**
- Every existing session cookie fails signature verification, so everyone is signed out (2 users).
- The `UserSession` rows become unreachable. Revoking them is optional hygiene.

**Recovery:**
- Sign in again with password + TOTP at `app.`. Nothing else changes: no data, Plaid Items or TOTP enrolment are affected.
- Rollback: retarget `140sAi8S` back to production and redeploy.

**Testing on `app.`.**
- Before the env switch, NextAuth issues apex callbacks, so sign-in on `app.` cannot complete.
- The login, TOTP, wrong-TOTP, logout, password-reset link and Plaid link-token checks are therefore cutover step C3 (§6), run after the env switch and before the apex moves. The apex keeps serving the app until then.
- The same matrix was proven on the Preview pair on 2026-10-07 (`docs/operations/domain-split-preview.md` §4.3).

## 5. Rollback (tested paths)

| Stage reached | Rollback |
|---|---|
| Env switched, apex still on the app | Promote `dpl_6NL1QND6ccmcNvDvtM7x5Mue2Kso` (apex env baked in), or revert the 3 env vars and redeploy |
| Webhooks repointed | None needed: `app.` stays attached and keeps receiving them |
| Apex moved to the site | Remove `fourthmeridian.com` from `fourth-meridian-site`, re-add it to fintracker1 (production), promote `dpl_6NL1QND6…`. No DNS change: same team, A record unchanged |
| Secret rotated | Retarget `140sAi8S` to production and redeploy (sessions are invalidated again) |

## 6. Cutover plan (requires explicit owner approval)

| # | Step | Gate |
|---|---|---|
| C0 | Merge PR #25 → v2.6, then promote v2.6 → main (normal PR + required checks); the Production deploy is READY | Health ok; 0 5xx |
| C1 | fintracker1 Production env: `NEXTAUTH_URL` = `NEXT_PUBLIC_APP_URL` = `https://app.fourthmeridian.com`; add `NEXT_PUBLIC_SITE_URL` = `https://fourthmeridian.com`; redeploy | `/api/auth/providers` on `app.` returns `app.` callbacks |
| C2 | Probe `app.` | `/` → 307 `/dashboard`; `/about` → 308 apex; writes from a foreign Origin → 403 |
| C3 | **Owner smoke on `app.`:** login + TOTP, one wrong TOTP, logout, password-reset email link lands on `app.`, Connections → Plaid link token created (Link opened and closed, no new Item) | Verified server-side (UserSession / AuditLog / logs) |
| C4 | **Owner:** Platform Ops → Policies → Plaid webhook routing: Check, then Repoint each of the 3 Items | Each shows `ALREADY_CURRENT` + "Last acknowledged"; logs show `/api/plaid/webhook` on host `app.` |
| C5 | Move `fourthmeridian.com` from fintracker1 to `fourth-meridian-site` (production) | Apex serves the marketing page; `app.` unaffected; legacy links forward |
| C6 | Rotate `NEXTAUTH_SECRET` (§4); redeploy | Old cookie → signed out; owner fresh login + TOTP on `app.` |
| C7 | 30-minute monitoring | Health, JobRuns, webhooks on `app.`, 0 5xx, integrity invariants |

**Owner actions in the plan:** approve; C3 smoke; C4 repoint (CONTROL in Platform Ops); C6 fresh login. No NameBright change is needed. `www.` stays on the NameBright wildcard, by instruction.
