/**
 * lib/imports/investments/row-identity.ts
 *
 * A7-3 — deterministic externalEventId derivation (investigation §5.2). Priority:
 *   1. the broker reference / confirm number when the profile mapped one —
 *      durable across re-exports;
 *   2. else a content hash of (tradeDate, rawAction, symbol, quantity,
 *      grossAmount, price) plus a within-file ordinal `-n` for the nth identical
 *      tuple in the same file.
 *
 * Properties: re-importing the same file is a full-MATCH no-op; an overlapping
 * longer export MATCHes the overlap and CREATEs the extension; the hash NEVER
 * includes filename or import date (re-exports stay stable); two genuinely
 * distinct same-tuple rows in one file get distinct ids via the ordinal.
 *
 * Pure: node:crypto only, no DB.
 */

import { createHash } from "node:crypto";

/** The raw fields a content hash is built from (verbatim strings, pre-parse). */
export interface RowIdentityInput {
  tradeDate:   string;
  rawAction:   string;
  symbol:      string;
  quantity:    string;
  grossAmount: string;
  price:       string;
  /** Broker reference/confirm number when mapped; empty ⇒ hash path. */
  reference:   string;
}

/** Canonical, order-stable serialization for the content hash. */
function canonical(i: RowIdentityInput): string {
  return [i.tradeDate, i.rawAction, i.symbol, i.quantity, i.grossAmount, i.price]
    .map((s) => (s ?? "").trim())
    .join("");
}

/**
 * Derive stable external ids for a whole file at once (the ordinal needs the
 * within-file view). Returns one id per input row, in order. A non-empty
 * reference wins; otherwise the content hash + an ordinal that increments per
 * repeated identical content tuple.
 */
export function deriveExternalEventIds(rows: RowIdentityInput[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const ref = (r.reference ?? "").trim();
    if (ref) return ref;
    const h = createHash("sha256").update(canonical(r)).digest("hex").slice(0, 32);
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return `h:${h}-${n}`;
  });
}
