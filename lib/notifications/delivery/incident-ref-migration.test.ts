/**
 * lib/notifications/delivery/incident-ref-migration.test.ts  (Incident customer update, PR-C1 — parse-pinned)
 *
 * prisma/migrations/20261111140000_comms_delivery_incident_ref adds ONE nullable
 * soft-reference column, CommsDelivery."incidentId" (S2 rulings 09gg (c), 09gh).
 * This test parses the SQL and the schema model and pins:
 *   · the place in history (after 20261111120000), lock_timeout before the DDL;
 *   · exactly one statement besides SET LOCAL: ALTER TABLE "CommsDelivery" ADD
 *     COLUMN "incidentId" TEXT NULL — no default, no backfill;
 *   · ADDITIVE only: no DROP / ALTER COLUMN / RENAME, no DML (INSERT / UPDATE /
 *     DELETE / COPY / TRUNCATE), no index (09gh: a plain CREATE INDEX blocks writes
 *     on this write-hot table), no FK / REFERENCES, no function / trigger;
 *   · grants unchanged: no GRANT / REVOKE / POLICY / RLS statement; CommsDelivery's
 *     grants are table-level only (no column-list grant anywhere in history);
 *   · the schema model: `incidentId String?`, and no @@index naming it.
 *
 *   npx tsx lib/notifications/delivery/incident-ref-migration.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const MIGRATION = "20261111140000_comms_delivery_incident_ref";
const DIR = path.join(ROOT, "prisma/migrations");
const raw = readFileSync(path.join(DIR, MIGRATION, "migration.sql"), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");
const flat = sql.replace(/\s+/g, " ").trim();
const statements = flat.split(";").map((s) => s.trim()).filter(Boolean);

console.log("place in history");
{
  const names = readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  check("sorts after 20261111120000_platform_ai_operator_cap (never back-dated)",
    names.indexOf(MIGRATION) > names.indexOf("20261111120000_platform_ai_operator_cap") && names.indexOf("20261111120000_platform_ai_operator_cap") >= 0);
  check("lock_timeout is set before the DDL (ADD COLUMN takes a brief ACCESS EXCLUSIVE lock)",
    statements[0] === "SET LOCAL lock_timeout = '5s'", statements[0]);
}

console.log("additive only");
{
  check("exactly two statements: SET LOCAL + the one ADD COLUMN", statements.length === 2, statements.join(" | "));
  check("the column: ALTER TABLE \"CommsDelivery\" ADD COLUMN \"incidentId\" TEXT NULL (no default)",
    statements[1] === `ALTER TABLE "CommsDelivery" ADD COLUMN "incidentId" TEXT NULL`, statements[1]);
  check("no DEFAULT / NOT NULL", !/\bDEFAULT\b|\bNOT NULL\b/i.test(flat));
  check("no DROP, ALTER COLUMN or RENAME", !/\bDROP\b|ALTER\s+COLUMN|\bRENAME\b/i.test(flat));
  check("no DML (INSERT / UPDATE / DELETE / COPY / TRUNCATE) — no backfill", !/\b(INSERT|UPDATE|DELETE|COPY|TRUNCATE)\b/i.test(flat));
  check("no index (09gh)", !/CREATE\s+(UNIQUE\s+)?INDEX/i.test(flat));
  check("no foreign key (soft reference)", !/REFERENCES|FOREIGN KEY/i.test(flat));
  check("no function, trigger or SECURITY DEFINER", !/CREATE (OR REPLACE )?(FUNCTION|TRIGGER)|SECURITY DEFINER/i.test(flat));
}

console.log("grants unchanged");
{
  check("no GRANT / REVOKE / POLICY / RLS statement", !/\b(GRANT|REVOKE)\b|\bPOLICY\b|ROW LEVEL SECURITY/i.test(flat));
  const history = readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory())
    .map((e) => readFileSync(path.join(DIR, e.name, "migration.sql"), "utf8").replace(/--[^\n]*/g, "").replace(/\s+/g, " "));
  const cdGrants = history.flatMap((s) => s.split(";")).filter((s) => /\bGRANT\b/i.test(s) && /"CommsDelivery"(?!Daily)/.test(s)).map((s) => s.trim());
  check("CommsDelivery grants in history are table-level only (no column list a new column would miss)",
    cdGrants.length > 0 && cdGrants.every((g) => /^GRANT [A-Z, ]+ ON TABLE public\."CommsDelivery" TO \w+$/.test(g)), cdGrants.join(" | "));
  check("…exactly fm_system SELECT, INSERT, DELETE and fm_backup SELECT",
    cdGrants.sort().join(" | ") === [`GRANT SELECT ON TABLE public."CommsDelivery" TO fm_backup`, `GRANT SELECT, INSERT, DELETE ON TABLE public."CommsDelivery" TO fm_system`].sort().join(" | "),
    cdGrants.join(" | "));
}

console.log("schema model");
{
  const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const model = /model CommsDelivery \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
  check("CommsDelivery.incidentId String? (nullable, no default)", /\n\s*incidentId\s+String\?\s*(\/\/.*)?\n/.test(model) && !/incidentId[^\n]*@default/.test(model));
  check("no @@index on incidentId", !/@@index\(\[[^\]]*incidentId/.test(model));
  check("no relation on incidentId (soft ref)", !/@relation\([^)]*incidentId/.test(model));
}

if (failures > 0) { console.error(`\nincident-ref-migration.test: ${failures} failure(s).`); process.exit(1); }
console.log("\nincident-ref-migration.test: all passed.");
