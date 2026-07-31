/**
 * lib/investments/ownership-windows.ts
 *
 * V26-PRICE-5A — the thin seam that lets the A9 regeneration binding resolve
 * ownership windows without importing lib/prices directly.
 *
 * The binding must not import `@/lib/prices` — a boundary asserted by
 * lib/snapshots/regenerate-history.test.ts ("does NOT open a second historical
 * price lookup") and the reason lib/investments/holding-price-backfill.ts
 * exists. The rule protects against a SECOND price/valuation authority growing
 * inside the snapshot writer, which is exactly the class of defect this whole
 * arc has been unwinding.
 *
 * Ownership resolution reads PositionObservation, InvestmentEvent,
 * FinancialAccount and Transaction — no prices, no providers, no archive. It
 * happens to live under lib/prices because that is where the ownership-window
 * doctrine was defined (V26-PRICE-4), so it needs this wrapper to cross the
 * boundary the same way acquisition does. Weakening the guard instead would
 * have traded a real architectural protection for one import's convenience.
 */

import { loadOwnershipWindows } from "@/lib/prices/ownership-window";
import type { OwnershipResolution } from "@/lib/prices/ownership-window.core";

export type { OwnershipResolution };

/**
 * Ownership windows for a set of instruments against one valuation ceiling.
 * Read-only; no provider contact. See lib/prices/ownership-window.ts.
 */
export async function resolveOwnershipWindowsForInstruments(
  instrumentIds:  readonly string[],
  valuationToISO: string,
): Promise<Map<string, OwnershipResolution>> {
  return loadOwnershipWindows(instrumentIds, valuationToISO);
}
