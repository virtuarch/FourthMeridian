/**
 * components/platform/platform-directory.test.ts  (UX-P2 — navigation separation)
 *
 * Standalone tsx + renderToStaticMarkup (house pattern), exits 0/1.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/platform-directory.test.ts
 *
 * The Platform directory page — since Platform Operations 2.0 R1 the OVERVIEW
 * command center (components/platform/overview), fed by the same rows:
 *   A. the pure mapper: one row shape, registry order, grant ∩ Space;
 *   B. 0 / 1 / n render (R1: one Space section per granted row, replacing the
 *      HQ card idiom), no Create CTA;
 *   C. links only — bare area URLs, the page/Overview write no cookie, no
 *      switch call, no auto-open (the nav provider alone remembers the Space);
 *   D. decision N1: the launcher no longer carries the group; /api/spaces keeps
 *      its `platform` key for the sidebar; the area page redirects here.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PlatformOverviewView, initialSignals } from "@/components/platform/overview/PlatformOverview";
import { platformAreaHref, platformDirectoryRows, type PlatformDirectoryRow } from "@/lib/platform/directory";
import { ALL_PLATFORM_AREAS, PLATFORM_AREAS } from "@/lib/platform/policy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
const render = (rows: PlatformDirectoryRow[]) => {
  const spaces = rows.map((r) => ({ id: r.id, name: r.name, area: r.area }));
  return renderToStaticMarkup(createElement(PlatformOverviewView, { spaces, signals: initialSignals(spaces) }));
};
/** The Space doorways (section headings) of the Overview, in document order. */
const spaceLinks = (html: string) =>
  [...(html.match(/<section aria-label="Spaces"[^>]*>([\s\S]*)<\/section>/)?.[1] ?? "").matchAll(/<a class="group inline-flex[^"]*" href="([^"?]+)"/g)].map((m) => m[1]);

// Fixtures in DELIBERATELY scrambled order, with names that exist nowhere in
// the source, so only the registry can order them and only the row can name them.
const areas = ALL_PLATFORM_AREAS;
const space = (i: number) => ({ id: `s-${areas[i]}`, name: `ROW-NAME::${areas[i]}`, platformArea: areas[i] });
const grant = (i: number, level = "READ") => ({ area: areas[i], level });

// ─────────────────────────────────────────────────────────────────────────────
console.log("A. The pure mapper — one row shape, registry order, grant ∩ Space");
{
  check("the registry has at least three areas (the order claim is not vacuous)", areas.length >= 3, `${areas.length}`);
  const scrambled = [space(2), space(0), space(1)];
  const rows = platformDirectoryRows(scrambled, [grant(1, "MANAGE"), grant(2), grant(0, "CONTROL")]);
  check("rows come back in ALL_PLATFORM_AREAS order, whatever the input order",
    rows.map((r) => r.area).join() === [areas[0], areas[1], areas[2]].join(), rows.map((r) => r.area).join());
  check("one row shape: {id, name, area, access}",
    rows.every((r) => Object.keys(r).sort().join() === "access,area,id,name"));
  check("access is the GRANT's level for that area",
    rows.map((r) => r.access).join() === "CONTROL,MANAGE,READ", rows.map((r) => r.access).join());
  check("name and id are the Space row's", rows[0].id === `s-${areas[0]}` && rows[0].name === `ROW-NAME::${areas[0]}`);
  check("a Space whose area is NOT granted yields no row (second lock behind the server filter)",
    platformDirectoryRows([space(0), space(1)], [grant(0)]).map((r) => r.area).join() === areas[0]);
  check("a grant with no seeded Space yields no row (nothing to open, nothing invented)",
    platformDirectoryRows([space(0)], [grant(0), grant(1)]).length === 1);
  check("no grants ⇒ no rows", platformDirectoryRows([space(0)], []).length === 0);
  check("no Spaces ⇒ no rows", platformDirectoryRows([], [grant(0)]).length === 0);
  check("a null platformArea never matches", platformDirectoryRows([{ id: "x", name: "x", platformArea: null }], [grant(0)]).length === 0);
  check("platformAreaHref is the bare area URL (the default workspace; no ?workspace=, no auto-open)",
    platformAreaHref(areas[0]) === `/dashboard/platform/${areas[0]}` && !platformAreaHref(areas[0]).includes("?"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("B. 0 / 1 / n render — one Space section per granted row (R1 Overview), no Create CTA");
{
  // R1 — REPLACES the HQ-card pins (badge, "Platform area · {access}", arrow
  // card): the Overview renders one Space SECTION per granted row — a doorway
  // link + that Space's KPI tiles — with the same 0/1/n, order and grant rules.
  const zero = render([]);
  check("0: the title and an honest empty line, no Space section, no CTA",
    /<h1[^>]*>Overview<\/h1>/.test(zero) && text(zero).includes("No Platform Space is granted to this account") &&
      hrefs(zero).length === 0);

  const one = render(platformDirectoryRows([space(1)], [grant(1, "MANAGE")]));
  check("1: exactly one Space doorway, a LINK to the bare area URL",
    spaceLinks(one).join() === `/dashboard/platform/${areas[1]}`, spaceLinks(one).join());
  check("1: the Space's name from the row", one.includes(`ROW-NAME::${areas[1]}`));

  const many = render(platformDirectoryRows([space(2), space(0), space(1)], [grant(0), grant(1), grant(2)]));
  check("n: n Space doorways, in registry order",
    spaceLinks(many).join() === [0, 1, 2].map((i) => `/dashboard/platform/${areas[i]}`).join(), spaceLinks(many).join());
  check("n: every section names its Space from the row", [0, 1, 2].every((i) => many.includes(`ROW-NAME::${areas[i]}`)));
  check("a Space the operator is NOT granted simply does not appear",
    !render(platformDirectoryRows([space(0), space(1)], [grant(0)])).includes(`ROW-NAME::${areas[1]}`));

  for (const html of [zero, one, many]) {
    check("no Create CTA, no 'Create' anywhere (provisioned by grant, never created)", !/Create/.test(text(html)));
    check("no money and no figure before any area has answered (first frame)", !/\$|\d+\.\d+%/.test(text(html).replace(/\d+ Platform Spaces?/, "")));
  }
  check("title: Overview, with the granted count as framing", text(many).includes("3 Platform Spaces · granted to you"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("C. Links only — no cookie, no switch, no storage, no auto-open");
{
  const dir = code(read("components", "platform", "overview", "PlatformOverview.tsx")) + code(read("components", "platform", "overview", "overview-model.ts"));
  check("no router.push, no onClick — doorways are <Link>s", !/router\.push|onClick|useRouter/.test(dir) && /<Link/.test(dir));
  check("prefetch={false} on every Overview link", (dir.match(/<Link\b/g) ?? []).length === (dir.match(/prefetch=\{false\}/g) ?? []).length);
  check("no cookie, storage or switch call (the Overview remembers nothing)", !/document\.cookie|localStorage|sessionStorage|\/api\/space\/switch|fm_platform_space|PLATFORM_SPACE_COOKIE/.test(dir));
  check("Space hrefs come from the one helper (platformAreaHref / platformWorkspaceHref), never a template here",
    /platformAreaHref\(space\.area\)/.test(dir) && !/`\/dashboard\/platform\//.test(dir));
  check("no sorting of Spaces here — order arrives from the loader", !/spaces\.(slice\(\)\.)?sort\(/.test(dir));
  const realNames = Object.values(PLATFORM_AREAS).map((a) => a.spaceName);
  check("no hardcoded platform Space names", realNames.every((n) => !dir.includes(n)));

  const page = code(read("app", "(shell)", "dashboard", "platform", "page.tsx"));
  check("the page loads through the one read site", /loadPlatformDirectory\(session\.user\.id\)/.test(page));
  check("zero grants ⇒ redirect to the launcher, never an empty directory",
    /if \(spaces\.length === 0\) redirect\("\/dashboard\/spaces"\)/.test(page));
  check("NEVER auto-opens an area (no redirect into /dashboard/platform/<AREA>, no 'last area')",
    !/redirect\([^)]*platformAreaHref|redirect\(`\/dashboard\/platform\/|last/i.test(page));
  check("no cookie / switch / customer-Space authority on the page",
    !/ACTIVE_SPACE_COOKIE|cookies\(|resolveSpaceContext|getSpaceContext|spaceMember|\/api\/space\/switch/.test(page));
  check("the page renders the Overview and nothing else, from the granted rows only",
    /return <PlatformOverview spaces=\{spaces\.map\(/.test(page) && (page.match(/<[A-Z]\w+/g) ?? []).length === 1);

  const mapper = code(read("lib", "platform", "directory.ts"));
  check("the mapper is pure and client-safe (no Prisma client, no server-only, no db)",
    !/server-only|@\/lib\/db|prisma\b(?!\/client)|systemDb|withTenantDb/.test(mapper) && /import type \{ PlatformArea \} from "@prisma\/client"/.test(mapper));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("D. Decision N1 — one home; the sidebar's feed and the area page's redirects");
{
  const launcher = code(read("components", "dashboard", "SpacesClient.tsx"));
  check("SpacesClient no longer renders an HQ group (no PlatformSpaceGroup, no platformSpaces prop)",
    !/PlatformSpaceGroup|PlatformSpaceItem|platformSpaces/.test(launcher));
  check("…and carries no 'Fourth Meridian HQ' eyebrow", !/Fourth Meridian HQ/.test(launcher));
  const spacesPage = code(read("app", "(shell)", "dashboard", "spaces", "page.tsx"));
  // (`platformArea: null` legitimately survives there — it is the public-Space
  // list's exclusion of platform Spaces, not a platform read.)
  check("the launcher page loads no platform Spaces", !/loadPlatformSpaces|platformGrant|ALL_PLATFORM_AREAS/.test(spacesPage));

  const api = read("app", "api", "spaces", "route.ts");
  check("/api/spaces keeps its `platform` key (the sidebar's PlatformNav reads it)",
    /platform,\s*\}\);/.test(api) && /ALL_PLATFORM_AREAS/.test(api));

  const area = code(read("app", "(shell)", "dashboard", "platform", "[area]", "page.tsx"));
  // SEC-PLAT-2 — the grant check moved into the shared guard (requirePlatformAccess):
  // unknown area, a 403 from the guard, a missing grant row and a missing Space all
  // still land on the DIRECTORY.
  check("[area]/page.tsx: an unknown / ungranted / missing area redirects to the DIRECTORY (which itself redirects at zero grants)",
    (area.match(/redirect\("\/dashboard\/platform"\)/g) ?? []).length === 4 && /err\.status === 403\) redirect\("\/dashboard\/platform"\)/.test(area)
      && !/redirect\("\/dashboard\/spaces"\)/.test(area));
  check("[area]/page.tsx: authority = the shared platform guard + the sections read on db (RLS-T3)",
    /requirePlatformAccess\(area, "READ"\)/.test(area) && !/platformGrant/.test(area) && /db\.space\.findUnique/.test(area));
}

if (failures > 0) { console.error(`\nplatform-directory: ${failures} failure(s).`); process.exit(1); }
console.log("\nplatform-directory: all passed.");
