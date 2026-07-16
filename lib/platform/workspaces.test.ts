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
  getPlatformAreaWorkspaces,
  getPlatformWorkspace,
  isPlatformWorkspaceId,
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
    check(`"${id}" declares no consumesShellTime (finance SD-0B time)`, d.consumesShellTime === undefined);
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
    // Every declared section appears in at least one workspace (nothing orphaned out).
    for (const k of declared) check(`${area} declared section "${k}" is placed in a workspace`, composed.has(k));
  }
}

// ── PLATFORM_OPS decomposition: Overview is a summary, detail lives elsewhere ─────

console.log("PLATFORM_OPS decomposition shape");
{
  const ops = getPlatformAreaWorkspaces("PLATFORM_OPS");
  const byId = new Map(ops.map((w) => [w.workspaceId, w] as const));

  check("decomposed into >1 workspace (not a single Overview grid)", ops.length > 1);
  check("first workspace is Overview", ops[0].workspaceId === "platform-overview");

  const overview = byId.get("platform-overview")!;
  check("Overview offers doorways (summary→detail navigation)", (overview.doorways?.length ?? 0) >= 1);
  check("Overview does NOT host Manual Operations (the WRITE surface left the landing grid)", !overview.sections.includes("ops_manual_operations"));
  check("Overview does NOT host the connection/API-usage detail", !overview.sections.includes("ops_connection_health") && !overview.sections.includes("ops_api_usage"));
  check("Overview surfaces top alerts", overview.sections.includes("ops_alerts"));

  // Detailed capabilities have dedicated homes.
  check("Manual Operations lives in the Operations workspace", byId.get("platform-operations")?.sections.includes("ops_manual_operations") === true);
  check("Rich Job Health lives in the Jobs workspace", byId.get("platform-jobs")?.sections.includes("ops_job_health") === true);
  check("Alerts detail lives in the Alerts workspace", byId.get("platform-alerts")?.sections.includes("ops_alerts") === true);
  check("Providers workspace groups provider + connection + freshness + api", (() => {
    const p = byId.get("platform-providers")?.sections ?? [];
    return ["ops_provider_health", "ops_connection_health", "ops_resource_freshness", "ops_api_usage"].every((k) => p.includes(k));
  })());

  // Every doorway target is a real sibling workspace in the same area.
  for (const d of overview.doorways ?? []) check(`Overview doorway "${d}" is a sibling workspace`, byId.has(d));
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

if (failures > 0) {
  console.error(`\nworkspaces.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nworkspaces.test: all passed.");
