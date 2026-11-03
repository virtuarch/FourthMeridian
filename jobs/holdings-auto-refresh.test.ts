/**
 * jobs/holdings-auto-refresh.test.ts  (FIN-006)
 *
 * Brokerage holdings refreshed only when someone pressed Refresh: neither the
 * scheduled sweep (jobs/sync-banks.ts) nor the webhook pipeline
 * (lib/plaid/backgroundHistorySync.ts via lib/plaid/webhook-sync.ts) ran the
 * holdings stage, so after a trade the positions stopped summing to the freshly
 * refreshed account balance. This proves the fix with fakes — no Plaid, no
 * database:
 *
 *   1. eligibility: automatic paths run holdings only for ENABLED consent (the
 *      consent the Plaid cost model already prices as an Investments Item-month);
 *   2. the cron pipeline runs the SAME stage (runAutoHoldingsStage → runHoldingsStage)
 *      for consented Items only, between BALANCES and SNAPSHOT, never throwing;
 *   3. a non-investment Item's execution is unchanged (no HOLDINGS row at all);
 *   4. the cost freeze, admission and billable gates refuse BEFORE the pipeline
 *      and record their skip exactly as for every other stage;
 *   5. the webhook: HOLDINGS/DEFAULT_UPDATE schedules the WEBHOOK pipeline, and
 *      only the WEBHOOK trigger runs the holdings stage;
 *   6. the cadence pin: at most once per Item per sweep, on the BANK refresh
 *      policy, never for a fresh Item, and no doubled event ingest.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/holdings-auto-refresh.test.ts
 */

import { readFileSync } from "node:fs";
import { PlaidInvestmentsConsent } from "@prisma/client";
import { allowAllBillable, notFrozen } from "@/lib/test-support/billable-open";
import {
  runCronItemRefresh, syncBanks, syncBanksOrder, SYNC_BANKS_RECENT_MS,
  type CronItemDeps, type SyncBanksCandidate,
} from "@/jobs/sync-banks";
import {
  autoHoldingsEligible, runAutoHoldingsStage, runHoldingsStage,
} from "@/lib/plaid/refresh";
import { deferredPipelineRunsHoldings, syncPlaidItemFromWebhook } from "@/lib/plaid/webhook-sync";
import { decidePlaidWebhook, handlePlaidWebhook, isSyncTrigger } from "@/lib/plaid/webhook-receiver";
import { billableSkipCode } from "@/lib/entitlements/billable-gate-core";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { defaultJobCadencePolicies } from "@/lib/jobs/cadence-policy";
import type { RefreshEndpoint, RefreshSkipReason, RefreshStageRecorder } from "@/lib/plaid/refresh-execution-types";
import type { SyncInvestmentsResult } from "@/lib/plaid/sync-investments";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

// ── fakes ────────────────────────────────────────────────────────────────────
type Ev = { op: "begin" | "succeed" | "skip" | "fail" | "failOpen"; endpoint?: RefreshEndpoint; reason?: RefreshSkipReason };
function fakeRecorder() {
  const events: Ev[] = [];
  const recorder: RefreshStageRecorder = {
    begin: (endpoint) => { events.push({ op: "begin", endpoint }); },
    succeed: (endpoint) => { events.push({ op: "succeed", endpoint }); },
    skip: (endpoint, _k, reason) => { events.push({ op: "skip", endpoint, reason }); },
    fail: (endpoint) => { events.push({ op: "fail", endpoint }); },
    failOpen: () => { events.push({ op: "failOpen" }); },
  } as unknown as RefreshStageRecorder;
  const seq = () => events.map((e) => `${e.op}:${e.endpoint ?? ""}${e.reason ? `/${e.reason}` : ""}`);
  return { recorder, events, seq };
}

const RESULT: SyncInvestmentsResult = { holdingsSynced: 3, consent: PlaidInvestmentsConsent.ENABLED, processedAccountIds: ["inv-1"], accountCoverage: [], eventsIngestAttempted: true };

type Bal = Parameters<typeof runHoldingsStage>[0];
const bal = (consent: PlaidInvestmentsConsent | null, accounts: Array<{ type: string; subtype: string }> = []) => ({
  item: { id: "item-1", institutionName: "Broker", investmentsConsent: consent },
  accessToken: "tok",
  plaidAccounts: accounts.map((a, i) => ({ account_id: `pa-${i}`, ...a })),
  itemData: {},
  updatedAccountIds: ["a1"],
  accountsUpdated: 1,
  reconcileTargets: [],
  accountCoverage: [],
});

const TX = { added: 1, modified: 0, removed: 0, created: 1, updatedByPlaidId: 0, updatedByFingerprint: 0, skippedMissingAccount: 0 };

/** Cron deps with the REAL eligibility (runAutoHoldingsStage) over a counted fake stage. */
function cronDeps(consent: PlaidInvestmentsConsent | null, over: Partial<CronItemDeps> = {}, counter = { calls: 0 }) {
  const deps: CronItemDeps = {
    syncTransactions: (async () => TX) as unknown as CronItemDeps["syncTransactions"],
    withLock: (async (_id: string, fn: () => Promise<unknown>) => ({ ok: true, result: await fn() })) as unknown as CronItemDeps["withLock"],
    refreshBalances: (async () => bal(consent)) as unknown as CronItemDeps["refreshBalances"],
    regenerateSnapshots: (async () => ["space-1"]) as unknown as CronItemDeps["regenerateSnapshots"],
    holdings: ((b: Bal, r?: RefreshStageRecorder) =>
      runAutoHoldingsStage(b, r, { stage: async (_b, rec) => { counter.calls++; rec?.begin("HOLDINGS", "PROVIDER"); rec?.succeed("HOLDINGS"); return RESULT; } })) as CronItemDeps["holdings"],
    ...over,
  };
  return deps;
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

async function main() {
  // ── 1. eligibility ─────────────────────────────────────────────────────────
  console.log("eligibility (automatic paths: ENABLED consent only)");
  check("ENABLED is eligible", autoHoldingsEligible(PlaidInvestmentsConsent.ENABLED));
  check("null / CONSENT_REQUIRED / UNSUPPORTED / undefined are NOT (automatic paths never add the Investments product)",
    [null, undefined, PlaidInvestmentsConsent.CONSENT_REQUIRED, PlaidInvestmentsConsent.UNSUPPORTED].every((c) => !autoHoldingsEligible(c)));
  {
    let called = 0;
    const r = fakeRecorder();
    const out = await runAutoHoldingsStage(bal(null) as Bal, r.recorder, { stage: async () => { called++; return RESULT; } });
    check("not eligible ⇒ the stage is NOT called and NOTHING is recorded", called === 0 && r.events.length === 0 && !out.ran && out.reason === "NOT_ELIGIBLE");
  }
  {
    const r = fakeRecorder();
    const out = await quiet(() => runAutoHoldingsStage(bal(PlaidInvestmentsConsent.ENABLED) as Bal, r.recorder, {
      stage: async (_b, rec) => { rec?.begin("HOLDINGS", "PROVIDER"); throw new Error("holdings boom"); },
    }));
    check("a throwing stage never throws out; the OPEN stage is failed (failOpen) and the outcome is FAILED",
      !out.ran && out.reason === "FAILED" && r.seq().join() === "begin:HOLDINGS,failOpen:", r.seq().join());
  }
  {
    // The REAL shared stage: an ENABLED Item with no investment accounts records
    // HOLDINGS SKIPPED/NOT_APPLICABLE (syncInvestmentsForItem returns before any call).
    const r = fakeRecorder();
    const out = await runAutoHoldingsStage(bal(PlaidInvestmentsConsent.ENABLED, [{ type: "depository", subtype: "checking" }]) as Bal, r.recorder);
    check("real runHoldingsStage: no investment accounts ⇒ HOLDINGS SKIPPED/NOT_APPLICABLE (same as manual refresh)",
      out.ran && r.seq().join() === "skip:HOLDINGS/NOT_APPLICABLE" && out.result.holdingsSynced === 0, r.seq().join());
  }

  // ── 2/3. the cron pipeline ─────────────────────────────────────────────────
  console.log("cron pipeline (runCronItemRefresh)");
  {
    const r = fakeRecorder();
    const counter = { calls: 0 };
    const out = await runCronItemRefresh("item-1", r.recorder, "run-1", cronDeps(PlaidInvestmentsConsent.ENABLED, {}, counter));
    const s = r.seq();
    check("consented Item: the holdings stage runs exactly once", counter.calls === 1, `calls=${counter.calls}`);
    check("order: TRANSACTIONS → BALANCES → HOLDINGS → SNAPSHOT (today's snapshot reads fresh positions)",
      s.join() === "begin:TRANSACTIONS,succeed:TRANSACTIONS,begin:BALANCES,succeed:BALANCES,begin:HOLDINGS,succeed:HOLDINGS,begin:SNAPSHOT,succeed:SNAPSHOT", s.join());
    check("the event ingest the stage reached is reported (no second A3-4 call)", out.holdingsEventsIngested === true && out.skippedLocked === false);
  }
  for (const consent of [null, PlaidInvestmentsConsent.CONSENT_REQUIRED, PlaidInvestmentsConsent.UNSUPPORTED] as const) {
    const r = fakeRecorder();
    const counter = { calls: 0 };
    const out = await runCronItemRefresh("item-1", r.recorder, "run-1", cronDeps(consent, {}, counter));
    check(`non-investment / unconsented Item (${consent ?? "null"}): unchanged — no holdings call, no HOLDINGS row`,
      counter.calls === 0 && !r.seq().some((x) => x.includes("HOLDINGS"))
      && r.seq().join() === "begin:TRANSACTIONS,succeed:TRANSACTIONS,begin:BALANCES,succeed:BALANCES,begin:SNAPSHOT,succeed:SNAPSHOT"
      && out.holdingsEventsIngested === false, r.seq().join());
  }
  {
    const r = fakeRecorder();
    const counter = { calls: 0 };
    const out = await runCronItemRefresh("item-1", r.recorder, "run-1", cronDeps(PlaidInvestmentsConsent.ENABLED, {
      withLock: (async () => ({ ok: false, reason: "in-flight" })) as unknown as CronItemDeps["withLock"],
    }, counter));
    check("lock held elsewhere ⇒ no holdings call (TRANSACTIONS IN_FLIGHT only, as before)",
      counter.calls === 0 && out.skippedLocked && r.seq().join() === "begin:TRANSACTIONS,skip:TRANSACTIONS/IN_FLIGHT", r.seq().join());
  }
  {
    const r = fakeRecorder();
    const counter = { calls: 0 };
    await quiet(() => runCronItemRefresh("item-1", r.recorder, "run-1", cronDeps(PlaidInvestmentsConsent.ENABLED, {
      refreshBalances: (async () => { throw new Error("balance boom"); }) as unknown as CronItemDeps["refreshBalances"],
    }, counter)));
    check("a balance failure ⇒ no holdings call (it needs the accounts answer); BALANCES FAILED as before",
      counter.calls === 0 && r.seq().join() === "begin:TRANSACTIONS,succeed:TRANSACTIONS,begin:BALANCES,fail:BALANCES", r.seq().join());
  }
  {
    const r = fakeRecorder();
    const out = await quiet(() => runCronItemRefresh("item-1", r.recorder, "run-1", cronDeps(PlaidInvestmentsConsent.ENABLED, {
      holdings: ((b: Bal, rec?: RefreshStageRecorder) => runAutoHoldingsStage(b, rec, {
        stage: async (_b, x) => { x?.begin("HOLDINGS", "PROVIDER"); throw new Error("holdings boom"); },
      })) as CronItemDeps["holdings"],
    })));
    check("a holdings failure never fails the Item: HOLDINGS failed, SNAPSHOT still runs",
      !out.skippedLocked && r.seq().join() === "begin:TRANSACTIONS,succeed:TRANSACTIONS,begin:BALANCES,succeed:BALANCES,begin:HOLDINGS,failOpen:,begin:SNAPSHOT,succeed:SNAPSHOT"
      && out.holdingsEventsIngested === false, r.seq().join());
  }

  // ── 4. gates refuse BEFORE the pipeline, with their skip recorded ──────────
  console.log("cost freeze / admission / billable");
  const candidate = (id: string): SyncBanksCandidate =>
    ({ id, userId: "owner-1", institutionName: `Broker ${id}`, investmentsConsent: PlaidInvestmentsConsent.ENABLED, encryptedToken: "x", lastSyncedAt: null });
  {
    let processed = 0;
    const r = await quiet(() => syncBanks({
      loadItems: async () => [candidate("a"), candidate("b")],
      admit: async () => ({ decision: "ADMIT" as const, reason: null }),
      billable: allowAllBillable,
      costFreeze: async () => ({ frozen: true, state: "ON", reason: "COST_FREEZE" }),
      processItem: async () => { processed++; return "succeeded"; },
    }));
    check("global cost freeze ⇒ no Item pipeline (so no holdings call); the run records SKIPPED with the billable skip code",
      processed === 0 && r.outcome === "SKIPPED" && r.skipReason === billableSkipCode("COST_FREEZE"), JSON.stringify(r));
  }
  {
    let processed = 0;
    const r = await quiet(() => syncBanks({
      loadItems: async () => [candidate("a")],
      admit: async () => ({ decision: "DENY" as const, reason: "INGESTION_PAUSED" }),
      billable: allowAllBillable, costFreeze: notFrozen,
      processItem: async () => { processed++; return "succeeded"; },
    }));
    check("admission DENY ⇒ no Item pipeline; the typed reason lands on the run (notAdmitted)",
      processed === 0 && r.notAdmitted === "INGESTION_PAUSED" && r.deferred === 1, JSON.stringify(r));
  }
  {
    let processed = 0;
    const denied: Array<{ id: string; reason: string }> = [];
    const r = await quiet(() => syncBanks({
      loadItems: async () => [candidate("a")],
      admit: async () => ({ decision: "ADMIT" as const, reason: null }),
      costFreeze: notFrozen,
      billable: async (ids) => new Map(ids.map((id) => [id, { allowed: false as const, reason: "BETA_PAUSED" as const }])),
      recordDenial: async (item, reason) => { denied.push({ id: item.id, reason }); },
      processItem: async () => { processed++; return "succeeded"; },
    }));
    check("billable refusal ⇒ no Item pipeline; one SKIPPED execution recorded with the reason (planRestricted)",
      processed === 0 && denied.length === 1 && denied[0].reason === "BETA_PAUSED" && r.planRestricted === 1, JSON.stringify({ r, denied }));
  }
  {
    let ran = 0;
    const denials: Array<{ admissionReason: string; trigger: string }> = [];
    const out = await quiet(() => syncPlaidItemFromWebhook("item-1", "WEBHOOK", "RECONNECT",
      { decision: "ADMIT", reason: null } as never,
      {
        checkBillable: async () => ({ allowed: false, reason: "COST_FREEZE" }),
        recordDenial: (async (d: { admissionReason: string; trigger: string }) => { denials.push(d); }) as never,
        runPipeline: async () => { ran++; return "ran"; },
      }));
    check("webhook under the cost freeze ⇒ plan-restricted, pipeline (and its holdings stage) never reached, SKIPPED recorded with BILLABLE_COST_FREEZE",
      out === "plan-restricted" && ran === 0 && denials.length === 1 && denials[0].admissionReason === billableSkipCode("COST_FREEZE") && denials[0].trigger === "WEBHOOK",
      JSON.stringify({ out, ran, denials }));
  }

  // ── 5. webhook ────────────────────────────────────────────────────────────
  console.log("webhook (HOLDINGS triggers the holdings stage)");
  const active = { id: "item-1", status: "ACTIVE", ownerDeactivated: false };
  check("HOLDINGS/DEFAULT_UPDATE is a sync trigger and schedules the pipeline for an eligible Item",
    isSyncTrigger("HOLDINGS", "DEFAULT_UPDATE") && decidePlaidWebhook("HOLDINGS", "DEFAULT_UPDATE", active).handling === "SYNC_SCHEDULED");
  {
    const scheduled: string[] = [];
    await quiet(() => handlePlaidWebhook(JSON.stringify({ webhook_type: "HOLDINGS", webhook_code: "DEFAULT_UPDATE", item_id: "ext-1" }), "sig", {
      verify: async () => ({ ok: true }),
      lookupItem: async () => active,
      recordEvent: () => {},
      scheduleSync: (id) => { scheduled.push(id); },
      environment: () => "test",
      isDuplicate: async () => false,
    }));
    check("handlePlaidWebhook(HOLDINGS/DEFAULT_UPDATE) schedules exactly one pipeline for the Item", scheduled.join() === "item-1", scheduled.join());
  }
  const ROUTE = readFileSync("app/api/plaid/webhook/route.ts", "utf8");
  check("the route schedules that pipeline with trigger WEBHOOK",
    /scheduleSync:\s*\(plaidItemId\)\s*=>\s*after\(\(\)\s*=>\s*syncPlaidItemFromWebhook\(plaidItemId,\s*"WEBHOOK"\)\)/.test(ROUTE));
  check("only the WEBHOOK trigger runs the holdings stage (RECONNECT follows exchangeToken; RESUME unchanged)",
    deferredPipelineRunsHoldings("WEBHOOK") && !deferredPipelineRunsHoldings("RECONNECT") && !deferredPipelineRunsHoldings("RESUME")
    && !deferredPipelineRunsHoldings("CRON") && !deferredPipelineRunsHoldings("MANUAL"));
  const WSYNC = readFileSync("lib/plaid/webhook-sync.ts", "utf8");
  check("the locked run passes the trigger's holdings decision into the deferred pipeline",
    /runDeferredHistorySync\(plaidItemId, recorder, runId, \{ holdings: deferredPipelineRunsHoldings\(trigger\) \}\)/.test(WSYNC));
  const BG = readFileSync("lib/plaid/backgroundHistorySync.ts", "utf8");
  const balOk = BG.indexOf('recorder?.succeed("BALANCES"');
  const hStage = BG.indexOf("if (opts.holdings) await (opts.holdingsStage ?? runAutoHoldingsStage)(bal, recorder);");
  const snap = BG.indexOf('recorder?.begin("SNAPSHOT", "DERIVED")');
  check("the deferred pipeline runs the SHARED stage after BALANCES and before SNAPSHOT, only when asked",
    balOk > 0 && hStage > balOk && snap > hStage, `balances@${balOk} holdings@${hStage} snapshot@${snap}`);
  const RECEIVER = readFileSync("lib/plaid/webhook-receiver.ts", "utf8");
  check("the receiver comment no longer claims the pipeline already synced holdings",
    !/Same FULL pipeline, never a holdings-only sync\./.test(RECEIVER) && /FIN-006/.test(RECEIVER));

  // ── 6. cadence pin ────────────────────────────────────────────────────────
  console.log("cadence (bounded, follows the BANK refresh policy)");
  const pol = defaultJobCadencePolicies(SCHEDULED_JOBS).get("sync-banks");
  check("sync-banks runs on the BANK refresh policy, 24 h default — the holdings stage adds no schedule of its own",
    pol?.hours === 24 && pol?.origin === "REFRESH_POLICY", JSON.stringify(pol));
  {
    const now = Date.UTC(2026, 10, 3, 6, 0, 0);
    const fresh = { ...candidate("fresh"), lastSyncedAt: new Date(now - SYNC_BANKS_RECENT_MS + 60_000) };
    const due = { ...candidate("due"), lastSyncedAt: new Date(now - SYNC_BANKS_RECENT_MS) };
    check("an Item synced within SYNC_BANKS_RECENT_MS is not re-swept (so no holdings call either)",
      syncBanksOrder([fresh, due], now).map((i) => i.id).join() === "due");
    const seen: string[] = [];
    await quiet(() => syncBanks({
      loadItems: async () => [candidate("a"), candidate("b"), candidate("c")],
      admit: async () => ({ decision: "ADMIT" as const, reason: null }),
      billable: allowAllBillable, costFreeze: notFrozen,
      processItem: async (it) => { seen.push(it.id); return "succeeded"; },
    }));
    check("each Item's pipeline (and so its holdings stage) runs at most once per sweep",
      seen.length === 3 && new Set(seen).size === 3, seen.join());
  }
  const BANKS = readFileSync("jobs/sync-banks.ts", "utf8");
  check("the cron calls the holdings stage exactly once, inside runCronItemRefresh",
    (BANKS.match(/await holdings\(bal, recorder\)/g) ?? []).length === 1
    && BANKS.indexOf("await holdings(bal, recorder)") > BANKS.indexOf("export async function runCronItemRefresh(")
    && BANKS.indexOf("await holdings(bal, recorder)") < BANKS.indexOf("export const SYNC_BANKS_BUDGET_MS"));
  check("no doubled event ingest: the sweep's A3-4 call is skipped when the holdings stage already reached it",
    /if \(eventsOn && holdingsEventsIngested\) \{\s*counters\.eventItems\+\+;\s*\} else if \(eventsOn && item\.investmentsConsent === PlaidInvestmentsConsent\.ENABLED\) \{/.test(BANKS));
  const REFRESH = readFileSync("lib/plaid/refresh.ts", "utf8");
  check("ONE holdings implementation: syncInvestmentsForItem is called once in refresh.ts, inside runHoldingsStage",
    (REFRESH.match(/syncInvestmentsForItem\(/g) ?? []).length === 1
    && REFRESH.indexOf("syncInvestmentsForItem(") > REFRESH.indexOf("export async function runHoldingsStage(")
    && REFRESH.indexOf("syncInvestmentsForItem(") < REFRESH.indexOf("export function autoHoldingsEligible("));
  check("neither automatic path calls syncInvestmentsForItem directly (they reuse the shared stage)",
    ![BANKS, BG, WSYNC].some((src) => /\bsyncInvestmentsForItem\s*\(/.test(src.replace(/\/\/[^\n]*/g, ""))));

  if (failures > 0) { console.error(`\nholdings-auto-refresh: ${failures} failure(s).`); process.exit(1); }
  console.log("\nholdings-auto-refresh: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
