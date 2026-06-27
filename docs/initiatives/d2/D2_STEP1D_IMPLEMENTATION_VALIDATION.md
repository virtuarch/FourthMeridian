# D2 Step 1D — ProviderAccountIdentity Multi-Account Correction: Implementation & Validation

Status: **implemented in code. Migration not generated/applied in this sandbox — see
Validation summary. Stop point per instruction: do not continue into WALLET dual-write (Step 2).**

Implements exactly the schema correction approved in
`D2_STEP1D_PROVIDER_ACCOUNT_IDENTITY_MULTI_ACCOUNT_CORRECTION.md` §2, plus the one
unavoidable follow-on fix discovered during implementation (below).

---

## 1. Files changed

| File | Change |
|---|---|
| `prisma/schema.prisma` | `ProviderAccountIdentity.@@unique([provider, externalAccountId])` → `@@unique([provider, externalAccountId, financialAccountId])`. Added second constraint `@@unique([provider, financialAccountId])`. Doc comment explaining both, pointing at this initiative's docs. |
| `lib/accounts/reconcile.ts` | One `findUnique` → `findFirst` (line ~89), filter flattened out of the now-gone `provider_externalAccountId` compound-key wrapper. |
| `lib/plaid/syncTransactions.ts` | Same, one call site (line ~172). |
| `lib/plaid/refresh.ts` | Same, two call sites (balance loop + holdings loop). |
| `app/api/plaid/exchange-token/route.ts` | Same, two call sites (initial import + holdings). |

**Not changed:** `lib/accounts/provider-identity.ts`, `lib/accounts/dualWriteProviderAccountIdentity` (the create/find-by-`{financialAccountId, provider}` helper was already scoped correctly and needed no edit), any WALLET route, any UI, any other model.

## 2. Why the five extra files were touched (not just schema.prisma)

Scoped in as "only the files required for the schema correction" — discovered mid-implementation, reported to you, and fixed only after your approval (you chose "fix all 6 now").

Prisma names a composite-unique key after its field list. Changing the constraint's fields renames the generated key from `provider_externalAccountId` to `provider_externalAccountId_financialAccountId`, and `findUnique` requires supplying every field of whichever named key it targets. Six existing `findUnique` calls across these four files looked up a `ProviderAccountIdentity` row by `(provider, externalAccountId)` alone — that's the whole point of the lookup, they don't have `financialAccountId` yet. There's no schema variant that avoids this: any constraint that lets WALLET have multiple `FinancialAccount`s per address while PLAID keeps one global row makes a two-field-only `findUnique` impossible by construction.

Fix applied: `findUnique` → `findFirst`, same `where` values (flattened out of the compound-key object, since `findFirst`'s `where` is a plain filter, not a unique-input shape). Zero behavior change for PLAID — `FinancialAccount.plaidAccountId` is still independently `@unique`, so at most one row can ever match in practice; `findFirst` and `findUnique` return the same row. Each site got a one-line comment pointing back to this doc.

## 3. Migration summary

**Could not generate or apply in this sandbox** — see §4. Expected migration, based on direct comparison against the original `20260623221124_d2_provider_account_identity/migration.sql` (which created `ProviderAccountIdentity_provider_externalAccountId_key` on `(provider, externalAccountId)`):

```sql
DROP INDEX "ProviderAccountIdentity_provider_externalAccountId_key";
CREATE UNIQUE INDEX "ProviderAccountIdentity_provider_externalAccountId_financialAccountId_key"
  ON "ProviderAccountIdentity"("provider", "externalAccountId", "financialAccountId");
CREATE UNIQUE INDEX "ProviderAccountIdentity_provider_financialAccountId_key"
  ON "ProviderAccountIdentity"("provider", "financialAccountId");
```

Drop one index, create two. No column add/drop, no table change, no data statement. **Before running `npx prisma migrate dev` on your machine, read the generated SQL and confirm it matches this shape exactly** — if it proposes anything else (a column change, a data backfill, a table rewrite), stop and don't apply it; that would mean something about the live schema differs from what this review assumed.

No data migration needed: relaxing/adding unique constraints can't violate rows that already exist (it's removing a restriction, not adding one), and the second constraint is additive over today's data.

## 4. Validation summary

| Check | Result |
|---|---|
| `npx prisma generate` | **Blocked.** `403 Forbidden` fetching engine binaries from `binaries.prisma.sh`, including with `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` set. Sandbox has no egress to that host. |
| `npx prisma migrate dev` | **Blocked.** Same engine-fetch failure, plus `localhost:5432` connection refused — no live Postgres reachable from this sandbox. |
| `npx tsc --noEmit` | Ran clean (no errors), both before and after the six-file fix. **Not a meaningful signal either way** — `node_modules/.prisma/client` is a client generated on your machine before this session's schema edit (darwin-arm64 binaries), so the type-checker is checking against the *old* generated types, not the new constraint shape. It would have passed even without the six-file fix. |
| `npm run lint` | Ran clean — 0 errors, 4 pre-existing `no-img-element` warnings unrelated to this change, unchanged before/after. |

**What you need to run locally** to get real signal: `npx prisma generate` (regenerates the client against the new schema), then `npx prisma migrate dev` (read the diff against §3 before confirming), then `npx tsc --noEmit` again with the fresh client — that run is the one that actually proves the six call sites compile. I'd expect it to pass given the fix applied, but I have not been able to confirm it directly in this sandbox, consistent with every prior D2 step's documented environment limitation.

## 5. Scope confirmation

- No WALLET dual-write call sites added. `app/api/accounts/wallet/route.ts` untouched.
- No collision-handling, re-share, or reactivate logic added anywhere.
- No signature/ownership verification added.
- No Step 2 work performed.
- No UI touched.
- No legacy table or column removed.
- No new tables (`CreatorPayout`, billing, `Conversation`, `Message`, support-ticket, etc.) added.
- Net diff: one schema file (constraint correction), five application files (mechanical `findUnique`→`findFirst`, no logic change), one new doc, one superseded-doc banner already in place from the prior turn.

---

Stopping here per instruction. D2 Step 2 (WALLET dual-write) resumes only on a separate go-ahead.
