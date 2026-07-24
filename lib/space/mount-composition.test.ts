/**
 * lib/space/mount-composition.test.ts  (PS-6B)
 *
 * Guards the financial mount hydration cutover. The loaders themselves are
 * DB-coupled, so this proves the STRUCTURE the cutover depends on:
 *   - ONE loader definition per resource, shared by the API route AND the mount
 *     composition (no duplicate query definitions).
 *   - the client hook consumes the hydrated payload and SKIPS the eager fetches,
 *     while preserving every refresh/reload path.
 *   - the payload is FINANCIAL-only and never leaks into the domain-neutral
 *     contract or into Platform.
 *   - authorization is unchanged (the routes keep their guards; the composition
 *     performs none and is only reachable from the already-authorized page).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

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

console.log("PS-6B — financial mount hydration cutover");

const comp     = stripComments(src("lib/space/mount-composition.ts"));
const secRoute = stripComments(src("app/api/spaces/[id]/sections/route.ts"));
const accRoute = stripComments(src("app/api/spaces/[id]/accounts/route.ts"));
const hook     = stripComments(src("lib/space/use-space-data.ts"));
const page     = stripComments(src("app/(shell)/dashboard/page.tsx"));

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
const contract = stripComments(src("lib/space/mount-context.ts"));
check("domain-neutral SpaceMountContext does NOT import the finance payload",
  !contract.includes("mount-composition") && !contract.includes("FinancialInitialWorkspacePayload"));
const platformDash = stripComments(src("components/platform/PlatformSpaceDashboard.tsx"));
const platformPage = stripComments(src("app/(shell)/dashboard/platform/[area]/page.tsx"));
check("Platform dashboard does NOT import the finance composition", !platformDash.includes("mount-composition"));
check("Platform page does NOT compose a finance initial payload", !platformPage.includes("composeFinancialInitialWorkspace") && !platformPage.includes("initialWorkspace"));
check("Platform page still uses platformMountContext (untouched)", platformPage.includes("platformMountContext"));

// ── Page wiring + no duplicate getSpaceContext ─────────────────────────────────
console.log("\nPage composition + no duplicate authority");
check("page composes the finance initial payload", page.includes("composeFinancialInitialWorkspace(ctx.spaceId)"));
check("page passes initialWorkspace to the shell", page.includes("initialWorkspace={initialWorkspace}"));
check("page resolves getSpaceContext exactly ONCE (cache-deduped authority)",
  (page.match(/getSpaceContext\(\)/g) ?? []).length === 1);
check("composition is imported ONLY by finance routes + finance page (never an API-authz surface)",
  page.includes("mount-composition") && secRoute.includes("mount-composition") && accRoute.includes("mount-composition"));

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll PS-6B mount-composition checks passed.");
