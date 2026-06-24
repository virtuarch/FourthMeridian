# D2 Step 3D — reconcile.ts ProviderAccountIdentity Read Cutover (Implementation + Validation)

Status: **implemented and validated within sandbox limits. No schema changes. No migrations. No WALLET/MANUAL/CSV touched.**

## Impact map

Only one file changed: `lib/accounts/reconcile.ts`. Confirmed via `git diff --stat` — the only modified file in the working tree.

| Area | Touched? |
|---|---|
| `findActiveAccountByIdentity` — PLAID branch (this step's target) | Yes — now tries `ProviderAccountIdentity` first, falls back to `FinancialAccount.plaidAccountId` |
| `findActiveAccountByIdentity` — WALLET branch | No — unchanged, still queries `FinancialAccount` by `ownerUserId`+`walletAddress` directly |
| `providerIdentityOf` | No — pure function, no DB call, untouched |
| Fingerprint matching (`findCandidatesByFingerprint`, `pickCanonicalAndMerge`, `resolveAccountByFingerprint`) | No — these never branched on `plaidAccountId` for matching (confirmed no-op in Step 3A §A #3); untouched |
| `mergeArchivedDuplicateIntoCanonical` (merge/archive/dedupe logic) | No — untouched |
| `app/api/accounts/[id]/restore/route.ts` (calls into `findActiveAccountByIdentity`) | No file change — automatically inherits the cutover via the shared function, exactly as Step 3A §A #9 predicted |
| `app/api/plaid/exchange-token/route.ts` | No |
| `lib/plaid/refresh.ts` | No |
| `lib/plaid/syncTransactions.ts` | No |
| Holdings lookups | No |
| Schema / migrations | No |
| WALLET / MANUAL / CSV | No |

## Code change

`findActiveAccountByIdentity` in `lib/accounts/reconcile.ts`:

```ts
export async function findActiveAccountByIdentity(identity: ProviderIdentity, excludeId?: string) {
  if (identity.kind === "plaid") {
    const plaidIdentity = await db.providerAccountIdentity.findUnique({
      where: { provider_externalAccountId: { provider: ProviderType.PLAID, externalAccountId: identity.plaidAccountId } },
      include: { financialAccount: true },
    });

    if (plaidIdentity) {
      // plaidAccountId is globally unique at the DB level, so the linked
      // FinancialAccount is the same row the legacy lookup below would have
      // found — apply the same "active, not excluded" predicate to it
      // in-memory instead of a second query.
      const fa = plaidIdentity.financialAccount;
      const isExcluded = excludeId ? fa.id === excludeId : false;
      return fa.deletedAt === null && !isExcluded ? fa : null;
    }

    // No identity row — coverage gap. Fall back to the legacy lookup.
    const fallback = await db.financialAccount.findFirst({
      where: { plaidAccountId: identity.plaidAccountId, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (fallback) {
      console.warn(
        `[plaid][D2-3D] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fallback.id} externalAccountId=${identity.plaidAccountId}. Coverage gap; investigate before removing fallback.`
      );
    }
    return fallback;
  }

  return db.financialAccount.findFirst({
    where: {
      ownerUserId:   identity.ownerUserId,
      walletAddress: identity.walletAddress,
      deletedAt:     null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}
```

`ProviderType` added to the existing `@prisma/client` import line — no other imports changed.

**Why this preserves existing behavior exactly:** `plaidAccountId` is globally `@unique` on `FinancialAccount`, so at most one row can ever match a given value. When an identity row exists, its linked `FinancialAccount` *is* that same unique row — applying the `deletedAt === null && !isExcluded` check to it in memory produces the identical result the original `findFirst({ plaidAccountId, deletedAt: null, id: { not: excludeId } })` would have, without a second query. When no identity row exists (coverage gap), the function falls back to that exact original query, so behavior is unchanged in that branch too — only a `console.warn` is added, which is non-fatal and doesn't affect the return value. The WALLET branch and every caller downstream (`providerIdentityOf`, the restore routes, `mergeArchivedDuplicateIntoCanonical`, fingerprint matching) are untouched — no algorithm, merge, archive, or dedupe behavior changes.

`app/api/accounts/[id]/restore/route.ts` automatically inherits this cutover since it calls `findActiveAccountByIdentity` directly — exactly the propagation Step 3A §A #9 anticipated. No edit was needed or made in that file.

## Rollback plan

Pure code revert — restore the single `where`-then-`findFirst` version of `findActiveAccountByIdentity` (remove the `ProviderAccountIdentity` branch and the `ProviderType` import). No data, schema, or migration impact: `ProviderAccountIdentity` and `FinancialAccount.plaidAccountId` are both untouched by this step, and the fallback-first design never created a hard dependency on the new table.

## Validation results

| Check | Result |
|---|---|
| `git diff --stat` scope check | Only `lib/accounts/reconcile.ts` changed (45 insertions, 6 deletions) |
| `npx tsc --noEmit` | Clean, 0 errors |
| `npm run lint` | 0 errors, 4 warnings — all pre-existing `@next/next/no-img-element` warnings in unrelated files (`components/dashboard/AccountModal.tsx:45`, `components/dashboard/TotpSection.tsx:152`, `components/ui/CoinIcon.tsx:78,97`); none in the touched file |
| `npx tsx scripts/verify-provider-account-identity-backfill.ts --verbose` | **Could not run** — same sandbox blocker as Steps 3B/3C: `PrismaClientInitializationError: Prisma Client could not locate the Query Engine for runtime "linux-arm64-openssl-3.0.x" ... Prisma Client was generated for "darwin-arm64"`. Expected, not caused by this change — no live DB access from this sandbox. |

Run locally to close out validation:

```
npx tsx scripts/verify-provider-account-identity-backfill.ts --verbose
```

Suggested functional check: exercise the generic restore route (`app/api/accounts/[id]/restore/route.ts`) on an archived, PLAID-linked account that has an active duplicate, and confirm it still folds into the canonical account instead of restoring as a second visible row. Watch logs for any `[plaid][D2-3D]` warning — its presence would mean the identity-table lookup missed for an account the legacy field still finds, a coverage gap worth investigating before Step 3G removes the fallback.

---

**Stopping here per scope. Step 3E (refresh.ts) and Step 3F (syncTransactions.ts) not started.**
