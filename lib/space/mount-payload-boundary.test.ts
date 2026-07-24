/**
 * lib/space/mount-payload-boundary.test.ts  (PS-6D — hydration boundary doctrine)
 *
 * The mount layer earns its keep by staying SMALL. PS-6B hydrates exactly the
 * structural set the shell needs for its first render; PS-6D locks that boundary
 * so future work cannot quietly grow the mount payload into a business/operational
 * data channel (the failure mode that would re-create the very fan-out PS-6
 * removed, now on the SERVER, and would make the shell a second data authority).
 *
 * ── HYDRATION DOCTRINE ──────────────────────────────────────────────────────────
 * A field is ELIGIBLE for the initial mount payload only if ALL hold:
 *   1. it is required for the shell's FIRST render (identity / navigation / shell
 *      metadata / the section stack the shell paints immediately), AND
 *   2. it is STRUCTURAL and bounded (a small, identity-like set — not an unbounded
 *      or historical series), AND
 *   3. hydrating it removes a DUPLICATE eager authority the client would otherwise
 *      re-run (i.e. it pays for itself in removed duplicate work, not merely a
 *      request count).
 *
 * A field is REJECTED — it belongs to a WORKSPACE loader, never the mount — if it
 * is any of:
 *   • workspace analytics / perspectives (computed projections)
 *   • historical series (snapshots, valuation history, time-machine)
 *   • operational / platform metrics (job/provider/sync/growth/cost)
 *   • unbounded collections (transactions)
 *   • optional / below-the-fold panels
 *   • AI payloads
 * Reducing a request is NOT a justification. If a candidate is rejected here, it
 * stays a workspace responsibility (lazy, canonical loader).
 *
 * The allowlist below is the ENFORCED contract. Adding a field to the payload
 * requires adding it here WITH a justification against the three eligibility
 * criteria — a deliberate, reviewed act, not an accident.
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

console.log("PS-6D — mount hydration boundary");

const comp = stripComments(src("lib/space/mount-composition.ts"));
const hook = stripComments(src("lib/space/use-space-data.ts"));

// ── The ENFORCED allowlist ──────────────────────────────────────────────────────
// sections     — the shell's section stack (which widgets Overview paints): shell
//                metadata, required for first paint.
// accounts     — the account roster: STRUCTURAL, bounded, identity+current-balance
//                spine the shell/header needs; removed a duplicate eager authority.
// memberCount  — the shell header's "N members": shell metadata, first paint.
const ALLOWED_PAYLOAD_FIELDS = new Set(["sections", "accounts", "memberCount"]);

// ── 1. The payload interface contains EXACTLY the allowlisted fields ─────────────
console.log("\nPayload allowlist (adding a field forces a doctrine decision)");
const ifaceMatch = comp.match(/interface\s+FinancialInitialWorkspacePayload\s*\{([\s\S]*?)\}/);
check("FinancialInitialWorkspacePayload interface is present", Boolean(ifaceMatch));
const payloadFields = (ifaceMatch?.[1] ?? "")
  .split("\n")
  .map((l) => l.match(/^\s*([A-Za-z_]\w*)\s*\??\s*:/)?.[1])
  .filter((f): f is string => Boolean(f));
check("payload declares at least the three structural fields", payloadFields.length >= 3, payloadFields.join(","));
for (const f of payloadFields) {
  check(`payload field "${f}" is on the reviewed allowlist`, ALLOWED_PAYLOAD_FIELDS.has(f),
    `NEW mount field "${f}" — justify it against the hydration doctrine (top of this file) and add to ALLOWED_PAYLOAD_FIELDS, or move it to a workspace loader`);
}

// ── 2. No rejected (business / operational / analytical) shape in the payload ────
console.log("\nNo business / operational / analytical data in the mount payload");
const REJECTED = /snapshot|perspective|holding|transaction|valuation|timeMachine|time_machine|forecast|projection|growth|funnel|providerHealth|syncIssue|opsMetric|\bcost\b|aiUsage|analytic/i;
// scan only the payload interface + the composer, not the whole file (loaders may
// name a `transaction` groupBy internally — that's the floor query, not payload).
const composer = comp.match(/export async function composeFinancialInitialWorkspace[\s\S]*?\n\}/)?.[0] ?? "";
check("payload interface names no rejected (analytical/operational) field",
  !REJECTED.test(ifaceMatch?.[1] ?? ""));
check("composer assembles ONLY the three structural loaders (no snapshot/perspective/transaction load)",
  composer.includes("loadSpaceSections") && composer.includes("loadSpaceAccounts") && composer.includes("getSpaceMemberCount") &&
  !/getSnapshots|loadSnapshots|getPerspectives|loadPerspectives|queryTransactions|getTransactions/.test(composer));

// ── 3. The shared SpaceMountContext carries no business/operational data ─────────
console.log("\nShared SpaceMountContext stays identity/navigation/shell only");
const contract = stripComments(src("lib/space/mount-context.ts"));
// Allow the words to appear in prose is already stripped; scan the type surface.
check("SpaceMountContext interfaces carry no balance/currency-amount/metric/holdings/snapshot field",
  !/\b(balance|amount|holdings|snapshot|providerHealth|opsMetric|growthFunnel)\s*[?]?\s*:/i.test(contract));

// ── 4. Over-hydration guard on the CONSUMER — snapshots/transactions stay lazy ───
console.log("\nConsumer keeps heavy data lazy (not folded into the mount)");
check("hook keeps snapshots lazy (wantSnapshots gate intact)", hook.includes("if (!wantSnapshots) return"));
check("hook keeps transactions lazy (wantTransactions gate intact)", hook.includes("if (!wantTransactions) return"));
check("hook does NOT hydrate snapshots/transactions from `initial`",
  !/initial\?\.(snapshots|transactions)/.test(hook));

// ── 5. Platform stays payload-free (Part G) ─────────────────────────────────────
console.log("\nPlatform remains InitialWorkspacePayload-free");
const platPage = stripComments(src("app/(shell)/dashboard/platform/[area]/page.tsx"));
const platDash = stripComments(src("components/platform/PlatformSpaceDashboard.tsx"));
check("platform page composes no financial initial payload",
  !platPage.includes("composeFinancialInitialWorkspace") && !platPage.includes("initialWorkspace"));
check("platform dashboard consumes no initial payload (widgets self-fetch)",
  !platDash.includes("initialWorkspace") && !platDash.includes("mount-composition"));

// ── 6. Prefetch containment is intentional (Part C intentionality lock) ─────────
console.log("\nMount-time prefetch containment stays intentional");
const bottomNav = src("components/ui/BottomNav.tsx"); // keep comments — this is a documented decision
check("BottomNav contains the mount-time sibling prefetch (prefetch={false})",
  /prefetch=\{false\}/.test(bottomNav),
  "re-enabling viewport prefetch here restores the mobile mount-time full-context RSC fan-out (PS-6D)");

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll PS-6D mount-payload-boundary checks passed.");
