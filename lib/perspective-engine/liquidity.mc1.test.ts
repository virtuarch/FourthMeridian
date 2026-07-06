/**
 * lib/perspective-engine/liquidity.mc1.test.ts
 *
 * MC1 Phase 3 Slice 5 — liquidity-lens conversion equivalence gates (F-3),
 * mirroring the classifier gates (plan D-10): context-less = byte-identical
 * kill switch; pure-USD through a real context = numerically identical with
 * estimated:false; non-USD converts at the latest close; miss/null-residue
 * keep native amounts with estimated:true. Pure fixtures — no DB, no network.
 */

import { computeLiquidity, type LiquidityAccountRow } from "./lenses/liquidity.core";
import { identityContext } from "@/lib/money/convert";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { minusDaysISO, toISODateUTC } from "@/lib/fx/config";
import type { ConversionContext } from "@/lib/money/types";
import type { ComputeOptions, PerspectiveScope } from "./types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const NOW = new Date("2026-07-05T12:00:00Z");
const scope: PerspectiveScope = { spaceId: "s1", userId: "u1" } as PerspectiveScope;
const options: ComputeOptions = { now: () => NOW } as ComputeOptions;
const CLOSE = minusDaysISO(toISODateUTC(NOW), 1); // the valuation date the lens derives

const row = (id: string, type: string, balance: number, currency?: string | null, extra: Partial<LiquidityAccountRow> = {}): LiquidityAccountRow => ({
  id, type, balance, currency,
  lastUpdated: "2026-07-04T00:00:00Z",
  visibilityLevel: "FULL",
  ...extra,
});

const metric = (r: ReturnType<typeof computeLiquidity>, id: string) =>
  r.metrics.find((m) => m.id === id)?.value;

const usdRows: LiquidityAccountRow[] = [
  row("a", "checking",   1200.55, "USD"),
  row("b", "savings",    5000,    "USD"),
  row("c", "investment", 30000,   "USD"),
  row("d", "other",      90000,   "USD"),
  row("e", "debt",       -450,    "USD", { creditLimit: 5000 }),
];

// ── kill switch: context-less result byte-identical to pre-flip shape ────────
{
  const r = computeLiquidity(scope, options, usdRows);
  check("kill switch: no estimated field without a context", !("estimated" in r));
  check("kill switch: raw sums intact", metric(r, "cashNow") === 6200.55 && metric(r, "availableCredit") === 4550);
}

// ── pure-USD through identity/real-USD context: numerically identical ────────
{
  const withCtx = computeLiquidity(scope, options, usdRows, identityContext(DEFAULT_DISPLAY_CURRENCY));
  const without = computeLiquidity(scope, options, usdRows);
  check("all-USD: cash/marketable/illiquid/credit identical",
    metric(withCtx, "cashNow") === metric(without, "cashNow") &&
    metric(withCtx, "marketable") === metric(without, "marketable") &&
    metric(withCtx, "illiquid") === metric(without, "illiquid") &&
    metric(withCtx, "availableCredit") === metric(without, "availableCredit"));
  check("all-USD: estimated false", withCtx.estimated === false);
  check("all-USD: verdict identical", withCtx.verdict === without.verdict);
}

// ── non-USD converts at the latest close; miss/null degrade honestly ─────────
{
  const realCtx: ConversionContext = {
    target: "USD",
    resolve: (from, dateISO) =>
      from === "EUR" && dateISO === CLOSE
        ? { kind: "rate", rate: 1.25, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
        : { kind: "miss", quote: from, requestedDateISO: dateISO },
  };
  const mixed: LiquidityAccountRow[] = [
    row("a", "checking", 100,  "EUR"),               // converts: 125
    row("b", "checking", 50,   "SAR"),               // miss → native 50, estimated
    row("c", "savings",  10),                        // currency undefined → null-residue, estimated
    row("d", "debt",     -100, "EUR", { creditLimit: 1100 }), // headroom 1000 EUR → 1250 USD
  ];
  const r = computeLiquidity(scope, options, mixed, realCtx);
  check("non-USD: EUR converts at the derived close date (100×1.25 + 50 + 10 = 185)",
    metric(r, "cashNow") === 185);
  check("non-USD: credit headroom converts in native currency (1000 EUR → 1250)",
    metric(r, "availableCredit") === 1250);
  check("non-USD: miss + null-residue taint → estimated true", r.estimated === true);

  const exactOnly = computeLiquidity(scope, options, [row("a", "checking", 100, "EUR")], realCtx);
  check("non-USD: exact-only conversion → estimated false", exactOnly.estimated === false);
}

// ── QA Q1: verdict labels follow the context target ──────────────────────────
{
  // Identity context with a EUR target over EUR-native rows: values pass
  // through as EUR amounts, so the verdict's embedded formatting must be €.
  const eurCtx = identityContext("EUR");
  const r = computeLiquidity(scope, options, [row("a", "checking", 1200, "EUR")], eurCtx);
  check("verdict label: EUR-target verdict formats in €", (r.verdict ?? "").includes("€"));
  check("verdict label: no $ leaks into a EUR-target verdict", !(r.verdict ?? "").includes("$"));

  // No context ⇒ historical USD default, exactly as before (kill switch).
  const legacy = computeLiquidity(scope, options, usdRows);
  check("verdict label: context-less verdict keeps the USD default", (legacy.verdict ?? "").includes("$"));
}

// ── privacy/provenance shape untouched by the flip ────────────────────────────
{
  const r = computeLiquidity(scope, options, usdRows, identityContext("USD"));
  check("provenance: accountIds/tierCounts unchanged by conversion threading",
    r.provenance.accountIds.length === 5 && r.provenance.tierCounts.full === 5);
}

if (failures.length > 0) {
  console.error(`\nMC1 P3 liquidity gates: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P3 liquidity gates: all ${passed} checks passed.`);
process.exit(0);
