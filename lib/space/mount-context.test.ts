/**
 * lib/space/mount-context.test.ts  (PS-6A)
 *
 * PART 1 (executing) — the pure domain resolvers produce a valid domain-neutral
 *   contract for BOTH families from their respective authorized inputs, sourcing
 *   Workspaces from the ONE registry and deriving canonical time as a capability.
 *
 * PART 2 (source scans) — the AUTHORITY invariants: each route preserves its own
 *   resolution + authorization chain, the two domains never cross-wire, the mount
 *   capability is never used to authorize, and no platform mount mutates the
 *   financial active-Space cookie.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SpaceContext } from "@/lib/space";
import {
  getWorkspaceDefinition,
  workspaceConsumesShellTime,
  getPerspectivesForCategory,
} from "@/lib/perspectives";
import { getPlatformAreaWorkspaces } from "@/lib/platform/workspaces";
import { financialMountContext, platformMountContext } from "@/lib/space/mount-context.server";

const ROOT = path.resolve(__dirname, "..", "..");
let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function src(rel: string): string { return readFileSync(path.join(ROOT, rel), "utf8"); }
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

console.log("PS-6A — domain-neutral SpaceMountContext");

// ── Fixtures (already-AUTHORIZED inputs; the resolvers only normalize) ──────────

const financialCtx: SpaceContext = {
  userId:  "user-1",
  spaceId: "space-fin-1",
  role:    "OWNER",
  permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
  space: {
    id: "space-fin-1", name: "Chris' Space", type: "PERSONAL",
    category: "PERSONAL", isPublic: false, reportingCurrency: "USD",
  },
};

// ── PART 1a — financial ─────────────────────────────────────────────────────────
console.log("\nPart 1a — financial resolution");

const fin = financialMountContext(financialCtx, { asOf: "2026-07-24" });
check("ref.id is the REAL canonical Space.id (not a category/area key)", fin.ref.id === "space-fin-1");
check("ref.domain = finance", fin.ref.domain === "finance");
check("ref.kind derived from SpaceType (PERSONAL→personal)", fin.ref.kind === "personal");
check("SHARED SpaceType → kind 'shared'",
  financialMountContext({ ...financialCtx, space: { ...financialCtx.space, type: "SHARED" } }, {}).ref.kind === "shared");
check("principal carries userId only", fin.principal.userId === "user-1" && Object.keys(fin.principal).length === 1);
check("access is DESCRIPTIVE (canRead/canWrite/level from permissions+role)",
  fin.access.canRead === true && fin.access.canWrite === true && fin.access.level === "OWNER");
check("shell.variant = space", fin.shell.variant === "space");
check("display.name only (no balances/currency/counts)",
  fin.display.name === "Chris' Space" && !("balance" in fin.display) && !("currency" in fin.display));
// Workspaces come from the shared registry, filtered to the Space's category.
const expectFin = getPerspectivesForCategory("PERSONAL").map((p) => p.id);
check("workspaces.available sourced from shared registry (category perspectives)",
  fin.workspaces.available.length === expectFin.length &&
  fin.workspaces.available.every((w) => expectFin.includes(w.key)));
check("financial default selectedKey = overview", fin.workspaces.selectedKey === "overview");
check("requested selectedKey honored when valid",
  financialMountContext(financialCtx, { selectedKey: "wealth" }).workspaces.selectedKey === "wealth");
check("invalid requested selectedKey falls back to overview",
  financialMountContext(financialCtx, { selectedKey: "not-a-workspace" }).workspaces.selectedKey === "overview");

// ── PART 1b — platform ──────────────────────────────────────────────────────────
console.log("\nPart 1b — platform resolution (same contract shape)");

const plat = platformMountContext({
  spaceId: "space-plat-ops", spaceName: "Platform Ops", area: "PLATFORM_OPS" as never,
  areaLabel: "Platform Operations", accessLevel: "READ" as never, userId: "user-1",
});
check("ref.id is the REAL platform Space.id (NOT the area key)", plat.ref.id === "space-plat-ops");
check("ref.domain = platform", plat.ref.domain === "platform");
check("ref.kind = utility", plat.ref.kind === "utility");
// PS-6C correction — platform renders the "space" VARIANT (it delegates identity
// to the ContextualNavbar exactly like finance; "utility" is for lone GLOBAL-nav
// destinations). ref.kind stays "utility" (Space NATURE) — a separate axis.
check("shell.variant = space (frame axis ≠ kind; platform delegates identity like finance)", plat.shell.variant === "space");
// PS-6E invariant guard (SPACE_MOUNT_DOCTRINE §3) — kind (ontology) and variant
// (presentation) are INDEPENDENT axes; one must never be derived from the other.
// Platform is the living proof: a utility-KIND Space renders the space-VARIANT.
// Deriving variant from kind was the PS-6C defect (it suppressed the rail).
// Compare as widened strings — the literal-narrowed `!==` is provably-true to the
// compiler (TS2367); widening keeps the runtime independence assertion honest.
check("SpaceRef.kind and shell.variant do NOT co-vary (utility kind → space variant)",
  plat.ref.kind === "utility" && plat.shell.variant === "space" &&
  (plat.ref.kind as string) !== (plat.shell.variant as string));
check("READ grant → canRead true, canWrite false, level 'READ'",
  plat.access.canRead === true && plat.access.canWrite === false && plat.access.level === "READ");
check("WRITE grant → canWrite true",
  platformMountContext({ spaceId: "s", spaceName: "n", area: "PLATFORM_OPS" as never, areaLabel: "l", accessLevel: "WRITE" as never, userId: "u" }).access.canWrite === true);
const expectPlat = getPlatformAreaWorkspaces("PLATFORM_OPS" as never).map((c) => c.workspaceId);
check("platform workspaces from shared registry (area composition)",
  plat.workspaces.available.length > 0 &&
  plat.workspaces.available.every((w) => expectPlat.includes(w.key)));
check("platform default selectedKey = platform-overview", plat.workspaces.selectedKey === "platform-overview");
check("financial and platform yield the SAME contract shape (same top-level keys)",
  JSON.stringify(Object.keys(fin).sort()) === JSON.stringify(Object.keys(plat).sort()));

// ── PART 1c — canonical time as an OPTIONAL capability ──────────────────────────
console.log("\nPart 1c — canonical time capability");

// Find a finance workspace that genuinely consumes shell time (registry authority).
const timeCapableKey = getPerspectivesForCategory("PERSONAL")
  .map((p) => p.id)
  .find((id) => { const d = getWorkspaceDefinition(id); return d ? workspaceConsumesShellTime(d) : false; });
check("registry exposes at least one time-capable finance workspace (fixture sanity)", Boolean(timeCapableKey), String(timeCapableKey));
if (timeCapableKey) {
  const withTime = financialMountContext(financialCtx, { selectedKey: timeCapableKey, asOf: "2026-07-24", compareTo: "2026-07-01" });
  check("time-capable workspace + asOf ⇒ supported with values",
    withTime.time.supported === true && (withTime.time as { asOf: string }).asOf === "2026-07-24");
  const noAsOf = financialMountContext(financialCtx, { selectedKey: timeCapableKey });
  check("time-capable workspace but NO asOf ⇒ supported:false (never fabricated)", noAsOf.time.supported === false);
}
check("PLATFORM workspaces NEVER receive canonical time (supported:false)", plat.time.supported === false);

// ── PART 2 — authority invariants (source scans) ────────────────────────────────
console.log("\nPart 2 — authority invariants");

const finPage  = stripComments(src("app/(shell)/dashboard/page.tsx"));
const platPage = stripComments(src("app/(shell)/dashboard/platform/[area]/page.tsx"));
const server   = stripComments(src("lib/space/mount-context.server.ts"));

// Route identity + authorization preserved
check("financial route still resolves via getSpaceContext (cookie→preferred→personal→SpaceMember gate)",
  finPage.includes("getSpaceContext()"));
check("platform route still validates PlatformArea", platPage.includes("PlatformArea") && platPage.includes("redirect(\"/dashboard/spaces\")"));
check("platform route still authorizes via PlatformGrant + hasPlatformAccess",
  platPage.includes("platformGrant.findUnique") && platPage.includes("hasPlatformAccess"));
check("platform route loads canonical Space by platformArea (real Space row)",
  platPage.includes("platformArea: area"));

// Domains never cross-wire in the resolver module. Slice the financial function
// body from its declaration to the next `export` (the PlatformMountInputs
// boundary) and drop that boundary line, then assert it uses the finance registry
// accessor and never the platform one.
const rawServer = src("lib/space/mount-context.server.ts");
const finStart = rawServer.indexOf("export function financialMountContext");
const finEnd   = rawServer.indexOf("export interface PlatformMountInputs");
const finBody  = rawServer.slice(finStart, finEnd);
check("financial resolver uses the FINANCE registry accessor", finBody.includes("getPerspectivesForCategory"));
check("financial resolver body never calls the platform registry accessor",
  !finBody.includes("getPlatformAreaWorkspaces") && !/\binput\.area\b/.test(finBody));
check("platform resolver does NOT call getSpaceContext / read cookie / SpaceMember",
  !server.includes("getSpaceContext") && !server.includes("SpaceMember") && !server.includes("fintracker_space"));

// No platform mount mutates the financial active-Space cookie
check("platform page never sets the financial active-Space cookie",
  !platPage.includes("fintracker_space") && !platPage.includes("ACTIVE_SPACE_COOKIE"));

// Capability is DESCRIPTIVE — never authorization. mount-context.server is imported
// ONLY by the two page.tsx composition sites, never by an API route.
function importsMountServer(rel: string): boolean {
  try { return src(rel).includes("mount-context.server"); } catch { return false; }
}
const apiConsumers: string[] = [];
(function walk(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "route.ts" && readFileSync(p, "utf8").includes("mount-context.server")) apiConsumers.push(p.replace(`${ROOT}/`, ""));
  }
})(path.join(ROOT, "app/api"));
check("no API route imports the mount resolver (capability ≠ authorization)", apiConsumers.length === 0, apiConsumers.join(", "));
void importsMountServer;

// The client contract file is server-only-free (safe to serialize/hydrate)
const contract = src("lib/space/mount-context.ts");
check("contract module imports nothing server-only", !contract.includes('"server-only"') && !/from "@\/lib\/db"/.test(contract));
check("SpaceMountAccess documented as non-authorization (raw source)",
  rawServer.includes("NOT authorize server operations") || rawServer.includes("re-authorize through its own domain authority"));

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll PS-6A mount-context checks passed.");
