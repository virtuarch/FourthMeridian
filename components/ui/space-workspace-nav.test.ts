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
 *      aria-labelledby into a control that is missing or CSS-hidden;
 *   J. Net Worth is a PARENT: Total · Assets · Debt nest under it while it is
 *      open (the same wealthMode state as the in-content selector, which is
 *      below-lg only), collapse under Cash Flow, and deep-link via ?metric=.
 */

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SpaceMode, SpaceWorkspaceNav } from "@/components/ui/ContextualNavbar";
import { PRIMARY_NAV } from "@/lib/space-nav";
import {
  CORE_LENS_IDS, NET_WORTH_LENS_ID, lensHref, openWorkspaceId, resolveUrlLens, wealthModeHref,
} from "@/lib/space/use-space-navigation";
import { WEALTH_MODES, WEALTH_MODE_LABELS, parseWealthMode, type WealthMode } from "@/lib/wealth/wealth-mode";
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
/** The Space nav with any nested child group removed — the workspace level only. */
const topLevel = (nav: string) => nav.replace(/<div role="group"[\s\S]*?<\/div>/g, "");
function activeIn(html: string, label: string): string[] {
  const n = label === "Space" ? topLevel(navHtml(html, label)) : navHtml(html, label);
  return [...n.matchAll(/<(a|button)[^>]*aria-current="true"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => text(m[2]));
}

/** The nav the host publishes — built from the REAL helpers, as SpaceDashboard does. */
const LENSES = [
  { id: NET_WORTH_LENS_ID, label: "Net Worth" },
  ...CORE_LENS_IDS.map((id) => ({ id, label: "Cash Flow" })),
];
function publishedNav(
  activeTab: string,
  activePerspectiveId: string | null,
  onSelect = (_id: string) => {},
  wealthMode: WealthMode = "total",
  onSelectChild = (_ws: string, _id: string) => {},
): SpaceChromeWorkspaceNav {
  const activeId = openWorkspaceId(activeTab, activePerspectiveId);
  return {
    items: LENSES.map(({ id, label }) => ({
      id, label, href: lensHref(id),
      ...(id === NET_WORTH_LENS_ID
        ? { children: WEALTH_MODES.map((m) => ({ id: m, label: WEALTH_MODE_LABELS[m], href: wealthModeHref(m) })) }
        : {}),
    })),
    activeId,
    onSelect,
    activeChildId: activeId === NET_WORTH_LENS_ID ? wealthMode : null,
    onSelectChild,
  };
}

type Clickable = ReactElement<{ href?: string; onClick?: (e: unknown) => void; children?: unknown }>;
/** Every <a> in a rendered element tree (function components are called), in order. */
function anchors(node: unknown): Clickable[] {
  if (Array.isArray(node)) return node.flatMap(anchors);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<{ children?: unknown }> & { type: unknown };
  if (typeof el.type === "function") return anchors((el.type as (p: unknown) => unknown)(el.props));
  return [...(el.type === "a" ? [el as Clickable] : []), ...anchors(el.props.children)];
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
  check("exactly two WORKSPACE destinations, in that order", text(topLevel(nav)) === "Net Worth Cash Flow", text(topLevel(nav)));
  check('no "Sections" label anywhere in the Space sidebar', !/\bSections\b/.test(text(html)) && !html.includes('aria-label="Sections"'));
  check("no published section anchor surfaces (Summary row, anchor ids); Assets / Debt appear ONLY as Net Worth's views",
    !/\bSummary\b/.test(text(html)) && !html.includes("wealth-summary") && !html.includes("cf-calendar") &&
      !/Assets|Debt/.test(text(topLevel(nav))) && (text(html).match(/\bAssets\b/g) ?? []).length === 1);
  check("Cash Flow appears ONCE (the published 'Cash Flow' anchor is not rendered too)",
    (text(html).match(/Cash Flow/g) ?? []).length === 1);
  check("peers, not subsections: same row class as the site nav (pl-3, 13px, 14px icon), no indentation",
    (nav.match(/py-1\.5 pl-3 pr-2 text-left text-\[13px\]/g) ?? []).length === 2 &&
      (nav.match(/<svg[^>]*width="14"/g) ?? []).length === 2 && !/\bml-\d|pl-[4-9]/.test(nav));
  check("semantic links (no clickable divs / buttons)", (topLevel(nav).match(/<a /g) ?? []).length === 2 && !/<button/.test(nav));
  check("a Space that publishes no workspaces renders no empty block", renderToStaticMarkup(createElement(SpaceWorkspaceNav, { nav: null })) === ""
    && renderToStaticMarkup(createElement(SpaceWorkspaceNav, { nav: { items: [], activeId: null, onSelect: () => {} } })) === "");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("B. Canonical destinations — the URL the navigation authority writes");
{
  const html = spaceMode("/dashboard", publishedNav("OVERVIEW", "wealth"));
  const links = hrefs(topLevel(navHtml(html, "Space")));
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
  const [nwLink, cfLink] = anchors(SpaceWorkspaceNav({ nav: publishedNav("ACCOUNTS", null, (id) => picked.push(id)) })) as
    ReactElement<{ onClick: (e: unknown) => void }>[];
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
    /items: lensSelectorItems\.map\(\(\{ id, label \}\) => \(\{\s*id,\s*label,\s*href: lensHref\(id\),/.test(host));
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
  // The ONE shared href is by design: Net Worth's landing view IS Total (the
  // default mode writes no ?metric=), so the parent and its Total child agree.
  const dupes = all.filter((h, i) => all.indexOf(h) !== i);
  check("no duplicate destination in the sidebar (only Net Worth ≡ its default Total view)",
    dupes.join() === "/dashboard?tab=overview", dupes.join());
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
  check("…derived from the SAME lens list both switchers render + the open mode's label (no second label source)",
    /lensSelectorItems\.find\(\(l\) => l\.id === openWorkspace\)\?\.label, openChild \? WEALTH_MODE_LABELS\[openChild\] : null\]/.test(host) &&
      /const openChild = openWorkspace === NET_WORTH_LENS_ID \? wealthMode : null;/.test(host));
  const nameFor = (tab: string, p: string | null, m: WealthMode = "total") => {
    const ws = openWorkspaceId(tab, p);
    const child = ws === NET_WORTH_LENS_ID ? WEALTH_MODE_LABELS[m] : null;
    return [LENSES.find((l) => l.id === ws)?.label, child].filter(Boolean).join(", ");
  };
  check("Net Worth / Total ⇒ region named \"Net Worth, Total\"", nameFor("OVERVIEW", "wealth") === "Net Worth, Total");
  check("Net Worth / Assets ⇒ \"Net Worth, Assets\"; Debt ⇒ \"Net Worth, Debt\"",
    nameFor("OVERVIEW", "wealth", "assets") === "Net Worth, Assets" && nameFor("OVERVIEW", "wealth", "debt") === "Net Worth, Debt");
  check("Cash Flow selected ⇒ region named \"Cash Flow\" (no Net Worth mode leaks in)", nameFor("OVERVIEW", "cashFlow", "debt") === "Cash Flow");
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

// ─────────────────────────────────────────────────────────────────────────────
console.log("J. Net Worth is a parent: Total · Assets · Debt nested while open");
{
  const render = (tab: string, p: string | null, m: WealthMode = "total") =>
    spaceMode("/dashboard", publishedNav(tab, p, () => {}, m));
  const group = (html: string) => html.match(/<div role="group" aria-label="Net Worth"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? null;
  const lit = (html: string) => [...navHtml(html, "Space").matchAll(/<a [^>]*aria-current="true"[^>]*>([\s\S]*?)<\/a>/g)].map((x) => text(x[1]));

  for (const m of WEALTH_MODES) {
    const html = render("OVERVIEW", "wealth", m);
    const g = group(html);
    check(`${WEALTH_MODE_LABELS[m]}: Net Worth is the active workspace AND ${WEALTH_MODE_LABELS[m]} the one active child`,
      lit(html).join() === `Net Worth,${WEALTH_MODE_LABELS[m]}`, lit(html).join());
    check(`${WEALTH_MODE_LABELS[m]}: Total · Assets · Debt render beneath Net Worth, before Cash Flow`,
      g !== null && text(g) === "Total Assets Debt" &&
        html.indexOf(">Net Worth<") < html.indexOf('role="group"') && html.indexOf('role="group"') < html.indexOf(">Cash Flow<"));
    check(`${WEALTH_MODE_LABELS[m]}: exactly one child active`, (g?.match(/aria-current="true"/g) ?? []).length === 1);
  }
  check("the child is named Total — never a second \"Net Worth\"", (text(render("OVERVIEW", "wealth")).match(/Net Worth/g) ?? []).length === 1);

  const cf = render("OVERVIEW", "cashFlow", "debt");
  check("Cash Flow open: Net Worth's children collapse (none rendered, even with a stale Debt mode)",
    group(cf) === null && !/>(Total|Assets|Debt)</.test(navHtml(cf, "Space")));
  check("Cash Flow open: Cash Flow alone is lit", lit(cf).join() === "Cash Flow", lit(cf).join());
  const acc = render("ACCOUNTS", null, "assets");
  check("off Overview: no workspace lit, children collapsed", lit(acc).length === 0 && group(acc) === null);

  // One accent bar at a time: the parent's bar yields to the child's.
  const nwHtml = navHtml(render("OVERVIEW", "wealth", "assets"), "Space");
  check("one visible accent bar in the Space nav while a child list shows (no double indicator)",
    (nwHtml.match(/bg-\[var\(--meridian-400\)\][^"]*opacity-100/g) ?? []).length === 1);
  check("…and Cash Flow (a leaf) keeps its own bar", (navHtml(cf, "Space").match(/opacity-100/g) ?? []).length === 1);
  check("children read as nested: guide line at the icon, smaller type, no icon, not peers of the parent",
    /role="group" aria-label="Net Worth" class="ml-\[18px\] flex flex-col border-l/.test(nwHtml) &&
      ((group(render("OVERVIEW", "wealth")) ?? "").match(/text-\[12px\]/g) ?? []).length === 3 &&
      !/<svg/.test(group(render("OVERVIEW", "wealth")) ?? "x"));
  check("parent semantics: Net Worth stays a real link to the workspace", /<a [^>]*href="\/dashboard\?tab=overview"[^>]*aria-current="true"/.test(nwHtml));
  check("child semantics: a named group of real links, selected one aria-current",
    /<div role="group" aria-label="Net Worth"/.test(nwHtml) && (group(render("OVERVIEW", "wealth")) ?? "").match(/<a /g)?.length === 3);

  // Routing — the canonical ?metric= the mode writer commits, and it reads back.
  const hrefsOf = hrefs(group(render("OVERVIEW", "wealth")) ?? "");
  check("Total → /dashboard?tab=overview (default mode writes no param)", hrefsOf[0] === "/dashboard?tab=overview", hrefsOf[0]);
  check("Assets → …&metric=assets; Debt → …&metric=debt",
    hrefsOf[1] === "/dashboard?tab=overview&metric=assets" && hrefsOf[2] === "/dashboard?tab=overview&metric=debt", hrefsOf.join(" "));
  check("each child href direct-loads to its own mode (parseWealthMode over ?metric=) on the Net Worth lens",
    hrefsOf.every((h, i) => {
      const q = new URLSearchParams(h.split("?")[1]);
      return parseWealthMode(q.get("metric")) === WEALTH_MODES[i] && resolveUrlLens({ tab: q.get("tab"), perspective: q.get("perspective") }).perspective === null;
    }));

  // Selection — the SAME setter as the in-content selector; plain vs modified click.
  const picks: string[] = [];
  let prevented = 0;
  const kids = anchors(SpaceWorkspaceNav({ nav: publishedNav("OVERVIEW", "wealth", () => {}, "total", (ws, id) => picks.push(`${ws}:${id}`)) }))
    .slice(1, 4) as ReactElement<{ onClick: (e: unknown) => void }>[];
  const ev = (over: Record<string, unknown> = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => { prevented++; }, ...over });
  kids[2].props.onClick(ev()); kids[1].props.onClick(ev()); kids[1].props.onClick(ev({ metaKey: true }));
  check("plain click on a child selects through onSelectChild(parent, mode); ⌘-click is the browser's",
    picks.join() === "networth:debt,networth:assets" && prevented === 2, `${picks.join()} ${prevented}`);

  const host = code(read("components", "dashboard", "SpaceDashboard.tsx"));
  const selChild = host.match(/const selectWorkspaceChild = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? "";
  check("host: a child selection IS setWealthMode — the in-content selector's own setter (one source of truth)",
    /if \(workspaceId === NET_WORTH_LENS_ID\) setWealthMode\(childId as WealthMode\);/.test(selChild) && (selChild.match(/;/g) ?? []).length === 1, selChild);
  check("host: children are WEALTH_MODES with WEALTH_MODE_LABELS + wealthModeHref (no second mode list)",
    /children: WEALTH_MODES\.map\(\(m\) => \(\{ id: m, label: WEALTH_MODE_LABELS\[m\], href: wealthModeHref\(m\) \}\)\)/.test(host));
  check("host: the active child is wealthMode, only while Net Worth is open",
    /activeChildId: openChild,/.test(host));
  check("mode writes are unchanged (?metric= via replace — the existing history contract)",
    /metric: serializeWealthMode\(m\)[\s\S]{0,120}\{ history: "replace" \}/.test(read("lib", "space", "use-space-navigation.ts")));

  // Responsive: ONE Total · Assets · Debt control per width.
  const ww = read("components", "space", "widgets", "wealth", "WealthWorkspace.tsx");
  check("in-content mode selector: `lg:hidden` when the host says belowLg (desktop = sidebar owns it)",
    /modeSelectorVisibility === "belowLg" \? "lg:hidden" : ""/.test(ww) && /data-wealth-mode-row/.test(ww));
  check("…default stays visible everywhere, and it is still the SAME Chips over `mode` / onModeChange (mobile keeps all three)",
    /modeSelectorVisibility = "always"/.test(ww) && /options=\{WEALTH_MODES\.map/.test(ww) && /value=\{mode\}/.test(ww) && /onChange=\{\(m\) => onModeChange\?\.\(m\)\}/.test(ww));
  check("…rendered in every mode path (Debt, loading, no-history, main) — hidden, never removed",
    (code(ww).match(/\{modeSelector\}/g) ?? []).length === 4);
  check("the customer host opts in once, through the render context",
    (host.match(/wealthModeSelectorVisibility: "belowLg"/g) ?? []).length === 1 &&
      /modeSelectorVisibility=\{ctx\.wealthModeSelectorVisibility\}/.test(read("components", "space", "workspaces", "workspaceRenderers.tsx")));
  check("the mode selector owns no aria-labelledby relationship to leave dangling when hidden",
    !/aria-labelledby/.test(code(ww)));
}

if (failures > 0) { console.error(`\nspace-workspace-nav: ${failures} failure(s).`); process.exit(1); }
console.log("\nspace-workspace-nav: all passed.");
