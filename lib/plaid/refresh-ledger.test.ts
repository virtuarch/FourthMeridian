/**
 * lib/plaid/refresh-ledger.test.ts  (RLS-P-1)
 *
 * THE DOOR'S GUARDS. Standalone tsx script (house pattern): npx tsx <this> —
 * exits 0/1. NO live database and NO Plaid: the real `ledgerRecorderFor` is
 * driven over an in-memory client, so every behavioural claim below is about the
 * production code path.
 *
 * Three of these are the LOAD-BEARING PROPERTIES the slice exists to establish,
 * and each is asserted twice where that is possible — once mechanically over the
 * source, once behaviourally over the real door:
 *
 *   1. the execution id is MINTED, never accepted
 *   2. no row crosses the boundary
 *   3. no credential may pass through it
 *
 * plus: exactly ONE product-tree file writes the four refresh-ledger tables, a
 * ledger failure never changes the caller's outcome, and a start failure is a
 * TOTAL BLACKOUT rather than a quiet partial one.
 *
 * ⚠️ EVERY ABSENCE CLAIM BELOW CARRIES ITS DENOMINATOR. A scan that matched
 * nothing passes for the wrong reason, and this programme has shipped exactly
 * that bug (an unescaped `$` in `\b${name}\s*\(` made a `$transaction` scan
 * report clean over zero call sites). So each source scan asserts the count of
 * things it examined, and the self-check at the bottom re-runs the scans against
 * DELIBERATELY VIOLATING text to prove each one goes red.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  isTotalBlackout,
  ledgerRecorderFor,
  type LedgerDegradation,
  type LedgerWriteClient,
} from "@/lib/plaid/refresh-ledger";
import { runFullRefresh, type RefreshExecutionStartData } from "@/lib/plaid/refresh-execution";
import type { SyncIssueInput } from "@/lib/plaid/syncIssues";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const ROOT = process.cwd();
const DOOR = "lib/plaid/refresh-ledger.ts";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Comments quote these names constantly; only real code counts. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── The scans, as reusable pure functions so they can be mutation-tested ─────

/**
 * PROPERTY 1 (mechanical, part A) — inside the door's two public interfaces,
 * `refreshExecutionId` may appear ONLY inside an `Omit<…>`, i.e. only as a key
 * being REMOVED from a caller-supplied shape.
 *
 * Returns the occurrences examined and the ones that violate, so the caller can
 * assert a non-zero denominator.
 */
function scanNoExecutionIdParameter(src: string): { examined: number; bad: string[] } {
  const code = stripComments(src);
  const bad: string[] = [];
  let examined = 0;
  for (const block of ["LedgerRecorder", "LedgerHandle"]) {
    const at = code.indexOf(`interface ${block} {`);
    if (at < 0) { bad.push(`interface ${block} not found`); continue; }
    // Interface bodies here contain no nested braces beyond generics, so the
    // first `\n}` closes the block.
    const body = code.slice(at, code.indexOf("\n}", at));
    for (const m of body.matchAll(/refreshExecutionId/g)) {
      examined++;
      const before = body.slice(Math.max(0, m.index - 60), m.index);
      if (!before.includes("Omit<")) bad.push(`${block}: bare refreshExecutionId at offset ${m.index}`);
    }
  }
  return { examined, bad };
}

/**
 * PROPERTY 1 (mechanical, part B) — every row the door writes sets
 * `refreshExecutionId` to the id it minted, and to nothing else.
 *
 * Scoped to the IMPLEMENTATION (everything from `ledgerRecorderFor` onwards), so
 * the row-shape declarations above it — which legitimately spell
 * `refreshExecutionId: string` — are not mistaken for assignments. The marker's
 * presence is asserted, so a rename cannot turn this into a scan over nothing.
 */
const IMPL_MARKER = "export function ledgerRecorderFor";
function scanEveryRowUsesTheMintedId(src: string): { examined: number; bad: string[] } {
  const code = stripComments(src);
  const at = code.indexOf(IMPL_MARKER);
  if (at < 0) return { examined: 0, bad: [`${IMPL_MARKER} not found — the scan has no region`] };
  const impl = code.slice(at);
  const bad: string[] = [];
  let examined = 0;
  for (const m of impl.matchAll(/refreshExecutionId:\s*([A-Za-z0-9_.]+)/g)) {
    examined++;
    if (m[1] !== "executionId") bad.push(`refreshExecutionId: ${m[1]}`);
  }
  return { examined, bad };
}

/**
 * PROPERTY 2 (mechanical) — every method of `LedgerHandle` returns `void` or
 * `Promise<void>`. Nothing a caller can read a row out of.
 */
function scanHandleReturnsNoRows(src: string): { examined: number; bad: string[] } {
  const code = stripComments(src);
  const at = code.indexOf("interface LedgerHandle {");
  if (at < 0) return { examined: 0, bad: ["interface LedgerHandle not found"] };
  const body = code.slice(at, code.indexOf("\n}", at));
  const bad: string[] = [];
  let examined = 0;
  for (const m of body.matchAll(/^\s{2}(\w+)\([^)]*\):\s*([^;]+);/gm)) {
    examined++;
    const ret = m[2].trim();
    if (ret !== "void" && ret !== "Promise<void>") bad.push(`${m[1]}(): ${ret}`);
  }
  return { examined, bad };
}

/** PROPERTY 3 (mechanical) — no credential vocabulary anywhere in the door. */
const CREDENTIAL_NEEDLES = ["decryptWithPurpose", "accessToken", "encryptedToken"] as const;
function scanNoCredentials(src: string): { examined: number; bad: string[] } {
  const bad: string[] = [];
  for (const needle of CREDENTIAL_NEEDLES) {
    if (src.includes(needle)) bad.push(needle);
  }
  return { examined: CREDENTIAL_NEEDLES.length, bad };
}

// ── The in-memory ledger client ──────────────────────────────────────────────

interface FailAt {
  create?: boolean;
  createMany?: boolean;
  coverage?: boolean;
  providerCall?: boolean;
  update?: boolean;
}

function fakeLedger(fail: FailAt = {}) {
  const starts: RefreshExecutionStartData[] = [];
  const completions: Array<{ id: string; data: unknown }> = [];
  const stageBatches: Array<Record<string, unknown>> = [];
  const stageRows: Array<Record<string, unknown>> = [];
  const coverage: Array<Record<string, unknown>> = [];
  const providerCalls: Array<Record<string, unknown>> = [];
  let seq = 0;
  const err = (code: string) => Object.assign(new Error("denied"), { code });
  const client: LedgerWriteClient = {
    refreshExecution: {
      async create({ data }) {
        if (fail.create) throw err("P2010"); // what a `permission denied` surfaces as
        starts.push(data);
        return { id: `exec-${++seq}` };
      },
      async update({ where, data }) {
        if (fail.update) throw err("P2025");
        completions.push({ id: where.id, data });
        return {};
      },
    },
    refreshEndpointResult: {
      async createMany({ data }) {
        if (fail.createMany) throw err("P2010");
        stageBatches.push(...(data as unknown as Record<string, unknown>[]));
        return {};
      },
      async create({ data }) {
        if (fail.createMany) throw err("P2010");
        stageRows.push(data as unknown as Record<string, unknown>);
        return {};
      },
      // RLS-P-2 — the attempt-numbering probe shares the WRITE client now, so
      // the fake must answer it (and from the rows the inserts land in, never
      // from somewhere else: a probe on a different authority is the defect).
      async findFirst({ where }) {
        const prior = stageRows.filter(
          (r) => r.refreshExecutionId === where.refreshExecutionId && r.endpoint === where.endpoint,
        );
        return prior.length === 0 ? null : { attempt: Math.max(...prior.map((r) => Number(r.attempt ?? 0))) };
      },
    },
    refreshEndpointAccountCoverage: {
      async createMany({ data }) {
        if (fail.coverage) throw err("P2010");
        coverage.push(...(data as unknown as Record<string, unknown>[]));
        return {};
      },
    },
    providerCall: {
      async create({ data }) {
        if (fail.providerCall) throw err("P2010");
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

/** Walk the product tree. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "prototype") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(path.relative(ROOT, full));
  }
  return found;
}

async function main() {
  const doorSrc = read(DOOR);

  // ══ 1. THE EXECUTION ID IS MINTED, NEVER ACCEPTED ════════════════════════
  console.log("1. the execution id is minted, never accepted (mechanical + behavioural)");
  {
    const a = scanNoExecutionIdParameter(doorSrc);
    check(`no entry point takes a refreshExecutionId (${a.examined} mention(s) examined, all inside Omit<>)`,
      a.bad.length === 0 && a.examined > 0, a.bad.join("; ") || "nothing examined");

    const b = scanEveryRowUsesTheMintedId(doorSrc);
    check(`every written row uses the minted id (${b.examined} assignment(s) examined)`,
      b.bad.length === 0 && b.examined > 0, b.bad.join("; ") || "nothing examined");

    // Behavioural: a caller that SPOOFS the id in every row it hands over gets
    // the minted one written anyway. This is the property the type system cannot
    // carry across an `as` cast, a JS caller, or an `any`.
    const f = fakeLedger();
    const recorder = ledgerRecorderFor(f.client);
    const handle = await recorder.open(startData());
    check("open() returns a handle carrying the minted id", handle?.executionId === "exec-1");
    if (!handle) { check("handle present", false); return finish(); }

    await handle.recordStages([{
      endpoint: "BALANCES", stageKind: "PROVIDER", status: "SUCCEEDED",
      startedAt: new Date(0), completedAt: new Date(0), durationMs: 0,
      coveredAccountIds: ["a1"],
      // The spoof: a caller reaching past the Omit<> with a cast.
      refreshExecutionId: "exec-SOMEONE-ELSE",
    } as never]);
    await handle.recordCoverage([{
      endpoint: "BALANCES", financialAccountId: "a1", status: "COVERED", freshnessAdvanced: true,
      refreshExecutionId: "exec-SOMEONE-ELSE",
    } as never]);
    handle.recordProviderCall({
      provider: "PLAID", operation: "accountsGet", status: "SUCCEEDED", attempt: 1,
      startedAt: new Date(0), completedAt: new Date(0), durationMs: 0,
      refreshExecutionId: "exec-SOMEONE-ELSE",
    } as never);
    await new Promise((r) => setImmediate(r)); // the provider-call emit is void-dispatched

    const written = [...f.stageBatches, ...f.coverage, ...f.providerCalls];
    check(`a spoofed id is overwritten on every path (${written.length} row(s) written)`,
      written.length === 3 && written.every((r) => r.refreshExecutionId === "exec-1"),
      JSON.stringify(written.map((r) => r.refreshExecutionId)));
  }

  // ══ 2. NO ROW CROSSES THE BOUNDARY ═══════════════════════════════════════
  console.log("2. no row crosses the boundary");
  {
    const s = scanHandleReturnsNoRows(doorSrc);
    check(`every LedgerHandle method returns void (${s.examined} method(s) examined)`,
      s.bad.length === 0 && s.examined >= 7, s.bad.join("; ") || `only ${s.examined} examined`);

    // The honest rule is not "no reads": the incident lifecycle reads SyncIssue to
    // converge, and the stage writer reads its own prior attempts to number the
    // next one. What must hold is that no read's ROWS come back out — which is
    // exactly what "every method returns void" states, so the two halves agree.
    const f = fakeLedger();
    const handle = await ledgerRecorderFor(f.client).open(startData());
    const returns = handle
      ? [
          await handle.recordStages([]),
          await handle.recordCoverage([]),
          handle.recordProviderCall({
            provider: "PLAID", operation: "x", status: "SUCCEEDED", attempt: 1,
            startedAt: new Date(0), completedAt: new Date(0), durationMs: 0,
          }),
          await handle.close({ completedAt: new Date(0), durationMs: 0, overallStatus: "SUCCEEDED" }),
        ]
      : [];
    check(`every method actually resolved to undefined (${returns.length} call(s))`,
      returns.length === 4 && returns.every((v) => v === undefined));
  }

  // ══ 3. NO CREDENTIAL MAY PASS THROUGH IT ═════════════════════════════════
  console.log("3. no credential may pass through it");
  {
    const s = scanNoCredentials(doorSrc);
    check(`the door names no credential vocabulary (${s.examined} needle(s) checked)`,
      s.bad.length === 0, s.bad.join(", "));
    // And it reaches no database of its own: the authority arrives as an argument.
    check("the door imports no database client (@/lib/db)",
      !/from\s+["']@\/lib\/db["']/.test(doorSrc) && !/import\(\s*["']@\/lib\/db["']\s*\)/.test(doorSrc));
  }

  // ══ 4. ONE DOOR — the whole point of the slice ════════════════════════════
  console.log("4. exactly one product-tree file writes the four refresh-ledger tables");
  {
    const WRITE =
      /\.(refreshExecution|refreshEndpointResult|refreshEndpointAccountCoverage|providerCall)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
    const files = ["lib", "app", "components", "jobs"]
      .flatMap((r) => walk(path.join(ROOT, r)))
      .filter((f) => !/\.test\.tsx?$/.test(f));
    const writers = files.filter((f) => WRITE.test(stripComments(read(f))));
    check(`one writer over ${files.length} scanned product file(s)`,
      writers.length === 1 && writers[0] === DOOR, writers.join(", "));
    // The denominator for the regex itself: it must match the door.
    check("the write regex matches the door (the scan is not vacuous)", WRITE.test(stripComments(doorSrc)));
  }

  // ══ 5. A LEDGER FAILURE NEVER CHANGES THE CALLER'S OUTCOME ═══════════════
  console.log("5. a ledger failure never changes the caller's outcome");
  {
    const sentinel = { ok: true, marker: Symbol("runner result") };
    const f = fakeLedger({ createMany: true, coverage: true, update: true });
    const recorder = ledgerRecorderFor(f.client);
    const result = await runFullRefresh<typeof sentinel>(
      { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      {
        client: recorder,
        refresh: async ({ recorder: rec }) => {
          rec.begin("BALANCES", "PROVIDER");
          rec.succeed("BALANCES", {
            recordsChanged: 1, coveredAccountIds: ["a1"],
            accounts: [{ financialAccountId: "a1", status: "COVERED", freshnessAdvanced: true }],
          });
          return sentinel;
        },
      },
    );
    check("the runner's result comes back by identity, unchanged", result === sentinel);
    const d = recorder.degradations;
    check(`every failed write surfaced a degradation (${d.length} recorded)`, d.length === 3);
    check("degradations name the table, the phase and a Prisma code",
      d.every((x: LedgerDegradation) => typeof x.ledger === "string" && typeof x.phase === "string" && /^P\d{4}$/.test(x.dbErrorCode)),
      JSON.stringify(d));
    check("a degradation carries NO message and NO row",
      !JSON.stringify(d).includes("denied") && !JSON.stringify(d).includes("a1"));
    check("stages, coverage and completion are each named",
      new Set(d.map((x) => x.phase)).size === 3 &&
      d.some((x) => x.phase === "stages") && d.some((x) => x.phase === "coverage") && d.some((x) => x.phase === "completion"));
    check("a non-start failure is NOT a blackout", isTotalBlackout(d) === false);

    // The thrown case: the ORIGINAL error object, by identity, with ledger
    // writes failing underneath it. reportItemRefreshFailure classifies by
    // identity, so a wrapped error would silently reclassify every failure.
    const boom = new Error("provider down");
    const g = fakeLedger({ createMany: true, update: true });
    let rethrew: unknown;
    try {
      await runFullRefresh<never>(
        { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
        { client: ledgerRecorderFor(g.client), refresh: async () => { throw boom; } },
      );
    } catch (e) { rethrew = e; }
    check("the original error is rethrown by identity even when the ledger failed", rethrew === boom);
  }

  // ══ 6. A START FAILURE IS A TOTAL BLACKOUT ═══════════════════════════════
  console.log("6. a start failure is a total blackout, named as one");
  {
    const f = fakeLedger({ create: true });
    const recorder = ledgerRecorderFor(f.client);
    const handle = await recorder.open(startData("run-blackout"));
    check("open() returns null when the start write fails", handle === null);
    check(`degradations describe the blackout (${recorder.degradations.length} recorded)`,
      recorder.degradations.length === 1 &&
      recorder.degradations[0].ledger === "RefreshExecution" &&
      recorder.degradations[0].phase === "start" &&
      recorder.degradations[0].dbErrorCode === "P2010");
    check("isTotalBlackout() says so", isTotalBlackout(recorder.degradations) === true);

    // ESCALATED, not merely logged. A write-dead ledger that only reaches
    // console.error is what let the DF-2 ledger stay dead from 2026-07-24 while
    // every dashboard read green.
    const escalations: Array<[string, string]> = [];
    const h = fakeLedger({ create: true, update: true });
    const esc = ledgerRecorderFor(h.client, { capture: (l, p) => { escalations.push([l, p]); } });
    await esc.open(startData("run-escalate"));
    check(`the start failure is escalated, not only logged (${escalations.length} escalation(s))`,
      escalations.length === 1 && escalations[0][0] === "RefreshExecution" && escalations[0][1] === "start",
      JSON.stringify(escalations));

    // The DENOMINATOR for "nothing else was written": run a refresh whose runner
    // records stages, coverage AND a provider call, and count zero of each.
    const g = fakeLedger({ create: true });
    const rec2 = ledgerRecorderFor(g.client);
    const out = await runFullRefresh<string>(
      { itemId: "item-1", trigger: "MANUAL", profile: "FULL_REFRESH" },
      {
        client: rec2,
        refresh: async ({ recorder: r }) => {
          r.begin("BALANCES", "PROVIDER");
          r.succeed("BALANCES", {
            recordsChanged: 1, coveredAccountIds: ["a1"],
            accounts: [{ financialAccountId: "a1", status: "COVERED", freshnessAdvanced: true }],
          });
          check("no ledger door exists for the historical layer either", r.ledger === undefined);
          return "ran";
        },
      },
    );
    await new Promise((res) => setImmediate(res));
    check("the refresh still ran and returned its own result", out === "ran");
    check("blackout: zero executions, zero stages, zero coverage, zero provider calls, zero completions",
      g.starts.length === 0 && g.stageBatches.length === 0 && g.stageRows.length === 0 &&
      g.coverage.length === 0 && g.providerCalls.length === 0 && g.completions.length === 0,
      `starts=${g.starts.length} stages=${g.stageBatches.length} cov=${g.coverage.length} pc=${g.providerCalls.length} done=${g.completions.length}`);
    check("the blackout is a SINGLE degradation, not one per suppressed write",
      rec2.degradations.length === 1 && isTotalBlackout(rec2.degradations));
  }

  // ══ 7. THE INCIDENT CORRELATOR IS OVERWRITTEN, NOT MERGED ════════════════
  console.log("7. an incident recorded through the door cannot name another run");
  {
    const f = fakeLedger();
    const forwarded: SyncIssueInput[] = [];
    const resolved: Array<{ plaidItemId: string; runId: string }> = [];
    const recorder = ledgerRecorderFor(f.client, {
      // RLS-P-2 — both deps now REPORT whether they wrote. `null` / `failedWrite:
      // null` is the "it landed" answer; the failure arm is exercised in
      // refresh-ledger-failure-matrix.test.ts.
      recordSyncIssue: async (input) => { forwarded.push(input); return null; },
      resolveCursorBlockingIssues: async (plaidItemId, runId) => {
        resolved.push({ plaidItemId, runId });
        return { resolved: 0, failedWrite: null };
      },
    });
    const handle = await recorder.open(startData("run-REAL"));
    await handle?.recordIncident({
      kind: "BALANCE_TX_MISMATCH",
      plaidItemId: "item-1",
      // The spoof again: a caller naming somebody else's run in the detail blob,
      // which is where the correlator has always travelled.
      detail: { runId: "run-SOMEONE-ELSE", basis: "posted" },
    });
    await handle?.resolveIncidentsByRecovery({ plaidItemId: "item-1" });
    check(`one observation forwarded to the facade (${forwarded.length})`, forwarded.length === 1);
    check("detail.runId is REPLACED with this execution's correlator",
      (forwarded[0]?.detail as Record<string, unknown> | undefined)?.runId === "run-REAL");
    check("the rest of the detail survives",
      (forwarded[0]?.detail as Record<string, unknown> | undefined)?.basis === "posted");
    check("the resolution carries this execution's correlator, not a parameter",
      resolved.length === 1 && resolved[0].runId === "run-REAL" && resolved[0].plaidItemId === "item-1");
    // The door forwards to the FACADE, never to the lifecycle authority: two
    // entry points into detection is what let btc-sync stop converging, and
    // incident-boundary.test.ts pins the facade as the only caller.
    check("the door reaches detection through the facade only",
      /@\/lib\/plaid\/syncIssues/.test(doorSrc) &&
      !/recordIncidentObservation\(/.test(stripComments(doorSrc)) &&
      !/resolveByAutomaticRecovery\(/.test(stripComments(doorSrc)));
  }

  // ══ 8. THE SCANS ABOVE GO RED WHEN THE PROPERTY IS VIOLATED ══════════════
  //
  // A source scan that cannot fail is decoration. Each mutation below is the
  // smallest edit that breaks exactly one property; the scan that owns it must
  // reject the mutated text AND still accept the real file.
  console.log("8. mutation self-check — each scan goes red on a real violation");
  {
    const mutations: Array<[string, string, (src: string) => { examined: number; bad: string[] }]> = [
      [
        "a handle method accepting an execution id",
        doorSrc.replace(
          "  recordStages(rows: readonly Omit<RefreshEndpointResultData, \"refreshExecutionId\">[]): Promise<void>;",
          "  recordStages(refreshExecutionId: string, rows: readonly RefreshEndpointResultData[]): Promise<void>;",
        ),
        scanNoExecutionIdParameter,
      ],
      [
        "a row written under a parameter instead of the minted id",
        doorSrc.replace("refreshExecutionId: executionId }", "refreshExecutionId: args.someId }"),
        scanEveryRowUsesTheMintedId,
      ],
      [
        "the implementation marker renamed out from under the scan",
        doorSrc.replace(IMPL_MARKER, "export function bindLedgerRecorder"),
        scanEveryRowUsesTheMintedId,
      ],
      [
        "a handle method returning a row",
        doorSrc.replace("  close(data: RefreshExecutionCompletionData): Promise<void>;",
                        "  close(data: RefreshExecutionCompletionData): Promise<RefreshExecutionStartData>;"),
        scanHandleReturnsNoRows,
      ],
      [
        "a credential reaching the door",
        doorSrc.replace("export function isTotalBlackout", "export const accessToken = 1;\nexport function isTotalBlackout"),
        scanNoCredentials,
      ],
    ];
    for (const [label, mutated, scan] of mutations) {
      const onReal = scan(doorSrc);
      const onMutant = scan(mutated);
      check(`mutation "${label}": the text really changed`, mutated !== doorSrc);
      check(`mutation "${label}": green on the real file`, onReal.bad.length === 0);
      check(`mutation "${label}": RED on the mutant`, onMutant.bad.length > 0, JSON.stringify(onMutant));
    }
  }

  finish();
}

function finish(): void {
  console.log(failures === 0 ? "\nAll refresh-ledger guards passed." : `\n${failures} guard(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
