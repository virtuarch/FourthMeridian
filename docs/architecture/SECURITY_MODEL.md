# Security Model — Three Authorization Axes

**Status:** ARCHITECTURE — binding.
**Scope:** the authorization model separating customers, platform operators, and emergency administration in Fourth Meridian.

> **New here? Read this first.** Authorization in Fourth Meridian is **not one system
> with roles** — it is **three independent axes** that never share a decision. A
> customer's Space membership grants access to *that customer's money and nothing
> else*. A platform operator's grant lets an employee run an HQ area *without ever
> seeing a customer's money*. A `SYSTEM_ADMIN` is break-glass emergency power,
> guarded by mandatory 2FA. Below those three axes sits a fourth, orthogonal
> dimension — **per-account visibility tiers** (§Customer visibility) — that decides
> how much of a *shared* account another Space member may see. If you are adding a
> route, an API, or a surface, the one question to answer is *which axis am I on*,
> and enforce it in code (never by hiding UI — §Where authorization happens).

---

## The rule, stated once

Fourth Meridian has **three independent authorization axes**. They are separate models, separate policy modules, and separate adapters. A grant on one axis confers **zero** authority on the others. Do not add a fourth path, and do not let any axis import another's authority.

```
Fourth Meridian
│
├─ Customer access          SpaceMember          → a customer Space's financial/product data
│
├─ Operator access          PlatformGrant        → a Fourth Meridian HQ area (read/act on the platform)
│
└─ Emergency access         User.role = SYSTEM_ADMIN → break-glass administration of the platform
```

| Axis | Model | Enum(s) | Controls | Gated by |
|---|---|---|---|---|
| **Customer** | `SpaceMember` (per user × Space) | `SpaceMemberRole {OWNER, ADMIN, MEMBER, VIEWER}`, status `ACTIVE\|REMOVED\|LEFT` | Access to a **customer Space's** balances, transactions, goals, AI, sharing | `requireSpaceRole(spaceId, minRole)` → `spaceMember` lookup (`lib/session.ts`, `lib/spaces/policy.ts`) |
| **Operator** | `PlatformGrant` (per user × area) | `PlatformArea {PLATFORM_OPS, SECURITY_OPS, GROWTH_REVENUE, CUSTOMER_SUCCESS}` × `PlatformAccessLevel {READ, WRITE}`, status `ACTIVE\|REVOKED` | Access to a **Fourth Meridian HQ** area at `/dashboard/platform/[area]` and its `/api/platform/*` routes | `requirePlatformAccess(area, level)` → `hasPlatformAccess` pure policy (`lib/platform/authorize.ts`, `lib/platform/policy.ts`) |
| **Emergency** | `User.role` | `UserRole {USER, SYSTEM_ADMIN}` | Break-glass administration at `/admin/*`: issue/revoke grants, user & space oversight, security settings, audit | `requireSystemAdmin` / `requireFreshSystemAdmin` (`lib/session.ts`) |

### Why they are separate — and must stay so

- **A `PlatformGrant` never creates a `SpaceMember` row, and vice-versa** (schema comment on `PlatformGrant`; enforced by the `spaceMember.create` tripwire in `lib/platform-surface.test.ts`). Holding operator access to `SECURITY_OPS` gives an employee **no** ability to read any customer's money; being a customer Space OWNER gives **no** platform power.
- **The platform surface reads only operational ledgers** (`AuditLog`, `JobRun`, `ApiUsageCounter`, `UserSession`, `FxRate`, `BetaAccessRequest`, `SyncIssue`, `PlatformGrant`) — **never** `Transaction`/`Holding`/`Position`/balance tables. Locked by source-scan (`lib/platform-surface.test.ts`).
- **Escalation is closed:** only `SYSTEM_ADMIN` can mint `PlatformGrant` rows, and only onto `role === USER` accounts. No platform capability can mint platform capabilities.
- **`SYSTEM_ADMIN` is break-glass, not a daily role.** It carries an unconditional bypass over every platform area (`decidePlatformAccess`), so it is the highest-value credential in the system and is treated accordingly (mandatory MFA below; kill switch `DISABLE_SYSTEM_ADMIN`; every admin action audited with `performedByAdminId`).

The employee/operator tier is expressed **today** as a normal `USER` account + one or more per-area `PlatformGrant`s — least-privilege, with zero customer-data reach and no new role enum required.

---

## Mandatory MFA for SYSTEM_ADMIN (PO-1)

**Invariant: there is no password-only path to admin power.**

- An **un-enrolled** `SYSTEM_ADMIN` is **always** forced into TOTP enrolment at login (`requireTotpSetup = true`), **independent of the `REQUIRE_TOTP_*` platform settings**. That session is rejected by every guard via `totpSetupPending()` (`lib/session.ts`, `lib/platform/authorize.ts`) and confined by `proxy.ts` to `/admin/security?setup2fa=true` — it can complete enrolment and reach nothing else.
- An **enrolled** `SYSTEM_ADMIN` is challenged for a live TOTP or recovery code on **every** login (the enforcement block in `lib/auth.ts` `authorize()`).
- The decision rule is pure and unit-tested: `requiresTotpEnrollment()` in `lib/auth-totp-policy.ts` (tests in `lib/auth-totp-policy.test.ts`; wiring locked by `lib/security-surface.test.ts` §5).

**Customer authentication is unchanged.** A normal `USER` is forced into enrolment only when the operator turns on `require_totp_all_users` (default off) — exactly as before PO-1. The `REQUIRE_TOTP_*` settings remain the opt-in toggle for ordinary users; they are simply no longer the gate for admins.

**Bootstrap (no lockout):** the first login of a new/never-enrolled admin is password-only *into the enrolment flow only* — a session with zero capability. They enrol via `/api/user/totp/*` (which opt out of the gate with `allowTotpSetupPending: true`), and every subsequent login is password + TOTP. This is mandatory 2FA enrolment, the industry-standard pattern, chosen over outright denial specifically so the sole founder-admin can never be locked out.

---

## The `DISABLE_SYSTEM_ADMIN` kill switch — persistent role vs. effective emergency access (V25-FINAL-2)

**Invariant: `DISABLE_SYSTEM_ADMIN` withdraws effective emergency access at runtime without touching the persistent identity — and it binds already-issued sessions.**

Two distinct things must not be conflated on the Emergency axis:

- **`User.role === SYSTEM_ADMIN` is persistent identity/role state.** It is who the account *is*, stored in the database and carried in the JWT.
- **`DISABLE_SYSTEM_ADMIN` (env, `env.isSystemAdminDisabled`) is a runtime control over whether that role has *effective* emergency access right now.** It is a piece of environment/runtime configuration, not identity.

Enabling the switch does **not** mutate the user's stored role, demote the account, or rewrite the persistent identity. Instead, the **canonical emergency-access authorization seam evaluates the kill switch on every protected request**: the pure rule `decideAdminApiAccess()` (`lib/admin-totp-enrollment.ts`) takes a `systemAdminDisabled` input and returns `FORBIDDEN_DISABLED`; both `requireSystemAdmin()` and `requireFreshSystemAdmin()` (`lib/session.ts`) feed it `env.isSystemAdminDisabled` through the single `adminApiAccess()` seam, and the `/admin/*` page shell (`app/admin/layout.tsx`) redirects on the same getter. Because the flag is read **at request time — not at login** — an **already-issued `SYSTEM_ADMIN` session loses effective emergency access the moment the switch is enabled**; refreshing the JWT does not restore it (the role in the token is unchanged and irrelevant to the runtime decision). Login is also refused while the switch is on (`lib/auth.ts` `authorize()`), so both new and existing sessions are covered.

The decision order is deliberate — role → kill switch → forced-enrolment — so a non-admin still resolves to `FORBIDDEN_ROLE` (learns nothing), and the emergency lockout cannot be evaded through enrolment state. **Disabling the switch restores eligibility subject to the normal `SYSTEM_ADMIN` requirements** — mandatory MFA/TOTP (above) and the `requireFreshSystemAdmin` live-revocation/freshness rules — none of which the switch weakens.

**Axis isolation holds:** `DISABLE_SYSTEM_ADMIN` acts only on the Emergency axis. It does **not** affect `PlatformGrant`/operator authorization (the Operator axis) or ordinary customer access (the Customer axis); those are separate policy modules and are untouched by the kill switch.

---

## Operator audit foundation (PO-1)

**Decision: `AuditLog` IS the audit foundation — extended, not duplicated.** No second table or parallel event store was introduced (that would duplicate the platform's strongest primitive: append-only, `SET NULL`-on-delete, indexed on `(action, createdAt)`, `performedByAdminId` for on-behalf actions). The required operator-audit fields map onto the existing model:

| Required field | AuditLog storage |
|---|---|
| actor | `userId` (null for anonymous/pre-account) |
| actor type | `metadata.actorType` — `USER \| SYSTEM_ADMIN \| PLATFORM_OPERATOR \| SYSTEM` |
| action | `action` — typed `AuditAction` vocabulary (`lib/audit-actions.ts`) |
| target | `metadata.target` — `{ type, id }`, domain-neutral |
| timestamp | `createdAt` (DB default `now()`) |
| result | `metadata.result` — `SUCCESS \| FAILURE` |
| metadata | `metadata` — counts/ids/kinds only; **never** financial values or user content |
| (on-behalf-of) | `performedByAdminId` — dedicated column, unchanged |

The shape is codified in `lib/audit.ts`: `buildAuditData()` (pure, unit-tested in `lib/audit.test.ts`) and `recordAuditEvent(input, client?)` (adapter, accepts a `$transaction` client). The successful-login event now records the second factor used (`metadata.mfa = "totp" | "recovery" | "none"`) so an admin login reads honestly as *"TOTP verified"*. Failed logins remain captured by the purpose-built `LOGIN_FAILED` + `{ reason }` recorder (with inline anomaly detection).

Future PO slices (per-connection resync, membership actions, etc.) emit through this one shape, so the operator audit feed is uniform from birth. `action` stays `LOGIN` (not `LOGIN_SUCCESS`) to preserve the existing security-history/activity allowlists — success vs failure is carried by `result` + the `LOGIN` / `LOGIN_FAILED` action split.

---

## Customer visibility — the fourth, orthogonal dimension

*(Full authority: [Financial Truth Spine §10](./FINANCIAL_TRUTH_SPINE.md) — the visibility ladder. Summarised here because it completes the customer axis.)*

Space membership decides *whether* a user is in a Space; **account visibility decides
how much of a shared account they see.** A `SpaceAccountLink` grants one account into
a Space at a `VisibilityLevel`:

| Level | Exposes | Never exposes |
|---|---|---|
| **`FULL`** | transaction rows, merchants, amounts, investment positions | — |
| **`BALANCE_ONLY`** | the balance total | any row, merchant, or holding line |
| **`SUMMARY_ONLY`** | a qualitative summary | any raw number, row, or holding |
| **`PRIVATE`** | nothing | everything |
| legacy `SHARED` | dormant — **fails closed** (over-redacts) | — |

**One predicate, no second definition.** `TRANSACTION_DETAIL_VISIBILITY = [FULL]`
(`lib/ai/visibility.ts`) is the sole source of truth for "may this link expose
detail," read via `grantsTransactionDetail` / `grantsAccountDetail`. Every read path
— the UI list loaders (`lib/data/transactions.ts`), the account-detail modal, the
`getCurrentPositions` seam, and every AI assembler — filters on it. Filtering stays
**server-side** and **fails closed**: absence of a grant is exclusion. A transfer's
resolved meaning is a *(row, viewer)* fact — the same row reads "Internal transfer"
for a viewer who can see both legs and "needs classification" for one who cannot.

---

## Where authorization happens — and why hiding UI is not security

- **Authorization is enforced at the API / route-handler layer**, in `lib/session.ts`
  (`requireSpaceRole`, `requireSystemAdmin`, `requireFreshSystemAdmin`) and
  `lib/platform/authorize.ts` (`requirePlatformAccess`) — and, for data, in the
  server loaders that apply the visibility predicate. **`proxy.ts` is only the *edge*
  session/redirect chokepoint** (it matches `/dashboard/*` and `/admin/*`, redirects
  by role, and enforces the forced-2FA funnel); it explicitly **does not run for
  `/api/*`**, so it is never the authorization boundary for data.
- **Hiding a control in the UI is not security.** A workspace that "isn't rendered"
  for a role still has its API reachable; the guard that matters is the one on the
  handler. Every privileged read and write is gated in code, server-side, and — for
  platform ops and admin — **audited append-only** (`AuditLog`, with
  `performedByAdminId` for on-behalf actions). If a new capability's only protection
  is that its button is hidden, it is unprotected.
- **The three axes never import one another's authority.** A `PlatformGrant` never
  mints a `SpaceMember` row (and vice-versa); the platform surface reads only
  operational ledgers, never customer money tables; escalation is closed (only
  `SYSTEM_ADMIN` mints grants, only onto plain `USER` accounts). These are guarded by
  source-scan tests, not convention.

**Customer vs Operator vs Emergency, in one line each:** *Customer* = "I can see my
own (or my household's) money." *Operator* = "I can run an HQ area of the platform,
and I cannot see any customer's money." *Emergency* = "I am break-glass admin,
mandatory-2FA, every action audited, and I should almost never be used."

---

## What the foundation deliberately did NOT build (yet)

Deferred to later platform-ops work: user-management UI, space-management UI,
connection-resync / job-retry actions, `/admin` → Platform HQ migration, new operator
**write** APIs (the `requireFreshPlatformAccess` gate exists ahead of its first use —
no operator write action has shipped), per-action step-up re-auth, and any employee
role tier beyond `USER` + `PlatformGrant`. The security *foundation* those
capabilities require is complete; the capabilities themselves are v2.6+.

---

*Related: [SPACE_ARCHITECTURE](./SPACE_ARCHITECTURE.md) (internal HQ Spaces are real,
built, PlatformGrant-gated Spaces with zero members) · [operations/admin-operations](../operations/admin-operations.md)
(the admin console + TOTP enrolment runbook) · [decisions/ADR-003-visibility-model](../decisions/ADR-003-visibility-model.md).*
