# Fourth Meridian — Security-Operations Architecture Review

**Date:** 2026-07-07
**Type:** Investigation only — no code changed, nothing implemented.
**Lens:** How ready is the security infrastructure to have **Fourth Meridian HQ / Platform Operations UI** built over it, Spaces-first?
**Method:** Direct source review of the auth/session/authz/audit/jobs/env layers and the Spaces composition machinery. Every claim cites a file.

**Note on prior art:** `docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md` already exists and is unusually thoughtful — it frames PO1 as "capabilities, not UI," names "the constraint nobody has written down," and sequences a phased plan (telemetry provenance → job substrate → rollups → operations console on the *existing admin surface* → alerting → an "Ops Intelligence presentation flip" to a Space). This review evaluates whether the **codebase** matches that plan's ambitions, and is candid where it doesn't.

---

## 1. Executive summary

The security infrastructure is **well-organized and, unusually, already half of an operations platform** — you have most of the *data* and much of the *read surface* an ops console needs, it just isn't presented as one yet. Session/authz/encryption/platform-settings each have a clean single source of truth with pure-policy/impure-adapter separation as a house style. The `JobRun` ledger, `UserSession` model, filterable `AuditLog` query, and `admin/overview` aggregation are effectively ops data sources that exist today.

The gaps are narrow and specific, not structural: (1) the audit-event **vocabulary is free-text `String` and duplicated across three files**, which is the one thing that will bite an ops UI that wants to aggregate/alert on events; (2) a few ready-made capabilities (**job health**, **env validation**, **rate-limit status**) have the *logic and data* but **no read endpoint**; (3) there is **no "internal/platform" Space primitive** and **no operational widget family**, so a genuinely Spaces-first HQ needs a new authz path and a new data plane, not just new cards.

The honest verdict on Spaces-first: the Space *composition* primitives can host an ops dashboard, but the ops *data plane* and *authz model* are fundamentally different from customer Spaces (platform-global + SYSTEM_ADMIN vs space-scoped + membership). The team's own roadmap already concedes this — "operations console on the existing admin surface" first, "presentation flip" to a Space later. That sequencing is correct. Building a pure Space on day one would fight the per-space scoping invariant that the rest of the security model depends on.

---

## 2. Security infrastructure organization score: **8 / 10**

Single sources of truth that exist and are clean:

- **Session/authz guards** — `lib/session.ts` (`requireUser`, `requireFreshUser`, `requireSystemAdmin`, `requireFreshSystemAdmin`, `requireSpaceRole`) is the one door for route auth; SEC-FIX-1's forced-TOTP gate lives here so it applies uniformly.
- **Space authorization** — `lib/spaces/policy.ts` pure `can(action, ctx)` + `lib/spaces/authorize.ts` I/O adapter; exhaustive `Record<SpaceAction, ...>`.
- **Encryption** — `lib/plaid/encryption.ts` purpose registry (HKDF per-purpose, versioned ciphertext).
- **Platform settings** — `lib/platform-settings.ts` typed `PlatformSettingKey` + defaults + `getAllSettings/getSetting/setSetting`; the forced-TOTP policy state (`require_totp_*`) and `min_password_length` live here.
- **Audit constants** — `lib/audit-actions.ts` (224 lines of named actions).
- **Rate limiting** — `lib/rate-limit.ts` single limiter, `RateLimit` table.
- **Job health** — `lib/jobs/health.ts` pure `classifyJobHealth()` with an injected `JobRunReadClient` (textbook pure/impure split; unit-tested in `job-health.test.ts`).
- **Env** — `lib/env.ts` `validateEnv()` runs at boot via `instrumentation.ts`.

Why not higher — three real organization dents:

- **The audit vocabulary is not enforced and is duplicated.** `AuditLog.action` is a bare `String` (`prisma/schema.prisma` — "See AuditAction constants"), not an enum. Several security events are written as **raw strings that never entered `audit-actions.ts`** (`lib/security-history.ts` documents `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_COMPLETE`, `PASSWORD_CHANGE_FAILED`, `ADMIN_SESSION_REVOKED`). And the "which actions are security events" list is hardcoded **three separate times**: `audit-actions.ts` (the canon), `lib/security-history.ts` `SECURITY_HISTORY_LABELS` (user allowlist), and `app/api/admin/audit/route.ts` `SECURITY_ACTIONS` (admin filter). These can — and per the docs already do — drift. For an ops UI whose whole job is aggregating events, this is the load-bearing weakness.
- **Two role-ranking tables.** `ROLE_ORDER` in `lib/session.ts` and `ROLE_RANK` in `lib/spaces/policy.ts` encode the same precedence; `policy.ts` itself flags the consolidation as "deferred." Harmless today, a divergence trap later.
- **Admin fresh-auth is inconsistent.** All 14 `app/api/admin/*` routes gate on `requireSystemAdmin`, but only the session-revoke route uses `requireFreshSystemAdmin`. Destructive admin actions (`.../2fa-reset`, `.../recovery-codes`) run on the 30s-cached revocation. Minor, but it's exactly the class of action fresh-auth exists for.

---

## 3. Platform Operations UI readiness score: **7 / 10**

Readiness is high on data, medium on read surface, low on ops-specific presentation. Breakdown of the eleven surfaces you asked about:

**Buildable now (data + read API already exist):**
- **Auth/security posture & audit events** — `app/api/admin/audit/route.ts` is already a filterable, paginated audit feed (search, action, date range, `securityOnly`, `adminOnly`, pagination). An audit-feed card needs zero new backend.
- **Forced-TOTP policy state** — `getAllSettings()` + `app/api/admin/security/settings/route.ts`.
- **TOTP enrollment & recovery-code status (per user)** — `app/api/admin/security/users/route.ts` and `.../users/[userId]/recovery-codes`.
- **Active/revoked sessions** — `UserSession` (with `revokedAt`, `revokedById`) via `.../users/[userId]/sessions`.
- **User/admin access state** — `app/api/admin/overview/route.ts` already returns stats + users-with-memberships + spaces + recentAudit (a proto-ops-dashboard).
- **Admin-on-beh-of provenance** — `AuditLog.performedByAdminId` + `adminOnly` filter.

**Has logic/data but needs a thin read endpoint (prep):**
- **Job/cron security state** — `lib/jobs/health.ts` (`JobHealthStatus`, `classifyJobHealth`, staleness/failure-streak thresholds) + the `JobRun` ledger (status, durationMs, errorSummary, `@@index([status, startedAt])`) are ready, but there is **no `admin/jobs` read route** — only the CRON-guarded execute routes. A read-only job-health endpoint over the existing lib is low effort.
- **Rate-limit status** — the `RateLimit` table exists and is written, but there's **no read endpoint** to show current buckets/over-limit keys.

**Docs/logic only — no queryable status (more prep):**
- **Environment validation status** — `validateEnv()` returns `void` and *throws*; it's a boot gate, not a structured report. An env-status card needs a variant that returns pass/warn/fail per key (names only, never values).
- **Key-rotation readiness** — supported in principle (`encryption.ts` versioned `v1→v2` dual-format reads; `docs/investigations/SEC-1_KD-6_REENCRYPTION_INVESTIGATION.md`) but there's no status surface reporting "N rows on legacy ciphertext."
- **Incident/runbook links** — `INCIDENT_RESPONSE_RUNBOOK.md` is excellent and structured, but it's a file, not linked data; surfacing "runbook for this alert" means mapping event classes → runbook anchors (config, not code).

So roughly six of eleven surfaces are buildable now, three need a thin endpoint, two need real prep.

---

## 4. Incident-response / code-navigation score: **8.5 / 10**

If you drop into this codebase mid-incident, you'll find your way fast:

- **The runbook is a genuine asset.** `INCIDENT_RESPONSE_RUNBOOK.md` is SEV-classified, has a "First Five Minutes," and is organized by incident class (auth, DB, background jobs with exact job names/UTC times, providers, security incidents incl. credential compromise, spray/stuffing, rate-limit bypass, privesc, secret exposure) plus a rollback procedure. That's better than most funded startups have.
- **Naming and boundaries are grep-friendly** — `AuditAction.*`, `JobRun.jobName` values, `PlatformSettingKey.*`, the `require*` guard family. You can grep a symbol to the one file that owns it.
- **Pure/impure separation** means the decision logic (`can()`, `classifyJobHealth()`, `decideSpaceAction()`) is readable without tracing I/O.
- **Guardrail tests exist** — `lib/security-surface.test.ts` (source-scan tripwire, incl. an OPS-4-unstarted check), `job-health.test.ts`, the space authz suites (560 checks green).

The half-point-plus off: the free-text audit strings mean "grep every security event" is not exhaustive (some are raw literals in routes); the `" 2"` Finder/cloud-sync duplicate directories (KD-13, still on disk) add navigation noise; and the two role tables mean "where is the role rule?" has two answers.

---

## 5. What is already clean

- The **`require*` guard family** as the single auth door, now including the SEC-FIX-1 TOTP gate.
- **Space authz** pure-policy/adapter split (`policy.ts` / `authorize.ts`).
- **Platform settings** as a typed, defaulted single source of truth — the natural backing store for an ops "policy" card.
- **`JobRun`** ledger: privacy-safe by design (summary = "counts/kinds/IDs only — never user content or monetary values," errorSummary "truncated, no stack"), indexed for exactly the ops questions ("did last night's X run?", failure scans).
- **`UserSession`** with admin-revocation provenance (`revokedById`).
- **`admin/overview`** and **`admin/audit`** — a working aggregation + a working filterable feed.
- **Encryption** purpose registry and versioned ciphertext (rotation-ready primitive).
- **The runbook.**

## 6. What is still scattered

- **Audit vocabulary**: free-text `String`, not enum; the "security actions" set duplicated across `audit-actions.ts`, `security-history.ts`, and `admin/audit/route.ts`; several actions written as raw literals never registered in the canon.
- **Role precedence**: `ROLE_ORDER` (session) vs `ROLE_RANK` (policy).
- **Admin fresh-auth**: only session-revoke uses `requireFreshSystemAdmin`; other destructive admin actions don't.
- **Policy vs enforcement drift risk**: `min_password_length` is a `PlatformSetting`, but registration enforces a hardcoded `password.length < 8` (`register/route.ts`) — the setting isn't the source of truth for the check. Any ops UI that displays "min password length = N" would be showing a value the code doesn't actually enforce.
- **Operational read surfaces embedded nowhere**: job-health, env-validation, and rate-limit status have no route — they live only in libs/tables.

## 7. UI surfaces that can be built easily now

Audit feed (filterable), security-settings/forced-TOTP policy editor, per-user TOTP + recovery-code status, active/revoked session table with admin-revoke, platform overview (users/spaces/accounts/recent audit), admin-action provenance view. All have existing SYSTEM_ADMIN read routes; these are presentation work, not backend work.

## 8. UI surfaces that need prep work

- **Job/cron health board** — add a read-only endpoint over `lib/jobs/health.ts` + `JobRun`.
- **Rate-limit status** — add a read endpoint over the `RateLimit` table (current over-limit keys, shadow-mode counts).
- **Environment-validation status** — refactor `validateEnv()` to *also* expose a structured, value-free report.
- **Key-rotation readiness** — add a "ciphertext version distribution" counter over the encrypted columns.
- **Runbook linking** — map event/alert classes to runbook anchors (config).
- **Anything that mutates infra/secrets** (rotate a key, disable SYSTEM_ADMIN, purge) — needs its own extra-guarded, fresh-auth, heavily-audited surface regardless of where it's presented.

---

## 9. Can Fourth Meridian HQ stay Spaces-first?

**Mostly yes for presentation, no for the data/authz plane — and that's the right design.**

What genuinely reuses Spaces primitives:
- The **shell**: a Space with `SpaceDashboardSection` rows, tabs (`SpaceDashboardTab`), and the `widget-registry.ts` adapter pattern ("add one entry, no switch/case") can compose an ops dashboard the same way a customer dashboard is composed.
- **Role-gated views**: the role machinery can gate internal tabs.

What does **not** transfer, and why a pure day-one Space would fight the architecture:
- **Authorization model.** Customer Spaces gate on `SpaceMember` membership (`requireSpaceRole` / `can()`); HQ must gate on `SYSTEM_ADMIN` (`requireSystemAdmin`). These are different predicates. An HQ "Space" would need an authz path that replaces membership with platform-role — i.e. a new gate, not the existing one.
- **Data scoping invariant.** Every AI assembler and data read is deliberately **filtered by `spaceId`** (a core security invariant — no cross-Space reads). Ops widgets are **platform-global** (all users, all jobs, all sessions). They must *intentionally and auditably* escape the per-space scope under the admin guard — the opposite of the customer invariant.
- **Widget primitives.** The registry's primitives are financial (`AssetValue`, `Progress`, `Breakdown`, `Summary`, `Timeline`). There is **no operational primitive** (job-health grid, audit stream, session table, env-status panel), and **no `SpaceCategory`/`SpaceType` for an internal Space** (grep found zero "internal/platform/HQ Space" notion). Those are net-new.

The realistic, roadmap-aligned path: keep the **traditional admin surface as the capability layer** (it already exists and is uniformly `requireSystemAdmin`-gated), express ops capabilities as read endpoints + pure classifiers (mirroring `lib/jobs/health.ts`), and **later** flip presentation into a Spaces-first HQ once (a) an internal Space type + admin-authz adapter exists and (b) an ops widget family exists. This is exactly the PLATOPS roadmap's "operations console on the existing admin surface" → "presentation flip." A small residue (secret rotation, SYSTEM_ADMIN disable, destructive purges) will likely always deserve a non-Space, extra-guarded surface — that's a feature, not a failure of Spaces-first.

---

## 10. Recommended prep before PO1 (smallest work, no implementation now)

Ordered by leverage:

1. **Make the audit vocabulary a single enforced source of truth.** Promote `AuditLog.action` toward the `AuditAction` canon: fold the raw-literal actions (`PASSWORD_RESET_REQUESTED`, `PASSWORD_CHANGE_FAILED`, `ADMIN_SESSION_REVOKED`, …) into `audit-actions.ts`, and derive the "security event" set **once** so `security-history.ts` and `admin/audit` stop maintaining parallel lists. This is the prerequisite for any reliable ops aggregation/alerting.
2. **Add read-only status endpoints for the three headless capabilities** — job health (over `lib/jobs/health.ts`), rate-limit status (over `RateLimit`), and a structured, value-free env-validation report (refactor `validateEnv()` to return a report *and* keep throwing at boot). These unlock three ops cards cheaply.
3. **Define the internal-Space authz seam** on paper: how a platform-role gate substitutes for membership, and how ops data adapters *auditably* opt out of `spaceId` scoping. This is the one architectural decision that determines whether HQ can be Spaces-first.
4. **Reconcile policy-vs-enforcement** where they've drifted — `min_password_length` setting vs the hardcoded check — so an ops policy panel shows values the code actually honors.
5. **Consolidate the two role tables** (`ROLE_ORDER` / `ROLE_RANK`) into one, and make destructive admin routes use `requireFreshSystemAdmin` uniformly.
6. **Add a ciphertext-version counter** so key-rotation readiness is observable before you build a rotation control.
7. **Housekeeping**: remove the `" 2"` duplicate dirs (KD-13) so incident-time navigation is clean.

None of these is large; all of them make PO1 — and an incident at 3am — materially easier.

---

### Evidence appendix (files read for this review)

`lib/session.ts`, `lib/auth.ts`, `lib/audit-actions.ts`, `lib/platform-settings.ts`, `lib/security-history.ts`, `lib/env.ts`, `lib/jobs/health.ts`, `lib/widget-registry.ts`, `lib/space-presets.ts`, `lib/spaces/policy.ts`+`authorize.ts` (prior), `lib/plaid/encryption.ts` (prior); `app/api/admin/*` (14 routes — authz coverage + `overview` + `audit`), `app/api/user/totp/*`; `prisma/schema.prisma` (`AuditLog`, `JobRun`, `UserSession`, `PlatformSetting`); `INCIDENT_RESPONSE_RUNBOOK.md`, `docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md`.

**Not verified (out of scope / not in code):** production env configuration and actual header values served; live job-run history contents; whether the PLATOPS roadmap's later phases have any code behind them yet (they read as planning). Scores reflect the codebase as it exists on disk, not the deployed environment.
