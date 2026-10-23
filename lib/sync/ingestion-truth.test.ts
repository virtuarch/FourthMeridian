/**
 * lib/sync/ingestion-truth.test.ts  (2026-10-06, Preview Plaid Sandbox lane)
 *
 * The Connections surface may say work is happening ONLY when the refresh ledger
 * shows work happening. Two live defects on one Sandbox Item motivated this:
 *
 *   1. Its first-run import failed at page 2 (MUTATION_DURING_PAGINATION). The
 *      card said "Transaction history importing… 100 imported" with nothing
 *      running — `syncIncompleteAt` set was read as "importing".
 *   2. After recovery through the browser resume, the card said "Building your
 *      timeline — this finishes in the background" with nothing building it —
 *      "transactions ready, no anchor" was read as "rebuilding", and that resume
 *      path never wrote the anchor at all.
 *
 *   npx tsx lib/sync/ingestion-truth.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveIngestionActivity, INGESTION_ACTIVITY_STALE_MS, type IngestionActivity } from "./deferred-ingestion";
import { buildSyncStatus, deriveConnectionState, type PlaidItemStateInput } from "./status";
import { deriveConnectionIntelligence, isBuildingIntelligence } from "../connections/intelligence";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (f: string) => readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-10-06T20:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

const item = (over: Partial<PlaidItemStateInput> = {}): PlaidItemStateInput => ({
  id: "item_1", institutionName: "First Platypus Bank - OAuth", status: "ACTIVE",
  syncIncompleteAt: ago(30 * MIN), syncImportedCount: 100, lastSyncedAt: null, errorCode: null, ...over,
});
const stateOf = (i: PlaidItemStateInput, a?: IngestionActivity) => deriveConnectionState(i, null, a, NOW);

function main(): void {
  console.log("1. Activity is POSITIVE evidence from the ledger, bounded by freshness");
  {
    const exec = (overallStatus: string, startedAgoMs: number, admissionReason: string | null = null) =>
      ({ overallStatus, admissionReason, startedAt: ago(startedAgoMs) });
    check("a fresh lock ⇒ RUNNING", deriveIngestionActivity({ syncLockedAt: ago(MIN), latestExecution: exec("FAILED", 9 * MIN) }, NOW) === "RUNNING");
    check("a fresh RUNNING execution ⇒ RUNNING", deriveIngestionActivity({ syncLockedAt: null, latestExecution: exec("RUNNING", 2 * MIN) }, NOW) === "RUNNING");
    check("a stale lock is not work ⇒ IDLE", deriveIngestionActivity({ syncLockedAt: ago(7 * MIN), latestExecution: exec("FAILED", 9 * MIN) }, NOW) === "IDLE");
    check("a stale RUNNING row (killed process) is not work ⇒ IDLE", deriveIngestionActivity({ syncLockedAt: null, latestExecution: exec("RUNNING", 7 * MIN) }, NOW) === "IDLE");
    check("the last attempt FAILED, nothing running ⇒ IDLE", deriveIngestionActivity({ syncLockedAt: null, latestExecution: exec("FAILED", MIN) }, NOW) === "IDLE");
    check("the last attempt SUCCEEDED, nothing running ⇒ IDLE", deriveIngestionActivity({ syncLockedAt: null, latestExecution: exec("SUCCEEDED", MIN) }, NOW) === "IDLE");
    check("SKIPPED for a policy reason ⇒ DEFERRED", deriveIngestionActivity({ syncLockedAt: null, latestExecution: exec("SKIPPED", MIN, "PLATFORM_PAUSED") }, NOW) === "DEFERRED");
    check("SKIPPED without a reason (lock contention) is not deferral ⇒ IDLE", deriveIngestionActivity({ syncLockedAt: null, latestExecution: exec("SKIPPED", MIN) }, NOW) === "IDLE");
    check("no execution ever ⇒ UNKNOWN", deriveIngestionActivity({ syncLockedAt: null, latestExecution: null }, NOW) === "UNKNOWN");
    const ttl = /LOCK_TTL_MS\s*=\s*([\d_]+)/.exec(code("lib/plaid/sync-lock.ts"))?.[1]?.replace(/_/g, "");
    check("the freshness bound equals the sync-lock TTL", Number(ttl) === INGESTION_ACTIVITY_STALE_MS, `${ttl} vs ${INGESTION_ACTIVITY_STALE_MS}`);
  }

  console.log("2. Transaction state: importing only while work is running");
  {
    check("REGRESSION: an unfinished import with nothing running is import_paused, NOT importing (the '100 imported' card)",
      stateOf(item(), "IDLE") === "import_paused");
    check("a genuinely running import still reads importing", stateOf(item(), "RUNNING") === "importing");
    check("a mutation-restart in flight is importing — not prematurely ready",
      stateOf(item({ syncImportedCount: 0 }), "RUNNING") === "importing");
    check("a failed attempt never reads ready while the import is unfinished", stateOf(item(), "IDLE") !== "ready");
    check("policy-held stays sync_deferred", deriveConnectionState(item(), { reason: "PLATFORM_PAUSED" }, "DEFERRED", NOW) === "sync_deferred");
    check("no execution yet, marker fresh (a Link exchange starting) ⇒ importing",
      stateOf(item({ syncIncompleteAt: ago(20_000) }), "UNKNOWN") === "importing");
    check("no execution, marker old ⇒ import_paused, not an indefinite spinner",
      stateOf(item({ syncIncompleteAt: ago(30 * MIN) }), "UNKNOWN") === "import_paused");
    check("a completed import is ready whatever the ledger says",
      (["RUNNING", "IDLE", "UNKNOWN"] as const).every((a) => stateOf(item({ syncIncompleteAt: null }), a) === "ready"));
    check("a fresh history-rebuild marker reads importing", stateOf(item({ syncIncompleteAt: null, historyBuildStartedAt: ago(MIN) }), "IDLE") === "importing");
    check("a STALE history-rebuild marker (killed process) reads ready, not importing forever",
      stateOf(item({ syncIncompleteAt: null, historyBuildStartedAt: ago(30 * MIN) }), "IDLE") === "ready");
    check("revocation still removes the connection", stateOf(item({ status: "REVOKED" }), "RUNNING") === null);
    check("callers that resolve no activity keep the prior behaviour", stateOf(item()) === "importing");
    check("reload/revisit: the same inputs give the same state", stateOf(item(), "IDLE") === stateOf(item(), "IDLE"));

    const view = buildSyncStatus([item()], new Map(), new Map([["item_1", "IDLE"]]), NOW);
    const c = view.connections[0];
    check("paused: nothing polls it as 'building'", view.building === false);
    check("paused: still reports where it stopped (100)", c.state === "import_paused" && c.importedCount === 100);
    check("paused: never carries a history-build progress bar",
      buildSyncStatus([item({ historyBuildStartedAt: ago(30 * MIN), historyBuildTotalDays: 730 })], new Map(), new Map([["item_1", "IDLE"]]), NOW).connections[0].historyBuild === null);
  }

  console.log("3. Intelligence: 'building your timeline' only while something builds it");
  {
    const intel = (state: Parameters<typeof deriveConnectionIntelligence>[0]["state"], activity: IngestionActivity | undefined, anchor: Date | null = null, provider: "PLAID" | "WALLET" = "PLAID") =>
      deriveConnectionIntelligence({ provider, state, historySyncedAt: anchor, earliestTxDate: ago(700 * 86_400_000),
        connectedAt: ago(90 * MIN), lastSyncedAt: ago(MIN), balancesUpdatedAt: ago(MIN), ingestionActivity: activity }, NOW);
    const notBuilt = intel("ready", "IDLE");
    check("REGRESSION: transactions ready, no anchor, nothing running ⇒ NOT_BUILT (the 'finishes in the background' card)",
      notBuilt.intelligence === "NOT_BUILT" && notBuilt.phase === "INTELLIGENCE_NOT_BUILT");
    check("NOT_BUILT does not keep the poller spinning", !isBuildingIntelligence([notBuilt]));
    const building = intel("ready", "RUNNING");
    check("the pipeline running after transactions ⇒ REBUILDING", building.intelligence === "REBUILDING" && building.phase === "BUILDING_INTELLIGENCE");
    check("…and that keeps the poller live", isBuildingIntelligence([building]));
    check("an anchor means READY regardless of activity", intel("ready", "IDLE", ago(MIN)).phase === "READY");
    const paused = intel("import_paused", "IDLE");
    check("a paused import is its own phase with a PAUSED history, not polled as building",
      paused.phase === "IMPORT_PAUSED" && paused.transactionHistory === "PAUSED" && !isBuildingIntelligence([paused]));
    check("unresolved activity keeps the prior REBUILDING behaviour", intel("ready", undefined).intelligence === "REBUILDING");
    check("wallets are unaffected", intel("ready", "IDLE", null, "WALLET").intelligence === "READY");
  }

  console.log("4. The surfaces honour the contract");
  {
    const card = code("components/connections/ConnectionCard.tsx");
    const fnBody = (name: string) => card.slice(card.indexOf(`function ${name}`), card.indexOf("\nfunction ", card.indexOf(`function ${name}`) + 10));
    check("the card renders a distinct paused state", /case "import_paused":[\s\S]{0,80}ImportPausedContent/.test(card));
    check("the card renders a distinct not-built state", /INTELLIGENCE_NOT_BUILT[\s\S]{0,120}TimelineNotBuiltContent/.test(card));
    for (const fn of ["ImportPausedContent", "TimelineNotBuiltContent"]) {
      const body = fnBody(fn);
      check(`${fn} claims no background work and shows no spinner`,
        !/background|animate-spin|Loader2/.test(body.replace(/\{busy \?[^}]*\}/, "")), body.slice(0, 80));
      check(`${fn} says nothing is running`, /nothing is (running|building)/.test(body));
    }
    check("the not-built card offers the existing rebuild action", /\/api\/connections\/build-intelligence/.test(fnBody("TimelineNotBuiltContent")));
    const list = code("components/connections/ConnectionsList.tsx");
    check("the poller drives resume for paused imports", /import_paused/.test(list.slice(list.indexOf("const driveResume"), list.indexOf("const poll = useCallback"))));
    check("the poller stays alive while an import is paused (it is what resumes it)", /anyPaused/.test(list) && /"import_paused"\)\s*\|\|/.test(list));
    const resume = code("app/api/plaid/resume-sync/route.ts");
    check("the browser resume runs the shared full pipeline (anchor included), not a private partial one",
      /syncPlaidItemFromWebhook\(item\.id,\s*"RESUME",\s*"IMPORT_RECOVERY"/.test(resume) && !/regenerateWealthHistoryForItem/.test(resume));
    const bhs = code("lib/plaid/backgroundHistorySync.ts");
    const rsc = bhs.slice(bhs.indexOf("async function recordSyncComplete"));
    check("the reconstruction anchor is written once per connection",
      rsc.indexOf("findFirst") > -1 && rsc.indexOf("findFirst") < rsc.indexOf("auditLog.create") && /if \(already\) return;/.test(rsc));
    check("operator diagnostics use the same evidence", /getIngestionEvidence\(/.test(code("lib/platform/connection-diagnostics.ts")));
  }

  if (failures > 0) { console.error(`\ningestion-truth.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ningestion-truth.test: all passed.");
}

main();
