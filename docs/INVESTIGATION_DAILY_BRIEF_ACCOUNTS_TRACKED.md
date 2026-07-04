# Investigation — Daily Brief "Accounts Tracked" Inflated Count

**Status:** Investigation only. No code, schema, migration, or UI changes made.
**Branch observed:** `feature/v2.5-spaces-completion`
**Symptom:** "In the last hour" card shows **Accounts tracked: 44**; user has ~9 real accounts shared across multiple Spaces.

---

## 1. Root cause (evidence-based)

The metric sums a **per-Space account count across every eligible Space**. A single account that is shared into N Spaces is counted N times. The value is therefore a count of **account placements (SpaceAccountLink rows)**, not distinct accounts.

### Chain of evidence

**UI (dumb renderer — not the bug):**
`components/brief/DailyBriefClient.tsx` → `since_last_visit` case → `components/brief/BriefSinceLastVisit.tsx`. It renders `section.items[].label` / `.value` verbatim. No calculation happens in the UI.

**Item construction:**
`app/api/brief/route.ts` → `buildSinceLastVisit()` (lines ~183-190):

```
if (totalAccounts > 0) {
  items.push({ id: "account_count", label: "Accounts tracked", value: String(totalAccounts), tone: "neutral" });
}
```

`totalAccounts` is passed in as `totalAccountCount`.

**The defect — `app/api/brief/route.ts` lines 528-533:**

```
// Note: shared accounts may be double-counted when they appear in multiple
// Spaces. This is a known limitation of per-Space context aggregation and
// will be addressed in a future deduplication slice.
const totalAccountCount = successfulContexts
  .reduce((sum, c) => sum + (accounts(c)?.totalCount ?? 0), 0);
```

The code comment already documents the double-counting.

**What `totalCount` actually is — `lib/ai/assemblers/accounts.ts`:**

- Line 126: `links = db.spaceAccountLink.findMany({ where: { spaceId, status: ACTIVE, financialAccount: { deletedAt: null } } })` — one row per account **placement in that one Space**.
- Line 385: `totalCount: links.length`.

So `totalCount` = **SpaceAccountLink rows for a single Space**. Per-Space that is correct (distinct accounts in that Space). The bug is the **cross-Space `reduce` sum** in the route: distinct accounts within a Space become non-distinct once summed across Spaces.

### Answering the scoped questions

1. **Component rendering "Accounts Tracked":** `BriefSinceLastVisit.tsx` (via `DailyBriefClient.tsx`). Pure renderer.
2. **Server/data function supplying the value:** `GET` in `app/api/brief/route.ts`; computed at lines 532-533, injected via `buildSinceLastVisit()`.
3. **What it counts:** **SpaceAccountLink rows**, summed across all eligible Spaces. `totalCount` per Space = `links.length` (ACTIVE, non-soft-deleted SpaceAccountLink rows). It is **not** distinct FinancialAccount rows, not legacy Account rows, and not "visible instances filtered to one Space."
4. **Are shared accounts counted multiple times:** **Yes.** An account shared into 3 Spaces contributes 3 to the total. 9 real accounts spread across Spaces summing to 44 implies ~44 total placements.
5. **What the metric should mean:** **"Accounts Tracked" = distinct real accounts visible to the user** across eligible Spaces → should read **9**. The current behaviour is effectively "Account Shares / placements" (44), which is the wrong semantic for this label.
6. **Correct semantic fix:** Deduplicate by `FinancialAccount.id` across eligible Spaces before counting. Count distinct financial accounts, not link rows.

### Why 44 vs 9 (consistency note)

Headline **net worth** already avoids this: the route deliberately uses the **primary Space only** for net worth (route header lines 19-22) to avoid double-counting balances. The account **count** was left as a cross-Space sum, so the count and the net worth are computed on different bases. The fix brings the count onto a distinct-account basis, consistent with the "no double-counting" intent already stated in the file.

---

## 2. Recommended semantic definition

> **Accounts Tracked** = the number of **distinct `FinancialAccount` records** (not soft-deleted) that are visible to the user through an ACTIVE `SpaceAccountLink` in any eligible Space (OWNER / ADMIN / MEMBER; VIEWER Spaces already excluded).

Notes:
- Distinctness key = `FinancialAccount.id`. An account linked into multiple Spaces counts once.
- This is intentionally **placement-dedup**, not **canonical-identity dedup**. If the same real-world account was connected twice as two `FinancialAccount` rows, that is a separate concern (D1 `DuplicateAccountCandidate`) and is explicitly out of scope here.
- Visibility level (FULL / BALANCE_ONLY / SUMMARY_ONLY) does not change the count — all visible accounts count once, matching current per-Space behaviour.

---

## 3. Files affected

| File | Role | Change type |
|---|---|---|
| `lib/ai/assemblers/accounts.ts` | Source of per-Space count | Additive: expose distinct account identifiers (`accountIds`) alongside `totalCount`, populated even when `scopeHint='brief'`. |
| `lib/ai/types.ts` | `AccountsSectionData` interface | Additive: add optional `accountIds: string[]`. |
| `app/api/brief/route.ts` | Cross-Space aggregation | Replace the `reduce` sum (lines 532-533) with a distinct-set size over `accountIds`; remove the stale double-counting comment. |

No UI file changes. No schema/migration changes. No Spaces redesign. Layout preserved — only the integer value changes.

`totalCount` has exactly two references (`accounts.ts` defines it; `route.ts` consumes it) — confirmed by grep — so blast radius is contained.

---

## 4. Implementation checklist (smallest viable — DO NOT execute yet)

Recommended approach (**Option A** — respects the D4 rule that the brief route does not query financial tables directly):

1. `lib/ai/types.ts`: add `accountIds?: string[]` to `AccountsSectionData` (optional, additive; JSDoc: "distinct FinancialAccount ids visible in this Space; used for cross-Space dedup").
2. `lib/ai/assemblers/accounts.ts`: build `const accountIds = links.map(l => l.financialAccount.id);` and include it in the returned `data`. Populate it **regardless of `scopeHint`** (unlike the per-account `accounts` array, which stays omitted in brief mode). IDs only — no balances/names — so no new privacy exposure and BALANCE_ONLY guarantees are untouched.
3. `app/api/brief/route.ts`: replace lines 532-533 with a distinct count:
   `const totalAccountCount = new Set(successfulContexts.flatMap(c => accounts(c)?.accountIds ?? [])).size;`
   Delete the obsolete "may be double-counted" comment (lines 528-531).
4. Run validation (section 6).

**Alternative (Option B — smaller diff, architecturally discouraged):** add a single direct `db.spaceAccountLink.findMany({ where: { spaceId: { in: eligibleSpaceIds }, status: ACTIVE, financialAccount: { deletedAt: null } }, select: { financialAccountId: true }, distinct: ['financialAccountId'] })` in the route and use `.length`. Rejected as primary because the route header explicitly states it "no longer queries SpaceAccountLink … directly." Documented only as a fallback if Option A is blocked.

Scope guardrails honoured: no schema change, no `WorkspaceAccountShare` rename, no legacy-table removal, additive-before-subtractive, unrelated UI untouched.

---

## 5. Rollback plan

- **Isolation:** all changes land in one small commit touching 3 files. Additive field (`accountIds`) plus a one-line aggregation swap.
- **Revert:** `git revert <commit>` restores the previous sum-based count. No data migration involved, so revert is instant and stateless.
- **Forward-safe fallback:** because `accountIds` is optional, if the assembler field is ever absent the route expression falls back to `?? []`, yielding a smaller count rather than a crash. The previous inflated behaviour is not reintroduced by partial deploy.
- **No persistence risk:** the metric is computed per request from live queries; nothing is cached to a table, so there is no stored bad state to clean up.

---

## 6. Validation plan

### Automated / build gates
- `npx prisma generate` — no schema change, expected to pass unchanged (run only to confirm no drift).
- `npx tsc --noEmit` — verifies the new optional field and the `Set` typing.
- `npm run lint`.
- Targeted route check: hit `GET /api/brief` for the affected user and assert `sections[].items` `account_count.value === "9"`.

### Fixture (the required test case)
Seed one user with:
- **9 distinct `FinancialAccount` rows** (not soft-deleted), e.g. ids `fa1`…`fa9`.
- **Multiple Spaces**, e.g. Personal + 2 shared Spaces, with the same accounts linked into more than one Space via `SpaceAccountLink` (status `ACTIVE`), such that total link rows ≈ 44. Suggested distribution:
  - Personal Space: links to all 9 (`fa1`…`fa9`).
  - Shared Space A: links to `fa1`…`fa9` (all shared in) — visibility BALANCE_ONLY on some to also prove visibility level doesn't affect the count.
  - Shared Space B: links to a subset repeated to push total placements toward 44.
- User role OWNER/MEMBER on all (not VIEWER).

**Expected results:**

| Assertion | Before fix | After fix |
|---|---|---|
| `account_count.value` on "In the last hour" card | `"44"` (sum of link rows) | `"9"` (distinct `FinancialAccount.id`) |
| Adding one net-new account (`fa10`) linked into 2 Spaces | +2 | +1 |
| Removing all of one Space's links for an account still linked elsewhere | count drops | count unchanged (still visible elsewhere) |
| A VIEWER Space's links | (already excluded) | still excluded |
| Net worth headline | unchanged (primary Space) | unchanged (primary Space) |

### Manual UI check
Load the Daily Brief for the fixture user; confirm the "In the last hour" card reads **Accounts tracked: 9**, layout unchanged, and no other card/value shifts.

---

## 7. Summary

The metric is a **sum of `SpaceAccountLink` rows across Spaces** (`route.ts:532-533` × `accounts.ts:385`), so shared accounts inflate it — a defect the code comments already flag. Fix is a contained, additive 3-file change: expose distinct `FinancialAccount` ids from the accounts assembler and count the deduplicated set in the brief route. No schema, migration, UI, or Spaces changes. Awaiting approval before any implementation.
