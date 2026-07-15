/**
 * lib/ai/assemblers/transactions.population.test.ts
 *
 * P2-7B — AI banking-population convergence gate (pure, no DB).
 *
 * The assembler's per-assembler `BANKING_FLOWS` allow-list (which excluded
 * UNKNOWN / ADJUSTMENT) was retired in favour of the canonical banking
 * population (`flowType: { not: INVESTMENT }`, incl. UNKNOWN / ADJUSTMENT /
 * null). Admitting those rows is a VISIBILITY change, never an economics one:
 * they must be COUNTED (transactionCount) but NEVER fold into any money total or
 * category sum (doctrine: an ADJUSTMENT is not spending, an UNKNOWN is not
 * income). This gate pins that over the exported pure seam buildMonthlyBreakdown
 * and source-scans the assembler so the retired allow-list can't creep back.
 *
 * NOTE: importing the assembler transitively constructs the Prisma client — pure
 * fixtures only, no query is issued (same note as the golden / kd17 suites).
 */

import { buildMonthlyBreakdown } from "./transactions";
import { isNonEconomicResidue, isAdjustment, isBankingPopulation } from "@/lib/transactions/flow-predicates";
import { readFileSync } from "node:fs";
import path from "node:path";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function row(dateISO: string, amount: number, flowType: string | null, category: string): any {
  return { date: new Date(`${dateISO}T00:00:00Z`), amount, currency: "USD", category, flowType };
}

// ── Predicate partition: residue ⊂ banking population, disjoint from economics ──
{
  check("residue predicate: UNKNOWN / ADJUSTMENT / null are non-economic residue",
    isNonEconomicResidue("UNKNOWN") && isNonEconomicResidue("ADJUSTMENT") && isNonEconomicResidue(null));
  check("residue predicate: the 7 economic flows are NOT residue",
    ["SPENDING", "REFUND", "INCOME", "DEBT_PAYMENT", "TRANSFER", "FEE", "INTEREST"]
      .every((f) => !isNonEconomicResidue(f)));
  check("residue is INSIDE the banking population (visible for review, not dropped)",
    isBankingPopulation("UNKNOWN") && isBankingPopulation("ADJUSTMENT") && isBankingPopulation(null));
  check("INVESTMENT is the ONLY flow outside the banking population, and is not residue",
    !isBankingPopulation("INVESTMENT") && !isNonEconomicResidue("INVESTMENT"));
  check("isAdjustment isolates only ADJUSTMENT within the residue",
    isAdjustment("ADJUSTMENT") && !isAdjustment("UNKNOWN") && !isAdjustment(null));
}

// ── buildMonthlyBreakdown: residue counted, never folded into money ────────────
{
  const settled = [
    row("2026-06-03", -100, "SPENDING", "Groceries"),
    row("2026-06-05",  200, "INCOME",   "Income"),
    row("2026-06-07",  -50, "UNKNOWN",  "Other"),      // residue — must NOT be spending
    row("2026-06-09",   -5, "ADJUSTMENT", "Other"),    // residue — must NOT be spending
    row("2026-06-11",   -7, null,        "Shopping"),  // residue (null flow) — must NOT be spending
  ];
  const m = buildMonthlyBreakdown(settled, [], "2026-06-01", "2026-06-30", null);
  const june = m.find((x) => x.month === "2026-06");

  check("monthly: month present", june !== undefined);
  check("monthly: expenseTotal = 100 (SPENDING only; UNKNOWN/ADJUSTMENT/null excluded)",
    june?.expenseTotal === 100, JSON.stringify(june));
  check("monthly: incomeTotal = 200 (residue never counted as income)", june?.incomeTotal === 200);
  check("monthly: transactionCount = 5 (ALL rows counted, residue never dropped)", june?.transactionCount === 5);

  // byCategory is debit-only: the residue rows carry categories Other/Shopping.
  // Neither may appear with a spending total — the residue was skipped before the
  // category fold, so 'Other' (UNKNOWN+ADJUSTMENT) and the null-flow 'Shopping'
  // contribute ZERO category spend.
  const cats = new Map((june?.byCategory ?? []).map((c) => [c.category, c.total]));
  check("monthly: only the real SPENDING category has a total (Groceries=100)",
    cats.get("Groceries") === 100);
  check("monthly: residue category 'Other' (UNKNOWN+ADJUSTMENT) has NO spending total",
    !cats.has("Other"));
  check("monthly: null-flow 'Shopping' has NO spending total", !cats.has("Shopping"));

  // Reconciliation: Σ byCategory debit totals == expenseTotal (KD-17 population).
  const catSum = (june?.byCategory ?? []).reduce((s, c) => s + c.total, 0);
  check("monthly: Σ byCategory == expenseTotal (residue never inflates a category)", catSum === june?.expenseTotal);
}

// ── All-economic month is unchanged by the gate (no residue → byte-identical) ──
{
  const settled = [
    row("2026-05-03", -120, "SPENDING", "Food"),
    row("2026-05-10", 2500, "INCOME",   "Income"),
    row("2026-05-12", -300, "DEBT_PAYMENT", "Payment"),
    row("2026-05-14",   45, "REFUND",   "Shopping"),
    row("2026-05-20",  -80, "TRANSFER", "Transfer"),
  ];
  const m = buildMonthlyBreakdown(settled, [], "2026-05-01", "2026-05-31", null);
  const may = m.find((x) => x.month === "2026-05");
  check("no-residue month: expenseTotal = 120, income 2500, debt 300, refund 45, transfer 80 (unchanged)",
    may?.expenseTotal === 120 && may?.incomeTotal === 2500 && may?.debtPaymentTotal === 300 &&
    may?.refundTotal === 45 && may?.transferTotal === 80, JSON.stringify(may));
  check("no-residue month: transactionCount = 5", may?.transactionCount === 5);
}

// ── Source-scan guard: the retired allow-list must not creep back ──────────────
{
  const src = readFileSync(path.join(process.cwd(), "lib", "ai", "assemblers", "transactions.ts"), "utf8");
  check("guard: no `const BANKING_FLOWS: FlowType[]` population allow-list in the assembler",
    !/const\s+BANKING_FLOWS\s*:/.test(src),
    "P2-7B retired it — use the canonical BANKING_POPULATION (`not: INVESTMENT`) instead");
  check("guard: assembler consumes the canonical banking population (`not: FlowType.INVESTMENT`)",
    /flowType:\s*\{\s*not:\s*FlowType\.INVESTMENT\s*\}/.test(src));
  check("guard: money folds gate on isNonEconomicResidue (canonical predicate, not a local set)",
    /isNonEconomicResidue/.test(src));
}

if (failures.length > 0) {
  console.error(`\nP2-7B population convergence: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`P2-7B population convergence: all ${passed} checks passed.`);
process.exit(0);
