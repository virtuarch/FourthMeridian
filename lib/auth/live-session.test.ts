/**
 * lib/auth/live-session.test.ts — ONE definition of a "live" session (SEC-010).
 *
 * Standalone tsx script (house pattern). No database, no network.
 *
 * THE DEFECT. Operator surfaces (Security Ops, CS, Growth, admin Security)
 * counted a UserSession as live/active when `revokedAt` was null, ignoring the
 * SEC-010 lifetime (30-day idle, 90-day absolute) and the ACCOUNT LOCKOUT the
 * auth path enforces in lib/auth/session-proof.ts. Expired-but-unrevoked rows
 * read as live.
 *
 * WHAT THIS PROVES.
 *   1. BOUNDARY AGREEMENT — on rows just inside / just outside each cut-off,
 *      plus revoked, deactivated and deletion-scheduled rows, three classifiers
 *      agree EXACTLY: `liveSessionWhere(now)` evaluated by an in-memory Prisma
 *      `where` matcher, the pure `isSessionLive`, and the auth path's own
 *      `factsFromRow` (non-null ⇔ live).
 *   2. A session idle beyond the limit, or past the absolute lifetime, is not
 *      counted; a live one is.
 *   3. CENSUS PIN — no `userSession` read (count / groupBy / aggregate /
 *      findMany / findFirst …) outside session-proof filters on a bare
 *      `revokedAt: null`; no session list filters rows on `!x.revokedAt` alone.
 *      The revoke WRITES (updateMany) are named exceptions with reasons.
 *   4. The nine display sites use the shared definition.
 *   5. SURFACE COPY — the expired group renders the admin labels ("expired, not
 *      revoked" / "Revoke") on the admin views and the customer labels
 *      ("Expired — these sessions can no longer access your account" /
 *      "Remove") in the customer Security Center; each surface passes its set.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { ExpiredSessionsGroup, SESSION_LIST_LABELS, SessionsList, type SessionRow } from "@/components/security/SessionsList";
import { join, relative } from "node:path";
import {
  factsFromRow, isSessionLive, judgeSessionLifetime, liveSessionWhere, sessionDisplayState,
  SESSION_ABSOLUTE_LIFETIME_MS, SESSION_IDLE_TIMEOUT_MS,
} from "./session-proof";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}`, detail ?? ""); }
}

// ── An in-memory evaluator for the Prisma `where` subset liveSessionWhere emits ──
function matches(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond === null) { if (value !== null) return false; continue; }
    if (typeof cond !== "object" || cond instanceof Date) { if (value !== cond) return false; continue; }
    const c = cond as Record<string, unknown>;
    if ("is" in c) {
      if (!value || typeof value !== "object") return false;
      if (!matches(c.is as Record<string, unknown>, value as Record<string, unknown>)) return false;
      continue;
    }
    for (const [op, operand] of Object.entries(c)) {
      if (op === "gte") { if (!(value instanceof Date) || value.getTime() < (operand as Date).getTime()) return false; }
      else if (op === "gt") { if (!(value instanceof Date) || value.getTime() <= (operand as Date).getTime()) return false; }
      else if (op === "in") { if (!(operand as unknown[]).includes(value)) return false; }
      else throw new Error(`matcher: unsupported operator ${op} on ${key}`);
    }
  }
  return true;
}

const NOW = new Date("2026-11-03T12:00:00.000Z");
const T = NOW.getTime();
const ago = (ms: number) => new Date(T - ms);
const MIN = 60_000;

function row(over: { createdAt?: Date; lastActiveAt?: Date; revokedAt?: Date | null; deactivatedAt?: Date | null; deletionScheduledAt?: Date | null; userId?: string } = {}) {
  const userId = over.userId ?? "user_a";
  return {
    userId,
    revokedAt:    over.revokedAt ?? null,
    createdAt:    over.createdAt ?? ago(10 * MIN),
    lastActiveAt: over.lastActiveAt ?? ago(MIN),
    user: {
      id: userId, role: "USER", totpEnabled: true,
      deactivatedAt: over.deactivatedAt ?? null, deletionScheduledAt: over.deletionScheduledAt ?? null,
    },
  };
}

const fixtures: { name: string; live: boolean; r: ReturnType<typeof row> }[] = [
  { name: "fresh session",                         live: true,  r: row() },
  { name: "idle exactly at the limit",             live: true,  r: row({ lastActiveAt: ago(SESSION_IDLE_TIMEOUT_MS) }) },
  { name: "idle 1 ms inside the limit",            live: true,  r: row({ lastActiveAt: ago(SESSION_IDLE_TIMEOUT_MS - 1) }) },
  { name: "idle 1 ms beyond the limit",            live: false, r: row({ createdAt: ago(SESSION_IDLE_TIMEOUT_MS + 5 * MIN), lastActiveAt: ago(SESSION_IDLE_TIMEOUT_MS + 1) }) },
  { name: "idle 31 days",                          live: false, r: row({ createdAt: ago(40 * 86_400_000), lastActiveAt: ago(31 * 86_400_000) }) },
  { name: "created exactly at the absolute limit", live: true,  r: row({ createdAt: ago(SESSION_ABSOLUTE_LIFETIME_MS) }) },
  { name: "created 1 ms inside the absolute limit", live: true, r: row({ createdAt: ago(SESSION_ABSOLUTE_LIFETIME_MS - 1) }) },
  { name: "created 1 ms beyond the absolute limit, active now", live: false, r: row({ createdAt: ago(SESSION_ABSOLUTE_LIFETIME_MS + 1), lastActiveAt: ago(MIN) }) },
  { name: "revoked, otherwise fresh",              live: false, r: row({ revokedAt: ago(MIN) }) },
  { name: "deactivated account, fresh session",    live: false, r: row({ deactivatedAt: ago(MIN) }) },
  { name: "deletion-scheduled account, fresh session", live: false, r: row({ deletionScheduledAt: ago(MIN) }) },
];

async function main() {
  console.log("\n1. boundary agreement: liveSessionWhere ≡ isSessionLive ≡ factsFromRow");
  const where = liveSessionWhere(NOW) as unknown as Record<string, unknown>;
  for (const f of fixtures) {
    const byWhere = matches(where, f.r as unknown as Record<string, unknown>);
    const byPred  = isSessionLive(f.r, NOW);
    const byAuth  = (await factsFromRow(f.r, async () => false, { now: () => T })) !== null;
    check(`${f.name}: where=${byWhere} predicate=${byPred} auth=${byAuth} (expected ${f.live})`,
      byWhere === f.live && byPred === f.live && byAuth === f.live);
  }

  console.log("\n2. counts: expired-but-unrevoked rows are not live");
  const table = fixtures.map((f) => f.r);
  const counted = table.filter((r) => matches(where, r as unknown as Record<string, unknown>)).length;
  const bareRevokedNull = table.filter((r) => r.revokedAt === null).length;
  check(`live count ${counted} = number of live fixtures`, counted === fixtures.filter((f) => f.live).length);
  check(`the old bare revokedAt:null count (${bareRevokedNull}) overcounted`, bareRevokedNull > counted);

  const scoped = liveSessionWhere(NOW, { userId: { in: ["user_b"] }, userWhere: { role: "USER" } }) as unknown as Record<string, unknown>;
  check("userId filter is honoured", !matches(scoped, row() as unknown as Record<string, unknown>) &&
    matches(scoped, row({ userId: "user_b" }) as unknown as Record<string, unknown>));
  const lockedB = row({ userId: "user_b", deactivatedAt: ago(MIN) });
  check("userWhere never displaces the lockout", !matches(scoped, lockedB as unknown as Record<string, unknown>));

  console.log("\n3. sessionDisplayState (session lists) splits live / expired-not-revoked / revoked");
  for (const f of fixtures) {
    const want = f.r.revokedAt !== null ? "REVOKED"
      : judgeSessionLifetime(f.r, { now: () => T }) === "LIVE" ? "LIVE" : "EXPIRED_NOT_REVOKED";
    check(`${f.name} → ${want}`, sessionDisplayState(f.r, NOW) === want);
  }
  // JSON rows (string timestamps) behave the same.
  const json = { revokedAt: null, createdAt: ago(SESSION_ABSOLUTE_LIFETIME_MS + 1).toISOString(), lastActiveAt: NOW.toISOString() };
  check("ISO-string row past the absolute limit → EXPIRED_NOT_REVOKED", sessionDisplayState(json, NOW) === "EXPIRED_NOT_REVOKED");

  console.log("\n4. census pin");
  pin();

  console.log("\n5. expired-group copy by surface");
  surfaceCopy();

  console.log(`\n${passes} passed, ${failures} failed.`);
  process.exit(failures > 0 ? 1 : 0);
}

// ── Census pin ────────────────────────────────────────────────────────────────

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "components", "jobs", "scripts"];
const DEFINITION = "lib/auth/session-proof.ts";

/**
 * Deliberate bare `revokedAt: null` on UserSession — every one a revoke WRITE
 * (it narrows "rows to stamp revoked now"; an expired row being stamped too is
 * correct and harmless). S2 ruling 2026-11-03. Key = `file#method`.
 */
const ALLOW: Record<string, string> = {
  "lib/auth.ts#updateMany":                                     "sign-out: revoke THIS session row",
  "lib/sessions.ts#updateMany":                                 "revokeOtherUserSessions: revoke every unrevoked row (incl. expired)",
  "app/api/admin/security/users/[userId]/sessions/route.ts#updateMany": "admin revoke one / all: stamp every unrevoked row",
  "scripts/admin-promote.ts#updateMany":                        "promotion revokes every unrevoked row so the next request re-logs in",
};

function walk(dir: string, out: string[]) {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
}

/** Every `userSession.<method>( … )` call, with its balanced argument text. */
function sessionCalls(src: string): { method: string; args: string }[] {
  const out: { method: string; args: string }[] = [];
  const re = /\buserSession\s*\.\s*(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1; let i = re.lastIndex;
    while (i < src.length && depth > 0) { const ch = src[i++]; if (ch === "(") depth++; else if (ch === ")") depth--; }
    out.push({ method: m[1], args: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}

const BARE_REVOKED_NULL = /\brevokedAt\s*:\s*null\b/;
/** A session list filtering rows on `!x.revokedAt` alone (the client-side twin). */
const BARE_REVOKED_FILTER = /\.filter\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*!\s*\1\.revokedAt\s*\)/;

function violations(file: string, src: string): string[] {
  const v: string[] = [];
  for (const c of sessionCalls(src)) {
    if (!BARE_REVOKED_NULL.test(c.args) || /liveSessionWhere\s*\(/.test(c.args)) continue;
    if (ALLOW[`${file}#${c.method}`]) continue;
    v.push(`${file}: userSession.${c.method} filters on bare revokedAt: null`);
  }
  if (BARE_REVOKED_FILTER.test(src)) v.push(`${file}: filters session rows on !revokedAt alone`);
  return v;
}

function pin() {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
  const all: string[] = [];
  const allowSeen = new Set<string>();
  for (const abs of files) {
    const file = relative(ROOT, abs).split("\\").join("/");
    if (file === DEFINITION) continue;
    const src = readFileSync(abs, "utf8");
    all.push(...violations(file, src));
    for (const c of sessionCalls(src)) if (BARE_REVOKED_NULL.test(c.args) && ALLOW[`${file}#${c.method}`]) allowSeen.add(`${file}#${c.method}`);
  }
  check(`scanned ${files.length} files; no bare revokedAt:null live/active session filter`, all.length === 0, all);
  for (const key of Object.keys(ALLOW)) check(`allowlist entry still needed: ${key}`, allowSeen.has(key));
  for (const key of Object.keys(ALLOW)) check(`allowlisted exception is a revoke write: ${key}`, key.endsWith("#updateMany"));

  // The pin bites.
  check("pin catches a bare count", violations("x.ts", "db.userSession.count({ where: { revokedAt: null } })").length === 1);
  check("pin catches a bare groupBy across lines", violations("x.ts", "tx.userSession.groupBy({\n by: [\"userId\"],\n where: { userId, revokedAt: null },\n})").length === 1);
  check("pin catches a bare findMany", violations("x.ts", "db.userSession.findMany({ where: { revokedAt: null }, take: 8 })").length === 1);
  check("pin catches an un-allowlisted updateMany", violations("x.ts", "db.userSession.updateMany({ where: { revokedAt: null }, data: {} })").length === 1);
  check("pin catches a client !revokedAt filter", violations("x.tsx", "sessions.filter((s) => !s.revokedAt)").length === 1);
  check("pin accepts liveSessionWhere", violations("x.ts", "db.userSession.count({ where: liveSessionWhere(now) })").length === 0);
  check("pin ignores other models", violations("x.ts", "db.spaceShare.count({ where: { revokedAt: null } })").length === 0);

  // The nine display sites use the shared definition.
  const SITES = [
    "app/api/platform/security-ops/sessions/route.ts",
    "app/api/platform/security-ops/auth-posture/route.ts",
    "lib/platform/security/analytics.ts",
    "app/api/platform/growth-revenue/users/route.ts",
    "lib/platform/customer/customer-detail.ts",
    "lib/platform/customer/customers.ts",
    "app/api/admin/security/admin-status/route.ts",
    "app/api/admin/security/users/route.ts",
  ];
  for (const f of SITES) check(`${f} uses liveSessionWhere`, /liveSessionWhere\s*\(/.test(readFileSync(join(ROOT, f), "utf8")));
  const cd = readFileSync(join(ROOT, "lib/platform/customer/customer-detail.ts"), "utf8");
  check("customer-detail: both the count and the presence aggregate are live-scoped", (cd.match(/liveSessionWhere\(now, \{ userId \}\)/g) ?? []).length === 2);
  for (const f of ["components/security/SessionsList.tsx", "components/security/ActiveSessions.tsx"]) {
    check(`${f} uses sessionDisplayState`, /sessionDisplayState\s*\(/.test(readFileSync(join(ROOT, f), "utf8")));
  }
}

function surfaceCopy() {
  const parsed = { browser: "Chrome", os: "macOS", device: "Desktop" } as SessionRow["parsed"];
  const base = { userId: "user_a", ipAddress: null, userAgent: null, revokedAt: null, parsed };
  const nowIso = new Date().toISOString();
  const liveRow: SessionRow = { ...base, id: "s_live", createdAt: nowIso, lastActiveAt: nowIso };
  const expiredRow: SessionRow = { ...base, id: "s_exp",
    createdAt: new Date(Date.now() - SESSION_ABSOLUTE_LIFETIME_MS - 86_400_000).toISOString(), lastActiveAt: nowIso };
  const noop = async () => {};
  const CUSTOMER_HEADING = "Expired — these sessions can no longer access your account";

  // Admin per-user view + admin's own view: SessionsList with the admin set.
  const admin = renderToStaticMarkup(createElement(SessionsList, {
    sessions: [liveRow, expiredRow], onRevoke: noop, onRevokeAll: noop, expiredLabels: SESSION_LIST_LABELS.admin,
  }));
  const adminGroup = admin.slice(admin.indexOf("data-sessions-expired"));
  check("admin: expired group heading is \"1 expired, not revoked\"", adminGroup.includes("1 expired, not revoked"));
  check("admin: expired row action is \"Revoke\"", />Revoke<\/button>/.test(adminGroup));
  check("admin: no customer copy", !admin.includes(CUSTOMER_HEADING) && !/>Remove</.test(admin));
  const adminDefault = renderToStaticMarkup(createElement(SessionsList, { sessions: [expiredRow], onRevoke: noop, onRevokeAll: noop }));
  check("SessionsList defaults to the admin set", adminDefault.includes("1 expired, not revoked"));

  // Customer Security Center: the shared group with the customer set.
  const customer = renderToStaticMarkup(createElement(ExpiredSessionsGroup, {
    sessions: [expiredRow], labels: SESSION_LIST_LABELS.customer, onRemove: noop, removingId: null,
  }));
  check("customer: heading is the customer copy", customer.includes(CUSTOMER_HEADING));
  check("customer: action is \"Remove\"", />Remove<\/button>/.test(customer));
  check("customer: no operator copy", !/Revoke/.test(customer) && !/not revoked/.test(customer));
  check("empty expired group renders nothing", renderToStaticMarkup(createElement(ExpiredSessionsGroup, {
    sessions: [], labels: SESSION_LIST_LABELS.customer, onRemove: noop, removingId: null })) === "");

  // Each surface passes its own set.
  const console_ = readFileSync(join(ROOT, "components/admin/AdminSecurityConsole.tsx"), "utf8");
  check("AdminSecurityConsole: both SessionsList mounts pass SESSION_LIST_LABELS.admin",
    (console_.match(/<SessionsList\b/g) ?? []).length === 2 &&
    (console_.match(/expiredLabels=\{SESSION_LIST_LABELS\.admin\}/g) ?? []).length === 2);
  const active = readFileSync(join(ROOT, "components/security/ActiveSessions.tsx"), "utf8");
  check("ActiveSessions (customer Security Center) passes SESSION_LIST_LABELS.customer",
    /<ExpiredSessionsGroup[^>]*labels=\{SESSION_LIST_LABELS\.customer\}/.test(active) && !/SESSION_LIST_LABELS\.admin/.test(active));
}

main().catch((e) => { console.error("  ✗ threw —", e); process.exit(1); });
