/**
 * scripts/lib/db-backup.core.ts — the verification behind scripts/db-backup.ts.
 *
 * ── 2026-11-01 — A LIVE COUNT IS NOT THE DUMP'S COUNT ───────────────────────
 * The RLS-3 completeness check compared each table's LIVE `count(*)` (separate
 * psql calls, AFTER pg_dump finished) with the dump's COPY line count. pg_dump
 * reads one snapshot; the live count read a later one. On Production the job
 * dispatcher writes JobRun rows throughout a ~6-minute dump, so JobRun's live
 * count always exceeded the dump and every attempt failed (B1, three attempts:
 * 27147 → 27148 → 27149 live vs the dump's smaller count).
 *
 * The fix: ONE session holds `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY`
 * for the whole backup and exports its snapshot; pg_dump imports it
 * (`--snapshot=<id>`); the counts run AFTER the dump in that SAME transaction.
 * Both sides therefore read the identical snapshot, and any mismatch is a
 * genuinely partial dump (RLS truncation, missing COPY block, short table) —
 * the check's purpose is unchanged. No cron pause is needed.
 *
 * Requires a SESSION-mode connection (Supabase :5432 / DIRECT_URL). A
 * transaction pooler (:6543) cannot hold an exported snapshot for another
 * connection; the backup then FAILS — it never falls back to comparing against
 * live counts, which is exactly the race this replaces.
 *
 * Pure verification + orchestration with injected deps (unit-tested in
 * scripts/db-backup.test.ts) + the psql-driven snapshot session.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

// ── pure: the dump side ────────────────────────────────────────────────────

/** One snapshot-session request (BEGIN, export, one count) must answer within this; the dump itself is not a request. */
export const SNAPSHOT_REQUEST_TIMEOUT_MS = 120_000;

/** `COPY public."Name" (cols) FROM stdin;` or, for a lower-case unquoted name, `COPY public.name (cols) FROM stdin;`. */
const COPY_HEADER = /^COPY public\.("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*) .*FROM stdin;$/;

/**
 * ONE pass over the dump, line by line, tracking whether we are inside a COPY block:
 * `{ table → data lines }` for every block that is properly terminated by `\.`.
 * A header is recognised ONLY at a line start OUTSIDE a block (text inside row data
 * can never open a block), an empty block counts 0 wherever it sits, and an
 * unterminated block is left out (so its table reads as "no COPY block").
 * COPY text format escapes newlines and backslashes in values, so a data line can
 * never be `\.` itself.
 */
export function parseDumpCopyCounts(dump: string): Map<string, number> {
  const out = new Map<string, number>();
  let current: string | null = null;
  let rows = 0;
  let pos = 0;
  while (pos <= dump.length) {
    const nl = dump.indexOf("\n", pos);
    const line = (nl === -1 ? dump.slice(pos) : dump.slice(pos, nl)).replace(/\r$/, "");
    pos = nl === -1 ? dump.length + 1 : nl + 1;
    if (current === null) {
      const m = COPY_HEADER.exec(line);
      if (m) {
        const raw = m[1];
        current = raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
        rows = 0;
      }
    } else if (line === "\\.") {
      out.set(current, rows);
      current = null;
    } else {
      rows++;
    }
  }
  return out;
}

/** Data lines in the dump's COPY block for `public."<table>"`, or null when there is no (terminated) block. */
export function countDumpCopyRows(dump: string, table: string): number | null {
  return parseDumpCopyCounts(dump).get(table) ?? null;
}

export interface DumpVerification {
  /** Non-empty tables compared. */
  checked: number;
  /** Human-readable, one per failing table. Empty ⇒ the dump is complete. */
  mismatches: string[];
}

/**
 * Compare `{ table: count(*) read INSIDE the dump's snapshot }` with the dump.
 * A table with 0 rows (or a non-finite count) is skipped — nothing to
 * under-report. A missing COPY block or a different line count is a mismatch.
 */
export function verifyDumpAgainstSnapshot(counts: Record<string, number>, dump: string): DumpVerification {
  const mismatches: string[] = [];
  let checked = 0;
  const inDumpByTable = parseDumpCopyCounts(dump);
  for (const [t, rows] of Object.entries(counts)) {
    if (!Number.isFinite(rows) || rows === 0) continue;
    checked++;
    const inDump = inDumpByTable.get(t) ?? null;
    if (inDump === null) mismatches.push(`${t}: ${rows} rows in the snapshot, NO COPY block in the dump`);
    else if (inDump !== rows) mismatches.push(`${t}: ${rows} rows in the snapshot, ${inDump} in the dump`);
  }
  return { checked, mismatches };
}

// ── messages ───────────────────────────────────────────────────────────────

export const SESSION_MODE_HINT = [
  "The row-for-row check reads the dump's OWN snapshot (pg_export_snapshot →",
  "pg_dump --snapshot), which needs a SESSION-mode connection. On Supabase use",
  "the session pooler or direct connection on port 5432 (DIRECT_URL), not the",
  "transaction pooler on port 6543. The backup does not fall back to comparing",
  "against live counts: on a database with writers that comparison always fails.",
];

export const RLS_HINT = [
  "Under row-level security a dump taken by a role without BYPASSRLS is",
  "silently partial. Take backups as fm_backup (the one role granted",
  "BYPASSRLS for exactly this reason), not as the application role.",
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim();

/** Transaction-pooler URLs cannot carry an exported snapshot between connections. */
export function isTransactionPoolerUrl(url: string): boolean {
  try { return new URL(url).port === "6543"; } catch { return false; }
}

// ── orchestration ──────────────────────────────────────────────────────────

/** One held REPEATABLE READ, READ ONLY transaction that exported its snapshot. */
export interface SnapshotSession {
  snapshotId: string;
  /** public base tables except _prisma_migrations, read inside the transaction. */
  listTables(): Promise<string[]>;
  /** `count(*)` inside the transaction (i.e. in the exported snapshot). */
  count(table: string): Promise<number>;
  /** End the transaction (ROLLBACK — it is read-only) and close the session. */
  close(): Promise<void>;
}

export interface SnapshotBackupDeps {
  openSnapshotSession(): Promise<SnapshotSession>;
  runPgDump(args: string[]): Promise<void>;
  readDump(): string;
  dumpBytes(): number;
}

export type SnapshotBackupResult =
  | { ok: true; snapshotId: string; checked: number; bytes: number }
  | { ok: false; stage: "snapshot" | "dump" | "verify"; message: string };

export function pgDumpArgs(snapshotId: string, outFile: string, cleanUrl: string): string[] {
  // --no-owner/--no-privileges keep the dump restorable across roles.
  return ["--no-owner", "--no-privileges", `--snapshot=${snapshotId}`, "-f", outFile, cleanUrl];
}

/** Order: export snapshot → pg_dump --snapshot → count in the snapshot → close. */
export async function runSnapshotBackup(
  deps: SnapshotBackupDeps,
  opts: { outFile: string; cleanUrl: string; source: string },
): Promise<SnapshotBackupResult> {
  let session: SnapshotSession;
  try {
    session = await deps.openSnapshotSession();
  } catch (e) {
    return {
      ok: false, stage: "snapshot",
      message: ["could not open a snapshot session (BEGIN REPEATABLE READ + pg_export_snapshot).", "", `  ${errText(e)}`, "", ...SESSION_MODE_HINT.map((l) => `  ${l}`)].join("\n"),
    };
  }

  try {
    try {
      await deps.runPgDump(pgDumpArgs(session.snapshotId, opts.outFile, opts.cleanUrl));
    } catch (e) {
      return {
        ok: false, stage: "dump",
        message: [
          `pg_dump failed (${errText(e)}). Is Postgres reachable at ${opts.source}? Is pg_dump installed (brew install libpq)?`,
          "",
          "  If pg_dump reported that it could not import the snapshot (invalid snapshot identifier):",
          ...SESSION_MODE_HINT.map((l) => `  ${l}`),
        ].join("\n"),
      };
    }

    const bytes = deps.dumpBytes();
    if (bytes < 100) return { ok: false, stage: "dump", message: `the dump is suspiciously small (${bytes} bytes) — treating as failed.` };

    const counts: Record<string, number> = {};
    try {
      for (const t of await session.listTables()) counts[t] = await session.count(t);
    } catch (e) {
      return {
        ok: false, stage: "verify",
        message: [`the snapshot session failed while counting rows: ${errText(e)}`, "", "  The dump was written but is UNVERIFIED — do not rely on it."].join("\n"),
      };
    }

    const v = verifyDumpAgainstSnapshot(counts, deps.readDump());
    if (v.mismatches.length) {
      return {
        ok: false, stage: "verify",
        message: ["the dump is INCOMPLETE — it does not contain every row of its own snapshot.", "", ...v.mismatches.map((m) => `  ${m}`), "", ...RLS_HINT.map((l) => `  ${l}`)].join("\n"),
      };
    }
    return { ok: true, snapshotId: session.snapshotId, checked: v.checked, bytes };
  } finally {
    await session.close().catch(() => {});
  }
}

// ── the psql-driven session ────────────────────────────────────────────────

const LIST_TABLES_SQL =
  "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace " +
  "where n.nspname = 'public' and c.relkind = 'r' and c.relname <> '_prisma_migrations' order by 1;";

const SNAPSHOT_ID = /^[0-9A-Fa-f]+-[0-9A-Fa-f]+(-\d+)?$/;

/**
 * ONE long-lived psql child over stdin/stdout. Each request is followed by
 * `\echo <marker>`; the reply is every stdout line before that marker. psql
 * runs with ON_ERROR_STOP, so an SQL error ends the child and fails the
 * pending request (and every later one) with psql's stderr. No `pg` dependency.
 *
 * `idle_in_transaction_session_timeout` is disabled with SET LOCAL (this
 * transaction only — never a session SET through a pooler): the transaction is
 * idle while pg_dump runs, and fm_backup's role setting (15 s) would otherwise
 * end it, and the snapshot with it, mid-backup.
 */
export async function openPsqlSnapshotSession(cleanUrl: string, psqlBin = "psql", timeoutMs = SNAPSHOT_REQUEST_TIMEOUT_MS): Promise<SnapshotSession> {
  if (isTransactionPoolerUrl(cleanUrl)) {
    throw new Error("the target URL is a transaction pooler (port 6543); an exported snapshot cannot be shared from it.");
  }

  const child = spawn(psqlBin, ["-X", "-A", "-t", "-q", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", cleanUrl], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const tag = randomBytes(8).toString("hex");
  let seq = 0;
  let buf = "";
  let stderr = "";
  let lines: string[] = [];
  let dead: Error | null = null;
  let pending: { marker: string; resolve: (l: string[]) => void; reject: (e: Error) => void } | null = null;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => { stderr += d; });
  child.stdout.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (pending && line === pending.marker) {
        const p = pending; pending = null;
        const out = lines; lines = [];
        p.resolve(out);
      } else {
        lines.push(line);
      }
    }
  });
  const die = (why: string) => {
    if (dead) return;
    dead = new Error(`${why}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    if (pending) { const p = pending; pending = null; p.reject(dead); }
  };
  child.on("error", (e) => die(`psql could not run (${e.message})`));
  child.on("close", (code) => die(`psql session ended (exit ${code})`));
  child.stdin.on("error", () => { /* surfaced through close */ });

  const request = (sql: string): Promise<string[]> => {
    if (dead) return Promise.reject(dead);
    if (pending) return Promise.reject(new Error("snapshot session: concurrent request"));
    const marker = `__FM_BACKUP_${tag}_${++seq}__`;
    return new Promise<string[]>((resolve, reject) => {
      // A reply that never arrives (psql not flushing to the pipe, a stalled pooler) must FAIL
      // loudly, never hang: the session is killed and the backup reports itself unverified.
      const timer = setTimeout(() => {
        die(`snapshot session: no reply within ${timeoutMs / 1000}s`);
        child.kill("SIGTERM");
      }, timeoutMs);
      pending = {
        marker,
        resolve: (v: string[]) => { clearTimeout(timer); resolve(v); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      };
      child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  };
  const values = (out: string[]) => out.map((s) => s.trim()).filter(Boolean);

  let snapshotId: string;
  try {
    await request("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;");
    await request("SET LOCAL idle_in_transaction_session_timeout = 0;");
    // A role that RLS would filter must ERROR here, not count a filtered subset: with
    // row_security off, any table it cannot fully see raises instead of under-counting
    // (pg_dump sets the same itself, so dump and counts fail or succeed together).
    await request("SET LOCAL row_security = off;");
    const got = values(await request("SELECT pg_export_snapshot();"));
    snapshotId = got.length === 1 ? got[0] : "";
    if (!SNAPSHOT_ID.test(snapshotId)) throw new Error(`pg_export_snapshot returned an unexpected value: ${JSON.stringify(got)}`);
  } catch (e) {
    child.stdin.end();
    child.kill();
    throw e;
  }

  let closed = false;
  return {
    snapshotId,
    async listTables() { return values(await request(LIST_TABLES_SQL)); },
    async count(table: string) {
      const got = values(await request(`select count(*) from "${table.replace(/"/g, '""')}";`));
      const n = Number(got[got.length - 1]);
      if (got.length !== 1 || !Number.isFinite(n)) throw new Error(`count(*) on ${table} returned ${JSON.stringify(got)}`);
      return n;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!dead) await request("ROLLBACK;").catch(() => {});
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("close", () => resolve());
      });
      child.stdin.end();
      await exited;
    },
  };
}
