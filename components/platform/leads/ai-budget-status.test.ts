/**
 * components/platform/leads/ai-budget-status.test.ts  (AI & Costs — ONE fleet spend status)
 *
 * The AI & Costs budget tiles once contradicted each other: "Budget used —
 * spend unpriced" and "Unknown of $10.00" beside a priced 30-day figure. Every
 * fleet-budget tile now reads ONE computed object (lib/platform/ai/fleet-spend-status.ts):
 *
 *   ESTIMATED    every call priced — "42%", an estimate
 *   PARTIAL      some calls unpriced — "≥42%", "at least $X", the unpriced count
 *   UNAVAILABLE  nothing priced — no figure, no %, never $0, never "Unknown of $10.00"
 *   MEASURED     never produced: no invoice is read, a fully priced window is ESTIMATED
 *
 * and the hero KPI, the Budget utilisation card and the Economics → AI Budget
 * drawer agree on every fixture. Missing telemetry is never $0. No DB, no network.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/leads/ai-budget-status.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ESTIMATE_NOT_BILLING, type AiBudgetUtilization } from "@/lib/platform/ai/cost-controls.types";
import { FLEET_REASON_NO_CALLS, FLEET_REASON_NONE_PRICED, fleetSpendStatus } from "@/lib/platform/ai/fleet-spend-status";
import { aiKpis, budgetMeter, budgetTileText } from "./ai-costs-model";
import { AiCostsLeadSurface } from "./AiCostsLead";
import { fleetReading } from "../widgets/ai-budget-view";
import { AiBudgetSurface } from "../widgets/OpsAiBudgetWidget";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = "2026-10-15T12:00:00.000Z";
const ok = <T,>(data: T) => ({ data, loading: false, error: null });
const failed = (error: string) => ({ data: null, loading: false, error });

/** A fleet window: `priced` USD over `calls` customer calls, `unpriced` of them without a rate. */
function budget(fleet: { usd: number | null; calls: number; unpriced?: number; thresholdUsd?: number }): AiBudgetUtilization {
  const threshold = fleet.thresholdUsd ?? 10;
  const unpriced = fleet.unpriced ?? 0;
  return {
    checkedAt: NOW, windowHours: 24,
    fleet: {
      estimatedUsd: fleet.usd, thresholdUsd: threshold, alertEnabled: true,
      utilizationPct: fleet.usd === null ? null : Math.round((fleet.usd / threshold) * 1000) / 10,
      invocations: fleet.calls, customers: fleet.calls > 0 ? 2 : 0,
    },
    overhead: { estimatedUsd: null, invocations: 0 },
    customers: [],
    bySurface: [
      { surface: "chat", customer: true, estimatedUsd: fleet.usd, invocations: fleet.calls, unpricedInvocations: unpriced },
      { surface: "brief", customer: true, estimatedUsd: null, invocations: 0, unpricedInvocations: 0 },
      { surface: "harness", customer: false, estimatedUsd: null, invocations: 0, unpricedInvocations: 0 },
      { surface: "other", customer: false, estimatedUsd: null, invocations: 0, unpricedInvocations: 0 },
    ],
    unpriced: { invocations: unpriced, models: unpriced > 0 ? ["OPENAI:model-x"] : [] },
    recentAlerts: [],
    controls: { allowanceEnforced: true, allowanceDefaultUsd: 5, userAlertEnabled: true, userAlertThresholdUsd: 3, paused: false },
    estimateNote: ESTIMATE_NOT_BILLING,
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
/** The 30-day surface donut is priced ($1.62) — the Preview shape where the budget tile contradicted it. */
const spend30 = ok({ spend: { customer: { chat: { usd: 1.2 }, brief: { usd: 0.42 }, total: { usd: 1.62 } }, overhead: { harness: { usd: null }, other: { usd: null }, total: { usd: null } }, unpriced: { tokens: 0, invocations: 0, models: [] }, byDay: [], window: { days: 30, from: "2026-09-16", to: "2026-10-15" } }, safeguards: {} });
const leadHtml = (b: ReturnType<typeof ok<AiBudgetUtilization>> | ReturnType<typeof failed>) => renderToStaticMarkup(createElement(AiCostsLeadSurface, {
  trend: failed("x"), spend: spend30, inv7: failed("x"), inv30: failed("x"), budget: b, plaid: failed("x"), apiUsage: failed("x"),
  nowMs: Date.parse(NOW), hasHosted: () => true, onOpenDrawer: () => {},
} as never));
const budgetCard = (html: string) => text(/<section[^>]*id="ai-budget"[\s\S]*?<\/section>|id="ai-budget"[\s\S]*?id="ai-customers"/.exec(html)?.[0] ?? "");
const drawerHtml = (b: AiBudgetUtilization) => renderToStaticMarkup(createElement(AiBudgetSurface, { section: { id: "s", key: "ops_ai_budget", label: "AI Budget" } as never, data: b }));

/** The three tiles' readings of one fixture. */
function tiles(b: AiBudgetUtilization) {
  const kpi = aiKpis({ budget: ok(b) as never, inv7: failed("x") as never }).find((k) => k.key === "budget")!;
  const m = budgetMeter(b)!;
  const card = budgetTileText(m);
  const drawer = fleetReading(b);
  return { status: fleetSpendStatus(b), kpi, m, card, drawer };
}

console.log("1. ESTIMATED — every call priced: utilisation = estimate ÷ threshold, labelled an estimate");
{
  const t = tiles(budget({ usd: 4.2, calls: 120 }));
  check("status ESTIMATED, priced $4.20, 42%, not a lower bound", t.status.status === "ESTIMATED" && t.status.pricedUsd === 4.2 && t.status.utilisationPct === 42 && !t.status.atLeast);
  check("KPI '42%' · 'of $10.00 · 24 h · estimated'", t.kpi.value === "42%" && t.kpi.sub === "of $10.00 · 24 h · estimated", `${t.kpi.value} | ${t.kpi.sub}`);
  check("card '42%' · '$4.20 of $10.00 · 24 h · estimated'", t.card.headline === "42%" && t.card.detail === "$4.20 of $10.00 · 24 h · estimated", t.card.detail);
  check("drawer figure $4.20, 42% of the threshold, ESTIMATED", t.drawer.kind === "figure" && t.drawer.status === "ESTIMATED" && t.drawer.value === "$4.20" && /^42% of the \$10 fleet alert threshold/.test(t.drawer.qualifier));
}

console.log("\n2. MEASURED — no invoice is read, so a fully priced window is ESTIMATED, never MEASURED");
{
  for (const [usd, calls] of [[0.5, 3], [9.99, 400], [25, 1000]] as const) {
    const s = fleetSpendStatus(budget({ usd, calls }));
    check(`fully priced $${usd} over ${calls} calls ⇒ ESTIMATED (MEASURED is never produced)`, s.status === "ESTIMATED" && (s.status as string) !== "MEASURED");
  }
}

console.log("\n3. PARTIAL — priced + unpriced: the priced portion, the unpriced count, 'at least'");
{
  const t = tiles(budget({ usd: 4.2, calls: 120, unpriced: 7 }));
  check("status PARTIAL, priced $4.20 a lower bound, 7 unpriced counted", t.status.status === "PARTIAL" && t.status.pricedUsd === 4.2 && t.status.atLeast && t.status.unpricedInvocations === 7);
  check("KPI '≥42%' · 'at least $4.20' · '7 unpriced calls'", t.kpi.value === "≥42%" && /partial · at least \$4\.20 of \$10\.00 · 24 h · 7 unpriced calls/.test(t.kpi.sub), t.kpi.sub);
  check("card '≥42%' · 'at least $4.20 … 7 unpriced calls not counted'", t.card.headline === "≥42%" && /^at least \$4\.20 of \$10\.00 · 24 h · partial · 7 unpriced calls not counted$/.test(t.card.detail), t.card.detail);
  check("drawer 'at least $4.20', 'at least 42%', the unpriced count named", t.drawer.kind === "figure" && t.drawer.status === "PARTIAL" && t.drawer.value === "at least $4.20" && /at least 42% of the \$10 fleet alert threshold · partial — 7 unpriced invocations not counted/.test(t.drawer.qualifier));
  check("the Money handed to the card is ESTIMATED + partial", t.m.spend.kind === "ESTIMATED" && t.m.spend.partial);
  const one = tiles(budget({ usd: 1, calls: 5, unpriced: 1 }));
  check("singular: '1 unpriced call'", /1 unpriced call(?!s)/.test(one.kpi.sub) && /1 unpriced invocation not counted/.test(one.drawer.qualifier));
}

console.log("\n4. UNAVAILABLE — nothing priced: no figure, no %, never $0, never 'Unknown of $10.00'");
{
  const none = tiles(budget({ usd: null, calls: 0 }));
  check("no calls ⇒ UNAVAILABLE with that reason", none.status.status === "UNAVAILABLE" && none.status.reason === FLEET_REASON_NO_CALLS && none.status.pricedUsd === null && none.status.utilisationPct === null);
  check("no calls ⇒ KPI '—' 'unavailable · no calls · 24 h'", none.kpi.value === "—" && none.kpi.sub === "unavailable · no calls · 24 h" && none.kpi.tone === "muted", none.kpi.sub);
  check("no calls ⇒ card 'Unavailable' with the reason and the threshold", none.card.headline === "Unavailable" && none.card.detail === `${FLEET_REASON_NO_CALLS} · threshold $10.00 / 24 h`);
  const unp = tiles(budget({ usd: null, calls: 12, unpriced: 12 }));
  check("calls but none priced ⇒ UNAVAILABLE with the pricing reason", unp.status.status === "UNAVAILABLE" && unp.status.reason === FLEET_REASON_NONE_PRICED && unp.status.unpricedInvocations === 12);
  check("none priced ⇒ KPI '—' '12 unpriced calls, none priced'", unp.kpi.value === "—" && /12 unpriced calls, none priced/.test(unp.kpi.sub), unp.kpi.sub);
  check("none priced ⇒ drawer unavailable, same reason", unp.drawer.kind === "unavailable" && unp.drawer.reason === FLEET_REASON_NONE_PRICED);
  for (const [name, b] of [["no calls", budget({ usd: null, calls: 0 })], ["none priced", budget({ usd: null, calls: 12, unpriced: 12 })]] as const) {
    const card = budgetCard(leadHtml(ok(b)));
    check(`${name}: budget card has no $0, no 'Unknown of', no 'spend unpriced', no %`, card.length > 0 && !/\$0\.00|\$0(?![.\d])/.test(card) && !/Unknown of/.test(card) && !/spend unpriced/.test(card) && !/\d%/.test(card), card);
    const all = text(leadHtml(ok(b)));
    check(`${name}: beside the priced $1.62 30-day donut, the page never says 'Unknown of $10.00'`, /\$1\.62/.test(all) && !/Unknown of \$10/.test(all) && !/spend unpriced/.test(all));
    const d = text(drawerHtml(b));
    check(`${name}: drawer shows no $0 fleet figure and no utilisation %`, !/Fleet · rolling 24 h estimate \$0/.test(d) && !/threshold: \d/.test(d), d.slice(0, 300));
  }
}

console.log("\n5. Every tile reads the same computed object — they cannot disagree");
{
  const fixtures: [string, AiBudgetUtilization][] = [
    ["estimated", budget({ usd: 4.2, calls: 120 })],
    ["estimated · over threshold", budget({ usd: 12.4, calls: 300 })],
    ["partial", budget({ usd: 4.2, calls: 120, unpriced: 7 })],
    ["unavailable · no calls", budget({ usd: null, calls: 0 })],
    ["unavailable · none priced", budget({ usd: null, calls: 9, unpriced: 9 })],
  ];
  for (const [name, b] of fixtures) {
    const t = tiles(b);
    const s = t.status;
    const kpiPct = /(\d+)%/.exec(t.kpi.value)?.[1] ?? null;
    const cardPct = /(\d+)%/.exec(t.card.headline)?.[1] ?? null;
    const want = s.utilisationPct === null ? null : String(Math.round(s.utilisationPct));
    check(`${name}: KPI %, card %, meter pct, drawer pct = the status's ${want ?? "none"}`,
      kpiPct === want && cardPct === want && (t.m.pct === null ? null : String(Math.round(t.m.pct))) === want && (t.drawer.pct === null ? null : String(Math.round(t.drawer.pct))) === want,
      `${kpiPct} ${cardPct} ${t.m.pct} ${t.drawer.pct}`);
    const drawerStatus = t.drawer.status;
    check(`${name}: KPI, card and drawer name the same status (${s.status})`,
      drawerStatus === s.status && t.m.status.status === s.status
        && (s.status === "UNAVAILABLE" ? t.kpi.value === "—" && t.card.headline === "Unavailable" : s.status === "PARTIAL" ? t.kpi.value.startsWith("≥") && t.card.headline.startsWith("≥") : !t.kpi.value.startsWith("≥")));
    const html = leadHtml(ok(b));
    check(`${name}: the rendered card carries data-fleet-spend-status=${s.status}`, html.includes(`data-fleet-spend-status="${s.status}"`));
  }
}

console.log("\n6. Missing telemetry is never $0");
{
  const unread = aiKpis({ budget: failed("x") as never, inv7: failed("x") as never }).find((k) => k.key === "budget")!;
  check("budget read failed ⇒ KPI '—' unavailable, never 0", unread.value === "—" && unread.sub === "unavailable" && !/\$0|0%/.test(`${unread.value} ${unread.sub}`));
  check("budget read failed ⇒ card says 'Budget unavailable', no figure", /Budget unavailable/.test(budgetCard(leadHtml(failed("timeout")))) && !/\$0/.test(budgetCard(leadHtml(failed("timeout")))));
  check("budgetMeter(null) ⇒ null (nothing invented)", budgetMeter(null) === null);
  const s = fleetSpendStatus(budget({ usd: null, calls: 40, unpriced: 40 }));
  check("an absent fleet figure stays null — pricedUsd and utilisation are null, not 0", s.pricedUsd === null && s.utilisationPct === null);
  // A fleet figure the reader did price is kept even when tiny — a real estimate is not hidden.
  const tiny = fleetSpendStatus(budget({ usd: 0.004, calls: 1 }));
  check("a tiny priced figure stays ESTIMATED (not UNAVAILABLE, not zeroed)", tiny.status === "ESTIMATED" && tiny.pricedUsd === 0.004);
}

if (failures > 0) { console.error(`\nai-budget-status: ${failures} check(s) failed.`); process.exit(1); }
console.log("\nai-budget-status: all checks passed.");
