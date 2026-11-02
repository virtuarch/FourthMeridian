/**
 * scripts/db-backup.ts  (Recovery/Hardening slice)
 *
 * Take a timestamped pg_dump of the current database into `backups/` (gitignored).
 * This is the FIRST step of any migration/reset workflow — the local DB holds
 * REAL personal test data (Plaid connections, sync history, manual config), so it
 * is treated as valuable state, not disposable.
 *
 *   npm run db:backup
 *
 * Uses host pg_dump against the MUTATION TARGET — the database the next command
 * will change: DIRECT_URL when schema.prisma routes Prisma Migrate through it,
 * else DATABASE_URL (FM-AUDIT-002). It refuses, exactly as scripts/db-guard.ts
 * does, when DATABASE_URL and DIRECT_URL are not provably the same database: a
 * backup of the wrong database is worse than none, because it reads as a safety
 * net. (Newer pg_dump can dump an older server, so a homebrew pg_dump vs the pg16
 * container is fine.) Fails loudly rather than silently producing an empty/partial
 * dump.
 *
 * Row-for-row verification is SNAPSHOT-CONSISTENT (2026-11-01): one held
 * REPEATABLE READ, READ ONLY transaction exports its snapshot, pg_dump imports
 * it (--snapshot), and each table's count(*) is read afterwards in that same
 * transaction — so a LIVE database (crons writing) verifies exactly, with no
 * cron pause. Requires a session-mode connection (Supabase :5432 / DIRECT_URL);
 * a transaction pooler (:6543) fails loudly and never falls back to the racy
 * live comparison. Mechanism and tests: scripts/lib/db-backup.core.ts,
 * scripts/db-backup.test.ts.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { processMutationAuthority, schemaRequiresDirectUrl } from "@/lib/db/target-identity";
import { openPsqlSnapshotSession, runSnapshotBackup } from "./lib/db-backup.core";

function fail(msg: string): never {
  console.error(`\n✗ db:backup — ${msg}\n`);
  process.exit(1);
}

const requireDirect = schemaRequiresDirectUrl(readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8"));
const authority = processMutationAuthority(requireDirect);
if (!authority.ok) fail([...authority.reasons, "", ...authority.hint].join("\n  "));
const target = authority.target;
const dbName = target.identity.database;
// Strip Prisma-only query params (?schema=…, ?pgbouncer=…) that pg_dump doesn't understand.
const cleanUrl = target.url.split("?")[0];

const dir = path.join(process.cwd(), "backups");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(dir, `${dbName}-${stamp}.sql`);

function runPgDump(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pg_dump", args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code, signal) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code ?? signal}`))));
  });
}

// ── RLS-3 — A BYTE FLOOR IS NOT A COMPLETENESS CHECK ─────────────────────────
//
// Row-level security applies to pg_dump exactly as it does to any other client.
// Under FORCE ROW LEVEL SECURITY, a role without BYPASSRLS either fails outright
// ("query would be affected by row-level security policy") or, with
// --enable-row-security, SILENTLY WRITES A PARTIAL DUMP. A partial dump of a
// financial database sails past a 100-byte floor and looks like a backup right
// up until the restore.
//
// So the dump is verified by COUNTING. For each table that carries rows in the
// dump's own snapshot, the dump must contain a COPY block with the same number
// of data lines. A table that is non-empty in the snapshot but empty, short or
// missing here is a silently truncated dump, and that is a hard failure. The
// counts are read inside the snapshot pg_dump used (runSnapshotBackup), so
// writers that commit during the dump cannot cause a false failure.
async function main(): Promise<void> {
  console.log(`db:backup — dumping ${target.identity.display} (via ${target.source}) → backups/${path.basename(outFile)} …`);
  const r = await runSnapshotBackup(
    {
      openSnapshotSession: () => openPsqlSnapshotSession(cleanUrl),
      runPgDump,
      readDump: () => readFileSync(outFile, "utf8"),
      dumpBytes: () => statSync(outFile).size,
    },
    { outFile, cleanUrl, source: target.source },
  );
  if (!r.ok) fail(r.message);

  console.log(`  verified row-for-row across ${r.checked} non-empty table(s), in the dump's own snapshot (${r.snapshotId}).`);
  console.log(`✓ db:backup — wrote backups/${path.basename(outFile)} (${(r.bytes / 1024).toFixed(1)} KB).`);
  // A pg_dump newer than the server emits `SET transaction_timeout`, which PG16 rejects
  // (docs/operations/database-safety.md §4) — the restore line filters it.
  console.log(`  Restore with:  grep -v '^SET transaction_timeout' backups/${path.basename(outFile)} | psql "$${target.source}"`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
