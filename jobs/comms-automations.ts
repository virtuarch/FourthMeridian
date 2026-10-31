/**
 * jobs/comms-automations.ts  (Comms Center B2 — the automation EXECUTOR job)
 *
 * One bounded pass of the engine (lib/notifications/automations/engine.ts),
 * registered as `comms-automations` in lib/jobs/registry.core.ts and run by the
 * dispatcher through runJob() like every scheduled job — so job health, the ops
 * overview and alerting cover it. The JobRun summary holds counts only.
 *
 * CADENCE: hourly anchor, SELF-CONTINUING (~15 min, CONTINUATION_DELAY_MS) while
 * an automation is ACTIVE or an item is pending (`deferred > 0`), so a delay's
 * jitter is about one wake. Idle, it runs hourly and sends nothing.
 *
 * BUDGET: it shares the wake's function invocation with the jobs before it, so
 * it gets min(120 s, 270 s − the wake's elapsed time) (currentBudgetStartedAtMs);
 * under 10 s it does nothing and defers.
 *
 * BOUNDED (≤ 50 automations, ≤ 100 facts each, ≤ 200 deliveries), IDEMPOTENT per
 * run item (the unique idempotencyKey claim + the SCHEDULED → SENDING lease) and
 * RESUMABLE (the per-automation keyset cursor; an expired lease returns its item).
 *
 * SKIPPED (job health's skipped semantics → the ops overview shows DEGRADED):
 *   · the GLOBAL Cost Freeze (ON / INVALID / UNAVAILABLE): live runs HALT,
 *     scheduled items CANCELLED / PROVIDER_FREEZE, `skipReason: "BILLABLE_<reason>"`;
 *   · the activation gate closed (automationActivationEnabled(process.env): Preview + the
 *     COMMS_AUTOMATIONS_PREVIEW_ENABLED="true" switch only — never Production) with an ACTIVE row
 *     or pending item: nothing written, nothing sent, `skipReason: "ACTIVATION_DISABLED_PENDING_HARDENING"`.
 *     The gate is re-read before every send, so unsetting the switch stops a pass mid-run;
 *   · platform admission (COMMS_AUTOMATION_SEND) denied — maintenance or an unreadable
 *     control plane: nothing sent, `skipReason: "ADMISSION_<reason>"` (HARDENING A5).
 * With the gate closed and nothing held the run is COMPLETE with `note: "ACTIVATION_DISABLED"`
 * (not a skip: that would pin the jobs domain DEGRADED for as long as the gate is closed by design).
 */

import { runAutomationEngine, DEFAULT_BUDGET, type EngineDeps, type EngineSummary } from "@/lib/notifications/automations/engine";

/** The wake's usable function time (maxDuration 300 s less a 30 s margin). */
export const WAKE_USABLE_MS = 270_000;
export const MIN_PASS_MS = 10_000;

export interface CommsAutomationsResult extends EngineSummary {
  /** Items SCHEDULED for later (a delay not yet elapsed). */
  pendingScheduled: number;
  /** The pass budget actually granted (ms). */
  budgetMs: number;
}

export async function commsAutomations(deps?: EngineDeps, opts: { budgetStartedAtMs?: number | null } = {}): Promise<CommsAutomationsResult> {
  const d = deps ?? (await import("@/lib/notifications/automations/engine-deps")).productionEngineDeps();
  const now = d.now().getTime();
  const wakeStart = opts.budgetStartedAtMs !== undefined ? opts.budgetStartedAtMs
    : (await import("@/lib/jobs/run")).currentBudgetStartedAtMs();
  const budgetMs = Math.min(DEFAULT_BUDGET.timeBudgetMs, WAKE_USABLE_MS - (now - (wakeStart ?? now)));
  const work = async () => {
    const [active, pending] = await Promise.all([
      d.db.automationDefinition.count({ where: { state: "ACTIVE" } }),
      d.db.automationRunItem.count({ where: { status: { in: ["SCHEDULED", "SENDING", "FAILED"] } } }),
    ]);
    return active > 0 || pending > 0;
  };
  // Too little of the wake left: do nothing now, self-continue ~15 min later.
  if (budgetMs < MIN_PASS_MS) {
    return { ...emptySummary(), outcome: "PARTIAL", deferred: 1, pendingScheduled: 0, budgetMs: Math.max(0, budgetMs) };
  }
  const summary = await runAutomationEngine(d, { ...DEFAULT_BUDGET, timeBudgetMs: budgetMs });
  if (summary.outcome === "SKIPPED") return { ...summary, pendingScheduled: 0, budgetMs };
  // The activation gate is closed and nothing is held: nothing can run — no self-continuation, the note says why.
  if (summary.note === "ACTIVATION_DISABLED") return { ...summary, pendingScheduled: 0, budgetMs };
  const pendingScheduled = await d.db.automationRunItem.count({ where: { status: "SCHEDULED" } });
  return { ...summary, pendingScheduled, budgetMs, deferred: summary.deferred + ((await work()) ? 1 : 0) };
}

function emptySummary(): EngineSummary {
  return { outcome: "COMPLETE", automations: 0, facts: 0, runs: 0, claimed: 0, deduped: 0, scheduled: 0, sent: 0, suppressed: 0, cancelled: 0, failed: 0, dead: 0, halted: 0, autoPaused: 0, deferred: 0, recovered: 0, staleFacts: 0, errors: 0 };
}
