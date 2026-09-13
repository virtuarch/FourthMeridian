/**
 * lib/platform/capability-control.test.ts  (OPS-2D-2)
 *
 * CONTROL exists canonically, and EXACTLY ONE thing consumes it.
 *
 * OPS-2D-2 shipped CONTROL as a rank with no consumers and this file guarded the
 * absence. PLATFORM OPS POLICIES (Slice 2) shipped the first consumer — the
 * financial-refresh cadence editor — and the contract evolved on purpose rather
 * than being deleted: §4–§7 now pin that CONTROL is issuable, that the matrix
 * offers it, that exactly ONE route family requires it (the policies route),
 * that exactly ONE UI surface branches on it (the Policies widget), and that
 * every OTHER CONTROL family stays PLANNED. The failure mode this guards is the
 * same as before: a second endpoint reaching for CONTROL casually, or a WRITE
 * surface quietly acquiring control-plane power.
 *
 * Run:  npx tsx lib/platform/capability-control.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  LEVEL_RANK,
  ISSUABLE_LEVELS,
  isIssuableLevel,
  CAPABILITY_SUFFIX,
  platformCapability,
  hasPlatformAccess,
  type PlatformGrantCtx,
} from "./policy";
import { MUTATION_FAMILIES, OPEN_CLASSIFICATIONS } from "./capability-classification";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();

/** Read a file with block + line comments removed. Doctrine text must never
 *  satisfy — or trip — a code assertion. */
function code(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function exists(rel: string): boolean {
  try { statSync(path.join(ROOT, rel)); return true; } catch { return false; }
}

/** Every .ts/.tsx file under `dir`, recursively, skipping build artefacts and
 *  the untracked prototype tree (design harnesses never speak for production). */
function walk(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "prototype") continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

function main() {
  // ── 1. CONTROL is canonical in the schema + the generated client ────────────
  console.log("1. CONTROL is a canonical member of PlatformAccessLevel");
  {
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
    const enumBlock = schema.slice(
      schema.indexOf("enum PlatformAccessLevel"),
      schema.indexOf("}", schema.indexOf("enum PlatformAccessLevel")),
    );
    check("schema PlatformAccessLevel declares CONTROL", /\bCONTROL\b/.test(enumBlock));
    check("schema still declares READ and WRITE", /\bREAD\b/.test(enumBlock) && /\bWRITE\b/.test(enumBlock));

    // A migration must accompany the schema edit, or `prisma migrate deploy`
    // ships a client that knows a value the database does not.
    const migDir = "prisma/migrations/20260725_ops2d2_platform_control_capability";
    check("an additive migration accompanies the schema edit", exists(`${migDir}/migration.sql`));
    if (exists(`${migDir}/migration.sql`)) {
      const sql = readFileSync(path.join(ROOT, migDir, "migration.sql"), "utf8");
      check("migration uses ALTER TYPE ... ADD VALUE (additive, no rewrite)",
        /ALTER TYPE "PlatformAccessLevel" ADD VALUE/.test(sql));
      check("migration creates/drops/alters no table or column",
        !/\b(CREATE|DROP|ALTER)\s+TABLE\b/i.test(sql) && !/\bUPDATE\b/i.test(sql));
    }
  }

  // ── 2. Ranked, exhaustive, and distinct from WRITE ──────────────────────────
  console.log("2. CONTROL is ranked, exhaustive, and DISTINCT from WRITE");
  {
    check("LEVEL_RANK ranks CONTROL", LEVEL_RANK.CONTROL === 2);
    check("CONTROL outranks WRITE", LEVEL_RANK.CONTROL > LEVEL_RANK.WRITE);
    check("CONTROL is not an alias for WRITE", LEVEL_RANK.CONTROL !== LEVEL_RANK.WRITE);
    check("LEVEL_RANK covers exactly READ/WRITE/CONTROL",
      JSON.stringify(Object.keys(LEVEL_RANK).sort()) === JSON.stringify(["CONTROL", "READ", "WRITE"]));

    // Distinctness that MATTERS is directional, and it is asserted through the
    // real decision function, not the rank table it happens to use.
    const write:   PlatformGrantCtx[] = [{ area: "PLATFORM_OPS", level: "WRITE",   status: "ACTIVE" }];
    const control: PlatformGrantCtx[] = [{ area: "PLATFORM_OPS", level: "CONTROL", status: "ACTIVE" }];
    check("WRITE does NOT satisfy CONTROL", hasPlatformAccess("PLATFORM_OPS", "CONTROL", write) === false);
    check("CONTROL satisfies WRITE",        hasPlatformAccess("PLATFORM_OPS", "WRITE",   control) === true);
    check("CONTROL satisfies READ",         hasPlatformAccess("PLATFORM_OPS", "READ",    control) === true);
    check("a REVOKED CONTROL grant confers nothing",
      hasPlatformAccess("PLATFORM_OPS", "READ", [{ area: "PLATFORM_OPS", level: "CONTROL", status: "REVOKED" }]) === false);
    check("a CONTROL grant does not leak across areas",
      hasPlatformAccess("SECURITY_OPS", "READ", control) === false);
  }

  // ── 3. Capability naming is exhaustive and unambiguous ──────────────────────
  console.log("3. Derived capability names cover CONTROL without colliding");
  {
    check("CAPABILITY_SUFFIX maps CONTROL", CAPABILITY_SUFFIX.CONTROL === "CONTROL");
    check("CAPABILITY_SUFFIX preserves VIEW/MANAGE",
      CAPABILITY_SUFFIX.READ === "VIEW" && CAPABILITY_SUFFIX.WRITE === "MANAGE");
    const suffixes = Object.values(CAPABILITY_SUFFIX);
    check("suffixes are distinct (no two levels share a capability name)",
      new Set(suffixes).size === suffixes.length);
    check("platformCapability composes area × level",
      platformCapability("PLATFORM_OPS", "CONTROL") === "PLATFORM_OPS_CONTROL" &&
      platformCapability("SECURITY_OPS", "READ")    === "SECURITY_OPS_VIEW" &&
      platformCapability("SECURITY_OPS", "WRITE")   === "SECURITY_OPS_MANAGE");
  }

  // ── 4. ISSUABLE — the grant surface and the matrix offer all three levels ───
  console.log("4. CONTROL is issuable; the matrix offers it; READ/WRITE are unchanged");
  {
    check("ISSUABLE_LEVELS is exactly READ, WRITE, CONTROL",
      JSON.stringify([...ISSUABLE_LEVELS].sort()) === JSON.stringify(["CONTROL", "READ", "WRITE"]));
    check("isIssuableLevel(READ/WRITE) === true", isIssuableLevel("READ") && isIssuableLevel("WRITE"));
    check("isIssuableLevel(CONTROL) === true", isIssuableLevel("CONTROL") === true);

    const grantRoute = code("app/api/admin/platform-grants/route.ts");
    check("the grant route validates against isIssuableLevel (the one policy list)", /isIssuableLevel\(/.test(grantRoute));
    check("grant administration is still SYSTEM_ADMIN-only",
      /requireSystemAdmin\(\)/.test(grantRoute) && /requireFreshSystemAdmin\(\)/.test(grantRoute) &&
      !/requirePlatformAccess|requireFreshPlatformAccess/.test(grantRoute));
    check("the grant route still rejects unknown levels with 400", /"Invalid level"[\s\S]{0,60}400/.test(grantRoute));
    check("the grant route never hardcodes a level", !/"CONTROL"/.test(grantRoute));

    // The matrix enumerates from the model and renders the third cell live.
    const matrix = code("app/admin/platform-access/page.tsx");
    check("the matrix enumerates levels from the canonical list, not a literal",
      /const LEVELS = ALL_ACCESS_LEVELS;/.test(matrix) && !/\["READ",\s*"WRITE"\]/.test(matrix));
    check("ALL_ACCESS_LEVELS is derived from LEVEL_RANK (exhaustive + ordered)",
      /Object\.keys\(LEVEL_RANK\)/.test(code("lib/platform/policy.ts")));
    check("the matrix labels all three levels", /READ: "R", WRITE: "W", CONTROL: "C"/.test(matrix));
    check("the legend describes CONTROL as the operational-policy authority, distinct from WRITE",
      /CONTROL:\s*\n?\s*"Can change declared operational policy/.test(matrix) && !/Not currently issuable/.test(matrix));
    check("the matrix keeps a reserved path for any future non-issuable level (driven by isIssuableLevel)",
      /disabled=\{isCurrent \|\| !issuable\}/.test(matrix) && /if \(!isIssuableLevel\(level\)\) return;/.test(matrix)
        && /onClick=\{\(\) => issuable && !isCurrent && setLevel/.test(matrix));
    check("the matrix never hardcodes CONTROL as a submitted value",
      !/level:\s*"CONTROL"/.test(matrix) && !/setLevel\([^)]*"CONTROL"/.test(matrix));
    check("the selected-state styling for READ/WRITE is unchanged and CONTROL has its own (Atlas tokens, no raw palette)",
      /bg-amber-500\/15 text-amber-400/.test(matrix) && /bg-blue-500\/15 text-blue-400/.test(matrix) && /CHIP_CONTROL_CURRENT/.test(matrix) && !/purple/.test(matrix));
    // Grant / revoke: the same two routes as before, no new permission system.
    check("revoke is the existing PATCH route, unchanged in shape",
      /action !== "revoke"/.test(code("app/api/admin/platform-grants/[grantId]/route.ts")));
  }

  // ── 5. EXACTLY ONE route family requires CONTROL ────────────────────────────
  console.log("5. Exactly one route asks the authorization layer for CONTROL");
  {
    const CONTROL_ROUTE = "app/api/platform/platform-ops/policies/route.ts";
    const routes = walk("app").filter((f) => /route\.tsx?$/.test(f) || /page\.tsx$/.test(f));
    const requiring = routes.filter((f) => {
      const src = code(f);
      return /require(Fresh)?PlatformAccess\(\s*[^)]*"CONTROL"/.test(src) ||
             /hasPlatformAccess\(\s*[^)]*"CONTROL"/.test(src) ||
             /decidePlatformAccess\(\s*[^)]*"CONTROL"/.test(src);
    });
    check(`the policies route is the only route requiring CONTROL (scanned ${routes.length})`,
      requiring.length === 1 && requiring[0] === CONTROL_ROUTE, requiring.join(", "));
    const control = code(CONTROL_ROUTE);
    check("its mutations require FRESH CONTROL (live revocation check), never cached",
      (control.match(/requireFreshPlatformAccess\("PLATFORM_OPS", "CONTROL"\)/g) ?? []).length === 2 && !/requirePlatformAccess\([^)]*"CONTROL"/.test(control));
    check("its read stays at READ", /requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(control));
    check("it delegates every rule to the one mutation service", /from "@\/lib\/platform\/policies\/mutate"/.test(control) && !/platformSetting|auditLog/.test(control));

    // And the mutation routes that exist still require exactly WRITE.
    const WRITE_GATED = [
      "app/api/platform/platform-ops/connections/[id]/resync/route.ts",
      "app/api/platform/platform-ops/connections/[id]/request-reauth/route.ts",
      "app/api/platform/platform-ops/operations/route.ts",
      "app/api/platform/growth-revenue/registration-mode/route.ts",
      "app/api/platform/growth-revenue/product-status/route.ts",
      "app/api/platform/growth-revenue/invitations/route.ts",
      "app/api/platform/growth-revenue/users/[userId]/route.ts",
      "app/api/platform/growth-revenue/requests/[id]/approve/route.ts",
      "app/api/platform/growth-revenue/requests/[id]/deny/route.ts",
      "app/api/platform/growth-revenue/requests/[id]/resend/route.ts",
      "app/api/platform/growth-revenue/requests/[id]/revoke/route.ts",
    ];
    for (const f of WRITE_GATED) {
      const src = code(f);
      check(`${f}: still gated at WRITE`, /requireFreshPlatformAccess\([^)]*"WRITE"\)/.test(src));
    }
    check(`the WRITE-gated census is complete (${WRITE_GATED.length} routes)`,
      walk("app/api").filter((f) => /requireFreshPlatformAccess\([^)]*"WRITE"\)/.test(code(f))).length === WRITE_GATED.length);
    check("no WRITE-gated route was silently promoted to CONTROL", WRITE_GATED.every((f) => !/"CONTROL"/.test(code(f))));
  }

  // ── 6. EXACTLY ONE UI surface branches on control-plane access ──────────────
  console.log("6. Only the Policies editor branches on control-plane access");
  {
    const ADMIN_SURFACE = "app/admin/platform-access/page.tsx";
    const POLICIES_WIDGET = "components/platform/widgets/OpsPoliciesWidget.tsx";
    // The literal CONTROL stays confined to the SYSTEM_ADMIN grant matrix: the
    // widget branches on the descriptive `canControl` flag, never on the level.
    const mentionsControl = [...walk("components"), ...walk("app").filter((f) => /\.tsx$/.test(f))]
      .filter((f) => f !== ADMIN_SURFACE)
      .filter((f) => /\bCONTROL\b/.test(code(f)));
    check("the literal CONTROL appears in no UI outside the admin grant matrix", mentionsControl.length === 0, mentionsControl.join(", "));

    const ui = [...walk("components"), ...walk("app").filter((f) => /\.tsx$/.test(f))]
      .filter((f) => !/\.test\.tsx?$/.test(f)); // a test that RENDERS the editor with canControl is not a consumer
    const consumers = ui.filter((f) => {
      const src = code(f);
      return /(level|accessLevel|access)\s*[!=]==?\s*"CONTROL"/.test(src) ||
             /"CONTROL"\s*[!=]==?\s*(level|accessLevel|access)/.test(src) ||
             /canControl/.test(src);
    }).filter((f) => f !== "components/platform/PlatformSpaceDashboard.tsx"); // the host only forwards `access`
    check(`the Policies widget is the only component that consumes control-plane access (scanned ${ui.length})`,
      consumers.length === 1 && consumers[0] === POLICIES_WIDGET, consumers.join(", "));
    const widget = code(POLICIES_WIDGET);
    check("the widget renders its controls only behind canControl and never a control that 403s",
      /offerEdit = canControl &&/.test(widget) && /offerReset = canControl &&/.test(widget));

    // The mount contract carries the flag, computed by RANK like canWrite.
    const mount = code("lib/space/mount-context.ts");
    const mountServer = code("lib/space/mount-context.server.ts");
    check("SpaceMountContext.access exposes canControl (descriptive)", /canControl: boolean/.test(mount));
    check("platform canControl is rank-based (CONTROL ≥ CONTROL), never string equality",
      /canControl: LEVEL_RANK\[input\.accessLevel\]\s*>=\s*LEVEL_RANK\.CONTROL/.test(mountServer) && !/=== "CONTROL"/.test(mountServer));
    check("platform canWrite is still rank-based",
      /canWrite:\s*LEVEL_RANK\[input\.accessLevel\]\s*>=\s*LEVEL_RANK\.WRITE/.test(mountServer));
    check("a financial Space never carries control-plane authority", /canControl: false/.test(mountServer));
  }

  // ── 7. The classification table is a TABLE, not a second authority ──────────
  console.log("7. capability-classification.ts classifies; it never authorizes");
  {
    // Structural, not promised: nothing outside tests may import it. If this
    // ever fails, a classification has become a gate and there are two
    // authorization systems.
    const importers = [...walk("lib"), ...walk("app"), ...walk("components")]
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .filter((f) => /capability-classification/.test(code(f)));
    check("no production module imports the classification table", importers.length === 0,
      importers.join(", "));

    const table = code("lib/platform/capability-classification.ts");
    check("the table performs no authorization",
      !/hasPlatformAccess|requirePlatformAccess|decidePlatformAccess|forbidden\(/.test(table));

    // Every family that claims a SHIPPED gate must actually carry it. This is
    // what keeps the table from drifting into fiction: change a route's gate
    // without updating the classification and the build fails.
    const all = [...MUTATION_FAMILIES, ...OPEN_CLASSIFICATIONS];
    check("family keys are unique", new Set(all.map((f) => f.key)).size === all.length);
    for (const fam of all) {
      if (fam.status === "PLANNED") {
        check(`${fam.key}: PLANNED families cite no routes`, fam.routes === undefined);
        continue;
      }
      if (fam.capability === "SYSTEM_ADMIN" && fam.key === "emergency-administration") continue; // no single route
      check(`${fam.key}: cites at least one route`, (fam.routes?.length ?? 0) > 0);
      for (const r of fam.routes ?? []) {
        check(`${fam.key}: ${r} exists`, exists(r));
        if (!exists(r)) continue;
        const src = code(r);
        if (fam.capability === "SYSTEM_ADMIN") {
          check(`${fam.key}: ${r} is SYSTEM_ADMIN-gated`, /require(Fresh)?SystemAdmin\(/.test(src));
        } else {
          check(`${fam.key}: ${r} carries the claimed ${fam.capability} gate`,
            new RegExp(`require(Fresh)?PlatformAccess\\([^)]*"${fam.capability}"\\)`).test(src));
        }
      }
    }

    // Exactly ONE CONTROL family is SHIPPED — the policy editor — and it cites
    // the one CONTROL route (§5). Every other CONTROL family stays PLANNED:
    // maintenance / ingestion holds, scheduler holds, provider enablement and
    // admission overrides are separate product decisions, not this route.
    const controlFamilies = all.filter((f) => f.capability === "CONTROL");
    const shipped = controlFamilies.filter((f) => f.status === "SHIPPED");
    check("exactly one CONTROL family is SHIPPED: control-plane-policy",
      shipped.length === 1 && shipped[0].key === "control-plane-policy", shipped.map((f) => f.key).join(", "));
    check("control-plane-policy cites the policies route and only it",
      JSON.stringify(shipped[0]?.routes) === JSON.stringify(["app/api/platform/platform-ops/policies/route.ts"]));
    for (const fam of controlFamilies.filter((f) => f.key !== "control-plane-policy")) {
      check(`${fam.key}: CONTROL family remains PLANNED`, fam.status === "PLANNED");
    }

    // Unresolved means unresolved — an UNRESOLVED row without a stated tension
    // is a guess wearing a label.
    for (const fam of OPEN_CLASSIFICATIONS) {
      check(`${fam.key}: UNRESOLVED and states its tension`,
        fam.status === "UNRESOLVED" && (fam.tension?.length ?? 0) > 40);
    }
    check("the required families are all classified",
      ["observation", "refresh-request", "ingestion-hold", "scheduler-hold",
       "provider-enablement", "admission-override", "control-plane-policy",
       "grant-administration", "emergency-administration"]
        .every((k) => MUTATION_FAMILIES.some((f) => f.key === k)));
  }

  // ── 8. Scope — OPS-2D-3 did not leak in ─────────────────────────────────────
  console.log("8. No policy, admission, or control machinery entered");
  {
    const touched = [
      "lib/platform/policy.ts",
      "lib/platform/capability-classification.ts",
      "app/api/admin/platform-grants/route.ts",
      "lib/space/mount-context.server.ts",
      "app/api/platform/platform-ops/policies/route.ts",
      "lib/platform/policies/mutate.ts",
    ];
    const forbidden = /\bmayRun\b|JobControlState|JobAdmissionPolicy|declaredPolicy|pausedUntil|admissionResolver/;
    for (const f of touched) {
      check(`${f}: no OPS-2D-3 admission vocabulary`, !forbidden.test(code(f)));
    }
    // No control ENDPOINT was created.
    const controlRoutes = walk("app/api").filter((f) => /\/control\//.test(f));
    check("no control endpoint was created", controlRoutes.length === 0, controlRoutes.join(", "));
  }

  if (failures > 0) {
    console.error(`\ncapability-control.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\ncapability-control.test: all passed.");
}

main();
