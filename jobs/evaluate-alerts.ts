/**
 * jobs/evaluate-alerts.ts  (OPS-5 S5 — Alerting)
 *
 * The alert-evaluation job body. Registered in lib/jobs/registry.core.ts with an
 * operator-editable EXECUTION CADENCE (P1 HUMAN OPERABILITY, 2026-10-08:
 * `job_cadence_hours_evaluate-alerts`, default every 6 hours, floor 1 hour —
 * P0 had moved it from once daily to every :30 slot; the slot is gone, the
 * cadence stays), sequenced LAST in registry order so a wake that also runs
 * sync/fx jobs evaluates the fresh state they leave. The dispatcher runs it
 * through runJob(), which writes its returned
 * AlertRunSummary into the JobRun ledger — that ledger row IS the alert history
 * and the next cycle's suppression input (no new table).
 *
 * The body is the thinnest possible wrapper over evaluatePlatformAlerts(): all
 * gathering, evaluation, suppression, and delivery live in lib/alerts. It never
 * throws (evaluatePlatformAlerts is best-effort end-to-end), so a bad cycle is a
 * `succeeded` run whose summary records the failure detail — the alerting job
 * must never become the thing that pages you at 3am.
 */

import { evaluatePlatformAlerts } from "@/lib/alerts/run";
import type { AlertRunSummary } from "@/lib/alerts/evaluate";

/** Run one alert-evaluation cycle. Returns the summary for the JobRun ledger. */
export async function evaluateAlerts(): Promise<AlertRunSummary> {
  return evaluatePlatformAlerts();
}
