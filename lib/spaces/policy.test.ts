/**
 * lib/spaces/policy.test.ts
 *
 * SP-2a policy tests — pure, no DB, no session, no LLM.
 *
 * The project has no test runner (no jest/vitest). This is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/space-nav.test.ts and lib/ai/output-validator.test.ts:
 *
 *     npx tsx lib/spaces/policy.test.ts
 *
 * Exits 0 when all cases pass and 1 on failure, so it can be wired into CI.
 *
 * Strategy: an INDEPENDENT oracle (re-deriving the expected decision from its
 * own inlined tables, NOT importing ACTION_POLICY) is checked against `can()`
 * across the full 4×3×2×20 = 480-combination matrix, plus named
 * leak/invariant cases pinning the recurring "read surface disagrees with the
 * canonical rule" failure class.
 */

import type {
  SpaceMemberRole,
  SpaceMemberStatus,
  SpaceType,
} from "@prisma/client";
import { can, ALL_SPACE_ACTIONS, type SpaceAction } from "./policy";

// ── Tiny harness ──────────────────────────────────────────────────────────────

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes++;
  } else {
    failures++;
    console.log(`[FAIL] ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
}

// ── Independent oracle ────────────────────────────────────────────────────────
// Hand-written expected behavior. Intentionally NOT importing the module's
// ACTION_POLICY, so a drift between spec and implementation is caught.

const RANK: Record<SpaceMemberRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN:  2,
  OWNER:  3,
};

const EXPECTED_MIN_RANK: Record<SpaceAction, number> = {
  "space:read":            0,
  "space:edit":            2,
  "space:archive":         3,
  "space:delete":          3,
  "space:deletePermanent": 3,
  "member:invite":         2,
  "member:manageRoles":    3,
  "member:remove":         2,
  "section:read":          0,
  "section:edit":          2,
  "goal:read":             0,
  "goal:edit":             2,
  "goal:checkIn":          0,
  "account:read":          0,
  "account:share":         0,
  "account:revoke":        2,
  "snapshot:read":         0,
  "transaction:read":      0,
  "activity:read":         0,
  "perspective:read":      0,
};

const LIFECYCLE_ACTIONS = new Set<SpaceAction>([
  "space:archive",
  "space:delete",
  "space:deletePermanent",
]);

function expected(
  action: SpaceAction,
  role: SpaceMemberRole,
  status: SpaceMemberStatus,
  spaceType: SpaceType,
): boolean {
  if (status !== "ACTIVE") return false;
  if (LIFECYCLE_ACTIONS.has(action) && spaceType === "PERSONAL") return false;
  return RANK[role] >= EXPECTED_MIN_RANK[action];
}

// ── Domains ───────────────────────────────────────────────────────────────────

const ROLES:    SpaceMemberRole[]   = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];
const STATUSES: SpaceMemberStatus[] = ["ACTIVE", "REMOVED", "LEFT"];
const TYPES:    SpaceType[]         = ["PERSONAL", "SHARED"];

// ── A. Full 480-combination matrix vs oracle ──────────────────────────────────

let combos = 0;
for (const action of ALL_SPACE_ACTIONS) {
  for (const role of ROLES) {
    for (const status of STATUSES) {
      for (const spaceType of TYPES) {
        combos++;
        const got  = can(action, { role, status, spaceType });
        const want = expected(action, role, status, spaceType);
        check(
          `matrix ${action} | ${role} | ${status} | ${spaceType}`,
          got === want,
          `expected ${want}, got ${got}`,
        );
      }
    }
  }
}
check(`matrix covered exactly 480 combinations (got ${combos})`, combos === 480,
  `20 actions × 4 roles × 3 statuses × 2 types = 480`);

// ── B. Named leak / invariant cases ───────────────────────────────────────────

// 1. Departed member sees nothing — REMOVED/LEFT denied EVERY action incl. reads.
for (const status of ["REMOVED", "LEFT"] as SpaceMemberStatus[]) {
  const allDenied = ALL_SPACE_ACTIONS.every(
    (a) => can(a, { role: "OWNER", status, spaceType: "SHARED" }) === false,
  );
  check(`leak#1 ${status} OWNER denied every action (incl. reads)`, allDenied);
}

// 2. PERSONAL Space is undeletable by its own OWNER, but still readable/editable.
{
  const ctx = { role: "OWNER" as SpaceMemberRole, status: "ACTIVE" as SpaceMemberStatus, spaceType: "PERSONAL" as SpaceType };
  check("leak#2 PERSONAL OWNER cannot archive",          can("space:archive", ctx) === false);
  check("leak#2 PERSONAL OWNER cannot delete",           can("space:delete", ctx) === false);
  check("leak#2 PERSONAL OWNER cannot deletePermanent",  can("space:deletePermanent", ctx) === false);
  check("leak#2 PERSONAL OWNER can still read",          can("space:read", ctx) === true);
  check("leak#2 PERSONAL OWNER can still edit",          can("space:edit", ctx) === true);
}

// 3. ADMIN cannot archive/delete a SHARED Space (OWNER-only), but can edit.
{
  const ctx = { role: "ADMIN" as SpaceMemberRole, status: "ACTIVE" as SpaceMemberStatus, spaceType: "SHARED" as SpaceType };
  check("leak#3 SHARED ADMIN cannot archive",           can("space:archive", ctx) === false);
  check("leak#3 SHARED ADMIN cannot delete",            can("space:delete", ctx) === false);
  check("leak#3 SHARED ADMIN cannot deletePermanent",   can("space:deletePermanent", ctx) === false);
  check("leak#3 SHARED ADMIN can edit",                 can("space:edit", ctx) === true);
}

// 4. VIEWER is read-only (+ checkIn + share role-part); denied all writes.
{
  const ctx = { role: "VIEWER" as SpaceMemberRole, status: "ACTIVE" as SpaceMemberStatus, spaceType: "SHARED" as SpaceType };
  const readable: SpaceAction[] = [
    "space:read", "section:read", "goal:read", "goal:checkIn",
    "account:read", "account:share", "snapshot:read",
    "transaction:read", "activity:read", "perspective:read",
  ];
  const denied: SpaceAction[] = [
    "space:edit", "space:archive", "space:delete", "space:deletePermanent",
    "member:invite", "member:manageRoles", "member:remove",
    "section:edit", "goal:edit", "account:revoke",
  ];
  check("leak#4 VIEWER allowed set", readable.every((a) => can(a, ctx) === true));
  check("leak#4 VIEWER denied set",  denied.every((a) => can(a, ctx) === false));
  // read + write sets together must cover the whole union exactly once.
  check("leak#4 read/write sets partition all 20 actions",
    readable.length + denied.length === 20 &&
    new Set([...readable, ...denied]).size === 20);
}

// 5. Only OWNER manages roles.
{
  const admin = { role: "ADMIN" as SpaceMemberRole, status: "ACTIVE" as SpaceMemberStatus, spaceType: "SHARED" as SpaceType };
  const owner = { role: "OWNER" as SpaceMemberRole, status: "ACTIVE" as SpaceMemberStatus, spaceType: "SHARED" as SpaceType };
  check("leak#5 ADMIN cannot manageRoles", can("member:manageRoles", admin) === false);
  check("leak#5 OWNER can manageRoles",    can("member:manageRoles", owner) === true);
}

// 6. MEMBER cannot edit config, but can do the any-member actions.
{
  const ctx = { role: "MEMBER" as SpaceMemberRole, status: "ACTIVE" as SpaceMemberStatus, spaceType: "SHARED" as SpaceType };
  check("leak#6 MEMBER cannot section:edit", can("section:edit", ctx) === false);
  check("leak#6 MEMBER cannot goal:edit",    can("goal:edit", ctx) === false);
  check("leak#6 MEMBER cannot space:edit",   can("space:edit", ctx) === false);
  check("leak#6 MEMBER can section:read",    can("section:read", ctx) === true);
  check("leak#6 MEMBER can goal:checkIn",    can("goal:checkIn", ctx) === true);
  check("leak#6 MEMBER can account:share",   can("account:share", ctx) === true);
}

// 7. Determinism — same args, same result across repeated calls.
{
  const ctx = { role: "ADMIN" as SpaceMemberRole, status: "ACTIVE" as SpaceMemberStatus, spaceType: "SHARED" as SpaceType };
  const a = can("space:edit", ctx);
  const b = can("space:edit", ctx);
  const c = can("space:edit", ctx);
  check("leak#7 deterministic", a === b && b === c);
}

// 8. Exhaustiveness — every union member is covered by the module's action list.
{
  check("leak#8 ALL_SPACE_ACTIONS has 20 entries", ALL_SPACE_ACTIONS.length === 20,
    `got ${ALL_SPACE_ACTIONS.length}`);
  check("leak#8 no duplicate actions", new Set(ALL_SPACE_ACTIONS).size === ALL_SPACE_ACTIONS.length);
  // oracle table and module list agree on the action set.
  const oracleKeys = new Set(Object.keys(EXPECTED_MIN_RANK));
  const moduleKeys = new Set(ALL_SPACE_ACTIONS);
  const sameSet =
    oracleKeys.size === moduleKeys.size &&
    [...moduleKeys].every((k) => oracleKeys.has(k));
  check("leak#8 module action set matches oracle set", sameSet);
}

// C. Residual-boundary doc test — account:revoke's adder path is a route
//    residual, so the role-only decision denies a plain MEMBER by design.
{
  const ctx = { role: "MEMBER" as SpaceMemberRole, status: "ACTIVE" as SpaceMemberStatus, spaceType: "SHARED" as SpaceType };
  check("boundary account:revoke role-part denies MEMBER (adder residual is route-level)",
    can("account:revoke", ctx) === false);
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) {
  console.log("SP-2a policy tests FAILED.");
  process.exit(1);
}
console.log("SP-2a policy tests passed.");
process.exit(0);
