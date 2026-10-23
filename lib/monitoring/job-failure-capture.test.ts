/**
 * lib/monitoring/job-failure-capture.test.ts  (OPERATIONALIZATION P0)
 *
 * The scheduled-job failure capture carries static identifiers and nothing
 * else — provable on the pure builder without a Sentry double, the same way
 * buildLedgerWriteCapture is pinned.
 *
 *     npx tsx lib/monitoring/job-failure-capture.test.ts
 */

import { buildJobFailureCapture } from "@/lib/monitoring/capture";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("buildJobFailureCapture");
{
  const c = buildJobFailureCapture({ jobName: "sync-banks", executionId: "exec-1" });
  check("area tag is scheduled-job", c.tags.area === "scheduled-job");
  check("job name and execution id are the only identifiers", c.tags.jobName === "sync-banks" && c.tags.executionId === "exec-1" && Object.keys(c.tags).sort().join() === "area,executionId,jobName");
  check("always an error", c.level === "error");
  const bare = buildJobFailureCapture({ jobName: "x", executionId: null });
  check("no execution id ⇒ no tag (never an invented one)", !("executionId" in bare.tags));
  // The payload is tags only: no summary, no row, no user content, no money.
  check("no contexts / extra payload", !("contexts" in c) && !("extra" in c));
  check("no secret-looking material in the payload", !/token|password|secret|\$\d/i.test(JSON.stringify(c)));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
