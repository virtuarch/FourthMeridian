# D2.x — Payroll Pending→Posted Disappearance — Investigation

**Status:** Investigation only. No implementation.
**Space:** `cmr456dtb0004117fjb6qavmm`. **Merchant:** Vectrus payroll, ~$5,286, July 2.
**Report:** the payroll was visible as **pending**, then vanished after posting; balance still reflects it.

**Access:** local DB unreachable here — code paths proven from source; DB checks are exact queries below.

---

## Code facts (proven)

1. **`removed[]` → HARD DELETE by `plaidTransactionId`** (`syncTransactions.ts`):
   ```
   const ids = removedTxns.map(t => t.transaction_id);
   await db.transaction.deleteMany({ where: { plaidTransactionId: { in: ids } } });
   ```
   Not a soft delete, not a `pending=false` flip — the row is **physically deleted**, leaving **no `deletedAt` tombstone**.
2. **`pending_transaction_id` is never read or stored** (grep: zero references in `lib/plaid`, `lib/transactions`, schema). There is **no linkage** between a pending row and its posted replacement.
3. **Fingerprint key includes `pending`** (`fingerprint.ts:18`): `where: { financialAccountId, date, amount, pending, deletedAt: null }`, with **exact `amount`**. So a **posted** row (`pending=false`) will **not** fingerprint-match a **pending** row (`pending=true`).

## The pending→posted mechanics (normal vs failure)

Plaid delivers a pending→posted transition (when it reissues the id) as: the **posted** row in `added[]`/`modified[]` (new `transaction_id` P2, `pending=false`, carrying `pending_transaction_id=P1`) **and** the **pending** id `P1` in `removed[]`. The loop processes **added/modified first, then `removed`**.

**Normal (works):**
- Posted P2 processed: `findUnique(P2)` miss → `findByFingerprint(…, pending=false)` → the pending row is `pending=true`, so **no match** → **INSERT P2**. Now both P1 (pending) + P2 (posted) exist.
- `removed=[P1]` → deletes the pending P1. Result: only P2 (posted). ✔

**Failure (disappears) — Q5 confirmed:** the `removed[P1]` hard-delete runs, but **P2 is never inserted**:
- **(a) P2 skipped** — `resolveFinancialAccountId(P2.account_id)` returns null (a `ProviderAccountIdentity`/`plaidAccountId` gap for Chase checking) → `skippedMissingAccount++; continue;` → P2 not written. Then `removed[P1]` deletes the pending. Payroll gone.
- **(b) P2 upsert error** — the per-txn `try/catch` logs and continues → P2 not written; pending still deleted.
- **(c) split across syncs** — `removed=[P1]` arrives in one sync (deletes pending) while P2 arrives in a later sync; if that later sync skips P2 (a/b), it never lands. Between syncs the payroll is absent, and with a skip it stays absent.

Because the delete is **hard** (fact 1), the removed pending leaves **no tombstone**, so neither the pending nor the posted exists — while the balance (a separate `accountsGet` endpoint) still shows the deposit.

---

## Answers

**Q1 — removed[] handling:** hard delete via `deleteMany` on `plaidTransactionId` only. No soft delete, no `pending` flip, no tombstone.

**Q2 — pending→posted when `transaction_id` changes:** handled **implicitly** — posted expected via `added/modified` (insert/upsert), pending removed via `removed[]` (hard delete). No explicit transition logic. If Plaid keeps a **stable** id (posts as `modified` with the same id), the code updates it in place (`findUnique` hit → update, `pending=false`) and there is no `removed` — that path is safe. The failure is specific to the **id-changes + removed[]** path when the posted insert doesn't happen.

**Q3 — `pending_transaction_id` support:** none. Not read, not stored. So no way to know a `removed` pending had a posted successor, and no way to reattach them.

**Q4 — pending rows linked to posted rows:** no. Independent rows; the only "link" Plaid offers (`pending_transaction_id`) is ignored.

**Q5 — could the pending be removed while the posted was skipped?** **Yes — this is the root cause.** `removed[P1]` hard-deletes the pending; the posted P2 is dropped by the missing-account skip or a write error (or arrives in a later sync and is dropped). Net: both gone.

**Q6 — could fingerprint match the posted to the removed pending and leave it deleted?** **No.** The fingerprint key includes `pending` (fact 3), so posted (`pending=false`) cannot match the pending row (`pending=true`) — it takes the **insert** path, not a match. Fingerprint therefore does **not** cause the deletion. (Had it matched, it would have been *protective* — updating the row's id so `removed[P1]` couldn't find it.) The deletion is solely `removed[]`'s hard-delete of the pending with no posted insert to replace it.

---

## Queries

**Q7 — hunt the payroll (deleted/pending/posted, either sign, any account):**
```sql
SELECT COALESCE(fa.name,a.name) AS account, COALESCE(fa.type,a.type) AS type,
       t.date, t.merchant, t.description, t.amount, t.pending, t."deletedAt",
       t."plaidTransactionId", t."financialAccountId", t."accountId"
FROM "Transaction" t
LEFT JOIN "FinancialAccount" fa ON fa.id=t."financialAccountId"
LEFT JOIN "Account" a           ON a.id =t."accountId"
WHERE (t.merchant ILIKE '%vectrus%' OR t.description ILIKE '%vectrus%'
       OR ABS(t.amount) BETWEEN 5000 AND 5600)
  AND t.date BETWEEN '2026-06-30' AND '2026-07-05'
ORDER BY t.date;
```
Note: this includes soft-deleted rows (`deletedAt` shown). If the payroll was hard-deleted by `removed[]`, **it will NOT appear here at all** — a hard delete leaves nothing to find (which itself is consistent with the root cause).

**Q8 — which transaction_ids were removed near the last Chase sync?**
There is **no stored record of removed ids.** The code only computes a `removed` **count** and returns it; `AuditLog` (`PLAID_SYNC`) metadata stores `totalRemoved` (a number), not ids:
```sql
SELECT "createdAt", action, metadata
FROM "AuditLog"
WHERE action IN ('PLAID_SYNC','PLAID_REFRESH')
  AND "createdAt" BETWEEN '2026-06-30' AND '2026-07-05'
ORDER BY "createdAt";
```
A non-zero `totalRemoved` around July 2 is circumstantial support (a pending was removed), but the specific ids are only in server logs, if retained. **This logging gap is itself a finding** (no forensic trail for hard-deleted rows).

**Q9 — cursor advancement + skip logging:** `next_cursor` is persisted after the full loop **regardless of skips**; skips are surfaced only as `skippedMissingAccount` (a returned count) and `console.error`/`console.warn` — **not persisted**. So a skipped posted payroll advances the cursor with no DB trace. Confirm via server logs (grep `skippedMissingAccount`, `no FinancialAccount for plaidAccountId`, `failed to upsert transaction`) around the July 2 Chase sync, if logs are retained.

---

## Q10 — Smallest safe recovery (ranked; no code here)

1. **Undelete the pending row? Not possible.** `removed[]` is a hard delete (fact 1) — there is no `deletedAt` row to restore. Rules this out.
2. **Cursor reset Chase + re-sync — the smallest safe recovery.** Set the Chase `PlaidItem.cursor = NULL` and re-run `syncTransactionsForItem`. With a null cursor Plaid returns the full available window (bounded by the immutable `days_requested=730`), re-delivering the **posted** payroll; the `plaidTransactionId` upsert + fingerprint dedupe prevent duplicates. This recovers the incident. (If the underlying cause was a missing-account skip, also verify the Chase-checking `ProviderAccountIdentity` resolves — else the re-sync could skip it again; `scripts/backfill-provider-account-identity.ts` exists for that.)
3. **Repair a pending→posted mapping? N/A for this incident** — no mapping is stored to repair; it can only be re-fetched (step 2).
4. **Add `pending_transaction_id` support — durable prevention, not this fix.** Future hardening to stop recurrence: (i) **soft-delete** on `removed[]` (set `deletedAt`) instead of hard delete → tombstone, auditable, recoverable; and/or (ii) store `pending_transaction_id` and reconcile pending→posted (update in place / only delete the pending once its posted successor exists); and/or (iii) persist removed ids for forensics. These are larger changes and out of scope here.

**Root cause:** Plaid removed the pending Vectrus payroll (`removed[]`), which the sync **hard-deletes** with no tombstone; the **posted** replacement was never inserted (missing-account skip / write-error / later-sync skip), and nothing links pending→posted — so the transaction vanished while the balance endpoint still reflects it. **Smallest safe recovery: cursor-reset + re-sync Chase (step 2), after confirming the Chase-checking provider identity resolves.**

**Stop — investigation only. Run Q7 (expect empty if hard-deleted) + Q8 (`totalRemoved` near July 2), then recover via step 2.**
