# D2.x — Payroll Disappearance: Proof Before Cursor Reset — Investigation

**Status:** Investigation only. No implementation.
**New decisive evidence:** *multiple manual refreshes do NOT recover it.*

---

## What the "refreshes don't recover it" evidence proves (high confidence)

`syncTransactionsForItem` resumes from the **saved** `PlaidItem.cursor` and, after the loop, writes `next_cursor` (`:310-312`). A manual refresh = an **incremental** `/transactions/sync` from that saved cursor. Plaid only returns changes **since** the cursor. Therefore:

- If the posted payroll had merely **lagged** (never delivered yet), a refresh would deliver it → it would recover. It does **not**.
- So the posted payroll **was delivered**, the cursor **advanced past it**, and Plaid will not re-send it incrementally (it isn't new/modified/removed anymore).

**Conclusion (confidence: HIGH):** this is a **"delivered-but-not-stored"** loss, not a lag and not "Plaid never sent it." That rules out the timing/lag branch and points squarely at the pipeline dropping it *once* while the cursor moved on.

## Every path a transaction can disappear permanently (code-proven, `syncTransactions.ts:203-308`)

Per page, the loop processes `[...added, ...modified]`, then `removed`, then advances the cursor (`:307`). Disappearance paths:

1. **Account-resolution skip** (`:205-211`): `resolveFinancialAccountId(txn.account_id)` null → `skippedMissingAccount++; continue;`. Not stored; cursor advances.
2. **Upsert error** (`:293-295`): `create`/`update` throws → caught, logged, `continue`. Not stored; cursor advances.
3. **`removed[]` HARD delete** (`:300-304`): `deleteMany` on `plaidTransactionId`. Deletes the pending row; if the posted was dropped by (1)/(2) or split across syncs, the transaction is gone with **no tombstone**.
4. **Fingerprint over-match / merge** (`:276-288`): a posted row can `update` a *different* existing row that shares `(financialAccountId, date, amount, merchant, pending)`, overwriting its `plaidTransactionId` — merging two distinct transactions into one (one disappears). Needs a coincidental twin; low for a unique payroll.

Every path reduces to the same shape: **the posted was not inserted, while the pending was removed** — and the cursor advanced regardless.

## Q1–Q3 — Which one actually happened? (honest limits)

**We cannot prove the exact path from the current DB.** The `removed[]` hard delete (path 3) erased the pending with no `deletedAt`, and **no removed-ids are persisted** (only a count). So the pending is gone without a trace, and if the posted was skipped it left only a **log line**, not a row. The DB today can only show *absence*, which is consistent with several paths.

What we *can* narrow with confidence:
- **HIGH:** delivered + cursor-advanced + not stored (from the refresh evidence).
- **Account-resolution skip (path 1) is UNLIKELY (confidence: LOW)** — "every previous payroll imported normally" and other Chase-checking transactions exist, so that account's `account_id` **does** resolve; the posted payroll shares that `account_id`, so a persistent resolution skip would have dropped *many* rows, not one.
- Therefore the residual, ranked (see §Q8).

## Q4 — What evidence could distinguish the paths?

- **Server logs from the July-2 Chase sync** (if retained) are the only direct proof:
  - path 1 → `"[plaid sync] no FinancialAccount for plaidAccountId … — skipping transaction …"`
  - path 2 → `"[plaid sync] failed to upsert transaction …"`
  - path 4 → `"[plaid sync] fingerprint match — reusing existing transaction … for new plaidTransactionId …"`
- **`AuditLog` (`PLAID_SYNC`/`PLAID_REFRESH`) metadata** stores only counts (`totalRemoved`, `totalAdded`, …) — a non-zero `totalRemoved` near July 2 is *circumstantial* support that a pending was removed, but carries **no ids**.
```sql
SELECT "createdAt", action, metadata FROM "AuditLog"
WHERE action IN ('PLAID_SYNC','PLAID_REFRESH') AND "createdAt" BETWEEN '2026-06-30' AND '2026-07-05'
ORDER BY "createdAt";
```
- **The definitive experiment is a controlled cursor-reset re-sync with logging** (see Q7): it re-delivers the posted payroll and shows whether it inserts (recovered) or skips (path 1/2 reproduces) — proving the hypothesis *and* recovering it in one move.

## Q5 — Every permanent-disappearance path

Paths 1–4 above. There is **no** guard that a pending is deleted only after its posted successor is stored, and **no** `pending_transaction_id` reconciliation, so any single dropped insert coinciding with a `removed[]` = permanent loss.

## Q6/Q7 — Cursor reset: semantics, safety, duplicate risk

**What resetting only the Chase cursor does:** set that one `PlaidItem.cursor = NULL`; the next `syncTransactionsForItem` calls `/transactions/sync` with **no cursor**, so Plaid **replays the full available window** for that item (bounded by the immutable `days_requested=730` and the account's actual history) as **`added[]`**, paginated on `has_more`. It sends **no `removed[]`** and generally **no `modified[]`** (everything is "added" from a fresh cursor). It touches **only** transactions for **that one item** — other institutions' cursors and data are untouched. **Balances are unaffected** (separate `accountsGet` endpoint; a refresh updates them as normal). **Current pending** transactions are re-delivered as `added[]` (whatever is pending *now*); the July-2 payroll, now posted, is delivered as a **posted** `added[]` row.

**Why it's the smallest safe recovery — duplicate protection (code-proven):** on the full replay, each re-delivered transaction is matched before insert:
- `findUnique(plaidTransactionId)` hit → **update in place** (`:267-271`) — existing rows are refreshed, **not duplicated**.
- miss → `findByFingerprint` (`:276-288`) → reuses the row if `(fa, date, amount, merchant, pending)` matches — catches `plaidTransactionId` changes without duplicating.
- only a genuinely new row (the missing posted payroll) → `create` (`:291`).
So a replay is **idempotent** for everything already stored and **inserts only** the missing payroll. **Residual duplicate risk (LOW):** a transaction whose `plaidTransactionId` changed *and* whose fingerprint no longer matches (amount/date/merchant/pending drift) could double-insert — uncommon on a stable account.

**Proof it is smallest/safe:** it's a single-field write to one row plus a re-sync that reuses the existing idempotent pipeline — no schema change, no data deletion, no effect on other items. It is strictly additive/corrective.

## Q8 — If the cursor reset does NOT recover it, ranked remaining causes

1. **Plaid does not expose this deposit as a transaction on the account (balance-only)** — *confidence: MEDIUM.* Some direct-deposit/payroll or internal postings appear in `balances.current` but not in `/transactions`. A full replay would then re-deliver everything **except** the payroll → nothing to insert → unrecoverable via Plaid; the reconstruction limitation for this deposit is fundamental. Distinguishing sign: the replay's `added[]` (logged counts) contains no ~$5.2k Vectrus row.
2. **Persistent account-resolution skip on this specific `account_id`** (path 1) — *confidence: LOW-MEDIUM.* Only if the posted payroll's `account_id` differs from the one other Chase txns use (e.g. a sub-account). Sign: the replay logs `"no FinancialAccount for plaidAccountId <X>"` for a **new** `account_id`. Fix: repair `ProviderAccountIdentity` (`scripts/backfill-provider-account-identity.ts`) then re-sync.
3. **Fingerprint merge into another row** (path 4) — *confidence: LOW.* The payroll amount would now live on a *different* row (wrong merchant/category). Sign: a ~$5.2k row exists but mislabeled.
4. **`days_requested` window** — *confidence: VERY LOW.* July 2 is days old; well inside 730.

## Q9 — Plaid edge case, or a Fourth Meridian correctness bug? **A real correctness bug in the FM pipeline, triggered by (not caused by) normal Plaid behavior.**

The Plaid pending→posted transition (reissue a `transaction_id`; send the old id in `removed[]`) is **standard, documented behavior**. What turns it into permanent data loss is the pipeline:
- **Hard delete on `removed[]` with no tombstone** (`:302`) — no soft delete, no audit trail, no recoverability.
- **No `pending_transaction_id` reconciliation** — the pipeline deletes a pending without knowing/waiting for its posted successor.
- **Silent skip + unconditional cursor advance** (paths 1–2, `:307`) — a dropped transaction leaves only a log line, and the cursor moves past it.
- **No "delete the pending only if the posted landed" guard.**

Individually survivable; **together** they create a data-loss window that any normal Plaid transition can trip if a single insert is dropped. So: **Plaid = the trigger; Fourth Meridian's sync pipeline = the correctness bug.** The durable fix is pipeline hardening (soft-delete removed rows; store/reconcile `pending_transaction_id`; persist removed ids / skip reasons) — larger than, and separate from, the one-off cursor-reset recovery.

---

## Recommendation (no implementation)

1. **First, gather proof cheaply:** pull the July-2 Chase server logs (grep the three messages in Q4) and the `AuditLog` `totalRemoved`. If logs are gone, proceed to (2), which is both recovery and proof.
2. **Cursor-reset + re-sync Chase, WITH logging** — the smallest safe recovery *and* the experiment: watch the replay's `added[]` for the ~$5.2k Vectrus row and whether it inserts or skips. Insert ⇒ hypothesis confirmed and recovered; no ~$5.2k row ⇒ Q8-#1 (Plaid balance-only); skip log ⇒ Q8-#2 (identity gap).
3. **Do not repair the July-2 snapshot** until the payroll transaction is present — otherwise the reconstruction bakes in the inflated cash (prior investigation).
4. **Separately, treat the pipeline weaknesses (Q9) as a real bug** to harden, independent of this incident.

**Confidence summary:** delivered-but-not-stored — **HIGH**; specific path (upsert error vs split-sync skip vs Plaid balance-only) — **not determinable from the current DB**, resolved by the logged cursor-reset in step 2; cursor reset is the correct, safe next move with **LOW** duplicate risk.

**Stop — investigation only.**
