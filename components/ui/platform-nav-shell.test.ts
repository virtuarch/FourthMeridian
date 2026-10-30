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
import { PlatformBottomBar } from "@/components/ui/BottomNav";
import { PLATFORM_AI_HREF, PLATFORM_SPACE_COOKIE, platformSpaceCookie, resolveCurrentPlatformSpace, type PlatformSpaceOption } from "@/lib/platform/nav";
import { PlatformNavProvider, usePlatformNav } from "@/components/ui/PlatformNavContext";
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

// Rows named so they exist nowhere in the source: only the granted row can label the bar.
const ALL: PlatformSpaceOption[] = Object.keys(PLATFORM_AREAS).map((a, i) => ({ id: `s${i}`, name: `ROW::${a}`, area: a }));
const bar = (pathname: string | null, current: PlatformSpaceOption | null) =>
  renderToStaticMarkup(createElement(PlatformBottomBar, { pathname, current }));

// R1 (Platform Operations 2.0, plan §2) — REPLACES the P-1 rule "Overview + up to
// four granted areas (five slots)": the owner ruled the Platform bar is EXACTLY
// three destinations, Overview · AI · Current Space, whatever the grant count.
// Each former check is restated as its R1 rule below (own landmark, Overview =
// directory, labels from the granted row, exactly one lit, no-grants honesty,
// links without eager prefetch, no area literal in the source).
console.log("mobile Platform bar (R1: exactly three destinations)");
{
  const sec = ALL.find((p) => p.area === "SECURITY_OPS")!;
  const html = bar("/dashboard/platform/SECURITY_OPS", sec);
  check("its own landmark (aria-label=Platform), never the personal 'Global' bar", /<nav aria-label="Platform"/.test(html) && !/aria-label="Global"/.test(html));
  check("EXACTLY three items, whatever the number of granted Spaces", hrefs(html).length === 3 && ALL.length > 3, hrefs(html).join());
  check("Overview → the directory; AI → /dashboard/platform/ai; Current Space → the selected area",
    hrefs(html).join() === ["/dashboard/platform", PLATFORM_AI_HREF, "/dashboard/platform/SECURITY_OPS"].join() && PLATFORM_AI_HREF === "/dashboard/platform/ai", hrefs(html).join());
  check("labels: Overview · AI · the Current Space's REAL name (the granted row, never a literal)",
    /aria-label="Overview"/.test(html) && /aria-label="AI"/.test(html) && /aria-label="ROW::SECURITY_OPS"/.test(html) && text(html).endsWith("ROW::SECURITY_OPS"));
  check("on an area, exactly Current Space is lit", lit(html).join() === "ROW::SECURITY_OPS", lit(html).join());
  check("Current Space is lit on ANY /dashboard/platform/<AREA> path (deep links + workspaces included)",
    lit(bar("/dashboard/platform/SECURITY_OPS/anything", sec)).join() === "ROW::SECURITY_OPS");
  check("on the directory, Overview alone is lit", lit(bar("/dashboard/platform", sec)).join() === "Overview");
  check("on the AI page, AI alone is lit (never mistaken for an area)", lit(bar(PLATFORM_AI_HREF, sec)).join() === "AI");
  const none = bar("/dashboard/platform", null);
  check("no granted Space known ⇒ still three items; the third is a neutral 'Space' pointing at Overview (nothing invented)",
    hrefs(none).length === 3 && /aria-label="Space"/.test(none) && hrefs(none)[2] === "/dashboard/platform" && !none.includes("ROW::"));
  check("every tap target is a Link (no buttons, no eager prefetch)", (html.match(/<a /g) ?? []).length === 3 && !/<button/.test(html));
  const src = code("components/ui/BottomNav.tsx");
  check("no hardcoded area literal in the bar's source", Object.keys(PLATFORM_AREAS).every((a) => !src.includes(`"${a}"`)));
  check("the bar's items come from the ONE list (lib/platform/nav platformDestinations), shared with the desktop rail",
    /platformDestinations\(pathname, current\)/.test(src) && /platformDestinations\(pathname, current\)/.test(code("components/ui/ContextualNavbar.tsx")));
  check("prefetch={false} on the Platform bar's link", /prefetch=\{false\}/.test(src.slice(src.indexOf("export function PlatformBottomBar"), src.indexOf("export function BottomNavBar"))));
}

console.log("Current Space: the cookie is followed ONLY when granted (R1)");
{
  const two = ALL.slice(0, 2);
  check("a remembered, GRANTED area is the Current Space", resolveCurrentPlatformSpace(two, null, two[1].area)?.area === two[1].area);
  check("an UNGRANTED remembered area falls back to the first granted", resolveCurrentPlatformSpace(two, null, ALL[3].area)?.area === two[0].area);
  check("an unknown / forged value falls back to the first granted", resolveCurrentPlatformSpace(two, null, "ADMIN; Path=/")?.area === two[0].area && resolveCurrentPlatformSpace(two, null, "ai")?.area === two[0].area);
  check("the route's own (granted) area beats the cookie", resolveCurrentPlatformSpace(two, two[0].area, two[1].area)?.area === two[0].area);
  check("an ungranted route area does not win either", resolveCurrentPlatformSpace(two, ALL[3].area, two[1].area)?.area === two[1].area);
  check("no grants ⇒ no Current Space, whatever the cookie says", resolveCurrentPlatformSpace([], null, ALL[0].area) === null);
}

console.log("the Platform nav provider + layout: SSR label, cookie validated against grants (R1)");
{
  const Probe = () => { const { current, spaces } = usePlatformNav(); return createElement("i", null, `${current?.area ?? "none"}/${spaces.length}`); };
  const view = (pathname: string, spaces: PlatformSpaceOption[], rememberedArea: string | null) =>
    renderToStaticMarkup(createElement(PlatformNavProvider, { spaces, rememberedArea, pathname }, createElement(Probe)));
  const two = ALL.slice(0, 2);
  check("SSR: the remembered (granted) Space labels the first paint", view("/dashboard/platform", two, two[1].area) === `<i>${two[1].area}/2</i>`);
  check("SSR: an ungranted remembered value is ignored ⇒ first granted", view("/dashboard/platform", two, ALL[4].area) === `<i>${two[0].area}/2</i>`);
  check("on a granted area route, that area is current (the route wins)", view(`/dashboard/platform/${two[0].area}`, two, two[1].area) === `<i>${two[0].area}/2</i>`);
  check("outside the provider: no Spaces, no current (nothing invented)", renderToStaticMarkup(createElement(Probe)) === "<i>none/0</i>");
  check("the cookie holds ONLY a validated area enum, first-party, Lax, path /dashboard",
    platformSpaceCookie(two[0].area, true) === `${PLATFORM_SPACE_COOKIE}=${two[0].area}; Path=/dashboard; Max-Age=31536000; SameSite=Lax; Secure` &&
      platformSpaceCookie("ai", false) === null && platformSpaceCookie("X; Domain=evil", false) === null && PLATFORM_SPACE_COOKIE === "fm_platform_space");
  const prov = code("components/ui/PlatformNavContext.tsx");
  check("the provider writes the cookie only for a VISITED GRANTED area", /const visited = pathArea !== null && spaces\.some\(\(s\) => s\.area === pathArea\) \? pathArea : null;/.test(prov) &&
    /if \(visited === null\) return;/.test(prov) && (prov.match(/document\.cookie/g) ?? []).length === 1);
  const layout = code("app/(shell)/dashboard/layout.tsx");
  check("layout: rows + cookie only for a grant holder, the cookie resolved AGAINST the rows",
    /if \(hasPlatformGrants\) \{/.test(layout) && /loadPlatformDirectory\(session\.user\.id\)/.test(layout) &&
      /resolveCurrentPlatformSpace\(platformSpaces, null, remembered\)/.test(layout) && /platformSpaces=\{platformSpaces\} platformArea=\{platformArea\}/.test(layout));
  check("no cookie is written by any page or the proxy (display preference, client-only write)",
    !/fm_platform_space|PLATFORM_SPACE_COOKIE/.test(code("proxy.ts")) && !/PLATFORM_SPACE_COOKIE|cookies\(\)\.set/.test(code("app/(shell)/dashboard/platform/[area]/page.tsx")));
}

console.log("BottomNav switches presentation by ROUTE context; personal path unchanged");
{
  const src = code("components/ui/BottomNav.tsx");
  check("context = navContext(pathname) — a route fact", /const platformContext = navContext\(pathname\) === "platform";/.test(src));
  check("personal context renders the unchanged personal bar", /platformContext\s*\?\s*<PlatformBottomBar[^>]*\/>\s*:\s*<BottomNavBar pathname=\{pathname\} \/>/.test(src));
  // R1 — REPLACES "grants are fetched only in the platform context, through the
  // sidebar's one hook": the bar now fetches NOTHING; the Current Space comes from
  // the Platform nav provider (granted rows the layout loaded server-side).
  check("the bar performs no fetch; the Current Space comes from the Platform nav provider",
    /const \{ current \} = usePlatformNav\(\);/.test(src) && !/fetch\(/.test(src) && !/usePlatformDestinations/.test(src));
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
