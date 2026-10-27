/**
 * components/space/widgets/cashflow/perspective-ux-pass.test.ts  (v2.7 FINAL PERSPECTIVE UX PASS)
 *
 * Owner decisions 1–5 + the Cash Flow / Spending page orders, as pure and render
 * checks (house pattern: standalone tsx, exits 0/1):
 *
 *   A. per-group time — Net Worth vs flow (Cash Flow · Spending) independence,
 *      URL round-trip of BOTH groups (reload / Back-Forward are pure hydrations of
 *      the URL), explicit shared links win, legacy Cash Flow links, UTC midnight
 *      (rolling advances, pinned + explicit calendar units stay), 1M default;
 *   B. header ⇄ heatmap — Month · Quarter · Year are three distinct windows, the
 *      stepper's edges, a header action ends the heatmap's unit, and the header
 *      readout names the heatmap's unit;
 *   C. Cash Flow vs Spending semantics on the reconciled Preview fixture shape
 *      (cash in 500 · out 117.46 · net 382.54 vs spending 3,774.46), card payment
 *      not spending, refund once per axis, unresolved transfers in neither;
 *   D. the Spending donut reconciles exactly (or states its adjustment);
 *   E. Markets shows no global reporting-period picker;
 *   F. page order, no hero toggle, no Cards view, no persistent Compare To hint.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/widgets/cashflow/perspective-ux-pass.test.ts
 */

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FLOW_PERIOD_PARAM, TIME_GROUP_PARAMS, calendarNavigation, defaultGroupedShellTime, explicitPeriodBounds,
  explicitPeriodContaining, groupPeriod, hydrateGroupedShellTime, parseExplicitPeriodKey, explicitPeriodKey,
  reduceGroupTime, rollGroupedShellTime, serializeGroupedShellTime, setGroupExplicit, stepExplicitPeriod, timeGroupFor,
  type GroupedShellTime,
} from "@/lib/space/perspective-time-groups";
import { DEFAULT_TIME_PRESET, resolvePerspectiveTimeRange } from "@/lib/perspectives/time-range";
import { applySpaceUrlUpdate } from "@/lib/space/space-url";
import { summarizeExplicitPeriod, shortExplicitPeriodLabel } from "@/components/space/shell/perspective-time-adapter";
import { PerspectiveShell } from "@/components/space/shell/PerspectiveShell";
import { buildCashFlowSpaceData } from "@/lib/transactions/cash-flow-space-data";
import { economicSpendByTier } from "@/lib/transactions/cash-flow-projection";
import { spendingDonutModel, sliceShares } from "./spending-distribution";
import { SpendingDistribution, SpendingHero, SPENDING_HERO_SUB } from "./SpendingSections";
import { CashFlowHero, CASH_FLOW_HERO_SUB } from "./CashFlowHero";
import { movementLines } from "./CashFlowMovements";
import { CORE_LENS_IDS, lensHref, parsePerspectiveParam } from "@/lib/space/use-space-navigation";
import { PERSPECTIVE_LIBRARY } from "@/lib/perspectives";
import { openPerspectiveDataNeeds } from "@/lib/space/workspace-resources";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&rsquo;/g, "’").replace(/\s+/g, " ").trim();

const TODAY = "2026-10-27";
const COVER = "2025-01-01";
const ctx = { today: TODAY, coverageFrom: COVER };
const urlOf = (g: GroupedShellTime, base = "tab=overview", today = TODAY) => applySpaceUrlUpdate(base, serializeGroupedShellTime(g, today));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── A. per-group time ─────────────────────────────────────────────────────────
console.log("A. per-perspective-group time");
{
  check("groups: Net Worth / other tabs ⇒ position; Cash Flow + Spending ⇒ flow",
    timeGroupFor("OVERVIEW", "wealth") === "position" && timeGroupFor("OVERVIEW", "markets") === "position"
      && timeGroupFor("TRANSACTIONS", null) === "position" && timeGroupFor("OVERVIEW", "cashFlow") === "flow"
      && timeGroupFor("OVERVIEW", "spending") === "flow" && timeGroupFor("ACCOUNTS", "cashFlow") === "position");
  const d = defaultGroupedShellTime(TODAY);
  check("both groups default to 1M (PAST_MONTH — the '1 month' preset), rolling at today",
    DEFAULT_TIME_PRESET === "PAST_MONTH" && d.flow.time.preset === "PAST_MONTH" && d.position.time.preset === "PAST_MONTH" && d.flow.time.asOf === TODAY);
  check("Cash Flow's and Spending's period default is 1M", groupPeriod(d.flow) === "PAST_MONTH");

  // Changing the flow period never moves Net Worth's, and vice versa.
  const flowYtd: GroupedShellTime = { ...d, flow: reduceGroupTime(d.flow, { type: "selectPreset", preset: "YTD" }, ctx) };
  check("a flow change leaves the position group untouched", flowYtd.position === d.position && flowYtd.flow.time.preset === "YTD");
  const nwPast: GroupedShellTime = { ...flowYtd, position: reduceGroupTime(flowYtd.position, { type: "setAsOf", asOf: "2026-06-30" }, ctx) };
  check("a Net Worth change leaves the flow group untouched", nwPast.flow === flowYtd.flow && nwPast.position.time.asOf === "2026-06-30");

  // URL: both groups, separate params, round-trip (= reload, = Back/Forward re-hydration).
  const url = urlOf(nwPast);
  const q = new URLSearchParams(url);
  check("each group writes ONLY its own params", q.get("preset") === "PAST_MONTH" && q.get("asof") === "2026-06-30" && q.get("fpreset") === "YTD" && !q.has("fasof"),
    url);
  check("reload (hydrate the URL) restores BOTH groups exactly", same(hydrateGroupedShellTime(url, ctx), nwPast));
  check("rolling As Of is omitted for each group (#57)", !q.has("fasof") && !q.has("fcompareto"));
  check("flow params are distinct names", TIME_GROUP_PARAMS.flow.preset === "fpreset" && FLOW_PERIOD_PARAM === "fperiod");

  // Back/Forward: two history entries hydrate independently; no leakage.
  const entryA = urlOf(d);
  const entryB = urlOf(flowYtd, "tab=overview&perspective=cash-flow");
  check("Back from a flow change ⇒ the earlier entry's flow period (Net Worth unchanged in both)",
    hydrateGroupedShellTime(entryA, ctx).flow.time.preset === "PAST_MONTH" && hydrateGroupedShellTime(entryB, ctx).flow.time.preset === "YTD"
      && same(hydrateGroupedShellTime(entryA, ctx).position, hydrateGroupedShellTime(entryB, ctx).position));

  // Explicit shared links win; pinned dates stay pinned.
  const link = "tab=overview&perspective=spending&fasof=2026-08-31&fpreset=PAST_QUARTER&preset=YTD";
  const fromLink = hydrateGroupedShellTime(link, ctx);
  check("an explicit link's flow dates win", fromLink.flow.time.asOf === "2026-08-31" && fromLink.flow.time.preset === "PAST_QUARTER");
  check("…and its Net Worth params apply to Net Worth only", fromLink.position.time.preset === "YTD" && fromLink.position.time.asOf === TODAY);
  const explicitLink = hydrateGroupedShellTime("perspective=cash-flow&fpreset=PAST_MONTH&fperiod=month:2026-07", ctx);
  check("an explicit calendar unit in a link (fperiod) is restored", same(groupPeriod(explicitLink.flow), { kind: "month", year: 2026, month: 7 }));
  check("a future calendar unit in a link is ignored", hydrateGroupedShellTime("fpreset=PAST_MONTH&fperiod=month:2027-01", ctx).flow.explicit === null);
  check("a malformed unit is ignored", hydrateGroupedShellTime("fpreset=PAST_MONTH&fperiod=month:2026-13", ctx).flow.explicit === null);

  // Legacy pre-v2.7 Cash Flow links carried the shared params.
  const legacy = hydrateGroupedShellTime("tab=overview&perspective=cash-flow&preset=PAST_YEAR", ctx);
  check("legacy Cash Flow link (no flow params): its period goes to the FLOW group, Net Worth starts at default",
    legacy.flow.time.preset === "PAST_YEAR" && legacy.position.time.preset === "PAST_MONTH");
  const nwLegacy = hydrateGroupedShellTime("tab=overview&preset=PAST_YEAR", ctx);
  check("…a Net Worth link is never read as flow", nwLegacy.position.time.preset === "PAST_YEAR" && nwLegacy.flow.time.preset === "PAST_MONTH");
  check("a URL this module wrote always carries fpreset (the legacy fallback cannot fire on it)",
    new URLSearchParams(urlOf(d, "tab=overview&perspective=cash-flow")).has("fpreset"));

  // UTC midnight rollover — per group.
  const pinned: GroupedShellTime = {
    position: reduceGroupTime(d.position, { type: "setAsOf", asOf: "2026-09-30" }, ctx),
    flow: setGroupExplicit(d.flow, { kind: "month", year: 2026, month: 10 }),
  };
  const next = { today: "2026-10-28", coverageFrom: COVER };
  const rolledDefault = rollGroupedShellTime(d, TODAY, next);
  check("midnight: rolling groups advance to the new day (1M re-derived)",
    rolledDefault.flow.time.asOf === "2026-10-28" && rolledDefault.position.time.asOf === "2026-10-28"
      && rolledDefault.flow.time.compareTo === resolvePerspectiveTimeRange({ preset: "PAST_MONTH", asOf: "2026-10-28", coverageFrom: COVER }).compareTo);
  const rolledPinned = rollGroupedShellTime(pinned, TODAY, next);
  check("midnight: a pinned Net Worth date stays pinned", rolledPinned.position.time.asOf === "2026-09-30");
  check("midnight: an explicit calendar unit stays pinned", same(rolledPinned.flow.explicit, { kind: "month", year: 2026, month: 10 }));
  check("midnight: identity when nothing rolls (no state/URL loop)", rollGroupedShellTime(pinned, "2026-10-28", next) === pinned
    || rollGroupedShellTime(rolledPinned, "2026-10-28", { ...next }) === rolledPinned);
  const reloadedTomorrow = hydrateGroupedShellTime(urlOf(d), next);
  check("reload after midnight: rolling URL follows the new day for both groups",
    reloadedTomorrow.flow.time.asOf === "2026-10-28" && reloadedTomorrow.position.time.asOf === "2026-10-28");
}

// ── B. header ⇄ heatmap ───────────────────────────────────────────────────────
console.log("\nB. header ⇄ heatmap coherence");
{
  const nav = calendarNavigation({ period: "PAST_MONTH", windowEnd: TODAY, today: TODAY, earliest: "2025-03-02" });
  check("relative header preset (1M): no heatmap unit active, no stepper", nav.scale === null && nav.prev === null && nav.next === null);
  check("Month · Quarter · Year select three DISTINCT windows containing the window's end",
    same(nav.choose.month, { kind: "month", year: 2026, month: 10 }) && same(nav.choose.quarter, { kind: "quarter", year: 2026, quarter: 4 })
      && same(nav.choose.year, { kind: "year", year: 2026 }));
  check("…with distinct ranges", ["month", "quarter", "year"].map((k) => JSON.stringify(explicitPeriodBounds(nav.choose[k as "month"]))).filter((v, i, a) => a.indexOf(v) === i).length === 3
    && explicitPeriodBounds(nav.choose.quarter).start === "2026-10-01" && explicitPeriodBounds(nav.choose.quarter).end === "2026-12-31");
  const oct = calendarNavigation({ period: { kind: "month", year: 2026, month: 10 }, windowEnd: TODAY, today: TODAY, earliest: "2025-03-02" });
  check("current month: Month active; ◀ September; ▶ disabled (never past today)",
    oct.scale === "month" && same(oct.prev, { kind: "month", year: 2026, month: 9 }) && oct.next === null);
  const mar = calendarNavigation({ period: { kind: "month", year: 2025, month: 3 }, windowEnd: TODAY, today: TODAY, earliest: "2025-03-02" });
  check("first data month: ◀ disabled (never before the first data-bearing date); ▶ April", mar.prev === null && same(mar.next, { kind: "month", year: 2025, month: 4 }));
  const q = calendarNavigation({ period: { kind: "quarter", year: 2026, quarter: 1 }, windowEnd: TODAY, today: TODAY, earliest: null });
  check("Quarter steps by quarter across years", same(q.prev, { kind: "quarter", year: 2025, quarter: 4 }) && same(q.next, { kind: "quarter", year: 2026, quarter: 2 }));
  check("Year → Month from an explicit year picks the month containing the year's end (clamped to today)",
    same(calendarNavigation({ period: { kind: "year", year: 2025 }, windowEnd: TODAY, today: TODAY, earliest: null }).choose.month, { kind: "month", year: 2025, month: 12 }));
  check("step/parse/key are inverse", same(stepExplicitPeriod({ kind: "month", year: 2026, month: 1 }, -1), { kind: "month", year: 2025, month: 12 })
    && ["month:2026-07", "quarter:2026-Q4", "year:2026"].every((k) => explicitPeriodKey(parseExplicitPeriodKey(k)!) === k)
    && same(explicitPeriodContaining("quarter", "2026-02-28"), { kind: "quarter", year: 2026, quarter: 1 }));

  // The heatmap's unit lives in the group: the header shows it; a header action ends it.
  const g = setGroupExplicit(defaultGroupedShellTime(TODAY).flow, { kind: "quarter", year: 2026, quarter: 3 });
  check("heatmap → header: the group's period IS the chosen unit", same(groupPeriod(g), { kind: "quarter", year: 2026, quarter: 3 }));
  const s = summarizeExplicitPeriod({ kind: "quarter", year: 2026, quarter: 3 }, TODAY);
  check("…and the header readout names it (no stale preset label)", s.periodLabel === "Q3 2026" && s.rangeLabel === "Jul 1, 2026 → Sep 30, 2026" && s.anchoredToPresent === false);
  check("short trigger label for an explicit month", shortExplicitPeriodLabel({ kind: "month", year: 2026, month: 10 }) === "Oct 2026");
  const afterHeader = reduceGroupTime(g, { type: "selectPreset", preset: "PAST_QUARTER" }, ctx);
  check("header → heatmap: a header preset ENDS the unit (the heatmap then paints the preset)", afterHeader.explicit === null && groupPeriod(afterHeader) === "PAST_QUARTER");
  check("a custom header range also ends it", reduceGroupTime(g, { type: "setCompareTo", compareTo: "2026-05-01" }, ctx).explicit === null);
  check("the unit round-trips through the URL (fperiod)",
    same(hydrateGroupedShellTime(urlOf({ ...defaultGroupedShellTime(TODAY), flow: g }), ctx).flow.explicit, g.explicit));
  const shellHtml = renderToStaticMarkup(createElement(PerspectiveShell as never, {
    today: TODAY, onAsOfChange: () => {}, onCompareToChange: () => {}, onSwap: () => {}, onSelectPreset: () => {}, envelope: {},
    timeState: defaultGroupedShellTime(TODAY).flow.time, tabs: [], activeTabId: null, onSelectTab: () => {}, tabsVisibility: "none",
    explicitPeriod: { kind: "month", year: 2026, month: 9 },
  } as never));
  check("the rendered header trigger shows the heatmap's month, not '1 month'", /September 2026/.test(shellHtml) && !/>1 month</.test(shellHtml));
  const host = code("components/dashboard/SpaceDashboard.tsx");
  check("host wires the group's unit into the header and the heatmap's pick into the group",
    /explicitPeriod=\{shell\.explicitPeriod\}/.test(host) && /onSelectCashFlowPeriod: handleSelectSlice/.test(host)
      && /group: timeGroupFor\(activeTab, activePerspectiveId\)/.test(host));
}

// ── C. Cash Flow vs Spending semantics (the reconciled Preview fixture shape) ──
console.log("\nC. Cash Flow vs Spending on the reconciled fixture");
let n = 0;
const tx = (acct: string, amount: number, flowType: string, category: string, over: Record<string, unknown> = {}) => ({
  id: `f${n++}`, accountId: acct, financialAccountId: acct, merchant: "m", category, pending: false, currency: "USD",
  flowType, counterpartyAccountId: null, transferDisposition: null, date: "2026-10-15", amount, ...over,
});
const ACCOUNTS = [
  { id: "chk", type: "checking" }, { id: "sav", type: "savings" }, { id: "mm", type: "savings" }, { id: "cd", type: "savings" }, { id: "cc", type: "debt" },
];
const FIXTURE = [
  tx("chk", 500, "REFUND", "Travel"),
  tx("chk", -89.40, "SPENDING", "Shopping"), tx("chk", -12, "SPENDING", "Dining"), tx("chk", -6.33, "SPENDING", "Travel"),
  tx("chk", -5.40, "SPENDING", "Travel"), tx("chk", -4.33, "SPENDING", "Dining"),
  tx("cc", -2078.50, "SPENDING", "Other"), tx("cc", -500, "SPENDING", "Travel"), tx("cc", -500, "SPENDING", "Utilities"),
  tx("cc", -500, "SPENDING", "Other"), tx("cc", -500, "SPENDING", "Dining"), tx("cc", -78.50, "SPENDING", "Other"),
  tx("mm", -5850, "TRANSFER", "Transfer", { transferDisposition: "EXTERNAL_BANK_TRANSFER" }),
  tx("cd", -1000, "TRANSFER", "Transfer", { transferDisposition: "UNKNOWN_MOVEMENT" }),
  tx("sav", -25, "TRANSFER", "Transfer", { transferDisposition: "EXTERNAL_BANK_TRANSFER" }),
  tx("sav", 4.22, "TRANSFER", "Transfer", { transferDisposition: "UNKNOWN_MOVEMENT" }),
];
const OCT = { kind: "month", year: 2026, month: 10 } as const;
const clock = () => new Date("2026-10-27T00:00:00");
const data = buildCashFlowSpaceData({ transactions: FIXTURE as never, accounts: ACCOUNTS, period: OCT, now: clock });
const r2 = (v: number) => Math.round(v * 100) / 100;
{
  check("Cash Flow: cash in 500.00 · cash out 117.46 · net +382.54",
    r2(data.summary.cashIn) === 500 && r2(data.summary.cashOut) === 117.46 && r2(data.summary.cashIn - data.summary.cashOut) === 382.54);
  check("Spending: total 3,774.46 (card 4,157.00 at purchase + direct 117.46 − refund 500)", r2(data.spending.net) === 3774.46 && r2(data.summary.creditCardSpending) === 4157);
  const tier = economicSpendByTier(data.summary);
  check("tier breakdown reconciles: 4,157.00 + 0.00 − 382.54 = 3,774.46",
    r2(tier.creditCard) === 4157 && r2(tier.direct) === 0 && r2(tier.refundsUnapplied) === 382.54 && r2(tier.creditCard + tier.direct - tier.refundsUnapplied) === 3774.46);
  check("the refund counts ONCE per axis: +500 cash in (liquidity) and −500 in Travel (economic)",
    data.cashInByReason.some((l) => l.reason === "REFUND" && r2(l.amount) === 500) && r2(data.outflowByCategory.find((c) => c.id === "Travel")!.value) === 11.73);
  const lines = movementLines({ context: data.context, charged: data.summary.creditCardSpending, chargedRows: [] });
  const unresolved = lines.find((l) => l.key === "unresolved-transfers");
  check("unresolved transfers: 6,879.22 across 4, stated as unconfirmed", r2(unresolved!.amount!) === 6879.22 && unresolved!.count === 4 && /not confirmed/.test(unresolved!.description));
  check("…excluded from BOTH axes (not in cash in/out, not in spending)",
    r2(data.summary.cashIn) === 500 && r2(data.summary.cashOut) === 117.46 && r2(data.spending.gross) === 4274.46);
  // A card bill payment from checking: cash out, never spending.
  const withPayment = buildCashFlowSpaceData({
    transactions: [...FIXTURE, tx("chk", -300, "DEBT_PAYMENT", "Payment", { counterpartyAccountId: "cc" })] as never,
    accounts: ACCOUNTS, period: OCT, now: clock,
  });
  check("a card payment is Cash Out (+300) and NOT spending (unchanged 3,774.46)",
    r2(withPayment.summary.cashOut) === 417.46 && r2(withPayment.spending.net) === 3774.46 && withPayment.debtPayments.length > 0);
}

// ── D. donut reconciliation ───────────────────────────────────────────────────
console.log("\nD. the Spending donut reconciles exactly");
{
  const m = spendingDonutModel(data.outflowByCategory, data.spending);
  check("fixture: slices Σ = Total spending 3,774.46 ⇒ centre = Total spending", m.reconciles && r2(m.centerValue) === 3774.46 && m.centerLabel === "Total spending"
    && r2(m.slices.reduce((s, x) => s + x.value, 0)) === 3774.46);
  check("five positive slices, colours assigned, no zero/negative slice", m.slices.length === 5 && m.slices.every((s) => s.value > 0 && /^#|^rgb|^var|^hsl/.test(s.color)));
  check("slice shares sum to 100%", Math.abs(sliceShares(m).reduce((s, x) => s + x.pct, 0) - 100) < 1e-9);
  // Unabsorbed refund: an August booking refunded in September (no Travel charge in the window).
  const ACC2 = [{ id: "chk", type: "checking" }, { id: "cc", type: "debt" }];
  const sep = buildCashFlowSpaceData({
    transactions: [
      tx("cc", -1000, "SPENDING", "Travel", { date: "2026-08-10" }), tx("chk", -600, "SPENDING", "Groceries", { date: "2026-09-06" }),
      tx("cc", -80, "SPENDING", "Dining", { date: "2026-09-10" }), tx("cc", 400, "REFUND", "Travel", { date: "2026-09-05" }),
    ] as never,
    accounts: ACC2, period: "MTD", now: () => new Date("2026-09-21T00:00:00"),
  });
  const adj = spendingDonutModel(sep.outflowByCategory, sep.spending);
  check("unabsorbed refund: the ring does NOT claim the total (centre = Σ slices 680, 'Category spending')",
    !adj.reconciles && adj.centerValue === 680 && adj.centerLabel === "Category spending" && adj.total === 280 && adj.adjustment === 400);
  const html = text(renderToStaticMarkup(createElement(SpendingDistribution, { model: adj, fmt: (v: number) => `$${v}`, ledger: createElement("p", null, "ledger") })));
  check("…and the adjustment line is stated beside it", /Less refunds with no matching purchase −\$400 · Total spending \$280/.test(html), html);
  check("no Travel slice (it nets to ≤ 0) — the ledger keeps its own honesty",
    !adj.slices.some((s) => s.id === "Travel") && sep.outflowByCategory.every((c) => c.value > 0));
  const empty = spendingDonutModel([], { net: 0, gross: 0, refunds: 0, refundsUnapplied: 0 });
  check("no spending: no slices, centre 0, reconciles", empty.slices.length === 0 && empty.reconciles && empty.centerValue === 0);
}

// ── E. Markets: no global reporting-period picker ─────────────────────────────
console.log("\nE. Markets shows no global reporting-period picker");
{
  const base = {
    today: TODAY, onAsOfChange: () => {}, onCompareToChange: () => {}, onSwap: () => {}, onSelectPreset: () => {}, envelope: {},
    timeState: defaultGroupedShellTime(TODAY).position.time, tabs: [], activeTabId: null, onSelectTab: () => {}, tabsVisibility: "none",
  };
  const withPicker = renderToStaticMarkup(createElement(PerspectiveShell as never, base as never));
  check("control: other perspectives render the picker", /data-timeline-period/.test(withPicker));
  const markets = renderToStaticMarkup(createElement(PerspectiveShell as never, { ...base, hideTime: true, compactHideTime: true } as never));
  check("Markets (hideTime): no picker at ANY width — no trigger, no range readout", !/data-timeline-period|data-timeline-range|Change time period/.test(markets));
  const marketsCompact = renderToStaticMarkup(createElement(PerspectiveShell as never, {
    ...base, hideTime: true, compactHideTime: true, compactViewSelector: createElement("span", { "data-test-selector": "" }, "Markets"),
  } as never));
  check("…the compact view selector still mounts", /data-test-selector/.test(marketsCompact) && !/data-timeline-period/.test(marketsCompact));
  check("the host hides it for Markets", /hideTime=\{activePerspectiveId === "markets"\}/.test(code("components/dashboard/SpaceDashboard.tsx")));
  check("Markets declares no time axis (and no time toggles were added)",
    same(PERSPECTIVE_LIBRARY.markets.temporalCapability, { asOf: "none", compareTo: "none", period: "none" })
      && !/TimelineLens|selectPreset/.test(code("components/space/widgets/markets/MarketsWorkspace.tsx")));
}

// ── F. perspectives, page order, removed controls ─────────────────────────────
console.log("\nF. Spending is its own perspective; page orders; removed controls");
{
  check("Spending is a registered, available perspective after Cash Flow", PERSPECTIVE_LIBRARY.spending?.status === "available"
    && CORE_LENS_IDS.join() === "cashFlow,spending,markets");
  check("its own URL: ?tab=overview&perspective=spending, parsed back to the lens",
    lensHref("spending") === "/dashboard?tab=overview&perspective=spending" && parsePerspectiveParam("spending") === "spending");
  check("its transactions fetch activates (dataNeeds)", openPerspectiveDataNeeds("OVERVIEW", "spending").has("transactions"));

  const ws = code("components/space/widgets/cashflow/CashFlowWorkspace.tsx");
  const cf = ws.slice(ws.indexOf('data-flow-view="cashFlow"'));
  check("Cash Flow order: hero → Cash In/Out → Activity heatmap → Transfers & movements → cash in sources → What changed",
    ["<CashFlowHero", "<CashFlowSummaryWidget", 'id="cashflow-activity"', 'id="cashflow-movements"', 'id="cashflow-income"', 'id="cashflow-insights"']
      .map((id) => cf.indexOf(id)).every((v, i, a) => v > -1 && (i === 0 || v > a[i - 1])));
  const sp = ws.slice(ws.indexOf('data-flow-view="spending"'), ws.indexOf('data-flow-view="cashFlow"'));
  check("Spending order: hero → credit/direct breakdown → donut + ledger → heatmap → observations",
    ["<SpendingHero", "<SpendingTierBreakdown", 'id="spending-distribution"', "<SpendingDistribution", 'id="spending-activity"', 'id="spending-insights"']
      .map((id) => sp.indexOf(id)).every((v, i, a) => v > -1 && (i === 0 || v > a[i - 1])));
  check("the category ledger renders INSIDE the distribution (directly beneath the donut)",
    /<SpendingDistribution model=\{spendingDonutModel\(data\.outflowByCategory, data\.spending\)\} fmt=\{fmt\} ledger=\{renderSpendingLedger\(\)\} \/>/.test(sp)
      && code("components/space/widgets/cashflow/SpendingSections.tsx").indexOf("<BreakdownWidget") < code("components/space/widgets/cashflow/SpendingSections.tsx").indexOf("{ledger}"));
  check("Spending-by-category is NOT on Cash Flow (at most a teaser link)", !cf.includes("renderSpendingLedger()") && /data-spending-teaser/.test(cf));
  check("no empty cards: movements and cash-in sections render only when they have content",
    /\{data && hasMovements && \(/.test(cf) && /\{data && hasCashIn && \(/.test(cf) && /data\.debtPayments\.length > 0 &&/.test(cf));

  const heroCf = renderToStaticMarkup(createElement(CashFlowHero as ComponentType<Record<string, unknown>>, {
    facts: { cashIn: 500, cashOut: 117.46 }, currency: "USD", period: "PAST_MONTH", windowLabel: "as of Oct 27, 2026", change: null,
  }));
  check("Cash Flow hero: 'Net cash flow', explicit liquidity sub, no toggle, no Compare To hint",
    /Net cash flow · 1M/.test(text(heroCf)) && text(heroCf).includes(CASH_FLOW_HERO_SUB) && !/role="tablist"/.test(heroCf) && !/Set a Compare To/.test(heroCf));
  const heroSp = renderToStaticMarkup(createElement(SpendingHero, { total: 3774.46, currency: "USD", period: "PAST_MONTH", windowLabel: "as of Oct 27, 2026", change: null }));
  check("Spending hero: 'Total spending' $3,774.46 with the economic sub-line", /Total spending · 1M/.test(text(heroSp)) && /\$3,774\.46/.test(text(heroSp))
    && /purchases across cards and bank accounts, net of refunds — card payments aren.t counted again/.test(text(heroSp)) && SPENDING_HERO_SUB.length > 0);
  check("both heroes share the HeroEyebrow skeleton and the compact hero surface",
    [code("components/space/widgets/cashflow/CashFlowHero.tsx"), code("components/space/widgets/cashflow/SpendingSections.tsx")].every((s) => /<HeroEyebrow /.test(s) && /className=\{COMPACT_HERO\}/.test(s)));
  check("the Cards view and the perspective toggle are gone from the heatmap", !/CardsView|ModeToggle|aria-label="Cash flow perspective"/.test(code("components/space/widgets/CashFlowHistoryWidget.tsx")));
  check("no 'Set a Compare To date above' hint anywhere in the Cash Flow surfaces",
    !/Set a Compare To date/.test(code("components/space/widgets/cashflow/CashFlowHero.tsx") + code("components/space/widgets/cashflow/CashFlowWorkspace.tsx")));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
