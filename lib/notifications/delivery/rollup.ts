/**
 * lib/notifications/delivery/rollup.ts  (Comms Center Phase A-2a)
 *
 * RETENTION of the delivery ledger (owner decision 2026-10-31): CommsDelivery
 * rows are kept 90 days; after that only COUNTS survive, in CommsDeliveryDaily
 * (UTC day × catalog key × channel × status × reason).
 *
 * THE BOUNDARY IS A UTC MIDNIGHT. cutoff = (today 00:00 UTC) − 90 days, and a
 * row is rolled when createdAt < cutoff. A UTC day is therefore always rolled
 * WHOLE, never split between the two tables mid-day, and the ledger holds every
 * day of the longest read window (90d = today + the 89 days before it).
 *
 * MESSAGES, NOT ATTEMPTS (contract v1.0.2): the ledger has one row per attempt;
 * a message is (channel, messageKey) and counts ONCE, by its FINAL attempt
 * (highest attempt; ties: latest createdAt, then id — the read's order), on
 * that attempt's UTC day. An expired attempt that a later attempt supersedes
 * is deleted WITHOUT being counted — the later one (still in the ledger, and
 * counted by the read until it too expires) carries the message.
 *
 * IDEMPOTENT BY CONSTRUCTION: each batch is ONE transaction that
 *   1. selects ≤ ROLLUP_BATCH expired rows, oldest first;
 *   2. looks up every attempt (any age) of those messages, and keeps only the
 *      batch rows that are their message's FINAL attempt;
 *   3. upserts those per-group counts into CommsDeliveryDaily (increment);
 *   4. deletes every batch id (age predicate repeated);
 * and REFUSES (rolls back) when the delete removed fewer rows than it counted —
 * a concurrent run got there first. So a row is counted in exactly one of the
 * two tables, a re-run counts nothing twice, and a crash mid-batch leaves the
 * batch untouched for the next run. Bounded: at most ROLLUP_MAX_BATCHES per run;
 * the rest waits for tomorrow (`exhausted: false`).
 *
 * TEST ROWS ARE DELETED, NEVER COUNTED (Comms Center B2 HARDENING A8): an operator's
 * test send (mode TEST, v1.1 §6.9) is excluded from analytics by default, so folding
 * it into CommsDeliveryDaily — which has no mode column — would leak it into every
 * LIVE count forever. An expired TEST row is deleted with its batch, uncounted
 * (reported as `test`).
 *
 * Authority: fm_system (SELECT + DELETE on CommsDelivery, SELECT + INSERT +
 * UPDATE on CommsDeliveryDaily — migration 20261031200000). Counts only: no
 * recipient of any kind reaches the rollup.
 */

/** Owner decision: per-delivery records live 90 days. */
export const DELIVERY_RETENTION_DAYS = 90;
export const ROLLUP_BATCH = 1000;
export const ROLLUP_MAX_BATCHES = 20;
const DAY_MS = 86_400_000;

export interface RollupSourceRow {
  id: string;
  messageKey: string;
  attempt: number;
  definitionKey: string;
  channel: string;
  status: string;
  reason: string | null;
  createdAt: Date;
  /** "LIVE" | "TEST" (B2). Absent on a pre-B2 row ⇒ LIVE. */
  mode?: string | null;
}

export interface DailyKey { day: Date; definitionKey: string; channel: string; status: string; reason: string }

export interface RollupTx {
  commsDelivery: {
    findMany(args: {
      where: { createdAt: { lt: Date } };
      orderBy: Array<{ createdAt: "asc" } | { id: "asc" }>;
      take: number;
      select: { id: true; messageKey: true; attempt: true; definitionKey: true; channel: true; status: true; reason: true; createdAt: true; mode: true };
    }): Promise<RollupSourceRow[]>;
    /** Every attempt (any age) of the batch's messages — to find each message's final attempt. */
    findAttempts(args: {
      where: { messageKey: { in: string[] } };
      select: { id: true; messageKey: true; channel: true; attempt: true; createdAt: true };
    }): Promise<Array<Pick<RollupSourceRow, "id" | "messageKey" | "channel" | "attempt" | "createdAt">>>;
    deleteMany(args: { where: { id: { in: string[] }; createdAt: { lt: Date } } }): Promise<{ count: number }>;
  };
  commsDeliveryDaily: {
    upsert(args: {
      where: { day_definitionKey_channel_status_reason: DailyKey };
      create: DailyKey & { count: number };
      update: { count: { increment: number } };
    }): Promise<unknown>;
  };
}

export interface RollupClient {
  $transaction<T>(fn: (tx: RollupTx) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

export interface CommsRollupResult {
  /** Expired ledger rows (attempts) removed. */
  rolled: number;
  /** Of those, the messages counted into the daily table (final attempts). */
  counted: number;
  /** Of those, attempts deleted uncounted because a later attempt carries the message. */
  superseded: number;
  /** Of those, operator TEST rows deleted uncounted (B2 HARDENING A8). */
  test: number;
  /** Daily cells written (inserted or incremented). */
  cells: number;
  batches: number;
  exhausted: boolean;
  cutoff: string;
  error?: string;
}

/** (today 00:00 UTC) − 90 days. Rows strictly before it are rolled. */
export function rollupCutoff(now: Date, days = DELIVERY_RETENTION_DAYS): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - days * DAY_MS);
}

/** The UTC calendar day of an instant, as a Date at 00:00 UTC (the @db.Date value). */
export function utcDay(t: Date): Date {
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

/** Group rows into daily cells. Pure. `reason` null ⇒ "" (the composite key cannot hold NULL). */
export function groupDaily(rows: readonly RollupSourceRow[]): Array<DailyKey & { count: number }> {
  const cells = new Map<string, DailyKey & { count: number }>();
  for (const r of rows) {
    const day = utcDay(r.createdAt);
    const reason = r.reason ?? "";
    const k = [day.toISOString(), r.definitionKey, r.channel, r.status, reason].join("\u0000");
    const cell = cells.get(k);
    if (cell) cell.count++;
    else cells.set(k, { day, definitionKey: r.definitionKey, channel: r.channel, status: r.status, reason, count: 1 });
  }
  return [...cells.values()];
}

/** True when `a` is a LATER attempt than `b` (attempt, then createdAt, then id). */
function later(a: { attempt: number; createdAt: Date; id: string }, b: { attempt: number; createdAt: Date; id: string }): boolean {
  return a.attempt !== b.attempt ? a.attempt > b.attempt
    : a.createdAt.getTime() !== b.createdAt.getTime() ? a.createdAt > b.createdAt
    : a.id > b.id;
}

/** The batch rows that are their message's final attempt, given every attempt of those messages. Pure. */
export function finalAttempts<R extends RollupSourceRow>(
  batch: readonly R[],
  attempts: ReadonlyArray<Pick<RollupSourceRow, "id" | "messageKey" | "channel" | "attempt" | "createdAt">>,
): R[] {
  const best = new Map<string, { id: string; attempt: number; createdAt: Date }>();
  for (const a of [...attempts, ...batch]) {
    const k = `${a.channel}\u0000${a.messageKey}`;
    const cur = best.get(k);
    if (!cur || later(a, cur)) best.set(k, a);
  }
  return batch.filter((r) => best.get(`${r.channel}\u0000${r.messageKey}`)?.id === r.id);
}

/** Thrown inside a batch transaction to roll it back when a concurrent run deleted some of its rows. */
class ConcurrentRollup extends Error {}

export async function runCommsDeliveryRollup(client: RollupClient, now: Date = new Date()): Promise<CommsRollupResult> {
  const cutoff = rollupCutoff(now);
  const res: CommsRollupResult = { rolled: 0, counted: 0, superseded: 0, test: 0, cells: 0, batches: 0, exhausted: false, cutoff: cutoff.toISOString() };
  try {
    while (res.batches < ROLLUP_MAX_BATCHES) {
      res.batches++;
      const batch = await client.$transaction(async (tx) => {
        const rows = await tx.commsDelivery.findMany({
          where: { createdAt: { lt: cutoff } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: ROLLUP_BATCH,
          select: { id: true, messageKey: true, attempt: true, definitionKey: true, channel: true, status: true, reason: true, createdAt: true, mode: true },
        });
        if (rows.length === 0) return { rows: 0, counted: 0, test: 0, cells: 0 };
        const attempts = await tx.commsDelivery.findAttempts({
          where: { messageKey: { in: [...new Set(rows.map((r) => r.messageKey))] } },
          select: { id: true, messageKey: true, channel: true, attempt: true, createdAt: true },
        });
        // A8 — a TEST row is deleted with the batch and never counted (its message is a test message).
        const allFinals = finalAttempts(rows, attempts);
        const finals = allFinals.filter((r) => r.mode !== "TEST");
        const test = rows.filter((r) => r.mode === "TEST").length;
        const cells = groupDaily(finals);
        for (const { count, ...key } of cells) {
          await tx.commsDeliveryDaily.upsert({
            where: { day_definitionKey_channel_status_reason: key },
            create: { ...key, count },
            update: { count: { increment: count } },
          });
        }
        const del = await tx.commsDelivery.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, createdAt: { lt: cutoff } } });
        if (del.count !== rows.length) throw new ConcurrentRollup(`deleted ${del.count} of ${rows.length}`);
        return { rows: rows.length, counted: finals.length, test, cells: cells.length };
      }, { timeout: 60_000, maxWait: 10_000 });
      res.rolled += batch.rows;
      res.counted += batch.counted;
      res.test += batch.test;
      res.superseded += batch.rows - batch.counted - batch.test;
      res.cells += batch.cells;
      if (batch.rows < ROLLUP_BATCH) { res.exhausted = true; break; }
    }
  } catch (err) {
    // Counts only — the message is a fixed class tag, never a driver message (it could quote values).
    res.error = err instanceof ConcurrentRollup ? "concurrent rollup: batch rolled back" : (err instanceof Error ? err.name : "Error");
    console.error(`[comms-ledger] retention rollup stopped (rolled ${res.rolled} so far; the rest is retried tomorrow): ${res.error}`);
  }
  if (res.rolled > 0) console.log(`[comms-ledger] rolled ${res.rolled} delivery row(s) older than ${DELIVERY_RETENTION_DAYS} days into ${res.cells} daily cell(s)${res.exhausted ? "" : " (more remain)"}`);
  return res;
}

// ── The Prisma binding ───────────────────────────────────────────────────────

/** The slice of a Prisma client the rollup uses (structurally satisfied by systemDb). */
export interface PrismaRollupLike {
  $transaction<T>(fn: (tx: {
    commsDelivery: { findMany(args: unknown): Promise<unknown>; deleteMany(args: unknown): Promise<{ count: number }> };
    commsDeliveryDaily: { upsert(args: unknown): Promise<unknown> };
  }) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

/** Bind RollupClient to a Prisma client: `findAttempts` is the same delegate's findMany with another shape. */
export function rollupClientFrom(p: PrismaRollupLike): RollupClient {
  return {
    $transaction: (fn, options) => p.$transaction((tx) => fn({
      commsDelivery: {
        findMany: (args) => tx.commsDelivery.findMany(args) as Promise<RollupSourceRow[]>,
        findAttempts: (args) => tx.commsDelivery.findMany(args) as Promise<Array<Pick<RollupSourceRow, "id" | "messageKey" | "channel" | "attempt" | "createdAt">>>,
        deleteMany: (args) => tx.commsDelivery.deleteMany(args),
      },
      commsDeliveryDaily: { upsert: (args) => tx.commsDeliveryDaily.upsert(args) },
    }), options),
  };
}
