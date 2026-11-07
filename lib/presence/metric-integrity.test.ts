/**
 * lib/presence/metric-integrity.test.ts  (PB-10 — what may read and write which clock)
 *
 *   A. The beat statement: parity with touchSessionActivity (one autocommit
 *      statement, SKIP LOCKED sub-select, bound token + user, DB throttle = the
 *      config), and it writes the presence clocks ONLY — never lastActiveAt,
 *      never an AuditLog row, never a product event.
 *   B. Background polls cannot move "last active": the session touch (the only
 *      write any ordinary authenticated request makes) never writes the
 *      presence clocks, and nothing but the beat statement writes them.
 *   C. lastInteractionAt is LOW TRUST: read only by the presence buckets and the
 *      Customer Success display — never by engagement (DAU/WAU/MAU, "Returned",
 *      Growth returning), never by SEC-010 or any auth/security module.
 *   D. Engagement = the server-side predicate only: Growth "returning" and
 *      active7 count loadEngagedUserIdsSince (ENGAGEMENT_AUDIT_ACTIONS ∪ AI
 *      customer surfaces); SESSION_ACTIVE_DAY stays PRESENCE ("a UTC day with a
 *      human-initiated authenticated request", PB-10 F3) and no engagement
 *      / active-user metric reads it; Customer Ops / Growth no longer read
 *      UserSession.lastActiveAt as activity.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/presence/metric-integrity.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { recordPresenceBeat } from "@/lib/auth/presence-activity";
import { touchSessionActivity, type RawExecutor } from "@/lib/auth/session-activity";
import { PRESENCE_CONFIG } from "@/lib/presence/definitions";
import { AuditAction, PRODUCT_EVENT_ACTIONS } from "@/lib/audit-actions";
import { ENGAGEMENT_AUDIT_ACTIONS, PRESENCE_ACTIONS, ENGAGEMENT_AI_SURFACES } from "@/lib/platform/growth/product-analytics-core";
import { loadEngagedUserIdsSince, type ProductAnalyticsDb } from "@/lib/platform/growth/product-analytics";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function recorder() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client: RawExecutor = {
    $executeRaw(q: TemplateStringsArray, ...values: unknown[]) { calls.push({ sql: q.join("$?").replace(/\s+/g, " "), values }); return Promise.resolve(1); },
  };
  return { calls, client };
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(path.join(ROOT, d))) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const rel = path.join(d, e);
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
    }
  };
  for (const d of ["app", "lib", "components", "jobs", "scripts", "context", "hooks"]) {
    try { if (statSync(path.join(ROOT, d)).isDirectory()) walk(d); } catch { /* absent */ }
  }
  return out;
}

async function main() {
  console.log("PB-10 — metric integrity\n\nA. the beat statement");
  {
    const { calls, client } = recorder();
    await recordPresenceBeat(client, "tok_abcdefghijklmnop", "user_1", true);
    const sql = calls[0]?.sql ?? "";
    check("one call, one statement, no transaction", calls.length === 1 && !/\bBEGIN\b|\bCOMMIT\b|\bSET (LOCAL |SESSION )?[a-z_]+ (=|TO)/i.test(sql) && !sql.includes(";"), sql);
    check("the row is taken in a sub-select FOR UPDATE SKIP LOCKED", /FROM \( SELECT "id" FROM "UserSession" .* FOR UPDATE SKIP LOCKED \) s/.test(sql), sql);
    check("bound by sessionToken AND userId AND not revoked", /"sessionToken" = \$\?/.test(sql) && /"userId" = \$\?/.test(sql) && /"revokedAt" IS NULL/.test(sql));
    check("values are exactly: the boolean, the token, the user, the boolean — no time, no IP, no UA, no path",
      JSON.stringify(calls[0]?.values) === JSON.stringify([true, "tok_abcdefghijklmnop", "user_1", true]), JSON.stringify(calls[0]?.values));
    check("time is the database clock", (sql.match(/now\(\) AT TIME ZONE 'UTC'/g) ?? []).length >= 2 && !/\$\?::timestamp/.test(sql));
    const literal = [...sql.matchAll(/interval '(\d+) seconds'/g)].map((m) => Number(m[1]));
    check("the DB throttle literal is PRESENCE_CONFIG.serverThrottleSeconds", literal.length === 2 && literal.every((n) => n === PRESENCE_CONFIG.serverThrottleSeconds), JSON.stringify(literal));
    check("it writes lastPresenceAt / lastInteractionAt and NEVER lastActiveAt (SEC-010's clock)",
      /SET "lastPresenceAt" =/.test(sql) && /"lastInteractionAt" = CASE/.test(sql) && !/lastActiveAt/.test(sql), sql);
    check("a heartbeat is never engagement: no AuditLog row, no product event", !/AuditLog|INSERT/i.test(sql));
    const mod = strip(read("lib/auth/presence-activity.ts"));
    check("the module opens no transaction", !/\$transaction/.test(mod));
    const route = strip(read("app/api/user/presence/route.ts"));
    check("the route imports no audit / product-event writer and reads no IP, UA or path",
      !/@\/lib\/audit|auditInsert|getClientIp|user-agent|userAgent|ipAddress|nextUrl|pathname|referer/i.test(route));
    check("the route's write goes through lib/session.ts (a confined authDb importer), not a new authority",
      /recordSessionPresence\(user, body\.interacted\)/.test(route) && !/authDb|systemDb|withTenantDb|from "@\/lib\/db"/.test(route));
    const session = strip(read("lib/session.ts"));
    check("lib/session.ts writes the beat on authDb — the client the session touch uses",
      /recordPresenceBeat\(authDb, user\.sessionToken, user\.id, interacted === true\)/.test(session));
  }

  console.log("\nB. background polls cannot move \"last active\"");
  {
    const { calls, client } = recorder();
    await touchSessionActivity(client, "tok_abcdefghijklmnop", "user_1");
    check("the session touch (every ordinary authenticated request) never writes the presence clocks",
      !/lastPresenceAt|lastInteractionAt/.test(calls[0]?.sql ?? ""));
    const writers = sourceFiles().filter((f) => {
      const src = strip(read(f));
      return /"lastPresenceAt"\s*=|"lastInteractionAt"\s*=|lastPresenceAt\s*:\s*(new Date|now|dbNow)|lastInteractionAt\s*:\s*(new Date|now|dbNow)/.test(src);
    });
    check("nothing but lib/auth/presence-activity.ts writes the presence clocks",
      JSON.stringify(writers) === '["lib/auth/presence-activity.ts"]', JSON.stringify(writers));
  }

  console.log("\nC. lastInteractionAt is low trust — presence buckets and the CS display only");
  {
    const READERS_ALLOWED = new Set([
      "lib/presence/definitions.ts",          // the state machine + buckets
      "lib/auth/presence-activity.ts",        // the writer
      "lib/platform/customer/customers.ts",   // CS list → buckets
      "lib/platform/customer/customer-detail.ts", // CS detail → buckets
      "lib/platform/customer/customer-core.ts",   // CS projection → buckets
      "lib/export/assemble.ts",               // the subject's own data export
      // B10.6 rollback rehearsal (throwaway database only; asserts the columns, never buckets them)
      "scripts/test-b10-rollback-rehearsal.ts",
      "scripts/test-b10-rehearsal-b10-probe.ts",
      "scripts/test-b10-rehearsal-b9-probe.ts",
    ]);
    const readers = sourceFiles().filter((f) => /lastInteractionAt|lastPresenceAt/.test(strip(read(f))));
    const extra = readers.filter((f) => !READERS_ALLOWED.has(f));
    check("only the allowlisted modules read the presence clocks", extra.length === 0, JSON.stringify(extra));
    for (const f of [
      "lib/auth/session-proof.ts", "lib/session-cache.ts", "lib/auth.ts", "lib/auth/session-activity.ts",
      "lib/platform/growth/growth.ts", "lib/platform/growth/product-analytics.ts", "lib/platform/growth/product-analytics-core.ts",
      "lib/platform/activity/activity.ts", "app/api/platform/growth-revenue/signups/route.ts",
    ]) check(`${f} (security / engagement) never reads the presence clocks`, !/lastInteractionAt|lastPresenceAt/.test(strip(read(f))));
  }

  console.log("\nD. engagement = the server-side predicate; SESSION_ACTIVE_DAY is presence");
  {
    check("SESSION_ACTIVE_DAY is a PRESENCE action (a UTC day with a human-initiated authenticated request)", PRESENCE_ACTIONS.includes(AuditAction.SESSION_ACTIVE_DAY));
    const defs = read("lib/presence/definitions.ts");
    check("definitions.ts states the F3 meaning: background reads excluded, 30-day unused tab signs out",
      /HUMAN-INITIATED authenticated request/.test(defs) && /BACKGROUND reads do NOT touch it/.test(defs) && /90-day absolute cut-off is unchanged/.test(defs));
    check("…and not an engagement action", !ENGAGEMENT_AUDIT_ACTIONS.includes(AuditAction.SESSION_ACTIVE_DAY));
    check("every engagement audit action is a server-written product event or a connection add",
      ENGAGEMENT_AUDIT_ACTIONS.every((a) => PRODUCT_EVENT_ACTIONS.includes(a) || [AuditAction.ACCOUNT_ADD, AuditAction.WALLET_ADD, AuditAction.MANUAL_ASSET_ADD].includes(a as never)));

    const seen: Array<{ model: string; where: Record<string, unknown> }> = [];
    const fakeClient = {
      aiInvocation: { groupBy: async (a: { where: Record<string, unknown> }) => { seen.push({ model: "ai", where: a.where }); return [{ userId: "u1" }, { userId: null }]; } },
      auditLog:     { groupBy: async (a: { where: Record<string, unknown> }) => { seen.push({ model: "audit", where: a.where }); return [{ userId: "u2" }, { userId: "u1" }]; } },
    } as unknown as ProductAnalyticsDb;
    const since = new Date("2026-10-27T00:00:00Z");
    const ids = await loadEngagedUserIdsSince(fakeClient, since);
    check("engaged users = distinct union of AI-surface and engagement-audit users", ids.size === 2 && ids.has("u1") && ids.has("u2"));
    const audit = seen.find((s) => s.model === "audit")?.where as { action: { in: string[] }; createdAt: { gte: Date } };
    const ai = seen.find((s) => s.model === "ai")?.where as { surface: { in: string[] }; occurredAt: { gte: Date } };
    check("the audit half reads exactly ENGAGEMENT_AUDIT_ACTIONS (no SESSION_ACTIVE_DAY), windowed",
      JSON.stringify(audit.action.in) === JSON.stringify(ENGAGEMENT_AUDIT_ACTIONS) && !audit.action.in.includes(AuditAction.SESSION_ACTIVE_DAY)
      && audit.createdAt.gte.getTime() === since.getTime());
    check("the AI half reads exactly the customer surfaces (harness never), windowed",
      JSON.stringify(ai.surface.in) === JSON.stringify(ENGAGEMENT_AI_SURFACES) && ai.occurredAt.gte.getTime() === since.getTime());

    const growth = strip(read("lib/platform/growth/growth.ts"));
    check("Growth returning counts engagement, not session use",
      /async returningUsers\(activeSince, createdBefore\) \{\s*const ids = \[\.\.\.\(await loadEngagedUserIdsSince\(systemDb, activeSince\)\)\];/.test(growth)
      && !/lastActiveAt/.test(growth));
    const signups = strip(read("app/api/platform/growth-revenue/signups/route.ts"));
    check("Growth active7 counts engagement, not session use", /loadEngagedUserIdsSince\(systemDb, week\)/.test(signups) && !/lastActiveAt/.test(signups));
    for (const f of [
      "lib/platform/customer/customers.ts", "lib/platform/customer/customer-detail.ts", "lib/platform/customer/customer-core.ts",
      "lib/platform/growth/product-analytics.ts", "lib/platform/growth/product-analytics-core.ts", "lib/platform/activity/activity.ts",
      "components/platform/widgets/CsCustomersWidget.tsx",
    ]) check(`${f} does not read UserSession.lastActiveAt as activity`, !/lastActiveAt/.test(strip(read(f))));
    const engagementReaders = ["lib/platform/growth/growth.ts", "app/api/platform/growth-revenue/signups/route.ts", "lib/platform/customer/customers.ts", "lib/platform/customer/customer-detail.ts"];
    check("no engagement / active-user reader names SESSION_ACTIVE_DAY",
      engagementReaders.every((f) => !/SESSION_ACTIVE_DAY/.test(strip(read(f)))));
  }
}

main().then(() => {
  if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log("\nAll metric-integrity checks passed.");
}, (e) => { console.error(e); process.exit(1); });
