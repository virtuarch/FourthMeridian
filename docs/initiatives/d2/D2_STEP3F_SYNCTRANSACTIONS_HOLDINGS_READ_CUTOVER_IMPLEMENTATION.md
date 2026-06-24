# D2 Step 3F — syncTransactions.ts + exchange-token Holdings Read Cutover (Implementation + Validation)

Status: **implemented and validated within sandbox limits. No schema changes. No migrations. No WALLET/MANUAL/CSV touched.**

This is the last step in the Step 3A read-cutover plan (§C) — every eligible PLAID read site identified in Step 3A is now cut over (3C exchange-token exact-match, 3D reconcile.ts, 3E refresh.ts, 3F syncTransactions.ts + exchange-token holdings).

## Impact map

Two files changed, both pre-approved: `lib/plaid/syncTransactions.ts` and `app/api/plaid/exchange-token/route.ts`. Confirmed via `git diff --stat`.

| Area | Touched? |
|---|---|
| `syncTransactions.ts` — `resolveFinancialAccountId()` | Yes — now tries `ProviderAccountIdentity` first, falls back to `FinancialAccount.plaidAccountId` |
| `syncTransactions.ts` — `accountIdCache` memoization | No behavior change — cache-hit check and cache-set are unchanged; only what happens on a cache miss changed |
| `syncTransactions.ts` — transaction upsert / fingerprint fallback (`findByFingerprint`, plaidTransactionId matching) | No — untouched |
| `exchange-token/route.ts` — holdings cross-reference (this step's target) | Yes — same pattern |
| `exchange-token/route.ts` — exact-match resolution (Step 3C) | No — untouched, already cut over in a prior step |
| `exchange-token/route.ts` — holdings business logic (delete/recreate, security mapping) | No — untouched |
| `lib/accounts/reconcile.ts` | No |
| `lib/plaid/refresh.ts` | No |
| Schema / migrations / dual-write logic | No |
| WALLET / MANUAL / CSV | No |

## Code changes

**`lib/plaid/syncTransactions.ts`** — `resolveFinancialAccountId()`:

```ts
async function resolveFinancialAccountId(plaidAccountId: string): Promise<string | null> {
  if (accountIdCache.has(plaidAccountId)) return accountIdCache.get(plaidAccountId)!;

  const plaidIdentity = await db.providerAccountIdentity.findUnique({
    where:  { provider_externalAccountId: { provider: ProviderType.PLAID, externalAccountId: plaidAccountId } },
    select: { financialAccount: { select: { id: true } } },
  });

  let fa = plaidIdentity?.financialAccount ?? null;
  if (!fa) {
    fa = await db.financialAccount.findUnique({
      where:  { plaidAccountId },
      select: { id: true },
    });
    if (fa) {
      console.warn(
        `[plaid][D2-3F] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fa.id} externalAccountId=${plaidAccountId}. Coverage gap; investigate before removing fallback.`
      );
    }
  }

  const resolved = fa?.id ?? null;
  accountIdCache.set(plaidAccountId, resolved);
  return resolved;
}
```

Cache-hit short-circuit (`if (accountIdCache.has(...))`) and cache-set (`accountIdCache.set(...)`) are unchanged and still wrap the whole resolution — one resolution (now two possible queries instead of one, only on a cache miss) per unique account per sync run, exactly as before.

**`app/api/plaid/exchange-token/route.ts`** — holdings cross-reference:

```ts
const holdingPlaidIdentity = await db.providerAccountIdentity.findUnique({
  where:  { provider_externalAccountId: { provider: ProviderType.PLAID, externalAccountId: plaidAcct.account_id } },
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
      `[plaid][D2-3F] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fa.id} externalAccountId=${plaidAcct.account_id}. Coverage gap; investigate before removing fallback.`
    );
  }
}
if (!fa) continue;
```

`ProviderType` added to `syncTransactions.ts`'s existing `@prisma/client` import; already present in `exchange-token/route.ts` from Step 3C. Both sites' downstream logic is unchanged and consumes the resolved `fa`/`financialAccountId` exactly as before.

## Rollback plan

Pure code revert per file — remove the `ProviderAccountIdentity` lookup block in each site, restore the single direct `FinancialAccount.findUnique({ plaidAccountId })` call (and the `ProviderType` import in `syncTransactions.ts`). No data, schema, or migration impact: `ProviderAccountIdentity` and `FinancialAccount.plaidAccountId` are both untouched by this step.

## Validation results

| Check | Result |
|---|---|
| `git diff --stat` scope check | Only `app/api/plaid/exchange-token/route.ts` (28 insertions, 6 deletions) and `lib/plaid/syncTransactions.ts` (29 insertions, 4 deletions) changed |
| `npx tsc --noEmit` | Clean, 0 errors |
| `npm run lint` | 0 errors, 4 warnings — all pre-existing `@next/next/no-img-element` warnings in unrelated files (`components/dashboard/AccountModal.tsx:45`, `components/dashboard/TotpSection.tsx:152`, `components/ui/CoinIcon.tsx:78,97`); none in either touched file |
| `npx tsx scripts/verify-provider-account-identity-backfill.ts --verbose` | **Could not run** — same sandbox blocker as Steps 3B–3E: `PrismaClientInitializationError: Prisma Client could not locate the Query Engine for runtime "linux-arm64-openssl-3.0.x" ... Prisma Client was generated for "darwin-arm64"`. Expected, not caused by this change — no live DB access from this sandbox. |

Run locally to close out validation:

```
npx tsx scripts/verify-provider-account-identity-backfill.ts --verbose
```

Suggested functional check: run a manual "Sync Now" on a linked item and confirm transactions still post to the right accounts, plus a manual refresh/holdings update on an investment account. Watch logs for any `[plaid][D2-3F]` warning — its presence would mean the identity-table lookup missed for an account the legacy field still finds, a coverage gap worth investigating before Step 3G removes the fallback (now relevant across all of 3C–3F).

---

**All Step 3A-identified eligible PLAID read sites are now cut over (3C, 3D, 3E, 3F). Step 3G (fallback removal) is a separate, later decision — not started here.**
