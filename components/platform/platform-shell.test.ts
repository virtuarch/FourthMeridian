/**
 * components/platform/platform-shell.test.ts
 *
 * The Platform-Space SIDEBAR contract (migration workstream S1): the two blocks
 * the prototype shows inside a Platform Space and production was missing —
 * SECTIONS and PLATFORM.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/platform-shell.test.ts
 *
 * Two gates, deliberately different in kind:
 *
 *   • RENDER (renderToStaticMarkup) — for everything that can be reached without
 *     a router or effects: the published Sections payload, the Sections block
 *     that consumes it, the section anchors actually emitted by the workspace
 *     body, and the Platform block for 0 / 1 / n access-derived destinations.
 *
 *   • SOURCE SCAN — for the two facts a DOM-less render cannot reach: that the
 *     Platform list has exactly ONE origin (the access-derived `/api/spaces`
 *     `platform` projection, never a literal), and that Space mode gates it on
 *     the platform axis. These are the invariants whose violation is invisible
 *     in markup, which is precisely why they are pinned in text.
 *
 * NOT tested here: that the operator is AUTHORIZED. That is server truth
 * (app/api/spaces/route.ts derives `platform` from ACTIVE PlatformGrant rows,
 * and the Space route redirects an ungranted area). What IS tested is that this
 * surface adds no second opinion about it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SpaceChromeSection } from "@/lib/space/space-chrome-context";
import { PlatformNav, SectionsNav, isPlatformSpaceRoute } from "@/components/ui/ContextualNavbar";
import {
  PlatformWorkspaceBody,
  platformChromeSections,
  platformSectionAnchor,
} from "@/components/platform/PlatformSpaceDashboard";
import { PLATFORM_AREA_WORKSPACES } from "@/lib/platform/workspaces";
import { PLATFORM_AREAS } from "@/lib/platform/policy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const stripComments = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const NAVBAR_SRC = stripComments("components/ui/ContextualNavbar.tsx");
const HOST_SRC = stripComments("components/platform/PlatformSpaceDashboard.tsx");

/** DB `SpaceDashboardSection` rows, shaped exactly as the page loads them. The
 *  labels here are deliberately NOT the key and NOT the policy default, so a
 *  hardcoded or key-derived label cannot pass. */
type Row = { id: string; key: string; label: string };
const row = (key: string, label: string): Row => ({ id: `row-${key}`, key, label });

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nA. SECTIONS — published from the ACTIVE workspace's DB rows");
// ─────────────────────────────────────────────────────────────────────────────
{
  const ops = PLATFORM_AREA_WORKSPACES.PLATFORM_OPS;
  const overview = ops.find((w) => w.workspaceId === "platform-overview")!;
  const refresh = ops.find((w) => w.workspaceId === "platform-refresh")!;

  // Every composed key of both workspaces has an enabled DB row with a label
  // that exists nowhere in the source (so only the row can supply it).
  const allKeys = [...new Set([...overview.sections, ...refresh.sections])];
  const rows = allKeys.map((k) => row(k, `DB-LABEL::${k}`));
  const byKey = new Map(rows.map((r) => [r.key, r] as const));

  const overviewSections = platformChromeSections(overview.sections, byKey);
  const refreshSections = platformChromeSections(refresh.sections, byKey);

  check(
    "labels come from the DB row, never the key or a literal",
    overviewSections.every((s, i) => s.label === `DB-LABEL::${overview.sections[i]}`),
    JSON.stringify(overviewSections),
  );
  check(
    "one row per composed section, in composition order",
    overviewSections.length === overview.sections.length &&
      overviewSections.length > 1,
  );
  check(
    "sections CHANGE with the active workspace (Overview ≠ Refresh)",
    JSON.stringify(overviewSections.map((s) => s.label)) !==
      JSON.stringify(refreshSections.map((s) => s.label)) &&
      refreshSections.length === refresh.sections.length,
  );
  check(
    "every live anchor is the key-derived id",
    overviewSections.every((s, i) => s.anchor === platformSectionAnchor(overview.sections[i])),
  );

  // A composed key with NO enabled DB row does not exist on this surface: it has
  // no label to show, and fabricating one is exactly what must not happen.
  const partial = new Map([[overview.sections[0], byKey.get(overview.sections[0])!]]);
  const partialSections = platformChromeSections(overview.sections, partial);
  check(
    "a composed key with no enabled DB row is OMITTED (not faked)",
    partialSections.length === 1 && partialSections[0].anchor != null,
  );

  // A DB row whose key has NO widget renders nothing on the page, so it gets a
  // null anchor — honestly disabled rather than pointing at a missing element.
  const ghostKey = "ops_not_a_widget_key";
  const withGhost = new Map(byKey);
  withGhost.set(ghostKey, row(ghostKey, "DB-LABEL::ghost"));
  const ghosted = platformChromeSections([overview.sections[0], ghostKey], withGhost);
  check(
    "a section with no widget gets anchor: null (honest, not invented)",
    ghosted.length === 2 && ghosted[1].label === "DB-LABEL::ghost" && ghosted[1].anchor === null,
    JSON.stringify(ghosted),
  );

  // The anchors must EXIST in the rendered body — a sidebar row that scrolls to
  // a missing id is the failure mode this pairing prevents.
  const bodyHtml = renderToStaticMarkup(
    createElement(PlatformWorkspaceBody, {
      sectionKeys: overview.sections,
      dbByKey: byKey,
      onOpen: () => {},
    }),
  );
  check(
    "every published anchor is a real id in the rendered workspace body",
    overviewSections
      .filter((s): s is SpaceChromeSection & { anchor: string } => s.anchor != null)
      .every((s) => bodyHtml.includes(`id="${s.anchor}"`)),
  );
  check(
    "a NON-composed section's anchor is absent from that body",
    !bodyHtml.includes(`id="${platformSectionAnchor("ops_manual_operations")}"`),
  );
  // The body is scoped to the ACTIVE workspace, not to "every enabled row": a
  // key that is available in the DB map but composed into a DIFFERENT workspace
  // must not render here (otherwise every workspace would show everything).
  const otherWorkspaceOnly = refresh.sections.filter((k) => !overview.sections.includes(k));
  check(
    "the body renders ONLY the active workspace's sections",
    otherWorkspaceOnly.length > 0 &&
      otherWorkspaceOnly.every((k) => byKey.has(k) && !bodyHtml.includes(`id="${platformSectionAnchor(k)}"`)),
  );
  check(
    "the body emits exactly one anchored row per composed section",
    (bodyHtml.match(/ id="platform-section-/g) ?? []).length === overview.sections.length,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB. SECTIONS block — the sidebar consumer of that payload");
// ─────────────────────────────────────────────────────────────────────────────
{
  const sections: SpaceChromeSection[] = [
    { label: "Scheduler", anchor: "platform-section-ops_scheduler" },
    { label: "Job Health", anchor: "platform-section-ops_job_health" },
    { label: "Not Built Yet", anchor: null },
  ];
  const html = renderToStaticMarkup(
    createElement(SectionsNav, { sections, activeSection: "Job Health", onSelectSection: () => {} }),
  );

  check("renders the Sections eyebrow", html.includes(">Sections</p>"));
  check('nav is labelled aria-label="Sections"', html.includes('aria-label="Sections"'));
  check("renders one row per published section", (html.match(/<button/g) ?? []).length === 3);
  check(
    "the anchor-less row is DISABLED and marked · soon",
    /<button disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Not Built Yet(?:(?!<\/button>)[\s\S])*· soon/.test(html),
    html,
  );
  check(
    "live rows are NOT disabled",
    (html.match(/<button disabled=""/g) ?? []).length === 1,
  );
  check(
    'the active section carries aria-current="true", and only it',
    (html.match(/aria-current="true"/g) ?? []).length === 1 &&
      /aria-current="true"[^>]*>(?:(?!<\/button>)[\s\S])*Job Health/.test(html),
  );
  check(
    "an empty payload renders NOTHING (no orphan eyebrow)",
    renderToStaticMarkup(
      createElement(SectionsNav, { sections: [], activeSection: "", onSelectSection: () => {} }),
    ) === "",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nC. PLATFORM block — driven by the access-derived destinations");
// ─────────────────────────────────────────────────────────────────────────────
{
  const nav = (items: { id: string; name: string; platformArea: string }[], pathname: string) =>
    renderToStaticMarkup(createElement(PlatformNav, { items, pathname }));

  check(
    "NO grants ⇒ no PLATFORM block at all (not an empty heading)",
    nav([], "/dashboard/platform/PLATFORM_OPS") === "",
  );

  const one = nav(
    [{ id: "s1", name: "Security Operations", platformArea: "SECURITY_OPS" }],
    "/dashboard/platform/SECURITY_OPS",
  );
  check("ONE grant ⇒ exactly one entry", (one.match(/<a /g) ?? []).length === 1);
  check("that entry links to /dashboard/platform/<area>", one.includes('href="/dashboard/platform/SECURITY_OPS"'));
  check("the entry shows the Space name from the response", one.includes("Security Operations"));
  check("the entry is a real interactive element (anchor with href)", /<a [^>]*href=/.test(one));
  check("the eyebrow reads PLATFORM", one.includes(">Platform</p>"));
  check('nav is labelled aria-label="Platform"', one.includes('aria-label="Platform"'));
  check("the Shield icon is present (prototype row idiom)", one.includes("lucide-shield"));

  const many = nav(
    [
      { id: "s1", name: "Platform Operations", platformArea: "PLATFORM_OPS" },
      { id: "s2", name: "Growth & Revenue", platformArea: "GROWTH_REVENUE" },
    ],
    "/dashboard/platform/GROWTH_REVENUE",
  );
  check("n grants ⇒ n entries", (many.match(/<a /g) ?? []).length === 2);
  check(
    "the CURRENT Space is the only one marked aria-current",
    (many.match(/aria-current="true"/g) ?? []).length === 1 &&
      /href="\/dashboard\/platform\/GROWTH_REVENUE"/.test(
        many.slice(many.indexOf('aria-current="true"'), many.indexOf('aria-current="true"') + 400),
      ),
  );
  check(
    "a Space the operator is NOT granted simply does not appear",
    !many.includes("SECURITY_OPS") && !many.includes("CUSTOMER_SUCCESS"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nD. ORIGIN — the list has one source, and Space mode gates it");
// ─────────────────────────────────────────────────────────────────────────────
{
  // No literal Space-name list may exist in the sidebar. The real names live in
  // lib/platform/policy.ts (server) and reach the client only via /api/spaces.
  const realNames = Object.values(PLATFORM_AREAS).map((a) => a.spaceName);
  const leaked = realNames.filter((n) => NAVBAR_SRC.includes(n));
  check(
    "no hardcoded platform Space names in the sidebar",
    leaked.length === 0,
    `leaked: ${leaked.join(", ")}`,
  );
  const areaLiterals = Object.keys(PLATFORM_AREAS).filter((a) => NAVBAR_SRC.includes(a));
  check(
    "no hardcoded PlatformArea literals in the sidebar",
    areaLiterals.length === 0,
    `leaked: ${areaLiterals.join(", ")}`,
  );

  check(
    "the destinations come from GET /api/spaces → data.platform",
    /fetch\("\/api\/spaces"\)/.test(NAVBAR_SRC) && /data\.platform/.test(NAVBAR_SRC),
  );
  check(
    "there is exactly ONE fetch of /api/spaces in the sidebar (not duplicated per mode)",
    (NAVBAR_SRC.match(/fetch\("\/api\/spaces"\)/g) ?? []).length === 1,
  );
  check(
    "both modes render the SAME PlatformNav component (one navigation pattern)",
    (NAVBAR_SRC.match(/<PlatformNav\b/g) ?? []).length === 2,
  );
  check(
    "Space mode gates the block on the platform axis (isPlatformSpaceRoute)",
    /onPlatformAxis\s*=\s*isPlatformSpaceRoute\(pathname\)/.test(NAVBAR_SRC) &&
      /\{onPlatformAxis\s*&&\s*<PlatformNav/.test(NAVBAR_SRC),
  );

  check("isPlatformSpaceRoute: a platform Space route", isPlatformSpaceRoute("/dashboard/platform/PLATFORM_OPS"));
  check("isPlatformSpaceRoute: a customer Space route is NOT", !isPlatformSpaceRoute("/dashboard"));
  check("isPlatformSpaceRoute: the launcher is NOT", !isPlatformSpaceRoute("/dashboard/spaces"));
  check("isPlatformSpaceRoute: null/undefined pathname is NOT", !isPlatformSpaceRoute(null) && !isPlatformSpaceRoute(undefined));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nE. PUBLISH LIFECYCLE — the host feeds the SAME chrome channel");
// ─────────────────────────────────────────────────────────────────────────────
{
  check(
    "the host uses the shared sections publisher (not a platform-only channel)",
    /useSpaceSectionsPublisher/.test(HOST_SRC) &&
      /@\/lib\/space\/space-chrome-context/.test(HOST_SRC),
  );
  check(
    "sections are derived from the ACTIVE workspace's composed keys",
    /platformChromeSections\(active\?\.sections/.test(HOST_SRC),
  );
  check(
    "sections are CLEARED on unmount (mirrors the identity publish)",
    /return \(\) => publishSections\(\[\]\)/.test(HOST_SRC),
  );
  check(
    "the rendered row id and the published anchor share ONE derivation",
    (HOST_SRC.match(/platformSectionAnchor\(/g) ?? []).length >= 3 &&
      /id=\{platformSectionAnchor\(row\.key\)\}/.test(HOST_SRC),
  );
  check(
    "the host hardcodes no section labels (labels are DB text)",
    !/label:\s*"/.test(HOST_SRC),
  );
}

console.log(
  failures === 0
    ? "\n✅ platform-shell: all checks passed\n"
    : `\n❌ platform-shell: ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
