/**
 * lib/ai/conversation/runtime-state.ts
 *
 * THE CONVERSATION'S CONTINUITY, SEALED FOR THE ROUND TRIP.
 *
 * ⚠️ THE PROBLEM. An in-process session keeps the active-scenario slot in
 * memory for as long as it lives. An HTTP conversation has no such place: the
 * route holds nothing between requests, the browser holds only the prose that
 * was said, and the transcript it sends back carries no tool call the scenario
 * could be rebuilt from. Without a carrier, the envelope designed for scenario
 * continuity would exist on one client and not the other.
 *
 * ⚠️ WHY THIS IS NOT "TRUSTING THE BROWSER". The browser is given an opaque
 * blob it cannot read, cannot edit into a different scenario, and cannot use
 * anywhere but the conversation it came from. It is AES-256-GCM under a
 * purpose-derived subkey (the mechanism the repo already uses for every other
 * secret it hands out), and the sealed payload names the user, the Space and
 * the exact conversation tail it was issued for. A blob that fails any of those
 * checks is not an error — it is simply no state, and the turn runs without a
 * hypothetical, which is what a fresh conversation does anyway.
 *
 * ⚠️ WHAT IT IS NOT. Not persistence: nothing is written, nothing is keyed by a
 * conversation id, and every seal dies with the cookie that carried it. Not a
 * cache: it holds one scenario, never evidence, never a tool result, never a
 * figure the model would otherwise have to fetch. Not a session: it survives no
 * logout, no Space switch and no new conversation.
 */

import { createHash } from 'crypto';
import {
  sealWithPurpose, openWithPurpose, EncryptionPurpose,
} from '@/lib/plaid/encryption';
import type { ActiveScenario } from './active-scenario';
import { isPendingPlan, type PendingPlan } from './pending-plan';

/** Bumped when the sealed shape changes. An older version is discarded, never coerced. */
// 2 — a conversation may now carry STAGED clauses beside an executed scenario
// (`pending-plan.ts`). A v1 seal is discarded, never coerced: it cannot say
// whether a pending plan existed, and guessing "none" is the safe reading anyway.
// 3 — FM-AUDIT-018: compact base64url sealing (~50% more state in the same
// cookie), and an explicit CONTINUITY marker when state cannot be carried. A v2
// seal is discarded, never coerced — the next turn simply starts without state,
// which is what a fresh conversation does.
const VERSION = 3;

/**
 * How long a sealed state may be presented.
 *
 * ⚠️ SHORTER THAN A SESSION, LONGER THAN A THOUGHT. A hypothetical is something
 * the user is actively discussing; two hours after the last turn, silently
 * re-establishing it would be surprising rather than continuous.
 */
export const RUNTIME_STATE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The largest seal worth issuing.
 *
 * ⚠️ A BROWSER DISCARDS AN OVERSIZED COOKIE SILENTLY — a browser's limit is 4,096
 * bytes of name plus value, and `fm_ai_state=` is 12 of them — so nothing larger
 * than this is ever set. The seal is base64url, so it needs no URL-encoding.
 *
 * 3,000 → 3,900 (planning continuity), set from a measurement: a 1,000-byte
 * envelope beside a plan at its staging cap was refused at 3,600.
 *
 * FM-AUDIT-018 — the CEILING stays; what fits under it grew, and what does not fit
 * is no longer silent. Hex spent two characters per plaintext byte; base64url
 * spends 1.33 (`sealWithPurpose`), so ~2,880 bytes of state fit where ~1,900 did.
 * State that STILL does not fit is replaced by a sealed CONTINUITY MARKER (a few
 * hundred characters, always under the ceiling): the next turn is TOLD the plan
 * was not carried, instead of quietly having no plan and answering from trend.
 */
export const MAX_SEALED_CHARS = 3_900;

/**
 * FM-AUDIT-018 — what was lost when state could not be carried, and when. Carried
 * as its own small slot (never merged into the executed or the staged slot), so
 * the next turn can say the plan is NOT in force and keep treating the plan as in
 * play (project_cash will not quietly answer the plan's question from trend).
 */
export interface ContinuityLoss {
  reason: 'TOO_LARGE';
  /** An executed scenario was dropped. */
  droppedScenario: boolean;
  /** How many staged (not-yet-run) conditions were dropped. */
  droppedPendingClauses: number;
  /** The size the full state would have sealed to. */
  wouldHaveSealedTo: number;
  /** ISO timestamp of the loss. */
  at: string;
}

/**
 * What a conversation carries between turns: what RAN, and what has been stated
 * since and has not run yet. Two slots, never one object — the envelope means
 * "this executed", and a clause that merely was said must never borrow that.
 */
export interface RuntimeState {
  scenario: ActiveScenario | null;
  /** Conditions staged in this conversation and not yet run. Absent when none. */
  pending?: PendingPlan | null;
  /** A plan this conversation built that could NOT be carried (FM-AUDIT-018). Absent when none. */
  continuity?: ContinuityLoss | null;
}

/**
 * What a seal is valid FOR.
 *
 * ⚠️ THE TAIL IS WHAT MAKES IT ONE CONVERSATION. `userId` and `spaceId` stop a
 * seal being replayed into someone else's money or another Space's; the tail —
 * a digest of the last thing the assistant said — stops it being replayed into
 * a DIFFERENT conversation in the same browser. A new chat starts with no
 * assistant turn, so its tail cannot match any seal ever issued.
 */
export interface StateBinding {
  userId:  string;
  spaceId: string;
  tail:    string;
}

interface SealedPayload extends RuntimeState, StateBinding {
  v:   number;
  iat: number;
}

/**
 * The digest of a conversation's last assistant turn, or '' when it has none.
 *
 * Content only — no salt, no key. It identifies a conversation; it protects
 * nothing on its own, and the seal around it is what provides integrity.
 */
export function conversationTail(history: readonly { role: string; content: string }[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant') {
      return createHash('sha256').update(m.content).digest('hex').slice(0, 32);
    }
  }
  return '';
}

/** How a turn's state crossed the boundary. */
export interface SealReport {
  /** The cookie value, or null to clear the carrier (nothing to carry, or no cipher). */
  sealed: string | null;
  /** FULL — state carried whole; LOST — a continuity marker carried instead; NONE — nothing to carry. */
  carried: 'FULL' | 'LOST' | 'NONE';
  /** Present when `carried === 'LOST'`: exactly what was not carried. */
  loss?: ContinuityLoss;
  /** True when the loss happened THIS turn (a surface tells the user once); false when carried forward. */
  fresh?: boolean;
}

function sealPayload(payload: SealedPayload): string {
  return sealWithPurpose(JSON.stringify(payload), EncryptionPurpose.AI_RUNTIME_STATE);
}

/**
 * Seal state for one conversation, one user, one Space — and say how it went.
 *
 * ⚠️ FM-AUDIT-018 — STATE THAT DOES NOT FIT IS NEVER DROPPED SILENTLY. It was:
 * an oversize seal returned null, the route cleared the cookie, and the next turn
 * had no scenario and no staged conditions — with nothing anywhere saying so,
 * and the project_cash guard (which refuses to answer a plan's question from the
 * current trend) switched off because no plan was visible. Now the state is
 * replaced by a sealed continuity marker naming what was lost; the next turn is
 * told, and the plan stays "in play". A missing key still degrades to no state
 * (null): continuity is a convenience, and it must never fail the answer.
 */
export function sealRuntimeStateWithReport(state: RuntimeState, binding: StateBinding): SealReport {
  const pending = state.pending && state.pending.clauses.length > 0 ? state.pending : null;
  const continuity = state.continuity ?? null;
  if (!state.scenario && !pending && !continuity) return { sealed: null, carried: 'NONE' };
  const base = { v: VERSION, iat: Date.now(), ...binding };
  try {
    const sealed = sealPayload({ ...base, scenario: state.scenario,
      ...(pending ? { pending } : {}), ...(continuity ? { continuity } : {}) });
    if (sealed.length <= MAX_SEALED_CHARS) {
      return continuity ? { sealed, carried: 'LOST', loss: continuity, fresh: false } : { sealed, carried: 'FULL' };
    }
    const loss: ContinuityLoss = {
      reason: 'TOO_LARGE',
      droppedScenario: state.scenario !== null || (continuity?.droppedScenario ?? false),
      droppedPendingClauses: (pending?.clauses.length ?? 0) + (continuity?.droppedPendingClauses ?? 0),
      wouldHaveSealedTo: sealed.length,
      at: new Date(base.iat).toISOString(),
    };
    const marker = sealPayload({ ...base, scenario: null, continuity: loss });
    return marker.length <= MAX_SEALED_CHARS ? { sealed: marker, carried: 'LOST', loss, fresh: true } : { sealed: null, carried: 'NONE' };
  } catch {
    return { sealed: null, carried: 'NONE' };
  }
}

/**
 * Seal state for one conversation, one user, one Space. The cookie value, or null
 * to clear the carrier — see `sealRuntimeStateWithReport` for how it went.
 */
export function sealRuntimeState(state: RuntimeState, binding: StateBinding): string | null {
  return sealRuntimeStateWithReport(state, binding).sealed;
}

/**
 * Open a sealed state, or refuse it.
 *
 * ⚠️ EVERY FAILURE IS THE SAME FAILURE: null. A forged blob, a blob from another
 * user, another Space, another conversation, an older version, an expired one,
 * a truncated one and a missing encryption key are all "this turn has no
 * hypothetical". Distinguishing them in the return value would hand a caller a
 * reason to treat one of them as recoverable.
 */
export function openRuntimeState(
  sealed: string | null | undefined, binding: StateBinding,
): RuntimeState | null {
  if (!sealed) return null;
  let payload: SealedPayload;
  try {
    payload = JSON.parse(
      openWithPurpose(sealed, EncryptionPurpose.AI_RUNTIME_STATE)) as SealedPayload;
  } catch {
    return null;
  }
  if (payload?.v !== VERSION) return null;
  if (payload.userId !== binding.userId) return null;
  if (payload.spaceId !== binding.spaceId) return null;
  if (payload.tail !== binding.tail) return null;
  if (typeof payload.iat !== 'number' || Date.now() - payload.iat > RUNTIME_STATE_TTL_MS) return null;
  // ⚠️ A STAGED PLAN THAT IS NOT ONE IS DROPPED ON ITS OWN; A SCENARIO THAT IS
  // NOT ONE DROPS EVERYTHING. The first is conditions nobody ran, and losing them
  // costs a restatement. The second is a claim about what executed, and a seal
  // that carries a malformed one is not a seal this code issued.
  const pending = isPendingPlan(payload.pending) ? payload.pending : null;
  const scenario = payload.scenario ?? null;
  if (scenario !== null && (typeof scenario !== 'object'
    || typeof scenario.assumptions !== 'object' || scenario.assumptions === null
    || typeof scenario.result !== 'object' || scenario.result === null)) return null;
  const continuity = isContinuityLoss(payload.continuity) ? payload.continuity : null;
  if (!scenario && !pending && !continuity) return null;
  return { scenario, ...(pending ? { pending } : {}), ...(continuity ? { continuity } : {}) };
}

function isContinuityLoss(x: unknown): x is ContinuityLoss {
  const c = x as ContinuityLoss | null | undefined;
  return !!c && c.reason === 'TOO_LARGE' && typeof c.droppedScenario === 'boolean'
    && Number.isInteger(c.droppedPendingClauses) && typeof c.at === 'string';
}
