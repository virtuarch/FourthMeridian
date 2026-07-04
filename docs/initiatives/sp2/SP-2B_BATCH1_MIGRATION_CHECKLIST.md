> **CHECKLIST ONLY — no implementation, no schema/migration, no UI, no FlowType/transaction/AI/Daily Brief/Atlas work.** Specifies the first SP-2b route-migration batch. Builds on SP-2a (`lib/spaces/policy.ts`, pure `can()`, complete). Companion: `docs/initiatives/sp2/SP-2A_IMPLEMENTATION_CHECKLIST.md`, `docs/investigations/SPACES_EXECUTION_PLAN_2026-07-04.md`.

# SP-2b Batch 1 — Route Migration to `requireSpaceAction`

**Slice goal:** introduce the session-aware `requireSpaceAction` adapter and migrate the first, smallest safe batch of inline-check routes onto it — removing 4 hand-rolled `spaceMember.findUnique` authorization checks while preserving every 401/403/404 status code and all residual predicates.

**Batch (3 files, 4 handlers):**

- `app/api/spaces/[id]/sections/route.ts` (GET)
- `app/api/spaces/[id]/sections/[sectionId]/route.ts` (PATCH)
- `app/api/spaces/[id]/accounts/share/route.ts` (POST + DELETE)

---

## 1. `requireSpaceAction` — the adapter

### Where it lives

**New file `lib/spaces/authorize.ts` (`server-only`).** Not in `policy.ts` (must stay pure — no `db`, no session, unit-testable in isolation), and not in `lib/session.ts` (generic session auth; keeping the Space-policy adapter in `lib/spaces/` groups the authorization domain with `policy.ts`). It composes the two existing pieces rather than duplicating them.

### Contract (mirrors `requireSpaceRole`'s Go-style tuple)

```
import "server-only";
import { db }                 from "@/lib/db";
import { requireUser, forbidden, type SessionUser } from "@/lib/session";
import { can, type SpaceAction } from "./policy";

export type SpaceActionAuth = {
  user: SessionUser;
  membership: { role: SpaceMemberRole; status: SpaceMemberStatus; spaceType: SpaceType };
};

export async function requireSpaceAction(
  spaceId: string,
  action:  SpaceAction,
): Promise<[SpaceActionAuth, null] | [null, NextResponse]> {
  const [user, err] = await requireUser();          // 401 if no session
  if (err) return [null, err];

  const membership = await db.spaceMember.findUnique({
    where:  { spaceId_userId: { spaceId, userId: user.id } },
    select: { role: true, status: true, space: { select: { type: true } } },
  });

  if (
    !membership ||
    !can(action, {
      role:      membership.role,
      status:    membership.status,
      spaceType: membership.space.type,
    })
  ) {
    return [null, forbidden()];                       // 403 for non-member / inactive / role-too-low
  }

  return [{ user, membership: { role: membership.role, status: membership.status, spaceType: membership.space.type } }, null];
}
```

### How it reuses existing session/db lookup

- **Session:** reuses the already-exported `requireUser()` from `lib/session.ts` — same `getServerSession(authOptions)` path (with the per-request revocation check) that every route already runs. No new session logic.
- **Membership:** the same `db.spaceMember.findUnique({ where: { spaceId_userId } })` the inline checks use, plus a `space.select.type` join so lifecycle actions (`sharedOnly`) are decidable generally. (For this batch's four actions `sharedOnly` is false, so `spaceType` is unused — but the adapter is built general so future lifecycle-route migrations need no change.)
- **Decision:** delegates entirely to the pure `can(action, ctx)` from SP-2a. The adapter contributes I/O only; the *rule* stays in the tested module.

### How it preserves 401/403/404

- **401** — no session ⇒ `requireUser` returns `unauthorized()` (401); the adapter propagates it unchanged.
- **403** — not a member, `status !== ACTIVE`, or `can(...) === false` ⇒ `forbidden()` (403 `{error:"Forbidden"}`), matching the inline `{error:"Forbidden"}` 403. Non-existent space ⇒ null membership ⇒ 403 (current behavior — these routes never 404 on space existence; non-disclosure preserved).
- **404** — the adapter never emits 404. All 404s (section-not-found, account-not-found, share-not-found) are **resource** checks that remain route-local, unchanged.

### One observable delta to ratify (§ flagged)

`sections/[sectionId]` PATCH currently returns **two different 403 bodies**: `{error:"Forbidden"}` (non-member/inactive) and `{error:"Insufficient permissions"}` (role < ADMIN). A single `requireSpaceAction("section:edit")` collapses both to `{error:"Forbidden"}` (403). **Status code is unchanged (403→403); only the role-denial body string changes**, and it normalizes to match the 12 routes already using `requireSpaceRole`. Recommendation: **accept the normalization** (more consistent, marginally better for non-disclosure). If strict byte-preservation is required, add an optional `denyMessage` param to `requireSpaceAction` — noted as the fallback, not the default.

---

## 2. First route batch — per-route plan

### 2a. `sections/route.ts` — GET (list sections)

- **Current authz:** `requireUser` → inline `findUnique` → `403 {Forbidden}` if not ACTIVE member (any role passes).
- **Target action:** `requireSpaceAction(spaceId, "section:read")` (min VIEWER = any active member).
- **Residuals (route-local):** none. Pure list read after the gate.
- **Status codes to preserve:** 401 (no session), 403 (non-member/inactive), 200 (ordered sections). Response body of the 200 unchanged (`findMany` untouched).
- **Rollback:** revert this file to the inline `findUnique` + `SpaceMemberStatus` import.

### 2b. `sections/[sectionId]/route.ts` — PATCH (edit a section)

- **Current authz:** `requireUser` → inline `findUnique` → `403 {Forbidden}` if not ACTIVE → `403 {Insufficient permissions}` if role ∉ {OWNER,ADMIN} → `404 {Section not found}` if section's `spaceId !== spaceId`.
- **Target action:** `requireSpaceAction(spaceId, "section:edit")` (min ADMIN).
- **Residuals (route-local, KEEP):** the **section-belongs-to-space** existence check — `db.spaceDashboardSection.findUnique({ where:{id:sectionId}, select:{spaceId} })` and the `!existing || existing.spaceId !== spaceId ⇒ 404 {Section not found}`. This is a resource-scoping check `can()` cannot make. Also keep the body-field update logic verbatim.
- **Status codes to preserve:** 401; 403 (non-member/inactive/role<ADMIN — see body-string note §1); 404 (section not found or cross-space); 200 (updated row).
- **Rollback:** revert this file.

### 2c. `accounts/share/route.ts` — POST (share) + DELETE (revoke)

**POST (share an account into the space):**

- **Current authz:** `requireUser` → inline `findUnique` → `403 {Forbidden}` if not ACTIVE (any role) → `400` missing `financialAccountId` → `400` invalid `visibilityLevel` → account `findUnique` → `404 {Account not found}` if missing/deleted → `403 {You do not own this account}` if `fa.ownerUserId !== userId` → SAL upsert + audit + snapshot regen → `201 {ok}`.
- **Target action:** `requireSpaceAction(spaceId, "account:share")` (min VIEWER = active member — matches current door exactly).
- **Residuals (route-local, KEEP):** ownership check (`fa.ownerUserId !== userId ⇒ 403 {You do not own this account}`), both 400 body validations, the 404 account check, the transactional SAL upsert + audit, and the non-fatal snapshot regen — all unchanged.
- **Status codes to preserve:** 401; 403 (non-member/inactive) and 403 (ownership); 400 (×2); 404 (account); **201** (success — note the non-200 success code must be preserved).

**DELETE (revoke a share) — the two-tier case, handle carefully:**

- **Current authz:** `requireUser` → inline `findUnique` → `403 {Forbidden}` if not ACTIVE (**any role passes the door**) → `400` missing id → link `findUnique` → `404 {Share not found}` if missing/not ACTIVE → `403 {Forbidden}` if `link.addedByUserId !== userId && role ∉ {OWNER,ADMIN}` → revoke + audit + snapshot → `200 {ok}`.
- **Door action:** `requireSpaceAction(spaceId, "account:share")` — the shared account-surface door, **min VIEWER = any active member**. ⚠️ **Do NOT use `"account:revoke"` as the door.** `account:revoke` is min ADMIN; using it at the door would reject an adder-MEMBER who is currently allowed to revoke their own share — a behavior regression. The ADMIN baseline belongs in the *residual*, not the door.
- **Residual (route-local, KEEP) — expressed via `can()`:** replace the inline `isPrivileged = ["OWNER","ADMIN"].includes(role)` with `can("account:revoke", auth.membership)`, then keep the exact rule:
  `if (link.addedByUserId !== userId && !can("account:revoke", auth.membership)) return forbidden();`
  This preserves the adder-OR-privileged semantics byte-for-byte (OWNER/ADMIN ⇒ `can` true = privileged; adder ⇒ first clause false).
- **Status codes to preserve:** 401; 403 (non-member/inactive door) and 403 (not adder & not privileged); 400 (missing id); 404 (share not found); 200 (success).
- **Rollback:** revert this file (both handlers together).

---

## 3. Residual predicates — explicit disposition

| Residual | Route | Disposition |
|---|---|---|
| **Account ownership** (`fa.ownerUserId === caller`) | share POST | **Stays route-local.** 403 `{You do not own this account}` unchanged. `can()` cannot see resource ownership. |
| **Adder / admin rule** (`addedByUserId === caller` OR privileged) | share DELETE | **Stays route-local**, but the privileged half now reads `can("account:revoke", ctx)` instead of an inline `.includes()`. Behavior identical. |
| **Section existence / belongs-to-space** (`existing.spaceId === spaceId`) | sections PATCH | **Stays route-local.** 404 `{Section not found}` unchanged. |
| **Active-member check** (`status === ACTIVE`) | all 4 handlers | **Centralized into the adapter** (via `can()`'s global `status !== ACTIVE ⇒ false`). This is the inline check being removed. |
| **Non-disclosure** (403 not 404 for space membership) | all 4 handlers | **Preserved.** Adapter returns 403 for non-member; it never reveals space existence via 404. Resource 404s (section/account/share) are unchanged and unrelated to space existence. |
| **Body validation** (400s) + **success codes** (201 for share POST, 200 elsewhere) | share POST/DELETE, sections | **Stays route-local**, verbatim. |

---

## 4. Tests to prove behavior did not change

The repo has **no test runner** — tests are standalone `tsx` scripts (exit 0/1). Precedent for route-level tests: `lib/perspective-engine/route.test.ts`.

1. **Rerun `lib/spaces/policy.test.ts`** — unchanged; confirms `can()` (the rule the adapter delegates to) still passes the full 480-combo matrix + leak cases.
2. **New `lib/spaces/authorize.test.ts` (pure decision parity, no HTTP):** the adapter's I/O (session + `findUnique`) is not unit-testable without mocks the repo doesn't have, so test the **decision mapping** in isolation — a tiny exported pure helper `decideSpaceAction(action, membershipOrNull)` that `requireSpaceAction` calls after the DB fetch (returns `"allow" | "deny"`). Assert: null membership ⇒ deny; inactive ⇒ deny; role-too-low ⇒ deny; role-meets ⇒ allow, across the four batch actions. Keeps the branch logic tested without a live DB. (This is a minimal, non-opportunistic extraction — one pure function the adapter and the test share.)
3. **Route smoke matrix (manual/curl, documented) — the behavior-preservation oracle.** For each handler, exercise every scenario and assert the **exact status code** (and body where it matters):

   | Handler | Scenario | Expect |
   |---|---|---|
   | sections GET | no session / non-member / VIEWER member | 401 / 403 / 200 |
   | sections PATCH | non-member / MEMBER / ADMIN / cross-space sectionId | 403 / 403 / 200 / 404 |
   | share POST | non-member / member non-owner acct / member owner + bad visibility / success | 403 / 403 / 400 / 201 |
   | share DELETE | non-member / adder MEMBER / non-adder MEMBER / OWNER non-adder / missing share | 403 / 200 / 403 / 200 / 404 |

   The **adder-MEMBER ⇒ 200** and **non-adder-MEMBER ⇒ 403** rows are the critical regression guard for the DELETE door decision (§2c).
4. **Diff review gate:** confirm the *only* intended body-string change is `sections/[sectionId]` role-denial (`Insufficient permissions` → `Forbidden`, §1); every other body and status is byte-identical.

---

## 5. Validation checklist (run in order)

- [ ] `npx tsc --noEmit` — clean (adapter types, `SpaceAction` imports, route call sites resolve).
- [ ] `npm run lint` (`npx eslint` on the adapter + 3 routes) — clean; confirm removed imports (`SpaceMemberStatus` where now unused) don't leave unused-import errors.
- [ ] `npx tsx lib/spaces/policy.test.ts` — green (unchanged rule).
- [ ] `npx tsx lib/spaces/authorize.test.ts` — green (decision parity).
- [ ] **Route smoke matrix** (§4.3) — every cell matches expected status.
- [ ] **Grep delta:** `grep -rc "spaceMember.findUnique" app/api/spaces | grep -v ':0'` shows the 3 target files gone from the list; total occurrences drop **11 → 7** (the 4 removed: sections GET, sections PATCH, share POST, share DELETE). Remaining inline checks live in the not-yet-migrated routes (goals/check-in, activity, perspectives, invite, `[id]`, members).
- [ ] `git diff --name-only` lists exactly: `lib/spaces/authorize.ts` (new), `lib/spaces/authorize.test.ts` (new), and the 3 route files. No schema, no UI, no other files.

---

## 6. Impact map

| Dimension | Effect |
|---|---|
| New files | `lib/spaces/authorize.ts`, `lib/spaces/authorize.test.ts` |
| Modified files | 3 routes: `sections/route.ts`, `sections/[sectionId]/route.ts`, `accounts/share/route.ts` |
| Schema / migration | **None** |
| UI | **None** |
| `policy.ts` | **Untouched** (stays pure; adapter imports it) |
| `session.ts` | **Untouched** (adapter reuses its exports; no edits) |
| Behavior delta | One 403 **body string** normalization (`Insufficient permissions`→`Forbidden`); all status codes unchanged |
| Inline `findUnique` removed | 4 (11→7 occurrences) |
| FlowType P5 interaction | None — disjoint file set (FlowType owns `lib/transactions/*`, `syncTransactions.ts`, import + AI-chat routes, `Transaction` schema) |
| Blast radius | 3 route handlers; adapter is additive and could ship unused before routes migrate |

---

## 7. Migration order

1. **Land `lib/spaces/authorize.ts` + `authorize.test.ts`** (additive, zero route callers). Validate: tsc, lint, `authorize.test.ts` green. This can merge independently — same additive/zero-caller safety as SP-2a.
2. **Migrate `sections/route.ts` (GET)** — the simplest single-gate case; smoke 401/403/200.
3. **Migrate `sections/[sectionId]/route.ts` (PATCH)** — single gate + section residual; smoke incl. cross-space 404 and the body-string delta.
4. **Migrate `accounts/share/route.ts`** — POST first (door + ownership residual), then DELETE (door + adder/privileged residual). Smoke the full matrix, emphasizing adder-MEMBER ⇒ 200.
5. **Full validation gate (§5)** after each file, and once more at batch end.

Each step is an independent revert unit; a failure at any route rolls back just that file with the adapter and prior routes intact.

---

## 8. Rollback plan

- **Per-file, reverse order.** Revert route files individually (`git checkout -- <file>`); each still compiles against its original inline check.
- **Adapter is additive:** `lib/spaces/authorize.ts` has no other importers once routes are reverted, so it can stay (harmless) or be deleted. No schema, no data, nothing to un-migrate.
- **Whole-batch abort:** revert the 3 routes + delete the 2 new files ⇒ tree identical to pre-slice. Verified by `git status` showing no residual changes.

---

## 9. Final recommendation

Proceed with Batch 1 as scoped: ship `requireSpaceAction` in **`lib/spaces/authorize.ts`** (server-only, reusing `requireUser`/`forbidden` + pure `can()`), then migrate the 3 files in the §7 order. The design preserves every status code; the sole behavior delta is the `sections/[sectionId]` 403 body-string normalization, which I recommend **accepting** (it aligns with the 12 already-`requireSpaceRole` routes).

**Two non-negotiable correctness guards for implementation:** (1) the share **DELETE door must be `account:share` (active-member), not `account:revoke`**, with the ADMIN rule expressed as `can("account:revoke", ctx)` in the residual — otherwise adder-MEMBERs lose revoke rights; (2) the share POST **success code stays 201**, not 200.

**Stop point:** this checklist. Await approval before writing `lib/spaces/authorize.ts` or touching any route.
