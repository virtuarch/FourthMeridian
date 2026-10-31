/**
 * lib/platform/workspaces.test.ts  (OPS-5 S6 + S8 foundation)
 *
 * Behavior/type guards for Platform Workspace decomposition. Standalone tsx
 * (house pattern): npx tsx lib/platform/workspaces.test.ts — exits 0/1.
 * Auto-discovered by scripts/run-tests.ts.
 *
 * Pins the wave's invariants: every Platform primary destination resolves to a
 * Workspace in the UNIVERSAL registry; ONE composition owner; Overview is a
 * summary (not a landfill); OPS-5 authorities are consumed, not recomputed; no
 * fake operational Perspective ships; no finance vocabulary pollutes a Platform
 * definition; navigation uses the shared SpaceShell.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PLATFORM_WORKSPACES,
  PLATFORM_AREA_WORKSPACES,
  PLATFORM_WORKSPACE_ALIASES,
  canonicalPlatformWorkspaceId,
  aliasedPlatformViewId,
  getPlatformWorkspaceComposition,
  parsePlatformDestination,
  platformAreaViewIds,
  platformViewTarget,
  resolvePlatformDestination,
  resolvePlatformViewId,
  resolveRequestedPlatformView,
  viewComposedKeys,
  viewSectionKey,
  PLATFORM_SECTION_REPRESENTATION,
  getPlatformAreaWorkspaces,
  getPlatformWorkspace,
  isPlatformWorkspaceId,
  reachableSectionKeys,
} from "@/lib/platform/workspaces";
import { WORKSPACE_REGISTRY, getWorkspaceDefinition, STANDARD_WORKSPACES } from "@/lib/perspectives";
import { PLATFORM_AREAS, ALL_PLATFORM_AREAS } from "@/lib/platform/policy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The absorption chain for a section key: itself, then whatever absorbs it, and
 *  so on. Terminates on a cycle (a cycle is simply a chain that stops). */
function absorptionChain(key: string): string[] {
  const chain = [key];
  const seen = new Set([key]);
  let cursor: string | undefined = PLATFORM_SECTION_REPRESENTATION[key];
  while (cursor && !seen.has(cursor)) {
    chain.push(cursor);
    seen.add(cursor);
    cursor = PLATFORM_SECTION_REPRESENTATION[cursor];
  }
  return chain;
}

/** Section keys of the platform-local widget registry, read from its ONE
 *  definition site by brace-matching the object literal. Anchored on the
 *  identifier rather than on any widget name, so renaming a widget (or
 *  reordering/reformatting the map) does not change what this sees. */
function widgetRegistryKeys(src: string): Set<string> {
  const anchor = src.indexOf("PLATFORM_WIDGET_REGISTRY");
  if (anchor < 0) return new Set();
  const open = src.indexOf("{", src.indexOf("=", anchor));
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { end = i; break; }
  }
  if (open < 0 || end < 0) return new Set();
  const keys = new Set<string>();
  for (const m of src.slice(open + 1, end).matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)) keys.add(m[1]);
  return keys;
}

// ── Identity in the UNIVERSAL registry (no parallel identity system) ─────────────

console.log("universal registry identity");
{
  for (const [id, def] of Object.entries(PLATFORM_WORKSPACES)) {
    check(`"${id}" is registered in the universal WORKSPACE_REGISTRY`, WORKSPACE_REGISTRY[id] === def);
    check(`"${id}" identity resolves via the universal getWorkspaceDefinition`, getWorkspaceDefinition(id) === def);
    check(`"${id}" is "platform-*"-namespaced (disjoint from finance ids)`, id.startsWith("platform-"));
    check(`"${id}" declares domain:"platform"`, def.domain === "platform");
  }
  // Finance identities are untouched by the merge.
  check("finance STANDARD_WORKSPACES still resolve in the universal registry", Object.keys(STANDARD_WORKSPACES).every((id) => WORKSPACE_REGISTRY[id] != null));
  check("no id collision between finance and platform (disjoint sets)", Object.keys(PLATFORM_WORKSPACES).every((id) => !(id in STANDARD_WORKSPACES)));
}

// ── No finance vocabulary pollutes a Platform definition ─────────────────────────

console.log("no finance-vocabulary pollution");
{
  for (const [id, def] of Object.entries(PLATFORM_WORKSPACES)) {
    const d = def as unknown as Record<string, unknown>;
    check(`"${id}" declares no finance dataNeeds`, d.dataNeeds === undefined);
    check(`"${id}" declares no finance envelope`, d.envelope === undefined);
    check(`"${id}" declares no finance routing`, d.routing === undefined);
    check(`"${id}" declares no temporalCapability (finance SD-0B time)`, d.temporalCapability === undefined);
  }
}

// ── Every Platform primary destination resolves to a Workspace ───────────────────

console.log("every destination resolves to a Workspace");
{
  for (const area of ALL_PLATFORM_AREAS) {
    const comp = getPlatformAreaWorkspaces(area);
    check(`area ${area} exposes ≥1 workspace`, comp.length >= 1);
    for (const w of comp) {
      check(`${area} → "${w.workspaceId}" resolves to a registered Workspace`, getPlatformWorkspace(w.workspaceId) != null && isPlatformWorkspaceId(w.workspaceId));
    }
  }
}

// ── ONE composition owner: composition ⊆ declared area sections ──────────────────

console.log("single composition owner integrity");
{
  for (const area of ALL_PLATFORM_AREAS) {
    const declared = new Set(PLATFORM_AREAS[area].sections.map((s) => s.key));
    const composed = new Set<string>();
    for (const w of getPlatformAreaWorkspaces(area)) for (const k of w.sections) composed.add(k);
    // Every composed section key is a real, declared section of the area (no orphans).
    for (const k of composed) check(`${area} composed section "${k}" is a declared area section`, declared.has(k));
  }
}

// ── REACHABILITY: no declared operational surface may go dark ────────────────────

/*
 * THE guard this file exists for (PM-1). A section that is declared in
 * PLATFORM_AREAS is seeded as an enabled SpaceDashboardSection row and therefore
 * reads, to an operator, as a surface the platform HAS. If no workspace composes
 * it and nothing absorbs it, that surface renders nowhere — silently. Every past
 * instance of this failure looked like a harmless composition edit.
 *
 * Reachable is deliberately the WEAKER, honest predicate: composed into some
 * workspace of its own area, OR transitively absorbed (PLATFORM_SECTION_
 * REPRESENTATION) by a section that is. Consolidating five cards into one
 * surface is legitimate and passes; deleting the last surface that answers a
 * question is not and fails — including when the deletion is of the ABSORBING
 * section, which is the subtler defect.
 */
console.log("section reachability (nothing declared renders nowhere)");
{
  const areaOf = new Map<string, string>();
  for (const area of ALL_PLATFORM_AREAS) {
    for (const s of PLATFORM_AREAS[area].sections) areaOf.set(s.key, area);
  }

  for (const area of ALL_PLATFORM_AREAS) {
    const reachable = reachableSectionKeys(area);
    for (const s of PLATFORM_AREAS[area].sections) {
      check(
        `${area} section "${s.key}" is reachable (composed, or absorbed by a composed section)`,
        reachable.has(s.key),
        `neither composed into a ${area} workspace nor absorbed by one — it would be seeded, enabled, and render nowhere`,
      );
    }
  }

  // Absorption integrity: an absorption edge only means something if both ends
  // are real sections of the SAME area (cross-area absorption would claim a
  // surface is visible behind a grant its operator may not hold).
  for (const [absorbed, absorbing] of Object.entries(PLATFORM_SECTION_REPRESENTATION)) {
    check(`absorbed "${absorbed}" is a declared section`, areaOf.has(absorbed));
    check(`absorbing "${absorbing}" is a declared section`, areaOf.has(absorbing));
    check(`"${absorbed}" → "${absorbing}" stays inside one area`, areaOf.get(absorbed) === areaOf.get(absorbing));
    check(`"${absorbed}" does not absorb itself`, absorbed !== absorbing);
    // A cycle terminates the walk, so it cannot loop — but it also grants no
    // reachability, which would be a confusing way to lose a surface. Ban it.
    const chain = absorptionChain(absorbed);
    const tail = chain[chain.length - 1];
    check(`"${absorbed}" absorption chain terminates (no cycle)`, PLATFORM_SECTION_REPRESENTATION[tail] === undefined);
  }
}

// ── Registry ↔ composition parity (three-place registration is complete) ─────────

/*
 * A section key must exist in all three places or it fails silently:
 *   policy.ts        — declared, so the seed materializes an enabled row;
 *   workspaces.ts    — composed, so some workspace renders it;
 *   the widget map   — resolved, so the row maps to a component.
 * PlatformWorkspaceBody SKIPS a row with no registry entry (no error, no log),
 * which is why parity is pinned rather than reviewed. Read from the ONE registry
 * definition site by brace-matching, so widget renames do not weaken it.
 */
console.log("registry ↔ composition parity");
{
  const registry = widgetRegistryKeys(strip("components/platform/PlatformSpaceDashboard.tsx"));
  check("the platform widget registry was located and parsed", registry.size >= 20, `parsed ${registry.size} keys`);

  const declared = new Set<string>();
  const composed = new Set<string>();
  for (const area of ALL_PLATFORM_AREAS) {
    for (const s of PLATFORM_AREAS[area].sections) declared.add(s.key);
    for (const w of getPlatformAreaWorkspaces(area)) for (const k of w.sections) composed.add(k);
  }

  for (const k of composed) {
    check(`composed section "${k}" resolves to a widget (else it renders nothing, silently)`, registry.has(k));
  }
  for (const k of registry) {
    check(`registered widget key "${k}" is a declared platform section`, declared.has(k),
      "a registry entry for an undeclared key can never receive a DB row");
  }
}

// ── PLATFORM_OPS decomposition: Overview is a summary, detail lives elsewhere ─────

console.log("PLATFORM_OPS decomposition shape");
{
  const ops = getPlatformAreaWorkspaces("PLATFORM_OPS");
  const byId = new Map(ops.map((w) => [w.workspaceId, w] as const));

  check("decomposed into >1 workspace (not a single Overview grid)", ops.length > 1);
  check("first workspace is Overview", ops[0].workspaceId === "platform-overview");

  // PLATFORM OPS PHASE 1 UX — re-ruled: "Overview" is now the DEFAULT VIEW of
  // the Operations workspace (platform-overview), whose `sections` is the union
  // of its Overview · Jobs · Pipeline views. The summary-surface invariants
  // below are about what the operator LANDS on, so they read that view; the
  // doorways stay on the workspace (rendered on its default view only).
  const operations = byId.get("platform-overview")!;
  // PLATFORM OPS 2.0 (R2) — re-ruled: a view now has INLINE sections (rendered
  // on the page) and HOSTED keys (reached only through its summary-first lead's
  // drawers). `viewKeys` is what renders inline; `composedKeys` adds the hosted
  // keys — what an operator can REACH from that view. The landing invariants
  // below are about what renders inline; the "question survives" checks read
  // what is reachable.
  const viewKeys = (ws: string, view: string): string[] =>
    byId.get(ws)?.views?.find((v) => v.id === view)?.sections.map(viewSectionKey) ?? [];
  const composedKeys = (ws: string, view: string): string[] => {
    const v = byId.get(ws)?.views?.find((x) => x.id === view);
    return v ? [...viewComposedKeys(v)] : [];
  };
  const overview = { sections: viewKeys("platform-overview", "overview"), reachable: composedKeys("platform-overview", "overview"), doorways: operations.doorways };
  check("Operations' default view is Overview", operations.views?.[0]?.id === "overview");
  // PLATFORM OPS VISUAL SPEC (2026-10-30) — re-ruled: the "Explore" doorway row is
  // gone. The dashboard's own cards open Jobs ("See all") and Pipeline, and the
  // other workspaces are the rail's tabs; the views are DRILL-DOWNS, never a second
  // tab row (spec §1: one navigation row).
  check("Operations reaches its views from its dashboard (drill-down, no doorway row, no second tab row)",
    operations.viewControl === "drilldown" && (overview.doorways?.length ?? 0) === 0);
  check("Overview leads with the summary-first Operations lead", operations.views?.[0]?.lead === "operations");
  // R2 — re-ruled: Manual operations is HOSTED by the Overview lead (a drawer
  // behind the deliberate "Run an operation…" entry), never rendered inline.
  // PLATFORM OPS VISUAL SPEC §3 — re-ruled: Manual operations is ABSORBED by the
  // unified Jobs section (each job's row / detail carries its Dry run / Run now),
  // which the Overview hosts as its Jobs card — never a standalone section.
  check("Manual Operations is absorbed by the unified Jobs section, which the Overview hosts (never inline)",
    PLATFORM_SECTION_REPRESENTATION.ops_manual_operations === "ops_job_health" && overview.reachable.includes("ops_job_health")
      && !overview.sections.includes("ops_job_health") && !overview.reachable.includes("ops_manual_operations"));
  check("Overview does NOT host the connection/API-usage detail", !overview.reachable.includes("ops_connection_health") && !overview.reachable.includes("ops_api_usage"));

  // PM-1 — Overview no longer carries an alerts CARD; the alerts question is
  // absorbed by the consolidated health surface. The check therefore asserts the
  // QUESTION survives on Overview (composed there, or absorbed by something
  // composed there) rather than pinning the key — a further consolidation is
  // allowed, dropping the question from the landing surface is not.
  const answeredOnOverview = (key: string): boolean =>
    absorptionChain(key).some((k) => overview.reachable.includes(k));
  check("Overview still answers the alerts question", answeredOnOverview("ops_alerts"));
  check("Overview still answers the platform-configuration questions (rate limits + environment)",
    answeredOnOverview("ops_rate_limits") && answeredOnOverview("ops_env_status"));

  // Overview is a SUMMARY, not the area's landfill: it must host strictly fewer
  // sections than PLATFORM_OPS declares. Proportional, so it survives growth.
  check("Overview stays a summary (hosts far fewer sections than the area declares)",
    overview.sections.length * 2 < PLATFORM_AREAS.PLATFORM_OPS.sections.length,
    `${overview.sections.length} of ${PLATFORM_AREAS.PLATFORM_OPS.sections.length}`);

  // Detailed capabilities have dedicated homes.
  // PLATFORM OPS PHASE 1 UX — re-ruled: Jobs and Pipeline are views of Operations.
  // R2 — re-ruled: Manual Operations moved from the Jobs view into the Overview
  // lead's deliberate drawer; it renders INLINE on no view (fleet commands are
  // never casual buttons on a page).
  // R2 review fix — Manual Operations is hosted by the Overview lead (the
  // deliberate "Run an operation…" entry) AND inline on the Jobs drill-down view,
  // which is where every "Run from Jobs" action lands. Never inline on the
  // default Overview screen.
  // PLATFORM OPS VISUAL SPEC §3 — re-ruled again: no view composes the standalone
  // Manual operations section; its question survives through ops_job_health.
  check("Manual Operations: composed by no view, still reachable (absorbed by the unified Jobs section)",
    (operations.views ?? []).every((v) => !viewComposedKeys(v).includes("ops_manual_operations"))
      && answeredOnOverview("ops_manual_operations"));
  check("Rich Job Health lives in the Jobs view", viewKeys("platform-overview", "jobs").includes("ops_job_health"));
  check("Alerts detail lives in the Policies workspace", byId.get("platform-policies")?.sections.includes("ops_alerts") === true);
  check("Providers workspace groups provider + freshness + api; connection health renders once, in Pipeline (P-10)", (() => {
    const p = byId.get("platform-providers")?.sections ?? [];
    return ["ops_provider_health", "ops_resource_freshness", "ops_api_usage"].every((k) => p.includes(k)) && !p.includes("ops_connection_health")
      && composedKeys("platform-overview", "pipeline").includes("ops_connection_health");
  })());

  // Every doorway target is a real sibling workspace in the same area.
  // PLATFORM OPS PHASE 1 UX — re-ruled: a doorway may name a VIEW of a sibling.
  for (const d of overview.doorways ?? []) {
    const dest = resolvePlatformDestination(d);
    check(`Overview doorway "${d}" is a sibling workspace (or one of its views)`,
      dest != null && byId.has(dest.workspaceId) && (dest.viewId === null || byId.get(dest.workspaceId)?.views?.some((v) => v.id === dest.viewId) === true));
  }
}

// ── No fake operational Perspective ships (S8 foundation, no substrate) ──────────

console.log("no fake Perspective (S8 foundation only)");
{
  // Wave A establishes the Perspective SEAM (the registry supports kind:"perspective"
  // + domain:"platform") but ships NO operational Perspective — S7 Operational History
  // does not exist, so there is no honest temporal substrate. Guard: every Platform
  // workspace is "standard", and nothing composes a perspective-kind platform workspace.
  for (const [id, def] of Object.entries(PLATFORM_WORKSPACES)) {
    check(`"${id}" is a standard Workspace (no fabricated Perspective)`, def.kind === "standard");
  }
  for (const area of ALL_PLATFORM_AREAS) {
    for (const w of getPlatformAreaWorkspaces(area)) {
      const def = getPlatformWorkspace(w.workspaceId);
      check(`${area} composes no perspective-kind platform workspace`, def?.kind !== "perspective");
    }
  }
}

// ── Reuse (not a parallel framework) + authority preservation — source scans ─────

console.log("architecture reuse + authority preservation");
{
  const dash = read("components/platform/PlatformSpaceDashboard.tsx");
  const ws = read("lib/platform/workspaces.ts");

  check("navigation uses the shared SpaceShell (not a parallel frame)", /@\/components\/space\/shell\/SpaceShell/.test(dash) && /railOptions/.test(dash));
  check("composition comes from the single owner (getPlatformAreaWorkspaces)", /getPlatformAreaWorkspaces/.test(dash));
  check("no parallel Platform workspace-definition type is introduced", !/interface\s+PlatformWorkspaceDefinition|type\s+PlatformWorkspaceDefinition/.test(ws));

  // OPS-5 authorities are CONSUMED via self-fetching widgets, never recomputed here:
  // the composition/render layer must not import any S1–S5 authority.
  const authorities = /checkResourceFreshness|checkScheduledJobHealth|getConnectionHealth|getProviderHealth|evaluatePlatformAlerts|classifyResourceFreshness|classifyJobHealth/;
  check("dashboard recomputes no OPS-5 authority (widgets self-fetch)", !authorities.test(dash));
  check("composition owner recomputes no OPS-5 authority", !authorities.test(ws));

  // Platform authz stays grant-based — the render layer imports no customer
  // space-authz module. The customer-axis TOKEN scan over lib/platform is owned by
  // lib/platform-surface.test.ts; asserting by import here avoids naming the
  // forbidden tokens (which that tripwire also scans THIS file for).
  const customerAuthz = /@\/lib\/spaces\/(policy|authorize|session)/;
  check("dashboard imports no customer space-authz module", !customerAuthz.test(dash));
  check("composition owner imports no customer space-authz module", !customerAuthz.test(ws));
}

// ── P-10 (owner-approved 2026-10-27) — 8 → 6 Operations workspaces, no capability removed ──
// PLATFORM OPS PHASE 1 UX — re-ruled from six to FOUR (owner brief): Jobs and
// Pipeline became views of Operations. The capability pins (BEFORE, no
// duplication, aliases) are kept and extended to the view-carrying aliases.
console.log("P-10 + Phase 1 UX · four Operations workspaces, every capability kept");
{
  const ops = PLATFORM_AREA_WORKSPACES.PLATFORM_OPS;
  check("exactly four, in the approved order",
    ops.map((w) => w.workspaceId).join(",") === "platform-overview,platform-providers,platform-ai,platform-policies",
    ops.map((w) => w.workspaceId).join(","));
  // Every section key the eight-workspace composition rendered (develop 78b7558).
  const BEFORE = [
    "ops_overview", "ops_platform_health", "ops_scheduler", "ops_job_health", "ops_manual_operations", "ops_policies", "ops_alerts",
    "ops_refresh_executions", "ops_refresh_summary", "ops_connection_health", "ops_refresh_coverage", "ops_provider_health",
    "ops_provider_operations", "ops_connection_diagnostics", "ops_provider_cleanup", "ops_api_usage", "ops_resource_freshness",
    "ops_email_delivery", "ops_history", "ops_convergence", "ops_timeline", "ops_ai_invocations", "ops_brief_ops", "ops_ai_trend",
    "ops_ai_budget", "ops_plaid_usage", "ops_cost",
  ];
  const composed = new Set(ops.flatMap((w) => w.sections));
  // PLATFORM OPS VISUAL SPEC §3 — a key ABSORBED by a composed section (declared in
  // PLATFORM_SECTION_REPRESENTATION) is not lost: ops_manual_operations → ops_job_health.
  const lost = BEFORE.filter((k) => !composed.has(k) && !absorptionChain(k).some((a) => composed.has(a)));
  check("no section that was composed before is lost (composed, or absorbed by a composed section)", lost.length === 0, lost.join(", "));
  const all = ops.flatMap((w) => w.sections);
  check("no section renders twice across Operations (one home per fact)", all.length === new Set(all).size,
    all.filter((k, i) => all.indexOf(k) !== i).join(", "));
  check("retired ids resolve to their new home",
    canonicalPlatformWorkspaceId("platform-trends") === "platform-overview" && canonicalPlatformWorkspaceId("platform-costs") === "platform-ai"
      && canonicalPlatformWorkspaceId("platform-jobs") === "platform-overview" && canonicalPlatformWorkspaceId("platform-refresh") === "platform-overview"
      && canonicalPlatformWorkspaceId("platform-providers") === "platform-providers" && canonicalPlatformWorkspaceId(null) === null);
  check("view-carrying aliases carry their view",
    aliasedPlatformViewId("platform-jobs") === "jobs" && aliasedPlatformViewId("platform-refresh") === "pipeline"
      // VISUAL SPEC §5 — AI & Costs is one dashboard (Costs is in its drawers), so the
      // retired economics id carries no view any more: it lands on that dashboard.
      && aliasedPlatformViewId("platform-costs") === null && aliasedPlatformViewId("platform-trends") === null && aliasedPlatformViewId("platform-ai") === null);
  check("every alias target is a live workspace, and every alias view a live view of it",
    Object.values(PLATFORM_WORKSPACE_ALIASES).every((a) => {
      const w = ops.find((x) => x.workspaceId === a.workspaceId);
      return w != null && (a.viewId === undefined || w.views?.some((v) => v.id === a.viewId) === true);
    }));
  check("no retired id is still a workspace identity", Object.keys(PLATFORM_WORKSPACE_ALIASES).every((id) => !getPlatformWorkspace(id)));
  check("the Overview's doorways all point at live workspaces (or their views)",
    (ops[0].doorways ?? []).every((id) => { const d = resolvePlatformDestination(id); return d != null && ops.some((w) => w.workspaceId === d.workspaceId); }));
}

// ── PLATFORM OPS PHASE 1 UX — named VIEWS beneath the four workspaces ──
console.log("Phase 1 UX · views");
{
  const ops = PLATFORM_AREA_WORKSPACES.PLATFORM_OPS;
  // R2 — the shape now spells each view's lead (`<lead>`) and hosted keys
  // (`{…}`) beside its inline sections. Operations › Overview and Providers are
  // summary-first leads; Pipeline keeps its paginated execution table inline.
  const shape = ops.map((w) => `${w.workspaceId}[${(w.views ?? []).map((v) => `${v.id}:${v.lead ? `<${v.lead}>` : ""}${v.sections.map((e) => typeof e === "string" ? e : `${e.key}/${e.variant}`).join("+")}${v.hosted ? `{${v.hosted.join("+")}}` : ""}`).join(" ")}]`).join(" | ");
  check("the approved composition, exactly (workspace → views → lead · inline sections · hosted keys, in order)", shape === [
    "platform-overview[overview:<operations>{ops_overview+ops_platform_health+ops_convergence+ops_timeline+ops_job_health} jobs:ops_job_health+ops_scheduler+ops_history pipeline:<pipeline>ops_refresh_executions{ops_refresh_summary+ops_connection_health+ops_refresh_coverage}]",
    "platform-providers[health:<providers>{ops_provider_health+ops_provider_operations+ops_resource_freshness+ops_connection_diagnostics+ops_provider_cleanup+ops_api_usage+ops_email_delivery}]",
    // VISUAL SPEC §5 — AI & Costs re-ruled from two inline views (AI · Costs) to ONE
    // lead view hosting the same six keys in drawers (no key added or lost).
    "platform-ai[ai:<ai-costs>{ops_ai_invocations+ops_ai_trend+ops_ai_budget+ops_brief_ops+ops_plaid_usage+ops_cost}]",
    // VISUAL SPEC §5 — Policies › Policy groups re-ruled from the inline catalogue
    // panel to ONE read-only entitlement lead hosting ops_policies (in its groups /
    // defaults / emergency variants) and ops_alerts in drawers; the other three
    // views stay as drill-downs so platform-policies:defaults / :alerts and
    // ?view=emergency open exactly what they always did.
    "platform-policies[groups:<policies>{ops_policies+ops_alerts} defaults:ops_policies/defaults alerts:ops_alerts emergency:ops_policies/emergency]",
  ].join(" | "), shape);
  check("labels: Operations · Providers · AI & Costs · Policies (Operations is PLATFORM_OPS-local; the shared identity stays Overview)",
    ops.map((w) => w.label ?? getPlatformWorkspace(w.workspaceId)?.label).join(" · ") === "Operations · Providers · AI & Costs · Policies"
      && getPlatformWorkspace("platform-overview")?.label === "Overview");
  check("view labels", ops.map((w) => (w.views ?? []).map((v) => v.label).join("/")).join(" · ")
    === "Overview/Jobs/Pipeline · Providers · AI & Costs · Policy groups/Platform defaults/Alerts/Emergency controls");

  for (const w of ops) {
    const views = w.views ?? [];
    // R2 — re-ruled from "≥2 views": Providers became ONE master–detail view
    // (its former Health / Connections / Usage views are hosted inside it). A
    // single view renders no switcher (PlatformSpaceDashboard: views.length > 1).
    check(`${w.workspaceId}: has ≥1 view`, views.length >= 1);
    const union: string[] = [];
    // R2 — the union counts each view's inline sections, then its hosted keys.
    for (const v of views) for (const k of viewComposedKeys(v)) if (!union.includes(k)) union.push(k);
    check(`${w.workspaceId}: sections is EXACTLY the ordered union of its views (inline + hosted)`, w.sections.join() === union.join(), `${w.sections.join()} vs ${union.join()}`);
    check(`${w.workspaceId}: view ids are unique`, new Set(views.map((v) => v.id)).size === views.length);
    check(`${w.workspaceId}: view ids are URL-safe and carry no destination separator`, views.every((v) => /^[a-z][a-z-]*$/.test(v.id)));
    // R2 — re-ruled from "no view is empty": a view renders SOMETHING — inline
    // sections or a lead (a lead-only view is the summary-first screen).
    check(`${w.workspaceId}: no view renders nothing (inline sections or a lead)`, views.every((v) => v.sections.length > 0 || v.lead !== undefined));
    check(`${w.workspaceId}: hosted keys are only declared beside a lead (something must open them)`, views.every((v) => (v.hosted?.length ?? 0) === 0 || v.lead !== undefined));
    check(`${w.workspaceId}: no key is both inline and hosted in one view`, views.every((v) => (v.hosted ?? []).every((k) => !v.sections.map(viewSectionKey).includes(k))));
  }

  // Every key the six-workspace composition rendered (develop 296516c) renders in SOME view.
  const SIX_WORKSPACE_KEYS = [
    "ops_overview", "ops_platform_health", "ops_convergence", "ops_timeline",
    "ops_scheduler", "ops_job_health", "ops_manual_operations", "ops_history",
    "ops_refresh_executions", "ops_refresh_summary", "ops_connection_health", "ops_refresh_coverage",
    "ops_provider_health", "ops_provider_operations", "ops_connection_diagnostics", "ops_provider_cleanup", "ops_api_usage", "ops_resource_freshness", "ops_email_delivery",
    "ops_ai_invocations", "ops_ai_trend", "ops_ai_budget", "ops_plaid_usage", "ops_cost", "ops_brief_ops",
    "ops_policies", "ops_alerts",
  ];
  // R2 — "reachable in some view" now means rendered inline OR hosted by the
  // view's lead (opened from its summary). Same list, same strictness.
  const inSomeView = new Set(ops.flatMap((w) => (w.views ?? []).flatMap((v) => [...viewComposedKeys(v)])));
  // PLATFORM OPS VISUAL SPEC §3 — …or absorbed by a key that is (ops_manual_operations → ops_job_health).
  const unreachable = SIX_WORKSPACE_KEYS.filter((k) => !absorptionChain(k).some((a) => inSomeView.has(a)));
  check("every previously composed PLATFORM_OPS key is reachable in some view (inline, hosted, or absorbed)", unreachable.length === 0, unreachable.join(", "));
  check("…and no view composes a key the six-workspace composition did not (no new section keys)", [...inSomeView].every((k) => SIX_WORKSPACE_KEYS.includes(k)));
  // Declared exceptions only: ops_policies (its variants) and ops_job_health — the
  // unified Jobs list, as the Overview's 5-row card (hosted) and the Jobs
  // drill-down's full list (PLATFORM OPS VISUAL SPEC §4 row D; it replaced the
  // former ops_manual_operations exception). Anything else twice fails.
  // VISUAL SPEC §5 — ops_alerts joins the declared exceptions: the Policies
  // dashboard's Alerts card opens it in a drawer (hosted) and the Alerts
  // drill-down renders it inline (deep link platform-policies:alerts) — the
  // same pattern as ops_job_health (Overview card + Jobs).
  check("a key renders in ONE view, except the declared ops_policies variants, ops_job_health (Overview card + Jobs) and ops_alerts (Policies drawer + Alerts)",
    (() => {
      const seen = new Map<string, number>();
      for (const w of ops) for (const v of w.views ?? []) for (const k of viewComposedKeys(v)) seen.set(k, (seen.get(k) ?? 0) + 1);
      return [...seen].every(([k, n]) => n === 1 || k === "ops_policies" || ((k === "ops_job_health" || k === "ops_alerts") && n === 2));
    })());
  // VISUAL SPEC §5 — the groups view no longer renders ops_policies inline: its
  // lead hosts it (the catalogue / defaults / emergency drawers pass the variant).
  // The two drill-downs keep their inline variant, never bare.
  check("ops_policies renders inline in defaults / emergency (each with its own variant, never bare) and is hosted by the groups lead",
    (() => {
      const views = getPlatformWorkspaceComposition("PLATFORM_OPS", "platform-policies")?.views ?? [];
      const inline = views.flatMap((v) => v.sections.filter((e) => viewSectionKey(e) === "ops_policies").map((e) => `${v.id}=${typeof e === "string" ? "bare" : e.variant}`)).join();
      const groups = views.find((v) => v.id === "groups");
      return inline === "defaults=defaults,emergency=emergency" && groups?.lead === "policies" && (groups.hosted ?? []).includes("ops_policies") && groups.sections.length === 0;
    })());
  check("Policies drills down (no second tab row); its default view stays groups",
    getPlatformWorkspaceComposition("PLATFORM_OPS", "platform-policies")?.viewControl === "drilldown"
      && getPlatformWorkspaceComposition("PLATFORM_OPS", "platform-policies")?.views?.[0].id === "groups");

  // PLATFORM SPACES 2.0 — every area's default workspace is now a dashboard view;
  // the secondary workspaces (Security audit / operator actions, CS incidents) keep no views.
  // COMMUNICATIONS CENTER — the one exception: Customer Success › Communications
  // is a lead-only, four-view workspace (pinned in its own block below).
  check("secondary workspaces outside PLATFORM_OPS keep no views (except CS › Communications)",
    ALL_PLATFORM_AREAS.filter((a) => a !== "PLATFORM_OPS").every((a) => getPlatformAreaWorkspaces(a).slice(1)
      .filter((w) => !(a === "CUSTOMER_SUCCESS" && w.workspaceId === "platform-communications"))
      .every((w) => w.views === undefined && w.label === undefined)));
  check("every non-Ops area's Overview is ONE dashboard view with a lead",
    ALL_PLATFORM_AREAS.filter((a) => a !== "PLATFORM_OPS").every((a) => { const w = getPlatformAreaWorkspaces(a)[0]; return w.views?.length === 1 && !!w.views[0].lead && w.views[0].sections.length === 0; }));
  {
    const mo = getPlatformWorkspaceComposition("MERCHANT_OPS", "platform-overview");
    check("Merchant Operations: lead 'merchant', merchant_review still composed (hosted)", mo?.views?.[0].lead === "merchant" && mo.sections.join() === "merchant_review");
  }
  // PLATFORM SPACES 2.0 — Growth is ONE dashboard view (lead "growth") hosting
  // all seven former sections, the beta signup list among them.
  {
    const g = getPlatformWorkspaceComposition("GROWTH_REVENUE", "platform-overview");
    const v = g?.views?.[0];
    check("Growth: one view 'overview' led by the growth dashboard, nothing stacked inline",
      g?.views?.length === 1 && v?.id === "overview" && v.lead === "growth" && v.sections.length === 0);
    check("Growth: every former section is hosted (the beta list included) and still composed",
      JSON.stringify([...(v?.hosted ?? [])].sort()) === JSON.stringify(["growth_activity", "growth_beta_requests", "growth_funnel", "growth_policy_groups", "growth_product_analytics", "growth_signups", "growth_users"])
        && JSON.stringify([...(g?.sections ?? [])].sort()) === JSON.stringify([...(v?.hosted ?? [])].sort()));
  }
  check("platformAreaViewIds: PLATFORM_OPS lists every workspace's views (first = default); other areas list none",
    JSON.stringify(platformAreaViewIds("PLATFORM_OPS")) === JSON.stringify({
      "platform-overview": ["overview", "jobs", "pipeline"],
      // R2 — Providers is one master–detail view; its id stays "health" so the
      // default URL and ?view=health deep links are unchanged.
      "platform-providers": ["health"],
      // VISUAL SPEC §5 — one dashboard view; its id stays "ai" (default URL unchanged).
      "platform-ai": ["ai"],
      "platform-policies": ["groups", "defaults", "alerts", "emergency"],
    }));

  // The view validator: unknown ⇒ default, never a ghost; no views ⇒ null.
  const ids = ["overview", "jobs", "pipeline"];
  check("resolvePlatformViewId: a valid request wins", resolvePlatformViewId(ids, "jobs") === "jobs");
  check("resolvePlatformViewId: an unknown view falls back to the default", resolvePlatformViewId(ids, "not-a-view") === "overview" && resolvePlatformViewId(ids, null) === "overview");
  check("resolvePlatformViewId: first VALID request wins (explicit before alias)", resolvePlatformViewId(ids, "nope", "pipeline") === "pipeline" && resolvePlatformViewId(ids, "jobs", "pipeline") === "jobs");
  check("resolvePlatformViewId: a workspace without views has no view", resolvePlatformViewId(undefined, "jobs") === null && resolvePlatformViewId([], "jobs") === null);
  check("resolveRequestedPlatformView: ?workspace=platform-jobs opens Jobs; ?view= beats it; an alias for another workspace is ignored",
    resolveRequestedPlatformView(ids, "platform-overview", "platform-jobs", null) === "jobs"
      && resolveRequestedPlatformView(ids, "platform-overview", "platform-jobs", "pipeline") === "pipeline"
      && resolveRequestedPlatformView(["ai", "costs"], "platform-ai", "platform-jobs", null) === "ai"
      && resolveRequestedPlatformView(ids, "platform-overview", null, "bogus") === "overview");

  // Destinations: one resolver for doorways, block links and read-model targets.
  check("platformViewTarget spells workspace:view", platformViewTarget("platform-overview", "jobs") === "platform-overview:jobs");
  check("parsePlatformDestination: workspace, view target, and aliases (explicit view beats the alias's)",
    JSON.stringify(parsePlatformDestination("platform-ai")) === JSON.stringify({ workspaceId: "platform-ai", viewId: null })
      && JSON.stringify(parsePlatformDestination("platform-policies:alerts")) === JSON.stringify({ workspaceId: "platform-policies", viewId: "alerts" })
      && JSON.stringify(parsePlatformDestination("platform-jobs")) === JSON.stringify({ workspaceId: "platform-overview", viewId: "jobs" })
      && JSON.stringify(parsePlatformDestination("platform-refresh")) === JSON.stringify({ workspaceId: "platform-overview", viewId: "pipeline" })
      && JSON.stringify(parsePlatformDestination("platform-costs")) === JSON.stringify({ workspaceId: "platform-ai", viewId: null }));
  const label = (id: string) => resolvePlatformDestination(id)?.label;
  check("resolvePlatformDestination labels a view by the view, a workspace by its (area-local) label",
    label("platform-jobs") === "Jobs" && label("platform-refresh") === "Pipeline" && label("platform-overview:jobs") === "Jobs"
      && label("platform-policies:alerts") === "Alerts" && label("platform-policies:defaults") === "Platform defaults"
      && label("platform-ai") === "AI & Costs" && label("platform-policies") === "Policies" && label("platform-overview") === "Operations"
      && resolvePlatformDestination("platform-overview", "SECURITY_OPS")?.label === "Overview");
  check("resolvePlatformDestination keeps the retired workspaces' icons for their views",
    resolvePlatformDestination("platform-jobs")?.icon === "Timer" && resolvePlatformDestination("platform-refresh")?.icon === "RefreshCw");
  check("resolvePlatformDestination fails safe on a ghost workspace or a ghost view",
    resolvePlatformDestination("platform-nope") === undefined && resolvePlatformDestination("platform-overview:nope") === undefined);

  // Every destination a Platform read model or block still carries resolves.
  const CARRIED = ["platform-jobs", "platform-refresh", "platform-providers", "platform-ai", "platform-policies:alerts", "platform-policies:defaults"];
  check("every destination the overview / attention / activity read models carry resolves", CARRIED.every((id) => resolvePlatformDestination(id) != null));
  const feedCore = read("lib/platform/activity/operator-feed-core.ts");
  check("the activity feed's literal Policies target is the spelled view target", /const POLICY_DEFAULTS_VIEW = "platform-policies:defaults";/.test(feedCore)
    && platformViewTarget("platform-policies", "defaults") === "platform-policies:defaults");
}

// ── Redesign §4.3 — Customer Success: Customers · Incidents ──
console.log("Customer Success · Customers + Incidents");
{
  const cs = getPlatformAreaWorkspaces("CUSTOMER_SUCCESS");
  check("three workspaces: Overview (customers), Incidents, then Communications",
    cs.map((w) => w.workspaceId).join(",") === "platform-overview,platform-incidents,platform-communications", cs.map((w) => w.workspaceId).join(","));
  check("customers on the first, sync incidents on the second; nothing else moved",
    cs[0].sections.join() === "cs_customers" && cs[1]?.sections.join() === "cs_sync_issues");
  check("PLATFORM SPACES 2.0 — Customers is one dashboard view (lead 'customer-success') hosting the audited list",
    cs[0].views?.length === 1 && cs[0].views[0].lead === "customer-success" && JSON.stringify(cs[0].views[0].hosted) === JSON.stringify(["cs_customers"]) && cs[0].views[0].sections.length === 0);
  check("Incidents is a registered Platform identity with a nav-resolvable icon",
    getPlatformWorkspace("platform-incidents")?.label === "Incidents"
      && /WORKSPACE_ICONS_BY_NAME[^{]*\{[^}]*\bTriangleAlert,/.test(readFileSync(path.join(process.cwd(), "components/ui/ContextualNavbar.tsx"), "utf8")));

  // COMMUNICATIONS CENTER (owner-approved 2026-10-31) — four lead-only views,
  // no section keys (so no DB rows and no seeding), Library first (default).
  const comms = getPlatformWorkspaceComposition("CUSTOMER_SUCCESS", "platform-communications");
  check("Communications: four views Library · Automations · Delivery & History · Preferences, in order",
    JSON.stringify(comms?.views?.map((v) => [v.id, v.label, v.lead])) === JSON.stringify([
      ["library", "Library", "comms-library"], ["automations", "Automations", "comms-automations"],
      ["delivery", "Delivery & History", "comms-delivery"], ["preferences", "Preferences", "comms-preferences"],
    ]));
  check("Communications composes NO section key (lead-only; nothing to seed) and hosts nothing",
    comms?.sections.length === 0 && (comms?.views ?? []).every((v) => v.sections.length === 0 && (v.hosted ?? []).length === 0));
  check("Communications uses the segmented view control (four peers, not a drill-down)", comms?.viewControl === undefined);
  check("Communications is a registered identity with a nav-resolvable icon",
    getPlatformWorkspace("platform-communications")?.label === "Communications" && getPlatformWorkspace("platform-communications")?.icon === "Mail"
      && /WORKSPACE_ICONS_BY_NAME[^{]*\{[^}]*\bMail,/.test(readFileSync(path.join(process.cwd(), "components/ui/ContextualNavbar.tsx"), "utf8")));
  check("platformAreaViewIds(CUSTOMER_SUCCESS) lists the Communications views (Library = default)",
    JSON.stringify(platformAreaViewIds("CUSTOMER_SUCCESS")["platform-communications"]) === JSON.stringify(["library", "automations", "delivery", "preferences"]));
  check("each Communications lead is registered on the dashboard",
    ["comms-library", "comms-automations", "comms-delivery", "comms-preferences"].every((id) =>
      new RegExp(`"${id}":\\s+Comms\\w+Lead,`).test(readFileSync(path.join(process.cwd(), "components/platform/PlatformSpaceDashboard.tsx"), "utf8"))));
}

// ── Redesign §4.9 — Security: Posture · Audit · Operator actions ──
console.log("Security · Posture + Audit + Operator actions");
{
  const sec = getPlatformAreaWorkspaces("SECURITY_OPS");
  check("three workspaces in order", sec.map((w) => w.workspaceId).join(",") === "platform-overview,platform-audit,platform-operator-actions", sec.map((w) => w.workspaceId).join(","));
  check("the two feeds are composed directly, no longer absorbed",
    sec[1]?.sections.join() === "sec_audit_feed" && sec[2]?.sections.join() === "sec_operator_actions"
      && !("sec_audit_feed" in PLATFORM_SECTION_REPRESENTATION) && !("sec_operator_actions" in PLATFORM_SECTION_REPRESENTATION));
  check("PLATFORM SPACES 2.0 — the Overview is one dashboard view (lead 'security') hosting the posture widget",
    sec[0]?.views?.length === 1 && sec[0].views[0].lead === "security" && sec[0].views[0].sections.length === 0
      && JSON.stringify(sec[0].views[0].hosted) === JSON.stringify(["sec_auth_posture"]) && sec[0].sections.join() === "sec_auth_posture");
  check("anomalies and sessions stay absorbed by the posture host",
    PLATFORM_SECTION_REPRESENTATION.sec_anomalies === "sec_auth_posture" && PLATFORM_SECTION_REPRESENTATION.sec_sessions === "sec_auth_posture");
  const nav = readFileSync(path.join(process.cwd(), "components/ui/ContextualNavbar.tsx"), "utf8");
  check("both identities are registered with nav-resolvable icons",
    getPlatformWorkspace("platform-audit")?.icon === "ScrollText" && getPlatformWorkspace("platform-operator-actions")?.icon === "UserCog"
      // The icon list's tail, pinned exactly: Security's two, then Communications' Mail, then the close.
      && /ScrollText, UserCog,\n  \/\/ Platform redesign — Customer Success › Communications\.\n  Mail,\n\};/.test(nav));
}

if (failures > 0) {
  console.error(`\nworkspaces.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nworkspaces.test: all passed.");
