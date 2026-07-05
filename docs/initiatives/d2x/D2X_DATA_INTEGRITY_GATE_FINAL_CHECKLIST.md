# D2.x — Financial Data Integrity Gate — Final Hardening Checklist

**Status:** Investigation + checklist only. No implementation. Scope discipline: **data trust before Ambient Intelligence** — detect, log, recover, or mark uncertainty. Do not overbuild.

---

## 1. Root-cause summary — the July 2 incident

A normal Plaid **pending→posted** transition reissues the `transaction_id` and sends the old id in `removed[]`. Fourth Meridian's sync then:
- **hard-deleted** the pending row (no tombstone), and
- **failed to insert** the posted replacement (a skip/upsert-error or split-sync delivery), while
- the **cursor advanced** past it.

Result: the posted payroll was permanently absent (balance still reflected it, since balances are a separate endpoint), normal incremental refresh could not recover it (cursor already past it), and the snapshot reconstruction inflated the whole month because the paycheck could not be walked back. Recovery required a cursor-reset replay.

**The system-level lesson:** the pipeline could lose a financial fact **silently and untraceably**, and nothing downstream (snapshots, FlowType, Brief, future AI) knew the facts were incomplete.

## 2. Fixes already implemented (this D2.x work)

- **Snapshot orchestration** (`refresh.ts`): all-items refresh regenerates each Space **once after all institutions finish**, and **excludes Spaces touched by a failed item** → no partial-refresh live snapshots.
- **Soft-delete `removed[]`** (`syncTransactions.ts`): tombstone (`deletedAt`) instead of physical delete; `plaidTransactionId` preserved; readers already filter `deletedAt: null` (D2 Step 4D-R) so tombstones don't resurface. **A removed pending is never lost without a trace.**
- **Resurrection** on `findUnique(plaidTransactionId)` (`deletedAt: null` on update) → a transaction Plaid re-sends as live comes back.
- **Removed-id forensic log line** + the tombstone rows themselves.
- **Targeted recovery script** (`recover-plaid-item-transactions.ts`): cursor-reset + idempotent replay for one item.
- **Snapshot `isEstimated`** provenance (Slice 4) + **credit-card debt reconstruction** (Slice 4B).

## 3. Remaining risks (ranked by trust impact)

1. **Skipped transactions are only `console`-logged — not durable.** A missing-account skip or upsert error advances the cursor with **no persisted record**; operators and future AI can't see it. *(This is the exact gap the incident exposed.)* **HIGH.**
2. **No balance↔transaction reconciliation.** The July 2 class (balance moved, transactions don't explain it) is **not auto-detected** — including the "Plaid balance-only" case where no skip is even logged. **HIGH.**
3. **No sync-health signal for snapshots / Brief / AI.** Downstream consumers trust facts blindly. **HIGH (for AI readiness), MEDIUM (today).**
4. **No auto-recovery.** Recovery is manual (script). **MEDIUM.**
5. **`pending_transaction_id` not reconciled** — the pipeline can still delete a pending without confirming its posted successor landed (soft-delete now makes this *recoverable*, not *prevented*). **MEDIUM.**
6. **Fingerprint over-match** (a posted merging into a coincidental twin). **LOW.**
7. **Single-item refresh** regenerates the full Space with other items at last-known balances — legitimate current state, not a partial-*mid-operation* write; acceptable. **LOW.**

## 4. Ranked hardening roadmap

**MUST DO before closing D2 (the trust foundation):**
- **M1 — `SyncIssue` durable table** + wire the existing three sites to it: missing-account skip, upsert error, removed-tombstone. Turns silent loss into a **queryable record**. (Schema: one table — §6.)
- **M2 — Minimal balance↔transaction reconciliation** (cash + card only) at end of `refreshPlaidItem`: compare the per-account balance delta captured this refresh vs the transaction sum; on a gap beyond threshold, write a `BALANCE_TX_MISMATCH` SyncIssue. **Flag only — no auto-replay.** This auto-detects the incident class.

**SHOULD DO in v2.5:**
- S1 — **Guarded auto-recovery:** on an open `BALANCE_TX_MISMATCH` (or `skippedMissingAccount > 0`), trigger **one** cursor-reset replay, gated by a `replayAttempted` flag + the existing manual-refresh cooldown (loop/rate-limit safety); dedupe already prevents duplicates. Record `REPLAY_ATTEMPTED/RECOVERED/FAILED`.
- S2 — **Snapshot trust at read time:** derive incompleteness from open SyncIssues for a Space's accounts (no new snapshot column — see §3 answer) and expose it.
- S3 — **Brief surfacing:** "Chase transaction history may be incomplete" when an account has an open gap issue.

**CAN WAIT v2.6+ (with Ambient Intelligence):**
- V1 — **AI context sync-health domain:** `buildContext` includes a per-account trust signal from SyncIssue; AI caveats/declines precise claims over accounts with open gaps.
- V2 — **`pending_transaction_id` reconciliation** (delete a pending only once its posted successor is stored).
- V3 — Fingerprint over-match hardening; richer provider-issue analytics; denormalized snapshot `quality` if read-time joins become a perf problem.

## 5. Minimal D2.x must-do implementation checklist (M1 + M2)

**M1 — SyncIssue persistence**
1. Add the `SyncIssue` model + `SyncIssueKind` enum (§6). `prisma migrate dev`.
2. `lib/plaid/syncTransactions.ts`: on the **missing-account** skip (`:205-211`) and the **upsert-error** catch (`:293-295`), write a `SyncIssue` (`kind`, `plaidItemId`, `plaidAccountId`, `plaidTransactionId`, `detail={merchant,amount,date}`) — keep the console log too. On `removed[]` soft-delete, write one `REMOVED_TOMBSTONE` issue per batch (`detail={ids}`) — optional but cheap.
3. Best-effort: wrap each SyncIssue write so it can never fail the sync.

**M2 — Reconciliation (cash + card only, flag-only)**
4. In `refreshPlaidItem`, capture per-account `balanceBefore` (current stored) and `balanceAfter` (from `accountsGet`) during the balance step; compute `balanceDelta`.
5. After the transaction sync, for accounts of type `checking`/`savings` (expect `balanceDelta ≈ Σ FM amount`) and `debt` credit-card (expect `balanceDelta ≈ −Σ FM amount`), query this account's transaction sum over the reconciled window; if `|expected − actual| > threshold` → write `BALANCE_TX_MISMATCH` SyncIssue (`detail={balanceDelta, txnSum, threshold}`).
6. **Exclude** `investment`/`crypto` (market movement → false positives) and `other`/manual (no transactions).
7. Threshold: `max($100 floor, ~2% of |balance|)` — generous to avoid pending/timing false positives; the incident was $5,286 so any sane threshold catches it. No auto-replay in this slice.

**Explicitly NOT in the must-do:** auto-replay, snapshot column, AI consumption, `pending_transaction_id` — all deferred (§4).

## 6. Schema recommendation (minimal)

**Add ONE table + one enum. No `SpaceSnapshot` change.**
```prisma
model SyncIssue {
  id                 String        @id @default(cuid())
  provider           String        @default("PLAID")
  plaidItemId        String?
  financialAccountId String?
  kind               SyncIssueKind
  plaidTransactionId String?
  plaidAccountId     String?
  detail             Json?         // { merchant, amount, date, balanceDelta, txnSum, threshold, ids, ... }
  resolved           Boolean       @default(false)
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  @@index([financialAccountId, resolved])
  @@index([plaidItemId, kind])
}
enum SyncIssueKind {
  MISSING_ACCOUNT
  UPSERT_ERROR
  REMOVED_TOMBSTONE
  BALANCE_TX_MISMATCH
  REPLAY_ATTEMPTED     // written by v2.5 auto-recovery
  REPLAY_RECOVERED
  REPLAY_FAILED
}
```
- **Why a table, not `AuditLog`:** AuditLog is user-action history; SyncIssue is a first-class, **resolvable**, AI-queryable forensic surface (`resolved` + `financialAccountId` indexes). The removed/replay kinds are included now so v2.5 doesn't need a second migration.
- **Answers to §4's questions:**
  - *Is `isEstimated` enough?* On the snapshot row, yes — reconstruction provenance. **Incompleteness/gap is a per-account, temporal fact → model it in SyncIssue and join at read time; do NOT denormalize a `quality` column onto every snapshot** (leaner, avoids a snapshot migration). Add `quality` only if read-time joins become a perf issue (v2.6+).
  - *Reconcilable account types:* checking/savings (safe), credit-card debt (wider threshold); never investments/crypto/manual.
  - *AuditLog vs SyncIssue vs status flag:* SyncIssue row. A `PlaidItem`/`FinancialAccount` status flag can be a v2.5 convenience derived from open issues, not the system of record.
  - *Auto-replay?* Not in must-do; v2.5 with cooldown + `replayAttempted` guard.
  - *How AI treats incompleteness (v2.6+):* reads open SyncIssues for the Space's accounts; Brief warns; AI caveats/declines precise numeric claims when a `BALANCE_TX_MISMATCH` is open.

## 7. Rollback + validation

**Rollback:**
- M1/M2 are additive: the `SyncIssue` writes are best-effort and behavior-neutral to sync results; revert the wiring to remove them. The table can be dropped (`DROP TABLE "SyncIssue"`) — no other model references it. No data loss (it's a forensic side-table).
- The reconciliation is read-only + issue-write; disabling it changes nothing about balances/transactions/snapshots.

**Validation:**
- `prisma generate` + `migrate dev`; `tsc`; `lint`.
- **Unit/integration (dev DB):**
  - Missing-account skip and upsert error each create exactly one `SyncIssue` with the right `kind`/ids; sync result counts unchanged.
  - Reconciliation: a cash account whose balance moved by ~$5k with no matching transactions produces one `BALANCE_TX_MISMATCH`; a cash account whose balance == txn sum produces **none**; an investment account with market movement produces **none** (excluded).
  - Threshold: sub-threshold noise produces no issue.
  - Replay the July 2 recovery: after the missing payroll returns, reconciliation produces **no** open gap for Chase checking.
- **Regression:** normal sync path (added/modified/removed/fingerprint/cursor) byte-unchanged except the additive SyncIssue writes.

**Success criterion:** after M1+M2, a July-2-class loss is **detected and durably recorded** at sync time (visible to operators, and queryable by AI when Ambient Intelligence ships), even though auto-recovery and AI consumption land later.

**Stop — investigation/checklist only. Awaiting approval of the M1+M2 must-do slice (one additive table) before any implementation.**
