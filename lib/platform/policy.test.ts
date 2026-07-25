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
const LEVELS:   PlatformAccessLevel[]  = ["READ", "WRITE", "CONTROL"];
const STATUSES: PlatformGrantStatus[]  = ["ACTIVE", "REVOKED"];

/**
 * The two levels that existed before OPS-2D-2. Kept as its own list so the
 * pre-CONTROL behaviour can be asserted as a REGRESSION set, independent of
 * whatever LEVELS grows to. If adding a rank ever perturbs the old matrix, the
 * §F block below fails whether or not the oracle was updated in sympathy.
 */
const PRE_CONTROL_LEVELS: PlatformAccessLevel[] = ["READ", "WRITE"];

// ── Independent oracle ────────────────────────────────────────────────────────
// Hand-written expected behavior. Intentionally NOT importing LEVEL_RANK, so a
// drift between spec and implementation is caught.

const ORACLE_RANK: Record<PlatformAccessLevel, number> = { READ: 0, WRITE: 1, CONTROL: 2 };

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
// 4 grantAreas × 3 grantLevels × 2 statuses × 4 askAreas × 3 needed = 288
check(`matrix covered exactly 288 combinations (got ${combos})`, combos === 288);

// ── B. Named invariant cases ──────────────────────────────────────────────────

// 1. LEVEL_RANK semantics on the SAME area.
{
  const readGrant:  PlatformGrantCtx[] = [{ area: "SECURITY_OPS", level: "READ",  status: "ACTIVE" }];
  const writeGrant: PlatformGrantCtx[] = [{ area: "SECURITY_OPS", level: "WRITE", status: "ACTIVE" }];
  check("inv#1 READ satisfies READ",         hasPlatformAccess("SECURITY_OPS", "READ",  readGrant)  === true);
  check("inv#1 READ does NOT satisfy WRITE", hasPlatformAccess("SECURITY_OPS", "WRITE", readGrant)  === false);
  check("inv#1 WRITE satisfies READ",        hasPlatformAccess("SECURITY_OPS", "READ",  writeGrant) === true);
  check("inv#1 WRITE satisfies WRITE",       hasPlatformAccess("SECURITY_OPS", "WRITE", writeGrant) === true);

  // OPS-2D-2 — CONTROL is a RANK ABOVE WRITE, which cuts one way only. The
  // second assertion is the load-bearing one: if WRITE ever satisfied CONTROL,
  // every operator holding WRITE today would silently acquire control-plane
  // power the moment the first control endpoint shipped.
  const controlGrant: PlatformGrantCtx[] = [{ area: "SECURITY_OPS", level: "CONTROL", status: "ACTIVE" }];
  check("inv#1 CONTROL satisfies READ",         hasPlatformAccess("SECURITY_OPS", "READ",    controlGrant) === true);
  check("inv#1 CONTROL satisfies WRITE",        hasPlatformAccess("SECURITY_OPS", "WRITE",   controlGrant) === true);
  check("inv#1 CONTROL satisfies CONTROL",      hasPlatformAccess("SECURITY_OPS", "CONTROL", controlGrant) === true);
  check("inv#1 WRITE does NOT satisfy CONTROL", hasPlatformAccess("SECURITY_OPS", "CONTROL", writeGrant)   === false);
  check("inv#1 READ does NOT satisfy CONTROL",  hasPlatformAccess("SECURITY_OPS", "CONTROL", readGrant)    === false);
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

// LEVEL_RANK is a strict three-member ranking (CONTROL > WRITE > READ).
{
  check("rank LEVEL_RANK READ=0",    LEVEL_RANK.READ === 0);
  check("rank LEVEL_RANK WRITE=1",   LEVEL_RANK.WRITE === 1);
  check("rank LEVEL_RANK CONTROL=2", LEVEL_RANK.CONTROL === 2);
  check("rank WRITE outranks READ",     LEVEL_RANK.WRITE > LEVEL_RANK.READ);
  check("rank CONTROL outranks WRITE",  LEVEL_RANK.CONTROL > LEVEL_RANK.WRITE);
  // The rank is a total order with no ties — a tie would make two levels
  // mutually satisfying and silently collapse the distinction.
  check("rank has no ties", new Set(Object.values(LEVEL_RANK)).size === Object.keys(LEVEL_RANK).length);
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
  check(`dec USER matrix covered 288 combinations (got ${decCombos})`, decCombos === 288);
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

// ── F. Pre-CONTROL regression + fail-closed on unknown levels (OPS-2D-2) ──────
//
// Section A already compares the implementation to an oracle, but both were
// edited in the same slice — so a shared mistake would pass. This block pins the
// pre-OPS-2D-2 answers LITERALLY, computed from nothing: 24 hand-stated
// expectations for the READ/WRITE world. If adding CONTROL moved any existing
// decision by so much as one cell, these fail regardless of the oracle.
{
  // Expected truth table for a single ACTIVE grant on the SAME area, exactly as
  // it read before CONTROL existed: grantLevel → { neededLevel → allowed }.
  const PRE: Record<string, Record<string, boolean>> = {
    READ:  { READ: true,  WRITE: false },
    WRITE: { READ: true,  WRITE: true  },
  };
  let pinned = 0;
  for (const area of AREAS) {
    for (const grantLevel of PRE_CONTROL_LEVELS) {
      for (const needed of PRE_CONTROL_LEVELS) {
        pinned++;
        const grants: PlatformGrantCtx[] = [{ area, level: grantLevel, status: "ACTIVE" }];
        check(
          `regress ${area} grant=${grantLevel} needs=${needed} → ${PRE[grantLevel][needed]}`,
          hasPlatformAccess(area, needed, grants) === PRE[grantLevel][needed],
        );
      }
    }
  }
  check(`regress pinned 16 pre-CONTROL decisions (got ${pinned})`, pinned === 16);

  // Revoked and cross-area denials are unchanged for the pre-CONTROL levels.
  for (const grantLevel of PRE_CONTROL_LEVELS) {
    const revoked: PlatformGrantCtx[] = [{ area: "PLATFORM_OPS", level: grantLevel, status: "REVOKED" }];
    check(`regress REVOKED ${grantLevel} still denies READ`,
      hasPlatformAccess("PLATFORM_OPS", "READ", revoked) === false);
    const elsewhere: PlatformGrantCtx[] = [{ area: "SECURITY_OPS", level: grantLevel, status: "ACTIVE" }];
    check(`regress ${grantLevel} on SECURITY_OPS still denies PLATFORM_OPS READ`,
      hasPlatformAccess("PLATFORM_OPS", "READ", elsewhere) === false);
  }
}

// Unknown level values FAIL CLOSED. A level outside the enum (a stale row from a
// rolled-back migration, a hand-written DB value, a deserialized string) indexes
// LEVEL_RANK to `undefined`; `undefined >= n` is false in JS, so the comparison
// DENIES rather than defaulting to WRITE. Asserted through the real function via
// a deliberate cast — this is the one place the type system is bypassed on
// purpose, because the hazard is precisely a value the types said was impossible.
{
  const bogusGrant: PlatformGrantCtx[] = [
    { area: "PLATFORM_OPS", level: "SUPERUSER" as PlatformAccessLevel, status: "ACTIVE" as PlatformGrantStatus },
  ];
  for (const needed of LEVELS) {
    check(`failclosed unknown grant level denies ${needed}`,
      hasPlatformAccess("PLATFORM_OPS", needed, bogusGrant) === false);
  }
  // And an unknown NEEDED level is not satisfied by any real grant.
  const realGrant: PlatformGrantCtx[] = [{ area: "PLATFORM_OPS", level: "CONTROL", status: "ACTIVE" }];
  check("failclosed unknown needed level denied even to CONTROL",
    hasPlatformAccess("PLATFORM_OPS", "SUPERUSER" as PlatformAccessLevel, realGrant) === false);
  check("failclosed LEVEL_RANK has no entry for an unknown level",
    (LEVEL_RANK as Record<string, number | undefined>).SUPERUSER === undefined);
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) {
  console.log("PO1.0 platform policy tests FAILED.");
  process.exit(1);
}
console.log("PO1.0 platform policy tests passed.");
process.exit(0);
