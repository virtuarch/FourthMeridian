/**
 * lib/platform/policies/mutate.test.ts  (PLATFORM OPS POLICIES — Slice 2)
 *
 * THE POLICY MUTATION SERVICE: validated, honourable, concurrency-safe,
 * transactional with its audit, and side-effect free.
 *
 *   npx tsx lib/platform/policies/mutate.test.ts
 *
 * No live database. A small in-memory Prisma stand-in implements exactly the
 * calls the service makes — findUnique / create (P2002 on a duplicate key) /
 * updateMany / deleteMany predicated on updatedAt, auditLog.create, and an
 * INTERACTIVE $transaction that commits on success and DISCARDS every write on a
 * throw. That last property is what lets the transactional contract be proven
 * rather than promised.
 */

import { readFileSync } from "node:fs";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { attemptPeriodHours } from "@/lib/jobs/cadence";
import { classifyJobHealth } from "@/lib/jobs/health";
import { deriveSpaceDataHealth } from "@/lib/connections/space-data-health.core";
import { AuditAction } from "@/lib/audit-actions";
import { resolveRefreshPolicy } from "@/lib/platform/refresh-policy.core";
import { EDITABLE_POLICIES, isEditableSourceKind, resetRefreshCadence, updateRefreshCadence } from "./mutate";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── The in-memory database ────────────────────────────────────────────────────

interface Row { key: string; value: string; updatedAt: Date; updatedById: string | null }
interface Audit { userId?: string; action: string; performedByAdminId?: string; metadata: Record<string, unknown> }

interface Faults {
  auditFails?: boolean;
  settingWriteFails?: boolean;
  /** Runs inside the transaction, right after the first read — simulates a concurrent writer. */
  interleave?: (state: State) => void;
}

interface State { settings: Map<string, Row>; audits: Audit[]; jobRuns: { jobName: string; startedAt: Date; summary: unknown }[]; clock: number }

function makeDb(initial: Partial<State> = {}, faults: Faults = {}) {
  const state: State = { settings: new Map(), audits: [], jobRuns: [], clock: Date.parse("2026-09-14T12:00:00.000Z"), ...initial };
  // The clock lives OUTSIDE the transactional snapshot: a committed write's
  // updatedAt is a fact the world keeps, so a later write must get a later instant.
  let clock = state.clock;
  const tick = () => new Date((clock += 1000));
  // A concurrent writer commits to the shared world AND becomes visible to the
  // in-flight transaction's later statements (READ COMMITTED).
  let pendingInterleave = faults.interleave;
  const interleaveInto = (draft: State) => {
    if (!pendingInterleave) return;
    const f = pendingInterleave; pendingInterleave = undefined;
    f(state); f(draft);
  };

  const clientOver = (st: State, inTx: boolean) => ({
    platformSetting: {
      findMany: async (args: { where: { key: { in: string[] } } }) =>
        [...st.settings.values()].filter((r) => args.where.key.in.includes(r.key)).map((r) => ({ ...r })),
      findUnique: async (args: { where: { key: string } }) => {
        const r = st.settings.get(args.where.key);
        if (inTx) interleaveInto(st);
        return r ? { ...r } : null;
      },
      create: async (args: { data: { key: string; value: string; updatedById: string } }) => {
        if (faults.settingWriteFails) throw new Error("simulated setting write failure");
        if (st.settings.has(args.data.key)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        const row = { ...args.data, updatedAt: tick() };
        st.settings.set(row.key, row);
        return row;
      },
      updateMany: async (args: { where: { key: string; updatedAt: Date }; data: { value: string; updatedById: string } }) => {
        if (faults.settingWriteFails) throw new Error("simulated setting write failure");
        const r = st.settings.get(args.where.key);
        if (!r || r.updatedAt.getTime() !== args.where.updatedAt.getTime()) return { count: 0 };
        st.settings.set(r.key, { ...r, ...args.data, updatedAt: tick() });
        return { count: 1 };
      },
      deleteMany: async (args: { where: { key: string; updatedAt: Date } }) => {
        const r = st.settings.get(args.where.key);
        if (!r || r.updatedAt.getTime() !== args.where.updatedAt.getTime()) return { count: 0 };
        st.settings.delete(r.key);
        return { count: 1 };
      },
    },
    auditLog: {
      create: async (args: { data: Audit }) => {
        if (faults.auditFails) throw new Error("simulated audit failure");
        st.audits.push(args.data);
        return args.data;
      },
    },
    user: { findMany: async () => [{ id: "op_1", name: "Operator One" }] },
    jobRun: {
      findFirst: async (args: { where: { jobName: { in: string[] } } }) =>
        st.jobRuns.find((r) => args.where.jobName.in.includes(r.jobName)) ?? null,
    },
  });

  const root = {
    ...clientOver(state, false),
    async $transaction<T>(fn: (tx: ReturnType<typeof clientOver>) => Promise<T>): Promise<T> {
      // Snapshot-and-commit: writes go to a copy; a throw discards the copy.
      const draft: State = { settings: new Map([...state.settings].map(([k, v]) => [k, { ...v }])), audits: [...state.audits], jobRuns: state.jobRuns, clock };
      const result = await fn(clientOver(draft, true));
      state.settings = draft.settings; state.audits = draft.audits;
      return result;
    },
  };
  return { db: root as never, state };
}

const ACTOR = { id: "op_1", ipAddress: "127.0.0.1", userAgent: "test" };
const WKEY = EDITABLE_POLICIES.WALLET;
const walletView = (m: { policies: { sourceKind: string }[] }) => m.policies.find((p) => p.sourceKind === "WALLET") as never as import("./refresh-policies.core").RefreshPolicyView;

async function main(): Promise<void> {
  console.log("1. update: default 6h → 12h creates the override, audits, returns the canonical model");
  {
    const { db, state } = makeDb();
    const before = resolveRefreshPolicy({ sourceKind: "WALLET" }, null).version;
    const r = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, db);
    check("ok", r.ok);
    if (!r.ok) return;
    const row = state.settings.get(WKEY)!;
    check("row created with the normalised value and the actor", row.value === "12h" && row.updatedById === "op_1");
    const w = walletView(r.model);
    check("origin SETTING, effective 12h, grace 3h, overdue 15h",
      w.effective.origin === "SETTING" && w.effective.cadence === "12h" && w.effective.graceHours === 3 && w.effective.overdueAfterHours === 15);
    check("policy version changed", w.effective.version !== before && w.effective.version === resolveRefreshPolicy({ sourceKind: "WALLET" }, row).version);
    check("desired carries the new version token and the writer's name", w.desired.updatedAt === row.updatedAt.toISOString() && w.desired.updatedBy?.name === "Operator One");
    check("scheduler remains capable (12h honoured)", w.capability.effectiveHonoured);
    check("actual is UNKNOWN — no sweep evidence; never CURRENT because the write succeeded", w.actual.state === "UNKNOWN");
    const a = state.audits[0];
    check("exactly one audit row, canonical action, operator attributed",
      state.audits.length === 1 && a.action === AuditAction.PLATFORM_POLICY_CHANGED && a.performedByAdminId === "op_1" && a.userId === "op_1");
    const meta = a.metadata as { previous: Record<string, unknown>; next: Record<string, unknown>; key: string; result: string; target: { id: string } };
    check("audit metadata: key, previous (absent/DEFAULT/6h/8h) → next (12h/SETTING/15h) with the new updatedAt",
      meta.key === WKEY && meta.result === "SUCCESS" && meta.target.id === WKEY
        && meta.previous.raw === null && meta.previous.origin === "DEFAULT" && meta.previous.cadence === "6h" && meta.previous.overdueAfterHours === 8
        && meta.next.raw === "12h" && meta.next.origin === "SETTING" && meta.next.overdueAfterHours === 15 && meta.next.updatedAt === row.updatedAt.toISOString());
    check("no secret-shaped or financial content in the audit row", !/token|secret|balance|@/i.test(JSON.stringify(a)));
  }

  console.log("\n2. reset: 12h override → row deleted, DEFAULT in force, reset audited");
  {
    const { db, state } = makeDb();
    const up = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, db);
    const token = up.ok ? walletView(up.model).desired.updatedAt! : "";
    const r = await resetRefreshCadence({ sourceKind: "WALLET", expectedUpdatedAt: token, actor: ACTOR }, db);
    check("ok", r.ok);
    if (!r.ok) return;
    const w = walletView(r.model);
    check("row deleted; effective 6h; origin DEFAULT; overdue 8h", !state.settings.has(WKEY) && w.effective.cadence === "6h" && w.effective.origin === "DEFAULT" && w.effective.overdueAfterHours === 8);
    check("version is the default version again", w.effective.version === resolveRefreshPolicy({ sourceKind: "WALLET" }, null).version);
    const a = state.audits[1];
    const meta = a.metadata as { previous: Record<string, unknown>; next: Record<string, unknown> };
    check("reset audited: previous override 12h/SETTING → next DEFAULT/6h with no row",
      a.action === AuditAction.PLATFORM_POLICY_RESET && meta.previous.raw === "12h" && meta.previous.origin === "SETTING"
        && meta.next.raw === null && meta.next.origin === "DEFAULT" && meta.next.cadence === "6h" && meta.next.updatedAt === null);
    check("desired: no override, no token", !w.desired.present && w.desired.updatedAt === null);
  }

  console.log("\n3. unsupported values are refused by the scheduler-capability rule — nothing written, nothing audited");
  {
    const cases: [ "BANK" | "WALLET", string ][] = [["WALLET", "4h"], ["WALLET", "8h"], ["BANK", "4h"], ["BANK", "6h"], ["BANK", "8h"], ["BANK", "12h"]];
    for (const [kind, cadence] of cases) {
      const { db, state } = makeDb();
      const r = await updateRefreshCadence({ sourceKind: kind, cadence, expectedUpdatedAt: null, actor: ACTOR }, db);
      check(`${kind} ${cadence}: VALIDATION refusal with the scheduler's reason; no row; no audit`,
        !r.ok && r.code === "VALIDATION" && /every \d+ hours|would be \d+ hours/.test(r.reason) && state.settings.size === 0 && state.audits.length === 0, r.ok ? "accepted" : r.reason);
    }
    const { db, state } = makeDb();
    const garbage = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "soon", expectedUpdatedAt: null, actor: ACTOR }, db);
    check("a value outside the menu is refused by the descriptor", !garbage.ok && garbage.code === "VALIDATION" && state.settings.size === 0);
    const supported = await updateRefreshCadence({ sourceKind: "BANK", cadence: "24h", expectedUpdatedAt: null, actor: ACTOR }, db);
    check("BANK 24h (the only honourable bank cadence) is accepted", supported.ok);
  }

  console.log("\n4. invalid legacy row: a CONTROL operator can replace it or reset it, concurrency intact");
  {
    const legacy = (): Partial<State> => ({ settings: new Map([[WKEY, { key: WKEY, value: "every 5 minutes", updatedAt: new Date("2026-09-01T00:00:00.000Z"), updatedById: null }]]) });
    const a = makeDb(legacy());
    const readA = await (await import("./refresh-policies")).loadRefreshPoliciesReadModel(a.db, new Date());
    const wA = walletView(readA);
    check("the read model shows INVALID_SETTING with the default in force and the row's token", wA.effective.origin === "INVALID_SETTING" && wA.desired.raw === "every 5 minutes" && wA.desired.updatedAt === "2026-09-01T00:00:00.000Z");
    const rep = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "24h", expectedUpdatedAt: wA.desired.updatedAt, actor: ACTOR }, a.db);
    check("A. replaced with a valid honourable value; audit records the invalid previous", rep.ok && a.state.settings.get(WKEY)?.value === "24h"
      && (a.state.audits[0].metadata as { previous: { origin: string; raw: string } }).previous.origin === "INVALID_SETTING");
    const b = makeDb(legacy());
    const rst = await resetRefreshCadence({ sourceKind: "WALLET", expectedUpdatedAt: "2026-09-01T00:00:00.000Z", actor: ACTOR }, b.db);
    check("B. reset removes the invalid row; audit records INVALID_SETTING → DEFAULT", rst.ok && !b.state.settings.has(WKEY)
      && (b.state.audits[0].metadata as { previous: { origin: string }; next: { origin: string } }).previous.origin === "INVALID_SETTING");
    const c = makeDb(legacy());
    const stale = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "24h", expectedUpdatedAt: "2026-08-01T00:00:00.000Z", actor: ACTOR }, c.db);
    check("a stale token against the invalid row still conflicts", !stale.ok && stale.code === "CONFLICT" && c.state.settings.get(WKEY)?.value === "every 5 minutes");
  }

  console.log("\n5. update conflict: A read X, B changed it, A submits X");
  {
    const { db, state } = makeDb();
    const first = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, db);
    const tokenX = first.ok ? walletView(first.model).desired.updatedAt! : "";
    const b = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "24h", expectedUpdatedAt: tokenX, actor: { id: "op_2" } }, db);
    check("B's change applied", b.ok && state.settings.get(WKEY)?.value === "24h");
    const auditsBefore = state.audits.length;
    const a = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "6h", expectedUpdatedAt: tokenX, actor: ACTOR }, db);
    check("A conflicts; B's value preserved; no audit for A; A receives the canonical current state",
      !a.ok && a.code === "CONFLICT" && state.settings.get(WKEY)?.value === "24h" && state.audits.length === auditsBefore
        && walletView(a.model).effective.cadence === "24h");
  }

  console.log("\n6. create conflict: both observed no override");
  {
    const { db, state } = makeDb();
    const one = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, db);
    const two = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "24h", expectedUpdatedAt: null, actor: { id: "op_2" } }, db);
    check("the first wins; the second conflicts (a row now exists); no silent last-write-wins",
      one.ok && !two.ok && two.code === "CONFLICT" && state.settings.get(WKEY)?.value === "12h" && state.audits.length === 1);
    // The tighter race: both pass the read, one create lands first inside the transaction.
    const raced = makeDb({}, { interleave: (st) => st.settings.set(WKEY, { key: WKEY, value: "24h", updatedAt: new Date("2026-09-14T12:30:00.000Z"), updatedById: "op_2" }) });
    const r = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, raced.db);
    check("a row appearing between the read and the create is a P2002 ⇒ CONFLICT, the other row preserved",
      !r.ok && r.code === "CONFLICT" && raced.state.settings.get(WKEY)?.value === "24h" && raced.state.audits.length === 0);
  }

  console.log("\n7. reset conflict: A read X, B changed it, A resets X");
  {
    const { db, state } = makeDb();
    const first = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, db);
    const tokenX = first.ok ? walletView(first.model).desired.updatedAt! : "";
    await updateRefreshCadence({ sourceKind: "WALLET", cadence: "24h", expectedUpdatedAt: tokenX, actor: { id: "op_2" } }, db);
    const auditsBefore = state.audits.length;
    const r = await resetRefreshCadence({ sourceKind: "WALLET", expectedUpdatedAt: tokenX, actor: ACTOR }, db);
    check("A's reset conflicts; B's override (24h) preserved; no reset audit",
      !r.ok && r.code === "CONFLICT" && state.settings.get(WKEY)?.value === "24h" && state.audits.length === auditsBefore);
    const gone = await resetRefreshCadence({ sourceKind: "WALLET", expectedUpdatedAt: tokenX, actor: ACTOR }, makeDb().db);
    check("resetting when no override exists is a conflict, not a silent no-op", !gone.ok && gone.code === "CONFLICT");
    // The tighter race for reset: the row moves between the read and the delete.
    const seeded = makeDb();
    const up = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, seeded.db);
    const tok = up.ok ? walletView(up.model).desired.updatedAt! : "";
    const moved = makeDb({ settings: new Map(seeded.state.settings) }, { interleave: (st) => st.settings.set(WKEY, { ...st.settings.get(WKEY)!, value: "24h", updatedAt: new Date("2026-09-14T13:00:00.000Z") }) });
    const late = await resetRefreshCadence({ sourceKind: "WALLET", expectedUpdatedAt: tok, actor: ACTOR }, moved.db);
    check("a row that moves between the read and the delete is refused (0 rows deleted ⇒ CONFLICT)", !late.ok && late.code === "CONFLICT" && moved.state.settings.get(WKEY)?.value === "24h");
  }

  console.log("\n8. transactional audit: setting and audit commit together or not at all");
  {
    const a = makeDb({}, { auditFails: true });
    const r1 = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, a.db).catch((e) => e as Error);
    check("audit failure ⇒ the setting write is rolled back and the error surfaces",
      r1 instanceof Error && !a.state.settings.has(WKEY) && a.state.audits.length === 0);
    const b = makeDb({}, { settingWriteFails: true });
    const r2 = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, b.db).catch((e) => e as Error);
    check("setting failure ⇒ no success audit row", r2 instanceof Error && b.state.audits.length === 0 && !b.state.settings.has(WKEY));
    const c = makeDb();
    await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, c.db);
    const tok = c.state.settings.get(WKEY)!.updatedAt.toISOString();
    const d = makeDb({ settings: new Map(c.state.settings) }, { auditFails: true });
    const r3 = await resetRefreshCadence({ sourceKind: "WALLET", expectedUpdatedAt: tok, actor: ACTOR }, d.db).catch((e) => e as Error);
    check("reset: audit failure ⇒ the row is NOT deleted", r3 instanceof Error && d.state.settings.get(WKEY)?.value === "12h" && d.state.audits.length === 0);
    const src = readFileSync("lib/platform/policies/mutate.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    check("the service writes the setting and the audit inside ONE $transaction callback",
      (src.match(/\$transaction\(async/g) ?? []).length === 2 && !/db\.auditLog|db\.platformSetting/.test(src));
  }

  console.log("\n9. the closed contract and the absence of side effects");
  {
    check("only BANK and WALLET are editable", Object.keys(EDITABLE_POLICIES).sort().join() === "BANK,WALLET" && EDITABLE_POLICIES.WALLET === "refresh_cadence_wallet");
    check("isEditableSourceKind refuses every other name", !isEditableSourceKind("maintenance_mode") && !isEditableSourceKind("ingestion_paused") && !isEditableSourceKind("product_status") && isEditableSourceKind("BANK"));
    const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    const svc = code("lib/platform/policies/mutate.ts");
    const route = code("app/api/platform/platform-ops/policies/route.ts");
    check("the service and route import no provider, sync, job runner or AI module",
      !/plaid|rpc|openai|generate|syncWallet|syncBanks|runJob|refreshScheduledWallets|fetch\(/i.test(svc) && !/plaid|rpc|openai|syncWallet|syncBanks|runJob/i.test(route));
    check("the route names no setting key — the body is a source kind", !/refresh_cadence|maintenance_mode|ingestion_paused|PlatformSettingKey/.test(route));
    check("the route's mutating handlers require FRESH CONTROL; GET stays READ",
      (route.match(/requireFreshPlatformAccess\("PLATFORM_OPS", "CONTROL"\)/g) ?? []).length === 2 && /requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(route)
        && /export async function PATCH/.test(route) && /export async function DELETE/.test(route) && !/export async function (POST|PUT)/.test(route));
    check("the route touches no table directly", !/db\.|platformSetting|auditLog/.test(route));
    check("the service writes through the settings authority's conditional primitives only",
      /createSettingIfAbsent\(/.test(svc) && /updateSettingIfVersion\(/.test(svc) && /deleteSettingIfVersion\(/.test(svc) && !/platformSetting\.(create|update|upsert|delete)/.test(svc));
  }

  console.log("\n10. cross-surface: after 6h → 12h every consumer resolves the same policy; actual stays actual");
  {
    const { db, state } = makeDb();
    const r = await updateRefreshCadence({ sourceKind: "WALLET", cadence: "12h", expectedUpdatedAt: null, actor: ACTOR }, db);
    check("applied", r.ok);
    const row = state.settings.get(WKEY)!;
    const policies = { BANK: resolveRefreshPolicy({ sourceKind: "BANK" }, null), WALLET: resolveRefreshPolicy({ sourceKind: "WALLET" }, row) };
    const NOW = new Date(state.clock + 3_600_000);
    const hours = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    const health = (h: number) => deriveSpaceDataHealth([{
      detailVisible: true, accountName: "A", lastUpdated: hours(h), syncStatus: "synced", plaid: null,
      wallet: { key: "k", ownerUserId: "v", status: "ACTIVE", errorCode: null, lastSyncedAt: hours(h), discoveryCursor: false },
    }], "v", NOW, policies).sources[0].state;
    check("source health (Brief + Connections authority): 14h-old wallet CURRENT, 16h-old OUT_OF_DATE under 12h", health(14) === "CURRENT" && health(16) === "OUT_OF_DATE");
    const crypto = SCHEDULED_JOBS.find((j) => j.name === "sync-crypto")!;
    const jh = classifyJobHealth(crypto, [{ startedAt: hours(1), status: "succeeded" }], NOW, { policy: policies.WALLET, attemptPeriodHours: attemptPeriodHours(SCHEDULED_JOBS, "WALLET") });
    check("job source block reflects 12h while the job's own expectation stays the 6h slot",
      jh.source?.policyExpectedEveryHours === 12 && jh.source.policyHonoured && jh.expectedEveryHours === 6);
    const w = r.ok ? walletView(r.model) : null;
    check("Policies read model: effective 12h, overdue 15h, capable", w?.effective.cadence === "12h" && w.effective.overdueAfterHours === 15 && w.capability.effectiveHonoured);

    // Actual remains actual: a sweep stamped with the OLD version ⇒ PENDING; with the NEW version ⇒ CURRENT.
    const oldStamp = makeDb({ settings: new Map(state.settings), jobRuns: [{ jobName: "sync-crypto", startedAt: hours(2), summary: { policy: { version: resolveRefreshPolicy({ sourceKind: "WALLET" }, null).version } } }] });
    const pend = walletView(await (await import("./refresh-policies")).loadRefreshPoliciesReadModel(oldStamp.db, NOW));
    check("before a sweep under the new policy: PENDING, not CURRENT", pend.actual.state === "PENDING");
    const newStamp = makeDb({ settings: new Map(state.settings), jobRuns: [{ jobName: "sync-crypto", startedAt: hours(0.5), summary: { policy: { version: policies.WALLET.version } } }] });
    const cur = walletView(await (await import("./refresh-policies")).loadRefreshPoliciesReadModel(newStamp.db, NOW));
    check("after a completed sweep stamped with the new version: CURRENT", cur.actual.state === "CURRENT");
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
