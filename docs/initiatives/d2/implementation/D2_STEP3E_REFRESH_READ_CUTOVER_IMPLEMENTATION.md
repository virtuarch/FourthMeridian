> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 3E — refresh.ts ProviderAccountIdentity Read Cutover (Implementation + Validation)

Status: **implemented and validated within sandbox limits. No schema changes. No migrations. No WALLET/MANUAL/CSV touched.**

## Impact map

Only one file changed: `lib/plaid/refresh.ts`. Confirmed via `git diff --stat` — the only modified file in the working tree.

| Area | Touched? |
|---|---|
| Balance/metadata lookup (`refreshPlaidItem`, step 1) | Yes — now tries `ProviderAccountIdentity` first, falls back to `FinancialAccount.plaidAccountId` |
| Holdings cross-reference lookup (`refreshPlaidItem`, step 2) | Yes — same pattern |
| Holdings business logic (delete/recreate, security mapping, change24h calc) | No — untouched, still consumes whatever `fa.id` resolves to |
| Transactions (`syncTransactionsForItem` call) | No — called as-is, file untouched |
| SpaceSnapshot regeneration (`regenerateSnapshotsForAccounts`) | No — untouched |
| `refreshAllActiveItemsForUser` | No — untouched, calls `refreshPlaidItem` as before |
| `app/api/plaid/exchange-token/route.ts` | No |
| `lib/accounts/reconcile.ts` | No |
| `lib/plaid/syncTransactions.ts` | No |
| Schema / migrations | No |
| WALLET / MANUAL / CSV | No |

## Code change

Both `findUnique` calls in `refreshPlaidItem()` were preceded by a `ProviderAccountIdentity` lookup. Site 1 (balance/metadata):

```ts
const plaidIdentity = await db.providerAccountIdentity.findUnique({
  where: { provider_externalAccountId: { provider: ProviderType.PLAID, externalAccountId: acct.account_id } },
  include: { financialAccount: true },
});

let fa = plaidIdentity?.financialAccount ?? null;
if (!fa) {
  fa = await db.financialAccount.findUnique({ where: { plaidAccountId: acct.account_id } });
  if (fa) {
    console.warn(
      `[plaid][D2-3E] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fa.id} externalAccountId=${acct.account_id}. Coverage gap; investigate before removing fallback.`
    );
  }
}

// No match, or soft-deleted (removed by the user) — never restore or
// create during a refresh. That only happens via relink (exchange-token).
if (!fa || fa.deletedAt) continue;
```

Site 2 (holdings cross-reference), same pattern with a `select`-only identity lookup to match the original's `select: { id: true }` shape:

```ts
const holdingPlaidIdentity = await db.providerAccountIdentity.findUnique({
  where: { provider_externalAccountId: { provider: ProviderType.PLAID, externalAccountId: plaidAcct.account_id } },
  select: { financialAccount: { select: { id: true } } },
});

let fa = holdingPlaidIdentity?.financialAccount ?? null;
if (!fa) {
  fa = await db.financialAccount.findUnique({
    where:  { plaidAccountId: plaidAcct.account_id },
    select: { id: true },
  });
  if (fa) {
    console.warn(
      `[plaid][D2-3E] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fa.id} externalAccountId=${plaidAcct.account_id}. Coverage gap; investigate before removing fallback.`
    );
  }
}
if (!fa) continue; // never create — refresh only updates known accounts
```

`ProviderType` added to the existing `@prisma/client` import line — no other imports changed. Both sites' downstream logic (`fa.id`, `fa.balance`, `fa.deletedAt`, `db.holding.deleteMany`/`create`) is unchanged and consumes `fa` exactly as before.

**Why this preserves existing behavior:** each site falls back to the identical legacy query it used before, so a coverage gap degrades to today's behavior, not a skipped or wrong update. A `console.warn` surfaces the gap without affecting control flow. Doing both sites together (rather than splitting across steps) avoids the partial-cutover inconsistency flagged as Risk 3 in the Step 3A report, since both reads exist in the same function and resolve the same kind of identity.

## Rollback plan

Pure code revert — remove both `ProviderAccountIdentity` lookup blocks, restore the two direct `FinancialAccount.findUnique({ plaidAccountId })` calls (and the `ProviderType` import). No data, schema, or migration impact: `ProviderAccountIdentity` and `FinancialAccount.plaidAccountId` are both untouched by this step.

## Validation results

| Check | Result |
|---|---|
| `git diff --stat` scope check | Only `lib/plaid/refresh.ts` changed (41 insertions, 6 deletions) |
| `npx tsc --noEmit` | Clean, 0 errors |
| `npm run lint` | 0 errors, 4 warnings — all pre-existing `@next/next/no-img-element` warnings in unrelated files (`components/dashboard/AccountModal.tsx:45`, `components/dashboard/TotpSection.tsx:152`, `components/ui/CoinIcon.tsx:78,97`); none in the touched file |
| `npx tsx scripts/verify-provider-account-identity-backfill.ts --verbose` | **Could not run** — same sandbox blocker as Steps 3B–3D: `PrismaClientInitializationError: Prisma Client could not locate the Query Engine for runtime "linux-arm64-openssl-3.0.x" ... Prisma Client was generated for "darwin-arm64"`. Expected, not caused by this change — no live DB access from this sandbox. |

Run locally to close out validation:

```
npx tsx scripts/verify-provider-account-identity-backfill.ts --verbose
```

Suggested functional check: trigger a manual "Refresh" on a linked account (and ideally one with investment holdings) and confirm balances/holdings still update as before. Watch logs for any `[plaid][D2-3E]` warning — its presence would mean the identity-table lookup missed for an account the legacy field still finds, a coverage gap worth investigating before Step 3G removes the fallback.

---

**Stopping here per scope. Step 3F (syncTransactions.ts + exchange-token holdings lookup) not started.**
