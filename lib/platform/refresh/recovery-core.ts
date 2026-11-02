/**
 * lib/platform/refresh/recovery-core.ts  (PB-7 — "recovered, not failed", pure)
 *
 * THE PROBLEM (Production, 2026-11-01). A new invitee linked Wells Fargo. The
 * exchange-token route's after() import ran under a RECONNECT execution and was
 * killed at the 300 s function limit (20:44Z) — no completion write. The
 * resume-stale-imports backstop then drove the same Item to completion under a
 * RESUME / IMPORT_RECOVERY execution (20:55Z, SUCCEEDED, 1,388 transactions,
 * wealth regeneration ran). At 21:00Z the stale-execution reaper finalised the
 * killed row as FAILED / "stale: …" — correctly: that process DID die.
 *
 * But every reader that counts FAILED rows then told the owner the import
 * failed: Platform Ops' user-impact list ("Refresh · Plaid item — Failed"), the
 * pipeline domain ("1 of N failed" → DEGRADED), the latest-failures list, the
 * Pipeline "Failed" KPI and the execution tables, and the Customer Success
 * profile's "Recent refreshes" ("reconnect failed"). The customer's data was
 * complete. Note the reaped row's completedAt (21:00) is LATER than the
 * recovery's (20:55): a reader ordering by completion would even pick the
 * failure as "latest".
 *
 * THE RULE (reader-side; the ledger row is never rewritten — it stays the
 * honest record that a process ended mid-run): a REAPED execution
 * (isReapedStaleExecution) is RECOVERED when a SUCCEEDED execution for the SAME
 * source STARTED after it. Start order, not completion order, because the
 * reaper's completedAt is the reap instant, not when the work stopped.
 *
 * Deliberately narrow:
 *   • only reaped rows — a FAILED row written by its own completion recorded a
 *     real error (a provider timeout, an auth failure); a later success does
 *     not make that error not have happened, so it still reads as failed;
 *   • only a later SUCCEEDED — a PARTIAL successor still left work undone;
 *   • same source only (the Plaid item, or the wallet's sourceRef).
 *
 * Pure: no I/O, no clock. Deterministic regardless of input order.
 */

import { isReapedStaleExecution } from "@/lib/plaid/stale-execution.core";

export { isReapedStaleExecution };

/** The minimum an execution row must carry for the supersession rule. */
export interface SupersessionFact {
  id: string;
  plaidItemId: string | null;
  sourceKind: string;
  sourceRef: string | null;
  startedAt: Date | string;
  overallStatus: string;
  errorSummary: string | null;
}

/** The display word for a recovered (reaped, then superseded) execution. Never written to the ledger. */
export const RECOVERED_STATUS_WORD = "RECOVERED";

/** One source's identity: the Plaid item, else the source kind + its own ref; null when neither is recorded. */
export function sourceKeyOf(f: Pick<SupersessionFact, "plaidItemId" | "sourceKind" | "sourceRef">): string | null {
  if (f.plaidItemId) return `item:${f.plaidItemId}`;
  if (f.sourceRef) return `${f.sourceKind}:${f.sourceRef}`;
  return null;
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));

/**
 * Reaped execution id → the id of the EARLIEST later SUCCEEDED execution for the
 * same source (ties by id, so the answer is stable). Reaped rows with no such
 * successor are absent — they still read as failed.
 */
export function findRecoveredExecutions(rows: readonly SupersessionFact[]): Map<string, string> {
  const successes = new Map<string, { id: string; at: number }[]>();
  for (const r of rows) {
    if (r.overallStatus !== "SUCCEEDED") continue;
    const key = sourceKeyOf(r);
    if (!key) continue;
    const list = successes.get(key) ?? [];
    list.push({ id: r.id, at: ms(r.startedAt) });
    successes.set(key, list);
  }
  for (const list of successes.values()) list.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const out = new Map<string, string>();
  for (const r of rows) {
    if (!isReapedStaleExecution(r)) continue;
    const key = sourceKeyOf(r);
    if (!key) continue;
    const at = ms(r.startedAt);
    const next = (successes.get(key) ?? []).find((s) => s.at > at);
    if (next) out.set(r.id, next.id);
  }
  return out;
}

/** The ids of the reaped rows a later success superseded (convenience over findRecoveredExecutions). */
export function recoveredExecutionIds(rows: readonly SupersessionFact[]): Set<string> {
  return new Set(findRecoveredExecutions(rows).keys());
}

/**
 * A projection's FAILED count with the recovered rows taken out — what every
 * "failed" figure shows (the ledger's own byStatus.FAILED stays unchanged).
 * `recovered` is optional so a payload from before PB-7 still reads.
 */
export function unrecoveredFailed(x: { byStatus: Readonly<Record<string, number>>; recovered?: number | null }): number {
  return Math.max(0, (x.byStatus.FAILED ?? 0) - (x.recovered ?? 0));
}
