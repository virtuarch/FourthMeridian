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
| **Operator** | `PlatformGrant` (per user × area) | `PlatformArea {PLATFORM_OPS, SECURITY_OPS, GROWTH_REVENUE, CUSTOMER_SUCCESS, MERCHANT_OPS}` × `PlatformAccessLevel {READ, WRITE, CONTROL}`, status `ACTIVE\|REVOKED` | Access to a **Fourth Meridian HQ** area at `/dashboard/platform/[area]` and its `/api/platform/*` routes (MERCHANT_OPS: `/merchant-ops` + `/api/merchant-ops/*`) | `requirePlatformAccess(area, level)` → `hasPlatformAccess` pure policy (`lib/platform/authorize.ts`, `lib/platform/policy.ts`) |
| **Emergency** | `User.role` | `UserRole {USER, SYSTEM_ADMIN}` | Break-glass administration at `/admin/*`: issue/revoke grants, user & space oversight, security settings, audit | `requireSystemAdmin` / `requireFreshSystemAdmin` (`lib/session.ts`) |

### Why they are separate — and must stay so

- **A `PlatformGrant` never creates a `SpaceMember` row, and vice-versa** (schema comment on `PlatformGrant`; enforced by the `spaceMember.create` tripwire in `lib/platform-surface.test.ts`). Holding operator access to `SECURITY_OPS` gives an employee **no** ability to read any customer's money; being a customer Space OWNER gives **no** platform power.
- **The platform surface reads only operational ledgers** (`AuditLog`, `JobRun`, `ApiUsageCounter`, `UserSession`, `FxRate`, `BetaAccessRequest`, `SyncIssue`, `PlatformGrant`) — **never** `Transaction`/`Holding`/`Position`/balance tables. Locked by source-scan (`lib/platform-surface.test.ts`). **One documented exception (owner ruling P-6, 2026-10-27):** Merchant Operations' merge review reads per-merchant transaction **counts** across tenants (`lib/transactions/merchant-merge-review.ts`) — counts only, never an amount, date, account or row.
- **Identity is area-scoped (owner ruling P-4, 2026-10-27).** Customer Success may resolve customer identity under its own grant; Platform Operations and Growth are identity-minimized (no customer names, emails or customer-chosen Space names on their surfaces — SEC-PLAT-2 removed the last Space-name list from Growth).
- **Escalation is closed:** only `SYSTEM_ADMIN` can mint `PlatformGrant` rows, and only onto `role === USER` accounts. No platform capability can mint platform capabilities.
- **`SYSTEM_ADMIN` is break-glass, not a daily role.** It carries a bypass over every platform area (`decidePlatformAccess`) — honoured only while the emergency-access rule allows it (kill switch off, TOTP enrolled; PLATFORM-SEC-1) — so it is the highest-value credential in the system and is treated accordingly (mandatory MFA below; kill switch `DISABLE_SYSTEM_ADMIN`; every admin action audited with `performedByAdminId`).

The employee/operator tier is expressed **today** as a normal `USER` account + one or more per-area `PlatformGrant`s — least-privilege, with no customer financial-data reach and no new role enum required.

**Every operator page and route goes through the one guard.** `requirePlatformAccess` / `requireFreshPlatformAccess` (`lib/platform/authorize.ts`) is the only grant check — including the `/dashboard/platform/[area]` page (SEC-PLAT-2; it previously read the grant itself and so skipped denial recording and the pending-enrolment gate). Every refusal is recorded (OBS-009, rate-limited). Every CONTROL check — reads included — is the fresh (live-revocation) variant. `/merchant-ops` is covered by `proxy.ts` like `/dashboard` and `/admin`.

**Operator MFA (SEC-PLAT-1) — implemented, rolled out per environment.** Owner ruling P-2: every ACTIVE grant holder must have TOTP. The shared Platform guard reads the grant and the holder's `totpEnabled` together on every request (so stale sessions, 2FA resets and newly issued grants are covered, and direct API calls are refused with `OPERATOR_TOTP_REQUIRED`); Platform pages redirect to the personal enrolment screen. An operator may still disable 2FA themselves (the lost-device path, with a recovery code) — Platform access is then refused until they enrol again. Enforcement is active only where `OPERATOR_TOTP_ENFORCEMENT=enforce` (Preview first; Production on an explicit rollout decision) — see `docs/plans/SEC-PLAT-1-OPERATOR-MFA-ROLLOUT-PLAN-2026-10-27.md`. Customer 2FA stays optional. The unenforced `require_totp_admins` setting is removed.

---

## The CONTROL capability (OPS-2D-2)

The Operator axis ranks **`CONTROL > WRITE > READ`** (`LEVEL_RANK`, `lib/platform/policy.ts`). The rank is the model; levels are never compared for equality.

**The distinction, in one line:**

> **WRITE** — do operational work *within* the platform's current behaviour.
> **CONTROL** — change what the platform's behaviour *is*.

"Resync this connection now" is WRITE: it asks for an occurrence of work the platform already performs on a schedule. "Stop syncing this connection" is CONTROL: afterwards the platform behaves differently until someone changes it back. The test is **not** blast radius and **not** reversibility — it is whether steady-state behaviour differs after the action.

**Why a rank above WRITE, and not a flag or a fold-in.** The ranking cuts one way only: `CONTROL` satisfies `WRITE` and `READ`; **`WRITE` does not satisfy `CONTROL`.** Had control-plane mutations been folded into WRITE, every operator holding WRITE today would silently acquire control-plane power the day the first control endpoint shipped. Because CONTROL ranks *above* WRITE, every existing grant keeps exactly the reach it has, and CONTROL has to be granted deliberately.

**Current state (2026-10-27).** CONTROL is issued and consumed:

| | Status |
|---|---|
| Declared in `PlatformAccessLevel` + migrated | ✅ |
| Ranked, exhaustive, distinct from WRITE | ✅ |
| Required by routes | ✅ — refresh cadence (`policies`), job cadence, AI cost controls, operational controls (maintenance mode), Plaid webhook roster / dry run / repoint — the exact set is pinned by `lib/platform/capability-control.test.ts` |
| Checked by UI | ✅ — `canControl` on the platform mount access |
| **Issuable** | ✅ — `ISSUABLE_LEVELS = ALL_ACCESS_LEVELS`; the admin matrix renders R / W / C per area |
| Refusals audited | ✅ — maintenance mode on `PLATFORM_POLICY_*` (REFUSED); the other CONTROL mutations on `PLATFORM_CONTROL_REFUSED` (SEC-PLAT-2: control, verb, closed-vocabulary target, refusal code, reason code — never a submitted value) |

*History (OPS-2D-2):* CONTROL was first introduced unconsumed and un-issuable, on the rule below. Nothing asks for CONTROL, and the admin matrix (`/admin/platform-access`) renders exactly two cells per area — so a CONTROL grant would confer no capability anyone requests while displaying as *no grant at all* in the operator's own UI. An unrenderable grant is worse than an absent one. **Whoever makes CONTROL issuable owes the admin matrix a third cell in the same change.**

**Escalation stays closed.** CONTROL does not, and must never, permit minting grants — a CONTROL holder who could issue grants would be a `SYSTEM_ADMIN` by another name. Grant administration remains `SYSTEM_ADMIN`-only.

**Classification, not enforcement.** Which mutation families *should* require CONTROL is recorded in `lib/platform/capability-classification.ts` — a typed, test-backed table that **no production module imports** (asserted structurally by `lib/platform/capability-control.test.ts`, so the question "is this enforced?" is settled by grep, not by trusting a comment). Two families are recorded as genuinely **UNRESOLVED** rather than guessed: platform-wide settings (registration mode, product status) and manual operations (Run Now / Dry Run) — both ship as WRITE today and both have a real argument for CONTROL. They are resolved deliberately, with the grant migration, not as a side effect.

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

Enabling the switch does **not** mutate the user's stored role, demote the account, or rewrite the persistent identity. Instead, the **canonical emergency-access authorization seam evaluates the kill switch on every protected request**: the pure rule `decideAdminApiAccess()` (`lib/admin-totp-enrollment.ts`) takes a `systemAdminDisabled` input and returns `FORBIDDEN_DISABLED`; both `requireSystemAdmin()` and `requireFreshSystemAdmin()` (`lib/session.ts`) feed it `env.isSystemAdminDisabled` through the single `adminApiAccess()` seam, and the `/admin/*` page shell (`app/admin/layout.tsx`) redirects on the same getter. Because the flag is read **at request time — not at login** — an **already-issued `SYSTEM_ADMIN` session loses effective emergency access the moment the switch is enabled**; refreshing the JWT does not restore it (the role in the token is unchanged and irrelevant to the runtime decision). Login is also refused while the switch is on (`lib/auth.ts` `authorize()`), so both new and existing sessions are covered. **Platform APIs (PLATFORM-SEC-1, 2026-10-30):** the SYSTEM_ADMIN break-glass bypass in `lib/platform/authorize.ts` applies the same `decideAdminApiAccess` rule (via `decideBreakGlass`) on every request; before this fix it returned before any check, so an already-issued session kept Platform API authority while the switch was on.

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
  by role, and enforces the forced-2FA funnel). For `/api/*` it runs **only** the
  browser-write Origin check (`lib/security/write-origin.ts`) and performs no
  authorization, so it is never the authorization boundary for data.
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

## Database-level tenant isolation (Row-Level Security)

**Status markers in this section:** **IMPLEMENTED** (verified in code / migrations) ·
**DECIDED BUT NOT IMPLEMENTED** · **PROPOSED** · **DEPRECATED**.
Operational procedures (migrations, backups, pooled connections) live in
[operations/database-safety.md](../operations/database-safety.md).

### Threat model and the rule

The customer axis above is enforced in application code. Without a database
boundary, tenancy rests on hand-written predicates composed correctly at every call
site: rows of `Transaction`, `Holding`, `PositionObservation`, `InvestmentEvent`,
`DebtProfile` and `ImportBatch` carry no tenant column and are scoped only through the
account → `SpaceAccountLink` → `SpaceMember` path, library functions accept a
`spaceId` as authority without re-verifying membership, and some routes load a row by
bare id before checking it. One missing predicate is a cross-tenant disclosure.

> **Rule.** Row-Level Security is a **backstop behind** the application's account and
> Space filters, never a replacement for them. A query that forgets its tenant
> predicate must return the caller's rows and nothing else — and the application's
> own `where` clauses stay, because RLS that rejects rows defeats `ORDER BY … LIMIT`
> short-circuiting (scan amplification ≈ 1 / visible fraction).

**RLS enforces tenancy only — IMPLEMENTED (owner decision).** Policies answer exactly
one question: *is this row in a Space this identity belongs to?* The visibility tier
(`SpaceAccountLink.visibilityLevel`, §Customer visibility) is a column-level redaction
and stays in application code (`lib/account-privacy.ts`, `lib/ai/visibility.ts`). A
policy that reproduced it would create two authorities for one question
(`prisma/migrations/20261002000100_rls_roles_and_policies/migration.sql` header).

**The security property needs all four parts — IMPLEMENTED.** A non-owner,
`NOBYPASSRLS` runtime role **+** `ENABLE ROW LEVEL SECURITY` **+** `FORCE ROW LEVEL
SECURITY` **+** policies. Any one missing makes the others a silent no-op (a table
owner is exempt unless `FORCE` is set; a `BYPASSRLS` role is exempt from everything).

### Database roles

| Role | Attributes | Used by | Subject to RLS | Status |
|---|---|---|---|---|
| **migration principal** (`postgres` on the hosted provider; the bootstrap superuser locally) | owns every table; `BYPASSRLS` (platform-managed, cannot be stripped) | `prisma migrate deploy` via `DIRECT_URL`; the legacy `db` client | **no** | IMPLEMENTED — ownership deliberately **unchanged**: reassigning it buys nothing while the owner keeps `BYPASSRLS`. What matters is that application runtime stops using it. |
| **`fm_app`** | `LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE`; not an owner; no `TRUNCATE`/`REFERENCES` | ordinary web requests, only through `withTenantDb()` (`DATABASE_URL_APP` → `tenantDb`, `lib/db.ts`) | **yes** | IMPLEMENTED |
| **`fm_auth`** | same attributes | the **pre-identity** surface only: credential lookup, session revocation check, recovery codes, registration/waitlist intake (`DATABASE_URL_AUTH` → `authDb`) | yes (permissive policies on exactly its tables) | IMPLEMENTED — grants derived from the measured pre-identity queries (`20261002000200_rls_auth_surface`, `20261002000600_rls_beta_access_request_seam`) |
| **`fm_system`** | same attributes | cron, webhooks, ingestion, operator consoles (`DATABASE_URL_SYSTEM` → `systemDb`) | yes — reaches rows through role-scoped `TO fm_system` policies, **not** `BYPASSRLS`, so every cross-tenant grant is visible in `pg_policies` | IMPLEMENTED |
| **`fm_backup`** | `LOGIN BYPASSRLS`, `SELECT` on every table (`BYPASSRLS` exempts from policies, not from grants) | `pg_dump` only; never in application runtime configuration | no — enumerated bypass | IMPLEMENTED |
| `fm_owner` (non-`BYPASSRLS` schema owner) | — | — | — | **DEPRECATED** proposal — superseded by "ownership unchanged" above |
| `fm_operator` (separate operator client) | — | — | — | **DEPRECATED** proposal — operator work uses `fm_system` (or, until converted, `db`; see the authority ratchet) |

Roles are created `WITH LOGIN` and **without a password** in migrations; each is inert
until an operator sets its secret out of band. No credential is ever committed.
Per-role statement timeouts: `fm_app` 15 s, `fm_auth` 5 s, `fm_system` 60 s; the
migration principal and `fm_backup` are untouched — IMPLEMENTED
(`20261022000700_db006_role_statement_timeouts`).

### Identity propagation — IMPLEMENTED (`lib/db/tenant-context.ts`)

- The request identity reaches Postgres as one transaction-local setting,
  `app.user_id`, set by `withTenantDb(userId, fn)` with
  `set_config('app.user_id', $1, true)` (bound parameter, never an interpolated
  `SET` string) together with a transaction-local
  `idle_in_transaction_session_timeout` of 15 s.
- **`SET LOCAL` semantics only.** The runtime connects through a transaction-mode
  pooler, which hands a server connection to the next client after every
  transaction; a session-level setting would leak one tenant's identity to the next.
  Transaction-local settings are discarded at `COMMIT` **and** `ROLLBACK`.
  Consequence: **every tenant-scoped access runs inside an interactive transaction.**
- The user id comes from **server-side authenticated session state only** — never a
  body, query string, header or the active-Space cookie. Space scope is not passed at
  all; policies derive it from `SpaceMember`.
- **An empty identity is refused in the application:** `withTenantDb` throws
  `TenantIdentityError` rather than run unidentified. In the database,
  `current_fm_user_id()` returns `NULL` when unset, so every policy denies (fail
  closed). *(The earlier proposal that the SQL helper itself raise when unset is
  **DEPRECATED** — the refusal lives in `withTenantDb`.)*
- Rejected alternatives (recorded): Supabase Auth / `auth.uid()` (identity is
  NextAuth; no JWT reaches Postgres over Prisma), a database role per tenant, and a
  connection per tenant.

### Policy model — IMPLEMENTED (`prisma/migrations/20261002000100_rls_roles_and_policies` and follow-ups)

Helper functions (all `STABLE`, `search_path` pinned): `current_fm_user_id()`;
`fm_visible_space_ids()` — the identity's **ACTIVE** memberships (`SECURITY DEFINER`,
parameterless and self-scoped, because `SpaceMember`'s own policy needs it and
`SECURITY INVOKER` would recurse); `fm_account_visible(text)`; `fm_may_join_space(text)`;
`fm_beta_request_is_intake`. `EXECUTE` is revoked from `PUBLIC` and granted only to
the roles whose policies evaluate them (`20261006000000_rls_function_execute_least_privilege`).

| Command | Clause | Rule |
|---|---|---|
| SELECT | `USING` | the tenancy predicate for the table's class (below) |
| INSERT | `WITH CHECK` | the tenancy predicate on the **new** row — this is what stops a cross-Space write |
| UPDATE | `USING` **and** `WITH CHECK` | visible pre-image **and** an in-scope post-image — a tenant key can never be moved outside the caller's visible set |
| DELETE | `USING` | membership rows and account links are never deleted (status flips), so `fm_app` has no DELETE on `SpaceMember` |

Table classes:

- **Direct `spaceId`** — `"spaceId" IN (SELECT fm_visible_space_ids())`. Membership
  status `ACTIVE` is load-bearing: membership rows are never deleted.
- **Space-scoped and user-private** (e.g. `SpaceMemory`, `DailyBrief`) — Space
  membership **and** `ownerUserId = current_fm_user_id()`; a shared household Space
  holds two people's private rows.
- **Account subtree** — a correlated `EXISTS` through `SpaceAccountLink` (ACTIVE),
  plus an **owner arm** so an archived account's owner still reaches its contents
  (`20261003000000_rls_account_subtree_owner_arm`). Do not flatten it to
  `financialAccountId IN (…)` — that defeats the ordered index scan.
- **No denormalised `Transaction.spaceId`** — an account is ACTIVE-linked into a *set*
  of Spaces; a single-valued column is a cardinality error, not a shortcut.
- **User-scoped** — `"userId" = current_fm_user_id()`. `User` itself: a user sees only
  themselves; co-member display identity is served by the application.
- **`Space`** — membership, plus a `PlatformGrant` arm for member-less platform Spaces.
- **`SpaceMember`** — reads limited to the caller's Spaces (closes the
  users-search roster oracle at the database). **Self-join is not a policy arm:**
  creating a Space and accepting an invitation go through `fm_may_join_space`
  (`20261002000400_rls_membership_bootstrap`).
- **`SpaceInvite`** — membership **or** `invitedUserId = current_fm_user_id()` (the
  invitee is not yet a member).
- **`AuditLog`** — append-only for `fm_app` (permissive INSERT, no UPDATE/DELETE);
  SELECT is `userId` **or** visible `spaceId`; operator reads via `fm_system`.
  `fm_system` still holds full UPDATE/DELETE under one `FOR ALL` policy. Narrowing it
  to the two retention writers (column grant + per-command policies) is **PLANNED**:
  [database-safety §4e](../operations/database-safety.md#4e-auditlog-append-only-at-the-database-db-010--priv-005--planned).
- **`PlatformGrant`** — `SELECT` only for `fm_app`; grants are minted by the admin
  surface, never by a tenant session (`20261022000500_sec014_platform_grant_read_only`).
- **`RateLimit`** — RLS on; `fm_app` reaches only its own `user:…:<userId>` buckets;
  `fm_auth`/`fm_system` all (`20261022000600_db004_rate_limit_rls`). *(The original
  "RateLimit left without RLS" exception is **DEPRECATED**.)*
- **Revoked from `fm_app` entirely** (operator forensic ledgers and deployment
  telemetry with deliberately soft references, plus `AiInvocation`, which is
  un-tenanted as a privacy decision): `AiInvocation`, `ApiUsageCounter`,
  `PlatformSetting`, `SyncIssue`, `SyncIssueOccurrence`, `JobRun`, `RefreshExecution`,
  `RefreshEndpointAccountCoverage`, `ProviderCall`, `RefreshEndpointResult`,
  `NotificationDelivery`, `ProviderCapabilityObservation`, `MerchantMergeDecision`.
  Revoking is stronger and simpler than a tenant policy that breaks when the observed
  parent is deleted. Later migrations may grant narrow reads (e.g.
  `20261002000300_rls_app_platform_settings`, `20261002000500_rls_app_sync_issue_read`).
- **Global reference data** (`Instrument`, `InstrumentAlias`, `PriceObservation`,
  `CorporateActionTerms`, `FxRate`, `Merchant`, `MerchantAlias`) — no tenant, no
  policy; `fm_app` may read, insert and update but not delete (merges are operator work). This is the closed exception
  list in `scripts/migration-rls-census.test.ts`.
- **Default privileges** — future tables are granted to nobody, and all access is
  revoked from the hosted provider's Data API roles (`anon`, `authenticated`,
  `service_role`). An unclassified table is unreachable rather than open.

**Every table ENABLEs and FORCEs RLS** except the closed reference-data list —
IMPLEMENTED and enforced without a database by `scripts/migration-rls-census.test.ts`,
and against a live database (as `fm_app`, not the superuser) by the CI
`rls:accept*` suites (`scripts/rls-acceptance.ts` and siblings, `.github/workflows/ci.yml`).
`FORCE` is a deliberate no-op against today's `BYPASSRLS` owner; it keeps the design
correct if ownership ever moves.

### Bypass inventory

Every principal that can read a protected row without satisfying a policy must be
named here:

1. The hosted provider's superuser and platform-managed `BYPASSRLS` roles (incl.
   `postgres`, `service_role`) — dashboard/SQL-editor access governed by provider
   account access + MFA; no grants on `public` for the Data API roles.
2. The **migration principal** (`db`) — still imported by part of the runtime; see the
   ratchet below.
3. **`fm_backup`** — `pg_dump` only; its credential lives in the owner's password
   manager, never in Vercel.
4. **`fm_system`** — cross-tenant through explicit role-scoped policies.
5. **`SECURITY DEFINER` functions** — `fm_visible_space_ids`, `fm_may_join_space`;
   each parameterless or self-scoped, `search_path` pinned, `EXECUTE` least-privilege.
6. **A wipe or a restore** — `DROP SCHEMA public CASCADE` (`scripts/db-wipe.ts`)
   leaves no RLS until migrations are re-applied; a restore must be verified with
   `rls:accept` before it is trusted ([database-safety §4c](../operations/database-safety.md)).

### Making "RLS is on" a claim the deployment must earn — IMPLEMENTED

- **Strict mode** (`lib/db/strict-mode.ts`): with `FM_RLS_STRICT=true`, a missing or
  unsafe role URL (`DATABASE_URL_APP`/`_AUTH`/`_SYSTEM`) is a **refusal to boot**, not
  a silent fallback to the migration principal; `verifyDbAuthorities()` asks each
  connection for `current_user`. On a Vercel **Production** deployment strict mode is
  mandatory (`productionRequiresStrict`). Outside strict mode the role clients fall
  back to `db`, visible through `activeDbRoles()`.
- **The authority ratchet** (`scripts/audit-db-authority.ts`): each role client may be
  imported only by the code that owns that authority (`authDb` is the sharpest); the
  set of runtime files importing `db`, defaulting a missing client to `db`, or calling
  such a default without an authority may **shrink but never grow**. Capabilities
  that legitimately need `systemDb` are listed **as files, not directories**.
- `lib/platform/db-authority.ts` reports the deployed posture to operators.

### The silent-refusal hazard — RULE, IMPLEMENTED (`lib/db/conditional-write.ts`, `lib/ai/absence.ts`)

Under a tenant role a policy refusal is not uniformly loud: `INSERT` refused by
`WITH CHECK` **raises**; `UPDATE`/`DELETE` refused by `USING` return **`{count: 0}`**;
`SELECT` returns an **empty set**. Postgres is behaving as specified; the defect is
code that reads the quiet result as a business answer.

**Writes.** *Inside a tenant phase, a zero-row `updateMany`/`deleteMany` is
indeterminate unless the row's visibility was already established in the same phase.
It may not be reported as a business outcome* (e.g. "somebody else got there first").
Use `resolveConditionalWrite(count, site, probe)`: on zero, probe visibility through
the **same client** (one indexed `count`, failure path only); visible ⇒ genuine
contention, invisible ⇒ `IndeterminateWriteError`. For bulk writes, count the
eligible rows first in the same phase and call
`assertEveryObservedRowWasWritten` — a partial (1-of-2) write looks exactly like
success and is the nastier form. Error payloads carry table, key and verb only, never
row contents. Converted sites include `lib/plaid/sync-lock.ts`,
`lib/platform-settings.ts`, `app/api/imports/[id]/rollback/route.ts`,
`jobs/retry-notifications.ts`, `lib/accounts/disconnect.ts`,
`lib/accounts/links-everywhere.ts`, `lib/platform/incidents/lifecycle.ts`.
**DECIDED BUT NOT IMPLEMENTED:** the Daily Brief lease claim
(`lib/ai/brief/store.ts` `claim`) still reads `count === 1` directly; it survives only
because its fallback is an `INSERT`, which raises.

**Reads.** *"I did not obtain evidence" is not "the evidence does not exist."* Every
table the AI surface reads is granted to `fm_app`, so no AI read can fail loudly — the
only failure mode is the silent empty set, which that surface would turn into
declarative English. `lib/ai/absence.ts` defines three states — `PRESENT`,
`PROVEN_EMPTY`, `INDETERMINATE` — with an absence oracle **derived from the client
that came back empty** (never a wider authority). Consumers include
`lib/ai/coverage-envelope.ts`, `lib/data/transaction-query.ts`
(`absence: 'PROVEN_EMPTY' | 'INDETERMINATE'`) and
`lib/ai/conversation/memory-tools.ts`. The distinguishing test: an empty-but-visible
Space says "none"; an empty-and-invisible Space says "indeterminate".

### Disconnect is deployment-wide — RULE, IMPLEMENTED (`lib/accounts/links-everywhere.ts`)

**Authority must follow the operation's true blast radius.** Disconnecting/archiving an
account revokes its `SpaceAccountLink` rows **in every Space** (including co-owners'
Spaces) and regenerates every affected Space's snapshot — a co-owner's ACTIVE link to
a soft-deleted account would be a dangling reference narrating a balance that no
longer syncs. `fm_app` cannot express this (the co-owner's link is invisible to the
actor), so:

1. Authorization happens **first, in the tenant phase**; the capability is only called
   with ids that phase already proved.
2. `revokeAccountLinksEverywhere` runs on `fm_system`, takes **already-authorized ids
   and returns counts, never rows**, and takes no `spaceId`/`userId` selector.
3. It is listed in `scripts/audit-db-authority.ts` **as a file**, so `lib/accounts/`
   does not become a `systemDb` neighbourhood.
4. The revoked count is asserted against the links observed — the partial-write rule
   above.

Not a hazard (recorded so it is not re-derived): the Plaid orphan gate
(`lib/plaid/disconnect.ts`) counts accurately under `fm_app`, because a `PlaidItem`
and every connection hanging off it belong to the single user who connected it.

### Residual risks — PROPOSED follow-ups

- Client IP for rate limits, audit and login is IMPLEMENTED in one extractor
  (`lib/security/client-ip.ts`). `CLIENT_IP_TRUST_CLOUDFLARE` is registered (`lib/env.ts`) and
  defaults off, so `cf-connecting-ip` is ignored. Turn it on only if Cloudflare fronts every
  Production request; the Production edge topology is an owner check, not yet recorded.
- Privacy items PRIV-007 / 008 / 009 / 016 (deletion with unconfirmed Plaid revocation, breach
  and global-revoke procedure, plaintext wallet descriptors, terms re-consent) are tracked with
  status in `docs/audits/pre-beta-2026-10/11-PRIVACY-COMPLIANCE.md`; counsel reviews
  (PRIV-010 / 011 / 012 / 013) in `docs/audits/pre-beta-2026-10/remediation/01-FINDINGS-REGISTER.md`.
- RLS protects rows, not JSON interiors: `SyncIssue*.detail`, `MerchantAlias.sample`,
  `InvestmentEvent.importedRaw`, `ImportBatch` error/decision payloads,
  `Notification` bodies, `AuditLog.metadata` can carry tenant content in operator
  tables; `Merchant`/`MerchantAlias` row existence is a cross-tenant inference channel.
- The Plaid webhook still resolves `item_id` on the migration principal
  (`app/api/plaid/webhook/route.ts`); a narrow `SECURITY DEFINER` resolver followed by
  a tenant phase was proposed and is not built.
- Merchant merge is a deployment-wide effect reachable from a narrower authorization
  and should be operator-only.

---

## Security checklist (release gate)

Walk before every Production promotion and every major release. Items are kept only
while they matter; a closed item states where it is enforced.

**Authentication**
- Passwords bcrypt cost 12 (`app/api/auth/register`, `reset-password`, `user/password`) — IMPLEMENTED.
- Password change requires the current password and a fresh-user check; other sessions revoked, alert sent, audited (`app/api/user/password/route.ts`) — IMPLEMENTED.
- Reset tokens: 32 random bytes, stored hashed, 1 h TTL, single-use; link built from the trusted app URL, never the request Host; non-enumerating request (`lib/password-reset-token.ts`) — IMPLEMENTED.
- Email verification consumed by POST only; login blocked until verified — IMPLEMENTED.
- Login rate limit **inside `authorize()`**, per identifier, fail-closed when the limiter store is unavailable; CAPTCHA step-up after repeated failures (`lib/auth.ts`, `lib/login-limits.ts`) — IMPLEMENTED.
- TOTP secrets encrypted with a per-purpose key; disabling 2FA claims the TOTP step so a captured code cannot be replayed (`app/api/user/totp/disable/route.ts`) — IMPLEMENTED. **Login-path one-time use** (SEC-012): login claims the matched step (`user:totp-login-step:<id>` unique per 30 s window in `RateLimit`), so the same code cannot sign in twice (`lib/auth.ts`; pinned in `app/api/auth/[...nextauth]/route.test.ts`) — IMPLEMENTED.
- Mandatory MFA for `SYSTEM_ADMIN` and operators — see §Mandatory MFA and SEC-PLAT-1 above.
- Registration / invite / email-change existence disclosure — accepted for closed beta; hardening PROPOSED before public beta.

**Sessions**
- NextAuth default cookies (`HttpOnly`, `SameSite=Lax`, `Secure` + `__Secure-` in production); verify flags on the live domain each release.
- Revocation re-checked against `UserSession`; sensitive actions use the fresh (uncached) guards; bulk revoke clears the cache (`lib/sessions.ts`) — IMPLEMENTED.
- `SYSTEM_ADMIN` role is re-read live by `requireFreshSystemAdmin` (`lib/session.ts`) — IMPLEMENTED. A shorter session lifetime for admins (JWT `maxAge` is 30 days for everyone, `lib/auth.ts`) — PROPOSED.

**Authorization** — the three axes and RLS above. Every new `[id]` route proves membership/ownership before returning data (release review). Export composes the visibility-enforcing readers only (`lib/export/assemble.ts`). `GET /api/users/search` authorizes the `exclude` Space via `requireSpaceAction` (`app/api/users/search/route.ts`) — IMPLEMENTED.

**Secrets**
- AES-256-GCM with HKDF per-purpose subkeys from one root `ENCRYPTION_KEY` (`lib/plaid/encryption.ts`) for Plaid tokens, TOTP seeds, date of birth and connection credentials — IMPLEMENTED.
- Key rotation runbook: [operations/key-rotation.md](../operations/key-rotation.md). The re-encryption script (`scripts/rotate-encryption-key.ts`) and a drill against a restored backup — DECIDED BUT NOT IMPLEMENTED.
- Production boot requires `CRON_SECRET`, app URLs, email key and error-monitoring DSN (`lib/env.ts` `PROD_REQUIRED_KEYS`) — IMPLEMENTED. Distinct `ENCRYPTION_KEY`, `NEXTAUTH_SECRET` and database per environment — verify each release.
- No secrets, tokens, reset/verify URLs or decrypted values in logs; clients get a generic 500 (`withApiHandler`).

**API**
- Rate limiting active by default in production (`lib/rate-limit.ts`; `RATE_LIMIT_ENABLED=false` is an emergency opt-out that `validateEnv` warns about) — IMPLEMENTED.
- Browser-write Origin boundary on state-changing `/api/**` requests, environment-local (`lib/security/write-origin.ts`, wired in `proxy.ts`) — IMPLEMENTED.
- Cron bearer secret compared with `timingSafeEqual` (`lib/security/cron-secret.ts`) — IMPLEMENTED.
- Per-user limits on external-cost Plaid endpoints — PROPOSED.

**Infrastructure**
- Security headers: HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, CSP **report-only** (`next.config.ts`) — IMPLEMENTED. Enforcing CSP — DECIDED BUT NOT IMPLEMENTED.
- Backups and restore drills — [operations/backup-restore-verification.md](../operations/backup-restore-verification.md).

**Privacy** — export and deletion compose visibility-enforcing readers; deletion is reversible-grace → irreversible purge with audit-before-delete and a hashed email on the anonymised row; `AuditLog.userId` is `SetNull`. An audit-retention window — PROPOSED.

**Per-Production-deploy confirmations (owner):** strict mode on and all three role
URLs set; `CRON_SECRET` set and crons firing; email domain SPF/DKIM/DMARC verified;
cookies and headers present on the live domain; no seed accounts; `npm audit` reviewed;
`DISABLE_SYSTEM_ADMIN` decision recorded; monitoring and alerting live.

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

---

*Sources consolidated (deleted; recover with `git log -- <path>`):*
`docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md` ·
`docs/plans/RLS-DISCONNECT-BLAST-RADIUS.md` ·
`docs/plans/RLS-SILENT-REFUSAL-CAS.md` ·
`docs/operations/security-checklist.md`.
