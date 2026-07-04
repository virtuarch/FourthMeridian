> **INVESTIGATION / CHECKLIST ONLY — no code, no implementation.** Continues SP-2b. No schema/UI changes; preserve all status codes and route-local residuals; use `requireSpaceAction` only where it *exactly* matches the route's authorization door. Builds on `SP-2A_IMPLEMENTATION_CHECKLIST.md` and `SP-2B_BATCH1_MIGRATION_CHECKLIST.md`.

# SP-2b Batch 2 — Remaining Authorization Migration

## 1. Evidence — the 7 remaining `spaceMember.findUnique` classified

Grep (`app/api/spaces`, 7 across 6 files) splits into **three distinct kinds**. Only one kind is an inline *caller auth door* that `requireSpaceAction` should replace.

| # | File : line | Kind | Migrate? |
|---|---|---|---|
| A | `goals/[goalId]/check-in/route.ts:19` | **inline caller door** (any ACTIVE member) | ✅ Batch 2 |
| B | `activity/route.ts:292` | **inline caller door** (any ACTIVE member) | ✅ Batch 2 |
| C | `perspectives/route.ts:54` | **inline caller door** (any ACTIVE member) | ✅ Batch 2 |
| D | `invite/route.ts:46` | **residual** — target user's existing membership (409 "already a member"). Caller door is already `requireSpaceRole(ADMIN)`. | ❌ not a door — keep |
| E | `[id]/route.ts:47` (GET) | **special door** — caller membership **with public-space exception** + `myRole` derivation | ⏸ Batch 3 (see §4) |
| F | `members/[userId]/route.ts:48` (PATCH) | **residual** — target member lookup. Caller door already `requireSpaceRole(OWNER)`. | ❌ not a door — keep |
| G | `members/[userId]/route.ts:107` (DELETE) | **residual** — target member lookup. Caller door already `requireSpaceRole(VIEWER)`. | ❌ not a door — keep |

**Key finding:** of the 7, only **3 are inline caller doors** (A/B/C). Three (D/F/G) are *resource/target lookups* that authorize nothing about the caller — they must **stay** (`requireSpaceAction` authorizes the caller, never a target row). One (E) is a genuinely *special* door that does not cleanly match any single action. So after Batch 2 the inline-door migration is effectively **done**, and the residual `findUnique` count plateaus at 4 by design — not by omission.

---

## 2. Per-route detail (the three Batch-2 candidates)

All three share the identical door shape today: `requireUser()` → `db.spaceMember.findUnique` → `403 "Forbidden"` if missing or `status !== ACTIVE` (**any role**). None has a role residual. Each maps to an existing **VIEWER-min** action. All already return **plain `403 "Forbidden"`**, so migration has **zero body-string delta** (unlike Batch 1's `sections/[sectionId]`).

### A. `goals/[goalId]/check-in/route.ts` — POST
- **Current auth:** `requireUser` → inline `findUnique` (full row) → 403 if not ACTIVE.
- **401/403/404/400:** 401 no session; 403 non-member/inactive; **404** goal missing or `goal.spaceId !== spaceId`; **400** `goalType !== "HABIT"`; 200 success.
- **Role/status:** any ACTIVE member (VIEWER).
- **Residuals (stay route-local):** goal-exists + belongs-to-space (404); HABIT-only (400); streak logic.
- **Matching action:** **`goal:checkIn`** (VIEWER, sharedOnly:false) — exact match.

### B. `activity/route.ts` — GET
- **Current auth:** `requireUser` → **`400` if missing `spaceId`** → inline `findUnique(select status)` → 403 if not ACTIVE.
- **401/403/400:** 401 no session; **400** missing space id; 403 non-member/inactive; 200 list.
- **Role/status:** any ACTIVE member (VIEWER).
- **Residuals (stay):** the `ALLOWED_ACTIONS` audit-log filtering/serialization; the `400 missing spaceId` guard (**must remain ordered BEFORE the door** — see §3 note).
- **Matching action:** **`activity:read`** (VIEWER) — exact match.

### C. `perspectives/route.ts` — GET
- **Current auth:** `requireUser` → **`400` if missing `spaceId`** → inline `findUnique(select status)` → 403 if not ACTIVE.
- **401/403/400:** identical shape to activity.
- **Role/status:** any ACTIVE member (VIEWER).
- **Residuals (stay):** per-viewer `computePerspectives({ spaceId, userId })`; the `400 missing spaceId` guard (order note §3).
- **Matching action:** **`perspective:read`** (VIEWER) — exact match.

---

## 3. Batch 2 recommendation

**Migrate exactly these three** — the "any-active-member door" family:

| Route | Handler | Action |
|---|---|---|
| `app/api/spaces/[id]/goals/[goalId]/check-in/route.ts` | POST | `requireSpaceAction(spaceId, "goal:checkIn")` |
| `app/api/spaces/[id]/activity/route.ts` | GET | `requireSpaceAction(spaceId, "activity:read")` |
| `app/api/spaces/[id]/perspectives/route.ts` | GET | `requireSpaceAction(spaceId, "perspective:read")` |

**Why these belong together:** identical door (any ACTIVE member, no role residual), each an exact VIEWER-min action already in `policy.ts`, all already emit plain `403 "Forbidden"` (zero body delta), and none carries a role/lifecycle residual that could drift. Smallest coherent, lowest-risk family. They are **not** combined with the residual/target routes (D/F/G — nothing to migrate) or the special GET door (E — Batch 3), per the "don't combine unrelated families / don't migrate a route needing special handling" rules.

**Exact edit per file:** replace `requireUser()` + inline `findUnique` + the `!membership || status !== ACTIVE` 403 with `const [ , err] = await requireSpaceAction(spaceId, "<action>"); if (err) return err;` (drop the now-unused `SpaceMemberStatus` import where it becomes unused). **Preserve everything else**, especially:
- **Order guard:** in activity & perspectives, keep the `if (!spaceId) return 400` **before** `requireSpaceAction` (otherwise an empty id → 403 instead of 400 — a status-code change).
- Check-in keeps its 404 (goal/space) and 400 (HABIT) residuals verbatim.
- `withApiHandler` wrappers and success payloads unchanged.

**Files affected:** the 3 route files above only. No new action (all three actions pre-exist). No `authorize.ts`/`policy.ts` change.

**Tests / validation:**
- Re-run `npx tsx lib/spaces/policy.test.ts` and `lib/spaces/authorize.test.ts` (unchanged; confirm still green).
- Extend `authorize.test.ts` source-scan tripwires (house pattern): assert each of the 3 routes now calls `requireSpaceAction(spaceId, "<action>")` and no longer contains `spaceMember.findUnique`; assert activity/perspectives still contain the `400`/missing-spaceId guard before the door.
- Route smoke matrix (status codes must be byte-identical): per handler — no session → **401**; non-member/inactive → **403**; ACTIVE member → **200**; plus check-in cross-space goal → **404**, non-HABIT → **400**; activity/perspectives missing id → **400**.
- `npx tsc --noEmit`, `npm run lint` — clean.
- **Grep delta:** inline `spaceMember.findUnique` under `app/api/spaces` drops **7 → 4** (A/B/C removed). Confirm the remaining 4 are exactly D/E/F/G.
- `git diff --name-only` = only the 3 route files (+ `authorize.test.ts` if tripwires added).

**Rollback:** per-file `git checkout`; each route still compiles against its original inline check. `requireSpaceAction` already exists (Batch 1) and is unaffected.

---

## 4. Batch 3 inventory (what remains, and why)

After Batch 2, **only one true auth door remains inline**, plus three non-doors that should never be migrated:

- **E — `GET /api/spaces/[id]` (route.ts:47) — Batch 3, special-handling required.** The door is `space:read` **OR `space.isPublic`** (a non-member may read a *public* space), and it also needs the **membership row itself** to return `myRole`. `requireSpaceAction("space:read")` would (a) `403` a non-member on a public space (behavior change) and (b) not surface `myRole`. **Options for Batch 3:** keep it inline (legitimately special), OR introduce a small optional-membership variant (e.g. `resolveSpaceMembership(spaceId)` returning `membership | null` without erroring) so the route composes `can("space:read", …) || space.isPublic` itself. Recommend deciding this in Batch 3; do **not** force-fit `requireSpaceAction` here.
- **D / F / G — not migration targets, keep permanently.** `invite:46` (target user already-a-member → 409), `members:48` / `members:107` (target member lookups). Their **caller doors are already centralized** via `requireSpaceRole`; these `findUnique`s look up *other* rows, which is exactly what an authorization adapter must not do. They remain as ordinary DB reads.

So the honest end-state target is **inline caller doors = 0** after Batch 3 handles E; the residual `findUnique` count settles at 3 (D/F/G), all legitimate resource lookups.

---

## 5. Validation plan (summary)

- [ ] `npx tsc --noEmit` + `npm run lint` — clean.
- [ ] `npx tsx lib/spaces/policy.test.ts` + `lib/spaces/authorize.test.ts` — green (rule + adapter unchanged; add the 3 route tripwires).
- [ ] Smoke matrix per §3 — every status code byte-identical (401/403/200 + check-in 404/400 + activity/perspectives 400).
- [ ] Grep: inline `spaceMember.findUnique` **7 → 4**; remaining set == {D,E,F,G}.
- [ ] `git diff --name-only` == the 3 route files (+ optional `authorize.test.ts`); no schema/UI/other-route changes.
- [ ] Confirm the activity/perspectives `400 missing spaceId` guard still precedes the door.

## 6. Recommendation
Take **Batch 2 = { check-in, activity, perspectives }** exactly as scoped — three exact-match VIEWER-doors, zero body/status delta, one small edit each, `git`-revertible per file. Defer **E (GET `[id]`)** to Batch 3 as the one door needing an optional-membership/public-read decision, and explicitly mark **D/F/G** as permanent resource lookups (not migration debt). **Stop point:** this checklist — no code until approved.
