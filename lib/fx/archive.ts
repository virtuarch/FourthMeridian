/**
 * lib/fx/archive.ts
 *
 * MC1 Phase 1 Slice 2 — the ONE database touchpoint of the FX layer
 * (plan §3.1). Prisma-backed implementation of the FxArchive contract:
 *
 *   - INSERT-ONLY. writeBatch uses createMany({ skipDuplicates: true }) so a
 *     re-fetch is a no-op against the @@unique([date, base, quote]) anchor.
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

  async writeBatch(source, rows) {
    // Batch provenance is required: one batch = one adapter's complete answer
    // (plan D2). RateResult deliberately carries no per-row source field.
    if (!source) throw new Error("[fx] writeBatch requires a non-empty batch source");

    // Append-only doctrine: every row must be a closed date. Throwing (not
    // filtering) is deliberate — a future-dated row is a caller bug, and
    // silently dropping it would hide that bug.
    for (const r of rows) assertClosedDateISO(r.dateISO);

    const res = await db.fxRate.createMany({
      data: rows.map((r: RateResult) => ({
        date:  isoToDate(r.dateISO),
        base:  r.base,
        quote: r.quote,
        rate:  r.rate,
        source,
      })),
      skipDuplicates: true, // idempotent re-fetch; existing rows are never touched
    });
    return { attempted: rows.length, inserted: res.count };
  },
};
