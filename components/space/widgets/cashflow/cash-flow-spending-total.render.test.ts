/**
 * components/space/widgets/cashflow/cash-flow-spending-total.render.test.ts   (CF-RECON-1)
 *
 * Standalone tsx + renderToStaticMarkup (house pattern), exits 0/1.
 *
 *   npx tsx components/space/widgets/cashflow/cash-flow-spending-total.render.test.ts
 *
 * "Total spending" under the category list PRINTS the authority's total — the same
 * figure as the Spending tile — never a React sum of its lines, and discloses the
 * refunds no listed category absorbed so the lines on screen add up to it.
 * The Summary's gross card figure says "Charged", never "Spent".
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CashFlowCategoryLedger } from "./CashFlowCategoryLedger";
import { CashFlowSummaryWidget } from "@/components/space/widgets/CashFlowSummaryWidget";
import { buildCashFlowSpaceData } from "@/lib/transactions/cash-flow-space-data";
import { economicSpend } from "@/lib/transactions/cash-flow-projection";
import type { Transaction } from "@/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ACCOUNTS = [{ id: "chk", type: "checking" }, { id: "cc", type: "debt" }];
const tx = (id: string, date: string, amount: number, account: string, category: string, flowType = "SPENDING"): Transaction => ({
  id, date, amount, category, description: "x", merchant: null, merchantDisplayName: null, flowType,
  currency: "USD", pending: false, accountId: account, financialAccountId: account,
} as unknown as Transaction);

// September (MTD at 2026-09-21): Groceries 600 (chk) · Dining 80 (cc) · a 400 Travel
// refund of an AUGUST booking (no Travel charge in September).
//   Spending tile = 680 − 400 = 280;  category lines 600 + 80 = 680;  unapplied 400.
const ROWS = [
  tx("aug-trv", "2026-08-10", -1000, "cc", "Travel"),
  tx("gro", "2026-09-06", -600, "chk", "Groceries"),
  tx("din", "2026-09-10", -80, "cc", "Dining"),
  tx("trv-ref", "2026-09-05", 400, "cc", "Travel", "REFUND"),
];
const data = buildCashFlowSpaceData({ transactions: ROWS, accounts: ACCOUNTS, period: "MTD", now: () => new Date("2026-09-21T00:00:00") });

console.log("1. Total spending prints the authority's total, not Σ lines");
{
  check("fixture: tile 280, lines 680, unapplied 400",
    economicSpend(data.summary) === 280 && data.spending.net === 280 && data.spending.refundsUnapplied === 400);
  const html = text(renderToStaticMarkup(createElement(CashFlowCategoryLedger, {
    items: data.outflowByCategory,
    total: data.spending.net,
    adjustment: { label: "Net of refunds with no matching purchase in this period", value: data.spending.refundsUnapplied },
    browserTitle: "Spending categories", browserEyebrow: "Spending", noun: "categories", detailEyebrow: "Spending category",
    sliceFor: () => [], invalidationKey: "MTD",
  })));
  check("header prints Total spending $280 (the Spending tile's figure)", /Total spending \$280\.00(?![\d])/.test(html), html.slice(0, 200));
  check("the React sum $680 is NOT printed as the total", !/Total spending \$680(\.00)?/.test(html));
  check("the reconciling refund line is disclosed (−$400)", /no matching purchase in this period −\$400\.00(?![\d])/.test(html));
  check("the lines themselves still print (Groceries $600, Dining $80)", /Groceries \$600\.00(?![\d])/.test(html) && /Dining \$80\.00(?![\d])/.test(html));
}

console.log("2. nothing to reconcile ⇒ no adjustment line");
{
  const html = text(renderToStaticMarkup(createElement(CashFlowCategoryLedger, {
    items: [{ id: "Groceries", label: "Groceries", value: 50, transactionIds: [] }],
    total: 50, adjustment: { label: "Net of refunds with no matching purchase in this period", value: 0 },
    browserTitle: "x", browserEyebrow: "x", noun: "categories", detailEyebrow: "x", sliceFor: () => [], invalidationKey: "MTD",
  })));
  check("no disclosure when refundsUnapplied is 0", !/no matching purchase/.test(html) && /\$50\.00(?![\d])/.test(html));
}

console.log("3. the gross card figure says 'Charged', never 'Spent'");
{
  const html = text(renderToStaticMarkup(createElement(CashFlowSummaryWidget, {
    transactions: ROWS, period: "MTD", accounts: ACCOUNTS, perspective: "liquidity",
    windowRows: data.rows, facts: data.summary, context: data.context, hideHeadline: true,
  })));
  check("liquidity context row reads 'Charged on credit'", /Charged on credit \(no cash moved at purchase\)/.test(html), html.slice(0, 300));
  check("…and no longer 'Spent on credit'", !/Spent on credit/.test(html));
}

console.log("4. source guards — no second definition of a spending total in React");
{
  const ledger = code(read("components/space/widgets/cashflow/CashFlowCategoryLedger.tsx"));
  check("ledger prints the `total` PROP", /fmt\(total\)/.test(ledger) && /\btotal:\s*number/.test(ledger));
  check("ledger never declares `const total =` (no summed total)", !/const total\s*=/.test(ledger));
  const ws = code(read("components/space/widgets/cashflow/CashFlowWorkspace.tsx"));
  check("workspace feeds Total spending from the contract's spending.net", /total=\{data\.spending\.net\}/.test(ws));
  const sw = code(read("components/space/widgets/CashFlowSummaryWidget.tsx"));
  check("summary tile split comes from economicSpendByTier, not min/max in React",
    /economicSpendByTier\(facts\)/.test(sw) && !/Math\.min\(\s*facts\.creditCardSpending/.test(sw));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall spending-total render checks passed");
