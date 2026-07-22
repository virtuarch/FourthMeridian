/**
 * lib/transactions/counterparty-visibility.ts
 *
 * KD-15 gate for the transaction list DTO's `counterpartyAccountId` (Cash Flow
 * liquidity axis). The liquidity engine needs the counterparty's TIER
 * (liquid / asset / liability, derived client-side from the Space's already-
 * visible accounts) to classify a transfer — e.g. Coinbase(asset) → Chase(liquid)
 * = Asset Liquidation. It never needs the counterparty's NAME.
 *
 * Privacy rule (identical to the transaction-detail route's counterparty seam):
 * expose the raw counterpartyAccountId to a Space ONLY when the counterparty
 * account is itself visible to that Space through an ACTIVE, transaction-detail-
 * granting (FULL) link. Otherwise the id is withheld (null) — so a member can
 * never learn the existence/identity of an account that isn't shared with the
 * Space. Callers pass the counterparty's `spaceAccountLinks` ALREADY filtered by
 * the KD-15 predicate (spaceId + ACTIVE + TRANSACTION_DETAIL_VISIBILITY), so a
 * non-empty list means "visible here".
 *
 * Pure (no DB/Prisma import) so it is unit-testable and cannot drift from the
 * query's intent without a test noticing.
 */

export interface CounterpartyVisibilityRow {
  counterpartyAccountId: string | null;
  /** The counterparty FinancialAccount, with links PRE-FILTERED to this Space's
   *  ACTIVE + FULL links (length > 0 ⇒ visible). Null when there is no
   *  counterparty or the relation was not loaded. */
  counterpartyAccount?: {
    deletedAt: Date | null;
    spaceAccountLinks: { id: string }[];
  } | null;
}

/**
 * The privacy-gated counterpartyAccountId to serialize for this Space: the real
 * id when the counterparty account is visible here, otherwise null. Fails
 * closed (null) for a missing id, a deleted counterparty, or no visible link.
 */
export function gatedCounterpartyId(row: CounterpartyVisibilityRow): string | null {
  if (!row.counterpartyAccountId) return null;
  const cp = row.counterpartyAccount;
  if (!cp || cp.deletedAt !== null) return null;
  return cp.spaceAccountLinks.length > 0 ? row.counterpartyAccountId : null;
}

/**
 * TI4 Slice 1 — resolve which counterparty id a serialized row should carry when
 * BOTH a persisted (provider-confirmed) link and a read-time deterministic match
 * may exist. Precedence, pure and total:
 *
 *   1. `persistedGatedId` — the persisted Transaction.counterpartyAccountId AFTER
 *      gatedCounterpartyId() (e.g. a BTC wallet internal transfer). Provider-
 *      confirmed links are HIGHER AUTHORITY and always win when present.
 *   2. `resolvedGatedId`  — a read-time owned-account transfer match, ALREADY
 *      KD-15-gated by the data layer (null if the matched account is not visible
 *      to the reading Space). Read-time resolution never overrides a persisted link.
 *
 * Both inputs are expected to be pre-gated, so this only encodes precedence — it
 * performs no visibility logic of its own. Returns null when neither applies
 * (the row stays honestly Unresolved on the liquidity axis).
 */
export function chooseCounterpartyId(
  persistedGatedId: string | null,
  resolvedGatedId: string | null,
): string | null {
  return persistedGatedId ?? resolvedGatedId ?? null;
}
