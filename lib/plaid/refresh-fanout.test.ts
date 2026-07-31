/**
 * lib/plaid/refresh-fanout.test.ts  (V26 OPS-REFRESH-1A)
 *
 * The all-items manual refresh fan-out reaches the canonical execution ledger.
 *
 * WHY THIS FILE EXISTS. `lib/plaid/execution-convergence.test.ts` already
 * asserted that "every refresh-equivalent execution leaves RefreshExecution
 * evidence" — and PASSED while the product's primary refresh gesture left none.
 * Its check greps the ROUTE file for the token `runFullRefresh(`, which the
 * route's single-item branch supplied; the all-items branch called
 * `refreshPlaidItem` directly, from a different file the census never read. A
 * lexical scan cannot see a second branch that bypasses the thing it is
 * scanning for. (Sixth time a guard has been narrower or broader than its own
 * doctrine — the habit that keeps catching it: assert the INTENT, and make the
 * primary assertion behavioural.)
 *
 * So the intent is stated three ways, in decreasing strength:
 *
 *   1. BEHAVIOURAL, per item — the REAL `runManualItemRefresh` driving the REAL
 *      `runFullRefresh` against an in-memory write client. Proves the envelope
 *      exists, that the recorder and runId threaded into refreshPlaidItem are
 *      the LIVE ones (their stage records land under the created execution),
 *      that the provider-call context is established, that lock contention is
 *      recorded, and that a thrown error keeps its identity.
 *   2. BEHAVIOURAL, fan-out — the REAL `refreshAllActiveItemsForUser` over
 *      injected collaborators. Proves one envelope per ELIGIBLE item, correct
 *      eligibility, preserved summary semantics, and exactly one post-loop
 *      snapshot regeneration.
 *   3. STRUCTURAL, minimal — the fan-out's own body never calls
 *      `refreshPlaidItem` directly, and the injected default IS the envelope.
 *      This is the only lexical layer, and it exists solely to stop the
 *      envelope being bypassed rather than broken (layer 1 catches broken).
 *
 * NO LIVE DATABASE, NO PLAID, NO NETWORK — every collaborator is injected.
 * Standalone tsx script (house pattern):
 *   npx tsx --require scripts/lib/server-only-preload.cjs lib/plaid/refresh-fanout.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  runManualItemRefresh,
  refreshAllActiveItemsForUser,
  type RefreshItemResult,
  type RefreshAllDeps,
} from "@/lib/plaid/refresh";
import {
  runFullRefresh,
  type RunFullRefreshParams,
  type RunFullRefreshDeps,
  type RefreshExecutionWriteClient,
  type RefreshExecutionStartData,
  type RefreshExecutionCompletionData,
  type RefreshEndpointResultData,
  type RefreshEndpointAccountCoverageData,
} from "@/lib/plaid/refresh-execution";
import { getProviderCallContext } from "@/lib/plaid/provider-call-context";
import type { SyncLockResult } from "@/lib/plaid/sync-lock";

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

// ── In-memory ledger (the narrow RefreshExecutionWriteClient seam) ───────────

function makeLedger() {
  const creates: RefreshExecutionStartData[] = [];
  const updates: Array<{ id: string; data: RefreshExecutionCompletionData }> = [];
  const endpointRows: RefreshEndpointResultData[] = [];
  const coverageRows: RefreshEndpointAccountCoverageData[] = [];
  let seq = 0;
  const client: RefreshExecutionWriteClient = {
    refreshExecution: {
      async create({ data }) { creates.push(data); return { id: `exec-${++seq}` }; },
      async update({ where, data }) { updates.push({ id: where.id, data }); return {}; },
    },
    refreshEndpointResult: {
      async createMany({ data }) { endpointRows.push(...data); return {}; },
    },
    refreshEndpointAccountCoverage: {
      async createMany({ data }) { coverageRows.push(...data); return {}; },
    },
  };
  return { client, creates, updates, endpointRows, coverageRows };
}

/**
 * The REAL authority, with the ledger writes redirected to an in-memory client
 * and the params captured. Everything else — runId minting, the StageRecorder,
 * the AsyncLocalStorage provider-call context, status derivation, error
 * rethrow — is the production code path.
 */
function spyingAuthority(client: RefreshExecutionWriteClient, calls: RunFullRefreshParams[]) {
  return function <T>(params: RunFullRefreshParams, deps: RunFullRefreshDeps<T> = {}): Promise<T> {
    calls.push(params);
    return runFullRefresh<T>(params, { ...deps, client });
  };
}

/** What the injected refreshPlaidItem stand-in observed about its own invocation. */
interface SeenOpts {
  deferSnapshot?: boolean;
  hasRecorder: boolean;
  runId?: string;
  contextExecutionId?: string;
}

function okItemResult(overrides: Partial<RefreshItemResult> = {}): RefreshItemResult {
  return {
    plaidItemId: "item-1",
    institution: "Chase",
    ok: true,
    accountsUpdated: 2,
    holdingsUpdated: 3,
    transactionsAdded: 5,
    transactionsModified: 1,
    transactionsRemoved: 0,
    spacesSnapshotted: [],
    updatedAccountIds: ["acc-1", "acc-2"],
    ...overrides,
  };
}

/** A lock wrapper that behaves like the real one: runs fn, rethrows, always releases. */
function realisticLock(released: string[]) {
  return async function <T>(itemId: string, fn: () => Promise<T>): Promise<SyncLockResult<T>> {
    try {
      return { ok: true, result: await fn() };
    } finally {
      released.push(itemId);
    }
  };
}

/** A lock wrapper that is already held: fn must never run. */
function heldLock(fnCalls: { count: number }) {
  return async function <T>(_itemId: string, _fn: () => Promise<T>): Promise<SyncLockResult<T>> {
    void fnCalls;
    return { ok: false, reason: "in-flight" };
  };
}

async function main() {
  // ══ 1. BEHAVIOURAL, per item — the envelope exists and is live ═════════════
  console.log("1. every per-item manual refresh runs inside the canonical envelope");
  {
    const ledger = makeLedger();
    const calls: RunFullRefreshParams[] = [];
    const released: string[] = [];
    let seen: SeenOpts | undefined;

    const result = await runManualItemRefresh("item-A", {
      runFullRefresh: spyingAuthority(ledger.client, calls),
      withLock: realisticLock(released) as never,
      refreshItem: async (id, opts) => {
        seen = {
          deferSnapshot: opts?.deferSnapshot,
          hasRecorder: opts?.recorder !== undefined,
          runId: opts?.runId,
          contextExecutionId: getProviderCallContext()?.refreshExecutionId,
        };
        // Drive the recorder exactly as refreshPlaidItem does, so the rows this
        // produces PROVE the recorder handed over is the execution's own.
        opts?.recorder?.begin("BALANCES", "PROVIDER");
        opts?.recorder?.succeed("BALANCES", {
          recordsChanged: 2,
          coveredAccountIds: ["acc-1", "acc-2"],
          accounts: [{ financialAccountId: "acc-1", status: "COVERED", freshnessAdvanced: true }],
        });
        opts?.recorder?.begin("TRANSACTIONS", "PROVIDER");
        opts?.recorder?.succeed("TRANSACTIONS", { recordsRead: 6, recordsWritten: 6, recordsChanged: 6 });
        // deferSnapshot's own truthful record (refresh.ts does this, not us).
        opts?.recorder?.skip("SNAPSHOT", "DERIVED", "BUDGET");
        return okItemResult({ plaidItemId: id });
      },
    });

    check("exactly ONE execution is opened for one item", ledger.creates.length === 1,
      `got ${ledger.creates.length}`);
    check("the authority was invoked exactly once", calls.length === 1, `got ${calls.length}`);
    check("trigger is MANUAL", calls[0]?.trigger === "MANUAL", String(calls[0]?.trigger));
    check("profile is FULL_REFRESH", calls[0]?.profile === "FULL_REFRESH", String(calls[0]?.profile));
    check("the execution names the right item", calls[0]?.itemId === "item-A");
    check("NO parentJobRunId is claimed (no JobRun in this slice)",
      calls[0]?.parentJobRunId === undefined && ledger.creates[0]?.parentJobRunId === null);
    check("the opened row is RUNNING with a runId", ledger.creates[0]?.overallStatus === "RUNNING"
      && typeof ledger.creates[0]?.runId === "string" && ledger.creates[0]!.runId.length > 0);

    // ── the seam that actually failed in production ────────────────────────
    check("NEGATIVE CONTROL: refreshPlaidItem received a recorder (undefined = the OPS-REFRESH-1A defect)",
      seen?.hasRecorder === true);
    check("NEGATIVE CONTROL: refreshPlaidItem received the execution's runId",
      typeof seen?.runId === "string" && seen.runId === ledger.creates[0]?.runId,
      `opts.runId=${seen?.runId} execution.runId=${ledger.creates[0]?.runId}`);
    check("deferSnapshot: true is preserved", seen?.deferSnapshot === true);
    check("the provider-call context is established for this item",
      seen?.contextExecutionId === "exec-1", String(seen?.contextExecutionId));

    // ── the recorder is the LIVE one, not a detached stub ──────────────────
    const rows = ledger.endpointRows.filter((r) => r.refreshExecutionId === "exec-1");
    check("the recorder's stages persist UNDER this execution", rows.length === 3,
      `got ${rows.length}`);
    check("BALANCES recorded SUCCEEDED with its counts",
      rows.some((r) => r.endpoint === "BALANCES" && r.status === "SUCCEEDED" && r.recordsChanged === 2));
    check("TRANSACTIONS recorded SUCCEEDED", rows.some((r) => r.endpoint === "TRANSACTIONS" && r.status === "SUCCEEDED"));
    check("SNAPSHOT recorded SKIPPED(BUDGET) — the deferral is DISCLOSED, not hidden",
      rows.some((r) => r.endpoint === "SNAPSHOT" && r.status === "SKIPPED" && r.skipReason === "BUDGET"));
    check("per-account coverage lands under this execution",
      ledger.coverageRows.length === 1 && ledger.coverageRows[0]?.refreshExecutionId === "exec-1");
    check("the execution closes SUCCEEDED (a SKIPPED stage never degrades it)",
      ledger.updates.length === 1 && ledger.updates[0]?.data.overallStatus === "SUCCEEDED");

    check("the lock was still acquired and released", released.length === 1 && released[0] === "item-A");
    check("the caller still receives the ordinary SyncLockResult",
      result.ok === true && result.result.plaidItemId === "item-A");
  }

  // ══ 2. Lock contention is now OBSERVABLE (the Option-1 payoff) ═════════════
  console.log("2. lock contention records a SKIPPED execution instead of vanishing");
  {
    const ledger = makeLedger();
    const calls: RunFullRefreshParams[] = [];
    const fnCalls = { count: 0 };
    let refreshItemCalled = false;

    const result = await runManualItemRefresh("item-B", {
      runFullRefresh: spyingAuthority(ledger.client, calls),
      withLock: heldLock(fnCalls) as never,
      refreshItem: async () => { refreshItemCalled = true; return okItemResult(); },
    });

    check("an execution IS opened before the lock is attempted", ledger.creates.length === 1);
    check("refreshPlaidItem was NEVER called", refreshItemCalled === false);
    const rows = ledger.endpointRows;
    check("TRANSACTIONS recorded SKIPPED(IN_FLIGHT)",
      rows.length === 1 && rows[0]?.endpoint === "TRANSACTIONS"
      && rows[0]?.status === "SKIPPED" && rows[0]?.skipReason === "IN_FLIGHT"
      && rows[0]?.stageKind === "PROVIDER");
    check("the execution derives SKIPPED (nothing attempted), not FAILED",
      ledger.updates[0]?.data.overallStatus === "SKIPPED");
    check("no admissionReason is invented — this is contention, not policy deferral",
      ledger.updates[0]?.data.admissionReason === undefined);
    check("the caller still receives { ok: false, reason: 'in-flight' }",
      result.ok === false && result.reason === "in-flight");
  }

  // ══ 3. Failure keeps its identity (health classification is unchanged) ═════
  console.log("3. a provider failure is rethrown as the ORIGINAL error");
  {
    const ledger = makeLedger();
    const calls: RunFullRefreshParams[] = [];
    const released: string[] = [];
    const boom = new Error("ITEM_LOGIN_REQUIRED");
    let thrown: unknown;

    try {
      await runManualItemRefresh("item-C", {
        runFullRefresh: spyingAuthority(ledger.client, calls),
        withLock: realisticLock(released) as never,
        refreshItem: async (_id, opts) => {
          opts?.recorder?.begin("BALANCES", "PROVIDER");
          throw boom;
        },
      });
    } catch (e) { thrown = e; }

    check("the ORIGINAL error object is rethrown (identity, not a wrapper)", thrown === boom);
    check("the open stage is finalized FAILED by failOpen",
      ledger.endpointRows.some((r) => r.endpoint === "BALANCES" && r.status === "FAILED"));
    check("the execution derives FAILED (every attempted PROVIDER stage failed)",
      ledger.updates[0]?.data.overallStatus === "FAILED");
    check("errorSummary is recorded", typeof ledger.updates[0]?.data.errorSummary === "string");
    check("the lock was released despite the throw", released.length === 1);
  }

  // ══ 4. BEHAVIOURAL, fan-out — one envelope per ELIGIBLE item ══════════════
  console.log("4. the fan-out sends every eligible item through the envelope, exactly once");
  {
    const envelopeCalls: string[] = [];
    const regenCalls: Array<{ succeeded: string[]; failed: string[] }> = [];
    const selfHealed: string[] = [];

    const deps: RefreshAllDeps = {
      listActiveItems: async () => [
        { id: "ok-1",     institutionName: "Chase" },
        { id: "orphan",   institutionName: "Dead Bank" },
        { id: "locked",   institutionName: "Amex" },
        { id: "boom",     institutionName: "Schwab" },
        { id: "ok-2",     institutionName: "Fidelity" },
      ],
      hasActiveLinkedAccount: async (id) => id !== "orphan",
      selfHealOrphaned: async (id) => { selfHealed.push(id); },
      runItem: async (id) => {
        envelopeCalls.push(id);
        if (id === "locked") return { ok: false, reason: "in-flight" };
        if (id === "boom") throw new Error("provider exploded");
        return { ok: true, result: okItemResult({ plaidItemId: id, updatedAccountIds: [`acc-${id}`] }) };
      },
      onItemFailure: async () => {},
      regenerateCompleted: async (succeeded, failed) => {
        regenCalls.push({ succeeded: [...succeeded], failed: [...failed] });
        return ["space-1"];
      },
    };

    const summary = await refreshAllActiveItemsForUser("user-1", undefined, deps);

    check("one envelope per ELIGIBLE item — the orphan is excluded",
      envelopeCalls.join(",") === "ok-1,locked,boom,ok-2", envelopeCalls.join(","));
    check("the orphan was self-healed instead, with NO provider call and NO execution",
      selfHealed.length === 1 && selfHealed[0] === "orphan");
    check("deterministic item association (list order preserved)",
      envelopeCalls.length === new Set(envelopeCalls).size);

    // Summary semantics — unchanged from before the envelope existed.
    check("itemCount still counts every listed item (incl. the orphan)", summary.itemCount === 5);
    check("results carry one row per item that reached the envelope", summary.results.length === 4);
    check("the in-flight item is reported as skipped, not failed",
      summary.results.find((r) => r.plaidItemId === "locked")?.skipped === "in-flight");
    check("the failed item is reported ok:false with its message",
      summary.results.find((r) => r.error === "provider exploded")?.ok === false);
    check("totals aggregate only the successful items",
      summary.totalAccountsUpdated === 4 && summary.totalTransactionsAdded === 10);

    // Post-loop snapshot regeneration — once, with the right inputs.
    check("regenerateCompletedSpaces ran EXACTLY once, after the loop", regenCalls.length === 1);
    check("it received only the succeeded accounts",
      regenCalls[0]?.succeeded.join(",") === "acc-ok-1,acc-ok-2", regenCalls[0]?.succeeded.join(","));
    check("it received the failed item so its Spaces stay untarnished",
      regenCalls[0]?.failed.join(",") === "boom");
    check("spacesSnapshotted is returned unchanged", summary.spacesSnapshotted.join(",") === "space-1");
  }

  // ══ 5. Eligibility edges ══════════════════════════════════════════════════
  console.log("5. non-attempts correctly produce NO execution");
  {
    const envelopeCalls: string[] = [];
    const seenExclusions: string[][] = [];
    const summary = await refreshAllActiveItemsForUser(
      "user-1",
      { excludeItemIds: ["cooling-down"] },
      {
        listActiveItems: async (_u, exclude) => { seenExclusions.push([...exclude]); return []; },
        runItem: async (id) => { envelopeCalls.push(id); return { ok: true, result: okItemResult() }; },
        regenerateCompleted: async () => [],
      },
    );
    check("the route's cooldown exclusions reach the candidate query",
      seenExclusions[0]?.join(",") === "cooling-down");
    check("a cooldown-excluded item never reaches the envelope", envelopeCalls.length === 0);
    check("no items ⇒ no executions and an empty summary",
      summary.itemCount === 0 && summary.results.length === 0);
  }

  // ══ 6. STRUCTURAL — the envelope cannot be bypassed ═══════════════════════
  console.log("6. the fan-out cannot call refreshPlaidItem outside the envelope");
  {
    const ROOT = process.cwd();
    const raw = readFileSync(path.join(ROOT, "lib", "plaid", "refresh.ts"), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // refreshAllActiveItemsForUser is the LAST declaration in the file, so
    // "from its signature to EOF" is its body without brace-matching (which
    // has bitten this repo before by swallowing a return-type brace).
    const fanoutAt = src.indexOf("export async function refreshAllActiveItemsForUser");
    check("the fan-out is locatable", fanoutAt >= 0);
    const fanoutBody = src.slice(fanoutAt);
    check("the fan-out body NEVER calls refreshPlaidItem directly",
      !/refreshPlaidItem\s*\(/.test(fanoutBody));
    check("the fan-out body NEVER claims the lock itself",
      !/withPlaidItemSyncLock\s*\(/.test(fanoutBody));
    check("the fan-out body delegates to the injected per-item unit",
      /runItem\(item\.id\)/.test(fanoutBody));
    check("the injected default IS the execution envelope",
      /deps\.runItem\s*\?\?\s*runManualItemRefresh/.test(fanoutBody));

    // The per-item unit: the authority is entered BEFORE the lock is claimed.
    const unitAt = src.indexOf("export async function runManualItemRefresh");
    const unit = src.slice(unitAt, src.indexOf("async function regenerateCompletedSpaces"));
    check("runManualItemRefresh resolves the canonical authority by default",
      /await import\("@\/lib\/plaid\/refresh-execution"\)\)\.runFullRefresh/.test(unit));
    check("the lock is claimed INSIDE the envelope (authority first, lock second)",
      unit.indexOf("runFullRefresh<") >= 0 && unit.indexOf("withLock(") > unit.indexOf("runFullRefresh<"));
    check("it declares MANUAL / FULL_REFRESH",
      /trigger:\s*"MANUAL"/.test(unit) && /profile:\s*"FULL_REFRESH"/.test(unit));
    check("it passes deferSnapshot: true", /deferSnapshot:\s*true/.test(unit));
    check("it writes no route-local execution record",
      !/\.(refreshExecution|refreshEndpointResult|providerCall|refreshEndpointAccountCoverage)\s*\./.test(unit));
    check("no JobRun is created in this slice",
      !/runJob\s*\(|parentJobRunId/.test(unit) && !/runJob\s*\(/.test(fanoutBody));

    // The authority module really does export what the lazy import names.
    const authority = await import("@/lib/plaid/refresh-execution");
    check("the lazily-imported name resolves to a function",
      typeof authority.runFullRefresh === "function");
  }

  // ══ 7. The other paths were not disturbed ════════════════════════════════
  console.log("7. branch A, cron, webhook, reconnect and resume are untouched");
  {
    const ROOT = process.cwd();
    const strip = (rel: string) =>
      readFileSync(path.join(ROOT, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

    const route = strip("app/api/plaid/refresh/route.ts");
    check("branch A still wraps runFullRefresh in the lock (unchanged this slice)",
      /withPlaidItemSyncLock\(item\.id,\s*\(\)\s*=>[\s\S]{0,120}runFullRefresh\(/.test(route));
    check("branch B still delegates to refreshAllActiveItemsForUser",
      /refreshAllActiveItemsForUser\(user\.id/.test(route));
    check("the route still writes no execution record of its own",
      !/\.(refreshExecution|refreshEndpointResult|providerCall)\s*\./.test(route));

    for (const [file, marker] of [
      ["jobs/sync-banks.ts", /trigger:\s*"CRON"/],
      ["lib/plaid/webhook-sync.ts", /runFullRefresh<WebhookSyncOutcome>/],
      ["app/api/plaid/resume-sync/route.ts", /trigger:\s*"RESUME"/],
      ["app/api/plaid/sync/route.ts", /profile:\s*"TRANSACTIONS_ONLY"/],
    ] as const) {
      check(`${file}: still reaches the authority as before`, marker.test(strip(file)));
    }
  }

  if (failures > 0) {
    console.error(`\nrefresh-fanout.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nrefresh-fanout.test: all passed.");
}

void main();
