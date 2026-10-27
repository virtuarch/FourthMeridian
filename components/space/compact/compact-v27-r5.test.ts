/**
 * components/space/compact/compact-v27-r5.test.ts  (v2.7 R5 — compact Cash Flow)
 *
 *   1. v2.7 (owner) — NO perspective control at all: Cash Flow and Spending are
 *      separate perspectives (neither the hero nor the heatmap carries a toggle);
 *   2. v2.7 (owner) — the nested "View options" disclosure is replaced by ONE compact,
 *      always-visible control set: Month · Quarter · Year, the unit stepper, and the
 *      page-scoped measure select (no Calendar/Cards switch — Cards is removed);
 *   3. the calendar heatmap is still rendered, with the existing day-click drill;
 *   4. What changed: the first 3 observations lead, the rest wait behind "Show all
 *      observations"; the list is the builder's output, same objects, same order;
 *      the completeness caveat is never hidden;
 *   5. desktop (≥1024px) markup of the touched widgets carries none of it.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/compact-v27-r5.test.ts
 */

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { desktopMarkup } from "./desktop-markup";
import { CashFlowHistoryWidget } from "@/components/space/widgets/CashFlowHistoryWidget";
import { CashFlowHero } from "@/components/space/widgets/cashflow/CashFlowHero";
import { CashFlowInsightsCard, COMPACT_INSIGHT_LEAD } from "@/components/space/widgets/cashflow/CashFlowInsightsCard";
import { buildCashFlowInsights } from "@/components/space/widgets/cashflow/cash-flow-insights";
import type { CashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import type { DayFacts } from "@/lib/transactions/cash-flow-projection";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The opening tag carrying `marker` (an attribute fragment). */
const tagWith = (html: string, marker: string) => {
  const i = html.indexOf(marker);
  if (i < 0) return "";
  return html.slice(html.lastIndexOf("<", i), html.indexOf(">", i) + 1);
};
const classOf = (tag: string) => /\sclass="([^"]*)"/.exec(tag)?.[1].split(/\s+/) ?? [];

let n = 0;
const tx = (over: Record<string, unknown>) => ({
  id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Shopping",
  pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null,
  date: "2026-07-05", amount: -10, ...over,
});
const ROWS = [
  tx({ amount: 2500, date: "2026-06-01", flowType: "INCOME", category: "Payroll" }),
  tx({ amount: -200, date: "2026-06-04", category: "Groceries" }),
  tx({ amount: 3000, date: "2026-07-01", flowType: "INCOME", category: "Payroll" }),
  tx({ amount: -400, date: "2026-07-03", accountId: "card", financialAccountId: "card" }),
  tx({ amount: -300, date: "2026-07-20", flowType: "DEBT_PAYMENT", category: "Payment", counterpartyAccountId: "card" }),
  tx({ amount: -60, date: "2026-07-04", category: "Groceries" }),
];
const ACCOUNTS = [{ id: "chk", type: "checking" }, { id: "card", type: "debt" }];
const JULY = { kind: "month", year: 2026, month: 7 } as const;
const clock = () => new Date("2026-07-31T00:00:00");

const history = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(CashFlowHistoryWidget as unknown as ComponentType<Record<string, unknown>>, {
  transactions: ROWS, period: JULY, now: clock, asOf: "2026-07-31", today: "2026-10-27", accounts: ACCOUNTS, onSelectPeriod: () => {}, ...over,
}));

console.log("1. no perspective control anywhere");
{
  const hero = renderToStaticMarkup(createElement(CashFlowHero as ComponentType<Record<string, unknown>>, {
    facts: { cashIn: 5000, cashOut: 3200 } as unknown as DayFacts, currency: "USD", period: "PAST_MONTH", windowLabel: "as of Sep 20, 2026", change: null,
  }));
  for (const [name, html] of [["hero", hero], ["heatmap (Cash Flow)", history()], ["heatmap (Spending)", history({ page: "spending" })]] as const) {
    check(`${name}: no Cash Flow ⇄ Spending toggle`, !/aria-label="Cash flow perspective"/.test(html) && !/>Spending<\/button>/.test(html));
  }
}

console.log("\n2. the compact control set (no View options disclosure)");
{
  const html = history();
  check("no View options disclosure, no aria-controls panel", !/View options/.test(html) && !/aria-controls=/.test(html));
  const row = tagWith(html, "data-heatmap-controls");
  check("one controls row, visible at every width (no max-lg:hidden / lg:hidden)", row !== "" && !classOf(row).includes("max-lg:hidden") && !classOf(row).includes("lg:hidden"), row);
  check("Month · Quarter · Year as one radiogroup", /role="radiogroup" aria-label="Heatmap period"/.test(html)
    && ["month", "quarter", "year"].every((k) => html.includes(`data-scale="${k}"`)));
  check("July 2026 (an explicit month) ⇒ Month is the active unit", /aria-checked="true" data-scale="month"/.test(html));
  check("the unit stepper shows the window and steps it", /data-heatmap-stepper/.test(html) && /July 2026/.test(html) && /aria-label="Previous period"/.test(html) && /aria-label="Next period"/.test(html));
  check("Cash Flow measures: the liquidity set", /aria-label="Heatmap measure"/.test(html) && /Cash in &amp; out/.test(html) && !/Credit-card spending/.test(html));
  const sp = history({ page: "spending" });
  check("Spending measures: spending only (no income, no cash measures)", /Credit-card spending/.test(sp) && !/>Income</.test(sp) && !/Cash in &amp; out/.test(sp));
  check("no Calendar / Cards switch", !/aria-label="Cash flow history view"/.test(html) && !/>Cards</.test(html));
  check("touch targets ≥40px below lg", (html.match(/max-lg:min-h-10|max-lg:h-10/g) ?? []).length >= 4);
  const rel = history({ period: "PAST_MONTH", asOf: "2026-07-31" });
  check("a relative preset (1M) ⇒ no unit is active and no stepper (the heatmap paints the preset's range)",
    !/aria-checked="true"/.test(rel) && !/data-heatmap-stepper/.test(rel));
}

console.log("\n3. the calendar heatmap stays");
{
  const src = read("components/space/widgets/CashFlowHistoryWidget.tsx");
  check("CashFlowHistoryWidget still renders CashFlowCalendar with the day-click drill", /<CashFlowCalendar[\s\S]{0,200}onSelectDay=\{openDay\}/.test(src));
  const html = history();
  const after = html.slice(html.indexOf("data-heatmap-controls"));
  check("the calendar renders after the controls — visible on compact", /July|Jul/.test(after.slice(after.indexOf("</select>"))));
}

console.log("\n4. What changed — first 3, then Show all");
{
  const stamp = { completeness: { tier: "incomplete", reason: "History before June 2026 isn't connected yet." }, dataAsOf: "2026-07-31" } as unknown as CashFlowStamp;
  const props = { transactions: ROWS, accounts: ACCOUNTS, period: JULY, now: clock, compareTo: null, perspective: "liquidity" as const, stamp };
  const expected = buildCashFlowInsights(props as never);
  const html = renderToStaticMarkup(createElement(CashFlowInsightsCard as unknown as ComponentType<Record<string, unknown>>, props));
  const items = [...html.matchAll(/<li class="([^"]*)">[\s\S]*?<span class="[^"]*">([\s\S]*?)<\/span><\/li>/g)].map((m) => ({ cls: m[1], text: decode(m[2]) }));
  check(`fixture yields more than ${COMPACT_INSIGHT_LEAD} observations plus the caveat`, expected.length > COMPACT_INSIGHT_LEAD + 1 && expected.at(-1)?.id === "completeness", expected.map((e) => e.id).join(","));
  check("the rendered list is the builder's output, verbatim and in order", JSON.stringify(items.map((i) => i.text)) === JSON.stringify(expected.map((e) => e.text)));
  check(`the first ${COMPACT_INSIGHT_LEAD} are visible on compact`, items.slice(0, COMPACT_INSIGHT_LEAD).every((i) => !i.cls.includes("max-lg:hidden")));
  check("the rest (except the caveat) wait behind the disclosure", items.slice(COMPACT_INSIGHT_LEAD, -1).every((i) => i.cls.includes("max-lg:hidden")));
  check("the completeness caveat (the stamp) stays visible", !items.at(-1)!.cls.includes("max-lg:hidden") && items.at(-1)!.text === stamp.completeness.reason);
  const btn = tagWith(html, "aria-controls=");
  const ulId = /<ul id="([^"]+)"/.exec(html)?.[1];
  check("a compact-only Show all observations button controls the list", classOf(btn).includes("lg:hidden") && /aria-expanded="false"/.test(btn) && btn.includes(`aria-controls="${ulId}"`) && /Show all observations/.test(html));
  check("it is a ≥40px target with a focus ring", classOf(btn).includes("min-h-10") && classOf(btn).includes("focus-visible:ring-2"));
  const desk = desktopMarkup(html);
  check("desktop: every observation shown, no disclosure",
    !/Show all observations/.test(desk) && (desk.match(/<li class="flex items-start gap-2">/g) ?? []).length === expected.length);
  const few = renderToStaticMarkup(createElement(CashFlowInsightsCard as unknown as ComponentType<Record<string, unknown>>, { ...props, stamp: null, transactions: ROWS.slice(0, 2), period: { kind: "month", year: 2026, month: 6 } }));
  check("with ≤3 observations there is no disclosure and nothing is clamped", !/Show all observations/.test(few) && !/line-clamp/.test(few));
  check("the card derives nothing new (no edit to the builder's import surface)", !/compareCashFlow|outflowByCategory/.test(read("components/space/widgets/cashflow/CashFlowInsightsCard.tsx")));
}

/** Length of the first element in `html` (balanced by tag name, naive but sufficient for divs). */
function endOfElement(html: string): number {
  const re = /<(\/?)div\b[^>]*>/g;
  let depth = 0;
  for (const m of html.matchAll(re)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index! + m[0].length;
  }
  return html.length;
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
