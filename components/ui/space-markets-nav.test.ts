/**
 * components/ui/space-markets-nav.test.ts
 *
 * Standalone tsx + renderToStaticMarkup (house pattern), exits 0/1.
 *
 *   npx tsx components/ui/space-markets-nav.test.ts
 *
 * MARKETS SKELETON — the third customer workspace, on the SAME grammar as Net
 * Worth: a sidebar parent whose five views (Portfolio · Research · Fundamentals ·
 * Technicals · Watchlist) nest under it only while it is open at lg+, and an
 * in-content view row below lg — one `marketsMode` state (?view=) behind both.
 * Shell only: every view is an honest empty state.
 *
 *   A. sidebar — three workspaces, contextual children, one active child;
 *   B. routing — canonical ?view=, default = clean Markets URL, direct load;
 *   C. mobile / tablet — the lens row carries Markets, the view row is <lg only;
 *   D. accessibility — semantics, selected state, the region's name;
 *   E. regression — Net Worth, Cash Flow, Platform, global nav;
 *   F. scope — no data, provider, AI, schema, fake securities; nothing moved.
 */

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SpaceMode, SpaceWorkspaceNav } from "@/components/ui/ContextualNavbar";
import { MarketsWorkspace, MARKETS_EMPTY_COPY } from "@/components/space/widgets/markets/MarketsWorkspace";
import { WORKSPACE_RENDERERS } from "@/components/space/workspaces/workspaceRenderers";
import { PRIMARY_NAV } from "@/lib/space-nav";
import { PERSPECTIVE_LIBRARY, getPerspectivesForCategory } from "@/lib/perspectives";
import { openPerspectiveDataNeeds } from "@/lib/space/workspace-resources";
import {
  CORE_LENS_IDS, MARKETS_LENS_ID, NET_WORTH_LENS_ID,
  lensHref, marketsModeHref, openChildId, openWorkspaceId, resolveUrlLens, workspaceChildren,
} from "@/lib/space/use-space-navigation";
import {
  DEFAULT_MARKETS_MODE, MARKETS_MODES, MARKETS_MODE_LABELS, MARKETS_VIEW_PARAM,
  parseMarketsMode, serializeMarketsMode, type MarketsMode,
} from "@/lib/markets/markets-mode";
import type { WealthMode } from "@/lib/wealth/wealth-mode";
import type { SpaceChromeWorkspaceNav } from "@/lib/space/space-chrome-context";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
const navHtml = (html: string, label: string) => html.match(new RegExp(`<nav aria-label="${label}"[^>]*>([\\s\\S]*?)</nav>`))?.[1] ?? "";
const topLevel = (nav: string) => nav.replace(/<div role="group"[\s\S]*?<\/div>/g, "");
const group = (html: string, name: string) => html.match(new RegExp(`<div role="group" aria-label="${name}"[^>]*>([\\s\\S]*?)</div>`))?.[1] ?? null;
const litTop = (html: string) => [...topLevel(navHtml(html, "Space")).matchAll(/<a [^>]*aria-current="true"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => text(m[1]));
const litAll = (html: string) => [...navHtml(html, "Space").matchAll(/<a [^>]*aria-current="true"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => text(m[1]));

const LENSES = [
  { id: NET_WORTH_LENS_ID, label: "Net Worth" },
  ...CORE_LENS_IDS.map((id) => ({ id, label: PERSPECTIVE_LIBRARY[id].label })),
];
/** The nav exactly as SpaceDashboard publishes it — from the real helpers. */
function nav(
  activeTab: string, activePerspectiveId: string | null,
  modes: { wealthMode?: WealthMode; marketsMode?: MarketsMode } = {},
  handlers: { onSelect?: (id: string) => void; onSelectChild?: (ws: string, id: string) => void } = {},
): SpaceChromeWorkspaceNav {
  const activeId = openWorkspaceId(activeTab, activePerspectiveId);
  return {
    items: LENSES.map(({ id, label }) => {
      const children = workspaceChildren(id);
      return { id, label, href: lensHref(id), ...(children ? { children } : {}) };
    }),
    activeId,
    onSelect: handlers.onSelect ?? (() => {}),
    activeChildId: openChildId(activeId, { wealthMode: modes.wealthMode ?? "total", marketsMode: modes.marketsMode ?? "portfolio" }),
    onSelectChild: handlers.onSelectChild ?? (() => {}),
  };
}
const sidebar = (n: SpaceChromeWorkspaceNav | null, pathname = "/dashboard") =>
  renderToStaticMarkup(createElement(SpaceMode, {
    pathname, pendingInvites: 0,
    space: { identity: { name: "Household", subtitle: "Family Space · 3 members", shared: true }, onLeave: () => {}, onManage: () => {}, onLeaveSpace: () => {} },
    currencyControl: null, workspaceNav: n,
    sections: [{ label: "Summary", anchor: "wealth-summary" }, { label: "Holdings", anchor: "inv-holdings" }],
    activeSection: "Summary", onSelectSection: () => {},
  } as never));
const markets = (mode: MarketsMode, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(MarketsWorkspace, { mode, onModeChange: () => {}, modeSelectorVisibility: "belowLg", ...over } as never));

const LABELS = MARKETS_MODES.map((m) => MARKETS_MODE_LABELS[m]);

// ─────────────────────────────────────────────────────────────────────────────
console.log("A. Sidebar — three workspaces, contextual children");
{
  const nw = sidebar(nav("OVERVIEW", "wealth"));
  const cf = sidebar(nav("OVERVIEW", "cashFlow"));
  check("1. top-level workspaces are exactly Net Worth · Cash Flow · Markets",
    [nw, cf].every((h) => text(topLevel(navHtml(h, "Space"))) === "Net Worth Cash Flow Markets"));
  check("2. no customer Sections group (even with anchors published)",
    [nw, cf].every((h) => !/aria-label="Sections"|\bSections\b|Holdings/.test(h)));
  check("3. Markets has no children while inactive (Net Worth / Cash Flow / Accounts)",
    [nw, cf, sidebar(nav("ACCOUNTS", null))].every((h) => group(h, "Markets") === null && !/Portfolio|Watchlist/.test(h)));

  for (const m of MARKETS_MODES) {
    const h = sidebar(nav("OVERVIEW", "markets", { marketsMode: m }));
    const g = group(h, "Markets");
    check(`4/5. Markets · ${MARKETS_MODE_LABELS[m]}: five children, in order, beneath Markets`,
      g !== null && text(g) === LABELS.join(" ") && h.indexOf(">Markets<") < h.indexOf('aria-label="Markets"'), g ?? "none");
    check(`9. Markets · ${MARKETS_MODE_LABELS[m]}: exactly one child selected, and it is ${MARKETS_MODE_LABELS[m]}`,
      (g?.match(/aria-current="true"/g) ?? []).length === 1 && /aria-current="true"[^>]*>[\s\S]*?</.test(g ?? "") &&
        litAll(h).join() === `Markets,${MARKETS_MODE_LABELS[m]}`, litAll(h).join());
    check(`10. Markets · ${MARKETS_MODE_LABELS[m]}: Markets is the one active workspace`, litTop(h).join() === "Markets");
    check(`6. Markets · ${MARKETS_MODE_LABELS[m]}: Net Worth's children collapse`, group(h, "Net Worth") === null && !/>Total<|>Debt</.test(h));
  }
  check("7. Net Worth open: Markets children collapse, Net Worth's show",
    group(nw, "Markets") === null && text(group(nw, "Net Worth") ?? "") === "Total Assets Debt");
  check("8. Cash Flow open: neither child set expands", group(cf, "Markets") === null && group(cf, "Net Worth") === null);
  check("…and with a stale Markets view in state, Cash Flow still shows none",
    group(sidebar(nav("OVERVIEW", "cashFlow", { marketsMode: "watchlist" })), "Markets") === null);

  const mk = navHtml(sidebar(nav("OVERVIEW", "markets", { marketsMode: "technicals" })), "Space");
  check("same child grammar as Net Worth: guide line at the icon, 12px, no icon, one accent bar",
    /role="group" aria-label="Markets" class="ml-\[18px\] flex flex-col border-l/.test(mk) &&
      ((group(mk, "Markets") ?? "").match(/text-\[12px\]/g) ?? []).length === 5 && !/<svg/.test(group(mk, "Markets") ?? "x") &&
      (mk.match(/bg-\[var\(--meridian-400\)\][^"]*opacity-100/g) ?? []).length === 1);
  check("Markets parent: same row + 14px icon as its peers, open weight while children show",
    /<a [^>]*aria-current="true" class="[^"]*py-1\.5 pl-3 pr-2 text-left text-\[13px\][^"]*font-medium"[\s\S]*?<svg[^>]*width="14"[\s\S]*?>Markets</.test(mk));
  check("long labels (Fundamentals / Technicals) truncate rather than wrap", ((group(mk, "Markets") ?? "").match(/class="truncate"/g) ?? []).length === 5);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("B. Routing — the canonical ?view= on the Markets lens");
{
  check("11/18. Markets parent href = the clean Markets URL = Portfolio (no view param)",
    lensHref(MARKETS_LENS_ID) === "/dashboard?tab=overview&perspective=markets" && marketsModeHref("portfolio") === lensHref(MARKETS_LENS_ID));
  check("…the default is Portfolio and serializes to nothing", DEFAULT_MARKETS_MODE === "portfolio" && serializeMarketsMode("portfolio") === null);
  const host = code(read("components", "dashboard", "SpaceDashboard.tsx"));
  check("11. an in-place click on the Markets parent opens Portfolio (what its href opens)",
    /const selectWorkspace = openWorkspaceDefault;/.test(host) &&
      /if \(id === MARKETS_LENS_ID\) setMarketsMode\(DEFAULT_MARKETS_MODE\);/.test(read("lib", "space", "use-space-navigation.ts")));
  for (const m of MARKETS_MODES) {
    const href = marketsModeHref(m);
    const q = new URLSearchParams(href.split("?")[1]);
    const lens = resolveUrlLens({ tab: q.get("tab"), perspective: q.get("perspective") });
    check(`12–16. ${MARKETS_MODE_LABELS[m]} direct load: ${href} → Markets lens + ${m}`,
      lens.perspective === "markets" && lens.legacy === null && parseMarketsMode(q.get(MARKETS_VIEW_PARAM)) === m &&
        (m === "portfolio" ? !q.has(MARKETS_VIEW_PARAM) : q.get(MARKETS_VIEW_PARAM) === m));
  }
  check("unknown / absent ?view= resolves deterministically to Portfolio",
    parseMarketsMode(null) === "portfolio" && parseMarketsMode("bogus") === "portfolio" && parseMarketsMode("RESEARCH") === "research");

  const hook = read("lib", "space", "use-space-navigation.ts");
  const sync = hook.match(/const syncFromUrl = \(\) => \{([\s\S]*?)\n    \};/)?.[1] ?? "";
  check("17. refresh / direct load / Back-Forward: ?view= is read on mount AND on popstate (the ?metric= sync)",
    /setMarketsMode\(parseMarketsMode\(readSpaceParam\(search, MARKETS_VIEW_PARAM\)\)\)/.test(sync) &&
      /syncFromUrl\(\);\s*return spaceUrl\.subscribe\(syncFromUrl\);/.test(hook));
  check("…read BEFORE the Net Worth legacy early-return (a legacy link cannot drop the view)",
    sync.indexOf("setMarketsMode") > -1 && sync.indexOf("setMarketsMode") < sync.indexOf("if (legacy)"));
  check("19. ?view= is written by the ONE URL writer for the open Markets (default clears; REPLACE — space-history.test §7–9)",
    /openWorkspace === MARKETS_LENS_ID \? \{ \[MARKETS_VIEW_PARAM\]: serializeMarketsMode\(marketsMode\) \}/.test(hook) &&
      /const handleMarketsModeChange = useCallback\(\(m: MarketsMode\) => setMarketsMode\(m\), \[\]\);/.test(hook));
  check("?view= is a documented Space param", read("lib", "space", "space-url.ts").includes('"view",'));

  const picks: string[] = [];
  let prevented = 0;
  const el = SpaceWorkspaceNav({ nav: nav("OVERVIEW", "markets", { marketsMode: "portfolio" }, { onSelectChild: (ws, id) => picks.push(`${ws}:${id}`) }) });
  const html = renderToStaticMarkup(el as ReactElement);
  check("19. children are real <a href> links to their canonical URLs",
    JSON.stringify(hrefs(group(html, "Markets") ?? "")) === JSON.stringify(MARKETS_MODES.map(marketsModeHref)));
  // Walk the element tree for the child anchors' handlers.
  const anchors = (node: unknown): ReactElement<{ onClick: (e: unknown) => void }>[] => {
    if (Array.isArray(node)) return node.flatMap(anchors);
    if (!node || typeof node !== "object" || !("props" in node)) return [];
    const n = node as ReactElement<{ children?: unknown }> & { type: unknown };
    return [...(n.type === "a" ? [n as ReactElement<{ onClick: (e: unknown) => void }>] : []), ...anchors(n.props.children)];
  };
  const kids = anchors(el).slice(3); // Net Worth, Cash Flow, Markets, then Markets' five
  const ev = (o: Record<string, unknown> = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => { prevented++; }, ...o });
  kids[2].props.onClick(ev()); kids[4].props.onClick(ev()); kids[3].props.onClick(ev({ ctrlKey: true }));
  check("plain click selects in place through onSelectChild(markets, view); Ctrl-click is the browser's",
    picks.join() === "markets:fundamentals,markets:watchlist" && prevented === 2, picks.join());
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("C. Mobile / tablet — the content owns both levels below lg");
{
  check("20. the lens row (Net Worth · Cash Flow · Markets) — Markets is a CORE lens after Cash Flow",
    CORE_LENS_IDS.join() === "cashFlow,markets" && /CORE_LENS_IDS\.map/.test(read("components", "dashboard", "SpaceDashboard.tsx")));
  const cats = ["PERSONAL", "FAMILY", "RETIREMENT", "INVESTMENT", "PROPERTY", "VEHICLE", "BUSINESS", "DEBT_PAYOFF", "EMERGENCY_FUND", "GOAL", "TRIP", "EQUIPMENT", "CUSTOM", "OTHER", "UNKNOWN_CATEGORY"];
  check("21. Markets is reachable in every customer Space category (incl. the default list)",
    cats.every((c) => getPerspectivesForCategory(c).some((p) => p.id === "markets")));
  for (const m of MARKETS_MODES) {
    const h = markets(m);
    const row = h.match(/<div data-markets-mode-row="[^"]*" class="([^"]*)"/)?.[1] ?? "";
    check(`22/24. ${MARKETS_MODE_LABELS[m]}: view row present, hidden only at lg+ (lg:hidden, nothing else hidden)`,
      /(^| )lg:hidden( |$)/.test(row) && !/(^| )hidden( |$)/.test(row), row);
    check(`23. ${MARKETS_MODE_LABELS[m]}: all five views reachable as radios, ${MARKETS_MODE_LABELS[m]} checked`,
      (h.match(/role="radio"/g) ?? []).length === 5 && text(h.match(/<div role="radiogroup"[\s\S]*?<\/div>/)?.[0] ?? "") === LABELS.join(" ") &&
        new RegExp(`role="radio" aria-checked="true"[^>]*>${MARKETS_MODE_LABELS[m]}<`).test(h));
  }
  const h = markets("research");
  check("one horizontal row that scrolls, never wraps or crushes (nowrap + overflow-x + whitespace-nowrap chips)",
    /class="no-scrollbar flex gap-1\.5 overflow-x-auto flex-nowrap justify-center-safe"/.test(h) && (h.match(/whitespace-nowrap/g) ?? []).length === 5);
  check("…safe-centred, so an overflowing row never clips its first option out of reach", !/ justify-center[" ]/.test(h));
  check("…in a block wrapper (not a flex centre) so the row can shrink to the column and scroll",
    /<div data-markets-mode-row="true" class="px-1 lg:hidden">/.test(h));
  check("Chips default (every existing caller) still wraps", /wrap = true/.test(read("components", "atlas", "Chips.tsx")) &&
    /wrap \? "flex-wrap" : "flex-nowrap"/.test(read("components", "atlas", "Chips.tsx")));
  check("25. sidebar children carry the views at lg+ (the sidebar is lg-only, the row lg-hidden: exact complements)",
    /<aside className="hidden w-\[212px\] shrink-0 lg:block">/.test(read("components", "ui", "ContextualNavbar.tsx")));
  const host = code(read("components", "dashboard", "SpaceDashboard.tsx"));
  check("26. ONE state: the sidebar child and the view row both call setMarketsMode on marketsMode",
    /if \(workspaceId === MARKETS_LENS_ID\) setMarketsMode\(childId as MarketsMode\);/.test(host) &&
      /marketsMode,\s*onMarketsModeChange: setMarketsMode,\s*marketsModeSelectorVisibility: "belowLg",/.test(host) &&
      /mode=\{ctx\.marketsMode\}\s*onModeChange=\{ctx\.onMarketsModeChange\}\s*modeSelectorVisibility=\{ctx\.marketsModeSelectorVisibility\}/.test(read("components", "space", "workspaces", "workspaceRenderers.tsx")));
  check("the default presentation (no host opt-in) is visible at every width", /data-markets-mode-row="true" class="px-1">/.test(markets("portfolio", { modeSelectorVisibility: undefined })));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("D. Accessibility");
{
  const h = navHtml(sidebar(nav("OVERVIEW", "markets", { marketsMode: "fundamentals" })), "Space");
  check("27. Markets parent: a real link to its workspace, marked current",
    /<a href="\/dashboard\?tab=overview&amp;perspective=markets" aria-current="true"/.test(h));
  check("28/29. children: a group named \"Markets\" of five real links; the selected one aria-current",
    (group(h, "Markets")?.match(/<a /g) ?? []).length === 5 && /aria-current="true"[^>]*>[\s\S]*?Fundamentals/.test(group(h, "Markets") ?? ""));
  check("keyboard: every destination is an <a href> (focusable, Enter activates) — no clickable div/span",
    !/<(div|span)[^>]*(onclick|tabindex)/i.test(h));

  const host = code(read("components", "dashboard", "SpaceDashboard.tsx"));
  const nameFor = (ws: string | null, child: string | null) =>
    [LENSES.find((l) => l.id === ws)?.label, ws ? workspaceChildren(ws)?.find((c) => c.id === child)?.label : null].filter(Boolean).join(", ");
  check("30. region name follows the open view — \"Markets, Portfolio\" … \"Markets, Watchlist\"",
    MARKETS_MODES.every((m) => nameFor("markets", openChildId("markets", { wealthMode: "total", marketsMode: m })) === `Markets, ${MARKETS_MODE_LABELS[m]}`));
  check("…and the host names the region through that exact derivation (aria-label, workspaceChildren)",
    /aria-label=\{openWorkspaceLabel\}/.test(host) && /workspaceChildren\(openWorkspace\)\?\.find\(\(c\) => c\.id === openChild\)\?\.label/.test(host));
  const mk = markets("technicals");
  check("31/32. no aria-labelledby anywhere on the Markets path — the hidden view row is never the name source",
    !/aria-labelledby/.test(mk) && !/aria-labelledby/.test(code(read("components", "space", "widgets", "markets", "MarketsWorkspace.tsx"))) && !/aria-labelledby/.test(host));
  check("the visible (<lg) view row is a named radiogroup with its selected radio exposed",
    /role="radiogroup" aria-label="Markets view"/.test(mk) && /role="radio" aria-checked="true"[^>]*>Technicals</.test(mk));
  check("each empty state carries its view as a heading", /<h2[^>]*>Technicals<\/h2>/.test(mk));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("E. Regression");
{
  for (const m of ["total", "assets", "debt"] as WealthMode[]) {
    const h = sidebar(nav("OVERVIEW", "wealth", { wealthMode: m }));
    check(`33. Net Worth · ${m}: Total · Assets · Debt nested, ${m} selected`,
      text(group(h, "Net Worth") ?? "") === "Total Assets Debt" && litAll(h).join() === `Net Worth,${m[0].toUpperCase()}${m.slice(1)}`);
  }
  const ww = read("components", "space", "widgets", "wealth", "WealthWorkspace.tsx");
  check("34. Net Worth's content mode row stays below-lg only via the host opt-in",
    /modeSelectorVisibility === "belowLg" \? "lg:hidden" : ""/.test(ww) && /wealthModeSelectorVisibility: "belowLg"/.test(read("components", "dashboard", "SpaceDashboard.tsx")));
  const cf = sidebar(nav("OVERVIEW", "cashFlow"));
  check("35. Cash Flow: a leaf, lit alone, its renderer unchanged", litAll(cf).join() === "Cash Flow" && workspaceChildren("cashFlow") === undefined &&
    /cashFlow: \(ctx\) => \(\s*<CashFlowWorkspace/.test(read("components", "space", "workspaces", "workspaceRenderers.tsx")));
  const hq = sidebar(null, "/dashboard/platform/PLATFORM_OPS");
  check("36. Platform HQ: Sections still render, no workspace nav, no Markets",
    hq.includes('<nav aria-label="Sections"') && !hq.includes('aria-label="Space"') && !/Markets/.test(hq) &&
      !/markets/i.test(code(read("components", "platform", "PlatformSpaceDashboard.tsx"))));
  check("37. global navigation unchanged — Markets is not a site destination",
    PRIMARY_NAV.map((d) => d.label).join() === "Brief,My Space,AI,Spaces,Connections" && !/markets/i.test(read("lib", "space-nav.ts")));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("F. Scope — a shell, nothing more");
{
  const mw = code(read("components", "space", "widgets", "markets", "MarketsWorkspace.tsx"));
  const mm = code(read("lib", "markets", "markets-mode.ts"));
  check("39/40. no fetch, provider, API or network call in the Markets code",
    ![mw, mm].some((s) => /fetch\(|axios|\/api\/|polygon|alphavantage|alpha vantage|finnhub|yahoo|tradingview|sec\.gov|websocket/i.test(s)));
  check("38. no database: Markets code imports no Prisma/db, and the schema has no Markets/Watchlist/Security model",
    ![mw, mm].some((s) => /prisma|@\/lib\/db/.test(s)) && !/model\s+(Market|Watchlist|Security|Quote)\w*\s*\{/.test(read("prisma", "schema.prisma")));
  check("42. no calculation: the workspace takes only mode + handlers (no accounts, snapshots, holdings, ctx)",
    !/accounts|snapshots|holdings|transactions|ConversionContext|formatCurrency/.test(mw));
  check("43. no fake security data: empty-state copy carries no ticker, price, % or figure",
    Object.values(MARKETS_EMPTY_COPY).every((c) => !/\b[A-Z]{2,5}\b|\$|%|\d/.test(c)) && !/\$\d|\d+\.\d+%|<svg|chart/i.test(markets("portfolio")));
  check("…and no data needs: opening Markets activates no host fetch",
    openPerspectiveDataNeeds("OVERVIEW", "markets").size === 0 && (PERSPECTIVE_LIBRARY.markets.dataNeeds ?? []).length === 0 &&
      PERSPECTIVE_LIBRARY.markets.lensId === undefined && PERSPECTIVE_LIBRARY.markets.envelope === "none");
  check("the workspace publishes the EMPTY trust envelope (no stale completeness above an empty page)",
    /onEnvelopeChange\?\.\(\{\}\)/.test(mw));

  const walk = (dir: string): string[] => readdirSync(path.join(ROOT, dir)).flatMap((f) => {
    const rel = path.join(dir, f);
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f) ? [rel] : [];
  });
  // Identifiers, not prose: AI code may say "market" in a comment; it must not
  // import or name the Markets workspace, its vocabulary or its lens id.
  const aiHits = walk("lib/ai").filter((f) => /MarketsWorkspace|markets-mode|MARKETS_|MarketsMode|["']markets["']/.test(read(f)));
  check("41. no AI tool / prompt / orchestration references Markets", aiHits.length === 0, aiHits.join());

  check("44. existing investment functionality untouched: `investments` keeps its registry entry, has no renderer",
    PERSPECTIVE_LIBRARY.investments?.status === "available" && !WORKSPACE_RENDERERS.investments);
  const inv = resolveUrlLens({ tab: "overview", perspective: "investments" });
  check("…and ?perspective=investments still lands in Net Worth → Assets / Investments, NOT Markets",
    inv.perspective === null && inv.legacy?.mode === "assets" && inv.legacy.slice === "investments");
  check("…Net Worth → Assets still embeds the investments section", /wealth-investments/.test(read("components", "space", "widgets", "wealth", "WealthWorkspace.tsx")));
}

if (failures > 0) { console.error(`\nspace-markets-nav: ${failures} failure(s).`); process.exit(1); }
console.log("\nspace-markets-nav: all passed.");
