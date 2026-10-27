/**
 * components/space/compact/compact-cashflow.test.ts  (COMPACT DASHBOARD — P4/P5)
 *
 *   1. v2.7 (owner) — the "Moved, not spent — N kinds" card is GONE: Cash Flow's
 *      Transfers & movements section states each movement as what it is, with its
 *      amount, count, status and a neutral Review (CashFlowMovements);
 *   2. the summary is only the Cash In / Cash Out tiles (no toggle, no context);
 *   3. the compact hero treatment is max-lg-only on all three heroes;
 *   4. UNCHANGED, byte for byte, since P0: the calendar heatmap and every lower
 *      Cash Flow section, Markets / Coming soon, Real assets, and every finance
 *      library (totals, classification, transfers, credit, periods, dates).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/compact-cashflow.test.ts
 */

import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CashFlowSummaryWidget } from "@/components/space/widgets/CashFlowSummaryWidget";
import { CashFlowMovements, movementLines } from "@/components/space/widgets/cashflow/CashFlowMovements";
import { buildCashFlowSpaceData } from "@/lib/transactions/cash-flow-space-data";
import { COMPACT_HERO } from "./compact-hero";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

let n = 0;
const tx = (over: Record<string, unknown>) => ({
  id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Shopping",
  pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null,
  date: "2026-07-05", amount: -10, ...over,
});
const ROWS = [
  tx({ amount: 3000, date: "2026-07-01", flowType: "INCOME", category: "Payroll" }),
  tx({ amount: -400, date: "2026-07-03", accountId: "card", financialAccountId: "card" }),
  tx({ amount: -300, date: "2026-07-20", flowType: "DEBT_PAYMENT", category: "Payment", counterpartyAccountId: "card" }),
  tx({ amount: -60, date: "2026-07-04", category: "Groceries" }),
];
const ACCOUNTS = [{ id: "chk", type: "checking" }, { id: "card", type: "debt" }];
const widget = () => renderToStaticMarkup(createElement(CashFlowSummaryWidget, {
  transactions: ROWS, period: { kind: "month", year: 2026, month: 7 }, accounts: ACCOUNTS, asOf: "2026-07-31",
} as never));
// The fixture-reconciliation shape: an unresolved $6,879.22 across 4 transfers.
const MOVED = [
  ...ROWS,
  tx({ amount: -5850, flowType: "TRANSFER", category: "Transfer", transferDisposition: "EXTERNAL_BANK_TRANSFER" }),
  tx({ amount: -1000, flowType: "TRANSFER", category: "Transfer", transferDisposition: "UNKNOWN_MOVEMENT" }),
  tx({ amount: -25, flowType: "TRANSFER", category: "Transfer", transferDisposition: "EXTERNAL_BANK_TRANSFER" }),
  tx({ amount: 4.22, flowType: "TRANSFER", category: "Transfer", transferDisposition: "UNKNOWN_MOVEMENT" }),
];
const data = buildCashFlowSpaceData({ transactions: MOVED as never, accounts: ACCOUNTS, period: { kind: "month", year: 2026, month: 7 }, now: () => new Date("2026-07-31T00:00:00") });
const lines = movementLines({ context: data.context, charged: data.summary.creditCardSpending, chargedRows: data.rows.filter((r) => r.flowType === "SPENDING" && r.accountId === "card") });

console.log("1. Transfers & movements — meaningful lines, not 'N kinds'");
{
  const html = renderToStaticMarkup(createElement(CashFlowMovements, { lines, invalidationKey: "k" }));
  const t = text(html);
  check("unresolved transfers: amount · count · status, never asserted internal or spent",
    /Unresolved transfers · 6,879\.22 · 4 transactions destination not confirmed — not counted as cash in or out/.test(t), t);
  check("card charges: the canonical gross figure, 'Charged', with what it means", /Charged on credit · 400(\.00)? · 1 purchase no cash moved at purchase/.test(t), t);
  check("every line has a neutral Review action (opens the existing slice drawer)",
    (html.match(/>Review</g) ?? []).length === lines.length && /TransactionSliceDrawer/.test(read("components/space/widgets/cashflow/CashFlowMovements.tsx")));
  check("no 'kinds' count and no 'Moved, not spent' card anywhere", !/kinds?\b|Moved, not spent/i.test(t) && !existsSync(path.join(ROOT, "components/space/compact/CompactCashFlowCards.tsx")));
  check("no new total: the line amounts are the projection's own per-kind figures",
    lines.find((l) => l.key === "unresolved-transfers")?.amount === data.context.movedNotSpent.find((r) => r.key === "unresolved-transfers")?.amount
      && !/reduce\(/.test(read("components/space/widgets/cashflow/CashFlowMovements.tsx").replace(/\/\*[\s\S]*?\*\//g, "")));
  check("nothing moved ⇒ nothing rendered (no empty card)",
    renderToStaticMarkup(createElement(CashFlowMovements, { lines: [], invalidationKey: "k" })).indexOf("data-movement") === -1);
  check("Review targets are ≥40px on compact", /max-lg:min-h-10/.test(html));
}

console.log("\n2. the summary is just Cash In / Cash Out");
{
  const t = text(widget());
  check("Cash In and Cash Out tiles", /Cash In/.test(t) && /Cash Out/.test(t));
  check("no toggle, no context rows, no compact cards", !/Charged on credit|Moved, not spent|Needs classification|Spending/.test(t) && !/data-compact-cashflow-cards|role="tablist"/.test(widget()));
}

console.log("\n3. the compact hero");
check("every hero utility is max-lg (none can apply at ≥1024px)", COMPACT_HERO.split(/\s+/).filter(Boolean).every((t) => t.startsWith("max-lg:")));
check("dark navy surface (--ink-800) with padding, border and rounding", /var\(--ink-800\)/.test(COMPACT_HERO) && /max-lg:px-5/.test(COMPACT_HERO) && /max-lg:rounded-2xl/.test(COMPACT_HERO));
// v2.7 visual-first — DELIBERATE: Net Worth / Debt draw their compact hero through
// the shared five-row CompactHeroCard, whose card root carries COMPACT_HERO.
check("CompactHeroCard's card root uses it", /className=\{`lg:hidden grid grid-rows-\[auto_auto_auto_auto_auto\] gap-1 \$\{COMPACT_HERO\}`\}/.test(read("components/space/compact/CompactHeroCard.tsx")));
for (const f of ["components/space/widgets/wealth/WealthHero.tsx", "components/space/widgets/debt/DebtHero.tsx", "components/space/widgets/cashflow/CashFlowHero.tsx", "components/space/widgets/cashflow/SpendingSections.tsx"]) {
  check(`${path.basename(f)} renders the shared card`, /<CompactHeroCard\b/.test(read(f)));
}
// v2.7 final UX pass — Cash Flow / Spending joined the shared card; their desktop
// hero is a separate max-lg:hidden section (bare, unchanged at ≥1024px).
for (const f of ["components/space/widgets/cashflow/CashFlowHero.tsx", "components/space/widgets/cashflow/SpendingSections.tsx"]) {
  check(`${path.basename(f)} desktop hero is max-lg:hidden`, /<section className="max-lg:hidden"/.test(read(f)));
}

console.log("\n4. unchanged since P0 (byte for byte)");
{
  const PINS = path.join(ROOT, "components/space/compact/unchanged-pins.json");
  const PROTECTED_FILES = [
    "components/space/widgets/CashFlowCalendar.tsx",
    "components/space/widgets/shared/CalendarHeatmapGrid.tsx",
    "components/space/widgets/CashFlowHistoryWidget.tsx",
    "components/space/widgets/CashFlowCategoryBreakdown.tsx",
    "components/space/widgets/CashFlowFilterControls.tsx",
    "components/space/widgets/DebtPaymentsWidget.tsx",
    "components/space/widgets/TransactionSliceDrawer.tsx",
    "components/space/widgets/cashflow/CashFlowWorkspace.tsx",
    "components/space/widgets/cashflow/CashFlowCategoryLedger.tsx",
    "components/space/widgets/cashflow/CashFlowCategoryDetail.tsx",
    "components/space/widgets/cashflow/CashFlowInsightsCard.tsx",
    "components/space/widgets/cashflow/cash-flow-insights.ts",
    "components/space/widgets/markets/MarketsWorkspace.tsx",
    "components/space/workspaces/WorkspaceComingSoon.tsx",
    "components/space/widgets/wealth/RealAssetsSection.tsx",
  ];
  // Finance authorities: totals, classification, transfers, credit, liquidity, periods, FX.
  const FINANCE_DIRS = ["lib/transactions", "lib/debt", "lib/accounts", "lib/money", "lib/liquidity", "lib/investments", "lib/fx"];
  const walk = (dir: string): string[] => existsSync(path.join(ROOT, dir)) ? readdirSync(path.join(ROOT, dir)).flatMap((e) => {
    const rel = path.join(dir, e);
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) ? [rel] : [];
  }) : [];
  const files = [...PROTECTED_FILES, ...FINANCE_DIRS.flatMap(walk), "lib/wealth/wealth-time-machine.ts", "lib/wealth/invested-label.ts"].sort();
  const sha = (rel: string) => createHash("sha256").update(readFileSync(path.join(ROOT, rel))).digest("hex");
  const current = Object.fromEntries(files.map((f) => [f, sha(f)]));
  if (process.env.UPDATE_UNCHANGED_PINS === "1" || !existsSync(PINS)) {
    writeFileSync(PINS, JSON.stringify(current, null, 1) + "\n");
    console.log(`  (wrote ${path.relative(ROOT, PINS)})`);
  }
  const pins = JSON.parse(readFileSync(PINS, "utf8")) as Record<string, string>;
  const changed = files.filter((f) => pins[f] !== current[f]);
  const missing = Object.keys(pins).filter((f) => !(f in current));
  check(`${files.length} protected files (calendar, lower Cash Flow, Markets, Real assets, finance libraries) are byte-identical`,
    changed.length === 0 && missing.length === 0, `changed [${changed.join(", ")}] missing [${missing.join(", ")}]`);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
