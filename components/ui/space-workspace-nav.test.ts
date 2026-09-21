/**
 * components/ui/space-workspace-nav.test.ts
 *
 * Standalone tsx + renderToStaticMarkup (house pattern), exits 0/1.
 *
 *   npx tsx components/ui/space-workspace-nav.test.ts
 *
 * PRODUCT CONTRACT — inside a (customer) Space the sidebar has exactly two
 * workspace-level destinations, Net Worth · Cash Flow, and NO "Sections" group
 * and no section-anchor list. Net Worth owns the wealth workspace and its own
 * Total · Assets · Debt modes; Cash Flow owns the Cash Flow workspace.
 *
 * Pins:
 *   A. the block renders exactly Net Worth · Cash Flow, and no Sections;
 *   B. each points at the canonical deep link the URL writer itself commits;
 *   C. active state comes from the RENDERED workspace (never text), survives
 *      the Net Worth modes, is exactly one on Overview, none off it;
 *   D. a plain click selects in place; a modified click is left to the browser;
 *   E. the rest of the sidebar is intact (site nav, identity, Leave Space);
 *   F. platform axis + mobile are unchanged; no duplicate destinations;
 *   G. the host wiring is navigation only;
 *   H. ONE switcher per width: the in-page lens row is below-lg only in a
 *      customer Space (the sidebar owns lg+), and BottomNav carries no stale
 *      "Sections" label;
 *   I. the open workspace's content region is NAMED at every width — no
 *      aria-labelledby into a control that is missing or CSS-hidden.
 */

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SpaceMode, SpaceWorkspaceNav } from "@/components/ui/ContextualNavbar";
import { PRIMARY_NAV } from "@/lib/space-nav";
import {
  CORE_LENS_IDS, NET_WORTH_LENS_ID, lensHref, openWorkspaceId, resolveUrlLens,
} from "@/lib/space/use-space-navigation";
import type { SpaceChromeWorkspaceNav } from "@/lib/space/space-chrome-context";
import { PerspectiveShell } from "@/components/space/shell/PerspectiveShell";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
function navHtml(html: string, label: string): string {
  return html.match(new RegExp(`<nav aria-label="${label}"[^>]*>([\\s\\S]*?)</nav>`))?.[1] ?? "";
}
function activeIn(html: string, label: string): string[] {
  return [...navHtml(html, label).matchAll(/<(a|button)[^>]*aria-current="true"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => text(m[2]));
}

/** The nav the host publishes — built from the REAL helpers, as SpaceDashboard does. */
const LENSES = [
  { id: NET_WORTH_LENS_ID, label: "Net Worth" },
  ...CORE_LENS_IDS.map((id) => ({ id, label: "Cash Flow" })),
];
function publishedNav(activeTab: string, activePerspectiveId: string | null, onSelect = (_id: string) => {}): SpaceChromeWorkspaceNav {
  return {
    items: LENSES.map(({ id, label }) => ({ id, label, href: lensHref(id) })),
    activeId: openWorkspaceId(activeTab, activePerspectiveId),
    onSelect,
  };
}
const PUBLISHED_SECTIONS = [
  { label: "Summary", anchor: "wealth-summary" },
  { label: "Assets", anchor: "wealth-assets" },
  { label: "Debt", anchor: "wealth-debt" },
  { label: "Cash Flow", anchor: "cf-calendar" },
];
const spaceMode = (pathname: string, workspaceNav: SpaceChromeWorkspaceNav | null) =>
  renderToStaticMarkup(createElement(SpaceMode, {
    pathname, pendingInvites: 0,
    space: {
      identity: { name: "Household", subtitle: "Family Space · 3 members", updatedLabel: "Last checked 2 hr ago", shared: true },
      onLeave: () => {}, onManage: () => {}, onLeaveSpace: () => {},
    },
    currencyControl: null,
    workspaceNav,
    sections: PUBLISHED_SECTIONS,
    activeSection: "Assets",
    onSelectSection: () => {},
  } as never));

// ─────────────────────────────────────────────────────────────────────────────
console.log("A. Exactly Net Worth · Cash Flow — and no Sections");
{
  const html = spaceMode("/dashboard", publishedNav("OVERVIEW", "wealth"));
  const nav = navHtml(html, "Space");
  check("renders Net Worth", text(nav).includes("Net Worth"));
  check("renders Cash Flow", text(nav).includes("Cash Flow"));
  check("exactly two destinations, in that order", text(nav) === "Net Worth Cash Flow", text(nav));
  check('no "Sections" label anywhere in the Space sidebar', !/\bSections\b/.test(text(html)) && !html.includes('aria-label="Sections"'));
  check("no published section anchor surfaces (Summary / Assets / Debt rows, anchor ids)",
    !/\bSummary\b/.test(text(html)) && !text(html).includes("Assets") && !text(html).includes("Debt") &&
      !html.includes("wealth-summary") && !html.includes("cf-calendar"));
  check("Cash Flow appears ONCE (the published 'Cash Flow' anchor is not rendered too)",
    (text(html).match(/Cash Flow/g) ?? []).length === 1);
  check("peers, not subsections: same row class as the site nav (pl-3, 13px, 14px icon), no indentation",
    (nav.match(/py-1\.5 pl-3 pr-2 text-left text-\[13px\]/g) ?? []).length === 2 &&
      (nav.match(/<svg[^>]*width="14"/g) ?? []).length === 2 && !/\bml-\d|pl-[4-9]/.test(nav));
  check("semantic links (no clickable divs / buttons)", (nav.match(/<a /g) ?? []).length === 2 && !/<(div|button)[^>]*onClick/.test(nav));
  check("a Space that publishes no workspaces renders no empty block", renderToStaticMarkup(createElement(SpaceWorkspaceNav, { nav: null })) === ""
    && renderToStaticMarkup(createElement(SpaceWorkspaceNav, { nav: { items: [], activeId: null, onSelect: () => {} } })) === "");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("B. Canonical destinations — the URL the navigation authority writes");
{
  const html = spaceMode("/dashboard", publishedNav("OVERVIEW", "wealth"));
  const links = hrefs(navHtml(html, "Space"));
  check("Net Worth → /dashboard?tab=overview (the clean Overview URL; no Net Worth page is invented)",
    links[0] === "/dashboard?tab=overview", links[0]);
  check("Cash Flow → /dashboard?tab=overview&perspective=cash-flow", links[1] === "/dashboard?tab=overview&perspective=cash-flow", links[1]);
  const back = (href: string) => {
    const q = new URLSearchParams(href.split("?")[1]);
    return resolveUrlLens({ tab: q.get("tab"), perspective: q.get("perspective") });
  };
  check("…and each href reads BACK to its own workspace through resolveUrlLens",
    back(links[0]).perspective === null && back(links[0]).legacy === null && back(links[1]).perspective === "cashFlow");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("C. Active state — the rendered workspace, exactly one on Overview");
{
  check("Overview + wealth ⇒ Net Worth", openWorkspaceId("OVERVIEW", "wealth") === NET_WORTH_LENS_ID);
  check("Overview + cashFlow ⇒ Cash Flow", openWorkspaceId("OVERVIEW", "cashFlow") === "cashFlow");
  for (const tab of ["ACTIVITY", "ACCOUNTS", "TRANSACTIONS", "MEMBERS", ""]) {
    check(`${tab || "(unresolved)"} ⇒ none lit`, openWorkspaceId(tab, null) === null);
  }
  check("the active rule never reads the Net Worth mode (Total · Assets · Debt is wealthMode, not the lens)",
    openWorkspaceId.length === 2 && !/wealthMode|metric/.test(openWorkspaceId.toString()));

  const nw = spaceMode("/dashboard", publishedNav("OVERVIEW", "wealth"));
  const cf = spaceMode("/dashboard", publishedNav("OVERVIEW", "cashFlow"));
  const acc = spaceMode("/dashboard", publishedNav("ACCOUNTS", null));
  check("Net Worth workspace: Net Worth lit, and only it", activeIn(nw, "Space").join() === "Net Worth", activeIn(nw, "Space").join());
  check("Cash Flow workspace: Cash Flow lit, and only it", activeIn(cf, "Space").join() === "Cash Flow", activeIn(cf, "Space").join());
  check("Accounts tab: neither lit (the rail owns that state)", activeIn(acc, "Space").length === 0);
  check("the site nav's My Space stays lit independently in every case",
    [nw, cf, acc].every((h) => activeIn(h, "Global").join() === "My Space"));

  // The host passes the RENDERED lens (activePerspectiveId), never the chip id or wealthMode.
  const host = code(read("components", "dashboard", "SpaceDashboard.tsx"));
  check("host derives activeId from openWorkspaceId(activeTab, activePerspectiveId)",
    /openWorkspaceId\(activeTab, activePerspectiveId\)/.test(host) && /activeId: openWorkspace\b/.test(host));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("D. Selection — in place for a plain click, the browser's for a modified one");
{
  const picked: string[] = [];
  const el = SpaceWorkspaceNav({ nav: publishedNav("ACCOUNTS", null, (id) => picked.push(id)) }) as ReactElement<{ children: ReactElement<{ onClick: (e: unknown) => void }>[] }>;
  const [nwLink, cfLink] = el.props.children;
  let prevented = 0;
  const ev = (over: Record<string, unknown> = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => { prevented++; }, ...over });
  cfLink.props.onClick(ev());
  nwLink.props.onClick(ev());
  check("plain click selects through the host (Cash Flow, then Net Worth) and prevents the reload",
    picked.join() === "cashFlow,networth" && prevented === 2, `${picked.join()} ${prevented}`);
  for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
    cfLink.props.onClick(ev(mod));
  }
  check("⌘/Ctrl/Shift/middle click is left to the browser (new tab on the canonical href)", picked.length === 2 && prevented === 2);

  const host = code(read("components", "dashboard", "SpaceDashboard.tsx"));
  const sel = host.match(/const selectWorkspace = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? "";
  check("host selection = the lens + the Overview tab, nothing else (works from any rail tab)",
    /selectLens\(id\);\s*setActiveTab\("OVERVIEW"\);/.test(sel) && (sel.match(/;/g) ?? []).length === 2, sel);
  check("host publishes the SAME lens set the in-page lens row uses (one list, no second definition)",
    /items: lensSelectorItems\.map\(\(\{ id, label \}\) => \(\{ id, label, href: lensHref\(id\) \}\)\)/.test(host));
  check("host clears the channel on unmount", /useEffect\(\(\) => \(\) => publishWorkspaceNav\(null\), \[publishWorkspaceNav\]\)/.test(host));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("E. The rest of the Space sidebar is intact");
{
  const html = spaceMode("/dashboard", publishedNav("OVERVIEW", "wealth"));
  const t = text(html);
  check("global PRIMARY_NAV present, all five", PRIMARY_NAV.every((d) => hrefs(navHtml(html, "Global")).includes(d.href)));
  check("Space identity: name heading, subtitle, freshness", /<h1[^>]*>Household<\/h1>/.test(html) && t.includes("Family Space · 3 members") && t.includes("Last checked 2 hr ago"));
  check("All Spaces + Manage + Leave Space", t.includes("All Spaces") && t.includes("Manage") && t.includes("Leave Space"));
  const iName = html.indexOf("Household</h1>"), iManage = html.indexOf("Manage"), iWork = html.indexOf('aria-label="Space"');
  const iBlockEnd = html.indexOf("</div>", html.lastIndexOf("</nav>"));
  const iLeave = html.indexOf("Leave Space");
  check("workspaces sit INSIDE the Space block, after identity + controls (not detached)",
    iName < iManage && iManage < iWork && html.indexOf('data-nav-context="space"') < iWork && iWork < iBlockEnd && iBlockEnd < iLeave,
    `${iName} ${iManage} ${iWork} ${iBlockEnd} ${iLeave}`);
  check("one hairline divider (the Space block's), no second", (html.match(/border-t/g) ?? []).length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("F. Platform axis, mobile, duplicates");
{
  const hq = spaceMode("/dashboard/platform/PLATFORM_OPS", null);
  check("a Platform HQ Space keeps its section anchors (HQ has no Net Worth / Cash Flow)",
    hq.includes('<nav aria-label="Sections"') && !hq.includes('aria-label="Space"'));

  const rail = read("components", "ui", "ContextualNavbar.tsx");
  check("the sidebar (and so these links) is desktop-only — unchanged <aside hidden … lg:block>",
    /<aside className="hidden w-\[212px\] shrink-0 lg:block">/.test(rail));
  const bar = code(read("components", "ui", "BottomNav.tsx"));
  check("BottomNav is untouched: PRIMARY_NAV only, no workspace destinations", /PRIMARY_NAV\.map/.test(bar) && !/Net Worth|Cash Flow|lensHref|workspaceNav/.test(bar));
  const host = code(read("components", "dashboard", "SpaceDashboard.tsx"));
  check("mobile still reaches both workspaces through the in-page lens row (PerspectiveShell tabs)",
    /tabs=\{lensSelectorItems\}/.test(host) && /onSelectTab=\{selectLens\}/.test(host));

  const html = spaceMode("/dashboard", publishedNav("OVERVIEW", "wealth"));
  const all = hrefs(html);
  check("no duplicate destination in the sidebar", new Set(all).size === all.length, all.join());
  check("the workspace hrefs are not site destinations restated", hrefs(navHtml(html, "Space")).every((h) => !PRIMARY_NAV.some((d) => d.href === h)));
  check("exactly one Space nav", (html.match(/<nav aria-label="Space"/g) ?? []).length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("G. Navigation only — no financial surface touched by the sidebar");
{
  const rail = code(read("components", "ui", "ContextualNavbar.tsx"));
  check("the sidebar imports no finance/workspace module",
    !/from "@\/lib\/(cashflow|cash-flow|wealth|perspectives|forecast|ai)|from "@\/components\/space\/widgets/.test(rail));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("H. One workspace switcher per width; no stale Sections label");
{
  const shell = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PerspectiveShell as never, {
    today: "2026-09-21", onAsOfChange: () => {}, onCompareToChange: () => {}, onSwap: () => {}, onSelectPreset: () => {},
    envelope: {}, temporalCapability: { asOf: "full", compareTo: "full", period: "none" },
    timeState: { preset: "MTD", asOf: "2026-09-21", compareTo: "2026-09-01" },
    tabs: [{ id: "networth", label: "Net Worth", hasWorkspace: true }, { id: "cashFlow", label: "Cash Flow", hasWorkspace: true }],
    activeTabId: "networth", onSelectTab: () => {},
    ...over,
  } as never));
  const rowClass = (html: string) => html.match(/<div data-lens-row="[^"]*" class="([^"]*)"/)?.[1] ?? null;

  const customer = shell({ tabsVisibility: "belowLg" });
  check("desktop (lg+): the customer lens row is hidden — the sidebar is the only switcher",
    /(^| )lg:hidden( |$)/.test(rowClass(customer) ?? ""), String(rowClass(customer)));
  check("mobile/tablet (<lg): the row is still RENDERED with both workspaces and its active tab (display only, not unmounted)",
    text(customer).includes("Net Worth") && text(customer).includes("Cash Flow") && /aria-checked="true"[^>]*>Net Worth</.test(customer) &&
      !/(^| )hidden( |$)/.test(rowClass(customer) ?? ""));
  const dflt = shell();
  check("default presentation is unchanged (visible at every width) for any other host",
    rowClass(dflt) === "flex justify-center px-1", String(rowClass(dflt)));
  check("…and the markup differs ONLY by that class (same tabs, same selection)",
    customer.replace(/ lg:hidden/, "") === dflt);

  const rail = read("components", "ui", "ContextualNavbar.tsx");
  check("the two breakpoints are exact complements: sidebar `hidden … lg:block` ⇔ row `lg:hidden`",
    /<aside className="hidden w-\[212px\] shrink-0 lg:block">/.test(rail));
  const host = code(read("components", "dashboard", "SpaceDashboard.tsx"));
  check("the customer host opts in exactly once, on the lens row it already renders (no second switcher, same routing)",
    (host.match(/tabsVisibility="belowLg"/g) ?? []).length === 1 &&
      /tabs=\{lensSelectorItems\}[\s\S]{0,120}onSelectTab=\{selectLens\}[\s\S]{0,40}tabsVisibility="belowLg"/.test(host));
  check("Net Worth internal modes (Total · Assets · Debt) are not the lens row — untouched by this switch",
    !/tabsVisibility/.test(code(read("components", "space", "widgets", "wealth", "WealthWorkspace.tsx"))));

  const bar = code(read("components", "ui", "BottomNav.tsx"));
  check('BottomNav: no stale "Sections" label; named "Global" like the desktop PRIMARY_NAV block it mirrors',
    !/Sections/.test(bar) && /<nav\s+aria-label="Global"/.test(bar));
  check("BottomNav destinations/visuals unchanged: PRIMARY_NAV, lg:hidden bar, per-link labels",
    /PRIMARY_NAV\.map/.test(bar) && /fixed inset-x-0 bottom-0 z-40 border-t border-\[var\(--border-hairline\)\] lg:hidden/.test(bar) &&
      /aria-label=\{d\.label\}/.test(bar));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("I. The workspace region's accessible name");
{
  const host = code(read("components", "dashboard", "SpaceDashboard.tsx"));
  const panel = host.match(/<div\s+role="region"[\s\S]*?>/)?.[0] ?? "";
  check("the content panel is a named region: aria-label from the open workspace's label",
    /aria-label=\{openWorkspaceLabel\}/.test(panel), panel);
  check("…derived from the SAME lens list both switchers render (no second label source)",
    /const openWorkspaceLabel = lensSelectorItems\.find\(\(l\) => l\.id === openWorkspace\)\?\.label;/.test(host));
  const nameFor = (tab: string, p: string | null) => LENSES.find((l) => l.id === openWorkspaceId(tab, p))?.label;
  check("Net Worth selected ⇒ region named \"Net Worth\"", nameFor("OVERVIEW", "wealth") === "Net Worth");
  check("Cash Flow selected ⇒ region named \"Cash Flow\"", nameFor("OVERVIEW", "cashFlow") === "Cash Flow");
  check("the name does not depend on which switcher is visible (no id reference at all)",
    !/aria-labelledby/.test(panel) && !/role="tabpanel"/.test(host) && !/ptab-/.test(host));

  // No dangling labelled-by anywhere on this path: every aria-labelledby in the
  // host, the shell and the lens row must name an id that is actually rendered.
  const shellHtml = renderToStaticMarkup(createElement(PerspectiveShell as never, {
    today: "2026-09-21", onAsOfChange: () => {}, onCompareToChange: () => {}, onSwap: () => {}, onSelectPreset: () => {},
    envelope: {}, temporalCapability: { asOf: "full", compareTo: "full", period: "none" },
    timeState: { preset: "MTD", asOf: "2026-09-21", compareTo: "2026-09-01" },
    tabs: LENSES.map((l) => ({ ...l, hasWorkspace: true })), activeTabId: "networth", onSelectTab: () => {},
    tabsVisibility: "belowLg",
  } as never));
  const refs = [...shellHtml.matchAll(/aria-labelledby="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  check("no dangling aria-labelledby in the rendered shell", refs.every((id) => shellHtml.includes(`id="${id}"`)), refs.join());
  const srcRefs = [
    host,
    code(read("components", "space", "shell", "PerspectiveShell.tsx")),
    code(read("components", "space", "shell", "PerspectiveTabs.tsx")),
  ].join("\n").match(/aria-labelledby/g) ?? [];
  check("no aria-labelledby left on the host → shell → lens-row path", srcRefs.length === 0, String(srcRefs.length));
  check("the mobile lens row keeps its own name (radiogroup \"Perspectives\") with the selected radio exposed",
    /role="radiogroup" aria-label="Perspectives"/.test(shellHtml) && /role="radio" aria-checked="true"[^>]*>Net Worth</.test(shellHtml));
}

if (failures > 0) { console.error(`\nspace-workspace-nav: ${failures} failure(s).`); process.exit(1); }
console.log("\nspace-workspace-nav: all passed.");
