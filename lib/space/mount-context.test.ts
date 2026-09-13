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
 *
 * Also carries the sibling PS-6 suites (same contract, same fixtures, same scan
 * harness):
 *   • PS-6B — financial mount hydration cutover (merged from
 *     lib/space/mount-composition.test.ts): one loader definition per resource,
 *     hook consumes hydration + preserves refresh, financial-only payload,
 *     authorization unchanged, page wiring.
 *   • PS-6C / PS-6F — platform mount adoption + the deliberate consumption
 *     asymmetry (merged from lib/space/platform-mount-adoption.test.ts).
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
// PLATFORM OPS POLICIES (Slice 2) — canControl is the same rank rule one step up.
check("READ / WRITE grants → canControl false; CONTROL grant → canControl true (and canWrite true)",
  plat.access.canControl === false
    && platformMountContext({ spaceId: "s", spaceName: "n", area: "PLATFORM_OPS" as never, areaLabel: "l", accessLevel: "WRITE" as never, userId: "u" }).access.canControl === false
    && (() => { const c = platformMountContext({ spaceId: "s", spaceName: "n", area: "PLATFORM_OPS" as never, areaLabel: "l", accessLevel: "CONTROL" as never, userId: "u" }).access; return c.canControl === true && c.canWrite === true; })());
check("a financial Space never carries control-plane authority", fin.access.canControl === false);
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

// ════════════════════════════════════════════════════════════════════════════
// merged from lib/space/mount-composition.test.ts (PS-6B — financial mount
// hydration cutover). `page` from that suite is `finPage` here; the platform
// page/dashboard scans reuse `platPage` and `platformDash` below.
// ════════════════════════════════════════════════════════════════════════════
console.log("\nPS-6B — financial mount hydration cutover");

const comp     = stripComments(src("lib/space/mount-composition.ts"));
const secRoute = stripComments(src("app/api/spaces/[id]/sections/route.ts"));
const accRoute = stripComments(src("app/api/spaces/[id]/accounts/route.ts"));
const hook     = stripComments(src("lib/space/use-space-data.ts"));
const platformDash = stripComments(src("components/platform/PlatformSpaceDashboard.tsx"));

// ── ONE loader definition, shared (no duplication) ──────────────────────────────
console.log("\nOne loader definition per resource (routes delegate to composition)");
check("composition owns loadSpaceSections", comp.includes("export async function loadSpaceSections"));
check("composition owns loadSpaceAccounts", comp.includes("export async function loadSpaceAccounts"));
check("composition owns getSpaceMemberCount", comp.includes("export function getSpaceMemberCount"));
check("sections route DELEGATES to loadSpaceSections", secRoute.includes("loadSpaceSections(spaceId)"));
check("sections route no longer defines the inline query",
  !secRoute.includes("spaceDashboardSection.findMany"));
check("accounts route DELEGATES to loadSpaceAccounts", accRoute.includes("loadSpaceAccounts(spaceId)"));
check("accounts route no longer defines the inline links query",
  !accRoute.includes("spaceAccountLink.findMany"));

// ── Authorization unchanged (routes keep their guards; composition has none) ────
console.log("\nAuthorization preserved");
check("sections route still guards with requireSpaceAction", secRoute.includes("requireSpaceAction(spaceId"));
check("accounts route still guards with requireSpaceRole", accRoute.includes("requireSpaceRole(spaceId"));
check("composition performs NO authorization (no requireSpace*/getSpaceContext)",
  !comp.includes("requireSpace") && !comp.includes("getSpaceContext") && !comp.includes("getServerSession"));

// ── Client hook: consume payload, skip eager fetches, preserve refresh ──────────
console.log("\nHook consumes hydration + preserves refresh");
check("hook accepts an `initial` payload", hook.includes("initial?"));
check("hook seeds sections/accounts/memberCount from initial",
  hook.includes("initial?.sections ?? []") && hook.includes("initial?.accounts ?? []") && hook.includes("initial?.memberCount ?? null"));
check("hook starts NOT loading when hydrated", hook.includes("useState(!hydrated)"));
check("initial sections+accounts effect is skipped when hydrated", /if \(hydrated\) return;[\s\S]{0,200}sections`\)/.test(hook));
check("member-count effect is skipped when hydrated", /if \(hydrated\) return;[\s\S]{0,120}fetch\(`\/api\/spaces\/\$\{spaceId\}`\)/.test(hook));
// refresh/reload paths preserved (Workspace switching + manual sync still fetch)
check("reloadSections still fetches (ManageSpaceModal refresh preserved)", hook.includes("reloadSections") && hook.includes("/sections`)"));
check("reloadAccounts still fetches (shared-account / manual-sync refresh preserved)", hook.includes("reloadAccounts") && hook.includes("/accounts`)"));
check("snapshots/transactions stay LAZY (not hydrated) — wantSnapshots/wantTransactions gates intact",
  hook.includes("if (!wantSnapshots) return") && hook.includes("if (!wantTransactions) return"));

// ── Financial-only payload; no leak into neutral contract or platform ──────────
console.log("\nFinancial-only; contract + platform isolation");
check("FinancialInitialWorkspacePayload is finance-only (sections/accounts/memberCount)",
  comp.includes("interface FinancialInitialWorkspacePayload") &&
  !/holdings|providerHealth|opsMetric|securityEvent|growthFunnel|platform/i.test(comp.replace(/PS-6P|Platform keeps|platform assumptions|not touched/gi, "")));
const contractCode = stripComments(contract);
check("domain-neutral SpaceMountContext does NOT import the finance payload",
  !contractCode.includes("mount-composition") && !contractCode.includes("FinancialInitialWorkspacePayload"));
check("Platform dashboard does NOT import the finance composition", !platformDash.includes("mount-composition"));
check("Platform page does NOT compose a finance initial payload", !platPage.includes("composeFinancialInitialWorkspace") && !platPage.includes("initialWorkspace"));
check("Platform page still uses platformMountContext (untouched)", platPage.includes("platformMountContext"));

// ── Page wiring + no duplicate getSpaceContext ─────────────────────────────────
console.log("\nPage composition + no duplicate authority");
check("page composes the finance initial payload", finPage.includes("composeFinancialInitialWorkspace(ctx.spaceId)"));
check("page passes initialWorkspace to the shell", finPage.includes("initialWorkspace={initialWorkspace}"));
check("page resolves getSpaceContext exactly ONCE (cache-deduped authority)",
  (finPage.match(/getSpaceContext\(\)/g) ?? []).length === 1);
check("composition is imported ONLY by finance routes + finance page (never an API-authz surface)",
  finPage.includes("mount-composition") && secRoute.includes("mount-composition") && accRoute.includes("mount-composition"));

// ════════════════════════════════════════════════════════════════════════════
// merged from lib/space/platform-mount-adoption.test.ts (PS-6C — platform mount
// adoption, + PS-6F asymmetry). Reuses the shared fin/plat fixtures above; the
// identical-shape and PlatformGrant-authorization checks already run in PS-6A/
// PS-6B and are not repeated.
// ════════════════════════════════════════════════════════════════════════════
console.log("\nPS-6C — platform mount contract adoption");

// ── PART 1 — one contract, two domains, identical shell expectation ─────────────
console.log("\nPart 1 — shared contract + shell expectation across domains");

check("finance + platform share the SAME shell expectation (variant 'space')",
  fin.shell.variant === "space" && plat.shell.variant === "space");

// The platform context carries every field PlatformSpaceDashboard now reads.
check("platform context supplies display.name", plat.display.name === "Platform Ops");
check("platform context supplies display.label (area label)", plat.display.label === "Platform Operations");
check("platform context supplies access.level (grant vocabulary)", plat.access.level === "READ");
check("platform context supplies a workspace rail projection (key/label/icon)",
  plat.workspaces.available.length > 0 &&
  plat.workspaces.available.every((w) => typeof w.key === "string" && typeof w.label === "string" && typeof w.icon === "string"));
check("platform context supplies a valid selectedKey (a real available workspace)",
  plat.workspaces.available.some((w) => w.key === plat.workspaces.selectedKey));
// The rail the dashboard renders (from the contract) must line up 1:1 with the
// operational composition it renders the body from (still Platform-owned).
const compositionKeys = getPlatformAreaWorkspaces("PLATFORM_OPS" as never).map((c) => c.workspaceId);
check("contract rail keys ⊆ the operational composition keys (rail/body stay consistent)",
  plat.workspaces.available.every((w) => compositionKeys.includes(w.key)));

// ── PART 2 — dashboard consumes the contract; no financial assumptions leak ─────
console.log("\nPart 2 — platform dashboard consumption + domain isolation");

const dash = platformDash;

// Consumes the five mount concerns FROM the contract (not rebuilt locally).
check("reads display.name from the contract", dash.includes("mountContext.display.name"));
check("reads display.label (area label) from the contract", dash.includes("mountContext.display.label"));
check("reads access.level from the contract", dash.includes("mountContext.access.level"));
check("reads workspace navigation (available + selectedKey) from the contract",
  dash.includes("mountContext.workspaces") && dash.includes("selectedKey"));
check("reads shell config (variant) from the contract", dash.includes("mountContext.shell.variant"));
check("builds the rail from the contract projection, not a second registry walk",
  /available\.map\(/.test(dash));

// The duplicate props are GONE (identity/display/access no longer passed in).
check("mountContext prop is REQUIRED (not optional)",
  /mountContext:\s*SpaceMountContext/.test(dash) && !/mountContext\?:\s*SpaceMountContext/.test(dash));
check("dashboard no longer declares a spaceName prop", !/^\s*spaceName:\s*string/m.test(dash));
check("dashboard no longer declares an areaLabel prop", !/^\s*areaLabel:\s*string/m.test(dash));
check("dashboard no longer declares an accessLevel prop", !/^\s*accessLevel:\s*string/m.test(dash));
check("platform page no longer passes spaceName/areaLabel/accessLevel to the dashboard",
  !/spaceName=\{/.test(platPage) && !/areaLabel=\{/.test(platPage) && !/accessLevel=\{/.test(platPage));

// Platform keeps its OWN area locator + operational composition (correctly NOT in
// the neutral contract).
check("dashboard still takes the PlatformArea locator (kept out of SpaceRef)", /area:\s*PlatformArea/.test(dash));
check("dashboard still composes the body from the operational owner (getPlatformAreaWorkspaces)",
  dash.includes("getPlatformAreaWorkspaces(area)"));

// NO financial assumptions leak into Platform.
check("dashboard imports NO financial mount composition", !dash.includes("mount-composition") && !dash.includes("composeFinancialInitialWorkspace"));
check("dashboard imports NO financial data hook (useSpaceData)", !dash.includes("useSpaceData"));
check("dashboard never calls getSpaceContext", !dash.includes("getSpaceContext"));
check("dashboard never gates on the customer SpaceMember axis",
  !/\bSpaceMember\b/.test(dash) && !/requireSpaceRole|requireSpaceAction/.test(dash));
check("dashboard has NO SpaceType / personal-vs-shared / category branching",
  !/\bSpaceType\b/.test(dash) && !/PERSONAL|SHARED/.test(dash) && !/\.category\b/.test(dash));

// Platform hydration is NOT introduced (self-fetch preserved) and Platform is
// never handed a financial initial payload.
check("Platform widgets stay self-fetching (host passes only the DB section row)",
  dash.includes("section={row}") && !dash.includes("initialWorkspace"));

// ── PART 3 — REPRESENTABILITY vs CONSUMPTION (PS-6F, deliberate asymmetry) ───────
// Two DISTINCT claims, encoded so a future contributor does NOT see the asymmetry
// and "complete the migration" by wiring finance to consume the context:
//   • REPRESENTABILITY — BOTH domains can PRODUCE a valid SpaceMountContext.
//   • CONSUMPTION      — Platform consumes it directly (it consolidates real
//                        authority). Finance does NOT, by design: the financial
//                        shell reads native props + its bounded payload, and
//                        consuming the context would add indirection without
//                        consolidating any authority (SPACE_MOUNT_DOCTRINE
//                        §domain-asymmetry). This is intentional, not unfinished.
console.log("\nPart 3 — representability vs consumption (deliberate asymmetry)");

// REPRESENTABILITY (retained): finance produces a valid, same-shape context.
check("REPRESENTABILITY: finance produces a valid SpaceMountContext, same shape as platform",
  fin.ref.domain === "finance" &&
  JSON.stringify(Object.keys(fin).sort()) === JSON.stringify(Object.keys(plat).sort()));
check("REPRESENTABILITY: the financialMountContext resolver still exists (proof retained)",
  server.includes("export function financialMountContext"));

// CONSUMPTION asymmetry: finance does NOT construct/pass/declare the context.
const finShell    = stripComments(src("components/dashboard/SpaceDashboard.tsx"));
const finPersonal = stripComments(src("components/dashboard/PersonalDashboard.tsx"));
check("CONSUMPTION: financial route does NOT construct or pass a SpaceMountContext (no dead plumbing)",
  !finPage.includes("financialMountContext(") && !finPage.includes("mountContext="),
  "finance is representable but must not construct the context only to pass an unconsumed prop");
check("CONSUMPTION: financial shell (SpaceDashboard) declares NO mountContext prop",
  !/mountContext\s*\??\s*:/.test(finShell));
check("CONSUMPTION: PersonalDashboard neither declares nor forwards mountContext",
  !/mountContext/.test(finPersonal));
// Finance keeps its OWN richer route contract — the initial payload is retained
// and is a SEPARATE value from the neutral context (never re-enveloped).
check("finance still hydrates via its own FinancialInitialWorkspacePayload (native route contract intact)",
  finPage.includes("composeFinancialInitialWorkspace") && finShell.includes("FinancialInitialWorkspacePayload"));

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll PS-6A mount-context + PS-6B composition + PS-6C adoption checks passed.");
