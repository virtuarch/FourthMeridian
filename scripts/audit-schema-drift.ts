/**
 * scripts/audit-schema-drift.ts — REQUIRED (DB-008): prisma/migrations and
 * prisma/schema.prisma describe the same database.
 *
 * Creates a throwaway shadow database on the SAME local server as DATABASE_URL
 * (CI's postgres service container), runs `prisma migrate diff --from-migrations
 * … --to-schema-datamodel …`, drops the shadow, and fails on any statement.
 * Refuses non-local servers before connecting (scripts/lib/schema-drift.ts).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { driftStatements, shadowServerAllowed, shadowUrl } from "./lib/schema-drift";

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  const allowed = shadowServerAllowed(url);
  if (!allowed.ok) { console.error(`  ✗ audit-schema-drift: ${allowed.reason}`); return 1; }
  const name = `fintracker_driftshadow_${randomBytes(4).toString("hex")}`;
  const admin = new PrismaClient({ datasourceUrl: url, log: [] });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } catch (e) {
    console.error(`  ✗ audit-schema-drift: could not create the shadow database: ${(e as Error).message}`);
    await admin.$disconnect();
    return 1;
  }
  try {
    const r = spawnSync("npx", ["prisma", "migrate", "diff",
      "--from-migrations", "prisma/migrations",
      "--to-schema-datamodel", "prisma/schema.prisma",
      "--shadow-database-url", shadowUrl(url!, name),
      "--script"], { encoding: "utf8", env: { ...process.env } });
    if (r.status !== 0) {
      console.error(`  ✗ audit-schema-drift: prisma migrate diff failed (exit ${r.status})\n${r.stderr}`);
      return 1;
    }
    const stmts = driftStatements(r.stdout);
    if (stmts.length === 0) {
      console.log("  ✓ prisma/migrations and prisma/schema.prisma describe the same database (0 drift statements)");
      return 0;
    }
    console.error(`  ✗ ${stmts.length} drift statement(s) between migrations and schema — add a migration or fix the schema:`);
    for (const s of stmts) console.error(`      ${s}`);
    return 1;
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect();
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
