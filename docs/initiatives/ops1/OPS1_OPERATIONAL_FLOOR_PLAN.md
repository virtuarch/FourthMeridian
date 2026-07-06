# OPS-1 — The Operational Floor · Investigation & Implementation Plan

**Status:** PLANNED — investigation complete, zero implementation
**Date:** 2026-07-06 · investigated against the working tree (post-MC1 / FlowType P5, `f22de52` era)
**Track:** `OPS-x` (launch operations substrate) — new prefix, to be allocated in STATUS.md §4 per the namespace rule at implementation start (this folder reserves the ID; no STATUS edit has been made by this document)
**Goal:** the minimum operational floor required before ANY external beta user touches the system. Every slice is a beta entry gate, not a feature.
**Doctrine:** same as every recent initiative — additive-first, behavior-neutral substrate before cutover, one chokepoint per capability, flags documented in `.env.example`, no slice depends on an unshipped later slice.

**This document contains no code changes, no migrations, and edits no existing file. All schema and code described here is FUTURE work.**

---

## 1. Investigation — current state (verified against the repo)

| Capability | Current state | Evidence |
|---|---|---|
| Email | **Nothing.** No provider SDK in `package.json`, no send module, no templates | dependency list; repo-wide grep |
| Password reset | Token machinery is production-grade (random 32-byte, hashed via `lib/password-reset-token.ts`, 1h TTL, non-revealing 200) but **the raw reset URL is returned in the HTTP response** with a "PRODUCTION TODO: replace with email" | `app/api/auth/forgot-password/route.ts` |
| Email verification | None. No `emailVerified*` field on `User`; registration is open and immediate | `prisma/schema.prisma` User model; `app/api/auth/register/route.ts` |
| Invite delivery | `SpaceInvite` requires an **already-registered** `invitedUserId` — there is no invite-by-email path for non-users, and no beta invite concept anywhere (no waitlist/inviteCode/beta hits in schema or routes) | `prisma/schema.prisma` SpaceInvite; repo grep |
| Account deletion | **No endpoint.** `app/api/user/` = password/profile/sessions/totp only. User has ~20 relations; `onDelete` behavior is unaudited; PlaidItem deletion has a Plaid-side obligation (`/item/remove`) | `app/api/user/`; schema User relations |
| Data export | **None.** `exceljs`/`papaparse` serve the *import* pipeline only | `lib/imports/excel.ts`; `app/api/accounts/[id]/import/` |
| Monitoring / errors | **Zero.** No Sentry or equivalent; the v2.4.5 observability counters are named, unimplemented debt; no health endpoint | STATUS §5 v2.4.5 carry-forward; repo grep |
| Uptime alerting | None; no status page | — |
| Rate limiting | Implemented (`lib/rate-limit.ts`, KD-3) but **off unless `RATE_LIMIT_ENABLED=true`**; TOTP `setup`/`disable`/`recovery-codes` intentionally unlimited; flags absent from `.env.example`; fails open silently | `lib/rate-limit.ts` header; STATUS KD-3 caveats |
| Security headers | **None.** `next.config.ts` sets only dev `allowedDevOrigins`; no CSP/HSTS/frame-ancestors/nosniff anywhere | `next.config.ts` |
| Legal pages | None. No ToS/Privacy/LLM-disclosure routes; `/` redirects to `/dashboard/brief`; STATUS blocker 7 ("LLM data-processing posture undefined") is open | `app/page.tsx`; STATUS §6.7 |
| Startup validation | `lib/env.ts` has `validateEnv()` **designed for `instrumentation.ts` — which does not exist** (same gap that leaves `startScheduler()` uninvoked) | `lib/env.ts` header; `jobs/scheduler.ts` header |
| Fail-open safety nets | AI output validator (KD-2) and rate limiter both fail open by design, with no counter/alert on the fail-open path | `lib/ai/output-validator.ts`; `lib/rate-limit.ts` |

**Useful existing substrate OPS-1 rides on (build nothing twice):** hashed single-use token pattern (`lib/password-reset-token.ts`) → template for invite/verification tokens; `AuditLog` + `lib/audit-actions.ts` → all new lifecycle events; `PlatformSetting` → any runtime-tunable toggle; `lib/env.ts` getter/flag pattern → all new env vars; SYSTEM_ADMIN admin surface → beta approval queue home; rate-limit helpers → applied to every new unauthenticated endpoint at birth.

**Sequencing insight from the investigation:** email (Slice 1) is the root dependency — reset, verification, invites, deletion confirmation, and monitoring alerts all consume it. `instrumentation.ts` (Slice 6) is a two-for-one: it is both the Sentry init point and the long-missing `validateEnv()` hook.

---

## 2. Scope boundary

**In:** email substrate; production password reset; email verification; beta invite delivery; account deletion; full data export; error reporting + health + uptime alerting; fail-open observability; rate limiting default-on with TOTP coverage; security headers; ToS/Privacy/LLM-disclosure pages; beta access-gate substrate (request + invite token + register gate).

**Out (named, so they can't creep in):** marketing site content beyond the three legal pages (that is BETA-1/landing work); Space-invite-by-email for non-users (follow-on — reuse the OPS-1 token pattern later); notification system generally (v2.6b — only *transactional* security/beta email is in scope); scheduler substrate / D5 (v2.6b — OPS-1 adds `instrumentation.ts` for Sentry+env only, and explicitly does NOT wire `startScheduler()` there without its own decision); billing (D10 ban holds); SOC 2 program; feature-flag system (env vars + PlatformSetting remain the doctrine); Decimal money migration (VER-1 territory); admin UI polish beyond the approval queue.

---

## 3. Slices

Ordering is dependency-driven. Slices 1–3 are serial; 4, 5, 6, 9 are parallel-safe any time; 7–8 serial pair; 10 last. Each slice is independently shippable and revertible.

### Slice 0 — Allocation & flag doctrine (doc-only)
Allocate `OPS-x` in STATUS.md §4 and add the OPS-1 ledger row in §3. Add ALL flags this initiative will introduce to `.env.example` in one pass — including the already-missing `AI_OUTPUT_VALIDATION_MODE`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_SHADOW` (closing that named v2.4.5 debt item), plus the new `EMAIL_*`, `SENTRY_*`, `BETA_REQUIRE_INVITE` placeholders.
**Gate:** `.env.example` documents every flag the initiative will ship; STATUS ledger row exists; zero behavior change.

### Slice 1 — Email substrate (behavior-neutral, zero callers)
One chokepoint module `lib/email/` mirroring the LLM-provider seam: a single `sendEmail(template, to, data)` entry, a typed template registry (reset, verify, beta-invite, deletion-confirm, security-alert), one provider adapter behind it, and a dev transport that logs/captures instead of sending (so local dev and CI never need credentials — same philosophy as the in-memory rate-limit backend).
**Decision required (§5.1):** provider — recommendation Resend (solo-operator ergonomics, trivial DX); any transactional provider is acceptable; the adapter seam makes it swappable.
**Gate:** unit tests over template rendering + dev-transport capture; repo-wide check that `lib/email/send.ts` is the ONLY import site of the provider SDK (grep-proven, like the single-LLM-import rule); zero production callers; deploy is behavior-neutral. Domain auth (SPF/DKIM) verified on the sending domain before Slice 2 cuts over.

### Slice 2 — Real password reset
Cut `forgot-password` over to the email seam: production returns only the generic message; the raw-URL-in-response branch survives strictly under `NODE_ENV !== "production"`. Add an audit action for reset-email-sent. Token/TTL/hashing untouched.
**Gate:** prod-mode test proves the response body never contains a token; dev capture test proves the email contains a working reset URL; existing reset flow tests stay green; rate limit on the endpoint unchanged.

### Slice 3 — Email verification + security notification
Additive `User.emailVerifiedAt` (nullable — additive migration, no backfill semantics: pre-OPS-1 users are grandfathered as verified-by-invite in the beta era). Registration sends a verification email (hashed single-use token, reset-token pattern); unverified accounts see a verify banner; a `PlatformSetting` decides whether unverified users are blocked or nagged (beta: blocked). Stretch (explicitly droppable without failing the slice): new-device login email on `UserSession` creation from an unseen device fingerprint.
**Gate:** register→verify→login proven in a test; unverified-block enforced when the setting is on; resend endpoint rate-limited from birth; no change to TOTP or session machinery.

### Slice 4 — Rate limiting default-on + fail-open visibility
Flip the semantic: limiter active unless `RATE_LIMIT_DISABLED=true` (or equivalent — the point is that a *missing* var can no longer mean *unprotected*; keep `RATE_LIMIT_SHADOW` as the measurement mode). Extend coverage to the intentionally-unlimited TOTP endpoints (`setup`/`disable`/`recovery-codes` — the KD-3 TODOs) and to every endpoint OPS-1 itself adds (verify-resend, beta request, export, delete). Instrument both fail-open paths: rate-limiter store failure and validator exception each increment a counter and emit a Sentry event (consumes Slice 6; until then, structured log line).
**Gate:** a fresh env with no rate-limit vars set IS limited (test); TOTP endpoints return 429 under hammering (test); fail-open paths provably emit (test with injected store failure). KD-3's "off by default" caveat in STATUS flips to closed.

### Slice 5 — Security headers
`headers()` in `next.config.ts`: HSTS (with sane max-age ramp), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `frame-ancestors 'none'` (nothing embeds this app), `Permissions-Policy` minimal, and CSP in **Report-Only** first. CSP is the only risky item (Next inline chunks, Plaid Link and TradingView embeds are known constraint points — the Plaid CSP requirements must be read against `react-plaid-link` usage); enforce only after a clean report-only window.
**Gate:** headers asserted by an integration test or a checked script against a running build; Plaid Link + TradingView flows manually verified under Report-Only with zero violations before the enforce flip; the enforce flip is its own commit (revertible).

### Slice 6 — Error reporting, health, uptime
Create `instrumentation.ts` (the long-missing hook): `validateEnv()` at boot + Sentry init (server & client; scrub bodies/PII by default — financial data must never ride an error payload). Add `GET /api/health` (DB ping + build/commit id; unauthenticated, rate-limited, no data exposure). Register external uptime monitoring + alerting on `/api/health` and the login page (BetterStack/UptimeRobot class — external service, no code). Wire the Slice 4 fail-open counters to Sentry events. Explicit non-goal: `startScheduler()` stays un-invoked (D5 is v2.6b's decision, not a side effect of this file finally existing — note this in the file header).
**Decision required (§5.2):** Sentry vs. lighter alternative; recommendation Sentry (Next.js/Vercel integration maturity, solo-operator triage UX).
**Gate:** a thrown test error appears in Sentry with PII scrubbing verified; `/api/health` green in prod and monitored externally with alerting to your phone/email; a deliberately broken env var fails the boot loudly (validateEnv proof); STATUS §1 "observability counters not implemented" gets its first real dent.

### Slice 7 — Full user data export
`GET /api/user/export` (authenticated, rate-limited, audit-logged): a machine-readable JSON bundle + human-usable CSVs (transactions, accounts, holdings, snapshots) zipped. Contents: profile (decrypted DOB — it's the user's own), personal-Space data in full, shared-Space data **filtered through the same KD-19/`lib/ai/visibility.ts` predicates as every other read surface** (export must not become a visibility bypass — this is the subtle correctness risk of the slice), goals, import batches, FX-converted totals *labeled* as estimates per MC1 doctrine. Excluded and documented: secrets (Plaid tokens, TOTP seed, password hash), other users' data, raw audit rows beyond the user's own auth events. Sync single-request is fine at beta scale (5k-row cap precedent says volumes are modest); async job explicitly deferred.
**Gate:** two-user Space test proves a BALANCE_ONLY counterparty's transactions are absent from the export (extends the existing two-user proof harness); export of a seeded user round-trips through the CSV importer for transactions (self-consistency check); no encrypted-at-rest secret appears in any export byte (grep the artifact in test).

### Slice 8 — Account deletion
Two phases inside one slice. **(a) Deletion inventory (investigation artifact, committed to this folder):** walk every User relation and decide per table — cascade, anonymize, or retain; audit the schema's existing `onDelete` directives against those decisions; enumerate external obligations (Plaid `/item/remove` per item — also stops item billing; OpenAI has no stored-state obligation, but say so in the disclosure page). **(b) Implementation:** `DELETE /api/user` with re-auth (password + TOTP if enrolled), a typed confirmation, a grace-period design decision (§5.3 — recommendation: 7-day soft window with cancel link via email, matching the existing trash/purge idiom), then hard erasure. Named hard problems the inventory must answer, not dodge: **shared Spaces** (sole OWNER of a shared Space with active members → block deletion until ownership transferred or Space deleted — mirror the `member:remove` OWNER residual in `lib/spaces/policy.ts`); **audit log** (recommendation: retain rows, null/anonymize the userId linkage — deletion of a user must not delete the security history of *other* users' Spaces they touched; state this in the privacy policy); **counterparty visibility** (accounts they shared into others' Spaces disappear — SAL revocation events must fire so snapshots regenerate via the existing EV-1 handler). Admin surface: the same machinery exposed in the admin panel (audit-logged) — build once, expose twice.
**Gate:** deletion inventory doc reviewed & committed BEFORE code; post-deletion zero-residue proof (scripted query sweep for the userId across all tables, allowing only the anonymized audit rows); Plaid items provably removed (sandbox); deleted user's email can re-register cleanly; purge actually runs (this slice may NOT depend on the never-invoked scheduler — purge must be a Vercel cron or inline check, decided in the slice).

### Slice 9 — Legal surface (parallel-safe from day one)
Three public static routes — `/terms`, `/privacy`, `/legal/ai` (LLM data-processing disclosure) — outside the auth gate (verified compatible: `proxy.ts` only guards `/dashboard/*` and `/admin/*`). Linked from login, register, and the future request-access page; register gains an explicit accept checkbox + `acceptedTermsAt` timestamp (additive). Content drafted honestly for a beta: no-financial-advice clause, beta availability disclaimer, the OpenAI processing disclosure with named retention posture (closes STATUS blocker 7), deletion/export rights (which Slices 7–8 make TRUE before this page claims them). **Constraint:** counsel review is a launch blocker for public/paid launch (v3.0/L-1) but drafted-honest pages are acceptable for a hand-picked beta — record this risk acceptance in the ledger row.
**Gate:** pages reachable logged-out; register requires acceptance and stamps it; every claim on the pages is true of the deployed system on the day it deploys (checklist review against Slices 2/3/7/8 — the privacy page cannot ship before deletion/export exist).

### Slice 10 — Beta access-gate substrate (the bridge to BETA-1)
The prerequisite plumbing only — cohort strategy, approval cadence, and the marketing request page belong to BETA-1. Additive schema: `AccessRequest` (email, two qualifying answers, status, notes, cohort tag) and `InviteToken` (hashed single-use, email-bound, expiring — the Slice 1/3 token pattern again). Public rate-limited `POST /api/access-request`; admin queue tab (list/approve/reject/hold/note) on the existing SYSTEM_ADMIN surface, approval sends the invite via Slice 1; `BETA_REQUIRE_INVITE` flag gates `register` (token required + consumed when on). Because registration-by-invite proves inbox ownership, an invited signup is born verified (sets `emailVerifiedAt`) — the Slice 3 flow remains for any non-invite era.
**Gate:** flag ON: no token → register refuses; valid token → account created verified + token consumed (single-use proven under replay); flag OFF: behavior identical to pre-OPS-1 (the open-registration seam survives untouched for the eventual public flip); approve/reject fully audit-logged; queue usable end-to-end by a non-engineer (you, on your phone).

---

## 4. Validation gates & launch blockers

**Initiative-level validation (all must hold at closeout, in the STATUS ledger row):**

1. Repo-wide grep proofs: exactly one email-provider import site; zero token-bearing response bodies in production paths; zero OPS-1 endpoints lacking a rate-limit call.
2. The two-user privacy proof extended to cover export (Slice 7) and deletion side effects (Slice 8) — and the standing recommendation from the 2026-07-06 audit is repeated here: this harness belongs in CI with a Postgres service container (VER-1 scope, but OPS-1 must not widen the un-CI'd surface).
3. A fresh clone + `.env.example` + documented steps boots with every OPS-1 feature functional in dev transport/shadow modes — no undocumented env var (this is the `.env.example` debt, closed for good).
4. `tsc --noEmit`, `lint`, `npm test` green per slice — house standard.

**Beta launch blockers (no external user until ALL are checked):**

| # | Blocker | Slice |
|---|---|---|
| B1 | Password reset works over real email in production; no token in any response body | 1–2 |
| B2 | Email verification enforced (or invite-born-verified) for every new account | 3, 10 |
| B3 | Rate limiting ACTIVE in production, TOTP endpoints covered, fail-open alerting live | 4 |
| B4 | Security headers deployed; CSP at minimum clean in Report-Only with Plaid/TradingView verified | 5 |
| B5 | Sentry receiving prod errors (PII-scrubbed); `/api/health` externally monitored with alerting that reaches a human | 6 |
| B6 | A user can export everything and delete everything, provably, without operator help | 7–8 |
| B7 | Terms/Privacy/LLM disclosure live, accepted at registration, and factually true | 9 |
| B8 | Register is invite-gated; approval queue works end-to-end including the invite email | 10 |
| B9 | One restore drill performed against a Supabase backup, written up in `docs/operations/` | — (ops task, no code; do it during Slice 6 week) |
| B10 | Secrets hygiene: repo moved out of the cloud-synced path or secrets externalized; `.env.bak` keys rotated (2026-07-06 audit finding — cloud sync is the KD-13 root cause AND a secrets exposure) | — (ops task) |

B9 and B10 are deliberately in the blocker list despite requiring no code: OPS-1 is an operational floor, not a code initiative.

**Explicitly NOT blockers (resist scope creep at closeout):** enforced CSP (Report-Only suffices for beta), the new-device-login email (stretch), a status page (external monitor alerting suffices), counsel-reviewed legal text (beta risk acceptance; blocker again at v3.0), async export jobs, Space-invite-by-email.

---

## 5. Open decisions (resolve at slice entry, not before)

1. **Email provider (Slice 1):** Resend recommended; Postmark strong alternative; SES if cost-paranoid. The adapter seam makes this a low-stakes decision — time-box it to an hour.
2. **Error reporting (Slice 6):** Sentry recommended; the real decision is the PII-scrubbing config, which deserves more attention than the vendor.
3. **Deletion grace period (Slice 8):** immediate hard-delete vs 7-day soft window. Recommendation: 7-day window (matches trash idiom, protects against account-takeover-then-delete, gives the cancel-link email a job) — but note it requires the purge to actually run (Vercel cron slot or inline check; the Hobby-plan cron budget already holds 2 of its slots, verify the limit before committing).
4. **Audit-log anonymization semantics (Slice 8a):** retain-and-anonymize recommended over cascade-delete; must be stated in the privacy policy either way — the inventory doc is the decision record.
5. **Rate-limit flag polarity (Slice 4):** `RATE_LIMIT_DISABLED` opt-out vs `NODE_ENV`-keyed default-on. Either closes the gap; pick one and update STATUS KD-3.
6. **`emailVerifiedAt` vs NextAuth's conventional `emailVerified`:** naming only; decide once at Slice 3 migration authoring.

---

## 6. First implementation prompt

Paste-ready for the first working session:

> Implement OPS-1 Slice 0 and Slice 1 only, per `docs/initiatives/ops1/OPS1_OPERATIONAL_FLOOR_PLAN.md`.
>
> Slice 0: allocate the `OPS-x` track prefix in STATUS.md §4 and add the OPS-1 ledger row to §3 (status Active, this plan as evidence). Update `.env.example` in one pass with every flag OPS-1 will introduce, plus the three already-shipped-but-undocumented flags named in the v2.4.5 carry-forward debt: `AI_OUTPUT_VALIDATION_MODE`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_SHADOW`. No behavior change of any kind.
>
> Slice 1: build the email substrate at `lib/email/` with zero production callers. Requirements: (1) a single `sendEmail()` chokepoint — the provider SDK may be imported in exactly one file, grep-enforced the same way the single-LLM-import rule works; (2) a typed template registry with five templates: password-reset, email-verification, beta-invite, deletion-confirmation, security-alert — plain, text-first, no HTML framework; (3) a dev/test transport that captures instead of sending, selected the same way `lib/rate-limit.ts` selects its in-memory backend, so local dev and CI need no email credentials; (4) provider adapter for [Resend — or substitute the Slice-entry decision] behind the seam; (5) new env vars accessed via the existing `lib/env.ts` getter pattern, documented in `.env.example` (done in Slice 0); (6) unit tests: template rendering snapshots, dev-transport capture, and a test that the chokepoint refuses to send in test mode.
>
> Constraints: additive only — no migrations, no changes to any existing route or module besides `.env.example`, `lib/env.ts`, and STATUS.md as described. The deploy must be behavior-neutral (zero callers). Validation: `tsc --noEmit`, `lint`, `npm test` green; grep proof of the single-import rule included in the closeout note. Do not start Slice 2.

---

*Investigation sources: `app/api/auth/*`, `app/api/user/*`, `prisma/schema.prisma` (User, SpaceInvite, PlatformSetting, RateLimit), `lib/rate-limit.ts`, `lib/env.ts`, `lib/password-reset-token.ts`, `lib/plaid/encryption.ts`, `next.config.ts`, `proxy.ts`, `vercel.json`, `.github/workflows/ci.yml`, `jobs/scheduler.ts`, STATUS.md §§1–7, and the 2026-07-06 pre-launch audit (`PRELAUNCH_AUDIT_2026-07-06.md`).*
