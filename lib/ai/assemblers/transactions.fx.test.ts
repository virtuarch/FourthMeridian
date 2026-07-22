/**
 * lib/ai/assemblers/transactions.fx.test.ts
 *
 * P2-7C — multi-currency reporting-currency convergence for the AI transaction
 * assembler's canonicalized rollups. The top-level totals (incomeTotal /
 * expenseTotal / byCategory / monthlyBreakdown) already converted every row
 * per-row at its own date into the Space reporting currency; the merchant,
 * income-source, and recurring rollups did NOT — they summed native
 * `txn.amount`, so for a multi-currency Space a merchant total was a
 * native-currency sum shown beside a converted expenseTotal.
 *
 * These gates pin the fix over the pure exported seams (no DB):
 *   - all-USD / identity context → byte-identical to the pre-fix native sums.
 *   - mixed USD+EUR+AED → totals reconcile in ONE reporting currency, converted
 *     per-row at each row's OWN date (historical FX by date).
 *   - same nominal amount, different currency → different converted totals.
 *   - missing FX → UNAVAILABLE: excluded to 0 + `estimated: true` (V25-FINAL-1 —
 *     the native magnitude is never summed into a reporting-currency total as
 *     though it had been converted).
 *   - ordering is by CONVERTED magnitude (a small-native / high-rate row can
 *     outrank a large-native / low-rate one; an unavailable row sinks to 0).
 *
 * Harness mirrors transactions.golden.test.ts (plain tsx, no test runner).
 * NOTE: importing the assembler transitively constructs the Prisma client —
 * pure fixtures only, no query is issued.
 */

import {
  buildMerchantRollup,
  buildIncomeSourceRollup,
  buildRecurringCandidates,
  type RollupRow,
} from "./transactions";
import { identityContext } from "@/lib/money/convert";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import type { ConversionContext } from "@/lib/money/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const IDENTITY = identityContext(DEFAULT_DISPLAY_CURRENCY);

/**
 * Reporting currency = USD. EUR converts at a DATE-DEPENDENT rate (1.20 before
 * 2026-06-15, 1.10 on/after) so we exercise "historical FX by row date"; AED is
 * a flat 0.27; every other currency (e.g. SAR) MISSES → UNAVAILABLE: excluded to
 * 0 + estimated (V25-FINAL-1, superseding D-3's native pass-through).
 */
const usdCtx: ConversionContext = {
  target: "USD",
  resolve: (from, dateISO) => {
    if (from === "EUR") {
      const rate = dateISO >= "2026-06-15" ? 1.10 : 1.20;
      return { kind: "rate", rate, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" };
    }
    if (from === "AED") {
      return { kind: "rate", rate: 0.27, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" };
    }
    return { kind: "miss", quote: from, requestedDateISO: dateISO };
  },
};

function row(
  merchant: string,
  amount: number,
  currency: string | null,
  dateISO: string,
  flowType: RollupRow["flowType"],
  category = "Shopping",
): RollupRow {
  return {
    merchant,
    category,
    amount,
    currency,
    date: new Date(`${dateISO}T00:00:00Z`),
    flowType: flowType,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Merchant rollup ───────────────────────────────────────────────────────────

{
  // Amazon appears twice: USD 100 (→100) + EUR 100 @1.20 (→120) = 220 exact.
  // Ikea: EUR 100 @1.10 (later date → different historical rate) = 110.
  // Carrefour: AED 1000 @0.27 = 270 (native 1000 would have dwarfed everything).
  // Souq: SAR 500 → MISS → UNAVAILABLE, excluded to 0 + estimated (V25-FINAL-1:
  // the native 500 must never be summed into a USD total as though converted).
  const spend: RollupRow[] = [
    row("Amazon",    -100, "USD", "2026-06-10", "SPENDING"),
    row("Amazon",    -100, "EUR", "2026-06-10", "SPENDING"),
    row("Ikea",      -100, "EUR", "2026-06-20", "SPENDING"),
    row("Carrefour", -1000, "AED", "2026-06-10", "SPENDING"),
    row("Souq",      -500, "SAR", "2026-06-10", "SPENDING"),
    // Non-spending rows must NOT surface as merchants.
    row("Payroll",    5000, "USD", "2026-06-10", "INCOME", "Income"),
    row("Move",      -200, "USD", "2026-06-10", "TRANSFER", "Transfer"),
  ];
  const m = buildMerchantRollup(spend, usdCtx, 25);
  const by = new Map(m.map((x) => [x.canonicalName, x]));

  check("merchant: Amazon total = 100 + 120 = 220 (per-row converted)", by.get("Amazon")?.total === 220);
  check("merchant: Amazon exact ⇒ no estimated flag", by.get("Amazon")?.estimated === undefined);
  check("merchant: Ikea EUR @1.10 (date ≥ 06-15) = 110 (historical FX by date)", by.get("Ikea")?.total === 110);
  check("merchant: Carrefour AED 1000 @0.27 = 270", by.get("Carrefour")?.total === 270);
  check("merchant: Souq SAR missing rate ⇒ excluded to 0 + estimated (not native 500)", by.get("Souq")?.total === 0 && by.get("Souq")?.estimated === true);
  check("merchant: payroll/transfer never surface as spending merchants", !by.has("Payroll") && !by.has("Move"));

  // Ordering is by CONVERTED magnitude: Carrefour(270) > Amazon(220) > Ikea(110) > Souq(0, excluded).
  check("merchant: ranked by converted total; the unavailable row sinks to 0 (never native-inflated)",
    m.map((x) => x.canonicalName).join(",") === "Carrefour,Amazon,Ikea,Souq",
    m.map((x) => `${x.canonicalName}:${x.total}`).join(" "));
}

// ── Same nominal amount, different currency → different converted totals ───────

{
  const spend: RollupRow[] = [
    row("UsdShop", -100, "USD", "2026-06-10", "SPENDING"),
    row("EurShop", -100, "EUR", "2026-06-10", "SPENDING"), // @1.20
  ];
  const m = buildMerchantRollup(spend, usdCtx, 25);
  const by = new Map(m.map((x) => [x.canonicalName, x]));
  check("same-nominal: 100 USD → 100, 100 EUR → 120 (never treated as parity)",
    by.get("UsdShop")?.total === 100 && by.get("EurShop")?.total === 120);
}

// ── Income-source rollup ──────────────────────────────────────────────────────

{
  const inflow: RollupRow[] = [
    row("Acme",       2000, "USD", "2026-06-10", "INCOME", "Income"),
    row("Acme",       1000, "EUR", "2026-06-10", "INCOME", "Income"), // @1.20 → 1200 (Acme = 3200)
    row("Dividends",  1000, "AED", "2026-06-10", "INCOME", "Income"), // @0.27 → 270
    row("Mystery",     100, "SAR", "2026-06-10", "INCOME", "Income"), // miss → excluded to 0 + estimated
    // A negative INCOME row (refunded payroll) must be excluded (sign gate).
    row("Acme",       -50, "USD", "2026-06-10", "INCOME", "Income"),
    // Spending rows never appear as income sources.
    row("Amazon",     -80, "USD", "2026-06-10", "SPENDING"),
  ];
  const s = buildIncomeSourceRollup(inflow, usdCtx, 25);
  const by = new Map(s.map((x) => [x.canonicalName, x]));

  check("income: Acme = 2000 + 1200 = 3200 (per-row converted, negative excluded)", by.get("Acme")?.total === 3200);
  check("income: Dividends AED = 270", by.get("Dividends")?.total === 270);
  check("income: Mystery SAR missing ⇒ excluded to 0 + estimated (not native 100)", by.get("Mystery")?.total === 0 && by.get("Mystery")?.estimated === true);
  check("income: spending merchant never appears as income source", !by.has("Amazon"));
  check("income: ranked by converted total (Acme > Dividends > Mystery)",
    s.map((x) => x.canonicalName).join(",") === "Acme,Dividends,Mystery");
}

// ── Recurring candidates: typicalAmount converted per-row before averaging ─────

{
  const spend: RollupRow[] = [
    // Netflix twice in EUR at DIFFERENT dates → different historical rates:
    // 15 @1.20 = 18, 15 @1.10 = 16.5 → mean = 17.25 (signed negative).
    row("Netflix", -15, "EUR", "2026-06-10", "SPENDING", "Subscriptions"),
    row("Netflix", -15, "EUR", "2026-06-20", "SPENDING", "Subscriptions"),
    // Spotify: one USD exact + one SAR miss → estimated propagates.
    row("Spotify", -10, "USD", "2026-06-10", "SPENDING", "Subscriptions"),
    row("Spotify", -10, "SAR", "2026-06-10", "SPENDING", "Subscriptions"),
    // Single-occurrence merchant is not a recurring candidate.
    row("OneOff",  -99, "USD", "2026-06-10", "SPENDING"),
  ];
  const r = buildRecurringCandidates(spend, usdCtx);
  const by = new Map(r.map((x) => [x.merchant, x]));

  check("recurring: Netflix typicalAmount = mean(-18, -16.5) = -17.25 (converted, historical)", by.get("netflix")?.typicalAmount === -17.25);
  check("recurring: Netflix exact ⇒ no estimated flag", by.get("netflix")?.estimated === undefined);
  check("recurring: Spotify has a missing-rate leg ⇒ estimated", by.get("spotify")?.estimated === true);
  check("recurring: single-occurrence merchant excluded", !by.has("oneoff"));
}

// ── All-USD / identity context is byte-identical to native sums (kill switch) ──

{
  const spend: RollupRow[] = [
    row("Amazon", -100, "USD", "2026-06-10", "SPENDING"),
    row("Amazon", -50,  "USD", "2026-06-11", "SPENDING"),
    row("Ikea",   -200, "USD", "2026-06-12", "SPENDING"),
  ];
  const m = buildMerchantRollup(spend, IDENTITY, 25);
  const by = new Map(m.map((x) => [x.canonicalName, x]));
  check("all-USD merchant: Amazon = |−100| + |−50| = 150, no estimated", by.get("Amazon")?.total === 150 && by.get("Amazon")?.estimated === undefined);
  check("all-USD merchant: Ikea = 200", by.get("Ikea")?.total === 200);

  const inflow: RollupRow[] = [
    row("Acme", 2000, "USD", "2026-06-10", "INCOME", "Income"),
    row("Acme", 1500, "USD", "2026-06-20", "INCOME", "Income"),
  ];
  const s = buildIncomeSourceRollup(inflow, IDENTITY, 25);
  check("all-USD income: Acme = 3500, no estimated", s[0]?.total === 3500 && s[0]?.estimated === undefined);

  // Reconciliation: Σ merchant totals == Σ|converted spend| for these rows.
  const merchantSum = round2(m.reduce((acc, x) => acc + x.total, 0));
  check("all-USD reconcile: Σ merchant totals == 350", merchantSum === 350);
}

// ── Cross-rollup reconciliation in ONE reporting currency (mixed) ─────────────

{
  // The merchant rollup's Σ total must equal the same population's per-row
  // converted Σ|amount| — proving the rollup and any headline expense figure
  // over the same rows share one currency basis.
  const spend: RollupRow[] = [
    row("A", -100, "USD", "2026-06-10", "SPENDING"),
    row("B", -100, "EUR", "2026-06-10", "SPENDING"), // 120
    row("C", -1000, "AED", "2026-06-10", "SPENDING"), // 270
  ];
  const m = buildMerchantRollup(spend, usdCtx, 25);
  const rollupSum = round2(m.reduce((acc, x) => acc + x.total, 0));
  const expected = round2(100 + 120 + 270);
  check("mixed reconcile: Σ merchant totals == Σ per-row converted spend (490)", rollupSum === expected, `${rollupSum} vs ${expected}`);
}

if (failures.length > 0) {
  console.error(`\nP2-7C FX rollup convergence: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`P2-7C FX rollup convergence: all ${passed} checks passed.`);
process.exit(0);
