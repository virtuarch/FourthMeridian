/**
 * components/space/compact/compact-v27-p0.test.ts  (v2.7 P0 — compact visual refinement)
 *
 *   1. the compact Net Worth hero shows ONLY: title, amount, $ change, % change,
 *      comparison range, latest observed date — from the same WealthResult; the
 *      Assets / Liabilities / Liquid NW line is compact-hidden (kept on desktop
 *      and in the detailed sections); the freshness line is the canonical
 *      "Last checked" claim or "As of <snapshot date>", never a snapshot date
 *      presented as fresh data;
 *   2. the compact time control is the ONE in-flow TimelineLens (v2.7 R1 — the
 *      P0 header portal is deleted): below lg its row is the controls row
 *      (selector left, period trigger right, range readout hidden); never for
 *      Markets; desktop unchanged;
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
import { existsSync } from "node:fs";
import { SpaceShell } from "@/components/space/shell/SpaceShell";
import { PerspectiveShell } from "@/components/space/shell/PerspectiveShell";

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
  // v2.7 hero-tighten — DELIBERATE: the freshness claim moved into the label row
  // (owner: "next to Net Worth"); it is read from that element now.
  const fresh = (h: string) => text((h.match(/<span class="lg:hidden ml-auto[^"]*" data-compact-hero-freshness="true">[\s\S]*?<\/span>/) ?? [""])[0]);
  check("compact, no freshness claim: \"As of <snapshot date>\" in the label row — the snapshot date is never labelled as fresh data",
    /As of Oct 16, 2026/.test(fresh(html)) && !/Latest data|updated|refreshed|checked/i.test(fresh(html)) && !/data-compact-hero-freshness/.test(compactPart(html)));
  const claimedHtml = hero({ freshnessLabel: "Last checked 3 days ago" });
  check("compact, with the canonical claim: the label row shows it verbatim, not the snapshot date",
    /Last checked 3 days ago/.test(fresh(claimedHtml)) && !/As of Oct 16/.test(fresh(claimedHtml)));
  check("the freshness claim sits in the label row, after the metric label", claimedHtml.indexOf("Net worth") < claimedHtml.indexOf("data-compact-hero-freshness") && claimedHtml.indexOf("data-compact-hero-freshness") < claimedHtml.indexOf("data-compact-hero-meta"));
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
  check("v2.7 R1: the header portal is gone — no createPortal, no slot module, no slot prop",
    !/createPortal|headerSlot|COMPACT_TIME/.test(ps) && !existsSync(path.join(process.cwd(), "components/space/shell/compact-time.ts"))
      && !/compactTimeSlot|COMPACT_TIME/.test(code("components/space/shell/SpaceShell.tsx")) && !/compactTimeSlot|compactTimeInHeader/.test(host));
  check("exactly ONE TimelineLens in PerspectiveShell, wired to the same intent handler", (ps.match(/<TimelineLens\b/g) ?? []).length === 1 && /onIntent=\{handleTimelineIntent\}/.test(ps));
  check("compact-only: the range readout is hidden beside the trigger (max-lg)", /max-lg:\[&_\[data-timeline-period\]~span\]:hidden/.test(ps));
  check("never for Markets (no date trigger below lg)", /compactHideTime=\{activePerspectiveId === "markets"\}/.test(host)
    && /"flex flex-wrap items-center justify-center gap-2 max-lg:hidden"/.test(ps));
  const noop = () => {};
  const render = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(PerspectiveShell as never, {
    today: "2026-10-16", onAsOfChange: noop, onCompareToChange: noop, onSwap: noop, onSelectPreset: noop, envelope: {},
    temporalCapability: { asOf: "full", compareTo: "full", period: "none" }, timeState: { preset: "MTD", asOf: "2026-10-16", compareTo: "2026-10-01" },
    tabs: [], activeTabId: null, onSelectTab: noop, tabsVisibility: "none", compactViewSelector: createElement("div", { className: "relative lg:hidden" }, "Net Worth"), ...extra,
  } as never));
  const html = render({});
  check("server markup holds exactly one lens trigger", (html.match(/data-timeline-period="true"/g) ?? []).length === 1);
  const shellHtml = renderToStaticMarkup(createElement(SpaceShell, {
    title: "Chris's Space", subtitle: "Personal", currencyControl: null, onManage: () => {}, compactTitleOnly: true,
    railOptions: [{ id: "OVERVIEW", label: "Overview" }], activeTab: "OVERVIEW", onSelectTab: () => {}, children: createElement("p", null, "x"),
  } as never));
  check("the compact header carries no time control any more", !/data-timeline-period|fm-compact-time-slot/.test(shellHtml));
  const ns = (h: string) => h.replace(/_R_\w+_/g, "ID");
  check("DESKTOP: the controls-row markup is the plain centred time row at ≥1024px",
    ns(desktopMarkup(html)) === ns(desktopMarkup(render({ compactViewSelector: undefined }))));
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
  // v2.7 R3 — DELIBERATE: the tabs are enabled on the display-only presentationDebtClass (owner D-4/D-5).
  check("Debt category tabs are enabled (v2.7 R3)", /export const DEBT_CATEGORY_TABS_ENABLED = true;/.test(read("lib/wealth/wealth-mode.ts")));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
