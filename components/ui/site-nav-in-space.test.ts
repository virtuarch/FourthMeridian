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
 *   C. the Space's navigation is all still there;
 *   D. active states — one rule, both modes;
 *   E. one definition: no second link list, one component in both modes;
 *   F. the responsive contract is untouched (rail lg+, bar < lg, same width).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContextualNavbar, PrimaryNav, SpaceMode } from "@/components/ui/ContextualNavbar";
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
      onLeave: () => {}, onManage: () => {}, onLeaveSpace: () => {},
    },
    currencyControl: null,
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
  check("return to Spaces: the 'All Spaces' back control", t.includes("All Spaces"));
  check("Manage control", t.includes("Manage"));
  check('the Sections nav (aria-label="Sections") with every published section',
    html.includes('<nav aria-label="Sections"') && t.includes("Sections Summary Liabilities"));
  check("Leave Space", t.includes("Leave Space"));

  // HIERARCHY — document order is site → Space → sections, and the Space block is
  // visibly its own group (a hairline above it), not five more rows in one list.
  const iSite = html.indexOf('aria-label="Global"');
  const iSpace = html.indexOf('data-nav-context="space"');
  const iName = html.indexOf("Household</h1>");
  const iSections = html.indexOf('aria-label="Sections"');
  check("order: site nav → Space context → its sections", iSite > -1 && iSite < iSpace && iSpace < iName && iName < iSections,
    `${iSite} ${iSpace} ${iName} ${iSections}`);
  check("the Space block is set apart by the hairline divider",
    /data-nav-context="space" class="[^"]*border-t[^"]*border-\[var\(--border-hairline\)\]/.test(html));
  check("two ways back to Spaces, neither a dead end: the site 'Spaces' link and the Space's 'All Spaces'",
    hrefs(html).includes("/dashboard/spaces") && t.includes("All Spaces"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("D. Active states — one rule, both modes, never two at once");
{
  const inSpace = spaceMode("/dashboard");
  check("inside the active Space (/dashboard): My Space is lit — the same rule the mobile bar uses",
    activeIn(inSpace, "Global").join() === "My Space", activeIn(inSpace, "Global").join());
  check("…and the Space's active SECTION is lit independently", activeIn(inSpace, "Sections").join() === "Liabilities");
  check("'Spaces' is NOT lit while inside a Space (My Space ≠ Spaces)", !activeIn(inSpace, "Global").includes("Spaces"));

  const hq = spaceMode("/dashboard/platform/PLATFORM_OPS");
  check("a platform HQ Space lights NO site destination (it is none of the five)", activeIn(hq, "Global").length === 0,
    activeIn(hq, "Global").join());
  check("…but still offers all five", SITE_HREFS.every((h) => hrefs(hq).includes(h)));

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
  check("'All Spaces' still routes to the launcher from both hosts (pure client navigation)",
    (hosts.match(/onLeave: \(\) => router\.push\("\/dashboard\/spaces"\)/g) ?? []).length === 2);
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

if (failures > 0) { console.error(`\nsite-nav-in-space: ${failures} failure(s).`); process.exit(1); }
console.log("\nsite-nav-in-space: all passed.");
