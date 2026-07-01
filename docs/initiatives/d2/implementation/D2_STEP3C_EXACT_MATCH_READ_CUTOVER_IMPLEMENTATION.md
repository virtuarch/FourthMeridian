> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 3C — exchange-token Exact-Match Read Cutover (Implementation + Validation)

Status: **implemented and validated within sandbox limits. No schema changes. No migrations. No WALLET/MANUAL/CSV touched.**

## Impact map

Only one file changed: `app/api/plaid/exchange-token/route.ts`. Confirmed via `git status --short` — the only modified file (plus the pre-existing untracked Step 3A/3B docs).

| Area | Touched? |
|---|---|
| Exact-match resolution (this step's target) | Yes — now tries `ProviderAccountIdentity` first, falls back to `FinancialAccount.plaidAccountId` |
| Fingerprint fallback logic | No — untouched, still consumes whatever `fa` resolves to |
| Create-new-account branch | No — untouched |
| Holdings cross-reference lookup (same file) | No — explicitly excluded from this step's scope |
| `lib/plaid/refresh.ts` | No |
| `lib/plaid/syncTransactions.ts` | No |
| `lib/accounts/reconcile.ts` | No |
| Schema / migrations | No |
| WALLET / MANUAL / CSV | No |

## Code change

Exact-match block in `app/api/plaid/exchange-token/route.ts` now reads:

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
      `[plaid][D2-3C] ProviderAccountIdentity miss, legacy plaidAccountId hit — financialAccountId=${fa.id} externalAccountId=${acct.account_id}. Coverage gap; investigate before removing fallback.`
    );
  }
}
```

Everything downstream (`if (fa) { ...update... } else { ...fingerprint resolution... }`) is unchanged and consumes `fa` exactly as before. `ProviderType` was already imported in this file from Step 2A — no new import needed. The Step 2A dual-write call later in the file is untouched.

**Why fallback-first, not a hard replacement:** per Step 3A §B Risk 1, a `FinancialAccount` row could have `plaidAccountId` set but no identity row yet (pre-backfill account, or a silently-failed dual-write). Trying the identity table first and falling back to the legacy field means a coverage gap degrades to today's existing behavior instead of a wrong duplicate-create. The `console.warn` makes any such gap visible without affecting behavior, so gaps can be found and fixed before the fallback is ever removed (Step 3G).

## Rollback plan

Pure code revert — delete the `ProviderAccountIdentity` lookup block, restore the single `findUnique({ plaidAccountId })` line. No data, schema, or migration impact either direction: `ProviderAccountIdentity` and `FinancialAccount.plaidAccountId` are both untouched by this step, and the fallback-first design never created a hard dependency on the new table.

## Validation results

| Check | Result |
|---|---|
| `git status --short` scope check | Only `app/api/plaid/exchange-token/route.ts` modified |
| `npx tsc --noEmit` | Clean, 0 errors |
| `npm run lint` | 0 errors, 4 warnings — all pre-existing `@next/next/no-img-element` warnings in unrelated files (`components/dashboard/AccountModal.tsx:45`, `components/dashboard/TotpSection.tsx:152`, `components/ui/CoinIcon.tsx:78,97`); none in the touched file |
| `npx tsx scripts/verify-provider-account-identity-backfill.ts --verbose` | **Could not run** — same sandbox blocker as Step 3B: `PrismaClientInitializationError: Prisma Client could not locate the Query Engine for runtime "linux-arm64-openssl-3.0.x" ... Prisma Client was generated for "darwin-arm64"`. Expected, not caused by this change — no live DB access from this sandbox. |

Run locally to close out validation:

```
npx tsx scripts/verify-provider-account-identity-backfill.ts --verbose
```

Suggested functional check: relink a Plaid sandbox institution covering the 3 existing accounts and confirm the route resolves them as before (update, not a duplicate create). Watch logs for any `[plaid][D2-3C]` warning — its presence would mean the identity-table lookup missed for an account the legacy field still finds, a coverage gap worth investigating before Step 3G removes the fallback.

---

**Stopping here per scope. No further read-cutover steps (3D+) started.**
