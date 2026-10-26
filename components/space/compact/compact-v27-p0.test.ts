/**
 * components/space/compact/compact-v27-p0.test.ts  (v2.7 P0 — compact visual refinement)
 *
 *   1. the compact Net Worth hero shows ONLY: title, amount, $ change, % change,
 *      comparison range, latest observed date — from the same WealthResult; the
 *      Assets / Liabilities / Liquid NW line is compact-hidden (kept on desktop
 *      and in the detailed sections); the freshness line is the canonical
 *      "Last checked" claim or "As of <snapshot date>", never a snapshot date
 *      presented as fresh data;
 *   2. the compact time control is the SAME TimelineLens, portalled into the
 *      header slot beside Manage (client-only), the in-flow row compact-hidden;
 *      never for Markets; desktop unchanged;
 *   3. Total · Assets · Debt is a prominent primary segmented control on compact,
 *      the category tabs a quieter secondary row.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/compact-v27-p0.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { desktopMarkup } from "./desktop-markup";
import { CompactSectionTabs } from "./CompactSectionTabs";
import { WealthHero } from "@/components/space/widgets/wealth/WealthHero";
import { SpaceShell } from "@/components/space/shell/SpaceShell";
import { COMPACT_TIME_SLOT_ID, COMPACT_TIME_WRAPPER } from "@/components/space/shell/compact-time";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
/** Only the compact meta block (it ends where the desktop stat line begins). */
const compactPart = (h: string) => {
  const from = h.slice(h.indexOf("data-compact-hero-meta"));
  const end = from.indexOf('<div class="mt-3 flex flex-wrap');
  return end === -1 ? from : from.slice(0, end);
};

const STATE = { found: true, date: "2026-10-16", netWorth: -77164.15, totalAssets: 86541.74, totalLiabilities: 163705.89, liquidNetWorth: -101116.89, cash: 62589, invested: 23952.74, composition: { investments: 23952.74, crypto: 0 } };
const RESULT = {
  hasHistory: true,
  asOfState: STATE,
  compareState: { ...STATE, date: "2026-09-26", netWorth: -88685.03 },
  deltas: { netWorth: { abs: 11521.88, pct: 13 }, totalAssets: { abs: 11521.88, pct: 15.4 }, totalLiabilities: { abs: 0, pct: 0 }, liquidNetWorth: { abs: -85.18, pct: 0.1 }, cash: { abs: -85.18, pct: 0.1 }, invested: { abs: 11607.06, pct: 94 } },
};
const ENVELOPE = { completeness: "complete", warnings: [] };
const hero = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(WealthHero, { result: RESULT, currency: "USD", envelope: ENVELOPE, metric: "netWorth", ...extra } as never));

console.log("1. the compact Net Worth hero");
{
  const html = hero();
  const compact = text(compactPart(html));
  check("title and amount (the one figure, shared with desktop)", /Net worth/.test(text(html)) && /77,164\.15/.test(text(html)));
  check("compact: the $ change and the % change", /11,521\.88/.test(compact) && /13\.0%/.test(compact));
  check("compact: the comparison range, compare date → as-of date", /Sep 26, 2026 → Oct 16, 2026/.test(compact), compact);
  check("compact, no freshness claim: \"As of <snapshot date>\" — the snapshot date is never labelled as fresh data",
    /As of Oct 16, 2026/.test(compact) && !/Latest data|updated|refreshed|checked/i.test(compact));
  const claimed = text(compactPart(hero({ freshnessLabel: "Last checked 3 days ago" })));
  check("compact, with the canonical claim: it shows that claim verbatim (the chrome subtitle's source), not the snapshot date",
    /Last checked 3 days ago/.test(claimed) && !/As of Oct 16/.test(claimed));
  const host = code("components/dashboard/SpaceDashboard.tsx");
  check("the host passes the SAME chromeUpdated claim the subtitle uses", /wealthFreshnessLabel: chromeUpdated,/.test(host)
    && /freshnessLabel=\{ctx\.wealthFreshnessLabel \?\? null\}/.test(read("components/space/workspaces/workspaceRenderers.tsx"))
    && /metric=\{metric\} freshnessLabel=\{freshnessLabel\}/.test(read("components/space/widgets/wealth/WealthWorkspace.tsx")));
  check("compact: nothing else — no Assets / Liabilities / Liquid NW stat", !/Assets|Liabilities|Liquid NW/.test(compact));
  check("the stat line is compact-hidden (max-lg:hidden), so it stays on desktop", /max-lg:hidden"><span class="inline-flex items-baseline gap-1\.5 tabular-nums"><span[^>]*>Assets</.test(html));
  const desk = desktopMarkup(html);
  check("DESKTOP: the hero keeps its stat line, delta-with-compare and As-of line; no compact meta",
    /Assets/.test(text(desk)) && /Liabilities/.test(text(desk)) && /vs Sep 26, 2026/.test(text(desk)) && /As of Oct 16, 2026/.test(text(desk)) && !/data-compact-hero-meta/.test(desk) && !/Latest data/.test(desk));
  const noCompare = hero({ result: { ...RESULT, deltas: null, compareState: null } });
  check("no comparison ⇒ no invented change or range; the compact hint points at the date menu",
    !/→/.test(text(compactPart(noCompare))) && /Choose a comparison in the date menu/.test(text(compactPart(noCompare))));
  check("every compact-meta element is lg:hidden", (compactPart(html).match(/<p class="|<span class="/g) ?? []).length > 0 && !/<p class="(?!lg:hidden)/.test(compactPart(html).split("</div>")[0]));
}

console.log("\n2. the compact time control");
{
  const ps = code("components/space/shell/PerspectiveShell.tsx");
  const host = code("components/dashboard/SpaceDashboard.tsx");
  check("the SAME TimelineLens (same props, same intent handler) is portalled into the header slot",
    /createPortal\(\s*<div className=\{COMPACT_TIME_WRAPPER\} data-compact-time>\s*<TimelineLens[\s\S]{0,500}onIntent=\{handleTimelineIntent\}/.test(ps));
  check("client-only (the slot is read after mount) — the server markup holds one lens", /setHeaderSlot\(props\.compactTimeInHeader \? document\.getElementById\(COMPACT_TIME_SLOT_ID\) : null\)/.test(ps));
  check("the in-flow time row is compact-hidden when the header copy is active", /props\.compactHideTime \|\| props\.compactTimeInHeader \? "px-1 max-lg:hidden" : "px-1"/.test(ps));
  check("never for Markets (no time controls there)", /compactTimeInHeader=\{activePerspectiveId !== "markets"\}/.test(host) && /props\.compactTimeInHeader && !props\.compactHideTime/.test(ps));
  check("the header copy shows only the trigger, and only below lg", COMPACT_TIME_WRAPPER.split(" ").every((t) => t === "lg:hidden" || t.startsWith("[&_")));
  const shellHtml = renderToStaticMarkup(createElement(SpaceShell, {
    title: "Chris's Space", subtitle: "Personal", currencyControl: null, onManage: () => {}, compactTimeSlot: true,
    railOptions: [{ id: "OVERVIEW", label: "Overview" }], activeTab: "OVERVIEW", onSelectTab: () => {}, children: createElement("p", null, "x"),
  } as never));
  check("the slot sits beside Manage in the compact header", new RegExp(`<div id="${COMPACT_TIME_SLOT_ID}" data-compact-time-slot="true" class="lg:hidden"></div>[\\s\\S]{0,400}Manage`).test(shellHtml));
  check("Overview only", /compactTimeSlot=\{activeTab === "OVERVIEW"\}/.test(host));
  check("DESKTOP: the slot never renders at ≥1024px", !desktopMarkup(shellHtml).includes(COMPACT_TIME_SLOT_ID));
}

console.log("\n3. Total · Assets · Debt is prominent; category tabs are secondary");
{
  const primary = renderToStaticMarkup(createElement(CompactSectionTabs, { ariaLabel: "Net worth view", variant: "primary", value: "total", onChange: () => {}, tabs: [{ id: "total", label: "Total", controls: [] }, { id: "assets", label: "Assets", controls: [] }, { id: "debt", label: "Debt", controls: [] }] } as never));
  const secondary = renderToStaticMarkup(createElement(CompactSectionTabs, { ariaLabel: "Assets category", value: "all", onChange: () => {}, tabs: [{ id: "all", label: "All", controls: [] }] } as never));
  check("primary: 44px segments, larger semibold type, a framed track", /min-h-11/.test(primary) && /text-\[15px\] font-semibold/.test(primary) && /data-variant="primary"/.test(primary));
  check("secondary: quieter pill row, still ≥40px touch targets", /min-h-10/.test(secondary) && /rounded-full/.test(secondary) && /data-variant="secondary"/.test(secondary));
  const ww = code("components/space/widgets/wealth/WealthWorkspace.tsx");
  check("the compact mode selector is the primary variant over the SAME mode/handler; desktop keeps its Chips",
    /variant="primary"\s+value=\{mode\}\s+onChange=\{\(m\) => onModeChange\?\.\(m\)\}/.test(ww) && /modeSelectorVisibility === "belowLg" \? \(/.test(ww) && /<Chips\s+options=\{WEALTH_MODES\.map/.test(ww));
  check("Debt category tabs remain withheld", /export const DEBT_CATEGORY_TABS_ENABLED = false;/.test(read("lib/wealth/wealth-mode.ts")));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
