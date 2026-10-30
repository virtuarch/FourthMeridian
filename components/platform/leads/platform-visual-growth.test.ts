/**
 * components/platform/leads/platform-visual-growth.test.ts  (Platform Spaces 2.0 — Growth + the heatmap kit)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/leads/platform-visual-growth.test.ts
 *
 * Unit tests prove structure and honesty, NOT visual acceptance (owner rule) —
 * that is the 390/1280 screenshot review on Preview.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GrowthLeadSurface } from "./GrowthLead";
import { BETA_LIST_KEY, GROWTH_DRAWERS, cohortHasHistory, describeCohortCell, describeWeekHourCell, growthKpis } from "./growth-model";
import { calendarLayout, cellStyle, cohortLayout, heatBin, weekHourLayout, NO_DATA_FILL, ZERO_FILL } from "../charts/heatmap-model";
import type { AcquisitionResponse, CohortRow } from "@/lib/platform/growth/acquisition-types";
import type { ProductAnalyticsResponse } from "@/lib/platform/growth/product-analytics-types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const strip = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const grid = (fill: number) => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => fill));
const DAYS = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, 22 + i)).toISOString().slice(0, 10));
const ACQ: AcquisitionResponse = {
  checkedAt: "2026-11-20T15:00:00.000Z", windowDays: 30, from: "2026-10-22", to: "2026-11-20",
  coverage: { requestsFrom: "2026-10-07", engagementFrom: "2026-10-15", chatFrom: "2026-08-23" },
  requests: { perDay: DAYS.map((day, i) => ({ day, count: i % 3 })), total: 29 },
  registrations: { perDay: DAYS.map((day, i) => ({ day, count: i === 4 ? 2 : 0 })), total: 2 },
  waitlist: { pending: 3, invited: 1, invitedExpired: 1, redeemed: 8, declined: 0 },
  sources: [{ label: "newsletter", count: 4 }], sourcesUnrecorded: 2,
  timeOfWeek: { signIns: grid(1), signInTotal: 168, chatTurns: grid(0), chatTotal: 3 },
  retention: { offsets: 8, rows: [
    { weekStart: "2026-10-19", size: 4, cells: [{ state: "value", num: 4, den: 4 }, { state: "value", num: 2, den: 4 }, { state: "value", num: 0, den: 4 }, { state: "immature" }, { state: "immature" }, { state: "immature" }, { state: "immature" }, { state: "immature" }] },
  ] },
  onboarding: { stages: [{ key: "verified", label: "Verified" }, { key: "firstSession", label: "First session" }, { key: "firstConnection", label: "First connection" }, { key: "firstAiTurn", label: "First AI turn" }, { key: "firstBriefViewed", label: "First Brief viewed" }],
    rows: [{ weekStart: "2026-10-19", size: 4, cells: [{ state: "value", num: 4, den: 4 }, { state: "value", num: 3, den: 4 }, { state: "value", num: 2, den: 4 }, { state: "value", num: 1, den: 4 }, { state: "value", num: 0, den: 4 }] }] },
  notes: ["UTC days and hours."],
};
const PA = {
  checkedAt: "2026-11-20T15:00:00.000Z", windowDays: 30,
  registrations: { total: 9, deactivated: 1, last7d: 1, last30d: 2, perDay: [] },
  active: { daily: { present: 2, engaged: 1, signIns: 1 }, weekly: { present: 5, engaged: 4, signIns: 3 }, monthly: { present: 8, engaged: 6, signIns: 7 },
    perDay: [{ day: "2026-11-19", present: 2, engaged: 1 }, { day: "2026-11-20", present: 3, engaged: 2 }] },
  retention: { returningEver: { count: 5, rate: 5 / 9 }, cohorts: [], abandonmentHorizonDays: 7 },
  funnel: [{ key: "registered", label: "Registered", count: 9 }, { key: "verified", label: "Verified", count: 8, rate: 8 / 9, abandoned: 1 }],
  features: [{ key: "aiChat", label: "AI Chat", adopters: 4, adoption: 4 / 9, frequencyPerEngagedUserPerWeek: 1, basis: "x" }],
  cost: { aiUsd: null, plaidUsd: null, engagedUsers: 6, perEngagedUserUsd: null, tier: "ESTIMATED", notes: [] },
  exclusions: ["Operators' own activity is excluded."],
} as ProductAnalyticsResponse;

const ok = <T,>(data: T) => ({ data, loading: false, error: null });
const failed = { data: null, loading: false, error: "Request failed (500)" };
const render = (over: Partial<Parameters<typeof GrowthLeadSurface>[0]> = {}) =>
  renderToStaticMarkup(createElement(GrowthLeadSurface, {
    acq: ok(ACQ), pa: ok(PA), period: "30", onPeriod: () => {}, hasHosted: () => true,
    betaList: createElement("div", { "data-test-beta": true }, "BETA LIST"), onOpenDrawer: () => {}, ...over,
  }));

console.log("1. owner hierarchy — the beta signup list is third, above the expanded analytics");
{
  const html = render();
  const at = (needle: string) => html.indexOf(needle);
  check("hero, then the acquisition overview, then the beta list", at("data-health-hero") < at('id="growth-acquisition"') && at('id="growth-acquisition"') < at("BETA LIST"));
  check("the list precedes the calendar, funnel, cohorts, active accounts and time of week",
    ["growth-calendar", "growth-funnel", "growth-onboarding-cohorts", "growth-active", "growth-retention", "growth-time-of-week"].every((id) => at("BETA LIST") < at(`id="${id}"`)));
  check("a period control sits above the hero", at('aria-label="Period"') > -1 && at('aria-label="Period"') < at("data-health-hero"));
  check("no list slot when the Space has no beta section", !render({ betaList: null }).includes("data-beta-list-slot"));
}

console.log("2. real charts, not number tiles");
{
  const html = render();
  check("daily bars, funnel bars and four heat grids render (calendar, onboarding, retention, time of week)", html.includes("data-day-bars") && html.includes("data-funnel-bars") && (html.match(/data-heat-grid/g) ?? []).length === 4, { bars: html.includes("data-day-bars"), funnel: html.includes("data-funnel-bars"), grids: (html.match(/data-heat-grid/g) ?? []).length });
  check("only 4 KPI tiles", growthKpis(ok(ACQ), ok(PA)).length === 4);
  check("< lg shows ONE analytics group at a time (the others are max-lg:hidden)",
    /data-group="conversion"/.test(html) && /max-lg:hidden" data-group="conversion"/.test(html) && !/max-lg:hidden" data-group="acquisition"/.test(html));
}

console.log("3. honesty — unavailable, too little history, no invented figures");
{
  const html = render({ acq: failed, pa: failed });
  check("failed reads say unavailable with the reason", html.includes("Acquisition unavailable — Request failed (500)") && !html.includes("data-heat-grid"));
  check("KPIs read '—', never 0", growthKpis(failed, failed).every((k) => k.value === "—"));
  const few = render();
  check("3 chat turns is too few for a time-of-week pattern (toggle state hidden by default, sign-ins shown)", few.includes("sign-ins by weekday and UTC hour"));
  check("a cohort table with < 2 measured cells is not drawn", !cohortHasHistory([{ weekStart: "2026-10-19", size: 1, cells: [{ state: "value", num: 1, den: 1 }, { state: "immature" }] }]));
}

console.log("4. heatmap kit — zero vs no data vs in progress, denominators, layouts");
{
  check("5 bins over (0, max]", heatBin(1, 10) === 0 && heatBin(10, 10) === 4 && heatBin(5, 10) === 2 && heatBin(0, 10) === 0);
  check("zero and no-data are drawn differently", cellStyle({ kind: "zero" }, 1).background === ZERO_FILL && cellStyle({ kind: "noData" }, 1).background === NO_DATA_FILL);
  check("in-progress is an outline, not a fill", cellStyle({ kind: "immature" }, 1).border?.includes("dashed") === true);
  const cal = calendarLayout([{ day: "2026-11-18", count: null }, { day: "2026-11-19", count: 0 }, { day: "2026-11-20", count: 3 }]);
  check("calendar: Wednesday lands in row 2; days before the series are blank padding",
    cal.cells[2][0].kind === "noData" && cal.cells[3][0].kind === "zero" && cal.cells[4][0].kind === "value" && cal.cells[0][0].kind === "blank" && cal.dayAt(4, 0) === "2026-11-20");
  const wh = weekHourLayout([[0, 2]]);
  check("time of week: 7 × 24, hour labels every 6 h", wh.cells.length === 7 && wh.cols.length === 24 && wh.cols.filter((c) => c.shown).length === 4 && wh.cells[0][1].kind === "value");
  const row: CohortRow = ACQ.retention.rows[0];
  const co = cohortLayout([row, { weekStart: "2026-10-26", size: 0, cells: [{ state: "value", num: 0, den: 0 }] }], [{ key: "w0", label: "W0" }]);
  check("cohort cell intensity is num ÷ den with the denominator kept", co.cells[0][1].kind === "value" && (co.cells[0][1] as { v: number; den?: number }).v === 0.5 && (co.cells[0][1] as { den?: number }).den === 4);
  check("an empty cohort is blank (no denominator), not 0%", co.cells[1][0].kind === "blank");
  check("cohort readout carries numerator, denominator and share", describeCohortCell(row, "week 1", co.cells[0][1], "engaged") === "Week of Oct 19 · week 1 · 2 of 4 engaged (50%)");
  check("time-of-week readout names the UTC hour and the share of the total", describeWeekHourCell(1, 9, { kind: "value", v: 3 }, "sign-in", 12) === "Tue 09:00–09:59 UTC · 3 sign-ins · 25% of 12");
}

console.log("5. lead source rules (the Ops 2.0 ratchet, extended to Growth)");
{
  for (const f of ["components/platform/leads/GrowthLead.tsx", "components/platform/leads/growth-model.ts", "components/platform/charts/HeatGrid.tsx", "components/platform/charts/heatmap-model.ts", "components/platform/charts/FunnelBars.tsx"]) {
    const src = strip(f);
    check(`${f}: no CONTROL / canControl / canWrite / matchMedia / raw fetch`,
      !/\bCONTROL\b|canControl|canWrite|matchMedia|innerWidth|\bfetch\(/.test(src));
  }
  check("the beta list is HOSTED through the registry (its actions and gating stay in the widget)",
    BETA_LIST_KEY === "growth_beta_requests" && /renderHosted\(BETA_LIST_KEY/.test(strip("components/platform/leads/GrowthLead.tsx")));
  check("every former Growth widget is reachable from a drawer or the page",
    ["growth_signups", "growth_product_analytics", "growth_users", "growth_activity", "growth_funnel", "growth_policy_groups"].every((k) => GROWTH_DRAWERS.some((d) => d.keys.includes(k))));
  const lead = strip("components/platform/leads/GrowthLead.tsx");
  check("Personal components are imported, not forked", /from "@\/components\/space\/widgets\/BreakdownWidget"/.test(lead) && /from "\.\.\/ops-visual\/HealthHero"/.test(lead));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
