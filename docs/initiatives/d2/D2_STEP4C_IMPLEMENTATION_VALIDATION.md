# D2 Step 4C — Shared Transaction Fingerprint Helper: Implementation + Validation

Status: **implemented exactly as scoped in `D2_STEP4C_TRANSACTION_FINGERPRINTING_INVESTIGATION.md`. Pure extraction. No schema fields added. No migrations. No import routes. No UI. No 4D work. No persisted `fingerprintHash`. No change to duplicate-matching semantics.**

## 1. Implementation summary

`lib/plaid/syncTransactions.ts`'s inline `normalizeMerchantKey()` and `findByFingerprint()` — the transaction-level fingerprint fallback used when a Plaid `transaction_id` exact match misses — were extracted, unchanged, into a new shared module: `lib/transactions/fingerprint.ts`. `syncTransactions.ts` now imports `findByFingerprint` from that module instead of defining it locally; its one call site (line 238, inside the added/modified transaction loop) is untouched — same arguments, same position in the exact-match → fingerprint-fallback → create flow, same return handling.

This gives future import sources (CSV, Excel, QuickBooks — D2 Step 4D) one shared matcher to call instead of each writing an independent implementation, which was the literal goal stated in `D2_ROADMAP.md`'s 4C entry and the investigation report's recommendation. Per that report's explicit scope split, this step implements **only** the helper-extraction half of 4C (zero schema impact) — the separate, larger question of a persisted `fingerprintHash` column was recommended against being bundled into 4C and was not touched here.

`lib/accounts/reconcile.ts`'s account-level fingerprint matcher (`findCandidatesByFingerprint`, mask/institution/name-based) was **not** re-pointed onto anything — the investigation report flagged that as explicitly optional and "a smaller win than it sounds" since the two matchers key on disjoint field sets. Not done in this step; `reconcile.ts` is unmodified.

## 2. Exact files changed

| File | Change |
|---|---|
| `lib/transactions/fingerprint.ts` | **New.** `normalizeMerchantKey()` and `findByFingerprint()`, moved verbatim from `syncTransactions.ts` (same logic, same query shape, same in-memory narrowing, same ambiguous-match warning text). Exports both, plus a `TransactionFingerprintCandidate` type matching the original inline return-type shape (`{ id, plaidTransactionId }`). |
| `lib/plaid/syncTransactions.ts` | **Modified.** Removed the two inline function definitions; added `import { findByFingerprint } from "@/lib/transactions/fingerprint"`; added one header-comment bullet noting the D2 Step 4C move (no behavior implication, documentation of the relocation only). The call site and every other line of sync logic are untouched. |

```
 lib/plaid/syncTransactions.ts | 56 ++++++-------------------------------------
 1 file changed, 7 insertions(+), 49 deletions(-)
 lib/transactions/fingerprint.ts | new file (76 lines)
```

No other file touched. In particular: no file under `prisma/`, `app/api/`, or `components/` changed.

## 3. Behavior-preservation check

- Function bodies of `normalizeMerchantKey` and `findByFingerprint` are byte-for-byte identical to the pre-move versions, including the `console.warn` text (`[plaid sync] fingerprint match ambiguous — ...`) — left as-is rather than rebranded to a generic prefix, since changing observable log output is itself a behavior change and out of scope here.
- The call site in `syncTransactions.ts` (`findByFingerprint(financialAccountId, date, amount, merchant, txn.pending)`) is unchanged — same five positional arguments, same place in the exact-match → fingerprint → create branch, same handling of the result (`updatedByFingerprint` counter, the same warning log, the same `continue`).
- `db` import in `syncTransactions.ts` remains in use elsewhere in the file (PlaidItem/account/transaction reads and writes outside the fingerprint helper) — not left dangling, confirmed by `tsc`/`lint` both passing with no unused-import diagnostics.
- No change to `findCandidatesByFingerprint`/`pickCanonicalAndMerge`/`mergeArchivedDuplicateIntoCanonical` in `reconcile.ts` — that file is untouched.

## 4. Manual validation (no test framework in this project)

Checked first, since the task asked for tests "if the project already has a nearby test pattern": repo-wide search found no Jest/Vitest/Mocha/Playwright/Cypress dependency in `package.json`, no `test` script, and zero `*.test.*`/`*.spec.*`/`__tests__` files anywhere in the repo. There is no nearby test pattern to extend, and introducing a test framework is its own decision, well outside "extract this helper" scope. Documenting manual validation instead, per the task's own fallback instruction:

- **Static/behavioral equivalence:** the extracted functions are textually identical to the originals (verified via diff, §3) — there is no logic for a manual run to diverge on. The only change is *where* the code lives, not what it does.
- **Compile-time check:** `tsc --noEmit` passing confirms the import path resolves, the extracted function's inferred types match the call site's expectations exactly as before (same five-argument call, same `Promise<{ id, plaidTransactionId } | null>` shape consumed the same way).
- **DB reachability:** unchanged from every prior step — `DATABASE_URL` points at `localhost:5432`, unreachable from this sandbox, so no live sync run could be executed here. Recommend running one real "Sync Now" pass locally (`app/api/plaid/sync/route.ts`) against an account with at least one already-fingerprint-matched transaction in its history, and confirming the `created`/`updatedByPlaidId`/`updatedByFingerprint`/`skippedMissingAccount` counters in the log line (`syncTransactions.ts`'s final `console.log`) come out identical to a pre-change baseline run against the same data. That comparison is the most direct behavioral proof available, and it's a local-only check given the sandbox's DB-reachability limitation already documented in every prior D2/D1 step.

## 5. Validation results

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **Clean — exit code 0, zero errors.** |
| `npm run lint` | **Clean — 0 errors, 4 warnings**, all 4 the same pre-existing `@next/next/no-img-element` warnings in `AccountModal.tsx`/`TotpSection.tsx`/`CoinIcon.tsx` seen in every prior step's validation — none in the two files touched here. |
| `git diff --stat` | `lib/plaid/syncTransactions.ts` — 7 insertions, 49 deletions (net removal, as expected for an extraction). |
| `git status --short` (untracked) | `lib/transactions/fingerprint.ts` — one new file, as planned. |
| Scope check | No file under `prisma/`, `app/`, or `components/` touched. No migration directory created. No route added. |

## 6. Confirmation: 4D / import pipeline / schema work not started

- No schema field added — `prisma/schema.prisma` is unmodified (not in `git status`).
- No migration created — no new `prisma/migrations/` directory.
- No `fingerprintHash` column, persisted or otherwise — the shared module exposes only the same in-memory, query-then-filter matching the original had; nothing new is stored.
- No import route, no upload endpoint, no CSV/Excel/QuickBooks parsing — none of `app/api/` was touched.
- No UI — none of `components/` was touched.
- No change to duplicate-matching semantics — same fields compared, same normalization, same fallback order, same "first match wins, log if ambiguous" behavior.
- `lib/accounts/reconcile.ts` (the account-level matcher) is untouched — re-pointing it onto shared primitives was explicitly optional per the investigation report and was not attempted.

## 7. Scope discipline confirmed

- Extraction only — `findByFingerprint`/`normalizeMerchantKey` moved, not rewritten.
- `D2_ROADMAP.md`'s 4C row updated to ✅, pointing at this report and the investigation report (same pattern as every prior completed step) — see diff below. No other documentation file touched.

---

**Stopping here per scope. 4D (import pipeline) remains not started and not approved.**
