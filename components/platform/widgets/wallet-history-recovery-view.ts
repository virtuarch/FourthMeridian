/**
 * components/platform/widgets/wallet-history-recovery-view.ts
 *
 * PURE copy for the "Resume history" panel (WalletHistoryRecoveryPanel.tsx) —
 * every sentence the operator reads before and after a resume, from the
 * server's facts only. No I/O, no React.
 */

import type { HistoryResumePreviewResponse, HistoryResumeResponse } from "@/app/api/platform/platform-ops/connections/[id]/history-resume/route";

export const RECOVERY_PANEL_TITLE = "History recovery";

export const RESUME_CONFIRM_TEXT =
  "Runs ONE bounded pass now, under this wallet's sync lock and today's shared provider budget. Existing history and checkpoints are kept; nothing is reset.";

export const historyResumeUrl = (connectionId: string) =>
  `/api/platform/platform-ops/connections/${encodeURIComponent(connectionId)}/history-resume`;

/** The lines shown before confirming: why it stopped, how far it got, what today's budget allows. */
export function previewLines(p: HistoryResumePreviewResponse): string[] {
  const h = p.history;
  const lines: string[] = [];
  if (h) {
    lines.push(`State: ${h.state}${h.lastFailureCode ? ` — ${h.lastFailureCode} (×${h.failures})` : ""}`);
    lines.push(`Verified: ${h.verifiedFromISO ? `${h.verifiedFromISO} → ${h.verifiedToISO ?? "—"}` : "nothing licensed yet"}`);
    lines.push(`Progress: ${h.processed.count} ${h.processed.unit}${h.headVerified ? ", head verified" : ""}`);
  }
  if (p.budget) lines.push(`Budget today: ${p.budget.remaining} of ${p.budget.dailyRequestCap} requests left (this wallet used ${p.requestsToday})`);
  lines.push(`Worker for ${p.chain ?? "this chain"}: ${p.workerEnabled ? "on" : "off"}`);
  return lines;
}

/** The structured result of a pass, in sentences. */
export function resultLines(r: HistoryResumeResponse): string[] {
  const a = r.after;
  const lines = [
    `${r.result === "SUCCESS" ? "Resumed" : "Pass ran but did not recover"}: ${r.before.state} → ${a?.state ?? "unknown"}${r.failureCode ? ` (${r.failureCode})` : ""}`,
    `Verified back to: ${a?.verifiedFromISO ?? "—"}`,
    `Requests used: ${r.requests}; rows written: ${r.rowsWritten}`,
  ];
  if (!r.moreWorkRemains) lines.push("History is complete — no further work.");
  else if (r.continuesAutomatically) lines.push(`More work remains and will continue automatically${r.regenerationPending ? " (wealth history regeneration is queued)" : ""}.`);
  else lines.push("More work remains and will NOT continue automatically — review the state above.");
  return lines;
}
