/**
 * lib/platform/ai/ledger-health.ts  (IDEMP-009 / OBS-005 — can the AI cost ledger be trusted?)
 *
 * THE ALLOWANCE IS A REDUCTION OVER AiInvocation. A write to that ledger that
 * fails silently makes every downstream safeguard wrong in the SAME direction:
 * the daily spend reads lower than it is, the reservation admits a turn it
 * should refuse, the "healthy" AI tile stays green. Before this module the
 * writer swallowed its failures with `console.warn` and the chokepoint did not
 * even wait for it (`void recordAiInvocation`). Now:
 *
 *   1. the chokepoint AWAITS the ledger write before it returns (lib/ai/provider.ts),
 *      so a row is on the ledger before the HTTP response resolves — on the chat
 *      path and on the Brief path, which both go through the chokepoint;
 *   2. a write failure is CAPTURED through the operational-ledger seam
 *      (lib/monitoring/capture.ts `captureLedgerWriteFailure`), counted here, and
 *      REPORTED to the reservation, which then fails CLOSED;
 *   3. the turn still returns its answer. The cost has already been incurred:
 *      refusing the answer would not un-spend it, and the row that is missing is
 *      exactly what the next turn's refusal accounts for. What is never allowed
 *      is the silent case — a write-dead ledger admitting every turn.
 *
 * ── Two signals, one verdict ────────────────────────────────────────────────
 *   · PER-PROCESS: `consecutive` write failures, reset by a success. Fast and
 *     exact within one instance — which, on a serverless platform, is ONE lambda
 *     and not the fleet. Trips at LEDGER_CONSECUTIVE_TRIP.
 *   · DURABLE: a RateLimit-style row written by fm_system on every failure, key
 *     `system:ai-ledger-write-failures`, `windowStart` = the hour bucket (the
 *     in-flight reservation's own idiom, lib/platform/ai/allowance-reservation.ts).
 *     The reservation reads the current + previous bucket INSIDE its transaction
 *     and refuses at LEDGER_FAILURE_TRIP. Self-healing: a burst ages out of the
 *     window within two hours, and the first process that writes successfully
 *     after having failed clears it. Written through the SAME client the ledger
 *     write used, so a fake client in a test sees no stray database call.
 *
 * ── What it does NOT claim ──────────────────────────────────────────────────
 * A ledger AND counter that are both dead (the database is gone) is already the
 * reservation's own RESERVATION_UNAVAILABLE path. This module covers the case
 * the runtime audit named: the AiInvocation write fails while the rest of the
 * database works (a drifted column, a revoked grant, a constraint).
 */

import "server-only";
import { captureLedgerWriteFailure, type OperationalLedger } from "@/lib/monitoring/capture";

export const LEDGER_FAILURE_KEY = "system:ai-ledger-write-failures";
/** The hour — the in-flight counter's bucket (pinned equal to INFLIGHT_BUCKET_MS by a test). */
export const LEDGER_FAILURE_BUCKET_MS = 60 * 60 * 1000;
/** Durable: this many failed writes in the current + previous hour ⇒ untrusted. */
export const LEDGER_FAILURE_TRIP = 3;
/** Per-process: this many CONSECUTIVE failed writes ⇒ untrusted. */
export const LEDGER_CONSECUTIVE_TRIP = 2;

/**
 * The capture seam names its ledgers by an exhaustive union of fm_app-revoked
 * tables; AiInvocation is one of those (…000100 §4) but is not yet in the union
 * (lib/monitoring/capture.ts is Agent A's file in this wave). The cast says what
 * the row is; the phase "providerCall" carries the right effect sentence ("this
 * provider attempt is unrecorded, so … counts … are understated").
 */
const AI_LEDGER: OperationalLedger = "AiInvocation";

export interface LedgerHealthWriteClient {
  rateLimit?: {
    upsert(args: {
      where: { key_windowStart: { key: string; windowStart: Date } };
      create: { key: string; windowStart: Date; count: number };
      update: { count: { increment: number } };
      select: { count: true };
    }): Promise<{ count: number }>;
    deleteMany(args: { where: { key: string } }): Promise<{ count: number }>;
  };
}

export interface LedgerHealthReadClient {
  rateLimit: {
    findMany(args: { where: { key: string; windowStart: { in: Date[] } }; select: { count: true } }): Promise<{ count: number }[]>;
  };
}

export function ledgerFailureBucket(now: Date): Date {
  return new Date(Math.floor(now.getTime() / LEDGER_FAILURE_BUCKET_MS) * LEDGER_FAILURE_BUCKET_MS);
}

let consecutive = 0;
/** Consecutive AiInvocation write failures seen by THIS process (0 after any success). */
export function consecutiveLedgerWriteFailures(): number { return consecutive; }
/** Tests only. */
export function resetLedgerHealthForTests(): void { consecutive = 0; observers.clear(); }

export type LedgerWriteFailureObserver = (info: { consecutive: number; durableWritten: boolean }) => void;
const observers = new Set<LedgerWriteFailureObserver>();
/** Observe write failures (tests; an ops tile). Returns the unsubscribe. */
export function onLedgerWriteFailure(observer: LedgerWriteFailureObserver): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

/** PURE — the verdict the reservation applies. */
export function ledgerUntrusted(durableFailures: number, consecutiveFailures: number): boolean {
  return durableFailures >= LEDGER_FAILURE_TRIP || consecutiveFailures >= LEDGER_CONSECUTIVE_TRIP;
}

/**
 * An AiInvocation write failed. Never throws. Captures (static tags only: the
 * ledger and the phase — no row, no user, no message), counts, and writes the
 * durable signal through the client that failed the ledger write, when it can.
 */
export async function noteLedgerWriteFailure(
  err: unknown, client?: LedgerHealthWriteClient | null, now: Date = new Date(),
): Promise<void> {
  consecutive += 1;
  console.error(`[ai/ledger] AiInvocation write FAILED (consecutive=${consecutive}); the allowance will fail closed:`, err);
  try { captureLedgerWriteFailure(AI_LEDGER, "providerCall", err); } catch { /* capture never becomes a second failure */ }
  let durableWritten = false;
  if (client?.rateLimit) {
    try {
      await client.rateLimit.upsert({
        where: { key_windowStart: { key: LEDGER_FAILURE_KEY, windowStart: ledgerFailureBucket(now) } },
        create: { key: LEDGER_FAILURE_KEY, windowStart: ledgerFailureBucket(now), count: 1 },
        update: { count: { increment: 1 } },
        select: { count: true },
      });
      durableWritten = true;
    } catch (e) {
      console.error("[ai/ledger] the durable failure signal could not be written either:", e);
    }
  }
  for (const o of observers) { try { o({ consecutive, durableWritten }); } catch { /* observers never break the writer */ } }
}

/**
 * An AiInvocation write succeeded. Resets the per-process count and, when this
 * process had been failing, clears the durable signal (recovery is observed by
 * the process that recovered). Never throws.
 */
export async function noteLedgerWriteSuccess(client?: LedgerHealthWriteClient | null): Promise<void> {
  if (consecutive === 0) return;
  consecutive = 0;
  if (!client?.rateLimit) return;
  try { await client.rateLimit.deleteMany({ where: { key: LEDGER_FAILURE_KEY } }); }
  catch (e) { console.error("[ai/ledger] the durable failure signal could not be cleared (it ages out within the window):", e); }
}

/** The durable count over the current + previous bucket — read INSIDE the reservation's transaction. */
export async function readLedgerWriteFailures(client: LedgerHealthReadClient, now: Date = new Date()): Promise<number> {
  const bucket = ledgerFailureBucket(now);
  const previous = new Date(bucket.getTime() - LEDGER_FAILURE_BUCKET_MS);
  const rows = await client.rateLimit.findMany({ where: { key: LEDGER_FAILURE_KEY, windowStart: { in: [bucket, previous] } }, select: { count: true } });
  return rows.reduce((n, r) => n + Math.max(0, r.count), 0);
}
