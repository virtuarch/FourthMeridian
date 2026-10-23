/**
 * scripts/lib/schema-drift.ts — pure core of audit-schema-drift (DB-008).
 *
 * The audit replays prisma/migrations into a throwaway shadow database and asks
 * Prisma for the SQL that would turn that result into prisma/schema.prisma. Any
 * statement means the two disagree: a schema edit with no migration, or a
 * migration the schema does not describe. Partial-unique indexes that live only
 * in raw SQL are invisible to Prisma in BOTH directions and do not appear.
 */

/** Statements in a `prisma migrate diff --script` output (comments and blanks dropped). */
export function driftStatements(script: string): string[] {
  return script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("--"));
}

/**
 * The audit creates and drops a database, so it may only point at a disposable
 * local server: the CI service container or a developer's own Docker Postgres.
 * Anything else (a pooler, a hosted project) is refused before any connection.
 */
export function shadowServerAllowed(databaseUrl: string | undefined): { ok: true; host: string } | { ok: false; reason: string } {
  if (!databaseUrl) return { ok: false, reason: "DATABASE_URL is not set" };
  let u: URL;
  try { u = new URL(databaseUrl); } catch { return { ok: false, reason: "DATABASE_URL is not a URL" }; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return { ok: false, reason: `unsupported protocol ${u.protocol}` };
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) {
    return { ok: false, reason: `refusing to create a shadow database on ${u.hostname} — local throwaway servers only` };
  }
  if (u.searchParams.get("pgbouncer") === "true") return { ok: false, reason: "pooler URL (pgbouncer=true) cannot create databases" };
  return { ok: true, host: u.hostname };
}

/** The shadow database URL: same server and credentials, a fresh database name. */
export function shadowUrl(databaseUrl: string, name: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${name}`;
  u.search = "";
  return u.toString();
}
