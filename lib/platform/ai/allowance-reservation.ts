/**
 * lib/platform/ai/allowance-reservation.ts  (AI COST CONTROLS — the bounded in-flight reservation)
 *
 * THE ONE PLACE THE DAILY ALLOWANCE IS JUDGED FOR A REAL TURN. The ledger
 * (AiInvocation) is written AFTER the provider returns, so N simultaneous turns
 * would each read the same stale sum and all pass. This module takes the
 * decision inside ONE short fm_system transaction that:
 *
 *   1. holds `pg_advisory_xact_lock(hashtext('ai-allowance:' || userId))` — the
 *      customer's turns are judged one at a time, nothing else waits;
 *   2. reads `ai_daily_allowance_enforced` (FALLBACK_TO_DEFAULT: a missing or
 *      unreadable row means ENFORCED), today's spend groups (the C7 read, same
 *      predicate, through the transaction) and the IN-FLIGHT count;
 *   3. applies the pure rule `spent + inFlight × RESERVE_USD ≥ allowance ⇒ refuse`
 *      (lib/ai/allowance-core.ts reservedAllowanceVerdict);
 *   4. when admitted, INCREMENTS the in-flight counter and hands back a release
 *      handle the route calls in `finally` (decrement, never below 0).
 *
 * The model call is NEVER inside the transaction — it is milliseconds long.
 *
 * ── The counter, with no migration ──────────────────────────────────────────
 * The existing RateLimit table (fm_system holds SELECT/INSERT/UPDATE/DELETE):
 * key `user:ai-inflight:<userId>`, `windowStart` = the current HOUR bucket. The
 * count read is the SUM of the current and the previous hour's buckets, so a
 * turn admitted at 10:59 and released at 11:02 is decremented from the bucket
 * it incremented and never goes negative, while a reservation whose release
 * was lost (a crashed process) ages out of the window within two hours — the
 * SELF-HEALING property, and the reason this needs no new table or column.
 *
 * ── The guarantee, honestly ─────────────────────────────────────────────────
 *   admitted spend ≤ allowance + Σ_{admitted turns} (actual cost − RESERVE_USD)
 * Overshoot is bounded by one turn's excess over its reserve PER CONCURRENTLY
 * ADMITTED TURN. It is NOT an absolute hard cap: a turn's cost is known only
 * after the provider returns, and a lost release over-reserves (refusing too
 * much, never too little) until its bucket ages out.
 *
 * ── When the reservation cannot be taken: FAIL CLOSED ───────────────────────
 * When the transaction cannot run — no fm_system client, the lock or counter
 * errors — the verdict says `reservation: "UNAVAILABLE"` and, with enforcement
 * ON (including an unreadable flag), the turn is REFUSED with the retryable
 * RESERVATION_UNAVAILABLE (503 + Retry-After). The plain stale-sum check has no
 * in-flight count, so it would admit every simultaneous turn: measured 8/8 at
 * $3.80 of $5, and before 2026-10-16 that was every turn on every database
 * (P2010). Only when an operator has explicitly turned enforcement OFF does the
 * pre-existing plain check decide (pricing validation still refuses). This module does not consult RATE_LIMIT_ENABLED:
 * the reservation is a cost control, not an abuse limiter, and runs wherever
 * fm_system can open a transaction (local dev included).
 *
 * fm_system: AiInvocation and PlatformSetting are operator tables; RateLimit
 * carries no tenant data. Only the AUTHENTICATED user's id is ever the predicate.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { todayUTCISO } from "@/lib/time/clock";
import { PlatformSettingKey } from "@/lib/platform-settings";
import {
  RESERVE_USD, reservedAllowanceVerdict, sumTodaySpend, type AllowanceVerdict,
} from "@/lib/ai/allowance-core";
import { readCustomerSpendGroupsToday, type CustomerSpendReadClient } from "@/lib/platform/ai/customer-spend-today";

export const INFLIGHT_KEY_PREFIX = "user:ai-inflight:";
export const INFLIGHT_BUCKET_MS = 60 * 60 * 1000;

export function inflightKey(userId: string): string { return `${INFLIGHT_KEY_PREFIX}${userId}`; }
export function inflightBucket(now: Date): Date { return new Date(Math.floor(now.getTime() / INFLIGHT_BUCKET_MS) * INFLIGHT_BUCKET_MS); }
/** The advisory lock key — hashed by Postgres (`hashtext`) so it is an int4, never a table or a row. */
export function allowanceLockKey(userId: string): string { return `ai-allowance:${userId}`; }

/** The narrow transactional surface the reservation needs — a Prisma transaction or a fake. */
export interface ReservationTx extends CustomerSpendReadClient {
  /**
   * The lock statement. `$executeRaw`, NEVER `$queryRaw`: `pg_advisory_xact_lock`
   * returns `void`, and `$queryRaw` must DESERIALIZE every result column — Prisma
   * refuses a `void` column (P2010 "Failed to deserialize column of type 'void'"),
   * which threw on every real database and sent every turn down the fallback.
   * `$executeRaw` runs the same SELECT and returns only the row count.
   */
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  platformSetting: {
    findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null>;
  };
  rateLimit: {
    findMany(args: { where: { key: string; windowStart: { in: Date[] } }; select: { count: true } }): Promise<{ count: number }[]>;
    upsert(args: {
      where: { key_windowStart: { key: string; windowStart: Date } };
      create: { key: string; windowStart: Date; count: number };
      update: { count: { increment: number } };
      select: { count: true };
    }): Promise<{ count: number }>;
  };
}

export interface ReservationClient extends CustomerSpendReadClient {
  $transaction<T>(fn: (tx: ReservationTx) => Promise<T>): Promise<T>;
  platformSetting: ReservationTx["platformSetting"];
  rateLimit: {
    updateMany(args: {
      where: { key: string; windowStart: Date; count: { gt: number } };
      data: { count: { decrement: number } };
    }): Promise<{ count: number }>;
  };
}

export interface ReservationOutcome {
  verdict: AllowanceVerdict;
  /** Give the reservation back. Idempotent; never throws; a no-op when nothing was reserved. */
  release(): Promise<void>;
}

const DEFAULT_CLIENT = (): ReservationClient => systemDb as unknown as ReservationClient;

/** FALLBACK_TO_DEFAULT — "false" is the only value that turns enforcement off; missing or unreadable ⇒ enforced. */
export function enforcedFrom(raw: string | null | undefined): boolean {
  return raw !== "false";
}

async function readEnforced(client: { platformSetting: ReservationTx["platformSetting"] }): Promise<boolean> {
  try {
    const row = await client.platformSetting.findUnique({ where: { key: PlatformSettingKey.AI_DAILY_ALLOWANCE_ENFORCED }, select: { value: true } });
    return enforcedFrom(row?.value ?? null);
  } catch (err) {
    console.error("[ai/allowance] enforcement flag unreadable; enforcing:", err);
    return true;
  }
}

const NO_RELEASE = async () => {};

/**
 * Judge one customer's next turn under the lock and, when admitted, reserve it.
 * When the transaction cannot run: REFUSED (RESERVATION_UNAVAILABLE) with
 * enforcement on; the plain check with enforcement explicitly off (throws only
 * when that plain spend read fails).
 */
export async function reserveAiTurn(
  userId: string,
  allowanceUsd: number,
  now: Date = new Date(),
  client: ReservationClient = DEFAULT_CLIENT(),
  reserveUsd: number = RESERVE_USD,
): Promise<ReservationOutcome> {
  const key = inflightKey(userId);
  const bucket = inflightBucket(now);
  const previous = new Date(bucket.getTime() - INFLIGHT_BUCKET_MS);
  const today = todayUTCISO(now);

  try {
    const verdict = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${allowanceLockKey(userId)}))`;
      const [enforced, groups, buckets] = await Promise.all([
        readEnforced(tx),
        readCustomerSpendGroupsToday(userId, now, tx),
        tx.rateLimit.findMany({ where: { key, windowStart: { in: [bucket, previous] } }, select: { count: true } }),
      ]);
      const spend = sumTodaySpend(groups, today);
      const inFlight = buckets.reduce((n, b) => n + Math.max(0, b.count), 0);
      const v = reservedAllowanceVerdict({
        spentUsd: spend.spentUsd, allowanceUsd, unpricedInvocations: spend.unpricedInvocations,
        inFlight, reserveUsd, enforced, reservation: "RESERVED",
      });
      if (v.allowed) {
        await tx.rateLimit.upsert({
          where: { key_windowStart: { key, windowStart: bucket } },
          create: { key, windowStart: bucket, count: 1 },
          update: { count: { increment: 1 } },
          select: { count: true },
        });
      }
      return v;
    });
    if (!verdict.allowed) return { verdict, release: NO_RELEASE };
    let released = false;
    return {
      verdict,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.rateLimit.updateMany({ where: { key, windowStart: bucket, count: { gt: 0 } }, data: { count: { decrement: 1 } } });
        } catch (err) {
          // A lost release over-reserves for at most two hours (the bucket ages out); it never under-reserves.
          console.error("[ai/allowance] reservation release failed (self-heals within the bucket window):", err);
        }
      },
    };
  } catch (err) {
    console.error("[ai/allowance] reservation unavailable:", err);
  }

  // ── Reservation unavailable: fail closed unless enforcement is explicitly OFF ─
  const enforced = await readEnforced(client);
  if (enforced) {
    // The spend is read for the refusal body only; it cannot admit anything here.
    let spentUsd = 0;
    try { spentUsd = sumTodaySpend(await readCustomerSpendGroupsToday(userId, now, client), today).spentUsd; }
    catch (err) { console.error("[ai/allowance] spend unreadable while refusing (fail closed):", err); }
    console.error(`[ai/allowance] reservation unavailable; REFUSING (fail closed, enforcement on) user=${userId}`);
    return {
      verdict: { allowed: false, reason: "RESERVATION_UNAVAILABLE", unpricedInvocations: 0,
        spentUsd, allowanceUsd: Math.max(0, allowanceUsd), enforced: true, reservation: "UNAVAILABLE", inFlight: 0 },
      release: NO_RELEASE,
    };
  }
  // Enforcement explicitly OFF by an operator: the pre-existing plain check, no reservation.
  const spend = sumTodaySpend(await readCustomerSpendGroupsToday(userId, now, client), today);
  const verdict = reservedAllowanceVerdict({
    spentUsd: spend.spentUsd, allowanceUsd, unpricedInvocations: spend.unpricedInvocations,
    inFlight: 0, reserveUsd: 0, enforced, reservation: "UNAVAILABLE",
  });
  return { verdict, release: NO_RELEASE };
}
