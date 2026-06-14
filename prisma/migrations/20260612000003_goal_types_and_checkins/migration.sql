-- Add GoalType enum
CREATE TYPE "GoalType" AS ENUM ('FINANCIAL', 'HABIT', 'SPENDING_LIMIT', 'DEBT_REDUCTION');

-- Add new columns to WorkspaceGoal
ALTER TABLE "WorkspaceGoal"
  ADD COLUMN "goalType"              "GoalType" NOT NULL DEFAULT 'FINANCIAL',
  ADD COLUMN "habitFrequency"        TEXT,
  ADD COLUMN "currentStreak"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "longestStreak"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastCheckIn"           TIMESTAMP(3),
  ADD COLUMN "spendingCategory"      TEXT,
  ADD COLUMN "linkedAccountId"       TEXT,
  ADD COLUMN "targetReductionAmount" DOUBLE PRECISION,
  ADD COLUMN "targetReductionPct"    DOUBLE PRECISION,
  ADD COLUMN "snapshotBalance"       DOUBLE PRECISION;

-- Make targetAmount optional (existing rows keep their value)
ALTER TABLE "WorkspaceGoal" ALTER COLUMN "targetAmount" DROP NOT NULL;

-- GoalCheckIn table
CREATE TABLE "GoalCheckIn" (
  "id"        TEXT NOT NULL,
  "goalId"    TEXT NOT NULL,
  "note"      TEXT,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoalCheckIn_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GoalCheckIn"
  ADD CONSTRAINT "GoalCheckIn_goalId_fkey"
  FOREIGN KEY ("goalId") REFERENCES "WorkspaceGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "GoalCheckIn_goalId_idx"        ON "GoalCheckIn"("goalId");
CREATE INDEX "GoalCheckIn_goalId_checkedAt_idx" ON "GoalCheckIn"("goalId", "checkedAt");
CREATE INDEX "WorkspaceGoal_workspaceId_goalType_idx" ON "WorkspaceGoal"("workspaceId", "goalType");
