/**
 * lib/ai/conversation/continuity.ts — FM-AUDIT-018
 *
 * What a turn is TOLD when the plan this conversation built could not be carried
 * to it (the sealed carrier — runtime-state.ts — replaced the state with a
 * continuity marker because it was too large). The carrier only carries; the
 * transcript is shaped here, beside pending-plan.ts's injection of what is
 * staged and active-scenario.ts's injection of what ran.
 *
 * Pure: no I/O.
 */

import type { ContinuityLoss } from './runtime-state';

/**
 * The system message a turn receives when the conversation's plan could not be
 * carried to it. Tells the model the plan is NOT in force and what to do.
 */
export const CONTINUITY_MARKER = 'CONTINUITY NOT CARRIED';
export function continuityMessage(loss: ContinuityLoss): { role: 'system'; content: string } {
  const what = [
    loss.droppedScenario ? 'the scenario that ran earlier in this conversation (its assumptions and result)' : null,
    loss.droppedPendingClauses > 0 ? `${loss.droppedPendingClauses} staged condition(s) that had not run yet` : null,
  ].filter(Boolean).join(' and ');
  return { role: 'system', content: `${CONTINUITY_MARKER}\n${JSON.stringify({
    lost: what || 'the plan built earlier in this conversation',
    why: 'it was too large to carry between turns',
    inForce: false,
    doNot: 'Do not quote any earlier scenario figure as current, and do not answer the plan\'s question from the current trend as if the plan applied.',
    instead: 'Tell the user the earlier plan could not be carried forward. Re-run scenario_projection with every condition they want (they can restate them), or — only if they ask for the current trend without their plan — use project_cash with ignoreStaged: true and say so.',
  })}` };
}

const isContinuityMessage = (m: unknown): boolean =>
  typeof (m as { content?: unknown })?.content === 'string'
  && (m as { content: string }).content.startsWith(CONTINUITY_MARKER);

/** Put the continuity notice in place — replaced, never appended; removed when there is no loss. */
export function injectContinuity(messages: unknown[], loss: ContinuityLoss | null): unknown[] {
  for (let i = messages.length - 1; i >= 0; i--) if (isContinuityMessage(messages[i])) messages.splice(i, 1);
  if (loss) messages.push(continuityMessage(loss));
  return messages;
}
