# D2.x — Missing Chase Checking Payroll Transaction — Investigation

**Status:** Investigation only. No implementation.
**Space:** `cmr456dtb0004117fjb6qavmm`.
**Given:** checking balance reflects the ~$5.2k July 2 paycheck, but no checking deposit > 3000 exists 2026-06-25 → 07-05.

**Access:** local DB unreachable here — code paths proven from source; DB checks are exact queries below.

---

## How "balance updated, transaction absent" happens (code-proven)

`refreshPlaidItem` runs **balances (accountsGet) → holdings → transactions (`syncTransactionsForItem`)** as three separate Plaid calls. Balances and transactions are **independent** Plaid endpoints with **independent freshness**, so the balance can include the paycheck while `/transactions/sync` has not yet delivered (or has skipped) the payroll row.

`syncTransactionsForItem` (`lib/plaid/syncTransactions.ts`):
- **Cursor-based, incremental.** Resumes from `PlaidItem.cursor`; `next_cursor` is written back **only after the full `has_more` loop completes** (`:306-312`). Once the cursor moves past a transaction, Plaid re-sends it **only** if it is later `modified`/`removed`.
- **No amount-sign filter.** The loop processes `added` + `modified` regardless of sign (a positive/deposit is treated like any other) — **deposits are NOT excluded by design** (Q4).
- **Two silent skip paths that still advance the cursor:**
  1. `resolveFinancialAccountId(txn.account_id)` returns null → `skippedMissingAccount++; continue;` (`:206-210`). The txn is dropped if its `account_id` doesn't resolve to a FinancialAccount (e.g. a ProviderAccountIdentity/`plaidAccountId` gap after a reconnect).
  2. per-txn `try { upsert } catch (e) { console.error(...) }` → **continues** (does not rethrow). A write error drops that one txn.
  In both cases the loop keeps going and the cursor is advanced at the end — so a dropped payroll is **not re-fetched** on later syncs.

**Two candidate scenarios, indistinguishable from the DB alone:**
- **(A) Lag** — the cursor is legitimately *before* the payroll entered Plaid's sync stream; balance is fresher than transactions. **A re-sync will fetch it.**
- **(B) Skip** — the payroll was delivered in a page but dropped (missing-account skip or upsert error), and the cursor advanced past it. **A re-sync will NOT fetch it; only a cursor reset (or Plaid re-sending it as modified) recovers it.**

---

## Answers + exact queries

### Q1 — Chase Plaid cursor state
```sql
SELECT "institutionName", status, "errorCode",
       cursor IS NOT NULL AS has_cursor, length(cursor) AS cursor_len,
       "lastSyncedAt", "lastManualRefreshAt"
FROM "PlaidItem"
WHERE "userId" = (SELECT "ownerUserId" FROM "FinancialAccount" fa
                  JOIN "SpaceAccountLink" sal ON sal."financialAccountId"=fa.id
                  WHERE sal."workspaceId"='cmr456dtb0004117fjb6qavmm' AND sal.status='ACTIVE'
                    AND fa.institution ILIKE '%chase%' LIMIT 1)
  AND "institutionName" ILIKE '%chase%';
```
`has_cursor=true` + a recent `lastSyncedAt` ⇒ a sync ran and advanced the cursor (favours scenario B or lag). `status`/`errorCode` reveal a failed item (a failed Chase sync would leave stale balance + incomplete transactions — the same partial-sync family as the July 2 issue).

### Q2 — Did Chase checking transaction history import fully?
```sql
SELECT fa.name, COUNT(*) AS n, MIN(t.date) AS earliest, MAX(t.date) AS latest,
       SUM((t.pending)::int) AS pending_n
FROM "Transaction" t
JOIN "FinancialAccount" fa ON fa.id=t."financialAccountId"
JOIN "SpaceAccountLink" sal ON sal."financialAccountId"=fa.id
WHERE sal."workspaceId"='cmr456dtb0004117fjb6qavmm' AND sal.status='ACTIVE'
  AND fa.type='checking' AND fa.institution ILIKE '%chase%' AND t."deletedAt" IS NULL
GROUP BY fa.name;
```
A `latest` earlier than July 2, or a suspiciously low `n`, indicates the recent window (including the payroll) never landed.

### Q3 & Q5 — Find the payroll ANYWHERE (rule out pending / other account / inverted sign / null merchant / deleted / legacy accountId)
```sql
-- Wide net: any account in the Space, any date, either sign, incl. pending & soft-deleted, both FK columns.
SELECT COALESCE(fa.name, a.name) AS account, COALESCE(fa.type, a.type) AS type,
       t.date, t.merchant, t.description, t.amount, t.pending, t."deletedAt",
       t."financialAccountId", t."accountId", t."plaidTransactionId"
FROM "Transaction" t
LEFT JOIN "FinancialAccount" fa ON fa.id=t."financialAccountId"
LEFT JOIN "Account" a           ON a.id =t."accountId"
WHERE ABS(t.amount) > 3000
  AND t.date BETWEEN '2026-06-20' AND '2026-07-05'
ORDER BY ABS(t.amount) DESC;
```
This resolves Q5 definitively:
- **inverted sign** → a **negative** ~5200 row appears (would also over-inflate the reconstruction — but your flat `cash=6438` argues against this).
- **pending** → `pending=true` row (sync *does* store pending, so it would be here).
- **removed/soft-deleted** → `deletedAt` non-null.
- **assigned to another account** → different `account`/`type`.
- **legacy accountId** → `accountId` set, `financialAccountId` null.
- **truly missing** → **no row at all** ⇒ it was never stored (scenario A or B).

### Q4 — Does sync exclude positive checking deposits? **No.**
The loop has no sign guard; `added`+`modified` are processed regardless of sign (see code section). Deposits are stored the same as any other transaction. Not the cause.

### Q6 — Was the cursor advanced before the payroll was stored? (the crux)
Provable behaviour: the cursor advances at the end of the loop **even if** a page's txn was skipped (`skippedMissingAccount`) or errored. So if the payroll was in a delivered page and dropped, the cursor is now past it (scenario B). The **decisive test** is operational, not a query: **re-run the sync and see if it appears** (Q7).
- Indirect DB signal for a *skip*: check that Chase checking's `account_id` resolves —
```sql
SELECT provider, "externalAccountId", "financialAccountId"
FROM "ProviderAccountIdentity"
WHERE "financialAccountId" IN (
  SELECT fa.id FROM "FinancialAccount" fa
  JOIN "SpaceAccountLink" sal ON sal."financialAccountId"=fa.id
  WHERE sal."workspaceId"='cmr456dtb0004117fjb6qavmm' AND sal.status='ACTIVE'
    AND fa.type='checking' AND fa.institution ILIKE '%chase%');
```
A missing/duplicate identity row for Chase checking is exactly what makes `resolveFinancialAccountId` skip that account's transactions while balances (matched separately) still update.

### Q7 — Should a manual refresh fetch it?
- **If scenario A (lag): yes** — `POST /api/plaid/refresh` → `refreshPlaidItem` → `syncTransactionsForItem` resumes from the cursor and pulls the now-available payroll (idempotent). This is the first thing to try.
- **If scenario B (cursor advanced past a dropped row): no** — the cursor is already beyond it; a normal refresh won't re-request it. Recovery needs a **cursor reset** (below) or Plaid re-sending the row as `modified`.

The manual refresh is therefore the **diagnostic that separates A from B**: run it; if the Q3/Q5 query then finds the payroll, it was lag; if not, it was skipped and the cursor must be reset.

---

## Q8 — Smallest safe fix (no code here; ranked)

1. **Re-sync first (zero-risk):** trigger a manual refresh for Chase. Idempotent (upsert on `plaidTransactionId` + fingerprint fallback). If it recovers the payroll ⇒ done (was lag).
2. **If still missing — targeted cursor reset for Chase's PlaidItem, then re-sync:** set `PlaidItem.cursor = NULL` for the Chase item and re-run `syncTransactionsForItem`. With a null cursor Plaid returns the full available history (bounded by the immutable `days_requested=730`), and the payroll re-enters; existing rows are protected by the `plaidTransactionId` upsert + fingerprint dedupe, so **no duplicates**. This is the standard recovery for a cursor-skipped transaction and is the smallest safe fix. (Could be a one-line targeted DB update behind a small script flag, mirroring the existing diagnostic/repair scripts — investigate before coding, per the rule.)
3. **Root-cause the skip (so it can't recur):** if Q6's `ProviderAccountIdentity` query shows a gap for Chase checking, that identity gap is why `resolveFinancialAccountId` dropped the payroll — the durable fix is backfilling/repairing that identity (there is already `scripts/backfill-provider-account-identity.ts`), separate from this incident.

**Sequencing with the snapshot work:** do **not** repair the July 2 snapshot until the payroll transaction is present (steps 1–2). Once it exists, re-running the backfill reconstructs a **correct** (lower) pre-payroll cash curve; repairing before that would just bake in the inflated value (see the month-long-inflation investigation).

**Stop — investigation only. Run Q1/Q3 to locate/confirm, then a manual refresh to separate lag from skip.**
