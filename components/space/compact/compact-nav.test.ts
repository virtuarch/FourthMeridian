/**
 * components/space/compact/compact-nav.test.ts  (COMPACT DASHBOARD — P1)
 *
 *   1. the compact financial-view selector: a menu button, compact-only, showing
 *      the active view; WAI-ARIA menu semantics and keyboard handling in source;
 *   2. it lives in SpaceShell's compact header row (upper-left), and passing it —
 *      and the compact Leave control — changes NOTHING a ≥1024px viewport renders;
 *   3. the host feeds it the lens row's items and handler (same routing), on
 *      Overview only, and offers compact Leave only to roles that can leave.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/compact-nav.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { desktopMarkup } from "./desktop-markup";
import { CompactViewSelector, COMPACT_VIEW_MENU_LABEL } from "@/components/space/shell/CompactViewSelector";
import { SpaceShell } from "@/components/space/shell/SpaceShell";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const ITEMS = [
  { id: "networth", label: "Net Worth", hasWorkspace: true },
  { id: "cashFlow", label: "Cash Flow", hasWorkspace: true },
  { id: "markets", label: "Markets", hasWorkspace: false },
];
const RAIL = ["Overview", "Activity", "Accounts", "Transactions", "Members"].map((label) => ({ id: label.toUpperCase(), label }));
const shell = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SpaceShell, {
  title: "Chris's Space", subtitle: "Personal", currencyControl: null, onManage: () => {},
  railOptions: RAIL, activeTab: "OVERVIEW", onSelectTab: () => {}, mobileOptimized: true,
  children: createElement("p", null, "content"), ...extra,
} as never));
const baseline = JSON.parse(read("components/space/compact/desktop-baseline.json")) as { renders: Record<string, string> };

console.log("1. the selector");
{
  const html = renderToStaticMarkup(createElement(CompactViewSelector, { items: ITEMS, activeId: "cashFlow", onSelect: () => {} }));
  check("compact-only root (lg:hidden)", /^<div class="relative lg:hidden"/.test(html));
  check("a menu button: aria-haspopup=menu, collapsed by default", /aria-haspopup="menu"/.test(html) && /aria-expanded="false"/.test(html) && !/role="menu"/.test(html));
  check("it shows — and names — the active view", />Cash Flow</.test(html) && html.includes(`aria-label="${COMPACT_VIEW_MENU_LABEL}: Cash Flow"`));
  check("touch-sized (≥44px) and keyboard-focusable", /min-h-11/.test(html) && /focus-visible:ring-2/.test(html));
  check("an unknown active id falls back to the first view", />Net Worth</.test(renderToStaticMarkup(createElement(CompactViewSelector, { items: ITEMS, activeId: null, onSelect: () => {} }))));
  const src = code("components/space/shell/CompactViewSelector.tsx");
  check("the open menu is role=menu of menuitemradio items with aria-checked", /role="menu"/.test(src) && /role="menuitemradio"/.test(src) && /aria-checked=\{on\}/.test(src));
  check("keyboard: ArrowUp/Down, Home/End, Escape (focus returns to the button), Tab closes",
    ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab"].every((k) => src.includes(`"${k}"`)) && /close\(true\)/.test(src));
  check("an outside press closes it", /pointerdown/.test(src));
  check("a coming-soon destination says so in the menu (Markets)", /!i\.hasWorkspace && <span[^>]*>\{COMPACT_VIEW_SOON\}/.test(src));
  check("presentation only: no fetch, no URL access", !/fetch\(|history\.|location\.|useSearchParams/.test(src));
}

console.log("\n2. in the compact header — and invisible to desktop");
{
  const selector = createElement(CompactViewSelector, { items: ITEMS, activeId: "networth", onSelect: () => {} });
  const html = shell({ compactViewSelector: selector, onLeave: () => {} });
  check("the selector renders inside the compact header row, under the Space name",
    /<div class="lg:hidden mb-5[^"]*"><div class="min-w-0" data-compact-header="true"><h1 class="lg:hidden truncate text-\[13px\][^"]*">Chris&#x27;s Space<\/h1><div class="relative lg:hidden" data-compact-view-selector="true"/.test(html), html.slice(0, 400));
  check("Leave is offered in the compact controls when the host passes it", />Leave<\/button>/.test(html) && /<button type="button" class="lg:hidden min-h-9/.test(html));
  check("…and not otherwise", !/>Leave</.test(shell()));
  check("without a selector the compact header is exactly as before (title + subtitle)",
    /<h1 class="truncate text-lg font-semibold[^"]*">Chris&#x27;s Space<\/h1><p/.test(shell()));
  check("DESKTOP: with the selector and Leave passed, the ≥1024px markup equals the P0 baseline",
    desktopMarkup(html) === baseline.renders["SpaceShell (customer, Overview)"]);
}

console.log("\n3. the host wiring");
{
  const host = code("components/dashboard/SpaceDashboard.tsx");
  check("the selector gets the lens row's items + handler, on Overview only",
    /compactViewSelector=\{activeTab === "OVERVIEW"\s*\?\s*<CompactViewSelector items=\{lensSelectorItems\} activeId=\{activeLensId\} onSelect=\{selectLens\} \/>\s*:\s*undefined\}/.test(host));
  check("compact Leave only for roles that can leave (member/viewer), via the existing confirmation",
    /onLeave=\{canLeave \? \(\) => setConfirmLeave\(true\) : undefined\}/.test(host) && /const canLeave\s+= !canManage/.test(host));
  check("the compact lens row is not rendered for customer Spaces (one compact switcher)", /tabsVisibility="none"/.test(host));
  check("Platform Spaces are untouched (no compact selector, rail still belowLg)",
    !/CompactViewSelector|compactViewSelector/.test(read("components/platform/PlatformSpaceDashboard.tsx")) && /railVisibility="belowLg"/.test(read("components/platform/PlatformSpaceDashboard.tsx")));
  check("the desktop sidebar keeps its own Leave Space", /onLeaveSpace && \(/.test(read("components/ui/ContextualNavbar.tsx")));
}

console.log("\n4. Markets on compact: Coming soon, no Net Worth / Cash Flow controls");
{
  const host = code("components/dashboard/SpaceDashboard.tsx");
  const ps = code("components/space/shell/PerspectiveShell.tsx");
  check("below lg the time row is hidden while Markets is open (the selector still mounts; desktop unchanged)",
    /compactHideTime=\{activePerspectiveId === "markets"\}/.test(host) && /className=\{props\.compactHideTime \? "px-1 max-lg:hidden" : "px-1"\}/.test(ps));
  check("Markets declares no time capability (the reason)", /status:\s*"comingSoon"[\s\S]{0,400}temporalCapability: \{ asOf: "none", compareTo: "none", period: "none" \}|temporalCapability: \{ asOf: "none", compareTo: "none", period: "none" \}/.test(read("lib/perspectives.ts")));
  check("Markets still renders Coming soon (renderer unchanged)", /isComingSoon/.test(read("components/space/workspaces/workspaceRenderers.tsx")));
  check("the Net Worth chips and category tabs are Net Worth-only (never in Markets)",
    !/CompactSectionTabs|WEALTH_MODES|DEBT_SECTIONS|ASSETS_SLICES/.test(code("components/space/widgets/markets/MarketsWorkspace.tsx")));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
