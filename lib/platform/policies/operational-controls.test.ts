/**
 * lib/platform/policies/operational-controls.test.ts  (PLATFORM OPS — Operational Controls: maintenance mode)
 *
 * The read model resolves the row in the admission module's words (absent =
 * Not configured ≠ "false" = Disabled); ENABLE writes "true", DISABLE writes
 * "false", RESET deletes; every change is ONE setting write + ONE audit row in
 * ONE transaction (actor, before, after, reason, result); a stale version is
 * refused with nothing written and audited REFUSED; no other setting moves;
 * maintenance denies exactly its three work classes and the route never
 * consults admission (no lockout); the route carries the right gates and only
 * CONTROL mutates. No live database: an in-memory Prisma stand-in whose
 * interactive $transaction discards every write on a throw.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/policies/operational-controls.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";
import { REASON_REQUIRED_ACTIONS, type OperatorReason } from "@/lib/audit";
import { AuditAction } from "@/lib/audit-actions";
import { decidePlatformAccess } from "@/lib/platform/authorize";
import { evaluateAdmission, readFactState, workDeniedBy } from "@/lib/platform/admission/policy-core";
import {
  applyMaintenanceChange, flagViewOf, loadOperationalControlsReadModel, validateMaintenanceChange,
  type OperationalControlsClient, type OperationalControlsTx,
} from "./operational-controls";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── The in-memory stand-in ────────────────────────────────────────────────────

interface Row { key: string; value: string; updatedAt: Date; updatedById: string | null }
interface Audit { data: Record<string, unknown> }

function store(initial: Row[] = []) {
  let rows = new Map(initial.map((r) => [r.key, { ...r }]));
  let audits: Audit[] = [];
  let tick = Date.parse("2026-10-24T20:00:00.000Z");
  const nextTime = () => new Date(tick += 1000);

  const settingApi = (m: Map<string, Row>) => ({
    async findMany(args: { where: { key: { in: string[] } } }) { return [...m.values()].filter((r) => args.where.key.in.includes(r.key)).map((r) => ({ ...r })); },
    async findUnique(args: { where: { key: string } }) { const r = m.get(args.where.key); return r ? { value: r.value, updatedAt: r.updatedAt } : null; },
    async create(args: { data: { key: string; value: string; updatedById: string } }) {
      if (m.has(args.data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
      m.set(args.data.key, { ...args.data, updatedAt: nextTime() });
      return {};
    },
    async updateMany(args: { where: { key: string; updatedAt: Date }; data: { value: string; updatedById: string } }) {
      const r = m.get(args.where.key);
      if (!r || r.updatedAt.getTime() !== args.where.updatedAt.getTime()) return { count: 0 };
      m.set(r.key, { ...r, ...args.data, updatedAt: nextTime() });
      return { count: 1 };
    },
    async deleteMany(args: { where: { key: string; updatedAt: Date } }) {
      const r = m.get(args.where.key);
      if (!r || r.updatedAt.getTime() !== args.where.updatedAt.getTime()) return { count: 0 };
      m.delete(r.key);
      return { count: 1 };
    },
    async count(args: { where: { key: string } }) { return m.has(args.where.key) ? 1 : 0; },
  });

  const client = {
    platformSetting: settingApi(rows),
    user: { async findMany() { return [{ id: "op1", name: "Ops Person" }]; } },
    auditLog: { async create(args: Audit) { audits.push(args); return {}; } },
    async $transaction<T>(fn: (tx: OperationalControlsTx) => Promise<T>): Promise<T> {
      const staged = new Map([...rows].map(([k, v]) => [k, { ...v }]));
      const stagedAudits: Audit[] = [];
      const tx = { platformSetting: settingApi(staged), auditLog: { async create(a: Audit) { stagedAudits.push(a); return {}; } } };
      const out = await fn(tx as unknown as OperationalControlsTx);
      rows = staged; audits = [...audits, ...stagedAudits];
      client.platformSetting = settingApi(rows);
      return out;
    },
  };
  return {
    client: client as unknown as OperationalControlsClient,
    rows: () => rows,
    audits: () => audits,
    /** Another operator's write landing between read and save. */
    bump(key: string, value: string) { const r = rows.get(key); rows.set(key, { key, value, updatedAt: nextTime(), updatedById: "op2", ...(r ? {} : {}) }); },
  };
}

const T0 = new Date("2026-10-22T20:57:52.282Z");
const KILL = { key: "ai_paid_requests_paused", value: "false", updatedAt: T0, updatedById: "op1" };
const REASON: OperatorReason = { code: "TESTING", note: "Preview validation of maintenance gate" };
const ACTOR = { id: "op1", ipAddress: "203.0.113.9", userAgent: "test" };
const iso = (d: Date) => d.toISOString();

async function main() {
  console.log("read model");
  {
    const s = store([KILL]);
    const m = await loadOperationalControlsReadModel(s.client, "preview");
    check("absent row ⇒ MISSING (Not configured), no version", m.maintenance.state === "MISSING" && m.maintenance.updatedAt === null);
    check("environment is carried so Preview/Production cannot be confused", m.environment === "preview");
    check("blocks = the policy's own maintenance work classes", JSON.stringify(m.maintenance.blocks) === JSON.stringify(workDeniedBy("maintenanceMode")));
    check("kill switch and ingestion pause are read-only neighbours", m.related.aiKillSwitch.state === "OFF" && m.related.ingestionPaused.state === "MISSING");
    check("\"false\" ⇒ OFF (Disabled), distinct from MISSING", flagViewOf("maintenance_mode", { ...KILL, key: "maintenance_mode" }, null).state === "OFF");
    const bad = flagViewOf("maintenance_mode", { ...KILL, key: "maintenance_mode", value: "yes" }, null);
    check("garbage ⇒ INVALID with the raw value shown", bad.state === "INVALID" && bad.invalidRaw === "yes");
    check("the state words are the admission reader's", readFactState("maintenance_mode", "true").state === "ON");
  }

  console.log("validation");
  check("unknown action refused", !validateMaintenanceChange({ action: "PURGE", expectedUpdatedAt: null }).ok);
  check("a setting key is not an action", !validateMaintenanceChange({ action: "maintenance_mode", expectedUpdatedAt: null }).ok);
  check("bad version refused", !validateMaintenanceChange({ action: "ENABLE", expectedUpdatedAt: "yesterday" }).ok);
  check("closed body accepted", validateMaintenanceChange({ action: "ENABLE", expectedUpdatedAt: null }).ok);

  console.log("enable → disable → reset");
  {
    const s = store([KILL]);
    const en = await applyMaintenanceChange({ change: { action: "ENABLE", expectedUpdatedAt: null }, reason: REASON, actor: ACTOR }, s.client, "preview");
    const row = s.rows().get("maintenance_mode");
    check("ENABLE persists \"true\" with the actor as writer", en.ok && row?.value === "true" && row.updatedById === "op1");
    check("the returned model reads Enabled", en.ok && en.model.maintenance.state === "ON" && en.model.maintenance.updatedBy === "Ops Person");
    const a = s.audits()[0]?.data as Record<string, unknown> | undefined;
    const meta = (a?.metadata ?? {}) as Record<string, unknown>;
    const metaText = JSON.stringify(meta);
    check("ONE audit row, PLATFORM_POLICY_CHANGED, actor recorded", s.audits().length === 1 && a?.action === AuditAction.PLATFORM_POLICY_CHANGED && a?.performedByAdminId === "op1");
    check("audit carries before/after, reason, result and environment", /"before":\{"value":null,"state":"MISSING"\}/.test(metaText) && /"after":\{"value":"true","state":"ON"\}/.test(metaText)
      && /TESTING/.test(metaText) && /Preview validation/.test(metaText) && /SUCCESS/.test(metaText) && /"environment":"preview"/.test(metaText), metaText);
    check("the kill switch row is untouched", s.rows().get("ai_paid_requests_paused")?.value === "false" && s.rows().get("ai_paid_requests_paused")?.updatedAt.getTime() === T0.getTime());

    const v1 = iso(s.rows().get("maintenance_mode")!.updatedAt);
    const dis = await applyMaintenanceChange({ change: { action: "DISABLE", expectedUpdatedAt: v1 }, reason: REASON, actor: ACTOR }, s.client, "preview");
    check("DISABLE persists an explicit \"false\" row (not a delete)", dis.ok && s.rows().get("maintenance_mode")?.value === "false" && dis.model.maintenance.state === "OFF");

    const v2 = iso(s.rows().get("maintenance_mode")!.updatedAt);
    const rs = await applyMaintenanceChange({ change: { action: "RESET", expectedUpdatedAt: v2 }, reason: REASON, actor: ACTOR }, s.client, "preview");
    check("RESET deletes the row ⇒ Not configured", rs.ok && !s.rows().has("maintenance_mode") && rs.model.maintenance.state === "MISSING");
    check("RESET audits PLATFORM_POLICY_RESET", (s.audits()[2]?.data as Record<string, unknown>)?.action === AuditAction.PLATFORM_POLICY_RESET);
    check("three changes ⇒ three audit rows; only maintenance_mode ever moved", s.audits().length === 3 && [...s.rows().keys()].join() === "ai_paid_requests_paused");
  }

  console.log("concurrency — never overwrite another operator");
  {
    const s = store([KILL]);
    await applyMaintenanceChange({ change: { action: "ENABLE", expectedUpdatedAt: null }, reason: REASON, actor: ACTOR }, s.client, "preview");
    const seen = iso(s.rows().get("maintenance_mode")!.updatedAt);
    s.bump("maintenance_mode", "false"); // op2 disabled it meanwhile
    const before = s.audits().length;
    const r = await applyMaintenanceChange({ change: { action: "ENABLE", expectedUpdatedAt: seen }, reason: REASON, actor: ACTOR }, s.client, "preview");
    check("stale version ⇒ CONFLICT", !r.ok && r.code === "CONFLICT");
    check("nothing written: op2's \"false\" stands", s.rows().get("maintenance_mode")?.value === "false" && s.rows().get("maintenance_mode")?.updatedById === "op2");
    check("the refusal returns the CURRENT model", !r.ok && r.model.maintenance.state === "OFF");
    const refused = s.audits()[before]?.data as Record<string, unknown> | undefined;
    check("the refused attempt is audited REFUSED (outside the rolled-back tx)", s.audits().length === before + 1 && /REFUSED/.test(JSON.stringify(refused?.metadata)));

    const s2 = store([KILL]);
    const ghost = await applyMaintenanceChange({ change: { action: "ENABLE", expectedUpdatedAt: iso(T0) }, reason: REASON, actor: ACTOR }, s2.client, "preview");
    check("claiming a row that does not exist ⇒ CONFLICT, nothing created", !ghost.ok && ghost.code === "CONFLICT" && !s2.rows().has("maintenance_mode"));
    const s3 = store([KILL]);
    const raced = store([KILL]);
    raced.bump("maintenance_mode", "true");
    const lost = await applyMaintenanceChange({ change: { action: "ENABLE", expectedUpdatedAt: null }, reason: REASON, actor: ACTOR }, raced.client, "preview");
    check("\"I saw no row\" but one appeared ⇒ CONFLICT", !lost.ok && lost.code === "CONFLICT" && raced.rows().get("maintenance_mode")?.updatedById === "op2");
    const nf = await applyMaintenanceChange({ change: { action: "RESET", expectedUpdatedAt: null }, reason: REASON, actor: ACTOR }, s3.client, "preview");
    check("RESET with no row ⇒ NOT_FOUND", !nf.ok && nf.code === "NOT_FOUND");
  }

  console.log("reason");
  {
    const s = store([KILL]);
    const r = await applyMaintenanceChange({ change: { action: "ENABLE", expectedUpdatedAt: null }, reason: { code: "TESTING" }, actor: ACTOR }, s.client, "preview");
    check("a reason note is required — nothing written, no audit", !r.ok && r.code === "VALIDATION" && !s.rows().has("maintenance_mode") && s.audits().length === 0);
    check("the actions are reason-required in the audit chokepoint", REASON_REQUIRED_ACTIONS.has(AuditAction.PLATFORM_POLICY_CHANGED) && REASON_REQUIRED_ACTIONS.has(AuditAction.PLATFORM_POLICY_RESET));
  }

  console.log("no lockout — maintenance denies exactly its three work classes");
  {
    check("maintenance denies REFRESH_EXECUTION, CONNECTION_ESTABLISHMENT, PAID_AI_REQUEST — nothing else",
      [...workDeniedBy("maintenanceMode")].sort().join() === "CONNECTION_ESTABLISHMENT,PAID_AI_REQUEST,REFRESH_EXECUTION");
    const on = { maintenanceMode: readFactState("maintenance_mode", "true"), ingestionPaused: readFactState("ingestion_paused", null) };
    check("the policy denies paid AI under maintenance", evaluateAdmission({ work: "PAID_AI_REQUEST" }, on).decision === "DENY");
    const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const route = strip("app/api/platform/platform-ops/operational-controls/route.ts");
    const svc = strip("lib/platform/policies/operational-controls.ts");
    check("the route and service never consult admission (the way out can't be blocked by maintenance)",
      !/admitOperationalWork|readPaidRequestsAdmission|evaluateAdmission/.test(route + svc));
    for (const f of ["lib/session.ts", "lib/platform/authorize.ts", "app/api/health/route.ts"]) {
      let src = "";
      try { src = strip(f); } catch { continue; }
      check(`${f} never consults admission`, !/admitOperationalWork|readPaidRequestsAdmission|maintenance_mode|MAINTENANCE_MODE/.test(src));
    }

    console.log("route gates");
    check("GET reads at PLATFORM_OPS READ", /export async function GET\(\)[\s\S]*?requirePlatformAccess\("PLATFORM_OPS", "READ"\)[\s\S]*?if \(err\) return err/.test(route));
    check("PATCH mutates only under FRESH CONTROL, error returned first",
      /export async function PATCH[\s\S]*?requireFreshPlatformAccess\("PLATFORM_OPS", "CONTROL"\);\s*if \(err\) return err;/.test(route) && !/requirePlatformAccess\([^)]*"CONTROL"/.test(route));
    check("PATCH requires a structured reason and is paced on its own bucket", /parseOperatorReason\(/.test(route) && /"platform-policy-operational-controls"/.test(route) && /limitByUser\(auth\.user\.id, bucket,/.test(route));
    check("the cost freeze toggle is paced on its OWN bucket (follow-up N6)", /body\.control === "COST_FREEZE"\s*\?\s*"platform-policy-cost-freeze"/.test(route));
    check("a coarse flood limiter runs AFTER the fresh grant check and BEFORE the body is parsed (follow-up P3-5)",
      route.indexOf('requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL")') < route.indexOf('"platform-policy-operational-controls-any"')
        && route.indexOf('"platform-policy-operational-controls-any"') < route.indexOf("await req.json()"));
    check("the route never touches PlatformSetting or AuditLog itself", !/platformSetting|auditLog|setSetting/.test(route));
    check("the route exports no other mutating verb", !/export async function (POST|PUT|DELETE)/.test(route));
    check("only CONTROL (or break-glass) passes the mutation gate",
      decidePlatformAccess(UserRole.USER, "PLATFORM_OPS", "CONTROL", [{ area: "PLATFORM_OPS", level: "CONTROL", status: "ACTIVE" }])
      && !decidePlatformAccess(UserRole.USER, "PLATFORM_OPS", "CONTROL", [{ area: "PLATFORM_OPS", level: "WRITE", status: "ACTIVE" }])
      && !decidePlatformAccess(UserRole.USER, "PLATFORM_OPS", "CONTROL", [{ area: "PLATFORM_OPS", level: "READ", status: "ACTIVE" }])
      && !decidePlatformAccess(UserRole.USER, "PLATFORM_OPS", "CONTROL", [{ area: "PLATFORM_OPS", level: "CONTROL", status: "REVOKED" }])
      && !decidePlatformAccess(UserRole.USER, "PLATFORM_OPS", "CONTROL", [{ area: "SECURITY_OPS", level: "CONTROL", status: "ACTIVE" }])
      && !decidePlatformAccess(UserRole.USER, "PLATFORM_OPS", "CONTROL", []));
    check("READ holders can read", decidePlatformAccess(UserRole.USER, "PLATFORM_OPS", "READ", [{ area: "PLATFORM_OPS", level: "READ", status: "ACTIVE" }]));
    check("no Space-administration axis anywhere on this path", !/requireSpace|SpaceMember|\bcan\(/.test(route + svc));
    check("no financial table is reachable from the service", !/\b(account|transaction|plaidItem|spaceMember|balanceSnapshot)\b\s*[.:]/i.test(svc));
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
