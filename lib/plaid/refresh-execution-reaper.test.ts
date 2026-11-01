/**
 * lib/plaid/refresh-execution-reaper.test.ts
 *
 * RefreshExecution rows whose process was killed (Vercel's function time limit
 * on an inline ETH history walk, Preview 2026-10-30/31) never wrote their
 * completion and read RUNNING for ever. The reaper — the JobRun stale-run
 * finaliser's twin, run by the same dispatch wake — flips them to FAILED with
 * a reason, and touches nothing fresh or finished.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/refresh-execution-reaper.test.ts
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  reapStaleRefreshExecutions, REFRESH_EXECUTION_MAX_DURATION_MS, STALE_EXECUTION_MARGIN_MS, STALE_EXECUTION_ERROR_SUMMARY,
  type StaleExecutionReapClient,
} from "./refresh-ledger";
import { dispatchDueJobs, type JobLedgerClient } from "@/lib/jobs/dispatch";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

interface Row { id: string; overallStatus: string; startedAt: Date; completedAt: Date | null; errorSummary: string | null; failureCategory: string | null; durationMs: number | null }

/** An in-memory RefreshExecution table that applies the reaper's predicates as Postgres would. */
function table(rows: Row[], hooks: { beforeUpdate?: (id: string) => void } = {}): { client: StaleExecutionReapClient; rows: Row[] } {
  const matches = (r: Row, w: { overallStatus: string; completedAt: null }) => r.overallStatus === w.overallStatus && r.completedAt === w.completedAt;
  return {
    rows,
    client: {
      refreshExecution: {
        async findMany({ where, take }) {
          return rows.filter((r) => matches(r, where) && r.startedAt < where.startedAt.lt)
            .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()).slice(0, take).map((r) => ({ id: r.id }));
        },
        async update({ where, data }) {
          hooks.beforeUpdate?.(where.id);
          const r = rows.find((x) => x.id === where.id && matches(x, where));
          if (!r) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
          Object.assign(r, data);
          return r;
        },
      },
    },
  };
}

const NOW = new Date("2026-10-31T06:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const row = (id: string, overallStatus: string, startedAt: Date, completedAt: Date | null = null): Row =>
  ({ id, overallStatus, startedAt, completedAt, errorSummary: null, failureCategory: null, durationMs: null });

async function main() {
  console.log("1. stale RUNNING rows are failed with a reason; fresh and finished rows are untouched");
  {
    const LIMIT = REFRESH_EXECUTION_MAX_DURATION_MS + STALE_EXECUTION_MARGIN_MS;
    const t = table([
      row("eth-killed", "RUNNING", ago(19 * 3_600_000)),        // the 10-30 / 10-31 ETH executions
      row("just-past", "RUNNING", ago(LIMIT + 1)),
      row("fresh", "RUNNING", ago(2 * 60_000)),                  // a live sync, mid-run
      row("at-limit", "RUNNING", ago(LIMIT)),                     // not yet past it
      row("done", "SUCCEEDED", ago(24 * 3_600_000), ago(24 * 3_600_000 - 5_000)),
      row("failed", "FAILED", ago(24 * 3_600_000), ago(24 * 3_600_000 - 5_000)),
    ]);
    const before = JSON.stringify(t.rows.filter((r) => !["eth-killed", "just-past"].includes(r.id)));
    const n = await reapStaleRefreshExecutions(t.client, NOW);
    const by = (id: string) => t.rows.find((r) => r.id === id)!;
    check("the limit is the max function duration (300 s) plus a margin", LIMIT >= 300_000 + 60_000 && LIMIT <= 15 * 60_000, String(LIMIT));
    check("a RUNNING row past max duration + margin is marked FAILED, completed now, with the stale reason and an UNKNOWN category",
      n === 2 && ["eth-killed", "just-past"].every((id) => by(id).overallStatus === "FAILED" && by(id).completedAt?.getTime() === NOW.getTime()
        && by(id).errorSummary === STALE_EXECUTION_ERROR_SUMMARY && /^stale/.test(by(id).errorSummary ?? "") && by(id).failureCategory === "UNKNOWN"),
      JSON.stringify(t.rows));
    check("…its duration is left unknown (null), never invented", by("eth-killed").durationMs === null);
    check("a fresh RUNNING row, one exactly at the limit, and finished rows are untouched",
      JSON.stringify(t.rows.filter((r) => !["eth-killed", "just-past"].includes(r.id))) === before);
    check("idempotent: a second sweep changes nothing", (await reapStaleRefreshExecutions(t.client, NOW)) === 0);
  }

  console.log("1b. a row that completes between the scan and the write keeps its own completion");
  {
    const t = table([row("racing", "RUNNING", ago(3_600_000))], { beforeUpdate: (id) => {
      const r = t.rows.find((x) => x.id === id)!; r.overallStatus = "SUCCEEDED"; r.completedAt = ago(1); } });
    const n = await reapStaleRefreshExecutions(t.client, NOW);
    check("…it is skipped (guarded update by primary key), not overwritten", n === 0 && t.rows[0].overallStatus === "SUCCEEDED" && t.rows[0].errorSummary === null);
  }

  console.log("2. never throws (telemetry never breaks the wake)");
  {
    const broken: StaleExecutionReapClient = { refreshExecution: { findMany: async () => { throw new Error("db down"); }, update: async () => { throw new Error("db down"); } } };
    const orig = console.error; console.error = () => {};
    let n = -1;
    try { n = await reapStaleRefreshExecutions(broken, NOW); } finally { console.error = orig; }
    check("a failing write returns 0", n === 0);
  }

  console.log("3. the dispatch wake runs it, beside the JobRun stale sweep");
  {
    const calls: Date[] = [];
    const client: JobLedgerClient = { jobRun: { findMany: async () => [], updateMany: async () => ({ count: 0 }) } } as unknown as JobLedgerClient;
    const log = console.log; console.log = () => {};
    try {
      await dispatchDueJobs(NOW, { jobs: [], client, policies: new Map() as never, reapStaleExecutions: async (at) => { calls.push(at); return 0; } });
      await dispatchDueJobs(NOW, { jobs: [], client, policies: new Map() as never, reapStaleExecutions: async () => { throw new Error("boom"); } });
    } finally { console.log = log; }
    check("every wake calls the reaper with the wake instant (a throwing one cannot fail the wake)", calls.length === 1 && calls[0] === NOW);
    const src = readFileSync(join(process.cwd(), "lib", "jobs", "dispatch.ts"), "utf8");
    check("production binds it to the system principal (the operational ledger's authority) when nothing is injected",
      /reapStaleRefreshExecutions\(systemDb as unknown as StaleExecutionReapClient, at\)/.test(src));
  }

  console.log("4. census: the reaper's threshold stays above every caller's maxDuration");
  {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name === "route.ts" ? [join(dir, e.name)] : []);
    const routes = walk(join(process.cwd(), "app"));
    const rel = (f: string) => f.slice(process.cwd().length + 1);
    // Routes that open RefreshExecutions: wallet syncs, Plaid refreshes, job / operator runs.
    const RUNS = /syncWalletByChain|runFullRefresh|refreshScheduledWallets|runJob\(|dispatchDueJobs|resyncConnection|refreshAll|exchangePublicToken|handlePlaidWebhook|resumeSync/;
    const durations = routes.map((f) => {
      const src = readFileSync(f, "utf8");
      const m = /export const maxDuration\s*=\s*(\d+)/.exec(src);
      return { f: rel(f), runs: RUNS.test(src), seconds: m ? Number(m[1]) : null };
    });
    const runners = durations.filter((d) => d.runs);
    const missing = runners.filter((d) => d.seconds === null).map((d) => d.f);
    check(`every route that runs a refresh pins maxDuration explicitly (${runners.length} route(s))`, missing.length === 0 && runners.length >= 10, missing.join(", "));
    check("…including the wallet sync, the wallet add and the operator Run Now routes (the census is not vacuous)",
      ["app/api/accounts/[id]/sync/route.ts", "app/api/accounts/wallet/route.ts", "app/api/platform/platform-ops/operations/route.ts"]
        .every((f) => runners.some((d) => d.f === f && d.seconds === 300)));
    const longest = Math.max(...durations.map((d) => d.seconds ?? 0));
    check(`no route may outlive the reaper's notion of a function (longest ${longest} s ≤ ${REFRESH_EXECUTION_MAX_DURATION_MS / 1000} s)`,
      longest * 1000 <= REFRESH_EXECUTION_MAX_DURATION_MS, durations.filter((d) => (d.seconds ?? 0) * 1000 > REFRESH_EXECUTION_MAX_DURATION_MS).map((d) => d.f).join(", "));
    check("…and the reap threshold sits strictly above it, with margin", REFRESH_EXECUTION_MAX_DURATION_MS + STALE_EXECUTION_MARGIN_MS > longest * 1000 + 60_000);
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { functions?: Record<string, { maxDuration?: number }> };
    const overrides = Object.values(vercel.functions ?? {}).map((v) => v.maxDuration ?? 0);
    check("vercel.json raises no function past it either", overrides.every((s) => s * 1000 <= REFRESH_EXECUTION_MAX_DURATION_MS));
  }

  console.log(failures ? `\nrefresh-execution-reaper: ${failures} FAILED` : "\nrefresh-execution-reaper: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
