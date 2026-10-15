/**
 * components/platform/widgets/product-analytics.test.ts  (BETA V3 · Workstream W4)
 *
 * RENDER-PATH proof for the Growth & Revenue "Product analytics" surface
 * (house pattern: standalone tsx + renderToStaticMarkup, DB-free):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/product-analytics.test.ts
 *
 * The fixture is typed against the FROZEN W3→W4 contract
 * (lib/platform/growth/product-analytics-types.ts), so a field the contract
 * drops fails the typecheck here rather than rendering blank in production.
 *
 * Pinned:
 *   1. the self-fetching widget's first frame is loading inside ONE SectionSurface
 *   2. the three strata words are visible in every window — never a single "active" figure
 *   3. registrations: three BigStats + a per-day series over the whole window (zero, not gap)
 *   4. retention: a too-young cohort reads "not yet measurable"; no denominator is an em-dash, never 0 %
 *   5. the onboarding funnel carries the FunnelStages grammar and the abandonment count
 *   6. feature adoption: four columns, three-state cells, every basis in Technical details
 *   7. cost per engaged user: ESTIMATED with derivation; null ⇒ Unavailable with the reason
 *   8. footnote = the reader's exclusions + the Customer Success note; no doorway to another area
 *   9. privacy: no username, email, Space name or id reaches the markup
 *  10. purity: the view authors no metric; the widget fetches ONE literal url and imports no server module
 *  11. grammar: md: collapse by class, tokens only, word + count on every distribution
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProductAnalyticsResponse } from "@/lib/platform/growth/product-analytics-types";
import { GrowthProductAnalyticsWidget, ProductAnalyticsSurface } from "./GrowthProductAnalyticsWidget";
import {
  CS_NOTE, NOT_MEASURED, NOT_YET_MEASURABLE, PRODUCT_ANALYTICS_URL,
  activeTiles, costReading, daySeries, featureRows, footnoteText, funnelRows, retentionCell, retentionRows, windowDayKeys,
} from "./product-analytics-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const WIDGET = "components/platform/widgets/GrowthProductAnalyticsWidget.tsx";
const VIEW = "components/platform/widgets/product-analytics-view.ts";
const SECTION = { id: "sec_pa", key: "growth_product_analytics", label: "Product analytics" };

// ── Fixture (typed against the frozen contract) ──────────────────────────────

const CHECKED_AT = "2026-10-15T09:12:00.000Z";

const fixture: ProductAnalyticsResponse = {
  checkedAt: CHECKED_AT,
  windowDays: 30,
  registrations: {
    total: 12, deactivated: 1, last7d: 3, last30d: 9,
    perDay: [{ day: "2026-10-13", count: 2 }, { day: "2026-10-15", count: 1 }],
  },
  active: {
    daily: { present: 4, engaged: 2, signIns: 1 },
    weekly: { present: 7, engaged: 5, signIns: 3 },
    monthly: { present: 10, engaged: 8, signIns: 6 },
    perDay: [{ day: "2026-10-14", present: 3, engaged: 1 }, { day: "2026-10-15", present: 4, engaged: 2 }],
  },
  retention: {
    returningEver: { count: 6, rate: 0.5 },
    cohorts: [
      { weekStart: "2026-09-28", cohortSize: 4, d1: 0.25, d7Window: 0.5, d7Strict: 0 },
      { weekStart: "2026-10-05", cohortSize: 0, d1: null, d7Window: null, d7Strict: null },
      { weekStart: "2026-10-12", cohortSize: 3, d1: 2 / 3 }, // too young for D7
    ],
    abandonmentHorizonDays: 7,
  },
  funnel: [
    { key: "registered", label: "Registered", count: 12 },
    { key: "verified", label: "Verified", count: 11, rate: 11 / 12, abandoned: 1 },
    { key: "firstSession", label: "First session", count: 10, rate: 10 / 11, abandoned: 1 },
    { key: "firstConnection", label: "First connection", count: 7, rate: 0.7, abandoned: 3 },
    { key: "firstAiTurn", label: "First AI turn", count: 5, rate: null, abandoned: 2 },
    { key: "firstBriefViewed", label: "First Brief viewed", count: 4, rate: 0.8 },
    { key: "returned", label: "Returned", count: 6 },
  ],
  features: [
    { key: "aiChat", label: "AI chat", adopters: 5, adoption: 5 / 12, frequencyPerEngagedUserPerWeek: 1.4, basis: "AiInvocation surface chat with a userId" },
    { key: "dailyBrief", label: "Daily Brief", adopters: 4, adoption: null, frequencyPerEngagedUserPerWeek: null, basis: "BRIEF_VIEWED product events" },
    { key: "exports", label: "Exports", adopters: 0, basis: "EXPORT_* audit actions" },
  ],
  cost: { aiUsd: 1.25, plaidUsd: 2.75, engagedUsers: 8, perEngagedUserUsd: 0.5, tier: "ESTIMATED", notes: ["Plaid is the current billing cycle's Item-months."] },
  exclusions: ["cron, webhook and operator executions", "harness invocations", "operator actions"],
};

const render = (data: ProductAnalyticsResponse) => {
  const html = renderToStaticMarkup(createElement(ProductAnalyticsSurface, { title: SECTION.label, data }));
  return { html, text: text(html) };
};
const badgeWords = (html: string) => [...html.matchAll(/<span class="text-xs font-medium">([^<]*)<\/span>/g)].map((m) => m[1]);

function main() {
  console.log("1. first frame");
  {
    const html = renderToStaticMarkup(createElement(GrowthProductAnalyticsWidget, { section: SECTION }));
    const t = text(html);
    check("one surface titled from the section, loading", (html.match(/<section/g) ?? []).length === 1 && t.includes("Product analytics") && /role="status"/.test(html));
    check("no figure in the loading frame", !/\d/.test(t), t);
  }

  console.log("2. three strata, every window");
  {
    const { html, text: t } = render(fixture);
    const words = badgeWords(html);
    check("present · engaged · sign-ins each appear three times (D/W/M)",
      words.filter((w) => w === "present").length === 3 && words.filter((w) => w === "engaged").length === 3 && words.filter((w) => w === "sign-ins").length === 3, words.join(","));
    check("the three windows are named", ["Daily · today UTC", "Weekly · last 7 d", "Monthly · last 30 d"].every((w) => t.includes(w)));
    check("no 'active users' figure anywhere", !/\bactive users?\b/i.test(t), t.match(/.{30}active.{30}/i)?.[0]);
    check("the sign-ins basis says it is not an activity metric", t.includes("not an activity metric"));
    const tiles = activeTiles(fixture.active);
    check("the view keeps the strata order present → engaged → sign-ins in every window",
      tiles.every((w) => w.tiles.map((x) => x.key).join(",") === "present,engaged,signIns") && tiles.length === 3);
    check("strata tiles carry no verdict colour (muted tone only)", !/tone="(ok|bad|warn|info)"/.test(strip(WIDGET).slice(strip(WIDGET).indexOf("StatusTile key"), strip(WIDGET).indexOf("StatusTile key") + 300)));
  }

  console.log("3. registrations");
  {
    const { text: t, html } = render(fixture);
    check("Accounts · last 7 d · last 30 d as BigStats", t.includes("Accounts") && t.includes("Registered · last 7 d") && t.includes("Registered · last 30 d") && t.includes("1 deactivated"));
    const keys = windowDayKeys(CHECKED_AT, 30);
    check("the window's day keys end on checkedAt's UTC day and span the window", keys.length === 30 && keys[29] === "2026-10-15" && keys[0] === "2026-09-16", `${keys[0]}..${keys[29]}`);
    const series = daySeries(CHECKED_AT, 30, fixture.registrations.perDay.map((d) => ({ day: d.day, value: d.count })), "registered");
    check("a day the reader did not list is zero, never a gap (complete ledger)", series.every((p) => p.value !== null) && series.find((p) => p.key === "2026-10-13")?.value === 2 && series.find((p) => p.key === "2026-10-14")?.value === 0);
    check("the series is a role=img with its totals in words", /aria-label="Registrations per UTC day · last 30: 30 buckets, 30 observed, total 3 registered, peak 2 registered on 2026-10-13"/.test(html));
    check("present and engaged have their own per-day series", /aria-label="Present per UTC day:/.test(html) && /aria-label="Engaged per UTC day:/.test(html));
  }

  console.log("4. retention");
  {
    const { text: t } = render(fixture);
    const rows = retentionRows(fixture.retention.cohorts);
    check("rows keep the reader's order", rows.map((r) => r.key).join(",") === "2026-09-28,2026-10-05,2026-10-12");
    check("a too-young cohort reads not yet measurable", rows[2].d7Window.text === NOT_YET_MEASURABLE && rows[2].d7Strict.text === NOT_YET_MEASURABLE && t.includes(NOT_YET_MEASURABLE));
    check("no denominator is an em-dash with its reason, never 0%", rows[1].d1.text === "—" && rows[1].d1.qualifier === "no denominator" && !/\b0%/.test(t.slice(t.indexOf("week of 2026-10-05"), t.indexOf("week of 2026-10-12"))));
    check("a measured 0 is 0% (a fact), distinct from unmeasured", rows[0].d7Strict.text === "0%" && retentionCell(0).text === "0%");
    check("returning ever renders count and share", t.includes("Returning ever") && t.includes("50% of users engaged on a day after their first visit"));
    for (const h of ["First-visit week", "Cohort", "D1", "D7 window", "D7 strict"]) check(`column "${h}"`, t.includes(h));
  }

  console.log("5. onboarding funnel");
  {
    const { text: t, html } = render(fixture);
    const rows = funnelRows(fixture.funnel, 7);
    check("first stage has no rate and no bar share of itself", rows[0].rateText === null && rows[0].fraction === 1);
    check("a null rate is the em-dash (no denominator), an undefined rate renders nothing", rows[4].rateText === "—" && rows[6].rateText === null);
    check("abandonment is stated with the horizon", rows[3].abandonedText === "3 abandoned · no next step within 7 d" && t.includes("3 abandoned · no next step within 7 d"));
    check("a stage without an abandonment figure gets none", rows[0].abandonedText === null && rows[6].abandonedText === null);
    check("rows are numbered and not selectable (no stage panel here)", /<span class="w-3 shrink-0 text-\[10px\] tabular-nums text-\[var\(--text-faint\)\]">1<\/span>/.test(html) && !/aria-pressed/.test(html));
    check("the bar share comes from growth-funnel-view (one funnel rule)", /from "\.\/growth-funnel-view"/.test(strip(VIEW)) && /barFraction\(/.test(strip(VIEW)));
  }

  console.log("6. feature adoption");
  {
    const { text: t, html } = render(fixture);
    const rows = featureRows(fixture.features);
    for (const h of ["Feature", "Adopters", "Adoption", "Frequency"]) check(`column "${h}"`, t.includes(h));
    check("adoption is the reader's share; frequency is per engaged user per week", rows[0].adoptionText === "42%" && rows[0].frequencyText === "1.4 per engaged user per week");
    check("null ⇒ em-dash + no denominator; undefined ⇒ not measured", rows[1].adoptionText === "— no denominator" && rows[2].adoptionText === NOT_MEASURED && rows[2].frequencyText === NOT_MEASURED);
    check("every basis is in the Technical details disclosure", /<details/.test(html) && t.includes("Technical details") && fixture.features.every((f) => t.includes(f.basis)));
    check("the basis is NOT on the row itself", t.indexOf("AiInvocation surface chat") > t.indexOf("Technical details"));
  }

  console.log("7. cost per engaged user");
  {
    const { text: t } = render(fixture);
    check("figure with the estimate caption and derivation", t.includes("$0.50") && t.includes("estimate, not a bill") && t.includes("AI $1.25 + Plaid $2.75 ÷ 8 engaged users · ESTIMATED"));
    const unpriced = costReading({ ...fixture.cost, aiUsd: null, perEngagedUserUsd: null });
    check("AI unpriced ⇒ unavailable with the reason", unpriced.kind === "unavailable" && /AI spend could not be priced/.test(unpriced.reason));
    const nobody = costReading({ ...fixture.cost, engagedUsers: 0, perEngagedUserUsd: null });
    check("no engaged users ⇒ no denominator, never $0", nobody.kind === "unavailable" && /no denominator/.test(nobody.reason));
    const r2 = render({ ...fixture, cost: { ...fixture.cost, aiUsd: null, plaidUsd: null, perEngagedUserUsd: null } });
    check("the surface renders Unavailable (em-dash + reason), not a dollar figure", r2.text.includes("— AI spend could not be priced") && !/\$0\.00/.test(r2.text.slice(r2.text.indexOf("Cost per engaged user"))));
    check("the reader's notes are listed", t.includes("Plaid is the current billing cycle's Item-months."));
  }

  console.log("8. footnote and doorways");
  {
    const { text: t, html } = render(fixture);
    check("exclusions are the footnote", t.includes("Excluded by the projection: cron, webhook and operator executions · harness invocations · operator actions."));
    check("the Customer Success note closes the footnote", t.includes(CS_NOTE) && footnoteText([]) === CS_NOTE);
    check("no doorway button (no platform-* id for another area)", !/aria-label="Open /.test(html) && !/onOpenWorkspace\(/.test(strip(WIDGET)));
    check("checkedAt and the window are stated in the header", t.includes("computed 2026-10-15 09:12 UTC · window 30 d"));
  }

  console.log("9. privacy");
  {
    const leaky: ProductAnalyticsResponse = { ...fixture, exclusions: [...fixture.exclusions] };
    const { html } = render(leaky);
    check("no email-shaped string", !/[\w.+-]+@[\w-]+\.[\w.]+/.test(html));
    check("no cuid-shaped id", !/\bc[a-z0-9]{24}\b/.test(html));
    const src = strip(WIDGET);
    check("the widget reads only the contract type from lib/platform/growth", /import type \{ ProductAnalyticsResponse \} from "@\/lib\/platform\/growth\/product-analytics-types"/.test(src) && !/from "@\/lib\/platform\/growth\/(growth|product-analytics)"/.test(src));
    check("the widget never renders a username, Space name or id field", !/\.(username|email|spaceName|userId|spaceId|name)\b/.test(src));
  }

  console.log("10. purity");
  {
    const view = strip(VIEW);
    check("the view declares no function ending in Rate", !/function \w*Rate\(/.test(view));
    check("the view divides no count (the one share is imported)", !/\b(count|adopters|engaged|present|total|cohortSize)\w*\s*\/\s*/.test(view));
    check("the view imports no React, no server module", !/from "react"|server-only|@\/lib\/db/.test(view));
    const src = strip(WIDGET);
    check("exactly one read, the contract url as a literal", (src.match(/useWidgetFetch</g) ?? []).length === 1 && src.includes(`useWidgetFetch<ProductAnalyticsResponse>("${PRODUCT_ANALYTICS_URL}")`));
    check("no sort, no clock, no fetch beyond the hook", !/\.sort\(/.test(src) && !/Date\.now\(/.test(src) && !/[^d]fetch\(/.test(src));
    check("is a client component that imports no reader", /^"use client";/.test(readFileSync(path.join(ROOT, WIDGET), "utf8")) && !/customer-core|@\/lib\/db|server-only/.test(src));
  }

  console.log("11. grammar");
  {
    const { html } = render(fixture);
    const src = strip(WIDGET);
    check("table headers are hidden below md and a grid above", (html.match(/class="mb-1 hidden items-center gap-4 border-b px-1 pb-2 md:grid"/g) ?? []).length === 2);
    check("cells carry their column word below md", /md:hidden/.test(html) && /md:grid/.test(html));
    check("tables own horizontal scroll", (html.match(/overflow-x-auto/g) ?? []).length >= 2);
    check("no raw hex, no palette class", !/#[0-9a-fA-F]{3,8}\b/.test(src) && !/\b(?:bg|text|border)-(?:gray|blue|red|emerald|green)-\d{2,3}\b/.test(src));
    check("no coral-500/600", !/--coral-(5|6)00/.test(html));
    check("no JS viewport read", !/matchMedia|innerWidth|useNarrowViewport/.test(src));
    check("nothing hover-only: no element carries a title attribute (GroupLabel hints are aria-labelled)", !/<(span|div|li|button|p)\b[^>]*\stitle=/.test(src));
  }

  if (failures > 0) { console.error(`\nproduct-analytics.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nproduct-analytics.test: all passed.");
}

main();
