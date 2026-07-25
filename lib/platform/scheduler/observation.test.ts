/**
 * lib/platform/scheduler/observation.test.ts  (OPS-2C-7)
 *
 * The scheduler surface is where fabrication is easiest. Every temptation here
 * produces a plausible-looking green number:
 *
 *   • a "last tick" (the dispatcher records none);
 *   • a "scheduler healthy" roll-up (no such authority exists);
 *   • folding an external cron in with registry jobs so it looks covered;
 *   • a count inside an explanatory note, which reads as an observation.
 *
 * Each is pinned below.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EXTERNAL_CRON_NOTE,
  SCHEDULER_NOTES,
  buildSchedulerObservation,
} from "@/lib/platform/scheduler/observation-core";
import { deriveNextSlot } from "@/lib/platform/scheduler/observation";
import type { ScheduledJob } from "@/lib/jobs/registry";
import type { JobHealthReport } from "@/lib/jobs/health";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const D = (iso: string) => new Date(iso);
const job = (name: string, hourUTC: number | number[], minuteUTC: 0 | 30 = 0): ScheduledJob =>
  ({ name, hourUTC, minuteUTC, run: async () => undefined }) as ScheduledJob;
const health = (over: Partial<JobHealthReport>): JobHealthReport =>
  ({ job: "x", status: "healthy", lastStartedAt: null, ...over }) as JobHealthReport;

const WINDOW = { from: "2026-07-24T06:00:00.000Z", to: "2026-07-25T06:00:00.000Z" };

function main() {
  // ── observed ───────────────────────────────────────────────────────────────────
  console.log("observed · only rows that exist");
  {
    const o = buildSchedulerObservation({
      jobs: [job("sync-banks", 6)],
      health: [],
      runs: [
        { jobName: "sync-banks", startedAt: D("2026-07-25T06:00:00.000Z") },
        { jobName: "sync-banks", startedAt: D("2026-07-24T06:00:00.000Z") },
      ],
      nextSlotAt: null,
      jobsInNextSlot: [],
      window: WINDOW,
    });
    check("last recorded execution is the NEWEST row", o.observed.lastRecordedExecutionAt === "2026-07-25T06:00:00.000Z");
    check("recorded executions counts rows", o.observed.recordedExecutions === 2);

    const empty = buildSchedulerObservation({
      jobs: [job("sync-banks", 6)], health: [], runs: [], nextSlotAt: null, jobsInNextSlot: [], window: WINDOW,
    });
    check("no rows ⇒ null, never a fabricated timestamp", empty.observed.lastRecordedExecutionAt === null);
    check("no rows ⇒ zero recorded (a real counted zero)", empty.observed.recordedExecutions === 0);
  }

  // ── overdue is READ from the health authority ─────────────────────────────────
  console.log("overdue · read from the health authority, never recomputed");
  {
    const o = buildSchedulerObservation({
      jobs: [job("a", 6), job("b", 7)],
      health: [
        health({ job: "a", status: "overdue", lastStartedAt: D("2026-07-20T06:00:00.000Z") }),
        health({ job: "b", status: "healthy" }),
        health({ job: "c", status: "dead", lastStartedAt: null }),
        health({ job: "d", status: "never-ran" }),
        health({ job: "e", status: "failing" }),
      ],
      runs: [], nextSlotAt: null, jobsInNextSlot: [], window: WINDOW,
    });
    const jobs = o.observed.overdue.map((x) => x.job);
    check("overdue and dead are surfaced", jobs.includes("a") && jobs.includes("c"));
    check("healthy is not", !jobs.includes("b"));
    check("never-ran is NOT surfaced as overdue (an operator-decides state)", !jobs.includes("d"));
    check("failing is not relabelled overdue (a different fact)", !jobs.includes("e"));
    check("the authority's own status string is passed through", o.observed.overdue[0].status === "overdue");
    check("stable order", jobs.join() === "a,c");
  }

  // ── external cron: disclosed, never folded in ─────────────────────────────────
  console.log("external cron · an architectural gap, never a registry job");
  {
    const o = buildSchedulerObservation({
      jobs: [job("sync-banks", 6)],
      health: [health({ job: "sync-banks", status: "healthy" })],
      runs: [
        { jobName: "sync-banks", startedAt: D("2026-07-25T06:00:00.000Z") },
        { jobName: "resume-stale-imports", startedAt: D("2026-07-25T05:55:00.000Z") },
        { jobName: "resume-stale-imports", startedAt: D("2026-07-25T05:50:00.000Z") },
      ],
      nextSlotAt: null, jobsInNextSlot: [], window: WINDOW,
    });
    check("the unregistered job is disclosed", o.observed.externalCrons.length === 1);
    const ext = o.observed.externalCrons[0];
    check("named as recorded", ext.job === "resume-stale-imports");
    check("marked NOT registered", ext.registered === false);
    check("its observed executions are counted", ext.recordedExecutions === 2);
    check("its newest run is reported", ext.lastRecordedExecutionAt === "2026-07-25T05:55:00.000Z");

    check("it is NOT counted among registered jobs", o.expected.registeredJobs === 1);
    check("it is NOT listed as overdue (no health authority covers it)", o.observed.overdue.length === 0);
    check("a registered job never appears as an external cron", !o.observed.externalCrons.some((c) => c.job === "sync-banks"));
    check("the gap note is appended only when one was observed", o.notes.includes(EXTERNAL_CRON_NOTE));

    const none = buildSchedulerObservation({
      jobs: [job("sync-banks", 6)], health: [],
      runs: [{ jobName: "sync-banks", startedAt: D("2026-07-25T06:00:00.000Z") }],
      nextSlotAt: null, jobsInNextSlot: [], window: WINDOW,
    });
    check("...and omitted when none was", !none.notes.includes(EXTERNAL_CRON_NOTE));
  }

  // ── expected is configuration, deterministic ──────────────────────────────────
  console.log("expected · deterministic from the registry only");
  {
    const jobs = [job("early", 6, 0), job("late", 7, 30), job("intraday", [0, 6, 12, 18], 0)];
    const now = D("2026-07-25T05:00:00.000Z");
    const a = deriveNextSlot(jobs, now);
    const b = deriveNextSlot(jobs, now);
    check("same inputs ⇒ same slot (deterministic)", a.at?.toISOString() === b.at?.toISOString());
    check("the EARLIEST declared slot wins", a.at?.toISOString().slice(11, 16) === "06:00");
    check(
      "what fires is decided by the dispatcher's own selector",
      a.jobs.includes("early") && a.jobs.includes("intraday") && !a.jobs.includes("late"),
    );

    const noSlots = deriveNextSlot([], now);
    check("no registry jobs ⇒ null slot, never a guessed one", noSlots.at === null && noSlots.jobs.length === 0);

    const o = buildSchedulerObservation({
      jobs, health: [], runs: [], nextSlotAt: a.at, jobsInNextSlot: a.jobs, window: WINDOW,
    });
    check("registered count is configuration", o.expected.registeredJobs === 3);
    check("slot job list is stably ordered", o.expected.jobsInNextSlot.join() === [...a.jobs].sort().join());
  }

  // ── notes: prose only ──────────────────────────────────────────────────────────
  console.log("notes · explanation only, never a figure");
  {
    const all = [...SCHEDULER_NOTES, EXTERNAL_CRON_NOTE];
    for (const n of all) {
      check(`note carries no digits: "${n.slice(0, 42)}…"`, !/\d/.test(n));
    }
    check("a note explains that ticks are not recorded", all.some((n) => /not recorded/i.test(n)));
    check("a note routes silence to overdue, not to this surface", all.some((n) => /overdue/i.test(n)));
    check("a note discloses that slots are config the platform may not enforce", all.some((n) => /deployment configuration/i.test(n)));
  }

  // ── no false health, no last tick ─────────────────────────────────────────────
  console.log("doctrine · no fabricated health, no tick");
  {
    const core = strip("lib/platform/scheduler/observation-core.ts");
    const auth = strip("lib/platform/scheduler/observation.ts");
    const route = strip("app/api/platform/platform-ops/scheduler/route.ts");
    const widget = strip("components/platform/widgets/OpsSchedulerWidget.tsx");
    const all = core + auth + route + widget;

    check("no scheduler-health concept anywhere", !/schedulerHealth|dispatcherHealthy|scheduler(Ok|Status)/i.test(all));
    check('no "last tick" field or copy', !/lastTick|last tick/i.test(all));
    check("no tick counting", !/tickCount|ticksObserved/i.test(all));
    check("the honest field name is used instead", /lastRecordedExecutionAt/.test(core));
    check("overdue is not recomputed in the core", !/GRACE_HOURS|expectedEveryHours|DEAD_CADENCE/.test(core));
    check("the authority composes checkScheduledJobHealth", /checkScheduledJobHealth/.test(auth));
    check("the authority reuses the dispatcher's own selector", /dueJobs\(/.test(auth));
    check("the pure core does no I/O", !/@\/lib\/db|fetch\(|server-only/.test(core));
    check("nothing writes", !/\.(create|update|upsert|delete)\w*\(/.test(all));
  }

  console.log("scope · no OPS-2D concepts");
  {
    const all =
      strip("lib/platform/scheduler/observation-core.ts") +
      strip("lib/platform/scheduler/observation.ts") +
      strip("app/api/platform/platform-ops/scheduler/route.ts") +
      strip("components/platform/widgets/OpsSchedulerWidget.tsx");
    check(
      "no pause/resume/disable/enable/skip vocabulary",
      !/\bpause|\bresume|\bdisable|\benable\b|skipNext/i.test(all),
    );
    check("no admission/policy/mayRun", !/mayRun|admission|declaredPolicy|JobControlState|JobAdmissionPolicy/i.test(all));
    check("no maintenance mode", !/maintenanceMode|maintenance mode/i.test(all));
    check("no schedule persistence or editing", !/saveSchedule|updateSchedule|editSchedule|scheduleKind/i.test(all));
    check("the route exposes no mutating verb", !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(strip("app/api/platform/platform-ops/scheduler/route.ts")));
  }

  console.log("route · READ-gated");
  {
    const route = strip("app/api/platform/platform-ops/scheduler/route.ts");
    check("requires PLATFORM_OPS READ", /requirePlatformAccess\(\s*["']PLATFORM_OPS["']\s*,\s*["']READ["']\s*\)/.test(route));
    check("never requests WRITE", !/["']WRITE["']/.test(route));
    check("returns early on the auth error", /if\s*\(\s*err\s*\)\s*return\s+err/.test(route));
    check("touches no db directly", !/@\/lib\/db/.test(route));
  }

  console.log("widget · groups kept apart, joins the workspace session");
  {
    const widget = strip("components/platform/widgets/OpsSchedulerWidget.tsx");
    check("renders an Observed group label", />\s*Observed\s*</.test(widget));
    check("renders an Expected group label", />\s*Expected\s*</.test(widget));
    check(
      "Observed precedes Expected (evidence before configuration)",
      widget.indexOf("Observed") < widget.indexOf("Expected"),
    );
    check(
      "observed and expected figures are read from separate payload groups",
      /observed\.(lastRecordedExecutionAt|recordedExecutions)/.test(widget) &&
        /expected\.(nextSlotAt|registeredJobs)/.test(widget),
    );
    check("renders notes from the payload, not hardcoded copy", /notes\.map\(/.test(widget));
    check("consumes the shared workspace session", /useSharedWidgetFetch/.test(widget));
    check("derives nothing", !/\.reduce\(|\.filter\(|\.sort\(/.test(widget));
    check("no health colour roll-up", !/healthy|OPERATIONAL/i.test(widget));
  }

  if (failures > 0) {
    console.error(`\nobservation.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nobservation.test: all passed.");
}

main();
