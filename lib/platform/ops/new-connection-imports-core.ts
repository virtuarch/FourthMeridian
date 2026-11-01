/**
 * lib/platform/ops/new-connection-imports-core.ts  (PB-7 — the tile's fold, pure)
 *
 * Verdicts in, COUNTS out. The input type carries no identity at all (a
 * verdict has a status, a reason category and counts), so the output cannot.
 */

import {
  IMPORT_STATUSES, tallyImportStatuses,
  type ImportReasonCategory, type ImportStatus, type ImportVerdict,
} from "@/lib/platform/onboarding/import-status-core";

export interface NewConnectionImports {
  windowDays: number;
  /** Items linked in the window. */
  started: number;
  byStatus: Record<ImportStatus, number>;
  /** Failed imports by reason category (counts only). */
  failedReasons: Partial<Record<ImportReasonCategory, number>>;
  /** In-progress imports whose newest attempt was interrupted (a resume is pending). */
  interruptedInProgress: number;
  /** A read hit its row cap — every figure is a floor. */
  floor: boolean;
  checkedAt: string;
  notes: string[];
}

export function buildNewConnectionImports(
  verdicts: readonly Pick<ImportVerdict, "status" | "reason" | "interrupted">[],
  opts: { windowDays: number; floor: boolean; checkedAt: Date },
): NewConnectionImports {
  const failedReasons: Partial<Record<ImportReasonCategory, number>> = {};
  for (const v of verdicts) if (v.status === "failed" && v.reason) failedReasons[v.reason] = (failedReasons[v.reason] ?? 0) + 1;
  return {
    windowDays: opts.windowDays,
    started: verdicts.length,
    byStatus: tallyImportStatuses(verdicts),
    failedReasons,
    interruptedInProgress: verdicts.filter((v) => v.status === "in_progress" && v.interrupted).length,
    floor: opts.floor,
    checkedAt: opts.checkedAt.toISOString(),
    notes: [
      `Plaid connections linked by active customers in the last ${opts.windowDays} days (UTC, rolling). Wallets and manual assets have no first-import ledger and are not counted.`,
      `Statuses partition "started": ${IMPORT_STATUSES.join(" · ").replace(/_/g, " ")}.`,
      "Recovered = the first pass was interrupted (a failed or mid-run-ended attempt, or finished by the resume backstop) and a later run completed it.",
      "Failed = needs re-authentication or provider error while incomplete, or no completion 24 h after the import began.",
    ],
  };
}
