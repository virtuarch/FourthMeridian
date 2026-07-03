/**
 * scripts/kd17-audit-jan-other.ts
 *
 * KD-17 transaction-level audit — READ-ONLY diagnostic. No writes, no schema
 * changes. Safe to delete after the investigation.
 *
 * Reproduces, from raw January 2026 rows, the exact figures the AI-context
 * pipeline emits, using the same logic as lib/ai/assemblers/transactions.ts:
 *
 *   1. Space scoping     — dual-path OR (legacy account.spaceId, or
 *                          FinancialAccount via ACTIVE SpaceAccountLink with
 *                          FULL visibility), deletedAt guards, banking
 *                          categories only. Mirrors the summary query
 *                          (transactions.ts:211-244) and KD-1 predicate.
 *   2. Monthly rollup    — expenseTotal (negative non-Transfer/Payment/Income
 *                          rows), per-category signed sum → abs() at output.
 *                          Mirrors buildMonthlyBreakdown (transactions.ts:686-728).
 *   3. Drilldown total   — Other with amount < 0 only, Σ|amount|.
 *                          Mirrors assembleDrilldown (transactions.ts:854-911).
 *
 * Then lists EVERY settled January 2026 "Other" row with provenance
 * (Plaid sync / CSV import / manual) and a flow-type classification, and
 * prints a reconciliation table explaining Other ($6,529.45) vs total
 * spending ($5,848.70).
 *
 * Usage (from repo root, local dev DB from .env):
 *   npx tsx scripts/kd17-audit-jan-other.ts > docs/investigations/kd17-audit-output.md
 *
 * Optional: SPACE_ID=<id> to restrict to one Space; MONTH=YYYY-MM (default 2026-01).
 */

import { PrismaClient, TransactionCategory, VisibilityLevel, ShareStatus } from "@prisma/client";

const prisma = new PrismaClient();

const MONTH = process.env.MONTH ?? "2026-01";
const SPACE_ID = process.env.SPACE_ID;

// ── Constants mirrored from lib/ai/assemblers/transactions.ts ────────────────
const BANKING_CATEGORIES: TransactionCategory[] = [
  TransactionCategory.Income,
  TransactionCategory.Transfer,
  TransactionCategory.Groceries,
  TransactionCategory.Dining,
  TransactionCategory.Shopping,
  TransactionCategory.Travel,
  TransactionCategory.Subscriptions,
  TransactionCategory.Utilities,
  TransactionCategory.Interest,
  TransactionCategory.Payment,
  TransactionCategory.Other,
];
const INCOME_CATEGORIES = new Set<TransactionCategory>([
  TransactionCategory.Income,
  TransactionCategory.Interest,
]);
// Mirrors lib/ai/visibility.ts TRANSACTION_DETAIL_VISIBILITY (KD-1: FULL only).
const TRANSACTION_DETAIL_VISIBILITY: VisibilityLevel[] = [VisibilityLevel.FULL];
// Mirrors app/api/ai/chat/route.ts NON_SPENDING (prompt-side name filter).
const NON_SPENDING = new Set(["Income", "Interest", "Transfer", "Payment"]);

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Flow-type classification (KD-17 task 2 taxonomy) ─────────────────────────
// Category is already `Other` for the listed rows, so classification relies on
// sign + merchant/description text. Heuristic, clearly labeled as such.
type FlowType =
  | "debit" | "credit" | "refund" | "transfer" | "payment" | "income" | "fee" | "unknown";

function classifyFlow(amount: number, merchant: string, description: string | null): FlowType {
  const text = `${merchant} ${description ?? ""}`.toLowerCase();
  const has = (re: RegExp) => re.test(text);

  if (has(/\bfee\b|service charge|overdraft|nsf\b/)) return "fee";
  if (has(/refund|reversal|\breturn\b|chargeback|cash ?back reward/)) return "refund";
  if (has(/transfer|xfer|zelle|venmo|paypal.*(transfer|cashout)|wire\b|ach credit|ach debit/))
    return "transfer";
  if (has(/payment|pymt|autopay|bill ?pay|card pmt/)) return "payment";
  if (amount > 0 && has(/payroll|salary|direct dep|deposit|interest|dividend|reimburse/))
    return "income";
  if (amount < 0) return "debit";
  if (amount > 0) return "credit"; // inflow with no recognizable pattern
  return "unknown";
}

// ── Per-space audit ──────────────────────────────────────────────────────────
async function auditSpace(spaceId: string, spaceName: string): Promise<void> {
  const start = new Date(`${MONTH}-01T00:00:00.000Z`);
  const end = new Date(new Date(`${MONTH}-01T00:00:00.000Z`).setUTCMonth(start.getUTCMonth() + 1) - 1);

  // Same scoping as the AI summary query (both paths, both deletedAt guards,
  // banking categories only). Pending rows fetched too, to mirror partitioning.
  const rows = await prisma.transaction.findMany({
    where: {
      OR: [
        { account: { spaceId } },
        {
          financialAccount: {
            deletedAt: null,
            spaceAccountLinks: {
              some: {
                spaceId,
                status: ShareStatus.ACTIVE,
                visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY },
              },
            },
          },
        },
      ],
      deletedAt: null,
      category: { in: BANKING_CATEGORIES },
      date: { gte: start, lte: end },
    },
    select: {
      id: true,
      date: true,
      merchant: true,
      description: true,
      category: true,
      amount: true,
      pending: true,
      plaidTransactionId: true,
      importBatchId: true,
      accountId: true,
      financialAccountId: true,
      account: { select: { name: true } },
      financialAccount: { select: { name: true, displayName: true } },
    },
    orderBy: { date: "asc" },
  });

  if (rows.length === 0) return;

  const settled = rows.filter((r) => !r.pending);
  const pendingCount = rows.length - settled.length;

  // ── Replicate buildMonthlyBreakdown for this month ─────────────────────────
  let incomeTotal = 0, expenseTotal = 0, debtPaymentTotal = 0, transferTotal = 0;
  const categoryAgg = new Map<string, { signed: number; count: number; debits: number; credits: number }>();

  for (const txn of settled) {
    const agg = categoryAgg.get(txn.category) ?? { signed: 0, count: 0, debits: 0, credits: 0 };
    agg.signed += txn.amount;
    agg.count += 1;
    if (txn.amount < 0) agg.debits += Math.abs(txn.amount);
    else agg.credits += txn.amount;
    categoryAgg.set(txn.category, agg);

    if (txn.category === TransactionCategory.Transfer) {
      transferTotal += Math.abs(txn.amount);
    } else if (txn.category === TransactionCategory.Payment) {
      if (txn.amount < 0) debtPaymentTotal += Math.abs(txn.amount);
    } else if (INCOME_CATEGORIES.has(txn.category) && txn.amount > 0) {
      incomeTotal += txn.amount;
    } else if (txn.amount < 0) {
      expenseTotal += Math.abs(txn.amount);
    }
    // NOTE: a POSITIVE row in a spending category falls through every branch
    // above — zero contribution to any money total, but already in categoryAgg.
  }

  const byCategory = Array.from(categoryAgg.entries())
    .map(([category, a]) => ({
      category,
      total: r2(Math.abs(a.signed)), // what the monthly line prints
      debits: r2(a.debits),          // what expenseTotal counts (if spending cat)
      credits: r2(a.credits),        // counted by NEITHER money total
      count: a.count,
    }))
    .filter((c) => c.total > 0)
    .sort((x, y) => y.total - x.total);

  // ── Replicate drilldown matchedTotal for Other (debits only) ───────────────
  const otherRows = settled.filter((r) => r.category === TransactionCategory.Other);
  const otherDebits = otherRows.filter((r) => r.amount < 0);
  const otherCredits = otherRows.filter((r) => r.amount > 0);
  const drilldownOtherTotal = r2(otherDebits.reduce((s, r) => s + Math.abs(r.amount), 0));

  const otherAgg = categoryAgg.get(TransactionCategory.Other) ?? { signed: 0, count: 0, debits: 0, credits: 0 };
  const monthlyOtherTotal = r2(Math.abs(otherAgg.signed));

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log(`\n\n# Space: ${spaceName} (${spaceId}) — ${MONTH}`);
  console.log(`\nRows in window: ${rows.length} (${settled.length} settled, ${pendingCount} pending)`);

  console.log(`\n## Recomputed monthly rollup (mirrors buildMonthlyBreakdown)`);
  console.log(`\n| Metric | Value |`);
  console.log(`|---|---|`);
  console.log(`| expenseTotal ("Total ${MONTH} spending") | ${money(r2(expenseTotal))} |`);
  console.log(`| incomeTotal | ${money(r2(incomeTotal))} |`);
  console.log(`| debtPaymentTotal | ${money(r2(debtPaymentTotal))} |`);
  console.log(`| transferTotal | ${money(r2(transferTotal))} |`);
  console.log(`| **Other — monthly category line (\`abs(signed net)\`)** | **${money(monthlyOtherTotal)}** |`);
  console.log(`| Other — drilldown matchedTotal (debits only) | ${money(drilldownOtherTotal)} |`);

  console.log(`\n## Per-category decomposition (settled rows)`);
  console.log(`\nPrinted = \`abs(debits_sum - credits_sum)\` — the monthly "categories:" line.`);
  console.log(`Counted-in-expenseTotal = debits only (spending categories).\n`);
  console.log(`| Category | Printed total | Σ debits | Σ credits | In expenseTotal | In prompt categories line | Count |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const c of byCategory) {
    const isSpendingName = !NON_SPENDING.has(c.category);
    const inExpense = isSpendingName ? money(c.debits) : "— (non-spending branch)";
    console.log(
      `| ${c.category} | ${money(c.total)} | ${money(c.debits)} | ${money(c.credits)} | ${inExpense} | ${isSpendingName ? "yes" : "no (name-filtered)"} | ${c.count} |`,
    );
  }

  console.log(`\n## Every settled "${MONTH}" Other transaction (${otherRows.length} rows)`);
  console.log(`\nFlow type is heuristic (sign + text) — category on all rows is \`Other\`.`);
  console.log(`Provenance: plaid = plaidTransactionId set; import = importBatchId set; manual = neither.\n`);
  console.log(`| Date | Merchant | Description | Amount | Flow type (heuristic) | Provenance | Account | Path | In expenseTotal | In monthly Other | In drilldown Other |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const t of otherRows) {
    const flow = classifyFlow(t.amount, t.merchant, t.description);
    const provenance = t.plaidTransactionId ? "plaid" : t.importBatchId ? `import (${t.importBatchId})` : "manual";
    const path = t.financialAccountId ? "FinancialAccount" : t.accountId ? "legacy Account" : "orphan";
    const acct = t.financialAccount?.displayName ?? t.financialAccount?.name ?? t.account?.name ?? "?";
    const sign = t.amount < 0 ? "-" : "+";
    console.log(
      `| ${t.date.toISOString().slice(0, 10)} | ${t.merchant} | ${t.description ?? ""} | ${sign}${money(t.amount)} | ${flow} | ${provenance} | ${acct} | ${path} | ${t.amount < 0 ? "yes" : "**no**"} | yes (signed) | ${t.amount < 0 ? "yes" : "**no**"} |`,
    );
  }

  console.log(`\n## Reconciliation`);
  const D = r2(otherDebits.reduce((s, r) => s + Math.abs(r.amount), 0));
  const C = r2(otherCredits.reduce((s, r) => s + r.amount, 0));
  console.log(`\n| Quantity | Formula | Value |`);
  console.log(`|---|---|---|`);
  console.log(`| Other debits (D) | Σ\\|amount<0\\| | ${money(D)} |`);
  console.log(`| Other credits (C) | Σ amount>0 | ${money(C)} |`);
  console.log(`| Monthly "Other" printed | \\|C − D\\| | ${money(r2(Math.abs(C - D)))} |`);
  console.log(`| Other's contribution to expenseTotal | D | ${money(D)} |`);
  console.log(`| Drilldown Other matchedTotal | D | ${money(drilldownOtherTotal)} |`);
  console.log(`| Month expenseTotal | Σ debits, spending branches | ${money(r2(expenseTotal))} |`);
  console.log(
    `| Excess of Other over expenseTotal | \\|C − D\\| − expenseTotal | ${money(r2(Math.abs(C - D) - expenseTotal))} |`,
  );

  // Blast radius: positive rows in spending categories, whole table, all time.
  const blast = await prisma.transaction.groupBy({
    by: ["category"],
    where: {
      OR: [
        { account: { spaceId } },
        {
          financialAccount: {
            deletedAt: null,
            spaceAccountLinks: {
              some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } },
            },
          },
        },
      ],
      deletedAt: null,
      pending: false,
      amount: { gt: 0 },
      category: { in: BANKING_CATEGORIES.filter((c) => !NON_SPENDING.has(c)) },
    },
    _count: { _all: true },
    _sum: { amount: true },
  });
  console.log(`\n## Blast radius — positive rows in spending categories (all dates, this space)`);
  console.log(`\n| Category | Positive rows | Σ credits |`);
  console.log(`|---|---|---|`);
  for (const b of blast.sort((a, z) => (z._sum.amount ?? 0) - (a._sum.amount ?? 0))) {
    console.log(`| ${b.category} | ${b._count._all} | ${money(r2(b._sum.amount ?? 0))} |`);
  }
}

async function main(): Promise<void> {
  console.log(`# KD-17 audit output — generated ${new Date().toISOString()}`);
  console.log(`\nRead-only. Month: ${MONTH}. Mirrors lib/ai/assemblers/transactions.ts logic.`);

  const spaces = SPACE_ID
    ? await prisma.space.findMany({ where: { id: SPACE_ID }, select: { id: true, name: true } })
    : await prisma.space.findMany({ select: { id: true, name: true } });

  for (const s of spaces) {
    await auditSpace(s.id, s.name);
  }
}

main()
  .catch((e) => {
    console.error("Audit failed:", e);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
