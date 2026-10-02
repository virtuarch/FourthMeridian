/**
 * lib/plaid/refresh-ledger-failure-matrix.test.ts  (RLS-P-2)
 *
 * WHAT EACH WAY THE OPERATIONAL LEDGER CAN FAIL ACTUALLY MEANS.
 *
 * RLS-P-1 gave the (B) family one door and made a swallowed failure
 * EXPRESSIBLE. It did not make any of it OBSERVED: `degradations` had no
 * production reader, `isTotalBlackout()` had none either, and seven of the nine
 * ledger-write sites escalated to nothing at all. A refresh whose entire stage
 * evidence failed to write returned, byte for byte, what a fully-recorded
 * refresh returns.
 *
 * This suite is the twelve-scenario matrix for that. Every case is driven
 * through the REAL door and the REAL orchestrator over an in-memory client, so
 * each claim is about the production code path rather than about a fixture.
 *
 *   1  provider fails before financial persistence
 *   2  financial persistence fails
 *   3  financial persistence succeeds, operational bookkeeping fails
 *   4  bookkeeping succeeds, a LATER financial phase fails
 *   5  partial provider payload
 *   6  retry / idempotency
 *   7  duplicate execution
 *   8  stale execution
 *   9  tenant (fm_app) refusal
 *  10  system (fm_system) refusal
 *  11  zero-row conditional write
 *  12  batch / partial-write accounting
 *
 * ⚠️ WHAT THIS SUITE CANNOT PROVE, STATED SO NOBODY READS IT AS PROVEN. Cases 9
 * and 10 inject the ERROR SHAPE a refused statement produces; they say nothing
 * about whether a policy would actually refuse. A fake client cannot speak about
 * a policy — it answers whatever it was written to answer. The role-level half
 * lives in scripts/rls-plaid-acceptance.ts against real fm_app / fm_system
 * principals, and neither suite substitutes for the other.
 *
 * ⚠️ EVERY ABSENCE CLAIM CARRIES ITS DENOMINATOR, and §13 re-runs each source
 * scan against deliberately violating text to prove it can go red. A scan that
 * matched nothing passes for the wrong reason, and this programme has shipped
 * exactly that bug.
 *
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs <this>
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveByAutomaticRecovery, type IncidentClient } from "@/lib/platform/incidents/lifecycle";
import {
  describeLedgerDegradations,
  isTotalBlackout,
  ledgerCompleteness,
  ledgerRecorderFor,
  type LedgerDegradation,
  type LedgerTable,
  type LedgerWriteClient,
  type LedgerWritePhase,
} from "@/lib/plaid/refresh-ledger";
import { runFullRefresh, type RefreshExecutionStartData } from "@/lib/plaid/refresh-execution";
import type { RefreshStageRecorder } from "@/lib/plaid/refresh-execution-types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** One row of the reported matrix. Printed at the end, pass or fail. */
const MATRIX: Array<{ n: number; scenario: string; meaning: string }> = [];
function record(n: number, scenario: string, meaning: string): void {
  MATRIX.push({ n, scenario, meaning });
}

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const ROOT = process.cwd();
const DOOR = "lib/plaid/refresh-ledger.ts";
const ORCHESTRATOR = "lib/plaid/refresh-execution.ts";
const AUTHORITY = "lib/platform/incidents/lifecycle.ts";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Let the void-dispatched provider-call emit settle before anything is counted. */
const settle = () => new Promise((r) => setImmediate(r));

// ── The in-memory ledger, with per-statement failure injection ───────────────

type Stmt = "start" | "stages" | "stageRow" | "coverage" | "providerCall" | "completion";

/**
 * The error a REFUSED statement surfaces as.
 *
 * Both roles refuse through the GRANT layer for this family — `fm_app` is
 * revoked from all six tables outright (migration §4) rather than carrying a
 * false policy — so both produce SQLSTATE 42501 and Prisma reports it as P2010
 * (raw query failed). They are injected as distinct codes anyway, because the
 * suite's job is to show that the door reports WHAT IT WAS TOLD rather than
 * collapsing every refusal into one fingerprint an operator cannot act on.
 */
const REFUSED_BY_GRANT = () => Object.assign(new Error("denied"), { code: "P2010" });
const REFUSED_BY_POLICY = () => Object.assign(new Error("new row violates row-level security policy"), { code: "P2004" });
const SCHEMA_DRIFT = () => Object.assign(new Error("column does not exist"), { code: "P2022" });

interface FakeOpts {
  fail?: Partial<Record<Stmt, () => Error>>;
}

function fakeLedger(opts: FakeOpts = {}) {
  const fail = opts.fail ?? {};
  const starts: RefreshExecutionStartData[] = [];
  const completions: Array<{ id: string; data: Record<string, unknown> }> = [];
  const stageBatches: Array<Record<string, unknown>> = [];
  const stageRows: Array<Record<string, unknown>> = [];
  const coverage: Array<Record<string, unknown>> = [];
  const providerCalls: Array<Record<string, unknown>> = [];
  let seq = 0;
  const boom = (s: Stmt) => { const f = fail[s]; if (f) throw f(); };

  const client: LedgerWriteClient = {
    refreshExecution: {
      async create({ data }) {
        boom("start");
        starts.push(data);
        return { id: `exec-${++seq}` };
      },
      async update({ where, data }) {
        boom("completion");
        completions.push({ id: where.id, data: data as unknown as Record<string, unknown> });
        return {};
      },
    },
    refreshEndpointResult: {
      async createMany({ data }) {
        boom("stages");
        stageBatches.push(...(data as unknown as Record<string, unknown>[]));
        return {};
      },
      async create({ data }) {
        boom("stageRow");
        stageRows.push(data as unknown as Record<string, unknown>);
        return {};
      },
      // RLS-P-2 — the attempt-numbering probe now runs on the WRITE client, so
      // the fake must answer it. Backed by the same array the inserts land in:
      // a probe that answered from somewhere else would be the defect.
      async findFirst({ where }) {
        const prior = stageRows.filter(
          (r) => r.refreshExecutionId === where.refreshExecutionId && r.endpoint === where.endpoint,
        );
        if (prior.length === 0) return null;
        return { attempt: Math.max(...prior.map((r) => Number(r.attempt ?? 0))) };
      },
    },
    refreshEndpointAccountCoverage: {
      async createMany({ data }) {
        boom("coverage");
        coverage.push(...(data as unknown as Record<string, unknown>[]));
        return {};
      },
    },
    providerCall: {
      async create({ data }) {
        boom("providerCall");
        providerCalls.push(data as unknown as Record<string, unknown>);
        return {};
      },
    },
  };
  return { client, starts, completions, stageBatches, stageRows, coverage, providerCalls };
}

function startData(runId = "run-1"): RefreshExecutionStartData {
  return {
    runId,
    plaidItemId: "item-1",
    sourceKind: "PLAID_ITEM",
    sourceRef: null,
    network: null,
    trigger: "MANUAL",
    profile: "FULL_REFRESH",
    parentJobRunId: null,
    startedAt: new Date(0),
    overallStatus: "RUNNING",
    deploymentSha: null,
  };
}

/** A runner that records one SUCCEEDED provider stage covering one account. */
const oneGoodStage = async ({ recorder }: { recorder: RefreshStageRecorder }) => {
  recorder.begin("BALANCES", "PROVIDER");
  recorder.succeed("BALANCES", {
    recordsChanged: 1,
    coveredAccountIds: ["a1"],
    accounts: [{ financialAccountId: "a1", status: "COVERED", freshnessAdvanced: true }],
  });
  return "ran" as const;
};

/** Collect the (table, phase) pairs the escalation was actually asked to send. */
function captureSpy() {
  const sent: Array<[LedgerTable, LedgerWritePhase]> = [];
  return { sent, capture: (l: LedgerTable, p: LedgerWritePhase) => { sent.push([l, p]); } };
}

// ── Source scans (pure, so §13 can mutation-test them) ───────────────────────

/**
 * SCENARIO 11 (mechanical) — the refresh ledger contains NO compare-and-swap.
 *
 * A zero-row `updateMany`/`deleteMany` is the silent-refusal defect's write
 * face, and the only honest way to be immune to it is not to have one. The door
 * writes with `create`/`createMany` and ONE `update` keyed by a primary key —
 * which RAISES P2025 rather than returning a count — so there is no count
 * anywhere for a refusal to hide in.
 */
function scanNoConditionalWrite(src: string): { examined: number; bad: string[] } {
  const code = stripComments(src);
  const bad: string[] = [];
  let examined = 0;
  // Escaped and anchored on the DOT, so this cannot match a word in prose. The
  // earlier version of this programme's scan used an unescaped `$` and matched
  // nothing while reporting clean over zero sites.
  for (const m of code.matchAll(/\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g)) {
    examined++;
    if (m[1] === "updateMany" || m[1] === "deleteMany") bad.push(m[1]);
  }
  return { examined, bad };
}

/**
 * THE RECORDER'S LIFETIME (mechanical) — `ledgerRecorderFor(` must not be called
 * at module scope in the orchestrator.
 *
 * A module-scope binding makes `degradations` process-global, so one refresh's
 * failures are read back as the next one's and a single failed `open()` makes
 * `isTotalBlackout()` true for every later refresh in that process. Indentation
 * is the signal and it is a weak one on its own, which is why the behavioural
 * half (§14) exists beside it.
 */
function scanRecorderIsPerRefresh(src: string): { examined: number; bad: string[] } {
  const code = stripComments(src);
  const bad: string[] = [];
  let examined = 0;
  for (const line of code.split("\n")) {
    if (!line.includes("ledgerRecorderFor(")) continue;
    examined++;
    if (/^(const|let|var|export)\s/.test(line)) bad.push(line.trim());
  }
  return { examined, bad };
}

/**
 * THE ESCALATION STAYS GREPPABLE (mechanical) — every `captureLedgerWriteFailure`
 * argument in the door is a STRING LITERAL.
 *
 * lib/jobs/run.test.ts pins the literal text `captureLedgerWriteFailure(
 * "RefreshExecution", "start"`. Passing the narrowed variables instead compiles,
 * is shorter, and silently retires that ratchet — so the literal form is the
 * property, not a style.
 */
function scanCaptureArgsAreLiterals(src: string): { examined: number; bad: string[] } {
  const code = stripComments(src);
  const bad: string[] = [];
  let examined = 0;
  for (const m of code.matchAll(/captureLedgerWriteFailure\(\s*([^,]+),\s*([^,]+),/g)) {
    examined++;
    const [, ledger, phase] = m;
    if (!/^"[A-Za-z]+"$/.test(ledger.trim()) || !/^"[A-Za-z]+"$/.test(phase.trim())) {
      bad.push(`${ledger.trim()}, ${phase.trim()}`);
    }
  }
  return { examined, bad };
}

/**
 * EVERY PAIR THE DOOR CAN PRODUCE HAS AN ESCALATION LINE (mechanical).
 *
 * ⚠️ THIS SCAN EXISTS BECAUSE THE BEHAVIOURAL CHECKS COULD NOT SEE THE BRANCH.
 * §3, §8, §9, §10 and §16 all assert that a failure "was escalated" — and every
 * one of them does it by INJECTING `deps.capture`, which replaces
 * `defaultCapture` outright. So the real escalation function was driven by no
 * test at all: re-adding its old `if (ledger !== "RefreshExecution") return;`
 * left the entire suite GREEN while seven of the nine ledger-write sites went
 * back to reaching no monitor. That is the "unit suite blind to the one branch
 * that mattered" failure, reproduced inside the slice that was fixing it.
 *
 * The honest substitute is not a bigger behavioural test — it is to compare TWO
 * MEASURED SETS:
 *
 *   PRODUCED   every (table, phase) the door actually degrades under. Taken from
 *              the door's own `degrade("X", "y"` literals, plus the pairs the
 *              incident authority reports back through the observer channel.
 *   ESCALATED  every pair `defaultCapture` has a `case` for.
 *
 * PRODUCED must be a subset of ESCALATED, both must be non-empty, and
 * `defaultCapture` must contain no early return before its switch. A missing
 * case fails on the first rule; a reinstated early return fails on the third.
 */
function scanEveryProducedPairIsEscalated(door: string, authority: string): { examined: number; bad: string[] } {
  const d = stripComments(door);
  const a = stripComments(authority);
  const bad: string[] = [];

  const produced = new Set<string>();
  for (const m of d.matchAll(/degrade\(\s*"([A-Za-z]+)"\s*,\s*"([A-Za-z]+)"/g)) produced.add(`${m[1]}/${m[2]}`);
  // The pairs that arrive as a reported SITE rather than as a local degrade call:
  // the incident authority names them, and the door forwards them verbatim.
  for (const m of a.matchAll(/reportWriteFailure\(\s*observers\s*,\s*"([A-Za-z]+)"\s*,\s*"([A-Za-z]+)"/g)) produced.add(`${m[1]}/${m[2]}`);

  const escalated = new Set<string>();
  const impl = d.slice(d.indexOf("function defaultCapture"));
  const body = impl.slice(0, impl.indexOf("\n}"));
  for (const m of body.matchAll(/case\s+"([A-Za-z]+)\/([A-Za-z]+)"/g)) escalated.add(`${m[1]}/${m[2]}`);

  if (produced.size === 0) bad.push("no produced pair found — the scan has no subject");
  if (escalated.size === 0) bad.push("no escalation case found — the scan has no subject");
  for (const pair of produced) if (!escalated.has(pair)) bad.push(`UNESCALATED: ${pair}`);

  // The early return that M6 reinstated. Anything that leaves defaultCapture
  // before reaching its switch makes the case table unreachable for some input.
  const beforeSwitch = body.slice(0, body.indexOf("switch"));
  if (/\breturn\b/.test(beforeSwitch)) bad.push("defaultCapture returns before its switch");

  return { examined: produced.size + escalated.size, bad };
}

async function main() {
  const doorSrc = read(DOOR);
  const orchSrc = read(ORCHESTRATOR);

  // ══ 1. PROVIDER FAILS BEFORE FINANCIAL PERSISTENCE ═══════════════════════
  console.log("1. provider fails before any financial persistence");
  {
    const boom = Object.assign(new Error("provider down"), { error_code: "ITEM_LOGIN_REQUIRED" });
    const f = fakeLedger();
    const recorder = ledgerRecorderFor(f.client);
    let rethrew: unknown;
    try {
      await runFullRefresh<never>(
        { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
        {
          client: recorder,
          refresh: async ({ recorder: r }) => { r.begin("BALANCES", "PROVIDER"); throw boom; },
        },
      );
    } catch (e) { rethrew = e; }
    const done = f.completions[0]?.data as { overallStatus?: string; errorSummary?: string } | undefined;
    check("the ORIGINAL error object is rethrown by identity", rethrew === boom);
    check("the execution is closed, not abandoned", f.completions.length === 1);
    check("overallStatus is FAILED (no provider stage succeeded)", done?.overallStatus === "FAILED",
      String(done?.overallStatus));
    check("the open stage was finalized as FAILED, not left open",
      f.stageBatches.length === 1 && f.stageBatches[0].status === "FAILED",
      JSON.stringify(f.stageBatches.map((s) => s.status)));
    check("the ledger itself is COMPLETE — a provider failure is not a ledger failure",
      ledgerCompleteness(recorder.degradations) === "COMPLETE",
      JSON.stringify(recorder.degradations));
    record(1, "provider fails before persistence",
      "FAILED execution + FAILED stage are WRITTEN; original error rethrown by identity; ledger COMPLETE. Retry safe (new runId). Not swallowed.");
  }

  // ══ 2. FINANCIAL PERSISTENCE FAILS ═══════════════════════════════════════
  console.log("2. the provider answered and persistence failed");
  {
    const boom = Object.assign(new Error("persist failed"), { code: "P2002" });
    const f = fakeLedger();
    const recorder = ledgerRecorderFor(f.client);
    let rethrew: unknown;
    try {
      await runFullRefresh<never>(
        { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
        {
          client: recorder,
          refresh: async ({ recorder: r }) => {
            r.begin("BALANCES", "PROVIDER");
            r.succeed("BALANCES", { recordsChanged: 1, coveredAccountIds: ["a1"], accounts: [] });
            r.begin("TRANSACTIONS", "PROVIDER");
            throw boom;            // the persistence leg, after a clean provider leg
          },
        },
      );
    } catch (e) { rethrew = e; }
    const done = f.completions[0]?.data as { overallStatus?: string } | undefined;
    check("the original persistence error is rethrown by identity", rethrew === boom);
    check("both stages are recorded — the succeeded one is NOT retracted",
      f.stageBatches.length === 2 &&
      f.stageBatches.filter((s) => s.status === "SUCCEEDED").length === 1 &&
      f.stageBatches.filter((s) => s.status === "FAILED").length === 1,
      JSON.stringify(f.stageBatches.map((s) => `${s.endpoint}:${s.status}`)));
    check("a mixed outcome closes PARTIAL, never SUCCEEDED", done?.overallStatus === "PARTIAL",
      String(done?.overallStatus));
    check("the ledger is COMPLETE", ledgerCompleteness(recorder.degradations) === "COMPLETE");
    record(2, "financial persistence fails",
      "PARTIAL execution; the succeeded stage is kept and the failed one recorded beside it; original error by identity; ledger COMPLETE. Never reported as SUCCEEDED.");
  }

  // ══ 3. PERSISTENCE SUCCEEDS, BOOKKEEPING FAILS ═══════════════════════════
  console.log("3. the refresh worked and the ledger did not");
  {
    const spy = captureSpy();
    const f = fakeLedger({ fail: { stages: SCHEMA_DRIFT, coverage: REFUSED_BY_GRANT, completion: REFUSED_BY_GRANT } });
    const recorder = ledgerRecorderFor(f.client, { capture: spy.capture });
    const out = await runFullRefresh<"ran">(
      { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client: recorder, refresh: oneGoodStage },
    );
    const d = recorder.degradations;
    check("the runner's own result is returned unchanged", out === "ran");
    check(`three writes failed and three degradations were named (${d.length})`, d.length === 3,
      JSON.stringify(d));
    check("each names its table, its phase and a Prisma code",
      d.every((x: LedgerDegradation) => /^P\d{4}$/.test(x.dbErrorCode)) &&
      new Set(d.map((x) => x.phase)).size === 3,
      JSON.stringify(d));
    check("the drift code survives classification (P2022 is not flattened)",
      d.some((x) => x.dbErrorCode === "P2022"));
    check("the completeness verdict is PARTIAL, not COMPLETE and not BLACKOUT",
      ledgerCompleteness(d) === "PARTIAL" && !isTotalBlackout(d));
    check("a one-line, actionable report exists for the operator",
      (describeLedgerDegradations("run-1", d) ?? "").includes("LEDGER PARTIAL"),
      String(describeLedgerDegradations("run-1", d)));
    check("the report carries no row and no message",
      !/denied|does not exist|a1/.test(describeLedgerDegradations("run-1", d) ?? ""),
      String(describeLedgerDegradations("run-1", d)));
    check(`every one of the three was ESCALATED, not only logged (${spy.sent.length})`,
      spy.sent.length === 3, JSON.stringify(spy.sent));
    check("the escalation names the TABLE that failed, not just the execution",
      spy.sent.some(([l]) => l === "RefreshEndpointResult") &&
      spy.sent.some(([l]) => l === "RefreshEndpointAccountCoverage") &&
      spy.sent.some(([l]) => l === "RefreshExecution"),
      JSON.stringify(spy.sent));
    record(3, "bookkeeping fails after persistence",
      "SWALLOWED BY CONTRACT, but no longer silent: result unchanged, 3 degradations, completeness PARTIAL, one operator line, 3 escalations. Refresh success is NOT overstated to the caller; the ledger ROW is, and the report says so.");
  }

  // ══ 4. BOOKKEEPING SUCCEEDS, A LATER FINANCIAL PHASE FAILS ═══════════════
  //
  // THIS SEQUENCE IS POSSIBLE, and it is worth saying which write makes it so.
  // The provider stages are buffered in memory and flushed ONCE at completion,
  // so they can never precede a later failure. The HISTORICAL stages cannot be:
  // V26-STAGE-1 persists each one as it settles precisely so a crash mid-pipeline
  // is resumable, which means a durable SUCCEEDED row can and does outlive the
  // run that wrote it.
  console.log("4. an already-durable stage row survives a later failure");
  {
    const boom = new Error("a later phase died");
    const f = fakeLedger();
    const recorder = ledgerRecorderFor(f.client);
    let rethrew: unknown;
    try {
      await runFullRefresh<never>(
        { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
        {
          client: recorder,
          refresh: async ({ recorder: r }) => {
            // The incremental write: settled, durable, before anything else runs.
            await (r as { ledger?: { settleHistoricalStage: (a: Record<string, unknown>) => Promise<void> } })
              .ledger?.settleHistoricalStage({ stage: "COVERAGE", status: "SUCCEEDED", startedAt: new Date(0) });
            r.begin("TRANSACTIONS", "PROVIDER");
            throw boom;
          },
        },
      );
    } catch (e) { rethrew = e; }
    const done = f.completions[0]?.data as { overallStatus?: string } | undefined;
    check("the historical stage row was persisted BEFORE the failure",
      f.stageRows.length === 1 && f.stageRows[0].status === "SUCCEEDED",
      JSON.stringify(f.stageRows.map((s) => `${s.endpoint}:${s.status}`)));
    check("the durable row is NOT rewritten or retracted by the failure",
      f.stageRows.length === 1 && f.stageRows[0].status === "SUCCEEDED");
    check("the execution still closes FAILED", done?.overallStatus === "FAILED", String(done?.overallStatus));
    check("the original error is still rethrown by identity", rethrew === boom);
    record(4, "bookkeeping precedes a later financial failure",
      "POSSIBLE — only via the INCREMENTAL historical stage writer (the provider stages flush once, at completion, so they cannot). A durable SUCCEEDED stage coexisting with a FAILED execution is CORRECT and append-only: the stage did succeed. Nothing is rewritten.");
  }

  // ══ 5. PARTIAL PROVIDER PAYLOAD ══════════════════════════════════════════
  console.log("5. a partial provider payload cannot close as SUCCEEDED");
  {
    const f = fakeLedger();
    const recorder = ledgerRecorderFor(f.client);
    const out = await runFullRefresh<"partial">(
      { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      {
        client: recorder,
        refresh: async ({ recorder: r }) => {
          // Two of three accounts answered; the third is reported UNCOVERED.
          r.begin("BALANCES", "PROVIDER");
          r.succeed("BALANCES", {
            recordsChanged: 2,
            coveredAccountIds: ["a1", "a2"],
            accounts: [
              { financialAccountId: "a1", status: "COVERED", freshnessAdvanced: true },
              { financialAccountId: "a2", status: "COVERED", freshnessAdvanced: true },
              { financialAccountId: "a3", status: "FAILED", reason: "PROVIDER_FAILURE", freshnessAdvanced: false },
            ],
          });
          r.begin("HOLDINGS", "PROVIDER");
          r.fail("HOLDINGS", new Error("holdings truncated"));
          return "partial" as const;
        },
      },
    );
    const done = f.completions[0]?.data as { overallStatus?: string } | undefined;
    check("the runner's result is returned unchanged", out === "partial");
    check("a mixed payload closes PARTIAL", done?.overallStatus === "PARTIAL", String(done?.overallStatus));
    check(`coverage records the account that did NOT answer, as FAILED/PROVIDER_FAILURE (${f.coverage.length} rows)`,
      f.coverage.length === 3 && f.coverage.some((c) => c.financialAccountId === "a3" && c.status === "FAILED" && c.reason === "PROVIDER_FAILURE"),
      JSON.stringify(f.coverage.map((c) => `${c.financialAccountId}:${c.status}`)));
    check("the account that did not answer is NOT marked freshnessAdvanced",
      f.coverage.find((c) => c.financialAccountId === "a3")?.freshnessAdvanced === false);
    check("the ledger is COMPLETE — partial DATA is not a partial LEDGER",
      ledgerCompleteness(recorder.degradations) === "COMPLETE");
    record(5, "partial provider payload",
      "NO misleading completion: PARTIAL status, and the account that did not answer is written as FAILED/PROVIDER_FAILURE with freshnessAdvanced=false rather than omitted. Absence and non-coverage are different rows.");
  }

  // ══ 6. RETRY / IDEMPOTENCY ═══════════════════════════════════════════════
  console.log("6. a retry is a new execution, never a rewrite of the old one");
  {
    const f = fakeLedger();
    await runFullRefresh<"ran">({ itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client: ledgerRecorderFor(f.client), refresh: oneGoodStage });
    await runFullRefresh<"ran">({ itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client: ledgerRecorderFor(f.client), refresh: oneGoodStage });
    const runIds = f.starts.map((s) => s.runId);
    check("two attempts opened two executions", f.starts.length === 2);
    check("each minted its OWN runId — the idempotency key is never reused",
      new Set(runIds).size === 2 && runIds.every((r) => /^[0-9a-f-]{36}$/.test(r)), runIds.join(","));
    check("each closed exactly once: one create, one update, append-only",
      f.completions.length === 2 && new Set(f.completions.map((c) => c.id)).size === 2);
    check("the second attempt did not touch the first execution's row",
      f.completions[1].id !== f.completions[0].id);
    record(6, "retry / idempotency",
      "SAFE. Each attempt mints a fresh runId and opens its own row; nothing is keyed on a caller-supplied id, so a retry cannot overwrite, resurrect or re-complete an earlier execution. Append-only holds: one create + one update per execution.");
  }

  // ══ 7. DUPLICATE EXECUTION ═══════════════════════════════════════════════
  console.log("7. two executions in flight never write into each other");
  {
    const f = fakeLedger();
    const a = ledgerRecorderFor(f.client);
    const b = ledgerRecorderFor(f.client);
    const ha = await a.open(startData("run-A"));
    const hb = await b.open(startData("run-B"));
    check("two distinct execution ids were minted", ha?.executionId !== hb?.executionId);
    // Interleaved, and each one SPOOFS the other's id in the row it hands over.
    await ha?.recordStages([{ endpoint: "BALANCES", stageKind: "PROVIDER", status: "SUCCEEDED",
      startedAt: new Date(0), completedAt: new Date(0), durationMs: 0, coveredAccountIds: [],
      refreshExecutionId: hb?.executionId } as never]);
    await hb?.recordStages([{ endpoint: "BALANCES", stageKind: "PROVIDER", status: "SUCCEEDED",
      startedAt: new Date(0), completedAt: new Date(0), durationMs: 0, coveredAccountIds: [],
      refreshExecutionId: ha?.executionId } as never]);
    check(`each row carries its OWN execution's minted id (${f.stageBatches.length} rows)`,
      f.stageBatches.length === 2 &&
      f.stageBatches[0].refreshExecutionId === ha?.executionId &&
      f.stageBatches[1].refreshExecutionId === hb?.executionId,
      JSON.stringify(f.stageBatches.map((s) => s.refreshExecutionId)));
    check("neither recorder's degradation list saw the other's work",
      a.degradations.length === 0 && b.degradations.length === 0);
    record(7, "duplicate execution",
      "SAFE FOR THE LEDGER. Concurrent executions are independent append-only rows and neither can write under the other's id — the id is minted by open() and no entry point accepts one. Duplicate PROVIDER work is prevented upstream by the per-item sync lock, which is a different guarantee and not this door's.");
  }

  // ══ 8. STALE EXECUTION ═══════════════════════════════════════════════════
  console.log("8. a stale execution is distinguishable from a running one");
  {
    const spy = captureSpy();
    const f = fakeLedger({ fail: { completion: REFUSED_BY_GRANT } });
    const recorder = ledgerRecorderFor(f.client, { capture: spy.capture });
    const out = await runFullRefresh<"ran">(
      { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client: recorder, refresh: oneGoodStage },
    );
    check("the refresh itself still succeeded", out === "ran");
    check("the completion write never landed", f.completions.length === 0);
    check("the row is left RUNNING with no completedAt — readable as stale",
      f.starts[0].overallStatus === "RUNNING" && !("completedAt" in f.starts[0]),
      JSON.stringify(f.starts[0].overallStatus));
    check("its stage children DID land, so a stuck row is not an empty one",
      f.stageBatches.length === 1);
    check("the degradation names RefreshExecution/completion",
      recorder.degradations.length === 1 &&
      recorder.degradations[0].ledger === "RefreshExecution" &&
      recorder.degradations[0].phase === "completion",
      JSON.stringify(recorder.degradations));
    check("it is NOT reported as a blackout — the row exists",
      ledgerCompleteness(recorder.degradations) === "PARTIAL" && !isTotalBlackout(recorder.degradations));
    check("the completion failure was escalated",
      spy.sent.length === 1 && spy.sent[0][0] === "RefreshExecution" && spy.sent[0][1] === "completion",
      JSON.stringify(spy.sent));
    record(8, "stale execution",
      "DISTINGUISHABLE by state, not by clock: overallStatus=RUNNING with completedAt null. A crash and a refused completion write produce the same row — the difference is that the refusal is now escalated under RefreshExecution/completion, so a stale row has a cause in monitoring. NOT distinguishable from a still-running one by the row ALONE (P2 finding; the row has no lease).");
  }

  // ══ 9 & 10. REFUSALS — TENANT AND SYSTEM ═════════════════════════════════
  console.log("9+10. a refusal of any kind is non-fatal, named, and escalated");
  {
    // 9 — the tenant shape: fm_app is REVOKED from all six tables, so its
    //     refusal arrives from the GRANT layer and raises.
    const spyA = captureSpy();
    const fa = fakeLedger({ fail: { start: REFUSED_BY_GRANT } });
    const ra = ledgerRecorderFor(fa.client, { capture: spyA.capture });
    const outA = await runFullRefresh<"ran">(
      { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client: ra, refresh: oneGoodStage },
    );
    await settle();
    check("[9] the refresh still ran and returned its own result", outA === "ran");
    check("[9] a refused START is a TOTAL BLACKOUT, named as one",
      ledgerCompleteness(ra.degradations) === "BLACKOUT" && isTotalBlackout(ra.degradations));
    check("[9] the blackout is ONE degradation, not one per suppressed write",
      ra.degradations.length === 1 && ra.degradations[0].dbErrorCode === "P2010");
    check("[9] nothing at all was written: zero of every row type",
      fa.starts.length === 0 && fa.stageBatches.length === 0 && fa.stageRows.length === 0 &&
      fa.coverage.length === 0 && fa.providerCalls.length === 0 && fa.completions.length === 0);
    check("[9] it was escalated as RefreshExecution/start",
      spyA.sent.length === 1 && spyA.sent[0][1] === "start", JSON.stringify(spyA.sent));

    // 10 — the system shape: a policy refusal on a non-start write. Same
    //      posture, different verdict, and a DIFFERENT code reaching the tag.
    const spyB = captureSpy();
    const fb = fakeLedger({ fail: { stages: REFUSED_BY_POLICY, providerCall: REFUSED_BY_POLICY } });
    const rb = ledgerRecorderFor(fb.client, { capture: spyB.capture });
    const hb = await rb.open(startData("run-sys"));
    await hb?.recordStages([{ endpoint: "BALANCES", stageKind: "PROVIDER", status: "SUCCEEDED",
      startedAt: new Date(0), completedAt: new Date(0), durationMs: 0, coveredAccountIds: [] }]);
    hb?.recordProviderCall({ provider: "PLAID", operation: "accountsGet", status: "SUCCEEDED",
      attempt: 1, startedAt: new Date(0), completedAt: new Date(0), durationMs: 0 });
    await settle();
    check("[10] the execution row survives a refused CHILD write",
      fb.starts.length === 1 && !isTotalBlackout(rb.degradations));
    check("[10] both refusals were named, with the policy code preserved",
      rb.degradations.length === 2 && rb.degradations.every((d) => d.dbErrorCode === "P2004"),
      JSON.stringify(rb.degradations));
    check("[10] the fire-and-forget provider-call refusal was ALSO reported",
      rb.degradations.some((d) => d.ledger === "ProviderCall" && d.phase === "providerCall"));
    check("[10] both were escalated under their own table",
      spyB.sent.length === 2 &&
      spyB.sent.some(([l]) => l === "RefreshEndpointResult") &&
      spyB.sent.some(([l]) => l === "ProviderCall"),
      JSON.stringify(spyB.sent));
    record(9, "tenant (fm_app) refusal",
      "NON-FATAL AND LOUD. fm_app holds no grant on any of the six tables, so its refusal RAISES (a grant refusal is never the silent zero). A refused start is a TOTAL BLACKOUT — one degradation, every later write suppressed, the refresh runs UNATTRIBUTED and still returns its own result.");
    record(10, "system (fm_system) refusal",
      "NON-FATAL AND LOUD, per table. A refused child write leaves the execution row intact, is named with the refusal's own Prisma code rather than a flattened one, and is escalated under its own table — including the void-dispatched ProviderCall, whose failure used to reach nothing at all.");
  }

  // ══ 11. ZERO-ROW CONDITIONAL WRITE ═══════════════════════════════════════
  console.log("11. there is no count for a refusal to hide in");
  {
    const s = scanNoConditionalWrite(doorSrc);
    check(`the door issues NO updateMany/deleteMany (${s.examined} write statement(s) examined)`,
      s.bad.length === 0 && s.examined >= 6, s.bad.join(", ") || `only ${s.examined} examined`);

    // The ONE conditional write the family does have lives in the incident
    // authority, and until this slice its count was read as a business answer.
    const resolved: string[] = [];
    const rows = [
      { id: "i1", kind: "UPSERT_ERROR", provider: "PLAID", plaidTransactionId: "t1",
        detail: { stage: "transaction-persist", cursorBlocking: true }, resolved: false },
      { id: "i2", kind: "UPSERT_ERROR", provider: "PLAID", plaidTransactionId: "t2",
        detail: { stage: "transaction-persist", cursorBlocking: true }, resolved: false },
    ];
    const refusing = {
      syncIssue: {
        findMany: async () => rows,
        // THE DEFECT, REPRODUCED: the policy hid one of the two rows, so the
        // statement matched one. No error. A plausible number.
        updateMany: async () => { resolved.push("partial"); return { count: 1 }; },
        findFirst: async () => null,
        create: async () => ({ id: "x" }),
        update: async () => ({ id: "x" }),
      },
      syncIssueOccurrence: { create: async () => ({ id: "o1" }) },
      $transaction: async () => { throw new Error("never"); },
    } as unknown as IncidentClient;

    const seen: Array<[string, string]> = [];
    const out = await resolveByAutomaticRecovery(
      { plaidItemId: "item-1", domain: "transactions", runId: null },
      refusing,
      async () => null,
      { onWriteFailure: (l, p) => { seen.push([l, p]); } },
    );
    check("the partial update was attempted (the fixture is not vacuous)", resolved.length === 1);
    check("a 1-of-2 resolution reports ZERO resolved, never a plausible partial",
      out.resolved === 0, String(out.resolved));
    check("and it is ANNOUNCED as a SyncIssue/resolution failure, not as 'nothing matched'",
      seen.length === 1 && seen[0][0] === "SyncIssue" && seen[0][1] === "resolution",
      JSON.stringify(seen));

    // THE DENOMINATOR, and the half that makes the case above mean anything: a
    // COMPLETE resolution over the SAME fixture must stay silent.
    const seenOk: Array<[string, string]> = [];
    const complete = {
      ...(refusing as unknown as Record<string, unknown>),
      syncIssue: {
        ...((refusing as unknown as { syncIssue: Record<string, unknown> }).syncIssue),
        updateMany: async () => ({ count: 2 }),
      },
    } as unknown as IncidentClient;
    const okOut = await resolveByAutomaticRecovery(
      { plaidItemId: "item-1", domain: "transactions", runId: null },
      complete,
      async () => null,
      { onWriteFailure: (l, p) => { seenOk.push([l, p]); } },
    );
    check("a COMPLETE resolution reports 2 and announces nothing",
      okOut.resolved === 2 && seenOk.length === 0, `${okOut.resolved} / ${JSON.stringify(seenOk)}`);

    // And "nothing matched" must stay the calm, silent, common answer.
    const seenNone: Array<[string, string]> = [];
    const empty = {
      ...(refusing as unknown as Record<string, unknown>),
      syncIssue: {
        ...((refusing as unknown as { syncIssue: Record<string, unknown> }).syncIssue),
        findMany: async () => [],
      },
    } as unknown as IncidentClient;
    const noneOut = await resolveByAutomaticRecovery(
      { plaidItemId: "item-1", domain: "transactions", runId: null },
      empty,
      async () => null,
      { onWriteFailure: (l, p) => { seenNone.push([l, p]); } },
    );
    check("an item with NO open episode reports 0 and announces nothing — the three states are distinct",
      noneOut.resolved === 0 && seenNone.length === 0, JSON.stringify(seenNone));
    record(11, "zero-row conditional write",
      "IMMUNE BY CONSTRUCTION in the four refresh tables — the door issues no updateMany/deleteMany, and its one update is keyed by primary key so a miss RAISES P2025 rather than returning 0. The family's ONE conditional write (the incident resolution) now compares the count against the rows it observed in the same phase and announces a shortfall as a FAILURE; 'nothing matched' stays silent and the three states are finally distinct.");
  }

  // ══ 12. BATCH / PARTIAL-WRITE ACCOUNTING ═════════════════════════════════
  console.log("12. a failed batch is all-or-nothing, and the row that survives it says so");
  {
    const f = fakeLedger({ fail: { stages: REFUSED_BY_GRANT } });
    const recorder = ledgerRecorderFor(f.client);
    const out = await runFullRefresh<"ran">(
      { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      {
        client: recorder,
        refresh: async ({ recorder: r }) => {
          r.begin("BALANCES", "PROVIDER");
          r.succeed("BALANCES", { recordsChanged: 1, coveredAccountIds: ["a1"], accounts: [] });
          r.begin("TRANSACTIONS", "PROVIDER");
          r.succeed("TRANSACTIONS", { recordsChanged: 2, coveredAccountIds: ["a1"], accounts: [] });
          return "ran" as const;
        },
      },
    );
    const done = f.completions[0]?.data as { overallStatus?: string } | undefined;
    check("the refresh result is unchanged", out === "ran");
    check("ZERO stage rows landed — the batch is one statement, never half of one",
      f.stageBatches.length === 0);
    check("ONE degradation for the batch, not one per row it would have written",
      recorder.degradations.filter((d) => d.phase === "stages").length === 1,
      JSON.stringify(recorder.degradations));
    check("⚠️ the execution row still closes SUCCEEDED over NO child evidence",
      done?.overallStatus === "SUCCEEDED", String(done?.overallStatus));
    check("...and THAT overstatement is exactly what the PARTIAL verdict exists to report",
      ledgerCompleteness(recorder.degradations) === "PARTIAL");
    record(12, "batch / partial-write accounting",
      "NO PARTIAL IS POSSIBLE on the stage/coverage batches: each is a single createMany, so it writes every row or none, and a failure yields ONE degradation rather than N. The residual, reported rather than hidden: the completion row still closes SUCCEEDED over zero children, because overallStatus is derived from the stages that RAN and degrading it would FABRICATE a refresh failure. The honest signal is the PARTIAL completeness verdict beside it.");
  }

  // ══ 12b. EVERY PAIR THE DOOR PRODUCES REACHES A MONITOR ═════════════════
  console.log("12b. the real escalation function covers every pair the door can produce");
  {
    const authSrc = read(AUTHORITY);
    const e = scanEveryProducedPairIsEscalated(doorSrc, authSrc);
    check(`every produced (table, phase) has an escalation line and defaultCapture has no early return (${e.examined} pair-mentions examined)`,
      e.bad.length === 0 && e.examined >= 12, e.bad.join("; ") || `only ${e.examined} examined`);
  }

  // ══ 13. THE SCANS GO RED ON A REAL VIOLATION ═════════════════════════════
  console.log("13. mutation self-check — each source scan rejects the violation it owns");
  {
    const mutations: Array<[string, string, string, (src: string) => { examined: number; bad: string[] }]> = [
      [
        "a compare-and-swap appears in the door",
        doorSrc,
        doorSrc.replace(
          "await client.refreshExecution.update({ where: { id: executionId }, data });",
          "await client.refreshExecution.updateMany({ where: { id: executionId }, data });",
        ),
        scanNoConditionalWrite,
      ],
      [
        "the recorder goes back to module scope",
        orchSrc,
        orchSrc.replace(
          "  return ledgerRecorderFor(LEDGER_CLIENT);",
          "const ledgerRecorder = ledgerRecorderFor(LEDGER_CLIENT);\n  return ledgerRecorder;",
        ),
        scanRecorderIsPerRefresh,
      ],
      [
        "the escalation returns early for every table but one (the pre-P-2 shape)",
        doorSrc,
        doorSrc.replace(
          "function defaultCapture(ledger: LedgerTable, phase: LedgerWritePhase, error: unknown): void {\n  switch",
          'function defaultCapture(ledger: LedgerTable, phase: LedgerWritePhase, error: unknown): void {\n  if (ledger !== "RefreshExecution") return;\n  switch',
        ),
        (src: string) => scanEveryProducedPairIsEscalated(src, read(AUTHORITY)),
      ],
      [
        "one escalation case is deleted, so a produced pair reaches no monitor",
        doorSrc,
        doorSrc.replace(
          '    case "ProviderCall/providerCall":\n      captureLedgerWriteFailure("ProviderCall", "providerCall", error); return;\n',
          "",
        ),
        (src: string) => scanEveryProducedPairIsEscalated(src, read(AUTHORITY)),
      ],
      [
        "the escalation is passed variables instead of literals",
        doorSrc,
        doorSrc.replace(
          'captureLedgerWriteFailure("RefreshExecution", "start", error); return;',
          "captureLedgerWriteFailure(ledger, phase, error); return;",
        ),
        scanCaptureArgsAreLiterals,
      ],
    ];
    for (const [label, real, mutated, scan] of mutations) {
      const onReal = scan(real);
      const onMutant = scan(mutated);
      check(`mutation "${label}": the text really changed`, mutated !== real);
      check(`mutation "${label}": green on the real file (${onReal.examined} examined)`,
        onReal.bad.length === 0 && onReal.examined > 0, JSON.stringify(onReal));
      check(`mutation "${label}": RED on the mutant`, onMutant.bad.length > 0, JSON.stringify(onMutant));
    }
  }

  // ══ 14. ONE RECORDER PER REFRESH — the defect RLS-P-1 shipped ════════════
  //
  // A module-scope recorder made `degradations` process-global. Every
  // single-run test passes either way, which is exactly how it shipped, so the
  // property needs a SECOND run to be visible at all.
  console.log("14. one refresh's degradations never leak into the next");
  {
    const s = scanRecorderIsPerRefresh(orchSrc);
    check(`the orchestrator binds no recorder at module scope (${s.examined} binding(s) examined)`,
      s.bad.length === 0 && s.examined > 0, s.bad.join("; ") || "nothing examined");

    // Behavioural: a BLACKOUT, then a healthy refresh on the same client.
    let denyStart = true;
    const starts: RefreshExecutionStartData[] = [];
    let n = 0;
    const flaky: LedgerWriteClient = {
      refreshExecution: {
        async create({ data }) {
          if (denyStart) throw REFUSED_BY_GRANT();
          starts.push(data);
          return { id: `exec-${++n}` };
        },
        async update() { return {}; },
      },
      refreshEndpointResult: {
        async createMany() { return {}; },
        async create() { return {}; },
        async findFirst() { return null; },
      },
      refreshEndpointAccountCoverage: { async createMany() { return {}; } },
      providerCall: { async create() { return {}; } },
    };
    const first = ledgerRecorderFor(flaky);
    await runFullRefresh<"ran">({ itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client: first, refresh: oneGoodStage });
    denyStart = false;
    const second = ledgerRecorderFor(flaky);
    await runFullRefresh<"ran">({ itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client: second, refresh: oneGoodStage });

    check("the first refresh is a blackout (the fixture is not vacuous)",
      isTotalBlackout(first.degradations));
    check("the SECOND refresh carries no degradation at all",
      second.degradations.length === 0, JSON.stringify(second.degradations));
    check("and is NOT reported as a blackout — the bug a shared array produced",
      ledgerCompleteness(second.degradations) === "COMPLETE" && !isTotalBlackout(second.degradations));
    check("the second execution really opened (otherwise this passes for the wrong reason)",
      starts.length === 1 && starts[0].overallStatus === "RUNNING");
  }

  // ══ 15. MONITORING CANNOT BECOME THE FAILURE ═════════════════════════════
  console.log("15. a throwing escalation cannot break the thing it observes");
  {
    const f = fakeLedger({ fail: { stages: REFUSED_BY_GRANT } });
    const recorder = ledgerRecorderFor(f.client, {
      capture: () => { throw new Error("Sentry is down"); },
    });
    const out = await runFullRefresh<"ran">(
      { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client: recorder, refresh: oneGoodStage },
    );
    check("the refresh still returned its own result", out === "ran");
    check("the degradation was still recorded despite the escalation throwing",
      recorder.degradations.length === 1 && recorder.degradations[0].phase === "stages");
    check("and the completion write still happened", f.completions.length === 1);
  }

  // ══ 16. AN INCIDENT WRITE FAILURE IS FINALLY VISIBLE ═════════════════════
  //
  // The facade NEVER THROWS, so the door's try/catch around it could not fire
  // and a failed SyncIssue write was the one degradation this door structurally
  // could not report. It travels as a return value now.
  console.log("16. a failed incident write reaches the degradation list");
  {
    const f = fakeLedger();
    const spy = captureSpy();
    const recorder = ledgerRecorderFor(f.client, {
      capture: spy.capture,
      recordSyncIssue: async () => ({ ledger: "SyncIssueOccurrence", phase: "incident" }),
      resolveCursorBlockingIssues: async () => ({ resolved: 0, failedWrite: { ledger: "SyncIssue", phase: "resolution" } }),
    });
    const h = await recorder.open(startData("run-inc"));
    await h?.recordIncident({ kind: "BALANCE_TX_MISMATCH", plaidItemId: "item-1" });
    await h?.resolveIncidentsByRecovery({ plaidItemId: "item-1" });
    check("both reported failures became degradations",
      recorder.degradations.length === 2, JSON.stringify(recorder.degradations));
    check("the OCCURRENCE table is named distinctly from the episode table",
      recorder.degradations.some((d) => d.ledger === "SyncIssueOccurrence" && d.phase === "incident"));
    check("a failed RESOLUTION is its own phase, never folded into 'incident'",
      recorder.degradations.some((d) => d.ledger === "SyncIssue" && d.phase === "resolution"));
    check("no Prisma code is INVENTED for a failure classified elsewhere",
      recorder.degradations.every((d) => d.dbErrorCode === "UNKNOWN"),
      JSON.stringify(recorder.degradations.map((d) => d.dbErrorCode)));
    check("both were escalated", spy.sent.length === 2, JSON.stringify(spy.sent));

    // The silent arm: a successful incident write must add nothing.
    const g = fakeLedger();
    const quiet = ledgerRecorderFor(g.client, {
      recordSyncIssue: async () => null,
      resolveCursorBlockingIssues: async () => ({ resolved: 1, failedWrite: null }),
    });
    const hq = await quiet.open(startData("run-quiet"));
    await hq?.recordIncident({ kind: "BALANCE_TX_MISMATCH", plaidItemId: "item-1" });
    await hq?.resolveIncidentsByRecovery({ plaidItemId: "item-1" });
    check("a successful incident write adds NOTHING (the denominator)",
      quiet.degradations.length === 0, JSON.stringify(quiet.degradations));
  }

  // ── The matrix, printed whatever the outcome ──────────────────────────────
  console.log("\n════ P-2 FAILURE MATRIX ════");
  for (const row of MATRIX.sort((a, b) => a.n - b.n)) {
    console.log(`\n  ${String(row.n).padStart(2)}. ${row.scenario}\n      ${row.meaning}`);
  }
  check(`the matrix reports all twelve scenarios (${MATRIX.length})`, MATRIX.length === 12);

  console.log(failures === 0 ? "\nAll failure-semantics guards passed." : `\n${failures} guard(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
