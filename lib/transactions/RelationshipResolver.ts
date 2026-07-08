/**
 * lib/transactions/RelationshipResolver.ts
 *
 * Transaction Intelligence — read-time Relationship Resolver (foundation).
 *
 * Per the ratified TI4 decision, transaction relationships are NOT persisted:
 * they are explanation/navigation context, cheap to recompute, and consumed by
 * the transaction-detail experience. This module resolves them at READ TIME
 * from a target row plus a small set of candidate rows the caller supplies.
 *
 * Design contract (mirrors buildTransactionFacts / serialize.ts):
 *  - PURE & DETERMINISTIC: same inputs → same output. No DB, no I/O, no
 *    Date.now, no env, no side effects. Never throws.
 *  - ZERO IMPORTS: structural row types (not Prisma types) and an inlined
 *    merchant normalizer, so this module — and its tsx test — never pull in
 *    @/lib/db (which lib/transactions/fingerprint.ts does), and run without
 *    `prisma generate`.
 *  - RETURNS FACTS, NOT PROSE: structured ids/roles only. Rendering (UI) and
 *    narration (AI) belong elsewhere and consume this shape.
 *
 * Scope of THIS slice — deterministic / low-risk relationships only:
 *  - pendingPosted : exact provider match on plaidTransactionId ↔ pendingTransactionRef.
 *  - duplicate     : exact fingerprint (same account/date/amount/pending + normalized
 *                    merchant) — the same deterministic keys lib/transactions/fingerprint.ts
 *                    uses for sync dedup; no fuzzy matching.
 *
 * Deliberately NOT implemented (require a ratified fuzzy heuristic — proposed,
 * not built): refundCandidate (opposite-amount + merchant + window) and
 * transferCandidate (cross-account opposite-amount + window). They are reserved
 * as `null` in the output so the contract is stable when those slices land.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Structural input — a subset of the Transaction row, Prisma-free.
// ─────────────────────────────────────────────────────────────────────────────

export interface RelationshipTransaction {
  id:                    string;
  /** Legacy Account FK. */
  accountId:             string | null;
  /** Canonical FinancialAccount FK. Exactly one of the two identifies the account. */
  financialAccountId:    string | null;
  /** Provider transaction id (unique). Anchor for the pending↔posted match. */
  plaidTransactionId:    string | null;
  /** Plaid pending_transaction_id (TI2 seed): the posted row's pointer to its pending row. */
  pendingTransactionRef: string | null;
  date:                  Date;
  amount:                number;
  merchant:              string;
  pending:               boolean;
  /** Soft-delete tombstone (the pending row is tombstoned once it posts). */
  deletedAt?:            Date | null;
  flowType?:             string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output — structured relationship facts (no prose).
// ─────────────────────────────────────────────────────────────────────────────

export type PendingPostedRole =
  | 'POSTED_FROM_PENDING'   // the target row posted from a prior pending row
  | 'PENDING_AWAITING_POST'; // the target row is pending; a posted successor exists

export interface PendingPostedRelationship {
  role:          PendingPostedRole;
  /** The matched counterpart row's id (the pending row, or the posted successor). */
  transactionId: string;
}

export interface DuplicateRelationship {
  /** Ids of exact-fingerprint duplicates of the target (excludes the target itself). */
  transactionIds: string[];
}

export interface TransactionRelationships {
  pendingPosted:   PendingPostedRelationship | null;
  duplicate:       DuplicateRelationship | null;
  /** Reserved — requires a ratified fuzzy heuristic. Always null in this slice. */
  refundCandidate:   null;
  /** Reserved — requires a ratified fuzzy heuristic. Always null in this slice. */
  transferCandidate: null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors lib/transactions/fingerprint.ts `normalizeMerchantKey` (inlined to keep
 * this module DB-free; fingerprint.ts imports @/lib/db). Kept trivial and in sync
 * with that canonical source; a future slice may extract a shared pure normalizer.
 */
function normalizeMerchantKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** The account identity — whichever FK is set (both normalized to one on read). */
function accountKey(t: RelationshipTransaction): string | null {
  return t.financialAccountId ?? t.accountId;
}

/** Same calendar day (Transaction.date is @db.Date — day granularity). */
function sameDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic resolvers
// ─────────────────────────────────────────────────────────────────────────────

function resolvePendingPosted(
  tx: RelationshipTransaction,
  candidates: readonly RelationshipTransaction[],
): PendingPostedRelationship | null {
  // The target posted FROM a pending row: its pendingTransactionRef points at the
  // pending row's plaidTransactionId (exact, provider-supplied). The pending row
  // is typically tombstoned — deletedAt is NOT filtered here on purpose.
  if (tx.pendingTransactionRef) {
    const pendingRow = candidates.find(
      (c) => c.id !== tx.id && c.plaidTransactionId != null && c.plaidTransactionId === tx.pendingTransactionRef,
    );
    if (pendingRow) return { role: 'POSTED_FROM_PENDING', transactionId: pendingRow.id };
  }
  // The reverse: the target is a pending row and a posted successor points back.
  if (tx.pending && tx.plaidTransactionId) {
    const postedRow = candidates.find(
      (c) => c.id !== tx.id && c.pendingTransactionRef != null && c.pendingTransactionRef === tx.plaidTransactionId,
    );
    if (postedRow) return { role: 'PENDING_AWAITING_POST', transactionId: postedRow.id };
  }
  return null;
}

function resolveDuplicate(
  tx: RelationshipTransaction,
  candidates: readonly RelationshipTransaction[],
): DuplicateRelationship | null {
  const key = normalizeMerchantKey(tx.merchant);
  const acct = accountKey(tx);
  if (acct == null) return null;

  const ids = candidates
    .filter(
      (c) =>
        c.id !== tx.id &&
        c.deletedAt == null &&               // never flag a tombstoned row
        accountKey(c) === acct &&            // same account
        c.amount === tx.amount &&            // exact amount
        c.pending === tx.pending &&          // same settlement state (fingerprint key)
        sameDay(c.date, tx.date) &&          // same day
        normalizeMerchantKey(c.merchant) === key, // same normalized merchant
    )
    .map((c) => c.id);

  return ids.length > 0 ? { transactionIds: ids } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the deterministic relationship facts for one transaction against a
 * caller-supplied candidate set (e.g. same account, near date). Pure; the caller
 * owns fetching — the resolver never touches the DB.
 */
export function resolveTransactionRelationships(
  transaction: RelationshipTransaction,
  candidates: readonly RelationshipTransaction[],
): TransactionRelationships {
  return {
    pendingPosted:     resolvePendingPosted(transaction, candidates),
    duplicate:         resolveDuplicate(transaction, candidates),
    refundCandidate:   null,
    transferCandidate: null,
  };
}
