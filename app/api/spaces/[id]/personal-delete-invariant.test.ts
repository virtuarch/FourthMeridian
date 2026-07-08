/**
 * app/api/spaces/[id]/personal-delete-invariant.test.ts
 *
 * UX-CUST-1A correction — a Personal Space must NOT be deletable under any
 * condition, and the protection must not be UI-only.
 *
 * Runnable with the already-installed `tsx`:
 *     npx tsx app/api/spaces/[id]/personal-delete-invariant.test.ts
 * Exits 0 when all pass, 1 on failure. Auto-discovered by scripts/run-tests.ts.
 *
 * Source-scan (same rationale as lib/spaces/authorize.test.ts): importing the
 * routes pulls `@/lib/db` + next/server, which don't load under a bare tsx
 * script. So we scan the source for the invariants that must not regress:
 *   1. The soft-delete (trash) DELETE route fails closed for PERSONAL.
 *   2. The permanent-delete DELETE route fails closed for PERSONAL.
 *   3. ManageSpaceModal never shows the delete/danger tab for a PERSONAL Space.
 */

import { readFileSync } from "fs";
import { join }         from "path";

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

// ── 1. Soft-delete (trash) route — DELETE /api/spaces/[id] ───────────────────
// This file also holds GET/PATCH handlers, so scope ordering checks to the
// DELETE handler slice (PATCH also calls db.space.update).
const softDeleteFile = code(read("app", "api", "spaces", "[id]", "route.ts"));
const softDelete = softDeleteFile.slice(softDeleteFile.indexOf("export const DELETE"));

check("soft-delete route has a DELETE handler",
  /export\s+const\s+DELETE\s*=/.test(softDeleteFile));
check("soft-delete refuses PERSONAL (type === PERSONAL guard)",
  /space\.type\s*===\s*["']PERSONAL["']/.test(softDelete));
check("soft-delete PERSONAL guard returns an error status (fails closed)",
  /space\.type\s*===\s*["']PERSONAL["'][\s\S]{0,160}?status:\s*400/.test(softDelete));
check("soft-delete PERSONAL guard precedes the trash update (guard is upstream)",
  softDelete.indexOf('space.type === "PERSONAL"') !== -1 &&
  softDelete.indexOf('space.type === "PERSONAL"') <
    softDelete.indexOf("db.space.update"));

// ── 2. Permanent-delete route — DELETE /api/spaces/[id]/permanent ────────────
const permaDelete = code(read("app", "api", "spaces", "[id]", "permanent", "route.ts"));

check("permanent-delete route has a DELETE handler",
  /export\s+const\s+DELETE\s*=/.test(permaDelete));
check("permanent-delete refuses PERSONAL (type === PERSONAL guard)",
  /space\.type\s*===\s*["']PERSONAL["']/.test(permaDelete));
check("permanent-delete PERSONAL guard returns 400 (fails closed)",
  /space\.type\s*===\s*["']PERSONAL["'][\s\S]{0,160}?status:\s*400/.test(permaDelete));
check("permanent-delete PERSONAL guard precedes db.space.delete (guard is upstream)",
  permaDelete.indexOf('space.type === "PERSONAL"') !== -1 &&
  permaDelete.indexOf('space.type === "PERSONAL"') <
    permaDelete.indexOf("db.space.delete"));

// ── 3. UI — ManageSpaceModal hides the danger/delete tab for PERSONAL ────────
const manage = code(read("components", "dashboard", "ManageSpaceModal.tsx"));

check("Manage modal danger tab is NOT unconditionally shown",
  !/id:\s*["']danger["'][^}]*show:\s*true\b/.test(manage));
check("Manage modal danger tab is gated on non-PERSONAL type",
  /id:\s*["']danger["'][\s\S]{0,220}?type\s*!==\s*["']PERSONAL["']/.test(manage));
check("Manage modal danger tab BODY is gated on non-PERSONAL type",
  /activeTab\s*===\s*["']danger["'][\s\S]{0,40}?type\s*!==\s*["']PERSONAL["']/.test(manage));

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("Personal-delete-invariant tests FAILED."); process.exit(1); }
console.log("Personal-delete-invariant tests passed.");
process.exit(0);
