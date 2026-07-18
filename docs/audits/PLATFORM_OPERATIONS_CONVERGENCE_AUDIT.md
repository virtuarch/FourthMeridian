# Platform Operations → Fourth Meridian HQ · Convergence Audit

**Status:** INVESTIGATION + ARCHITECTURE ONLY — no code, no schema, no migrations. Planning deliverable.
**Date:** 2026-07-18 · verified against the working tree (`feature/v2.5-spaces-completion`, `140f244` era)
**Scope:** Map the existing Platform Operations surface, the prototype target, real operator capabilities, and the security boundary; separate presentation migration from backend capability additions; answer the launch-readiness question.
**Method:** four parallel read-only investigations (architecture · operator capabilities · security boundary · prototype) cross-checked against `prisma/schema.prisma`, `lib/platform/**`, `app/api/platform/**`, `app/api/admin/**`, `app/(shell)/dashboard/platform/**`, `components/platform/**`, and `prototype/prototype-claude/lib/platform.ts`.
**Predecessor:** `docs/plans/platform-ops-roadmap.md` (PO1, 2026-07-06). This audit reports the state *after* PO1 Phases 1–4 substantially landed (PlatformGrant axis, job-run ledger, read-model layer, the grant-gated platform Space) — it is a delta + finish-line document, not a re-derivation of PO1's vision.

---

## 0. The answer, up front

**Can Platform Operations become a true Fourth Meridian HQ workspace today?**

**For presentation: it already is one.** Platform HQ is not a proposal — it ships. `PLATFORM_OPS`, `SECURITY_OPS`, `GROWTH_REVENUE`, and `CUSTOMER_SUCCESS` render *today* at `/dashboard/platform/[area]` through the same `SpaceShell` + universal `WORKSPACE_REGISTRY` that customer Spaces use, gated by a `PlatformGrant` axis that is structurally separate from customer membership. There is **no second admin shell to build** — the frame convergence PO1 called the "presentation flip" has happened. What remains on the presentation side is *body* convergence (bespoke widget cards → Atlas panels/trust surfaces) and two missing workspaces (Users, Spaces).

**For running the platform: not safely yet — and the gaps are backend actions, not UI.** Every Platform HQ workspace is currently a **read-model projection**. An operator can *see* the fleet but can only *act* through a narrow set of write routes (issue/revoke grants, deactivate/reactivate a user, approve/deny beta requests, run a whole-fleet job). The operator actions a real platform steward needs — **retry one failed connection**, grant/remove Space membership, transfer ownership, recover an orphaned Space, promote a user, cold-invite an email — have **no endpoint**. None of them need a schema change; all are additive API gaps. And the authentication controls around privileged access are weaker than the data boundary: **MFA is default-OFF**, there is no per-action step-up, and platform *reads* are unaudited.

**Minimum to let a real operator run the platform safely** (detailed in §7):
1. **Hard-enforce TOTP** for `SYSTEM_ADMIN` and every WRITE-level grant holder (infra exists; flip it from default-off to mandatory).
2. **Targeted per-connection resync** — the one genuine *operational* gap (today: retry all, or nothing).
3. **Read-audit on platform surfaces** — record that an operator viewed PII-adjacent operational data.
4. **Space-membership operator actions** (grant / remove / transfer / recover) so "run the Spaces" is real, each additive + audited.

Everything else is either already present or a v2.6/v2.7 concern.

---

## 1. Existing architecture — the two-surface reality

There are **two deliberately separate operator surfaces**. Conflating them is the primary risk this migration must avoid.

### 1.1 Platform HQ — the operational Space (the convergence target, already live)

- **Route:** `app/(shell)/dashboard/platform/[area]/page.tsx` — the *only* render path. Server component; gates in order: known `PlatformArea` → session → ACTIVE `PlatformGrant` → `hasPlatformAccess(area,"READ")`; on failure `redirect("/dashboard/spaces")` (**never 404** — no existence disclosure). Loads the singleton platform Space + its enabled `SpaceDashboardSection` rows and renders `<PlatformSpaceDashboard>`.
- **Renderer:** `components/platform/PlatformSpaceDashboard.tsx` — a `"use client"` host that **reuses the shared `SpaceShell`** (`components/space/shell/SpaceShell.tsx`) exactly as the customer `SpaceDashboard` does, and publishes Space identity into the shared `ContextualNavbar` via `useSpaceChromePublisher`. It renders each area's active workspace body from a **platform-local** `PLATFORM_WIDGET_REGISTRY` (section-key → widget), leaving the customer `WIDGET_REGISTRY` untouched.
- **Navigation:** platform Spaces surface as cards in `components/dashboard/SpacesClient.tsx` and links in `ContextualNavbar`; `app/(shell)/dashboard/spaces/page.tsx` loads a user's ACTIVE grants and the matching Spaces (access-derived, **no `SpaceMember` rows**). A `SECURITY_OPS` notification even deep-links into it.

### 1.2 `/admin/*` — the SYSTEM_ADMIN shell (bespoke, and where the real CRUD lives)

- **Separate shell:** `app/admin/layout.tsx` (distinct "Fourth Meridian Admin" chrome + `AdminNav`); any non-`SYSTEM_ADMIN` is redirected. This is **not** where ops widgets live — it administers **grants, users, spaces, providers, security, audit**. SYSTEM_ADMIN is proxied off `/dashboard/*` to `/admin`.
- **This is the action surface today.** The mutating operator capabilities that exist at all (`/api/admin/users`, `/api/admin/spaces`, `/api/admin/platform-grants`, `/api/admin/security/*`) live behind `requireSystemAdmin` / `requireFreshSystemAdmin`, rendered by bespoke admin pages — *not* by the converged Platform HQ Space.

> **The core migration tension in one sentence:** Platform HQ (grant-gated Space) is a rich **read** surface; `/admin` (SYSTEM_ADMIN shell) is the **write** surface. Convergence means moving the *right* admin actions into the Space under the *grant* axis — not copying the whole admin shell, and not widening a grant into SYSTEM_ADMIN.

### 1.3 Workspace registry — already universal

`lib/platform/workspaces.ts` defines platform workspaces as **universal `WorkspaceDefinition`s** (`domain:"platform"`), spread into the ONE `WORKSPACE_REGISTRY` at `lib/perspectives.ts` alongside finance workspaces. Two owners:

- **`PLATFORM_WORKSPACES`** (identity — id/label/icon), 8 defs: `platform-overview` · `platform-jobs` · `platform-providers` · `platform-operations` · `platform-alerts` · `platform-trends` (History) · `platform-ai` · `platform-costs`. A test guard pins "no finance vocabulary on a platform definition" (no routing/dataNeeds/envelope — widgets self-fetch).
- **`PLATFORM_AREA_WORKSPACES`** (composition — which workspaces each area exposes). Only `PLATFORM_OPS` is decomposed into 8 workspaces; the other three areas keep a single `platform-overview` ("decompose on demand"). Area labels/seed metadata live in `lib/platform/policy.ts` (`PLATFORM_AREAS`, exhaustive `Record<PlatformArea, …>`).

### 1.4 Data loaders — pure read-models over operational ledgers

All are `"server-only"` pure projections ("pure core + injected I/O"), **zero writes**, sourcing only operational tables — **never customer money tables**:

| Loader | Projects | Over |
|---|---|---|
| `lib/platform/activity/activity.ts` | DAU/WAU/MAU, most-active Spaces | `AuditLog` (LOGIN/SPACE_SWITCH) + `User` + `UserSession` |
| `lib/platform/growth/growth.ts` | signup + beta-conversion funnels | `BetaAccessRequest` + `User` + `UserSession` |
| `lib/platform/provider-health.ts` | provider trust (OPERATIONAL/DEGRADED/STALE/FAILING/UNKNOWN, worst-wins) | `JobRun` + `ApiUsageCounter` + freshness/connection-health |
| `lib/platform/resource-freshness.ts` | content-derived freshness (S1 authority) | `MAX(FxRate.date)`, newest `PriceObservation` (never `JobRun.status`) |
| `lib/platform/cost/cost.ts` | cost/latency w/ provenance + trust tier | S7 history + S9 convergence (no direct ledger reads) |
| `lib/platform/history/history.ts` | operational history at asOf/window (S7 authority) | registered sources, worst-tier `Completeness` |
| `lib/platform/convergence/convergence.ts` | cross-area episodes (narrative clustering) | participant ledgers (AuditLog, alert runs) |
| `lib/platform/ai/ai-usage.ts` | per-day AI usage + estimated spend | `ApiUsageCounter` + `lib/usage/pricing` |
| `lib/jobs/health.ts` | rich job health (running/dead/nextExpectedRun) | `JobRun` |
| `lib/platform/operations/{registry,execute}.ts` | manual-op command vocabulary + execution | `SCHEDULED_JOBS` → canonical `runJob(trigger:"manual")` |

### 1.5 Widgets — bespoke body kit

Widgets under `components/platform/widgets/` are built from `components/platform/widget-kit.tsx` (`useWidgetFetch<T>` self-fetch hook + `PlatformWidgetCard`), each hitting its own `/api/platform/...` route. This is the **one place the convergence is incomplete**: the widget body uses a bespoke card family, **not** the Atlas panels (`components/atlas/panels/`) or trust surfaces (`components/space/trust/`) the prototype calls for. Existing widget families: Ops (14 — job-health, rate-limits, env-status, api-usage, connection-health, resource-freshness, manual-operations, provider-health, alerts, history, convergence, timeline, ai-trend, cost), Security (audit-feed, auth-posture, sessions, anomalies), Growth (signups, beta-requests, users, activity, funnel), Customer Success (sync-issues).

---

## 2. Prototype mapping (`prototype/prototype-claude`)

- **Where/how:** `prototype/prototype-claude/lib/platform.ts` (`PLATFORM_SPACES`), viewable at `http://localhost:3000/prototype/claude`. **Static mock data** — "no backend, no APIs." It documents the *mapping* to production loaders but calls none.
- **IA stance:** models Fourth Meridian HQ as **four Spaces** (1:1 with the production `PlatformArea` enum), reusing the same shell/cards/charts/panels as customer Spaces — "only the domain changes." Only **Platform Operations** is decomposed; the other three keep one Overview each. **This is exactly what production already implements at the frame level.**
- **Design primitives:** `Surface` / `Block` / `Figure` / `Delta`; viz family (`Stat`, `DistributionBar`/`MiniBars`/`Funnel`, `StatusList`/`HealthDot`/`Meter`, `ActivityTimeline`); `SidePanel`/`DrillPanel` for RightPanel inspection; `Sidebar` section anchors for LeftPanel browsing; the ambient `fact → interpretation → caveat → action` insight. Gap-aware bars **hatch `null`** (telemetry gap ≠ zero) — an honesty primitive worth carrying over.

### 2.1 Prototype IA vs the mission's target IA — a real divergence

The mission specifies Platform Operations = **Overview · Users · Spaces · Connections · Jobs**. The **prototype only models Overview · Providers · Jobs** — it contains **no Users and no Spaces workspace at all**, and reframes "Connections" as a **Providers** tab (end-user Connections lives globally, not inside Platform Ops).

| Mission target tab | Prototype | Production (`PLATFORM_AREA_WORKSPACES`) |
|---|---|---|
| Overview | ✅ | ✅ `platform-overview` |
| Users (invite/access/roles) | ❌ absent | ⚠️ read-only *widgets* (Growth: users/activity/funnel); **no workspace, no actions** |
| Spaces (inspect/membership) | ❌ absent | ❌ none (lives in `/admin/spaces`, read-only) |
| Connections (provider health/sync) | ⚠️ reframed as **Providers** | ✅ `platform-providers` + connection-health widget |
| Jobs (queue/retries/failures) | ✅ | ✅ `platform-jobs` + job-health/operations widgets |

**Implication for planning:** the prototype is the visual reference for Overview/Providers/Jobs, but the mission's **Users** and **Spaces** workspaces are *net-new IA* beyond the prototype. Their visual language must be *derived* (reuse `Surface`/`Block`/tables + LeftPanel browse + RightPanel inspect + action modals), and — critically — they are the workspaces that require the missing **backend actions** in §5. Design them last, behind the capabilities.

---

## 3. Prototype → Production mapping table

| Prototype concept | Production equivalent (exists) | Convergence state |
|---|---|---|
| HQ = 4 Spaces on `PlatformArea` | `/dashboard/platform/[area]` + `PLATFORM_AREAS` | **DONE** |
| Same shell as customer Spaces | `SpaceShell` reused by `PlatformSpaceDashboard` | **DONE (frame)** |
| Universal workspace registry | `PLATFORM_WORKSPACES` in `WORKSPACE_REGISTRY` | **DONE** |
| Decompose only Platform Ops | `PLATFORM_AREA_WORKSPACES` (8 vs 1×3) | **DONE** |
| `Surface`/`Block`/`Figure`/viz/panels | bespoke `widget-kit.tsx` `PlatformWidgetCard` | **PARTIAL** — body not on Atlas panels/trust |
| DrillPanel RightPanel inspection | none (widgets are flat cards) | **GAP** |
| Ambient insight (fact→action) | trust-tier text only; no action affordance | **GAP** |
| Users / Spaces operator workspaces | `/admin/*` bespoke pages, read-mostly | **GAP** (see §5) |

---

## 4. Current operator capabilities (what works today)

Two authorities, never conflated: **SYSTEM_ADMIN** (`/api/admin/*`, `requireFreshSystemAdmin`) and **platform grant-holder** (`/api/platform/*`, `requireFreshPlatformAccess`, per-area READ/WRITE). **No schema gaps found** anywhere in this audit — every model needed already exists.

**Supported today:**
- **View users** — `/api/admin/users`, `/api/platform/growth-revenue/users` (identity + lifecycle + last-login + active sessions), `/api/admin/security/users`. Cross-user.
- **Approve / deny / resend access requests** — `BetaAccessRequest` queue; `POST …/requests/[id]/approve|deny` (GROWTH_REVENUE WRITE, fresh). Re-approving rotates + re-sends the token in place (resend).
- **Deactivate / reactivate users** — `POST /api/platform/growth-revenue/users/[userId] {action}` → toggles `User.deactivatedAt` + revokes sessions; cannot target SYSTEM_ADMIN or self; data preserved.
- **Manage platform-area roles** — `PlatformGrant` create/reinstate/level-change/revoke via `/api/admin/platform-grants` (SYSTEM_ADMIN-only, fresh, revoke-don't-delete, **fully audited in one transaction** with `performedByAdminId`).
- **View all spaces + memberships** — `/api/admin/spaces` (cross-user, ACTIVE members + role + canonical account counts). Read-only.
- **Fleet job/sync operations** — `POST /api/platform/platform-ops/operations {commandId:"run-now:sync-banks"}` (PLATFORM_OPS WRITE, fresh, rate-limited, audited) runs a whole-fleet job body through `runJob(trigger:"manual")`; also crypto/fx/prices run-now + dry-run. One execution path; `JobRun` is the in-flight lock.
- **Inspect fleet health** — job-health, provider-health, connection-health, resource-freshness, history, sync-issues, api-usage, ai-trend, cost — all read-models.
- **Security operator writes (SYSTEM_ADMIN)** — 2FA-reset, regenerate recovery codes, list/revoke sessions, patch security settings.

---

## 5. Missing operator capabilities (the real work)

Every gap below is an **API gap** — the schema supports the write; no endpoint offers it. **No UI-only gaps** exist (a missing action is missing its route, not just its button). **No schema gaps** exist.

### 5.1 User lifecycle
- **Promote/demote `User.role` (USER ↔ SYSTEM_ADMIN)** — MISSING. No endpoint flips the role; promotion is seed/out-of-band only. *API gap.*
- **Cold-invite an arbitrary email** — PARTIAL. Invites require a pre-existing `BetaAccessRequest` row (originated by the public form). No operator "create request/invite" endpoint. *API gap.*
- (`User.forcePasswordReset` field exists but no operator route sets it — likely out-of-band.)

### 5.2 Space lifecycle (the largest cluster)
- **Grant / remove Space access (operator)** — MISSING. Membership changes exist *only* member-side (`SpaceInvite` requires an OWNER/ADMIN *member*). A non-member operator has no path. *API gap.*
- **Transfer ownership** — MISSING. `SpaceMemberRole.OWNER` exists; no `transferOwnership` route. *API gap.*
- **Recover orphaned/inaccessible Spaces** — MISSING. Deactivation preserves `SpaceMember` rows by design, but no operator route re-owns/re-admits a Space whose owner is deactivated or deleted. *API gap.*

> These three are what a **Spaces** operator workspace (mission IA) actually needs to exist for. Without them, a Spaces workspace is just the read-only `/admin/spaces` census relocated.

### 5.3 Connection / sync operations
- **Targeted per-connection retry / force-refresh** — MISSING, and the **only genuine operational gap** (an operator's most common real task). The registry's `retry`/`refresh`/`backfill`/`invalidate` KINDS are `status:"reserved"` (vocabulary only); operation targets are whole-`SCHEDULED_JOBS` bodies keyed by `jobName` with **no parameterization by `connectionId`/`itemId`/`userId`**. The only per-item refresh routes (`app/api/accounts/[id]/sync`, `app/api/plaid/refresh`) are **owner-scoped** — an operator cannot drive them for another user. Today it's *retry the whole fleet, or nothing*.
  - **Required backend capability** (pick one): (a) a **parameterized `OperationCommand`** (e.g. `retry:sync-banks` accepting `connectionId`/`plaidItemId`) resolving a per-item body under the same `runJob`/`withPlaidItemSyncLock`/audit envelope — the reserved `retry` kind is designed for exactly this; or (b) an operator route `POST /api/platform/.../connections/[id]/resync` reusing the per-item sync body but authorized via `requireFreshPlatformAccess` instead of owner identity.
- **Operator write to `Connection.status`** (e.g. clear NEEDS_REAUTH) — MISSING and a **genuine constraint, not just a gap**: reauth is inherently user-driven (Plaid Link update mode). The operator capability here is a *reconnect-nudge* to the affected user, not a status flip.

---

## 6. Security considerations

**Data-isolation boundary: structurally enforced and tripwire-tested — the strongest part of the design. Do not weaken it.**
- Two orthogonal axes: `PlatformGrant`(area×level×status) vs `SpaceMember`(`SpaceMemberRole`). Separate models, separate policy modules (`lib/platform/policy.ts` pure `hasPlatformAccess` vs `lib/spaces/policy.ts`), separate adapters that import nothing from each other. A grant **never** mints a membership (schema comment + `spaceMember.create` tripwire); a membership never confers platform powers.
- Platform read-models provably touch only `User/UserSession/AuditLog/JobRun/FxRate/BetaAccessRequest/SyncIssue/PlatformGrant/ApiUsageCounter` — **zero** reads of `Transaction/Holding/Position/AccountBalance`. Locked by `lib/platform-surface.test.ts` (source-scan: no `can(`/`requireSpaceRole`/`SpaceMemberRole` under platform paths; `POST /api/spaces` never reads `platformArea`; no `spaceMember.create` in platform/grant code).
- **Escalation closed:** only SYSTEM_ADMIN can mint grants, and only to `role===USER` accounts — no platform capability can mint platform capabilities.
- **Least-privilege operator identity already expressible:** a normal USER account + a per-area READ/WRITE grant *is* the "employee" tier, with zero customer-data reach — no new role enum required for that.

**Gaps, by priority:**
1. **MFA is default-OFF (highest risk).** TOTP is real (`lib/totp.ts`) but `REQUIRE_TOTP_SYSTEM_ADMIN` / `REQUIRE_TOTP_ADMINS` / `REQUIRE_TOTP_ALL_USERS` all default `"false"`. As shipped, a SYSTEM_ADMIN — holder of the unconditional break-glass over every area — can log in **password-only**. The schema comment "requires TOTP (M3)" is aspirational. **Close first.**
2. **No per-action step-up.** `requireFresh*` only re-checks session revocation against the DB — it never re-prompts for credential/TOTP. Grant issuance and mutating operations have no re-auth ceremony.
3. **Reads are unaudited.** Writes are exemplary (transactional `AuditLog` + `performedByAdminId` + IP on every grant change and every operation, mutating *and* dry-run). But *viewing* PII-adjacent surfaces (Security Ops audit feed, sessions, user lists) leaves no trace. For a surface that aggregates exactly the metadata an attacker wants, read-audit is the main missing control.
4. **Coarse role enum.** `UserRole` is binary; the employee tier lives entirely in grant rows (works today, but there's no distinct employee identity class or role provenance for a larger team).

**New-surface doctrine (binding for every migration slice below):** each relocated **action** must (a) authorize via `requireFreshPlatformAccess(area,"WRITE")` under the grant axis — *never* widen a grant into `SpaceMember` semantics or SYSTEM_ADMIN; (b) write an `AuditLog` row with `performedByAdminId` in the same transaction; (c) read only operational tables (the `lib/platform-surface.test.ts` grep-proofs must still pass). A migration that reaches a customer money table from a platform panel is a defect of the highest severity class.

---

## 7. Recommended implementation phases

Separated exactly as the mission requires: **presentation migration** (no backend), **backend capability additions** (additive routes, existing schema), and **future v2.6/v2.7**. Each slice: one responsibility · one seam · one audit gate · independently shippable and revertible.

### Track P — Presentation migration (zero backend; safe to start immediately)
The frame is done; this is body + IA convergence over existing read-models.
- **P1 — Widget body onto Atlas primitives.** Reshell `widget-kit.tsx`'s `PlatformWidgetCard` onto `Surface`/`Block`/`Figure` + the viz family; carry the prototype's **hatched-null telemetry-gap** honesty primitive. Presentation-only; read-models untouched. *Gate:* visual parity at `/prototype/claude`; `platform-surface.test.ts` green.
- **P2 — RightPanel inspection.** Add `DrillPanel`/`SidePanel` (Atlas panels) for widget drill-downs (provider → per-connection detail; job → run history). Read-only inspection, no actions yet. *Gate:* no new data-plane reads.
- **P3 — Ambient insight affordance.** Render the trust-tiered `fact → interpretation → caveat → action` progression; the **action slot renders only when a real action route exists** (render-only-when-data doctrine — reserve the slot, wire it in Track B). *Gate:* no dead/placeholder actions.
- **P4 — Users & Spaces *read* workspaces.** Add `platform-users` and `platform-spaces` workspace defs to `PLATFORM_AREA_WORKSPACES`, relocating the read views from `/admin/users` + `/admin/spaces` into Platform HQ (census, memberships, lifecycle counts) as grant-gated read widgets. **Read-only** — the actions land in Track B. *Gate:* grant-axis authz (not SYSTEM_ADMIN), no customer-money reads.

### Track B — Backend capability additions (additive routes; existing schema)
Each: additive route + `requireFreshPlatformAccess(WRITE)` + transactional `AuditLog(performedByAdminId)` + reuse an existing body. Ordered by operator value.
- **B1 — Targeted per-connection resync** (§5.3). Highest operational value. Wire the reserved `retry` kind to a parameterized `OperationCommand` (or a `connections/[id]/resync` route) over the existing `withPlaidItemSyncLock` per-item body. *Gate:* idempotent, audited, lock-safe; a double-fire is harmless.
- **B2 — Space-membership operator actions** (§5.2): grant/remove access, transfer ownership, recover orphaned Space — each an additive route mutating `SpaceMember` under the grant axis with full audit. Turns P4's Spaces workspace from a census into a control surface. *Gate:* revoke-don't-delete preserved; owner-transfer atomic; recovery only for genuinely orphaned Spaces.
- **B3 — User role promotion + cold-invite** (§5.1): a guarded `User.role` flip endpoint (fresh SYSTEM_ADMIN, self-target forbidden, audited) and an operator "create invite" path that mints a `BetaAccessRequest`. *Gate:* promotion audited; invite single-use/expiring per existing token discipline.
- **B4 — Reconnect-nudge** for NEEDS_REAUTH connections (operator-triggered email to the affected user; **no** `Connection.status` write — respects the user-driven-reauth constraint). *Gate:* idempotent, rate-limited, audited.

### Track S — Security hardening (gates public-operator readiness; can parallel P/B)
- **S1 — Hard-enforce TOTP** for SYSTEM_ADMIN and every WRITE-level grant holder, independent of the default-off settings toggle. **Do before any non-founder operator exists.**
- **S2 — Per-action step-up** (re-prompt TOTP) for destructive operations: grant issuance, membership mutation, ownership transfer, role promotion, targeted resync.
- **S3 — Read-audit on platform surfaces** — record operator *views* of PII-adjacent areas (Security Ops feed, sessions, user lists) with `performedByAdminId`.

### Future — v2.6 / v2.7
- **v2.6 (ops intelligence, per PO1 Phase 6):** Ops Brief (the Daily Brief pattern inverted — "since yesterday: N signups, sync 98.2%, $X spend, 1 alert"); platform lenses; ops assemblers pointed at telemetry (structurally incapable of touching product data). PO1 Phases 1–3 are already v2.6b Ambient's measurement rig.
- **v2.6/2.7 (alerting maturity):** grow the declarative threshold rules (sync < X%, fail-open > 0, missed job, cost spike) → email; conservative human-triggered runbook automation (never autonomous).
- **v2.7 (team identity):** an explicit `EMPLOYEE`/`OPERATOR` role tier + role provenance if headcount outgrows the binary `UserRole` + grant model; per-Space audit exports; session revocation hardening (the `UserSession` "informational" caveat).
- **Deferred / out of scope:** ticketing (D10), third-party product analytics SDK (privacy stance), SSO/SAML, SOC 2 — architect nothing until a customer asks.

---

## 8. Answering the key question

> **"Can Platform Operations become a true Fourth Meridian HQ workspace today, and what minimum capabilities are required for a real operator to run the platform safely?"**

**It already is one — as a read surface.** The presentation flip PO1 planned has shipped: four grant-gated platform Spaces render through the shared `SpaceShell` + universal `WORKSPACE_REGISTRY`, on a customer/operator boundary that is structurally enforced and tripwire-tested. No second admin shell needs building. The remaining *presentation* work (Track P) is body convergence onto Atlas primitives + two read workspaces — all over existing read-models, zero backend.

**It cannot yet be *run* safely.** Two things stand between today and a real operator:

1. **Authentication strength** — MFA is default-off, so the break-glass superadmin can log in password-only; there is no step-up on destructive actions and no read-audit. **Track S1 (enforce TOTP) is the single highest-priority item in this document** and gates the moment a non-founder ever holds a grant.

2. **Operator actions** — every HQ workspace is read-only; the actions a steward needs (retry one connection, manage Space membership, transfer/recover Spaces, promote/invite users) have no endpoint. All are **additive API gaps over an already-sufficient schema** — none require a migration.

**Minimum viable safe-operator set:** **S1 (enforce TOTP)** + **B1 (per-connection resync)** + **S3 (read-audit)** + **B2 (Space-membership actions)**. With those four, a granted operator can authenticate strongly, resolve the most common fleet failure, run the Spaces, and leave an auditable trail — all under the grant axis, none of it touching customer money. Everything beyond that (role tiers, ops intelligence, alerting maturity) is optimization, not a safety gate.

---

*Sources: `prisma/schema.prisma` (User, PlatformGrant, SpaceMember, SpaceInvite, Connection, PlaidItem, JobRun, AuditLog, BetaAccessRequest, ApiUsageCounter); `lib/platform/{policy,authorize,seed,workspaces}.ts` + `{activity,cost,convergence,growth,ai,history,provider-health,resource-freshness,operations}`; `lib/platform-surface.test.ts`; `lib/audit-actions.ts`; `lib/auth.ts`; `lib/platform-settings.ts`; `app/(shell)/dashboard/platform/[area]/page.tsx`; `components/platform/{PlatformSpaceDashboard,widget-kit}.tsx` + `widgets/`; `app/api/platform/**`, `app/api/admin/**`; `app/admin/**`; `prototype/prototype-claude/lib/platform.ts`; `docs/plans/platform-ops-roadmap.md` (PO1). Prototype is static mock; all production claims verified against the working tree.*
