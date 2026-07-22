# Audit — Production Readiness

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
| 1 | `NEXT_PUBLIC_SENTRY_DSN` | **ABSENT from Production** (verified by name) | Config | **Deploy** — it is in `PROD_REQUIRED_KEYS`; `instrumentation.ts` calls `validateEnv()` at boot, so production will not start |
| 2 | `PLAID_ENV = production` | Key present, **value not verifiable** | Config — manual verification | Deploy (the V25-FINAL-2 guard throws if creds exist and the env is not production) |
| 3 | `INVESTMENT_OBSERVATIONS_ENABLED = true` | Key present, **value not verifiable** | Config — manual verification | Correct investment display: `getCurrentPositions()` reads `PositionObservation` only (no Holding fallback), so a disabled writer yields a silently empty portfolio |
| 4 | Turnstile site + secret keys | **Both ABSENT from Production** | Config | External beta — `verifyCaptchaToken` returns `true` with no secret, so CAPTCHA is a no-op |
| 5 | `registration_mode = invite_only` | **Not verifiable** (DB `PlatformSetting`; ship default is `open`) | Config — manual verification | External beta |
| 6 | Published support address | `support@fourthmeridian.com` exists only in `lib/email/senders.ts`; **0 user-facing occurrences** | Copy | External beta |
| 7 | External uptime monitor on `/api/health` | Not present in repo config | Ops act | External beta (Sentry is error capture, not availability) |
| 8 | Backup / restore drill (Supabase PITR), RPO/RTO recorded | No record in `docs/operations/` | Ops act | External beta |
| 9 | LLM / AI disclosure | `content/marketing/legal-ai.md` says "a third-party model provider" but names neither the provider nor a retention window | Policy + copy | External beta |

Already satisfied and verified by name in Production: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `CRON_SECRET`, `RESEND_API_KEY`, `OPENAI_API_KEY`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `DATABASE_URL`, `DIRECT_URL`, `ENCRYPTION_KEY`, `DISABLE_SYSTEM_ADMIN`. Cron is configured in `vercel.json` (`/api/jobs/dispatch`). Prisma: 76 migrations, all applied, none pending — **no migration or backfill is required to merge or deploy.**

## Source

Operational checklist input: `docs/operations/RELEASE_CHECKLIST.md`, `docs/operations/SECURITY_CHECKLIST.md`, `docs/operations/INCIDENT_RESPONSE_RUNBOOK.md`. Deeper architecture/security findings: the architecture and security audits in this directory.
