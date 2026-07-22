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
 *  - transferCandidate : TI4 Slice 1 — DETERMINISTIC owned-account two-leg transfer
 *                    matching. A transfer-like row resolves to the owned account on
 *                    the other side when EXACTLY ONE opposite leg matches on all of:
 *                    different owned account · same currency · equal |amount| (to
 *                    monetary precision) · opposite sign · both transfer-like · within
 *                    a narrow date window. Ambiguity (legs across >1 candidate account)
 *                    is REFUSED, never guessed. No descriptor / merchant heuristics, no
 *                    provider-specific logic — those are later slices. The counterparty
 *                    id this yields is projected into the DTO ONLY through the KD-15
 *                    visibility gate in the data layer; this pure module never persists.
 *
 * Deliberately NOT implemented (requires a ratified fuzzy heuristic — proposed,
 * not built): refundCandidate (opposite-amount + merchant + window). Reserved as
 * `null` in the output so the contract is stable when that slice lands.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Structural input — a subset of the Transaction row, Prisma-free.
// ─────────────────────────────────────────────────────────────────────────────

export interface RelationshipTransaction {
  id:                    string;
  /** Canonical FinancialAccount FK — the account identity. */
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
  /** Native currency (ISO 4217) — TI4 transfer matching requires same-currency legs. */
  currency?:             string | null;
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

/** Outcome of deterministic owned-account transfer matching (TI4 Slice 1). */
export type TransferMatchStatus =
  | 'RESOLVED'    // exactly one candidate account matched — safe to use
  | 'AMBIGUOUS'   // legs matched across >1 candidate account — refused, not guessed
  | 'NONE';       // target not transfer-like, or no matching opposite leg

export type TransferMatchReason =
  | 'DETERMINISTIC_UNIQUE'         // one owned counterparty account, deterministically
  | 'AMBIGUOUS_MULTIPLE_ACCOUNTS'  // >1 distinct candidate account — refuse
  | 'NO_CANDIDATE'                 // no opposite leg matched
  | 'NOT_TRANSFER_LIKE';           // target is not a directional transfer row

export interface TransferCandidateRelationship {
  status: TransferMatchStatus;
  /** The matched opposite-leg transaction id — only when status === 'RESOLVED' AND a
   *  single leg matched; null when the account is certain but the exact leg is not. */
  transactionId:         string | null;
  /** The owned counterparty account id — set only when status === 'RESOLVED'. */
  counterpartyAccountId: string | null;
  /** 1 for a unique deterministic match; 0 otherwise. Durable field for future UI. */
  confidence:            number;
  reason:                TransferMatchReason;
}

export interface TransactionRelationships {
  pendingPosted:   PendingPostedRelationship | null;
  duplicate:       DuplicateRelationship | null;
  /** Reserved — requires a ratified fuzzy heuristic. Always null in this slice. */
  refundCandidate:   null;
  /** TI4 Slice 1 — the RESOLVED deterministic owned-account transfer match, or null
   *  when NONE/AMBIGUOUS (unresolved is honest; the match is never guessed). Callers
   *  that need the AMBIGUOUS/NONE reason call matchTransferCandidate() directly. */
  transferCandidate: TransferCandidateRelationship | null;
}

/** Tunables for owned-account transfer matching. */
export interface TransferMatchOptions {
  /** ± window in whole days (Transaction.date is day-granular). Default 2. */
  windowDays?:    number;
  /** Absolute-amount tolerance in currency units (monetary precision). Default 0.005. */
  amountEpsilon?: number;
}

const DEFAULT_TRANSFER_WINDOW_DAYS = 2;
const DEFAULT_AMOUNT_EPSILON = 0.005; // half a cent — legs are cent-aligned in practice.

/** Transfer-like flow kinds. TRANSFER only — deterministic, no fragility (an
 *  INVESTMENT security trade is not a two-leg owned-account cash transfer). */
const TRANSFER_LIKE_FLOWS: ReadonlySet<string> = new Set(['TRANSFER']);
function isTransferLike(flowType: string | null | undefined): boolean {
  return flowType != null && TRANSFER_LIKE_FLOWS.has(flowType);
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

/** The account identity — the canonical FinancialAccount FK. */
function accountKey(t: RelationshipTransaction): string | null {
  return t.financialAccountId;
}

/** Same calendar day (Transaction.date is @db.Date — day granularity). */
function sameDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/** Absolute whole-day distance between two day-granular dates (UTC). */
function dayDistance(a: Date, b: Date): number {
  const DAY = 24 * 60 * 60 * 1000;
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.abs(Math.round((da - db) / DAY));
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

/**
 * TI4 Slice 1 — deterministic owned-account transfer matcher. Pure; the CALLER
 * gathers candidates (bounded, user-scoped cross-account query) and owns the
 * KD-15 visibility gate applied to the id this returns.
 *
 * Resolves the target transfer-like row to the OWNED account on the other side
 * when EXACTLY ONE candidate account matches on ALL required facts:
 *   - different owned account (candidate's account ≠ target's account)
 *   - same currency (null currency matches only null currency)
 *   - equal |amount| within `amountEpsilon` (monetary precision)
 *   - opposite sign (one leg in, one leg out; zero amounts never match)
 *   - both rows transfer-like (flowType TRANSFER)
 *   - candidate date within ±`windowDays` of the target
 *   - candidate not soft-deleted (a tombstoned leg is never paired)
 *
 * Ambiguity doctrine: matches are grouped by counterparty ACCOUNT. Many legs in
 * ONE account still name a single unambiguous counterparty → RESOLVED (the
 * liquidity axis needs the account, not the exact leg). Legs across MORE THAN ONE
 * account are a genuine ambiguity → AMBIGUOUS (refused; the id is left null and
 * the row stays unresolved). Never chooses arbitrarily.
 */
export function matchTransferCandidate(
  tx: RelationshipTransaction,
  candidates: readonly RelationshipTransaction[],
  opts: TransferMatchOptions = {},
): TransferCandidateRelationship {
  const windowDays = opts.windowDays ?? DEFAULT_TRANSFER_WINDOW_DAYS;
  const eps = opts.amountEpsilon ?? DEFAULT_AMOUNT_EPSILON;

  const ownAcct = accountKey(tx);
  const txSign = Math.sign(tx.amount);
  // Target must be a directional (nonzero) transfer-like row with a known account.
  if (!isTransferLike(tx.flowType) || txSign === 0 || ownAcct == null) {
    return { status: 'NONE', transactionId: null, counterpartyAccountId: null, confidence: 0, reason: 'NOT_TRANSFER_LIKE' };
  }
  const txCurrency = tx.currency ?? null;
  const txMagnitude = Math.abs(tx.amount);

  const matches = candidates.filter((c) => {
    if (c.id === tx.id) return false;
    if (c.deletedAt != null) return false;                    // never pair a tombstoned leg
    if (!isTransferLike(c.flowType)) return false;
    const cAcct = accountKey(c);
    if (cAcct == null || cAcct === ownAcct) return false;     // must be a DIFFERENT owned account
    if ((c.currency ?? null) !== txCurrency) return false;    // same currency
    if (Math.sign(c.amount) !== -txSign) return false;        // opposite direction
    if (Math.abs(Math.abs(c.amount) - txMagnitude) > eps) return false; // equal magnitude
    if (dayDistance(c.date, tx.date) > windowDays) return false;        // within window
    return true;
  });

  if (matches.length === 0) {
    return { status: 'NONE', transactionId: null, counterpartyAccountId: null, confidence: 0, reason: 'NO_CANDIDATE' };
  }

  const distinctAccounts = new Set(matches.map((m) => accountKey(m) as string));
  if (distinctAccounts.size > 1) {
    return { status: 'AMBIGUOUS', transactionId: null, counterpartyAccountId: null, confidence: 0, reason: 'AMBIGUOUS_MULTIPLE_ACCOUNTS' };
  }

  const counterpartyAccountId = [...distinctAccounts][0];
  // The account is certain; the exact leg only when a single row matched.
  const transactionId = matches.length === 1 ? matches[0].id : null;
  return { status: 'RESOLVED', transactionId, counterpartyAccountId, confidence: 1, reason: 'DETERMINISTIC_UNIQUE' };
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
  opts: TransferMatchOptions = {},
): TransactionRelationships {
  const transfer = matchTransferCandidate(transaction, candidates, opts);
  return {
    pendingPosted:     resolvePendingPosted(transaction, candidates),
    duplicate:         resolveDuplicate(transaction, candidates),
    refundCandidate:   null,
    // Only a RESOLVED, deterministic match surfaces; NONE/AMBIGUOUS stay null
    // (unresolved is honest). The full outcome is available via matchTransferCandidate.
    transferCandidate: transfer.status === 'RESOLVED' ? transfer : null,
  };
}
