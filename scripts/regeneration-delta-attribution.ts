/**
 * scripts/regeneration-delta-attribution.ts
 *
 * V26 — REGENERATION DELTA ATTRIBUTION. STRICTLY READ-ONLY.
 *
 *     npx dotenv -e .env.local -- npx tsx scripts/regeneration-delta-attribution.ts [threshold]
 *
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  NO WRITES. NO PROVIDER CALLS. NO REGENERATION.                        ║
 * ║  Row counts for PriceObservation and SpaceSnapshot are captured before ║
 * ║  and after and compared. Any change ABORTS with a non-zero exit — the  ║
 * ║  script cannot silently repeat the 2026-07-30 dry-run incident, in     ║
 * ║  which a "read-only" report made live Tiingo calls and inserted 18     ║
 * ║  price rows because `dryRun` suppressed only the snapshot upserts.     ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * ── The question this report exists to answer ────────────────────────────────
 * Regeneration would move 705 days, halving `stocks` on the largest. Two very
 * different things look identical in a summary:
 *
 *   A. BETTER PRICE EVIDENCE REVEALING QUANTITY LIMITATIONS
 *      The old row held today's VALUE flat across history. The new row holds
 *      today's QUANTITY flat and prices it at each day's real close. Where the
 *      historical price is below today's, the valuation legitimately falls. The
 *      number becomes more honest while remaining quantity-limited.
 *
 *   B. AN UNEXPECTED PRICING REGRESSION
 *      The new value is NOT explained by (today's quantity × that day's price) —
 *      something else moved, and the delta is unaccounted for.
 *
 * The discriminator is arithmetic, not judgement — but it must be arithmetic on
 * the SAME numbers the writer uses. This report therefore takes its per-holding
 * figures from A8's own valuation view (getInvestmentValueForWindow, with the
 * identical arguments regenerate-history.ts passes), never from a
 * re-implementation.
 *
 * That distinction matters: an earlier draft of this script modelled the new
 * value as Σ(today's quantity × that day's close) and flagged 704 days
 * "unexplained". The model was wrong, not the data — regeneration does NOT hold
 * every holding's quantity constant; it resolves each instrument's quantity
 * as-of the date and only holds constant before its earliest observation. A
 * re-implementation that disagrees with the writer produces false alarms, which
 * on a report whose whole purpose is to detect a regression is worse than no
 * report at all.
 *
 * `components` carries, per instrument per date: the quantity actually used and
 * its trust tier, the price used with its effective date and staleness, the
 * price tier, and the reporting-currency value. Σ reportingValue is the
 * valuedSubtotal the snapshot stores, so the residual against it is exact by
 * construction and any gap is a real finding.
 */

import { db } from "@/lib/db";
import { getInvestmentValueForWindow } from "@/lib/investments/valuation";
import type { InstrumentValuation, InvestmentValuationView } from "@/lib/investments/valuation-core";
import { regenerateWealthHistory, type WealthHistoryDiff } from "@/lib/snapshots/regenerate-history";
import {
  classifyRegeneration, type StoredSnapshotComponents,
} from "@/lib/snapshots/regeneration-candidates.core";
import {
  summariseSnapshotEvidence,
  type InstrumentEvidenceAxes,
  type PriceCoverageAxis,
  type OwnershipConfidenceAxis,
  type QuantityConfidenceAxis,
} from "@/lib/snapshots/price-completeness.core";
import { loadOwnershipWindows } from "@/lib/prices/ownership-window";

const THRESHOLD = Number(process.argv[2] ?? 1000);
/** Residual above this (absolute, reporting currency) is a real discrepancy. */
const RESIDUAL_TOLERANCE = 0.01;

type Category = "PRICE_ONLY" | "OWNERSHIP_CONFIDENCE" | "QUANTITY_LIMITED" | "MIXED" | "UNEXPLAINED";

/**
 * Map A8's per-instrument tiers onto the PRICE-5 evidence axes.
 *
 * Only MARKET-PRICED components are considered. A cash position (CUR:USD) has no
 * market price by nature and would otherwise drag the whole day's price axis to
 * NONE, reporting a price gap where none exists — the unvalued count and A8's
 * own tier already surface it correctly.
 */
function priceAxis(v: InstrumentValuation): PriceCoverageAxis | null {
  if (v.reportingValue === null && v.nativePrice === null) return null; // not market-priced
  if (v.nativePrice === null) return "NONE";
  if (v.priceTier === "observed") return "COMPLETE";
  return "PARTIAL"; // walked back within the staleness bound
}
function quantityAxis(v: InstrumentValuation, hasEvents: boolean): QuantityConfidenceAxis {
  if (v.quantity === null) return "UNKNOWN";
  return hasEvents ? "RECONSTRUCTED" : "BACK_PROJECTED";
}

const f2 = (n: number): string => n.toFixed(2);
const pct = (num: number, den: number): string => (den === 0 ? "n/a" : `${((num / den) * 100).toFixed(1)}%`);

async function main(): Promise<number> {
  // ── Guard: capture the world before touching anything ─────────────────────
  const beforePrices    = await db.priceObservation.count();
  const beforeSnapshots = await db.spaceSnapshot.count();
  const beforeObserved  = await db.spaceSnapshot.count({ where: { isEstimated: false } });

  console.log("╔════════════════════════════════════════════════════════════════════════╗");
  console.log("║  READ-ONLY DELTA ATTRIBUTION — no writes, no provider calls           ║");
  console.log("╚════════════════════════════════════════════════════════════════════════╝");
  console.log(`threshold: $${THRESHOLD} absolute · guard baseline: ${beforePrices} price rows, ${beforeSnapshots} snapshots\n`);

  const spaces = await db.space.findMany({ select: { id: true, name: true, reportingCurrency: true }, orderBy: { id: "asc" } });
  const categoryTotals: Record<Category, number> = {
    PRICE_ONLY: 0, OWNERSHIP_CONFIDENCE: 0, QUANTITY_LIMITED: 0, MIXED: 0, UNEXPLAINED: 0,
  };
  let unexplainedDays = 0;
  /** UPDATED days valued entirely BEFORE any ownership evidence exists. */
  let prehistoryDays = 0;
  let prehistoryValue = 0;

  for (const space of spaces) {
    const bounds = await db.spaceSnapshot.aggregate({
      where: { spaceId: space.id }, _min: { date: true }, _max: { date: true },
    });
    if (!bounds._min.date || !bounds._max.date) continue;
    const fromDate = bounds._min.date.toISOString().slice(0, 10);
    const toDate   = bounds._max.date.toISOString().slice(0, 10);

    // dryRun: true — writes suppressed AND acquisition suppressed (the fix for
    // the incident above). The guard at the end proves it held.
    const res = await regenerateWealthHistory({ spaceId: space.id, fromDate, toDate, dryRun: true });

    const stored = await db.spaceSnapshot.findMany({
      where:  { spaceId: space.id },
      select: { date: true, stocks: true, crypto: true, cash: true, savings: true, debt: true, netWorth: true },
    });
    const storedByDate = new Map<string, StoredSnapshotComponents>(
      stored.map((r) => [r.date.toISOString().slice(0, 10), {
        stocks: r.stocks, crypto: r.crypto, cash: r.cash,
        savings: r.savings, debt: r.debt, netWorth: r.netWorth,
      }]),
    );

    const candidates = res.diffs.map((d: WealthHistoryDiff) => {
      const fields = d.stocksAfter === null ? null : {
        stocks: d.stocksAfter, crypto: d.cryptoAfter ?? 0, cash: d.cashAfter ?? 0,
        savings: d.savingsAfter ?? 0, debt: d.debtAfter ?? 0, netWorth: d.netWorthAfter ?? 0,
        totalAssets: 0, netLiquid: 0, cashOnHand: 0, total: 0,
      };
      return classifyRegeneration(
        { date: d.date, action: d.action, fields, isEstimated: true, tier: d.tier, reason: null } as never,
        storedByDate.get(d.date) ?? null,
      );
    });
    const updated = candidates.filter((c) => c.disposition === "UPDATED");
    if (updated.length === 0) continue;

    console.log("─".repeat(72));
    console.log(`SPACE: ${space.name ?? space.id}   ${fromDate} → ${toDate}   (${updated.length} UPDATED)`);
    console.log("─".repeat(72));

    // ── Authoritative per-holding valuation, the writer's own numbers ───────
    const dates = updated.map((c) => c.dateISO);
    let viewByDate = new Map<string, InvestmentValuationView>();
    try {
      viewByDate = await getInvestmentValueForWindow({
        spaceId: space.id,
        dates,
        holdConstantBeforeEarliest: true,
        excludeDigitalAssetAccounts: true,
      });
    } catch (e) {
      console.log(`  ⚠ valuation view unavailable: ${e instanceof Error ? e.message : e}\n`);
      continue;
    }

    const allInstrumentIds = [...new Set(
      [...viewByDate.values()].flatMap((v) => v.components.map((c) => c.instrumentId)),
    )];
    const tickerById = new Map(
      (await db.instrument.findMany({
        where: { id: { in: allInstrumentIds } }, select: { id: true, tickerSymbol: true },
      })).map((i) => [i.id, i.tickerSymbol ?? "(none)"]),
    );
    const eventCounts = await db.investmentEvent.groupBy({
      by: ["instrumentId"], where: { instrumentId: { in: allInstrumentIds } }, _count: { _all: true },
    });
    const hasEvents = new Set(
      eventCounts.filter((e) => e._count._all > 0 && e.instrumentId).map((e) => e.instrumentId!),
    );
    const ownership = await loadOwnershipWindows(allInstrumentIds, toDate);

    const material = updated
      .filter((c) => c.largestAbsDelta > THRESHOLD)
      .sort((a, b) => b.largestAbsDelta - a.largestAbsDelta);
    console.log(`  ${material.length} of ${updated.length} UPDATED day(s) exceed $${THRESHOLD}\n`);

    const dayCategory = new Map<string, Category>();

    for (const c of updated) {
      const dISO = c.dateISO;
      const priorRow = storedByDate.get(dISO);
      const stocksDelta = c.deltas.find((d) => d.component === "stocks");
      const nwDelta     = c.deltas.find((d) => d.component === "netWorth");
      const view = viewByDate.get(dISO);
      const components: InstrumentValuation[] = view ? view.components : [];

      // Σ reportingValue IS the valuedSubtotal the snapshot stores, so this
      // residual is exact by construction — any gap is a genuine finding.
      const modelled  = components.reduce((n, v) => n + (v.reportingValue ?? 0), 0);
      const recomputed = stocksDelta ? stocksDelta.after : (priorRow?.stocks ?? 0);
      const residual  = Math.abs(recomputed - modelled);
      const explained = residual <= RESIDUAL_TOLERANCE;

      const axes: InstrumentEvidenceAxes[] = components.flatMap((v) => {
        const pAxis = priceAxis(v);
        if (pAxis === null) return [];
        const own = ownership.get(v.instrumentId);
        const ownAxis: OwnershipConfidenceAxis =
          !own || own.kind !== "resolved" ? "UNKNOWN"
          : own.segments.some((sg) => sg.confidence === "KNOWN" && dISO >= sg.fromISO && dISO <= sg.toISO) ? "KNOWN"
          : own.segments.some((sg) => sg.confidence === "POSSIBLE" && dISO >= sg.fromISO && dISO <= sg.toISO) ? "POSSIBLE"
          : "UNKNOWN";
        return [{
          instrumentId: tickerById.get(v.instrumentId) ?? v.instrumentId,
          priceCoverage: pAxis,
          ownershipConfidence: ownAxis,
          quantityConfidence: quantityAxis(v, hasEvents.has(v.instrumentId)),
        }];
      });
      const evidence = summariseSnapshotEvidence(dISO, axes);

      const anyBackProjected = axes.some((a) => a.quantityConfidence !== "RECONSTRUCTED");
      const anyPossible      = axes.some((a) => a.ownershipConfidence !== "KNOWN");
      const category: Category =
        !explained ? "UNEXPLAINED"
        : anyBackProjected && anyPossible ? "MIXED"
        : anyBackProjected ? "QUANTITY_LIMITED"
        : anyPossible ? "OWNERSHIP_CONFIDENCE"
        : "PRICE_ONLY";
      dayCategory.set(dISO, category);
      categoryTotals[category]++;
      if (category === "UNEXPLAINED") unexplainedDays++;
      // A day whose every holding sits OUTSIDE any ownership segment is being
      // valued in prehistory — before any evidence that these assets were held.
      if (axes.length > 0 && axes.every((a) => a.ownershipConfidence === "UNKNOWN")) {
        prehistoryDays++;
        prehistoryValue = Math.max(prehistoryValue, Math.abs(stocksDelta?.delta ?? 0));
      }

      if (!material.includes(c)) continue;

      console.log(`  ${dISO}   category: ${category}`);
      console.log(`    stocks    ${f2(priorRow?.stocks ?? 0).padStart(12)} → ${f2(recomputed).padStart(12)}` +
        `   Δ ${f2(stocksDelta?.delta ?? 0).padStart(11)} (${pct(stocksDelta?.delta ?? 0, priorRow?.stocks ?? 0)})`);
      if (nwDelta) {
        console.log(`    netWorth  ${f2(nwDelta.before).padStart(12)} → ${f2(nwDelta.after).padStart(12)}` +
          `   Δ ${f2(nwDelta.delta).padStart(11)} (${pct(nwDelta.delta, nwDelta.before)})`);
      }
      console.log(`    Σ components = ${f2(modelled)} · residual vs recomputed ${f2(residual)}` +
        ` → ${explained ? "EXACT (fully attributed)" : "⚠ UNATTRIBUTED"}`);
      if (view) {
        console.log(`    valued ${view.valuedCount} holding(s), UNVALUED ${view.unvaluedCount}` +
          ` · A8 tier ${view.completeness?.tier ?? "?"}` +
          (view.unvaluedCount > 0
            ? ` · unvalued: ${view.unvalued.slice(0, 4).map((u) => tickerById.get(u.instrumentId) ?? u.instrumentId).join(",")}`
            : ""));
      }
      console.log(`    completeness: tier=${evidence.summary.tier} · price=${evidence.summary.priceCoverage}` +
        ` · ownership=${evidence.summary.ownershipConfidence} · quantity=${evidence.summary.quantityConfidence}` +
        ` · [${evidence.summary.reasons.join(",")}]`);

      const top = [...components]
        .sort((a, b) => (b.reportingValue ?? 0) - (a.reportingValue ?? 0))
        .slice(0, 5);
      console.log("    largest holdings on this date (quantity and price actually used):");
      for (const v of top) {
        const own = axes.find((a) => a.instrumentId === (tickerById.get(v.instrumentId) ?? v.instrumentId));
        console.log(
          `      ${(tickerById.get(v.instrumentId) ?? "?").padEnd(6)}` +
          ` qty ${(v.quantity ?? 0).toFixed(4).padStart(10)} [${v.quantityTier}]` +
          ` × ${v.nativePrice != null ? f2(v.nativePrice).padStart(9) : "     none"}` +
          ` @${v.priceDate ?? "—"}${v.staleDays ? `(+${v.staleDays}d)` : ""} [${v.priceTier}]` +
          ` = ${f2(v.reportingValue ?? 0).padStart(11)}` +
          `  [${own?.priceCoverage}/${own?.ownershipConfidence}/${own?.quantityConfidence}]`,
        );
      }
      console.log("");
    }

    // Per-space category tally
    const spaceTally = [...dayCategory.values()].reduce<Record<string, number>>((m, v) => {
      m[v] = (m[v] ?? 0) + 1; return m;
    }, {});
    console.log(`  space category tally: ${Object.entries(spaceTally).sort().map(([k, v]) => `${k}=${v}`).join(" · ")}\n`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = Object.values(categoryTotals).reduce((a, b) => a + b, 0);
  console.log("═".repeat(72));
  console.log("ALL UPDATED SNAPSHOTS BY CATEGORY");
  console.log("═".repeat(72));
  console.log(`  PRICE_ONLY            ${String(categoryTotals.PRICE_ONLY).padStart(5)}   better prices, quantities reconstructed`);
  console.log(`  OWNERSHIP_CONFIDENCE  ${String(categoryTotals.OWNERSHIP_CONFIDENCE).padStart(5)}   inferred ownership contributes`);
  console.log(`  QUANTITY_LIMITED      ${String(categoryTotals.QUANTITY_LIMITED).padStart(5)}   price-explained, quantities back-projected`);
  console.log(`  MIXED                 ${String(categoryTotals.MIXED).padStart(5)}   ownership AND quantity both limited`);
  console.log(`  UNEXPLAINED           ${String(categoryTotals.UNEXPLAINED).padStart(5)}   ⚠ NOT explained by price substitution`);
  console.log(`  total                 ${String(total).padStart(5)}`);
  console.log("");
  if (prehistoryDays > 0) {
    console.log("─".repeat(72));
    console.log("FINDING — VALUATION IN OWNERSHIP PREHISTORY");
    console.log("─".repeat(72));
    console.log(`  ${prehistoryDays} UPDATED day(s) are valued entirely BEFORE any ownership evidence.`);
    console.log("  Every contributing holding falls outside its KNOWN and POSSIBLE segments, i.e.");
    console.log("  the UNKNOWN prehistory V26-PRICE-4 refuses to ACQUIRE prices for — yet");
    console.log("  regeneration still VALUES those days, via holdConstantBeforeEarliest: true.");
    console.log(`  Largest stocks delta among them: ${f2(prehistoryValue)}.`);
    console.log("  The arithmetic is sound; the question is whether a portfolio should be");
    console.log("  reported at all for dates preceding any evidence it was held.\n");
  }
  console.log(unexplainedDays === 0
    ? "VERDICT: every UPDATED day is fully attributed — Σ(quantity used × price used)\n" +
      "equals the recomputed total to the cent, with no unexplained residue. This is\n" +
      "BETTER PRICE EVIDENCE REVEALING QUANTITY LIMITATIONS, not a pricing regression.\n" +
      "The valuations become more honest while remaining quantity-limited — QUANTITY-1\n" +
      "is what closes the remaining gap."
    : `VERDICT: ⚠ ${unexplainedDays} day(s) are NOT explained by price substitution.\n` +
      "Investigate before approving production regeneration.");

  // ── Guard: prove nothing moved ────────────────────────────────────────────
  const afterPrices    = await db.priceObservation.count();
  const afterSnapshots = await db.spaceSnapshot.count();
  const afterObserved  = await db.spaceSnapshot.count({ where: { isEstimated: false } });
  console.log("\n" + "─".repeat(72));
  if (afterPrices !== beforePrices || afterSnapshots !== beforeSnapshots || afterObserved !== beforeObserved) {
    console.error(
      `✗ WRITE DETECTED — prices ${beforePrices}→${afterPrices}, snapshots ${beforeSnapshots}→${afterSnapshots}, ` +
      `observed ${beforeObserved}→${afterObserved}. This report is NOT read-only. Investigate immediately.`,
    );
    return 2;
  }
  console.log(`✓ read-only verified: prices ${afterPrices} unchanged · snapshots ${afterSnapshots} unchanged · observed ${afterObserved} unchanged`);
  return unexplainedDays === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error("regeneration-delta-attribution: failed:", e); process.exit(2); });
