> **CHECKLIST ONLY — no implementation, no route migration, no schema, no UI.** This document specifies the SP-2a slice; code lands in a separate step after this checklist is approved. Companion investigation: `docs/investigations/SPACES_EXECUTION_PLAN_2026-07-04.md`. Runs in parallel with FlowType P5 (disjoint file set).

# SP-2a — Centralized Space Policy Module — Implementation Checklist

**Slice goal:** land a pure, tested `can(action, ctx)` policy module as the single home for Space role + lifecycle authorization decisions. **Additive, zero callers.** No route touches it in this slice.

**Files in scope (exactly two, both new):**

- `lib/spaces/policy.ts`
- `lib/spaces/policy.test.ts`

**Everything else is out of scope:** no edits to `lib/session.ts`, `lib/space.ts`, `lib/ai/visibility.ts`, any route, any component, any schema, or FlowType/transaction/AI/Daily Brief/Atlas surfaces.

---

## 1. Impact map

| Dimension | Effect |
|---|---|
| New files | `lib/spaces/policy.ts`, `lib/spaces/policy.test.ts` |
| Modified files | **None** |
| Schema / migration | **None** |
| Routes changed | **None** (zero callers by design) |
| UI changed | **None** |
| Imports *into* the new module | None at runtime. `SpaceMemberRole` / `SpaceMemberStatus` / `SpaceType` type-only imports from `@prisma/client`. No `db`, no `next-auth`, no React. |
| Imports *of* the new module | **Zero** — verified by grep as an acceptance gate (see §8). |
| Blast radius | Nil. Nothing in the running app references `policy.ts`; behavior is byte-identical pre/post. |
| FlowType P5 interaction | None. FlowType owns `lib/transactions/*`, `lib/plaid/syncTransactions.ts`, `app/api/accounts/[id]/import/route.ts`, `app/api/ai/chat/route.ts`, `Transaction` schema — disjoint from `lib/spaces/*`. |
| Purity | `can()` is a pure function of its arguments — no I/O, no session, no DB. Deterministic and fully unit-testable. |

---

## 2. Final `SpaceAction` union

Grounded one-to-one in existing route gates. Kept semantically distinct (not collapsed) so authorization stays auditable per real operation — the whole point of the module.

```
type SpaceAction =
  // Space lifecycle
  | "space:read"
  | "space:edit"              // name / description / isPublic / category
  | "space:archive"           // set/clear archivedAt
  | "space:delete"            // move to trash (deletedAt)
  | "space:deletePermanent"   // permanent removal
  // Membership
  | "member:invite"
  | "member:manageRoles"      // change another member's role
  | "member:remove"           // remove another member (self-leave is a route residual — see §4)
  // Sections
  | "section:read"
  | "section:edit"
  // Goals
  | "goal:read"
  | "goal:edit"               // create / update / delete goal
  | "goal:checkIn"            // HABIT check-in
  // Accounts (Space-account links)
  | "account:read"
  | "account:share"           // + ownership residual (see §4)
  | "account:revoke"          // + adder residual (see §4)
  // Read surfaces
  | "snapshot:read"
  | "transaction:read"
  | "activity:read"
  | "perspective:read";
```

**Context type:**

```
interface SpacePolicyContext {
  role:      SpaceMemberRole;   // OWNER | ADMIN | MEMBER | VIEWER
  status:    SpaceMemberStatus; // ACTIVE | REMOVED | LEFT
  spaceType: SpaceType;         // PERSONAL | SHARED
}
```

`can()` decides purely from `{ role, status, spaceType }`. It answers the **member path only** — the public-Space read exception (`GET /api/spaces/[id]` allows non-members when `isPublic`) is a route-level `OR` over a *non-member* request that has no membership context, so it is deliberately **not** modeled in `can()` (documented for Slice 2).

---

## 3. Exact `can(action, ctx)` truth table

**Global gate:** `status !== ACTIVE` ⇒ **false for every action**, including all reads. (Every current route enforces `status === "ACTIVE"`; REMOVED/LEFT are fully denied. This pins the privacy-gap leak class.)

Given `status === ACTIVE`, the decision is a minimum-role gate plus the PERSONAL lifecycle block. Role rank: `VIEWER(0) < MEMBER(1) < ADMIN(2) < OWNER(3)`.

| Action | Min role | SHARED only? | Source of truth (route) |
|---|---|---|---|
| `space:read` | VIEWER | no | `GET /[id]` (active member; public handled at route) |
| `space:edit` | ADMIN | no | `PATCH /[id]` base gate `requireSpaceRole(ADMIN)` |
| `space:archive` | OWNER | **yes** | `PATCH /[id]` archive branch (OWNER; PERSONAL blocked `:88`) |
| `space:delete` | OWNER | **yes** | `DELETE /[id]` (OWNER; PERSONAL blocked `:139`) |
| `space:deletePermanent` | OWNER | **yes** | `permanent/route.ts` (OWNER; PERSONAL blocked `:52`) |
| `member:invite` | ADMIN | no | `invite/route.ts` `requireSpaceRole(ADMIN)` |
| `member:manageRoles` | OWNER | no | `members/[userId]` PATCH `requireSpaceRole(OWNER)` |
| `member:remove` | ADMIN | no | `members/[userId]` DELETE (privileged = OWNER/ADMIN; self residual §4) |
| `section:read` | VIEWER | no | `sections/route.ts` GET (active member) |
| `section:edit` | ADMIN | no | `sections/[sectionId]` `["OWNER","ADMIN"]` |
| `goal:read` | VIEWER | no | `goals/route.ts` GET `requireSpaceRole()` default VIEWER |
| `goal:edit` | ADMIN | no | `goals` POST + `goals/[goalId]` PATCH/DELETE `requireSpaceRole(ADMIN)` |
| `goal:checkIn` | VIEWER | no | `goals/[goalId]/check-in` (active member) |
| `account:read` | VIEWER | no | `accounts/route.ts` `requireSpaceRole(VIEWER)` |
| `account:share` | VIEWER | no | `accounts/share` POST (active member; ownership residual §4) |
| `account:revoke` | ADMIN | no | `accounts/share` DELETE privileged branch (adder residual §4) |
| `snapshot:read` | VIEWER | no | `snapshots/route.ts` `requireSpaceRole(VIEWER)` |
| `transaction:read` | VIEWER | no | `transactions/route.ts` `requireSpaceRole(VIEWER)` |
| `activity:read` | VIEWER | no | `activity/route.ts` (active member) |
| `perspective:read` | VIEWER | no | `perspectives/route.ts` (active member) |

**PERSONAL lifecycle rule:** for `space:archive` / `space:delete` / `space:deletePermanent`, `spaceType === "PERSONAL"` ⇒ **false regardless of role** (even OWNER). This is the only spaceType-dependent rule; no other action is gated on PERSONAL, because no other such gate exists in the current code (grounding discipline — we mirror, not invent).

**Decision function (spec):**

```
can(action, { role, status, spaceType }):
  if status !== ACTIVE: return false
  if action in {space:archive, space:delete, space:deletePermanent}
       and spaceType === PERSONAL: return false
  return rank(role) >= MIN_ROLE[action]
```

---

## 4. How the harder cases are handled

- **OWNER / ADMIN / MEMBER / VIEWER** — pure min-role rank per §3. MEMBER has no write privileges beyond VIEWER in the current routes except the "any active member" actions (share, check-in, reads); it is *not* granted `space:edit`/`section:edit`/`goal:edit` (those are ADMIN+). The table encodes exactly today's behavior.
- **ACTIVE / REMOVED / LEFT** — the global gate: REMOVED and LEFT return false for **everything**. No read leaks to a departed member. This is a pinned leak case (§6).
- **PERSONAL vs SHARED** — only the three lifecycle actions differ (PERSONAL ⇒ false). All other actions are spaceType-agnostic, matching current code.
- **archive / delete restrictions** — OWNER-only + SHARED-only + PERSONAL-blocked, all inside `can()`. The *additional* route-level guards that are **stateful** (e.g. "cannot archive while trashed," "already in trash") stay in the routes; they are data-state checks, not role/lifecycle decisions, and are explicitly **out of `can()`'s scope** (documented for Slice 2 so nothing is silently dropped).
- **section edit** — `section:edit` = ADMIN+. `section:read` = any active member.
- **account share / revoke** — `can("account:share")` = any active member (role part). The **ownership residual** (`fa.ownerUserId === caller`) is a resource-relationship predicate `can()` cannot see from `{role,status,spaceType}`; routes AND it in (Slice 2). `can("account:revoke")` returns the **privileged branch** (OWNER/ADMIN ⇒ true); the **adder residual** (`link.addedByUserId === caller` ⇒ also allowed) is OR-ed in by the route (Slice 2).
- **member invite / manage** — `member:invite` = ADMIN+; `member:manageRoles` = OWNER-only. Residuals for manage/remove that `can()` does **not** own: target-is-OWNER protection, target-must-be-ACTIVE, promotable-role validation, and **self-leave** (any active member may remove *themselves* — an OR the route applies). These are relationship/target-state checks, listed here so Slice 2 preserves them.
- **goal edit** — `goal:edit` = ADMIN+ (create, update, delete). `goal:checkIn` = any active member. `goal:read` = any active member.

**Residual predicates (NOT in `can()`, carried to Slice 2 route migration):**

| Action | Residual the route must still apply |
|---|---|
| `account:share` | AND caller owns the FinancialAccount |
| `account:revoke` | OR caller is `link.addedByUserId` |
| `member:manageRoles` | AND target ≠ OWNER; target ACTIVE; new role ∈ {ADMIN, MEMBER, VIEWER} |
| `member:remove` | OR `isSelf`; AND cannot remove OWNER unless self |
| `space:archive/delete` | AND data-state guards (not-trashed / not-already-trashed) |
| `space:read` | OR `space.isPublic` for non-members |

Capturing these now guarantees the Slice 2 migration is a faithful refactor, not a behavior change.

---

## 5. Design decisions on the two open questions

**Q4 — Visibility helpers: reference later, do NOT wrap in SP-2a.** `lib/ai/visibility.ts` (`grantsTransactionDetail`, `grantsAccountDetail`) stays untouched and is **not imported** by `policy.ts` in this slice. Wrapping it now would (a) create a dependency edge before any caller needs role+visibility composed, and (b) widen the slice past "role/lifecycle only." Recommendation: policy.ts owns role+lifecycle; visibility composition is added in a later slice when a concrete route needs both, at which point a `canSeeAccountDetail`/`canSeeTransactionDetail` re-export can join the module. (This intentionally tightens the earlier SPACES_EXECUTION_PLAN sketch, which floated composing them in Slice 1.)

**Q5 — `requireSpaceAction` is NOT in this slice.** It requires `getServerSession` + `db.spaceMember.findUnique` — impure, integration-tested, and it implies route wiring, which contradicts "zero callers, additive only." It is the **first deliverable of Slice 2 (SP-2b)**, built as a thin adapter over the existing `requireSpaceRole` resolver + `can()`. Keeping SP-2a to the pure predicate is what makes its rollback trivial and its tests DB-free.

---

## 6. Test matrix and pinned historical leak cases

**File:** `lib/spaces/policy.test.ts`.

**A. Full-matrix oracle test.** Iterate the Cartesian product `4 roles × 3 statuses × 2 spaceTypes × 20 actions = 480 combinations`. Assert `can(action, ctx)` equals an inlined **expected matrix** (the §3 table encoded as data — an independent oracle, not a re-call of the implementation). This catches any drift between spec and code in one deterministic pass.

**B. Named leak / invariant cases (explicit, human-readable — pin the four-times-recurring failure class):**

1. **Departed member sees nothing.** `status ∈ {REMOVED, LEFT}` ⇒ `can(x)` is false for **every** action, including all `*:read`. (Privacy-gap class.)
2. **PERSONAL Space is undeletable by its owner.** `{OWNER, ACTIVE, PERSONAL}` ⇒ false for `space:archive`, `space:delete`, `space:deletePermanent`; but true for `space:read`/`space:edit`. (The stringly-typed guard, now structural.)
3. **ADMIN cannot archive/delete.** `{ADMIN, ACTIVE, SHARED}` ⇒ false for `space:archive`/`space:delete`/`space:deletePermanent` (OWNER-only), true for `space:edit`.
4. **VIEWER is read-only.** `{VIEWER, ACTIVE, *}` ⇒ true for every `*:read` + `goal:checkIn` + `account:share`(role part); false for `space:edit`, `section:edit`, `goal:edit`, `member:*`, `account:revoke`.
5. **Only OWNER manages roles.** `{ADMIN, ACTIVE, SHARED}` ⇒ false for `member:manageRoles`; `{OWNER, ...}` ⇒ true.
6. **MEMBER cannot edit config.** `{MEMBER, ACTIVE, SHARED}` ⇒ false for `section:edit`, `goal:edit`, `space:edit`; true for `section:read`, `goal:checkIn`, `account:share`.
7. **Determinism.** Same args ⇒ same result across repeated calls (guards against accidental impurity).
8. **Exhaustiveness.** A compile-time `assertNever` over `SpaceAction` in the implementation's switch, plus a test asserting every union member appears in the expected matrix (no action silently unhandled).

**C. Residual-boundary documentation test (optional but recommended):** a test that asserts `can("account:revoke", {MEMBER,ACTIVE,SHARED})` is false — encoding that the *adder-can-revoke* path is deliberately a route residual, not `can()`'s job — so a future reader can't mistake the omission for a bug.

---

## 7. Rollback plan

Delete `lib/spaces/policy.ts` and `lib/spaces/policy.test.ts`. Nothing imports them (acceptance gate §8), so removal is zero-impact and requires no revert of any other file, no data change, and no migration. Partial states are safe: even a half-written module affects nothing until Slice 2 wires a caller.

---

## 8. Validation checklist

Run in order; all must pass before the slice is considered done:

- [ ] `npx prisma generate` — sanity only (no schema change); confirms enum type imports resolve.
- [ ] `npx tsc --noEmit` — clean; `assertNever` proves the `SpaceAction` switch is exhaustive.
- [ ] `npm run lint` — clean on both new files.
- [ ] `npm test lib/spaces/policy.test.ts` — full 480-combo matrix green + all named leak cases (§6) green.
- [ ] **Zero-caller gate:** `grep -rn "spaces/policy" app lib components` returns only the test file — proves additive/zero-caller.
- [ ] **Behavior-unchanged gate:** confirm no existing file was modified (`git diff --name-only` lists only the two new paths).

---

## 9. Implementation order (when approved to build)

1. Encode the **expected matrix** (§3) as a data table — this is the spec artifact and the test oracle; write it first.
2. Define `SpaceAction`, `SpacePolicyContext`, and the role-rank constant in `policy.ts` (policy.ts becomes the canonical role-order home; `session.ts`/`derivePermissions` consolidation is deferred to a later slice — no edit here).
3. Implement `can()` to satisfy the matrix, with `assertNever` exhaustiveness.
4. Write `policy.test.ts`: matrix oracle test + named leak cases + determinism/exhaustiveness.
5. Run the §8 validation checklist.
6. Run the zero-caller and behavior-unchanged gates.

---

## 10. Final recommendation

Proceed with SP-2a exactly as scoped: a **pure `can(action, ctx)`** over `{ role, status, spaceType }`, two new files, zero callers. **Defer** `requireSpaceAction` and any visibility wrapping to Slice 2 (SP-2b). **Document** — but do not implement — the residual relationship predicates (§4) so the later route migration is a faithful, behavior-preserving refactor. The full 20-action union and the 480-combination truth table above are ready to become the module and its test verbatim; nothing here changes runtime behavior, and rollback is deletion of two files.

**Stop point:** this checklist. Await approval before writing `lib/spaces/policy.ts`.
