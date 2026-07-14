# PO1 Investigation — Platform Capabilities, Read/Write Granularity, and Platform-Space Data Readiness

**Date:** 2026-07-13
**Type:** Investigation only. No implementation, no schema, no migrations, no file changes.
**Purpose:** Ground Chris's specific capability vision — an extensible family of platform Spaces (initially Platform Operations, Security Operations, Growth & Revenue, Customer Success), with per-user, per-Space grants at READ or WRITE granularity — against the current source, and resolve the read-vs-write axis the 07-07 docs left open.
**Prior art (decided, not re-litigated here):** `FOURTH_MERIDIAN_PO1_PLATFORM_ACCESS_INVESTIGATION_2026-07-07.md` and `FOURTH_MERIDIAN_SECOPS_ARCHITECTURE_REVIEW_2026-07-07.md`. Their conclusions stand: HQ-class Spaces are real, system-singleton, bootstrap-seeded, un-deletable Spaces; authorization is a new platform-wide capability layer orthogonal to `SpaceMemberRole`, mirroring the pure/impure split of `lib/spaces/policy.ts` + `lib/spaces/authorize.ts`; visibility is access-derived (the grant is the single source of truth — no `SpaceMember` mirroring); `SYSTEM_ADMIN` remains the unconditional break-glass bypass.
**One evolution since 07-07:** the vision is no longer one singleton "HQ" Space but a *family* of platform Spaces, one per platform area, extensible over time. Everything the 07-07 docs concluded about "HQ the singleton" applies per-member of that family (each is itself a system singleton for its area).

---

## 0. Executive summary

Three findings, in order of consequence:

1. **The read/write axis should be modeled as `area × level`, not as a flat capability enum with paired `*_VIEW`/`*_MANAGE` members.** A `PlatformGrant` row of `(userId, area: PlatformArea, level: READ|WRITE)` is exactly Chris's mental model ("grant this user read on Security Ops"), makes incoherent states (WRITE without READ) unrepresentable via a ranked-level comparison — the same min-rank idiom as `ROLE_RANK` (`lib/spaces/policy.ts:90-95`) and `ROLE_ORDER` (`lib/session.ts:246-251`) — and makes "add a platform Space" a one-enum-value change instead of two capability constants plus a bundle edit. The 07-07 capability names (`SECURITY_VIEW`, `JOB_VIEW`, …) survive as *derived* pairs in the pure policy layer, not as storage.

2. **The platform-Space marker must be a new field, not a `SpaceCategory` value.** `Space.category: SpaceCategory` (`prisma/schema.prisma:428`) is now load-bearing *user-facing* categorization: the create route's legacy path accepts any `Object.values(SpaceCategory)` member from the client (`app/api/spaces/route.ts:98-101`), and three template-registry test suites iterate every `SpaceCategory` value asserting each has a user-creatable template (`lib/space-templates/registry.test.ts:132-135`, `apply.test.ts:29`, `create-route.test.ts:34-37`). A reserved `PLATFORM` category value would be client-creatable and would demand a customer template. The correct marker is a nullable `Space.platformArea: PlatformArea? @unique` — which simultaneously *is* the area link and the singleton constraint. This matches the parked D12 prescription: "implement via `isInternal` + separate authz gate" (`STATUS.md:337`), with strictly more information than a boolean.

3. **Data readiness is a steep gradient, and the build-order belief is confirmed with one refinement: Security Operations is strictly easier than Platform Operations.** Security Ops is presentation-only today — its read routes already exist (`app/api/admin/audit`, `admin/overview`, `admin/security/*`). Platform Ops has all the *data and logic* (JobRun ledger, `lib/jobs/health.ts`, RateLimit table, `validateEnv()`) but **zero read routes** — three thin endpoints must be built first. Growth & Revenue has **no revenue-shaped data anywhere** (billing is ratified out until v3.0) — only signup/activation raw signals derivable from `User` timestamps. Customer Success has **nothing purpose-built** — only oblique operational signals (`SyncIssue`, notification delivery failures). Creating and access-gating all four Spaces is cheap and correct now; populating the last two honestly means placeholder-first.

---

## 1. Read/write granularity — concrete design

### 1.1 The requirement

Per Chris: the system admin grants and revokes access **per user, per platform Space, at READ or WRITE granularity** — e.g. a support person gets read-only Security Ops while an ops engineer gets write. The platform-Space list is extensible (four now, more later). This is a hard requirement, not a nice-to-have.

### 1.2 What the codebase's own conventions say

Four established idioms bear on the shape:

- **Ranked-role enums with a min-rank comparison.** `SpaceMemberRole { OWNER ADMIN MEMBER VIEWER }` (`prisma/schema.prisma:152-157`) is never compared for equality — routes ask "at least MEMBER?" via `ROLE_ORDER.indexOf(actual) >= ROLE_ORDER.indexOf(min)` (`lib/session.ts:246-258`) and the pure policy mirrors it with `ROLE_RANK` (`lib/spaces/policy.ts:90-95`). A READ/WRITE *level* is a two-member ranked enum of exactly this kind: WRITE ≥ READ, one comparison, no way to hold write without read.
- **Exhaustive pure policy tables.** `ACTION_POLICY: Record<SpaceAction, ActionRule>` (`lib/spaces/policy.ts:114-141`) uses `Record<union, rule>` so a missing action is a compile error, decided by pure `can(action, ctx)` (`policy.ts:159-170`). The platform layer should reuse this exhaustiveness trick for whatever per-area action vocabulary emerges.
- **Typed string-constant registries.** `PlatformSettingKey` is a `const` object + derived union (`lib/platform-settings.ts:10-18`); `AuditAction` is the same shape at 224 lines (`lib/audit-actions.ts:9`). This is the house pattern for *registries with metadata*, and is the right shape for the per-area display metadata (labels, Space names, descriptions) — but not for the grant storage itself, which needs DB-level integrity.
- **Grant-shaped join rows with never-deleted lifecycle.** `SpaceMember` (`prisma/schema.prisma:493-518`) is the template: `@@unique([spaceId, userId])`, a `status` enum instead of row deletion ("Rows are never deleted — status update preserves audit history", `schema.prisma:487-490`), and revocation provenance (`revokedAt`/`revokedById`, `schema.prisma:504-506`).

### 1.3 Recommended shape: `PlatformArea` × `PlatformAccessLevel` on a `PlatformGrant` row

```
enum PlatformArea        { PLATFORM_OPS, SECURITY_OPS, GROWTH_REVENUE, CUSTOMER_SUCCESS }   // extensible
enum PlatformAccessLevel { READ, WRITE }                                                    // ranked: WRITE ≥ READ

model PlatformGrant — (userId, area, level, status, grantedById/At, revokedById/At), @@unique([userId, area])
```

(The exact Prisma diff is in the companion implementation plan; this section records *why this shape*.)

**Why `area × level` beats paired `*_VIEW`/`*_MANAGE` capability members:**

1. **It cannot express incoherent states.** A flat `PlatformCapability { SECURITY_OPS_VIEW, SECURITY_OPS_MANAGE, … }` permits granting `SECURITY_OPS_MANAGE` without `SECURITY_OPS_VIEW` — a state every consumer must then defensively normalize. `level: WRITE` with a rank comparison (`LEVEL_RANK[grant.level] >= LEVEL_RANK[needed]`, mirroring `ROLE_RANK`) makes read-implied-by-write structural, exactly as OWNER implies every lower Space role.
2. **Extensibility is one value, not two-plus-a-bundle.** Chris's list grows over time. Adding `FINANCE_OPS` under `area × level` = one enum member + one metadata entry + one seeded Space. Under paired capabilities it is two enum members plus edits to every role-bundle map the 07-07 doc proposed.
3. **The model is the admin UI.** The grant-management screen Chris described is literally a (user, platform Space, read/write) matrix. `PlatformGrant` rows *are* that matrix — no translation layer between what the admin sees and what is stored, which also keeps the audit trail legible (`PLATFORM_GRANT_CREATED { area: SECURITY_OPS, level: READ }` reads exactly like the admin's intent).
4. **The 07-07 capability vocabulary is preserved as a derivation, not lost.** The pure policy layer can expose `hasPlatformAccess(area, "read" | "write", grants)` and, where a capability-style name helps widget self-declaration, derive it: `SECURITY_OPS_VIEW ≡ (SECURITY_OPS, READ)`, `SECURITY_OPS_MANAGE ≡ (SECURITY_OPS, WRITE)`. Widgets then self-declare `requiredAccess: { area, level }` — the same self-describing move as `DataRequirement` (`lib/widget-registry.ts:34-43`), per the 07-07 decision.
5. **Precedent parity.** This is `SpaceMember(role)` transposed to the platform axis: a join row from user to a scope (there: a Space via `spaceId`; here: a platform area) carrying a ranked authority enum, with the same never-delete + revocation-provenance lifecycle. It is the most conservative possible shape for this codebase.

**What is deliberately *not* in the recommendation (deferred, with reasons):**

- **Named role bundles** (Support Agent, Security Admin, …) from 07-07 §4: Chris's stated model is direct per-Space grants, and at current scale (grants issued by one admin, to a handful of users, across four areas) bundles are ergonomics without a customer. They layer on cleanly later as *presets that expand to grant rows* — nothing in `area × level` forecloses them. Launching without them also honors 07-07 risk #5 (capability sprawl: "launch with ~6–8 coarse view/act capabilities" — four areas × two levels = 8).
- **Per-action capabilities within an area** (e.g. separate `USER_SUSPEND` vs `SESSION_REVOKE` inside Security Ops): WRITE-on-area is the coarse grain for PO1; splitting is demand-driven, and the pure policy table's `Record<union, …>` exhaustiveness makes a later split a compile-guided refactor.

### 1.4 The pure/impure split (unchanged from 07-07, now concretely shaped)

- **Pure** `lib/platform/policy.ts`: `PLATFORM_AREAS` metadata registry (label, Space name, description — the `PlatformSettingKey`-style const registry), `LEVEL_RANK`, and pure `hasPlatformAccess(area, needed, grants): boolean` — no I/O, standalone-testable exactly like `can()` (`lib/spaces/policy.ts:159-170`).
- **Impure** `lib/platform/authorize.ts`: `requirePlatformAccess(area, level)` returning the Go-style `[auth, err]` tuple the whole `require*` family uses (`lib/session.ts:27-38` documents the convention), with the `SYSTEM_ADMIN` unconditional bypass (`user.role !== UserRole.SYSTEM_ADMIN` check precedent at `lib/session.ts:205`), plus a `requireFreshPlatformAccess` variant mirroring `requireFreshUser`'s live-revocation re-check (`lib/session.ts:165-191`) for any future WRITE mutations.

### 1.5 The platform-Space marker: `Space.platformArea PlatformArea? @unique`

The 07-07 doc left the marker as "a reserved `SpaceCategory` … or an `isSystem` marker" (07-07 investigation §5). The first branch is now **closed** by the SpaceCategory correction:

- `Space.category: SpaceCategory @default(PERSONAL)` (`prisma/schema.prisma:428`) is user-facing categorization ("Semantic category for a Space — drives default UI labels, section presets, and AI context", `schema.prisma:117-118`), with fifteen user-meaningful values (`schema.prisma:119-135`).
- The create route's legacy path validates client-sent categories against `Object.values(SpaceCategory)` and otherwise falls back to `OTHER` (`app/api/spaces/route.ts:98-101`) — **any enum value added to `SpaceCategory` becomes client-creatable**.
- Three test suites enforce "every `SpaceCategory` has a template": `lib/space-templates/registry.test.ts:132-135`, `lib/space-templates/apply.test.ts:29`, `lib/space-templates/create-route.test.ts:34-37`. A `PLATFORM` value would require registering a customer-facing template for it or breaking the invariant.

So the marker is the second branch, upgraded: a nullable `platformArea PlatformArea?` on `Space` with `@unique`. One field simultaneously provides (a) the internal-Space marker (`platformArea != null`), (b) the Space↔area link the grant check needs, and (c) the per-area singleton guarantee (unique nullable column — Postgres treats NULLs as distinct, the same trick already relied on for `Notification.dedupeKey`'s partial-unique behavior, `prisma/schema.prisma:2427`). This is D12's parked `isInternal` (`STATUS.md:112`, rationale and unlock condition at `STATUS.md:337`) implemented with more information and no second field.

`category` on platform Spaces stays at a mundane value (`OTHER`) and is simply never surfaced — platform Spaces do not render through customer templates.

---

## 2. Data readiness per platform Space (verified against current source, 2026-07-13)

### 2.1 Platform Operations — data rich, read surface still absent (07-07 finding re-confirmed)

- **Job health: fully built, still unexposed.** `lib/jobs/health.ts` is the complete dead-job detector — pure `classifyJobHealth()` (`health.ts:108-143`), `checkScheduledJobHealth()` over the ledger (`health.ts:151-173`), statuses `healthy | never-ran | overdue | failing` (`health.ts:57`). The `JobRun` ledger persists status/duration/errorSummary with ops-query indexes (`prisma/schema.prisma:2509-2524`). Eight jobs are registered (`lib/jobs/registry.ts:73-139`: sync-banks, fetch-fx-rates, fetch-security-prices, process-deletions, notification-cleanup, notification-retry, purge-trash, rate-limit-sweep). **No read route exists**: the only consumers are the operator CLI `scripts/check-job-health.ts` (header: "usable by hand … later PO1", lines 1-13) and the module's own header, which *names this exact future*: "a future admin panel (PO1 Phase 4) can consume the same helper unchanged" (`health.ts:33-34`). Everything under `app/api/jobs/*` is a `CRON_SECRET`-guarded *execute* route (`app/api/jobs/dispatch/route.ts:44-52`), not a read surface, and none of the 14 `app/api/admin/*` routes touches `JobRun` (route inventory: audit, overview, plaid×4, security×6, spaces, users).
- **Rate-limit status: table exists, zero reads.** `RateLimit` (`prisma/schema.prisma:2298-2308`) is written by `lib/rate-limit.ts` and swept by the `rate-limit-sweep` job (`lib/jobs/registry.ts:139`), but a repo-wide grep finds no route reading it — unchanged from 07-07.
- **Env-validation status: still a boot gate, not a report.** `validateEnv(): void` throws on missing vars (`lib/env.ts:107-115`); there is no structured pass/warn/fail-per-key variant. The SECOPS review's prep item #2 (a value-free report shape) remains open.

**Verdict: unchanged from 07-07 — the data and classifiers are production-grade; a Platform Operations Space needs two or three thin, capability-gated read endpoints before its first real widget.**

### 2.2 Security Operations — buildable today on existing read routes (07-07 finding re-confirmed)

- **Audit feed:** `GET /api/admin/audit` is filterable and paginated (search, action, date range, `securityOnly` via the `SECURITY_ACTIONS` list at `app/api/admin/audit/route.ts:27-33`, `adminOnly` via `performedByAdminId`, limit/offset) — `route.ts:35-53`. Backed by `AuditLog` with the `(action, createdAt)` index (`prisma/schema.prisma:2211-2226`).
- **Admin overview:** `GET /api/admin/overview` already aggregates users-with-memberships, spaces-with-members, totals, and the 100 most recent audit rows (`app/api/admin/overview/route.ts:20-95`) — a proto-ops dashboard.
- **TOTP/session state per user:** `GET /api/admin/security/users` returns `totpEnabled`, `forcePasswordReset`, unused-recovery-code counts, active-session counts, last logins (`app/api/admin/security/users/route.ts:31-60`); forced-TOTP policy state via `GET/PATCH /api/admin/security/settings` (`settings/route.ts:15-24`) over `PlatformSetting` (`prisma/schema.prisma:2282-2287`); per-user sessions with fresh-auth revoke — the one admin route on `requireFreshSystemAdmin` (`app/api/admin/security/users/[userId]/sessions/route.ts:42`). `UserSession.lastActiveAt` is maintained on every session callback (`lib/auth.ts:459-464`; model at `prisma/schema.prisma:2259-2273`).
- **Still true (SECOPS dents, unchanged):** the audit vocabulary remains free-text `String` (`schema.prisma:2217`) with the security-event set duplicated across `lib/audit-actions.ts`, `lib/security-history.ts:23-56`, and `admin/audit/route.ts:27-33`; destructive admin routes `2fa-reset` and `recovery-codes` still run on cached `requireSystemAdmin` (`2fa-reset/route.ts:23`, `recovery-codes/route.ts:22`); registration still hardcodes `password.length < 8` rather than reading `min_password_length` (`app/api/auth/register/route.ts:71` vs `lib/platform-settings.ts:15`).

**Verdict: unchanged from 07-07 — a Security Operations Space is presentation + re-gating work over read surfaces that already exist. It is the single easiest platform Space.**

### 2.3 Growth & Revenue — fresh investigation: **no revenue-shaped data exists; growth-lite signals are derivable**

Searched the full schema and source for anything resembling revenue, subscription, billing, pricing, usage-metering, or growth metrics:

- **Revenue/billing: nothing.** No billing, subscription, plan, pricing, or payment-provider (Stripe et al.) model or module exists anywhere in `prisma/schema.prisma` or `lib/`. Every "subscription" hit is the *customer-spending* `TransactionCategory` vocabulary (e.g. `lib/transactions/merchant-resolver.ts:236`), and the one "Revenue" string is the Business-Space perspective description shown to customers (`lib/perspectives.ts:183`) — both are user-finance features, not platform revenue. This absence is *by ratified decision*: D10 ratified billing out of Phase 2 with "Billing ban lifts at v3.0, nowhere earlier" (`STATUS.md:110`), reaffirmed in the parked-items table (`STATUS.md:342`).
- **Product analytics: nothing.** The PLATOPS roadmap's own audit row stands verbatim: "Analytics — Absolutely none. No product analytics, no aggregates, no counts endpoint — not even 'how many users' exists as a query anywhere outside `admin/overview`" (`docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md:42`). Re-verified: `admin/overview` computes `totalUsers: users.length` in memory (`app/api/admin/overview/route.ts:96`) — there is no time-series, cohort, or funnel query anywhere.
- **What IS derivable today (growth-lite raw signals):** `User.createdAt` (`prisma/schema.prisma:368`) → signups over time; `User.emailVerifiedAt` (`schema.prisma:326`) → activation/verification rate; `User.deactivatedAt` (`schema.prisma:344`) → deactivation counts; `UserSession.lastActiveAt` (`schema.prisma:2266`) → crude active-user counts; `AuditLog` LOGIN/REGISTER events (`lib/audit-actions.ts:11-12`) → auth funnel; `Space`/`SpaceMember` counts → shared-Space adoption (the roadmap's "wedge metric", `PLATOPS_ARCHITECTURE_ROADMAP.md` Part 6).

**Honest verdict: the Space can exist and be access-gated now, and can honestly host a small "signups / activation / active users" panel derived from the above — but anything labeled "Revenue" has no data source and cannot until billing exists (v3.0 per D10). Expected and fine per Chris's framing; recorded plainly.**

### 2.4 Customer Success — fresh investigation: **nothing purpose-built exists**

Searched for tickets, support cases, user health scores, churn signals, NPS/CSAT, feedback, helpdesk integrations (Zendesk/Intercom):

- **Purpose-built CS data: none.** No ticket, case, note, health-score, churn, NPS, or feedback model exists in the schema; no support-tool integration exists in `lib/`. Support workflows were ratified out by D10 ("Support workflows — None (ratified out of Phase 2 by D10; still true)", `PLATOPS_ARCHITECTURE_ROADMAP.md:44`), and the roadmap's own Part 6 vision keeps it that way: "Support: lightweight case notes attached to users … **not a ticketing system** — that stays out per D10 until real volume justifies it".
- **CS-adjacent operational signals that DO exist:** `SyncIssue` (`prisma/schema.prisma:2315-2331`) — durable, queryable per-user/per-account sync-integrity failures (kinds at `schema.prisma:2332-2341`), i.e. "which users are having a bad time syncing"; `NotificationDelivery` (`schema.prisma:2446+`) — per-user email delivery outcomes; `PlaidItem`/`Connection` status enums (`schema.prisma:65-98`) — connection-health clustering; `User.deactivatedAt` — the only churn-like event that exists.

**Honest verdict: nothing exists yet in the sense Chris means. A Customer Success Space in PO1 is an access-gated shell whose first honest widget would be a SyncIssue/connection-health triage list — real CS primitives (cases, health scores) are net-new modeling deferred until wanted.**

---

## 3. Build order — belief confirmed, with a refinement

The belief was "Platform Ops and Security Ops are the easiest first builds because they have the most real underlying data." **Confirmed — with the refinement that they are not equally easy:**

1. **Security Operations — easiest.** Data *and* read routes exist (§2.2); the work is a capability-gated read path + widgets. Nothing to build below the presentation layer.
2. **Platform Operations — second.** Data, classifiers, and indexes exist; **no read routes do** (§2.1). Two-three thin endpoints (job health over `checkScheduledJobHealth()`, rate-limit status over `RateLimit`, env report via a `validateEnv()` refactor) precede any widget.
3. **Growth & Revenue — third.** A minimal honest panel (signups/activation/active) is derivable from existing `User`/`UserSession`/`AuditLog` fields; "Revenue" is structurally empty until v3.0 billing (§2.3).
4. **Customer Success — last.** Only oblique signals exist (§2.4); the first honest widget (sync-issue triage) is real but thin, and everything CS-specific is net-new modeling.

The right PO1.0 posture, matching Chris's stated priority ("the capability to create the Space and gate access to it matters more right now than every Space being immediately data-complete"): **seed and gate all four Spaces now; build real content for Security Ops then Platform Ops in the first PO1.x slices; let Growth & Revenue and Customer Success launch as honestly-labeled shells.**

---

### Evidence appendix (files newly read/verified for this investigation, beyond the 07-07 corpus)

`prisma/schema.prisma` — `SpaceCategory` (119-135), `SpaceMemberRole` (152-157), `UserRole` (243-246), `User` timestamps (326/344/368), `Space.category` (428) + lifecycle (448-449), `SpaceMember` (493-518), `AuditLog` (2211), `UserSession` (2259, `lastActiveAt` 2266), `PlatformSetting` (2282), `RateLimit` (2298), `SyncIssue` (2315), `Notification` (2400, `dedupeKey` unique 2427), `JobRun` (2509-2524). `lib/spaces/policy.ts` (ROLE_RANK 90, ACTION_POLICY 114, can 159) + `authorize.ts` (decideSpaceAction 74, requireSpaceAction 89). `lib/session.ts` (require* family; ROLE_ORDER 246). `lib/platform-settings.ts` (10-18). `lib/audit-actions.ts` (224 lines). `lib/security-history.ts` (23-56). `lib/jobs/health.ts` + `registry.ts` (73-139) + `scripts/check-job-health.ts`. `lib/rate-limit.ts`. `lib/env.ts` (validateEnv 107). `lib/widget-registry.ts` (DataRequirement 34-43; WIDGET_REGISTRY 1177). `lib/space-nav.ts` (SPACE_TAB_ORDER 35-45). `lib/space-templates/{registry,apply,create-route}` tests (category-exhaustive invariants). `app/api/spaces/route.ts` (GET 39-61; category validation 98-101; create transaction 132-174). `app/(shell)/dashboard/spaces/page.tsx` (memberships 36-38; publicSpaces 76). `components/ui/Sidebar.tsx` (fetch /api/spaces 106). `app/api/space/switch/route.ts` (membership check 41). `lib/space.ts` (resolveSpaceContext 168+, membership gate 182-202). `proxy.ts` (SYSTEM_ADMIN↔dashboard redirects 48-55; matcher 79-82). All 14 `app/api/admin/*` routes (guards re-verified; only `sessions` uses fresh auth, at line 42). `app/api/jobs/dispatch/route.ts` (CRON guard 44-52). `app/api/auth/register/route.ts:71`. `prisma/seed.ts` (sysadmin 309-315). `docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md` (Parts 1, 6). `STATUS.md` (D10 110, D12 112 + 337, parked table 337-343).

**Not verified / out of scope:** production data volumes (row counts in JobRun/AuditLog/RateLimit); deployed env configuration; PLATOPS roadmap phases beyond what is in code today. This document reports the codebase as it exists on disk on 2026-07-13.
