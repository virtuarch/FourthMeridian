/**
 * scripts/platform-ai-conversations-precheck.ts — Platform AI conversations PRE-ENABLE CHECK (READ-ONLY)
 *
 * S2 REQUIRED 2 (docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §2.4, §12).
 * Run on Preview AFTER the migration is applied and BEFORE any of
 * PLATFORM_AI_CONVERSATIONS_ENABLED / PLATFORM_AI_PURGE_ENABLED is set. Proves
 * on the live target that the owner of fm_purge_platform_ai_conversations and
 * of fm_platform_ai_touch_conversation has rolbypassrls (pg_proc.proowner →
 * pg_roles), that the settle and soft-delete triggers are SECURITY INVOKER,
 * that only fm_system may EXECUTE the purge, and that both tables are FORCE
 * RLS with no fm_system table privilege. Record the output in the PR D enable
 * checklist.
 *
 * It WRITES NOTHING and reads only the catalog (no conversation row). One
 * transaction, opened with `SET TRANSACTION READ ONLY` (never a session SET).
 *
 *   npm run report:platform-ai-conversations-precheck -- --env=preview
 *
 * Gates (before the first database contact): --env=<local|preview|production>
 * is REQUIRED and the connection must prove it (scripts/lib/repair-env-guard.ts);
 * --env=production also needs --acknowledge-production-read (a safety rail,
 * NOT approval — reading Production is owner-approved).
 *
 * PR D — `--phase=pre-disable` (S2 disable order, design §13): before
 * PLATFORM_AI_PURGE_ENABLED is unset, prove no conversation row remains — two
 * COUNTS read by a principal that bypasses RLS (else FAIL: under FORCE RLS a
 * non-bypassing reader sees 0 and would fake an empty table). Same gates, same
 * read-only transaction.
 *
 *   npm run report:platform-ai-conversations-precheck -- --env=preview --phase=pre-disable
 *
 * Exit: 0 PASS · 3 FAIL · 2 refused (nothing read) · 1 could not run.
 */

import { decideRepairEnvGuard, redactConnectionDetails } from "./lib/repair-env-guard";
import {
  PRECHECK_FUNCTIONS_SQL, PRECHECK_READ_ONLY_STATEMENT, PRECHECK_TABLES_SQL, PREDISABLE_SQL,
  evaluatePrecheck, evaluatePredisable, parsePrecheckPhase, renderPrecheck, renderPredisable,
  type FunctionRow, type PredisableRow, type TableRow,
} from "./lib/platform-ai-conversations-precheck.core";

const KNOWN_FLAGS = new Set(["env", "acknowledge-production-read", "phase"]);
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
  const phase = parsePrecheckPhase(args);
  if (!phase) refuse(["--phase must be given at most once, as exactly `pre-enable` or `pre-disable`."]);
  const envArg = args.find((a) => a.startsWith("--env="));
  const envFlag = envArg ? envArg.slice("--env=".length) : null;
  if (!envFlag) refuse(["--env=<local|preview|production> is required."]);
  if (envFlag === "production" && !args.includes(PRODUCTION_ACK_FLAG)) {
    refuse([`--env=production requires ${PRODUCTION_ACK_FLAG}. Reading Production is OWNER-APPROVED: the flag is a safety rail, NOT approval.`]);
  }
  if (envFlag !== "production" && args.includes(PRODUCTION_ACK_FLAG)) {
    refuse([`${PRODUCTION_ACK_FLAG} is only meaningful with --env=production.`]);
  }
  const gate = decideRepairEnvGuard({
    apply: false, envFlag, databaseUrl: process.env.DATABASE_URL, directUrl: process.env.DIRECT_URL,
    productionRef: process.env.FM_PRODUCTION_DB_REF, vercelEnv: process.env.VERCEL_ENV, env: process.env,
  });
  if (!gate.ok) refuse(gate.reasons);

  // Imported only after the gates: constructing the client is the first contact with any database.
  const { db } = await import("@/lib/db");
  try {
    if (phase === "pre-disable") {
      const rows = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(PRECHECK_READ_ONLY_STATEMENT);
        return tx.$queryRawUnsafe<PredisableRow[]>(PREDISABLE_SQL);
      }, { maxWait: 10_000, timeout: 60_000 });
      const v = evaluatePredisable(rows);
      console.log(`\n${renderPredisable(gate.env ?? envFlag!, new Date().toISOString(), v)}\n`);
      process.exitCode = v.ok ? 0 : 3;
      return;
    }
    const { fns, tables } = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(PRECHECK_READ_ONLY_STATEMENT);
      return {
        fns: await tx.$queryRawUnsafe<FunctionRow[]>(PRECHECK_FUNCTIONS_SQL),
        tables: await tx.$queryRawUnsafe<TableRow[]>(PRECHECK_TABLES_SQL),
      };
    }, { maxWait: 10_000, timeout: 60_000 });
    const verdict = evaluatePrecheck(fns, tables);
    console.log(`\n${renderPrecheck(gate.env ?? envFlag!, new Date().toISOString(), verdict)}\n`);
    process.exitCode = verdict.ok ? 0 : 3;
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(redactConnectionDetails(e instanceof Error ? e.message : String(e), [process.env.FM_PRODUCTION_DB_REF]));
  process.exit(1);
});
