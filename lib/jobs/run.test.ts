/**
 * lib/jobs/run.test.ts  (OPS-4 S1)
 *
 * Pure guards for the runJob() execution-ledger wrapper. Standalone tsx
 * script (house pattern): npx tsx lib/jobs/run.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE: an injected in-memory fake implements the narrow
 * JobRunWriteClient seam. Covers: success path (start row + single
 * completion write + result passthrough) · failure path (rethrow unchanged +
 * errorSummary, no summary) · append-only discipline (exactly one create,
 * exactly one update, update targets the created row) · ledger-never-breaks-
 * the-job (start-write failure → job still runs, completion skipped;
 * completion-write failure → result still returned) · error truncation ·
 * summary serialization guard (void / circular → NULL) · source-scan that
 * S1 shipped none of the banned infrastructure (dispatcher, scheduler,
 * queue, retry, telemetry).
 */

import { readFileSync } from "node:fs";
import {
  runJob,
  summarizeError,
  toJsonSummary,
  type JobRunCompletionData,
  type JobRunStartData,
  type JobRunWriteClient,
} from "@/lib/jobs/run";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Environment tolerance (see lib/notifications/create.test.ts): PrismaClient
// engine warm-up floating-rejects on platform-mismatched sandboxes; nothing
// here uses Prisma at runtime (the fake client is injected).
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") {
    return;
  }
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

// ── In-memory fake implementing the narrow seam ──────────────────────────────

interface FakeOptions {
  failCreate?: boolean;
  failUpdate?: boolean;
}

function makeFake(opts: FakeOptions = {}) {
  const creates: JobRunStartData[] = [];
  const updates: Array<{ id: string; data: JobRunCompletionData }> = [];
  const client: JobRunWriteClient = {
    jobRun: {
      async create({ data }) {
        if (opts.failCreate) throw new Error("ledger down");
        creates.push(data);
        return { id: `row-${creates.length}` };
      },
      async update({ where, data }) {
        if (opts.failUpdate) throw new Error("ledger down");
        updates.push({ id: where.id, data });
        return {};
      },
    },
  };
  return { client, creates, updates };
}

// Silence the wrapper's expected non-fatal console.error noise in the two
// ledger-failure cases, while still failing loudly on anything unexpected.
function muteConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  return fn().finally(() => {
    console.error = original;
  });
}

async function main(): Promise<void> {
  console.log("runJob execution ledger (OPS-4 S1)");

  // ── 1. Success path ────────────────────────────────────────────────────────
  {
    const { client, creates, updates } = makeFake();
    const result = await runJob("test-job", async () => ({ added: 3, removed: 1 }), {
      trigger: "manual",
      client,
    });
    check("success: fn result returned verbatim", result.added === 3 && result.removed === 1);
    check("success: exactly one start row", creates.length === 1);
    check(
      "success: start row shape (name/trigger/status/executionId)",
      creates[0].jobName === "test-job" &&
        creates[0].trigger === "manual" &&
        creates[0].status === "running" &&
        typeof creates[0].executionId === "string" &&
        creates[0].executionId.length > 0 &&
        creates[0].startedAt instanceof Date,
    );
    check("success: exactly one completion write (append-only)", updates.length === 1);
    check("success: completion targets the created row", updates[0].id === "row-1");
    const done = updates[0].data;
    check(
      "success: completion write is succeeded + timed",
      done.status === "succeeded" && done.completedAt instanceof Date && typeof done.durationMs === "number" && done.durationMs >= 0,
    );
    check(
      "success: summary carries the result counts",
      JSON.stringify(done.summary) === JSON.stringify({ added: 3, removed: 1 }),
    );
    check("success: no errorSummary on success", done.errorSummary === undefined);
  }

  // ── 2. Failure path ────────────────────────────────────────────────────────
  {
    const { client, updates } = makeFake();
    const boom = new Error("provider exploded");
    let thrown: unknown = null;
    try {
      await runJob("test-job", async () => { throw boom; }, { client });
    } catch (err) {
      thrown = err;
    }
    check("failure: original error rethrown unchanged", thrown === boom);
    check("failure: exactly one completion write", updates.length === 1);
    const done = updates[0].data;
    check(
      "failure: completion write is failed + errorSummary, no summary",
      done.status === "failed" && done.errorSummary === "provider exploded" && done.summary === undefined,
    );
    check("failure: still timed", typeof done.durationMs === "number" && done.completedAt instanceof Date);
  }

  // ── 3. Default trigger ─────────────────────────────────────────────────────
  {
    const { client, creates } = makeFake();
    await runJob("test-job", async () => null, { client });
    check("default trigger is \"cron\"", creates[0].trigger === "cron");
  }

  // ── 4. Ledger never breaks the job ─────────────────────────────────────────
  {
    const { client, updates } = makeFake({ failCreate: true });
    const result = await muteConsoleError(() =>
      runJob("test-job", async () => "ran anyway", { client }),
    );
    check("start-write failure: job still runs and returns", result === "ran anyway");
    check("start-write failure: completion write skipped (no row to complete)", updates.length === 0);
  }
  {
    const { client, creates } = makeFake({ failUpdate: true });
    const result = await muteConsoleError(() =>
      runJob("test-job", async () => 42, { client }),
    );
    check("completion-write failure: result still returned", result === 42 && creates.length === 1);
  }
  {
    const { client } = makeFake({ failUpdate: true });
    const boom = new Error("job failed AND ledger failed");
    let thrown: unknown = null;
    try {
      await muteConsoleError(() => runJob("test-job", async () => { throw boom; }, { client }));
    } catch (err) {
      thrown = err;
    }
    check("completion-write failure on failed job: original error still rethrown", thrown === boom);
  }

  // ── 5. Helpers ─────────────────────────────────────────────────────────────
  {
    const long = "x".repeat(600);
    check("errorSummary truncated to 500 chars", summarizeError(new Error(long)).length === 500);
    check("non-Error summarized via String()", summarizeError("plain failure") === "plain failure");
    check("void result → summary undefined", toJsonSummary(undefined) === undefined);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    check("unserializable result → summary undefined (no throw)", toJsonSummary(circular) === undefined);
    check("plain counts survive projection", JSON.stringify(toJsonSummary({ n: 2 })) === '{"n":2}');
  }

  // ── 6. Source scans — S1 shipped none of the banned infrastructure ─────────
  {
    // Strip comments first (the security-surface.test.ts idiom): the header
    // deliberately DOCUMENTS the banned list, which must not trip the scan.
    const wrapperSrc = readFileSync("lib/jobs/run.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    check(
      "wrapper has no retry/backoff/queue/dispatcher/telemetry code",
      !/\b(dispatcher|backoff|BullMQ|setInterval|node-cron|telemetry)\b/i.test(wrapperSrc) &&
        !/\bretry\w*\(/i.test(wrapperSrc),
    );
    const routes = [
      "app/api/jobs/sync-banks/route.ts",
      "app/api/jobs/fetch-fx-rates/route.ts",
      "app/api/jobs/process-deletions/route.ts",
    ].map((p) => readFileSync(p, "utf8"));
    check(
      "all three cron routes keep their own CRON_SECRET check (R3)",
      routes.every((src) => src.includes("CRON_SECRET") && src.includes("401")),
    );
    check(
      "all three cron routes run their body through runJob",
      routes.every((src) => src.includes("runJob(")),
    );
    check(
      "notification cleanup still rides process-deletions (R4)",
      routes[2].includes("cleanupNotifications"),
    );
  }

  if (failures > 0) {
    console.error(`\nrunJob tests: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nrunJob tests: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("  ✗ test harness error:", err);
  process.exit(1);
});
