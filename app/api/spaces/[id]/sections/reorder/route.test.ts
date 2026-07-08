/**
 * app/api/spaces/[id]/sections/reorder/route.test.ts
 *
 * UX-CUST-1A — batch section reorder endpoint invariants.
 *
 * Runnable with the already-installed `tsx`:
 *     npx tsx app/api/spaces/[id]/sections/reorder/route.test.ts
 * Exits 0 when all pass, 1 on failure. Auto-discovered by scripts/run-tests.ts.
 *
 * WHY SOURCE-SCAN: importing the route pulls in `@/lib/db` (Prisma engine) and
 * next/server, which don't load under a bare tsx script — same constraint the
 * sibling lib/spaces/authorize.test.ts documents. So: assert the permission
 * *semantics* against the pure `can()` (imports cleanly), then source-scan the
 * route for the invariants that must not regress (gate, tab-scoping, order-only
 * writes, single transaction).
 */

import { readFileSync } from "fs";
import { join }         from "path";
import { can }          from "@/lib/spaces/policy";
import type { SpaceMemberRole, SpaceMemberStatus, SpaceType } from "@prisma/client";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

function read(...seg: string[]): string {
  return readFileSync(join(process.cwd(), ...seg), "utf8");
}
/** strip comments so scans match real code, not prose. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

const A = (role: SpaceMemberRole, status: SpaceMemberStatus, spaceType: SpaceType) =>
  ({ role, status, spaceType });

// ─────────────────────────────────────────────────────────────────────────────
// PART A — reorder is a `section:edit` action: OWNER/ADMIN allow, others deny.
// Reuses the exact policy the route delegates to via requireSpaceAction.
// ─────────────────────────────────────────────────────────────────────────────

check("A reorder gate: OWNER allowed",   can("section:edit", A("OWNER",  "ACTIVE", "SHARED")) === true);
check("A reorder gate: ADMIN allowed",   can("section:edit", A("ADMIN",  "ACTIVE", "SHARED")) === true);
check("A reorder gate: MEMBER denied",   can("section:edit", A("MEMBER", "ACTIVE", "SHARED")) === false);
check("A reorder gate: VIEWER denied",   can("section:edit", A("VIEWER", "ACTIVE", "SHARED")) === false);
check("A reorder gate: inactive ADMIN denied",
  can("section:edit", A("ADMIN", "REMOVED", "SHARED")) === false);

// ─────────────────────────────────────────────────────────────────────────────
// PART B — route source-scan invariants.
// ─────────────────────────────────────────────────────────────────────────────

const route = code(read("app", "api", "spaces", "[id]", "sections", "reorder", "route.ts"));

// Method + gate
check("B is a PATCH handler",
  /export\s+async\s+function\s+PATCH\s*\(/.test(route));
check("B gated by requireSpaceAction section:edit (VIEWER/MEMBER cannot reorder)",
  /requireSpaceAction\(\s*spaceId\s*,\s*["']section:edit["']\s*\)/.test(route));
check("B returns early on auth error",
  /if\s*\(\s*err\s*\)\s*return\s+err/.test(route));

// Input validation
check("B validates tab against a whitelist",
  /VALID_TABS/.test(route) && /400/.test(route));
check("B rejects duplicate section ids",
  /new\s+Set\(\s*sectionIds\s*\)\.size\s*!==\s*sectionIds\.length/.test(route));
check("B requires a non-empty string array of ids",
  /Array\.isArray\(\s*sectionIds\s*\)/.test(route) && /length\s*===\s*0/.test(route));

// Tab-scoping: the request must be exactly the tab's sections (no cross-tab,
// no foreign ids, none omitted). This is what prevents cross-tab moves.
check("B loads only this tab's sections (spaceId + tab)",
  /findMany\(\s*\{\s*where:\s*\{\s*spaceId\s*,\s*tab:/.test(route));
check("B enforces permutation of the tab (allInTab + same size)",
  /tabIds\.has\(\s*id\s*\)/.test(route) && /tabIds\.size\s*===\s*sectionIds\.length/.test(route));

// Persistence: dense order = index, single transaction, order-only writes.
check("B reassigns order = index",
  /data:\s*\{\s*order:\s*index\s*\}/.test(route));
check("B writes in one db.$transaction",
  /db\.\$transaction\(/.test(route));
check("B mutates ONLY order (never tab/enabled/label/config/key)",
  !/data:\s*\{[^}]*\b(tab|enabled|label|config|key)\b/.test(route));

// Scope guard: this is reorder only — no schema/density/widget-layout leakage.
check("B no density / collapse / resize fields (UX-CUST-1A scope)",
  !/density|collapsed|expanded|condensed|resize/i.test(route));

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("UX-CUST-1A reorder tests FAILED."); process.exit(1); }
console.log("UX-CUST-1A reorder tests passed.");
process.exit(0);
