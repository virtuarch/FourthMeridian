/**
 * lib/platform/security/p12a-readers.test.ts  (P12a — security inline queries → readers)
 *
 * The six route-inline reads moved into lib/platform/security/* are a PURE MOVE:
 *   1. OLD vs NEW on fixtures — each route's former inline logic (copied
 *      verbatim below as OLD, `db` → the same recording fake) and the new reader
 *      issue the SAME Prisma calls, in the SAME order, with the SAME arguments,
 *      and produce byte-identical JSON output;
 *   2. the call sites no longer hold the query: each route is gate → reader →
 *      JSON, keeps its exact requirePlatformAccess gate BEFORE the read, and
 *      touches no model on `db` itself;
 *   3. single home: every (non-trivial) query a reader issues appears verbatim in
 *      exactly one non-test Platform source file — the reader.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/security/p12a-readers.test.ts
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { ADMIN_SECURITY_FILTER_ACTIONS, AuditAction, OPERATOR_ACTION_FEED_ACTIONS } from "@/lib/audit-actions";
import { liveSessionWhere } from "@/lib/auth/session-proof";
import { ANOMALY_THRESHOLDS } from "@/lib/security/anomalies";
import { projectAnomalyTrip } from "./anomalies-core";
import { projectOperatorActionEvent } from "./operator-actions-core";
import { toPlatformSessionRow } from "./session-rows";
import { countLiveSessions } from "./live-sessions";
import { readSecurityAuditFeed } from "./audit-feed";
import { readAuthPosture } from "./auth-posture";
import { readOperatorActionFeed } from "./operator-actions";
import { listRecentLiveSessions } from "./sessions";
import { readSecurityAnomalies } from "./anomalies";
import { readRateLimitPressure } from "./rate-limits";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (f: string) => readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ── a recording fake client: every model call is logged, answers come from fixtures ──
type Db = Pick<PrismaClient, "auditLog" | "user" | "userSession" | "recoveryCode" | "rateLimit">;
interface Call { model: string; method: string; args: unknown }
type Answer = (args: unknown) => unknown;
function fake(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const models = ["auditLog", "user", "userSession", "recoveryCode", "rateLimit"];
  const client: Record<string, Record<string, (args?: unknown) => Promise<unknown>>> = {};
  for (const model of models) {
    client[model] = new Proxy({}, {
      get: (_t, method: string) => async (args?: unknown) => {
        calls.push({ model, method, args });
        const a = answers[`${model}.${method}`];
        if (!a) throw new Error(`unexpected call ${model}.${method}`);
        return a(args);
      },
    });
  }
  return { calls, db: client as unknown as Db };
}
/** Run OLD and NEW on twin fakes; compare the call log and the serialised output. */
async function parity(label: string, answers: Record<string, Answer>, oldFn: (db: Db) => Promise<unknown>, newFn: (db: Db) => Promise<unknown>) {
  const o = fake(answers), n = fake(answers);
  const before = JSON.stringify(await oldFn(o.db));
  const after = JSON.stringify(await newFn(n.db));
  check(`${label}: same Prisma calls, same order, identical arguments`, JSON.stringify(o.calls) === JSON.stringify(n.calls) && n.calls.length > 0, JSON.stringify(n.calls));
  check(`${label}: identical output`, before === after, `${before}\n    vs ${after}`);
  return { before, calls: n.calls };
}

const NOW = new Date("2026-11-09T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const AGO = (min: number) => new Date(NOW_MS - min * 60_000);

// ── OLD: the route handlers' inline logic, verbatim (before the move) ────────
// Only `db` became a parameter and the request clock (`new Date()` / `Date.now()`)
// the fixture clock; every query, ordering, limit and projection is unchanged.

async function oldAudit(db: Db) {
  const RECENT_LIMIT = 15;
  const rows = await db.auditLog.findMany({
    where:   { action: { in: ADMIN_SECURITY_FILTER_ACTIONS } },
    orderBy: { createdAt: "desc" },
    take:    RECENT_LIMIT,
    select:  {
      id:        true,
      action:    true,
      createdAt: true,
      user:      { select: { username: true } },
    },
  });

  const events = rows.map((r) => ({
    id:     r.id,
    action: r.action,
    at:     r.createdAt.toISOString(),
    actor:  r.user?.username ?? "system",
  }));

  return { events };
}

async function oldAuthPosture(db: Db, now: Date) {
  const [totalUsers, totpEnabled, forcedResetPending, activeSessions, recovery] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { totpEnabled: true } }),
    db.user.count({ where: { forcePasswordReset: true } }),
    db.userSession.count({ where: liveSessionWhere(now) }),
    db.recoveryCode.groupBy({ by: ["userId"], where: { usedAt: null }, _count: { id: true } }),
  ]);

  return {
    totalUsers,
    totpEnabled,
    forcedResetPending,
    activeSessions,
    usersWithRecoveryCodes: recovery.length,
  };
}

async function oldOperatorActions(db: Db) {
  const RECENT_LIMIT = 20;
  const rows = await db.auditLog.findMany({
    where:   { action: { in: OPERATOR_ACTION_FEED_ACTIONS }, performedByAdminId: { not: null } },
    orderBy: { createdAt: "desc" },
    take:    RECENT_LIMIT,
    select:  {
      id:                 true,
      action:             true,
      createdAt:          true,
      performedByAdminId: true,
      metadata:           true,
      user:               { select: { username: true } },
    },
  });

  const operatorIds = [...new Set(rows.map((r) => r.performedByAdminId).filter((v): v is string => v != null))];
  const operators = operatorIds.length
    ? await db.user.findMany({ where: { id: { in: operatorIds } }, select: { id: true, username: true } })
    : [];
  const operatorName = new Map(operators.map((u) => [u.id, u.username] as const));

  const events = rows.map((r) => projectOperatorActionEvent(
    { id: r.id, action: r.action, createdAt: r.createdAt, performedByAdminId: r.performedByAdminId, metadata: r.metadata, subjectUsername: r.user?.username ?? null },
    (r.performedByAdminId && operatorName.get(r.performedByAdminId)) || null,
  ));

  return { events };
}

async function oldSessions(db: Db, now: Date) {
  const RECENT_LIMIT = 8;
  const live = liveSessionWhere(now);
  const [counts, recent] = await Promise.all([
    countLiveSessions(db, now),
    db.userSession.findMany({
      where:   live,
      orderBy: { lastActiveAt: "desc" },
      take:    RECENT_LIMIT,
      select:  { userAgent: true, lastActiveAt: true },
    }),
  ]);

  const rows = recent.map(toPlatformSessionRow);

  return {
    totalActive: counts.sessions,
    distinctUsers: counts.distinctUsers,
    recent: rows,
  };
}

async function oldAnomalies(db: Db, now: number) {
  const RECENT_LIMIT = 15;
  const windowMinutes = ANOMALY_THRESHOLDS.identifierFailedLogin.windowMinutes;
  const windowStart = new Date(now - windowMinutes * 60_000);
  const dayStart = new Date(now - 24 * 60 * 60_000);

  const [rows, failedLoginsWindow, tripsLast24h] = await Promise.all([
    db.auditLog.findMany({
      where:   { action: AuditAction.SECURITY_ANOMALY_DETECTED },
      orderBy: { createdAt: "desc" },
      take:    RECENT_LIMIT,
      select:  { id: true, createdAt: true, metadata: true },
    }),
    db.auditLog.count({ where: { action: AuditAction.LOGIN_FAILED, createdAt: { gte: windowStart } } }),
    db.auditLog.count({ where: { action: AuditAction.SECURITY_ANOMALY_DETECTED, createdAt: { gte: dayStart } } }),
  ]);

  const trips = rows.map((r) => projectAnomalyTrip(r, windowMinutes));

  return {
    trips,
    summary: { failedLoginsWindow, windowMinutes, tripsLast24h },
  };
}

async function oldRateLimits(db: Db, now: number) {
  const WINDOW_LOOKBACK_MS = 60 * 60 * 1000;
  const TOP_N = 8;
  function bucketOf(key: string): string {
    const parts = key.split(":");
    return parts.length <= 2 ? key : parts.slice(0, -1).join(":");
  }
  const since = new Date(now - WINDOW_LOOKBACK_MS);
  const rows = await db.rateLimit.findMany({
    where:  { windowStart: { gte: since } },
    select: { key: true, count: true },
  });

  const agg = new Map<string, { hits: number; keys: number }>();
  let totalHits = 0;
  for (const r of rows) {
    totalHits += r.count;
    const b = bucketOf(r.key);
    const cur = agg.get(b) ?? { hits: 0, keys: 0 };
    cur.hits += r.count;
    cur.keys += 1;
    agg.set(b, cur);
  }

  const topBuckets = [...agg.entries()]
    .map(([bucket, v]) => ({ bucket, hits: v.hits, keys: v.keys }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, TOP_N);

  return {
    windowSince: since.toISOString(),
    totalRows:   rows.length,
    totalHits,
    topBuckets,
  };
}

// ── source helpers for the single-home scan ─────────────────────────────────
const MODELS = "auditLog|user|userSession|recoveryCode|rateLimit";
/** Every `<recv>.<model>.<method>(<args>)` call in a source, args whitespace-normalised. */
function modelCalls(src: string): { model: string; method: string; args: string }[] {
  const out: { model: string; method: string; args: string }[] = [];
  const re = new RegExp(`\\b\\w+\\.(${MODELS})\\.(\\w+)\\(`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1, i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; }
    out.push({ model: m[1], method: m[2], args: src.slice(re.lastIndex, i - 1).replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim() });
  }
  return out;
}
function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) acc.push(path.relative(ROOT, p));
  }
  return acc;
}

const READERS: { file: string; route: string; area: "SECURITY_OPS" | "PLATFORM_OPS"; call: RegExp; fn: string }[] = [
  { file: "lib/platform/security/audit-feed.ts",       route: "app/api/platform/security-ops/audit/route.ts",            area: "SECURITY_OPS", call: /readSecurityAuditFeed\(db\)/,               fn: "readSecurityAuditFeed" },
  { file: "lib/platform/security/auth-posture.ts",     route: "app/api/platform/security-ops/auth-posture/route.ts",     area: "SECURITY_OPS", call: /readAuthPosture\(db, new Date\(\)\)/,       fn: "readAuthPosture" },
  { file: "lib/platform/security/operator-actions.ts", route: "app/api/platform/security-ops/operator-actions/route.ts", area: "SECURITY_OPS", call: /readOperatorActionFeed\(db\)/,              fn: "readOperatorActionFeed" },
  { file: "lib/platform/security/sessions.ts",         route: "app/api/platform/security-ops/sessions/route.ts",         area: "SECURITY_OPS", call: /listRecentLiveSessions\(db, now\)/,         fn: "listRecentLiveSessions" },
  { file: "lib/platform/security/anomalies.ts",        route: "app/api/platform/security-ops/anomalies/route.ts",        area: "SECURITY_OPS", call: /readSecurityAnomalies\(db, Date\.now\(\)\)/, fn: "readSecurityAnomalies" },
  { file: "lib/platform/security/rate-limits.ts",      route: "app/api/platform/platform-ops/rate-limits/route.ts",      area: "PLATFORM_OPS", call: /readRateLimitPressure\(db, Date\.now\(\)\)/, fn: "readRateLimitPressure" },
];

/**
 * The ONE query shape a moved reader shares with a reader that already existed
 * before P12a: the live-session COUNT (`userSession.count({ where:
 * liveSessionWhere(now) })`) is also issued by lib/platform/security/analytics.ts.
 * Both are reader modules built on THE live rule (no route inlines it any more);
 * folding them together would change analytics' query plan, which a pure move
 * must not do. Pinned to exactly that second home so any further copy fails.
 */
const KNOWN_SHARED: Record<string, string> = {
  "lib/platform/security/auth-posture.ts#userSession.count({ where: liveSessionWhere(now) })": "lib/platform/security/analytics.ts",
};

async function main(): Promise<void> {
  console.log("\nP12a — security readers (pure move)\n");

  console.log("1. OLD vs NEW on fixtures");
  {
    const rows = [
      { id: "a1", action: "LOGIN_SUCCESS", createdAt: AGO(1), user: { username: "alice" } },
      { id: "a2", action: "TWO_FACTOR_DISABLED", createdAt: AGO(5), user: null },
      { id: "a3", action: "PASSWORD_CHANGED", createdAt: AGO(9), user: { username: "bob" } },
    ];
    const r = await parity("audit feed", { "auditLog.findMany": () => rows }, oldAudit, readSecurityAuditFeed);
    check("audit feed: actor falls back to \"system\"", r.before.includes('"actor":"system"'));
    await parity("audit feed (empty)", { "auditLog.findMany": () => [] }, oldAudit, readSecurityAuditFeed);
  }
  {
    const answers: Record<string, Answer> = {
      "user.count": (a) => (a === undefined ? 12 : JSON.stringify(a).includes("totpEnabled") ? 8 : 1),
      "userSession.count": () => 5,
      "recoveryCode.groupBy": () => [{ userId: "u1", _count: { id: 10 } }, { userId: "u2", _count: { id: 3 } }],
    };
    const r = await parity("auth posture", answers, (db) => oldAuthPosture(db, NOW), (db) => readAuthPosture(db, NOW));
    check("auth posture: values flow through unchanged", r.before === JSON.stringify({ totalUsers: 12, totpEnabled: 8, forcedResetPending: 1, activeSessions: 5, usersWithRecoveryCodes: 2 }), r.before);
    check("auth posture: live sessions use liveSessionWhere at the caller's clock",
      JSON.stringify((r.calls.find((c) => c.model === "userSession")!.args as { where: unknown }).where) === JSON.stringify(liveSessionWhere(NOW)));
  }
  {
    const rows = [
      { id: "o1", action: "CUSTOMER_POLICY_ASSIGNED", createdAt: AGO(2), performedByAdminId: "op1", metadata: { actor: { kind: "OPERATOR" }, target: { kind: "USER", id: "cus_000000abcdef" }, reason: { code: "SUPPORT_REQUEST", note: "never shown" }, result: "SUCCESS" }, user: { username: "carol" } },
      { id: "o2", action: "CONNECTION_RESYNC_TRIGGERED", createdAt: AGO(4), performedByAdminId: "op2", metadata: { connectionId: "x", institution: "Example Bank", outcome: "synced" }, user: null },
      { id: "o3", action: "OPERATOR_REFRESH_ALL", createdAt: AGO(6), performedByAdminId: "op1", metadata: { execution: { jobRunId: "jr_abcdef123456" } }, user: null },
    ];
    const answers: Record<string, Answer> = {
      "auditLog.findMany": () => rows,
      "user.findMany": (a) => [{ id: "op1", username: "jules" }].filter((u) => (a as { where: { id: { in: string[] } } }).where.id.in.includes(u.id)),
    };
    const r = await parity("operator actions", answers, oldOperatorActions, readOperatorActionFeed);
    check("operator actions: one batched operator lookup over the distinct ids",
      r.calls.length === 2 && JSON.stringify((r.calls[1].args as { where: unknown }).where) === JSON.stringify({ id: { in: ["op1", "op2"] } }));
    check("operator actions: a reason note never leaves the reader", !r.before.includes("never shown"));
    const e = await parity("operator actions (no rows ⇒ no operator lookup)", { "auditLog.findMany": () => [] }, oldOperatorActions, readOperatorActionFeed);
    check("operator actions: empty feed issues exactly one query", e.calls.length === 1);
  }
  {
    const answers: Record<string, Answer> = {
      "userSession.count": () => 3,
      "userSession.groupBy": () => [{ userId: "u1" }, { userId: "u2" }],
      "userSession.findMany": () => [
        { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", lastActiveAt: AGO(0.5) },
        { userAgent: null, lastActiveAt: AGO(3) },
      ],
    };
    // NEW = the route's composition after the move: countLiveSessions + listRecentLiveSessions at ONE clock.
    const newSessions = async (db: Db) => {
      const [counts, recent] = await Promise.all([countLiveSessions(db, NOW), listRecentLiveSessions(db, NOW)]);
      return { totalActive: counts.sessions, distinctUsers: counts.distinctUsers, recent };
    };
    const r = await parity("sessions", answers, (db) => oldSessions(db, NOW), newSessions);
    check("sessions: identity-free rows (no user-agent string, no id)", !/Mozilla|"id"|userId/.test(JSON.stringify(JSON.parse(r.before).recent)));
  }
  {
    const rows = [
      { id: "t1", createdAt: AGO(1), metadata: { key: "203.0.113.7", type: "failed_login_ip", count: 12, threshold: 10, windowMinutes: 15 } },
      { id: "t2", createdAt: AGO(30), metadata: { key: "system_admin_disabled", type: "system_admin_disabled", count: 1 } },
    ];
    const answers: Record<string, Answer> = {
      "auditLog.findMany": () => rows,
      "auditLog.count": (a) => (JSON.stringify(a).includes(AuditAction.LOGIN_FAILED) ? 4 : 2),
    };
    const r = await parity("anomalies", answers, (db) => oldAnomalies(db, NOW_MS), (db) => readSecurityAnomalies(db, NOW_MS));
    check("anomalies: the raw detector key never leaves the reader", !r.before.includes("203.0.113.7"));
    check("anomalies: summary carries the window and counts", /"summary":\{"failedLoginsWindow":4,"windowMinutes":\d+,"tripsLast24h":2\}/.test(r.before), r.before);
  }
  {
    const rows = [
      { key: "ip:pre-login:203.0.113.7", count: 5 },
      { key: "ip:pre-login:198.51.100.2", count: 2 },
      { key: "user:ai-chat:u1", count: 9 },
      { key: "global", count: 1 },
      ...Array.from({ length: 9 }, (_, i) => ({ key: `ip:ep${i}:x`, count: i })),
    ];
    const r = await parity("rate limits", { "rateLimit.findMany": () => rows }, (db) => oldRateLimits(db, NOW_MS), (db) => readRateLimitPressure(db, NOW_MS));
    const out = JSON.parse(r.before) as { topBuckets: { bucket: string }[]; windowSince: string };
    check("rate limits: top-N cap and window kept", out.topBuckets.length === 8 && out.windowSince === new Date(NOW_MS - 3_600_000).toISOString());
    check("rate limits: no subject leaves the reader", !/203\.0\.113\.7|198\.51\.100\.2|:u1"/.test(r.before));
  }

  console.log("\n2. the call sites: gate → reader → JSON, no inline query left");
  for (const r of READERS) {
    const route = code(r.route);
    const gate = new RegExp(`requirePlatformAccess\\(\\s*"${r.area}"\\s*,\\s*"READ"\\s*\\)`);
    check(`${r.route}: same gate (${r.area} READ), checked before the read`, gate.test(route) && route.search(gate) < route.search(r.call));
    check(`${r.route}: calls ${r.fn} with the request client and clock`, r.call.test(route));
    check(`${r.route}: no model is touched on db inline`, modelCalls(route).length === 0, JSON.stringify(modelCalls(route)));
    const reader = code(r.file);
    check(`${r.file}: takes the caller's client (no db import, no default authority)`, !/@\/lib\/db/.test(reader) && !/\?\?\s*db\b|=\s*db\b/.test(reader));
    check(`${r.file}: selects no email / ip / user-agent string field beyond the parsed session UA`,
      !/email:\s*true|ipAddress:\s*true/.test(reader) && (r.fn === "listRecentLiveSessions" || !/userAgent:\s*true/.test(reader)));
  }
  {
    const sec = code("app/api/platform/security-ops/sessions/route.ts");
    check("sessions route: counts still through countLiveSessions(db, now) (registry live-sessions@1 hop unchanged)", /countLiveSessions\(db, now\)/.test(sec));
  }

  console.log("\n3. single home: each reader query lives only in its reader");
  {
    const files = ["app/api/platform", "app/(shell)/dashboard/platform", "lib/platform", "components/platform"].flatMap((d) => walk(path.join(ROOT, d)));
    const index = new Map<string, Set<string>>();
    for (const f of files) for (const c of modelCalls(code(f))) {
      const k = `${c.model}.${c.method}(${c.args})`;
      (index.get(k) ?? index.set(k, new Set()).get(k)!).add(f);
    }
    for (const r of READERS) {
      // A zero-argument call (`user.count()`) is not a query shape any file can own.
      const qs = modelCalls(code(r.file)).filter((c) => c.args !== "");
      check(`${r.file}: issues at least one query`, qs.length > 0);
      for (const c of qs) {
        const key = `${c.model}.${c.method}(${c.args})`;
        const homes = [...(index.get(key) ?? [])].sort();
        const shared = KNOWN_SHARED[`${r.file}#${key}`];
        if (shared) {
          check(`${r.file}: ${c.model}.${c.method}(…) lives here and only in the pre-existing reader ${shared}`,
            JSON.stringify(homes) === JSON.stringify([r.file, shared].sort()), homes.join(", "));
        } else {
          check(`${r.file}: ${c.model}.${c.method}(…) lives only here`, homes.length === 1 && homes[0] === r.file, homes.join(", "));
        }
      }
    }
    for (const k of Object.keys(KNOWN_SHARED)) {
      const [file, key] = k.split("#");
      check(`known-shared entry still matches a reader query: ${file} ${key.slice(0, 40)}…`, modelCalls(code(file)).some((c) => `${c.model}.${c.method}(${c.args})` === key));
    }
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
