/**
 * lib/prices/capability-reconciliation.ts
 *
 * V26-CAP-1 — THE TRIGGER. Observe declared capability; on a widening, plan the
 * work the newly reachable dates make possible.
 *
 * ── Cadence ──────────────────────────────────────────────────────────────────
 * Called from the existing daily crypto sweep, before it syncs. That is the
 * cheapest reliable place in this repository: it already runs once a day on a
 * schedule this system owns, it already fans out over exactly the accounts a
 * crypto capability change affects, and it is not a request path.
 *
 * Deliberately NOT on a page or API read path — a capability check must never
 * ride a user request — and not on application startup, which in a serverless
 * deployment would fire on every cold start and record noise.
 *
 * The check itself is one indexed row read plus one insert. A normal sweep
 * therefore pays almost nothing and, crucially, plans NO work: only a genuine
 * widening does.
 *
 * ── What it will and will not do ─────────────────────────────────────────────
 * It reports a PLAN. It does not acquire, does not regenerate, and never writes
 * a snapshot or a price itself — those stay with their existing owners, in their
 * existing order. The invariant this slice must protect is that a wider
 * declaration expands only what may be ATTEMPTED; support still moves only when
 * a regeneration succeeds.
 */

import { db } from "@/lib/db";
import { AssetClass } from "@prisma/client";
import { observeProviderCapability, type CapabilityObservationResult } from "./provider-capability";
import { resolveHistoricalWorkWindow } from "@/lib/snapshots/historical-work-window";
import type { HistoricalWorkWindow } from "@/lib/snapshots/historical-work-window.core";

export interface CapabilityWideningPlan {
  observation: CapabilityObservationResult;
  /** Accounts whose history the widening could deepen. Empty ⇒ nothing to do. */
  affectedAccountIds: string[];
  /** Instruments the newly available interval could price. */
  affectedInstrumentIds: string[];
  /**
   * The window to acquire and regenerate, from the CANONICAL planner — never a
   * second date authority. Null when nothing widened or nothing is affected.
   */
  window: HistoricalWorkWindow | null;
}

/**
 * Reconcile one price provider's declared capability.
 *
 * Returns a plan; performs no acquisition and no regeneration.
 */
export async function reconcileProviderCapability(
  providerSource: string,
  opts: { secret?: string; now?: Date } = {},
): Promise<CapabilityWideningPlan> {
  const observation = await observeProviderCapability(providerSource, opts);

  // first-observation / unchanged / narrowed / incomparable / rejected all
  // schedule nothing. Narrowing is explicitly non-destructive: evidence acquired
  // under a wider entitlement stays acquired and stays supported, because it was
  // lawfully returned and successfully regenerated. A narrower declaration
  // constrains only future attempts.
  if (observation.comparison !== "widened" || !observation.newlyAvailable) {
    return { observation, affectedAccountIds: [], affectedInstrumentIds: [], window: null };
  }

  // Which accounts could the newly reachable dates actually deepen? Selected by
  // ASSET CLASS via the position spine — never by ticker, vendor or account type
  // string — so a second crypto asset or a new price vendor needs no change here.
  const held = await db.positionObservation.findMany({
    where:    { instrument: { assetClass: AssetClass.CRYPTO } },
    select:   { financialAccountId: true, instrumentId: true },
    distinct: ["financialAccountId", "instrumentId"],
  });
  const affectedAccountIds = [...new Set(held.map((h) => h.financialAccountId))].sort();
  const affectedInstrumentIds = [...new Set(held.map((h) => h.instrumentId))].sort();

  if (affectedAccountIds.length === 0) {
    return { observation, affectedAccountIds: [], affectedInstrumentIds: [], window: null };
  }

  // The window comes from the CANONICAL planner, handed the widened floor and an
  // impacted-from at the newly reachable date. It re-intersects with evidence,
  // quantity licensing and the writable ceiling, so a capability that outruns
  // what the account can actually support does not produce work.
  const window = await resolveHistoricalWorkWindow({
    financialAccountIds: affectedAccountIds,
    now:                 opts.now,
    initialBuild:        false,
    capabilityOverride: {
      blockingPriceFloorISO: observation.newlyAvailable.fromISO,
      impactedFromISO:       observation.newlyAvailable.fromISO,
    },
  });

  return { observation, affectedAccountIds, affectedInstrumentIds, window };
}
