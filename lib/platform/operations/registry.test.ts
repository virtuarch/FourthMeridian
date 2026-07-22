/**
 * lib/platform/operations/registry.test.ts  (OPS-5 S4)
 *
 * Pure guards for the manual-operations command registry. Standalone tsx
 * script (house pattern): npx tsx lib/platform/operations/registry.test.ts —
 * exits 0/1. No DB, no network: the registry is pure data + pure lookups.
 *
 * Covers: command materialization (kind × target) · id stability & uniqueness ·
 * only ACTIVE kinds materialize (no reserved kind leaks into a command) · every
 * target maps to a REAL SCHEDULED_JOBS body (resolveJobBody, the anti-drift
 * ratchet) · the destructive/maintenance jobs stay EXCLUDED (the safety
 * ratchet) · kind-meta exhaustiveness & mutates flags.
 */

import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import {
  OPERATION_KINDS,
  ACTIVE_OPERATION_KINDS,
  OPERATION_TARGETS,
  EXCLUDED_TARGETS,
  listOperationCommands,
  getOperationCommand,
  resolveJobBody,
  commandId,
  type OperationKind,
} from "@/lib/platform/operations/registry";

// PrismaClient engine warm-up can floating-reject on mismatched sandboxes;
// nothing here touches Prisma at runtime (pure module).
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("registry: kind vocabulary");
{
  const all: OperationKind[] = ["run-now", "refresh", "retry", "backfill", "dry-run", "invalidate"];
  check("all six kinds are described", all.every((k) => OPERATION_KINDS[k]?.kind === k));
  check("run-now is active + mutating", OPERATION_KINDS["run-now"].status === "active" && OPERATION_KINDS["run-now"].mutates);
  check("dry-run is active + non-mutating", OPERATION_KINDS["dry-run"].status === "active" && !OPERATION_KINDS["dry-run"].mutates);
  check(
    "refresh/retry/backfill/invalidate are reserved with a reason",
    (["refresh", "retry", "backfill", "invalidate"] as OperationKind[]).every(
      (k) => OPERATION_KINDS[k].status === "reserved" && !!OPERATION_KINDS[k].reservedReason,
    ),
  );
  check("invalidate is flagged destructive", OPERATION_KINDS["invalidate"].destructive === true);
  check(
    "ACTIVE_OPERATION_KINDS = exactly [run-now, dry-run]",
    ACTIVE_OPERATION_KINDS.length === 2 &&
      ACTIVE_OPERATION_KINDS.includes("run-now") &&
      ACTIVE_OPERATION_KINDS.includes("dry-run"),
  );
}

console.log("registry: command materialization");
{
  const cmds = listOperationCommands();
  const expected = OPERATION_TARGETS.reduce((n, t) => n + t.kinds.length, 0);
  check(`materializes one command per (target × kind) = ${expected}`, cmds.length === expected);

  const ids = cmds.map((c) => c.id);
  check("ids are unique", new Set(ids).size === ids.length);
  check("ids are `<kind>:<targetJob>`", cmds.every((c) => c.id === commandId(c.kind, c.targetJob)));
  check("jobName equals targetJob (manual run is ledgered as the job)", cmds.every((c) => c.jobName === c.targetJob));

  check(
    "NO reserved kind appears in any command",
    cmds.every((c) => OPERATION_KINDS[c.kind].status === "active"),
  );
  check("run-now commands are mutating, dry-run commands are not", cmds.every((c) => c.mutates === (c.kind === "run-now")));
  check("every command carries confirmation copy", cmds.every((c) => c.confirm.length > 0));
}

console.log("registry: canonical-body binding (anti-drift ratchet)");
{
  const jobNames = new Set(SCHEDULED_JOBS.map((j) => j.name));
  check("every target job exists in SCHEDULED_JOBS", OPERATION_TARGETS.every((t) => jobNames.has(t.targetJob)));
  check(
    "resolveJobBody returns the SAME closure SCHEDULED_JOBS holds",
    OPERATION_TARGETS.every((t) => {
      const job = SCHEDULED_JOBS.find((j) => j.name === t.targetJob);
      return job !== undefined && resolveJobBody(t.targetJob) === job.run;
    }),
  );
  let threw = false;
  try { resolveJobBody("no-such-job"); } catch { threw = true; }
  check("resolveJobBody throws for an unregistered target", threw);
}

console.log("registry: safety ratchet (excluded jobs stay excluded)");
{
  const targetJobs = new Set(OPERATION_TARGETS.map((t) => t.targetJob));
  check(
    "no EXCLUDED_TARGETS job is exposed as a target",
    Object.keys(EXCLUDED_TARGETS).every((name) => !targetJobs.has(name)),
  );
  // Destructive jobs must never be manual targets, whether or not listed above.
  check("process-deletions is not a target", !targetJobs.has("process-deletions"));
  check("purge-trash is not a target", !targetJobs.has("purge-trash"));
  check("every excluded job has a documented reason", Object.values(EXCLUDED_TARGETS).every((r) => r.length > 0));
}

console.log("registry: lookup");
{
  check("getOperationCommand finds a known id", getOperationCommand("run-now:fetch-fx-rates")?.kind === "run-now");
  check("getOperationCommand returns undefined for an unknown id", getOperationCommand("run-now:nope") === undefined);
}

if (failures > 0) {
  console.error(`\nregistry.test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nregistry.test: all checks passed");
