/**
 * lib/platform/policy.test.ts
 *
 * PO1.0 platform-access policy tests — pure, no DB, no session, no LLM.
 *
 * The project has no test runner (no jest/vitest). This is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/spaces/policy.test.ts:
 *
 *     npx tsx lib/platform/policy.test.ts
 *
 * Exits 0 when all cases pass and 1 on failure.
 *
 * Strategy: an INDEPENDENT oracle (re-deriving the expected decision from its
 * own inlined rank table, NOT importing LEVEL_RANK) is checked against
 * hasPlatformAccess() across the full area × level × status grant matrix, plus
 * named invariant cases pinning the level-rank / revoked / wrong-area / empty
 * failure classes. The `decidePlatformAccess` (SYSTEM_ADMIN bypass + USER
 * matrix) cases are appended to this same file in S3, when the adapter lands.
 */

import type {
  PlatformArea,
  PlatformAccessLevel,
  PlatformGrantStatus,
} from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { UserRole } from "@prisma/client";
import {
  hasPlatformAccess,
  PLATFORM_AREAS,
  ALL_PLATFORM_AREAS,
  LEVEL_RANK,
  type PlatformGrantCtx,
} from "./policy";

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

// ── Domains ───────────────────────────────────────────────────────────────────

const AREAS: PlatformArea[] = [
  "PLATFORM_OPS",
  "SECURITY_OPS",
  "GROWTH_REVENUE",
  "CUSTOMER_SUCCESS",
];
const LEVELS:   PlatformAccessLevel[]  = ["READ", "WRITE"];
const STATUSES: PlatformGrantStatus[]  = ["ACTIVE", "REVOKED"];

// ── Independent oracle ────────────────────────────────────────────────────────
// Hand-written expected behavior. Intentionally NOT importing LEVEL_RANK, so a
// drift between spec and implementation is caught.

const ORACLE_RANK: Record<PlatformAccessLevel, number> = { READ: 0, WRITE: 1 };

function oracleAllows(
  needed: PlatformAccessLevel,
  grantArea: PlatformArea,
  grantLevel: PlatformAccessLevel,
  grantStatus: PlatformGrantStatus,
  askArea: PlatformArea,
): boolean {
  if (grantStatus !== "ACTIVE") return false;   // 1. only ACTIVE counts
  if (grantArea !== askArea) return false;       // 2. exact area match
  return ORACLE_RANK[grantLevel] >= ORACLE_RANK[needed]; // 3. level rank
}

// ── A. Full single-grant matrix vs oracle ─────────────────────────────────────
// For every (grantArea, grantLevel, grantStatus), ask access for every
// (askArea, neededLevel) and compare hasPlatformAccess to the oracle.

let combos = 0;
for (const grantArea of AREAS) {
  for (const grantLevel of LEVELS) {
    for (const grantStatus of STATUSES) {
      const grants: PlatformGrantCtx[] = [
        { area: grantArea, level: grantLevel, status: grantStatus },
      ];
      for (const askArea of AREAS) {
        for (const needed of LEVELS) {
          combos++;
          const got  = hasPlatformAccess(askArea, needed, grants);
          const want = oracleAllows(needed, grantArea, grantLevel, grantStatus, askArea);
          check(
            `matrix grant(${grantArea},${grantLevel},${grantStatus}) ask(${askArea},${needed})`,
            got === want,
            `expected ${want}, got ${got}`,
          );
        }
      }
    }
  }
}
// 4 grantAreas × 2 grantLevels × 2 statuses × 4 askAreas × 2 needed = 128
check(`matrix covered exactly 128 combinations (got ${combos})`, combos === 128);

// ── B. Named invariant cases ──────────────────────────────────────────────────

// 1. LEVEL_RANK semantics on the SAME area.
{
  const readGrant:  PlatformGrantCtx[] = [{ area: "SECURITY_OPS", level: "READ",  status: "ACTIVE" }];
  const writeGrant: PlatformGrantCtx[] = [{ area: "SECURITY_OPS", level: "WRITE", status: "ACTIVE" }];
  check("inv#1 READ satisfies READ",         hasPlatformAccess("SECURITY_OPS", "READ",  readGrant)  === true);
  check("inv#1 READ does NOT satisfy WRITE", hasPlatformAccess("SECURITY_OPS", "WRITE", readGrant)  === false);
  check("inv#1 WRITE satisfies READ",        hasPlatformAccess("SECURITY_OPS", "READ",  writeGrant) === true);
  check("inv#1 WRITE satisfies WRITE",       hasPlatformAccess("SECURITY_OPS", "WRITE", writeGrant) === true);
}

// 2. REVOKED grants confer nothing — no residual access at either level.
{
  const revoked: PlatformGrantCtx[] = [{ area: "PLATFORM_OPS", level: "WRITE", status: "REVOKED" }];
  check("inv#2 REVOKED denies READ",  hasPlatformAccess("PLATFORM_OPS", "READ",  revoked) === false);
  check("inv#2 REVOKED denies WRITE", hasPlatformAccess("PLATFORM_OPS", "WRITE", revoked) === false);
}

// 3. Wrong-area grant never leaks to another area (no cross-area inheritance).
{
  const grants: PlatformGrantCtx[] = [{ area: "SECURITY_OPS", level: "WRITE", status: "ACTIVE" }];
  for (const other of AREAS.filter((a) => a !== "SECURITY_OPS")) {
    check(`inv#3 SECURITY_OPS grant denies ${other} READ`,  hasPlatformAccess(other, "READ",  grants) === false);
    check(`inv#3 SECURITY_OPS grant denies ${other} WRITE`, hasPlatformAccess(other, "WRITE", grants) === false);
  }
}

// 4. Empty grant set denies everything.
{
  for (const area of AREAS) {
    for (const needed of LEVELS) {
      check(`inv#4 empty grants deny ${area} ${needed}`, hasPlatformAccess(area, needed, []) === false);
    }
  }
}

// 5. Multiple grants — the matching ACTIVE grant is what decides; a revoked or
//    wrong-area sibling does not interfere with a valid one.
{
  const mixed: PlatformGrantCtx[] = [
    { area: "PLATFORM_OPS",   level: "READ",  status: "REVOKED" },
    { area: "SECURITY_OPS",   level: "READ",  status: "ACTIVE"  },
    { area: "GROWTH_REVENUE", level: "WRITE", status: "ACTIVE"  },
  ];
  check("inv#5 revoked sibling doesn't grant PLATFORM_OPS", hasPlatformAccess("PLATFORM_OPS", "READ",  mixed) === false);
  check("inv#5 active READ grants SECURITY_OPS READ",       hasPlatformAccess("SECURITY_OPS", "READ",  mixed) === true);
  check("inv#5 active READ denies SECURITY_OPS WRITE",      hasPlatformAccess("SECURITY_OPS", "WRITE", mixed) === false);
  check("inv#5 active WRITE grants GROWTH_REVENUE WRITE",   hasPlatformAccess("GROWTH_REVENUE", "WRITE", mixed) === true);
}

// ── C. Registry / rank exhaustiveness ─────────────────────────────────────────

// PLATFORM_AREAS is exhaustive over the enum and self-consistent (key === map key).
{
  check("reg PLATFORM_AREAS has exactly 4 areas", ALL_PLATFORM_AREAS.length === 4,
    `got ${ALL_PLATFORM_AREAS.length}`);
  check("reg every area covered", AREAS.every((a) => PLATFORM_AREAS[a] !== undefined));
  const keyConsistent = AREAS.every((a) => PLATFORM_AREAS[a].key === a);
  check("reg meta.key matches its map key", keyConsistent);
  // Section keys are unique across the whole registry (they become
  // SpaceDashboardSection @@unique([spaceId, key]) rows — within one Space they
  // must be distinct; globally-unique is a stronger, cheaper-to-assert floor).
  const allSectionKeys = AREAS.flatMap((a) => PLATFORM_AREAS[a].sections.map((s) => s.key));
  check("reg section keys globally unique", new Set(allSectionKeys).size === allSectionKeys.length);
  check("reg every area has ≥1 section", AREAS.every((a) => PLATFORM_AREAS[a].sections.length >= 1));
}

// LEVEL_RANK is a strict two-member ranking (WRITE > READ).
{
  check("rank LEVEL_RANK READ=0",  LEVEL_RANK.READ === 0);
  check("rank LEVEL_RANK WRITE=1", LEVEL_RANK.WRITE === 1);
  check("rank WRITE outranks READ", LEVEL_RANK.WRITE > LEVEL_RANK.READ);
}

// ── D. Determinism ────────────────────────────────────────────────────────────
{
  const grants: PlatformGrantCtx[] = [{ area: "SECURITY_OPS", level: "READ", status: "ACTIVE" }];
  const a = hasPlatformAccess("SECURITY_OPS", "READ", grants);
  const b = hasPlatformAccess("SECURITY_OPS", "READ", grants);
  const c = hasPlatformAccess("SECURITY_OPS", "READ", grants);
  check("det deterministic", a === b && b === c);
}

// ── E. decidePlatformAccess (adapter pure branch) ─────────────────────────────
// The adapter (lib/platform/authorize.ts) pulls in `server-only`, @/lib/db
// (Prisma engine), next/server and @/lib/session, so it cannot be imported into
// a standalone `tsx` script — exactly the constraint lib/spaces/authorize.test.ts
// documents for decideSpaceAction. So the pure branch is covered the same way:
//   (a) an inline oracle pins the SPEC (SYSTEM_ADMIN ⇒ true; USER ⇒ hasPlatformAccess),
//   (b) a source-scan of authorize.ts proves the implementation matches it.

const SYSTEM_ADMIN: UserRole = "SYSTEM_ADMIN";
const USER: UserRole = "USER";

/** Spec oracle for decidePlatformAccess. */
function oracleDecide(
  role:   UserRole,
  area:   PlatformArea,
  needed: PlatformAccessLevel,
  grants: PlatformGrantCtx[],
): boolean {
  if (role === "SYSTEM_ADMIN") return true;
  return hasPlatformAccess(area, needed, grants);
}

{
  // Spec (a): SYSTEM_ADMIN allowed everything, every level, with NO grants.
  for (const area of AREAS) {
    for (const needed of LEVELS) {
      check(`dec SYSTEM_ADMIN allowed ${area} ${needed} with no grants`,
        oracleDecide(SYSTEM_ADMIN, area, needed, []) === true);
    }
  }
  // SYSTEM_ADMIN allowed even where a USER would be denied (revoked grant).
  const revoked: PlatformGrantCtx[] = [{ area: "SECURITY_OPS", level: "READ", status: "REVOKED" }];
  check("dec SYSTEM_ADMIN bypass ignores revoked grant",
    oracleDecide(SYSTEM_ADMIN, "SECURITY_OPS", "WRITE", revoked) === true);

  // USER with NO grants is denied everywhere; USER decision === hasPlatformAccess.
  for (const area of AREAS) {
    for (const needed of LEVELS) {
      check(`dec USER denied ${area} ${needed} with no grants`,
        oracleDecide(USER, area, needed, []) === false);
    }
  }
  let decCombos = 0;
  for (const grantArea of AREAS) {
    for (const grantLevel of LEVELS) {
      for (const grantStatus of STATUSES) {
        const grants: PlatformGrantCtx[] = [{ area: grantArea, level: grantLevel, status: grantStatus }];
        for (const askArea of AREAS) {
          for (const needed of LEVELS) {
            decCombos++;
            check(
              `dec USER === policy grant(${grantArea},${grantLevel},${grantStatus}) ask(${askArea},${needed})`,
              oracleDecide(USER, askArea, needed, grants) === hasPlatformAccess(askArea, needed, grants),
            );
          }
        }
      }
    }
  }
  check(`dec USER matrix covered 128 combinations (got ${decCombos})`, decCombos === 128);
}

// Spec (b): the real authorize.ts implements exactly this branch + the tuple
// adapters, and never discloses existence (403 not 404).
{
  const ROOT = process.cwd();
  const authSrc = readFileSync(path.join(ROOT, "lib/platform/authorize.ts"), "utf8");
  // decidePlatformAccess: SYSTEM_ADMIN bypass then delegates to hasPlatformAccess.
  const decBody = authSrc.slice(authSrc.indexOf("export function decidePlatformAccess"));
  check("src decidePlatformAccess SYSTEM_ADMIN bypass returns true",
    /role === UserRole\.SYSTEM_ADMIN\)\s*return true/.test(decBody));
  check("src decidePlatformAccess delegates to hasPlatformAccess",
    decBody.includes("return hasPlatformAccess(area, needed, grants)"));
  // Adapters key on the @@unique([userId, area]) composite and use the right guards.
  check("src requirePlatformAccess uses requireUser",
    authSrc.includes("export async function requirePlatformAccess") && authSrc.includes("await requireUser()"));
  check("src requireFreshPlatformAccess uses requireFreshUser",
    authSrc.includes("export async function requireFreshPlatformAccess") && authSrc.includes("await requireFreshUser()"));
  check("src grant lookup keyed on userId_area composite",
    authSrc.includes("userId_area:"));
  // Strip comments before the 404 scan — the file header DOCUMENTS the never-404
  // rule, which must not trip the code check.
  const authCode = authSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("src denies with forbidden() (403), never 404 in code",
    authCode.includes("forbidden()") && !authCode.includes("404") && !authCode.includes("notFound"));
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) {
  console.log("PO1.0 platform policy tests FAILED.");
  process.exit(1);
}
console.log("PO1.0 platform policy tests passed.");
process.exit(0);
