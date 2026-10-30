/**
 * components/platform/ops-visual/job-catalog.ts  (Platform Ops visual spec §3)
 *
 * The client-safe words for the 14 scheduled jobs: a human name per job (the raw
 * ledger id appears only in a job's Technical detail) and, for a job that cannot
 * be run by hand, the ONE line that says why.
 *
 * NOT an authority. Whether a job can be run by hand is decided by the operations
 * registry (lib/platform/operations/registry.ts OPERATION_TARGETS) and served by
 * GET /api/platform/platform-ops/operations — the unified Jobs list renders a Run
 * control only for a command that response carries. This map only WORDS the
 * absence. It cannot import that registry (it pulls every job body into the
 * client bundle), so ops-visual.test.ts pins this map to it, key for key.
 */

import { SCHEDULED_JOB_FACTS, type ScheduledJobName } from "@/lib/jobs/registry.core";

export const JOB_LABELS: Readonly<Record<ScheduledJobName, string>> = {
  "sync-banks": "Bank sync",
  "fetch-fx-rates": "FX rates",
  "fetch-security-prices": "Security prices",
  "sync-crypto": "Wallet sync",
  "sync-crypto-continuation": "Wallet sync continuation",
  "process-deletions": "Account deletions",
  "notification-cleanup": "Notification cleanup",
  "notification-retry": "Notification retry",
  "purge-trash": "Data retention sweep",
  "rate-limit-sweep": "Rate-limit sweep",
  "plaid-removal-retry": "Plaid removal retry",
  "product-event-retention": "Product event retention",
  "sol-history-backfill": "Wallet history backfill",
  "evaluate-alerts": "Alert evaluation",
};

/** How a job relates to manual operation (display only — see the header). */
export type ManualAvailability =
  /** OPERATION_TARGETS registers a handler. */
  | { kind: "manual" }
  /** EXCLUDED_TARGETS records why it is automatic-only. */
  | { kind: "automatic"; reason: string }
  /** Neither: no handler and no recorded reason (a genuine gap, spec §3). */
  | { kind: "unavailable"; reason: string };

export const NOT_AVAILABLE_FOR_MANUAL_RUN = "Not available for manual run";

export const JOB_MANUAL: Readonly<Record<ScheduledJobName, ManualAvailability>> = {
  "fetch-fx-rates": { kind: "manual" },
  "fetch-security-prices": { kind: "manual" },
  "evaluate-alerts": { kind: "manual" },
  "sync-banks": { kind: "manual" },
  "sync-crypto": { kind: "manual" },
  "sol-history-backfill": { kind: "manual" },
  "process-deletions": { kind: "automatic", reason: "Automatic only — destructive" },
  "purge-trash": { kind: "automatic", reason: "Automatic only — data retention" },
  "notification-cleanup": { kind: "automatic", reason: "Automatic only" },
  "notification-retry": { kind: "automatic", reason: "Automatic only" },
  "rate-limit-sweep": { kind: "automatic", reason: "Automatic only" },
  "plaid-removal-retry": { kind: "unavailable", reason: NOT_AVAILABLE_FOR_MANUAL_RUN },
  "product-event-retention": { kind: "unavailable", reason: NOT_AVAILABLE_FOR_MANUAL_RUN },
  "sync-crypto-continuation": { kind: "unavailable", reason: NOT_AVAILABLE_FOR_MANUAL_RUN },
};

const FACTS = new Map<string, (typeof SCHEDULED_JOB_FACTS)[number]>(SCHEDULED_JOB_FACTS.map((j) => [j.name, j]));

/** The registered job names, in registry order. */
export const SCHEDULED_JOB_NAMES: readonly string[] = SCHEDULED_JOB_FACTS.map((j) => j.name);

/** A job's human name; an unregistered ledger name is shown as recorded. */
export function jobLabel(job: string): string {
  return (JOB_LABELS as Record<string, string>)[job] ?? job;
}

/** The job this one continues (it runs only when that job deferred work), or null. */
export function continuationOf(job: string): string | null {
  return FACTS.get(job)?.continuationOf ?? null;
}

/** Display availability for a job with NO command in the operations response. */
export function manualAvailability(job: string): ManualAvailability {
  return (JOB_MANUAL as Record<string, ManualAvailability>)[job] ?? { kind: "unavailable", reason: NOT_AVAILABLE_FOR_MANUAL_RUN };
}

/** The registry's declared slots, in words ("every :30 at 00, 06, 12, 18 UTC"). Technical detail only. */
export function slotWords(job: string): string | null {
  const f = FACTS.get(job);
  if (!f) return null;
  const hours = Array.isArray(f.hourUTC) ? f.hourUTC : [f.hourUTC];
  const mm = String(f.minuteUTC).padStart(2, "0");
  if (hours.length === 24) return `hourly at :${mm} UTC`;
  return `${hours.map((h) => `${String(h).padStart(2, "0")}:${mm}`).join(", ")} UTC`;
}
