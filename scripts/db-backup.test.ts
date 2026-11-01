/**
 * scripts/db-backup.test.ts — the row-for-row check reads the DUMP'S OWN snapshot.
 *
 * 2026-11-01 (B1): the Production backup failed three times because the check
 * compared pg_dump's snapshot with a LATER live count(*) while the dispatcher
 * wrote JobRun rows (27147 → 27148 → 27149). The fix holds one REPEATABLE READ,
 * READ ONLY transaction, exports its snapshot, runs pg_dump --snapshot=<id>, and
 * counts inside that transaction afterwards. What must hold:
 *
 *   1. pure verification: exact match passes; missing COPY block and short
 *      table fail; zero-row tables are skipped;
 *   2. orchestration (injected fakes, no database): export → dump → count →
 *      close; pg_dump gets --snapshot=<id>; a row written after the snapshot
 *      does not fail the check (live counts are never read); the session is
 *      closed even when pg_dump fails; snapshot export failure is a hard fail
 *      with the session-mode message and NO verification at all;
 *   3. the psql-driven session, against a FAKE psql (no network): the SQL it
 *      sends, the marker protocol, ROLLBACK on close, transaction-pooler and
 *      export-failure refusals;
 *   4. the script itself never reads a count outside the snapshot session.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/db-backup.test.ts
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  countDumpCopyRows, openPsqlSnapshotSession, runSnapshotBackup, verifyDumpAgainstSnapshot,
  type SnapshotBackupDeps, type SnapshotSession,
} from "./lib/db-backup.core";

let passes = 0, failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function copyBlock(table: string, rows: number): string {
  const lines = Array.from({ length: rows }, (_, i) => `${i + 1}\tv${i}`);
  return `COPY public."${table}" (id, v) FROM stdin;\n${lines.length ? lines.join("\n") + "\n" : ""}\\.\n\n`;
}
const DUMP = "-- PostgreSQL database dump\n\n" + copyBlock("Account", 3) + copyBlock("JobRun", 27147) + copyBlock("Empty", 0);

async function main(): Promise<void> {
  // ── 1. pure ────────────────────────────────────────────────────────────────
  console.log("pure verification");
  check("COPY block line count", countDumpCopyRows(DUMP, "JobRun") === 27147 && countDumpCopyRows(DUMP, "Account") === 3);
  check("empty COPY block counts 0", countDumpCopyRows(DUMP, "Empty") === 0);
  check("missing COPY block is null", countDumpCopyRows(DUMP, "Nope") === null);
  check("a table name that prefixes another does not match it", countDumpCopyRows(DUMP, "Job") === null);

  let v = verifyDumpAgainstSnapshot({ Account: 3, JobRun: 27147 }, DUMP);
  check("exact match passes", v.mismatches.length === 0 && v.checked === 2, JSON.stringify(v));
  v = verifyDumpAgainstSnapshot({ Account: 3, JobRun: 27147, Missing: 5 }, DUMP);
  check("missing COPY block fails", v.mismatches.length === 1 && /Missing: 5 rows in the snapshot, NO COPY block/.test(v.mismatches[0]), JSON.stringify(v));
  v = verifyDumpAgainstSnapshot({ Account: 4, JobRun: 27147 }, DUMP);
  check("short table fails", v.mismatches.length === 1 && /Account: 4 rows in the snapshot, 3 in the dump/.test(v.mismatches[0]), JSON.stringify(v));
  v = verifyDumpAgainstSnapshot({ Account: 3, JobRun: 27147, Empty: 0, NeverDumped: 0 }, DUMP);
  check("zero-row tables are skipped (present or not)", v.mismatches.length === 0 && v.checked === 2, JSON.stringify(v));

  // ── 2. orchestration ─────────────────────────────────────────────────────
  console.log("orchestration (injected fakes)");
  function harness(opts: { exportFails?: boolean; dumpFails?: boolean; snapshot?: Record<string, number>; dump?: string } = {}) {
    const events: string[] = [];
    const snapshot = opts.snapshot ?? { Account: 3, JobRun: 27147, Empty: 0 };
    // What a LIVE count(*) would say right now: the dispatcher kept writing.
    const live: Record<string, number> = { ...snapshot, JobRun: (snapshot.JobRun ?? 0) + 2 };
    let dumpArgs: string[] | null = null;
    let liveReads = 0;
    const session: SnapshotSession = {
      snapshotId: "00000003-0000001B-1",
      async listTables() { events.push("list"); return Object.keys(snapshot); },
      async count(t) { events.push(`count:${t}`); return snapshot[t]; },
      async close() { events.push("close"); },
    };
    const deps: SnapshotBackupDeps = {
      async openSnapshotSession() {
        events.push("export");
        if (opts.exportFails) throw new Error('ERROR:  invalid snapshot identifier: "00000003-0000001B-1"');
        return session;
      },
      async runPgDump(args) {
        events.push("dump"); dumpArgs = args;
        if (opts.dumpFails) throw new Error("pg_dump exited 1");
      },
      readDump() { events.push("readDump"); return opts.dump ?? DUMP; },
      dumpBytes() { return (opts.dump ?? DUMP).length; },
    };
    return { events, deps, live, getDumpArgs: () => dumpArgs, liveReads: () => liveReads, readLive: (t: string) => { liveReads++; return live[t]; } };
  }
  const OPTS = { outFile: "/x/backups/postgres-stamp.sql", cleanUrl: "postgresql://fm_backup@db.example:5432/postgres", source: "DIRECT_URL" };

  {
    const h = harness();
    const r = await runSnapshotBackup(h.deps, OPTS);
    check("exact snapshot match passes", r.ok && r.checked === 2, JSON.stringify(r));
    const args = h.getDumpArgs() ?? [];
    check("pg_dump receives --snapshot=<id> and keeps its flags",
      JSON.stringify(args) === JSON.stringify(["--no-owner", "--no-privileges", "--snapshot=00000003-0000001B-1", "-f", OPTS.outFile, OPTS.cleanUrl]), JSON.stringify(args));
    const order = h.events.filter((e) => e !== "readDump");
    check("order: export → dump → count (in the snapshot) → close",
      JSON.stringify(order) === JSON.stringify(["export", "dump", "list", "count:Account", "count:JobRun", "count:Empty", "close"]), JSON.stringify(h.events));
    check("a row written AFTER the snapshot does not fail the check (live JobRun 27149 ≠ dump 27147, never read)",
      r.ok && h.live.JobRun === 27149 && h.liveReads() === 0);
  }
  {
    const h = harness({ dumpFails: true });
    const r = await runSnapshotBackup(h.deps, OPTS);
    check("pg_dump failure fails at the dump stage", !r.ok && r.stage === "dump" && /pg_dump failed/.test(r.message) && /5432/.test(r.message), JSON.stringify(r));
    check("the session is closed even when pg_dump fails", h.events[h.events.length - 1] === "close" && !h.events.some((e) => e.startsWith("count")), JSON.stringify(h.events));
  }
  {
    const h = harness({ exportFails: true });
    const r = await runSnapshotBackup(h.deps, OPTS);
    check("snapshot export failure is a hard fail with the session-mode message",
      !r.ok && r.stage === "snapshot" && /SESSION-mode/.test(r.message) && /5432/.test(r.message) && /6543/.test(r.message) && /does not fall back/.test(r.message), JSON.stringify(r));
    check("… and NOTHING else runs: no dump, no counts, no verification against live counts",
      JSON.stringify(h.events) === JSON.stringify(["export"]) && h.getDumpArgs() === null && h.liveReads() === 0, JSON.stringify(h.events));
  }
  {
    const short = "-- dump\n" + copyBlock("Account", 3) + copyBlock("JobRun", 27000);
    const h = harness({ dump: short });
    const r = await runSnapshotBackup(h.deps, OPTS);
    check("a genuinely short table still fails (with the fm_backup / BYPASSRLS hint) and the session is closed",
      !r.ok && r.stage === "verify" && /JobRun: 27147 rows in the snapshot, 27000 in the dump/.test(r.message) && /fm_backup/.test(r.message) && /BYPASSRLS/.test(r.message) && h.events.at(-1) === "close", JSON.stringify(r));
  }
  {
    const h = harness({ snapshot: { Account: 3, JobRun: 27147, Ghost: 4 } });
    const r = await runSnapshotBackup(h.deps, OPTS);
    check("a non-empty table with no COPY block fails", !r.ok && /Ghost: 4 rows in the snapshot, NO COPY block/.test(r.message), JSON.stringify(r));
  }
  {
    const h = harness({ dump: "tiny" });
    const r = await runSnapshotBackup(h.deps, OPTS);
    check("the 100-byte floor still applies, and the session is closed", !r.ok && /suspiciously small/.test(r.message) && h.events.at(-1) === "close");
  }

  // ── 3. the psql session against a fake psql ──────────────────────────────
  console.log("psql snapshot session (fake psql, no network)");
  const dir = mkdtempSync(path.join(tmpdir(), "fm-backup-test-"));
  try {
    const fake = path.join(dir, "psql");
    const log = path.join(dir, "log");
    writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$*" > "$FAKE_PSQL_LOG.argv"
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$FAKE_PSQL_LOG"
  case "$line" in
    '\\echo '*) printf '%s\\n' "\${line#\\\\echo }" ;;
    'SELECT pg_export_snapshot();')
      if [ -n "$FAKE_PSQL_EXPORT_FAIL" ]; then echo 'ERROR:  cannot export a snapshot from a subtransaction' >&2; exit 3; fi
      echo '00000003-0000001B-1' ;;
    select\\ c.relname*) printf 'Account\\nJobRun\\n' ;;
    'select count(*) from "Account";') echo 3 ;;
    'select count(*) from "JobRun";') echo 27147 ;;
  esac
done
exit 0
`);
    chmodSync(fake, 0o755);
    process.env.FAKE_PSQL_LOG = log;
    const URL_OK = "postgresql://fm_backup@db.example:5432/postgres";

    const s = await openPsqlSnapshotSession(URL_OK, fake);
    check("snapshot id parsed from pg_export_snapshot", s.snapshotId === "00000003-0000001B-1", s.snapshotId);
    const tables = await s.listTables();
    const counts = [await s.count("Account"), await s.count("JobRun")];
    await s.close();
    await s.close(); // idempotent
    check("tables and counts come back through the marker protocol", JSON.stringify(tables) === '["Account","JobRun"]' && JSON.stringify(counts) === "[3,27147]", JSON.stringify({ tables, counts }));
    const sent = readFileSync(log, "utf8").split("\n").filter((l) => l && !l.startsWith("\\echo"));
    check("SQL sent: BEGIN RR READ ONLY → SET LOCAL idle timeout off → export → list → counts → ROLLBACK",
      sent[0] === "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;" &&
      sent[1] === "SET LOCAL idle_in_transaction_session_timeout = 0;" &&
      sent[2] === "SELECT pg_export_snapshot();" &&
      /^select c\.relname .*_prisma_migrations/.test(sent[3]) &&
      sent[4] === 'select count(*) from "Account";' && sent[5] === 'select count(*) from "JobRun";' &&
      sent[6] === "ROLLBACK;" && sent.length === 7, JSON.stringify(sent));
    const argv = readFileSync(`${log}.argv`, "utf8");
    check("psql runs with ON_ERROR_STOP and no psqlrc", /ON_ERROR_STOP=1/.test(argv) && /--no-psqlrc/.test(argv) && /-X/.test(argv));

    rmSync(log, { force: true });
    process.env.FAKE_PSQL_EXPORT_FAIL = "1";
    let err = "";
    try { await openPsqlSnapshotSession(URL_OK, fake); } catch (e) { err = (e as Error).message; }
    delete process.env.FAKE_PSQL_EXPORT_FAIL;
    check("export failure rejects the open with psql's error", /cannot export a snapshot/.test(err), err);

    rmSync(log, { force: true });
    err = "";
    try { await openPsqlSnapshotSession("postgresql://postgres.ref:pw@aws-0-x.pooler.supabase.com:6543/postgres", fake); } catch (e) { err = (e as Error).message; }
    let spawned = true; try { readFileSync(log); } catch { spawned = false; }
    check("a transaction-pooler URL (:6543) is refused before psql is spawned", /6543/.test(err) && !spawned, err);

    // End to end with the real orchestration: export failure ⇒ snapshot-stage failure, no dump.
    process.env.FAKE_PSQL_EXPORT_FAIL = "1";
    let dumped = false;
    const r = await runSnapshotBackup({
      openSnapshotSession: () => openPsqlSnapshotSession(URL_OK, fake),
      async runPgDump() { dumped = true; },
      readDump: () => DUMP, dumpBytes: () => DUMP.length,
    }, { outFile: "/x/out.sql", cleanUrl: URL_OK, source: "DIRECT_URL" });
    delete process.env.FAKE_PSQL_EXPORT_FAIL;
    check("fake-psql export failure ⇒ snapshot-stage hard fail, pg_dump never runs", !r.ok && r.stage === "snapshot" && !dumped && /SESSION-mode/.test(r.message), JSON.stringify(r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ── 4. the script ────────────────────────────────────────────────────────
  console.log("scripts/db-backup.ts");
  const src = readFileSync(path.join(process.cwd(), "scripts", "db-backup.ts"), "utf8");
  check("the script verifies through runSnapshotBackup + the psql snapshot session", /runSnapshotBackup\(/.test(src) && /openPsqlSnapshotSession\(cleanUrl\)/.test(src));
  check("the script reads no count(*) and runs no psql outside the snapshot session", !/select count/i.test(src) && !/execFileSync|execSync|spawnSync/.test(src) && !/spawn\(\s*["']psql/.test(src));
  check("the script still dumps the guarded mutation target", /processMutationAuthority\(requireDirect\)/.test(src) && /target\.url\.split/.test(src));

  console.log(`\ndb-backup: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
