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
 * ── When the ledger itself cannot be trusted: FAIL CLOSED (IDEMP-009 / OBS-005) ─
 * The spend this decision reduces over is only as complete as the writes that
 * produced it. lib/platform/ai/ledger-health.ts counts failed AiInvocation
 * writes (a durable hour-bucket row under the same RateLimit idiom, read HERE
 * inside the transaction, plus this process's consecutive count); at its trip
 * the turn is REFUSED with the retryable LEDGER_UNTRUSTED, nothing is reserved,
 * and the refusal clears when writes succeed again or the window ages out.
 * Enforcement explicitly OFF admits as before (an operator's decision).
 *
 * ── The OPTIONAL fleet ceiling (SEC-AI-001) ─────────────────────────────────
 * When `ai_fleet_daily_ceiling_usd_24h` is SET, a turn the customer allowance
 * admits is then judged fleet-wide in the SAME transaction, after
 * `pg_advisory_xact_lock(hashtext('ai-fleet'))` (taken after the customer lock,
 * always — one lock order): THE fleet fold the alert judges + every customer's
 * in-flight buckets × RESERVE_USD ≥ ceiling ⇒ FLEET_CEILING_REACHED (the
 * transient refusal path). UNAVAILABLE fleet spend admits and logs (fail open —
 * fleet-ceiling.core.ts). Absent (the default) ⇒ no fleet lock and no fleet read.
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
import { consecutiveLedgerWriteFailures, ledgerUntrusted, readLedgerWriteFailures } from "@/lib/platform/ai/ledger-health";
import { buildAiSpendHealth, readUserSpendGroups, type SpendGroupsRawClient, type UserSpendGroup } from "@/lib/platform/ai/spend-health";
import { fleetSpendStatus } from "@/lib/platform/ai/fleet-spend-status";
import {
  FLEET_CEILING_LOCK_KEY, FLEET_CEILING_SETTING_KEY, FLEET_CEILING_WINDOW_HOURS,
  fleetCeilingDecision, resolveFleetCeiling, type FleetCeiling,
} from "@/lib/platform/ai/fleet-ceiling.core";

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
    /** `key` is exact for one customer's buckets; `{ startsWith }` sums EVERY customer's (the fleet in-flight, SEC-AI-001 — ceiling set only). */
    findMany(args: { where: { key: string | { startsWith: string }; windowStart: { in: Date[] } }; select: { count: true } }): Promise<{ count: number }[]>;
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

/**
 * SEC-AI-001 — the OPTIONAL fleet ceiling, read in the transaction. Absent ⇒
 * OFF. An unreadable row is OFF too (logged): this cap is optional and never
 * refuses on a value it cannot read — the per-customer allowance, which fails
 * closed, is unaffected either way.
 */
async function readFleetCeiling(client: { platformSetting: ReservationTx["platformSetting"] }): Promise<FleetCeiling> {
  try {
    const row = await client.platformSetting.findUnique({ where: { key: FLEET_CEILING_SETTING_KEY }, select: { value: true } });
    return resolveFleetCeiling(row?.value ?? null);
  } catch (err) {
    console.error("[ai/allowance] fleet ceiling unreadable; no fleet ceiling applied (optional cap fails open):", err);
    return { state: "OFF" };
  }
}

/**
 * SEC-AI-001 — the fleet position, read UNDER the fleet lock: THE fleet fold's
 * groups (customer surfaces, RETURNED, the alert's trailing window) and every
 * customer's in-flight reservations. Injectable for tests.
 */
export interface FleetPositionDeps {
  /** The grouped ledger read, through the transaction (default: readUserSpendGroups on `tx`). */
  groups?: (tx: ReservationTx, since: Date, until: Date) => Promise<UserSpendGroup[]>;
}

const defaultFleetGroups = (tx: ReservationTx, since: Date, until: Date) =>
  readUserSpendGroups(since, until, tx as unknown as SpendGroupsRawClient);

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
  fleetDeps: FleetPositionDeps = {},
): Promise<ReservationOutcome> {
  const key = inflightKey(userId);
  const bucket = inflightBucket(now);
  const previous = new Date(bucket.getTime() - INFLIGHT_BUCKET_MS);
  const today = todayUTCISO(now);

  try {
    const verdict = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${allowanceLockKey(userId)}))`;
      const [enforced, groups, buckets, ledgerFailures, fleetCeiling] = await Promise.all([
        readEnforced(tx),
        readCustomerSpendGroupsToday(userId, now, tx),
        tx.rateLimit.findMany({ where: { key, windowStart: { in: [bucket, previous] } }, select: { count: true } }),
        readLedgerWriteFailures(tx, now),
        readFleetCeiling(tx),
      ]);
      const spend = sumTodaySpend(groups, today);
      const inFlight = buckets.reduce((n, b) => n + Math.max(0, b.count), 0);
      // IDEMP-009 / OBS-005 — a ledger that has been failing its writes cannot vouch
      // for `spent`; with enforcement on the turn is refused, and nothing is reserved.
      const consecutive = consecutiveLedgerWriteFailures();
      if (enforced && ledgerUntrusted(ledgerFailures, consecutive)) {
        console.error(`[ai/allowance] AiInvocation writes failing (window=${ledgerFailures}, consecutive=${consecutive}); REFUSING (fail closed) user=${userId}`);
        return {
          allowed: false, reason: "LEDGER_UNTRUSTED", unpricedInvocations: spend.unpricedInvocations,
          spentUsd: spend.spentUsd, allowanceUsd: Math.max(0, allowanceUsd), enforced, reservation: "RESERVED", inFlight,
        } satisfies AllowanceVerdict;
      }
      const v = reservedAllowanceVerdict({
        spentUsd: spend.spentUsd, allowanceUsd, unpricedInvocations: spend.unpricedInvocations,
        inFlight, reserveUsd, enforced, reservation: "RESERVED",
      });
      // ── SEC-AI-001 — the OPTIONAL fleet ceiling ───────────────────────────
      // Judged only for a turn the customer allowance would admit, and only
      // when a ceiling is SET: with none, no fleet lock is taken and nothing
      // fleet-wide is read (no added contention). When set, the fleet lock
      // serialises EVERY admission (always after the customer lock — one order,
      // no deadlock), so the in-flight count read below includes every turn
      // admitted before this one, and two edge turns cannot both pass.
      if (fleetCeiling.state === "INVALID") {
        console.error(`[ai/allowance] fleet ceiling row is invalid (${JSON.stringify(fleetCeiling.raw)}); no fleet ceiling applied`);
      }
      if (v.allowed && fleetCeiling.state === "SET") {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FLEET_CEILING_LOCK_KEY}))`;
        const since = new Date(now.getTime() - FLEET_CEILING_WINDOW_HOURS * 60 * 60 * 1000);
        const [fleetGroups, fleetBuckets] = await Promise.all([
          (fleetDeps.groups ?? defaultFleetGroups)(tx, since, now),
          tx.rateLimit.findMany({ where: { key: { startsWith: INFLIGHT_KEY_PREFIX }, windowStart: { in: [bucket, previous] } }, select: { count: true } }),
        ]);
        // THE fleet fold (the alert's) → THE fleet spend status. The threshold
        // is irrelevant to the ceiling's decision; the status and priced USD are not.
        const health = buildAiSpendHealth(fleetGroups, { fleetUsd: fleetCeiling.usd, userUsd: fleetCeiling.usd }, FLEET_CEILING_WINDOW_HOURS, now);
        const status = fleetSpendStatus({
          windowHours: FLEET_CEILING_WINDOW_HOURS,
          fleet: { estimatedUsd: health.fleetUsd, thresholdUsd: 0, alertEnabled: false, utilizationPct: null, invocations: health.customerInvocations, customers: health.customers },
          bySurface: [], // the fold is customer-only already ⇒ the reader's customer `unpriced` count
          unpriced: { invocations: health.unpricedInvocations, models: health.unpricedModels },
        });
        const fleetInFlight = fleetBuckets.reduce((n, b) => n + Math.max(0, b.count), 0);
        const f = fleetCeilingDecision({ spend: status, ceilingUsd: fleetCeiling.usd, fleetInFlight, reserveUsd });
        if (f.outcome === "FAIL_OPEN") {
          console.warn(`[ai/allowance] fleet spend UNAVAILABLE (${f.reason}); fleet ceiling $${f.ceilingUsd} NOT applied (optional cap fails open) user=${userId}`);
        } else if (f.outcome === "REACHED") {
          console.error(`[ai/allowance] fleet ceiling reached: committed $${f.committedUsd.toFixed(2)} (${f.status}, in-flight ${fleetInFlight}) ≥ ceiling $${f.ceilingUsd}; REFUSING user=${userId}`);
          return {
            allowed: false, reason: "FLEET_CEILING_REACHED", unpricedInvocations: 0,
            spentUsd: v.spentUsd, allowanceUsd: v.allowanceUsd, enforced, reservation: "RESERVED", inFlight,
          } satisfies AllowanceVerdict;
        }
      }
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
