/**
 * lib/platform/intelligence/ai/conversations/purge-health.ts  (PR D — "retention proven operational", PURE)
 *
 * S2 / OD-7 activation (a), design §13: while Platform AI conversations are ON,
 * Platform Ops must see the retention purge as LATE when no successful purge run
 * has been recorded for more than PLATFORM_AI_PURGE_STALE_HOURS. This file is the
 * pure verdict; the facts are gathered by ./purge-health.server.ts from the two
 * ledgers the purge already writes (no new table, no new write):
 *
 *   · JobRun (`purge-trash`, the scheduled job): EVERY run leaves a row whose
 *     summary carries `retention.platformAiConversations` = { enabled,
 *     conversations, messages, batches, exhausted } — counts only, ZERO-COUNT
 *     runs included. A `succeeded` row whose purge was enabled and reported no
 *     error is a successful purge run (zero removed is still a success).
 *   · AuditLog `PLATFORM_AI_CONVERSATIONS_PURGED` with trigger MANUAL_DISPATCH:
 *     the manual dispatch (Preview, no crons) writes one counts-only row EVERY
 *     run, zero included; a row WITHOUT `failed: true` is a successful purge run.
 *
 * The verdict reads timestamps and booleans only — never a count's meaning, an
 * id or any content. "On" = the conversations flag is set (whether or not the
 * purge flag is: the misordered state is ON and is exactly when a purge is
 * missing). Off ⇒ no signal at all.
 *
 * No database, no env, no clock (the caller passes `now`), no I/O.
 */

/** No successful purge run for more than this, while conversations are ON ⇒ LATE. */
export const PLATFORM_AI_PURGE_STALE_HOURS = 36;
/** The registered job the scheduled purge runs inside (lib/jobs/registry.core.ts). */
export const PLATFORM_AI_PURGE_JOB_NAME = "purge-trash";

const HOUR_MS = 3_600_000;

export type PlatformAiPurgeHealthState =
  /** The conversations flag is off: nothing to prove, no signal. */
  | "OFF"
  /** On, and a successful purge run inside the window. */
  | "OK"
  /** On, and no successful purge run for more than the window (or ever). */
  | "LATE";

export interface PlatformAiPurgeHealth {
  state: PlatformAiPurgeHealthState;
  /** The newest successful purge run (ISO), or null when none is recorded / not read (OFF). */
  lastSuccessAt: string | null;
  staleAfterHours: number;
  checkedAt: string;
}

/**
 * PURE. True when a `purge-trash` JobRun summary records an ENABLED purge that
 * reported no error and was not misordered. Counts are not read: a zero-count
 * run is a success.
 */
export function isSuccessfulPurgeSummary(summary: unknown): boolean {
  if (!summary || typeof summary !== "object") return false;
  const p = (summary as { retention?: { platformAiConversations?: unknown } }).retention?.platformAiConversations;
  if (!p || typeof p !== "object") return false;
  const r = p as { enabled?: unknown; error?: unknown; misordered?: unknown };
  return r.enabled === true && r.error === undefined && r.misordered === undefined;
}

/** PURE. True for a manual-dispatch purge audit row that did not fail (counts are not read: zero is a success). */
export function isSuccessfulDispatchAudit(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const m = metadata as { trigger?: unknown; failed?: unknown };
  return m.trigger === "MANUAL_DISPATCH" && m.failed === undefined;
}

/** PURE. The verdict. `lastSuccessAt` = the newest successful run from either ledger (null = none). */
export function evaluatePlatformAiPurgeHealth(input: { conversationsOn: boolean; lastSuccessAt: Date | null; now: Date }): PlatformAiPurgeHealth {
  const base = { staleAfterHours: PLATFORM_AI_PURGE_STALE_HOURS, checkedAt: input.now.toISOString() };
  if (!input.conversationsOn) return { ...base, state: "OFF", lastSuccessAt: null };
  const last = input.lastSuccessAt;
  const late = !last || input.now.getTime() - last.getTime() > PLATFORM_AI_PURGE_STALE_HOURS * HOUR_MS;
  return { ...base, state: late ? "LATE" : "OK", lastSuccessAt: last ? last.toISOString() : null };
}

/** The newest of two optional instants. */
export function newestOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
