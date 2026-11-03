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
  { file: "lib/investments/instrument-resolver.ts",          enveloped: false },
  // RLS-PREP-2 — the import resolver and the two A7 writers no longer hold a
  // client or call the facade: they RETURN / hand a typed incident to a
  // recorder the route supplies. The facade callers are therefore the routes.
  { file: "app/api/accounts/[id]/import/investments/route.ts", enveloped: false },
  { file: "app/api/investments/opening-position/route.ts",   enveloped: false },
  { file: "app/api/imports/[id]/rollback/route.ts",          enveloped: false },
  { file: "lib/crypto/btc-sync.ts",                          enveloped: false },
] as const;

/**
 * The ONLY modules permitted to touch SyncIssue rows directly. PB-1 Phase 1
 * adds two, deliberately: the account-deletion incident purge and the
 * archive-on-prune retention step — both DELETE, neither observes or resolves.
 */
const LIFECYCLE_INTERNALS = new Set([
  "lib/platform/incidents/lifecycle.ts",
  "lib/platform/incidents/purge.ts",
  "lib/platform/incidents/retention.ts",
]);

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

    const removers = prod.filter((f) => /export async function resolveBySubjectRemoval/.test(code(f)));
    check("one subject-removal service", removers.length === 1 && removers[0] === LIFECYCLE, removers.join(", "));

    // PB-1 S2 — DELIBERATE PIN UPDATE (was: "AUTOMATIC_RECOVERY is the only kind").
    // The kind set is exactly these three; each has one writer or is declared for
    // the invariant only (OPERATOR_RESOLVED — its writer is S6).
    const lc = code(LIFECYCLE);
    const inv = code("lib/platform/incidents/invariant.ts");
    for (const unbacked of ["CONNECTION_REMOVED", "REAUTHENTICATED", "OPERATOR_ACTION", "SUPERSEDED"]) {
      check(`no unbacked resolution kind \`${unbacked}\``, !new RegExp(`"${unbacked}"`).test(lc) && !new RegExp(`"${unbacked}"`).test(inv));
    }
    check("the resolution kinds are exactly AUTOMATIC_RECOVERY, OPERATOR_RESOLVED, SUBJECT_REMOVED",
      /RESOLUTION_KINDS = \["AUTOMATIC_RECOVERY", "OPERATOR_RESOLVED", "SUBJECT_REMOVED"\] as const/.test(inv)
      && /RESOLUTION_KIND_AUTOMATIC = "AUTOMATIC_RECOVERY"/.test(lc)
      && /RESOLUTION_KIND_SUBJECT_REMOVED = "SUBJECT_REMOVED"/.test(lc)
      && /RESOLUTION_KIND_OPERATOR = "OPERATOR_RESOLVED"/.test(lc));
    check("OPERATOR_RESOLVED has no writer yet (S6 owns applyOperatorTransition)",
      !/resolutionKind:\s*RESOLUTION_KIND_OPERATOR/.test(lc) && !/applyOperatorTransition/.test(lc));
    check("SUBJECT_REMOVED is never written as a recovery (its writer names its own kind)",
      /resolutionKind:\s*RESOLUTION_KIND_SUBJECT_REMOVED/.test(lc));
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
      .filter((f) => /recordIncidentObservation\(|resolveByAutomaticRecovery\(|resolveBySubjectRemoval\(/.test(code(f)));
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
    // PB-4 — through episodes-core's ONE row → state call (shared with the CS trend), which delegates to the authority.
    const episodes = code("lib/platform/incidents/episodes-core.ts");
    check("projections delegate state to the semantics authority",
      /episodeStateOf\(/.test(proj) && /from "\.\/episodes-core"/.test(proj) && !/function syncIssueState/.test(proj)
      && /syncIssueState\(/.test(episodes) && !/function syncIssueState/.test(episodes));
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

  // ── 8. PB-1 Phase 1 — provenance is append-only, evidence is typed ─────────
  console.log("8. the chronology, the archive and the evidence have one writer each");
  {
    // Disposable-PG harnesses (scripts/test-*.ts) reset their own throwaway
    // database and refuse any other; they are fixtures, not product code.
    // The RLS acceptance suite issues raw SQL against these tables ON PURPOSE, to
    // prove the database REFUSES it (cases 42-48: UPDATE / backdated INSERT denied
    // by grant). It runs only against a throwaway clone. Exempted by exact path —
    // ONE file, pinned below to keep proving refusal — never by loosening a pattern.
    const ACCEPTANCE_PROBES = new Set(["scripts/rls-acceptance.ts"]);
    const prod = [...walk("lib"), ...walk("app"), ...walk("jobs"), ...walk("components"), ...walk("scripts")]
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => !/^scripts\/test-[\w-]+\.ts$/.test(f))
      .filter((f) => !ACCEPTANCE_PROBES.has(f));
    check("the acceptance-probe exemption covers exactly one file",
      ACCEPTANCE_PROBES.size === 1 && ACCEPTANCE_PROBES.has("scripts/rls-acceptance.ts"));
    {
      const probes = code("scripts/rls-acceptance.ts");
      check("…and that file still asserts the refusals it is exempted for (append-only, no backdating)",
        /can NOT update an incident event \(append-only\)/.test(probes) && /can NOT supply `at` \(no backdating\)/.test(probes)
        && /deniedByGrant\(upd\)/.test(probes) && /deniedByGrant\(back\)/.test(probes));
    }
    const touching = (re: RegExp) => prod.filter((f) => re.test(code(f)));
    check("SyncIssueEvent is never updated anywhere (append-only)",
      touching(/syncIssueEvent\.(update|updateMany|upsert)\(|UPDATE\s+"?SyncIssueEvent/i).length === 0);
    const eventDeleters = touching(/syncIssueEvent\.(delete|deleteMany)\(|DELETE\s+FROM\s+"?SyncIssueEvent/i);
    check("SyncIssueEvent is deleted ONLY by the purge and the retention prune",
      eventDeleters.every((f) => f === "lib/platform/incidents/purge.ts" || f === "lib/platform/incidents/retention.ts")
      && eventDeleters.length === 2, eventDeleters.join(", "));
    const eventWriters = touching(/syncIssueEvent\.(create|createMany)\(|INSERT\s+INTO\s+"?SyncIssueEvent/i);
    check("SyncIssueEvent is written ONLY by the lifecycle authority",
      eventWriters.length === 1 && eventWriters[0] === LIFECYCLE, eventWriters.join(", "));
    const archiveWriters = touching(/syncIssueArchive\.(create|createMany|update|updateMany|upsert)\(/);
    check("SyncIssueArchive is written ONLY by the archive-on-prune step",
      archiveWriters.length === 1 && archiveWriters[0] === "lib/platform/incidents/retention.ts", archiveWriters.join(", "));
    check("the archive row is shaped ONLY by the allowlist builder", /buildArchiveRow\(/.test(code("lib/platform/incidents/retention.ts")));
    const lc = code(LIFECYCLE);
    // The evidence columns may be NAMED only where they are built, copied through
    // the builder, or exported read-only; the write forms are pinned in place.
    const EVIDENCE_FILES = new Set([
      LIFECYCLE, "lib/platform/incidents/evidence.ts", "lib/platform/incidents/archive-core.ts",
      "lib/platform/incidents/retention.ts", "lib/platform/incidents/invariant.ts", "lib/platform/incidents/subject-export.ts",
    ]);
    const evidenceNamers = touching(/\bresolutionEvidence\b/).filter((f) => !EVIDENCE_FILES.has(f));
    check("resolutionEvidence is touched only by its builder, the archive copy and the export",
      evidenceNamers.length === 0, evidenceNamers.join(", "));
    check("lifecycle writes resolutionEvidence only from buildResolutionEvidence",
      /const evidence = buildResolutionEvidence\(/.test(lc) && /resolutionEvidence:\s*evidence as unknown/.test(lc));
    check("the archive copy re-builds it through the typed reshaper",
      /resolutionEvidence:\s*reshapeStoredEvidence\(/.test(code("lib/platform/incidents/archive-core.ts")));
    const summaryNamers = touching(/\bevidenceSummary\b/).filter((f) => f !== LIFECYCLE && f !== "lib/platform/incidents/evidence.ts");
    check("evidenceSummary is written ONLY via buildOccurrenceEvidenceSummary",
      summaryNamers.length === 0 && /evidenceSummary:\s*buildOccurrenceEvidenceSummary\(/.test(lc), summaryNamers.join(", "));
    check("a transition is a CAS that THROWS on 0 rows, inside one transaction with its event",
      /\$transaction\(async \(tx\)/.test(lc) && /lifecycleState:\s*c\.lifecycleState/.test(lc)
      && /if \(count !== 1\) throw new IncidentTransitionConflictError/.test(lc));
  }

  // ── 9. PB-1 S3 — every removal path closes its subject's incidents ────────
  console.log("9. removal closes incidents as SUBJECT_REMOVED; restore never reopens");
  {
    for (const f of ["lib/accounts/disconnect.ts", "lib/plaid/disconnect.ts", "lib/account-deletion/purge.ts"]) {
      check(`${f}: calls the subject-removal facade`, /resolveIncidentsForRemovedSubjects|resolveRemovedSubjects/.test(code(f)));
    }
    const restore = code("app/api/accounts/[id]/restore/route.ts");
    check("restore does not reopen a closed episode (no incident code at all)",
      !/syncIssue|incidents\/|recordSyncIssue|resolveIncidents/.test(restore));
  }

  // ── 10. RLS — the tenant role's column grant is unchanged ─────────────────
  console.log("10. fm_app still reads only the RLS-16 columns of SyncIssue");
  {
    const dir = path.join(ROOT, "prisma/migrations");
    const grants: string[] = [];
    for (const m of readdirSync(dir)) {
      let sql = "";
      try { sql = readFileSync(path.join(dir, m, "migration.sql"), "utf8"); } catch { continue; }
      sql = sql.replace(/--.*$/gm, "");
      for (const g of sql.match(/GRANT[^;]*ON\s+TABLE\s+public\."SyncIssue(Occurrence|Event|Archive|Relation)?"[^;]*TO\s+fm_app[^;]*;/g) ?? []) grants.push(`${m}: ${g.replace(/\s+/g, " ")}`);
    }
    check("exactly one fm_app grant on the incident tables, the RLS-16 six columns",
      grants.length === 1 && grants[0].startsWith("20261002000500_rls_app_sync_issue_read")
      && /"id", "kind", "resolved", "createdAt", "financialAccountId", "plaidTransactionId"/.test(grants[0]), grants.join(" | "));
  }

  // ── 11. PB-1 Phase 2 FINAL — open/closed is the intelligence module's ──────
  // Every production file that reads SyncIssue ROWS (a Prisma read on syncIssue) or calls a legacy
  // row → state helper, outside the module, is CENSUSED here with why it may. An unlisted file fails;
  // a listed file that no longer matches fails too (the census only shrinks by a reviewed change).
  // None of the six cut-over readers (R1–R6, PB-1 §13.1) may appear: their open/closed is the module's.
  console.log("11. no reader outside the intelligence module decides open/closed from SyncIssue rows");
  {
    const RAW_READ = /\.syncIssue\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|groupBy|aggregate)\(|\b(syncIssueState|episodeStateOf|incidentEpisodes)\(/;
    const CENSUS: Readonly<Record<string, string>> = {
      // The lifecycle authority and its two DELETE-only steps (§2 LIFECYCLE_INTERNALS): they WRITE open/closed.
      "lib/platform/incidents/lifecycle.ts": "lifecycle writer",
      "lib/platform/incidents/purge.ts": "lifecycle internal (account-deletion purge; selects ids to delete)",
      "lib/platform/incidents/retention.ts": "lifecycle internal (archive-on-prune; copies rows it deletes)",
      // The semantics authority itself (defines syncIssueState; §1 pins it as the only classifier).
      "lib/platform/sync-issue-semantics.ts": "semantics authority (definition)",
      // Copies a customer's rows, `resolved` included as a FACT, into their export; decides nothing.
      "lib/platform/incidents/subject-export.ts": "subject export (verbatim facts)",
      // The wallet-sync incident's LAST FAILURE INSTANT (max lastOccurredAt) — a clock, not an open/closed verdict.
      "lib/crypto/wallet-refresh.ts": "failure clock (no state)",
      // PERMANENT EXCEPTION (S2 ruling, 2026-11-03) — shape pinned below.
      "lib/plaid/backgroundHistorySync.ts": "EXCEPTION: control gate, not a display read (MISSING_ACCOUNT persisted-open COUNT gates recovery)",
      // KNOWN RESIDUALS — not among PB-1 §13.1's six readers; each still derives open/closed from rows.
      // Listed so they cannot multiply; each is a PB-1 Phase 3 item (S2 rulings, 2026-11-03).
      // getIncidentDetail stays on this file's entry by ruling: execution evidence only; state ignored.
      "lib/platform/incidents/projections.ts": "RESIDUAL: getIncidentEpisodeTimeline (CS daily trend) · KEPT: getIncidentDetail — execution evidence only; state ignored",
      "lib/platform/incidents/episodes-core.ts": "RESIDUAL: the legacy episode fold the CS daily trend uses",
      // PB-1 Phase 3 (S2-approved design a) — fm_app tenant read of the RLS-16 columns; the open/closed
      // decision is the module's PURE core (lib/activity/member-incidents.ts, audience MEMBER).
      "app/api/spaces/[id]/activity/route.ts": "raw read; open/closed decision from module core",
    };
    const found = [...walk("lib"), ...walk("app"), ...walk("components")]
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => !f.startsWith("lib/platform/incidents/intelligence/") && !f.startsWith("lib/platform/incidents/parity/"))
      .filter((f) => RAW_READ.test(code(f)))
      .sort();
    const unlisted = found.filter((f) => !(f in CENSUS));
    const stale = Object.keys(CENSUS).filter((f) => !found.includes(f));
    check("every SyncIssue row reader / legacy state caller outside the module is censused", unlisted.length === 0, unlisted.join(", "));
    check("…and every census entry still matches (the census only shrinks by a reviewed change)", stale.length === 0, stale.join(", "));
    const CUT_OVER = [
      "lib/platform/customer/", // R1 customer-core, R2 customer-detail, R6b attention
      "lib/platform/convergence/", // R3
      "lib/alerts/", // R5
      "lib/platform/ops/", // R6a
    ];
    const leaks = found.filter((f) => CUT_OVER.some((d) => f.startsWith(d)));
    check("none of the cut-over readers (R1–R3, R5, R6a, R6b) reads SyncIssue rows or a legacy state helper", leaks.length === 0, leaks.join(", "));
    // The control-gate exception's SHAPE (S2): exactly one SyncIssue read in the file — a COUNT over
    // MISSING_ACCOUNT with resolved=false, scoped to the item (and the legacy resolvedAt=null guard);
    // no select, no detail, no other kind. Anything wider is a new reader and fails here.
    const gate = code("lib/plaid/backgroundHistorySync.ts");
    const gateReads = gate.match(new RegExp(RAW_READ.source, "g")) ?? [];
    check("backgroundHistorySync: its ONE SyncIssue read is a COUNT", gateReads.length === 1 && gateReads[0] === ".syncIssue.count(", gateReads.join(", "));
    check("…over MISSING_ACCOUNT, resolved=false, per item — no select, no detail",
      /\.syncIssue\.count\(\{\s*where: \{ plaidItemId: id, kind: SyncIssueKind\.MISSING_ACCOUNT, resolvedAt: null, resolved: false \},?\s*\}\)/.test(gate)
      && !/\.syncIssue\.count\(\{[^)]*(select|detail|include)/.test(gate));
    check("…and the revisit note (derived module-only closure on MISSING_ACCOUNT) stays beside it",
      /REVISIT if the intelligence module ever applies a module-only \(derived,\s*\n?\s*\/\/ not persisted\) closure to MISSING_ACCOUNT/.test(readFileSync(path.join(ROOT, "lib/plaid/backgroundHistorySync.ts"), "utf8")));
    const proj = code("lib/platform/incidents/projections.ts");
    // KEPT by ruling: getIncidentDetail is execution evidence only — its single consumer (Ops attention) reads
    // occurrences, never the derived state.
    const opsAtt = code("lib/platform/ops/attention.ts");
    check("getIncidentDetail's only consumer reads occurrences, never its state",
      /getIncidentDetail\(v\.id\)/.test(opsAtt) && /detail\?\.occurrences\.find/.test(opsAtt) && !/detail\?\.incident|\.incident\.state/.test(opsAtt));
    const page = proj.slice(proj.indexOf("export async function getActiveIncidentPage"));
    const pageBody = page.slice(0, page.indexOf("\n}\n") + 3);
    check("R4: getActiveIncidentPage reads the module (brokenNow) and no SyncIssue row",
      /incidentAccessors\.brokenNow\(token,/.test(pageBody) && !RAW_READ.test(pageBody) && !/resolved/.test(pageBody), pageBody.slice(0, 200));
  }

  if (failures > 0) {
    console.error(`\nincident-boundary.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nincident-boundary.test: all passed.");
}

main();
