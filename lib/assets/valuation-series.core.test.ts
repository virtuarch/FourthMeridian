/**
 * lib/assets/valuation-series.core.test.ts   (RWA-2A)
 *
 * The one valuation policy for manual assets: recorded anchors, the same-day
 * correction rule, the purchase-price opt-in, no ownership before acquisition,
 * linear modeling up AND down, carry-forward without extrapolation, and the
 * legacy (pre-RWA-2) fallback.
 *
 *   npx tsx lib/assets/valuation-series.core.test.ts
 */
import {
  buildValuationSeries, checkAcquisitionDate, checkEffectiveDate, describeModeledHistory,
  isIsoDate, latestAnchor, resolveAnchors, valueOn,
  type ProfileFacts, type ValuationRow,
} from "./valuation-series.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const row = (id: string, effectiveDate: string, value: number, recordedAt = `${effectiveDate}T12:00:00.000Z`, currency = "USD"): ValuationRow =>
  ({ id, effectiveDate, value, currency, recordedAt });
const profile = (over: Partial<ProfileFacts> = {}): ProfileFacts =>
  ({ acquisitionDate: null, purchasePrice: null, purchaseCurrency: null, purchasePriceIsStartingValue: false, ...over });
const TODAY = "2026-10-15";

console.log("dates and validation");
check("isIsoDate accepts a real date", isIsoDate("2024-02-29"));
check("isIsoDate rejects an impossible date", !isIsoDate("2026-02-30") && !isIsoDate("2026-1-5") && !isIsoDate(42));
check("acquisition in the future refused", !checkAcquisitionDate("2026-10-16", TODAY).ok);
check("acquisition today allowed", checkAcquisitionDate(TODAY, TODAY).ok);
check("valuation in the future refused", !checkEffectiveDate("2026-11-01", TODAY, null).ok);
check("valuation before acquisition refused", !checkEffectiveDate("2020-01-01", TODAY, "2021-06-01").ok);
check("valuation on the acquisition date allowed", checkEffectiveDate("2021-06-01", TODAY, "2021-06-01").ok);

console.log("Mode 1 — purchase price is an anchor ONLY by opt-in");
{
  const vals = [row("v1", TODAY, 500_000)];
  const noOpt = resolveAnchors({ currency: "USD", valuations: vals, legacy: null,
    profile: profile({ acquisitionDate: "2020-10-15", purchasePrice: 400_000, purchaseCurrency: "USD" }) });
  check("without the opt-in the purchase price is NOT an anchor", noOpt.anchors.length === 1 && noOpt.anchors[0].kind === "USER_VALUATION");
  check("…ownership still starts at acquisition", noOpt.startDate === "2020-10-15");
  const mid = valueOn(noOpt, "2023-01-01");
  check("…and the years before the first valuation are held but NOT valued (nothing invented)",
    mid.held === true && mid.valued === false);
  check("before acquisition: not held (no fabricated ownership)", valueOn(noOpt, "2019-01-01").held === false);
  check("no modeled history without two anchors", describeModeledHistory(noOpt, TODAY) === null);

  const opt = resolveAnchors({ currency: "USD", valuations: vals, legacy: null,
    profile: profile({ acquisitionDate: "2020-10-15", purchasePrice: 400_000, purchaseCurrency: "USD", purchasePriceIsStartingValue: true }) });
  check("with the opt-in: two anchors, purchase first", opt.anchors.map((a) => a.kind).join() === "PURCHASE_PRICE,USER_VALUATION");
  const start = valueOn(opt, "2020-10-15");
  check("acquisition day is the recorded purchase price", start.held && start.valued && start.value === 400_000 && start.basis === "recorded");
  const half = valueOn(opt, "2023-10-15");
  check("midway is MODELED, linear, whole units (appreciation)",
    half.held && half.valued && half.basis === "modeled" && Math.abs(half.value - 450_000) < 200 && Number.isInteger(half.value),
    JSON.stringify(half));
  const desc = describeModeledHistory(opt, TODAY);
  check("descriptor says modeled, not observed", desc?.basis === "MODELED" && /not observed market prices/.test(desc.meaning));
  check("purchase price in another currency is NOT used, and says so",
    resolveAnchors({ currency: "USD", valuations: vals, legacy: null,
      profile: profile({ acquisitionDate: "2020-10-15", purchasePrice: 400_000, purchaseCurrency: "EUR", purchasePriceIsStartingValue: true }) })
      .excluded.some((e) => e.reason === "PURCHASE_CURRENCY_MISMATCH"));
}

console.log("depreciation (a vehicle)");
{
  const r = resolveAnchors({ currency: "USD", legacy: null,
    valuations: [row("a", "2024-01-01", 40_000), row("b", "2026-01-01", 28_000)],
    profile: profile({ acquisitionDate: "2024-01-01" }) });
  const m = valueOn(r, "2025-01-01");
  check("modeled value falls between the two estimates", m.held && m.valued && m.basis === "modeled" && m.value < 40_000 && m.value > 28_000);
}

console.log("Mode 2 — append-only anchors, same-day rule, backdating, carry-forward");
{
  const vals = [
    row("jan", "2026-01-10", 300_000),
    row("jun-1", "2026-06-01", 310_000, "2026-06-01T09:00:00.000Z"),
    row("jun-2", "2026-06-01", 315_000, "2026-06-02T10:00:00.000Z"),   // same-day correction, recorded later
    row("mar-backdated", "2026-03-01", 305_000, "2026-10-01T10:00:00.000Z"), // entered in Oct, dated March
  ];
  const r = resolveAnchors({ currency: "USD", valuations: vals, profile: null, legacy: null });
  check("one anchor per date; the later-recorded same-day row wins",
    r.anchors.map((a) => `${a.date}:${a.value}`).join() === "2026-01-10:300000,2026-03-01:305000,2026-06-01:315000");
  check("the replaced same-day row is kept as superseded, not lost", r.superseded.map((s) => s.id).join() === "jun-1");
  check("a backdated correction does not displace the latest anchor", latestAnchor(r)?.value === 315_000);
  const c = valueOn(r, TODAY);
  check("after the last valuation: carried forward, never extrapolated",
    c.held && c.valued && c.basis === "carried" && c.value === 315_000);
  const a = valueOn(r, "2026-03-01");
  check("on an anchor date: recorded", a.held && a.valued && a.basis === "recorded" && a.value === 305_000);
  const out = valueOn(r, "2025-12-31");
  check("before the first valuation with no acquisition date: not held", out.held === false);
  check("a ledger row in another currency is excluded and named",
    resolveAnchors({ currency: "USD", valuations: [row("x", TODAY, 1, undefined, "EUR")], profile: null, legacy: null })
      .excluded[0]?.reason === "VALUATION_CURRENCY_MISMATCH");
}

console.log("legacy asset (pre-RWA-2, no ledger rows)");
{
  const r = resolveAnchors({ currency: "USD", valuations: [], profile: null,
    legacy: { balance: 12_000, currency: "USD", lastUpdated: "2026-08-20T15:00:00.000Z" } });
  check("its balance at lastUpdated is the one recorded anchor", r.anchors.length === 1 && r.anchors[0].kind === "LEGACY_BALANCE" && r.anchors[0].date === "2026-08-20");
  check("…and it is carried forward to today", (() => { const v = valueOn(r, TODAY); return v.held && v.valued && v.basis === "carried" && v.value === 12_000; })());
  check("ledger rows replace the legacy anchor entirely",
    resolveAnchors({ currency: "USD", valuations: [row("v", TODAY, 1)], profile: null,
      legacy: { balance: 12_000, currency: "USD", lastUpdated: "2026-08-20T15:00:00.000Z" } }).anchors.every((a) => a.kind !== "LEGACY_BALANCE"));
}

console.log("series for the chart");
{
  const r = resolveAnchors({ currency: "USD", legacy: null,
    valuations: [row("a", "2016-01-01", 100_000), row("b", "2026-01-01", 200_000)], profile: null });
  const s = buildValuationSeries(r, TODAY, 120);
  check("bounded point count over ten years", s.length <= 125, String(s.length));
  check("every anchor date is present (recorded values never sampled away)",
    s.some((p) => p.date === "2016-01-01" && p.basis === "recorded") && s.some((p) => p.date === "2026-01-01" && p.basis === "recorded"));
  check("ends today, carried", s[s.length - 1].date === TODAY && s[s.length - 1].basis === "carried");
  check("ascending dates", s.every((p, i) => i === 0 || s[i - 1].date < p.date));
  check("no points before the first anchor", s[0].date === "2016-01-01");
}

if (failures > 0) {
  console.error(`\nvaluation-series: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nvaluation-series: all passed.");
