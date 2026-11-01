# Audit — Production Readiness

> **Reconciliation note (2026-10-14).** The verdict below ("not ready for external users; the gap is configuration and operations") still holds, but several rows are superseded by later, dated records — read them before acting on a row here:
>
> - **Readiness verdict and gates:** the first-five beta verdict is **GO, conditional** on owner configuration acts ([P0 report §I](../plans/OPERATIONALIZATION-P0-REPORT-2026-10-07.md), [P1 report §O](../plans/OPERATIONALIZATION-P1-REPORT-2026-10-08.md)). The binding path to Production is the [production cutover plan](production-cutover-plan.md) (PLAN ONLY, NO-GO until its §6 gates are green).
> - **Closed since this doc's last reconciliation (2026-10-07, P0):** blocker 1 / gate 9 (AI disclosure now names OpenAI and the data sent; the retention window is still withheld pending the provider answer); blocker 9 / gate 6 (support address published; see `legal-factual-basis-2026-10-07.md`).
> - **Superseded facts:** gate 1 — `NEXT_PUBLIC_SENTRY_DSN` was measured **present** on Production on 2026-10-06 (cutover plan §1); that proves configuration only — event delivery was last proven for the v2.5 build on 2026-07-26 and is unproven for v2.6 until it is deployed (gate 1 row below). New since P0: `PLATFORM_ALERTS_EMAIL` is required on Production and is **absent** (a candidate deploy will not boot without it).
> - **Still open as written:** Turnstile keys (gate 4), external uptime monitor (7), backup/restore drill (8; the cutover plan rehearses a dump/restore in a clone), `registration_mode` re-verification (5; last verified 2026-08-17), `PLAID_ENV` / `INVESTMENT_OBSERVATIONS_ENABLED` value verification (2, 3).
> - **Not covered here at all:** the RLS role topology and strict mode Production must adopt at cutover, and the session-model change (`environment-separation.md`, `rls-preview-cutover.md`).
>
> Current state is tracked in [`/STATUS.md`](../../STATUS.md) §7–§8, §11–§14.

*The single living production-readiness snapshot. Regenerated from the beta-blocker analysis; supersedes the readiness tables previously scattered across STATUS and the prelaunch audit. The audits category expires at first production release.*

**Verdict:** Not ready for external users. The core platform architecture is largely built; the binding gap is **verification / configuration / operations**, not feature construction.

## Strengths (verified)

- Deterministic-first AI architecture (pre-computed, provenance-carrying assessments; the model narrates, never calculates — [../systems/ai.md](../systems/ai-foundation.md)).
- Plaid identity-instability handling with a convergent, never-hard-deleting merge engine.
- Boundary discipline: single auth chokepoint, single LLM import site, single decrypt module, HKDF per-purpose keys, tenancy with no admin bypass ([../doctrine/platform-and-security.md](../architecture/SECURITY_MODEL.md)).
- Disciplined additive-first migration execution.

## Must close before the first external beta user

Separated into code / configuration / operational acts:

| # | Blocker | Kind |
|---|---|---|
| 1 | **LLM / OpenAI disclosure + retention posture** — `/legal/ai` names neither the provider nor a retention window; its "not a chat window you have to prompt" line also misdescribes the shipped `app/api/ai/chat` surface | Decision + copy |
| 2 | ~~**Sentry error monitoring** — not configured~~ **CODE CLOSED (V25-FINAL-2, `f8ad187`).** `@sentry/nextjs` wired via Next-16 native hooks (`instrumentation.ts` server/edge init + `onRequestError`, `instrumentation-client.ts`, `app/global-error.tsx`) over one client-safe config (`lib/monitoring/sentry-options.ts`) with financial/PII scrubbing; `NEXT_PUBLIC_SENTRY_DSN` is in `PROD_REQUIRED_KEYS` so prod boot fails without it. **Remaining = config act: set the production DSN.** | Config (was code) |
| 3 | **External uptime monitoring** on `/api/health` | Ops act |
| 4 | **Backup restore drill** recorded in `docs/operations/` — verify Supabase PITR | Ops act (needs runtime/DB verification) |
| 5 | **Production beta gate verified `invite_only`** — DB default is `open`; the single most urgent config act | Config (needs verification) |
| 6 | **Turnstile production keys** live — a CAPTCHA is a no-op without them | Config (needs verification) |
| 7 | **Production Plaid credentials** — ~~`PLAID_ENV=sandbox` default; no prod guard~~ **GUARD CLOSED (V25-FINAL-2, `f8ad187`):** `validateEnv()` now throws at boot when `NODE_ENV=production` and Plaid credentials are present but `PLAID_ENV !== "production"` (no silent sandbox); the intentional Plaid-disabled prod mode is preserved (fires only when both creds present). **Remaining = config act: provide production Plaid client id/secret + `PLAID_ENV=production`.** | Config (was decision+config) |
| 8 | **Production email / domain verification** (Resend) | Config (needs verification) |
| 9 | **Published support address** — `support@fourthmeridian.com` exists only as a sender identity (`lib/email/senders.ts`); zero occurrences in user-facing surfaces. *Promoted from "beta-acceptable" — a beta with no reachable support channel has no defect-report path.* | Copy (small) |

### Closed since the last reconciliation

- **Registration consent capture** — closed in `630a84e` (PO-5A). `User.acceptedTermsAt` + `acceptedTermsVersion` at `prisma/schema.prisma:367`, migration `20260719191719_po5a_terms_consent`, server-side rejection at `app/api/auth/register/route.ts:76` (`acceptedTerms !== true`), persisted with `TERMS_VERSION` at `:205`, and a submit-gating checkbox in `app/(auth)/register/page.tsx:404`. Verified in code, V25-CLOSE-1.

## Beta-acceptable limitations (close shortly after beta)

- Dynamic-window / follow-up / drilldown characterization suites — re-homed to AI5-1 (bounds-not-dollars).
- CSP Report-Only → enforced after a clean observation window.
- Formal accessibility audit; status page; async export.
- Counsel-reviewed final legal text is deferred to v3.0 — the drafted legal pages are operationally honest but not attorney-approved. This does **not** downgrade the real blockers above (consent, LLM disclosure, Sentry, backup drill).

## Known risks

Migration seams open concurrently; verification debt (invariants asserted in comments, not checked in code); solo-maintainer bus factor; `Float` for money ([../architecture/decisions/DEC-0.md](../decisions/ADR-005-numeric-precision.md)); documentation weight exceeding maintenance capacity.

Recorded in the v2.5 closure review (2026-07-20). Re-verified in the V25-FINAL-3 closure gate (2026-07-22) — **three of the four are now CLOSED by the V25-FINAL / V25-CLOSE slices; the fourth is verified-intended:**

- ~~**FX rate-miss renders native amounts as target currency.**~~ **CLOSED (V25-FINAL-1, `e3c91d0`).** `convertMoney` now returns `amount: number | null` — `null` for an unavailable known-currency conversion, never the native magnitude relabeled. The type compiler-enforces that no consumer sums a fake zero; aggregators exclude and carry `unconverted`; Wealth/Cash-Flow/AI/txn-detail expose the incompleteness. Pinned by `lib/money/*.test.ts`, `components/charts/fx-disclosure-surface.test.ts`, `lib/perspectives/envelope.test.ts`.
- ~~**Operator gating inverted relative to blast radius (admin Plaid routes unaudited).**~~ **CLOSED (V25-CLOSE-3 Part 3; re-verified V25-FINAL-2).** All three `app/api/admin/plaid/*` mutating routes write a typed, attributed, secret-safe `auditLog` row (`ADMIN_PLAID_*`); the read-only `diagnostics` route is correctly unaudited. Enforced by `lib/admin-plaid-audit.test.ts`.
- ~~**Space visibility has three independent query implementations with no parity guard.**~~ **CLOSED (V25-CLOSE-2).** `lib/visibility-resolver-parity.test.ts` now asserts the three resolvers keep the single `TRANSACTION_DETAIL_VISIBILITY` predicate and identical `ACTIVE`/soft-delete traversal — a regression that widens one resolver's set now fails the suite.
- **Account deletion and shared accounts — VERIFIED INTENDED (V25-FINAL-3 read-only).** `lib/account-deletion/purge.ts` deletes only USER-owned and **PERSONAL single-OWNER-ACTIVE** space accounts; a sole-owner-of-a-shared-space deletion is *blocked at request* (`preflight.ts`), SALs the user added are `REVOKED` (not deleted), and FK postures are `SetNull` (pinned by `lib/deletion-safety.test.ts`). Shared accounts are not orphaned or wrongly destroyed. *(Co-member notification on account survival remains a nicety, not a blocker.)*

### Fault-tolerance gates named by V25-FINAL-3 (2026-07-22) — BOTH NOW CLOSED IN CODE

Neither invalidated the v2.5 architecture (both were ingestion/lifecycle fault-tolerance, not authority defects), and both were closed before external beta:

- ~~**Sync cursor advances past a swallowed transaction-upsert failure**~~ **CLOSED (PRE-V26-PLAID-CLOSE, `986d97a`).** A Plaid cursor may now advance past a page only when every canonical persistence obligation for that page has succeeded. Both lossy paths — an unresolved `account_id` (`MISSING_ACCOUNT`) and a transaction upsert throw (`UPSERT_ERROR`) — mark the page incomplete; the page's cursor is not written and `syncTransactionsForItem` throws `PlaidSyncIncompleteError`, so the same page replays. A returned result therefore *means* complete persistence (there is deliberately no partial-result field). Replay is idempotent by construction: `Transaction.plaidTransactionId` is unique, the write path resolves findUnique→update before create with a fingerprint fallback, `removed[]` is guarded on `deletedAt`, and merchant writes are upserts. The error is deliberately non-Axios so the health classifier leaves the item `ACTIVE` with `syncIncompleteAt` set — "retry me", not "broken". Verified behaviourally in `lib/plaid/cursor-safety.test.ts`.
  *Historical note:* the July-2 2026 payroll incident was this failure class. It was recovered by the cursor-reset replay at the time (the row is present and unduplicated); it is **not** an active unrecovered corruption. The class is now closed at the source.
- ~~**Account-deletion Plaid `itemRemove` is fail-open**~~ **CLOSED (PRE-BETA-OPS-CLOSE, `657e850`).** Three faults compounded before: the failure was downgraded to a count, the item was marked `REVOKED` anyway (which also excluded it from the deletion cron's own `status: ACTIVE` work-list), and the purge completed, cascading the encrypted token away. Now only a *confirmed* outcome marks `REVOKED` — either a successful `itemRemove`, or `ITEM_NOT_FOUND`, the sole error code that proves the item is already absent upstream (`INVALID_ACCESS_TOKEN` is deliberately excluded, since it can equally mean a rotated token). A retryable failure **holds** the deletion: the User row, the PlaidItem and its token survive, `deletionScheduledAt` is untouched, and the existing daily cron retries. Attempts are bounded to 3 and counted in **distinct calendar days**, so a duplicate or manually re-run cron cannot burn the budget early. On the third day the deletion completes — a provider outage must not hold a user's data hostage — and writes a durable `ACCOUNT_DELETED_UNREVOKED` audit row, a **distinct action** from `ACCOUNT_DELETED` so no reader can mistake a completed deletion for a completed revocation. That row carries the item id and institution an operator needs to revoke by hand, and **no token** (every audit write and log line is scanned for secrets by test). `AuditLog.userId` is `SetNull`, so the evidence survives the deletion it describes. Fourth Meridian stops ingesting regardless. Verified in `lib/account-deletion/revocation.test.ts` and `purge-revocation-wiring.test.ts`.

### Remaining production / beta gates (configuration and operator acts only)

No v2.5 **code** blocker remains. Everything below is configuration, an external service act, or a policy decision. Values held in Vercel are encrypted; presence was verified by NAME only, and no value was read.

| # | Gate | Verified state | Kind | Blocks |
|---|---|---|---|---|
| 1 | `NEXT_PUBLIC_SENTRY_DSN` | ~~ABSENT from Production~~ **PRESENT on Production (verified by name, 2026-10-06, cutover plan §1)**. Configuration ≠ delivery: the last *proven* Production event delivery is the 2026-07-27 Sentry investigation (events from the v2.5 build up to 2026-07-26; [record](../plans/Sentry-Production-Health-Investigation.md)). Delivery from the v2.6 candidate is unproven until it is deployed; Preview delivery was never asserted (`environment-separation.md` asks to confirm `environment=preview` tagging). | Config (closed) + verification (open) | Deploy boots (it is in `PROD_REQUIRED_KEYS`); post-cutover acceptance should include one deliberately captured event |
| 2 | `PLAID_ENV = production` | Key present, **value not verifiable** | Config — manual verification | Deploy (the V25-FINAL-2 guard throws if creds exist and the env is not production) |
| 3 | `INVESTMENT_OBSERVATIONS_ENABLED = true` | Key present, **value not verifiable** | Config — manual verification | Correct investment display: `getCurrentPositions()` reads `PositionObservation` only (no Holding fallback), so a disabled writer yields a silently empty portfolio |
| 4 | Turnstile site + secret keys | **Both ABSENT from Production** | Config — Preview first, then **separate owner approval** for Production (see [Beta intake hardening](#beta-intake-hardening-r2-2026-10-31)) | External beta — with no secret `captchaMode()` is `not_configured` and `verifyCaptchaToken` returns `true`, so CAPTCHA is a no-op (logged once per process) |
| 5 | `registration_mode = invite_only` | **Not verifiable** (DB `PlatformSetting`; ship default is `open`) | Config — manual verification | External beta |
| 6 | Published support address | `support@fourthmeridian.com` exists only in `lib/email/senders.ts`; **0 user-facing occurrences** | Copy | External beta |
| 7 | External uptime monitor on `/api/health` | Not present in repo config | Ops act | External beta (Sentry is error capture, not availability) |
| 8 | Backup / restore drill (Supabase PITR), RPO/RTO recorded | No record in `docs/operations/` | Ops act | External beta |
| 9 | LLM / AI disclosure | `content/marketing/legal-ai.md` says "a third-party model provider" but names neither the provider nor a retention window | Policy + copy | External beta |

Already satisfied and verified by name in Production: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `CRON_SECRET`, `RESEND_API_KEY`, `OPENAI_API_KEY`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `DATABASE_URL`, `DIRECT_URL`, `ENCRYPTION_KEY`, `DISABLE_SYSTEM_ADMIN`. Cron is configured in `vercel.json` (`/api/jobs/dispatch`). Prisma: 76 migrations, all applied, none pending — **no migration or backfill is required to merge or deploy.**

## Beta intake hardening (R2, 2026-10-31)

Owner-approved controls on the public `POST /api/access-request` intake and the shared CAPTCHA helper.

### CAPTCHA (Cloudflare Turnstile) — behaviour

| Mode (`captchaMode()` in `lib/captcha.ts`) | When | Behaviour |
|---|---|---|
| `not_configured` | `TURNSTILE_SECRET_KEY` unset | Verification skipped, returns `true`; one `[captcha] … NOT enforced` warning per process |
| `enforced` | `TURNSTILE_SECRET_KEY` set | Only a Cloudflare `success: true` is `passed`. Missing token or `success: false` is `rejected`; non-2xx, network error, timeout (5 s) or a malformed reply is `unavailable`. Both **fail closed** |

Callers sharing these semantics: access-request (every submission), register (every registration), and login step-up in `lib/auth.ts` (only after `LOGIN_CAPTCHA_THRESHOLD` failures on an identifier). `rejected` → the existing 400 (routes) / denied login. `unavailable` → an honest **503 "temporarily unavailable"** with `Retry-After` on access-request and register, and `TEMPORARILY_UNAVAILABLE` (the `AUTH_UNAVAILABLE_TOKEN` sentinel, Sentry `auth_stage: captcha`) on a step-up login — thrown before the user lookup, so it writes no `LOGIN_FAILED` row. **Consequence of fail-closed:** during a Cloudflare siteverify outage those three paths are refused until it recovers; ordinary logins below the threshold are unaffected.

### Enabling Turnstile — Preview first, Production only after a separate approval

1. In the Cloudflare dashboard create a Turnstile widget (Managed mode) whose hostnames include the Preview app and public-site hosts (`preview-app.`, `preview.`) — and, later, the Production hosts.
2. In Vercel set, **scoped to Preview (develop branch) only**:
   - `NEXT_PUBLIC_TURNSTILE_SITE_KEY` — the widget's site key (public; inlined into client bundles at **build** time, so a redeploy is required).
   - `TURNSTILE_SECRET_KEY` — the widget's secret (Sensitive).
   Set **both together**: the secret without the site key means no widget renders and every gated request is refused (boot-time `validateEnv()` logs a loud `[env] … Set both or neither` error for either half missing — warn-only, never fatal — and the verifier logs `[captcha] … NEXT_PUBLIC_TURNSTILE_SITE_KEY is not`).
3. Redeploy Preview. Validate: the request-access form, `/register` and a login past 3 failed attempts all render the widget and succeed; a request with no/invalid token gets `400 CAPTCHA verification failed`; logs show `[captcha] Turnstile verification enforced (fail-closed)`.
4. Production: repeat step 2 for the Production scope **only after the Preview validation is recorded and the owner approves separately.**

Rollback: unset `TURNSTILE_SECRET_KEY` (and the site key) and redeploy — behaviour returns to `not_configured`.

### Access-request limits

| Control | Value | On exceed | Store failure |
|---|---|---|---|
| Per IP | 5 / 15 min | 429 | fail-open |
| Global (all callers, counted after CAPTCHA) | PlatformSetting `beta_intake_global_limit_per_hour` per UTC hour — integer 10–1000, default **60**, Growth & Revenue WRITE, resettable | 429, generic message; the hour is recorded ONCE as `BETA_INTAKE_THROTTLED` | fail-open (availability; per-IP + CAPTCHA still apply). An unreadable/invalid setting ⇒ 60 |
| Per address **as stored** (sha256 of lowercase + trim — deliberately NOT the canonical form, so `victim+1@` cannot fill `victim@`'s bucket) | 3 / 24 h | **identical 200, submission silently dropped** (no waitlist, event or per-submission audit row, no e-mail; the hour is recorded ONCE as `BETA_INTAKE_DUPLICATE_DROPPED`) — a 429 would be an existence oracle | fail-open |
| Operator e-mail (`BETA_REQUESTS_EMAIL`) per **canonical** address (`+tag` dropped, Gmail dots folded — can only reduce operator mail) | 1 / 24 h | e-mail skipped, request still stored, `[access-request] operator notification throttled reason=email` | fail-open (e-mail sent) |
| Operator e-mail, global | 20 / hour | e-mail skipped, request still stored, `… reason=global` | fail-open |

All counters live in the existing `RateLimit` table (no raw addresses in keys; swept after 24 h). The limits honour `RATE_LIMIT_ENABLED`/`RATE_LIMIT_SHADOW` like every limiter; the operator-e-mail throttle is a cost control and applies in every environment. Origin/Referer headers are **not** used as a bot control.

**Monitoring.** Each refusal by the global ceiling and each per-address drop increments a per-UTC-hour counter in the `RateLimit` store (`counter:beta-intake:<action>`, kept 24 h), and the FIRST event of each hour writes one `AuditLog` row — `BETA_INTAKE_THROTTLED` / `BETA_INTAKE_DUPLICATE_DROPPED`, no userId, metadata `{ hourWindow, limit }` only (no address, no hash). Never one row per request. Throttled rows mean legitimate applicants may have been turned away that hour: consider raising the setting.

### Network-field retention

`BETA_ACCESS_REQUESTED` audit rows keep the raw IP and user agent for **90 days**. The daily `purge-trash` run (`jobs/data-retention.ts`, `runBetaIntakeNetworkMinimisation`) then nulls `ipAddress`/`userAgent` and adds `metadata.uaFamily` (browser / script / headless / empty / other) and `metadata.networkDigest` = HMAC-SHA256 of the IP under the **dedicated** secret `BETA_INTAKE_HASH_KEY_<VERSION>` (version from `BETA_INTAKE_HASH_KEY_VERSION`, default `v1`; ≥ 32 characters, `openssl rand -hex 32`), with `metadata.networkDigestKeyVersion` beside it. **No key ⇒ no digest** (the raw fields are still nulled; logged once per process). It never falls back to `NEXTAUTH_SECRET`. IPv6 text is canonicalised first (lowercase, RFC 5952 compression, IPv4-mapped `::ffff:a.b.c.d` → `a.b.c.d`). Rows are never deleted; ≤ 2,000 rows per run, idempotent. `purgeTrash({ dryRun: true })` / `runDataRetention(client, now, undefined, { dryRun: true })` (the comms rollup is skipped on a dry run) counts what would be deleted/minimised and writes nothing. **Rotation:** set `BETA_INTAKE_HASH_KEY_V2`, then `BETA_INTAKE_HASH_KEY_VERSION=v2`. Rows minimised from then on carry v2 digests; rows already minimised keep their v1 digest, labelled `v1`. Digests only correlate within one version; keep the old key until no comparison against v1 rows is needed (it is not used to re-hash). `validateEnv()` logs loudly (never fatal) for a short key, a malformed version, or a selected version whose key is unset.

## Source

Operational checklist input: `docs/operations/RELEASE_CHECKLIST.md`, `docs/operations/SECURITY_CHECKLIST.md`, `docs/operations/INCIDENT_RESPONSE_RUNBOOK.md`. Deeper architecture/security findings: the architecture and security audits in this directory.
