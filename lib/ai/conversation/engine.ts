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

import { emptyPlan, type PendingPlan } from './pending-plan';
import type { ContinuityLoss } from './runtime-state';
import {
  assembleFullContext, buildEvidence, ARM_USES_TOOLS, type Arm, type EvidencePack,
} from './evidence';
import { openAiToolSchemas, type ToolContext } from './tools';
import type { ReadClient } from '@/lib/db/tenant-context';
import {
  onClient, phasedReads, phasedMemoryRead,
  type AiPhaseRunner, type MemoryPhasedRead,
} from '@/lib/ai/tenant-phase';
import type { MemoryClient } from './memory-store';
import { executeTurn, supportsTools, SYSTEM_INSTRUCTION, type TurnRecord } from './turn';
import { newScenarioSlot, type ScenarioSlot, type ActiveScenario } from './active-scenario';
import { collectKnowledgeGaps } from './knowledge-gaps';
import { classifyGuidance, CLASSIFIER_TIMEOUT_MS, type GuidanceModelCall } from './guidance';
import { generateStructuredWithUsage } from '@/lib/ai/provider';
import { runWithAiInvocationContext } from '@/lib/ai/invocation-context';
import { todayUTCISO } from '@/lib/time/clock';
import type { SpaceContext } from '@/lib/space';
import type { SpaceContext_AI } from '@/lib/ai/types';
import type { AiGuidance, AiKnowledgeGap } from '@/types';

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
  /**
   * RLS slice A — the database authority this conversation's memory reads and
   * writes run under. Required: a transcript is opened by a boundary that knows
   * who the user is, and that boundary states the authority rather than letting
   * this module pick one.
   *
   * ⚠️ A CONVERSATION CANNOT BE WRAPPED IN ONE TRANSACTION. A turn makes model
   * calls, and `withTenantDb` must never be held across one, so the client handed
   * in here is a long-lived client — the tenant transaction is opened around the
   * individual memory operation, not around the turn.
   */
  memoryClient: MemoryClient;
  /**
   * RLS-C-S3 — the authority this conversation's FINANCIAL reads run under, stated
   * by the same boundary that states the memory authority, and for the same reason:
   * a transcript is opened by something that knows who the user is.
   *
   * ⚠️ A LONG-LIVED CLIENT, NOT A TRANSACTION, for the reason recorded above: a
   * turn makes model calls and `withTenantDb` must never be held across one. On
   * this path it is the migration principal today — see `ToolContext.readClient`
   * for why that is a recorded decision and not an oversight.
   */
  readClient: ReadClient;
  /** FM-AUDIT-019 — true ONLY for the product route or a clone-verified harness opt-in. */
  memoryWrites?: boolean;
  /**
   * RLS-AI-S11 — THE PHASE RUNNER, WHEN THE SURFACE HAS AN AUTHENTICATED SESSION.
   *
   * ⚠️ PRESENT ⇒ THE WHOLE PROLOGUE IS ONE SHORT TENANT TRANSACTION. Four domains,
   * the coverage census, the memory line, the corpus span and the activity frame
   * all read through the same `tx`, so the sentence this programme exists to make
   * true — "all financial evidence for this phase was read under the authenticated
   * caller's tenant authority" — is a property of ONE transaction rather than a
   * claim about a dozen call sites.
   *
   * ⚠️ AND IT ENDS BEFORE THE FIRST MODEL CALL. `openTranscript` returns a
   * transcript; `executeTurn` makes the provider call. Nothing here is awaited
   * across one, and `scripts/rls-ai-acceptance.ts` asserts that by source scan
   * rather than by reading.
   *
   * ⚠️ ABSENT ⇒ BYTE-FOR-BYTE THE PREVIOUS BEHAVIOUR, which is what the dogfood
   * harnesses and batch runners need: they read a CLONE as the migration principal
   * and have no session at all.
   */
  phase?: AiPhaseRunner;
  /**
   * The behavioural instruction, for a harness A/B arm ONLY. Absent ⇒
   * `SYSTEM_INSTRUCTION`, which is what the product route always sends — it has
   * no way to pass this, and must never gain one.
   */
  instruction?: string;
}): Promise<OpenTranscript> {
  const { spaceCtx, agentId, asOfISO, model } = args;
  const arm = args.arm ?? CHAT_ARM;

  // ⚠️ ONE SHORT PHASE PER PROLOGUE READ, CONCURRENT — NOT ONE TRANSACTION ROUND
  // THE LOT. It WAS one, and the acceptance suite measured it at 5,906 ms against
  // Prisma's 5 s default on a 34-read fixture, because reads inside a phase
  // SERIALISE. The alternative was a ten-second-plus transaction on the first turn
  // of every conversation, to buy a cross-domain snapshot the prologue has never
  // had (before this programme the four assemblers were four concurrent chains
  // against the migration principal, inside no transaction at all). So the
  // concurrency and the consistency are exactly today's; only the authority moved.
  // See `PROLOGUE_DOMAIN_QUERIES` in lib/ai/tenant-phase.ts for the measurement.
  const read = args.phase ? phasedReads(args.phase) : onClient(args.readClient);
  // ⚠️ THE MEMORY RUNNER IS BUILT SEPARATELY AND STAYS NARROW. Without a phase it
  // is the `memoryClient` this transcript was opened with — which the harnesses
  // deliberately point at a clone — and never the financial read client.
  const memoryRead: MemoryPhasedRead = args.phase
    ? phasedMemoryRead(args.phase)
    : ((fn) => fn(args.memoryClient as never));
  const ctx = await assembleFullContext(read, spaceCtx, agentId);
  const evidence = await buildEvidence(read, memoryRead, arm, ctx, spaceCtx);

  const usesTools = ARM_USES_TOOLS[arm] && supportsTools(model);
  const toolSchemas = usesTools ? openAiToolSchemas() : [];
  // FM-AUDIT-019 — durable memory writes are off unless the caller says otherwise.
  // ⚠️ THE TOOL CONTEXT STILL CARRIES THE LONG-LIVED CLIENTS, AND THAT IS RIGHT.
  // The prologue's `tx` is COMMITTED by the time this object is built; a tool must
  // never be handed a finished transaction. When `phase` is present the dispatcher
  // (`turn.ts`) replaces both clients per tool call with that call's own
  // transaction, so these values are the no-phase fallback and nothing else.
  const toolCtx: ToolContext = { spaceCtx, spaceId: spaceCtx.spaceId, asOfISO,
    memoryClient: args.memoryClient, readClient: args.readClient,
    ...(args.phase ? { phase: args.phase } : {}),
    ...(args.memoryWrites === true ? { memoryWrites: true } : {}) };

  const messages: unknown[] = [
    { role: 'system', content: `${args.instruction ?? SYSTEM_INSTRUCTION}\n\nToday is ${asOfISO}.` },
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
  /** Conditions staged and not yet run when the turn ended; null when none. */
  pending:  PendingPlan | null;
  /**
   * FM-AUDIT-018 — a plan this conversation built that could not be carried, still
   * unresolved when the turn ended (carried forward until a scenario runs again).
   */
  continuity: ContinuityLoss | null;
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
  /**
   * What kind of guidance this answer is (lib/ai/conversation/guidance.ts), or
   * null when there was no answer or the label could not be produced.
   *
   * ⚠️ LABELLED AFTER THE ANSWER, AND IT NEVER REACHES THE MODEL. It is not in
   * `record`, not in the transcript and not in the sealed state; a surface uses
   * it to frame the answer and nothing else does.
   */
  guidance: AiGuidance | null;
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
  /** Conditions staged earlier in this conversation and not yet run, if verified. */
  pending?:  PendingPlan | null;
  /** A plan the previous turn could NOT carry (FM-AUDIT-018), if the seal said so. */
  continuity?: ContinuityLoss | null;
  asOfISO?:  string;
  model?:    string;
  correlationId?: string;
  surface?:  string;
  /** RLS slice A — the authority this turn's memory reads and writes run under. */
  memoryClient: MemoryClient;
  /** RLS-C-S3 — the authority this turn's FINANCIAL reads run under. */
  readClient: ReadClient;
  /** FM-AUDIT-019 — true ONLY for the product route or a clone-verified harness opt-in. */
  memoryWrites?: boolean;
  /** RLS-AI-S11 — the tenant phase runner, when the caller authenticated someone. */
  phase?: AiPhaseRunner;
  /**
   * The guidance labeller. Defaults to a structured call on the conversation's
   * model; `false` skips it (the answer then carries no label). Injected by tests.
   */
  classify?: GuidanceModelCall | false;
  /** Harness A/B only — see `openTranscript`. */
  instruction?: string;
}): Promise<StatelessTurn> {
  const asOfISO = args.asOfISO ?? todayUTCISO();
  const model = args.model ?? CHAT_MODEL;

  const open = await openTranscript({
    spaceCtx: args.spaceCtx, agentId: args.agentId, asOfISO, model,
    memoryClient: args.memoryClient, readClient: args.readClient,
    phase: args.phase, memoryWrites: args.memoryWrites, instruction: args.instruction });
  replayHistory(open.messages, args.history);

  // ⚠️ A SLOT PER REQUEST, RESTORED — NOT A SLOT THAT LIVES ON THE SERVER. The
  // continuity is the caller's to carry; this only reconstitutes it for the
  // duration of one turn, exactly as the in-process session holds it for the
  // duration of one process.
  const slot: ScenarioSlot = newScenarioSlot();
  if (args.scenario) slot.active = args.scenario;
  // The staged plan, restored the same way and for the same span: one turn.
  // A LOST plan is still a plan in play: the turn is told it is not in force, and
  // project_cash keeps refusing to answer its question from the current trend.
  open.toolCtx.plan = { pending: args.pending ?? emptyPlan(), scenarioRan: slot.active !== null,
    ...(args.continuity ? { continuity: args.continuity } : {}) };

  const record = await executeTurn({
    messages: open.messages, user: args.user, index: args.history.length,
    model, toolSchemas: open.toolSchemas, toolCtx: open.toolCtx,
    scenario: slot, correlationId: args.correlationId, surface: args.surface,
    // The user's own prior turns, for the memory gate — never the transcript's
    // `role: 'user'` messages, which include the orientation.
    userTexts: args.history.filter((m) => m.role === 'user').map((m) => m.content),
  });

  // ⚠️ AFTER THE TURN, ON THE SAME LEDGER KEY. The label reads the finished
  // exchange — the question, the answer, and the turns before it — and its cost
  // is billed to this turn so "what did this turn cost?" stays one number.
  const guidance = record.assistant?.trim() && args.classify !== false
    ? await runWithAiInvocationContext(
      { correlationId: args.correlationId ?? 'conversation', turnIndex: args.history.length,
        surface: args.surface ?? 'harness' },
      () => classifyGuidance(
        { prior: args.history, asked: args.user, answer: record.assistant as string },
        args.classify || defaultGuidanceCall(model)))
    : null;

  return { answer: record.assistant, record, evidence: open.evidence, guidance,
    scenario: slot.active,
    pending: open.toolCtx.plan.pending.clauses.length > 0 ? open.toolCtx.plan.pending : null,
    // The loss stands until a scenario RUNS again in this conversation — a new
    // executed plan is what the user re-established after being told.
    continuity: args.continuity && !(slot.active && slot.active !== args.scenario) ? args.continuity : null,
    // Read off THIS turn's tool results, so a gap is a remark about this answer
    // rather than a standing notice about the Space.
    knowledgeGaps: collectKnowledgeGaps(record.toolCalls) };
}

/** The production labeller: one strict structured call, short deadline, small budget. */
function defaultGuidanceCall(model: string): GuidanceModelCall {
  return async (system, messages, schema) => (await generateStructuredWithUsage<unknown>(
    system, messages, { name: schema.name, schema: schema.schema as unknown as Record<string, unknown> },
    { model, timeoutMs: CLASSIFIER_TIMEOUT_MS, maxTokens: 2_000 })).value;
}
