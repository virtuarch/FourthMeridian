/**
 * lib/prices/archive.ts
 *
 * A8-1 — the ONE database touchpoint of the price layer. Prisma-backed
 * implementation of the PriceArchive contract, cloned from lib/fx/archive.ts:
 *
 *   - INSERT-ONLY. writeBatch uses createMany({ skipDuplicates: true }) so a
 *     re-fetch is a no-op against the @@unique([instrumentId, date, basis]) anchor.
 *   - CLOSED DATES ONLY. Rows dated after yesterday UTC are rejected
 *     (assertClosedDateISO) — a close price can never be dated by its arrival.
 *   - NO UPDATES, NO DELETES. Closed-date price facts are immutable evidence;
 *     determinism of A8-4 valuation depends on it.
 *   - ONE canonical row per (instrument, date, basis). `source` is provenance,
 *     never identity — which provider supplied it does not change the key.
 *
 * The reader half (readLatestOnOrBefore / readRange) enforces BASIS ISOLATION
 * in the query: every read filters on `basis`, so a RAW_CLOSE resolution can
 * never surface an ADJUSTED_CLOSE or NAV row. No provider logic, no fetch logic,
 * no resolution logic (service.ts). Unit tests do NOT import this module — they
 * inject in-memory fakes of the PriceArchiveReader seam (types.ts), so the suite
 * runs without a database.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { assertClosedDateISO, assertISODate, toISODateUTC } from "./config";
import type { PriceArchive, PriceResult } from "./types";

/** "YYYY-MM-DD" → Date at UTC midnight (the shape Prisma stores for @db.Date). */
function isoToDate(dateISO: string): Date {
  assertISODate(dateISO);
  return new Date(`${dateISO}T00:00:00Z`);
}

/**
 * Collapse a batch to one row per canonical key (instrumentId|date|basis) BEFORE
 * the DB write, first-wins. Pure and exported for tests: the DB's skipDuplicates
 * makes cross-run re-fetch idempotent, and this makes a within-batch duplicate
 * (the same close arriving twice in one payload) idempotent too — together they
 * guarantee "duplicates skipped by canonical key" without ever touching an
 * existing row. Also validates each row is a positive-finite price (a zero or
 * negative close is provider noise, dropped — never stored as a real price).
 */
export function canonicalizePriceBatch(rows: readonly PriceResult[]): PriceResult[] {
  const seen = new Map<string, PriceResult>();
  for (const r of rows) {
    if (!Number.isFinite(r.price) || r.price <= 0) continue; // not a defensible price
    const key = `${r.instrumentId}|${r.dateISO}|${r.basis}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

export const priceArchive: PriceArchive = {
  async readPrice(instrumentId, dateISO, basis) {
    const row = await db.priceObservation.findUnique({
      where:  { instrumentId_date_basis: { instrumentId, date: isoToDate(dateISO), basis } },
      select: { price: true, currency: true },
    });
    return row ? { price: row.price, currency: row.currency } : null;
  },

  async readLatestOnOrBefore(instrumentId, basis, dateISO, maxStaleDays) {
    const floorISO = toISODateUTC(
      new Date(isoToDate(dateISO).getTime() - maxStaleDays * 86_400_000),
    );
    const row = await db.priceObservation.findFirst({
      where: {
        instrumentId,
        basis, // basis isolation — never falls through to another series
        date: { lte: isoToDate(dateISO), gte: isoToDate(floorISO) },
      },
      orderBy: { date: "desc" }, // served by @@index([instrumentId, basis, date])
      select:  { date: true, price: true, currency: true },
    });
    return row
      ? { dateISO: toISODateUTC(row.date), price: row.price, currency: row.currency }
      : null;
  },

  // A8-4 valuation access pattern — one indexed range read for a whole window,
  // replacing N point reads. The same @@index([instrumentId, basis, date])
  // serves the (instrumentId IN …, basis =, date BETWEEN …) scan. The caller
  // re-derives walk-back per (instrument, date) from the in-memory snapshot.
  async readRange(instrumentIds, basis, fromISO, toISO) {
    if (instrumentIds.length === 0) return [];
    const rows = await db.priceObservation.findMany({
      where: {
        instrumentId: { in: [...instrumentIds] },
        basis,
        date: { gte: isoToDate(fromISO), lte: isoToDate(toISO) },
      },
      select: { instrumentId: true, date: true, price: true, currency: true },
    });
    return rows.map((r) => ({
      instrumentId: r.instrumentId,
      dateISO:      toISODateUTC(r.date),
      price:        r.price,
      currency:     r.currency,
    }));
  },

  async writeBatch(source, rows) {
    if (!source) throw new Error("[prices] writeBatch requires a non-empty batch source");

    const canonical = canonicalizePriceBatch(rows);

    // Append-only doctrine: every row must be a closed date. Throwing (not
    // filtering) is deliberate — a future-dated close is a caller bug.
    for (const r of canonical) assertClosedDateISO(r.dateISO);

    const res = await db.priceObservation.createMany({
      data: canonical.map((r: PriceResult) => ({
        instrumentId: r.instrumentId,
        date:         isoToDate(r.dateISO),
        basis:        r.basis as PriceBasis,
        price:        r.price,
        currency:     r.currency,
        source,
      })),
      skipDuplicates: true, // idempotent re-fetch; existing rows are never touched
    });
    return { attempted: rows.length, inserted: res.count };
  },
};
