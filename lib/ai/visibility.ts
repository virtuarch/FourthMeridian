/**
 * lib/ai/visibility.ts
 *
 * Canonical AI-context visibility predicate (KD-1, 2026-07-02).
 *
 * Single source of truth for which SpaceAccountLink.visibilityLevel values
 * allow an account's TRANSACTION-LEVEL DETAIL (rows, merchants, amounts, and
 * any aggregate derived from rows) to enter AI context. Both the
 * transactions-summary query and the drilldown query in
 * lib/ai/assemblers/transactions.ts MUST use this constant so they can never
 * disagree.
 *
 * ── The privacy rule ──────────────────────────────────────────────────────────
 * Transaction detail enters AI context only from accounts whose link to the
 * requesting Space grants full visibility:
 *
 *   FULL         → transaction detail allowed (this predicate)
 *   BALANCE_ONLY → balance totals only, via the accounts assembler — never rows
 *   SUMMARY_ONLY → qualitative summary only — never rows, never raw numbers
 *   PRIVATE      → nothing (should not exist on a link row at all)
 *   SHARED       → legacy value ("maps to FULL" per schema comment) —
 *                  EXCLUDED here. An ad-hoc data audit on 2026-07-02 (dev +
 *                  prod) confirmed zero SHARED rows on SpaceAccountLink, and no
 *                  current write path can produce one (share route validates
 *                  [BALANCE_ONLY, FULL]; all other SAL writes hardcode FULL).
 *                  That audit query is not committed to the repo. If SHARED ever
 *                  reappears, this predicate fails CLOSED: the account's
 *                  transactions are over-redacted, never leaked. Re-run an audit
 *                  of SpaceAccountLink.visibilityLevel before widening this list.
 *
 * Absence of a grant always fails closed.
 *
 * The legacy Account path (transaction.account.spaceId) is the Space's own
 * account set and is treated as FULL by definition — this predicate governs
 * only the SpaceAccountLink (D3 canonical) path.
 */

import { VisibilityLevel } from '@prisma/client';

/**
 * visibilityLevel values that grant transaction-level detail to AI context.
 * Use as: `visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY }`.
 */
export const TRANSACTION_DETAIL_VISIBILITY: VisibilityLevel[] = [
  VisibilityLevel.FULL,
];

/** True when the given visibility level grants transaction-level detail. */
export function grantsTransactionDetail(level: VisibilityLevel): boolean {
  return TRANSACTION_DETAIL_VISIBILITY.includes(level);
}

/**
 * True when the link grants a requesting Space full account DETAIL — account
 * metadata (institution, real name, credit limit, debt fields) AND per-item
 * detail (investment positions). FULL only; BALANCE_ONLY exposes the balance
 * total alone, SUMMARY_ONLY/PRIVATE/SHARED fail closed.
 *
 * Deliberately shares the FULL gate with grantsTransactionDetail /
 * TRANSACTION_DETAIL_VISIBILITY so the data layer (lib/data/accounts.ts) and
 * the AI assemblers can never disagree about who sees an account's identifying
 * fields (KD-19, same discipline as KD-1/KD-15 for transactions). If the
 * detail rule ever needs to differ from the transaction rule, split this into
 * its own constant then — do not let two copies drift.
 */
export function grantsAccountDetail(level: VisibilityLevel): boolean {
  return grantsTransactionDetail(level);
}
