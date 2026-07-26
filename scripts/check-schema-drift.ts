/**
 * scripts/check-schema-drift.ts  (SCHEDULER-DISPATCH-RESTORE-1)
 *
 * Operator CLI that answers one question: does the migration history on disk
 * match what the target database has actually applied?
 *
 *   npx tsx scripts/check-schema-drift.ts          # or: npm run db:drift
 *
 * Read-only (one SELECT against _prisma_migrations; writes nothing). Exits 0
 * when the database is in step, 1 on any drift.
 *
 * WHY THIS EXISTS. `vercel.json` deploys code; nothing deploys schema. The build
 * command is `prisma generate && next build`, so a production deploy carrying a
 * new migration ships the CODE that depends on the column and leaves the COLUMN
 * unapplied until someone remembers to run `db:migrate:safe` by hand. On
 * 2026-07-26 that gap ran for ten hours: production served 07-26 code against an
 * 07-22 schema, eight migrations behind, with `RefreshExecution`,
 * `RefreshEndpointResult`, `ProviderCall` and `SyncIssueOccurrence` simply absent.
 *
 * It was invisible because the code that touched the missing columns was exactly
 * the code designed never to complain: both operational ledgers write best-effort
 * and swallow their own failures. Ten registered jobs ran normally and recorded
 * nothing, and the dispatcher returned 200 the entire time.
 *
 * So this is the PRE/POST-DEPLOY check, and captureLedgerWriteFailure
 * (lib/monitoring/capture.ts) is the runtime one. Two different moments: this
 * catches drift before it can mislead anyone; the Sentry path catches drift that
 * reached production anyway.
 *
 * DELIBERATELY A SCRIPT, NOT A ROUTE. The migration list lives on disk in
 * prisma/migrations/, which is not traced into the serverless bundle — a runtime
 * surface would have to be fed a generated manifest and would then be asserting
 * against a build artifact rather than against the repository. An operator CLI
 * reads the real directory, runs against any DATABASE_URL, and can gate a deploy.
 *
 * DELIBERATELY NOT: applying anything, repairing _prisma_migrations, or reading
 * schema.prisma. It compares two ledgers of migration NAMES and reports. Applying
 * is `npm run db:migrate:safe`, which takes a backup first.
 */

import { readdirSync } from "node:fs";
import path from "node:path";

import { db } from "@/lib/db";

/** Migration directories are the on-disk source of truth for intended history. */
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

/** Directory names under prisma/migrations, lexicographic = apply order. */
function migrationsOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Redacted target label — host and database only, never credentials. */
function targetLabel(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "(DATABASE_URL not set)";
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  const onDisk = migrationsOnDisk();

  const rows = await db.$queryRaw<MigrationRow[]>`
    SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations
  `;

  // A migration counts as applied only when it FINISHED and was not rolled back.
  // A started-but-unfinished row is drift of a nastier kind than a missing one:
  // it means an apply died partway, so it is reported separately rather than
  // being folded into "pending".
  const applied = new Set(
    rows.filter((r) => r.finished_at !== null && r.rolled_back_at === null).map((r) => r.migration_name),
  );
  const unfinished = rows.filter((r) => r.finished_at === null && r.rolled_back_at === null);
  const rolledBack = rows.filter((r) => r.rolled_back_at !== null);

  const pending = onDisk.filter((name) => !applied.has(name));
  // Present in the database, absent from the repository — a checkout older than
  // the database, or a hand-applied migration. Never silently ignored.
  const unknown = [...applied].filter((name) => !onDisk.includes(name)).sort();

  console.log(`schema drift check → ${targetLabel()}`);
  console.log(`  ${onDisk.length} migration(s) on disk · ${applied.size} applied\n`);

  if (pending.length > 0) {
    console.error(`  ✗ ${pending.length} migration(s) NOT applied to this database:`);
    for (const name of pending) console.error(`      ${name}`);
  }
  if (unfinished.length > 0) {
    console.error(`\n  ✗ ${unfinished.length} migration(s) started but never finished:`);
    for (const r of unfinished) console.error(`      ${r.migration_name}`);
  }
  if (rolledBack.length > 0) {
    console.error(`\n  ✗ ${rolledBack.length} migration(s) recorded as rolled back:`);
    for (const r of rolledBack) console.error(`      ${r.migration_name}`);
  }
  if (unknown.length > 0) {
    console.error(`\n  ✗ ${unknown.length} applied migration(s) absent from prisma/migrations/:`);
    for (const name of unknown) console.error(`      ${name}`);
  }

  if (pending.length || unfinished.length || rolledBack.length || unknown.length) {
    console.error(
      "\nDRIFT — this database does not match the repository's migration history." +
        "\nDeployed code may reference columns or tables that do not exist here." +
        "\nApply with:  npm run db:migrate:safe   (backs up first, then migrate deploy)",
    );
    process.exit(1);
  }

  console.log("  ✓ in step — every migration on disk is applied, and nothing extra");
  process.exit(0);
}

main().catch((err) => {
  console.error("[check-schema-drift] failed:", err);
  process.exit(1);
});
