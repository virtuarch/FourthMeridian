/**
 * lib/goals/goal-trajectory.ts
 *
 * Pure goal-trajectory math for the Goals Perspective (UX-PER-3). The Goals
 * workspace answers ONE question — "Am I on track?" — about trajectory vs
 * target, not current balances.
 *
 * HONESTY NOTE: there is no per-contribution history in the model (currentAmount
 * is a denormalized rollup; GoalContribution is an account link, not a ledger of
 * dated deposits), and goals carry no createdAt in the DTO. So we CANNOT compute
 * an actual contribution pace or a pace-based forecast. We compute only what the
 * data honestly supports: progress, remaining gap, overdue status, and the
 * REQUIRED monthly contribution to hit a target by its date. Actual-pace
 * projection is explicitly reported as unavailable until contribution history
 * exists.
 *
 * Pure/importable (no DB/React) — unit-testable with tsx.
 */

export interface TrajectoryGoal {
  id:            string;
  name:          string;
  goalType:      string;
  status:        string;
  targetAmount:  number | null;
  currentAmount: number;
  targetDate:    string | null;
  completedAt?:  string | null;
}

/** A financial goal with a positive target — the only kind this lens measures. */
export function isFinancialGoal(g: TrajectoryGoal): boolean {
  return g.goalType === "FINANCIAL" && (g.targetAmount ?? 0) > 0;
}

/** Active (in-progress) — excludes completed/archived/etc. */
export function isActiveGoal(g: TrajectoryGoal): boolean {
  return g.status === "ACTIVE";
}

/** Financial + active — the working set for the on-track question. */
export function activeFinancialGoals(goals: TrajectoryGoal[]): TrajectoryGoal[] {
  return goals.filter((g) => isFinancialGoal(g) && isActiveGoal(g));
}

/** 0–100, clamped. */
export function progressPct(g: TrajectoryGoal): number {
  const target = g.targetAmount ?? 0;
  if (target <= 0) return 0;
  return Math.min(100, Math.max(0, (g.currentAmount / target) * 100));
}

/** Amount still needed (≥ 0). */
export function remainingGap(g: TrajectoryGoal): number {
  return Math.max(0, (g.targetAmount ?? 0) - g.currentAmount);
}

/** Whole/fractional months from `now` to a date; 0 if the date is past/absent. */
export function monthsUntil(dateStr: string | null, now: Date = new Date()): number {
  if (!dateStr) return 0;
  const target = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return ms / (1000 * 60 * 60 * 24 * 30.44);
}

/** Deadline passed and not yet funded. */
export function isOverdue(g: TrajectoryGoal, now: Date = new Date()): boolean {
  if (!g.targetDate) return false;
  if (progressPct(g) >= 100) return false;
  return new Date(`${g.targetDate.slice(0, 10)}T00:00:00`).getTime() < now.getTime();
}

/**
 * Required monthly contribution to reach the target by its date. Null when
 * there's no date, nothing remaining, or the deadline has passed (that's an
 * overdue signal, not a pace). This is what you NEED to do — NOT a claim about
 * your actual pace, which isn't tracked.
 */
export function requiredMonthly(g: TrajectoryGoal, now: Date = new Date()): number | null {
  if (!g.targetDate) return null;
  const gap = remainingGap(g);
  if (gap <= 0) return null;
  const months = monthsUntil(g.targetDate, now);
  if (months <= 0) return null;
  return gap / months;
}

export interface OnTrackSummary {
  active:  number;   // active financial goals
  funded:  number;   // fully funded (≥100%)
  overdue: number;   // past deadline, not funded
  onTrack: number;   // active − overdue
}

export function onTrackSummary(goals: TrajectoryGoal[], now: Date = new Date()): OnTrackSummary {
  const active = activeFinancialGoals(goals);
  const funded  = active.filter((g) => progressPct(g) >= 100).length;
  const overdue = active.filter((g) => isOverdue(g, now)).length;
  return { active: active.length, funded, overdue, onTrack: active.length - overdue };
}
