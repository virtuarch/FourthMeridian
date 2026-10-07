/**
 * lib/platform/policies/job-cadence.test.ts  (P1) — execution cadence: read model,
 * bounded validated mutation, optimistic concurrency, the audited reason.
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/policies/job-cadence.test.ts
 */
import { readFileSync } from "node:fs";
import { AuditAction } from "@/lib/audit-actions";
import { editableJob, loadJobCadenceReadModel, resetJobCadence, updateJobCadence } from "./job-cadence";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

interface Row { key: string; value: string; updatedAt: Date; updatedById: string | null }
interface Audit { userId?: string; action: string; performedByAdminId?: string; metadata: Record<string, unknown> }
interface State { settings: Map<string, Row>; audits: Audit[]; runs: { jobName: string; startedAt: Date; status: string }[] }

function makeDb(initial: Partial<State> = {}, faults: { auditFails?: boolean } = {}) {
  const state: State = { settings: new Map(), audits: [], runs: [], ...initial };
  let clock = Date.parse("2026-10-08T12:00:00.000Z");
  const tick = () => new Date((clock += 1000));
  const clientOver = (st: State) => ({
    platformSetting: {
      findMany: async (args: { where: { key: { in: string[] } } }) => [...st.settings.values()].filter((r) => args.where.key.in.includes(r.key)).map((r) => ({ ...r })),
      findUnique: async (args: { where: { key: string } }) => { const r = st.settings.get(args.where.key); return r ? { ...r } : null; },
      create: async (args: { data: { key: string; value: string; updatedById: string } }) => {
        if (st.settings.has(args.data.key)) throw Object.assign(new Error("Unique"), { code: "P2002" });
        const row = { ...args.data, updatedAt: tick() }; st.settings.set(row.key, row); return row;
      },
      updateMany: async (args: { where: { key: string; updatedAt: Date }; data: { value: string; updatedById: string } }) => {
        const r = st.settings.get(args.where.key);
        if (!r || r.updatedAt.getTime() !== args.where.updatedAt.getTime()) return { count: 0 };
        st.settings.set(r.key, { ...r, ...args.data, updatedAt: tick() }); return { count: 1 };
      },
      deleteMany: async (args: { where: { key: string; updatedAt: Date } }) => {
        const r = st.settings.get(args.where.key);
        if (!r || r.updatedAt.getTime() !== args.where.updatedAt.getTime()) return { count: 0 };
        st.settings.delete(r.key); return { count: 1 };
      },
      count: async (args: { where: { key: string } }) => (st.settings.has(args.where.key) ? 1 : 0),
    },
    auditLog: { create: async (args: { data: Audit }) => { if (faults.auditFails) throw new Error("audit down"); st.audits.push(args.data); return args.data; } },
    jobRun: { findMany: async (args: { where: { jobName: { in: string[] } } }) => {
      const seen = new Set<string>(); const out: typeof st.runs = [];
      for (const r of [...st.runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())) {
        if (!args.where.jobName.in.includes(r.jobName) || seen.has(r.jobName)) continue; seen.add(r.jobName); out.push(r);
      }
      return out;
    } },
  });
  const db = {
    ...clientOver(state),
    $transaction: async <T,>(fn: (tx: ReturnType<typeof clientOver>) => Promise<T>): Promise<T> => {
      const draft: State = { settings: new Map([...state.settings].map(([k, v]) => [k, { ...v }])), audits: [...state.audits], runs: state.runs };
      const out = await fn(clientOver(draft));
      state.settings = draft.settings; state.audits = draft.audits;
      return out;
    },
  };
  return { db: db as never, state };
}
const ACTOR = { id: "op_1", ipAddress: "10.0.0.1", userAgent: "ua" };
const REASON = { code: "TESTING" as const, note: "dogfood" };
const NOW = new Date("2026-10-08T12:00:00.000Z");
const FX = "job_cadence_hours_fetch-fx-rates";

async function main(): Promise<void> {
  console.log("1. read model: every job, cadence/origin/bounds, last run, next due");
  {
    const { db } = makeDb({ runs: [{ jobName: "fetch-fx-rates", startedAt: new Date("2026-10-08T06:00:00.000Z"), status: "succeeded" }] });
    const m = await loadJobCadenceReadModel(db, NOW);
    check("wake cadence stated", m.wakeEveryMinutes === 15);
    check("eleven jobs listed", m.jobs.length === 11);
    const fx = m.jobs.find((j) => j.job === "fetch-fx-rates")!;
    check("fx: DEFAULT 24h, editable 6–168, no version token", fx.origin === "DEFAULT" && fx.hours === 24 && fx.editable && fx.minHours === 6 && fx.updatedAt === null);
    check("fx: next due = last start + 24h − 5 min", fx.nextDueAt === "2026-10-09T05:55:00.000Z" && fx.lastStartedAt === "2026-10-08T06:00:00.000Z");
    const cont = m.jobs.find((j) => j.job === "sync-crypto-continuation")!;
    check("continuation: follows its primary, no next-due instant", cont.origin === "FOLLOWS_PRIMARY" && cont.primary === "sync-crypto" && cont.nextDueAt === null);
    check("a never-ran job has no next-due instant (due at the next wake)", m.jobs.find((j) => j.job === "sync-banks")?.nextDueAt === null);
    check("no email, token or balance in the model", !/@|token|secret|balance/i.test(JSON.stringify(m)));
  }

  console.log("\n2. update: bounded, versioned, audited WITH a reason, in one transaction");
  {
    const { db, state } = makeDb();
    const r = await updateJobCadence({ job: "fetch-fx-rates", hours: 12, expectedUpdatedAt: null, reason: REASON, actor: ACTOR }, db, NOW);
    check("ok", r.ok);
    const row = state.settings.get(FX)!;
    check("row created with the normalised value and the actor", row?.value === "12" && row.updatedById === "op_1");
    check("read model shows SETTING 12h with the version token", r.ok && r.model.jobs.find((j) => j.job === "fetch-fx-rates")?.origin === "SETTING" && r.model.jobs.find((j) => j.job === "fetch-fx-rates")?.updatedAt === row.updatedAt.toISOString());
    const a = state.audits[0];
    const meta = a.metadata as { reason: { code: string; note: string }; target: { kind: string; id: string }; change: { before: { hours: number | null }; after: { hours: number } } };
    check("exactly one audit row: JOB_CADENCE_CHANGED by the operator, target JOB, reason carried, before/after hours",
      state.audits.length === 1 && a.action === AuditAction.JOB_CADENCE_CHANGED && a.performedByAdminId === "op_1"
        && meta.target.kind === "JOB" && meta.target.id === "fetch-fx-rates" && meta.reason.code === "TESTING" && meta.reason.note === "dogfood"
        && meta.change.before.hours === null && meta.change.after.hours === 12);
    check("no secret-shaped or financial content in the audit row", !/token|secret|balance|@/i.test(JSON.stringify(a)));

    const below = await updateJobCadence({ job: "fetch-fx-rates", hours: 2, expectedUpdatedAt: row.updatedAt.toISOString(), reason: REASON, actor: ACTOR }, db, NOW);
    check("below the floor ⇒ VALIDATION, nothing written, nothing audited", !below.ok && below.code === "VALIDATION" && /at least 6/.test(below.reason) && state.settings.get(FX)?.value === "12" && state.audits.length === 1);
    const above = await updateJobCadence({ job: "fetch-fx-rates", hours: 999, expectedUpdatedAt: row.updatedAt.toISOString(), reason: REASON, actor: ACTOR }, db, NOW);
    check("above the ceiling ⇒ VALIDATION", !above.ok && above.code === "VALIDATION" && /at most 168/.test(above.reason));
    const stale = await updateJobCadence({ job: "fetch-fx-rates", hours: 24, expectedUpdatedAt: null, reason: REASON, actor: ACTOR }, db, NOW);
    check("a stale observation (null vs existing row) ⇒ CONFLICT, nothing written", !stale.ok && stale.code === "CONFLICT" && state.settings.get(FX)?.value === "12");
    const fixed = await updateJobCadence({ job: "process-deletions", hours: 12, expectedUpdatedAt: null, reason: REASON, actor: ACTOR }, db, NOW);
    check("a FIXED job is NOT_EDITABLE", !fixed.ok && fixed.code === "NOT_EDITABLE");
    const refresh = await updateJobCadence({ job: "sync-banks", hours: 12, expectedUpdatedAt: null, reason: REASON, actor: ACTOR }, db, NOW);
    check("a refresh job is NOT_EDITABLE here (its knob is the refresh policy)", !refresh.ok && refresh.code === "NOT_EDITABLE");
    check("editableJob names exactly the three", ["fetch-fx-rates", "fetch-security-prices", "evaluate-alerts"].every((j) => editableJob(j) !== null) && editableJob("sync-crypto") === null && editableJob("nope") === null);
  }

  console.log("\n3. reason is required by type and by the recorder; audit failure rolls the change back");
  {
    const { db, state } = makeDb();
    let threw = false;
    try { await updateJobCadence({ job: "fetch-fx-rates", hours: 12, expectedUpdatedAt: null, reason: undefined as never, actor: ACTOR }, db, NOW); }
    catch (e) { threw = (e as Error).name === "OperatorActionValidationError"; }
    check("a missing reason throws inside the transaction and NOTHING is written", threw && state.settings.size === 0 && state.audits.length === 0);
    const failing = makeDb({}, { auditFails: true });
    let failed = false;
    try { await updateJobCadence({ job: "fetch-fx-rates", hours: 12, expectedUpdatedAt: null, reason: REASON, actor: ACTOR }, failing.db, NOW); } catch { failed = true; }
    check("audit failure ⇒ the setting write is rolled back", failed && failing.state.settings.size === 0);
  }

  console.log("\n4. reset: delete the row, audit JOB_CADENCE_RESET with a reason");
  {
    const { db, state } = makeDb();
    await updateJobCadence({ job: "evaluate-alerts", hours: 2, expectedUpdatedAt: null, reason: REASON, actor: ACTOR }, db, NOW);
    const row = state.settings.get("job_cadence_hours_evaluate-alerts")!;
    const r = await resetJobCadence({ job: "evaluate-alerts", expectedUpdatedAt: row.updatedAt.toISOString(), reason: { code: "OTHER" }, actor: ACTOR }, db, NOW);
    check("ok; row deleted; default (6h) in force", r.ok && !state.settings.has("job_cadence_hours_evaluate-alerts") && r.ok && r.model.jobs.find((j) => j.job === "evaluate-alerts")?.hours === 6);
    check("reset audited with before 2h → after default", state.audits[1]?.action === AuditAction.JOB_CADENCE_RESET
      && (state.audits[1].metadata as { change: { before: { hours: number }; after: { origin: string } } }).change.before.hours === 2
      && (state.audits[1].metadata as { change: { after: { origin: string } } }).change.after.origin === "DEFAULT");
    const gone = await resetJobCadence({ job: "evaluate-alerts", expectedUpdatedAt: row.updatedAt.toISOString(), reason: { code: "OTHER" }, actor: ACTOR }, db, NOW);
    check("resetting when no override exists is a CONFLICT, not a silent no-op", !gone.ok && gone.code === "CONFLICT");
  }

  console.log("\n5. source: the route requires fresh CONTROL and a reason; the service runs no job");
  {
    const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    const route = code("app/api/platform/platform-ops/job-cadence/route.ts");
    const svc = code("lib/platform/policies/job-cadence.ts");
    check("GET is READ-gated; PATCH and DELETE require fresh CONTROL",
      /requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(route) && (route.match(/requireFreshPlatformAccess\("PLATFORM_OPS", "CONTROL"\)/g) ?? []).length === 2);
    check("the route parses a structured reason for both mutations", (route.match(/parseOperatorReason/g) ?? []).length >= 2);
    check("the service writes its audit through recordOperatorAction inside $transaction", /\$transaction/.test(svc) && (svc.match(/recordOperatorAction\(tx/g) ?? []).length === 2);
    check("the service imports no job runner, provider or AI module", !/runJob|plaid|openai|syncWallet|dispatch/i.test(svc));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
