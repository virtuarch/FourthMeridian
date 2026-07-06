/**
 * lib/perspective-engine/debt.mc1.test.ts
 *
 * MC1 QA Q2 — debt-lens conversion equivalence gates, mirroring the
 * liquidity gates (liquidity.mc1.test.ts): context-less kill switch,
 * all-USD identity, non-USD conversion (balances + minimum payments;
 * APRs are rates and never convert), miss ⇒ native + estimated, verdict
 * labels follow the context target. Pure fixtures — no DB, no network.
 */

import { computeDebt, type DebtAccountRow } from "./lenses/debt.core";
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
const CLOSE = minusDaysISO(toISODateUTC(NOW), 1);
const CTX = identityContext(DEFAULT_DISPLAY_CURRENCY);

const row = (id: string, balance: number, extra: Partial<DebtAccountRow> = {}): DebtAccountRow => ({
  id, type: "debt", balance,
  currency: "USD",
  lastUpdated: "2026-07-04T00:00:00Z",
  visibilityLevel: "FULL",
  ...extra,
});

const metric = (r: ReturnType<typeof computeDebt>, id: string) =>
  r.metrics.find((m) => m.id === id)?.value;

const usdRows: DebtAccountRow[] = [
  row("a", 5000, { interestRate: 24, minimumPayment: 150 }),
  row("b", 2000, { interestRate: 12 }),
  row("c", 800 ),
];

// ── kill switch: context-less byte-identical shape (no estimated field) ──────
{
  const r = computeDebt(scope, options, usdRows);
  check("kill switch: no estimated field without a context", !("estimated" in r));
  check("kill switch: totalDebt raw sum intact", metric(r, "totalDebt") === 7800);
}

// ── all-USD through identity: numerically identical, estimated false ─────────
{
  const a = computeDebt(scope, options, usdRows);
  const b = computeDebt(scope, options, usdRows, CTX);
  check("all-USD: totalDebt identical", metric(a, "totalDebt") === metric(b, "totalDebt"));
  check("all-USD: monthlyInterest identical", metric(a, "monthlyInterest") === metric(b, "monthlyInterest"));
  check("all-USD: minPayments identical", metric(a, "minPayments") === metric(b, "minPayments"));
  check("all-USD: verdict identical", a.verdict === b.verdict);
  check("all-USD: estimated false", b.estimated === false);
}

// ── non-USD conversion: balances + min payments convert; APRs never do ───────
{
  const realCtx: ConversionContext = {
    target: "USD",
    resolve: (from, dateISO) =>
      from === "EUR" && dateISO === CLOSE
        ? { kind: "rate", rate: 1.25, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
        : { kind: "miss", quote: from, requestedDateISO: dateISO },
  };
  const rows: DebtAccountRow[] = [
    row("eur", 1000, { currency: "EUR", interestRate: 12, minimumPayment: 100 }),
    row("usd", 500,  { interestRate: 12 }),
  ];
  const r = computeDebt(scope, options, rows, realCtx);
  check("non-USD: totalDebt converts (1000×1.25 + 500 = 1750)", metric(r, "totalDebt") === 1750);
  check("non-USD: monthlyInterest converts via converted balance ((1250+500)×0.01 = 17.5)",
    Math.abs(Number(metric(r, "monthlyInterest")) - 17.5) < 1e-9);
  check("non-USD: minPayments convert (100×1.25 = 125)", metric(r, "minPayments") === 125);
  check("non-USD: exact rates ⇒ estimated false", r.estimated === false);

  // miss ⇒ native + estimated
  const missRows = [row("sar", 1000, { currency: "SAR" })];
  const m = computeDebt(scope, options, missRows, realCtx);
  check("miss: native amount kept (D-3)", metric(m, "totalDebt") === 1000);
  check("miss: estimated true", m.estimated === true);
}

// ── verdict labels follow the context target ─────────────────────────────────
{
  const eurCtx = identityContext("EUR");
  const r = computeDebt(scope, options, [row("a", 1200, { currency: "EUR", interestRate: 10 })], eurCtx);
  check("verdict label: EUR-target verdict formats in €", (r.verdict ?? "").includes("€"));
  check("verdict label: no $ leaks into a EUR-target verdict", !(r.verdict ?? "").includes("$"));
  const legacy = computeDebt(scope, options, usdRows);
  check("verdict label: context-less verdict keeps the USD default", (legacy.verdict ?? "").includes("$"));
}

if (failures.length > 0) {
  console.error(`\nMC1 QA Q2 debt-lens gates: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 QA Q2 debt-lens gates: all ${passed} checks passed.`);
process.exit(0);
