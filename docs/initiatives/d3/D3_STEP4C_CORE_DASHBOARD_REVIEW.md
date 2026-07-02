> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D3 Step 4C — Core Dashboard Read Cutover Investigation

Read-only research. No code, schema, or migration changes were made to produce this report.

## 0. Headline finding — a real blocker, not a re-litigation

Steps 4A and 4B were safe because the Step 3 dual-write guarantees `SpaceAccountLink`'s ACTIVE row-set for a given account is *identical* to `WorkspaceAccountShare`'s. That guarantee **does not hold** for `ensureHomeLink()`.

`ensureHomeLink()` runs only on two creation paths — Plaid `exchange-token` (new account) and wallet `POST` (new wallet) — and only when the account is created while the user's *active* space differs from their personal space. It synthesizes one extra `SpaceAccountLink` row (`kind: HOME`, `status: ACTIVE`) at the creator's personal space, **with no corresponding `WorkspaceAccountShare` row ever written there**. Confirmed in code:

- `app/api/plaid/exchange-token/route.ts:253-288` — writes exactly one `WorkspaceAccountShare` (at `spaceId`, the active space), then calls `ensureHomeLink({ ..., excludeSpaceId: spaceId })` when `isNewAccount`.
- `app/api/accounts/wallet/route.ts:192-222` — same pattern for new wallets.
- `lib/accounts/space-account-link.ts:219-263` — `ensureHomeLink()` upserts a `SpaceAccountLink` directly; it never touches `WorkspaceAccountShare`.
- `app/api/accounts/manual/route.ts:131-163` — by contrast, manual accounts write a `WorkspaceAccountShare` *and* mirror it for every target in `shareTargets` (which always includes `personalSpaceId`), so manual accounts have no asymmetry.

Today, reading `WorkspaceAccountShare` (current production behavior): if you connect a Plaid item or add a wallet while viewing a non-personal space, **your personal space cannot see that account** — there's no share row for it there. Confirmed `getAccounts()` does no other ownership-based visibility check (`FinancialAccount.ownerUserId`/`ownerSpaceId` exist for D11 accountability bookkeeping only, not visibility — `lib/data/accounts.ts` queries `workspaceAccountShare` exclusively).

If `getAccounts()` / `getHoldings()` / `getTransactions()` etc. cut over to read `SpaceAccountLink` (ACTIVE, any `kind`), the personal space would **start seeing** every such Plaid/wallet account retroactively and going forward — a real, user-visible behavior change, not a transparent swap. There's no way to filter this out by `kind` alone: the synthesized row and a "real" mirrored row that happens to land at the personal space are both `kind: HOME, status: ACTIVE` and indistinguishable from the row itself.

This is self-contained to *active* (non-deleted) accounts only — archiving an account sets `FinancialAccount.deletedAt`, which every 4C-candidate query already filters on, so it's not exposed once an account is archived (verified in `app/api/accounts/[id]/route.ts:151-167`). It's also worth noting that archiving an account from a non-personal space revokes every real `WorkspaceAccountShare` row but does **not** revoke the synthesized personal-space link if the account is later un-archived/restored without going through manual's symmetric path — though since `deletedAt` is the actual visibility guard for archived accounts in every query below, this doesn't independently change anything.

**Retroactive note on Step 4B:** `app/api/accounts/[id]/transactions/route.ts`'s already-implemented `SpaceAccountLink` visibility gate is exposed to this same gap today — a personal-space request for transactions on a Plaid/wallet account created elsewhere would now pass where it previously 404'd. That change is implemented but not yet committed; flagging it here for awareness, not reverting it without instruction.

Recommend treating this as the kind of "concrete blocker" the project rules anticipate, and deciding explicitly before any 4C code change:

1. **Accept the behavior change** as a deliberate, disclosed improvement (personal space gaining visibility into its own creator's accounts matches the schema's stated long-term intent — "`kind=HOME` replaces the declared-owner pair"). Ship 4C with an explicit changelog note.
2. **Hold 4C** until the dual-write is made symmetric — e.g. `ensureHomeLink()`'s synthesized link is paired with a real `WorkspaceAccountShare` row at the personal space (a write-path change, out of scope for a read-only step and for "no write-path changes").
3. **Hold 4C** until there's a way to mark synthesized-only links distinctly (e.g. a new boolean/kind value) so reads can exclude them — also a schema/write-path change.

This report proceeds with the rest of the requested investigation (inventory, diffs, validation plan) so it's ready to execute the moment one of these is chosen, but does **not** recommend writing the code yet.

## 1. Query inventory — current state

| Function | File | Current query | deletedAt filter | status filter | visibilityLevel | kind |
|---|---|---|---|---|---|---|
| `getAccounts()` | `lib/data/accounts.ts:30-98` | `workspaceAccountShare.findMany({ where: { workspaceId, status: ACTIVE, financialAccount: { deletedAt: null } } })` | Yes, via relation | ACTIVE only | Ignored — every field returned regardless of level | n/a |
| `getHoldings()` (FinancialAccount branch) | `lib/data/accounts.ts:112-146` | `holding.findMany({ where: { financialAccountId: { not: null }, financialAccount: { deletedAt: null, workspaceShares: { some: { workspaceId, status: ACTIVE } } } } })` | Yes | ACTIVE only | Ignored | n/a |
| `getHoldings()` (legacy branch) | same | `holding.findMany({ where: { accountId: { not: null }, account: { spaceId } } })` | n/a (legacy `Account` has no shared `deletedAt` gate here) | n/a | n/a | n/a — **not** a `WorkspaceAccountShare`/`SpaceAccountLink` query, out of scope |
| `getTransactions()` | `lib/data/transactions.ts:28-57` | `OR: [{ account: { spaceId } }, { financialAccount: { deletedAt: null, workspaceShares: { some: { workspaceId, status: ACTIVE } } } }]` | Yes (2nd branch only) | ACTIVE only | Ignored | n/a |
| `getDebtTransactions()` | `lib/data/transactions.ts:60-87` | Same shape, `+ type: "debt"` on both branches | Yes | ACTIVE only | Ignored | n/a |
| `getInvestmentTransactions()` | `lib/data/transactions.ts:90-116` | Same shape as `getTransactions()` | Yes | ACTIVE only | Ignored | n/a |

Notes:
- The legacy `Account`-anchored branches in each function are untouched by Step 3/4 entirely — no `WorkspaceAccountShare` or `SpaceAccountLink` involved — leave as-is.
- `getInvestmentTransactions()` doesn't accept a `ctx` param (always resolves `getSpaceContext()` internally), unlike its two siblings. Pre-existing inconsistency, not part of this cutover's job to fix.
- None of these six query paths filter on `visibilityLevel` today — a space with a `BALANCE_ONLY` share still gets full fields back from `getAccounts()`/`getHoldings()`/`getTransactions()`. That's existing, unrelated behavior (the privacy transform only lives in `app/api/spaces/[id]/accounts/route.ts` via `normalizeSharedAccounts()`), preserved unchanged by a 1:1 relation swap.

## 2. Caller / blast-radius map

| Caller | Calls |
|---|---|
| `app/(shell)/dashboard/page.tsx` | `getAccounts`, `getHoldings`, `getDebtTransactions`, `getTransactions` — all passed the same resolved `ctx.spaceId` |
| `app/(shell)/dashboard/accounts/page.tsx` | `getAccounts` |
| `app/(shell)/dashboard/banking/page.tsx` | `getAccounts`, `getTransactions` |
| `app/(shell)/dashboard/investments/page.tsx` | `getAccounts`, `getHoldings`, `getInvestmentTransactions` |
| `app/(shell)/dashboard/holdings/page.tsx` | `getAccounts`, `getHoldings` |
| `app/(shell)/dashboard/credit/page.tsx` | `getAccounts`, `getDebtTransactions`, `getFicoData` |
| `lib/snapshots/regenerate.ts` → `regenerateSpaceSnapshot()` | `getAccounts()` (already reads `SpaceAccountLink` one level up in `regenerateSnapshotsForAccounts()` per Step 4A — this inner call is untouched) |
| `components/dashboard/widgets/RecentTransactionsPanel.tsx`, `components/dashboard/DashboardClient.tsx` | UI consumers of data already fetched by `dashboard/page.tsx` — no query of their own |

Every dashboard surface (Overview, Accounts, Banking, Investments, Holdings, Credit) depends on this cluster. This is the highest blast-radius step in the entire D3 read-cutover sequence — consistent with the original Step 4 doc's risk ranking.

Confirmed **not** to depend on this cluster, and explicitly off-limits per this task's rules:
- `app/api/brief/route.ts` — its own direct `workspaceAccountShare.findMany`, independent query, untouched.
- `app/api/spaces/[id]/accounts/route.ts` — its own direct `workspaceAccountShare.findMany` feeding `normalizeSharedAccounts()`, untouched.

## 3. Proposed exact diffs (do not implement yet — pending the decision in §0)

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
(`getDebtTransactions()` keeps its extra `type: "debt"` condition; `getInvestmentTransactions()` keeps its category list — only the relation name/field changes.)

No `kind` filter is proposed anywhere above — consistent with 4A/4B precedent and with how the Step 3 dual-write treats `kind` as descriptive metadata, not a gate. (This is precisely why §0's gap exists: `status: ACTIVE` alone can't distinguish a real mirrored link from a synthesized one.)

Response shapes: identical to today in all six functions — `links.map(...)` produces the exact same `Account[]`/`Holding[]`/`Transaction[]` shape, since only the relation being joined changes, not the selected fields.

## 4. Files to change (once §0 is resolved)

- `lib/data/accounts.ts` — `getAccounts()`, `getHoldings()` (FinancialAccount branch only)
- `lib/data/transactions.ts` — `getTransactions()`, `getDebtTransactions()`, `getInvestmentTransactions()`

## 5. Files explicitly not to change

- `app/api/brief/route.ts`
- `app/api/spaces/[id]/accounts/route.ts`
- Any write path (`app/api/plaid/exchange-token/route.ts`, `app/api/accounts/manual/*`, `app/api/accounts/wallet/route.ts`, `app/api/accounts/[id]/route.ts`, `app/api/spaces/[id]/accounts/share/route.ts`, `app/api/spaces/[id]/members/[userId]/route.ts`, `lib/accounts/reconcile.ts`, `lib/accounts/space-account-link.ts`)
- `prisma/schema.prisma`, any migration
- The legacy `Account`-anchored branches inside `getHoldings()`, `getTransactions()`, `getDebtTransactions()`, `getInvestmentTransactions()` — unrelated to `WorkspaceAccountShare`/`SpaceAccountLink`

## 6. Rollback plan

Pure code revert — no schema or data changes, same as 4A/4B:
- `git checkout -- lib/data/accounts.ts lib/data/transactions.ts`, or revert the six relation filters individually.
- `WorkspaceAccountShare` remains the live write target throughout; reverting the read is a no-op for data integrity.
- Detection: if the dashboard, banking, investments, holdings, or credit pages show an account/holding/transaction set that doesn't match what `app/api/spaces/[id]/accounts/route.ts` (still on `WorkspaceAccountShare`) shows for the same space, that's the signal — most likely caused by the §0 gap, not a generic dual-write drift.

## 7. Validation checklist

- `npx tsc --noEmit`
- `npm run lint`
- `npx tsx scripts/verify-space-account-link-backfill.ts` (re-run to confirm the two tables are still in the expected relationship before trusting reads against `SpaceAccountLink`)
- Manual Preview pass, both a personal space and a shared space, before/after:
  - Accounts page — account list and balances match pre-cutover exactly (same set, same order)
  - Holdings page — same holdings, same values
  - Banking page — same transaction list
  - Credit page — same debt transactions, same utilization figures
  - Investments page — same investment transactions
  - Specifically re-test the §0 scenario: connect a new Plaid item (or add a wallet) while a non-personal space is active, then check whether the personal space's account list changes — this is the exact case to confirm before/after differ, and to decide if that's acceptable
  - Archive → confirm archived accounts vanish from all five surfaces in both spaces
  - Share → revoke an account from a non-personal space, confirm it disappears there but (per §0) may still show in the personal space if a synthesized link exists
  - Leave/remove a member — confirm no regression in what remains visible to the removed space

## 8. Recommendation: one commit, after §0 is resolved

Keep `getAccounts()`, `getHoldings()`, `getTransactions()`, `getDebtTransactions()`, and `getInvestmentTransactions()` in **one commit** — they answer the same visibility question and must move together, exactly as the original Step 4 doc concluded; splitting them risks the dashboard's account list, holdings list, and transaction list disagreeing mid-rollout.

But do not schedule that commit until §0's decision is made. This is the one piece of Step 4 where "implement only this single reader cutover" isn't enough to make it safe by itself — the cluster is safe internally (all six functions share the exact same gap, so they'd still agree with each other), but as a whole it's not yet provably equivalent to current `WorkspaceAccountShare`-based behavior.

---

Stopping here per instruction. No code, schema, or migration changes were made.
