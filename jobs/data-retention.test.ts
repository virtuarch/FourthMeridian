/**
 * jobs/data-retention.test.ts  (PRIV-003 · DB-001 · PRIV-012)
 *
 * The retention schedule over a FAKE CLOCK and an in-memory client that
 * evaluates each rule's where-clause on real rows. Standalone tsx:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/data-retention.test.ts
 */

import { readFileSync } from "node:fs";
import {
  runDataRetention, retentionCutoffFor, RETENTION_RULES, RETENTION_BATCH, RETENTION_MAX_BATCHES,
  type RetentionClient, type RetentionTable,
} from "@/jobs/data-retention";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-10-22T07:30:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

// ── A where-clause evaluator covering the operators the rules use ────────────
type Row = Record<string, unknown> & { id: string };
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "AND") return (cond as Record<string, unknown>[]).every((w) => matches(row, w));
    if (k === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond === null) return v === null || v === undefined;
    if (typeof cond !== "object" || cond instanceof Date) return v === cond;
    const c = cond as { lt?: Date; not?: unknown; in?: unknown[]; none?: Record<string, unknown> };
    // A to-many relation filter (`items: { none: … }`): the row carries its children as an array.
    if (c.none) return !(Array.isArray(v) && (v as Row[]).some((child) => matches(child, c.none!)));
    if (c.in && !c.in.includes(v)) return false;
    if ("not" in c && (c.not === null ? (v === null || v === undefined) : v === c.not)) return false;
    if (c.lt && !(v instanceof Date && v.getTime() < c.lt.getTime())) return false;
    return true;
  });
}

function makeClient(tables: Partial<Record<RetentionTable, Row[]>>, opts: { failOn?: RetentionTable } = {}) {
  const data = Object.fromEntries(RETENTION_RULES.map((r) => [r.table, [...(tables[r.table] ?? [])]])) as Record<RetentionTable, Row[]>;
  const calls: Array<{ table: string; op: string; where: Record<string, unknown> }> = [];
  const client = Object.fromEntries(RETENTION_RULES.map((r) => [r.table, {
    async findMany({ where, take }: { where: Record<string, unknown>; take: number }) {
      if (opts.failOn === r.table) throw new Error("boom");
      calls.push({ table: r.table, op: "find", where });
      return data[r.table].filter((row) => matches(row, where)).slice(0, take).map((row) => ({ id: row.id }));
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      calls.push({ table: r.table, op: "delete", where });
      const before = data[r.table].length;
      data[r.table] = data[r.table].filter((row) => !matches(row, where));
      return { count: before - data[r.table].length };
    },
  }])) as unknown as RetentionClient;
  return { client, data, calls };
}

const quiet = <T,>(fn: () => Promise<T>) => {
  const o = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  return fn().finally(() => Object.assign(console, o));
};

async function main() {
  console.log("the schedule");
  {
    const days = Object.fromEntries(RETENTION_RULES.map((r) => [r.table, r.days]));
    check("windows: sessions 30, AI 90, jobs 90, refresh 60, provider calls 60, webhooks 30, sync issues 90, usage 90, waitlist 180, briefs 90, automation runs 90",
      days.userSession === 30 && days.aiInvocation === 90 && days.jobRun === 90 && days.refreshExecution === 60 && days.providerCall === 60
      && days.plaidWebhookEvent === 30 && days.syncIssue === 90 && days.apiUsageCounter === 90 && days.betaAccessRequest === 180
      && days.betaAccessRequestEvent === 180 && days.dailyBrief === 90 && days.automationRun === 90 && days.commsProviderEvent === 90, JSON.stringify(days));
    check("cutoff is exactly N days before now", retentionCutoffFor({ days: 30 }, NOW).getTime() === daysAgo(30).getTime());
  }

  console.log("\nrows past their window go; everything else stays");
  {
    const { client, data } = makeClient({
      userSession: [
        { id: "s-old-revoked", revokedAt: daysAgo(31) }, { id: "s-new-revoked", revokedAt: daysAgo(29) },
        { id: "s-live-old", revokedAt: null, createdAt: daysAgo(400) },
      ],
      aiInvocation: [{ id: "ai-old", occurredAt: daysAgo(91) }, { id: "ai-new", occurredAt: daysAgo(89) }],
      jobRun: [{ id: "j-old", startedAt: daysAgo(91), status: "succeeded" }, { id: "j-old-running", startedAt: daysAgo(91), status: "running" }, { id: "j-new", startedAt: daysAgo(10), status: "failed" }],
      refreshExecution: [{ id: "r-old", startedAt: daysAgo(61) }, { id: "r-new", startedAt: daysAgo(59) }],
      providerCall: [{ id: "p-old", startedAt: daysAgo(61) }],
      plaidWebhookEvent: [{ id: "w-old", receivedAt: daysAgo(31) }, { id: "w-new", receivedAt: daysAgo(1) }],
      syncIssue: [
        { id: "si-resolved-old", resolved: true, resolvedAt: daysAgo(91), updatedAt: daysAgo(91) },
        { id: "si-resolved-legacy", resolved: true, resolvedAt: null, updatedAt: daysAgo(100) },
        { id: "si-open-old", resolved: false, resolvedAt: null, updatedAt: daysAgo(300) },
        { id: "si-resolved-new", resolved: true, resolvedAt: daysAgo(5), updatedAt: daysAgo(5) },
      ],
      apiUsageCounter: [{ id: "u-old", day: daysAgo(91) }, { id: "u-new", day: daysAgo(1) }],
      betaAccessRequest: [
        { id: "b-denied-old", status: "DENIED", decidedAt: daysAgo(181), createdAt: daysAgo(200) },
        { id: "b-denied-new", status: "DENIED", decidedAt: daysAgo(10), createdAt: daysAgo(400) },
        { id: "b-pending-old", status: "PENDING", decidedAt: null, createdAt: daysAgo(181) },
        { id: "b-pending-new", status: "PENDING", decidedAt: null, createdAt: daysAgo(30) },
        { id: "b-approved-expired", status: "APPROVED", inviteExpiresAt: daysAgo(181), createdAt: daysAgo(200) },
        { id: "b-redeemed-old", status: "REDEEMED", decidedAt: daysAgo(400), createdAt: daysAgo(400) },
      ],
      betaAccessRequestEvent: [{ id: "e-old", receivedAt: daysAgo(181) }, { id: "e-new", receivedAt: daysAgo(1) }],
      dailyBrief: [{ id: "d-old", briefDay: daysAgo(91) }, { id: "d-new", briefDay: daysAgo(1) }],
      commsProviderEvent: [{ id: "cpe-old", receivedAt: daysAgo(91) }, { id: "cpe-edge", receivedAt: daysAgo(89) }, { id: "cpe-new", receivedAt: daysAgo(1) }],
    });
    const r = await quiet(() => runDataRetention(client, NOW));
    const left = (t: RetentionTable) => data[t].map((x) => x.id).sort().join();
    check("UserSession: revoked > 30 d deleted; recently revoked and LIVE sessions kept", left("userSession") === "s-live-old,s-new-revoked", left("userSession"));
    check("AiInvocation > 90 d deleted", left("aiInvocation") === "ai-new");
    check("JobRun > 90 d deleted, but never a `running` row", left("jobRun") === "j-new,j-old-running", left("jobRun"));
    check("RefreshExecution > 60 d deleted (children by FK cascade)", left("refreshExecution") === "r-new");
    check("ProviderCall > 60 d deleted", left("providerCall") === "");
    check("PlaidWebhookEvent > 30 d deleted", left("plaidWebhookEvent") === "w-new");
    check("SyncIssue: resolved > 90 d (incl. legacy rows without resolvedAt) deleted; OPEN issues kept at any age", left("syncIssue") === "si-open-old,si-resolved-new", left("syncIssue"));
    check("ApiUsageCounter > 90 d deleted", left("apiUsageCounter") === "u-new");
    check("waitlist: denied/pending/expired-approval > 180 d deleted; recent and REDEEMED kept", left("betaAccessRequest") === "b-denied-new,b-pending-new,b-redeemed-old", left("betaAccessRequest"));
    check("waitlist events > 180 d deleted", left("betaAccessRequestEvent") === "e-new");
    check("DailyBrief > 90 d deleted", left("dailyBrief") === "d-new");
    check("CommsProviderEvent > 90 d deleted (Comms Center C); 89 d and recent kept", left("commsProviderEvent") === "cpe-edge,cpe-new", left("commsProviderEvent"));
    check("totals add up (1+1+1+1+1+1+2+1+3+1+1+1)", r.totalDeleted === 15, `${r.totalDeleted}`);
    check("every table reports exhausted", RETENTION_RULES.every((rule) => r[rule.table].exhausted));
  }

  console.log("\nautomation runs: never one that is RUNNING or holds an item that can still send (PRE-FLIP R5)");
  {
    const run = (id: string, age: number, status: string, itemStatuses: string[]) => ({ id, startedAt: daysAgo(age), status, items: itemStatuses.map((st, i) => ({ id: `${id}-i${i}`, status: st })) });
    const { client, data } = makeClient({ automationRun: [
      run("ar-done", 91, "SUCCEEDED", ["SENT", "SUPPRESSED", "CANCELLED", "DEAD"]),
      run("ar-halted", 91, "HALTED", ["CANCELLED"]),
      run("ar-empty", 91, "SUCCEEDED", []),
      run("ar-running", 91, "RUNNING", ["SENT"]),
      run("ar-scheduled", 91, "SUCCEEDED", ["SENT", "SCHEDULED"]),
      run("ar-sending", 91, "SUCCEEDED", ["SENDING"]),
      run("ar-failed", 91, "SUCCEEDED", ["FAILED"]),
      run("ar-new", 89, "SUCCEEDED", ["SENT"]),
    ] });
    const r = await quiet(() => runDataRetention(client, NOW));
    const left = data.automationRun.map((x) => x.id).sort().join();
    check("finished runs > 90 d whose items are all terminal are deleted; RUNNING, SCHEDULED / SENDING / FAILED holders and a recent run are kept",
      left === "ar-failed,ar-new,ar-running,ar-scheduled,ar-sending" && r.automationRun.deleted === 3, `${left} deleted=${r.automationRun.deleted}`);
    const rule = RETENTION_RULES.find((x) => x.table === "automationRun")!;
    const w = rule.where(daysAgo(90)) as { status?: { not?: string }; items?: { none?: { status?: { in?: string[] } } } };
    check("the where(cutoff) itself excludes RUNNING runs and runs with SCHEDULED, SENDING or FAILED items",
      w.status?.not === "RUNNING" && [...(w.items?.none?.status?.in ?? [])].sort().join() === "FAILED,SCHEDULED,SENDING", JSON.stringify(w));
  }

  console.log("\nbatching and isolation");
  {
    const many = Array.from({ length: RETENTION_BATCH * RETENTION_MAX_BATCHES + 5 }, (_, i) => ({ id: `w${i}`, receivedAt: daysAgo(40) }));
    const { client, data, calls } = makeClient({ plaidWebhookEvent: many });
    const r = await quiet(() => runDataRetention(client, NOW));
    check("at most MAX_BATCHES per table per run; the remainder is reported, not lost", r.plaidWebhookEvent.batches === RETENTION_MAX_BATCHES
      && r.plaidWebhookEvent.exhausted === false && data.plaidWebhookEvent.length === 5);
    const del = calls.find((c) => c.op === "delete");
    check("each delete repeats the age predicate alongside the id list (a row that changed in between survives)",
      !!del && Array.isArray(del.where.AND) && (del.where.AND as unknown[]).length === 2);
  }
  {
    const { client, data } = makeClient({ aiInvocation: [{ id: "x", occurredAt: daysAgo(100) }], jobRun: [{ id: "j", startedAt: daysAgo(100), status: "succeeded" }] }, { failOn: "aiInvocation" });
    const r = await quiet(() => runDataRetention(client, NOW));
    check("one table failing does not stop the others", !!r.aiInvocation.error && data.jobRun.length === 0 && data.aiInvocation.length === 1);
  }

  console.log("\nwiring");
  {
    const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("the registered purge-trash body runs the retention schedule", /runDataRetention\(\)/.test(strip("jobs/purge-trash.ts")));
    check("retention defaults to the system principal", /\.systemDb as unknown as RetentionClient/.test(strip("jobs/data-retention.ts")));
    check("no financial table is in the schedule", !RETENTION_RULES.some((r) => /transaction|financialAccount|snapshot|holding|position/i.test(r.table)));
  }

  if (failures > 0) { console.error(`\n❌ data retention: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ data retention: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
