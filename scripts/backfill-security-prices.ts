/**
 * scripts/backfill-security-prices.ts
 *
 * A8-3A — historical security-price backfill. House pattern
 * (scripts/backfill-fx-rates.ts): dry-run by default, --apply to write,
 * idempotent, re-runnable, resumable, batched per instrument, progress + summary
 * with provider attribution.
 *
 * Append-only contract: ALL writes go through priceArchive.writeBatch (insert-
 * only, skipDuplicates, closed-dates-only) — this script never touches the
 * PriceObservation table directly, never updates, never deletes.
 *
 * Per instrument: window = [earliest defensible activity (first observation /
 * event), yesterday UTC], resumed from the latest already-covered RAW_CLOSE date
 * (missing-only), split into bounded chunks (batched acquisition), fetched
 * through the provider failover chain. A fully-covered instrument is skipped
 * without a network call. NO interpolation — only dates a provider returns are
 * stored.
 *
 * VENDOR-GATED: defaultPriceRegistry() is EMPTY until a licensed vendor is
 * selected (A8-3B, externally blocked). Dry-run always reports the plan offline;
 * --apply with no provider fetches nothing and says so.
 *
 * Run:
 *   npx tsx scripts/backfill-security-prices.ts                 # dry-run (default, offline)
 *   npx tsx scripts/backfill-security-prices.ts --apply         # fetch + store (needs a provider)
 *   flags: --instrument=<id>  --chunk-days=N (default 365)  --limit=N (max instruments)
 */

import { db } from "@/lib/db";
import { defaultPriceRegistry } from "@/lib/prices/registry";
import { backfillPricesForInstruments } from "@/lib/prices/backfill";
import { yesterdayUTCISO } from "@/lib/prices/config";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
function strFlag(name: string): string | null {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  return a ? (a.split("=")[1] ?? null) : null;
}
function numFlag(name: string, dflt: number): number {
  const v = strFlag(name);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const APPLY = has("--apply");
const CHUNK_DAYS = numFlag("--chunk-days", 365);
const LIMIT = numFlag("--limit", Number.MAX_SAFE_INTEGER);
const ONLY_INSTRUMENT = strFlag("--instrument");

async function main(): Promise<void> {
  const registry = defaultPriceRegistry();
  const toISO = yesterdayUTCISO();
  console.log(`security-price backfill — ${APPLY ? "APPLY" : "DRY-RUN"} · target end ${toISO} · chunk ${CHUNK_DAYS}d`);
  if (registry.adapters.length === 0) {
    console.log("⚠ no price provider configured (A8-3B vendor gate) — reporting the plan only; --apply will fetch nothing.");
  }

  // Held instruments (live, non-deleted, qty > 0), optionally filtered. The
  // per-instrument backfill loop itself lives in lib/prices/backfill.ts (shared
  // with the connect-time trigger); this script only selects the instrument set
  // and renders the plan/summary.
  const held = await db.positionObservation.findMany({
    where:    { supersededById: null, deletedAt: null, quantity: { gt: 0 }, ...(ONLY_INSTRUMENT ? { instrumentId: ONLY_INSTRUMENT } : {}) },
    select:   { instrumentId: true },
    distinct: ["instrumentId"],
  });
  const instrumentIds = [...new Set(held.map((h) => h.instrumentId))].sort().slice(0, LIMIT);
  console.log(`${instrumentIds.length} held instrument(s) to consider.\n`);

  const r = await backfillPricesForInstruments(instrumentIds, {
    apply:      APPLY,
    chunkDays:  CHUNK_DAYS,
    registry,
    toISO,
    onProgress: (line) => console.log(line),
  });

  console.log(`\nsummary — planned ${r.planned}, skipped(covered/no-activity) ${r.skipped}` +
    (APPLY ? `, fetched ${r.fetchedInstruments} instrument(s), stored ${r.inserted} row(s)` : " (dry-run: no writes)"));
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error("backfill-security-prices failed:", err);
  await db.$disconnect();
  process.exit(1);
});
