/**
 * lib/fx/archive.ts
 *
 * MC1 Phase 1 Slice 2 — the ONE database touchpoint of the FX layer
 * (plan §3.1). Prisma-backed implementation of the FxArchive contract:
 *
 *   - INSERT-ONLY. writeBatch is ONE autocommit INSERT … ON CONFLICT DO NOTHING
 *     against the @@unique([date, base, quote]) anchor, so a re-fetch is a no-op.
 *     It used to be createMany({ skipDuplicates: true }), which Prisma 5 sends as
 *     BEGIN / INSERT / COMMIT (measured, launch-readiness audit 2026-10-06). The
 *     write runs detached from the request (lib/money/server-context.ts), so a
 *     Fluid Compute instance suspended between INSERT and COMMIT would leave an
 *     open transaction holding those unique keys; every other instance's identical
 *     refresh would queue behind it on the shared `db` pool that getSpaceContext
 *     needs on every request. One statement commits on the server whatever the
 *     client does next.
 *   - CLOSED DATES ONLY. Rows dated after yesterday UTC are rejected
 *     (assertClosedDateISO) — this is the application-level enforcement of
 *     the append-only doctrine (plan D8).
 *   - NO UPDATES, NO DELETES. No code path here (or anywhere) mutates or
 *     removes FxRate rows; determinism of Phase 2 read-time conversion
 *     depends on this.
 *
 * No provider logic, no fetch logic (Slice 3), no resolution logic
 * (service.ts). Unit tests do NOT import this module — they inject in-memory
 * fakes of the FxArchiveReader seam (types.ts) so the suite runs without
 * `prisma generate` (plan §4).
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { assertClosedDateISO, assertISODate, toISODateUTC } from "./config";
import type { FxArchive, RateResult } from "./types";

/** "YYYY-MM-DD" → Date at UTC midnight (the shape Prisma stores for @db.Date). */
function isoToDate(dateISO: string): Date {
  assertISODate(dateISO);
  return new Date(`${dateISO}T00:00:00Z`);
}

export const fxArchive: FxArchive = {
  async readRate(dateISO, base, quote) {
    const row = await db.fxRate.findUnique({
      where:  { date_base_quote: { date: isoToDate(dateISO), base, quote } },
      select: { rate: true },
    });
    return row?.rate ?? null;
  },

  async readLatestOnOrBefore(base, quote, dateISO, maxStaleDays) {
    const floorISO = toISODateUTC(
      new Date(isoToDate(dateISO).getTime() - maxStaleDays * 86_400_000),
    );
    const row = await db.fxRate.findFirst({
      where: {
        base,
        quote,
        date: { lte: isoToDate(dateISO), gte: isoToDate(floorISO) },
      },
      orderBy: { date: "desc" }, // served by @@index([quote, date])
      select:  { date: true, rate: true },
    });
    return row ? { dateISO: toISODateUTC(row.date), rate: row.rate } : null;
  },

  // MC1 QA perf P0 — one indexed range read for a whole prefetch window,
  // replacing N sequential point reads. Same @@index([quote, date]) serves the
  // (quote IN …, date BETWEEN …) scan. No ordering guarantee is promised: the
  // in-memory snapshot the caller builds re-derives walk-back per date.
  async readRange(base, quotes, fromISO, toISO) {
    if (quotes.length === 0) return [];
    const rows = await db.fxRate.findMany({
      where: {
        base,
        quote: { in: [...quotes] },
        date:  { gte: isoToDate(fromISO), lte: isoToDate(toISO) },
      },
      select: { quote: true, date: true, rate: true },
    });
    return rows.map((r) => ({ quote: r.quote, dateISO: toISODateUTC(r.date), rate: r.rate }));
  },

  async writeBatch(source, rows) {
    // Batch provenance is required: one batch = one adapter's complete answer
    // (plan D2). RateResult deliberately carries no per-row source field.
    if (!source) throw new Error("[fx] writeBatch requires a non-empty batch source");

    // Append-only doctrine: every row must be a closed date. Throwing (not
    // filtering) is deliberate — a future-dated row is a caller bug, and
    // silently dropping it would hide that bug.
    for (const r of rows) assertClosedDateISO(r.dateISO);

    if (rows.length === 0) return { attempted: 0, inserted: 0 };
    // One statement, no transaction (see header). `id` has no database default
    // (Prisma generates it client-side), so it is minted here; `fetchedAt` keeps
    // its DB default. ON CONFLICT DO NOTHING = the old skipDuplicates: existing
    // rows are never touched.
    const values = rows.map((r: RateResult) =>
      Prisma.sql`(${randomUUID()}, ${r.dateISO}::date, ${r.base}, ${r.quote}, ${r.rate}, ${source})`);
    const inserted = await db.$executeRaw`
      INSERT INTO "FxRate" ("id", "date", "base", "quote", "rate", "source")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("date", "base", "quote") DO NOTHING`;
    return { attempted: rows.length, inserted };
  },
};
