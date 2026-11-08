/**
 * scripts/platform-ai-memory-precheck.ts — Platform AI operational memory PRE-ENABLE CHECK (READ-ONLY)
 *
 * Design v2 §6 / D1 (S2-approved 2026-11-08). Run on Preview AFTER migration
 * 20261110120000_platform_ai_operational_memory is applied and BEFORE either of
 * PLATFORM_AI_MEMORY_PURGE_ENABLED / PLATFORM_AI_MEMORY_ENABLED is set. It
 * verifies the SECURITY DEFINER inventory the migration adds, the table's RLS
 * and grants (O1 (b): no fm_app UPDATE on "deletedAt"), and the 7-day transcript
 * retention as the database holds it (D1). Record the output in the enable
 * checklist. Core: scripts/lib/platform-ai-memory-precheck.core.ts.
 *
 * It WRITES NOTHING and reads only the catalog (no memory or conversation row).
 * One transaction, opened with `SET TRANSACTION READ ONLY` (never a session SET).
 *
 *   npm run report:platform-ai-memory-precheck -- --env=preview
 *
 * Gates (before the first database contact): --env=<local|preview|production>
 * is REQUIRED and the connection must prove it (scripts/lib/repair-env-guard.ts);
 * --env=production also needs --acknowledge-production-read (a safety rail, NOT
 * approval — memory is Preview only).
 *
 * Exit: 0 PASS · 3 FAIL · 2 refused (nothing read) · 1 could not run.
 */

import { decideRepairEnvGuard, redactConnectionDetails } from "./lib/repair-env-guard";
import {
  MEMORY_PRECHECK_FUNCTIONS_SQL, MEMORY_PRECHECK_READ_ONLY_STATEMENT, MEMORY_PRECHECK_RETENTION_SQL, MEMORY_PRECHECK_TABLE_SQL,
  evaluateMemoryPrecheck, renderMemoryPrecheck,
  type MemoryFunctionRow, type MemoryRetentionRow, type MemoryTableRow,
} from "./lib/platform-ai-memory-precheck.core";

const KNOWN_FLAGS = new Set(["env", "acknowledge-production-read"]);
const PRODUCTION_ACK_FLAG = "--acknowledge-production-read";

function refuse(reasons: string[]): never {
  console.error("\n  REFUSED — nothing was read.");
  for (const r of reasons) console.error(`    · ${r}`);
  console.error("");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !a.startsWith("--") || !KNOWN_FLAGS.has(a.replace(/^--/, "").split("=")[0]));
  if (unknown.length) refuse([`unknown argument(s): ${unknown.map((a) => a.split("=")[0]).join(", ")} — refusing rather than guessing.`]);
  const envArg = args.find((a) => a.startsWith("--env="));
  const envFlag = envArg ? envArg.slice("--env=".length) : null;
  if (!envFlag) refuse(["--env=<local|preview|production> is required."]);
  if (envFlag === "production" && !args.includes(PRODUCTION_ACK_FLAG)) {
    refuse([`--env=production requires ${PRODUCTION_ACK_FLAG}. Reading Production is OWNER-APPROVED: the flag is a safety rail, NOT approval.`]);
  }
  if (envFlag !== "production" && args.includes(PRODUCTION_ACK_FLAG)) refuse([`${PRODUCTION_ACK_FLAG} is only meaningful with --env=production.`]);
  const gate = decideRepairEnvGuard({
    apply: false, envFlag, databaseUrl: process.env.DATABASE_URL, directUrl: process.env.DIRECT_URL,
    productionRef: process.env.FM_PRODUCTION_DB_REF, vercelEnv: process.env.VERCEL_ENV, env: process.env,
  });
  if (!gate.ok) refuse(gate.reasons);

  // Imported only after the gates: constructing the client is the first contact with any database.
  const { db } = await import("@/lib/db");
  try {
    const { fns, tables, retention } = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(MEMORY_PRECHECK_READ_ONLY_STATEMENT);
      return {
        fns: await tx.$queryRawUnsafe<MemoryFunctionRow[]>(MEMORY_PRECHECK_FUNCTIONS_SQL),
        tables: await tx.$queryRawUnsafe<MemoryTableRow[]>(MEMORY_PRECHECK_TABLE_SQL),
        retention: await tx.$queryRawUnsafe<MemoryRetentionRow[]>(MEMORY_PRECHECK_RETENTION_SQL),
      };
    }, { maxWait: 10_000, timeout: 60_000 });
    const verdict = evaluateMemoryPrecheck(fns, tables, retention);
    console.log(`\n${renderMemoryPrecheck(gate.env ?? envFlag!, new Date().toISOString(), verdict)}\n`);
    process.exitCode = verdict.ok ? 0 : 3;
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(redactConnectionDetails(e instanceof Error ? e.message : String(e), [process.env.FM_PRODUCTION_DB_REF]));
  process.exit(1);
});
