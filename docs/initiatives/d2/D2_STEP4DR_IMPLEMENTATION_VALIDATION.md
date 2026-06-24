# D2 Step 4D-R — Transaction Read Path Fix: Implementation + Validation

Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`.

Implements §7 of `D2_STEP4DR_TRANSACTION_READ_PATH_AUDIT_INVESTIGATION.md` exactly: the 8 `where`-clause additions across the 5 files that needed edits (6 files were in scope for review; `syncTransactions.ts` was confirmed to need none). No schema change, no migration, no rollback implementation, no import/CSV/Excel/QuickBooks/UI/provider-adapter work.

## 1. Exact files changed

| File | What changed |
|---|---|
| `lib/transactions/fingerprint.ts` | `findByFingerprint()` |
| `lib/imports/csv.ts` | `resolveFingerprintOutcome()` — 2 queries |
| `lib/data/transactions.ts` | `getTransactions()`, `getDebtTransactions()`, `getInvestmentTransactions()` — 1 query each + module header comment |
| `app/api/accounts/[id]/transactions/route.ts` | the route's `db.transaction.findMany()` |
| `lib/accounts/reconcile.ts` | `pickCanonicalAndMerge()`'s `count()`, plus an explanatory comment (no logic change) on `mergeArchivedDuplicateIntoCanonical()`'s `updateMany()` |

5 files modified, 8 `where`-clause additions, 55 insertions / 5 deletions total (`git diff --stat`). No file outside this set was touched; `prisma/` diff is empty.

## 2. Exact read paths updated (the 8 additions)

1. **`fingerprint.ts:62`** `findByFingerprint()` — added `deletedAt: null` to the candidates `where`. Highest-priority fix per the audit's §3: this is the shared chokepoint both Plaid sync and CSV/Excel import call through, and was the one site capable of permanently losing data (a soft-deleted row silently "adopted" by a later Plaid sync, gaining `plaidTransactionId` without `deletedAt` ever being cleared).
2. **`csv.ts:312`** `resolveFingerprintOutcome()` exact-`externalTransactionId` lookup — added `deletedAt: null`. Closes the re-import-after-rollback gap: without this, re-uploading the same file after a rollback would find the dead row and no-op instead of recreating it.
3. **`csv.ts:322`** `resolveFingerprintOutcome()` ambiguity-candidates query — added `deletedAt: null`. Kept in sync with #1's candidate shape so the two never disagree on what counts as a match.
4. **`lib/data/transactions.ts:36`** `getTransactions()` — added a top-level `deletedAt: null`, ANDed with the existing OR/category filter. Banking dashboard.
5. **`lib/data/transactions.ts:67`** `getDebtTransactions()` — same addition. Credit page.
6. **`lib/data/transactions.ts:96`** `getInvestmentTransactions()` — same addition. Investments page.
7. **`app/api/accounts/[id]/transactions/route.ts:40`** — added `deletedAt: null` alongside the existing `OR: [{accountId}, {financialAccountId}]`. Account-detail modal.
8. **`reconcile.ts:224`** `pickCanonicalAndMerge()` → `count()` — added `deletedAt: null`. Prevents a rolled-back import's dead rows from inflating an account's apparent "history" when reconcile.ts picks which duplicate-account candidate is canonical.

All 8 additions match the audit doc's §7 priority list verbatim — same files, same call sites, same fix shape (`where`-clause filter only, no new query, no schema field).

## 3. Read paths intentionally left unchanged, and why

- **`lib/plaid/syncTransactions.ts:224`, `findUnique` by `plaidTransactionId`.** Confirmed safe by construction (audit §4): a row only ever gets `plaidTransactionId` set by Plaid sync's own create/update paths, and rollback's adopted design (`importBatchId` set only on rows an import batch genuinely creates) means a row can never carry both `plaidTransactionId` and `importBatchId`. A row with `plaidTransactionId` can therefore never be the target of an import rollback's soft-delete, so this exact-match lookup can never encounter a soft-deleted row today. Verified untouched: `git diff --stat -- lib/plaid/syncTransactions.ts` is empty.
- **`reconcile.ts:339`, `mergeArchivedDuplicateIntoCanonical()`'s `updateMany`.** Per your explicit instruction and the audit's §5: this re-points every transaction (including soft-deleted ones) from a losing duplicate account to the winning canonical account during an account merge. Filtering it to `deletedAt: null` would orphan a soft-deleted row on the archived loser account, where it could resurface incorrectly if that loser is ever individually restored. Left as-is; only an explanatory comment was added, no logic change — confirmed by the diff above (the `where`/`data` shape is byte-for-byte unchanged).
- **`prisma/schema.prisma` and all migrations.** Untouched — `Transaction.deletedAt` already exists from 4B; this slice is a `where`-clause-only diff. `git diff --stat -- prisma/` is empty.
- **Account-level visibility gap in the account-detail route.** Noted but not touched: `app/api/accounts/[id]/transactions/route.ts`'s `SpaceAccountLink` resolution (lines 23–26) doesn't filter `financialAccount.deletedAt`, unlike `lib/data/transactions.ts`'s reads. That's a pre-existing gap unrelated to import rollback (it's about archived-account visibility, not rolled-back-transaction visibility) and is outside this fix's scope per your "do not modify... UI" instruction and the audit's own framing — flagging it here for visibility, not fixing it.
- **CSV/Excel/QuickBooks parsing logic, import route body, UI, provider adapters.** Untouched, per scope. Only the two `resolveFingerprintOutcome` queries inside `csv.ts` were touched — no other line in that file changed.

## 4. Validation

**`npx tsc --noEmit`** — clean, exit 0.

**`npm run lint`** — 0 errors, 4 pre-existing warnings (`<img>` in `AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx` — untouched by this change, identical to every prior D2 step's baseline).

**Scope check** — `git status --short`: exactly the 5 files in §1 modified, plus the already-untracked audit doc from the prior investigation pass. `git diff --stat -- prisma/` empty. No migration directory created. No file under `lib/imports/excel.ts`, any `app/api/.../import/`, or any UI component touched.

**No live-DB validation was possible or attempted** — consistent with every prior D2 step, this sandbox can't reach the Postgres instance (`DATABASE_URL` points at `localhost:5432`) or regenerate a matching Prisma engine binary. The change is a `where`-clause literal addition (`deletedAt: null`) to existing, already-typed Prisma queries; `tsc --noEmit` passing confirms the field exists on `Transaction` and the shape is valid against the generated client. No new runtime logic was introduced that pure-function tests could exercise — every change is "add one more AND condition to an existing filter," verified by code-reading the diff above rather than executed.

**One unrelated sandbox note:** `git diff --stat` triggered a benign `unable to unlink .git/index.lock: Operation not permitted` warning — the same virtiofs mount-bridge restriction documented in `D2_STEP4D2_IMPLEMENTATION_VALIDATION.md` §5 (this side of the bridge can't `unlink`/`rm`). All git read commands (`status`, `diff`, `diff --stat`) completed and returned correct output despite the warning; a stale 0-byte `.git/index.lock` is left in the working tree and should be removed from your end (`rm .git/index.lock`) before your next local git operation, same remediation as the leftover scratch files 4D-2 flagged.

## 5. Rollback-readiness assessment after this fix

**Closed:** the data-loss path described in the audit's §3 — Plaid sync silently absorbing a rolled-back row — is now closed at its one chokepoint (`findByFingerprint`). The re-import-after-rollback no-op gap is closed (`csv.ts`'s two queries). All four display read paths (banking, credit, investments, account-detail) now exclude soft-deleted rows. The account-merge canonical-selection decision no longer counts dead rows as history.

**Still required before rollback (`ImportBatch.status = ROLLED_BACK`, 4D-3) can ship:**
- The rollback write path itself does not exist yet — nothing in this slice adds a route, a status transition, or the soft-delete write. This was explicitly out of scope here and remains a separate, separately-approved implementation step.
- This fix has not been validated against a live database (sandbox limitation, §4) — recommend a local validation pass once `npx prisma generate`/`migrate dev` can run against a reachable Postgres instance, exercising the exact scenario the audit's §7 validation strategy named: create via CSV import → roll back (once 4D-3 exists) → run a real Plaid sync against the same fingerprint inputs → confirm a new row is created rather than the dead one being reused.
- The pre-existing account-level visibility gap noted in §3 (the account-detail route's `SpaceAccountLink` lookup not filtering `financialAccount.deletedAt`) is unrelated to rollback readiness but is a known, named gap if anyone revisits that route.

**Net assessment:** the read-path precondition the original 4D investigation (§3/§7) and the 4D-R audit named is now satisfied for all 8 identified sites. Rollback (4D-3) is unblocked from this specific precondition; it still needs its own checklist, impact map, and approval before any code is written, per the project's standing working style.

---

**Stopping here per scope. No rollback implementation. No schema changes. No migrations. Validated via `tsc --noEmit` (clean) and `npm run lint` (0 errors). Scope confirmed via `git status --short` / `git diff --stat` — exactly the 5 files above, plus the pre-existing untracked audit doc.**
