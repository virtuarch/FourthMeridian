/**
 * lib/data/transaction-aggregate-core.test.ts  (TX-3.1b)
 *
 * Pure tests for the aggregate fold — no DB, no FX archive.
 *
 * The load-bearing proof is EXACTNESS: folding grouped, sign-split, date-keyed sums
 * must produce the same number the client produces by converting every row
 * individually (`Math.abs(convertMoney(row.amount, row.date))` summed per flow type).
 * If that equivalence fails, the explorer's "total" silently disagrees with its own
 * list — the exact class of dishonesty that removed amount sorting (M1).
 *
 *   npx tsx lib/data/transaction-aggregate-core.test.ts
 */

import { foldAggregateGroups, conversionKeysFor, type AggregateGroup } from "./transaction-aggregate-core";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import { UNCLASSIFIED_FLOW_KEY } from "@/lib/transactions/flow-predicates";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Identity context — a single-currency Space (the overwhelmingly common case). */
const USD: ConversionContext = {
  target: "USD",
  resolve: (from, dateISO) => ({ kind: "miss", quote: from, requestedDateISO: dateISO }),
};

/**
 * A two-currency context with a DIFFERENT rate per date, so a fold that ignored the
 * date (converting a whole-currency total at one rate) would produce a wrong number
 * and this test would catch it.
 */
const RATES: Record<string, number> = { "2026-06-01": 1.1, "2026-06-02": 1.5 };
const MULTI: ConversionContext = {
  target: "USD",
  resolve: (from, dateISO) =>
    from === "EUR" && RATES[dateISO] != null
      ? {
          kind: "rate",
          rate: RATES[dateISO],
          requestedDateISO: dateISO,
          effectiveDates: { from: dateISO, to: dateISO },
          staleness: "exact",
        }
      : { kind: "miss", quote: from, requestedDateISO: dateISO },
};

console.log("FOLD — magnitude per flow type (identity / single-currency)");
{
  const groups: AggregateGroup[] = [
    { flowType: "SPENDING", currency: "USD", date: "2026-06-01", sum: -300 }, // negatives pass
    { flowType: "SPENDING", currency: "USD", date: "2026-06-02", sum: -200 },
    { flowType: "INCOME",   currency: "USD", date: "2026-06-01", sum: 1000 }, // positives pass
  ];
  const agg = foldAggregateGroups(groups, 3, USD);
  check("count is passed through exactly", agg.count === 3);
  check("SPENDING magnitude = |−300| + |−200| = 500", near(agg.totalsByFlowType.SPENDING, 500));
  check("INCOME magnitude = 1000", near(agg.totalsByFlowType.INCOME, 1000));
  check("currency is the context target", agg.currency === "USD");
  check("identity conversion is not flagged estimated", agg.estimated === false);
}

console.log("FOLD — the SIGN SPLIT is load-bearing (netting would be wrong)");
{
  // Same flow type, same day, both directions — e.g. a purchase and a refund.
  // Netted:      |1000 + (-300)| = 700   ← WRONG
  // Magnitudes:  |1000| + |-300| = 1300  ← what the client computes
  const groups: AggregateGroup[] = [
    { flowType: "SPENDING", currency: "USD", date: "2026-06-01", sum: 1000 },
    { flowType: "SPENDING", currency: "USD", date: "2026-06-01", sum: -300 },
  ];
  const agg = foldAggregateGroups(groups, 2, USD);
  check("magnitudes add, they do not net", near(agg.totalsByFlowType.SPENDING, 1300));
  check("specifically NOT the netted 700", !near(agg.totalsByFlowType.SPENDING, 700));
}

console.log("EXACTNESS — fold(grouped) === client's per-row conversion");
{
  // A realistic mixed set: two currencies, two dates (different rates), both signs.
  const rows = [
    { flowType: "SPENDING", currency: "EUR", date: "2026-06-01", amount: -100 },
    { flowType: "SPENDING", currency: "EUR", date: "2026-06-01", amount: -50 },
    { flowType: "SPENDING", currency: "EUR", date: "2026-06-02", amount: -100 }, // different rate
    { flowType: "SPENDING", currency: "USD", date: "2026-06-01", amount: -25 },
    { flowType: "INCOME",   currency: "EUR", date: "2026-06-02", amount: 400 },
    { flowType: "INCOME",   currency: "USD", date: "2026-06-01", amount: 90 },
    { flowType: null,       currency: "USD", date: "2026-06-01", amount: -7 },  // unclassified
  ];

  // What the CLIENT does today: convert every row at its own date, take |·|, sum.
  const clientTotals: Record<string, number> = {};
  for (const r of rows) {
    const c = convertMoney({ amount: r.amount, currency: r.currency }, r.date, MULTI);
    const key = r.flowType ?? UNCLASSIFIED_FLOW_KEY;
    clientTotals[key] = (clientTotals[key] ?? 0) + Math.abs(c.amount);
  }

  // What the SERVER does: group by (flowType, currency, date) split by sign, sum,
  // then convert each group once at its own date.
  const grouped = new Map<string, AggregateGroup>();
  for (const r of rows) {
    const sign = r.amount > 0 ? "+" : "-";
    const key = `${r.flowType}|${r.currency}|${r.date}|${sign}`;
    const g = grouped.get(key)
      ?? { flowType: r.flowType, currency: r.currency, date: r.date, sum: 0 };
    g.sum = (g.sum ?? 0) + r.amount;
    grouped.set(key, g);
  }
  const agg = foldAggregateGroups([...grouped.values()], rows.length, MULTI);

  for (const key of Object.keys(clientTotals)) {
    check(`${key}: fold matches per-row conversion exactly (${clientTotals[key].toFixed(4)})`,
      near(agg.totalsByFlowType[key], clientTotals[key]));
  }
  check("no extra flow-type keys appear",
    Object.keys(agg.totalsByFlowType).sort().join() === Object.keys(clientTotals).sort().join());

  // Tripwire for the date-collapsing mistake: if the fold converted a whole-currency
  // total at ONE date, EUR SPENDING would be (100+50+100)*rate(one date) — assert the
  // real figure differs from both single-rate collapses.
  const eurSpend = (100 + 50 + 100);
  check("date-collapsed conversion would differ (proves per-date conversion happened)",
    !near(agg.totalsByFlowType.SPENDING, eurSpend * 1.1 + 25)
    && !near(agg.totalsByFlowType.SPENDING, eurSpend * 1.5 + 25));
}

console.log("FOLD — honesty flags and edge cases");
{
  const missGroups: AggregateGroup[] = [
    { flowType: "SPENDING", currency: "JPY", date: "2026-06-01", sum: -1000 }, // no rate
  ];
  check("a rate miss marks the aggregate estimated",
    foldAggregateGroups(missGroups, 1, MULTI).estimated === true);

  const nullCurrency: AggregateGroup[] = [
    { flowType: "SPENDING", currency: null, date: "2026-06-01", sum: -10 }, // Phase 0 residue
  ];
  check("null-currency residue marks the aggregate estimated",
    foldAggregateGroups(nullCurrency, 1, MULTI).estimated === true);

  check("null sums are skipped, not counted as zero-crash",
    foldAggregateGroups([{ flowType: "SPENDING", currency: "USD", date: "2026-06-01", sum: null }], 0, USD)
      .totalsByFlowType.SPENDING === undefined);
  check("zero sums contribute nothing",
    foldAggregateGroups([{ flowType: "SPENDING", currency: "USD", date: "2026-06-01", sum: 0 }], 0, USD)
      .totalsByFlowType.SPENDING === undefined);
  check("empty groups → empty totals, count preserved", (() => {
    const a = foldAggregateGroups([], 0, USD);
    return a.count === 0 && Object.keys(a.totalsByFlowType).length === 0 && a.estimated === false;
  })());
  check("null flowType folds into the unclassified key",
    foldAggregateGroups([{ flowType: null, currency: "USD", date: "2026-06-01", sum: -5 }], 1, USD)
      .totalsByFlowType[UNCLASSIFIED_FLOW_KEY] === 5);
}

console.log("CONVERSION KEYS — prefetch exactly what the fold will convert");
{
  const groups: AggregateGroup[] = [
    { flowType: "SPENDING", currency: "EUR", date: "2026-06-01", sum: -100 },
    { flowType: "INCOME",   currency: "EUR", date: "2026-06-01", sum: 200 }, // same pair
    { flowType: "SPENDING", currency: "USD", date: "2026-06-02", sum: -1 },
    { flowType: "SPENDING", currency: "GBP", date: "2026-06-03", sum: null }, // skipped
  ];
  const keys = conversionKeysFor(groups);
  check("distinct currencies only (nulls preserved, skipped groups excluded)",
    keys.currencies.length === 2 && keys.currencies.includes("EUR") && keys.currencies.includes("USD"));
  check("distinct dates only", keys.dates.length === 2 && !keys.dates.includes("2026-06-03"));
}

if (failures > 0) { console.error(`\ntransaction-aggregate-core: ${failures} failure(s).`); process.exit(1); }
console.log("\ntransaction-aggregate-core: all passed.");
