/**
 * lib/ai/conversation/engine.ts
 *
 * THE CONVERSATION, ASSEMBLED — one prologue, one turn, two clients.
 *
 * ⚠️ WHAT IT ADDS OVER turn.ts. `turn.ts` knows how to run ONE turn against an
 * existing transcript. This knows how a Fourth Meridian transcript BEGINS —
 * instruction, then the orientation evidence, then the conversation — and how to
 * rebuild that beginning for a caller who does not keep one in memory. Both the
 * terminal harness and POST /api/ai/chat open their transcripts here, so the
 * system a dogfood session measures is the system a user talks to.
 *
 * ⚠️ THE STATELESS PATH IS NOT A SECOND ARCHITECTURE. A browser turn is the same
 * transcript, rebuilt: system + evidence + the prose that has already been said +
 * the active scenario + the new question. What it cannot rebuild is the RAW tool
 * results of the last two turns, because the browser was never sent them — see
 * `replayHistory`. That is a stated difference in what the model can see, not a
 * different loop, and it is the reason the scenario envelope exists.
 *
 * ⚠️ IT DECIDES NOTHING ABOUT TRUST. Authentication, Space authorisation, rate
 * limiting and what may be echoed back to a browser belong to the route. This
 * module takes an already-authorised `SpaceContext` and will happily read
 * whatever it names.
 */

import {
  assembleFullContext, buildEvidence, ARM_USES_TOOLS, type Arm, type EvidencePack,
} from './evidence';
import { openAiToolSchemas, type ToolContext } from './tools';
import { executeTurn, supportsTools, SYSTEM_INSTRUCTION, type TurnRecord } from './turn';
import { newScenarioSlot, type ScenarioSlot, type ActiveScenario } from './active-scenario';
import { collectKnowledgeGaps } from './knowledge-gaps';
import { todayUTCISO } from '@/lib/time/clock';
import type { SpaceContext } from '@/lib/space';
import type { SpaceContext_AI } from '@/lib/ai/types';
import type { AiKnowledgeGap } from '@/types';

/**
 * The model the conversation runs on.
 *
 * ⚠️ NOT A PREFERENCE — IT IS THE CONFIGURATION THAT WAS MEASURED. Every gate
 * that cleared this runtime for promotion (the causal-evidence 2×2, the two-frame
 * product gate, the scenario-continuity validation, the 17-turn dogfood) ran on
 * gpt-5.1. A different tier here would ship a system nobody has read the
 * transcripts of, and the failures it reintroduced would be found by users. There
 * is deliberately no environment override: a model is changed by measuring the
 * new one, not by setting a variable.
 */
export const CHAT_MODEL = 'gpt-5.1';

/** The arm the product is. A2 = thin orientation + the tool surface. */
export const CHAT_ARM: Arm = 'A2';

/** One user/assistant turn as it crosses the wire. Prose only — never a tool call. */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface OpenTranscript {
  /** system + evidence. The caller appends turns to it. */
  messages:    unknown[];
  /**
   * The assembled domains the evidence was built FROM.
   *
   * ⚠️ FOR THE CALLER'S OWN DISPLAY, NOT FOR THE MODEL. The model sees
   * `evidence.body` and nothing else; this is here so an operator banner can
   * print a position without assembling the context a second time.
   */
  context:     SpaceContext_AI;
  evidence:    EvidencePack;
  toolSchemas: unknown[];
  toolCtx:     ToolContext;
  /**
   * Whether this transcript has tools at all: the arm must offer them AND the
   * model must be able to take them. A model that silently lost its tools would
   * be a different experiment reported under the same name.
   */
  usesTools:   boolean;
}

/**
 * Open a transcript: the instruction, dated, then the orientation evidence.
 *
 * ⚠️ ONE PROLOGUE, NOT THREE. The batch runner, the operator session and the
 * route all start a conversation the same way, and the day the three drifted is
 * the day a recorded transcript stopped describing the product.
 */
export async function openTranscript(args: {
  spaceCtx: SpaceContext;
  agentId:  string;
  asOfISO:  string;
  model:    string;
  arm?:     Arm;
}): Promise<OpenTranscript> {
  const { spaceCtx, agentId, asOfISO, model } = args;
  const arm = args.arm ?? CHAT_ARM;

  const ctx = await assembleFullContext(spaceCtx, agentId);
  const evidence = await buildEvidence(arm, ctx, spaceCtx);

  const usesTools = ARM_USES_TOOLS[arm] && supportsTools(model);
  const toolSchemas = usesTools ? openAiToolSchemas() : [];
  const toolCtx: ToolContext = { spaceCtx, spaceId: spaceCtx.spaceId, asOfISO };

  const messages: unknown[] = [
    { role: 'system', content: `${SYSTEM_INSTRUCTION}\n\nToday is ${asOfISO}.` },
  ];
  if (evidence.body) messages.push({ role: 'user', content: evidence.body });

  return { messages, context: ctx, evidence, toolSchemas, toolCtx, usesTools };
}

/**
 * Append prior turns to an open transcript.
 *
 * ⚠️ PROSE ONLY, AND THE GAP IS REAL. A stateless client holds what was SAID; it
 * never held the tool calls or their JSON results, so a rebuilt transcript has
 * none of them. Under the shipped compaction policy raw results older than two
 * completed turns are elided anyway, so this differs from an in-process session
 * for the most recent two turns only — there, the model re-reads through a tool
 * instead of re-reading a payload. It costs a call; it cannot cost accuracy,
 * because a tool is the authority either way.
 *
 * ⚠️ EVERY MESSAGE HERE CAME FROM A BROWSER. Roles are narrowed to user and
 * assistant before anything is appended: a caller that could post `system` would
 * be writing the instruction, and one that could post `tool` would be writing
 * the financial evidence.
 */
export function replayHistory(
  messages: unknown[], history: readonly ConversationMessage[],
): unknown[] {
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    messages.push({ role: m.role, content: m.content });
  }
  return messages;
}

export interface StatelessTurn {
  /** The assistant's prose, or null when the turn produced none. */
  answer:   string | null;
  record:   TurnRecord;
  evidence: EvidencePack;
  /** The hypothetical under discussion when the turn ended, if there is one. */
  scenario: ActiveScenario | null;
  /**
   * Evidence this answer wanted and did not have, ready to show.
   *
   * ⚠️ PART OF THE ANSWER, NOT A FAULT. What Fourth Meridian could say and what
   * it could not yet establish are both results of the turn; a surface that
   * renders one is expected to render the other. Empty is the ordinary case.
   *
   * ⚠️ PRESENTATION-SAFE, SO ANY SERVER CONSUMER MAY FORWARD IT. Nothing here
   * is tool state, provider metadata or internal classification — it is the
   * public shape from `@/types`, projected field by field from what a tool
   * returned.
   */
  knowledgeGaps: AiKnowledgeGap[];
}

/**
 * ONE TURN FOR A CALLER THAT KEEPS NO TRANSCRIPT.
 *
 * Rebuilds the conversation from what the caller holds — prior prose and a
 * restored scenario — runs exactly one turn through the shared executor, and
 * hands back the answer plus the scenario as it now stands. The rebuilt
 * transcript is discarded: nothing here persists, caches or memoises a
 * conversation.
 */
export async function runStatelessTurn(args: {
  spaceCtx:  SpaceContext;
  agentId:   string;
  /** The question just asked. NOT part of `history`. */
  user:      string;
  history:   readonly ConversationMessage[];
  /** The hypothetical carried in from the previous turn, if one was verified. */
  scenario?: ActiveScenario | null;
  asOfISO?:  string;
  model?:    string;
  correlationId?: string;
  surface?:  string;
}): Promise<StatelessTurn> {
  const asOfISO = args.asOfISO ?? todayUTCISO();
  const model = args.model ?? CHAT_MODEL;

  const open = await openTranscript({
    spaceCtx: args.spaceCtx, agentId: args.agentId, asOfISO, model });
  replayHistory(open.messages, args.history);

  // ⚠️ A SLOT PER REQUEST, RESTORED — NOT A SLOT THAT LIVES ON THE SERVER. The
  // continuity is the caller's to carry; this only reconstitutes it for the
  // duration of one turn, exactly as the in-process session holds it for the
  // duration of one process.
  const slot: ScenarioSlot = newScenarioSlot();
  if (args.scenario) slot.active = args.scenario;

  const record = await executeTurn({
    messages: open.messages, user: args.user, index: args.history.length,
    model, toolSchemas: open.toolSchemas, toolCtx: open.toolCtx,
    scenario: slot, correlationId: args.correlationId, surface: args.surface,
    // The user's own prior turns, for the memory gate — never the transcript's
    // `role: 'user'` messages, which include the orientation.
    userTexts: args.history.filter((m) => m.role === 'user').map((m) => m.content),
  });

  return { answer: record.assistant, record, evidence: open.evidence,
    scenario: slot.active,
    // Read off THIS turn's tool results, so a gap is a remark about this answer
    // rather than a standing notice about the Space.
    knowledgeGaps: collectKnowledgeGaps(record.toolCalls) };
}
