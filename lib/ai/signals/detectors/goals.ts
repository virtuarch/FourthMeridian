/**
 * lib/ai/signals/detectors/goals.ts
 *
 * Signal detectors for the 'goals' domain.
 *
 * Signals emitted:
 *   GOAL_COMPLETED — a goal was marked completed within the recency window
 *
 * Rules:
 *   - Fires once per completed goal (signal id includes goalId).
 *   - Recency window: 30 days from detectedAt. Goals completed longer ago
 *     are excluded — they were already surfaced in a prior brief cycle.
 *   - If completedAt is null for a COMPLETED goal (data inconsistency),
 *     the signal still fires without a recency check so it is never silently
 *     dropped.
 */

import { FinanceDomains } from '@/lib/ai/types';
import type { ContextDomainSection, ContextSignal, GoalsSectionData } from '@/lib/ai/types';
import { SignalType } from '@/lib/ai/signals/types';
import { registerDetector } from '@/lib/ai/signals/registry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Completed goals older than this are not re-surfaced. */
const COMPLETED_RECENCY_DAYS = 30;

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

function detectGoalSignals(
  domains: Record<string, ContextDomainSection>,
  spaceId: string,
): ContextSignal[] {
  const section = domains[FinanceDomains.GOALS];
  if (!section) return [];

  const data   = section.data as GoalsSectionData;
  const now    = new Date();
  const cutoff = new Date(now.getTime() - COMPLETED_RECENCY_DAYS * 24 * 60 * 60 * 1000);
  const signals: ContextSignal[] = [];

  for (const goal of data.goals) {
    if (goal.status !== 'COMPLETED') continue;

    // Recency check: skip goals completed before the cutoff window.
    // If completedAt is missing, emit anyway (defensive).
    if (goal.completedAt) {
      const completedDate = new Date(goal.completedAt);
      if (completedDate < cutoff) continue;
    }

    signals.push({
      id:         `${spaceId}:${SignalType.GOAL_COMPLETED}:${goal.id}`,
      type:       SignalType.GOAL_COMPLETED,
      domain:     FinanceDomains.GOALS,
      spaceId,
      severity:   'info',
      title:      `Goal completed — ${goal.name}`,
      metadata: {
        goalId:      goal.id,
        goalName:    goal.name,
        goalType:    goal.goalType,
        category:    goal.category,
        completedAt: goal.completedAt ?? null,
      },
      detectedAt: now.toISOString(),
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerDetector(detectGoalSignals);
