/**
 * components/space/widgets/investments/investments-order.test.ts
 *
 * v2.7 final UX pass (owner) — Investments reads Chart → Allocation donut →
 * Holdings table at EVERY breakpoint. The order is plain DOM order: no CSS
 * `order-*`, `flex-*-reverse`, `grid-flow-*`, row/col-start placement or
 * `lg:` re-ordering anywhere on the path, so what renders first on a 375px
 * phone renders first on a 1440px desktop too.
 *
 * Both entries are covered:
 *   • standalone Investments — InvestmentsWorkspace's own balance history,
 *     then the Allocation block, then the Holdings block;
 *   • Assets → Investments (embedded) — WealthWorkspace's unified chart
 *     (#wealth-trend) precedes the embedded InvestmentsWorkspace, whose
 *     Allocation precedes Holdings.
 *
 *   npx tsx components/space/widgets/investments/investments-order.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (rel: string) => strip(readFileSync(path.join(process.cwd(), rel), "utf8"));

const INV = read("components/space/widgets/investments/InvestmentsWorkspace.tsx");
const WW = read("components/space/widgets/wealth/WealthWorkspace.tsx");
// The workspace's main render (the last top-level return).
const RET = INV.slice(INV.lastIndexOf("  return (\n    <div className=\"space-y-8"));

const REORDER = /(?:^|[\s"'`:])(?:[a-z0-9-]+:)*(?:order-|flex-row-reverse|flex-col-reverse|grid-flow-|row-start-|col-start-|row-span-)/;

console.log("1. standalone: Chart → Allocation → Holdings (DOM order)");
{
  const chart = RET.indexOf('id="investments-history"');
  const alloc = RET.indexOf('id="investments-allocation"');
  const hold = RET.indexOf('id="investments-holdings"');
  check("all three surfaces are in the render", chart > 0 && alloc > 0 && hold > 0, JSON.stringify({ chart, alloc, hold }));
  check("balance history precedes the Allocation donut", chart < alloc);
  check("the Allocation donut precedes the Holdings table", alloc < hold);
  check("the donut (InvestmentAllocationPanel) itself sits before the HoldingsLedger",
    RET.indexOf("<InvestmentAllocationPanel") < RET.indexOf("<HoldingsLedger"));
}

console.log("\n1b. the sidebar section list follows the same order");
{
  check("Allocation is listed before Holdings in the section anchors",
    INV.indexOf('anchor: "investments-allocation"') > 0 && INV.indexOf('anchor: "investments-allocation"') < INV.indexOf('anchor: "investments-holdings"'));
}

console.log("\n2. no CSS re-ordering at any breakpoint");
{
  const classes = [...RET.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);
  const bad = classes.filter((c) => REORDER.test(` ${c}`));
  check("InvestmentsWorkspace render uses no order/reverse/grid-placement utilities", bad.length === 0, bad.join(" | "));
  const wwTrend = WW.slice(WW.indexOf('id="wealth-trend"') - 40, WW.indexOf('id="wealth-trend"') + 200);
  check("the Assets chart wrapper carries no order utility", !REORDER.test(wwTrend), wwTrend);
}

console.log("\n3. embedded (Assets → Investments): the unified chart precedes the section");
{
  const body = WW.indexOf("const assetsSectionsBody");
  const invSection = WW.indexOf('id="wealth-investments"', body);
  const ret = WW.lastIndexOf("  return (\n    <>");
  const trendInRet = WW.indexOf('id="wealth-trend"', ret);
  const bodyInRet = WW.indexOf("{assetsSectionsBody}", trendInRet);
  check("assetsSectionsBody mounts the embedded Investments section", body > 0 && invSection > body);
  check("#wealth-trend renders before {assetsSectionsBody} in the main return", ret > 0 && trendInRet > ret && bodyInRet > trendInRet,
    JSON.stringify({ ret, trendInRet, bodyInRet }));
}

if (failures > 0) { console.error(`\ninvestments-order: ${failures} failure(s).`); process.exit(1); }
console.log("\ninvestments-order: all passed.");
