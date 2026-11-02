/**
 * components/platform/widgets/onboarding-view.ts  (PB-7 — words + tones, pure)
 *
 * Presentation for the three PB-7 surfaces: the profile's Onboarding timeline,
 * the Customer Success "Recently joined" panel and the Platform Ops
 * "New-connection imports" tile. React-free so the words are testable.
 */

import { recoveredPhrase, type ImportHealthDot, type ImportStatus } from "@/lib/platform/onboarding/import-status-core";
import type { OnboardingConnection } from "@/lib/platform/customer/onboarding-core";
import type { StatusTone } from "./job-health-format";

export const IMPORT_STATUS_TONE: Readonly<Record<ImportStatus, StatusTone>> = {
  complete: "ok",
  recovered: "warn",
  in_progress: "warn",
  failed: "bad",
  removed: "muted",
};

export const IMPORT_STATUS_LABEL: Readonly<Record<ImportStatus, string>> = {
  complete: "Complete",
  recovered: "Recovered",
  in_progress: "In progress",
  failed: "Failed",
  removed: "Removed",
};

export const DOT_TONE: Readonly<Record<ImportHealthDot, StatusTone>> = { green: "ok", amber: "warn", red: "bad", none: "muted" };

export const DOT_WORD: Readonly<Record<ImportHealthDot, string>> = {
  green: "imports complete",
  amber: "import in progress or recovered",
  red: "an import failed",
  none: "no bank connection yet",
};

/**
 * PB-7 Preview nit (c) — the dot's words for one customer: "none" with a wallet
 * linked is not "no connection yet" (wallet imports are not tracked by the dot).
 */
export function dotWord(dot: ImportHealthDot, opts: { wallets: number }): string {
  return dot === "none" && opts.wallets > 0 ? "no bank connection (wallet linked)" : DOT_WORD[dot];
}

/** PB-7 Preview nit (a) — the status words on a timeline connection row ("Recovered after an interruption (earlier attempt: …)" for a recovery). */
export function connectionStatusWord(c: Pick<OnboardingConnection, "importStatus" | "reason">): string {
  if (c.importStatus === null) return "";
  return c.importStatus === "recovered" ? recoveredPhrase(c.reason) : IMPORT_STATUS_LABEL[c.importStatus];
}

const n = (v: number) => v.toLocaleString("en-US");

/** The detail after a timeline connection row's status word ("" when there is nothing to add). */
export function connectionImportDetail(c: OnboardingConnection): string {
  if (c.importStatus === null) return "linked · no first-import ledger for wallets";
  const tx = c.transactions !== null ? `${n(c.transactions)} transaction${c.transactions === 1 ? "" : "s"}` : null;
  const attempts = c.attempts > 1 ? `${c.attempts} attempts${c.interruptedAttempts ? `, ${c.interruptedAttempts} ended mid-run` : ""}` : null;
  const parts: (string | null)[] =
    c.importStatus === "complete" ? [tx, attempts]
    : c.importStatus === "recovered" ? [tx, attempts] // the reason rides the status word (connectionStatusWord)
    : c.importStatus === "in_progress" ? [tx ? `${tx} so far` : null, c.interrupted ? "last attempt interrupted — resume pending" : null]
    : c.importStatus === "failed" ? [c.reasonLabel ?? "reason not recorded", tx ? `${tx} before it stopped` : null]
    : ["by the customer"];
  return parts.filter(Boolean).join(" · ");
}

/** The tile's figures, in display order. `started` first; the rest partition it. */
export function importTileFigures(byStatus: Readonly<Record<ImportStatus, number>>, started: number): { key: string; label: string; value: number; tone: StatusTone | undefined }[] {
  return [
    { key: "started", label: "Started", value: started, tone: undefined },
    { key: "complete", label: "Completed", value: byStatus.complete, tone: "ok" },
    { key: "recovered", label: "Recovered", value: byStatus.recovered, tone: byStatus.recovered > 0 ? "warn" : undefined },
    { key: "in_progress", label: "In progress", value: byStatus.in_progress, tone: undefined },
    { key: "failed", label: "Failed", value: byStatus.failed, tone: byStatus.failed > 0 ? "bad" : "ok" },
  ];
}
