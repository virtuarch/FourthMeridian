/**
 * lib/platform/incidents/invariant.test.ts  (OPS-2D-5A-1)
 *
 * EVENT evidence is not a recovered CONDITION.
 *
 * Both are stored `resolved = true`, which is precisely why this file exists.
 * The column carries two meanings — "recovered, here is when" for a condition,
 * "terminal, nothing will change it" for an event — and the failure mode is
 * someone noticing that events have a null `resolvedAt` and "fixing" the
 * inconsistency by stamping a timestamp. That turns forensic evidence into a
 * recovery that never happened, which is the exact class of lie the sync-issue
 * semantics authority was built to prevent.
 *
 * Run:  npx tsx lib/platform/incidents/invariant.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { lifecycleViolation, isLegacyRow } from "./invariant";
import { syncIssueState, classifySyncIssue } from "@/lib/platform/sync-issue-semantics";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function walk(dir: string, out: string[] = []): string[] {
  let e; try { e = readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const x of e) {
    if (x.name === "node_modules" || x.name === ".next" || x.name === "prototype") continue;
    const rel = path.join(dir, x.name);
    if (x.isDirectory()) walk(rel, out); else if (/\.tsx?$/.test(x.name)) out.push(rel);
  }
  return out;
}

const ACTIVE    = { resolved: false, resolvedAt: null, resolutionKind: null, resolvingExecutionId: null, incidentKey: "k" };
const RECOVERED = { resolved: true, resolvedAt: new Date(), resolutionKind: "AUTOMATIC_RECOVERY", resolvingExecutionId: "e1", incidentKey: "k" };
const EVENT     = { resolved: true, resolvedAt: null, resolutionKind: null, resolvingExecutionId: null, incidentKey: null };

function main() {
  // ── 1. The written contract ─────────────────────────────────────────────────
  console.log("1. the three legal shapes, and only those");
  {
    check("active CONDITION is legal", lifecycleViolation("condition", ACTIVE) === null);
    check("recovered CONDITION is legal", lifecycleViolation("condition", RECOVERED) === null);
    check("EVENT is legal", lifecycleViolation("event", EVENT) === null);

    // The six contradictions the brief names.
    check("CONDITION resolved without resolvedAt is refused",
      lifecycleViolation("condition", { ...RECOVERED, resolvedAt: null }) !== null);
    check("CONDITION active WITH resolvedAt is refused",
      lifecycleViolation("condition", { ...ACTIVE, resolvedAt: new Date() }) !== null);
    check("CONDITION active with a resolutionKind is refused",
      lifecycleViolation("condition", { ...ACTIVE, resolutionKind: "AUTOMATIC_RECOVERY" }) !== null);
    check("EVENT with a resolutionKind is refused",
      lifecycleViolation("event", { ...EVENT, resolutionKind: "AUTOMATIC_RECOVERY" }) !== null);
    check("EVENT with a resolvingExecutionId is refused",
      lifecycleViolation("event", { ...EVENT, resolvingExecutionId: "e1" }) !== null);
    // The one that would quietly rewrite history.
    check("EVENT with a resolvedAt is refused",
      lifecycleViolation("event", { ...EVENT, resolvedAt: new Date() }) !== null);
    check("EVENT with an incidentKey is refused (events never converge)",
      lifecycleViolation("event", { ...EVENT, incidentKey: "k" }) !== null);
    check("recovered CONDITION without a kind is refused",
      lifecycleViolation("condition", { ...RECOVERED, resolutionKind: null }) !== null);
  }

  // ── 2. The projection never conflates the two ───────────────────────────────
  console.log("2. resolved=true alone never means recovered");
  {
    const ev = { kind: "REMOVED_TOMBSTONE", provider: "PLAID", detail: {} };
    const cond = { kind: "UPSERT_ERROR", provider: "PLAID", plaidTransactionId: "t1",
                   detail: { stage: "transaction-persist", cursorBlocking: true } };
    check("EVENT nature is derived, not stored", classifySyncIssue(ev).nature === "event");
    check("an EVENT with resolved=true projects as evidence",
      syncIssueState(ev, { referentExists: true, resolved: true }) === "evidence");
    check("an EVENT with resolved=false ALSO projects as evidence (never active)",
      syncIssueState(ev, { referentExists: true, resolved: false }) === "evidence");
    check("a CONDITION with resolved=true projects as recovered",
      syncIssueState(cond, { referentExists: true, resolved: true }) === "recovered");
    check("a CONDITION with resolved=false projects as active",
      syncIssueState(cond, { referentExists: true, resolved: false }) === "active");
    // Same Boolean, two states — the whole reason the invariant is not universal.
    check("identical `resolved` yields different states by nature",
      syncIssueState(ev, { referentExists: true, resolved: true }) !==
      syncIssueState(cond, { referentExists: true, resolved: true }));
  }

  // ── 3. Legacy compatibility is separate from enforcement ────────────────────
  console.log("3. legacy rows are read, never judged or rewritten");
  {
    // A legacy recovered CONDITION has no resolvedAt — there was no such column.
    const legacyRecovered = { resolved: true, resolvedAt: null, resolutionKind: null,
                              resolvingExecutionId: null, incidentKey: null };
    check("a legacy row is identifiable structurally", isLegacyRow(legacyRecovered, 0));
    check("a newly written row is not legacy", !isLegacyRow(RECOVERED, 1));
    // It WOULD violate the new-write rule — which is exactly why enforcement is
    // scoped to writes and never applied to reads.
    check("the same shape would be refused as a NEW write",
      lifecycleViolation("condition", legacyRecovered) !== null);
    check("…yet it still projects as recovered, not as an error",
      syncIssueState({ kind: "UPSERT_ERROR", provider: "PLAID", plaidTransactionId: "t1",
                       detail: { stage: "transaction-persist" } },
                     { referentExists: true, resolved: true }) === "recovered");
    // The dangerous shortcut: "resolved=true + resolvedAt=null ⇒ event".
    check("a legacy resolved CONDITION is NOT reclassified as an event",
      classifySyncIssue({ kind: "UPSERT_ERROR", provider: "PLAID", plaidTransactionId: "t1",
                          detail: { stage: "transaction-persist" } }).nature === "condition");
  }

  // ── 4. Enforcement lives at the write boundary, in one place ────────────────
  console.log("4. one invariant authority, applied where writes happen");
  {
    const prod = [...walk("lib"), ...walk("app"), ...walk("components")]
      .filter((f) => !/\.test\.tsx?$/.test(f));
    const owners = prod.filter((f) => /export function lifecycleViolation/.test(code(f)));
    check("one invariant authority", owners.length === 1, owners.join(", "));

    const lc = code("lib/platform/incidents/lifecycle.ts");
    // That the lifecycle actually applies the invariant — and refuses rather
    // than throws — is proven behaviourally in lifecycle.test.ts. Here we only
    // assert the dependency exists; counting call sites or pinning the refusal's
    // control-flow shape made harmless refactors fail.
    check("the lifecycle consumes the invariant authority", /lifecycleViolation\(/.test(lc));
    check("the resolver cannot reach an event",
      /nature === "condition"/.test(lc));

    // Nature is never persisted to make this cheaper to check.
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model SyncIssue {"), schema.indexOf("model SyncIssueOccurrence"));
    check("nature is not stored", !/^\s+nature\s/m.test(model));
    check("the invariant module classifies nothing", !/classifySyncIssue|STAGE_DOMAIN/.test(code("lib/platform/incidents/invariant.ts")));

    // No consumer rebuilds the distinction.
    const rebuilders = prod
      .filter((f) => !f.startsWith("lib/platform/incidents/") && f !== "lib/platform/sync-issue-semantics.ts")
      .filter((f) => /resolved[\s\S]{0,40}\?\s*"recovered"|"evidence"\s*:/.test(code(f)));
    check("no consumer reconstructs recovered-vs-evidence", rebuilders.length === 0, rebuilders.join(", "));
  }

  if (failures > 0) { console.error(`\ninvariant.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ninvariant.test: all passed.");
}

main();
