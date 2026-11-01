/**
 * lib/plaid/incident-ambient-correlation.test.ts  (PB-1 S1 — incident ↔ operation correlation)
 *
 * Investment and wallet producers record incidents through the facade WITHOUT a
 * run id, so their episodes never named the execution that failed. The facade
 * now adopts the refresh execution in flight on the same async stack — and ONLY
 * that one, ONLY while it is open:
 *   - an explicit detail.runId always wins (the ledger door's path; no recursion);
 *   - two interleaved executions each stamp their own run id, never the other's;
 *   - an observation that settles after the execution's completion write began
 *     (fire-and-forget, `void`) is left uncorrelated, never attributed to it;
 *   - outside any execution nothing is invented.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/incident-ambient-correlation.test.ts
 */

import { readFileSync } from "node:fs";
import { recordSyncIssue, ambientRunId } from "./syncIssues";
import { runWithProviderCallContext } from "./provider-call-context";
import type { LedgerHandle } from "./refresh-ledger";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, detail ?? ""); }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A door carrying only what ambient adoption reads. */
function door(runId: string): LedgerHandle & { closed: boolean } {
  return { executionId: `exec_${runId}`, runId, closed: false } as unknown as LedgerHandle & { closed: boolean };
}
const inside = <T>(d: LedgerHandle, fn: () => Promise<T>) => runWithProviderCallContext({ ledger: d, attempts: new Map() }, fn);

/** The facade's injected client (root-client stand-in) + the run ids the authority was asked to resolve. */
function harness() {
  const written: Array<Record<string, unknown>> = [];
  const looked: Array<string> = [];
  const client = {
    syncIssue: {
      create: async ({ data }: { data: Record<string, unknown> }) => { written.push(data); return { id: "si1" }; },
      findFirst: async () => null,
      update: async () => ({ id: "si1" }),
    },
    syncIssueOccurrence: { create: async ({ data }: { data: Record<string, unknown> }) => { written.push({ occurrence: data }); return { id: "so1" }; } },
    $transaction: async () => { throw new Error("the incident lifecycle must not open transactions"); },
  };
  const deps = { getExecutionIdByRunId: async (runId: string) => { looked.push(runId); return `exec_${runId}`; } };
  return { client, deps, written, looked };
}
const wallet = { kind: "WALLET_SYNC_FAILED" as const, provider: "WALLET", financialAccountId: "fa_btc", detail: { chain: "BTC", stage: "price", message: "x" } };

async function main() {
  console.log("ambientRunId");
  check("outside any execution: null (nothing invented)", ambientRunId() === null);
  const d1 = door("run_A");
  check("inside an open execution: its run id", await inside(d1, async () => ambientRunId()) === "run_A");
  const dc = door("run_C"); dc.closed = true;
  check("inside a CLOSED execution: null", await inside(dc, async () => ambientRunId()) === null);
  const noRun = { executionId: "e", closed: false } as unknown as LedgerHandle;
  check("a door without a run id (test fake): null", await inside(noRun, async () => ambientRunId()) === null);

  console.log("facade adoption");
  {
    const h = harness();
    await inside(door("run_W"), () => recordSyncIssue(wallet, h.client as never, h.deps));
    check("a wallet incident recorded inside an execution is correlated to it", h.looked.join() === "run_W", h.looked);
  }
  {
    const h = harness();
    await inside(door("run_AMBIENT"), () => recordSyncIssue({ ...wallet, detail: { ...wallet.detail, runId: "run_EXPLICIT" } }, h.client as never, h.deps));
    check("an explicit detail.runId wins over the ambient one (the door's path)", h.looked.join() === "run_EXPLICIT", h.looked);
  }
  {
    const h = harness();
    await recordSyncIssue(wallet, h.client as never, h.deps);
    check("outside any execution the authority is asked about no run", h.looked.length === 0, h.looked);
  }

  console.log("leak pins (Session 2)");
  {
    // Two executions interleaved on one event loop: each observation sees ITS stack.
    const h = harness();
    const a = door("run_1"); const b = door("run_2");
    await Promise.all([
      inside(a, async () => { await tick(5); await recordSyncIssue(wallet, h.client as never, h.deps); await tick(1); }),
      inside(b, async () => { await tick(1); await recordSyncIssue(wallet, h.client as never, h.deps); await tick(8); await recordSyncIssue(wallet, h.client as never, h.deps); }),
    ]);
    check("interleaved executions: run_2, run_1, run_2 — each stamped with its own, never the other's",
      h.looked.join() === "run_2,run_1,run_2", h.looked);
  }
  {
    // A fire-and-forget producer that settles after the completion write began.
    const h = harness();
    const d = door("run_LATE");
    let late: Promise<void> = Promise.resolve();
    await inside(d, async () => {
      late = (async () => { await tick(10); await recordSyncIssue(wallet, h.client as never, h.deps); })();
      await tick(1);
      d.closed = true; // the completion write begins
    });
    await late;
    check("a late fire-and-forget observation is NOT attributed to the finished execution", h.looked.length === 0, h.looked);
  }

  console.log("source pins");
  const LEDGER = readFileSync("lib/plaid/refresh-ledger.ts", "utf8");
  check("the door exposes runId and flips closed at the START of its completion write",
    /executionId,\s*runId,\s*get closed\(\) \{ return closed; \},/.test(LEDGER) && /async close\(data\) \{[\s\S]{0,400}?closed = true;\s*try \{/.test(LEDGER));
  const FACADE = readFileSync("lib/plaid/syncIssues.ts", "utf8");
  check("the facade: explicit run id first, ambient second", /const runId = explicitRunId \?\? ambientRunId\(\);/.test(FACADE));
  const ING = readFileSync("lib/investments/investment-event-ingest.ts", "utf8");
  check("investment ingest mints ONE attempt id and writes it on coverage and on all four incident producers",
    (ING.match(/const attemptId = randomUUID\(\);/g) ?? []).length === 1 && /attemptId: randomUUID\(\),/.test(ING) && /detail, now: params\.now, attemptId,/.test(ING)
    && /stage: "investment-events-fetch", attemptId,/.test(ING) && /stage: "investment-events", attemptId,/.test(ING)
    && /stage: "investment-events-instrument", attemptId: attemptId \?\? null,/.test(ING) && /attemptId: attemptId \?\? null,\s*affectedInstrumentIds: \[\.\.\.a\.instrumentIds\]\.sort\(\)\.slice\(0, MAX_DETAIL_INSTRUMENT_IDS\),\s*affectedInstrumentCount: a\.instrumentIds\.size, affectedCash: a\.cash,/.test(ING)
    && /export const MAX_DETAIL_INSTRUMENT_IDS = 50;/.test(ING));

  // END-TO-END REACH (Session 2): the two producers this slice exists for must
  // actually run inside the envelope that establishes the ambient context — a
  // refactor that drops it would silently uncorrelate them again.
  const RUNNER = readFileSync("lib/plaid/refresh-execution.ts", "utf8");
  check("runFullRefresh establishes the provider-call context around the runner (the ONLY establishing site)",
    /return ctx \? runWithProviderCallContext\(ctx, execute\) : execute\(\);/.test(RUNNER));
  const WALLET = readFileSync("lib/crypto/wallet-sync-dispatch.ts", "utf8");
  check("wallet: the adapter runs inside the runner handed to runFullRefresh",
    /const runner = async \(\{ recorder \}[\s\S]{0,600}await adapter\.sync\(accountId\)/.test(WALLET)
    && /runFullRefresh<WalletSyncOutcome>\([\s\S]{0,400}refresh: runner,/.test(WALLET));
  const REFRESH = readFileSync("lib/plaid/refresh.ts", "utf8");
  const SYNCINV = readFileSync("lib/plaid/sync-investments.ts", "utf8");
  check("investments (manual / Refresh All): runFullRefresh → refreshPlaidItem → syncInvestmentsForItem → ingestInvestmentEvents",
    /runFullRefresh<SyncLockResult<RefreshItemResult>>\([\s\S]{0,300}refresh: async \(\{ recorder, runId \}\) => \{[\s\S]{0,200}refreshItem\(plaidItemDbId,/.test(REFRESH)
    && /const refreshItem = deps\.refreshItem \?\? refreshPlaidItem;/.test(REFRESH)
    && /export async function refreshPlaidItem\([\s\S]*?await syncInvestmentsForItem\(\{/.test(REFRESH)
    && /await ingestInvestmentEvents\(db, \{ accessToken, plaidItemId, now: new Date\(\), coveredFinancialAccountIds \}\);/.test(SYNCINV));
  const BANKS = readFileSync("jobs/sync-banks.ts", "utf8");
  check("KNOWN GAP, pinned honestly: the scheduled sync-banks ingest runs OUTSIDE any envelope (no run id; its attemptId still makes the clean-attempt test decidable)",
    /await ingestInvestmentEvents\(db, \{ accessToken, plaidItemId: item\.id, now: new Date\(\) \}\);/.test(BANKS));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
