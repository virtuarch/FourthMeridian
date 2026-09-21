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
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { processMutationAuthority, schemaRequiresDirectUrl } from "@/lib/db/target-identity";

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

console.log(`db:backup — dumping ${target.identity.display} (via ${target.source}) → backups/${path.basename(outFile)} …`);
try {
  // --no-owner/--no-privileges keep the dump restorable across roles.
  execFileSync("pg_dump", ["--no-owner", "--no-privileges", "-f", outFile, cleanUrl], {
    stdio: ["ignore", "inherit", "inherit"],
  });
} catch {
  fail(`pg_dump failed. Is Postgres running and reachable at ${target.source}? Is pg_dump installed (brew install libpq)?`);
}

const bytes = statSync(outFile).size;
if (bytes < 100) fail(`the dump is suspiciously small (${bytes} bytes) — treating as failed.`);
console.log(`✓ db:backup — wrote backups/${path.basename(outFile)} (${(bytes / 1024).toFixed(1)} KB).`);
// A pg_dump newer than the server emits `SET transaction_timeout`, which PG16 rejects
// (docs/operations/database-safety.md §4) — the restore line filters it.
console.log(`  Restore with:  grep -v '^SET transaction_timeout' backups/${path.basename(outFile)} | psql "$${target.source}"`);
