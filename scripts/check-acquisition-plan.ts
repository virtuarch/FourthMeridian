/**
 * scripts/check-acquisition-plan.ts
 *
 * V26-PRICE-3 — acquisition PLANNING DRY RUN. READ-ONLY.
 *
 *     npx dotenv -e .env.local -- npx tsx scripts/check-acquisition-plan.ts
 *
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  THIS IS A PLANNING DRY RUN, NOT AN ACQUISITION RUN.                   ║
 * ║  No provider is contacted. No PriceObservation row is written. Nothing ║
 * ║  is scheduled. It answers only: "if we were to acquire, what exactly   ║
 * ║  would be requested?"  Executing these windows is V26-PRICE-4.         ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * Structurally read-only: every DB statement is a SELECT; the coverage binding
 * makes no provider I/O (`historicalDepth` is a declared property, not a call);
 * and the acquisition planner is pure. There is no code path from here to
 * fetchInstrumentWindow or priceArchive.writeBatch.
 *
 * Exit codes: 0 = planned without incident · 1 = a plan needs attention
 * (calendar-unavailable or planning-error) · 2 = query failure.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { yesterdayUTCISO, toISODateUTC } from "@/lib/prices/config";
import { defaultPriceRegistry } from "@/lib/prices/registry";
import { loadInstrumentCoverage, type CoverageRequest } from "@/lib/prices/coverage-binding";
import {
  resolveInstrumentCoverage,
  resolveProviderFloorISO,
  type InstrumentCoverage,
  type ObservedPriceDate,
} from "@/lib/prices/coverage-binding.core";
import { planAcquisition, type AcquisitionPlan } from "@/lib/prices/acquisition-plan.core";
import { priceArchive } from "@/lib/prices/archive";

/** Vendor request limit modelled here — the backfill default. */
const CHUNK_DAYS = 365;

interface Row {
  id: string; ticker: string | null; assetClass: string; mic: string | null;
  currency: string | null; firstEvidence: Date | null; pxRows: bigint;
}

const name = (r: Row): string =>
  `${(r.ticker ?? "(no ticker)").slice(0, 22).padEnd(22)} ${r.assetClass.padEnd(7)}`;

/** Render a plan with every field an operator needs to act on it. */
function render(plan: AcquisitionPlan, indent = "      "): string[] {
  const out: string[] = [];
  switch (plan.kind) {
    case "planned":
      out.push(
        `${indent}PLANNED  ${plan.windows.length} request(s) · ${plan.missingExpectedCount} missing expected date(s) · ` +
        `${plan.requestDayCount} calendar day(s) requested` +
        (plan.unreachableCount > 0 ? ` · ${plan.unreachableCount} below provider depth (never requested)` : ""),
      );
      for (const [i, w] of plan.windows.entries()) {
        out.push(`${indent}  [${String(i + 1).padStart(2)}] ${w.fromISO} → ${w.toISO}  (${w.requestDays} day(s))`);
      }
      break;
    case "no-op":
      out.push(`${indent}NO-OP    ${plan.reason}` +
        (plan.unreachableCount > 0 ? ` · ${plan.unreachableCount} date(s) below provider depth` : "") +
        `  → zero requests`);
      break;
    case "unavailable":
      out.push(`${indent}UNAVAILABLE  ${plan.reasons.join(", ")}  → zero requests, and must never be retried`);
      break;
    case "calendar-unavailable":
      out.push(plan.failure.code === "HORIZON_EXCEEDED"
        ? `${indent}CALENDAR-UNAVAILABLE  HORIZON_EXCEEDED · ${plan.failure.calendarId} supports ` +
          `${plan.failure.supportedFromISO}→${plan.failure.supportedThroughISO}, asked ` +
          `${plan.failure.requestedFromISO}→${plan.failure.requestedToISO}  → extend the holiday tables`
        : `${indent}CALENDAR-UNAVAILABLE  NO_CALENDAR_FOR_MARKET · assetClass=${plan.failure.assetClass} ` +
          `mic=${plan.failure.mic ?? "NULL"}  → add the market or fix instrument identity`);
      break;
    case "planning-error":
      out.push(`${indent}PLANNING-ERROR  ${plan.code}  → a coverage invariant broke; investigate`);
      break;
  }
  return out;
}

function needsAttention(plan: AcquisitionPlan): boolean {
  return plan.kind === "calendar-unavailable" || plan.kind === "planning-error";
}

async function main(): Promise<number> {
  const registry = defaultPriceRegistry();
  const floor = resolveProviderFloorISO(registry, PriceBasis.RAW_CLOSE);
  const latestClosed = yesterdayUTCISO();

  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  PLANNING DRY RUN — no provider calls, no writes, nothing scheduled  ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");
  console.log(
    `registry: ${registry.adapters.length} adapter(s)` +
    `${registry.adapters.length ? ` (${registry.adapters.map((a) => a.source).join(", ")})` : " — no vendor key configured"}` +
    ` · provider floor: ${floor ?? "null (unbounded)"} · request limit: ${CHUNK_DAYS} calendar day(s)\n`,
  );

  const rows = await db.$queryRaw<Row[]>`
    SELECT i.id, i."tickerSymbol" AS ticker, i."assetClass"::text AS "assetClass",
           i."marketIdentifierCode" AS mic, i.currency,
           ev."firstEvidence", COALESCE(px."pxRows", 0) AS "pxRows"
    FROM "Instrument" i
    LEFT JOIN (
      SELECT "instrumentId", COUNT(*) AS "pxRows" FROM "PriceObservation"
      WHERE basis = 'RAW_CLOSE' GROUP BY 1
    ) px ON px."instrumentId" = i.id
    JOIN (
      SELECT "instrumentId", MIN(date) AS "firstEvidence" FROM (
        SELECT "instrumentId", date FROM "PositionObservation" WHERE "deletedAt" IS NULL
        UNION ALL
        SELECT "instrumentId", date FROM "InvestmentEvent"
      ) e GROUP BY 1
    ) ev ON ev."instrumentId" = i.id
    ORDER BY i."assetClass", i."tickerSymbol" NULLS LAST
  `;

  let attention = 0;

  // ── 1. Every owned instrument, over its ownership-evidence window ─────────
  console.log(`1 · OWNERSHIP WINDOWS — [earliest position/event evidence → ${latestClosed}]\n`);
  {
    const requests: CoverageRequest[] = rows.map((r) => ({
      instrumentId: r.id,
      fromISO: toISODateUTC(r.firstEvidence!),
      toISO:   latestClosed,
    }));
    const coverages = await loadInstrumentCoverage(requests, { basis: PriceBasis.RAW_CLOSE, registry });
    const byId = new Map(coverages.map((c) => [c.instrumentId, c]));

    for (const r of rows) {
      const coverage = byId.get(r.id)!;
      const plan = planAcquisition({ coverage, maxCalendarDaysPerRequest: CHUNK_DAYS });
      if (needsAttention(plan)) attention++;
      console.log(`  ${name(r)} ${toISODateUTC(r.firstEvidence!)} → ${latestClosed}  (${r.pxRows} archived row(s))`);
      for (const line of render(plan)) console.log(line);
    }

    const kinds = rows.map((r) => planAcquisition({
      coverage: byId.get(r.id)!, maxCalendarDaysPerRequest: CHUNK_DAYS,
    }).kind);
    const tally = [...new Set(kinds)].sort().map((k) => `${k}=${kinds.filter((x) => x === k).length}`).join(" · ");
    console.log(`\n    tally: ${tally}\n`);
  }

  // ── 2. Crypto over a wide ownership window ────────────────────────────────
  console.log(`2 · CRYPTO WIDE WINDOW — [2023-01-01 → ${latestClosed}] — the flat-history case\n`);
  {
    const crypto = rows.filter((r) => r.assetClass === "CRYPTO");
    if (crypto.length === 0) console.log("    (no crypto instruments)\n");
    else {
      const coverages = await loadInstrumentCoverage(
        crypto.map((r) => ({ instrumentId: r.id, fromISO: "2023-01-01", toISO: latestClosed })),
        { basis: PriceBasis.RAW_CLOSE, registry },
      );
      const byId = new Map(coverages.map((c) => [c.instrumentId, c]));
      for (const r of crypto) {
        const plan = planAcquisition({ coverage: byId.get(r.id)!, maxCalendarDaysPerRequest: CHUNK_DAYS });
        if (needsAttention(plan)) attention++;
        console.log(`  ${name(r)} 2023-01-01 → ${latestClosed}  (${r.pxRows} archived row(s))`);
        for (const line of render(plan)) console.log(line);
      }
      console.log("");
    }
  }

  // ── 3. Synthetic multiple-disjoint-gap case ───────────────────────────────
  // Local data has no interior gaps (coverage is one dense block per
  // instrument), so the multi-gap shape is exercised by DELETING dates from a
  // real observation set IN MEMORY. Nothing is modified in the database — this
  // is a what-if over real archived dates, and it is the shape the deleted
  // block-edge arithmetic could not represent at all.
  console.log("3 · SYNTHETIC MULTI-GAP CASE — real archived dates with holes punched in memory (DB untouched)\n");
  {
    const subject = rows.find((r) => (r.assetClass === "EQUITY" || r.assetClass === "ETF") && Number(r.pxRows) > 0);
    if (!subject) console.log("    (no priced equity available)\n");
    else {
      const FROM = "2025-01-01", TO = "2025-12-31";
      const real = (await priceArchive.readCoveredDates!([subject.id], PriceBasis.RAW_CLOSE, FROM, TO))
        .map((o): ObservedPriceDate => ({ dateISO: o.dateISO, currency: o.currency }));

      // Punch three disjoint holes: a leading run, an interior run, a trailing run.
      const holes = new Set<string>([
        ...real.slice(0, 5).map((o) => o.dateISO),
        ...real.slice(100, 104).map((o) => o.dateISO),
        ...real.slice(-3).map((o) => o.dateISO),
      ]);
      const punched = real.filter((o) => !holes.has(o.dateISO));

      const coverage: InstrumentCoverage = resolveInstrumentCoverage({
        meta: {
          instrumentId: subject.id, assetClass: subject.assetClass,
          tickerSymbol: subject.ticker, marketIdentifierCode: subject.mic, currency: subject.currency,
        },
        basis: PriceBasis.RAW_CLOSE,
        requestedFromISO: FROM, requestedToISO: TO,
        observed: punched, providerFloorISO: floor,
      });
      const plan = planAcquisition({ coverage, maxCalendarDaysPerRequest: CHUNK_DAYS });
      console.log(`  ${name(subject)} ${FROM} → ${TO}  (${real.length} real archived date(s), ${holes.size} removed in memory)`);
      for (const line of render(plan)) console.log(line);

      // Same holes, a tight request limit — proves chunking splits within a gap
      // but never merges across a covered date.
      const chunked = planAcquisition({ coverage, maxCalendarDaysPerRequest: 3 });
      console.log(`\n  …the same coverage replanned at a 3-day request limit:`);
      for (const line of render(chunked)) console.log(line);
      console.log("");
    }
  }

  if (attention > 0) {
    console.error(`${attention} plan(s) need attention (calendar-unavailable or planning-error).`);
    return 1;
  }
  console.log("check-acquisition-plan: every instrument planned without incident. NOTHING WAS FETCHED OR WRITTEN.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("check-acquisition-plan: failed:", e);
    process.exit(2);
  });
