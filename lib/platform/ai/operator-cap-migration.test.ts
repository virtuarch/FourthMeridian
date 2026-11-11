/**
 * lib/platform/ai/operator-cap-migration.test.ts  (D5 PR3 — the operator cap table, parse-pinned)
 *
 * prisma/migrations/20261111120000_platform_ai_operator_cap creates the additive
 * PlatformAiOperatorCap table (nothing reads it yet). This test parses the SQL
 * and the schema model and pins:
 *   · the place in history (sorts after every earlier migration), lock_timeout;
 *   · RLS ENABLE + FORCE, and the one fm_system_all policy;
 *   · grants: fm_system SELECT, INSERT, UPDATE, DELETE; fm_backup SELECT; REVOKE
 *     ALL from fm_app / fm_auth / fm_system first; NO grant or policy for fm_app
 *     or fm_auth (or any other role);
 *   · the CHECK bounds 0..20 = PLATFORM_AI_OPERATOR_CAP_CEILING_USD (S2 R4);
 *   · userId ON DELETE CASCADE, updatedById ON DELETE SET NULL (SQL and schema);
 *   · no data backfill (no INSERT / UPDATE / DELETE / COPY statements).
 *
 *   npx tsx lib/platform/ai/operator-cap-migration.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PLATFORM_AI_OPERATOR_CAP_CEILING_USD } from "./platform-ai-spend.core";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const MIGRATION = "20261111120000_platform_ai_operator_cap";
const T = `"PlatformAiOperatorCap"`;
const raw = readFileSync(path.join(ROOT, "prisma/migrations", MIGRATION, "migration.sql"), "utf8");
const sql = raw.replace(/--[^\n]*/g, "");
const flat = sql.replace(/\s+/g, " ");
const statements = flat.split(";").map((s) => s.trim()).filter(Boolean);

console.log("place in history");
{
  const names = readdirSync(path.join(ROOT, "prisma/migrations"), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  check("the migration is the LAST in sorted order at authoring time or later (never back-dated)",
    names.indexOf(MIGRATION) > names.indexOf("20261110120000_platform_ai_operational_memory"));
  check("lock_timeout is set before any DDL (the FKs lock \"User\" briefly)",
    /SET LOCAL lock_timeout = '\d+s'/.test(flat) && flat.indexOf("lock_timeout") < flat.indexOf("CREATE TABLE"));
}

console.log("RLS");
{
  check("ENABLE ROW LEVEL SECURITY", flat.includes(`ALTER TABLE public.${T} ENABLE ROW LEVEL SECURITY`));
  check("FORCE ROW LEVEL SECURITY", flat.includes(`ALTER TABLE public.${T} FORCE ROW LEVEL SECURITY`));
  check("no DISABLE / NO FORCE", !/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i.test(flat));
  const policies = [...flat.matchAll(/CREATE POLICY (\w+) ON public\."PlatformAiOperatorCap" FOR (\w+) TO (\w+)/g)];
  check("exactly one policy: fm_system_all FOR ALL TO fm_system",
    policies.length === 1 && policies[0][1] === "fm_system_all" && policies[0][2] === "ALL" && policies[0][3] === "fm_system",
    policies.map((p) => p[0]).join(" | "));
}

console.log("grants — fm_system only (+ fm_backup dump SELECT)");
{
  const grants = statements.filter((s) => /^GRANT\b/i.test(s));
  check("exactly two GRANT statements", grants.length === 2, grants.join(" | "));
  check("fm_system: SELECT, INSERT, UPDATE, DELETE",
    grants.includes(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${T} TO fm_system`));
  check("fm_backup: SELECT only (complete dumps)", grants.includes(`GRANT SELECT ON TABLE public.${T} TO fm_backup`));
  check("no GRANT to fm_app or fm_auth", !grants.some((g) => /\bTO\b.*\bfm_(app|auth)\b/.test(g)));
  check("no fm_app anywhere except its REVOKE",
    statements.filter((s) => /\bfm_app\b/.test(s)).every((s) => s === `REVOKE ALL ON TABLE public.${T} FROM fm_app`)
    && statements.some((s) => s === `REVOKE ALL ON TABLE public.${T} FROM fm_app`));
  for (const role of ["fm_app", "fm_auth", "fm_system"]) {
    const rev = flat.indexOf(`REVOKE ALL ON TABLE public.${T} FROM ${role};`);
    check(`REVOKE ALL FROM ${role} precedes every GRANT`, rev >= 0 && rev < flat.indexOf("GRANT "));
  }
  check("Data API roles revoked (anon, authenticated, service_role)",
    flat.includes(`REVOKE ALL ON TABLE public.${T} FROM anon, authenticated, service_role`));
  check("no function, trigger or SECURITY DEFINER", !/CREATE (OR REPLACE )?(FUNCTION|TRIGGER)|SECURITY DEFINER/i.test(flat));
}

console.log("CHECK bounds");
{
  const m = /CONSTRAINT "PlatformAiOperatorCap_dailyUsd_range" CHECK \("dailyUsd" >= (\d+) AND "dailyUsd" <= (\d+)\)/.exec(flat);
  check("CHECK 0 <= dailyUsd <= ceiling is present", m !== null);
  check("lower bound is 0", m?.[1] === "0", m?.[1]);
  check(`upper bound = PLATFORM_AI_OPERATOR_CAP_CEILING_USD (${PLATFORM_AI_OPERATOR_CAP_CEILING_USD}, S2 R4)`,
    Number(m?.[2]) === PLATFORM_AI_OPERATOR_CAP_CEILING_USD && PLATFORM_AI_OPERATOR_CAP_CEILING_USD === 20, m?.[2]);
  check("dailyUsd is INTEGER NOT NULL", /"dailyUsd" INTEGER NOT NULL/.test(flat));
}

console.log("delete behaviour");
{
  check("userId → User ON DELETE CASCADE",
    flat.includes(`FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE`));
  check("updatedById → User ON DELETE SET NULL (nullable column)",
    flat.includes(`FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL`) && /"updatedById" TEXT,/.test(flat));
  check("userId is the primary key (one cap per operator)", flat.includes(`CONSTRAINT "PlatformAiOperatorCap_pkey" PRIMARY KEY ("userId")`));
  const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const model = /^model PlatformAiOperatorCap \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? "";
  check("schema: userId @id, relation onDelete: Cascade",
    /^\s*userId\s+String\s+@id\b/m.test(model) && /\buser\s+User\s+@relation\([^)]*fields: \[userId\][^)]*onDelete: Cascade/.test(model));
  check("schema: updatedById String?, relation onDelete: SetNull",
    /^\s*updatedById\s+String\?/m.test(model) && /\bupdatedBy\s+User\?\s+@relation\([^)]*fields: \[updatedById\][^)]*onDelete: SetNull/.test(model));
}

console.log("additive, no backfill");
{
  check("no DML (INSERT / UPDATE / DELETE / COPY statements)",
    !statements.some((s) => /^(INSERT|UPDATE|DELETE|COPY|TRUNCATE)\b/i.test(s)));
  check("no DROP and no ALTER of any other table",
    !/\bDROP\b/i.test(flat) && [...flat.matchAll(/ALTER TABLE (?:public\.)?("?\w+"?)/g)].every((a) => a[1] === T));
  check("exactly one CREATE TABLE", (flat.match(/CREATE TABLE/g) ?? []).length === 1);
}

if (failures > 0) { console.error(`\n❌ operator cap migration: ${failures} check(s) failed`); process.exit(1); }
console.log("\n✅ operator cap migration: all checks passed");
