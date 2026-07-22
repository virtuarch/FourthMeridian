/**
 * jobs/fetch-fx-rates.ts
 *
 * MC1 Phase 1 Slice 4 — daily FX rate fetch job body. Invoked by the Vercel
 * Cron route (app/api/jobs/fetch-fx-rates/route.ts), and callable manually
 * (same body the backfill script exercises per-date, minus range logic).
 *
 * Behavior (plan §3.4):
 *   - Target = the previous closed UTC day (the newest date the append-only
 *     archive accepts; plan D4/D8).
 *   - Fetch ONLY the quotes still missing for that date — a re-run (or a day
 *     already topped up by the backfill) is a network-free no-op.
 *   - One pass through the provider failover chain (plan D2) — no retries
 *     beyond failover; the next day's run and the backfill script are the
 *     self-healing mechanisms for a fully-failed day.
 *   - All writes via fxArchive.writeBatch (insert-only, skipDuplicates,
 *     closed-dates-only). No conversion, no consumers.
 */

import { db } from "@/lib/db";
import { fxArchive } from "@/lib/fx/archive";
import { fetchDay } from "@/lib/fx/fetch";
import { defaultFxRegistry } from "@/lib/fx/registry";
import { SUPPORTED_QUOTES, toISODateUTC, yesterdayUTCISO } from "@/lib/fx/config";

export interface FetchFxRatesResult {
  dateISO:        string;
  /** Winning provider, "none" (all providers failed / no banking data), or "skipped" (already covered). */
  source:         string;
  missingBefore:  number;
  inserted:       number;
  /** Per-adapter notes from the failover walk (empty when skipped). */
  notes:          string[];
}

export async function fetchFxRates(): Promise<FetchFxRatesResult> {
  const dateISO = yesterdayUTCISO();

  const existing = await db.fxRate.findMany({
    where:  { base: "USD", date: new Date(`${dateISO}T00:00:00Z`) },
    select: { quote: true },
  });
  const have = new Set(existing.map((r) => r.quote));
  const missing = SUPPORTED_QUOTES.filter((q) => !have.has(q));

  if (missing.length === 0) {
    console.log(`[fx-cron] ${dateISO}: fully covered (${have.size} quotes) — no fetch needed`);
    return { dateISO, source: "skipped", missingBefore: 0, inserted: 0, notes: [] };
  }

  const day = await fetchDay(dateISO, defaultFxRegistry(), missing);

  if (day.source === null) {
    // No retry beyond the failover chain — tomorrow's run / the backfill
    // script self-heal the gap (append-only archive, skip-if-present).
    console.warn(`[fx-cron] ${dateISO}: no provider produced data — ${day.notes.join(" | ")}`);
    return { dateISO, source: "none", missingBefore: missing.length, inserted: 0, notes: day.notes };
  }

  const res = await fxArchive.writeBatch(day.source, day.rates);
  console.log(
    `[fx-cron] ${toISODateUTC(new Date(`${dateISO}T00:00:00Z`))}: stored ${res.inserted}/${res.attempted} row(s) ` +
    `from ${day.source} (${missing.length} quote(s) were missing)`,
  );
  return { dateISO, source: day.source, missingBefore: missing.length, inserted: res.inserted, notes: day.notes };
}
