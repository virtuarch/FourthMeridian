/**
 * app/api/health/route.test.ts  (OPS-1 S6 · OBS-001 / OPS-002 / OPS-014)
 *
 * Standalone tsx script (house pattern). Exercises the health route handler
 * directly — no server, no live database. DATABASE_URL points at a port
 * nothing listens on, so the DB ping fails fast and deterministically:
 * the route must degrade to a bare 503 without leaking connection details.
 * Also proves the per-IP rate limit wraps the endpoint (in-memory backend —
 * NODE_ENV is "test"), that the OK path carries the non-sensitive `scheduler`
 * block (through the handler's injection seam), that the commit sha is gone,
 * and that the pure signals derivation reads overdue exactly as job health does.
 */

// Set BEFORE import: unreachable-but-valid URL → fast ECONNREFUSED on query.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://health:health@127.0.0.1:9/health";
delete process.env.RATE_LIMIT_ENABLED;
delete process.env.RATE_LIMIT_SHADOW;

import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { GET, handleHealth } from "./route";
import { OVERDUE_GRACE_HOURS, buildSchedulerSignals, type SchedulerSignals } from "@/lib/jobs/scheduler-signals-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function req(ip: string): NextRequest {
  return new Request("http://localhost/api/health", {
    headers: { "x-forwarded-for": ip },
  }) as unknown as NextRequest;
}

const H = 3_600_000;

async function main(): Promise<void> {
  console.log("1. DB unreachable → bare 503 degraded, no secrets, scheduler null");
  const res = await GET(req("10.0.0.1"));
  check("status 503", res.status === 503, `got ${res.status}`);
  const body = await res.text();
  const json = JSON.parse(body) as Record<string, unknown>;
  check('body.status === "degraded"', json.status === "degraded");
  check('body.db === "error"', json.db === "error");
  check(
    "body keys limited to db/scheduler/status/time (no commit — OPS-014)",
    Object.keys(json).sort().join(",") === "db,scheduler,status,time",
    Object.keys(json).join(","),
  );
  check("scheduler is null on a 503, never fabricated", json.scheduler === null);
  check("no connection string in body", !body.includes("postgresql://") && !body.includes("127.0.0.1"));
  check("no env var names in body", !/DATABASE_URL|NEXTAUTH|ENCRYPTION|RESEND|CRON_SECRET/.test(body));
  check("no-store", res.headers.get("cache-control") === "no-store");

  console.log("2. Per-IP rate limit wraps the endpoint");
  (process.env as Record<string, string | undefined>).RATE_LIMIT_ENABLED = "true";
  // The limiter buckets by fixed calendar-minute windows (floor(now / 60s)).
  // On the wall clock the 31 calls could straddle a minute boundary, reset the
  // bucket, and turn call 31 into a 503 (CI 38636373842 attempt 1). Hold the
  // clock mid-window so "within a minute" is true by construction.
  const realNow = Date.now;
  const frozen = Math.floor(realNow() / 60_000) * 60_000 + 30_000;
  Date.now = () => frozen;
  try {
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) {
      last = await GET(req("10.0.0.2"));
    }
    check("call 31 within a minute is 429", last?.status === 429, `got ${last?.status}`);
    const other = await GET(req("10.0.0.3"));
    check("different IP unaffected (503, not 429)", other.status === 503, `got ${other.status}`);
  } finally {
    Date.now = realNow;
  }
  delete process.env.RATE_LIMIT_ENABLED;

  console.log("3. OK path carries the non-sensitive scheduler block (OBS-001 / OPS-002)");
  const now = new Date("2026-10-21T12:00:00.000Z");
  const signals: SchedulerSignals = {
    lastDispatchAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    lastAlertEvaluationAt: new Date(now.getTime() - 2 * H).toISOString(),
    lastBackstopCronAt: new Date(now.getTime() - 4 * 60_000).toISOString(),
    overdueJobs: 0,
    alertEvaluatorOverdue: false,
  };
  const ok = await handleHealth(req("10.0.0.4"), { ping: async () => 1, scheduler: async () => signals, now: () => now });
  const okJson = JSON.parse(await ok.text()) as Record<string, unknown>;
  check("200 ok / db ok", ok.status === 200 && okJson.status === "ok" && okJson.db === "ok");
  check("keys db/scheduler/status/time", Object.keys(okJson).sort().join(",") === "db,scheduler,status,time");
  const s = okJson.scheduler as SchedulerSignals;
  check("scheduler block has exactly the five fields", Object.keys(s).sort().join(",") === "alertEvaluatorOverdue,lastAlertEvaluationAt,lastBackstopCronAt,lastDispatchAt,overdueJobs");
  check("no job name, no email, no commit in the OK body", !/evaluate-alerts|sync-banks|@|commit/.test(JSON.stringify(okJson)));
  const ledgerDown = await handleHealth(req("10.0.0.5"), { ping: async () => 1, scheduler: async () => { throw new Error("ledger unreadable"); }, now: () => now });
  const ldJson = JSON.parse(await ledgerDown.text()) as Record<string, unknown>;
  check("ledger unreadable but SELECT 1 fine → 200 with scheduler null (absence, not zero)", ledgerDown.status === 200 && ldJson.scheduler === null);
  const dbDown = await handleHealth(req("10.0.0.6"), { ping: async () => { throw new Error("down"); }, scheduler: async () => signals, now: () => now });
  check("DB down → 503 even when the scheduler reader would answer", dbDown.status === 503);

  console.log("4. The pure signals derivation reads overdue as job health does");
  {
    const cad = new Map<string, number>([["sync-banks", 24], ["sync-crypto", 6], ["evaluate-alerts", 6]]);
    const base = {
      now, registered: ["sync-banks", "sync-crypto", "evaluate-alerts", "purge-trash"], cadenceHours: cad, defaultCadenceHours: 24,
      alertJobName: "evaluate-alerts", backstopJobName: "resume-stale-imports",
    };
    const healthy = buildSchedulerSignals({
      ...base,
      newestPerJob: [
        { jobName: "sync-banks", startedAt: new Date(now.getTime() - 20 * H) },
        { jobName: "sync-crypto", startedAt: new Date(now.getTime() - 5 * H) },
        { jobName: "evaluate-alerts", startedAt: new Date(now.getTime() - 1 * H) },
        { jobName: "resume-stale-imports", startedAt: new Date(now.getTime() - 3 * 60_000) },
      ],
      alertNewestSucceededAt: new Date(now.getTime() - 1 * H),
    });
    check("nothing overdue; never-ran purge-trash is not counted", healthy.overdueJobs === 0 && !healthy.alertEvaluatorOverdue);
    check("lastDispatchAt = newest registered run (not the backstop)", healthy.lastDispatchAt === new Date(now.getTime() - 1 * H).toISOString());
    check("lastBackstopCronAt is the backstop's own row", healthy.lastBackstopCronAt === new Date(now.getTime() - 3 * 60_000).toISOString());

    const silent = buildSchedulerSignals({
      ...base,
      newestPerJob: [
        { jobName: "sync-banks", startedAt: new Date(now.getTime() - 27 * H) },      // 24 + 2 grace < 27 → overdue
        { jobName: "sync-crypto", startedAt: new Date(now.getTime() - 8 * H) },      // 6 + 2 = 8, not > → not overdue (boundary)
        { jobName: "evaluate-alerts", startedAt: new Date(now.getTime() - 9 * H) },  // overdue
      ],
      alertNewestSucceededAt: new Date(now.getTime() - 30 * 24 * H),
    });
    check("overdue = strictly older than cadence + grace (27 h daily yes, 8 h six-hourly no, 9 h alerts yes)", silent.overdueJobs === 2, String(silent.overdueJobs));
    check("a 30-day-old alert evaluation is alertEvaluatorOverdue", silent.alertEvaluatorOverdue);
    check("no backstop row → null", silent.lastBackstopCronAt === null);
    const never = buildSchedulerSignals({ ...base, newestPerJob: [], alertNewestSucceededAt: null });
    check("empty ledger → nulls, 0 overdue, evaluator overdue (never succeeded)", never.lastDispatchAt === null && never.overdueJobs === 0 && never.alertEvaluatorOverdue);
    const failedOnly = buildSchedulerSignals({
      ...base,
      newestPerJob: [{ jobName: "evaluate-alerts", startedAt: new Date(now.getTime() - 1 * H) }],
      alertNewestSucceededAt: null,
    });
    check("an evaluator that STARTED recently but never succeeded is still overdue (success is the signal)", failedOnly.alertEvaluatorOverdue && failedOnly.lastDispatchAt !== null);

    const healthSrc = readFileSync("lib/jobs/health.ts", "utf8");
    const grace = Number(/export const GRACE_HOURS = (\d+);/.exec(healthSrc)?.[1]);
    check("OVERDUE_GRACE_HOURS mirrors lib/jobs/health.ts GRACE_HOURS", grace === OVERDUE_GRACE_HOURS, `${grace} vs ${OVERDUE_GRACE_HOURS}`);
  }

  console.log("5. Source pins");
  {
    const route = readFileSync("app/api/health/route.ts", "utf8");
    check("no commit sha read on the public route (OPS-014 / OBS-010)", !/VERCEL_GIT_COMMIT_SHA|commit/.test(route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
    check("the route imports registry FACTS only, never the executable registry or job bodies", !/jobs\/registry"|jobs\/health|from "@\/jobs\//.test(route) && !/jobs\/registry"/.test(readFileSync("lib/jobs/scheduler-signals.ts", "utf8")));
    check("the limiter precedes the DB probe (fail-open can never turn a dead DB into a 200)", route.indexOf("limitByIp(") < route.indexOf("await ping()"));
  }

  console.log(failures === 0 ? "\nAll health-route tests passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
