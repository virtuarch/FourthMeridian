/**
 * lib/platform/incidents/episodes-core.test.ts  (PB-4 → PB-1 Phase 3 — the one legacy row → state call)
 *
 * PB-1 Phase 3 moved the Customer Success trend onto module verdicts
 * (lib/platform/customer/incident-trend-core.test.ts carries the PB-4 owner case
 * now). What remains here is `episodeStateOf`, kept ONLY for getIncidentDetail's
 * IncidentView (S2: "execution evidence only; state ignored").
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/episodes-core.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { syncIssueState } from "@/lib/platform/sync-issue-semantics";
import { episodeStateOf } from "./episodes-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("1. episodeStateOf delegates to the semantics authority, unchanged");
{
  const cases = [
    { kind: "REMOVED_TOMBSTONE", provider: "PLAID", detail: {}, plaidTransactionId: "ptx", resolved: true },
    { kind: "TRANSACTION_PERSISTENCE_FAILED", provider: "PLAID", detail: {}, plaidTransactionId: null, resolved: false },
    { kind: "TRANSACTION_PERSISTENCE_FAILED", provider: "PLAID", detail: {}, plaidTransactionId: null, resolved: true },
    { kind: "BALANCE_TX_MISMATCH", provider: "PLAID", detail: {}, plaidTransactionId: null, resolved: false },
  ];
  for (const c of cases) for (const referentExists of [true, false]) {
    check(`${c.kind} resolved=${c.resolved} referent=${referentExists}`,
      episodeStateOf(c, referentExists) === syncIssueState({ kind: c.kind, provider: c.provider, detail: c.detail, plaidTransactionId: c.plaidTransactionId }, { referentExists, resolved: c.resolved }));
  }
}

console.log("2. who still calls it (source pins)");
{
  const proj = code("lib/platform/incidents/projections.ts");
  check("projections derive the IncidentView state through episodeStateOf, never syncIssueState directly", /state: episodeStateOf\(r, referentExists\)/.test(proj) && !/syncIssueState\(/.test(proj));
  {
    const page = proj.slice(proj.indexOf("export async function getActiveIncidentPage"), proj.indexOf("export async function getIncidentDetail"));
    check("the active page reads the module's derived broken-now set, never raw resolved=false",
      /incidentAccessors\.brokenNow\(token, \{ limit \}\)/.test(page) && !/resolved:\s*false/.test(page) && !/syncIssue\./.test(page));
  }
  check("PB-1 Phase 3: the legacy episode timeline and fold are gone", !/getIncidentEpisodeTimeline|incidentEpisodes\(/.test(proj) && !/incidentEpisodes|isIncidentEpisodeState/.test(code("lib/platform/incidents/episodes-core.ts")));
  const daily = code("lib/platform/customer/incidents-daily.ts");
  check("the CS trend no longer reads the projections or episodes-core", !/projections|episodes-core|episodeStateOf/.test(daily));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
