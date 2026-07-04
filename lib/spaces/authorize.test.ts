/**
 * lib/spaces/authorize.test.ts
 *
 * SP-2b Batch 1 — behavior-preservation tests for the requireSpaceAction
 * adapter and the three migrated routes.
 *
 * The project has no test runner. Runnable with the already-installed `tsx`:
 *
 *     npx tsx lib/spaces/authorize.test.ts
 *
 * Exits 0 when all pass, 1 on failure.
 *
 * WHY PART SOURCE-SCAN: importing lib/spaces/authorize.ts here is not practical
 * — it pulls in `server-only`, `@/lib/db` (Prisma engine), and next/server,
 * none of which load under a bare tsx script. This mirrors the established
 * repo pattern for route-auth tests (lib/perspective-engine/route.test.ts,
 * lib/data/transactions.privacy.test.ts): assert the decision *semantics*
 * against the pure `can()` (which imports cleanly), then source-scan the
 * adapter + routes for the invariants that must not regress.
 */

import { readFileSync } from "fs";
import { join }         from "path";
import { can }          from "./policy";
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

// ─────────────────────────────────────────────────────────────────────────────
// PART A — decision semantics the adapter delegates to (pure can()).
// decideSpaceAction(action, m) === (m ? can(action, m) : false). We assert the
// can() half here for the four batch actions; the null-membership half is
// pinned structurally in Part B.
// ─────────────────────────────────────────────────────────────────────────────

const A = (role: SpaceMemberRole, status: SpaceMemberStatus, spaceType: SpaceType) =>
  ({ role, status, spaceType });

// section:read — any ACTIVE member; inactive/removed denied.
check("A section:read VIEWER/ACTIVE allow",  can("section:read", A("VIEWER", "ACTIVE",  "SHARED")) === true);
check("A section:read VIEWER/REMOVED deny",  can("section:read", A("VIEWER", "REMOVED", "SHARED")) === false);
check("A section:read VIEWER/LEFT deny",     can("section:read", A("VIEWER", "LEFT",    "SHARED")) === false);

// section:edit — ADMIN+; MEMBER/VIEWER denied.
check("A section:edit ADMIN allow",  can("section:edit", A("ADMIN",  "ACTIVE", "SHARED")) === true);
check("A section:edit OWNER allow",  can("section:edit", A("OWNER",  "ACTIVE", "SHARED")) === true);
check("A section:edit MEMBER deny",  can("section:edit", A("MEMBER", "ACTIVE", "SHARED")) === false);
check("A section:edit VIEWER deny",  can("section:edit", A("VIEWER", "ACTIVE", "SHARED")) === false);

// account:share — any ACTIVE member (door for share POST + revoke DELETE).
check("A account:share VIEWER/ACTIVE allow", can("account:share", A("VIEWER", "ACTIVE",  "SHARED")) === true);
check("A account:share MEMBER/ACTIVE allow", can("account:share", A("MEMBER", "ACTIVE",  "SHARED")) === true);
check("A account:share MEMBER/REMOVED deny", can("account:share", A("MEMBER", "REMOVED", "SHARED")) === false);

// account:revoke — privileged half of the revoke residual: OWNER/ADMIN true, MEMBER/VIEWER false.
check("A account:revoke OWNER privileged",  can("account:revoke", A("OWNER",  "ACTIVE", "SHARED")) === true);
check("A account:revoke ADMIN privileged",  can("account:revoke", A("ADMIN",  "ACTIVE", "SHARED")) === true);
check("A account:revoke MEMBER not-priv",   can("account:revoke", A("MEMBER", "ACTIVE", "SHARED")) === false);
check("A account:revoke VIEWER not-priv",   can("account:revoke", A("VIEWER", "ACTIVE", "SHARED")) === false);

// ─────────────────────────────────────────────────────────────────────────────
// PART B — adapter invariants (source-scan of lib/spaces/authorize.ts).
// ─────────────────────────────────────────────────────────────────────────────

const adapter = read("lib", "spaces", "authorize.ts");
const adapterCode = code(adapter);

check("B adapter is server-only",              /import\s+["']server-only["']/.test(adapterCode));
check("B adapter reuses requireUser",          /requireUser\s*\(/.test(adapterCode) && /from\s+["']@\/lib\/session["']/.test(adapterCode));
check("B adapter reuses forbidden",            /\bforbidden\s*\(\s*\)/.test(adapterCode));
check("B adapter delegates to can()",          /\bcan\s*\(/.test(adapterCode) && /from\s+["']\.\/policy["']/.test(adapterCode));
check("B adapter fetches membership + space.type",
  /spaceMember\.findUnique/.test(adapterCode) && /space:\s*\{\s*select:\s*\{\s*type:\s*true/.test(adapterCode));
check("B decideSpaceAction denies null membership",
  /if\s*\(\s*!membership\s*\)\s*return\s+false/.test(adapterCode));
check("B adapter never emits 404",             !/404/.test(adapterCode));
check("B adapter 401 via requireUser err propagation",
  /if\s*\(\s*err\s*\)\s*return\s*\[\s*null\s*,\s*err\s*\]/.test(adapterCode));

// ─────────────────────────────────────────────────────────────────────────────
// PART C — migrated-route invariants (behavior preservation tripwires).
// ─────────────────────────────────────────────────────────────────────────────

const sectionsGet  = code(read("app", "api", "spaces", "[id]", "sections", "route.ts"));
const sectionPatch = code(read("app", "api", "spaces", "[id]", "sections", "[sectionId]", "route.ts"));
const share        = code(read("app", "api", "spaces", "[id]", "accounts", "share", "route.ts"));

// sections GET
check("C sectionsGET uses requireSpaceAction section:read",
  /requireSpaceAction\(\s*spaceId\s*,\s*["']section:read["']\s*\)/.test(sectionsGet));
check("C sectionsGET dropped inline spaceMember.findUnique",
  !/spaceMember\.findUnique/.test(sectionsGet));

// sections PATCH
check("C sectionPATCH uses requireSpaceAction section:edit",
  /requireSpaceAction\(\s*spaceId\s*,\s*["']section:edit["']\s*\)/.test(sectionPatch));
check("C sectionPATCH keeps section-belongs-to-space 404",
  /Section not found/.test(sectionPatch) && /status:\s*404/.test(sectionPatch));
check("C sectionPATCH dropped inline spaceMember.findUnique",
  !/spaceMember\.findUnique/.test(sectionPatch));

// accounts/share POST
check("C share POST uses requireSpaceAction account:share",
  /requireSpaceAction\(\s*spaceId\s*,\s*["']account:share["']\s*\)/.test(share));
check("C share POST keeps ownership 403",
  /You do not own this account/.test(share));
check("C share POST success stays 201",
  /status:\s*201/.test(share));

// accounts/share DELETE — door + residual
check("C share DELETE door is account:share (NOT account:revoke)",
  !/requireSpaceAction\(\s*spaceId\s*,\s*["']account:revoke["']\s*\)/.test(share));
check("C share DELETE residual uses can(account:revoke, auth.membership)",
  /can\(\s*["']account:revoke["']\s*,\s*auth\.membership\s*\)/.test(share));
check("C share DELETE keeps adder check",
  /link\.addedByUserId\s*!==\s*userId/.test(share));
check("C share DELETE keeps Share not found 404",
  /Share not found/.test(share) && /status:\s*404/.test(share));

// whole file: both share handlers dropped inline membership lookups
check("C share dropped inline spaceMember.findUnique (both handlers)",
  !/spaceMember\.findUnique/.test(share));
check("C share no longer imports requireUser / SpaceMemberStatus",
  !/requireUser/.test(share) && !/SpaceMemberStatus/.test(share));

// ─────────────────────────────────────────────────────────────────────────────
// PART D — Batch 2 migrated routes (check-in / activity / perspectives).
// Same source-scan tripwire approach. All three are "any ACTIVE member" doors.
// ─────────────────────────────────────────────────────────────────────────────

const checkIn      = code(read("app", "api", "spaces", "[id]", "goals", "[goalId]", "check-in", "route.ts"));
const activity     = code(read("app", "api", "spaces", "[id]", "activity", "route.ts"));
const perspectives = code(read("app", "api", "spaces", "[id]", "perspectives", "route.ts"));

// goal check-in
check("D check-in uses requireSpaceAction goal:checkIn",
  /requireSpaceAction\(\s*spaceId\s*,\s*["']goal:checkIn["']\s*\)/.test(checkIn));
check("D check-in dropped inline spaceMember.findUnique",
  !/spaceMember\.findUnique/.test(checkIn));
check("D check-in keeps goal 404 + HABIT 400 residuals",
  /status:\s*404/.test(checkIn) && /HABIT/.test(checkIn) && /status:\s*400/.test(checkIn));

// activity
check("D activity uses requireSpaceAction activity:read",
  /requireSpaceAction\(\s*spaceId\s*,\s*["']activity:read["']\s*\)/.test(activity));
check("D activity dropped inline spaceMember.findUnique",
  !/spaceMember\.findUnique/.test(activity));
check("D activity keeps missing-spaceId 400 BEFORE the door",
  activity.indexOf("Missing space id") !== -1 &&
  activity.indexOf("Missing space id") < activity.indexOf("requireSpaceAction(spaceId"));

// perspectives
check("D perspectives uses requireSpaceAction perspective:read",
  /requireSpaceAction\(\s*spaceId\s*,\s*["']perspective:read["']\s*\)/.test(perspectives));
check("D perspectives dropped inline spaceMember.findUnique",
  !/spaceMember\.findUnique/.test(perspectives));
check("D perspectives keeps missing-spaceId 400 BEFORE the door",
  perspectives.indexOf("Missing space id") !== -1 &&
  perspectives.indexOf("Missing space id") < perspectives.indexOf("requireSpaceAction(spaceId"));
check("D perspectives still computes as the requesting viewer (userId from auth)",
  /const\s+userId\s*=\s*auth\.user\.id/.test(perspectives) &&
  /computePerspectives\(\s*\{\s*spaceId\s*,\s*userId\s*\}\s*\)/.test(perspectives));

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("SP-2b authorize tests FAILED."); process.exit(1); }
console.log("SP-2b authorize tests passed.");
process.exit(0);
