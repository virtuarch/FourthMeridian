/**
 * lib/space/dashboard-types.ts
 *
 * Shared view-model types for the Space dashboard surface (SD-7). These were
 * previously declared inline in components/dashboard/SpaceDashboard.tsx; they moved
 * here verbatim so the host, the extracted section subsystem
 * (components/space/sections/*), and the standard Workspaces
 * (components/space/workspaces/*) all consume ONE definition instead of the host
 * owning types its children need. Pure types — no React, no runtime.
 */

export type DashboardSection = {
  id:          string;
  key:         string;
  label:       string;
  tab:         string;
  enabled:     boolean;
  order:       number;
  config:      Record<string, unknown> | null;
};

export type SpaceAccount = {
  id:             string;
  name:           string;
  type:           string;
  institution:    string;
  balance:        number;
  currency:       string;
  lastUpdated:    string;
  creditLimit?:   number;
  interestRate?:  number;  // APR, e.g. 19.99
  minimumPayment?: number; // monthly minimum
  earliestTxDate?: string | null; // YYYY-MM-DD earliest non-deleted tx (regen floor); FULL rows only
};

export type SpaceGoal = {
  id:                    string;
  name:                  string;
  description:           string | null;
  category:              string;
  goalType:              "FINANCIAL" | "HABIT" | "SPENDING_LIMIT" | "DEBT_REDUCTION";
  status:                string;
  targetAmount:          number | null;
  currentAmount:         number;
  targetDate:            string | null;
  completedAt:           string | null;
  archivedAt:            string | null;
  deletedAt:             string | null;
  // HABIT
  habitFrequency:        string | null;
  currentStreak:         number;
  longestStreak:         number;
  lastCheckIn:           string | null;
  checkIns:              { id: string; checkedAt: string; note: string | null }[];
  // SPENDING_LIMIT
  spendingCategory:      string | null;
  // DEBT_REDUCTION
  linkedAccountId:       string | null;
  targetReductionAmount: number | null;
  targetReductionPct:    number | null;
  snapshotBalance:       number | null;
};
