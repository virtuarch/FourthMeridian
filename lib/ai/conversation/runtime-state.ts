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
  encryptWithPurpose, decryptWithPurpose, EncryptionPurpose,
} from '@/lib/plaid/encryption';
import type { ActiveScenario } from './active-scenario';
import { isPendingPlan, type PendingPlan } from './pending-plan';

/** Bumped when the sealed shape changes. An older version is discarded, never coerced. */
// 2 — a conversation may now carry STAGED clauses beside an executed scenario
// (`pending-plan.ts`). A v1 seal is discarded, never coerced: it cannot say
// whether a pending plan existed, and guessing "none" is the safe reading anyway.
const VERSION = 2;

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
 * ⚠️ A BROWSER DISCARDS AN OVERSIZED COOKIE SILENTLY, and a silently discarded
 * carrier is continuity that works until the day a user states a scenario with
 * enough one-off events in it, then stops — with nothing anywhere saying why. A
 * scenario that will not fit is therefore refused HERE, where the caller clears
 * the carrier deliberately and the next turn simply has no hypothetical. The
 * ceiling is well under the ~4 KB a cookie gets, after URL-encoding roughly
 * doubles the hex; a measured ordinary scenario seals to about 1.1 KB.
 */
// ⚠️ 3,000 → 3,900 (planning continuity), SET FROM A MEASUREMENT. The carrier now
// holds the executed scenario AND the conditions staged since it ran, and a seal
// over the ceiling is discarded WHOLE — so it must hold the worst case of both at
// once. Tested, not estimated: a 1,000-byte envelope (its pinned ceiling) beside a
// plan at its staging cap was refused at 3,600. The seal is hex, so it needs no
// URL-encoding; a browser's limit is 4,096 bytes of name plus value, and
// `fm_ai_state=` is 12 of them.
export const MAX_SEALED_CHARS = 3_900;

/**
 * What a conversation carries between turns: what RAN, and what has been stated
 * since and has not run yet. Two slots, never one object — the envelope means
 * "this executed", and a clause that merely was said must never borrow that.
 */
export interface RuntimeState {
  scenario: ActiveScenario | null;
  /** Conditions staged in this conversation and not yet run. Absent when none. */
  pending?: PendingPlan | null;
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

/**
 * Seal state for one conversation, one user, one Space.
 *
 * Returns null when there is nothing worth carrying, when what there is will not
 * fit a cookie, and on a cipher failure — all three the same way, because all
 * three mean the same thing to the caller: clear the carrier. Continuity is a
 * convenience, and a missing key or an outsized hypothetical must degrade the
 * conversation, never fail the answer.
 */
export function sealRuntimeState(
  state: RuntimeState, binding: StateBinding,
): string | null {
  const pending = state.pending && state.pending.clauses.length > 0 ? state.pending : null;
  if (!state.scenario && !pending) return null;
  const payload: SealedPayload = {
    v: VERSION, iat: Date.now(), ...binding, scenario: state.scenario,
    ...(pending ? { pending } : {}) };
  try {
    const sealed = encryptWithPurpose(
      JSON.stringify(payload), EncryptionPurpose.AI_RUNTIME_STATE);
    return sealed.length > MAX_SEALED_CHARS ? null : sealed;
  } catch {
    return null;
  }
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
      decryptWithPurpose(sealed, EncryptionPurpose.AI_RUNTIME_STATE)) as SealedPayload;
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
  if (!scenario && !pending) return null;
  return { scenario, ...(pending ? { pending } : {}) };
}
