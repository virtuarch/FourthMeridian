/**
 * scripts/check-price-coverage.ts
 *
 * V26-PRICE-2 — historical price coverage probe. READ-ONLY.
 *
 * Run:
 *     npx dotenv -e .env.local -- npx tsx scripts/check-price-coverage.ts
 *
 * Exit codes: 0 = calendar validated · 1 = calendar findings · 2 = query failure.
 *
 * READ-ONLY and structurally so: every statement is a SELECT, and the coverage
 * binding it calls performs no provider I/O (a provider's `historicalDepth` is a
 * declared property, not a call). Nothing here writes, fetches, or schedules.
 *
 * ── Section 1 is the falsifiable one ─────────────────────────────────────────
 * Each equity/ETF is evaluated over ITS OWN archived span. Inside that span the
 * vendor supplied a row for every day the market was open, so the calendar's
 * expected dates must match the archive exactly and coverage must be COMPLETE.
 * Any missing range is a defect in the holiday tables, not in the data — a
 * calendar claiming a trading day the market was shut. This is what makes the
 * tables falsifiable rather than merely plausible: it is the market's own record
 * checking my arithmetic, and it is the only section that sets the exit code.
 *
 * Sections 2 and 3 are diagnostic: they report the real production answer over
 * ownership windows, where genuine gaps are EXPECTED and are the point of the
 * whole arc. A missing range there is a finding for PRICE-3/PRICE-4 to act on,
 * not a bug in this slice, so they never fail the probe.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { yesterdayUTCISO, toISODateUTC } from "@/lib/prices/config";
import { defaultPriceRegistry } from "@/lib/prices/registry";
import { loadInstrumentCoverage, type CoverageRequest } from "@/lib/prices/coverage-binding";
import { resolveProviderFloorISO } from "@/lib/prices/coverage-binding.core";
import type { InstrumentCoverage } from "@/lib/prices/coverage-binding.core";

interface InstrumentRow {
  id: string; ticker: string | null; assetClass: string; mic: string | null;
  firstPx: Date | null; lastPx: Date | null; pxRows: bigint;
  firstEvidence: Date | null;
}

function label(r: InstrumentRow): string {
  return `${(r.ticker ?? "(no ticker)").slice(0, 22).padEnd(22)} ${r.assetClass.padEnd(7)}`;
}

/** One-line summary of any binding outcome. */
function describe(c: InstrumentCoverage): string {
  if (c.kind === "calendar-unavailable") {
    const f = c.failure;
    return f.code === "HORIZON_EXCEEDED"
      ? `CALENDAR ${f.code} — ${f.calendarId} supports ${f.supportedFromISO}→${f.supportedThroughISO}, asked ${f.requestedFromISO}→${f.requestedToISO}`
      : `CALENDAR ${f.code} — assetClass=${f.assetClass} mic=${f.mic ?? "NULL"}`;
  }
  const r = c.report;
  const gaps = r.missingRanges.length === 0
    ? ""
    : ` · gaps ${r.missingRanges.map((m) => `${m.fromISO}→${m.toISO}(${m.expectedDates})`).join(" ")}`;
  const cur = c.currencyMismatchCount > 0 ? ` · currency-mismatch ${c.currencyMismatchCount}` : "";
  return `${r.state.toUpperCase().padEnd(11)} expected ${String(r.expectedCount).padStart(4)} · observed ${String(r.observedCount).padStart(4)} · ` +
    `missing ${String(r.missingCount).padStart(4)} · unreachable ${r.unreachableCount} · [${r.reasons.join(",")}]${cur}${gaps}`;
}

async function main(): Promise<number> {
  const registry = defaultPriceRegistry();
  const floor = resolveProviderFloorISO(registry, PriceBasis.RAW_CLOSE);
  console.log(
    `registry: ${registry.adapters.length} adapter(s)` +
    `${registry.adapters.length ? ` (${registry.adapters.map((a) => a.source).join(", ")})` : " — no vendor key configured"}` +
    ` · provider floor: ${floor ?? "null (unbounded — coverage is not acquisition)"}\n`,
  );

  const instruments = await db.$queryRaw<InstrumentRow[]>`
    SELECT i.id, i."tickerSymbol" AS ticker, i."assetClass"::text AS "assetClass",
           i."marketIdentifierCode" AS mic,
           px."firstPx", px."lastPx", COALESCE(px."pxRows", 0) AS "pxRows",
           ev."firstEvidence"
    FROM "Instrument" i
    LEFT JOIN (
      SELECT "instrumentId", MIN(date) AS "firstPx", MAX(date) AS "lastPx", COUNT(*) AS "pxRows"
      FROM "PriceObservation" WHERE basis = 'RAW_CLOSE' GROUP BY 1
    ) px ON px."instrumentId" = i.id
    LEFT JOIN (
      SELECT "instrumentId", MIN(date) AS "firstEvidence" FROM (
        SELECT "instrumentId", date FROM "PositionObservation" WHERE "deletedAt" IS NULL
        UNION ALL
        SELECT "instrumentId", date FROM "InvestmentEvent"
      ) e GROUP BY 1
    ) ev ON ev."instrumentId" = i.id
    WHERE ev."firstEvidence" IS NOT NULL OR px."pxRows" > 0
    ORDER BY i."assetClass", i."tickerSymbol" NULLS LAST
  `;

  let findings = 0;

  // ── 1. ACCEPTANCE — the calendar must reproduce each archived span ─────────
  console.log("1 · CALENDAR FALSIFICATION — each equity/ETF over its own archived span");
  console.log("    (inside a covered span the vendor priced every open day, so this MUST be complete)\n");
  {
    const eligible = instruments.filter(
      (r) => (r.assetClass === "EQUITY" || r.assetClass === "ETF") && r.firstPx && r.lastPx && Number(r.pxRows) > 0,
    );
    if (eligible.length === 0) {
      console.log("    (no priced equity/ETF instruments in this database — section skipped)\n");
    } else {
      const requests: CoverageRequest[] = eligible.map((r) => ({
        instrumentId: r.id,
        fromISO: toISODateUTC(r.firstPx!),
        toISO:   toISODateUTC(r.lastPx!),
      }));
      const results = await loadInstrumentCoverage(requests);
      const byId = new Map(results.map((c) => [c.instrumentId, c]));
      for (const r of eligible) {
        const c = byId.get(r.id)!;
        const ok = c.kind === "report" && c.report.state === "complete" && c.report.missingRanges.length === 0;
        if (!ok) findings++;
        console.log(`  ${ok ? "✓" : "✗"} ${label(r)} ${toISODateUTC(r.firstPx!)}→${toISODateUTC(r.lastPx!)}  ${describe(c)}`);
      }
      console.log(
        findings === 0
          ? `\n    ✓ all ${eligible.length} instrument(s) complete — holiday tables reproduce the archive exactly\n`
          : `\n    ✗ ${findings} instrument(s) NOT complete — the holiday tables disagree with the market's own record\n`,
      );
    }
  }

  // ── 2. Production answer over ownership-evidence windows ──────────────────
  const latestClosed = yesterdayUTCISO();
  console.log(`2 · OWNERSHIP-EVIDENCE WINDOWS — [earliest position/event evidence → ${latestClosed}]`);
  console.log("    (diagnostic: real gaps here are the arc's subject matter, not a defect in this slice)\n");
  {
    const owned = instruments.filter((r) => r.firstEvidence);
    const requests: CoverageRequest[] = owned.map((r) => ({
      instrumentId: r.id,
      fromISO: toISODateUTC(r.firstEvidence!),
      toISO:   latestClosed,
    }));
    const results = requests.length ? await loadInstrumentCoverage(requests) : [];
    const byId = new Map(results.map((c) => [c.instrumentId, c]));
    for (const r of owned) {
      console.log(`    ${label(r)} ${toISODateUTC(r.firstEvidence!)}→${latestClosed}  ${describe(byId.get(r.id)!)}`);
    }
    console.log("");
  }

  // ── 3. Crypto over a wide window — the flat-history case ──────────────────
  console.log("3 · CRYPTO OVER A WIDE WINDOW — is dense-but-short mistaken for complete?\n");
  {
    const crypto = instruments.filter((r) => r.assetClass === "CRYPTO");
    if (crypto.length === 0) {
      console.log("    (no crypto instruments in this database)\n");
    } else {
      const WIDE_FROM = "2023-01-01";
      const results = await loadInstrumentCoverage(
        crypto.map((r) => ({ instrumentId: r.id, fromISO: WIDE_FROM, toISO: latestClosed })),
      );
      const byId = new Map(results.map((c) => [c.instrumentId, c]));
      for (const r of crypto) {
        const c = byId.get(r.id)!;
        console.log(`    ${label(r)} ${WIDE_FROM}→${latestClosed}  ${describe(c)}`);
        if (c.kind === "report" && c.report.state === "partial") {
          console.log(
            `      ↳ its ${r.pxRows} archived row(s) are internally dense, yet the ownership-relative\n` +
            `        window is ${c.report.missingCount} expected date(s) short. Dense ≠ complete.`,
          );
        }
      }
      console.log("");
    }
  }

  if (findings > 0) {
    console.error(
      `${findings} calendar finding(s). A missing range inside an instrument's OWN archived span means\n` +
      `the holiday tables in lib/calendar/data/ claim a trading day the market was closed (or omit a\n` +
      `closure). Correct the table and bump the revision in US_EQUITY_CALENDAR_ID.`,
    );
    return 1;
  }
  console.log("check-price-coverage: CLEAN — the trading calendar matches the archive on every priced span.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("check-price-coverage: failed:", e);
    process.exit(2);
  });
