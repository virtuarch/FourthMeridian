/**
 * lib/platform/intelligence/ai/conversations/purge-on-demand.test.ts  (the ON-DEMAND Platform AI purge trigger)
 *
 * GET /api/jobs/dispatch?only=platform-ai-purge runs the conversation retention
 * purge once, ledgered (JobRun `platform-ai-purge-on-demand`) and audited
 * (trigger ON_DEMAND), behind TWO flags. Proves: either flag off ⇒ 409 and NO
 * database contact (no JobRun either); on ⇒ 200 counts, an audit row every run;
 * an errored purge ⇒ 500 + a FAILED JobRun that keeps its counts; a held claim ⇒
 * 409 BUSY; a ledger outage ⇒ 503; `exhausted:false` when more remain; every body
 * carries only its listed keys; auth precedes the branch; the definer function
 * still locks `FOR UPDATE SKIP LOCKED` (concurrency with the scheduled purge).
 * No database (the fake), no network. The real-env flag combinations run in
 * child processes of this file (lib/env snapshots process.env at load).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/conversations/purge-on-demand.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed fake rows */

import "@/lib/test-support/route-env";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { FakePrisma, installFakePrisma, knownError } from "@/lib/test-support/fake-prisma";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
  const { log, warn, error } = console; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; console.error = error; }
};
const keys = (o: unknown) => Object.keys(o as object).sort().join();
const COUNT_KEYS = "batches,conversations,exhausted,messages,ok";

const CHILD = process.argv.find((a) => a.startsWith("--child="))?.slice("--child=".length) ?? null;
const SECRET = "test-cron-secret-not-real-0123456789";

/** The route through the real handler, the fake installed, the env as this process was started. */
async function routeHarness(fake: FakePrisma) {
  const { request, invoke } = await import("@/lib/test-support/route-harness");
  const ROUTE = await import("@/app/api/jobs/dispatch/route");
  process.env.CRON_SECRET = SECRET;
  const get = (q: string, auth = true) => quiet(() => invoke(ROUTE.GET, request(`/api/jobs/dispatch${q}`, { headers: auth ? { authorization: `Bearer ${SECRET}` } : {} })));
  const untouched = () => fake.calls.length === 0 && fake.raw.length === 0;
  return { get, untouched };
}

// ── child mode: one real-env flag combination through the route ─────────────
async function child(mode: string): Promise<void> {
  const fake = new FakePrisma();
  await installFakePrisma(fake);
  const { get, untouched } = await routeHarness(fake);
  if (mode === "purge-only" || mode === "on-demand-only") {
    const r = await get("?only=platform-ai-purge");
    check(`[${mode}] ⇒ 409 PURGE_ON_DEMAND_DISABLED, body { ok, code } only`, r.status === 409 && (r.body as any).code === "PURGE_ON_DEMAND_DISABLED" && (r.body as any).ok === false && keys(r.body) === "code,ok", r);
    check(`[${mode}] …NO database contact (no JobRun, no call, no audit)`, untouched(), { calls: fake.calls.length, raw: fake.raw.length });
  } else if (mode === "both-on") {
    fake.queryRaw = () => [{ conversations: 2, messages: 7 }];
    const r = await get("?only=platform-ai-purge");
    check("[both-on] ⇒ 200 { ok, conversations, messages, batches, exhausted }", r.status === 200 && keys(r.body) === COUNT_KEYS
      && JSON.stringify(r.body) === JSON.stringify({ ok: true, conversations: 2, messages: 7, batches: 1, exhausted: true }), r);
    const runs = fake.rows("JobRun");
    check("[both-on] …one JobRun `platform-ai-purge-on-demand`, trigger manual, succeeded, counts summary",
      runs.length === 1 && runs[0].jobName === "platform-ai-purge-on-demand" && runs[0].trigger === "manual" && runs[0].status === "succeeded"
        && JSON.stringify(runs[0].summary) === JSON.stringify({ enabled: true, conversations: 2, messages: 7, batches: 1, exhausted: true }), runs);
    const audits = fake.rows("AuditLog");
    check("[both-on] …one counts-only audit row tagged trigger ON_DEMAND", audits.length === 1 && (audits[0].metadata as any).trigger === "ON_DEMAND"
      && keys(audits[0].metadata) === "actorType,batches,conversations,exhausted,messages,trigger", audits);
    check("[both-on] …the purge SQL is the only raw statement", fake.raw.length === 1 && /fm_purge_platform_ai_conversations/.test(fake.raw[0].sql), fake.raw);
    const busy = await get("?only=platform-ai-purge", false);
    check("[both-on] …and without the bearer ⇒ 401 even with the flags on", busy.status === 401 && fake.rows("JobRun").length === 1);
  }
  if (failures > 0) process.exit(1);
}

function runChild(mode: string, env: Record<string, string>): boolean {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  for (const k of ["PLATFORM_AI_PURGE_ENABLED", "PLATFORM_AI_PURGE_ON_DEMAND_ENABLED", "PLATFORM_AI_CONVERSATIONS_ENABLED"]) if (!(k in env)) delete childEnv[k];
  const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], `--child=${mode}`], { env: childEnv as NodeJS.ProcessEnv, encoding: "utf8" });
  process.stdout.write(r.stdout ?? "");
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 0;
}

// ── parent mode ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // The SHIPPED state in this process: both flags unset (lib/env is loaded only below).
  delete process.env.PLATFORM_AI_PURGE_ENABLED; delete process.env.PLATFORM_AI_PURGE_ON_DEMAND_ENABLED; delete process.env.PLATFORM_AI_CONVERSATIONS_ENABLED;
  const fake = new FakePrisma();
  await installFakePrisma(fake);
  const OD = await import("./purge-on-demand");
  const H = await import("./purge-health");
  const { platformAiPurgeDeps, platformAiPurgeOnDemandDeps } = await import("@/jobs/data-retention");
  const { env } = await import("@/lib/env");
  const { PLATFORM_AI_PURGE_BATCH, PLATFORM_AI_PURGE_MAX_CALLS } = await import("./constants");
  const flagsOn = { isPlatformAiPurgeOnDemandEnabled: true, isPlatformAiPurgeEnabled: true, isPlatformAiConversationsFlagSetWithoutPurge: false };

  console.log("1. the pins");
  check("the job name is pinned: PLATFORM_AI_PURGE_ON_DEMAND_JOB === \"platform-ai-purge-on-demand\" (one literal, re-exported)",
    OD.PLATFORM_AI_PURGE_ON_DEMAND_JOB === "platform-ai-purge-on-demand" && H.PLATFORM_AI_PURGE_ON_DEMAND_JOB === OD.PLATFORM_AI_PURGE_ON_DEMAND_JOB);
  check("the ?only= key is platform-ai-purge", OD.PLATFORM_AI_PURGE_DISPATCH_KEY === "platform-ai-purge");
  const envSrc = readFileSync("lib/env.ts", "utf8");
  check("lib/env: the getter is BOTH flags, strict === \"true\"",
    /get isPlatformAiPurgeOnDemandEnabled\(\) \{ return _e\.PLATFORM_AI_PURGE_ENABLED === "true" && _e\.PLATFORM_AI_PURGE_ON_DEMAND_ENABLED === "true"; \}/.test(envSrc)
      && /PLATFORM_AI_PURGE_ON_DEMAND_ENABLED: process\.env\.PLATFORM_AI_PURGE_ON_DEMAND_ENABLED,/.test(envSrc));
  check("…and the SHIPPED state (both unset) is OFF", env.isPlatformAiPurgeOnDemandEnabled === false && (await platformAiPurgeOnDemandDeps()).enabled === false);
  check(".env.example documents the flag, empty (default OFF), owner-gated", /\nPLATFORM_AI_PURGE_ON_DEMAND_ENABLED=\n/.test(readFileSync(".env.example", "utf8"))
    && /Production enablement is owner-gated/.test(readFileSync(".env.example", "utf8")));
  const routeSrc = readFileSync("app/api/jobs/dispatch/route.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const iAuth = routeSrc.indexOf("isAuthorizedCronRequest(req.headers.get(\"authorization\"), process.env.CRON_SECRET)");
  const iBranch = routeSrc.indexOf("narrowed.only === \"platform-ai-purge\"");
  check("route: the CRON_SECRET check (Authorization header only) precedes the platform-ai-purge branch",
    iAuth > 0 && iBranch > iAuth && routeSrc.indexOf("parseSingleJobDispatch(") > iAuth && routeSrc.indexOf("runPlatformAiPurgeOnDemand(") > iBranch, { iAuth, iBranch });
  check("route: the branch returns before the dispatcher (never the schedule / due logic)",
    iBranch < routeSrc.indexOf("dispatchDueJobs(new Date()") && /return NextResponse\.json\(r\.body, \{ status: r\.status \}\);/.test(routeSrc));
  const mig = readFileSync("prisma/migrations/20261104120000_platform_ai_conversations/migration.sql", "utf8");
  const fn = mig.slice(mig.indexOf("CREATE FUNCTION public.fm_purge_platform_ai_conversations"), mig.indexOf("END $$;", mig.indexOf("CREATE FUNCTION public.fm_purge_platform_ai_conversations")));
  check("migration: the purge function still selects its rows FOR UPDATE SKIP LOCKED (messages AND conversations) — concurrent runs delete disjoint rows",
    fn.length > 0 && (fn.match(/FOR UPDATE SKIP LOCKED/g) ?? []).length === 2, (fn.match(/FOR UPDATE SKIP LOCKED/g) ?? []).length);
  const odSrc = readFileSync("lib/platform/intelligence/ai/conversations/purge-on-demand.ts", "utf8");
  check("the module header documents the SKIP LOCKED concurrency and cites the migration",
    /FOR UPDATE SKIP LOCKED/.test(odSrc) && /20261104120000_platform_ai_/.test(odSrc) && !/systemDb|from "@\/lib\/db"/.test(odSrc));

  console.log("2. the ON_DEMAND purge deps (jobs/data-retention.ts)");
  {
    const f = (purge: boolean, misordered: boolean) => ({ isPlatformAiPurgeEnabled: purge, isPlatformAiConversationsFlagSetWithoutPurge: misordered });
    const on = await platformAiPurgeDeps("ON_DEMAND", f(true, false));
    check("ON_DEMAND: enabled = PLATFORM_AI_PURGE_ENABLED, an audit row every run, not misordered", on.enabled === true && on.auditEveryRun === true && on.misordered === false);
    const off = await platformAiPurgeDeps("ON_DEMAND", f(false, true));
    check("ON_DEMAND is NOT forced on (unlike MANUAL_DISPATCH): purge flag off ⇒ disabled, misordered reported as for SCHEDULED",
      off.enabled === false && off.misordered === true);
    check("platformAiPurgeOnDemandDeps: enabled = the combined getter", (await platformAiPurgeOnDemandDeps({ ...flagsOn, isPlatformAiPurgeOnDemandEnabled: false })).enabled === false
      && (await platformAiPurgeOnDemandDeps(flagsOn)).enabled === true);
  }

  console.log("3. the orchestration (injected seams)");
  const throwingClient = { jobRun: new Proxy({}, { get: () => () => { throw new Error("ledger touched"); } }) } as any;
  {
    let built = 0;
    const r = await quiet(() => OD.runPlatformAiPurgeOnDemand({ enabled: false, purgeDeps: async () => { built++; throw new Error("purge touched"); }, jobRunClient: throwingClient }));
    check("disabled ⇒ 409 PURGE_ON_DEMAND_DISABLED, body { ok, code } only — purge deps never built, the JobRun ledger never touched",
      r.status === 409 && (r.body as any).code === "PURGE_ON_DEMAND_DISABLED" && keys(r.body) === "code,ok" && built === 0);
  }
  const realDeps = (flags = flagsOn) => ({ enabled: true, purgeDeps: () => platformAiPurgeDeps("ON_DEMAND", flags) });
  {
    fake.reset();
    fake.queryRaw = () => [{ conversations: 0, messages: 0 }];
    const r = await quiet(() => OD.runPlatformAiPurgeOnDemand(realDeps()));
    check("on, nothing expired ⇒ 200 { ok:true, 0, 0, 1 batch, exhausted:true }, listed keys only",
      r.status === 200 && keys(r.body) === COUNT_KEYS && JSON.stringify(r.body) === JSON.stringify({ ok: true, conversations: 0, messages: 0, batches: 1, exhausted: true }), r);
    const runs = fake.rows("JobRun");
    check("…its JobRun: name platform-ai-purge-on-demand, trigger manual, succeeded, summary = the counts shape",
      runs.length === 1 && runs[0].jobName === OD.PLATFORM_AI_PURGE_ON_DEMAND_JOB && runs[0].trigger === "manual" && runs[0].status === "succeeded"
        && JSON.stringify(runs[0].summary) === JSON.stringify({ enabled: true, conversations: 0, messages: 0, batches: 1, exhausted: true }), runs);
    const audits = fake.rows("AuditLog");
    check("…an audit row EVERY run (zero included), trigger ON_DEMAND, counts only, no failed key",
      audits.length === 1 && (audits[0].metadata as any).trigger === "ON_DEMAND" && (audits[0].metadata as any).failed === undefined && audits[0].userId == null, audits);
    check("…and the succeeded on-demand JobRun reads as a successful purge run (purge health)",
      H.isSuccessfulPurgeRun({ jobName: runs[0].jobName as string, summary: runs[0].summary }));
  }
  {
    fake.reset();
    fake.queryRaw = () => [{ conversations: PLATFORM_AI_PURGE_BATCH, messages: 3 }];
    const r = await quiet(() => OD.runPlatformAiPurgeOnDemand(realDeps()));
    check(`more remain ⇒ 200 exhausted:false after ${PLATFORM_AI_PURGE_MAX_CALLS} batches (call again)`,
      r.status === 200 && (r.body as any).exhausted === false && (r.body as any).batches === PLATFORM_AI_PURGE_MAX_CALLS
        && (r.body as any).conversations === PLATFORM_AI_PURGE_BATCH * PLATFORM_AI_PURGE_MAX_CALLS && keys(r.body) === COUNT_KEYS, r);
  }
  {
    fake.reset();
    let n = 0;
    fake.queryRaw = () => { n++; if (n === 2) throw new Error("boom: relation secret-detail-123 does not exist"); return [{ conversations: PLATFORM_AI_PURGE_BATCH, messages: 4 }]; };
    const r = await quiet(() => OD.runPlatformAiPurgeOnDemand(realDeps()));
    check("error part-way ⇒ 500 { ok:false, code:PURGE_FAILED, counts so far } — listed keys only, NO error text",
      r.status === 500 && (r.body as any).code === "PURGE_FAILED" && keys(r.body) === "batches,code,conversations,exhausted,messages,ok"
        && (r.body as any).conversations === PLATFORM_AI_PURGE_BATCH && (r.body as any).batches === 1 && !/boom|secret/.test(JSON.stringify(r.body)), r);
    const runs = fake.rows("JobRun");
    check("…the JobRun is FAILED with a fixed errorSummary and its counts summary (failed:true, no error text)",
      runs.length === 1 && runs[0].status === "failed" && runs[0].errorSummary === OD.PLATFORM_AI_PURGE_ON_DEMAND_FAILED
        && JSON.stringify(runs[0].summary) === JSON.stringify({ enabled: true, conversations: PLATFORM_AI_PURGE_BATCH, messages: 4, batches: 1, exhausted: false, failed: true })
        && !/boom|secret/.test(JSON.stringify(runs[0])), runs);
    const audits = fake.rows("AuditLog");
    check("…the audit row carries failed:true (never read as a success)", audits.length === 1 && (audits[0].metadata as any).failed === true && (audits[0].metadata as any).trigger === "ON_DEMAND", audits);
    check("…and the failed run is not a successful purge run", !H.isSuccessfulPurgeRun({ jobName: OD.PLATFORM_AI_PURGE_ON_DEMAND_JOB, summary: runs[0].summary }));
  }
  {
    fake.reset();
    const r = await quiet(() => OD.runPlatformAiPurgeOnDemand(realDeps({ ...flagsOn, isPlatformAiPurgeEnabled: false })));
    check("defence in depth: the purge reads itself disabled inside the run ⇒ 500 PURGE_FAILED, FAILED JobRun, no purge call",
      r.status === 500 && (r.body as any).code === "PURGE_FAILED" && fake.rows("JobRun")[0]?.status === "failed" && fake.raw.length === 0, r);
  }
  {
    // BUSY — through the REAL claim: the one-running-per-job partial unique index
    // (prisma/migrations/20261022000200_job_run_one_running_per_job), declared to the fake.
    let built = 0;
    const deps = { enabled: true, purgeDeps: async () => { built++; return platformAiPurgeDeps("ON_DEMAND", flagsOn); } };
    fake.reset();
    fake.partialUnique("JobRun", ["jobName"], { status: "running" }, "JobRun_one_running_per_job");
    fake.seed("JobRun", { jobName: OD.PLATFORM_AI_PURGE_ON_DEMAND_JOB, trigger: "manual", executionId: "held-claim", status: "running", startedAt: new Date() });
    const r = await quiet(() => OD.runPlatformAiPurgeOnDemand(deps));
    check("a concurrent on-demand run holds the claim ⇒ 409 { ok:false, code:BUSY } only — the body did not run",
      r.status === 409 && (r.body as any).code === "BUSY" && keys(r.body) === "code,ok" && built === 0 && fake.raw.length === 0, r);
    const seam = await quiet(() => OD.runPlatformAiPurgeOnDemand({ ...deps, jobRunClient: { jobRun: {
      updateMany: async () => ({ count: 0 }),
      create: async () => { throw knownError("P2002", "Unique constraint failed on the index: `JobRun_one_running_per_job`"); },
      update: async () => { throw new Error("no completion expected"); },
    } } as any }));
    check("…the same via the injected ledger seam (P2002 on the start row) ⇒ BUSY", seam.status === 409 && (seam.body as any).code === "BUSY" && built === 0);
  }
  {
    let built = 0;
    const r = await quiet(() => OD.runPlatformAiPurgeOnDemand({ enabled: true, purgeDeps: async () => { built++; return platformAiPurgeDeps("ON_DEMAND", flagsOn); }, jobRunClient: { jobRun: {
      updateMany: async () => ({ count: 0 }),
      create: async () => { throw new Error("connection refused 10.0.0.1"); },
      update: async () => { throw new Error("no completion expected"); },
    } } as any }));
    check("the start-ledger write fails ⇒ 503 { ok:false, code:LEDGER_UNAVAILABLE } only — the body did not run, no cause echoed",
      r.status === 503 && (r.body as any).code === "LEDGER_UNAVAILABLE" && keys(r.body) === "code,ok" && built === 0 && !/10\.0|refused/.test(JSON.stringify(r.body)), r);
  }

  console.log("4. GET /api/jobs/dispatch?only=platform-ai-purge (the shipped env: both flags unset)");
  {
    fake.reset();
    const { get, untouched } = await routeHarness(fake);
    const noAuth = await get("?only=platform-ai-purge", false);
    check("without the CRON_SECRET bearer ⇒ 401, nothing touched", noAuth.status === 401 && untouched(), noAuth.status);
    const r = await get("?only=platform-ai-purge");
    check("authorised, flags unset ⇒ 409 PURGE_ON_DEMAND_DISABLED, body { ok, code } only", r.status === 409 && (r.body as any).code === "PURGE_ON_DEMAND_DISABLED" && keys(r.body) === "code,ok", r);
    check("…NO database contact: no JobRun, no purge call, no audit row (no fake call at all)", untouched(), { calls: fake.calls.length, raw: fake.raw.length });
    for (const q of ["?only=platform-ai-purge&only=platform-ai-purge", "?only=platform-ai-purge-on-demand", "?only=PLATFORM-AI-PURGE"]) {
      const bad = await get(q);
      check(`authorised ${q} ⇒ 400 listing the allowed keys, nothing touched`, bad.status === 400 && (bad.body as any).code === "VALIDATION"
        && /allowed: comms-automations, platform-ai-purge/.test((bad.body as any).error) && untouched(), bad);
    }
  }

  console.log("5. the real-env flag combinations (child processes)");
  check("PLATFORM_AI_PURGE_ENABLED only ⇒ 409, no contact", runChild("purge-only", { PLATFORM_AI_PURGE_ENABLED: "true" }));
  check("PLATFORM_AI_PURGE_ON_DEMAND_ENABLED only ⇒ 409, no contact", runChild("on-demand-only", { PLATFORM_AI_PURGE_ON_DEMAND_ENABLED: "true" }));
  check("both \"true\" ⇒ 200 through the route, ledgered + audited", runChild("both-on", { PLATFORM_AI_PURGE_ENABLED: "true", PLATFORM_AI_PURGE_ON_DEMAND_ENABLED: "true" }));

  console.log(failures === 0 ? "\n✅ platform-ai purge on demand: all checks passed" : `\n❌ ${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

(CHILD ? child(CHILD) : main()).catch((e) => { console.error(e); process.exit(1); });
