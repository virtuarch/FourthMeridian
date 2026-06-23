# D3 Step 4C — Core Dashboard Read Cutover: Implementation + Validation Report

Status: **implemented, validated, stopping per instruction. Do not begin 4D.**

Prerequisite confirmed by user before this step began: `correct-home-links.ts --dry-run` found 27/27 HOME-at-PERSONAL rows legitimate, 0 synthesized, 0 corrections required. HOME semantics correction (D3 Step 3) is implemented and committed.

## 1. Impact map

Reused from `docs/D3_STEP4C_CORE_DASHBOARD_REVIEW.md` §2 (caller/blast-radius map), confirmed still accurate:

| Caller | Calls |
|---|---|
| `app/(shell)/dashboard/page.tsx` | `getAccounts`, `getHoldings`, `getDebtTransactions`, `getTransactions` — all passed the same resolved `ctx.spaceId` |
| `app/(shell)/dashboard/accounts/page.tsx` | `getAccounts` |
| `app/(shell)/dashboard/banking/page.tsx` | `getAccounts`, `getTransactions` |
| `app/(shell)/dashboard/investments/page.tsx` | `getAccounts`, `getHoldings`, `getInvestmentTransactions` |
| `app/(shell)/dashboard/holdings/page.tsx` | `getAccounts`, `getHoldings` |
| `app/(shell)/dashboard/credit/page.tsx` | `getAccounts`, `getDebtTransactions`, `getFicoData` |
| `lib/snapshots/regenerate.ts` → `regenerateSpaceSnapshot()` | calls `getAccounts()`; the outer `regenerateSnapshotsForAccounts()` already reads `SpaceAccountLink` (Step 4A) — untouched |
| `components/dashboard/widgets/RecentTransactionsPanel.tsx`, `components/dashboard/DashboardClient.tsx` | consume data already fetched by `dashboard/page.tsx` — no query of their own |

Every dashboard surface (Overview, Accounts, Banking, Investments, Holdings, Credit) is affected — this was the highest blast-radius step in the D3 read-cutover sequence.

Confirmed unaffected, per the "do not change" list, and verified via `git status` after implementation (§4 below): `app/api/brief/route.ts`, `app/api/spaces/[id]/accounts/route.ts` — both still read `WorkspaceAccountShare` directly, untouched.

## 2. Exact query diffs

`lib/data/accounts.ts` — `getAccounts()`:
```diff
- const shares = await db.workspaceAccountShare.findMany({
-   where: {
-     workspaceId: spaceId,
-     status:           ShareStatus.ACTIVE,
-     financialAccount: { deletedAt: null },
-   },
+ const links = await db.spaceAccountLink.findMany({
+   where: {
+     spaceId,
+     status:           ShareStatus.ACTIVE,
+     financialAccount: { deletedAt: null },
+   },
    include: { financialAccount: { include: { debtProfile: true } } },
    orderBy: [ { financialAccount: { type: "asc" } }, { financialAccount: { name: "asc" } } ],
  });
- return shares.map(({ financialAccount: r }) => { ... });
+ return links.map(({ financialAccount: r }) => { ... });
```

`lib/data/accounts.ts` — `getHoldings()` (FinancialAccount branch only):
```diff
  financialAccount: {
    deletedAt: null,
-   workspaceShares: { some: { workspaceId: spaceId, status: ShareStatus.ACTIVE } },
+   spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE } },
  },
```

`lib/data/transactions.ts` — same relation-filter swap, applied identically in `getTransactions()`, `getDebtTransactions()`, `getInvestmentTransactions()`:
```diff
- { financialAccount: { deletedAt: null, workspaceShares: { some: { workspaceId: spaceId, status: ShareStatus.ACTIVE } } } },
+ { financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE } } } },
```
`getDebtTransactions()` keeps its extra `type: "debt"` condition; `getInvestmentTransactions()` keeps its category list — only the relation name/field changed in each.

No `kind` filter was added anywhere — `HOME` vs `SHARED` is ownership metadata, not a visibility gate; `status: ACTIVE` on the link is the sole visibility condition, matching what `WorkspaceAccountShare.status` gated before. Legacy `Account`-anchored OR-branches (`account: { spaceId }` / `account: { spaceId, type: "debt" }`) and the legacy-`Holding` branch were left untouched in every function. Response shapes are unchanged — only the relation being joined changed, not the selected/returned fields.

## 3. Files changed

- `lib/data/accounts.ts` — `getAccounts()`, `getHoldings()` (FinancialAccount branch), doc comments
- `lib/data/transactions.ts` — `getTransactions()`, `getDebtTransactions()`, `getInvestmentTransactions()`, doc comments

Confirmed via `git status --short` — exactly these two files modified, nothing else:
```
 M lib/data/accounts.ts
 M lib/data/transactions.ts
```
No schema, migration, write path, `app/api/brief/route.ts`, or `app/api/spaces/[id]/accounts/route.ts` changes.

## 4. Rollback plan

Pure code revert, no schema or data risk:
- `git checkout -- lib/data/accounts.ts lib/data/transactions.ts`, or revert the six relation filters individually.
- `WorkspaceAccountShare` remains the live write target (dual-write continues) — reverting the read is a no-op for data integrity.
- Detection signal: if any dashboard surface shows an account/holding/transaction set that disagrees with `app/api/spaces/[id]/accounts/route.ts` (still reading `WorkspaceAccountShare`) for the same space, that indicates a `SpaceAccountLink` data gap, not generic drift — investigate before re-applying.

## 5. Validation results

- `npx tsc --noEmit` — clean, zero errors.
- `npm run lint` — clean; only 4 pre-existing warnings in untouched files (`AccountModal.tsx:45`, `TotpSection.tsx:152`, `CoinIcon.tsx:78`, `:97` — all `@next/next/no-img-element`, unrelated to this change).
- Requirement 4 (account list / holdings / transactions / debt transactions / investment transactions all resolve visibility from the same source and cannot disagree): confirmed structurally — all five functions now query the identical shape, `spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE } }` (or the equivalent top-level `spaceAccountLink.findMany({ where: { spaceId, status: ACTIVE, ... } })` in `getAccounts()`), against the same `SpaceAccountLink` table, with the same `deletedAt: null` guard on `financialAccount`. There is no longer any function in this cluster reading `workspaceShares`/`WorkspaceAccountShare`, so the five cannot diverge from each other by construction.
- `npx tsx scripts/verify-space-account-link-backfill.ts` — not re-run in this session (no DB connectivity from the sandbox, consistent with the limitation already documented in `docs/D3_STEP3_HOME_SEMANTICS_CORRECTION.md` §4). Recommend running this locally before/with the manual Preview pass below.
- Manual Preview pass (personal space and a shared space, accounts/holdings/banking/investments/credit pages) — not performed by me; recommended as the final check before merge, comparing against pre-cutover behavior per the original review's §7 checklist.

Stopping here per instruction. 4D not started.
