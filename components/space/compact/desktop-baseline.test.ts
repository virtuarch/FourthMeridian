/**
 * components/space/compact/desktop-baseline.test.ts  (COMPACT DASHBOARD — P0)
 *
 * THE DESKTOP (≥1024px) EXPERIENCE DOES NOT CHANGE.
 *
 * Captured BEFORE any compact UI landed (P0, from develop 830dbab). Two gates:
 *   1. RENDERED — components that render statically (shell, ledger, summary,
 *      hero) must produce the same desktop-effective markup as the baseline
 *      (`desktopMarkup` drops only lg:hidden subtrees, max-lg:* utilities and
 *      data-compact* markers — exactly what cannot render at ≥1024px).
 *   2. SOURCE — files too stateful to render statically (the host, the
 *      workspaces, the sidebar, the chrome) must declare the same set of
 *      desktop-effective className tokens.
 *
 * A deliberate desktop change regenerates the baseline:
 *   UPDATE_DESKTOP_BASELINE=1 npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/desktop-baseline.test.ts
 * and the diff of desktop-baseline.json is the review of that change.
 */

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { desktopClassTokens, desktopMarkup } from "./desktop-markup";
import { SpaceShell } from "@/components/space/shell/SpaceShell";
import { LiabilitiesLedger } from "@/components/space/widgets/debt/LiabilitiesLedger";
import { CashFlowSummaryWidget } from "@/components/space/widgets/CashFlowSummaryWidget";
import { CashFlowHero } from "@/components/space/widgets/cashflow/CashFlowHero";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import type { DayFacts } from "@/lib/transactions/cash-flow-projection";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const BASELINE = path.join(process.cwd(), "components/space/compact/desktop-baseline.json");

// ── Fixtures ──────────────────────────────────────────────────────────────────
const RAIL = ["Overview", "Activity", "Accounts", "Transactions", "Members"].map((label) => ({ id: label.toUpperCase(), label }));
const debt = (id: string, name: string, balance: number, over: Partial<DebtPerspectiveAccount> = {}): DebtPerspectiveAccount =>
  ({ id, name, type: "debt", institution: "Bank", balance, currency: "USD", ...over });
const DEBTS: DebtPerspectiveAccount[] = [
  debt("c1", "Sapphire", -1200, { debtSubtype: "credit_card", creditLimit: 10000, interestRate: 24.99 }),
  debt("c2", "Freedom", -300, { debtSubtype: "credit_card", creditLimit: 5000 }),
  debt("l1", "Auto loan", -14000, { debtSubtype: "auto_loan", interestRate: 6.5 }),
  debt("l2", "Mortgage", -280000, { debtSubtype: "mortgage", interestRate: 5.1 }),
  debt("o1", "IOU", -500),
];
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

const RENDERS: Record<string, () => string> = {
  "SpaceShell (customer, Overview)": () => renderToStaticMarkup(createElement(SpaceShell, {
    title: "Chris's Space", subtitle: "Personal", currencyControl: null, onManage: () => {},
    railOptions: RAIL, activeTab: "OVERVIEW", onSelectTab: () => {}, mobileOptimized: true,
    children: createElement("p", null, "content"),
  } as never)),
  "LiabilitiesLedger (cards, loans, other)": () => renderToStaticMarkup(createElement(LiabilitiesLedger, { accounts: DEBTS, currency: "USD" })),
  // v2.7 — the summary is only Cash In / Cash Out (the economic view became the
  // separate Spending perspective), so the former "(economic)" render is retired.
  "CashFlowSummaryWidget (liquidity)": () => renderToStaticMarkup(createElement(CashFlowSummaryWidget, {
    transactions: ROWS, period: { kind: "month", year: 2026, month: 7 }, accounts: ACCOUNTS, asOf: "2026-07-31",
  } as never)),
  "CashFlowHero (liquidity)": () => renderToStaticMarkup(createElement(CashFlowHero as ComponentType<Record<string, unknown>>, {
    facts: { cashIn: 5000, cashOut: 3200 } as unknown as DayFacts,
    currency: "USD", period: "PAST_MONTH", windowLabel: "as of Sep 20, 2026", change: null,
  })),
};

/** Files whose desktop-effective className tokens must not change. */
const SOURCES = [
  "components/dashboard/SpaceDashboard.tsx",
  "components/space/shell/SpaceShell.tsx",
  "components/space/shell/PerspectiveShell.tsx",
  "components/space/shell/SpaceControls.tsx",
  "components/space/widgets/wealth/WealthWorkspace.tsx",
  "components/space/widgets/wealth/WealthHero.tsx",
  "components/space/widgets/wealth/WealthTrendChart.tsx",
  "components/space/widgets/wealth/RealAssetsSection.tsx",
  "components/space/widgets/liquidity/LiquidityWorkspace.tsx",
  "components/space/widgets/investments/InvestmentsWorkspace.tsx",
  "components/space/widgets/debt/DebtWorkspace.tsx",
  "components/space/widgets/debt/DebtHero.tsx",
  "components/space/widgets/debt/LiabilitiesLedger.tsx",
  "components/space/widgets/cashflow/CashFlowWorkspace.tsx",
  "components/space/widgets/cashflow/CashFlowHero.tsx",
  "components/space/widgets/CashFlowSummaryWidget.tsx",
  "components/space/widgets/charts/TrendChart.tsx",
  "components/ui/ContextualNavbar.tsx",
  "components/ui/BottomNav.tsx",
  "components/ui/DashboardChrome.tsx",
];

interface Baseline { capturedFrom: string; renders: Record<string, string>; tokens: Record<string, string[]> }

const current: Baseline = {
  capturedFrom: "develop 830dbab (before the compact redesign)",
  renders: Object.fromEntries(Object.entries(RENDERS).map(([k, r]) => [k, desktopMarkup(r())])),
  tokens: Object.fromEntries(SOURCES.map((f) => [f, desktopClassTokens(readFileSync(path.join(process.cwd(), f), "utf8"))])),
};

if (process.env.UPDATE_DESKTOP_BASELINE === "1" || !existsSync(BASELINE)) {
  const prior = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline).capturedFrom : null;
  writeFileSync(BASELINE, JSON.stringify({ ...current, capturedFrom: prior ?? current.capturedFrom }, null, 1) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), BASELINE)} — review its diff: it IS the desktop change`);
}
const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;

console.log("0. the normaliser removes exactly what cannot render at ≥1024px");
{
  const html = '<div class="p-4 max-lg:hidden" data-compact-section="cash"><span class="lg:hidden"><b>compact</b><br/></span><i>desk</i><img src="x"/></div>';
  check("compact-only subtree, max-lg utility and data-compact marker are dropped; the rest is untouched",
    desktopMarkup(html) === '<div class="p-4"><i>desk</i><img src="x"/></div>', desktopMarkup(html));
  check("a desktop-only element (hidden lg:block) is kept", desktopMarkup('<a class="hidden lg:block">x</a>') === '<a class="hidden lg:block">x</a>');
  check("source tokens skip compact-only literals and max-lg tokens",
    desktopClassTokens('<a className="lg:hidden px-9"/><b className={on ? "p-2 max-lg:hidden" : "p-3"}/>').join(" ") === "p-2 p-3");
}

console.log("\n1. rendered components: desktop markup equals the P0 baseline");
for (const [name, html] of Object.entries(current.renders)) {
  const want = baseline.renders[name];
  check(`${name}`, want !== undefined && html === want,
    want === undefined ? "missing from baseline" : `first difference at ${[...html].findIndex((c, i) => c !== want[i])}`);
}

console.log("\n2. source files: desktop-effective className tokens equal the P0 baseline");
for (const f of SOURCES) {
  const want = baseline.tokens[f] ?? [];
  const got = current.tokens[f];
  const added = got.filter((t) => !want.includes(t));
  const removed = want.filter((t) => !got.includes(t));
  check(f, added.length === 0 && removed.length === 0, `added [${added.join(" ")}] removed [${removed.join(" ")}]`);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
