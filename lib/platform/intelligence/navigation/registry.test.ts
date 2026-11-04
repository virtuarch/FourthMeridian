/**
 * lib/platform/intelligence/navigation/registry.test.ts  (Platform Intelligence — foundation step 3)
 *
 * Pins for ./registry.ts and ./access.ts (no database):
 *   1. DERIVED, both directions — every area × workspace × view and every
 *      retired alias has a target and every target has a source; every
 *      Platform deep-link param (space-url.ts + the workspace-scoped list) is
 *      owned by exactly one param group, and every other Space-URL key is
 *      declared personal-Space-only; each group's homes are EXACTLY the leads /
 *      sections whose component reads it;
 *   2. labels = the UI's own labels (view control, rail via platformMountContext,
 *      nav destinations);
 *   3. real routes — every href resolves to an app/ page route (filesystem scan),
 *      and is built by the UI's own link builder BY IDENTITY (workspace-href.ts);
 *   4. guards = the destination page's own guard (source scan), incl. the
 *      break-glass refusal;
 *   5. permission filtering per area and level; tier on every surface;
 *      break-glass and forged tokens see nothing; invisible ≡ unknown;
 *   6. params — the owner's parser decides; unknown / identity / repeated /
 *      non-canonical / unsafe ⇒ null; injection attempts; fuzzed same-origin check;
 *   7. metric links — ids exist, tile homes are real, every tile is homed or
 *      says why, and every metric drill page resolves through this registry to
 *      the SAME href;
 *   8. static — no mint path, literal surfaces, bounded importers.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/navigation/registry.test.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PlatformArea, UserRole } from "@prisma/client";
import {
  AI_PAGE, AREA_PAGE, AREA_PAGE_LEVEL, DIRECTORY_PAGE, NAVIGATION_PARAM_GROUPS, NAVIGATION_TARGETS, TARGET_IDENTITY_PARAMS,
  DEFAULT_WORKSPACE_ID, TILE_HOMES, type ComponentHome, type NavigationTarget,
} from "./registry";
import { listNavigationTargets, resolveNavigationTarget } from "./access";
import { metricAccessFor, type MetricAccessToken } from "@/lib/platform/intelligence/metrics/access";
import { METRICS, drillLinks, metricKey } from "@/lib/platform/intelligence/metrics/registry";
import { drillRouteArea } from "@/lib/platform/intelligence/metrics/retrieve-core";
import {
  PLATFORM_AREA_WORKSPACES, PLATFORM_WORKSPACES, PLATFORM_WORKSPACE_ALIASES,
} from "@/lib/platform/workspaces";
import { ALL_PLATFORM_AREAS, ALL_ACCESS_LEVELS, PLATFORM_AREAS } from "@/lib/platform/policy";
import { PLATFORM_AI_HREF, platformDestinations } from "@/lib/platform/nav";
import { PLATFORM_DIRECTORY_HREF } from "@/lib/space-nav";
import { PLATFORM_WORKSPACE_SCOPED_PARAMS, SPACE_URL_PARAMS } from "@/lib/space/space-url";
import { platformMountContext } from "@/lib/space/mount-context.server";
import * as hrefModule from "@/lib/platform/workspace-href";
import * as hookModule from "@/lib/space/use-platform-workspace-navigation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
// Line comments first: a "/*" inside a line comment ("comms/*") must not open a block.
const code = (s: string) => s.replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
const NOW = new Date("2026-11-04T12:00:00.000Z");
const ORIGIN = "https://x";

const user = (role: UserRole) => ({ role });
const grant = (area: string, level = "READ") => ({ area, level }) as never;
const tokenFor = (area: PlatformArea, level = "READ"): MetricAccessToken => metricAccessFor({ user: user(UserRole.USER), grant: grant(area, level) })!;
const SA = metricAccessFor({ user: user(UserRole.SYSTEM_ADMIN), grant: null })!;
const PO = tokenFor("PLATFORM_OPS");
const CS = tokenFor("CUSTOMER_SUCCESS");
const MO = tokenFor("MERCHANT_OPS");
const byId = (id: string) => NAVIGATION_TARGETS.find((t) => t.id === id);
const ids = (ts: readonly NavigationTarget[]) => ts.map((t) => t.id);
const PAGE_IDS = ["platform:overview", "platform:ai"];

// ── file / import helpers ────────────────────────────────────────────────────
function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? path.join(path.dirname(from), spec) : null;
  if (base === null) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(path.join(ROOT, c)) && statSync(path.join(ROOT, c)).isFile()) return path.normalize(c);
  }
  return null;
}
function importsOf(file: string): string[] {
  return [...src(file).matchAll(/from\s+"([^"]+)"/g)].map((m) => resolveImport(file, m[1])).filter((x): x is string => x !== null);
}
/** file itself, or a module it imports within `depth` hops. */
function reaches(file: string, target: string, depth: number): boolean {
  if (path.normalize(file) === path.normalize(target)) return true;
  if (depth === 0) return false;
  return importsOf(file).some((f) => reaches(f, target, depth - 1));
}
/** identifier → file, from a module's named imports. */
function namedImports(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src(file).matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
    const f = resolveImport(file, m[2]);
    if (!f) continue;
    for (const name of m[1].split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!).filter(Boolean)) out.set(name, f);
  }
  return out;
}
/** `key: Component` entries of a `const NAME … = { … };` object literal. */
function objectEntries(file: string, name: string): Map<string, string> {
  const s = code(src(file));
  const start = s.indexOf(`const ${name}`);
  const open = s.indexOf("= {", start);
  const end = s.indexOf("\n};", open);
  const out = new Map<string, string>();
  for (const m of s.slice(open, end).matchAll(/^\s*"?([\w-]+)"?\s*:\s*(\w+),/gm)) out.set(m[1], m[2]);
  return out;
}

const DASH = "components/platform/PlatformSpaceDashboard.tsx";
const dashImports = namedImports(DASH);
const LEAD_FILE = new Map([...objectEntries(DASH, "PLATFORM_VIEW_LEADS")].map(([k, c]) => [k, dashImports.get(c) ?? ""]));
const WIDGET_FILE = new Map([...objectEntries(DASH, "PLATFORM_WIDGET_REGISTRY")].map(([k, c]) => [k, dashImports.get(c) ?? ""]));
const homeFile = (h: ComponentHome) => ("lead" in h ? LEAD_FILE.get(h.lead) : WIDGET_FILE.get(h.section)) ?? "";
const homeKey = (h: ComponentHome) => ("lead" in h ? `lead:${h.lead}` : `section:${h.section}`);
const homeId = (h: ComponentHome) => ("lead" in h ? `lead:${h.lead}${h.view ? `@${h.view}` : ""}` : `section:${h.section}`);

function main(): void {
// ── 1. derived, both directions ──────────────────────────────────────────────
console.log("\n1. derived — sources ⇄ targets, both directions");
{
  check("the dashboard maps were parsed (leads + widgets resolve to files)",
    LEAD_FILE.size >= 15 && WIDGET_FILE.size >= 30 && [...LEAD_FILE.values(), ...WIDGET_FILE.values()].every((f) => f && existsSync(path.join(ROOT, f))),
    `${LEAD_FILE.size}/${WIDGET_FILE.size} ` + [...LEAD_FILE, ...WIDGET_FILE].filter(([, f]) => !f).map(([k]) => k).join());

  const expected = new Set<string>(PAGE_IDS);
  for (const area of ALL_PLATFORM_AREAS) for (const c of PLATFORM_AREA_WORKSPACES[area]) {
    if (c.views && c.views.length > 0) for (const v of c.views) expected.add(`${area}:${c.workspaceId}:${v.id}`);
    else expected.add(`${area}:${c.workspaceId}`);
  }
  const actual = new Set(ids(NAVIGATION_TARGETS));
  const missing = [...expected].filter((x) => !actual.has(x));
  const extra = [...actual].filter((x) => !expected.has(x));
  check("every area × workspace × view in the sources has a target", missing.length === 0, missing.join(", "));
  check("every target has a source (no hand-written target)", extra.length === 0, extra.join(", "));
  check("target ids are unique", actual.size === NAVIGATION_TARGETS.length);

  const composed = new Set(ALL_PLATFORM_AREAS.flatMap((a) => PLATFORM_AREA_WORKSPACES[a].map((c) => c.workspaceId)));
  const orphan = Object.keys(PLATFORM_WORKSPACES).filter((id) => !composed.has(id));
  check("every Platform workspace identity is composed by some area (so it surfaces as a target)", orphan.length === 0, orphan.join());

  const badAlias = Object.entries(PLATFORM_WORKSPACE_ALIASES).filter(([, a]) =>
    !NAVIGATION_TARGETS.some((t) => t.workspaceId === a.workspaceId && (a.viewId ? t.viewId === a.viewId : t.isDefault)));
  check("every retired workspace alias lands on a target", badAlias.length === 0, badAlias.map(([k]) => k).join());

  const navIds = platformDestinations(null, null).map((d) => d.id);
  check("nav destinations: Overview + AI are targets; 'space' is the dynamic current area (covered by area targets)",
    navIds.join() === "overview,ai,space" && PAGE_IDS.every((id) => actual.has(id)));

  // Params: the Platform deep-link keys ⇄ the groups ⇄ the targets.
  const scoped = new Set<string>(PLATFORM_WORKSPACE_SCOPED_PARAMS);
  const grouped = NAVIGATION_PARAM_GROUPS.flatMap((g) => g.keys);
  const onTargets = new Set(NAVIGATION_TARGETS.flatMap((t) => t.params));
  check("each param is owned by exactly one group", new Set(grouped).size === grouped.length);
  check("group keys == space-url PLATFORM_WORKSPACE_SCOPED_PARAMS (both directions)",
    grouped.length === scoped.size && grouped.every((k) => scoped.has(k)), `${grouped.join()} vs ${[...scoped].join()}`);
  check("every grouped param is allowed on at least one target", grouped.every((k) => onTargets.has(k)), grouped.filter((k) => !onTargets.has(k)).join());
  // Every other Space-URL key is a personal-Space key, declared here with the reason (S2 binding 3).
  const PERSONAL_SPACE_ONLY = [
    "tab", "perspective", "metric", "asof", "compareto", "preset", "account", "transaction", "section",
    "fasof", "fcompareto", "fpreset", "fperiod",
  ];
  const known = new Set<string>([...TARGET_IDENTITY_PARAMS, ...scoped, ...PERSONAL_SPACE_ONLY]);
  const unclaimed = SPACE_URL_PARAMS.filter((k) => !known.has(k));
  check("every space-url param is a target identity key, a Platform deep-link param, or declared personal-Space-only",
    unclaimed.length === 0, unclaimed.join());
  check("…and no declared key is stale", PERSONAL_SPACE_ONLY.every((k) => (SPACE_URL_PARAMS as readonly string[]).includes(k)));

  for (const g of NAVIGATION_PARAM_GROUPS) {
    const mod = code(src(g.module));
    check(`${g.id}: the owner module exists and declares the keys`, g.keys.every((k) => mod.includes(`"${k}"`)));
  }
  // Each group's homes are EXACTLY the components that read it (a new reader without a home fails).
  const READERS: Record<string, RegExp> = {
    incidents: /\breadIncidentsUrl\(/,
    "ai-budget-calls": /\breadAiBudgetCallsUrl\(/,
    "economics-drill": /\b(readEconomicsDrillUrl|useEconomicsDrill)\(/,
    "merchant-records": /\breadMerchantRecordsUrl\(/,
    "cs-attention": /\b(readAttentionParam|attentionFromSearch)\(/,
  };
  check("every param group has a reader pattern", NAVIGATION_PARAM_GROUPS.every((g) => READERS[g.id]));
  for (const g of NAVIGATION_PARAM_GROUPS) {
    const users = [
      ...[...LEAD_FILE].filter(([, f]) => READERS[g.id].test(src(f))).map(([k]) => `lead:${k}`),
      ...[...WIDGET_FILE].filter(([, f]) => READERS[g.id].test(src(f))).map(([k]) => `section:${k}`),
    ].sort();
    const homes = g.homes.map(homeKey).sort();
    check(`${g.id}: homes == the leads / widgets that read it`, users.join() === homes.join(), `readers ${users.join()} vs homes ${homes.join()}`);
  }
}

// ── 2. labels ────────────────────────────────────────────────────────────────
console.log("\n2. labels — the UI's own");
{
  const pages = platformDestinations(null, null);
  check("page labels == platformDestinations",
    byId("platform:overview")?.label === pages[0].label && byId("platform:ai")?.label === pages[1].label);
  const bad: string[] = [];
  for (const area of ALL_PLATFORM_AREAS) {
    const rail = platformMountContext({ spaceId: "s", spaceName: "n", area, areaLabel: PLATFORM_AREAS[area].label, accessLevel: "READ", userId: "u" }).workspaces.available;
    for (const c of PLATFORM_AREA_WORKSPACES[area]) {
      const railLabel = rail.find((w) => w.key === c.workspaceId)?.label;
      const identity = c.label ?? PLATFORM_WORKSPACES[c.workspaceId].label;
      for (const t of NAVIGATION_TARGETS.filter((x) => x.area === area && x.workspaceId === c.workspaceId)) {
        if (t.workspaceLabel !== railLabel || t.workspaceLabel !== identity) bad.push(`${t.id} workspace ${t.workspaceLabel} vs rail ${railLabel}`);
        const want = t.viewId ? c.views!.find((v) => v.id === t.viewId)!.label : identity;
        if (t.label !== want) bad.push(`${t.id} ${t.label} vs ${want}`);
      }
      if (t_areaLabelBad(area)) bad.push(`${area} area label`);
    }
  }
  check("every workspace label == the rail's (platformMountContext) and every view label == the view control's", bad.length === 0, bad.join("; "));
}
function t_areaLabelBad(area: PlatformArea) { return NAVIGATION_TARGETS.some((t) => t.area === area && t.areaLabel !== PLATFORM_AREAS[area].label); }

// ── 3. real routes ───────────────────────────────────────────────────────────
console.log("\n3. real routes — app/**/page.tsx");
{
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === "page.tsx" || e === "page.ts") pages.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, "app"));
  const routes = pages.map((f) => {
    const segs = path.dirname(f).split(path.sep).slice(1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return { file: f, segs };
  });
  const match = (pathname: string) => {
    const parts = pathname.split("/").slice(1);
    const hits = routes.filter((r) => r.segs.length === parts.length && r.segs.every((s, i) => /^\[[^.\]]+\]$/.test(s) || s === parts[i]));
    // Static beats dynamic, exactly as the App Router resolves siblings.
    hits.sort((a, b) => a.segs.filter((s) => s.startsWith("[")).length - b.segs.filter((s) => s.startsWith("[")).length);
    return hits[0]?.file ?? null;
  };
  check("the scan found the Platform pages", [AREA_PAGE, DIRECTORY_PAGE, AI_PAGE].every((p) => pages.includes(p)));
  const bad: string[] = [];
  for (const t of NAVIGATION_TARGETS) {
    const r = resolveNavigationTarget(t.area ?? "PLATFORM_OPS", tokenFor(t.area ?? "PLATFORM_OPS"), t.id, undefined, { now: NOW });
    if (!r) { bad.push(`${t.id}: did not resolve for its own area`); continue; }
    const u = new URL(r.href, ORIGIN);
    const file = match(u.pathname);
    if (file !== t.guard.page) bad.push(`${t.id}: ${u.pathname} → ${file} (guard names ${t.guard.page})`);
    if (t.area && !(Object.values(PlatformArea) as string[]).includes(u.pathname.split("/").pop()!)) bad.push(`${t.id}: [area] is not a PlatformArea`);
  }
  check("every target's href resolves to the page route its guard names", bad.length === 0, bad.join("; "));

  // The UI's own link builder, by IDENTITY (no equality test): one function, re-exported by the client hook.
  check("the client hook re-exports the SAME platformWorkspaceHref / default / params (identity)",
    hookModule.platformWorkspaceHref === hrefModule.platformWorkspaceHref
    && hookModule.PLATFORM_DEFAULT_WORKSPACE_ID === hrefModule.PLATFORM_DEFAULT_WORKSPACE_ID
    && hookModule.PLATFORM_WORKSPACE_SCOPED_PARAMS === PLATFORM_WORKSPACE_SCOPED_PARAMS);
  const hook = code(src("lib/space/use-platform-workspace-navigation.ts"));
  check("…and defines no link builder of its own (no template, no function body)",
    !/function platformWorkspaceHref|\/dashboard\/platform\//.test(hook) && /from "@\/lib\/platform\/workspace-href"/.test(hook));
  const workspaceHref = code(src("lib/platform/workspace-href.ts"));
  check("workspace-href.ts is server-safe (no \"use client\", no React, no hooks)",
    !/^\s*["']use client["']|from "react"|\buse[A-Z]\w*\(/m.test(workspaceHref) && /export function platformWorkspaceHref\(/.test(workspaceHref));
  check("the registry builds area hrefs with that same function (import, no local template)",
    /import \{[^}]*\bplatformWorkspaceHref\b[^}]*\} from "@\/lib\/platform\/workspace-href"/.test(src("lib/platform/intelligence/navigation/registry.ts"))
    && /platformWorkspaceHref\(t\.area, t\.workspaceId/.test(code(src("lib/platform/intelligence/navigation/registry.ts")))
    && !/`\/dashboard\/platform/.test(code(src("lib/platform/intelligence/navigation/registry.ts"))));
  check("page hrefs are the nav's own constants",
    byId("platform:overview")?.pathname === PLATFORM_DIRECTORY_HREF && byId("platform:ai")?.pathname === PLATFORM_AI_HREF);
  check("the default workspace is every area's first composition",
    DEFAULT_WORKSPACE_ID === hrefModule.PLATFORM_DEFAULT_WORKSPACE_ID
    && ALL_PLATFORM_AREAS.every((a) => PLATFORM_AREA_WORKSPACES[a][0].workspaceId === DEFAULT_WORKSPACE_ID));
}

// ── 4. guards = the page's own ──────────────────────────────────────────────
console.log("\n4. guards — the destination page's own gate");
{
  const area = code(src(AREA_PAGE));
  check(`[area] page guards with requirePlatformAccess(area, "${AREA_PAGE_LEVEL}") and nothing else`,
    new RegExp(`requirePlatformAccess\\(area, "${AREA_PAGE_LEVEL}"\\)`).test(area) && (area.match(/requirePlatform\w*Access\(/g) ?? []).length === 1);
  check("[area] page refuses break-glass (grant null ⇒ redirect)", /if \(!grant\) redirect\(/.test(area));
  for (const p of [DIRECTORY_PAGE, AI_PAGE]) {
    const s = code(src(p));
    check(`${p}: any ACTIVE grant (directory non-empty), no area guard`,
      /loadPlatformDirectory\(session\.user\.id\)/.test(s) && /spaces\.length === 0\) redirect\(/.test(s) && !/requirePlatform\w*Access\(/.test(s));
  }
  check("proxy.ts sends a SYSTEM_ADMIN off /dashboard (break-glass reaches no target)",
    /token\.role === "SYSTEM_ADMIN" && pathname\.startsWith\("\/dashboard"\)/.test(code(src("proxy.ts"))));
  check("every area target guards on its own area at the page level; pages on ANY_GRANT",
    NAVIGATION_TARGETS.every((t) => t.area
      ? t.guard.kind === "AREA" && t.guard.area === t.area && t.guard.level === AREA_PAGE_LEVEL && t.guard.page === AREA_PAGE
      : t.guard.kind === "ANY_GRANT"));
  check("only Customer Success targets carry the CUSTOMER_SUCCESS tier",
    NAVIGATION_TARGETS.every((t) => (t.tier === "CUSTOMER_SUCCESS") === (t.area === "CUSTOMER_SUCCESS")));
}

// ── 5. permission filtering ─────────────────────────────────────────────────
console.log("\n5. permission filtering — area × level × surface; break-glass; forged");
{
  const bad: string[] = [];
  for (const area of ALL_PLATFORM_AREAS) for (const level of ALL_ACCESS_LEVELS) {
    const tok = tokenFor(area, level);
    for (const surface of ALL_PLATFORM_AREAS) {
      const got = ids(listNavigationTargets(surface, tok));
      const want = NAVIGATION_TARGETS.filter((t) => t.area === null
        || (t.area === area && (t.tier === "OPS" || surface === "CUSTOMER_SUCCESS"))).map((t) => t.id);
      if (got.join() !== want.join()) bad.push(`${area}/${level} on ${surface}: ${got.length} vs ${want.length}`);
      for (const t of NAVIGATION_TARGETS) {
        const r = resolveNavigationTarget(surface, tok, t.id, undefined, { now: NOW });
        if ((r !== null) !== want.includes(t.id)) bad.push(`${area}/${level} on ${surface}: resolve ${t.id}`);
      }
    }
  }
  check("a grant lists and resolves exactly its own area's targets (+ the platform pages) at every level", bad.length === 0, bad.slice(0, 5).join("; "));
  check("CS token on the CS surface sees the CS targets",
    listNavigationTargets("CUSTOMER_SUCCESS", CS).some((t) => t.id === "CUSTOMER_SUCCESS:platform-overview:overview"));
  check("CS token on an Ops surface: CS-tier targets invisible (only the identity-free pages)",
    ids(listNavigationTargets("PLATFORM_OPS", CS)).join() === PAGE_IDS.join());
  check("filters: area / kind / metric",
    listNavigationTargets("MERCHANT_OPS", MO, { area: "MERCHANT_OPS" }).length === 1
    && listNavigationTargets("PLATFORM_OPS", PO, { kind: "platform-page" }).length === 2
    && ids(listNavigationTargets("PLATFORM_OPS", PO, { metric: "ai-fleet-spend-status" })).join() === "PLATFORM_OPS:platform-economics:ai"
    && ids(listNavigationTargets("PLATFORM_OPS", PO, { metric: "ai-fleet-spend-status@1" })).join() === "PLATFORM_OPS:platform-economics:ai");

  // Break-glass: holds every area, but every destination refuses it.
  check("break-glass lists nothing on any surface", ALL_PLATFORM_AREAS.every((s) => listNavigationTargets(s, SA).length === 0));
  check("break-glass resolves nothing on any surface",
    ALL_PLATFORM_AREAS.every((s) => NAVIGATION_TARGETS.every((t) => resolveNavigationTarget(s, SA, t.id) === null)));

  // Forged tokens.
  const forged = Object.freeze({ grants: [{ area: "PLATFORM_OPS", level: "CONTROL" }] }) as unknown as MetricAccessToken;
  const cast = { ...PO } as MetricAccessToken;
  for (const [name, f] of [["hand-built", forged], ["spread copy of a real token", cast], ["null", null], ["string", "PLATFORM_OPS"]] as const) {
    check(`forged (${name}) ⇒ nothing listed, nothing resolved`,
      listNavigationTargets("PLATFORM_OPS", f as never).length === 0 && resolveNavigationTarget("PLATFORM_OPS", f as never, "platform:overview") === null);
  }
  check("an unknown surface ⇒ nothing", listNavigationTargets("NOPE" as never, PO).length === 0 && resolveNavigationTarget("NOPE" as never, PO, "platform:overview") === null);

  // No oracle: invisible ≡ unknown.
  const invisible = resolveNavigationTarget("PLATFORM_OPS", PO, "CUSTOMER_SUCCESS:platform-overview:overview");
  const unknown = resolveNavigationTarget("PLATFORM_OPS", PO, "PLATFORM_OPS:platform-nope");
  check("invisible ≡ unknown (the same null)", invisible === null && unknown === null && Object.is(invisible, unknown));

  // Metric links are narrowed to what the token can describe.
  const cs = listNavigationTargets("CUSTOMER_SUCCESS", CS).find((t) => t.id === "CUSTOMER_SUCCESS:platform-overview:overview");
  check("listed metric links are visible metrics only", (cs?.metrics.length ?? 0) > 0
    && listNavigationTargets("CUSTOMER_SUCCESS", CS).every((t) => t.metrics.every((m) => METRICS.some((d) => metricKey(d) === m && d.permission.some((p) => p.area === "CUSTOMER_SUCCESS")))));
  check("listed targets are copies (mutating one does not touch the registry)", (() => {
    const t = listNavigationTargets("PLATFORM_OPS", PO)[2]; (t as { metrics: unknown }).metrics = ["x@1"];
    return byId(t.id)!.metrics[0] !== "x@1";
  })());
}

// ── 6. params ────────────────────────────────────────────────────────────────
console.log("\n6. params — owner parsers decide; injection; fuzzed same-origin");
{
  const r = (surface: PlatformArea, tok: MetricAccessToken, id: string, params?: unknown) =>
    resolveNavigationTarget(surface, tok, id, params as never, { now: NOW })?.href ?? null;
  const INC = "PLATFORM_OPS:platform-incidents:verify";
  const AI = "PLATFORM_OPS:platform-economics:ai";
  const ECON = "PLATFORM_OPS:platform-economics:overview";
  const MER = "MERCHANT_OPS:platform-overview:overview";
  const CSO = "CUSTOMER_SUCCESS:platform-overview:overview";
  const until = String(NOW.getTime() - 3_600_000);

  check("incidents: a valid filter set round-trips", r("PLATFORM_OPS", PO, INC, { isev: "error", ipage: "2", iid: "abc_123" })
    === "/dashboard/platform/PLATFORM_OPS?workspace=platform-incidents&view=verify&isev=error&ipage=2&iid=abc_123");
  check("ai budget calls: a valid drill round-trips", r("PLATFORM_OPS", PO, AI, { aicalls: "budget", aiuntil: until, aipage: "2" })
    === `/dashboard/platform/PLATFORM_OPS?workspace=platform-economics&view=ai&aicalls=budget&aiuntil=${until}&aipage=2`);
  check("economics drill: a valid figure round-trips", r("PLATFORM_OPS", PO, ECON, { econ: "ai_cost.30d" })
    === "/dashboard/platform/PLATFORM_OPS?workspace=platform-economics&econ=ai_cost.30d");
  check("merchant records: a valid table state round-trips", r("MERCHANT_OPS", MO, MER, { period: "90", records: "unlinked" })
    === "/dashboard/platform/MERCHANT_OPS?period=90&records=unlinked");
  check("CS attention: a valid filter round-trips", r("CUSTOMER_SUCCESS", CS, CSO, { attention: "any" })
    === "/dashboard/platform/CUSTOMER_SUCCESS?attention=any");
  check("param order is the allowlist's, not the caller's", r("PLATFORM_OPS", PO, INC, { iid: "abc", isev: "error" })
    === "/dashboard/platform/PLATFORM_OPS?workspace=platform-incidents&view=verify&isev=error&iid=abc");

  const NULLS: [string, string, unknown][] = [
    ["unknown key", INC, { nope: "1" }],
    ["a valid key plus an unknown one (never dropped)", INC, { isev: "error", nope: "1" }],
    ["?view= as a param (target identity)", INC, { view: "history" }],
    ["?view=../../x", INC, { view: "../../x" }],
    ["?workspace= as a param", INC, { workspace: "platform-audit" }],
    ["another group's key", INC, { aicalls: "budget" }],
    ["a param on a target with none", "PLATFORM_OPS:platform-policies:groups", { isev: "error" }],
    ["a param on a platform page", "platform:overview", { workspace: "x" }],
    ["unknown value (parser drops it)", INC, { isev: "catastrophic" }],
    ["non-canonical value (default page)", INC, { ipage: "1" }],
    ["non-canonical value (padded)", INC, { ipage: "02" }],
    ["merchant default period (parser writes none)", MER, { period: "30" }],
    ["merchant rid without records=merchants", MER, { rid: "c1234567890abcdefghijk" }],
    ["aicalls not 'budget'", AI, { aicalls: "open" }],
    ["aiuntil in the future (parser refuses)", AI, { aicalls: "budget", aiuntil: String(NOW.getTime() + 86_400_000) }],
    ["aiuntil without aicalls", AI, { aiuntil: until }],
    ["econ not drillable", ECON, { econ: "revenue.cycle" }],
    ["attention unknown", CSO, { attention: "nonsense" }],
    ["encoded slash", INC, { iid: "a%2F..%2Fb" }],
    ["encoded dot-dot", INC, { iid: "%2e%2e" }],
    ["double slash", INC, { iid: "//evil.example" }],
    ["backslash", INC, { iid: "a\\b" }],
    ["scheme", INC, { iid: "javascript:alert(1)" }],
    ["https scheme", MER, { records: "merchants", rq: "https:x" }],
    ["userinfo @", MER, { records: "merchants", rq: "a@b" }],
    ["control character", MER, { records: "merchants", rq: "a\nb" }],
    ["NUL", INC, { iid: "a\u0000" }],
    ["empty value", INC, { isev: "" }],
    ["overlong value", MER, { records: "merchants", rq: "a".repeat(201) }],
    ["non-string value", INC, { ipage: 2 }],
    ["array value", INC, { isev: ["error", "info"] }],
    ["params as an array", INC, ["isev"]],
    ["params as a string", INC, "isev=error"],
    ["params as a URLSearchParams", INC, new URLSearchParams("isev=error")],
    ["__proto__ key", INC, JSON.parse('{"__proto__": {"isev": "error"}}')],
  ];
  for (const [name, id, params] of NULLS) {
    const surface: PlatformArea = id.startsWith("MERCHANT") ? "MERCHANT_OPS" : id.startsWith("CUSTOMER") ? "CUSTOMER_SUCCESS" : "PLATFORM_OPS";
    const tok = surface === "MERCHANT_OPS" ? MO : surface === "CUSTOMER_SUCCESS" ? CS : PO;
    check(`null: ${name}`, r(surface, tok, id, params) === null);
  }
  check("null: a bad param on an INVISIBLE target is the same null as on a visible one",
    r("PLATFORM_OPS", PO, CSO, { attention: "any" }) === null && r("PLATFORM_OPS", PO, INC, { nope: "1" }) === null);
  check("null: a non-finite clock", resolveNavigationTarget("PLATFORM_OPS", PO, INC, {}, { now: new Date(NaN) }) === null);

  // Fuzz: every target × every allowed key × hostile values ⇒ null, or a same-origin path on the target's pathname.
  const HOSTILE = ["../../x", "..", "%2F", "%5c", "//h", "\\\\h", "http://h", "HTTPS:h", "mailto:a", "a@h", "?x=1", "#x", "&workspace=x", "x&view=y",
    "\u0000", "\r\nSet-Cookie: a", " ", "/", "./x", "error", "2", "budget", "any", "unlinked", "ai_cost.cycle", "c1234567890abcdefghijk", "‮", "é"];
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 400; i++) HOSTILE.push(Array.from({ length: 1 + Math.floor(rand() * 12) }, () => String.fromCharCode(32 + Math.floor(rand() * 95))).join(""));
  const leaks: string[] = [];
  let resolved = 0;
  for (const t of NAVIGATION_TARGETS) {
    const surface = t.area ?? "PLATFORM_OPS";
    const tok = tokenFor(t.area ?? "PLATFORM_OPS");
    for (const k of [...t.params, ...TARGET_IDENTITY_PARAMS, "next", "redirect"]) for (const v of HOSTILE) {
      const href = r(surface, tok, t.id, { [k]: v });
      if (href === null) continue;
      resolved++;
      const u = new URL(href, ORIGIN);
      if (!href.startsWith("/") || href.startsWith("//") || u.origin !== ORIGIN || u.pathname !== t.pathname || u.hash !== "")
        leaks.push(`${t.id} ${k}=${JSON.stringify(v)} → ${href}`);
      if (u.searchParams.get(k) !== v) leaks.push(`${t.id} ${k}: value changed in transit`);
    }
  }
  check(`fuzz: every href is a same-origin relative path on its fixed pathname (${resolved} accepted)`, leaks.length === 0 && resolved > 0, leaks.slice(0, 5).join("; "));
  check("no href anywhere carries a host or scheme",
    NAVIGATION_TARGETS.every((t) => { const h = r(t.area ?? "PLATFORM_OPS", tokenFor(t.area ?? "PLATFORM_OPS"), t.id); return h !== null && /^\/[^/\\]/.test(h) && new URL(h, ORIGIN).origin === ORIGIN; }));
}

// ── 7. metric links ──────────────────────────────────────────────────────────
console.log("\n7. metric links — ids exist, homes real, drills agree");
{
  const keys = new Set(METRICS.map(metricKey));
  check("every linked metric id exists in the metric registry", NAVIGATION_TARGETS.every((t) => t.metrics.every((m) => keys.has(m))));
  check("a target links only metrics served in its own area",
    NAVIGATION_TARGETS.every((t) => t.metrics.every((m) => METRICS.find((d) => metricKey(d) === m)!.permission.some((p) => p.area === t.area))));
  const tileFiles = new Set(METRICS.flatMap((m) => m.tiles.map((t) => t.component)));
  const unhomed = [...tileFiles].filter((f) => !(f in TILE_HOMES));
  check("every registry tile component is homed or says why not", unhomed.length === 0, unhomed.join());
  check("no stale tile home", Object.keys(TILE_HOMES).every((f) => tileFiles.has(f)));
  const badHome: string[] = [];
  for (const [file, homes] of Object.entries(TILE_HOMES)) {
    if (!Array.isArray(homes)) { if (!(homes as { none: string }).none.trim()) badHome.push(`${file}: empty reason`); continue; }
    for (const h of homes) {
      const hf = homeFile(h);
      if (!hf) badHome.push(`${file}: ${homeKey(h)} is not a lead / widget`);
      else if (!reaches(hf, file, 2)) badHome.push(`${file}: ${homeKey(h)} (${hf}) does not import it within two hops`);
      const composed = ALL_PLATFORM_AREAS.some((a) => PLATFORM_AREA_WORKSPACES[a].some((c) =>
        "lead" in h ? (c.views ?? []).some((v) => v.lead === h.lead && (h.view === undefined || v.id === h.view)) : c.sections.includes(h.section)));
      if (!composed) badHome.push(`${file}: ${homeId(h)} is composed nowhere`);
    }
  }
  check("every tile home is a real lead / widget that renders the tile, composed in some view", badHome.length === 0, badHome.join("; "));
  const linked = METRICS.filter((m) => NAVIGATION_TARGETS.some((t) => t.metrics.includes(metricKey(m))));
  check(`metric ↔ target coverage: ${linked.length}/${METRICS.length} metrics linked to a target`, linked.length >= 12, METRICS.filter((m) => !linked.includes(m)).map(metricKey).join());

  // One source of truth: a metric drill's page is this registry's href for that area.
  const drift: string[] = [];
  for (const m of METRICS) for (const link of drillLinks(m.drill)) {
    const page = link.page;
    const area = drillRouteArea(link.api);
    if (!area) { drift.push(`${metricKey(m)}: drill route has no area`); continue; }
    const hit = listNavigationTargets(area, tokenFor(area)).filter((t) => t.area === area)
      .map((t) => resolveNavigationTarget(area, tokenFor(area), t.id)?.href).filter((h) => h === page);
    if (hit.length === 0) drift.push(`${metricKey(m)}: ${page} is no ${area} target href`);
  }
  check("every metric drill page resolves through this registry to the SAME href, in the drill route's area", drift.length === 0, drift.join("; "));
  const ib = METRICS.find((m) => m.id === "incident-broken-now")!;
  const opsOpen = resolveNavigationTarget("PLATFORM_OPS", PO, "PLATFORM_OPS:platform-incidents:open")?.href;
  const csOpen = resolveNavigationTarget("CUSTOMER_SUCCESS", CS, "CUSTOMER_SUCCESS:platform-incidents:open")?.href;
  check("incident-broken-now: on PLATFORM_OPS the link and the drill are the Incidents › Broken now view, not the bare area",
    byId("PLATFORM_OPS:platform-incidents:open")!.metrics.includes("incident-broken-now@1")
    && !byId("PLATFORM_OPS:platform-overview:overview")!.metrics.includes("incident-broken-now@1")
    && "bySurface" in ib.drill && ib.drill.bySurface.PLATFORM_OPS?.page === opsOpen && opsOpen !== "/dashboard/platform/PLATFORM_OPS");
  check("incident-broken-now: on CUSTOMER_SUCCESS the drill is the CS incidents view (and only the open view links it)",
    "bySurface" in ib.drill && ib.drill.bySurface.CUSTOMER_SUCCESS?.page === csOpen
    && byId("CUSTOMER_SUCCESS:platform-incidents:open")!.metrics.includes("incident-broken-now@1")
    && !byId("CUSTOMER_SUCCESS:platform-incidents:verify")!.metrics.includes("incident-broken-now@1"));
}

// ── 8. static ────────────────────────────────────────────────────────────────
console.log("\n8. static — no mint, literal surfaces, bounded importers");
{
  const reg = code(src("lib/platform/intelligence/navigation/registry.ts"));
  const acc = code(src("lib/platform/intelligence/navigation/access.ts"));
  for (const [name, s] of [["registry.ts", reg], ["access.ts", acc]] as const) {
    check(`${name}: no issue( / mint( / metricAccessFor( / incidentAudienceFor( / ISSUED`,
      !/\bissue\(|\bmint\(|metricAccessFor\(|incidentAudienceFor\(|ISSUED|MINTED|WeakSet/.test(s));
    check(`${name}: no I/O, no writes, no storage`, !/@\/lib\/db|prisma\.|systemDb|fetch\(|localStorage|document\.|window\./.test(s));
  }
  const fromCore = (s: string) => [...s.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/lib\/platform\/intelligence\/metrics\/retrieve-core"/g)]
    .flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean)).sort().join();
  check("access.ts takes only the tiering helpers from retrieve-core", fromCore(acc) === "TIER_RANK,tokenTierOnSurface", fromCore(acc));
  check("registry.ts takes only SURFACE_TIER from retrieve-core", fromCore(reg) === "SURFACE_TIER", fromCore(reg));

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (e === "node_modules" || e.startsWith(".")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(path.relative(ROOT, p));
    }
  };
  for (const d of ["app", "lib", "components", "jobs", "scripts"]) if (existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));

  const CALL = /\b(listNavigationTargets|resolveNavigationTarget)\(\s*([^,)]*)/g;
  const nonLiteral = (s: string): string[] => [...code(s).matchAll(CALL)]
    .filter((mm) => !/function\s+$/.test(code(s).slice(Math.max(0, (mm.index ?? 0) - 9), mm.index)))
    .map((mm) => mm[2].trim()).filter((a) => !/^"[A-Z_]+"$/.test(a));
  check("scanner: a literal surface passes, a variable / request param is caught",
    nonLiteral(`resolveNavigationTarget("PLATFORM_OPS", t, id)`).length === 0
    && nonLiteral(`resolveNavigationTarget(area, t, id)`).length === 1 && nonLiteral(`listNavigationTargets(url.searchParams.get("s"), t)`).length === 1);
  const bad = files.flatMap((f) => {
    const s = readFileSync(path.join(ROOT, f), "utf8");
    return /listNavigationTargets\(|resolveNavigationTarget\(/.test(s) ? nonLiteral(s).map((a) => `${f}: ${a}`) : [];
  });
  check("every listNavigationTargets / resolveNavigationTarget call site passes a string-literal surface FIRST", bad.length === 0, bad.join("; "));

  const builders = files.filter((f) => /\bbuildNavigationHref\b/.test(readFileSync(path.join(ROOT, f), "utf8")));
  check("buildNavigationHref is used only by the registry and its accessor (no other URL composition path)",
    builders.sort().join() === "lib/platform/intelligence/navigation/access.ts,lib/platform/intelligence/navigation/registry.ts", builders.join());
  const importers = files.filter((f) => {
    const s = readFileSync(path.join(ROOT, f), "utf8");
    return /intelligence\/navigation\/(registry|access)["']/.test(s)
      || (path.dirname(f) === "lib/platform/intelligence/navigation" && /from "\.\/(registry|access)"/.test(s));
  });
  // Platform AI v0: the guarded ask route calls the ACCESSOR (it mints from its own requireFreshPlatformAccess
  // result); the AI core takes only TYPES from the registry. Nothing else may import it.
  const typeOnly = (f: string) => [...readFileSync(path.join(ROOT, f), "utf8").matchAll(/^import\s+(type\s+)?[^;]*?from\s+"@\/lib\/platform\/intelligence\/navigation\/(?:registry|access)";/gm)]
    .every((m) => !!m[1]);
  // PB-1 related navigation: the guarded Ops and CS incident detail routes resolve the drawer's "Go to" links
  // (lib/platform/incidents/related-navigation.ts takes only its resolver closure, never the registry).
  // B11: the Platform AI conversations' step-6 helper (not a route file; every conversation route
  // calls it) re-resolves stored links through the ACCESSOR with a token minted from its own guard.
  const GUARDED_ROUTES = ["app/api/platform/ai/ask/route.ts", "app/api/platform/platform-ops/incidents/[id]/route.ts", "app/api/platform/customer-success/incidents/[id]/route.ts",
    "app/api/platform/ai/conversations/area-access.ts"];
  const strayNav = importers.filter((f) => f !== "lib/platform/intelligence/navigation/access.ts"
    && !(GUARDED_ROUTES.includes(f) && /const \[(\w+), \w+\] = await require(?:Fresh)?PlatformAccess\(/.test(readFileSync(path.join(ROOT, f), "utf8")))
    && !(f.startsWith("lib/platform/intelligence/ai/") && typeOnly(f)));
  check("the navigation registry is imported only by its accessor, the guarded routes (Platform AI ask + the conversations' area guard, Ops + CS incident detail), and type-only by the AI core",
    strayNav.length === 0 && importers.includes("lib/platform/intelligence/navigation/access.ts"), strayNav.join() || importers.join());
  for (const f of GUARDED_ROUTES) {
    const s = readFileSync(path.join(ROOT, f), "utf8");
    check(`…${f} reaches it through the ACCESSOR only (never the registry, never buildNavigationHref) and mints from its own guard result`,
      !/intelligence\/navigation\/registry["']/.test(s) && /metricAccessFor\((\w+)\)/.test(s));
  }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log(`\nall checks passed (${NAVIGATION_TARGETS.length} targets)`);
}

main();
