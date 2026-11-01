/**
 * components/ui/site-nav-in-space.test.ts
 *
 * Standalone tsx + renderToStaticMarkup (house pattern), exits 0/1.
 *
 *   npx tsx components/ui/site-nav-in-space.test.ts
 *
 * REGRESSION — entering a Space took Fourth Meridian away. The desktop sidebar
 * was an either/or (`space ? <SpaceMode/> : <GlobalMode/>`) and the five primary
 * destinations lived inside GlobalMode only, so a Space publishing its chrome
 * unmounted the site nav. Below lg the BottomNav kept it reachable; at lg+
 * (where the bar is hidden) the only way to Brief / AI / Connections was out
 * through the launcher.
 *
 * Pins, by rendering the real components:
 *   A. the site nav on a non-Space route (the Spaces launcher);
 *   B. the SAME site nav inside a Space, above the Space's own context;
 *   C. the Space's navigation is all still there (workspaces, not Sections);
 *   D. active states — one rule, both modes;
 *   E. one definition: no second link list, one component in both modes;
 *   F. the responsive contract is untouched (rail lg+, bar < lg, same width);
 *   G. UX-P2 Phase B — the PLATFORM context (the directory and inside a
 *      Platform Space): the granted Platform list leads, one "Personal Spaces"
 *      exit, the site nav RETAINED under a hairline — a reordering, never a
 *      removal, never a duplication; a personal Space is untouched (D2).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContextualNavbar, GlobalMode, PrimaryNav, SpaceMode } from "@/components/ui/ContextualNavbar";
import { PRIMARY_NAV } from "@/lib/space-nav";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** Every <a href> in document order. */
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
/** The label of the element carrying aria-current="true" inside a given <nav aria-label>. */
function activeIn(html: string, navLabel: string): string[] {
  const nav = html.match(new RegExp(`<nav aria-label="${navLabel}"[^>]*>([\\s\\S]*?)</nav>`))?.[1] ?? "";
  return [...nav.matchAll(/<(a|button)[^>]*aria-current="true"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => text(m[2]));
}

const SITE_HREFS = PRIMARY_NAV.map((d) => d.href);
const SITE_LABELS = PRIMARY_NAV.map((d) => d.label);

const spaceMode = (pathname: string, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(SpaceMode, {
    pathname, pendingInvites: 0,
    space: {
      identity: { name: "Household", subtitle: "Shared · 3 members", shared: true },
      onManage: () => {}, onLeaveSpace: () => {},
    },
    currencyControl: null,
    workspaceNav: {
      items: [
        { id: "networth", label: "Net Worth", href: "/dashboard?tab=overview" },
        { id: "cashFlow", label: "Cash Flow", href: "/dashboard?tab=overview&perspective=cash-flow" },
      ],
      activeId: "networth",
      onSelect: () => {},
    },
    // A customer workspace may still PUBLISH anchors — the sidebar must not render them.
    sections: [{ label: "Summary", anchor: "debt-summary" }, { label: "Liabilities", anchor: "debt-liabilities" }],
    activeSection: "Liabilities",
    onSelectSection: () => {},
    ...over,
  } as never));

// ─────────────────────────────────────────────────────────────────────────────
console.log("A. Site nav on a non-Space route (the Spaces launcher)");
{
  // No Space has published chrome ⇒ the real sidebar resolves to global mode.
  const html = renderToStaticMarkup(createElement(ContextualNavbar));
  check("all five destinations, in PRIMARY_NAV order", hrefs(html).join() === SITE_HREFS.join(), hrefs(html).join());
  check('labelled nav aria-label="Global"', html.includes('<nav aria-label="Global"'));
  check("under the Fourth Meridian eyebrow", text(html).startsWith("Fourth Meridian Brief"));

  const launcher = renderToStaticMarkup(createElement(PrimaryNav, { pathname: "/dashboard/spaces" }));
  check("on /dashboard/spaces, Spaces is the active destination — and only it",
    activeIn(launcher, "Global").join() === "Spaces", activeIn(launcher, "Global").join());
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("B. The SAME site nav inside an individual Space");
{
  const html = spaceMode("/dashboard");
  check("all five site destinations are present inside the Space",
    SITE_HREFS.every((h) => hrefs(html).includes(h)), hrefs(html).join());
  check("…in PRIMARY_NAV order, as real links (client navigation, no full reload)",
    hrefs(html).slice(0, 5).join() === SITE_HREFS.join() && (html.match(/<nav aria-label="Global"/g) ?? []).length === 1);
  check("byte-identical block to the launcher's for the same pathname (one presentation, not a lookalike)",
    html.includes(renderToStaticMarkup(createElement(PrimaryNav, { pathname: "/dashboard" }))));
  check("the pending-invite badge rides along inside a Space too",
    text(spaceMode("/dashboard", { pendingInvites: 3 })).includes("Spaces 3 Connections"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("C. The Space's own navigation is all still there");
{
  const html = spaceMode("/dashboard");
  const t = text(html);
  check("which Space I am in: its name is THE heading", /<h1[^>]*>Household<\/h1>/.test(html));
  check("…with its Shared chip and subtitle", t.includes("Household Shared Shared · 3 members"));
  check("no in-Space 'All Spaces' back control (the site's Spaces link is the way back)", !t.includes("All Spaces"));
  check("Manage control", t.includes("Manage"));
  check('the Space nav (aria-label="Space") with its two workspaces',
    html.includes('<nav aria-label="Space"') && t.includes("Net Worth Cash Flow"));
  check("NO Sections list inside a customer Space, even with anchors published",
    !html.includes('aria-label="Sections"') && !/\bSections\b/.test(t) && !t.includes("Liabilities"));
  check("Leave Space", t.includes("Leave Space"));

  // HIERARCHY — document order is site → Space → workspaces, and the Space block is
  // visibly its own group (a hairline above it), not five more rows in one list.
  const iSite = html.indexOf('aria-label="Global"');
  const iSpace = html.indexOf('data-nav-context="space"');
  const iName = html.indexOf("Household</h1>");
  const iWork = html.indexOf('aria-label="Space"');
  check("order: site nav → Space context → its workspaces", iSite > -1 && iSite < iSpace && iSpace < iName && iName < iWork,
    `${iSite} ${iSpace} ${iName} ${iWork}`);
  check("the Space block is set apart by the hairline divider",
    /data-nav-context="space" class="[^"]*border-t[^"]*border-\[var\(--border-hairline\)\]/.test(html));
  check("the way back to Spaces is the site 'Spaces' link — no dead end without 'All Spaces'",
    hrefs(html).includes("/dashboard/spaces") && !t.includes("All Spaces"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("D. Active states — one rule, both modes, never two at once");
{
  const inSpace = spaceMode("/dashboard");
  check("inside the active Space (/dashboard): My Space is lit — the same rule the mobile bar uses",
    activeIn(inSpace, "Global").join() === "My Space", activeIn(inSpace, "Global").join());
  check("…and the Space's open WORKSPACE is lit independently", activeIn(inSpace, "Space").join() === "Net Worth");
  check("'Spaces' is NOT lit while inside a Space (My Space ≠ Spaces)", !activeIn(inSpace, "Global").includes("Spaces"));

  const hq = spaceMode("/dashboard/platform/PLATFORM_OPS");
  check("a platform HQ Space lights NO site destination (it is none of the five)", activeIn(hq, "Global").length === 0,
    activeIn(hq, "Global").join());
  // P-1 (owner-approved separate Platform shell) — the Platform context carries
  // no personal site nav; the exit row (and the header switch) lead back.
  check("…and offers none of the five (P-1: the Platform shell has its own navigation)",
    SITE_HREFS.every((h) => h === "/dashboard/spaces" || !hrefs(hq).includes(h)) && !hq.includes('aria-label="Global"'));

  for (const p of ["/dashboard", "/dashboard/spaces", "/dashboard/spaces/invites", "/dashboard/analyze", "/dashboard/brief", "/dashboard/connections", "/dashboard/settings/account"]) {
    const n = activeIn(renderToStaticMarkup(createElement(PrimaryNav, { pathname: p })), "Global").length;
    check(`${p} lights at most one`, n <= 1, `${n}`);
  }
  check("a null pathname (pre-hydration) lights nothing and does not throw",
    activeIn(renderToStaticMarkup(createElement(PrimaryNav, { pathname: null })), "Global").length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("E. ONE definition — reused, not duplicated");
{
  const rail = code(read("components", "ui", "ContextualNavbar.tsx"));
  check("PRIMARY_NAV is mapped exactly ONCE in the sidebar", (rail.match(/PRIMARY_NAV\.map/g) ?? []).length === 1);
  check("that one block is rendered by BOTH modes", (rail.match(/<PrimaryNav\b/g) ?? []).length === 2);
  check("no destination route is restated in the sidebar (hrefs come from lib/space-nav)",
    SITE_HREFS.filter((h) => h !== "/dashboard").every((h) => !rail.includes(`"${h}"`)),
    SITE_HREFS.filter((h) => rail.includes(`"${h}"`)).join());
  check("no label is restated either", SITE_LABELS.filter((l) => l !== "Spaces").every((l) => !new RegExp(`>\\s*${l}\\s*<`).test(rail)));
  check("the active rule is the shared one", /isPrimaryDestActive\(d\.id, pathname\)/.test(rail));
  check("the badge fetch is hoisted above the mode switch (no re-fetch when a Space publishes)",
    /export function ContextualNavbar\(\)[\s\S]*?usePendingInvites\(\)[\s\S]*?space \?/.test(rail));

  const hosts = code(read("components", "dashboard", "SpaceDashboard.tsx")) + code(read("components", "platform", "PlatformSpaceDashboard.tsx"));
  check("no Space host builds a site nav of its own", !/PRIMARY_NAV|PrimaryNav/.test(hosts));
  check("no host publishes an 'All Spaces' handler, and the chrome contract no longer carries one",
    !/\bonLeave:/.test(hosts) && !/\bonLeave:/.test(code(read("lib", "space", "space-chrome-context.tsx"))));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("F. Responsive contract untouched");
{
  const rail = read("components", "ui", "ContextualNavbar.tsx");
  const bar = read("components", "ui", "BottomNav.tsx");
  const chrome = read("components", "ui", "DashboardChrome.tsx");
  check("ONE <aside>, same 212px column, desktop-only — no second sidebar, no new width",
    (rail.match(/<aside\b/g) ?? []).length === 1 && /<aside className="hidden w-\[212px\] shrink-0 lg:block">/.test(rail));
  check("the longer Space-mode column scrolls inside the sticky rail instead of overflowing the viewport",
    rail.includes("sticky top-12 flex max-h-[calc(100dvh-3rem)] flex-col gap-5 overflow-y-auto"));
  check("below lg the BottomNav carries the same five — mounted once, unconditionally, in every mode",
    /lg:hidden/.test(bar) && /PRIMARY_NAV\.map/.test(bar) && (chrome.match(/<BottomNav \/>/g) ?? []).length === 1
      && !/\{[^}]*&&\s*<BottomNav/.test(chrome));
  check("content column still shrinks rather than overflowing (min-w-0 flex-1)", chrome.includes("min-w-0 flex-1"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("G. Platform context (UX-P2 Phase B → P-1): granted areas lead, one exit, no personal site nav");
{
  const globalMode = (pathname: string | null) =>
    renderToStaticMarkup(createElement(GlobalMode, { pathname, pendingInvites: 0 }));

  // 1. The Platform Spaces DIRECTORY — global mode on the platform axis. (In a
  //    DOM-less render the /api/spaces fetch never resolves, so PlatformNav is
  //    empty here; its LEADING position is pinned in source in §5.)
  const dir = globalMode("/dashboard/platform");
  const iExit = dir.indexOf('aria-label="Exit"');
  const iSite = dir.indexOf('data-nav-context="site"');
  const iGlobal = dir.indexOf('aria-label="Global"');
  check("directory: the exit row, and NO personal site nav after it (P-1)",
    iExit > -1 && iSite === -1 && iGlobal === -1, `${iExit} ${iSite} ${iGlobal}`);
  check("directory: the exit is ONE real link to the launcher — the Spaces destination's own route",
    /<nav aria-label="Exit"[^>]*><a [^>]*href="\/dashboard\/spaces"/.test(dir) &&
      (dir.match(/<nav aria-label="Exit"/g) ?? []).length === 1 && text(dir).includes("Personal Spaces"));
  // R1 — REPLACES "only the way back to Personal Spaces": the Platform context
  // now leads with its OWN three destinations (Overview · AI · Current Space);
  // the P-1 rule it protected — no PERSONAL site destination — is kept intact.
  check("directory: the three Platform destinations, then the way back; no personal site destination (P-1)",
    hrefs(dir).join() === "/dashboard/platform,/dashboard/platform/ai,/dashboard/platform,/dashboard/spaces" &&
      SITE_HREFS.filter((h) => h !== "/dashboard/spaces").every((h) => !hrefs(dir).includes(h)), hrefs(dir).join());
  check("directory: no site destination is lit (the directory is none of the five)", activeIn(dir, "Global").length === 0);
  check("directory: the site eyebrow no longer leads the rail", !text(dir).startsWith("Fourth Meridian"));

  // 2. The PERSONAL context is byte-identical to before: site nav leads, no exit, no demotion.
  for (const p of ["/dashboard/spaces", "/dashboard/brief", "/dashboard/analyze", "/dashboard/connections", "/dashboard/settings/account", null]) {
    const g = globalMode(p);
    check(`personal context (${p ?? "null"}): exactly the PrimaryNav block, nothing else`,
      g === renderToStaticMarkup(createElement(PrimaryNav, { pathname: p, pendingInvites: 0 })) &&
        !g.includes("Personal Spaces") && !g.includes('data-nav-context="site"'));
  }

  // 3. Inside a PLATFORM Space: Space block → Sections → exit → demoted site nav → Leave.
  const hq = spaceMode("/dashboard/platform/PLATFORM_OPS");
  const order = ['data-nav-context="space"', 'aria-label="Sections"', 'aria-label="Exit"']
    .map((k) => hq.indexOf(k));
  check("Platform Space: Space block → Sections → exit, in document order, and no site nav (P-1)",
    order.every((i) => i > -1) && order.every((v, i, a) => i === 0 || v > a[i - 1])
      && !hq.includes('data-nav-context="site"') && !hq.includes('aria-label="Global"'), order.join());
  check("Platform Space: the personal site nav is NOT rendered (P-1 separate Platform shell)",
    !hq.includes('aria-label="Global"') && SITE_HREFS.filter((h) => h !== "/dashboard/spaces").every((h) => !hrefs(hq).includes(h)));
  check("Platform Space: nothing lit in the site nav; the Space's workspace lit independently",
    activeIn(hq, "Global").length === 0 && activeIn(hq, "Space").join() === "Net Worth");
  check("Platform Space: Leave Space is still last", text(hq).endsWith("Leave Space"));

  // 4. Inside a PERSONAL Space nothing changed (D2 stands).
  const personal = spaceMode("/dashboard");
  check("personal Space: site nav first, no exit row, no demotion, no Platform list",
    hrefs(personal).slice(0, 5).join() === SITE_HREFS.join() && !personal.includes("Personal Spaces") &&
      !personal.includes('data-nav-context="site"') && !personal.includes('aria-label="Platform"') && !personal.includes('aria-label="Exit"'));

  // 5. Source — the leading position, and the single definitions.
  const rail = code(read("components", "ui", "ContextualNavbar.tsx"));
  const sm = rail.slice(rail.indexOf("export function SpaceMode"));
  // R1 — the Platform block is now the three-destination PlatformContextNav (same position rules).
  check("SpaceMode source: the Platform block is the FIRST block on the platform axis (before the Space block)",
    sm.indexOf("<PlatformContextNav") > -1 && sm.indexOf("<PlatformContextNav") < sm.indexOf('data-nav-context="space"'));
  const gm = rail.slice(rail.indexOf("export function GlobalMode"), rail.indexOf("export function SpaceMode"));
  check("GlobalMode source: on the platform context the Platform block precedes the exit, and nothing follows it (P-1)",
    /<PlatformContextNav pathname=\{pathname\} \/>\s*<PersonalSpacesExit \/>\s*<\/>/.test(gm));
  check("the exit row is ONE component, rendered by both modes, linking through primaryHref (no route literal)",
    (rail.match(/<PersonalSpacesExit \/>/g) ?? []).length === 2 && /href=\{primaryHref\("spaces"\)\}/.test(rail));
  check("the Phase B demotion wrapper is gone (P-1)", !/DemotedSiteNav/.test(rail));
  check("the context predicate is the shared navContext (global mode) and isPlatformSpaceRoute (space mode)",
    /navContext\(pathname\) === "platform"/.test(rail) && /onPlatformAxis = isPlatformSpaceRoute\(pathname\)/.test(rail));
  // R1 — PlatformNav (the personal way in) is mounted once; the Platform context's
  // block (PlatformContextNav) once per mode — still no duplication per mode.
  check("still exactly two PrimaryNav mounts; one PlatformNav (personal) + two PlatformContextNav (one per mode)",
    (rail.match(/<PrimaryNav\b/g) ?? []).length === 2 && (rail.match(/<PlatformNav\b/g) ?? []).length === 1 && (rail.match(/<PlatformContextNav\b/g) ?? []).length === 2);
  check("PRIMARY_NAV is still exactly five", PRIMARY_NAV.length === 5);
}

if (failures > 0) { console.error(`\nsite-nav-in-space: ${failures} failure(s).`); process.exit(1); }
console.log("\nsite-nav-in-space: all passed.");
