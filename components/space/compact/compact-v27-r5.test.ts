/**
 * components/space/compact/compact-v27-r5.test.ts  (v2.7 R5 — compact Cash Flow)
 *
 *   1. ONE perspective control on compact: the hero's toggle stays; the History
 *      widget's copy is max-lg:hidden — and both drive the SAME workspace state;
 *   2. the History widget's secondary options sit behind ONE compact "View options"
 *      disclosure (lg:hidden, aria-expanded/aria-controls) that contains every one
 *      of them (measure filter, Month/Quarter/Year, view switch, All Time year nav);
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
  transactions: ROWS, period: JULY, now: clock, accounts: ACCOUNTS, onSelectPeriod: () => {},
  perspective: "liquidity", filterId: "liq-net", onPerspectiveChange: () => {}, ...over,
}));

console.log("1. one perspective control on compact");
{
  const hero = renderToStaticMarkup(createElement(CashFlowHero as ComponentType<Record<string, unknown>>, {
    facts: { cashIn: 5000, cashOut: 3200 } as unknown as DayFacts, perspective: "liquidity", filterId: "", onPerspectiveChange: () => {},
    currency: "USD", period: "PAST_MONTH", asOf: "2026-09-20", change: null,
  }));
  const html = history();
  const heroTab = tagWith(hero, 'aria-label="Cash flow perspective"');
  const histTab = tagWith(html, 'aria-label="Cash flow perspective"');
  check("the hero's perspective toggle is visible on compact (no max-lg:hidden)", heroTab !== "" && !classOf(heroTab).includes("max-lg:hidden"), heroTab);
  check("the History widget's perspective toggle is max-lg:hidden", classOf(histTab).includes("max-lg:hidden"), histTab);
  check("…and still renders on desktop (only the max-lg token differs)", desktopMarkup(html).includes('role="tablist" aria-label="Cash flow perspective"'));
  const ws = read("components/space/widgets/cashflow/CashFlowWorkspace.tsx");
  const heroCall = ws.slice(ws.indexOf("<CashFlowHero\n"), ws.indexOf("/>", ws.indexOf("<CashFlowHero\n")));
  const histCall = ws.slice(ws.indexOf("<CashFlowHistoryWidget"), ws.indexOf("/>", ws.indexOf("<CashFlowHistoryWidget")));
  check("hero and History are driven by the SAME workspace perspective state",
    [heroCall, histCall].every((c) => /perspective=\{perspective\}/.test(c) && /filterId=\{filterId\}/.test(c) && /onPerspectiveChange=\{changePerspective\}/.test(c)));
  check("the hero toggle is a ≥40px target on compact", /max-lg:min-h-10/.test(heroTab) || /max-lg:min-h-10/.test(tagWith(hero, 'role="tab"')));
}

console.log("\n2. the View options disclosure");
{
  const html = history();
  const btnTag = tagWith(html, "aria-controls=");
  const controlsId = /aria-controls="([^"]+)"/.exec(btnTag)?.[1] ?? "";
  check("exactly one compact-only View options button", (html.match(/View options/g) ?? []).length === 1 && classOf(btnTag).includes("lg:hidden"), btnTag);
  check("it is collapsed by default and declares what it controls", /aria-expanded="false"/.test(btnTag) && controlsId !== "");
  check("it is a ≥40px target with a focus ring", classOf(btnTag).includes("min-h-10") && classOf(btnTag).includes("focus-visible:ring-2"));
  const panelTag = tagWith(html, `id="${controlsId}"`);
  check("the controlled panel is compact-hidden while collapsed", classOf(panelTag).includes("max-lg:hidden"), panelTag);
  const fromPanel = html.slice(html.indexOf(panelTag));
  const panel = fromPanel.slice(0, endOfElement(fromPanel));
  for (const label of ['aria-label="Cash flow measure filter"', 'aria-label="Cash flow — month"', 'aria-label="Cash flow — quarter"', 'aria-label="Cash flow — year"', 'aria-label="Cash flow history view"']) {
    check(`the panel contains ${label.slice(12, -1)}`, panel.includes(label));
  }
  const src = read("components/space/widgets/CashFlowHistoryWidget.tsx");
  check("the All Time year nav is hosted in the panel on compact and max-lg:hidden beside the calendar",
    /<div className="lg:hidden w-full">\s*<AllTimeYearNav /.test(src) && /<AllTimeYearNav [^>]*className="max-lg:hidden" \/>/.test(src));
  const desk = desktopMarkup(html);
  check("desktop: no View options button and the cluster renders as before",
    !/View options/.test(desk) && desk.includes(`<div id="${controlsId}" class="flex flex-wrap items-center justify-between gap-2">`));
}

console.log("\n3. the calendar heatmap stays");
{
  const src = read("components/space/widgets/CashFlowHistoryWidget.tsx");
  check("CashFlowHistoryWidget still renders CashFlowCalendar with the day-click drill", /<CashFlowCalendar[\s\S]{0,200}onSelectDay=\{openDay\}/.test(src));
  const html = history();
  const id = /aria-controls="([^"]+)"/.exec(html)?.[1] ?? "";
  const fromPanel = html.slice(html.indexOf(`id="${id}"`) - 5);
  const after = fromPanel.slice(endOfElement(fromPanel));
  check("the calendar renders after (outside) the collapsible panel — visible on compact",
    after.length > 0 && /July|Jul/.test(after) && !/max-lg:hidden/.test(tagWith(after, "<div")));
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
