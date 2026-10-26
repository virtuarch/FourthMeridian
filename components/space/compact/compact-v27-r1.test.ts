/**
 * components/space/compact/compact-v27-r1.test.ts  (v2.7 R1 — compact Space header)
 *
 *   1. compact header row: the Space name ONCE (title weight), then USD / Manage;
 *      no date control and no view selector in it;
 *   2. compact rail: Overview · Activity · Accounts · Transactions — Members
 *      withheld below lg only (owner D-1); the desktop rail keeps Members and its
 *      ≥1024px markup equals the P0 baseline;
 *   3. financial controls row (Overview): selector LEFT, date trigger RIGHT, one
 *      row; exactly ONE TimelineLens in the server markup; Markets has no trigger
 *      below lg; trust caveats stay below the row;
 *   4. D-10 short label below sm (compact-only, aria-hidden; the full label stays
 *      the trigger's description target);
 *   5. desktop: the PerspectiveShell ≥1024px markup is unchanged by any of it.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/compact-v27-r1.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { desktopMarkup } from "./desktop-markup";
import { SpaceShell } from "@/components/space/shell/SpaceShell";
import { PerspectiveShell } from "@/components/space/shell/PerspectiveShell";
import { CompactViewSelector } from "@/components/space/shell/CompactViewSelector";
import { shortPeriodLabel, summarize } from "@/components/space/shell/perspective-time-adapter";
import type { PerspectiveTimeState } from "@/lib/perspectives/time-range";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const ids = (h: string) => h.replace(/_R_\w+_/g, "ID"); // React useId values are opaque
const baseline = JSON.parse(read("components/space/compact/desktop-baseline.json")) as { renders: Record<string, string> };

const RAIL = ["Overview", "Activity", "Accounts", "Transactions", "Members"].map((label) => ({ id: label.toUpperCase(), label }));
const COMPACT_RAIL = RAIL.filter((o) => o.id !== "MEMBERS");
const shell = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SpaceShell, {
  title: "Chris's Space", subtitle: "Personal · Updated 3h ago", currencyControl: createElement("button", { type: "button" }, "USD"), onManage: () => {},
  railOptions: RAIL, compactRailOptions: COMPACT_RAIL, activeTab: "OVERVIEW", onSelectTab: () => {}, mobileOptimized: true,
  children: createElement("p", null, "content"), ...extra,
} as never));

const ITEMS = [
  { id: "networth", label: "Net Worth", hasWorkspace: true },
  { id: "cashFlow", label: "Cash Flow", hasWorkspace: true },
  { id: "markets", label: "Markets", hasWorkspace: false },
];
const TODAY = "2026-10-16";
const MTD: PerspectiveTimeState = { preset: "MTD", asOf: TODAY, compareTo: "2026-10-01" };
const noop = () => {};
const ps = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PerspectiveShell as never, {
  today: TODAY, onAsOfChange: noop, onCompareToChange: noop, onSwap: noop, onSelectPreset: noop,
  envelope: { warnings: [{ kind: "fx", label: "FX rate unavailable", detail: "EUR had no rate." }] },
  temporalCapability: { asOf: "full", compareTo: "full", period: "none" }, timeState: MTD,
  tabs: [], activeTabId: null, onSelectTab: noop, tabsVisibility: "none",
  compactViewSelector: createElement(CompactViewSelector, { items: ITEMS, activeId: "networth", onSelect: noop }), ...extra,
} as never));
/** The compact header row (the first lg:hidden mb-5 row). */
const headerRow = (h: string) => { const i = h.indexOf('class="lg:hidden mb-5'); return h.slice(i, h.indexOf("data-compact-rail", i)); };

console.log("1. the compact header row");
{
  const html = shell({ compactTitleOnly: true });
  const row = headerRow(html);
  check("the Space name, title weight, truncating", /<h1 class="lg:hidden truncate text-lg font-semibold[^"]*">Chris&#x27;s Space<\/h1>/.test(row), row.slice(0, 300));
  check("the name renders ONCE in the compact header (no subtitle line repeating it, no small eyebrow copy)",
    (row.match(/Chris&#x27;s Space/g) ?? []).length === 1 && !/Updated 3h ago/.test(row) && !/<h1 class="[^"]*text-\[13px\]/.test(row));
  check("order: name, then USD, then Manage", row.indexOf("Chris&#x27;s Space") < row.indexOf(">USD<") && row.indexOf(">USD<") < row.indexOf("Manage"));
  check("no date control and no view selector in the header row", !/data-timeline-period|data-compact-view-selector|fm-compact-time-slot/.test(row));
  const tx = headerRow(shell({ activeTab: "TRANSACTIONS" }));
  check("non-Overview tabs keep name + subtitle + controls (unchanged)", /<h1 class="truncate text-lg font-semibold[^"]*">Chris&#x27;s Space<\/h1><p[^>]*>Personal · Updated 3h ago<\/p>/.test(tx) && /Manage/.test(tx));
  check("host: title-only on Overview, the compact rail without Members",
    /compactTitleOnly=\{activeTab === "OVERVIEW"\}/.test(code("components/dashboard/SpaceDashboard.tsx"))
      && /const compactRailOptions = railOptions\.filter\(\(o\) => o\.id !== "MEMBERS"\);/.test(code("components/dashboard/SpaceDashboard.tsx")));
}

console.log("\n2. the compact rail");
{
  const html = shell({ compactTitleOnly: true });
  const compactRail = html.slice(html.indexOf("data-compact-rail"), html.indexOf('class="max-lg:hidden mb-7'));
  const tabs = [...compactRail.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
  check("compact rail: exactly Overview · Activity · Accounts · Transactions", tabs.join(",") === "Overview,Activity,Accounts,Transactions", tabs.join(","));
  check("the compact rail is compact-only (lg:hidden)", /<div class="lg:hidden mb-7 flex justify-center[^"]*" data-compact-rail="true">/.test(html));
  // v2.7 rail-fit — DELIBERATE: four tabs fit 375px (Transactions was clipped by 21px).
  check("below sm the compact rail tightens tab padding (compact wrapper only)", /<div class="lg:hidden mb-7 flex justify-center max-sm:\[&amp;_button\]:px-3" data-compact-rail="true">/.test(html));
  const desk = desktopMarkup(html);
  check("desktop rail still includes Members", /role="tab"[^>]*>Members</.test(desk) && !/data-compact-rail/.test(desk));
  check("DESKTOP: the ≥1024px SpaceShell markup equals the P0 baseline", desk === baseline.renders["SpaceShell (customer, Overview)"]);
  const members = shell({ compactTitleOnly: false, activeTab: "MEMBERS" });
  const cr = members.slice(members.indexOf("data-compact-rail"), members.indexOf('class="max-lg:hidden mb-7'));
  check("active MEMBERS on compact: no compact segment is selected (no redirect)", !/aria-selected="true"/.test(cr) && /aria-selected="true"[^>]*>Members</.test(members));
  const legacy = renderToStaticMarkup(createElement(SpaceShell, {
    title: "T", subtitle: "S", railOptions: RAIL, activeTab: "OVERVIEW", onSelectTab: noop, railVisibility: "belowLg", compactRailOptions: COMPACT_RAIL, children: null,
  } as never));
  check("a belowLg (Platform) rail ignores the compact set — one rail, unchanged", !/data-compact-rail/.test(legacy) && /role="tab"[^>]*>Members</.test(legacy));
}

console.log("\n3. the financial controls row");
{
  const html = ps();
  check("one controls row: selector LEFT, date trigger RIGHT, justify-between, never wraps",
    /<div data-compact-controls="" class="px-1 max-lg:flex max-lg:flex-nowrap max-lg:items-center max-lg:justify-between max-lg:gap-3">/.test(html)
      && html.indexOf("data-compact-view-selector") < html.indexOf("data-timeline-period"));
  check("the trigger side keeps its size and does not wrap below lg", /class="flex flex-wrap items-center justify-center gap-2 max-lg:shrink-0 max-lg:flex-nowrap max-lg:\[&amp;_\[data-timeline-period\]~span\]:hidden"/.test(html));
  check("exactly ONE TimelineLens in the server markup", (html.match(/data-timeline-period="true"/g) ?? []).length === 1 && (html.match(/aria-label="Change time period"/g) ?? []).length === 1);
  check("trust caveat chips render BELOW the controls row", html.indexOf("FX rate unavailable") > html.indexOf("data-timeline-period"));
  const markets = ps({ compactHideTime: true });
  check("Markets: the row keeps only the selector below lg (trigger container max-lg:hidden, no short label)",
    /class="flex flex-wrap items-center justify-center gap-2 max-lg:hidden"/.test(markets) && /data-compact-view-selector/.test(markets) && !/data-timeline-period-short/.test(markets));
  check("Markets without a selector: the whole row is compact-hidden (prior semantics)", /<div class="px-1 max-lg:hidden">/.test(ps({ compactHideTime: true, compactViewSelector: undefined })));
}

console.log("\n4. D-10 short date label below sm");
{
  const html = ps();
  const short = /<span aria-hidden="true" data-timeline-period-short="true" class="([^"]*)">([^<]*)<\/span>/.exec(html);
  check("present inside the trigger, short form of the preset", short !== null && short[2] === "MTD", short?.[2]);
  check("compact-only and below sm only (lg:hidden, hidden, max-sm:inline)", short !== null && short[1].split(" ").includes("lg:hidden") && short[1].split(" ").includes("hidden") && short[1].split(" ").includes("max-sm:inline"));
  check("the full label is hidden only below sm (max-lg:max-sm:hidden) and stays the description target",
    /<strong id="([^"]+)" class="[^"]*max-lg:max-sm:hidden">Month to date<\/strong>/.test(html)
      && new RegExp(`aria-describedby="${/<strong id="([^"]+)"/.exec(html)?.[1]} `).test(html));
  const cases: [PerspectiveTimeState, string][] = [
    [{ preset: "PAST_MONTH", asOf: TODAY, compareTo: "2026-09-16" }, "1M"],
    [{ preset: "PAST_QUARTER", asOf: TODAY, compareTo: "2026-07-16" }, "3M"],
    [{ preset: "PAST_YEAR", asOf: TODAY, compareTo: "2025-10-16" }, "1Y"],
    [{ preset: "YTD", asOf: TODAY, compareTo: "2026-01-01" }, "YTD"],
    [{ preset: "ALL", asOf: TODAY, compareTo: null }, "All"],
    [{ preset: "CUSTOM", asOf: TODAY, compareTo: "2026-03-02" }, "Custom"],
  ];
  check("short forms derive from the canonical preset vocabulary", cases.every(([s, want]) => shortPeriodLabel(s) === want), cases.map(([s]) => shortPeriodLabel(s)).join(","));
  check("the full label is unchanged (summarize)", summarize(MTD, TODAY).periodLabel === "Month to date");
  check("no compact row ⇒ no short label (other hosts' trigger markup unchanged)", !/data-timeline-period-short/.test(ps({ compactViewSelector: undefined })));
}

console.log("\n5. desktop is unchanged");
{
  const plain = ids(desktopMarkup(ps({ compactViewSelector: undefined })));
  check("Overview: ≥1024px markup with the controls row equals the plain centred time row", ids(desktopMarkup(ps())) === plain);
  check("…no selector, no short label, no compact marker survives", !/data-compact|data-timeline-period-short|max-lg:/.test(desktopMarkup(ps())));
  check("Markets: ≥1024px markup unchanged", ids(desktopMarkup(ps({ compactHideTime: true }))) === ids(desktopMarkup(ps({ compactHideTime: true, compactViewSelector: undefined }))));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
