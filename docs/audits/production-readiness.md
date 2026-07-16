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
| 1 | Registration **consent capture** — `User.acceptedTermsAt` absent; register page has no checkbox / terms links | Code (small) |
| 2 | **LLM / OpenAI disclosure + retention posture** — `/legal/ai` names neither OpenAI nor a retention window | Decision + copy |
| 3 | **Sentry (or equivalent) error monitoring** — `instrumentation.ts` documents it as not configured | Code (small) |
| 4 | **External uptime monitoring** on `/api/health` | Ops act |
| 5 | **Backup restore drill** recorded in `docs/operations/` — verify Supabase PITR | Ops act (needs runtime/DB verification) |
| 6 | **Production beta gate verified `invite_only`** — DB default is `open`; the single most urgent config act | Config (needs verification) |
| 7 | **Turnstile production keys** live — a CAPTCHA is a no-op without them | Config (needs verification) |
| 8 | **Production Plaid decision / credentials** — `PLAID_ENV=sandbox` default; keys not in `PROD_REQUIRED_KEYS` | Decision + config |
| 9 | **Production email / domain verification** (Resend) | Config (needs verification) |

## Beta-acceptable limitations (close shortly after beta)

- Dynamic-window / follow-up / drilldown characterization suites — re-homed to AI5-1 (bounds-not-dollars).
- Published support contact (`support@fourthmeridian.com` exists only as a sender identity).
- CSP Report-Only → enforced after a clean observation window.
- Formal accessibility audit; status page; async export.
- Counsel-reviewed final legal text is deferred to v3.0 — the drafted legal pages are operationally honest but not attorney-approved. This does **not** downgrade the real blockers above (consent, LLM disclosure, Sentry, backup drill).

## Known risks

Migration seams open concurrently; verification debt (invariants asserted in comments, not checked in code); solo-maintainer bus factor; `Float` for money ([../architecture/decisions/DEC-0.md](../architecture/decisions/DEC-0.md)); documentation weight exceeding maintenance capacity.

## Source

Operational checklist input: `docs/operations/RELEASE_CHECKLIST.md`, `docs/operations/SECURITY_CHECKLIST.md`, `docs/operations/INCIDENT_RESPONSE_RUNBOOK.md`. Deeper architecture/security findings: the architecture and security audits in this directory.
