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
// live database, the dump must contain a COPY block with the same number of
// data lines. A table that is present and non-empty upstream but empty or
// missing here is a silently truncated dump, and that is a hard failure.
{
  const sql = `
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relname <> '_prisma_migrations'
     order by 1`;
  const names = execFileSync("psql", ["-X", "-A", "-t", "-q", "--no-psqlrc", "-c", sql, cleanUrl], { encoding: "utf8" })
    .trim().split("\n").map((s) => s.trim()).filter(Boolean);

  const dump = readFileSync(outFile, "utf8");
  const mismatches: string[] = [];
  let checked = 0;

  for (const t of names) {
    const live = Number(
      execFileSync("psql", ["-X", "-A", "-t", "-q", "--no-psqlrc", "-c", `select count(*) from "${t}"`, cleanUrl],
        { encoding: "utf8" }).trim(),
    );
    if (!Number.isFinite(live) || live === 0) continue; // nothing to under-report
    checked++;

    // pg_dump writes:  COPY public."Name" (cols) FROM stdin;\n<rows>\n\\.
    const start = dump.indexOf(`COPY public."${t}" `);
    if (start === -1) { mismatches.push(`${t}: ${live} live rows, NO COPY block in the dump`); continue; }
    const from = dump.indexOf("\n", dump.indexOf("FROM stdin;", start)) + 1;
    const end  = dump.indexOf("\n\\.", from);
    const inDump = end <= from ? 0 : dump.slice(from, end).split("\n").length;
    if (inDump !== live) mismatches.push(`${t}: ${live} live rows, ${inDump} in the dump`);
  }

  if (mismatches.length) {
    fail([
      "the dump is INCOMPLETE — it does not contain every live row.",
      "",
      ...mismatches.map((m) => `  ${m}`),
      "",
      "  Under row-level security a dump taken by a role without BYPASSRLS is",
      "  silently partial. Take backups as fm_backup (the one role granted",
      "  BYPASSRLS for exactly this reason), not as the application role.",
    ].join("\n"));
  }
  console.log(`  verified row-for-row across ${checked} non-empty table(s).`);
}

console.log(`✓ db:backup — wrote backups/${path.basename(outFile)} (${(bytes / 1024).toFixed(1)} KB).`);
// A pg_dump newer than the server emits `SET transaction_timeout`, which PG16 rejects
// (docs/operations/database-safety.md §4) — the restore line filters it.
console.log(`  Restore with:  grep -v '^SET transaction_timeout' backups/${path.basename(outFile)} | psql "$${target.source}"`);
