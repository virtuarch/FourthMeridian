/**
 * components/platform/kpi-actions.test.ts  (Platform Spaces 2.0 — actionable KPIs)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/kpi-actions.test.ts
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HealthHero } from "./ops-visual/HealthHero";

let failures = 0;
const check = (name: string, cond: boolean, d?: unknown) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} — ${JSON.stringify(d)}`); } };
const kpis = [
  { key: "a", label: "A", value: "1", sub: "x" }, { key: "b", label: "B", value: "2", sub: "y" },
  { key: "c", label: "C", value: "3", sub: "z" }, { key: "d", label: "D", value: "4", sub: "w" },
];
const model = { verdict: { word: "ok", tone: "ok" as const }, checked: null, caption: "c", kpis };

console.log("1. HealthHero — an action makes a real button; no action stays a static figure");
{
  const plain = renderToStaticMarkup(createElement(HealthHero, { model }));
  check("no actions ⇒ no buttons, the Personal compact strip", !plain.includes("<button") && plain.includes("data-compact-kpi-strip"));
  const html = renderToStaticMarkup(createElement(HealthHero, { model: { ...model, actions: { a: { label: "Open A", onSelect: () => {} }, c: { label: "Open C", onSelect: () => {}, dialog: true } } } }));
  check("two actionable KPIs ⇒ a button each at both widths (compact + desktop) = 4", (html.match(/<button/g) ?? []).length === 4);
  check("the button names the figure and what opens", html.includes('aria-label="A: 1 — Open A"'));
  check("a drawer action says so (aria-haspopup=dialog)", /aria-label="C: 3 — Open C"[^>]*aria-haspopup="dialog"|aria-haspopup="dialog"[^>]*aria-label="C: 3 — Open C"/.test(html));
  check("static KPIs carry no chevron and no button", !/aria-label="B: 2/.test(html));
}

console.log("2. every Platform Space wires its KPIs to something it renders");
{
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  for (const f of ["OperationsLead", "ProvidersLead", "AiCostsLead", "PoliciesLead", "GrowthLead", "SecurityLead", "CustomerSuccessLead", "MerchantLead"]) {
    const src = read(`components/platform/leads/${f}.tsx`);
    const ids = [...src.matchAll(/goToSection\("([a-z0-9-]+)"\)/g)].map((m) => m[1]);
    const missing = ids.filter((id) => !src.includes(`id="${id}"`));
    check(`${f}: has KPI actions, and every section it scrolls to exists in the same lead`, /actions: \{/.test(src) && missing.length === 0, missing);
  }
}
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
