# Transaction Identity Doctrine

**Status:** shipped (DF-4). Defines the reconnection-safe identity of a canonical `Transaction` and the invariant the write path must uphold. Motivated by a production incident: **6 Amazon rows where only 2 real purchases exist**, created by three full re-pull passes during a db:wipe/reconnection window.

## The invariant

> **Replaying the same provider transaction history — through ordinary refresh, cursor replay, reconnection, connection restoration, or account restoration — must resolve to the same canonical `Transaction` and must not create an additional *active* row.**

Running the same payload twice is idempotent. A new provider `transaction_id` for a real transaction that already exists must **update** the existing row, not create a second one.

## Root cause of the incident (CONFIRMED)

1. Remove-then-re-add reconnect creates a **new `PlaidItem`** with `cursor = null` → Plaid returns the **full** history (a re-pull), not an increment.
2. Plaid's `transaction_id` is **not stable** across item recreation (documented in `lib/plaid/syncTransactions.ts`), so the exact-id fast path (`plaidTransactionId @unique`, the *only* DB uniqueness) misses.
3. The **fingerprint fallback** — the only remaining protection — keyed on the **enriched merchant name** (`txn.merchant_name ?? txn.name`). Plaid enrichment **drifts**: one pass returned `merchant_name = "Amazon"` (`personal_finance_category = GENERAL_MERCHANDISE`), a later pass returned it un-enriched (`merchant_name = null`, `OTHER_OTHER`). Two different keys → the fallback missed → `create()` ran → a duplicate active row. (Account-identity drift during db:wipe, plus a merge path that re-points transactions without deduping, compounded it.)

## The identity layers

### A. Provider identity
The provider's `transaction_id`, meaningful **only** within its correct provider, item/connection, and account lineage. Authoritative **when stable**, but Plaid reissues it on item recreation — so it is a fast path, not the whole identity.

### B. Canonical transaction identity
Fourth Meridian's stable identity for the economic transaction: the `Transaction` row. Resolved by, in order: (1) exact `plaidTransactionId`; (2) **content fingerprint** `{financialAccountId, date (day), amount, pending, normalized RAW descriptor}`; (3) create. The fingerprint's descriptor is the **raw provider descriptor** (`Transaction.description` = Plaid's verbatim `txn.name`), **not** the enriched merchant — the raw descriptor is stable across enrichment drift, the merchant is not. Callers pass `description ?? merchant`; the compare side coalesces identically, so import sources without a separate descriptor keep their prior behavior.

### C. Pending-to-posted lineage
A pending row and its posted successor are the same transaction. Plaid's `pending_transaction_id` is captured (`Transaction.pendingTransactionRef`). `pending` is part of the fingerprint, so pending and posted are distinct fingerprints; a posted row does not fingerprint-collapse onto its pending predecessor. The pending row is retired when Plaid sends it in `removed[]` (soft-delete). **Known residual (not a DF-4 target):** if `removed[]` is late/absent, a pending and posted row can both be visible — the stored `pendingTransactionRef` is not yet used to suppress the pending in the list.

### D. Reconnect identity
Continuity across a new/restored connection is proven by **account identity**, not by the transaction fingerprint alone: `exchangeToken` resolves a Plaid account via `ProviderAccountIdentity` (including soft-deleted → restore), then an account fingerprint, then create. When the **same** canonical `FinancialAccount` is restored (the normal case, mask present), the transaction fingerprint stays correctly scoped and — with the raw-descriptor key (§B) — replay is idempotent. Update-mode reconnect (same `item_id`) preserves the cursor and does not re-pull at all.

### E. Heuristic fallback (bounded)
The fingerprint is a bounded heuristic, permitted **only** after the exact-id path misses. It is scoped by `financialAccountId` + `date` + `amount` + `pending` and narrowed by the normalized **raw descriptor**. It must never widen to a global descriptor/amount/date match, and must never silently override a stronger lineage: the exact `plaidTransactionId` match always wins first. The raw descriptor is *stricter* than the enriched merchant (a longer, more specific string), so it can only reduce false merges.

### F. Unknown identity
When evidence is insufficient, **preserve uncertainty** — never merge unrelated transactions. Different raw descriptors, amounts, or dates ⇒ distinct rows. Cross-account and cross-user matches are structurally impossible (the fingerprint is `financialAccountId`-scoped; accounts belong to one user/space).

### G. Replay invariant
Running the same page twice is idempotent: exact-id → update (resurrecting a tombstone if needed); else fingerprint → update (re-pointing `plaidTransactionId`); else create. The cursor advances only after a fully-persisted page, so an interrupted page replays without loss. **DF-4 restores this invariant for the enrichment-drift case** (raw-descriptor fingerprint).

### H. Repair doctrine
Historical repair may occur **only after** the write-path invariant is proven (DF-4 before DF-5). Repair is auditable, dry-run-by-default, idempotent, narrowly scoped to proven rows, and **preserves evidence** — duplicates are **soft-deleted** (`deletedAt`), never hard-deleted, consistent with the repo's existing tombstone doctrine. A repair that would find a different state than the investigation proved must **abort**, not improvise.

## What DF-4 changed
`lib/transactions/fingerprint.ts` (`findByFingerprint`) now narrows on `description ?? merchant` (raw descriptor) instead of the enriched `merchant`; callers `lib/plaid/syncTransactions.ts` and `lib/imports/csv.ts` (+ its two routes) pass `description ?? merchant`. No schema change — the only DB uniqueness remains `plaidTransactionId @unique`; the fix strengthens the heuristic fallback rather than adding a constraint (which cannot be applied while the 6 duplicate rows exist).

## Residual gaps (stated, not closed by DF-4)
- **Transient-account drift under db:wipe:** if a reconnect creates a *new* `FinancialAccount` (e.g. account fingerprint also misses — null mask — or during a db:wipe) and it is later merged, the per-account-scoped fingerprint cannot see the prior pass's rows at ingest, and the merge (`mergeArchivedDuplicateIntoCanonical`) re-points transactions **without deduping**. DF-4's raw-descriptor fix does not close this. Recommended follow-up: **dedup transactions during account merge** (collapse rows sharing `{date, amount, pending, raw descriptor}` on the canonical account) — this would also retroactively clean any future occurrence. Not done here to keep DF-4 minimal and provable.
- **No fingerprint uniqueness constraint:** intentionally — a DB unique on the fingerprint cannot be added while duplicates exist, and would risk blocking genuinely-repeated same-day/same-amount/same-descriptor purchases. The fingerprint stays a resolve-time heuristic.
