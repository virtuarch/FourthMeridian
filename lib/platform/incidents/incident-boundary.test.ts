/**
 * lib/platform/incidents/incident-boundary.test.ts  (OPS-2D-5A-1)
 *
 * The boundaries the incident lifecycle must not cross.
 *
 * The specific risk here is duplication. `lib/platform/sync-issue-semantics.ts`
 * has been the shipped authority for domain/severity/nature/state since
 * PRE-V26-PLAID-CLOSE Phase 4, and the obvious way to build a lifecycle on top
 * of it is to "just store severity while we're adding columns" — which is
 * exactly what that authority's own doctrine forbids, because a stored opinion
 * drifts from the rule that produced it. §1 makes that structural.
 *
 * DELIBERATELY ABSENT (pruned in the post-5A-2 guard review): exact call-site
 * counts, pinned source spellings, and the 5B/5C/5D scope fences (those slices
 * have landed; scope fences are deleted the day their slice ships). This file
 * bans VOCABULARY and DEPENDENCIES — never formatting. What a producer is
 * allowed to DO is proven behaviourally in lifecycle.test.ts.
 *
 * Run:  npx tsx lib/platform/incidents/incident-boundary.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
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

const LIFECYCLE = "lib/platform/incidents/lifecycle.ts";
const IDENTITY  = "lib/platform/incidents/identity.ts";
const FACADE    = "lib/plaid/syncIssues.ts";



/**
 * THE PRODUCER CENSUS (OPS-2D-5A-2). Every production SyncIssue writer.
 * Adoption is complete: `btc-sync.ts` — which bypassed the facade entirely and
 * so never converged — is now a facade caller like the rest. Membership is
 * asserted (each file still calls the facade); exact call counts are not — the
 * direct-write ban in §4 is what actually prevents a bypass, and a count only
 * taxes legitimate new error paths.
 */
const ALL_PRODUCERS = [
  { file: "lib/plaid/syncTransactions.ts",                   enveloped: true },
  { file: "lib/plaid/refresh.ts",                            enveloped: true },
  { file: "lib/investments/investment-event-ingest.ts",      enveloped: false },
  { file: "lib/investments/instrument-resolver-import.ts",   enveloped: false },
  { file: "lib/investments/instrument-resolver.ts",          enveloped: false },
  { file: "lib/investments/investment-import-commit.ts",     enveloped: false },
  { file: "lib/investments/opening-position.ts",             enveloped: false },
  { file: "app/api/imports/[id]/rollback/route.ts",          enveloped: false },
  { file: "lib/crypto/btc-sync.ts",                          enveloped: false },
] as const;

/** The ONLY module permitted to touch SyncIssue rows directly. */
const LIFECYCLE_INTERNALS = new Set(["lib/platform/incidents/lifecycle.ts"]);

function main() {
  // ── 1. The semantics authority stays the only classifier ────────────────────
  console.log("1. domain/severity/nature remain derived, in one place");
  {
    const prod = [...walk("lib"), ...walk("app"), ...walk("components")]
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => f !== "lib/platform/sync-issue-semantics.ts");
    const rival = prod.filter((f) => {
      const s = code(f);
      return /(SEVERITY|STAGE_DOMAIN|SyncIssueSeverity)\s*[:=]\s*\{/.test(s) ||
             /function\s+classify(SyncIssue|Issue)\b/.test(s) ||
             /function\s+syncIssueState\b/.test(s);
    });
    check("no second domain/severity/nature classifier exists", rival.length === 0, rival.join(", "));

    // A stored severity is the specific regression this slice must not cause.
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model SyncIssue {"), schema.indexOf("model SyncIssueOccurrence"));
    for (const banned of ["severity", "domain", "nature", "state"]) {
      check(`SyncIssue persists no \`${banned}\` column`,
        !new RegExp(`^\\s+${banned}\\s`, "m").test(model));
    }
    check("the lifecycle authority asks the classifier rather than re-deriving",
      /classifySyncIssue\(/.test(code(LIFECYCLE)));
  }

  // ── 2. One identity builder, one detection service, one resolver ────────────
  console.log("2. exactly one of each authority");
  {
    const prod = [...walk("lib"), ...walk("app")].filter((f) => !/\.test\.tsx?$/.test(f));
    const builders = prod.filter((f) => /export function buildIncidentKey/.test(code(f)));
    check("one incident identity builder", builders.length === 1 && builders[0] === IDENTITY, builders.join(", "));
    const detectors = prod.filter((f) => /export async function recordIncidentObservation/.test(code(f)));
    check("one detection service", detectors.length === 1 && detectors[0] === LIFECYCLE, detectors.join(", "));
    const resolvers = prod.filter((f) => /export async function resolveByAutomaticRecovery/.test(code(f)));
    check("one automatic-resolution service", resolvers.length === 1 && resolvers[0] === LIFECYCLE, resolvers.join(", "));

    // Only AUTOMATIC_RECOVERY exists — no kind without a producer.
    const lc = code(LIFECYCLE);
    for (const unbacked of ["CONNECTION_REMOVED", "REAUTHENTICATED", "OPERATOR_ACTION", "SUPERSEDED"]) {
      check(`no unbacked resolution kind \`${unbacked}\``, !new RegExp(`"${unbacked}"`).test(lc));
    }
    check("AUTOMATIC_RECOVERY is the only kind", /RESOLUTION_KIND_AUTOMATIC = "AUTOMATIC_RECOVERY"/.test(lc));
  }

  // ── 3. Producers submit facts; they decide nothing ──────────────────────────
  console.log("3. producers cannot reach into the lifecycle");
  {
    const producers = [...ALL_PRODUCERS.map((p) => p.file), FACADE];
    for (const f of producers) {
      const s = code(f);
      if (f !== FACADE) check(`${f}: still a facade caller (census is real)`, /recordSyncIssue\(/.test(s));
      check(`${f}: builds no incident key`, !/buildIncidentKey\(/.test(s));
      check(`${f}: queries no active incident`, !/resolved:\s*false[\s\S]{0,80}findFirst|findFirst[\s\S]{0,80}resolved:\s*false/.test(s));
      check(`${f}: creates no occurrence row`, !/syncIssueOccurrence\./.test(s));
      check(`${f}: mutates no lifecycle field`,
        !/(resolvedAt|resolutionKind|resolvingExecutionId|previousIncidentId|incidentKey)\s*:/.test(s));
    }
    // The facade forwards, it does not write.
    check("the facade no longer creates SyncIssue rows itself", !/syncIssue\.create\(/.test(code(FACADE)));
    check("the facade no longer mutates lifecycle fields", !/data:\s*\{\s*resolved:\s*true/.test(code(FACADE)));
  }

  // ── 4. The direct-write ban ─────────────────────────────────────────────────
  console.log("4. every production writer goes through the facade");
  {
    // THE BAN. Any direct row write outside the lifecycle authority is a bypass
    // — that is exactly what btc-sync was, and why its failures never converged.
    const writers = [...walk("lib"), ...walk("app"), ...walk("jobs"), ...walk("components")]
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => !LIFECYCLE_INTERNALS.has(f))
      .filter((f) => /\bsyncIssue\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/.test(code(f)));
    check("no direct SyncIssue write outside the lifecycle authority", writers.length === 0, writers.join(", "));

    const occWriters = [...walk("lib"), ...walk("app"), ...walk("jobs")]
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => !LIFECYCLE_INTERNALS.has(f))
      .filter((f) => /syncIssueOccurrence\.(create|update|delete)/.test(code(f)));
    check("no direct occurrence write outside the lifecycle authority", occWriters.length === 0, occWriters.join(", "));

    // Only the facade may reach the authority.
    const consumers = [...walk("lib"), ...walk("app"), ...walk("jobs")]
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => !f.startsWith("lib/platform/incidents/"))
      .filter((f) => /recordIncidentObservation\(|resolveByAutomaticRecovery\(/.test(code(f)));
    check("only the facade calls the lifecycle authority",
      consumers.length === 1 && consumers[0] === FACADE, consumers.join(", "));

    // Unenveloped producers must not fabricate correlation.
    for (const p of ALL_PRODUCERS.filter((x) => !x.enveloped)) {
      const s2 = code(p.file);
      check(`${p.file}: creates no RefreshExecution`, !/refreshExecution\.create\(/.test(s2));
      check(`${p.file}: infers no execution from timestamps`,
        !/startedAt[\s\S]{0,60}(gte|lte|lt|gt)[\s\S]{0,60}refreshExecution/.test(s2));
    }
  }

  // ── 5. Correlation is an FK, not JSON ───────────────────────────────────────
  console.log("5. detail.runId is no longer the relationship authority");
  {
    const lc = code(LIFECYCLE);
    // The lookup goes through the canonical row seam — the authority must never
    // reach the ledger itself. HOW the seam is spelled (defaults, forwarding,
    // which field carries the FK) is proven behaviourally in lifecycle.test.ts;
    // pinning the spelling here made correct refactors fail.
    check("the authority resolves the correlator via the row seam, never the ledger",
      /getExecutionIdByRunId/.test(lc) && !/refreshExecution\./.test(lc));
    const proj = code("lib/platform/incidents/projections.ts");
    check("projections read the FK, never detail.runId",
      /refreshExecutionId/.test(proj) && !/detail.*runId|\["runId"\]/.test(proj));
    check("missing correlation is surfaced honestly", /correlationUnavailable/.test(proj));
  }

  // ── 6. Consumers do not infer lifecycle locally ─────────────────────────────
  console.log("6. active/history is decided centrally");
  {
    const proj = code("lib/platform/incidents/projections.ts");
    check("projections delegate state to the semantics authority",
      /syncIssueState\(/.test(proj) && !/function syncIssueState/.test(proj));
  }

  // ── 7. Admission separation holds ───────────────────────────────────────────
  console.log("7. a policy denial is not an incident");
  {
    for (const f of ["lib/platform/admission/facts.ts", "lib/platform/admission/policy-core.ts",
                     "lib/plaid/refresh-execution.ts"]) {
      check(`${f}: creates no incident`,
        !/recordIncidentObservation\(|recordSyncIssue\(|syncIssue\./.test(code(f)));
    }
    check("the lifecycle authority knows nothing of admission reasons",
      !/INGESTION_PAUSED|MAINTENANCE_MODE|CONTROL_PLANE_|admissionReason/.test(code(LIFECYCLE)));
  }

  if (failures > 0) {
    console.error(`\nincident-boundary.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nincident-boundary.test: all passed.");
}

main();
