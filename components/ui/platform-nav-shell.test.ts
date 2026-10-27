/**
 * components/ui/platform-nav-shell.test.ts  (P-1 — separate Platform navigation shell)
 *
 * Owner ruling P-1 (2026-10-27): a separate Platform navigation shell, same
 * login, same server-side grants. Personal context is proven byte-identical by
 * personal-nav-baseline.test.ts; this file pins the Platform side and the two
 * coordination requests (Claude 1, 2026-10-27):
 *   (a) personal unchanged — GlobalActions' only change is a context condition;
 *   (b) the personal Refresh is hidden by ROUTE CONTEXT ONLY, never by grant.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformBottomBar, PLATFORM_BAR_AREAS } from "@/components/ui/BottomNav";
import { showsPersonalRefresh, navContext } from "@/lib/space-nav";
import { PLATFORM_AREAS } from "@/lib/platform/policy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const hrefs = (h: string) => [...h.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
const lit = (h: string) => [...h.matchAll(/<a [^>]*aria-current="true"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);

const ALL = Object.keys(PLATFORM_AREAS).map((a, i) => ({ id: `s${i}`, name: `ROW::${a}`, platformArea: a }));

console.log("mobile Platform bar");
{
  const bar = renderToStaticMarkup(createElement(PlatformBottomBar, { pathname: "/dashboard/platform/SECURITY_OPS", platform: ALL }));
  check("its own landmark (aria-label=Platform), never the personal 'Global' bar", /<nav aria-label="Platform"/.test(bar) && !/aria-label="Global"/.test(bar));
  check(`Overview + at most ${PLATFORM_BAR_AREAS} granted areas (five slots)`, hrefs(bar).length === 1 + Math.min(PLATFORM_BAR_AREAS, ALL.length), hrefs(bar).join());
  check("Overview is the Platform directory; areas are bare area URLs, in the given (access-derived) order",
    hrefs(bar)[0] === "/dashboard/platform" && hrefs(bar).slice(1).join() === ALL.slice(0, PLATFORM_BAR_AREAS).map((p) => `/dashboard/platform/${p.platformArea}`).join());
  check("labels come from the registry's navLabel, not the row name or a literal",
    ALL.slice(0, PLATFORM_BAR_AREAS).every((p) => text(bar).includes(PLATFORM_AREAS[p.platformArea as keyof typeof PLATFORM_AREAS].navLabel)) && !bar.includes("ROW::"));
  check("exactly the open area is lit", lit(bar).join() === PLATFORM_AREAS.SECURITY_OPS.navLabel, lit(bar).join());
  const onDir = renderToStaticMarkup(createElement(PlatformBottomBar, { pathname: "/dashboard/platform", platform: ALL }));
  check("on the directory, Overview is lit", lit(onDir).join() === "Overview");
  const none = renderToStaticMarkup(createElement(PlatformBottomBar, { pathname: "/dashboard/platform", platform: [] }));
  check("no grants loaded yet ⇒ Overview alone (nothing invented)", hrefs(none).join() === "/dashboard/platform");
  check("every tap target is a Link without eager prefetch", (bar.match(/<a /g) ?? []).length === hrefs(bar).length);
  check("no hardcoded area literal in the bar's source", Object.keys(PLATFORM_AREAS).every((a) => !code("components/ui/BottomNav.tsx").includes(`"${a}"`)));
}

console.log("BottomNav switches presentation by ROUTE context; personal path unchanged");
{
  const src = code("components/ui/BottomNav.tsx");
  check("context = navContext(pathname) — a route fact", /const platformContext = navContext\(pathname\) === "platform";/.test(src));
  check("personal context renders the unchanged personal bar", /platformContext\s*\?\s*<PlatformBottomBar[^>]*\/>\s*:\s*<BottomNavBar pathname=\{pathname\} \/>/.test(src));
  check("grants are fetched only in the platform context, through the sidebar's one hook", /usePlatformDestinations\(platformContext\)/.test(src) && !/fetch\(/.test(src));
}

console.log("(b) the personal Refresh: hidden by route context only, never by grant");
{
  for (const p of ["/dashboard", "/dashboard/spaces", "/dashboard/brief", "/dashboard/analyze", "/dashboard/connections", "/dashboard/settings/account", null]) {
    check(`personal route ${p ?? "null"} shows Refresh`, showsPersonalRefresh(p) === true);
  }
  for (const p of ["/dashboard/platform", "/dashboard/platform/PLATFORM_OPS", "/dashboard/platform/CUSTOMER_SUCCESS?workspace=platform-incidents"]) {
    check(`platform route ${p} hides Refresh`, showsPersonalRefresh(p) === false && navContext(p) === "platform");
  }
  check("the predicate takes ONLY the pathname (no grant / session input)", /export function showsPersonalRefresh\(pathname: string \| null \| undefined\): boolean \{\s*return navContext\(pathname\) !== "platform";\s*\}/.test(code("lib/space-nav.ts")));
  const ga = code("components/ui/GlobalActions.tsx");
  check("(a) GlobalActions' only change is the context condition around RefreshButton",
    /\{showsPersonalRefresh\(pathname\) && <RefreshButton bare \/>\}/.test(ga) && /<NotificationBell \/>/.test(ga) && /<UserMenu \/>/.test(ga)
      && (ga.match(/<RefreshButton\b/g) ?? []).length === 1 && !/grant|platformGrant|usePlatformDestinations/.test(ga));
}

console.log("desktop sidebar: the Platform context carries no personal site nav");
{
  const rail = code("components/ui/ContextualNavbar.tsx");
  check("no demoted site nav remains", !/DemotedSiteNav/.test(rail));
  check("PrimaryNav is still mounted once per mode (both on the personal context)", (rail.match(/<PrimaryNav\b/g) ?? []).length === 2);
  check("the ONE /api/spaces fetch stays in the sidebar module", (rail.match(/fetch\("\/api\/spaces"\)/g) ?? []).length === 1);
}

if (failures > 0) {
  console.error(`\nplatform-nav-shell: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nplatform-nav-shell: all checks passed.");
