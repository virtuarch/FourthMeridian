# PO-5A — Beta Launch Gate Hardening: Implementation

**Status:** IMPLEMENTED. Stabilization only — no new product surfaces, no redesigns.
**Date:** 2026-07-19.
**Source:** the PO-5 audit (`docs/audits/PO5_BETA_READINESS_AUDIT.md`). This slice implements the highest beta-impact launch gates and documents what remains config/operator work.

---

## 1. Findings addressed

### Item 1 — Plaid availability gate (P0) ✅ IMPLEMENTED
**Problem:** the Connect action could crash silently — `lib/plaid/client.ts` validated + threw at **module load**, so `link-token`'s top-level import crashed the route before it could guard; the UI still showed "Connect institution" with only a tiny error.

**Fix (reuse only — no duplicated provider logic):**
- **`lib/plaid/client.ts` is now LAZY** — the real Plaid client is built on first *use*, not at import, so importing the module has no side effects and never throws. A misconfigured deploy fails at the first actual Plaid call (guarded away), not at import. `PLAID_ENV` is read raw at import (no validation).
- **`GET /api/plaid/link-token`** returns a clean `503 { error:"unavailable" }` when `env.isPlaidEnabled` is false — no crash.
- **UI** — `env.isPlaidEnabled` is threaded from the server page → `ConnectionsSpaceDashboard` → `ConnectionsActions` (header + empty state). When unavailable, the "Connect institution" button is replaced by an honest notice — *"Bank connections are being set up — check back soon."* — while self-custody "Add wallet" stays available (it doesn't need Plaid). No silent dead end.

**Authoritative availability source:** `env.isPlaidEnabled` (`PLAID_CLIENT_ID && PLAID_SECRET`) — the single existing getter, now actually used.

### Item 4 — Registration consent capture ✅ IMPLEMENTED
**Problem:** a fintech collecting bank data had zero recorded ToS/Privacy consent.

**Fix:**
- **Schema:** `User.acceptedTermsAt DateTime?` + `User.acceptedTermsVersion String?` — additive, nullable; existing rows stay null (never backfilled to a consent not given). Migration `20260719191719_po5a_terms_consent` applied DB-safely (backup → `migrate deploy`, never reset; `migrate status` = up to date, no drift).
- **Register form:** a required "I agree to the Terms of Service and Privacy Policy" checkbox (linking the existing `/terms` + `/privacy` pages); submit is disabled until checked.
- **Register route:** rejects registration (400) unless `acceptedTerms === true`, then records `acceptedTermsAt = now` + `acceptedTermsVersion` (`TERMS_VERSION = "2026-07-19"`) in the create transaction — so a stored consent always reflects a real affirmative action. Applies to invited + open-mode signups alike. Auth flow otherwise unchanged.

### Item 5 — Error visibility baseline (email) ✅ IMPLEMENTED (small surface) + documented gap
**Problem:** operators had no visibility into email delivery; a misconfigured/failing email key silently drops invites + verification links.

**Fix (smallest useful surface over EXISTING data — no schema change):**
- **`ops_email_delivery` widget** (`OpsEmailDeliveryWidget` + `GET /api/platform/platform-ops/email-health`, PLATFORM_OPS READ) over the existing `NotificationDelivery` ledger (its `@@index([channel,status,createdAt])` was built for exactly this). Shows **sent / captured / error** counts over 7 days + recent errors. **"Captured" is flagged** because in production it means email fell back to capture (RESEND unset/failing) and did NOT send — the exact silent failure to catch. Metadata only (no addresses/bodies).
- **Config-time** email visibility is already covered by the existing **`ops_env_status`** widget, which flags `RESEND_API_KEY` (prod-required) as fail/warn when unset.

**Documented gap (deferred):** transactional AUTH emails (verification / invite / reset) go through `lib/email/send.ts` directly and are **not** recorded in `NotificationDelivery` (which requires a `Notification` FK), so they don't appear in the widget. Their config health is covered by env-status; per-message auth-email recording needs a schema change (nullable FK or a small `EmailDelivery` table) and is deferred. The register route already `console.error`s a failed verification send.

### Item 2 — Beta configuration alignment ✅ VERIFIED + DOCUMENTED (no code)
Confirmed: `registration_mode` defaults to **`open`** (`lib/platform-settings.ts`), which contradicts the invite-only marketing copy. The landing/request-access flow is correct for invite-only. **No code redesign** — this is a go-live config step (see checklist §4). `product_status` (development/beta/live) is a separate operator axis.

### Item 3 — Production environment readiness ✅ EXISTING SURFACE (no new system)
The **`ops_env_status` widget** (`OpsEnvStatusWidget` + `/api/platform/platform-ops/env-status` over `getEnvReport()`) already classifies every required/prod-required/optional env var as pass/warn/fail (names + status only, never values). It covers Plaid keys, `RESEND_API_KEY`, `NEXT_PUBLIC_APP_URL`, encryption, etc. **No new operational system built** — this satisfies "if we deployed tomorrow, what config would break onboarding?" at a glance. (Value-level nuance like PLAID_ENV=sandbox-vs-production is a checklist item, since the report never reads values.)

---

## 2. Files changed

| File | Change |
|---|---|
| `lib/plaid/client.ts` | Lazy client (no import-time throw); raw `PLAID_ENV` |
| `app/api/plaid/link-token/route.ts` | 503 availability guard on `env.isPlaidEnabled` |
| `components/connections/ConnectionsActions.tsx` | `plaidEnabled` prop → honest unavailable notice |
| `components/connections/ConnectionsSpaceDashboard.tsx` | thread `plaidEnabled` (header + empty state) |
| `app/(shell)/dashboard/connections/page.tsx` | pass `env.isPlaidEnabled` |
| `prisma/schema.prisma` + `prisma/migrations/20260719191719_po5a_terms_consent/` | `User.acceptedTermsAt` + `acceptedTermsVersion` |
| `app/(auth)/register/page.tsx` | required consent checkbox + gating |
| `app/api/auth/register/route.ts` | consent validation + persistence + `TERMS_VERSION` |
| `lib/platform/email-health.ts` (new) | email-delivery read model over `NotificationDelivery` |
| `app/api/platform/platform-ops/email-health/route.ts` (new) | PLATFORM_OPS READ route |
| `components/platform/widgets/OpsEmailDeliveryWidget.tsx` (new) | email delivery widget |
| `lib/platform/workspaces.ts` · `lib/platform/policy.ts` · `components/platform/PlatformSpaceDashboard.tsx` | register `ops_email_delivery` |

---

## 3. Verification

- **tsc + eslint clean.** Unit: **297/298** in a clean env (the 1 failure is the pre-existing marketing-boundary check on concurrent-session files; 3 additional failures only appear when `.env.local`/network keys are loaded — env-dependent investments/coingecko tests, unrelated to this slice).
- **Migration:** DB backed up first (`backups/…`), applied via `migrate deploy` (additive, no reset), `migrate status` = "up to date", no drift, real data preserved.
- **Browser-verified:** registration consent checkbox renders with linked Terms/Privacy and gates the Create Account button.
- **Failure states reasoned/covered:** Plaid unavailable → 503 + honest UI notice (no dead end); email failure → captured/error surfaced in the widget + `RESEND_API_KEY` flagged by env-status; invite missing / closed beta → existing request-access + registration-policy flow (unchanged, confirmed correct by the PO-5 onboarding trace). Plaid-off UI could not be exercised live (Plaid is configured in dev) — the gate is covered by the 503 route + the `plaidEnabled=false` branch.

---

## 4. Production launch checklist (operator — config, not code)

Before inviting the first beta users, verify in the beta environment:
1. **Plaid:** `PLAID_CLIENT_ID` + `PLAID_SECRET` set; **`PLAID_ENV=production`** (not sandbox); country coverage decided (US-only invites, or add country codes — `link-token` is US-only today).
2. **`registration_mode = invite_only`** (align backend to the invite-only copy) unless open self-serve is intended.
3. **`product_status`** set to `beta`.
4. **`RESEND_API_KEY`** set + sending domain verified (send a real verification/invite and confirm it lands — the Email Delivery + Environment widgets will show "captured" if not).
5. **`NEXT_PUBLIC_APP_URL`** = the real beta URL (verification/invite links are built from it).
6. **`ENCRYPTION_KEY`**, `NEXTAUTH_URL`, Turnstile keys (if abuse protection wanted) present — check the **Environment** widget shows zero `fail`.
7. **Error monitoring** (Sentry or equivalent) configured — still the documented OPS-1 gap (PO-5 P1), an operator/infra decision.

---

## 5. Remaining deferred (per PO-5, not this slice)

Auth-email per-message runtime recording (schema change); error-monitoring adoption; `getClientIp` non-spoofable precedence (P2); Personal-Space "share accounts" dead-end + "Add Manual Asset" mislink (P2 onboarding); unbounded transaction reads (P1 scale — separate perf slice); investment-basis reconciliation note (P2). None block a small, invite-only, US-scoped first beta once §4 is done.

**Constraints honored:** no Spaces/Platform-HQ redesign, no new providers, no PO-4B, no AI expansion, no new operational system beyond the small email widget over existing data.

---

## The question after this slice

*"Would I confidently invite the first 10 beta users?"* — **Yes, once the §4 config checklist is done** (Plaid production keys + `invite_only` + Resend verified). The code-level dead ends and the consent gap are closed; the residual items are operator config and P2 polish, not blockers for a small, supervised first cohort.
