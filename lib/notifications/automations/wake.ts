/**
 * lib/notifications/automations/wake.ts  (Comms Center B2 — the executor on the dispatcher WAKE)
 *
 * The engine (engine.ts) runs on EVERY dispatcher wake (app/api/jobs/dispatch,
 * every 15 minutes), after the registered jobs, as its own ledgered job:
 * runJob("comms-automations", …) — one JobRun row, the summary as counts, the
 * unique `running` claim as the overlap guard (a second wake gets
 * JobAlreadyRunningError and runs nothing). A delay's jitter is therefore at
 * most one wake.
 *
 * WHY THE WAKE AND NOT A REGISTRY ENTRY. The registry's job-name union is
 * consumed exhaustively by the Platform Ops job catalogue UI (Session 2's
 * surface); a registry entry would need that catalogue to change in the same
 * PR. The wake step needs no UI change and keeps every other job's schedule
 * byte-identical. Promoting it to a registry job is a follow-up for the UI owner.
 *
 * QUIET WHEN IDLE: with no ACTIVE automation and no pending item (the state this
 * PR ships in) the step is two COUNT reads — no JobRun row, nothing sent.
 *
 * NEVER THROWS and never changes the wake's HTTP status: a failure is the
 * JobRun row's `failed` status plus one redacted log line.
 *
 * BUDGET: the wake shares one function invocation (maxDuration 300 s); the
 * engine gets min(120 s, what is left minus a 30 s margin), and is skipped when
 * under 10 s remain.
 */

import { runJob, JobAlreadyRunningError } from "@/lib/jobs/run";
import { DEFAULT_BUDGET, type EngineDb } from "./engine";

export const COMMS_AUTOMATIONS_JOB = "comms-automations";
const WAKE_MAX_MS = 300_000;
const MARGIN_MS = 30_000;
const MIN_BUDGET_MS = 10_000;

export type WakeOutcome = "IDLE" | "RAN" | "IN_FLIGHT" | "NO_TIME" | "FAILED";

export interface WakeDeps {
  db: Pick<EngineDb, "automationDefinition" | "automationRunItem">;
  run: (budgetMs: number) => Promise<unknown>;
  runner?: typeof runJob;
  now?: () => Date;
}

/** Is there anything for the engine to do? Two indexed COUNTs. */
export async function engineHasWork(db: WakeDeps["db"]): Promise<boolean> {
  const [active, pending] = await Promise.all([
    db.automationDefinition.count({ where: { state: "ACTIVE" } }),
    db.automationRunItem.count({ where: { status: { in: ["SCHEDULED", "SENDING", "FAILED"] } } }),
  ]);
  return active > 0 || pending > 0;
}

export async function runCommsAutomationsWake(wakeStartedAt: Date, deps?: WakeDeps): Promise<WakeOutcome> {
  try {
    const d = deps ?? (await productionWakeDeps());
    if (!(await engineHasWork(d.db))) return "IDLE";
    const elapsed = (d.now ?? (() => new Date()))().getTime() - wakeStartedAt.getTime();
    const budgetMs = Math.min(DEFAULT_BUDGET.timeBudgetMs, WAKE_MAX_MS - MARGIN_MS - elapsed);
    if (budgetMs < MIN_BUDGET_MS) return "NO_TIME";
    await (d.runner ?? runJob)(COMMS_AUTOMATIONS_JOB, () => d.run(budgetMs), { trigger: "cron", budgetStartedAt: wakeStartedAt });
    return "RAN";
  } catch (e) {
    if (e instanceof JobAlreadyRunningError) return "IN_FLIGHT";
    console.error(`[comms-automations] wake step failed (the dispatcher wake is unaffected): ${e instanceof Error ? e.name : typeof e}`);
    return "FAILED";
  }
}

async function productionWakeDeps(): Promise<WakeDeps> {
  const { systemDb } = await import("@/lib/db");
  const { commsAutomations } = await import("@/jobs/comms-automations");
  return {
    db: systemDb as unknown as WakeDeps["db"],
    run: (budgetMs) => commsAutomations(undefined, budgetMs),
  };
}
