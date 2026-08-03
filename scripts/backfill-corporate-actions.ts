/**
 * scripts/backfill-corporate-actions.ts
 *
 * V26-S1-CA — ask the price vendor about corporate actions we already have
 * EVENTS for but no TERMS.
 *
 *     npx dotenv -e .env.local -- npx tsx scripts/backfill-corporate-actions.ts [--apply]
 *
 * ── Why a targeted repair exists at all ──────────────────────────────────────
 * Capture-on-fetch (lib/prices/backfill.ts, jobs/fetch-security-prices.ts) records
 * the terms a vendor states in the SAME response as its prices. That fixes every
 * FUTURE action — and reaches none of the past ones, because the price archive is
 * append-only and the acquisition planner never re-requests a window it has
 * already covered. TQQQ's 2025-11-20 prices are stored; the splitFactor that
 * arrived beside them in 2026 was parsed away and will never be asked for again.
 *
 * So the repair is driven by EVIDENCE OF A GAP rather than by a date range: for
 * every corporate-action event whose terms are unknown, ask the vendor about the
 * few days around it. That is a handful of requests over the life of a portfolio,
 * not a re-acquisition.
 *
 * Read-only by default. `--apply` performs the vendor calls and writes terms.
 * It NEVER writes prices — the window it asks for is already covered, and this
 * script has no business in the price archive.
 */

import { AssetClass, InvestmentEventType } from "@prisma/client";
import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { defaultPriceRegistry } from "@/lib/prices/registry";
import { resolveProviderForInstrument } from "@/lib/prices/registry";
import { minusDaysISO } from "@/lib/prices/config";
import { recordCorporateActionTerms, loadCorporateActionTerms, actionKey } from "@/lib/investments/corporate-actions";

/** Days either side of the event date to ask about. */
const WINDOW_DAYS = 3;

/** Event types that need terms before a backward replay may invert them. */
const TERM_BEARING = [InvestmentEventType.SPLIT];

function plusDaysISO(dateISO: string, n: number): string {
  return minusDaysISO(dateISO, -n);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const registry = defaultPriceRegistry();

  const events = await db.investmentEvent.findMany({
    where: {
      type:           { in: TERM_BEARING },
      deletedAt:      null,
      supersededById: null,
      instrumentId:   { not: null },
      ratio:          null, // the event itself states no terms
    },
    select: {
      instrumentId: true, date: true, type: true, quantity: true, price: true,
      instrument: { select: { tickerSymbol: true, assetClass: true } },
    },
    orderBy: { date: "asc" },
  });

  if (events.length === 0) {
    console.log("No corporate-action events with unknown terms. Nothing to do.");
    await db.$disconnect();
    return;
  }

  const instrumentIds = [...new Set(events.map((e) => e.instrumentId!))];
  const known = await loadCorporateActionTerms(instrumentIds);

  // De-duplicate to (instrument, date): every holder's event describes the same
  // market action, and the terms table is deployment-global.
  const targets = new Map<string, { instrumentId: string; dateISO: string; symbol: string | null; assetClass: AssetClass }>();
  for (const e of events) {
    const dateISO = e.date.toISOString().slice(0, 10);
    const key = actionKey(e.instrumentId!, dateISO, "SPLIT");
    if (known.has(key)) continue; // already answered
    targets.set(key, {
      instrumentId: e.instrumentId!,
      dateISO,
      symbol: e.instrument?.tickerSymbol ?? null,
      assetClass: e.instrument?.assetClass ?? AssetClass.UNKNOWN,
    });
  }

  console.log(`${events.length} term-less corporate-action event(s); ${targets.size} distinct (instrument, date) to ask about.`);
  console.log(apply ? "MODE: apply (vendor calls + term writes)" : "MODE: dry run (no calls, no writes) — pass --apply to execute");

  let asked = 0, recorded = 0, unrouted = 0;
  for (const t of targets.values()) {
    const routing = resolveProviderForInstrument(registry, {
      assetClass:     t.assetClass,
      providerSymbol: t.symbol ?? "",
      basis:          PriceBasis.RAW_CLOSE,
    });
    if (routing.kind !== "provider") {
      unrouted++;
      console.log(`  · ${t.symbol ?? t.instrumentId} ${t.dateISO} — no capable provider (${routing.kind})`);
      continue;
    }
    const adapter = routing.adapter;
    if (!adapter.fetchDailyClosesWithActions) {
      unrouted++;
      console.log(`  · ${t.symbol ?? t.instrumentId} ${t.dateISO} — ${adapter.source} states no corporate actions`);
      continue;
    }

    const fromISO = minusDaysISO(t.dateISO, WINDOW_DAYS);
    const toISO   = plusDaysISO(t.dateISO, WINDOW_DAYS);
    console.log(`  → ${t.symbol ?? t.instrumentId} ${t.dateISO} — ${adapter.source} [${fromISO}..${toISO}]`);
    if (!apply) continue;

    asked++;
    try {
      const answer = await adapter.fetchDailyClosesWithActions({
        instrumentId:   t.instrumentId,
        assetClass:     t.assetClass,
        providerSymbol: t.symbol ?? "",
        basis:          PriceBasis.RAW_CLOSE,
        fromISO,
        toISO,
      });
      if (answer.corporateActions.length === 0) {
        console.log(`     · vendor states no action in this window`);
        continue;
      }
      const n = await recordCorporateActionTerms(adapter.source, answer.corporateActions);
      recorded += n;
      for (const a of answer.corporateActions) {
        console.log(`     ✓ ${a.kind} ${a.effectiveDate} ratio ${a.ratio}`);
      }
    } catch (e) {
      console.warn(`     ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n${asked} vendor call(s), ${recorded} term(s) recorded, ${unrouted} unrouted.`);
  await db.$disconnect();
}

main();
