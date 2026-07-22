/**
 * lib/goals/goal-trajectory.test.ts
 *
 * UX-PER-3 Goals — pure trajectory math. Runnable with tsx:
 *   npx tsx lib/goals/goal-trajectory.test.ts
 * Auto-discovered by scripts/run-tests.ts. Pure module.
 */

import {
  progressPct,
  remainingGap,
  monthsUntil,
  isOverdue,
  requiredMonthly,
  onTrackSummary,
  activeFinancialGoals,
  type TrajectoryGoal,
} from "@/lib/goals/goal-trajectory";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

function goal(p: Partial<TrajectoryGoal> & { id: string }): TrajectoryGoal {
  return { name: p.id, goalType: "FINANCIAL", status: "ACTIVE", targetAmount: 1000, currentAmount: 0, targetDate: null, ...p };
}

const now = new Date(2026, 6, 9); // 2026-07-09

// ── Progress ────────────────────────────────────────────────────────────────────
check("50% progress", progressPct(goal({ id: "g", currentAmount: 500, targetAmount: 1000 })) === 50);
check("progress clamps at 100", progressPct(goal({ id: "g", currentAmount: 1500, targetAmount: 1000 })) === 100);
check("no target → 0%", progressPct(goal({ id: "g", targetAmount: null })) === 0);
check("remaining gap", remainingGap(goal({ id: "g", currentAmount: 300, targetAmount: 1000 })) === 700);
check("remaining gap never negative", remainingGap(goal({ id: "g", currentAmount: 1200, targetAmount: 1000 })) === 0);

// ── Months until ────────────────────────────────────────────────────────────────
check("~3 months until 2026-10-08", Math.round(monthsUntil("2026-10-08", now)) === 3);
check("past date → 0 months", monthsUntil("2026-01-01", now) === 0);
check("no date → 0 months", monthsUntil(null, now) === 0);

// ── Overdue ────────────────────────────────────────────────────────────────────
check("past deadline + unfunded → overdue",
  isOverdue(goal({ id: "g", currentAmount: 200, targetAmount: 1000, targetDate: "2026-06-01" }), now));
check("past deadline but funded → not overdue",
  !isOverdue(goal({ id: "g", currentAmount: 1000, targetAmount: 1000, targetDate: "2026-06-01" }), now));
check("future deadline → not overdue",
  !isOverdue(goal({ id: "g", currentAmount: 200, targetAmount: 1000, targetDate: "2026-12-01" }), now));
check("no deadline → not overdue",
  !isOverdue(goal({ id: "g", currentAmount: 200, targetAmount: 1000, targetDate: null }), now));

// ── Required monthly (what you NEED, not actual pace) ────────────────────────────
const req = requiredMonthly(goal({ id: "g", currentAmount: 100, targetAmount: 1000, targetDate: "2026-10-08" }), now);
check("required monthly ≈ 900/3 = 300", req != null && Math.abs(req - 300) < 5);
check("no deadline → required monthly null",
  requiredMonthly(goal({ id: "g", currentAmount: 100, targetAmount: 1000, targetDate: null }), now) === null);
check("past deadline → required monthly null (overdue, not a pace)",
  requiredMonthly(goal({ id: "g", currentAmount: 100, targetAmount: 1000, targetDate: "2026-01-01" }), now) === null);
check("already funded → required monthly null",
  requiredMonthly(goal({ id: "g", currentAmount: 1000, targetAmount: 1000, targetDate: "2026-10-08" }), now) === null);

// ── Working set + summary ────────────────────────────────────────────────────────
const goals: TrajectoryGoal[] = [
  goal({ id: "onTrack", currentAmount: 500, targetAmount: 1000, targetDate: "2026-12-01" }),
  goal({ id: "overdue", currentAmount: 200, targetAmount: 1000, targetDate: "2026-06-01" }),
  goal({ id: "funded",  currentAmount: 1000, targetAmount: 1000 }),
  goal({ id: "habit", goalType: "HABIT", targetAmount: null }),          // excluded
  goal({ id: "archived", status: "ARCHIVED", currentAmount: 500 }),      // excluded
];
check("activeFinancialGoals excludes habit + archived",
  activeFinancialGoals(goals).map((g) => g.id).sort().join(",") === "funded,onTrack,overdue");

const s = onTrackSummary(goals, now);
check("summary: 3 active", s.active === 3);
check("summary: 1 funded", s.funded === 1);
check("summary: 1 overdue", s.overdue === 1);
check("summary: onTrack = active − overdue = 2", s.onTrack === 2);

console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("Goal-trajectory tests FAILED."); process.exit(1); }
console.log("Goal-trajectory tests passed.");
process.exit(0);
