/**
 * components/platform/leads/economics-overview.test.ts  (Platform Economics — Overview render)
 *
 *   1. view-model words — Unavailable is never "$0", PARTIAL is "≥", status words;
 *   2. render — every figure with records is a button carrying its own drill href;
 *      revenue + margin render "Unavailable · no billing source" and are never
 *      buttons; an empty snapshot renders no "$0.00" anywhere; loading / error;
 *   3. drill body — its total, in the figure's words, equals the tile's value;
 *      the engaged-customer drill lists opaque refs only;
 *   4. URL — ?econ / ?econuntil round-trip through the route's own parser and are
 *      declared workspace-scoped;
 *   5. 375 px (source) — no fixed width, grids collapse to ≤ 2 columns below sm,
 *      long text truncates or wraps.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/leads/economics-overview.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import { priceCycleBothReadings, type PlaidItemFact } from "@/lib/platform/plaid/item-months";
import { PLAID_RATES } from "@/lib/usage/pricing";
import {
  DRILLABLE, ECONOMICS_FIGURES, REASON_NO_BILLING, buildEconomicsDrill, buildEconomicsSnapshot,
  type EconomicsInputs,
} from "@/lib/platform/economics/snapshot-core";
import { PLATFORM_WORKSPACE_SCOPED_PARAMS } from "@/lib/space/use-platform-workspace-navigation";
import {
  ECONOMICS_URL_PARAMS, UNAVAILABLE_TEXT, drillStateOf, drillTotalText, economicsDrillApiPath, economicsDrillUrlUpdate,
  figureValueText, readEconomicsDrillUrl, splitShares, trendSeries,
} from "./economics-model";
import { EconomicsDrillBody, EconomicsOverviewSurface } from "./EconomicsOverviewLead";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = Date.parse("2026-11-03T12:00:00Z");
const grp = (day: string, surface: string, model = "gpt-5-mini"): SpendGroup => ({ provider: "OPENAI", model, surface, day, invocations: 2, promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 500_000 });
const item = (id: string, o: Partial<PlaidItemFact> = {}): PlaidItemFact => ({ id, externalItemId: `ext_${id}`, createdAt: "2026-08-01T00:00:00Z", status: "ACTIVE", investmentsConsent: null, environment: "production", plaidEnvironment: "production", ...o });
const ITEMS = [item("p1"), item("p2", { investmentsConsent: "ENABLED" })];
const TRANSITIONS = [{ plaidItemId: "zz", at: "2026-08-15T00:00:00Z", from: "ACTIVE", to: "REVOKED" }];
const both = priceCycleBothReadings(ITEMS, TRANSITIONS, { start: "2026-11-01", end: "2026-11-30" }, { today: "2026-11-03", rates: PLAID_RATES });

const FULL: EconomicsInputs = {
  nowMs: NOW,
  spendGroups: [grp("2026-11-01", "chat"), grp("2026-11-02", "brief"), grp("2026-11-02", "chat", "not-a-rated-model"), grp("2026-10-20", "harness")],
  aiPricingConfigured: true,
  plaidCycle: both.during, plaidReadingsAgree: both.agree, plaidRates: PLAID_RATES,
  engagedCustomerRefs: ["user #0a1b2c3d", "user #4e5f6a7b"],
};
const EMPTY: EconomicsInputs = { ...FULL, spendGroups: [], plaidCycle: null, engagedCustomerRefs: [] };

const ok = { loading: false, error: null };
const render = (inputs: EconomicsInputs) => renderToStaticMarkup(createElement(EconomicsOverviewSurface, {
  snapshot: { data: buildEconomicsSnapshot(inputs), ...ok }, onOpenDrill: () => {}, onOpenAiCosts: () => {},
}));
const unescape = (h: string) => h.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

// ── 1. Words ──────────────────────────────────────────────────────────────────
console.log("1. view-model words");
check("UNAVAILABLE says 'Unavailable', never a number", figureValueText({ value: null, status: "UNAVAILABLE", unit: "usd" }) === UNAVAILABLE_TEXT);
check("…even if a value slipped through", figureValueText({ value: 0, status: "UNAVAILABLE", unit: "usd" }) === UNAVAILABLE_TEXT);
check("PARTIAL is a lower bound '≥ $x'", figureValueText({ value: 4.7, status: "PARTIAL", unit: "usd" }) === "≥ $4.70");
check("ESTIMATED is cents; MEASURED counts are plain", figureValueText({ value: 3.75, status: "ESTIMATED", unit: "usd" }) === "$3.75" && figureValueText({ value: 12, status: "MEASURED", unit: "count" }) === "12");
check("split shares: a part without a value has NO share (dashed track), never 0 %", JSON.stringify(splitShares([
  { value: 3, status: "ESTIMATED" }, { value: 1, status: "PARTIAL" }, { value: null, status: "UNAVAILABLE" },
] as never)) === JSON.stringify([75, 25, null]));
check("trend series: unpriced / gap days are left out, never drawn at $0", (() => {
  const t = trendSeries([
    { day: "a", observed: false, customerUsd: null, overheadUsd: null, totalUsd: null, unpricedInvocations: 0 },
    { day: "b", observed: true, customerUsd: null, overheadUsd: null, totalUsd: null, unpricedInvocations: 2 },
    { day: "c", observed: true, customerUsd: 1, overheadUsd: null, totalUsd: 1, unpricedInvocations: 0 },
  ]);
  return t.points.length === 1 && t.points[0].date === "c" && t.gaps === 2;
})());

// ── 2. Render ─────────────────────────────────────────────────────────────────
console.log("2. render");
const snap = buildEconomicsSnapshot(FULL);
const html = render(FULL);
const text = unescape(html);
for (const k of ECONOMICS_FIGURES) {
  const f = snap.figures[k];
  if (f.drill) {
    const href = f.drill.href.replace(/&/g, "&amp;");
    check(`${k}: a button that opens ITS records (drill href ${f.drill.figure}.${f.drill.window})`, html.includes(`data-econ-drill="${href}"`) || new RegExp(`<button[^>]*data-econ-tile="${k}"`).test(html));
  } else {
    check(`${k}: no records ⇒ not a button`, !new RegExp(`<button[^>]*data-econ-tile="${k}"`).test(html));
  }
}
check("every drillable cycle figure renders as a button", Object.keys(DRILLABLE).every((k) => new RegExp(`<button[^>]*data-econ-tile="${k}"`).test(html)));
check("the trend window figure opens its own records", /<button[^>]*data-econ-tile="ai_cost\.30d"/.test(html));
check("revenue + margin: 'Unavailable' and 'no billing source', status chip Unavailable",
  /data-econ-value="revenue">Unavailable</.test(html) && /data-econ-value="margin">Unavailable</.test(html) && text.split(REASON_NO_BILLING).length - 1 >= 2);
check("operating cost is a lower bound (≥) with a Partial chip", text.includes(`≥ $`) && /data-econ-status="PARTIAL"/.test(html));
check("infrastructure renders Unavailable, never $0", /data-econ-value="infra_cost">Unavailable</.test(html));
check("the estimate note says 'never a bill'", /never a bill/.test(text));
const emptyHtml = render(EMPTY);
check("EMPTY snapshot: no '$0.00' anywhere (missing telemetry is never $0)", !/\$0\.00/.test(emptyHtml), (emptyHtml.match(/.{40}\$0\.00.{40}/) ?? [""])[0]);
check("EMPTY snapshot: active customers is a measured 0, cost per customer Unavailable",
  /data-econ-value="active_customers">0</.test(emptyHtml) && /data-econ-value="cost_per_active_customer">Unavailable</.test(emptyHtml));
const loading = renderToStaticMarkup(createElement(EconomicsOverviewSurface, { snapshot: { data: null, loading: true, error: null }, onOpenDrill: () => {} }));
const errored = renderToStaticMarkup(createElement(EconomicsOverviewSurface, { snapshot: { data: null, loading: false, error: "Not authorized" }, onOpenDrill: () => {} }));
check("loading / error states say so (no figures)", /Reading economics/.test(loading) && /Economics unavailable — Not authorized/.test(errored) && !/\$/.test(loading + errored));

// ── 3. Drill body ─────────────────────────────────────────────────────────────
console.log("3. drill body");
for (const key of Object.keys(DRILLABLE) as (keyof typeof DRILLABLE)[]) {
  for (const w of DRILLABLE[key]!) {
    const d = buildEconomicsDrill(FULL, key, w);
    const kpi = w === "cycle" ? snap.figures[key] : snap.trend.windows[w as "7d"];
    const body = unescape(renderToStaticMarkup(createElement(EconomicsDrillBody, { data: d })));
    const tileText = figureValueText(kpi);
    check(`${key}.${w}: the drill's total reads as the tile ('${tileText}')`, body.includes(drillTotalText(d.figure, d.total, d.rows.length)) && drillTotalText(d.figure, d.total, d.rows.length).startsWith(`Total ${tileText}`), drillTotalText(d.figure, d.total, d.rows.length));
  }
}
const cust = unescape(renderToStaticMarkup(createElement(EconomicsDrillBody, { data: buildEconomicsDrill(FULL, "active_customers", "cycle") })));
check("engaged-customer drill lists the opaque refs", cust.includes("user #0a1b2c3d") && cust.includes("user #4e5f6a7b"));
const opBody = unescape(renderToStaticMarkup(createElement(EconomicsDrillBody, { data: buildEconomicsDrill(FULL, "operating_cost", "cycle") })));
check("operating-cost drill names what is NOT included (infrastructure, other providers)", /Not included: Infrastructure/.test(opBody) && /Not included: Other providers/.test(opBody));

// ── 4. URL ────────────────────────────────────────────────────────────────────
console.log("4. URL");
check("econ / econuntil are workspace-scoped (cleared by a workspace switch)", ECONOMICS_URL_PARAMS.every((k) => PLATFORM_WORKSPACE_SCOPED_PARAMS.includes(k)));
const st = drillStateOf(snap.trend.windows["30d"])!;
const u = economicsDrillUrlUpdate(st);
const back = readEconomicsDrillUrl(`?workspace=platform-economics&econ=${u.econ}&econuntil=${u.econuntil}`, NOW + 1000);
check("a figure's drill state round-trips through the URL (figure · window · window end)", back !== null && back.figure === "ai_cost" && back.window === "30d" && back.untilMs === NOW);
check("…and its API path is the figure's own drill href", economicsDrillApiPath(st) === snap.trend.windows["30d"].drill!.href);
check("closing deletes both keys", JSON.stringify(economicsDrillUrlUpdate(null)) === JSON.stringify({ econ: null, econuntil: null }));
check("an unknown figure, a window the figure lacks, or revenue is dropped (no ghost drawer)",
  readEconomicsDrillUrl("?econ=nope.cycle", NOW) === null && readEconomicsDrillUrl("?econ=operating_cost.30d", NOW) === null && readEconomicsDrillUrl("?econ=revenue.cycle", NOW) === null);

// ── 5. 375 px (source rules) ──────────────────────────────────────────────────
console.log("5. 375 px");
const lead = readFileSync(path.join(process.cwd(), "components/platform/leads/EconomicsOverviewLead.tsx"), "utf8");
check("no fixed pixel width or min-width (nothing wider than a 375 px phone)", !/\bw-\[\d+px\]/.test(lead) && !/min-w-\[\d/.test(lead) && !/width:\s*\d{3,}/.test(lead));
check("multi-column grids only from sm / lg up; the tile grid is 2-up on a phone",
  /grid grid-cols-2 gap-3 lg:grid-cols-4/.test(lead) && /grid gap-3 sm:grid-cols-3/.test(lead) && /lg:grid-cols-12/.test(lead) && !/(?<![a-z]:)grid-cols-(3|4|12)\b/.test(lead.replace(/(sm|md|lg|xl):grid-cols-\d+/g, "")));
check("every flex row can shrink (min-w-0) and long text truncates or wraps", (lead.match(/min-w-0/g) ?? []).length >= 10 && /truncate/.test(lead) && /break-words/.test(lead));
check("no table (a list scales to a phone without horizontal scroll)", !/<table/.test(lead));
check("the lead reads the snapshot through the shared workspace fetch; no access-level literal; no viewport read",
  /useSharedWidgetFetch<EconomicsSnapshot>\(ECONOMICS_URL\)/.test(lead) && !/"(READ|WRITE|CONTROL)"/.test(lead) && !/innerWidth|matchMedia/.test(lead));

if (failures > 0) { console.error(`\neconomics overview: ${failures} failure(s).`); process.exit(1); }
console.log("\neconomics overview: all passed.");
