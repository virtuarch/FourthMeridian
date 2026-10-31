/**
 * lib/platform/merchant/overview-core.test.ts  (Platform Spaces 2.0 — Merchant Operations)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/merchant/overview-core.test.ts
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildMerchantOverview } from "./overview-core";
import { MerchantLeadSurface } from "@/components/platform/leads/MerchantLead";
import { coveragePct, merchantKpis, sourceBars } from "@/components/platform/leads/merchant-model";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const NOW = new Date("2026-11-20T15:00:00.000Z");
const m = buildMerchantOverview({
  totalTransactions: 200, resolvedTransactions: 150,
  bySource: [{ key: "PLAID_PFC", count: 120 }, { key: null, count: 50 }, { key: "USER_RULE", count: 30 }],
  merchants: 40, aliasesBySource: [{ source: "PLAID", count: 60 }, { source: "USER", count: 5 }], userRules: 7,
  decisions: [{ day: "2026-11-19", verdict: "MERGED", count: 2 }, { day: "2026-11-19", verdict: "DISMISSED", count: 1 }, { day: "2026-01-01", verdict: "MERGED", count: 9 }],
  byTier: [{ tier: "T1", verdict: "MERGED", count: 3 }, { tier: "T1", verdict: "DISMISSED", count: 1 }, { tier: "T2", verdict: "DISMISSED", count: 2 }],
  aliasDays: [{ day: "2026-11-20", count: 4 }], ruleDays: [{ day: "2026-11-20", count: 1 }],
}, NOW, 30);

console.log("1. core");
check("decisions in the window only", m.decisions.merged === 2 && m.decisions.dismissed === 1);
check("tiers merged/dismissed, all time", JSON.stringify(m.decisions.byTier) === JSON.stringify([{ tier: "T1", merged: 3, dismissed: 1 }, { tier: "T2", merged: 0, dismissed: 2 }]));
check("null provenance reads 'not recorded', ranked", m.transactions.bySource[1].key === "none" && /Not recorded/.test(m.transactions.bySource[1].label));
check("growth per day", m.growth.days[29].aliases === 4 && m.growth.days[29].rules === 1);
check("states plainly that no payments are processed", m.notes.some((x) => /does not process payments/.test(x)));
console.log("2. model + surface");
check("coverage 75%", coveragePct(m) === 75);
check("provenance shares of ALL transactions", sourceBars(m)[0].share === 0.6 && sourceBars(m)[1].muted === true);
check("failed read → '—' KPIs", merchantKpis({ data: null, loading: false, error: "x" }).every((k) => k.value === "—"));
const html = renderToStaticMarkup(createElement(MerchantLeadSurface, { f: { data: m, loading: false, error: null }, period: "30", onPeriod: () => {} }));
check("hero, review link to /merchant-ops, provenance bars, decision bars", html.includes("75% resolved") && html.includes('href="/merchant-ops"') && html.includes("data-share-bars") && html.includes("data-day-bars"));
check("no payment / settlement / processing figures implied", !/settle|payment volume|processing (failure|success)|chargeback/i.test(html.replace(/processes no payments/g, "")));
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
