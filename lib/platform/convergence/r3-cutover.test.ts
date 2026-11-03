/**
 * lib/platform/convergence/r3-cutover.test.ts  (PB-1 Phase 2 R3 — convergence reads module verdicts)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/convergence/r3-cutover.test.ts
 *
 * Synthetic ids only. The reader is a fake; the participant and correlation are real.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { getConvergence } from "@/lib/platform/convergence/convergence";
import { convergenceInstant, syncIssueOutcome, type ConvSyncIssue, type ConvergenceReaders } from "@/lib/platform/convergence/participants";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

function issue(id: string, over: Partial<ConvSyncIssue> = {}): ConvSyncIssue {
  return {
    id, provider: "PLAID", kind: "UPSERT_ERROR", plaidItemId: "item_a", financialAccountId: null,
    rowClass: "incident", state: "active", closure: null, severity: "critical", domain: "transactions",
    operation: "transaction-persist", episodeKey: `key_${id}`,
    firstSeenAt: "2026-11-01T10:00:00.000Z", lastSeenAt: "2026-11-02T10:00:00.000Z", resolvedAt: null,
    subjectLabel: "Bank A", ...over,
  };
}

const NOW = new Date("2026-11-03T12:00:00Z");
function readers(rows: ConvSyncIssue[]): ConvergenceReaders {
  return {
    now: NOW, jobRuns: async () => [], alertRuns: async () => [], syncIssues: async () => rows,
    statusTransitions: async () => [], lifecycleEvents: async () => [],
  };
}

async function main() {
  console.log("outcome is the module's verdict (MODULE_OPEN ⇔ state === \"active\")");
  check("active ⇒ degraded", syncIssueOutcome(issue("a")) === "degraded");
  for (const s of ["acknowledged", "recovering", "stale-unverified"] as const) {
    check(`${s} ⇒ not degraded (action)`, syncIssueOutcome(issue("x", { state: s })) === "action");
  }
  check("resolved (recovered / operator) ⇒ recovery", syncIssueOutcome(issue("r", { state: "resolved", closure: "recovered" })) === "recovery"
    && syncIssueOutcome(issue("o", { state: "resolved", closure: "operator" })) === "recovery");
  check("D2/D2b connection removed ⇒ action, never recovery", syncIssueOutcome(issue("c", { state: "resolved", closure: "connection-removed" })) === "action");
  check("D1 evidence / superseded ⇒ action", syncIssueOutcome(issue("e", { rowClass: "evidence", state: "resolved" })) === "action"
    && syncIssueOutcome(issue("s", { rowClass: "superseded", state: "resolved" })) === "action");

  console.log("D7 — timeline instant");
  check("open rows sit at their latest occurrence", convergenceInstant(issue("a")) === "2026-11-02T10:00:00.000Z");
  check("closed rows sit at their resolution", convergenceInstant(issue("r", { state: "resolved", closure: "recovered", resolvedAt: "2026-11-03T01:00:00.000Z" })) === "2026-11-03T01:00:00.000Z");

  console.log("D8 — one story per incident episode, per subject");
  {
    const res = await getConvergence({ asOf: "2026-11-03", from: "2026-10-20" }, {
      now: NOW,
      readers: readers([
        issue("g1", { episodeKey: "k_shared", state: "resolved", closure: "recovered", resolvedAt: "2026-10-25T00:00:00.000Z" }),
        issue("g2", { episodeKey: "k_shared" }),
        issue("other", { episodeKey: "k_other" }),
      ]),
    });
    const syncEpisodes = res.episodes.filter((e) => e.participants.includes("syncIssue"));
    check("the recurrence pair is one episode; an unrelated incident on the same item is another", syncEpisodes.length === 2
      && syncEpisodes.some((e) => e.events.length === 2), syncEpisodes.map((e) => e.events.length));
    const json = JSON.stringify(res);
    check("no raw stage, no customer id, no detail in the payload", !/"detail":\{|subjectUserId|u_/.test(json));
  }

  console.log("source pins");
  {
    const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const conv = strip(readFileSync(path.join(process.cwd(), "lib/platform/convergence/convergence.ts"), "utf8"));
    const part = strip(readFileSync(path.join(process.cwd(), "lib/platform/convergence/participants.ts"), "utf8"));
    check("convergence reads no SyncIssue directly — only the module's window accessor",
      !/\.syncIssue\./.test(conv) && /incidentAccessors\.window\(incidentToken/.test(conv));
    const syncPart = part.slice(part.indexOf("const syncIssueParticipant"), part.indexOf("const auditTransitionParticipant"));
    check("the sync-issue participant derives no state of its own (no classifier, no syncIssueState, no row detail)",
      syncPart.length > 0 && !/classifySyncIssue|syncIssueState|stageOf|r\.detail/.test(part) && !/r\.detail/.test(syncPart));
    check("no token ⇒ refused (fail closed), never an unscoped read", /if \(!incidentToken\) throw/.test(conv));
  }

  if (failures) { console.error(`\nr3-cutover.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nr3-cutover.test: all passed.");
}

void main();
