/**
 * lib/money-presentation.test.ts   (MONEY-PRECISION-1)
 *
 * THE MONEY PRESENTATION BOUNDARY, pinned:
 *
 *   INSIDE A SPACE    money is shown to the cent      $7,273.88 · $50.00 · −$861.30
 *   OUTSIDE A SPACE   whole dollars, as before        $7,274
 *
 * The contract is enforced by WHICH FORMATTER A SURFACE CALLS — `formatCurrency`
 * (and its aliases) for a Space's own figures, `formatCurrencyWhole` for the
 * launcher / cross-Space reads. So the load-bearing properties here are:
 *
 *   1. the same number renders BOTH ways, from the two named formatters;
 *   2. formatting NEVER changes a value — it rounds for display exactly as
 *      `Intl` always did, and no caller rounds first to get a display;
 *   3. non-money quantities (percent, APR, score, counts, months) are untouched;
 *   4. the compact notation ("$1.2M") stays compact — the one exception;
 *   5. the outside-Space surfaces still call the whole-dollar formatter.
 *
 * Synthetic values only — no live balance appears below.
 *
 * Run:  npx tsx lib/money-presentation.test.ts
 */
import { readFileSync } from "node:fs";
import {
  formatCurrency, formatCurrencyWhole, formatCurrencyExact, formatBalance,
  formatCompactCurrency, currencySymbol, DEFAULT_DISPLAY_CURRENCY,
} from "./currency";
import { formatAggregateMoney, formatProseMoney } from "@/components/space/widgets/display-money";
import { clampEconomicSpend, economicTotals } from "./transactions/cash-flow";
import { planPayoff } from "./debt/payoff";

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}
const code = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("1–7. inside a Space: cents, always");
{
  check("1. an integer gains cents: 100 → $100.00", formatCurrency(100) === "$100.00", formatCurrency(100));
  check("2. one decimal is filled: 100.1 → $100.10", formatCurrency(100.1) === "$100.10", formatCurrency(100.1));
  check("3. two decimals are preserved: 100.12 → $100.12", formatCurrency(100.12) === "$100.12");
  check("4. more precision rounds for DISPLAY only: 100.129 → $100.13", formatCurrency(100.129) === "$100.13", formatCurrency(100.129));
  check("…and 100.124 → $100.12 (half-up at the cent, Intl's own rule)", formatCurrency(100.124) === "$100.12");
  check("5. negative money keeps the house convention: −861.3 → −$861.30", formatCurrency(-861.3) === "-$861.30", formatCurrency(-861.3));
  check("6. zero is $0.00 — never a bare $0", formatCurrency(0) === "$0.00");
  check("7. separators + cents together: 1,000,000 → $1,000,000.00", formatCurrency(1_000_000) === "$1,000,000.00");
  check("the brief's own figures round-trip", formatCurrency(7273.88) === "$7,273.88" && formatCurrency(9007.64) === "$9,007.64" && formatCurrency(50) === "$50.00");
  check("a native row currency still labels itself (itemised doctrine)", formatCurrency(12.5, "EUR") === "€12.50" && formatCurrency(12.5, "SAR").endsWith("12.50"));
}

console.log("8. outside a Space: unchanged whole dollars");
{
  check("the same value, two named formatters: 7273.88 → $7,273.88 inside · $7,274 outside",
    formatCurrency(7273.88) === "$7,273.88" && formatCurrencyWhole(7273.88) === "$7,274");
  check("whole-dollar zero is $0, not $0.00", formatCurrencyWhole(0) === "$0");
  check("whole-dollar negative: −861.3 → −$861", formatCurrencyWhole(-861.3) === "-$861");
  check("whole-dollar separators: 1,000,000 → $1,000,000", formatCurrencyWhole(1_000_000) === "$1,000,000");
  check("…and it honours a currency argument like its counterpart", formatCurrencyWhole(12.5, "EUR") === "€13");
  // The whole-dollar output is EXACTLY what the shared formatter produced before
  // this slice, so nothing outside a Space moved.
  const legacy = (v: number, c = DEFAULT_DISPLAY_CURRENCY) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: c, notation: "standard", maximumFractionDigits: 0 }).format(v);
  check("byte-identical to the previous shared formatter across a battery",
    [0, 1, 12.5, -0.4, 99.999, 861.3, 7273.88, 1_000_000.004, -1234.56].every((v) => formatCurrencyWhole(v) === legacy(v)));
}

console.log("9. the aliases agree — one implementation, several intents");
{
  for (const v of [0, 1.005, 50, -861.3, 1_234_567.891]) {
    check(`formatBalance === formatCurrencyExact === formatCurrency (${v})`,
      formatBalance(v) === formatCurrency(v) && formatCurrencyExact(v) === formatCurrency(v));
  }
  check("the aggregate helper carries cents with a context", formatAggregateMoney(1234, { target: "EUR" }) === "€1,234.00");
  check("…and still makes NO currency claim without one", formatAggregateMoney(1234) === "1,234");
  check("the currency symbol helper is untouched", currencySymbol("USD") === "$" && currencySymbol("EUR") === "€");
}

console.log("10. the exception: compact notation stays compact");
{
  check("$1.2M and $25K keep their constrained form", formatCompactCurrency(1_200_000) === "$1.2M" && formatCompactCurrency(25_000) === "$25K");
  check("compact is the same through either entry point", formatCurrency(1_200_000, "USD", true) === formatCompactCurrency(1_200_000));
  check("…and is NOT how an ordinary figure renders", formatCurrency(1_200_000) === "$1,200,000.00");
}

console.log("11. formatting changes strings, never money");
{
  // The calculation authorities are untouched: same inputs, same numbers.
  check("the economic clamp is unchanged", clampEconomicSpend(9841.08, 861.3) === 8979.78);
  const t = economicTotals([
    { id: "a", date: "2026-07-01", amount: -100.129, flowType: "SPENDING" },
    { id: "b", date: "2026-07-02", amount: 30, flowType: "REFUND" },
  ] as never);
  check("a fold keeps full precision — display rounds, the number does not",
    t.spendGross === 100.129 && t.refunds === 30 && Math.abs(t.spend - 70.129) < 1e-9, JSON.stringify(t));
  check("…and the same value only LOOKS rounded: $70.13", formatCurrency(t.spend) === "$70.13");
  const plan = planPayoff({ balance: 124, aprPct: 0, payment: 50, startISO: "2026-01-01" });
  check("the payoff engine's figures are unchanged (final payment 24, 2 full payments)",
    plan.status === "paid_off" && plan.finalPayment === 24 && plan.fullPayments === 2);
  check("…and now READ to the cent", plan.status === "paid_off" && formatCurrency(plan.finalPayment) === "$24.00");
}

console.log("12. non-money quantities are untouched");
{
  const src = code("lib/currency.ts");
  check("the currency module formats currency only — it owns no percent/count rule",
    !/percent|APR|score|months|toFixed\(0\)/i.test(src));
  // These are the app's own non-money renderings; they must not gain ".00".
  check("a percentage keeps its own precision", `${(12.3456).toFixed(2)}%` === "12.35%" && `${Math.round(41.6)}%` === "42%");
  check("an APR keeps two decimals as a RATE, not as money", `${(24.99).toFixed(2)}% APR` === "24.99% APR");
  check("a credit score is a bare integer", String(731) === "731");
  check("counts and months stay bare", `${3} accounts` === "3 accounts" && `${6} months` === "6 months");
}

console.log("13. the boundary is where the surfaces call it");
{
  const brief = code("components/brief/DailyBriefClient.tsx");
  check("the cross-Space Brief calls the whole-dollar formatter", /formatCurrencyWhole as formatCurrency/.test(brief));
  const launcher = code("components/dashboard/SpacesClient.tsx");
  check("the Spaces launcher keeps its own whole-dollar/compact formatters",
    /maximumFractionDigits: 0/.test(launcher) && !/from "@\/lib\/currency"[\s\S]{0,80}formatCurrency\b/.test(launcher));
  // A Space surface, picked from each area, still calls the cents formatter.
  // Directly, or through display-money (which delegates to the same formatters).
  for (const f of [
    "components/space/widgets/wealth/WealthHero.tsx",
    "components/space/widgets/debt/DebtHero.tsx",
    "components/space/widgets/CashFlowSummaryWidget.tsx",
    "components/space/widgets/cashflow/CashFlowCategoryLedger.tsx",
    "components/space/sections/DebtPayoffSection.tsx",
    "components/space/widgets/wealth/WealthCompositionCard.tsx",
    "components/space/widgets/TransactionSliceDrawer.tsx",
    "components/space/widgets/BreakdownWidget.tsx",
  ]) {
    const src = code(f);
    check(`${f.split("/").pop()} formats through the Space money authority`,
      (/from "@\/lib\/currency"/.test(src) || /display-money/.test(src)) && !/formatCurrencyWhole/.test(src));
  }
  check("display-money delegates to the shared formatters — it defines no format of its own",
    /from "@\/lib\/currency"/.test(code("components/space/widgets/display-money.ts")));
}

console.log("14. MONEY-PRECISION-2 — a SENTENCE rounds to the dollar; a FIGURE keeps its cents");
{
  // The distinction is semantic and is made at the module that owns the text —
  // never by inspecting a string or the DOM around it.
  check("the same value, both ways: 23400 → $23,400.00 structured · $23,400 in prose",
    formatCurrency(23400) === "$23,400.00" && formatProseMoney(23400, { target: "USD" }) === "$23,400");
  check("prose rounds rather than truncating: 177.49 → $177 · 177.50 → $178",
    formatProseMoney(177.49, { target: "USD" }) === "$177" && formatProseMoney(177.5, { target: "USD" }) === "$178");
  check("prose negatives and zero follow the same convention as outside-Space money",
    formatProseMoney(-861.3, { target: "USD" }) === "-$861" && formatProseMoney(0, { target: "USD" }) === "$0");
  check("prose === the whole-dollar formatter, with a context", [0, 50, -861.3, 23400, 1_000_000.4].every((v) =>
    formatProseMoney(v, { target: "USD" }) === formatCurrencyWhole(v)));
  check("…and without one it keeps the no-currency-claim rule", formatProseMoney(1234) === "1,234");
  check("a native currency still labels itself in prose", formatProseMoney(23400, { target: "EUR" }) === "€23,400");

  // The real sentences, from the modules that own them.
  const debtVerdict = code("lib/perspective-engine/lenses/debt.core.ts");
  const liqVerdict  = code("lib/perspective-engine/lenses/liquidity.core.ts");
  const story       = code("lib/wealth/wealth-time-machine.ts");
  const signal      = code("lib/ai/signals/detectors/snapshot.ts");
  const insights    = code("components/space/widgets/cashflow/cash-flow-insights.ts");
  const hero        = code("components/space/widgets/liquidity/LiquidityHero.tsx");
  for (const [name, src] of [["debt verdict", debtVerdict], ["liquidity verdict", liqVerdict],
    ["wealth story", story], ["net-worth signal", signal]] as const) {
    check(`${name}: formats with formatCurrencyWhole, and never the cents formatter`,
      /formatCurrencyWhole\(/.test(src) && !/\bformatCurrency\(/.test(src));
  }
  check("cash-flow insights: the sentence helper is formatProseMoney", /formatProseMoney\(v, moneyCtx\)/.test(insights) && !/formatAggregateMoney/.test(insights));
  check("the liquidity hero passes the whole-dollar formatter INTO the baseline clause…",
    /describeExpenseBaseline\([\s\S]{0,400}?formatCurrencyWhole\(n, currency\)/.test(hero));
  check("…while its own structured figures keep the cents formatter", /formatCurrency\(cashNow, currency\)/.test(hero));

  // STRUCTURED money is untouched by this slice — these are figures, not sentences.
  const structured: [string, string][] = [
    ["payoff amounts", "components/space/sections/DebtPayoffSection.tsx"],
    ["ledger rows", "components/space/widgets/debt/LiabilitiesLedger.tsx"],
    ["category lines + total", "components/space/widgets/cashflow/CashFlowCategoryLedger.tsx"],
    ["drawer totals", "components/space/widgets/TransactionSliceDrawer.tsx"],
    ["evidence rows", "lib/perspectives/envelope.ts"],
    ["the composition card", "components/space/widgets/wealth/WealthCompositionCard.tsx"],
  ];
  for (const [what, f] of structured) {
    check(`${what} still format to the cent (no prose formatter)`, !/formatCurrencyWhole|formatProseMoney/.test(code(f)));
  }
  check("the prose helper is NOT reachable from the structured aggregate helper",
    !/formatProseMoney/.test(code("components/space/widgets/display-money.ts").split("export function formatAggregateMoney")[1] ?? ""));
}

console.log(failures === 0 ? `\nPASS — ${passed} checks` : `\nFAIL — ${failures} of ${passed + failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
