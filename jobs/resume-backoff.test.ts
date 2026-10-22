/**
 * jobs/resume-backoff.test.ts  (IDEMP-007)
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/resume-backoff.test.ts
 */
import { readFileSync } from "node:fs";
import { resumeStaleImports, resumeBackoffMs, RESUME_BACKOFF_MS } from "@/jobs/resume-stale-imports";
import type { StampedAdmissionVerdict } from "@/lib/platform/admission/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err); process.exit(1);
});

async function main() {
  check("schedule: 15 min, 1 h, 6 h, then daily", RESUME_BACKOFF_MS.join() === [900_000, 3_600_000, 21_600_000, 86_400_000].join());
  check("attempt N ⇒ Nth delay; past the end stays daily", resumeBackoffMs(1) === 900_000 && resumeBackoffMs(3) === 21_600_000 && resumeBackoffMs(9) === 86_400_000);

  // A simulated blocked Item over 2 days of 5-minute wakes: attempts happen on
  // the backoff schedule, not every wake.
  const T0 = Date.UTC(2026, 9, 22, 0, 0, 0);
  let t = T0;
  const item = { id: "pi", incomplete: true, attempts: 0, nextAt: null as number | null };
  const drives: number[] = [];
  const admission = { decision: "ADMIT" } as unknown as StampedAdmissionVerdict;
  const log = console.log; console.log = () => {};
  for (let wake = 0; wake < (2 * 24 * 60) / 5; wake++, t += 5 * 60_000) {
    await resumeStaleImports({
      now: () => new Date(t),
      resetCompleted: async () => { if (!item.incomplete) { item.attempts = 0; item.nextAt = null; } },
      loadCandidates: async () => (item.incomplete && (item.nextAt === null || item.nextAt <= t)
        ? { candidates: 1, items: [{ id: item.id, institutionName: "Blocked Bank" }] } : { candidates: 0, items: [] }),
      admit: async () => admission,
      drive: async () => { drives.push(t); return "ran"; },
      recordAttempt: async (_id, now) => { if (item.incomplete) { item.attempts++; item.nextAt = now.getTime() + resumeBackoffMs(item.attempts); } },
    });
  }
  console.log = log;
  const gaps = drives.slice(1).map((d, i) => (d - drives[i]) / 60_000);
  check("a permanently blocked Item is attempted ~6 times in 2 days, not 576", drives.length >= 5 && drives.length <= 7, `${drives.length} attempts`);
  check("gaps follow the schedule (15, 60, 360, 1440 min)", gaps[0] === 15 && gaps[1] === 60 && gaps[2] === 360 && gaps[3] === 1440, gaps.join());

  // skipped-locked is not an attempt; success resets.
  let recorded = 0;
  console.log = () => {};
  await resumeStaleImports({
    loadCandidates: async () => ({ candidates: 1, items: [{ id: "x", institutionName: "X" }] }),
    admit: async () => admission, drive: async () => "skipped-locked",
    recordAttempt: async () => { recorded++; }, resetCompleted: async () => {},
  });
  console.log = log;
  check("a lost lock race does not count as an attempt", recorded === 0);

  const src = readFileSync("jobs/resume-stale-imports.ts", "utf8");
  check("the production loader filters on the backoff slot", /syncResumeNextAt: \{ lte: new Date\(\) \}/.test(src));
  check("a completed Item's counter is reset each run", /syncIncompleteAt: null, OR: \[\{ syncResumeAttempts: \{ gt: 0 \} \}/.test(src));

  if (failures > 0) { console.error(`\n❌ resume backoff: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ resume backoff: all checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
