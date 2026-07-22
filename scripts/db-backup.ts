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
 * Uses host pg_dump against DATABASE_URL (newer pg_dump can dump an older server,
 * so a homebrew pg_dump vs the pg16 container is fine). Fails loudly rather than
 * silently producing an empty/partial dump.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";

function fail(msg: string): never {
  console.error(`\n✗ db:backup — ${msg}\n`);
  process.exit(1);
}

const raw = process.env.DATABASE_URL;
if (!raw) fail("DATABASE_URL is not set. Load your env (e.g. `set -a; . ./.env; set +a`).");

// Strip Prisma-only query params (?schema=…) that pg_dump doesn't understand.
let dbName = "database";
try {
  const u = new URL(raw!);
  dbName = u.pathname.replace(/^\//, "") || "database";
} catch {
  fail("DATABASE_URL is not a valid URL.");
}
const cleanUrl = raw!.split("?")[0];

const dir = path.join(process.cwd(), "backups");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(dir, `${dbName}-${stamp}.sql`);

console.log(`db:backup — dumping "${dbName}" → backups/${path.basename(outFile)} …`);
try {
  // --no-owner/--no-privileges keep the dump restorable across roles.
  execFileSync("pg_dump", ["--no-owner", "--no-privileges", "-f", outFile, cleanUrl], {
    stdio: ["ignore", "inherit", "inherit"],
  });
} catch {
  fail("pg_dump failed. Is Postgres running and reachable at DATABASE_URL? Is pg_dump installed (brew install libpq)?");
}

const bytes = statSync(outFile).size;
if (bytes < 100) fail(`the dump is suspiciously small (${bytes} bytes) — treating as failed.`);
console.log(`✓ db:backup — wrote backups/${path.basename(outFile)} (${(bytes / 1024).toFixed(1)} KB).`);
console.log(`  Restore with:  psql "$DATABASE_URL" < backups/${path.basename(outFile)}`);
