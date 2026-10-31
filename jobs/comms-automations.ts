/**
 * jobs/comms-automations.ts  (Comms Center B2 — the automation EXECUTOR job)
 *
 * One bounded pass of the engine (lib/notifications/automations/engine.ts),
 * run on EVERY dispatcher wake (every 15 minutes) through runJob() as the
 * ledgered job `comms-automations` (lib/notifications/automations/wake.ts) —
 * the JobRun summary holds counts only. A delay's jitter is about one wake.
 *
 * BOUNDED: ≤ 50 automations, ≤ 100 facts each, ≤ 200 deliveries, ≤ 120 s per
 * pass (less when the wake's other jobs used the function's time). IDEMPOTENT per run item (the unique idempotencyKey claim + the
 * SCHEDULED → SENDING lease) and RESUMABLE (the per-automation keyset cursor;
 * an expired lease returns its item to SCHEDULED).
 *
 * COST FREEZE: under the GLOBAL Cost Freeze (readGlobalCostFreeze: ON / INVALID
 * / UNAVAILABLE) every live run HALTS, scheduled items are CANCELLED /
 * PROVIDER_FREEZE and nothing is sent; the run reports `outcome: "SKIPPED"`
 * with `skipReason: "BILLABLE_<reason>"` — the job runner's skipped semantics
 * (lib/jobs/health.ts), so job health shows "Skipped (cost freeze)", not a success.
 *
 * NOTHING IS ACTIVE BY DEFAULT: with no ACTIVE automation (this PR ships none)
 * the pass is a handful of indexed reads and sends nothing.
 */

import { runAutomationEngine, DEFAULT_BUDGET, type EngineDeps, type EngineSummary } from "@/lib/notifications/automations/engine";

export interface CommsAutomationsResult extends EngineSummary {
  /** Items SCHEDULED for later (a delay not yet elapsed). */
  pendingScheduled: number;
}

export async function commsAutomations(deps?: EngineDeps, timeBudgetMs: number = DEFAULT_BUDGET.timeBudgetMs): Promise<CommsAutomationsResult> {
  const d = deps ?? (await import("@/lib/notifications/automations/deps")).productionEngineDeps();
  const summary = await runAutomationEngine(d, { ...DEFAULT_BUDGET, timeBudgetMs });
  const pendingScheduled = summary.outcome === "SKIPPED" ? 0 : await d.db.automationRunItem.count({ where: { status: "SCHEDULED" } });
  return { ...summary, pendingScheduled };
}
