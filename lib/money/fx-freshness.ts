/**
 * lib/money/fx-freshness.ts
 *
 * Opportunistic stale-while-revalidate (SWR) gate for FX rates.
 *
 * WHY: on the Vercel Hobby (free) tier, cron may only fire once per day, so the
 * scheduled fetch-fx-rates job cannot be relied on to keep the archive current
 * (see app/api/jobs/dispatch/route.ts). This gate keeps conversions reasonably
 * fresh WITHOUT adding cron frequency, queues, schema, or new infrastructure:
 * when a conversion is requested and the newest closed day is missing but older
 * rows exist, it kicks a best-effort background refresh and returns immediately.
 *
 * DOCTRINE:
 *   - Serve stale: the caller builds the conversion context from whatever is
 *     cached NOW. This gate NEVER blocks that path and never awaits a fetch.
 *   - Revalidate in background: newest closed day (yesterday UTC) absent but
 *     older rows present ⇒ fire a best-effort refresh. Next request sees fresh.
 *   - Cold archive (no rows at all) ⇒ NO trigger: the scheduled job / backfill
 *     bootstrap the archive, and the existing RateMiss path is unchanged. We do
 *     not turn a cold-start into a synchronous fetch on the user's request.
 *   - Advisory, never authoritative: freshness is not part of the conversion
 *     contract; failures here must never surface to a conversion.
 *
 * PURE + INJECTABLE: no Prisma, no network, no timers live in this module — the
 * db reads and the throttled background trigger are injected. This mirrors the
 * repo's unit-test pattern (lib/jobs/dispatch.ts, lib/notifications/cleanup.ts)
 * so it runs under a bare tsx script without `prisma generate`. The production
 * wiring lives in lib/money/server-context.ts.
 */

import { yesterdayUTCISO } from "@/lib/fx/config";

/** What the gate decided for one conversion request. */
export type FxRevalidateOutcome =
  /** Newest closed day already present — nothing to do. */
  | "fresh"
  /** No rows at all — bootstrap owns this; no background trigger. */
  | "cold"
  /** Stale but cached — background refresh triggered; stale data served now. */
  | "revalidating";

/** The injected seam: two cheap archive probes + the background trigger. */
export interface FxFreshnessGate {
  /** Clock override for tests; defaults to now. */
  now?: Date;
  /** Does the newest closed day (yesterday UTC) have at least one stored rate? */
  hasFreshDay(freshISO: string): Promise<boolean>;
  /** Does the archive hold ANY stored rate (i.e. is there a cache to serve)? */
  hasAnyCached(): Promise<boolean>;
  /** Best-effort, non-blocking background refresh. Implementations throttle. */
  triggerRefresh(): void;
}

/**
 * Decide whether to kick a background FX refresh for the current request.
 *
 * Pure control flow over the injected gate; never throws on a data condition
 * (probe rejections are the caller's concern — production wraps the call in a
 * catch so freshness I/O can never disturb a conversion).
 */
export async function revalidateFxIfStale(gate: FxFreshnessGate): Promise<FxRevalidateOutcome> {
  const freshISO = yesterdayUTCISO(gate.now ?? new Date());

  // Serve-and-check order: the newest closed day present ⇒ nothing to do.
  if (await gate.hasFreshDay(freshISO)) return "fresh";

  // Stale. Only revalidate when there is a cache to serve in the meantime —
  // a cold archive is the bootstrap path's job, not a user-request fetch.
  if (!(await gate.hasAnyCached())) return "cold";

  gate.triggerRefresh();
  return "revalidating";
}

/**
 * Pure throttle: allow at most one trigger per `minIntervalMs`. Returns whether
 * to fire and the timestamp to remember. Keeping this pure lets the in-process
 * rate-limit be unit-tested without wall-clock timers.
 */
export function shouldTrigger(
  lastAtMs: number,
  nowMs: number,
  minIntervalMs: number,
): { fire: boolean; lastAtMs: number } {
  if (nowMs - lastAtMs < minIntervalMs) return { fire: false, lastAtMs };
  return { fire: true, lastAtMs: nowMs };
}
