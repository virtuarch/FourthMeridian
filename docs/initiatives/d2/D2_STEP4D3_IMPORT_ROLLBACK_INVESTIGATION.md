# D2 Step 4D-3 — Import Rollback: Investigation

Read-only. No code, schema, migration, route, or UI changes in this slice — this report only. Builds on `D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md` §3/§7 (Option B, the original rollback design) and `D2_STEP4DR_TRANSACTION_READ_PATH_AUDIT_INVESTIGATION.md` + `D2_STEP4DR_IMPLEMENTATION_VALIDATION.md` (the read-path fix that was the named precondition for this step).

## 0. Precondition check

4D-3 was explicitly gated on the read-path audit (4D-R) being "completed and validated first" (`D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md` §3/§7). Confirmed satisfied: all 8 sites 4D-R identified now filter `Transaction.deletedAt: null` (or have a documented, deliberate exception — `reconcile.ts`'s account-merge `updateMany`). This investigation proceeds on that basis.

## 1. Where the rollback route should live

**Recommendation: `app/api/imports/[id]/rollback/route.ts`, POST, `[id]` = `ImportBatch.id`.**

No `app/api/imports/` directory exists yet — confirmed by repo-wide search; the only code that touches `ImportBatch` today is `app/api/accounts/[id]/import/route.ts` (creation) and `prisma/schema.prisma` itself. Rollback is a new top-level resource action, not a sub-action of the account-import route, for two reasons:

- `ImportBatch` already carries its own `financialAccountId` — the route doesn't need it repeated in the URL the way `POST /api/accounts/[id]/import` does (there, `[id]` is the *target* account being imported into, supplied by the client before any batch exists). For rollback, the batch *is* the resource; nesting it under `accounts/[id]/import/[batchId]/rollback` would just be redundant path segments carrying information the row itself already has.
- This mirrors the existing **action-route precedent**: `app/api/accounts/[id]/restore/route.ts` is `POST .../restore` on the resource being acted on, not nested under some other parent. Rollback is the same shape of "state-transition action on one row, identified by its own id," not a generic CRUD `DELETE` — it must not delete the `ImportBatch` row (that row is permanent history, same "do not remove ... prematurely" rule the project already applies to tables), only flip its `status` and soft-delete its child `Transaction` rows. A `DELETE` verb on `/api/imports/[id]` would be a misleading name for an operation that deletes zero `ImportBatch` rows.

A GET-list endpoint for `ImportBatch` (an import history view) does not exist either and is out of scope here — flagged in §9 as a UI-adjacent gap, not something this step needs to fill. The client can reach a batch's id today from the response `POST .../import` already returns (`importBatchId`), so an immediate "Undo this import" affordance is implementable without a list endpoint; a later "import history" page would need one, separately.

## 2. Authorization model

**Current precedent (`POST /api/accounts/[id]/import`):** `requireUser()` (ordinary session check, not freshness-checked) + `getSpaceContext()` + an ACTIVE `SpaceAccountLink` lookup for the target `financialAccountId` in the caller's active space. No role check — any space member (`MEMBER`/`ADMIN`/`OWNER`) who can see the account can import into it.

**Recommendation for rollback — stricter than creation, on two independent axes:**

1. **Session freshness.** `lib/session.ts` defines `requireFreshUser()` specifically for "destructive... actions" where a cached, up-to-30s-stale revocation check is not an acceptable risk, and lists password change, 2FA disable, recovery-code regen, and session revocation as its existing users. Rollback soft-deletes real financial transaction data — every bit as destructive in kind, if not in security-blast-radius, as those examples. Recommend `requireFreshUser()` over the import-creation route's plain `requireUser()`.
2. **Role.** Creation has no role gate (intentionally permissive — any member can bring in their own bank file). Rollback can erase rows a *different* member's import created, in a shared Space. Recommend: allow rollback if `(caller.id === importBatch.createdByUserId) OR (caller's space role has canManage)` — i.e., undo your own import freely; undoing someone else's import requires `OWNER`/`ADMIN`. This mirrors a common "delete your own, manage everyone else's" pattern and is a closer fit than either extreme (a flat `canWrite` gate would let any member erase any other member's imported history; no gate at all repeats creation's permissiveness for an operation that's meaningfully more destructive).

**This is presented as a recommendation, not a decision** — per the project's standing "produce a checklist, wait for approval" working style, the freshness requirement and the creator-or-manager rule should be confirmed (or adjusted) before implementation, not assumed.

**Resolution mechanics**, otherwise identical to the creation route's existing pattern: look up the `ImportBatch` by `id` first (404 if missing — do this before any space check, so a nonexistent id and an id in a space the caller can't see return the same 404, avoiding an enumeration signal); then verify an ACTIVE `SpaceAccountLink` exists for `(spaceId, importBatch.financialAccountId)`, exactly the lookup `POST .../import` already performs for the same `financialAccountId`. No legacy-`Account` fallback is needed here (unlike the import route, which has one for pre-migration accounts) — `ImportBatch.financialAccountId` is a required, non-nullable FK to `FinancialAccount` only; a batch can never point at a legacy `Account`, so there is no second model to fall back and check.

## 3. Which `ImportBatchStatus` values are rollback-eligible

| Status | Eligible? | Why |
|---|---|---|
| `PENDING` | No | Batch row exists but processing hasn't started — by construction, zero `Transaction` rows can have `importBatchId` set yet (the route creates the batch, *then* loops rows; see `app/api/accounts/[id]/import/route.ts` lines 191–252). Rolling back is a guaranteed no-op; reject with 409 rather than silently succeeding on nothing, so the caller isn't told something happened when it didn't. |
| `PROCESSING` | No (with a caveat) | The batch is mid-loop. Rolling back while the create-loop is still running races the importer's own writes — a row could be created by the loop a moment after rollback's `updateMany` already ran and missed it. Reject with 409 ("import still in progress"). **Caveat, flagged not fixed:** if the route's process crashes mid-loop (an uncaught error inside the `for` loop, or the process dying outright), `status` never advances past `PROCESSING` — the route's only two exit-status writes are `COMPLETED`/`COMPLETED_WITH_ERRORS` at the very end (line 254); nothing sets `FAILED` anywhere in the current implementation, and a crash mid-loop leaves a permanently-`PROCESSING` batch with some rows already created and `importBatchId`-tagged. That batch's rows are real, orphaned-from-rollback data with no route able to touch them under a strict `PROCESSING`-is-never-eligible rule. This is a **pre-existing gap in 4D-1**, not introduced or fixed by this investigation — surfaced here because it directly bears on rollback eligibility, but resolving it (e.g., a stuck-batch reaper, or making `PROCESSING` batches older than some threshold eligible) is its own decision, not assumed into this slice. |
| `COMPLETED` | Yes | The normal case — the loop finished, some rows may have been created. |
| `COMPLETED_WITH_ERRORS` | Yes | Same as above; some rows FAILED/SKIPPED but creation proceeded for the rest. |
| `FAILED` | Yes (defensively) | Unused by any code today (confirmed: no write sets this status anywhere in the repo). Including it costs nothing — if it's ever set after a partial run, rows that *were* created before the failure still carry `importBatchId` and deserve to be rollback-eligible; if no rows were created, the query below is a safe no-op (`count: 0`). |
| `ROLLED_BACK` | Idempotent, not an error | See §10 — return success describing the already-rolled-back state rather than 409. |

## 4. Exact rollback write query

**The query:**

```ts
await db.transaction.updateMany({
  where: { importBatchId: batchId, deletedAt: null },
  data:  { deletedAt: new Date() },
});
```

**On the prompt's own question — should `financialAccountId` be included in this `where`? Recommendation: no, and this is the most important finding in this report.**

`importBatchId` is already a precise 1:1 scope: every `Transaction` row's `importBatchId` points at exactly one `ImportBatch` (a plain nullable FK, no composite key), so `WHERE importBatchId = X` is already exactly "every row batch X created" — adding `financialAccountId` to the same `where` does not narrow that set any further under normal conditions. It can, however, **wrongly narrow it** under one concrete, already-existing condition in this codebase: **account merges.**

`lib/accounts/reconcile.ts`'s `mergeArchivedDuplicateIntoCanonical()` runs `db.transaction.updateMany({ where: { financialAccountId: loserId }, data: { financialAccountId: winnerId } })` — re-pointing every transaction from a losing duplicate account onto the winning canonical one, *without touching `importBatchId`* (confirmed by re-reading the function in full; it only ever writes `financialAccountId`). If a CSV/Excel import batch ran against account A (the eventual loser) and A later gets merged into canonical account B (e.g. via the duplicate-account restore flow in `app/api/accounts/[id]/restore/route.ts`, or any future explicit "merge duplicates" action), every `Transaction` row that batch created now has `financialAccountId = B` while `ImportBatch.financialAccountId` — the batch's own record of which account it targeted — is still A, untouched (nothing re-points `ImportBatch.financialAccountId` during a merge). A rollback query that additionally filtered on `importBatch.financialAccountId` (A) would **miss every row the merge already moved to B**, silently performing a partial rollback with no error and no indication anything was skipped.

Filtering on `importBatchId` alone has no such failure mode — it follows the rows wherever a later merge relocates them, which is the correct behavior (the rows are still, unambiguously, "what this batch created," regardless of which account currently holds them).

`financialAccountId` is still useful — just not in this query. It belongs in the **authorization check** (§2: confirm the caller has an ACTIVE `SpaceAccountLink` for the batch's *recorded* `financialAccountId`, read from the `ImportBatch` row itself, never from client input) and in the **audit log metadata** (§8: recording what the batch's original target was, for the human-facing record), but not as a filter on the mutation that actually decides which rows get soft-deleted.

**Why keep `deletedAt: null` in the `where`:** it makes the `updateMany` itself idempotent at the database level — a row already soft-deleted (by an earlier rollback attempt) won't match and won't have its `deletedAt` timestamp overwritten with a newer `now()`, preserving the true original rollback moment for forensics, and making a second, redundant call to this same query a guaranteed `count: 0` no-op rather than a silent re-stamp.

## 5. `updateMany` vs. the alternative

Confirmed: `updateMany` is the right primitive (single indexed query — `@@index([importBatchId])` already exists on `Transaction` from 4B, added specifically for this query per `D2_STEP4_ROADMAP_REFINEMENT.md`'s recommendation — not an N+1 walk over `findMany` + per-row `update`). No row-level loop is needed because rollback does not need to know *which* rows it affected beyond a count (see §9 on the response payload) — it needs "soft-delete every row this batch created," which `updateMany`'s single bulk statement does exactly.

## 6. `ImportBatch.status` transition

A single read-modify-write, done as a **conditional claim** rather than an unconditional `update`, to make the whole operation self-protecting against a concurrent double-submit (two rollback requests landing at nearly the same instant — e.g. a doubled click before a UI disables its own button):

```ts
const claim = await tx.importBatch.updateMany({
  where: { id: batchId, status: { in: [ImportBatchStatus.COMPLETED, ImportBatchStatus.COMPLETED_WITH_ERRORS, ImportBatchStatus.FAILED] } },
  data:  { status: ImportBatchStatus.ROLLED_BACK },
});
```

Using `updateMany` (not `update`) here specifically so that "the batch is not in an eligible status" is a `count: 0` result to branch on, rather than a thrown not-found error — `update` requires a unique match and throws (`P2025`) if the `where` doesn't resolve, which would conflate "batch doesn't exist" with "batch exists but isn't eligible right now," two states that need different HTTP responses (404 vs. 409/200-idempotent). Only if `claim.count === 1` does the route proceed to the `Transaction.updateMany` in §4 — see §10 for why this ordering matters for idempotency under concurrency.

## 7. `completedAt` — unchanged

**Recommendation: leave `ImportBatch.completedAt` exactly as it was set at Finalize.** It records *when the import finished running* — a historical fact that rollback does not change or undo (the import did, in fact, complete at that time; rolling it back later is a separate event). Overwriting it with the rollback time would destroy that original fact with no compensating benefit, since "when was this rolled back" already has two homes that need zero schema change to provide: the new `AuditLog` row's own `createdAt` (§8), and — per-row, if ever needed — `Transaction.deletedAt` on each affected row (already set to the rollback moment by §4's query). A future, separately-approved schema slice could add `ImportBatch.rolledBackAt`/`rolledBackByUserId` for a join-free "when/who" lookup, but that is a new nullable column — out of scope for this no-schema-change investigation, and not required to answer the question today.

`importedCount`/`matchedCount`/`skippedCount`/`failedCount` are likewise left untouched for the same reason — they are immutable historical stats about what the import *did*, not a live count of what's currently still alive. "How many of this batch's created rows are currently soft-deleted" is always answerable on demand (`db.transaction.count({ where: { importBatchId, deletedAt: { not: null } } })`) without persisting a new counter.

## 8. `AuditLog` requirements

**Gap found:** `POST /api/accounts/[id]/import` writes **zero** `AuditLog` entries today — confirmed by reading the route in full; there is no `db.auditLog.create` call anywhere in it. This was already named as a known, deliberately-deferred gap in `D2_STEP4D1_IMPLEMENTATION_VALIDATION.md` ("not in the approved 'Add' list for this slice"). Rollback would therefore be the *first* audited event in the entire import lifecycle if it adds logging and creation still doesn't — worth flagging explicitly: should creation's own audit gap be closed alongside or before rollback's, so the lifecycle has a consistent before/after record? Surfacing this as a question for approval, not deciding it here.

**For rollback itself**, the existing convention (`lib/audit-actions.ts` + every site reading from it, e.g. `app/api/spaces/[id]/route.ts`'s `SPACE_TRASHED`, `app/api/accounts/[id]/restore/route.ts`'s `ACCOUNT_RESTORE`) is a flat `{ userId, spaceId, action, metadata, ipAddress }` row. Recommend adding one new constant — `IMPORT_BATCH_ROLLED_BACK` — to `AuditAction` (additive; existing constants are a plain object literal, no enum/migration involved) and writing:

```ts
await tx.auditLog.create({
  data: {
    userId:    user.id,
    spaceId,
    action:    AuditAction.IMPORT_BATCH_ROLLED_BACK,
    metadata:  {
      importBatchId:      batch.id,
      financialAccountId: batch.financialAccountId,
      source:              batch.source,
      rolledBackCount:     softDeleted.count,
    },
    ipAddress: getClientIp(req),
  },
});
```

— same shape, same `getClientIp(req)` helper (`lib/api.ts`), same `metadata` style (small, structured, summary-shaped — explicitly *not* a manifest of affected row ids, per the 4D investigation's own reasoning in its §2 on why `AuditLog` and a row-level discriminator solve different problems).

## 9. Response payload shape

Recommend extending the same shape `POST .../import` already returns (so a client that handled one already knows the other), adding two rollback-specific fields:

```json
{
  "importBatchId":  "...",
  "status":         "ROLLED_BACK",
  "rolledBackCount": 42,
  "alreadyRolledBack": false,
  "rowCount":        50,
  "importedCount":   45,
  "matchedCount":    3,
  "skippedCount":    1,
  "failedCount":     1
}
```

`rolledBackCount` is the live `updateMany` count from §4 (how many rows were actually soft-deleted *by this call*) — distinct from `importedCount`, which never changes (§7). `alreadyRolledBack` disambiguates the idempotent-replay case (§10) from a genuine first rollback, without overloading `rolledBackCount`'s meaning (on replay it's reported as `0`, since nothing was newly touched, rather than re-reporting the original count as if it just happened again).

## 10. Idempotency behavior

**Already rolled back (sequential replay):** §6's conditional `updateMany` on `ImportBatch.status` returns `claim.count === 0` (current status is `ROLLED_BACK`, not in the eligible set) — the route should short-circuit there, skip the `Transaction.updateMany` and the new `AuditLog` write entirely (nothing new happened; logging a second "rolled back" event for the same action would misrepresent the audit trail), and return 200 with `alreadyRolledBack: true`, `rolledBackCount: 0`, reading the batch's *current* row for the rest of the payload's fields.

**Already rolled back (concurrent double-submit):** the same conditional `updateMany`, run inside one `db.$transaction(async (tx) => {...})` interactive callback (this codebase already uses this exact form — `app/api/auth/register/route.ts`'s `db.$transaction(async (tx) => {...})`, and the array form is used for atomic update+audit pairs in `app/api/user/sessions/[sessionId]/route.ts`, `app/api/user/totp/disable/route.ts`, `lib/recovery-codes.ts`, among others), resolves the race at the database level: whichever request's `updateMany` actually flips `PROCESSING`-eligible-status → `ROLLED_BACK` first "wins" the claim inside its own transaction; the second request's `updateMany` (evaluated in its own transaction, after the first commits) sees the now-`ROLLED_BACK` status and gets `count: 0`, falling into the same idempotent-replay path above. No row can be double-soft-deleted and no two `AuditLog` rows are written for one logical rollback.

**Rollback failed halfway:** using the interactive `db.$transaction` callback form (not the plain array form, since step 2 needs to branch on step 1's result) means the `ImportBatch.status` flip and the `Transaction.updateMany` soft-delete and the `AuditLog.create` all commit or all roll back together at the Postgres transaction level — there is no app-visible "halfway" state where status says `ROLLED_BACK` but the rows are still live, or vice versa. If the transaction itself fails (e.g. a connection drop mid-transaction), Postgres rolls the whole thing back automatically; the batch is left exactly as it was, eligible to retry from a clean `COMPLETED`/`COMPLETED_WITH_ERRORS`/`FAILED` state — no manual cleanup, no partial-state record to reconcile.

**Batch has zero created rows** (every row was MATCHED/SKIPPED/FAILED, nothing CREATED — a real, valid outcome for, e.g., a CSV re-upload of a file already fully imported): the status claim still succeeds (`COMPLETED` → `ROLLED_BACK` is legitimate regardless of how many rows exist), the `Transaction.updateMany` returns `count: 0` (nothing to delete — not an error), and the response reports `rolledBackCount: 0`, `alreadyRolledBack: false`. Rolling back a batch that created nothing is a valid, harmless action — it just records that the (no-op) batch is now formally marked rolled back, which is correct: the *batch* existed and ran, even if it happened to create zero new rows.

## 11. Snapshot regeneration requirements

**Finding: none are needed, and this is worth stating plainly because it's the opposite of what the restore-route precedent (§1, `app/api/accounts/[id]/restore/route.ts`) would suggest by analogy.**

That route calls `regenerateSnapshotsForAccounts([id])` (`lib/snapshots/regenerate.ts`) after restoring an account, because `SpaceSnapshot`'s balance fields are recomputed from `getAccounts()` → `classifyAccounts()`, which reads `FinancialAccount.balance` — a field account restoration *does* change (a soft-deleted account's balance comes back into the live total). Import rollback is different in kind: **`FinancialAccount.balance` is never touched by CSV/Excel import, in either direction.** Confirmed by re-reading `app/api/accounts/[id]/import/route.ts` in full — the only writes in that route are `ImportBatch` (create/update) and `Transaction` (create); no `db.financialAccount.update` exists anywhere in the file. Confirmed further by repo-wide search: no code anywhere derives or writes `FinancialAccount.balance` from a sum of `Transaction` rows — `balance` is always set directly, by Plaid sync, manual entry, or wallet sync, never recomputed from transaction history.

Confirmed also that `SpaceSnapshot` is the *only* model in the schema resembling a cached/derived aggregate (`grep -i "model.*Snapshot\|model.*Spending\|model.*Cache\|model.*Aggregate\|model.*Rollup"` against the full schema returns only `SpaceSnapshot`), and it reads `FinancialAccount.balance`, never `Transaction` rows. There is no other cache to invalidate.

The dashboard/credit/investment/account-detail views that *do* read `Transaction` directly (`lib/data/transactions.ts`, the account-detail route) are live queries, not cached snapshots — and as of 4D-R, every one of them already filters `deletedAt: null`. The moment rollback's `updateMany` commits, the next page load of any of those views simply stops returning the rolled-back rows, with nothing to regenerate or invalidate in between. **Recommendation: do not call `regenerateSnapshotsForAccounts()` (or any snapshot-adjacent helper) from the rollback route** — it would be a real write with no observable effect, since nothing it touches (`SpaceSnapshot`'s balance-derived fields) changes as a result of this action.

## 12. Validation plan

No test framework exists in this project (re-confirmed, consistent with every prior D2 step). Recommend the same fixture-file-based manual validation shape every prior 4D slice used, run once 4D-3 is actually implemented (this investigation makes no code changes to validate):

1. **Imported rows disappear.** Import a fixture CSV into a scratch account (creates N rows, all `CREATED`). Call rollback. Re-load the banking dashboard, the account-detail modal, and (if any rows classified as debt/investment categories) the credit/investment views — confirm none of the N rows appear. This exercises all 4 of 4D-R's display-read-path fixes at once.
2. **Matched rows remain.** Seed one existing `Transaction` (e.g. via the existing Plaid-sync fixture path or a manual row), then import a second fixture file whose one row fingerprint-matches it (`MATCH` outcome, `importBatchId` left `null` per Option B — confirmed by re-reading `csv.ts`'s `resolveFingerprintOutcome()` and the route's `else if (result.outcome === "MATCH") { matched++; }` branch, which performs no write at all). Roll back that batch. Confirm the matched row is untouched (`deletedAt` still `null`, no field changed) — this is the core safety property Option B exists to guarantee, and the one most worth a dedicated test rather than assuming the code is correct because the design says it should be.
3. **Re-import after rollback creates fresh rows.** Re-upload the exact same fixture file used in test 1, post-rollback. Confirm N *new* `Transaction` rows are created (new ids, new `importBatchId` pointing at the new batch) rather than a no-op — this is the exact scenario 4D-R's `csv.ts` `deletedAt: null` additions exist to guarantee; confirm `resolveFingerprintOutcome()`'s exact-`externalTransactionId` lookup and ambiguity-candidate query both correctly ignore the now-soft-deleted originals.
4. **Plaid sync does not adopt rolled-back rows.** After test 1's rollback, run (or simulate, if Plaid sandbox access isn't available in whatever environment this validation runs in) a Plaid sync whose `date`/`amount`/`merchant`/`pending` would have fingerprint-matched one of the now-soft-deleted rows. Confirm a *new* `Transaction` row is created (with a fresh `plaidTransactionId`) rather than the dead row being revived/adopted — this is 4D-R's `fingerprint.ts` `deletedAt: null` addition's exact purpose; this test is the end-to-end confirmation that 4D-R's fix and 4D-3's design compose correctly.
5. **Status-transition idempotency.** Call rollback twice in sequence on the same batch — confirm the second call returns `alreadyRolledBack: true`, `rolledBackCount: 0`, and writes no second `AuditLog` row (per §10).
6. **Ineligible-status rejection.** Attempt rollback on a batch left in `PENDING` (don't let it run) — confirm 409, not a silent no-op success.

`tsc --noEmit`/`npm run lint` as the baseline gate once code exists, same as every prior step. DB-unreachability in this sandbox (confirmed in every prior D2 step; `DATABASE_URL` points at `localhost:5432`) applies identically here — none of the above can be executed from this investigation; this is the validation plan for the *implementation* step, not something run now.

---

## Deliverables (per the prompt's request list)

**Implementation checklist** (for the future, separately-approved 4D-3 implementation step — not authorization to start it):
1. Add `IMPORT_BATCH_ROLLED_BACK` to `AuditAction` (`lib/audit-actions.ts`) — and resolve the §8 open question (should `IMPORT_BATCH_CREATED`/`COMPLETED` be added alongside it, closing creation's own audit gap, or left for a separate slice).
2. Create `app/api/imports/[id]/rollback/route.ts` (§1), `POST`.
3. Resolve auth per §2 (decision needed: `requireFreshUser()` vs. `requireUser()`; creator-or-`canManage` rule vs. a flatter gate) — confirm before writing the route, not while writing it.
4. Implement the eligibility check (§3) and the interactive `db.$transaction` (§4/§6/§10).
5. Skip snapshot regeneration (§11 — confirmed unnecessary, do not add the call).
6. Wire the response payload (§9).
7. Validate per §12, once a live DB is reachable.

**Route recommendation:** `POST /api/imports/[id]/rollback`, `[id]` = `ImportBatch.id` (§1).

**Status transition rules:** `COMPLETED`/`COMPLETED_WITH_ERRORS`/`FAILED` → `ROLLED_BACK`, via a conditional `updateMany` claim; `PENDING`/`PROCESSING` rejected (409); `ROLLED_BACK` already set is idempotent-success, not an error (§3/§6/§10).

**Authorization model:** `requireFreshUser()` + ACTIVE `SpaceAccountLink` on the batch's own `financialAccountId` + (creator OR space `canManage`) — recommended, pending approval (§2).

**Exact query plan:** `Transaction.updateMany({ where: { importBatchId: batchId, deletedAt: null }, data: { deletedAt: now } })` — deliberately **without** `financialAccountId` in the `where`, per the account-merge interaction found in §4 — wrapped in the same interactive transaction as the `ImportBatch` status claim and the `AuditLog` write.

**Snapshot impact assessment:** none required — import never writes `FinancialAccount.balance`, and `SpaceSnapshot` (the only cache/aggregate model in the schema) is balance-derived, not transaction-derived (§11).

**Validation plan:** 6 fixture-driven manual scenarios (§12), to be run once implemented; no test framework exists in this project.

**Rollback plan for *this* feature** (reverting the 4D-3 implementation itself, if something's wrong post-ship — distinct from import-rollback-the-feature, which this whole report is about): purely additive once built — one new route file, one new `AuditAction` constant, zero schema changes (this investigation explicitly designed around the existing `Transaction.deletedAt`/`importBatchId` columns from 4B, adding none). Reverting the implementing commit(s) is sufficient. The one piece of state the feature can produce — `Transaction.deletedAt` set on rows, `ImportBatch.status = ROLLED_BACK` — is itself already a soft, additive marker; if the route ships and a real bug is found in its query logic, the safe mitigation is the same one 4D-R's own implementation report already named for its own feature: stop exposing the action (remove/disable the route) rather than attempting to "undo an undo," and handle any already-incorrectly-rolled-back batch as a manual, case-by-case data fix (clear the specific `deletedAt` values that were wrongly set, informed by the `AuditLog` row's `metadata.importBatchId` recorded at the time).

---

**Stopping here per scope. No code, schema, migration, route, or UI changes. Investigation only.**
