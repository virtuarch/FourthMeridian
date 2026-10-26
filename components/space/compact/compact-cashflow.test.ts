/**
 * components/space/compact/compact-cashflow.test.ts  (COMPACT DASHBOARD — P4/P5)
 *
 *   1. compact Cash Flow cards: Cash In · Cash Out (the existing tiles, unchanged)
 *      + Charged on credit · Moved, not spent — values from the existing facts and
 *      context projection, the existing drill-downs, NO invented total;
 *   2. economic view keeps today's semantics (no Charged card: card purchases are
 *      already inside Spending); "Needs classification" is never hidden behind a card;
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
import { CompactCashFlowCards } from "./CompactCashFlowCards";
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
const widget = (perspective: "liquidity" | "economic") => renderToStaticMarkup(createElement(CashFlowSummaryWidget, {
  transactions: ROWS, period: { kind: "month", year: 2026, month: 7 }, accounts: ACCOUNTS, perspective, asOf: "2026-07-31", hideHeadline: true,
} as never));

console.log("1. the compact cards");
{
  const html = widget("liquidity");
  const cards = html.slice(html.indexOf("data-compact-cashflow-cards"));
  check("a compact-only (lg:hidden) row of cards follows the Cash In / Cash Out tiles",
    html.indexOf("Cash In") < html.indexOf("data-compact-cashflow-cards") && /class="lg:hidden grid gap-3 grid-cols-2" data-compact-cashflow-cards/.test(html));
  check("Cash In and Cash Out are the existing tiles, with their labels", /Cash In/.test(text(html)) && /Cash Out/.test(text(html)));
  check("Charged on credit shows the canonical facts figure (the 400 card purchase)", /Charged on credit\s*400\s*No cash moved at purchase/.test(text(cards)), text(cards).slice(0, 120));
  check("Moved, not spent shows a count of kinds — never a summed amount", /Moved, not spent\s*(None|\d+ kinds?)\s*Show details/.test(text(cards)));
  const src = read("components/space/widgets/CashFlowSummaryWidget.tsx");
  check("the Charged card opens the SAME slice the desktop row opens",
    (src.match(/setSlice\(\{ title: "Charged on credit", subtitle: "Bought on credit this period", spendLabel: "Charged",\s*rows: rows\.filter\(\(r\) => isCostFlow\(r\.flowType\) && isLiabilityRow\(r\)\) \}\)/g) ?? []).length === 2);
  check("the card values come straight from facts and the context projection",
    /charged=\{facts\.creditCardSpending > 0 \? fmt\(facts\.creditCardSpending, ctx\) : null\}/.test(src) && /movedKinds=\{context\.movedNotSpent\.length\}/.test(src));
  check("no new total was computed for Moved, not spent", !/movedNotSpent\.reduce|movedTotal/.test(src) && !/reduce|amount/.test(read("components/space/compact/CompactCashFlowCards.tsx").replace(/\/\*[\s\S]*?\*\//g, "")));
  check("the card discloses the existing rows in place (aria-expanded)", /aria-expanded=\{movedOpen\}/.test(read("components/space/compact/CompactCashFlowCards.tsx")));
}

console.log("\n2. economic view and the context rows");
{
  const html = widget("economic");
  const cards = html.slice(html.indexOf("data-compact-cashflow-cards"));
  check("economic: Income / Spending tiles; no Charged card (purchases are inside Spending — unchanged)",
    /Income/.test(text(html)) && /Spending/.test(text(html)) && !/Charged on credit/.test(text(cards)) && /grid-cols-1" data-compact-cashflow-cards/.test(html));
  const src = read("components/space/widgets/CashFlowSummaryWidget.tsx");
  check("on compact only the Moved-not-spent block waits behind its card", /rounded-xl px-3 py-2 space-y-1\.5 \$\{movedOpen \? "" : "max-lg:hidden"\}/.test(src));
  check("Needs classification is never hidden behind it", !/Needs classification[\s\S]{0,40}max-lg:hidden/.test(src) && /<div className="space-y-2">\s*\{context\.movedNotSpent\.length > 0 &&/.test(src));
  check("the cards render nothing on desktop", /^<div class="lg:hidden/.test(renderToStaticMarkup(createElement(CompactCashFlowCards, {
    economic: false, charged: "400", onOpenCharged: () => {}, movedKinds: 2, movedOpen: false, onToggleMoved: () => {},
  }))));
}

console.log("\n3. the compact hero");
check("every hero utility is max-lg (none can apply at ≥1024px)", COMPACT_HERO.split(/\s+/).filter(Boolean).every((t) => t.startsWith("max-lg:")));
check("dark navy surface (--ink-800) with padding, border and rounding", /var\(--ink-800\)/.test(COMPACT_HERO) && /max-lg:px-5/.test(COMPACT_HERO) && /max-lg:rounded-2xl/.test(COMPACT_HERO));
for (const f of ["components/space/widgets/wealth/WealthHero.tsx", "components/space/widgets/debt/DebtHero.tsx", "components/space/widgets/cashflow/CashFlowHero.tsx"]) {
  check(`${path.basename(f)} root uses it`, /<section className=\{COMPACT_HERO\}>/.test(read(f)));
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
