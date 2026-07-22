/**
 * jobs/evaluate-alerts.ts  (OPS-5 S5 — Alerting)
 *
 * The alert-evaluation job body. Registered in lib/jobs/registry.ts on the 07:30
 * UTC slot (already covered by the single dispatcher cron — NO vercel.json
 * change), sequenced after the 06:00/06:30 sync/fx/health jobs so it evaluates
 * fresh state. The dispatcher runs it through runJob(), which writes its returned
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
