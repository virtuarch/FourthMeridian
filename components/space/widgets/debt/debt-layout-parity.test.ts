/**
 * components/space/widgets/debt/debt-layout-parity.test.ts  (v2.7 — Debt page layout parity)
 *
 *   1. Debt workspace root uses the SAME section rhythm as Net Worth / Assets
 *      (24px below lg via max-lg:space-y-6!, 32/40px at ≥lg) — the measured
 *      32–40px compact gaps were the Debt-only root class;
 *   2. the desktop Debt hero carries no verdict paragraph (Net Worth structure);
 *   3. "Where it's owed" — the Debt donut: same owed amounts as the ledger,
 *      grouped by account / type / institution, Σ = computeDebtKpis().totalDebt,
 *      zero-owed rows absent, converted once, never double counted;
 *   4. the donut card + the Investments Allocation card put their grouping
 *      Dropdown in the Block header (Net Worth "Where it sits" idiom).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/widgets/debt/debt-layout-parity.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { identityContext } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import { debtCompositionItems, type DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { computeDebtKpis } from "./debt-kpis";
import { DebtCompositionCard, DEBT_COMPOSITION_GROUPINGS } from "./DebtCompositionCard";
import { InvestmentAllocationPanel, ALLOCATION_GROUPINGS } from "@/components/space/widgets/investments/InvestmentAllocationPanel";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/\s+/g, " ").trim();
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const EUR_CTX: ConversionContext = {
  target: "EUR",
  resolve: (from, dateISO) => from === "USD"
    ? { kind: "rate", rate: 0.5, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" } as never
    : { kind: "miss", quote: from, requestedDateISO: dateISO },
};

let uid = 0;
const debt = (over: Partial<DebtPerspectiveAccount>): DebtPerspectiveAccount =>
  ({ id: `d${uid++}`, name: "Card", type: "debt", institution: "Bank", balance: 0, currency: "USD", ...over } as DebtPerspectiveAccount);

const ACCOUNTS: DebtPerspectiveAccount[] = [
  debt({ id: "visa", name: "Visa", institution: "Chase", balance: 1200, debtSubtype: "credit_card" } as never),
  debt({ id: "amex", name: "Gold", institution: "American Express", balance: 300, debtSubtype: "credit_card" } as never),
  debt({ id: "auto", name: "Auto loan", institution: "Chase", balance: 8000, debtSubtype: "auto_loan" } as never),
  debt({ id: "paid", name: "Paid card", institution: "Citi", balance: 0, debtSubtype: "credit_card" } as never),
  debt({ id: "credit", name: "Overpaid", institution: "Citi", balance: -50, debtSubtype: "credit_card" } as never),
  { id: "chk", name: "Checking", type: "checking", institution: "Chase", balance: 9999, currency: "USD" } as DebtPerspectiveAccount,
];

console.log("1. section rhythm — Debt root matches the Net Worth / Assets root");
{
  const dw = code("components/space/widgets/debt/DebtWorkspace.tsx");
  const ww = code("components/space/widgets/wealth/WealthWorkspace.tsx");
  const ROOT_CLS = "space-y-8 sm:space-y-10 min-w-0 max-lg:space-y-6!";
  check("WealthWorkspace root class (the reference)", ww.includes(`<div className="${ROOT_CLS}">`));
  check("DebtWorkspace root carries the SAME class (incl. max-lg:space-y-6!)", dw.includes(`<div className="${ROOT_CLS}">`));
}

console.log("\n2. desktop Debt hero — Net Worth structure, no verdict paragraph");
{
  const hero = code("components/space/widgets/debt/DebtHero.tsx");
  check("no verdict render in the hero", !/\{verdict &&/.test(hero) && !/max-w-prose/.test(hero));
}

console.log("\n3. Where it's owed — debtCompositionItems");
{
  const ctx = identityContext("USD");
  const byAcct = debtCompositionItems(ACCOUNTS, ctx, "account");
  const kpis = computeDebtKpis(ACCOUNTS, ctx);
  check("by account: one slice per OWING liability (paid-off, in-credit and non-debt absent)",
    byAcct.map((i) => i.id).join() === "auto,visa,amex", byAcct.map((i) => i.id).join());
  check("Σ slices === computeDebtKpis().totalDebt (no recomputation, no double count)",
    near(byAcct.reduce((s, i) => s + i.value, 0), kpis.totalDebt), `${byAcct.reduce((s, i) => s + i.value, 0)} vs ${kpis.totalDebt}`);
  const byType = debtCompositionItems(ACCOUNTS, ctx, "type");
  check("by type: presentation classes, largest first", byType.map((i) => `${i.label}=${i.value}`).join() === "Loans=8000,Credit cards=1500", byType.map((i) => `${i.label}=${i.value}`).join());
  const byInst = debtCompositionItems(ACCOUNTS, ctx, "institution");
  check("by institution: grouped and summed", byInst.map((i) => `${i.label}=${i.value}`).join() === "Chase=9200,American Express=300", byInst.map((i) => `${i.label}=${i.value}`).join());
  check("every grouping sums to the same total", [byType, byInst].every((g) => near(g.reduce((s, i) => s + i.value, 0), kpis.totalDebt)));
  check("every slice has a colour", byAcct.every((i) => !!i.color));
  const eur = debtCompositionItems(ACCOUNTS, EUR_CTX, "account");
  check("EUR display: converted once at the context rate (USD→EUR 0.5)", eur.map((i) => i.value).join() === "4000,600,150", eur.map((i) => i.value).join());
  check("no debt ⇒ no slices", debtCompositionItems([ACCOUNTS[3], ACCOUNTS[5]], ctx, "account").length === 0);
}

console.log("\n4. grouping Dropdown in the Block header (Net Worth idiom)");
{
  const html = renderToStaticMarkup(createElement(DebtCompositionCard, { accounts: ACCOUNTS, ctx: identityContext("USD"), currency: "USD" }));
  check("label 'Where it's owed' + 'Current · today's debts'", /Where it's owed/.test(text(html)) && /Current · today's debts/.test(text(html)));
  check("Dropdown with an accessible label, default 'By account'", /aria-label="Debt composition grouping"/.test(html) && /By account/.test(text(html)));
  check("options order: account · type · institution", DEBT_COMPOSITION_GROUPINGS.map((g) => g.id).join() === "account,type,institution");
  check("the Dropdown precedes the donut surface (header, outside and above)", html.indexOf('aria-label="Debt composition grouping"') < html.indexOf("total debt"));
  check("donut centre = total debt in the display currency", /\$9,500\.00/.test(text(html)));
  const empty = renderToStaticMarkup(createElement(DebtCompositionCard, { accounts: [ACCOUNTS[5]], ctx: identityContext("USD"), currency: "USD" }));
  check("empty ⇒ honest empty state", /No debt/.test(text(empty)));

  const inv = code("components/space/widgets/investments/InvestmentsWorkspace.tsx");
  check("Investments: Allocation Block header owns the Dropdown",
    /<Block label="Allocation" action=\{<Dropdown options=\{ALLOCATION_GROUPINGS\} value=\{allocationDimension\} onChange=\{setAllocationDimension\} ariaLabel="Allocation grouping" \/>\}>/.test(inv));
  check("Investments: the panel receives the chosen axis", /dimension=\{allocationDimension\}/.test(inv));
  check("ALLOCATION_GROUPINGS = By asset class · By sector · By account · By currency",
    ALLOCATION_GROUPINGS.map((g) => g.label).join(" · ") === "By asset class · By sector · By account · By currency");
  const holdings = [{ key: "h1", symbol: "VTI", name: "VTI", value: 1000, accountId: "a1", assetClass: "EQUITY", currency: "USD" }] as never;
  const controlled = renderToStaticMarkup(createElement(InvestmentAllocationPanel, { holdings, accounts: [{ id: "a1", name: "Brokerage" }], reportingCurrency: "USD", dimension: "account" }));
  const own = renderToStaticMarkup(createElement(InvestmentAllocationPanel, { holdings, accounts: [{ id: "a1", name: "Brokerage" }], reportingCurrency: "USD" }));
  check("controlled panel renders no in-panel <select>", !/<select/.test(controlled));
  check("uncontrolled panel keeps its select (other hosts unchanged)", /<select/.test(own) || /No valued holdings/.test(own));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
