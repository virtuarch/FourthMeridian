/**
 * lib/transactions/debt-payments.ts
 *
 * Phase 3 — grouping the canonical DEBT_PAYMENT liquidity rows for the Debt
 * Payments widget by CREDITOR, so the widget shows one aggregate row per
 * creditor rather than one row per individual payment.
 *
 * "Did the data earn this?" — honest scope note. The desired grouping is by
 * *liability account*, but the client transaction DTO does not carry a populated
 * `counterpartyAccountId` for debt payments (the KD-18 owned-counterparty seam is
 * unfilled for these rows — verified 0/303 on the live dataset), so the true
 * liability account behind each payment is not knowable here. The only creditor
 * signal is the payment descriptor, and the resolved `merchantDisplayName` bakes
 * volatile per-payment tokens (statement dates, card last-4, ACH trace / WEB IDs)
 * into the name — which is exactly what fragments one creditor into hundreds of
 * near-unique rows. So we group by a NORMALIZED creditor label: the descriptor
 * with those volatile tokens stripped. This is a presentation-only label
 * normalizer over existing fields — it classifies NOTHING about the flow (the row
 * is already a canonical DEBT_PAYMENT); it only decides which rows share a
 * creditor heading. A future slice that populates counterpartyAccountId would let
 * this group by the real liability account.
 */

import type { Transaction } from "@/types";

/** Best raw creditor descriptor for a debt-payment row (pre-normalization). */
export function rawCreditorLabel(t: Pick<Transaction, "merchantDisplayName" | "merchant" | "description">): string {
  return (t.merchantDisplayName?.trim() || t.merchant?.trim() || t.description?.trim() || "Debt payment");
}

function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Collapse a debt-payment descriptor to a stable creditor key by stripping the
 * volatile per-payment tokens that would otherwise fragment one creditor into
 * many rows: statement dates, "ending in ####/MM/DD", ACH trace codes, WEB/REF
 * IDs and long digit runs. Conservative — it removes only clearly volatile
 * tokens, never real creditor words, so distinct creditors never merge.
 */
export function normalizeCreditor(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return "Debt payment";
  s = s.toUpperCase().replace(/\s+/g, " ");
  s = s
    .replace(/\bWEB ID:?.*$/i, "")                       // trailing "WEB ID: 12408506…"
    .replace(/\bREF(?:ERENCE)?\s*#?\s*\w+/gi, "")        // reference/trace numbers
    .replace(/\bCONF(?:IRMATION)?\s*#?\s*\w+/gi, "")     // confirmation numbers
    .replace(/\bENDING IN\b.*$/i, "")                    // "card ending in 0202 02/27"
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, "")  // MM/DD or MM/DD/YY(YY) dates
    .replace(/\bM\d{3,}\b/gi, "")                        // ACH trace ("ACH PMT M6410")
    .replace(/\b\d{4,}\b/g, "")                          // long digit runs (acct/ref)
    .replace(/[#*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s\-–—]+$/, "")                           // trailing dashes/space
    .trim();
  if (!s) return "Debt payment";
  return toTitleCase(s);
}

export interface DebtPaymentGroup {
  /** Stable grouping key == display label (the normalized creditor). */
  id:    string;
  label: string;
  value: number;
  count: number;
}

/**
 * Group already-filtered debt-payment rows by normalized creditor, descending by
 * amount. `magnitude` converts+abs a row (the caller supplies the money context
 * so this stays pure). Every input row lands in exactly one group (its creditor),
 * so no payment is double-counted and Σ(group values) == Σ(row magnitudes).
 */
export function groupDebtPaymentsByCreditor(
  payments: Transaction[],
  magnitude: (t: Transaction) => number,
): DebtPaymentGroup[] {
  const by = new Map<string, { value: number; count: number }>();
  for (const t of payments) {
    const key = normalizeCreditor(rawCreditorLabel(t));
    const g = by.get(key) ?? { value: 0, count: 0 };
    g.value += magnitude(t);
    g.count += 1;
    by.set(key, g);
  }
  return [...by.entries()]
    .map(([label, g]) => ({ id: label, label, value: g.value, count: g.count }))
    .filter((g) => g.value > 0)
    .sort((a, b) => b.value - a.value);
}
