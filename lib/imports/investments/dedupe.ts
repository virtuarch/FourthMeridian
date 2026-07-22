/**
 * lib/imports/investments/dedupe.ts
 *
 * A7-3 — the PURE dedupe classifier (investigation §5.1). Given one row and the
 * set of pre-import DB candidate events (fetched batched by the commit path,
 * NEVER including this file's own just-written rows), decide MATCH / CREATE /
 * SKIP_AMBIGUOUS. No DB, no writes.
 *
 * Decision order:
 *   1. within-source exact: a candidate with the same [source, externalEventId]
 *      ⇒ MATCH (re-import of the same file / overlapping same-broker export).
 *   2. cross-source fingerprint (vs Plaid, other brokers, manual): same-date
 *      candidates narrowed per row class — exactly one ⇒ MATCH, more than one ⇒
 *      SKIP_AMBIGUOUS (never guessed), zero ⇒ CREATE.
 *
 * Amounts are compared by ABSOLUTE value (sign conventions differ across
 * sources); a null amount is a wildcard. Quantity uses QUANTITY_EPSILON. Nothing
 * is ever mutated — investment sources are append-only (supportsUpdateOnMatch is
 * false for all of them).
 */

import { InvestmentEventType } from "@prisma/client";

export const QUANTITY_EPSILON = 1e-6;
export const MONETARY_EPSILON = 0.01;

export type DedupeOutcome = "MATCH" | "CREATE" | "SKIP_AMBIGUOUS";

export interface DedupeCandidate {
  id:              string;
  source:          string;
  externalEventId: string | null;
  date:            string;
  type:            InvestmentEventType | null;
  instrumentId:    string | null;
  quantity:        number | null;
  amount:          number | null;
  ratio:           number | null;
}

/** The current row, with its instrument already resolved by the commit path. */
export type DedupeRow = Omit<DedupeCandidate, "id">;

export interface DedupeResult {
  outcome:   DedupeOutcome;
  matchedId: string | null;
  reason:    string;
}

export type RowClass = "security" | "cash" | "corporate" | "transfer";

export function classifyRow(row: Pick<DedupeRow, "type" | "instrumentId">): RowClass {
  const T = InvestmentEventType;
  if (row.type === T.SPLIT || row.type === T.MERGER || row.type === T.SPIN_OFF) return "corporate";
  if (row.type === T.TRANSFER_IN || row.type === T.TRANSFER_OUT) return "transfer";
  if (row.instrumentId == null) return "cash";
  return "security";
}

const qtyMatch = (a: number | null, b: number | null): boolean =>
  a == null && b == null ? true : a != null && b != null ? Math.abs(a - b) <= QUANTITY_EPSILON : false;

/** Absolute-value comparison; a null on either side is a wildcard. */
const amountMatch = (a: number | null, b: number | null): boolean =>
  a == null || b == null ? true : Math.abs(Math.abs(a) - Math.abs(b)) <= MONETARY_EPSILON;

const ratioMatch = (a: number | null, b: number | null): boolean =>
  a == null && b == null ? true : a != null && b != null ? Math.abs(a - b) <= QUANTITY_EPSILON : false;

function fingerprintMatches(row: DedupeRow, c: DedupeCandidate, cls: RowClass): boolean {
  if (c.date !== row.date) return false;
  if (c.type !== row.type) return false;
  switch (cls) {
    case "security":
      return c.instrumentId === row.instrumentId && qtyMatch(c.quantity, row.quantity) && amountMatch(c.amount, row.amount);
    case "cash":
      return c.instrumentId == null && row.instrumentId == null && amountMatch(c.amount, row.amount);
    case "corporate":
      return c.instrumentId === row.instrumentId && ratioMatch(c.ratio, row.ratio);
    case "transfer":
      return c.instrumentId === row.instrumentId && qtyMatch(c.quantity, row.quantity);
  }
}

export function decideInvestmentRowOutcome(row: DedupeRow, candidates: DedupeCandidate[]): DedupeResult {
  // 1. Within-source exact identity.
  if (row.externalEventId) {
    const exact = candidates.find((c) => c.source === row.source && c.externalEventId != null && c.externalEventId === row.externalEventId);
    if (exact) return { outcome: "MATCH", matchedId: exact.id, reason: "exact [source, externalEventId]" };
  }

  // 2. Cross-source fingerprint by row class.
  const cls = classifyRow(row);
  const hits = candidates.filter((c) => fingerprintMatches(row, c, cls));
  if (hits.length === 1) return { outcome: "MATCH", matchedId: hits[0].id, reason: `${cls} fingerprint` };
  if (hits.length > 1)  return { outcome: "SKIP_AMBIGUOUS", matchedId: null, reason: `${cls} fingerprint ambiguous (${hits.length} candidates)` };
  return { outcome: "CREATE", matchedId: null, reason: "no candidate" };
}
