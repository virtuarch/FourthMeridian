/**
 * lib/plaid/refresh-execution.test.ts  (DF-2A)
 *
 * Pure guards for the canonical Refresh Execution Authority. Standalone tsx
 * script (house pattern, see lib/jobs/run.test.ts): npx tsx <this> — exits 0/1.
 *
 * NO LIVE DATABASE and NO PLAID: an injected in-memory fake implements the
 * narrow RefreshExecutionWriteClient seam, and an injected `refresh` fn drives
 * the recorder in place of refreshPlaidItem. Covers: one invocation → one
 * execution + one stable runId + child results under that execution · second
 * invocation → second execution · append-only (one create + one completion
 * update) · status derivation (SUCCEEDED / PARTIAL / FAILED / SKIPPED /
 * non-applicable-holdings-does-not-degrade) · correlation (runId threaded to
 * the stage runner; coverage on the right endpoint result) · persistence of
 * previously-discarded counts · failure discipline (completion attempted on
 * throw, bounded errorSummary, telemetry-failure never breaks the refresh).
 */

import {
  runFullRefresh,
  deriveOverallStatus,
  StageRecorder,
  type RefreshExecutionWriteClient,
  type RefreshExecutionStartData,
  type RefreshExecutionCompletionData,
  type RefreshEndpointResultData,
} from "@/lib/plaid/refresh-execution";
import type { RefreshItemResult } from "@/lib/plaid/refresh";
import type { RefreshStageRecord, RefreshStageRecorder } from "@/lib/plaid/refresh-execution-types";
// DF-2B — the real cron per-item runner, exercised through the SAME authority.
import { runCronItemRefresh, type CronItemDeps, type CronItemOutcome } from "@/jobs/sync-banks";
import type { SyncTransactionsResult } from "@/lib/plaid/syncTransactions";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Prisma engine warm-up can floating-reject on platform-mismatched sandboxes
// (see lib/jobs/run.test.ts); nothing here touches Prisma at runtime.
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

// ── Fake write client implementing the narrow seam ───────────────────────────

interface FakeOpts {
  failCreate?: boolean;
  failCreateMany?: boolean;
  failUpdate?: boolean;
}
function makeFake(opts: FakeOpts = {}) {
  const creates: RefreshExecutionStartData[] = [];
  const updates: Array<{ id: string; data: RefreshExecutionCompletionData }> = [];
  const endpointRows: RefreshEndpointResultData[] = [];
  let seq = 0;
  const client: RefreshExecutionWriteClient = {
    refreshExecution: {
      async create({ data }) {
        if (opts.failCreate) throw new Error("ledger down");
        creates.push(data);
        return { id: `exec-${++seq}` };
      },
      async update({ where, data }) {
        if (opts.failUpdate) throw new Error("ledger down");
        updates.push({ id: where.id, data });
        return {};
      },
    },
    refreshEndpointResult: {
      async createMany({ data }) {
        if (opts.failCreateMany) throw new Error("ledger down");
        endpointRows.push(...data);
        return {};
      },
    },
  };
  return { client, creates, updates, endpointRows };
}

const okResult: RefreshItemResult = {
  plaidItemId: "item-1",
  institution: "Chase",
  ok: true,
  accountsUpdated: 2,
  holdingsUpdated: 0,
  transactionsAdded: 5,
  transactionsModified: 1,
  transactionsRemoved: 0,
  spacesSnapshotted: ["space-1"],
  updatedAccountIds: ["acc-1", "acc-2"],
};

// A stage runner that mimics a full successful refresh driving the recorder.
function fullSuccessRunner(capturedRunId: { value?: string }) {
  return async ({ recorder, runId }: { recorder: RefreshStageRecorder; runId: string }) => {
    capturedRunId.value = runId;
    recorder.begin("BALANCES", "PROVIDER");
    recorder.succeed("BALANCES", { recordsChanged: 2, coveredAccountIds: ["acc-1", "acc-2"] });
    recorder.skip("HOLDINGS", "PROVIDER", "NOT_APPLICABLE");
    recorder.begin("TRANSACTIONS", "PROVIDER");
    recorder.succeed("TRANSACTIONS", { recordsRead: 6, recordsWritten: 6, recordsChanged: 6 });
    recorder.begin("SNAPSHOT", "DERIVED");
    recorder.succeed("SNAPSHOT", { recordsChanged: 1, coveredAccountIds: ["acc-1", "acc-2"] });
    return okResult;
  };
}

async function main() {
  // ── Lifecycle: one invocation → one execution + stable runId + children ────
  {
    const { client, creates, updates, endpointRows } = makeFake();
    const captured: { value?: string } = {};
    const result = await runFullRefresh(
      { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client, refresh: fullSuccessRunner(captured) },
    );
    check("returns the refresh result unchanged", result === okResult);
    check("one RefreshExecution created", creates.length === 1);
    check("exactly one completion write (append-only)", updates.length === 1);
    check("completion targets the created execution", updates[0]?.id === "exec-1");
    check("execution runId is the stable correlator passed to the stage runner", creates[0]?.runId === captured.value && !!captured.value);
    check("trigger/profile persisted", creates[0]?.trigger === "MANUAL" && creates[0]?.profile === "FULL_REFRESH");
    check("start row is RUNNING", creates[0]?.overallStatus === "RUNNING");
    check("child results reference the same execution", endpointRows.length > 0 && endpointRows.every((r) => r.refreshExecutionId === "exec-1"));
    check("overall SUCCEEDED (skipped holdings did not degrade)", updates[0]?.data.overallStatus === "SUCCEEDED");

    // Persistence of previously-discarded facts
    const tx = endpointRows.find((r) => r.endpoint === "TRANSACTIONS");
    check("transaction counts persisted (recordsChanged)", tx?.recordsChanged === 6 && tx?.recordsRead === 6);
    check("transaction freshnessAdvanced derived", tx?.freshnessAdvanced === true);
    const bal = endpointRows.find((r) => r.endpoint === "BALANCES");
    check("balance coverage persisted on the BALANCES result", JSON.stringify(bal?.coveredAccountIds) === JSON.stringify(["acc-1", "acc-2"]));
    const hold = endpointRows.find((r) => r.endpoint === "HOLDINGS");
    check("holdings outcome persisted as SKIPPED/NOT_APPLICABLE", hold?.status === "SKIPPED" && hold?.skipReason === "NOT_APPLICABLE");
    const snap = endpointRows.find((r) => r.endpoint === "SNAPSHOT");
    check("snapshot outcome persisted", snap?.status === "SUCCEEDED" && snap?.recordsChanged === 1 && snap?.stageKind === "DERIVED");
  }

  // ── Second invocation → second execution ───────────────────────────────────
  {
    const { client, creates } = makeFake();
    const c1: { value?: string } = {};
    const c2: { value?: string } = {};
    await runFullRefresh({ itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" }, { client, refresh: fullSuccessRunner(c1) });
    await runFullRefresh({ itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" }, { client, refresh: fullSuccessRunner(c2) });
    check("two invocations → two executions", creates.length === 2);
    check("each invocation mints a distinct runId", creates[0]?.runId !== creates[1]?.runId);
  }

  // ── Status derivation (pure) ───────────────────────────────────────────────
  {
    const s = (over: Partial<RefreshStageRecord>): RefreshStageRecord => ({
      endpoint: "BALANCES", stageKind: "PROVIDER", status: "SUCCEEDED",
      startedAt: new Date(0), completedAt: new Date(0), durationMs: 0, coveredAccountIds: [], ...over,
    });
    check("all provider stages succeed → SUCCEEDED", deriveOverallStatus([
      s({ endpoint: "BALANCES" }), s({ endpoint: "TRANSACTIONS" }),
    ]) === "SUCCEEDED");
    check("mixed provider success/failure → PARTIAL", deriveOverallStatus([
      s({ endpoint: "BALANCES", status: "SUCCEEDED" }), s({ endpoint: "TRANSACTIONS", status: "FAILED" }),
    ]) === "PARTIAL");
    check("all attempted provider stages fail → FAILED", deriveOverallStatus([
      s({ endpoint: "BALANCES", status: "FAILED" }),
    ]) === "FAILED");
    check("no attempted stages → SKIPPED", deriveOverallStatus([
      s({ endpoint: "HOLDINGS", status: "SKIPPED", skipReason: "IN_FLIGHT" }),
    ]) === "SKIPPED");
    check("non-applicable holdings does not degrade success", deriveOverallStatus([
      s({ endpoint: "BALANCES", status: "SUCCEEDED" }),
      s({ endpoint: "HOLDINGS", status: "SKIPPED", skipReason: "NOT_APPLICABLE" }),
      s({ endpoint: "TRANSACTIONS", status: "SUCCEEDED" }),
    ]) === "SUCCEEDED");
    check("derived-stage failure with providers OK → PARTIAL (not FAILED)", deriveOverallStatus([
      s({ endpoint: "BALANCES", status: "SUCCEEDED" }),
      s({ endpoint: "SNAPSHOT", stageKind: "DERIVED", status: "FAILED" }),
    ]) === "PARTIAL");
  }

  // ── StageRecorder: begin/succeed/skip/failOpen ─────────────────────────────
  {
    const r = new StageRecorder();
    r.begin("BALANCES", "PROVIDER");
    r.succeed("BALANCES", { recordsChanged: 3, coveredAccountIds: ["a"] });
    r.begin("TRANSACTIONS", "PROVIDER");
    r.failOpen(new Error("cursor blocked"));
    check("recorder finalizes succeed + failOpen", r.records.length === 2);
    check("failOpen marks the open stage FAILED", r.records[1]?.status === "FAILED" && r.records[1]?.endpoint === "TRANSACTIONS");
    check("failOpen after no open stage is a no-op", (() => { const rr = new StageRecorder(); rr.failOpen(new Error("x")); return rr.records.length === 0; })());
    check("freshnessAdvanced false when recordsChanged is 0", (() => { const rr = new StageRecorder(); rr.begin("BALANCES", "PROVIDER"); rr.succeed("BALANCES", { recordsChanged: 0 }); return rr.records[0]?.freshnessAdvanced === false; })());
  }

  // ── Failure discipline: completion attempted on throw; bounded error; rethrow
  {
    const { client, creates, updates } = makeFake();
    const boom = new Error("x".repeat(1000)); // long message → must be truncated
    const runner = async ({ recorder }: { recorder: RefreshStageRecorder; runId: string }) => {
      recorder.begin("BALANCES", "PROVIDER");
      recorder.succeed("BALANCES", { recordsChanged: 1, coveredAccountIds: ["acc-1"] });
      recorder.begin("TRANSACTIONS", "PROVIDER");
      throw boom; // provider/stage failure mid-refresh
    };
    let rethrew: unknown;
    try {
      await runFullRefresh({ itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" }, { client, refresh: runner });
    } catch (e) { rethrew = e; }
    check("original error rethrown unchanged", rethrew === boom);
    check("execution still opened on failure", creates.length === 1);
    check("completion written on failure", updates.length === 1);
    check("failed-mid-refresh derives PARTIAL (balances ok, transactions failed)", updates[0]?.data.overallStatus === "PARTIAL");
    check("errorSummary bounded (≤500) and no stack", (updates[0]?.data.errorSummary?.length ?? 0) <= 500 && !(updates[0]?.data.errorSummary ?? "").includes("at "));
  }

  // ── Telemetry never breaks the refresh ─────────────────────────────────────
  {
    const { client } = makeFake({ failCreate: true, failCreateMany: true, failUpdate: true });
    const captured: { value?: string } = {};
    const result = await runFullRefresh(
      { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client, refresh: fullSuccessRunner(captured) },
    );
    check("ledger write failures are swallowed — refresh result still returned", result === okResult);
  }

  // ── DF-2B: cron runner drives the SAME lifecycle ──────────────────────────
  const TX: SyncTransactionsResult = {
    added: 2, modified: 1, removed: 0, cursor: "c",
    created: 3, updatedByPlaidId: 0, updatedByFingerprint: 0, skippedMissingAccount: 0,
  };
  function cronDeps(over: Partial<CronItemDeps> = {}, capture?: { runId?: string }): CronItemDeps {
    return {
      syncTransactions: (async (_id: string, d?: { runId?: string }) => { if (capture) capture.runId = d?.runId; return TX; }) as unknown as CronItemDeps["syncTransactions"],
      withLock: (async (_id: string, fn: () => Promise<unknown>) => ({ ok: true, result: await fn() })) as unknown as CronItemDeps["withLock"],
      refreshBalances: (async () => ({ updatedAccountIds: ["a1", "a2"], accountsUpdated: 2, reconcileTargets: [], item: {}, accessToken: "", plaidAccounts: [], itemData: {} })) as unknown as CronItemDeps["refreshBalances"],
      regenerateSnapshots: (async () => ["space-1"]) as unknown as CronItemDeps["regenerateSnapshots"],
      ...over,
    };
  }

  {
    // Full cron item through runFullRefresh → one execution, cron's own stages.
    const { client, creates, updates, endpointRows } = makeFake();
    const cap: { runId?: string } = {};
    const outcome = await runFullRefresh<CronItemOutcome>(
      { itemId: "item-1", trigger: "CRON", profile: "FULL_REFRESH" },
      { client, refresh: ({ recorder, runId }) => runCronItemRefresh("item-1", recorder, runId, cronDeps({}, cap)) },
    );
    check("cron: refresh runs, not skipped", outcome.skippedLocked === false && outcome.added === 2);
    check("cron: creates exactly one RefreshExecution with trigger CRON", creates.length === 1 && creates[0]?.trigger === "CRON");
    check("cron: runId threaded into the transaction sync (correlation)", cap.runId === creates[0]?.runId && !!cap.runId);
    const endpoints = endpointRows.map((r) => r.endpoint);
    check("cron: records TRANSACTIONS + BALANCES + SNAPSHOT (its own pipeline)", endpoints.includes("TRANSACTIONS") && endpoints.includes("BALANCES") && endpoints.includes("SNAPSHOT"));
    check("cron: does NOT record HOLDINGS/RECONCILIATION (empty ≠ uncovered)", !endpoints.includes("HOLDINGS") && !endpoints.includes("RECONCILIATION"));
    check("cron: BALANCES coverage persisted", JSON.stringify(endpointRows.find((r) => r.endpoint === "BALANCES")?.coveredAccountIds) === JSON.stringify(["a1", "a2"]));
    check("cron: overall SUCCEEDED", updates[0]?.data.overallStatus === "SUCCEEDED");
  }

  {
    // Lock held elsewhere → SKIPPED execution, no balance/snapshot stages.
    const { client, updates, endpointRows } = makeFake();
    const outcome = await runFullRefresh<CronItemOutcome>(
      { itemId: "item-1", trigger: "CRON", profile: "FULL_REFRESH" },
      { client, refresh: ({ recorder, runId }) => runCronItemRefresh("item-1", recorder, runId, cronDeps({
        withLock: (async () => ({ ok: false, reason: "in-flight" })) as unknown as CronItemDeps["withLock"],
      })) },
    );
    check("cron: lock-held → skippedLocked", outcome.skippedLocked === true);
    check("cron: lock-held → TRANSACTIONS SKIPPED/IN_FLIGHT only", endpointRows.length === 1 && endpointRows[0]?.status === "SKIPPED" && endpointRows[0]?.skipReason === "IN_FLIGHT");
    check("cron: lock-held → overall SKIPPED", updates[0]?.data.overallStatus === "SKIPPED");
  }

  {
    // Best-effort balance failure → recorded FAILED, item NOT thrown, execution PARTIAL.
    const { client, updates, endpointRows } = makeFake();
    const outcome = await runFullRefresh<CronItemOutcome>(
      { itemId: "item-1", trigger: "CRON", profile: "FULL_REFRESH" },
      { client, refresh: ({ recorder, runId }) => runCronItemRefresh("item-1", recorder, runId, cronDeps({
        refreshBalances: (async () => { throw new Error("balance boom"); }) as unknown as CronItemDeps["refreshBalances"],
      })) },
    );
    check("cron: balance failure does not throw the item", outcome.skippedLocked === false);
    check("cron: TRANSACTIONS SUCCEEDED, BALANCES FAILED recorded", endpointRows.find((r) => r.endpoint === "TRANSACTIONS")?.status === "SUCCEEDED" && endpointRows.find((r) => r.endpoint === "BALANCES")?.status === "FAILED");
    check("cron: best-effort balance failure → overall PARTIAL", updates[0]?.data.overallStatus === "PARTIAL");
  }

  // ── DF-2B: manual / cron parity — same authority, both produce a ledger ────
  {
    const manual = makeFake();
    await runFullRefresh({ itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" }, { client: manual.client, refresh: fullSuccessRunner({}) });
    const cron = makeFake();
    await runFullRefresh<CronItemOutcome>({ itemId: "item-1", trigger: "CRON", profile: "FULL_REFRESH" }, { client: cron.client, refresh: ({ recorder, runId }) => runCronItemRefresh("item-1", recorder, runId, cronDeps()) });
    check("parity: both produce exactly one immutable execution", manual.creates.length === 1 && cron.creates.length === 1);
    check("parity: both persist endpoint results + one completion", manual.updates.length === 1 && cron.updates.length === 1 && manual.endpointRows.length > 0 && cron.endpointRows.length > 0);
    check("parity: both derive a completion status via the same lifecycle", !!manual.updates[0]?.data.overallStatus && !!cron.updates[0]?.data.overallStatus);
  }

  // ── DF-2B: coverage doctrine encoded as guards ────────────────────────────
  {
    const r = new StageRecorder();
    // present coverage but recordsChanged 0 → freshnessAdvanced false (present ≠ freshness-advanced)
    r.begin("BALANCES", "PROVIDER");
    r.succeed("BALANCES", { recordsChanged: 0, coveredAccountIds: ["a1"] });
    check("doctrine: coverage present but freshnessAdvanced FALSE (present ≠ advanced)", r.records[0]?.coveredAccountIds.length === 1 && r.records[0]?.freshnessAdvanced === false);
    // a SKIPPED stage carries empty coverage (empty ≠ per-account outcome)
    r.skip("HOLDINGS", "PROVIDER", "NOT_APPLICABLE");
    check("doctrine: SKIPPED stage has empty coverage", r.records[1]?.status === "SKIPPED" && r.records[1]?.coveredAccountIds.length === 0);
    // recorder.fail records a FAILED stage inline without throwing (best-effort)
    r.begin("SNAPSHOT", "DERIVED");
    r.fail("SNAPSHOT", new Error("x".repeat(800)));
    check("doctrine: fail() records FAILED inline with bounded errorSummary", r.records[2]?.status === "FAILED" && (r.records[2]?.errorSummary?.length ?? 0) <= 500);
    // HOLDINGS coverage is persistable (the manual path fills it from processedAccountIds)
    const holdCap = new StageRecorder();
    holdCap.begin("HOLDINGS", "PROVIDER");
    holdCap.succeed("HOLDINGS", { recordsChanged: 4, coveredAccountIds: ["inv-1", "inv-2"] });
    check("holdings: processed account ids recorded as coverage", JSON.stringify(holdCap.records[0]?.coveredAccountIds) === JSON.stringify(["inv-1", "inv-2"]));
  }

  console.log(failures === 0 ? "\nAll refresh-execution guards passed." : `\n${failures} guard(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
