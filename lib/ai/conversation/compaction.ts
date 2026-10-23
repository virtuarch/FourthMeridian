/**
 * lib/ai/conversation/compaction.ts
 *
 * CONTEXT GARBAGE COLLECTION. Not memory, not summarisation, not state.
 *
 * ⚠️ ONE THING IS REMOVED AND NOTHING IS ADDED. Raw tool-result CONTENT older than
 * a small window of completed turns is replaced by a stub saying it was elided.
 * The user's words, the assistant's words, and every tool CALL (name and
 * arguments) survive byte for byte. Nothing is summarised, no financial value is
 * carried forward, and no judgement is made about which evidence mattered.
 *
 * ⚠️ THE ARCHITECTURAL CHOICE THIS ENCODES: conversation prose + re-fetchable
 * authority, over conversation prose + synthetic memory of old evidence. If a
 * later turn needs an elided figure, the right thing is for the model to call the
 * authoritative tool again — and a stale payload sitting in context is exactly
 * what would stop it. Re-fetching is the feature.
 *
 * ⚠️ A TURN IS NOT A CONCEPT THIS FILE INVENTS. It is read off the transcript's
 * existing shape: a turn runs from a user message to the assistant message that
 * finally answers in prose. An assistant message carrying `tool_calls` is
 * mid-turn; an assistant message with EMPTY content is a failure, not an answer,
 * and the turn containing it is never treated as complete — so a blank or errored
 * turn keeps its raw evidence for diagnosis.
 *
 * PURE. No I/O, no clock, no model. Provider-shaped only where the wire format
 * requires it (`role`, `tool_calls`, `tool_call_id`).
 */

/** How much raw evidence stays behind the active turn. */
export interface CompactionPolicy {
  /** Completed turns whose tool results are kept verbatim. The active turn is always kept. */
  retainCompletedTurns: number;
}

export const DEFAULT_COMPACTION: CompactionPolicy = { retainCompletedTurns: 2 };

export interface CompactionStats {
  /** Tool-result messages replaced by a stub on THIS pass. */
  elided:        number;
  /** Tool-result messages left verbatim (active turn + retained window + already-elided). */
  retained:      number;
  /** Serialized bytes of tool-result content before and after. */
  bytesBefore:   number;
  bytesAfter:    number;
  /** Completed turns found in the transcript. */
  completedTurns: number;
  /** Index of the last message belonging to a compacted turn, or -1. */
  cutoffIndex:   number;
}

interface WireMessage {
  role?: string;
  content?: unknown;
  tool_calls?: { id?: string; function?: { name?: string } }[];
  tool_call_id?: string;
}

/** What the MODEL sees in place of an elided payload. Deliberately tiny. */
interface ElidedStub { elided: true; tool?: string }

const bytes = (v: unknown) => (typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length);

/** True when this tool message has already been replaced. Makes the pass idempotent. */
function isElided(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  try {
    const p = JSON.parse(content) as Partial<ElidedStub>;
    return p?.elided === true;
  } catch { return false; }
}

/**
 * An assistant message that ANSWERS: prose, no pending tool calls.
 *
 * ⚠️ EMPTY CONTENT IS NOT AN ANSWER. A reasoning model that spends its completion
 * budget returns `''` with no tool calls, and treating that as a turn boundary
 * would compact away the evidence of the very turn somebody needs to debug.
 */
function isCompletion(m: WireMessage): boolean {
  return m.role === 'assistant'
    && !m.tool_calls?.length
    && typeof m.content === 'string'
    && m.content.trim().length > 0;
}

/**
 * Replace tool-result content older than the retention window with a stub.
 *
 * Returns a NEW array. Input messages are never mutated, so a caller can compare
 * before and after — which is how the tests assert that user and assistant text
 * survives byte for byte.
 */
export function compactToolHistory(
  messages: readonly unknown[],
  policy: CompactionPolicy = DEFAULT_COMPACTION,
): { messages: unknown[]; stats: CompactionStats } {
  const retain = Math.max(0, policy.retainCompletedTurns);

  // Where each completed turn ends. Anything after the last one is the ACTIVE
  // turn — mid-loop evidence that must stay whole until its answer lands.
  const completions: number[] = [];
  messages.forEach((m, i) => { if (isCompletion(m as WireMessage)) completions.push(i); });

  // Everything up to and including this index may be compacted. -1 ⇒ nothing.
  const cutoffIndex = completions.length > retain
    ? completions[completions.length - retain - 1]
    : -1;

  let elided = 0, retained = 0, bytesBefore = 0, bytesAfter = 0;

  const out = messages.map((raw, i) => {
    const m = raw as WireMessage;
    if (m.role !== 'tool') return raw;

    const before = bytes(m.content);
    bytesBefore += before;

    if (i > cutoffIndex || isElided(m.content)) {
      retained += isElided(m.content) ? 0 : 1;
      bytesAfter += before;
      return raw;
    }

    // ⚠️ THE TOOL NAME COMES FROM THE ASSISTANT CALL THIS RESULT ANSWERS, not from
    // the payload. It costs ~20 bytes and tells the model what kind of evidence
    // used to be here, which is what lets it decide to fetch it again.
    const stub: ElidedStub = { elided: true, ...(nameFor(messages, i) ? { tool: nameFor(messages, i) } : {}) };
    const content = JSON.stringify(stub);
    elided++;
    bytesAfter += content.length;
    // ⚠️ `tool_call_id` AND `role` ARE COPIED THROUGH UNTOUCHED. Breaking that
    // linkage is a 400 from the provider, not a degraded answer.
    return { ...m, content };
  });

  return {
    messages: out,
    stats: { elided, retained, bytesBefore, bytesAfter,
      completedTurns: completions.length, cutoffIndex },
  };
}

/**
 * The tool name for the result at `index`, read from the nearest preceding
 * assistant tool-call message. Returns undefined when the transcript does not
 * say — the stub simply omits the field rather than guessing.
 */
function nameFor(messages: readonly unknown[], index: number): string | undefined {
  const target = (messages[index] as WireMessage).tool_call_id;
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i] as WireMessage;
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const hit = m.tool_calls.find((c) => c.id === target) ?? m.tool_calls[0];
    return hit?.function?.name;
  }
  return undefined;
}
