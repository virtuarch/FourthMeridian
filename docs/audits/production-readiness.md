# Audit — Production Readiness

*The single living production-readiness snapshot. Regenerated from the beta-blocker analysis; supersedes the readiness tables previously scattered across STATUS and the prelaunch audit. The audits category expires at first production release.*

**Verdict:** Not ready for external users. The core platform architecture is largely built; the binding gap is **verification / configuration / operations**, not feature construction.

## Strengths (verified)

- Deterministic-first AI architecture (pre-computed, provenance-carrying assessments; the model narrates, never calculates — [../systems/ai.md](../systems/ai.md)).
- Plaid identity-instability handling with a convergent, never-hard-deleting merge engine.
- Boundary discipline: single auth chokepoint, single LLM import site, single decrypt module, HKDF per-purpose keys, tenancy with no admin bypass ([../doctrine/platform-and-security.md](../doctrine/platform-and-security.md)).
- Disciplined additive-first migration execution.

## Must close before the first external beta user

Separated into code / configuration / operational acts:

| # | Blocker | Kind |
|---|---|---|
| 1 | **LLM / OpenAI disclosure + retention posture** — `/legal/ai` names neither the provider nor a retention window; its "not a chat window you have to prompt" line also misdescribes the shipped `app/api/ai/chat` surface | Decision + copy |
| 2 | **Sentry (or equivalent) error monitoring** — `instrumentation.ts:22` documents it as not configured | Code (small) |
| 3 | **External uptime monitoring** on `/api/health` | Ops act |
| 4 | **Backup restore drill** recorded in `docs/operations/` — verify Supabase PITR | Ops act (needs runtime/DB verification) |
| 5 | **Production beta gate verified `invite_only`** — DB default is `open`; the single most urgent config act | Config (needs verification) |
| 6 | **Turnstile production keys** live — a CAPTCHA is a no-op without them | Config (needs verification) |
| 7 | **Production Plaid decision / credentials** — `PLAID_ENV=sandbox` default; keys not in `PROD_REQUIRED_KEYS` | Decision + config |
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

Migration seams open concurrently; verification debt (invariants asserted in comments, not checked in code); solo-maintainer bus factor; `Float` for money ([../architecture/decisions/DEC-0.md](../architecture/decisions/DEC-0.md)); documentation weight exceeding maintenance capacity.

Recorded in the v2.5 closure review (2026-07-20), not yet actioned — all class **B**, none gate v2.5 closure:

- **FX rate-miss renders native amounts as target currency.** `lib/money/convert.ts:59-61` returns the native amount tagged `estimated` on a resolver miss (doctrine: never exclude, never throw). ¥1,000,000 displays as ≈$1,000,000. The taint propagation is correct and complete; the *signal* is not — `≈` reads as rounding, not as a 150× error. Amplified at launch because `lib/money/fx-freshness.ts` deliberately does not trigger refresh on a cold archive, so a fresh deploy has a window where every non-USD conversion misses.
- **Operator gating is inverted relative to blast radius.** The three `app/api/admin/plaid/*` routes have zero `auditLog` writes and no fresh-access check, while the less destructive `platform-ops` resync/request-reauth routes have both. Authorization is sound (`requireSystemAdmin`); forensics are absent on the operations that revoke a customer's connection or create a `PlaidItem` under another user's identity.
- **Space visibility filtering has three independent query implementations** (`lib/data/transaction-query.ts:99`, `lib/accounts/space-account-link.ts:114`, `lib/investments/account-scope.ts:35`). They share the `TRANSACTION_DETAIL_VISIBILITY` predicate correctly but hand-roll the traversal three ways, each tested only in isolation. No cross-authority parity guard.
- **Account deletion hard-deletes accounts shared into other members' Spaces** (`lib/account-deletion/purge.ts:157`). The scoping filter is visibly deliberate; confirm it is intended and that co-members are notified.

## Source

Operational checklist input: `docs/operations/RELEASE_CHECKLIST.md`, `docs/operations/SECURITY_CHECKLIST.md`, `docs/operations/INCIDENT_RESPONSE_RUNBOOK.md`. Deeper architecture/security findings: the architecture and security audits in this directory.
