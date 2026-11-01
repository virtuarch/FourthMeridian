/**
 * lib/jobs/single-job-dispatch.test.ts  (Comms Center Preview activation — GET /api/jobs/dispatch?only=)
 *
 * On Preview (no crons) the automation executor is woken by hand. `?only=comms-automations` must run
 * THAT job only — never the due bank / wallet / FX jobs (Preview's Plaid Items are legacy sandbox and
 * must never be called) — through the same due rule and runJob claim; any other key is 400; auth is
 * unchanged; with no `only` the wake is the ordinary one. No database (the fake), no network, no job body runs.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/jobs/single-job-dispatch.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed fake rows */

import "@/lib/test-support/route-env";
import { readFileSync } from "node:fs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
  const { log, warn, error } = console; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; console.error = error; }
};

const NOW = new Date(Date.UTC(2026, 10, 1, 9, 7, 0));
const MIN = 60_000;

async function main(): Promise<void> {
  const fake = new FakePrisma();
  await installFakePrisma(fake);
  const D = await import("@/lib/jobs/dispatch");
  const { SCHEDULED_JOBS } = await import("@/lib/jobs/registry");
  const { defaultJobCadencePolicies } = await import("@/lib/jobs/cadence-policy");
  const policies = defaultJobCadencePolicies(SCHEDULED_JOBS);
  const NEVER = new Map(); // every job NEVER_RAN ⇒ every job due on an ordinary wake
  const recorder = () => {
    const ran: string[] = [];
    const runner = async (name: string, _fn: () => Promise<unknown>, o: { trigger: string }) => { ran.push(`${name}:${o.trigger}`); return {}; };
    return { ran, runner };
  };

  // ── the parser ─────────────────────────────────────────────────────────────
  console.log("1. ?only= accepts ONLY the hard-coded allowlist");
  check("the allowlist is exactly [comms-automations]", D.SINGLE_JOB_DISPATCH_ALLOWLIST.join() === "comms-automations");
  const p = D.parseSingleJobDispatch;
  check("absent ⇒ no narrowing (the ordinary wake)", (p([]) as any).ok && (p([]) as any).only === null);
  check("comms-automations ⇒ narrowed to it", (p(["comms-automations"]) as any).only === "comms-automations");
  for (const bad of [["sync-banks"], ["sync-crypto"], ["fetch-fx-rates"], [""], ["Comms-Automations"], [" comms-automations"], ["comms-automations,sync-banks"], ["comms-automations", "comms-automations"], ["comms-automations", "sync-banks"]]) {
    check(`refused: ${JSON.stringify(bad)}`, p(bad).ok === false);
  }
  check("every real registry job other than comms-automations is refused", SCHEDULED_JOBS.filter((j) => j.name !== "comms-automations").every((j) => !p([j.name]).ok));

  // ── the narrowed wake ──────────────────────────────────────────────────────
  console.log("2. the narrowed wake runs ONLY the named job, by the same due rule");
  {
    const { ran, runner } = recorder();
    const r = await quiet(() => D.dispatchDueJobs(NOW, { only: "comms-automations", jobs: SCHEDULED_JOBS, facts: NEVER, policies, runner }));
    check("every registered job is due, yet ONLY comms-automations runs (trigger cron, the same runJob path)",
      ran.join() === "comms-automations:cron" && r.dispatched.length === 1 && r.dispatched[0].job === "comms-automations" && r.skipped.length === 0, { ran, r });
    check("…no bank / wallet / FX job is even considered", !r.skipped.some((s) => s.job !== "comms-automations") && !ran.some((x) => /sync-|fx|price/.test(x)));
  }
  {
    const { ran, runner } = recorder();
    const recent = new Map([["comms-automations", { lastStartedAt: new Date(NOW.getTime() - 5 * MIN), lastStatus: "succeeded", lastSummary: { deferred: 1 } }]]);
    const r = await quiet(() => D.dispatchDueJobs(NOW, { only: "comms-automations", jobs: SCHEDULED_JOBS, facts: recent, policies, runner }));
    check("not due (ran 5 min ago; the self-continuation is 15 min) ⇒ nothing runs — no force path",
      ran.length === 0 && r.skipped.length === 1 && r.skipped[0].job === "comms-automations" && r.skipped[0].reason === "NOT_YET_DUE", r);
    const later = new Map([["comms-automations", { lastStartedAt: new Date(NOW.getTime() - 16 * MIN), lastStatus: "succeeded", lastSummary: { deferred: 1 } }]]);
    const r2 = await quiet(() => D.dispatchDueJobs(NOW, { only: "comms-automations", jobs: SCHEDULED_JOBS, facts: later, policies, runner }));
    check("…16 min after a run that reported deferred work ⇒ due (SELF_CONTINUATION) and run", ran.join() === "comms-automations:cron" && r2.dispatched.length === 1, r2);
  }
  {
    // Ledger semantics: only THIS job's crashed `running` row is finalised; no other job's ledger is read or touched.
    const where: any[] = [];
    const reads: any[] = [];
    const client = { jobRun: {
      updateMany: async (a: any) => { where.push(a.where); return { count: 0 }; },
      findMany: async (a: any) => { reads.push(a.where); return []; },
    } } as any;
    const { ran, runner } = recorder();
    await quiet(() => D.dispatchDueJobs(NOW, { only: "comms-automations", jobs: SCHEDULED_JOBS, client, policies, runner }));
    check("the stale-run finaliser is scoped to comms-automations (no wake-wide sweep)", where.length === 1 && where[0].jobName === "comms-automations" && where[0].status === "running", where);
    check("…the ledger read covers comms-automations only", reads.length === 1 && JSON.stringify(reads[0].jobName?.in) === JSON.stringify(["comms-automations"]) && ran.join() === "comms-automations:cron", reads);
  }
  {
    const { ran, runner } = recorder();
    const r = await quiet(() => D.dispatchDueJobs(NOW, { only: "sync-banks" as any, jobs: SCHEDULED_JOBS, facts: NEVER, policies, runner }));
    check("a caller that bypasses the parser with a non-allowlisted key runs NOTHING", ran.length === 0 && r.dispatched.length === 0, r);
  }
  {
    const { ran, runner } = recorder();
    const r = await quiet(() => D.dispatchDueJobs(NOW, { jobs: SCHEDULED_JOBS, facts: NEVER, policies, runner }));
    const expected = D.selectDueJobs(NOW, SCHEDULED_JOBS, NEVER, policies).due.map((j) => `${j.name}:cron`);
    check("WITHOUT only: the ordinary wake — every due job, in registry order (unchanged)", ran.join() === expected.join() && ran.length > 1 && ran.includes("sync-banks:cron") && ran.includes("comms-automations:cron") && r.dispatched.length === ran.length, { ran: ran.length, expected: expected.length });
  }

  // ── the route ──────────────────────────────────────────────────────────────
  console.log("3. GET /api/jobs/dispatch: auth first, then ?only=");
  {
    const { request, invoke } = await import("@/lib/test-support/route-harness");
    const ROUTE = await import("@/app/api/jobs/dispatch/route");
    const saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test-cron-secret-not-real-0123456789";
    const auth = { authorization: `Bearer ${process.env.CRON_SECRET}` };
    const get = (q: string, headers: Record<string, string> = {}) => quiet(() => invoke(ROUTE.GET, request(`/api/jobs/dispatch${q}`, { headers })));
    try {
      const jobRuns = () => fake.rows("JobRun").length;
      const before = jobRuns();
      const noAuth = await get("?only=comms-automations");
      check("?only= WITHOUT the CRON_SECRET bearer ⇒ 401 (auth unchanged, decided first)", noAuth.status === 401 && jobRuns() === before, noAuth.status);
      const wrong = await get("?only=comms-automations", { authorization: "Bearer nope" });
      check("…a wrong secret ⇒ 401", wrong.status === 401);
      const badNoAuth = await get("?only=sync-banks");
      check("an unknown key without auth ⇒ 401, not 400 (nothing is disclosed before auth)", badNoAuth.status === 401);
      for (const q of ["?only=sync-banks", "?only=", "?only=comms-automations&only=sync-banks", "?only=COMMS-AUTOMATIONS"]) {
        const r = await get(q, auth);
        check(`authorised ${q} ⇒ 400, nothing run`, r.status === 400 && (r.body as any)?.code === "VALIDATION" && jobRuns() === before, { status: r.status, body: r.body });
      }
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    }
    const src = readFileSync("app/api/jobs/dispatch/route.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("the route parses ?only= only AFTER the CRON_SECRET check", src.indexOf("isAuthorizedCronRequest(") < src.indexOf("parseSingleJobDispatch("));
    check("…and without it calls dispatchDueJobs(new Date()) exactly as before (no options)",
      /narrowed\.only \? await dispatchDueJobs\(new Date\(\), \{ only: narrowed\.only \}\) : await dispatchDueJobs\(new Date\(\)\);/.test(src));
  }

  console.log(failures === 0 ? "\n✅ single-job dispatch: all checks passed" : `\n❌ ${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
