/**
 * lib/platform/incidents/incident-boundary.test.ts  (OPS-2D-5A-1)
 *
 * The boundaries the incident lifecycle must not cross, and the censuses that
 * must not quietly change.
 *
 * The specific risk here is duplication. `lib/platform/sync-issue-semantics.ts`
 * has been the shipped authority for domain/severity/nature/state since
 * PRE-V26-PLAID-CLOSE Phase 4, and the obvious way to build a lifecycle on top
 * of it is to "just store severity while we're adding columns" — which is
 * exactly what that authority's own doctrine forbids, because a stored opinion
 * drifts from the rule that produced it. §1 makes that structural.
 *
 * The second risk is a census that stops being one: nine producers are
 * deliberately NOT migrated in this slice, and a list of deferred work is only
 * useful while it is asserted.
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

/** ADOPTED in this slice — execution-aware Plaid producers. */
const ADOPTED = ["lib/plaid/syncTransactions.ts", "lib/plaid/refresh.ts"] as const;

/**
 * DEFERRED to OPS-2D-5A-2 — no execution envelope. Listed with their exact call
 * counts so the census cannot drift silently in either direction.
 */
const DEFERRED = [
  { file: "lib/investments/investment-event-ingest.ts",      sites: 4 },
  { file: "lib/investments/instrument-resolver-import.ts",   sites: 2 },
  { file: "lib/investments/instrument-resolver.ts",          sites: 1 },
  { file: "lib/investments/investment-import-commit.ts",     sites: 1 },
  { file: "lib/investments/opening-position.ts",             sites: 1 },
  { file: "app/api/imports/[id]/rollback/route.ts",          sites: 1 },
] as const;

/** The one producer that bypasses the facade entirely — 5A-2 must not miss it. */
const DIRECT_WRITER = "lib/crypto/btc-sync.ts";

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
    const producers = [...ADOPTED, ...DEFERRED.map((d) => d.file), DIRECT_WRITER, FACADE];
    for (const f of producers) {
      const s = code(f);
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

  // ── 4. Closed censuses ──────────────────────────────────────────────────────
  console.log("4. the adopted and deferred censuses are closed");
  {
    const count = (f: string) => (code(f).match(/recordSyncIssue\(/g) ?? []).length;
    check(`syncTransactions.ts has 3 call sites (got ${count(ADOPTED[0])})`, count(ADOPTED[0]) === 3);
    check(`refresh.ts has 1 call site (got ${count(ADOPTED[1])})`, count(ADOPTED[1]) === 1);
    for (const d of DEFERRED) {
      check(`${d.file}: still deferred, ${d.sites} site(s) (got ${count(d.file)})`, count(d.file) === d.sites);
    }
    const totalDeferred = DEFERRED.reduce((a, d) => a + d.sites, 0);
    check(`deferred total is 10 sites across 6 files (got ${totalDeferred})`, totalDeferred === 10);

    // btc-sync bypasses the facade — the one 5A-2 is most likely to miss.
    check(`${DIRECT_WRITER}: still writes SyncIssue directly (5A-2 target)`,
      /db\.syncIssue\.create\(/.test(code(DIRECT_WRITER)));
    check(`${DIRECT_WRITER}: does not go through the facade`,
      !/recordSyncIssue\(/.test(code(DIRECT_WRITER)));

    // No producer outside the census may reach the lifecycle authority.
    const consumers = [...walk("lib"), ...walk("app"), ...walk("jobs")]
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => !f.startsWith("lib/platform/incidents/"))
      .filter((f) => /recordIncidentObservation\(|resolveByAutomaticRecovery\(/.test(code(f)));
    check("only the facade calls the lifecycle authority",
      consumers.length === 1 && consumers[0] === FACADE, consumers.join(", "));
  }

  // ── 5. Correlation is an FK, not JSON ───────────────────────────────────────
  console.log("5. detail.runId is no longer the relationship authority");
  {
    const lc = code(LIFECYCLE);
    // The seam is the DEFAULT of an injection point, not a bare call — production
    // gets the canonical row-seam lookup; tests pass a hermetic one.
    check("the authority LOOKS UP the correlator through the row seam",
      /LookupExecutionId = getExecutionIdByRunId/.test(lc) && !/refreshExecution\./.test(lc));
    check("the FK is stored, not the raw correlator", /refreshExecutionId: executionId/.test(lc));
    check("the raw correlator is kept only as diagnostics", /runId: obs\.runId \?\? null/.test(lc));
    const proj = code("lib/platform/incidents/projections.ts");
    check("projections read the FK, never detail.runId",
      /refreshExecutionId/.test(proj) && !/detail.*runId|\["runId"\]/.test(proj));
    check("missing correlation is surfaced honestly", /correlationUnavailable/.test(proj));
  }

  // ── 6. Consumers do not infer lifecycle locally ─────────────────────────────
  console.log("6. active/history is decided centrally");
  {
    const proj = code("lib/platform/incidents/projections.ts");
    check("the active projection filters on DERIVED state, not the Boolean",
      /filter\(\(v\) => v\.state === "active"\)/.test(proj));
    check("the historical projection retains everything not active",
      /filter\(\(v\) => v\.state !== "active"\)/.test(proj));
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

  // ── 8. Scope — 5B/5C/5D did not leak in ─────────────────────────────────────
  console.log("8. deferred slices did not start");
  {
    const mine = [LIFECYCLE, IDENTITY, "lib/platform/incidents/projections.ts"];
    for (const f of mine) {
      const s = code(f);
      check(`${f}: no taxonomy split`, !/UPSERT_ERROR_[A-Z]|TRANSACTION_PERSIST_ERROR|ACCOUNT_PERSIST/.test(s));
      check(`${f}: no label enrichment`, !/institutionName|accountMask|operatorGuidance/.test(s));
      check(`${f}: no manual operator resolution`, !/OPERATOR_ACTION|manualResolve|resolveByOperator/.test(s));
      check(`${f}: imports nothing from prototype/ or Growth`,
        !/from\s+["']@?\/?prototype\//.test(s) && !/GrowthStagePanel|FunnelStages|growth-funnel/.test(s));
    }
    const controlRoutes = walk("app/api").filter((f) => /\/incidents?\//.test(f));
    check("no incident browser API was built", controlRoutes.length === 0, controlRoutes.join(", "));
  }

  if (failures > 0) {
    console.error(`\nincident-boundary.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nincident-boundary.test: all passed.");
}

main();
