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

  console.log(failures === 0 ? "\nAll refresh-execution guards passed." : `\n${failures} guard(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
