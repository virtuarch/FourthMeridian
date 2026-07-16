/**
 * lib/wealth/basis-disclosure.ts
 *
 * HIST-2E — the today/history VALUATION-BASIS disclosure (HIST-2 §F–I, Strategy
 * A+E). PURE, no DB, no arithmetic.
 *
 * Wealth deliberately carries two valuation bases in one series, and both are
 * correct for their job:
 *   - TODAY (the live "today" row) is the provider-reported current account
 *     balance — observed, and reconciled with the live Net-Worth KPI;
 *   - EARLIER dates are RECONSTRUCTED (qty × historical close × historical FX,
 *     cash/card walked back) — estimated.
 * So around the most-recent day the two bases can legitimately differ, and the
 * reconstructed basis can OMIT value the provider includes (a holding with no
 * recent price, or a balance-only-shared account). HIST-2 concluded the seam
 * should be made LEGIBLE, not unified (unifying would make today disagree with
 * the provider balance / KPI — the REG-1 reconciliation). This surfaces the WHY;
 * it changes no number and no valuation.
 *
 * Returns null unless the view actually MIXES the two bases (an observed point
 * AND a reconstructed point are both visible), so the note appears only where the
 * discontinuity is real — never on an all-observed or all-reconstructed view.
 * Reusable by any surface that plots observed-today alongside reconstructed history.
 */

export interface WealthBasisDisclosure {
  title: string;
  note: string;
}

export function wealthBasisDisclosure(input: {
  /** ≥1 observed (live/today) point is visible. */
  hasObserved: boolean;
  /** ≥1 reconstructed (estimated) point is visible. */
  hasReconstructed: boolean;
}): WealthBasisDisclosure | null {
  if (!input.hasObserved || !input.hasReconstructed) return null;
  return {
    title: "How today compares to earlier dates",
    note:
      "Today's value reflects your accounts' current balances as your providers report them; " +
      "earlier dates are reconstructed from historical prices and exchange rates. The two can " +
      "differ around the most recent day — and a holding with no recent price, or an account " +
      "shared as balance-only, may not appear in the reconstructed history.",
  };
}
