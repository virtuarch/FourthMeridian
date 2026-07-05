/**
 * scripts/backfill-fx-rates.ts
 *
 * MC1 Phase 1 Slice 3 — historical FX rate backfill + archive spot-check.
 * See docs/initiatives/mc1/MC1_PHASE1_FX_PROVIDER_LAYER_PLAN.md §3.4 / D7.
 *
 * House pattern (scripts/backfill-flowtype.ts, scripts/backfill-currency.ts):
 * dry-run by default, --apply to write, idempotent, re-runnable, batched by
 * date, progress + summary output with provider attribution.
 *
 * Append-only contract: ALL writes go through fxArchive.writeBatch (insert-
 * only, skipDuplicates, closed-dates-only guard) — this script never touches
 * the FxRate table directly, never updates, never deletes.
 *
 * Per-date behavior (--apply): fetch ONLY the quotes still missing for that
 * date (so an OXR run can top up SAR/AED on a day previously covered by the
 * Frankfurter failover), via the registry's failover chain. A date with full
 * coverage is skipped without any network call.
 *
 * Dry-run: fully OFFLINE — reports the date range, per-date coverage, and the
 * request estimate without a single network call (quota-aware, plan §3.4).
 *
 * Run:
 *   npx tsx scripts/backfill-fx-rates.ts                      # dry-run (default, offline)
 *   npx tsx scripts/backfill-fx-rates.ts --apply              # fetch + store
 *   npx tsx scripts/backfill-fx-rates.ts --verify             # read-only archive spot-check (network reads)
 *   flags: --start=YYYY-MM-DD  --end=YYYY-MM-DD  --throttle-ms=N  --sample=N (verify)
 *
 * Default range (plan D7): --start = MIN(Transaction.date) − 30d, capped at
 * 365 days back; --end = yesterday UTC.
 */

import { db } from "@/lib/db";
import { fxArchive } from "@/lib/fx/archive";
import { fetchDay } from "@/lib/fx/fetch";
import { defaultFxRegistry } from "@/lib/fx/registry";
import {
  SUPPORTED_QUOTES,
  assertISODate,
  minusDaysISO,
  toISODateUTC,
  yesterdayUTCISO,
} from "@/lib/fx/config";

const argv = process.argv.slice(2);

function strFlag(name: string): string | null {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  return a ? (a.split("=")[1] ?? null) : null;
}
function intFlag(name: string, def: number): number {
  const v = strFlag(name);
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

const APPLY       = argv.includes("--apply");
const VERIFY      = argv.includes("--verify");
const THROTTLE_MS = intFlag("--throttle-ms", 250);
const SAMPLE      = intFlag("--sample", 5);

const MAX_DEPTH_DAYS = 365; // plan D7 initial cap (append-only → deepening later is trivial)

function* dateRange(startISO: string, endISO: string): Generator<string> {
  for (let d = startISO; d <= endISO; d = minusDaysISO(d, -1)) yield d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** date → set of quotes already stored (one grouped query for the whole range). */
async function coverageByDate(startISO: string, endISO: string): Promise<Map<string, Set<string>>> {
  const rows = await db.fxRate.findMany({
    where:  { base: "USD", date: { gte: new Date(`${startISO}T00:00:00Z`), lte: new Date(`${endISO}T00:00:00Z`) } },
    select: { date: true, quote: true },
  });
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const d = toISODateUTC(r.date);
    (map.get(d) ?? map.set(d, new Set()).get(d)!).add(r.quote);
  }
  return map;
}

async function resolveRange(): Promise<{ startISO: string; endISO: string }> {
  const endISO = strFlag("--end") ?? yesterdayUTCISO();
  assertISODate(endISO);

  let startISO = strFlag("--start");
  if (startISO) {
    assertISODate(startISO);
  } else {
    const oldest = await db.transaction.aggregate({ _min: { date: true } });
    const floor  = minusDaysISO(endISO, MAX_DEPTH_DAYS);
    const wanted = oldest._min.date ? minusDaysISO(toISODateUTC(oldest._min.date), 30) : floor;
    startISO = wanted > floor ? wanted : floor; // cap at MAX_DEPTH_DAYS (plan D7)
  }
  if (startISO > endISO) throw new Error(`[fx-backfill] start ${startISO} is after end ${endISO}`);
  return { startISO, endISO };
}

// ── verify mode: read-only archive spot-check (plan §4) ───────────────────────

async function verify(): Promise<void> {
  const registry = defaultFxRegistry();
  const total = await db.fxRate.count();
  if (total === 0) { console.log("Archive is empty — nothing to verify."); return; }

  console.log(`\n[VERIFY] read-only spot-check: ${SAMPLE} random stored dates re-fetched and compared\n`);
  // Sample distinct dates via random offsets (small table; simple beats clever).
  const picked = new Map<string, { quote: string; rate: number; source: string }[]>();
  for (let i = 0; i < SAMPLE * 3 && picked.size < SAMPLE; i++) {
    const row = await db.fxRate.findFirst({
      skip: Math.floor(Math.random() * total),
      select: { date: true, quote: true, rate: true, source: true },
    });
    if (!row) continue;
    const d = toISODateUTC(row.date);
    if (!picked.has(d)) {
      const all = await db.fxRate.findMany({
        where:  { date: row.date, base: "USD" },
        select: { quote: true, rate: true, source: true },
      });
      picked.set(d, all.map((r) => ({ quote: r.quote, rate: r.rate, source: r.source })));
    }
  }

  let mismatches = 0;
  for (const [dateISO, stored] of picked) {
    const fresh = await fetchDay(dateISO, registry, stored.map((s) => s.quote));
    if (!fresh.source) { console.log(`  ${dateISO}: no provider data now (stored source: ${stored[0]?.source}) — inconclusive`); continue; }
    const freshByQuote = new Map(fresh.rates.map((r) => [r.quote, r.rate]));
    for (const s of stored) {
      const f = freshByQuote.get(s.quote);
      if (f === undefined) continue; // provider no longer serves this quote/date — inconclusive, not a mismatch
      const same = s.rate === f;
      if (!same) { mismatches++; console.log(`  ✗ ${dateISO} ${s.quote}: stored ${s.rate} (${s.source}) vs fresh ${f} (${fresh.source})`); }
    }
    console.log(`  ${dateISO}: ${stored.length} stored row(s) checked against ${fresh.source}`);
    await sleep(THROTTLE_MS);
  }
  console.log(mismatches === 0
    ? `\nSpot-check clean — no mismatches across ${picked.size} date(s). (Cross-source comparisons can differ legitimately; identical-source rows must match.)`
    : `\n${mismatches} mismatch(es) — investigate before trusting the archive.`);
}

// ── main: dry-run / apply ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (VERIFY) { await verify(); return; }

  const { startISO, endISO } = await resolveRange();
  const coverage = await coverageByDate(startISO, endISO);

  const mode = APPLY ? "[APPLY] fetching + storing (append-only, skip-duplicates)" : "[DRY RUN] OFFLINE — no network, no writes";
  console.log(`\nMC1 FX backfill — ${mode}`);
  console.log(`Range: ${startISO} → ${endISO}   Quotes: ${SUPPORTED_QUOTES.length}   Throttle: ${THROTTLE_MS}ms\n`);

  let fullyCovered = 0, toFetch = 0, fetched = 0, inserted = 0, noData = 0, failed = 0;
  const bySource: Record<string, number> = {};
  const registry = APPLY ? defaultFxRegistry() : null;

  for (const dateISO of dateRange(startISO, endISO)) {
    const have = coverage.get(dateISO) ?? new Set<string>();
    const missing = SUPPORTED_QUOTES.filter((q) => !have.has(q));
    if (missing.length === 0) { fullyCovered++; continue; }
    toFetch++;

    if (!APPLY) continue; // dry-run: counting only, fully offline

    const day = await fetchDay(dateISO, registry!, missing);
    if (day.source === null) {
      const failure = day.notes.some((n) => n.includes("FAILED"));
      if (failure) { failed++; console.warn(`  ${dateISO}: all providers failed — ${day.notes.join(" | ")}`); }
      else { noData++; } // legitimate non-banking day for every capable source
    } else {
      const res = await fxArchive.writeBatch(day.source, day.rates);
      fetched++;
      inserted += res.inserted;
      bySource[day.source] = (bySource[day.source] ?? 0) + res.inserted;
      console.log(`  ${dateISO}: ${res.inserted}/${res.attempted} row(s) stored (${day.source})`);
    }
    await sleep(THROTTLE_MS);
  }

  const fmt = (rec: Record<string, number>) =>
    Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ") || "—";

  console.log(`\nDates fully covered (skipped): ${fullyCovered}`);
  console.log(`Dates needing rates:           ${toFetch}`);
  if (APPLY) {
    console.log(`  fetched + stored:            ${fetched}`);
    console.log(`  rows inserted:               ${inserted}   by source {${fmt(bySource)}}`);
    console.log(`  no data (non-banking days):  ${noData}`);
    console.log(`  provider failures:           ${failed}`);
    console.log(`\nRe-run --apply to top up gaps/failures (idempotent: covered dates are skipped, duplicates ignored).`);
  } else {
    console.log(`  estimated provider requests: ≤ ${toFetch} (one per date; OXR free tier = 1,000/mo — plan D7)`);
    console.log(`\nDry run only — no network, no writes. Re-run with --apply to fetch and store.`);
  }
}

main()
  .catch((err) => {
    console.error("backfill-fx-rates failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
