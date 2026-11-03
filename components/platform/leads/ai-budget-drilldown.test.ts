/**
 * components/platform/leads/ai-budget-drilldown.test.ts  (AI & Costs — budget KPI follow-ups)
 *
 *   1. the budget KPI and the Budget utilisation card open the per-call records;
 *      the drawer's state (open · window end · page) survives a refresh in the URL
 *      (the PB-9 idiom: same parser as the route, REPLACE, workspace-scoped);
 *   2. the records table: unpriced / not-counted calls are never $0; the summary
 *      reads the KPI's own words;
 *   3. the hero says "Budget tiles cover the last 24 h" beside the 30 d spend;
 *   4. the shared provenance chip has "Unavailable", used by UNAVAILABLE tiles,
 *      and every other kind's words are unchanged;
 *   5. a 0 / unset fleet threshold reads "No threshold set", never "0% of $0.00".
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/leads/ai-budget-drilldown.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ESTIMATE_NOT_BILLING, type AiBudgetUtilization } from "@/lib/platform/ai/cost-controls.types";
import { fleetSpendStatus } from "@/lib/platform/ai/fleet-spend-status";
import type { BudgetCallRow, BudgetCallsResponse } from "@/lib/platform/ai/budget-calls-core";
import { SPACE_URL_PARAMS } from "@/lib/space/space-url";
import { PLATFORM_WORKSPACE_SCOPED_PARAMS } from "@/lib/space/use-platform-workspace-navigation";
import { ProvenanceChip, provenanceText } from "../ui/ProvenanceChip";
import { HealthHero } from "../ops-visual/HealthHero";
import { AiCostsLeadSurface, BUDGET_SCOPE_NOTE } from "./AiCostsLead";
import { AiBudgetCallsTable, callCostText, callOutcomeText, callsPopulationLine } from "./AiBudgetCalls";
import { aiKpis, budgetMeter, budgetMeterOf, budgetTileText } from "./ai-costs-model";
import {
  AI_BUDGET_CALLS_URL_PARAMS, CLOSED_CALLS, aiBudgetCallsApiPath, aiBudgetCallsUrlUpdate, openBudgetCalls, readAiBudgetCallsUrl,
} from "./ai-budget-calls-url";
import { fleetReading, thresholdText } from "../widgets/ai-budget-view";
import { AiBudgetSurface } from "../widgets/OpsAiBudgetWidget";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = "2026-10-15T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const H = 3_600_000;
const ok = <T,>(data: T) => ({ data, loading: false, error: null });
const failed = (error: string) => ({ data: null, loading: false, error });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");

function budget(fleet: { usd: number | null; calls: number; unpriced?: number; thresholdUsd?: number }): AiBudgetUtilization {
  const threshold = fleet.thresholdUsd ?? 10;
  const unpriced = fleet.unpriced ?? 0;
  return {
    checkedAt: NOW, windowHours: 24,
    fleet: {
      estimatedUsd: fleet.usd, thresholdUsd: threshold, alertEnabled: true,
      utilizationPct: fleet.usd === null || threshold <= 0 ? null : Math.round((fleet.usd / threshold) * 1000) / 10,
      invocations: fleet.calls, customers: fleet.calls > 0 ? 2 : 0,
    },
    overhead: { estimatedUsd: null, invocations: 0 },
    customers: [{ ref: "user …abc123", rolling24hUsd: 1, todayUsd: 0.5, allowanceUsd: 0, allowanceSource: "POLICY", allowanceUtilizationPct: null, alertUtilizationPct: null }],
    bySurface: [
      { surface: "chat", customer: true, estimatedUsd: fleet.usd, invocations: fleet.calls, unpricedInvocations: unpriced },
      { surface: "brief", customer: true, estimatedUsd: null, invocations: 0, unpricedInvocations: 0 },
    ],
    unpriced: { invocations: unpriced, models: [] },
    recentAlerts: [],
    controls: { allowanceEnforced: true, allowanceDefaultUsd: 5, userAlertEnabled: true, userAlertThresholdUsd: 3, paused: false },
    estimateNote: ESTIMATE_NOT_BILLING,
  };
}

const lead = (b: AiBudgetUtilization | null, over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AiCostsLeadSurface, {
  trend: failed("x"), spend: failed("x"), inv7: failed("x"), inv30: failed("x"), budget: b ? ok(b) : failed("x"), plaid: failed("x"), apiUsage: failed("x"),
  nowMs: NOW_MS, hasHosted: () => true, onOpenDrawer: () => {}, onOpenBudgetCalls: () => {}, ...over,
} as never));
const budgetCard = (html: string) => /id="ai-budget"[\s\S]*?id="ai-customers"/.exec(html)?.[0] ?? "";

console.log("1. the KPI and the card open the per-call records; the state lives in the URL");
{
  const html = lead(budget({ usd: 4.2, calls: 120 }));
  check("the Budget used KPI is a button that opens the calls drawer", /aria-label="Budget used: 42%[^"]*— Open the calls in this 24 h window"[^>]*aria-haspopup="dialog"|aria-haspopup="dialog"[^>]*aria-label="Budget used: 42%[^"]*— Open the calls in this 24 h window"/.test(html));
  check("the Budget utilisation card carries a 'Calls' doorway beside Budget & controls", /Calls/.test(text(budgetCard(html))) && /Budget &amp; controls|Budget & controls/.test(budgetCard(html)));
  const legacy = lead(budget({ usd: 4.2, calls: 120 }), { onOpenBudgetCalls: undefined });
  check("without a calls host the KPI keeps opening Budget & controls (no dead click)", /— Open budget &amp; controls"/.test(legacy));

  check("the three params are registered Space params and workspace-scoped", AI_BUDGET_CALLS_URL_PARAMS.every((k) => (SPACE_URL_PARAMS as readonly string[]).includes(k) && PLATFORM_WORKSPACE_SCOPED_PARAMS.includes(k)));
  const opened = openBudgetCalls(NOW);
  check("opening from the KPI pins the window end to its checkedAt, page 1", opened.open && opened.untilMs === NOW_MS && opened.page === 1);
  const u = aiBudgetCallsUrlUpdate({ ...opened, page: 3 });
  check("URL update: aicalls=budget, aiuntil=<ms>, aipage=3", u.aicalls === "budget" && u.aiuntil === String(NOW_MS) && u.aipage === "3");
  const search = "?" + new URLSearchParams(Object.entries(u).filter(([, v]) => v !== null) as [string, string][]).toString();
  const back = readAiBudgetCallsUrl(search, NOW_MS + H);
  check("a refresh reads back the SAME window and page", back.open && back.untilMs === NOW_MS && back.page === 3);
  check("closed ⇒ every key deleted (a clean URL)", Object.values(aiBudgetCallsUrlUpdate(CLOSED_CALLS)).every((v) => v === null));
  check("the API path carries the window end and the page", aiBudgetCallsApiPath(back) === `/api/platform/platform-ops/ai-budget/calls?until=${NOW_MS}&page=3`);
  const stale = readAiBudgetCallsUrl(`?aicalls=budget&aiuntil=${NOW_MS - 30 * 24 * H}&aipage=x`, NOW_MS);
  check("a refused aiuntil / aipage is dropped (opens the current window, page 1), never an error", stale.open && stale.untilMs === null && stale.page === 1);
  check("an unknown aicalls value is closed", !readAiBudgetCallsUrl("?aicalls=everything", NOW_MS).open);
}

console.log("\n2. the records table — never $0 for an unpriced or failed call; the KPI's own words");
{
  const row = (over: Partial<BudgetCallRow>): BudgetCallRow => ({ id: `r${Math.random()}`, occurredAt: NOW, surface: "chat", provider: "OPENAI", model: "gpt-5.1", promptTokens: 1200, cachedPromptTokens: 200, completionTokens: 90, outcome: "RETURNED", errorCode: null, customerRef: "user …abc123", pricing: "PRICED", costUsd: 0.0021, ...over });
  check("cost cell: PRICED ⇒ dollars; UNPRICED ⇒ 'unpriced'; NO_TOKENS ⇒ 'no tokens'; NOT_COUNTED ⇒ 'not counted'",
    callCostText(row({})) === "$0.0021" && callCostText(row({ pricing: "UNPRICED", costUsd: null })) === "unpriced"
      && callCostText(row({ pricing: "NO_TOKENS", costUsd: null })) === "no tokens" && callCostText(row({ pricing: "NOT_COUNTED", costUsd: null })) === "not counted");
  check("outcome cell names the failure and its code", callOutcomeText(row({ outcome: "RATE_LIMITED", errorCode: "429" })) === "Rate-limited · 429" && callOutcomeText(row({})) === "Returned");
  const b = budget({ usd: 4.2, calls: 3, unpriced: 1 });
  const status = { ...fleetSpendStatus(b), customers: 2 };
  const data: BudgetCallsResponse = {
    window: { since: new Date(NOW_MS - 24 * H).toISOString(), until: NOW, hours: 24 },
    summary: status,
    page: { rows: [row({}), row({ model: "model-x", pricing: "UNPRICED", costUsd: null }), row({ outcome: "TIMEOUT", errorCode: "abort", promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, pricing: "NOT_COUNTED", costUsd: null, customerRef: null })], total: 3, page: 1, pageSize: 25 },
    counts: { returned: 2, notCounted: 1 },
    estimateNote: ESTIMATE_NOT_BILLING,
  };
  const html = renderToStaticMarkup(createElement(AiBudgetCallsTable, { data, onPage: () => {} }));
  const t = text(html);
  check("columns: time · surface · model · in · out · cached · cost · outcome · customer", ["Time", "Surface", "Model", "In", "Out", "Cached", "Cost", "Outcome", "Customer"].every((h) => html.includes(`>${h}</th>`)));
  check("no $0 anywhere in the table", !/\$0(\.0+)?(?![.\d])/.test(t), t);
  check("the unpriced and not-counted rows say so", /data-call-pricing="UNPRICED"[\s\S]*?unpriced/.test(html) && /data-call-pricing="NOT_COUNTED"[\s\S]*?not counted/.test(html));
  check("a call without a user reads 'customer' (identity-free)", />customer</.test(html) && !/@/.test(t));
  const kpiText = budgetTileText(budgetMeter(b)!);
  check("the summary headline + detail are the KPI card's own words", new RegExp(`data-budget-calls-headline(="[a-z]*")?>${kpiText.headline}<`).test(html) && t.includes(kpiText.detail));
  check("population line counts returned vs not counted from the server's figures", callsPopulationLine(data) === "Showing 1–3 of 3 calls · 2 returned (counted) · 1 not counted");
  check("the page states its exact window", /Window 2026-10-14 12:00 – 2026-10-15 12:00 UTC/.test(t));
}

console.log("\n3. the hero says the budget tiles' window beside the 30 d spend");
{
  const html = lead(budget({ usd: 4.2, calls: 120 }));
  check(`"${BUDGET_SCOPE_NOTE}" renders in the hero (compact + desktop)`, (html.match(/data-hero-scope-note/g) ?? []).length === 2 && html.includes(BUDGET_SCOPE_NOTE) && /AI spend · 30 d/.test(html));
  const other = renderToStaticMarkup(createElement(HealthHero, { model: { verdict: { word: "ok", tone: "ok" }, checked: null, caption: "c", kpis: [] } }));
  check("a hero without a scope note renders none (every other hero unchanged)", !/data-hero-scope-note/.test(other));
}

console.log("\n4. the provenance chip — 'Unavailable', used by UNAVAILABLE tiles; other kinds unchanged");
{
  check("UNAVAILABLE ⇒ 'Unavailable'", provenanceText("UNAVAILABLE") === "Unavailable" && renderToStaticMarkup(createElement(ProvenanceChip, { kind: "UNAVAILABLE" })).includes('data-provenance="UNAVAILABLE"'));
  check("MEASURED / ESTIMATED / ASSUMED / UNKNOWN words unchanged",
    provenanceText("MEASURED") === "Measured" && provenanceText("ESTIMATED") === "Estimated" && provenanceText("ASSUMED") === "Assumed" && provenanceText("UNKNOWN") === "Unknown"
      && provenanceText("ESTIMATED", "2026-10-15T14:02:00Z") === "Estimated · as of 14:02 UTC");
  const none = budgetCard(lead(budget({ usd: null, calls: 0 })));
  check("an UNAVAILABLE budget card carries the Unavailable chip", /data-provenance="UNAVAILABLE"/.test(none) && !/data-provenance="UNKNOWN"/.test(none));
  const priced = budgetCard(lead(budget({ usd: 4.2, calls: 120 })));
  check("an estimated card keeps the Estimated chip", /data-provenance="ESTIMATED"/.test(priced));
  check("a failed budget read stays Unknown (no authority answered)", /data-provenance="UNKNOWN"/.test(budgetCard(lead(null))));
}

console.log("\n5. a 0 / unset fleet threshold — 'No threshold set', never '0% of $0.00'");
{
  for (const [name, b] of [["$0 threshold", budget({ usd: 4.2, calls: 120, thresholdUsd: 0 })], ["unset threshold", { ...budget({ usd: 4.2, calls: 120 }), fleet: { ...budget({ usd: 4.2, calls: 120 }).fleet, thresholdUsd: undefined as unknown as number, utilizationPct: null } }]] as const) {
    const s = fleetSpendStatus(b);
    check(`${name}: status ESTIMATED with its figure, thresholdSet false, no utilisation`, s.status === "ESTIMATED" && s.pricedUsd === 4.2 && !s.thresholdSet && s.utilisationPct === null);
    const kpi = aiKpis({ budget: ok(b) as never, inv7: failed("x") as never }).find((k) => k.key === "budget")!;
    check(`${name}: KPI is the figure with 'no threshold set', never a %`, kpi.value === "$4.20" && /no threshold set/.test(kpi.sub) && !/%/.test(`${kpi.value} ${kpi.sub}`), `${kpi.value} | ${kpi.sub}`);
    const card = text(budgetCard(lead(b)));
    check(`${name}: card headline 'No threshold set', no '0%' and no '$0.00'`, /No threshold set/.test(card) && !/\b0%/.test(card) && !/\$0\.00/.test(card), card);
    check(`${name}: no meter is drawn against a missing threshold`, !/role="meter" aria-label="Fleet AI budget used/.test(budgetCard(lead(b))));
    const r = fleetReading(b);
    check(`${name}: drawer qualifier 'No threshold set', never '0% of the $0'`, r.kind === "figure" && /No threshold set/.test(r.qualifier) && !/of the \$0/.test(r.qualifier) && r.pct === null);
    const d = text(renderToStaticMarkup(createElement(AiBudgetSurface, { section: { id: "s", key: "ops_ai_budget", label: "AI Budget" } as never, data: b })));
    check(`${name}: drawer threshold line 'No threshold set'; no '0% of $0'`, /No threshold set · alert enabled/.test(d) && !/0% of (the )?\$0/.test(d));
  }
  check("thresholdText: $10 ⇒ 'Threshold $10 / 24 h'; 0 ⇒ 'No threshold set'", thresholdText({ thresholdUsd: 10, alertEnabled: true }, 24) === "Threshold $10 / 24 h · alert enabled" && thresholdText({ thresholdUsd: 0, alertEnabled: false }, 24) === "No threshold set · alert disabled");
  const partial = budgetTileText(budgetMeterOf(fleetSpendStatus(budget({ usd: 4.2, calls: 120, unpriced: 3, thresholdUsd: 0 }))));
  check("partial + no threshold: '≥$4.20', 'No threshold set', the unpriced count", partial.kpiValue === "≥$4.20" && partial.headline === "No threshold set" && /3 unpriced calls/.test(partial.kpiSub));
  const zeroAllowance = text(renderToStaticMarkup(createElement(AiBudgetSurface, { section: { id: "s", key: "ops_ai_budget", label: "AI Budget" } as never, data: budget({ usd: 4.2, calls: 120 }) })));
  check("a $0 allowance (pct null) reads 'no allowance', never '0%'", /\$0\.50 of \$0 \(no allowance, policy group\)/.test(zeroAllowance) && /no threshold set\)/.test(zeroAllowance), zeroAllowance.slice(0, 400));
  check("the lead's customer row draws no 0% meter for a $0 allowance", /aria-label="user …abc123 has no allowance"/.test(lead(budget({ usd: 4.2, calls: 120 }))));
}

if (failures > 0) { console.error(`\nai-budget-drilldown: ${failures} check(s) failed.`); process.exit(1); }
console.log("\nai-budget-drilldown: all checks passed.");
