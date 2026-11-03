/**
 * jobs/auditlog-append-only-policy.test.ts  (DB-010 / PRIV-005 drift pin)
 *
 * Migration 20261103140000_db010_auditlog_append_only duplicates three facts
 * from code into SQL row policies on AuditLog:
 *   · fm_system_retain   (DELETE): action IN PRODUCT_EVENT_ACTIONS,
 *                                  older than PRODUCT_EVENT_RETENTION_MONTHS months;
 *   · fm_system_minimise (UPDATE): action = BETA_INTAKE_AUDIT_ACTION,
 *                                  older than BETA_INTAKE_NETWORK_DAYS days.
 * A later change to any constant must fail here until a follow-up migration
 * moves the policy with it — otherwise the job silently stops matching rows
 * (count 0) or the DB starts admitting rows the job never meant to touch.
 *
 * Parses the migration SQL (no database). Design: docs/operations/database-safety.md §4e.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/auditlog-append-only-policy.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PRODUCT_EVENT_ACTIONS } from "@/lib/audit-actions";
import { PRODUCT_EVENT_RETENTION_MONTHS } from "./product-event-retention";
import { BETA_INTAKE_AUDIT_ACTION, BETA_INTAKE_NETWORK_DAYS } from "./data-retention";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const MIGRATIONS = path.join(process.cwd(), "prisma", "migrations");
const NAME = "20261103140000_db010_auditlog_append_only";
const raw = readFileSync(path.join(MIGRATIONS, NAME, "migration.sql"), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");

/** The full text of `CREATE POLICY <name> ON public."AuditLog" … ;`, or null. */
function policy(name: string): string | null {
  const m = new RegExp(`CREATE\\s+POLICY\\s+${name}\\s+ON\\s+public\\."AuditLog"([\\s\\S]*?);`, "i").exec(sql);
  return m ? m[1] : null;
}
const intervals = (body: string) => [...body.matchAll(/interval\s+'(\d+)\s+(\w+)'/gi)].map((m) => ({ n: Number(m[1]), unit: m[2].toLowerCase() }));

console.log("\nDB-010 AuditLog append-only — SQL ↔ code drift pin\n");

// ── DELETE: product-event retention ──────────────────────────────────────────
const retain = policy("fm_system_retain");
check("fm_system_retain exists", retain !== null);
if (retain) {
  check("fm_system_retain is FOR DELETE TO fm_system", /^\s*FOR\s+DELETE\s+TO\s+fm_system\s+USING/i.test(retain), retain.slice(0, 80));
  check("fm_system_retain has no WITH CHECK (DELETE has no post-image)", !/WITH\s+CHECK/i.test(retain));
  const inList = /action\s+IN\s*\(([\s\S]*?)\)/i.exec(retain)?.[1] ?? "";
  const sqlActions = [...inList.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const code = [...PRODUCT_EVENT_ACTIONS];
  check("the DELETE action list has no duplicates", new Set(sqlActions).size === sqlActions.length, sqlActions.join(","));
  check(`the DELETE action set equals PRODUCT_EVENT_ACTIONS (${code.length})`,
    sqlActions.length === code.length && [...sqlActions].sort().join(",") === [...code].sort().join(","),
    `sql=[${[...sqlActions].sort().join(",")}] code=[${[...code].sort().join(",")}]`);
  const iv = intervals(retain);
  check(`the DELETE window is exactly one interval of PRODUCT_EVENT_RETENTION_MONTHS (${PRODUCT_EVENT_RETENTION_MONTHS}) months`,
    iv.length === 1 && iv[0].n === PRODUCT_EVENT_RETENTION_MONTHS && /^months?$/.test(iv[0].unit), JSON.stringify(iv));
  check("the DELETE window is \"older than\" (createdAt < now() - interval)", /"createdAt"\s*<\s*now\(\)\s*-\s*interval/i.test(retain));
}

// ── UPDATE: beta-intake network minimisation ─────────────────────────────────
const minimise = policy("fm_system_minimise");
check("fm_system_minimise exists", minimise !== null);
if (minimise) {
  check("fm_system_minimise is FOR UPDATE TO fm_system", /^\s*FOR\s+UPDATE\s+TO\s+fm_system\s+USING/i.test(minimise), minimise.slice(0, 80));
  const using = /USING\s*\(([\s\S]*?)\)\s*WITH\s+CHECK/i.exec(minimise)?.[1] ?? "";
  const check_ = /WITH\s+CHECK\s*\(([\s\S]*)\)\s*$/i.exec(minimise)?.[1] ?? "";
  const actions = [...using.matchAll(/action\s*=\s*'([^']+)'/gi)].map((m) => m[1]);
  check(`the UPDATE predicate's action equals BETA_INTAKE_AUDIT_ACTION (${BETA_INTAKE_AUDIT_ACTION})`,
    actions.length === 1 && actions[0] === BETA_INTAKE_AUDIT_ACTION && !/\bIN\s*\(/i.test(using), JSON.stringify(actions));
  const iv = intervals(using);
  check(`the UPDATE window is exactly one interval of BETA_INTAKE_NETWORK_DAYS (${BETA_INTAKE_NETWORK_DAYS}) days`,
    iv.length === 1 && iv[0].n === BETA_INTAKE_NETWORK_DAYS && /^days?$/.test(iv[0].unit), JSON.stringify(iv));
  check("the UPDATE window is \"older than\" (createdAt < now() - interval)", /"createdAt"\s*<\s*now\(\)\s*-\s*interval/i.test(using));
  check("the UPDATE post-image must be minimised (ipAddress AND userAgent IS NULL)",
    /"ipAddress"\s+IS\s+NULL/i.test(check_) && /"userAgent"\s+IS\s+NULL/i.test(check_) && !/\bOR\b/i.test(check_), check_);
}

// ── grants: column UPDATE is exactly the minimisation's columns ──────────────
check("table-wide UPDATE, DELETE is revoked from fm_system",
  /REVOKE\s+UPDATE\s*,\s*DELETE\s+ON\s+TABLE\s+public\."AuditLog"\s+FROM\s+fm_system\s*;/i.test(sql));
const colGrant = /GRANT\s+UPDATE\s*\(([^)]*)\)\s+ON\s+TABLE\s+public\."AuditLog"\s+TO\s+fm_system\s*;/i.exec(sql)?.[1] ?? "";
const cols = [...colGrant.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
check("the column UPDATE grant is exactly ipAddress, userAgent, metadata", cols.join(",") === "ipAddress,metadata,userAgent", cols.join(","));
check("no table-wide UPDATE is granted to fm_system", !/GRANT\s+[^;(]*\bUPDATE\b\s*(,[^;(]*)?\s+ON\s+TABLE\s+public\."AuditLog"/i.test(sql.replace(/GRANT\s+UPDATE\s*\([^)]*\)/gi, "")));
check("fm_system_all is dropped", /DROP\s+POLICY\s+fm_system_all\s+ON\s+public\."AuditLog"\s*;/i.test(sql));
check("no FOR ALL policy is (re)created on AuditLog", !/CREATE\s+POLICY\s+\w+\s+ON\s+public\."AuditLog"\s+FOR\s+ALL/i.test(sql));
check("fm_app / fm_auth / fm_backup are not touched", !/\bfm_(app|auth|backup)\b/.test(sql));

// ── no later migration silently moves the AuditLog fm_system policies ────────
const later = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name > NAME)
  .filter((e) => {
    try {
      const s = readFileSync(path.join(MIGRATIONS, e.name, "migration.sql"), "utf8").replace(/--[^\n]*/g, "");
      return /POLICY\s+fm_system_\w+\s+ON\s+public\."AuditLog"/i.test(s) || /ON\s+(TABLE\s+)?public\."AuditLog"\s+(TO|FROM)\s+fm_system/i.test(s);
    } catch { return false; }
  })
  .map((e) => e.name);
check("no later migration re-touches AuditLog fm_system grants/policies (else move this pin to it)", later.length === 0, later.join(", "));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
