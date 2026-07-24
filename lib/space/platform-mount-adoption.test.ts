/**
 * lib/space/platform-mount-adoption.test.ts  (PS-6C — platform mount adoption)
 *
 * PS-6A built the domain-neutral SpaceMountContext; PS-6B proved Financial
 * CONSUMES it while hydrating. PS-6C proves the abstraction works ACROSS domains:
 * Platform consumes the EXACT same contract for identity / display / navigation /
 * access / shell config, while keeping its independent data-loading (self-fetch),
 * authorization (PlatformGrant), and operational ownership — with NO financial
 * assumptions leaking in.
 *
 * PART 1 (executing) — both resolvers produce the SAME contract shape AND the same
 *   shell expectation; the platform context carries every field the dashboard now
 *   reads.
 * PART 2 (source scans) — the dashboard READS the five mount concerns from the
 *   contract (not a local rebuild), no longer takes the duplicate props, and pulls
 *   in NO financial loader / hydration / customer-authz axis. Platform widgets stay
 *   self-fetching and Platform is never handed a financial initial payload.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { SpaceContext } from "@/lib/space";
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

console.log("PS-6C — platform mount contract adoption");

// ── PART 1 — one contract, two domains, identical shell expectation ─────────────
console.log("\nPart 1 — shared contract + shell expectation across domains");

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
const fin  = financialMountContext(financialCtx, { asOf: "2026-07-24" });
const plat = platformMountContext({
  spaceId: "space-plat-ops", spaceName: "Platform Ops", area: "PLATFORM_OPS" as never,
  areaLabel: "Platform Operations", accessLevel: "READ" as never, userId: "user-1",
});

check("finance + platform expose the IDENTICAL mount contract shape (top-level keys)",
  JSON.stringify(Object.keys(fin).sort()) === JSON.stringify(Object.keys(plat).sort()));
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

const dash     = stripComments(src("components/platform/PlatformSpaceDashboard.tsx"));
const platPage = stripComments(src("app/(shell)/dashboard/platform/[area]/page.tsx"));

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
check("platform page composes NO financial initial payload",
  !platPage.includes("composeFinancialInitialWorkspace") && !platPage.includes("initialWorkspace"));
check("platform page still authorizes via PlatformGrant (unchanged auth strategy)",
  platPage.includes("platformGrant.findUnique") && platPage.includes("hasPlatformAccess"));

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll PS-6C platform-mount-adoption checks passed.");
