# PO1 Investigation — Platform Access Foundation

**Date:** 2026-07-07
**Type:** Investigation only. No implementation, no schema, no migrations, no file changes.
**Purpose:** Define the architectural foundation of Platform Operations before PO1 begins, focused on the proposed **Platform Access Foundation** as PO1's first slice.
**Grounding:** All conclusions cite the current codebase.

---

## 1. Executive summary

The current architecture supports the proposed model —

> Platform User → Platform Access → Fourth Meridian HQ (internal Space) → capability-gated widgets

— **more naturally than expected, with one missing primitive.** Everything on the *presentation* side already exists: "My Spaces" is nothing more than `spaceMember.findMany({ where: { userId, status: "ACTIVE" }})` (`app/api/spaces/route.ts`), a Space self-provisions its tabs, dashboard sections, and an AiAgent in one transaction, and widgets already **self-declare their requirements** via `DataRequirement` in `lib/widget-registry.ts`. So HQ-as-a-Space and capability-gated widgets are extensions of patterns that are already load-bearing, not new paradigms.

The one thing that does not exist is the *authorization* primitive. Platform authority today is **binary**: `enum UserRole { USER, SYSTEM_ADMIN }`, and all 14 `app/api/admin/*` routes gate on a single `requireSystemAdmin`. There is no middle tier, no capability, no grant, no entitlement anywhere in the schema. So "Support Agent," "Security Admin," "Read-only Auditor" etc. are **currently inexpressible** — they all collapse to "SYSTEM_ADMIN or nothing."

The recommendation is therefore unambiguous: **Platform Access should be PO1.0 — the first slice, before any operations surface is built.** It is the missing authorization axis that every later ops widget (Security, Jobs, Users, Billing, AI Ops) will need to gate on. Build it first and every ops widget is born capability-gated; build the dashboards first on raw `SYSTEM_ADMIN` and you will retrofit capabilities across every widget later — the exact cross-cutting migration debt this codebase has learned to avoid.

The correct shape: **HQ is a real (system-singleton) Space** reused for presentation; **Platform Access is a platform-wide, capability-based authorization layer** that is *orthogonal* to Space membership; and **SYSTEM_ADMIN is retained only as break-glass superuser**, with day-to-day ops routed through capabilities. This is precisely the "presentation reuses Spaces, authorization stays platform-wide" separation the prompt proposes, and it is the right architecture.

---

## 2. Does Platform Access belong in PO1? — **Yes, as PO1.0, first.**

Two facts from the codebase make this decisive:

- **Authority is binary today.** `enum UserRole { USER, SYSTEM_ADMIN }` (`prisma/schema.prisma`) with the comment "platform administration — not for daily use." Every admin capability is one gate: `requireSystemAdmin` on all 14 `app/api/admin/*` routes (uniform, verified). There is no way to grant a support agent read-only user access without making them a full platform god.
- **The ops surfaces PO1 will build all need the same missing answer** to "who may see/do this." If the Operations Dashboard, Security, Jobs, Users, Billing, and AI Operations are built before the capability seam exists, each hard-codes `requireSystemAdmin`, and introducing granular roles later means editing every one of them plus every widget's visibility. That is a fan-out refactor.

Building Platform Access first means the *first* ops widget is already written against `requirePlatformCapability(cap)`. The seam is defined once, at the cheapest possible moment. This is the same lesson the FlowType/Merchant-Intelligence initiatives internalized (single authority defined before readers cut over), applied to authorization.

**Conclusion:** Platform Access is not one PO1 feature among many — it is the foundation the rest of PO1 stands on. It must be PO1.0.

---

## 3. Recommended architecture

Fourth Meridian already has **two orthogonal authorization axes**, and the vision maps cleanly onto keeping them orthogonal:

| Axis | Today | Scope | Purpose |
|---|---|---|---|
| **Platform authority** | `UserRole` (USER / SYSTEM_ADMIN) | platform-wide | who may operate the platform |
| **Space authority** | `SpaceMemberRole` + `can()` | per-Space | who may do what *inside one Space* |

The proposal — "presentation reuses Spaces, authorization stays platform-wide" — is exactly: **use the Space axis for HQ's presentation, and a new capability layer on the platform axis for HQ's authorization.** Do not merge them.

Recommended structure:

```
Platform User (UserRole.USER, the same account)
      │  granted…
      ▼
Platform Access  ── a new platform-scope grant carrying CAPABILITIES
      │  which, as a side effect, makes…
      ▼
Fourth Meridian HQ  ── a real, system-singleton Space appear in "My Spaces"
      │  whose tabs/sections/widgets are gated by…
      ▼
Capabilities  ── SECURITY_VIEW, JOB_VIEW, USER_MANAGE, AI_OPERATIONS_VIEW, …
```

Why each piece reuses what exists:

- **HQ as a Space** reuses the "My Spaces" listing, `SPACE_TAB_ORDER` (`lib/space-nav.ts`), `SpaceDashboardSection` rows, and the `widget-registry.ts` adapter pattern ("add one entry, no switch/case"). HQ even gets an `AiAgent` for free (the "AI Operator" surface) since every Space provisions one.
- **Capability-gated widgets** extend the *existing* widget-declaration pattern. Widgets already declare a `DataRequirement { accountTypes, visibility, minCount, reason }`; adding a `requiredCapability` field is the same self-describing shape — the runtime already filters widgets by requirement, so it would filter by capability the same way.

---

## 4. Recommended authorization model — **capabilities, bundled into named roles, gated by a pure predicate**

Answering Q2 directly, grounded in the codebase's own proven pattern:

**Model capabilities as the atomic unit; expose named roles as capability bundles.** This is RBAC-with-capabilities, and it fits the existing `lib/spaces/policy.ts` design *exactly*:

- `policy.ts` already encodes authorization as a **pure static map** — `const ACTION_POLICY: Record<SpaceAction, ActionRule>` — decided by a pure `can(action, ctx)` with the I/O adapter (`authorize.ts`) kept separate. Platform Access should mirror this one-to-one:
  - **Pure layer** (`lib/platform/policy.ts`, conceptually): `PlatformCapability` union, a `PLATFORM_ROLE_CAPABILITIES: Record<PlatformRole, PlatformCapability[]>` bundle map, and a pure `hasCapability(cap, grant): boolean`.
  - **Impure adapter** (`lib/platform/authorize.ts`, conceptually): `requirePlatformCapability(cap)` — session + grant lookup → pure decision, returning the same Go-style `[auth, err]` tuple the `require*` family already uses.
- **Named roles** (Support Agent, Security Admin, Operations Engineer, Customer Success, Finance, Read-only Auditor, AI Operator) are *not* new enum branches of `SpaceMemberRole` — they are **presets that expand to capability sets**, defined in the pure bundle map. Onboarding grants a role; the system stores/derives capabilities. A person who is "Security + Finance" simply holds the union — no combinatorial dashboard problem (see §Q5 below).

Why capabilities over the alternatives you listed:

- **Roles alone** → the combinatorial-dashboard explosion; can't express "Finance but read-only."
- **Space membership (`SpaceMemberRole`)** → wrong axis and wrong cardinality. `SpaceMemberRole` is a fixed 4-value enum (OWNER/ADMIN/MEMBER/VIEWER) with *customer* semantics; overloading it with "AI Operator" conflates two domains, and Space authz is per-Space while ops authority is platform-global. Using `can()` to gate an ops widget would be an architectural category error.
- **Raw permissions/grants without role bundles** → operationally painful to administer (you'd grant 12 capabilities per hire by hand). Bundles fix onboarding ergonomics while capabilities keep enforcement granular.

**Storage shape (recommendation only — not writing schema):** a platform-scope analog of `SpaceMember` — a per-user `PlatformGrant`/`PlatformMember` record (userId, role(s) and/or explicit capability overrides, `grantedById`, `status`, mirroring `SpaceMember.revokedById`/`status`). This makes grants auditable and revocable with the same lifecycle vocabulary the codebase already uses.

**Enforcement bridge:** `requirePlatformCapability(cap)` should (a) allow `SYSTEM_ADMIN` unconditionally (break-glass), and (b) allow any holder of `cap`. This makes the migration backward-compatible: today's `requireSystemAdmin` routes can adopt `requirePlatformCapability(...)` one at a time, existing admins keep working, and granular roles become expressible immediately.

---

## 5. Relationship between Platform Access and Spaces

**HQ should be a real Space — specifically a system singleton — and Platform Access should be the single source of truth for who sees it.** (Answers Q3 and Q4.)

- **Real Space, not a parallel construct.** Making HQ a genuine `Space` row is what buys the reuse (listing, tabs, sections, widget registry, AiAgent). A "special/parallel system Space" that isn't a real `Space` would forfeit exactly the reuse that makes this Spaces-first.
- **But a *system singleton*, not an ordinary user Space.** HQ must be: created once by a bootstrap seed (not via `POST /api/spaces`), un-deletable (the PERSONAL-lifecycle guards already show the pattern for "cannot archive/trash/delete"), invisible to customer analytics, and marked distinctly — a reserved `SpaceCategory` (e.g. `PLATFORM`/`INTERNAL`) or an `isSystem` marker. `type` can remain `SHARED`.
- **Appearance in My Spaces (Q4) fits with essentially no new mechanism.** Two viable wirings:
  - **(A) Membership-mirrored:** insert an `ACTIVE SpaceMember` row when Platform Access is granted → HQ appears in the *unchanged* "My Spaces" query. Fastest, but creates a **dual source of truth** (PlatformGrant *and* SpaceMember must stay in sync) — the same class of sync-seam the WAS↔SAL retirement existed to remove. Not recommended as the durable model.
  - **(B) Access-derived (recommended):** Platform Access is the single source of truth; the "My Spaces" listing unions-in HQ for any user holding platform access. One small change to one query, one source of truth, no sync seam.

  Recommend **(B)**: it keeps PlatformGrant authoritative and avoids re-introducing a dual-write. HQ then "appears automatically once platform access is granted," exactly as the vision states.
- **Critical invariant:** HQ *presentation* comes from the Space; HQ *authorization* must come **only** from platform capabilities — never from `SpaceMemberRole`/`can()`. An HQ widget must gate on `requirePlatformCapability`, so that a customer-space ADMIN never inherits ops authority and an ops capability never leaks into a customer Space. This orthogonality is the whole point, and it is correct.

**On the data plane (carried from the prior SecOps review):** HQ ops widgets read **platform-global** data (all users, all jobs, all sessions), which deliberately escapes the `spaceId`-scoping invariant every customer assembler enforces (`buildContext`/assemblers filter by `spaceCtx.spaceId`). That escape must be an explicit, capability-gated, audited ops data path — not the customer assembler path. Reusing the Space *shell* does not mean reusing the Space *data-scoping* rules; those are intentionally different.

---

## 6. Relationship between Platform Access and SYSTEM_ADMIN

- **SYSTEM_ADMIN becomes break-glass, not the daily driver.** Today it is the only key and it opens every door. Under Platform Access it should be reframed as the **superuser bypass**: `requirePlatformCapability` grants it everything unconditionally, so you can never lock yourself out and can bootstrap the first grants. All *routine* ops — even performed by an admin — should flow through capabilities so least-privilege is the default and SYSTEM_ADMIN is reserved for bootstrap, recovery, and destructive infra actions.
- **Migration is incremental and non-breaking.** Because `requirePlatformCapability(cap)` treats SYSTEM_ADMIN as always-allowed, the existing 14 `requireSystemAdmin` routes can be converted route-by-route with zero behavior change for current admins, while immediately enabling granular grants. This mirrors how the codebase does everything: additive, dual-safe, cut over incrementally.
- **Audit already half-supports this.** `AuditLog.performedByAdminId` exists for "a SYSTEM_ADMIN acted on behalf of another user." Generalize its *meaning* (or add a sibling) to "a platform operator with capability X acted," so every capability-gated action stays attributable. `UserSession.revokedById` shows the same admin-attribution pattern is already in place.

---

## 7. Recommended PO1 roadmap (with the new first slice)

**PO1.0 — Platform Access Foundation** *(new, first — the authorization seam)*
- Pure `lib/platform/policy.ts`: `PlatformCapability` union, `PLATFORM_ROLE_CAPABILITIES` bundle map, `hasCapability()` — mirroring `spaces/policy.ts`.
- Impure `requirePlatformCapability(cap)` adapter in the `require*` family — SYSTEM_ADMIN bypass + capability grant, Go-style tuple return.
- Platform grant record (userId, role(s)/capabilities, grantedById, status).
- HQ system-singleton Space bootstrap (seed, un-deletable, reserved category/marker).
- "My Spaces" unions-in HQ for platform-access holders (access-derived visibility).
- Exit criteria: a non-SYSTEM_ADMIN user granted `AUDIT_VIEW` can see HQ + the audit widget and nothing else; SYSTEM_ADMIN sees all; a source tripwire (à la `security-surface.test.ts`) asserts no HQ widget gates on `SpaceMemberRole`.

**PO1.1 — Operations Dashboard shell** — HQ tabs/sections; widgets self-declare `requiredCapability`; the widget runtime filters by capability (extends the existing `DataRequirement` gate).

**PO1.2 — Security ops** (`SECURITY_VIEW`) — reuse `admin/audit` (already filterable), `admin/security/*`, forced-TOTP policy state, sessions.

**PO1.3 — Jobs ops** (`JOB_VIEW`) — thin read endpoint over the *already-built* `lib/jobs/health.ts` + `JobRun` ledger (data + classifier exist; only the read surface is missing).

**PO1.4 — Users/Access ops** (`USER_MANAGE`, `ACCESS_GRANT`) — user list + the grant-management UI for Platform Access itself (self-hosting: HQ administers HQ access).

**PO1.5 — AI Operations** (`AI_OPERATIONS_VIEW`) — surface HQ's own AiAgent + platform AI health.

**PO1.6+ — Billing / Finance / Env-status / Key-rotation-readiness** — each a capability + widget, built on the same foundation.

Sequencing rule (borrowed from the AI-evolution-ladder doctrine already in STATUS.md): **the authorization seam is the entry criterion for every later slice.** Nothing ships gated on raw `SYSTEM_ADMIN` once PO1.0 exists.

---

## 8. Risks

1. **Dual source of truth for HQ visibility** — if grants are mirrored as `SpaceMember` rows (option A). Mitigation: access-derived visibility (option B); PlatformGrant is authoritative.
2. **Authorization-axis confusion** — a developer gating an HQ widget on `SpaceMemberRole`/`can()` instead of a platform capability. This would silently tie ops authority to customer-space roles. Mitigation: a source-scan tripwire test (the codebase already does this in `security-surface.test.ts`) forbidding `can(`/`requireSpaceRole` inside HQ ops code.
3. **Scoping-invariant escape** — HQ widgets read platform-global data, bypassing the `spaceId` filter that protects customer data. Mitigation: a distinct, capability-gated, audited ops data layer; never route ops reads through the customer assemblers.
4. **Break-glass lockout** — misconfigured capabilities lock everyone out of administration. Mitigation: retain SYSTEM_ADMIN superuser bypass; audit every use of it loudly.
5. **Capability sprawl** — too many fine-grained caps become unmanageable. Mitigation: launch with ~6–8 coarse view/act capabilities aligned to the seven named roles; split only on demonstrated need.
6. **Privilege-escalation surface** — the grant-management endpoint (PO1.4) is now a high-value target (grant yourself `ACCESS_GRANT` → own the platform). Mitigation: gate grant management behind its own capability, require `requireFresh*` (live revocation, no cache), and audit exhaustively — and note today's admin routes mostly use cached `requireSystemAdmin`, so fresh-auth for grant mutations is a deliberate upgrade.
7. **HQ Space leaking into customer surfaces** — analytics, public listings, "spaces count," AI context. Mitigation: the system-singleton marker must be excluded everywhere customer Spaces are enumerated/aggregated; add it to the same guards.

---

## 9. Final recommendation

**Adopt Platform Access as PO1.0 — the first and foundational slice of PO1 — modeled as a platform-wide, capability-based authorization layer that is orthogonal to Space membership.**

Concretely:
- **Platform Access = capabilities, bundled into named roles**, implemented as a pure policy map + impure adapter that mirrors `lib/spaces/policy.ts` / `authorize.ts` one-to-one. This is the codebase's own proven, tested pattern applied to a new axis.
- **Fourth Meridian HQ = a real, system-singleton Space**, reusing every presentation primitive (My Spaces listing, tabs, dashboard sections, widget registry, AiAgent), created by bootstrap and un-deletable.
- **Visibility is access-derived** (single source of truth: the grant), so HQ appears in My Spaces automatically when access is granted — no `SpaceMember` sync seam.
- **Widgets are capability-gated**, extending the existing `DataRequirement` self-declaration pattern with a `requiredCapability` — one HQ dashboard, not one per role. This scales strictly better than role-driven dashboards and matches how widgets already work.
- **SYSTEM_ADMIN is retained as break-glass superuser**; all routine ops migrate to `requirePlatformCapability` incrementally and non-breakingly.

The architecture already supports this model far more than it resists it. The only genuinely new thing is the authorization primitive — and defining it *first*, before any operations surface exists, is the single highest-leverage decision available to PO1. The prompt's instinct is correct on every axis: presentation reuses Spaces, authorization stays platform-wide, and the two must remain orthogonal.

---

### Evidence appendix (grounding for this investigation)

`prisma/schema.prisma` — `enum UserRole { USER, SYSTEM_ADMIN }`; `SpaceMember` (role/status/revokedById); `Space` (type/category/isPublic/lifecycle, `aiAgent`); `SpaceDashboardSection`. `app/api/spaces/route.ts` — "My Spaces" = `spaceMember.findMany({ userId, status:"ACTIVE", space not archived/deleted })`, and the create-transaction that provisions Space + OWNER membership + dashboard sections + AiAgent together. `lib/space-nav.ts` — fixed tab rail, "SETTINGS only for managers" (role-gated tab rendering already conceptual). `lib/widget-registry.ts` — widgets self-declare `DataRequirement`; adapter pattern. `lib/spaces/policy.ts` + `authorize.ts` — pure `can()` + `Record<SpaceAction, ActionRule>` + impure adapter (the pattern to mirror). `app/api/admin/*` — 14 routes, uniform `requireSystemAdmin`. `lib/jobs/health.ts`, `JobRun`, `AuditLog.performedByAdminId`, `UserSession.revokedById` — ops data/attribution primitives that already exist. Grep confirmed: **no** `capability`/`grant`/`entitlement`/`PlatformRole` authorization primitive exists today.

**Not verified / out of scope:** the later PLATOPS roadmap phases' code (they read as planning); production configuration. This is a codebase-grounded architectural investigation, not an implementation plan.
