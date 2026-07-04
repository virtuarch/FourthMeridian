> **INVESTIGATION / CHECKLIST ONLY — no code, no implementation.** Final SP-2b batch. No schema/UI changes; preserve public-Space access, `myRole`, and all status codes; do not migrate target/resource lookups. Builds on Batches 1–2 (`SP-2B_BATCH1/2` checklists).

# SP-2b Batch 3 — `GET /api/spaces/[id]` public-read authorization

## 1. Evidence — the exact GET handler (`app/api/spaces/[id]/route.ts:26–54`)

```
GET:
  requireUser()                              → 401 if no session
  space = db.space.findUnique(id, {members}) → fetch space + ACTIVE members
  if (!space) → 404 "Not found"              ← existence check, BEFORE auth
  membership = db.spaceMember.findUnique(id, user.id)   ← caller row (any status)
  isActiveMember = membership?.status === "ACTIVE"
  if (!space.isPublic && !isActiveMember) → 403 "Forbidden"
  return { ...space, myRole: isActiveMember ? membership.role : null }
```

### Behavior matrix (what must be preserved exactly)

| Scenario | Result | Body |
|---|---|---|
| No session | **401** | (unauthorized) |
| Space does not exist | **404** | `Not found` — *precedes* the auth check (existence is not hidden behind 403) |
| Private space, ACTIVE member | **200** | space + `myRole = <role>` |
| Private space, non-member | **403** | `Forbidden` |
| Private space, REMOVED/LEFT | **403** | `Forbidden` (isActiveMember false) |
| **Public** space, ACTIVE member | **200** | space + `myRole = <role>` |
| **Public** space, non-member | **200** | space + `myRole = null` |
| **Public** space, REMOVED/LEFT | **200** | space + `myRole = null` |

The door is a **composite**: *(space exists → else 404) AND (isPublic OR active member → else 403)*, and it must **return the membership row** to derive `myRole`.

## 2. Why `requireSpaceAction` cannot be used here (grounded in the contract)

`requireSpaceAction(spaceId, action)` (`lib/spaces/authorize.ts`) — confirmed:
- 401 on no session; otherwise fetches membership and returns **`[null, forbidden()]` (403)** whenever `decideSpaceAction` is false (`!membership` → false).
- **Never emits 404** (it does not check space existence).
- **No `isPublic` awareness.**
- Returns the membership only for members; a public non-member gets 403, not a row.

So swapping in `requireSpaceAction(spaceId, "space:read")` would cause **three behavior regressions**:
1. **Public non-member → 403** instead of 200 — *breaks public-Space reads.*
2. **Missing space → 403** instead of 404 — *changes existence semantics.*
3. **`myRole` unavailable** for public non-members — *breaks `myRole`.*

**Conclusion:** GET's gate is not a role/lifecycle door (which is what `requireSpaceAction`/`can` model). It is a **read-visibility rule** (public OR member) + **existence** (404) + **identity derivation** (`myRole`). It legitimately does not match any single `SpaceAction`.

## 3. Options considered

| Option | What | Verdict |
|---|---|---|
| **A. Leave inline, documented exception** | Keep the handler as-is; add a comment explaining why it doesn't route through `requireSpaceAction`; add a test tripwire pinning its invariants | ✅ **Recommended** — zero behavior risk, zero new surface, smallest |
| **B. Optional-membership helper** | Add `resolveSpaceMembership(spaceId) → membership \| null` in `authorize.ts`; GET composes `can("space:read", ctx) \|\| space.isPublic` + `myRole` | ◐ Optional future — centralizes the "active member" check, but adds an exported helper + tests for marginal benefit; the public/404/`myRole` logic still stays in the route regardless |
| **C. Extend `requireSpaceAction` with `allowPublic`** | Add an option that returns membership-or-null and tolerates public non-members | ❌ Rejected — bloats the adapter contract, couples it to `space.isPublic`, duplicates the space fetch GET already does, and raises regression risk on the very door it's meant to protect |

### Why A over B
The only thing B centralizes is "an ACTIVE member may read" — which today is exactly `can("space:read")` = *any active member*, a trivial rule GET already expresses. The genuinely tricky parts (public-OR, 404-before-auth, `myRole`) **cannot** be centralized and stay in the route either way. So B pays a new-surface cost (exported helper + tests + a second module touched) for near-zero decision-centralization gain. A keeps `requireSpaceAction` used *only where it exactly matches* (the stated rule) and documents GET as the one principled exception — alongside the three target/resource lookups already marked permanent.

## 4. Recommended Batch 3 approach — Option A (documented inline exception)

GET `/api/spaces/[id]` **stays inline, by design.** The "handling" is to make that intentional and regression-proof, with **no behavior change**:

1. **Document the exception** in the GET handler: a comment stating this door is a read-visibility gate (public OR active member) + 404 existence + `myRole` derivation, which `requireSpaceAction` deliberately does not model (it would 403 public non-members, 403 missing spaces, and drop `myRole`).
2. **Pin the invariants** with a source-scan tripwire in `lib/spaces/authorize.test.ts` so a future refactor can't naively swap in `requireSpaceAction("space:read")` here.
3. **Reclassify the SP-2 end-state:** "inline caller doors = 0" is amended to "inline caller doors = 0 *except the documented public-read exception*." The remaining four `spaceMember.findUnique` are all intentional: GET (visibility door) + invite/members×2 (target lookups) — none is migration debt.

## 5. Implementation checklist (when approved)

**Files (exactly two, additive/comment-only):**
- `app/api/spaces/[id]/route.ts` — add the explanatory comment above the GET membership/visibility block. **No logic change.**
- `lib/spaces/authorize.test.ts` — add Part-E tripwires for GET.

**Tripwires to add (source-scan of `route.ts`):**
- GET keeps the public-read branch — asserts `space.isPublic` appears in the `!space.isPublic && !isActiveMember` gate.
- GET keeps `404 "Not found"` for a missing space, ordered **before** the 403 auth check.
- GET derives `myRole` from `isActiveMember ? membership.role : null`.
- GET **does NOT** call `requireSpaceAction(spaceId, "space:read")` (guards against a naive future swap).
- (Optional) assert the three permanent lookups still read as target lookups (`invite` `existing`, `members` `targetMembership`) — documents them as non-doors.

**Not touched:** `policy.ts`, `authorize.ts` (no new helper in Option A), invite, members, any schema/UI/route logic.

## 6. Validation plan

- [ ] `npx tsc --noEmit` + `npm run lint` — clean (comment + test only).
- [ ] `npx tsx lib/spaces/policy.test.ts` — green (unchanged).
- [ ] `npx tsx lib/spaces/authorize.test.ts` — green with the new Part-E GET tripwires.
- [ ] **GET smoke matrix** (must be byte-identical to §1): 401 (no session); 404 (missing space); 200 + `myRole=<role>` (member, public or private); **200 + `myRole=null` (public non-member)** — the critical public-read case; 403 (private non-member); 403 (REMOVED/LEFT private).
- [ ] **Grep:** inline `spaceMember.findUnique` under `app/api/spaces` stays **4** (GET intentionally retained). Confirm the set == {GET `[id]:47`, invite `:46`, members `:48`, members `:107`}.
- [ ] `git diff --name-only` == `route.ts` + `authorize.test.ts` only.

## 7. Rollback plan

Trivial and per-file: revert the comment in `route.ts` and the Part-E block in `authorize.test.ts`. **No behavior was ever changed**, so rollback carries zero functional risk. `requireSpaceAction`/`policy.ts` are untouched.

## 8. Recommendation

Adopt **Option A**: keep `GET /api/spaces/[id]` inline as the one documented public-read exception, pinned by tripwires, with no behavior change. This completes SP-2b: `requireSpaceAction` is used everywhere it exactly matches (Batches 1–2), the three target/resource lookups stay as legitimate DB reads, and GET is a principled, tested exception rather than migration debt. Consider **Option B** only if a future feature makes the "who may read" rule non-trivial (e.g., viewer-tier public access), at which point centralizing it earns its surface. **Stop point:** this checklist — no code until approved.
