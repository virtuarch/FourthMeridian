/**
 * lib/platform/admission/admission-boundary.test.ts  (OPS-2D-3)
 *
 * The boundaries admission must not cross, and the honesty about how far it has
 * actually reached.
 *
 * Two failure modes this guards, both of which look like progress:
 *
 *   1. ADMISSION QUIETLY BECOMES AUTHORIZATION. The evaluator gains a session,
 *      a role, or a capability check "just for the admin case", and from then on
 *      a paused platform reads as a permissions problem. §2 makes the separation
 *      structural: the admission module may not import any authorization
 *      authority at all.
 *
 *   2. PARTIAL ADOPTION IS REPORTED AS UNIVERSAL. One producer consumes the
 *      evaluator, the slice is called done, and the five producers that still
 *      run unadmitted are forgotten. §5 pins the census: every producer is
 *      listed as MIGRATED or NOT, and a producer that changes state without the
 *      list changing fails the build.
 *
 * Run:  npx tsx lib/platform/admission/admission-boundary.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { evaluateAdmission } from "./policy-core";
import { ADMISSION_REASONS, type ControlPlaneFacts } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function exists(rel: string): boolean {
  try { statSync(path.join(ROOT, rel)); return true; } catch { return false; }
}

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "prototype") continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

const MODULE_FILES = [
  "lib/platform/admission/types.ts",
  "lib/platform/admission/policy-core.ts",
  "lib/platform/admission/facts.ts",
];

/**
 * Every producer of refresh-equivalent work, and whether it consumes admission.
 *
 * OPS-2D-3 migrated ONE — the representative path. OPS-2D-4 converged the
 * remaining seven, so the list is now uniformly true. It stays here, and stays
 * asserted against the source, because a census whose entries all agree is
 * exactly when it stops being read: the next producer to be added is the one
 * that will be forgotten, and this fails the moment its state and its label
 * disagree in EITHER direction.
 *
 * Placement, evidence and channel semantics are asserted separately in
 * producer-convergence.test.ts; this file owns the boundary and the ownership.
 */
const PRODUCERS = [
  { file: "app/api/platform/platform-ops/connections/[id]/resync/route.ts", migrated: true,
    note: "representative path — operator-triggered, provable without a provider call" },
  { file: "app/api/plaid/refresh/route.ts",             migrated: true, note: "owner manual refresh" },
  { file: "app/api/plaid/sync/route.ts",                migrated: true, note: "owner manual transaction sync" },
  { file: "app/api/plaid/resume-sync/route.ts",         migrated: true, note: "client-driven import recovery" },
  { file: "app/api/plaid/investments/enable/route.ts",  migrated: true, note: "consent-driven full refresh" },
  { file: "jobs/sync-banks.ts",                         migrated: true, note: "the scheduled batch" },
  { file: "jobs/resume-stale-imports.ts",               migrated: true, note: "the */5 recovery backstop" },
  { file: "lib/plaid/webhook-sync.ts",                  migrated: true, note: "webhook + reconnect wrapper" },
] as const;

function main() {
  // ── 1. Authorization ≠ admission ────────────────────────────────────────────
  console.log("1. admission is not authorization");
  {
    for (const f of MODULE_FILES) {
      const src = code(f);
      check(`${f}: consults no session`, !/requireUser|requireFreshUser|getServerSession|SessionUser/.test(src));
      check(`${f}: consults no grant or capability`,
        !/hasPlatformAccess|requirePlatformAccess|decidePlatformAccess|PlatformGrant|LEVEL_RANK|ISSUABLE_LEVELS/.test(src));
      check(`${f}: consults no role`, !/UserRole|SYSTEM_ADMIN/.test(src));
    }
    // …and the converse: the authorization layer knows nothing about admission.
    for (const f of ["lib/platform/policy.ts", "lib/platform/authorize.ts"]) {
      check(`${f}: unaware of admission`, !/admission|admitOperationalWork|AdmissionVerdict/i.test(code(f)));
    }
  }

  // ── 2. CONTROL is not a bypass; SYSTEM_ADMIN is not a bypass ────────────────
  console.log("2. no capability or role bypasses admission");
  {
    // Structural: there is no input to the evaluator through which an actor
    // could be expressed. The request type carries a work class and nothing else.
    const types = code("lib/platform/admission/types.ts");
    const req = types.slice(types.indexOf("interface AdmissionRequest"));
    check("AdmissionRequest carries only a work class",
      /interface AdmissionRequest \{\s*work: OperationalWork;\s*\}/.test(req));
    check("no actor, principal, role or capability field exists on the request",
      !/userId|actor|principal|role|capability|level/i.test(req.slice(0, req.indexOf("}") + 1)));

    // Behavioural: identical facts yield an identical verdict no matter what,
    // because there is no second argument to vary.
    const paused: ControlPlaneFacts = {
      maintenanceMode: { key: "maintenance_mode", state: "OFF", raw: "false" },
      ingestionPaused: { key: "ingestion_paused", state: "ON",  raw: "true" },
    };
    const v = evaluateAdmission({ work: "REFRESH_EXECUTION" }, paused);
    check("a paused platform denies the only work class there is", v.decision === "DENY");
    check("the denial names the operator's declaration", v.reason === "INGESTION_PAUSED");

    // The one consumer must not weaken it with an escape hatch.
    const consumer = code(PRODUCERS[0].file);
    check("the representative consumer has no admission bypass",
      !/bypass|force|override|skipAdmission|ignoreAdmission/i.test(consumer));
    check("the consumer does not condition admission on the actor",
      !/if\s*\([^)]*auth\.user[^)]*\)[\s\S]{0,120}admitOperationalWork/.test(consumer));
  }

  // ── 3. Admission ≠ concurrency, cooldown, or lifecycle ──────────────────────
  console.log("3. admission absorbed no existing gate");
  {
    for (const f of MODULE_FILES) {
      const src = code(f);
      check(`${f}: no lock concern`, !/SyncLock|claimPlaidItemSyncLock|withPlaidItemSyncLock|IN_FLIGHT/.test(src));
      check(`${f}: no cooldown or rate concern`, !/[Cc]ooldown|limitBy|RateLimit/.test(src));
      check(`${f}: no per-subject lifecycle concern`,
        !/PlaidItem|deactivatedAt|syncIncompleteAt|NEEDS_REAUTH/.test(src));
    }
    // The representative consumer still runs every pre-existing gate.
    const c = code(PRODUCERS[0].file);
    check("consumer keeps its authorization gate", /requireFreshPlatformAccess\([^)]*"WRITE"\)/.test(c));
    check("consumer keeps its item-status gate", /NEEDS_REAUTH/.test(c));
    check("consumer keeps its cooldown gate", /checkManualRefreshCooldown/.test(c));
    check("consumer keeps its lock + in-flight 409", /withPlaidItemSyncLock/.test(c) && /"in-flight"/.test(c));
    // Ordering matters: a denial must not burn the caller's 60-minute cooldown.
    check("admission is evaluated BEFORE the cooldown is consumed",
      c.indexOf("admitOperationalWork") < c.indexOf("markManualRefreshed"));
    // …and AFTER authorization, so an unauthorized caller learns nothing.
    check("admission is evaluated AFTER authorization",
      c.indexOf("requireFreshPlatformAccess") < c.indexOf("admitOperationalWork"));
  }

  // ── 4. Denials are ledgered with registered codes ───────────────────────────
  console.log("4. a denial is evidence, not silence");
  {
    const c = code(PRODUCERS[0].file);
    check("the denial is recorded in the execution ledger", /recordAdmissionDenial\(/.test(c));
    check("the denial answers 503 (platform condition), not 403", /status:\s*503/.test(c));
    check("the response carries the typed reason and the evaluated moment",
      /reason:\s*admission\.reason/.test(c) && /evaluatedAt:\s*admission\.evaluatedAt/.test(c));
    check("the denial is audited", /auditResync\("not-admitted"/.test(c));

    const ledger = code("lib/plaid/refresh-execution.ts");
    check("the ledger stores admissionReason separately from errorSummary",
      /admissionReason/.test(ledger) &&
      !/errorSummary:\s*params\.admissionReason/.test(ledger));
    check("a denied execution derives its status rather than asserting one",
      /overallStatus:\s*deriveOverallStatus\(\[\]\)/.test(ledger));
    check("a denied execution records no stages",
      !/recordAdmissionDenial[\s\S]{0,900}refreshEndpointResult/.test(ledger));

    // Producers cannot invent codes: the only values written come from the
    // registry, via the verdict.
    const registered = Object.keys(ADMISSION_REASONS);
    const literals = [...code(PRODUCERS[0].file).matchAll(/admissionReason:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    check("the consumer writes no hand-typed reason code", literals.length === 0,
      literals.join(", "));
    check(`the registry is the only source of codes (${registered.length} registered)`,
      /admissionReason:\s*admission\.reason/.test(c));
  }

  // ── 5. Adoption is stated honestly ──────────────────────────────────────────
  console.log("5. the producer census is complete and truthful");
  {
    // ANY reach into the admission module counts as consumption — not just the
    // adapter's front door. A producer that imported evaluateAdmission directly
    // would be consuming policy while slipping past a census that only looked
    // for admitOperationalWork(, and the list would silently stop being a list.
    const REACHES_ADMISSION =
      /admitOperationalWork\(|evaluateAdmission\(|resolveControlPlaneFacts\(|readFactState\(|ADMISSION_REASONS|from ["']@\/lib\/platform\/admission/;
    const consumesAdmission = (f: string) => REACHES_ADMISSION.test(code(f));

    for (const p of PRODUCERS) {
      // A censused producer must still EXIST. Without this a rename would drop a
      // producer off the list by making its scan silently unreachable — the exact
      // way a closed census stops being closed.
      check(`${p.file}: still exists (census target is real)`, exists(p.file));
      if (!exists(p.file)) continue;
      const actual = consumesAdmission(p.file);
      check(
        `${p.file}: ${p.migrated ? "MIGRATED" : "not migrated"} — ${p.note}`,
        actual === p.migrated,
        actual ? "consumes admission but is listed as not migrated" : "listed as migrated but does not consume admission",
      );
    }
    // OPS-2D-4: all eight. Asserted as a COUNT so the next producer added to the
    // list forces a deliberate decision rather than defaulting to "migrated".
    check("every censused producer is migrated (OPS-2D-4)",
      PRODUCERS.filter((p) => p.migrated).length === PRODUCERS.length);
    check("the census still holds all eight known producers", PRODUCERS.length === 8);

    // No producer OUTSIDE the census may consume admission.
    const consumers = [...walk("app"), ...walk("jobs"), ...walk("lib")]
      .filter((f) => !f.includes("/admission/"))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => consumesAdmission(f));
    const listed = new Set<string>(PRODUCERS.filter((p) => p.migrated).map((p) => p.file));
    const unlisted = consumers.filter((f) => !listed.has(f));
    check("no unlisted module consumes the evaluator", unlisted.length === 0, unlisted.join(", "));
  }

  // ── 5b. One authority, repo-wide ────────────────────────────────────────────
  //
  // §5 proves nobody consumes policy off-census. This proves nobody REDEFINES
  // it. The two failures look identical from a producer's call site and only the
  // second one fragments the model, so they are asserted separately — and both
  // repo-wide, because the convergence guard's own file list covers only the six
  // paths OPS-2D-1 touched and a fragment could appear anywhere.
  console.log("5b. policy is defined in exactly one place");
  {
    const PRODUCTION = [...walk("app"), ...walk("jobs"), ...walk("lib"), ...walk("components")]
      .filter((f) => !/\.test\.tsx?$/.test(f));

    // (1) The reason registry has ONE declaration site.
    const registries = PRODUCTION.filter((f) => /(const|enum)\s+ADMISSION_REASONS/.test(code(f)));
    check("ADMISSION_REASONS is declared exactly once",
      registries.length === 1 && registries[0] === "lib/platform/admission/types.ts",
      registries.join(", "));

    // (2) Nobody outside the module hardcodes a reason code. Producers must
    //     carry `verdict.reason` through, never re-type the vocabulary.
    const REASON_LITERAL = new RegExp(`"(${Object.keys(ADMISSION_REASONS).join("|")})"`);
    const reasonAuthors = PRODUCTION
      .filter((f) => !f.startsWith("lib/platform/admission/"))
      .filter((f) => REASON_LITERAL.test(code(f)));
    check("no module outside admission/ writes a reason code literal",
      reasonAuthors.length === 0, reasonAuthors.join(", "));

    // (3) Nobody constructs a verdict. A local `{ decision: "DENY" }` is a
    //     second evaluator wearing the canonical type.
    const verdictAuthors = PRODUCTION
      .filter((f) => !f.startsWith("lib/platform/admission/"))
      .filter((f) => /decision:\s*"(ADMIT|DENY)"/.test(code(f)));
    check("no module outside admission/ constructs a verdict",
      verdictAuthors.length === 0, verdictAuthors.join(", "));

    // (4) The raw control-plane keys are readable in exactly two places: the
    //     settings registry that names them and the fact adapter that resolves
    //     them. Anywhere else is a producer parsing policy for itself.
    const FACT_KEYS = /"(maintenance_mode|ingestion_paused)"/;
    const keyReaders = PRODUCTION.filter((f) => FACT_KEYS.test(code(f)));
    check("control-plane keys appear only in the settings registry and the fact adapter",
      keyReaders.every((f) => f === "lib/platform-settings.ts" || f.startsWith("lib/platform/admission/")),
      keyReaders.join(", "));

    // (5) …and no producer reads them through the settings helpers either.
    const settingReaders = PRODUCTION
      .filter((f) => !f.startsWith("lib/platform/admission/") && f !== "lib/platform-settings.ts")
      .filter((f) => /PlatformSettingKey\.(MAINTENANCE_MODE|INGESTION_PAUSED)/.test(code(f)));
    check("no producer reads an admission fact through PlatformSettingKey",
      settingReaders.length === 0, settingReaders.join(", "));
  }

  // ── 6. Scope — no control UI, no broad control plane ────────────────────────
  console.log("6. no control surface was built");
  {
    const controlRoutes = [...walk("app/api")].filter((f) => /\/(control|admission|maintenance|pause)\//.test(f));
    check("no control or admission endpoint exists", controlRoutes.length === 0, controlRoutes.join(", "));
    const ui = [...walk("components"), ...walk("app").filter((f) => /\.tsx$/.test(f))]
      .filter((f) => /maintenance_mode|ingestion_paused|admitOperationalWork/.test(code(f)));
    check("no UI reads or writes control-plane facts", ui.length === 0, ui.join(", "));

    // The facts are settings-shaped, on the EXISTING authority — no second store.
    const settings = code("lib/platform-settings.ts");
    check("both facts are registered PlatformSetting keys",
      /MAINTENANCE_MODE:\s*"maintenance_mode"/.test(settings) &&
      /INGESTION_PAUSED:\s*"ingestion_paused"/.test(settings));
    check("both facts declare a default", /maintenance_mode:\s*"false"/.test(settings) && /ingestion_paused:\s*"false"/.test(settings));
    check("no second settings model was introduced",
      (readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8").match(/model \w*Setting\w* \{/g) ?? []).length === 1);

    // The admin matrix still shows CONTROL as reserved (OPS-2D-2 unchanged).
    const matrix = code("app/admin/platform-access/page.tsx");
    check("CONTROL is still represented and still not issuable",
      /const LEVELS = ALL_ACCESS_LEVELS;/.test(matrix) && /if \(!isIssuableLevel\(level\)\) return;/.test(matrix));
  }

  // ── 7. Design Lab / prototype untouched ─────────────────────────────────────
  console.log("7. no Design Lab or prototype file participates");
  {
    for (const f of [...MODULE_FILES, PRODUCERS[0].file, "lib/plaid/refresh-execution.ts"]) {
      check(`${f}: imports nothing from prototype/`, !/from\s+["']@?\/?prototype\//.test(code(f)));
    }
    const growth = [...walk("components/platform")].filter((f) =>
      /Growth|Funnel/.test(f) && /admitOperationalWork|admissionReason/.test(code(f)));
    check("no Growth / Design Lab component touches admission", growth.length === 0, growth.join(", "));
  }

  if (failures > 0) {
    console.error(`\nadmission-boundary.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nadmission-boundary.test: all passed.");
}

main();
