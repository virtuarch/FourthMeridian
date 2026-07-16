/**
 * components/platform/widgets/job-health-format.test.ts  (OPS-5 S2)
 *
 * Pure guards for the OpsJobHealthWidget presentation helpers. Standalone tsx
 * script (house pattern): npx tsx components/platform/widgets/job-health-format.test.ts
 * — exits 0/1. No DOM, no React: the formatters are pure. Covers duration /
 * percent / cadence / relative-time formatting, the em-dash-on-null contract
 * (no fabricated metrics), and severity ordering across all six statuses.
 */

import {
  JOB_STATUS_META,
  fmtCadence,
  fmtDuration,
  fmtPercent,
  relTime,
  severityRank,
  statusLabel,
  statusTone,
} from "./job-health-format";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const DASH = "—";
const NOW = Date.parse("2026-07-16T12:00:00Z");

console.log("job-health-format (OPS-5 S2)");

// ── Duration ──────────────────────────────────────────────────────────────────
check("sub-second → ms", fmtDuration(840) === "840ms");
check("seconds → one-decimal s", fmtDuration(3200) === "3.2s");
check("minutes → m s", fmtDuration(125000) === "2m 5s");
check("hours → h m", fmtDuration(3840000) === "1h 4m");
check("null duration → em-dash (no fake metric)", fmtDuration(null) === DASH);
check("negative duration → em-dash", fmtDuration(-5) === DASH);

// ── Percent ───────────────────────────────────────────────────────────────────
check("rate 0.75 → 75%", fmtPercent(0.75) === "75%");
check("rate 1 → 100%", fmtPercent(1) === "100%");
check("null rate → em-dash", fmtPercent(null) === DASH);

// ── Cadence ───────────────────────────────────────────────────────────────────
check("24h → daily", fmtCadence(24) === "daily");
check("6h → every 6h", fmtCadence(6) === "every 6h");
check("sub-hour → minutes", fmtCadence(0.5) === "every 30m");
check("null cadence → em-dash", fmtCadence(null) === DASH);

// ── Relative time (signed, explicit clock) ────────────────────────────────────
check("past → ' ago'", relTime("2026-07-16T09:00:00Z", NOW) === "3h ago");
check("future → 'in '", relTime("2026-07-16T17:00:00Z", NOW) === "in 5h");
check("within a minute → now", relTime("2026-07-16T12:00:30Z", NOW) === "now");
check("days granularity", relTime("2026-07-14T12:00:00Z", NOW) === "2d ago");
check("null iso → em-dash", relTime(null, NOW) === DASH);
check("unparseable iso → em-dash", relTime("not-a-date", NOW) === DASH);

// ── Status metadata + ordering ────────────────────────────────────────────────
check("every status has label/rank/tone", (Object.keys(JOB_STATUS_META) as (keyof typeof JOB_STATUS_META)[]).every(
  (k) => typeof JOB_STATUS_META[k].label === "string" && typeof JOB_STATUS_META[k].rank === "number"));
check("severity: dead worst, healthy best",
  severityRank("dead") < severityRank("failing") &&
  severityRank("failing") < severityRank("overdue") &&
  severityRank("overdue") < severityRank("never-ran") &&
  severityRank("never-ran") < severityRank("running") &&
  severityRank("running") < severityRank("healthy"));
check("unknown status sorts last", severityRank("bogus") === 99);
check("labels human-readable", statusLabel("never-ran") === "Never ran" && statusLabel("dead") === "Dead");
check("unknown status label falls back to raw", statusLabel("bogus") === "bogus");
check("tone maps (healthy ok / dead bad / running info)",
  statusTone("healthy") === "ok" && statusTone("dead") === "bad" && statusTone("running") === "info");
check("unknown status tone → muted", statusTone("bogus") === "muted");

if (failures > 0) {
  console.error(`\njob-health-format tests: ${failures} FAILED`);
  process.exit(1);
}
console.log("\njob-health-format tests: all passed");
process.exit(0);
