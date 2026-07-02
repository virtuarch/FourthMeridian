/**
 * lib/ai/assemblers/goals.ts
 *
 * AI Context Assembler — 'goals' domain (D4 Slice 3).
 *
 * Assembles a ContextDomainSection for FinanceDomains.GOALS containing
 * the active, paused, and completed (non-trashed, non-cancelled) goals
 * for the validated Space.
 *
 * ── Included goals ───────────────────────────────────────────────────────────
 *   ACTIVE    — in-progress goals; primary AI subject
 *   PAUSED    — temporarily suspended; still relevant for advice
 *   COMPLETED — recently achieved; context for progress narrative
 *
 * Excluded:
 *   CANCELLED — user explicitly abandoned; not useful for advice
 *   Trashed   — deletedAt is not null; treated as deleted
 *
 * Archived goals (archivedAt not null) are included — the existing route
 * does not filter on archivedAt for the main list, matching that behaviour.
 *
 * ── scopeHint behaviour ──────────────────────────────────────────────────────
 *   'full'  — all non-cancelled, non-trashed goals
 *   'brief' — ACTIVE goals only (tightest summary for Daily Brief)
 *
 * ── Permissions ──────────────────────────────────────────────────────────────
 * buildContext() validates Space membership before invoking any assembler.
 * All queries are filtered by spaceCtx.spaceId — no cross-Space data possible.
 * SpaceGoal belongs directly to a Space (spaceId FK), so no additional
 * share-layer permission is required (unlike accounts, which go through
 * SpaceAccountLink and have a visibilityLevel tier).
 *
 * ── Security invariants ──────────────────────────────────────────────────────
 * - Does NOT import lib/plaid/encryption or call any decrypt function.
 * - Does NOT query WorkspaceAccountShare.
 * - Queries are always filtered by spaceCtx.spaceId.
 */

import { db } from '@/lib/db';
import { GoalStatus } from '@prisma/client';

import { registerAssembler } from '@/lib/ai/assembler-registry';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
  GoalsSectionData,
  GoalSummaryItem,
} from '@/lib/ai/types';
import type { SpaceContext } from '@/lib/space';

// ---------------------------------------------------------------------------
// Assembler implementation
// ---------------------------------------------------------------------------

async function assembleGoals(
  spaceCtx: SpaceContext,
  options:  AssemblerOptions,
): Promise<ContextDomainSection | null> {
  const { spaceId } = spaceCtx;
  const { scopeHint = 'full' } = options;
  const assembledAt = new Date().toISOString();

  // ── Build status filter ───────────────────────────────────────────────────

  // brief → ACTIVE only; full → all non-cancelled, non-trashed
  const statusFilter: GoalStatus[] = scopeHint === 'brief'
    ? [GoalStatus.ACTIVE]
    : [GoalStatus.ACTIVE, GoalStatus.PAUSED, GoalStatus.COMPLETED];

  // ── Query ─────────────────────────────────────────────────────────────────

  const goals = await db.spaceGoal.findMany({
    where: {
      spaceId,
      deletedAt: null,                      // exclude trashed
      status:    { in: statusFilter },      // exclude CANCELLED
    },
    orderBy: [
      { status:     'asc' },   // ACTIVE → COMPLETED → PAUSED (enum sort)
      { targetDate: 'asc' },   // soonest deadline first within status
      { createdAt:  'asc' },
    ],
    select: {
      id:                    true,
      name:                  true,
      category:              true,
      goalType:              true,
      status:                true,
      // Financial / spending
      targetAmount:          true,
      currentAmount:         true,
      targetDate:            true,
      // Debt reduction
      targetReductionAmount: true,
      targetReductionPct:    true,
      snapshotBalance:       true,
      // Habit
      habitFrequency:        true,
      currentStreak:         true,
      longestStreak:         true,
      lastCheckIn:           true,
      completedAt:           true,
    },
  });

  // No goals → return null so the domain is noted as empty.
  if (goals.length === 0) return null;

  // ── Normalize ─────────────────────────────────────────────────────────────

  const items: GoalSummaryItem[] = goals.map((g): GoalSummaryItem => {
    // Progress percentage: only computable for types where targetAmount > 0
    let progressPct: number | null = null;
    if (
      (g.goalType === 'FINANCIAL' || g.goalType === 'SPENDING_LIMIT') &&
      g.targetAmount != null &&
      g.targetAmount > 0
    ) {
      progressPct = Math.min(
        100,
        Math.round((g.currentAmount / g.targetAmount) * 100),
      );
    }
    // DEBT_REDUCTION and HABIT types intentionally omit progressPct:
    //   DEBT_REDUCTION: progress direction is inverted (balance decreasing)
    //     and depends on snapshotBalance/targetReductionAmount semantics —
    //     exposed as raw fields for the AI to interpret.
    //   HABIT: progress is expressed through streak, not a percentage.

    const item: GoalSummaryItem = {
      id:       g.id,
      name:     g.name,
      category: g.category,
      goalType: g.goalType,
      status:   g.status,
    };

    // ── Type-specific fields ───────────────────────────────────────────────
    // Only include fields that are populated for this goalType to avoid
    // cluttering the payload with null fields from other types.

    if (g.goalType === 'FINANCIAL' || g.goalType === 'SPENDING_LIMIT') {
      item.targetAmount  = g.targetAmount;
      item.currentAmount = g.currentAmount;
      item.progressPct   = progressPct;
      item.targetDate    = g.targetDate?.toISOString().split('T')[0] ?? null;
    }

    if (g.goalType === 'DEBT_REDUCTION') {
      item.currentAmount         = g.currentAmount;
      item.targetReductionAmount = g.targetReductionAmount;
      item.targetReductionPct    = g.targetReductionPct;
      item.snapshotBalance       = g.snapshotBalance;
      item.targetDate            = g.targetDate?.toISOString().split('T')[0] ?? null;
    }

    if (g.goalType === 'HABIT') {
      item.habitFrequency = g.habitFrequency;
      item.currentStreak  = g.currentStreak;
      item.longestStreak  = g.longestStreak;
      item.lastCheckIn    = g.lastCheckIn?.toISOString() ?? null;
    }

    if (g.completedAt) {
      item.completedAt = g.completedAt.toISOString();
    }

    return item;
  });

  // ── Counts ────────────────────────────────────────────────────────────────

  const counts = {
    active:    items.filter((g) => g.status === GoalStatus.ACTIVE).length,
    paused:    items.filter((g) => g.status === GoalStatus.PAUSED).length,
    completed: items.filter((g) => g.status === GoalStatus.COMPLETED).length,
  };

  const data: GoalsSectionData = {
    totalCount: items.length,
    counts,
    goals:      items,
  };

  return {
    domain:      FinanceDomains.GOALS,
    assembledAt,
    data,
  };
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerAssembler(FinanceDomains.GOALS, assembleGoals);
