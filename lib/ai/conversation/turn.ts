/**
 * lib/ai/conversation/turn.ts
 *
 * ONE CONVERSATIONAL TURN — and the only implementation of one.
 *
 * TWO CLIENTS, ONE ENGINE. The terminal harness and the production chat route
 * both run this code; neither owns a copy. That is the whole reason the module
 * exists here rather than under scripts/: a second turn loop written for the
 * route would drift from the one every dogfood gate measured, and the drift
 * would stay invisible until a figure disagreed in front of a user.
 *
 * IT OWNS THE LOOP, NOT THE SESSION. A turn is: inject the active scenario,
 * append the user's message, call the model, run whatever tools it asks for,
 * repeat until it answers in prose. Who authenticated, which Space is
 * authorised, where the transcript came from and where it goes are the
 * caller's — the harness keeps them in a process, the route rebuilds them on
 * every request.
 *
 * NOTHING HERE IS TERMINAL-SHAPED. No readline, no console output, no artifact
 * writing, no probe selection, no model menu. Those stayed in
 * scripts/ai-baseline, which is now a client of this module like any other.
 */

import { generateWithTools } from '@/lib/ai/provider';
import { callWithRateLimitRetry } from '@/lib/ai/rate-limit-retry';
import { findTool, type ToolContext } from './tools';
import { runWithAiInvocationContext } from '@/lib/ai/invocation-context';
import { checkpointProjection } from './memory-tools';
import { turnEvidence } from './memory-model';
import {
  captureActiveScenario, applyCapture, injectScenario, type ScenarioSlot,
} from './active-scenario';
import type { CompactionStats } from './compaction';

/**
 * The behavioural instruction. ~140 words, identical in every arm and every
 * model tier.
 *
 * ⚠️ IT IS NOT DOCTRINE AND MUST NOT BECOME IT. No phrase tables, no worked
 * examples, no financial ontology, no rules about which figure may be stated.
 * The previous architecture's prompt reached ~4,250 tokens of doctrine; if this
 * one starts growing to fix a transcript, the growth IS the finding.
 */
/**
 * The one sentence Slice C added, and the only sentence about substitution.
 *
 * ⚠️ MEASURED, NOT ASSUMED. The structural fixes (a floor rule the engine can
 * represent, a table at the cadence asked for, dates that say how far away they
 * are) are what repaired the dogfood; this sentence is the general rule those
 * fixes are instances of, added last so its effect could be measured on its own.
 * Exported so a harness can run the same conversation with and without it.
 */
export const EVIDENCE_RULE =
  'Never quietly drop, approximate or reshape a condition the user stated; if the tools cannot '
  + 'represent it exactly, say so. When a tool can compute a figure, use its output and never '
  + 'fill in values it did not return.';

export const SYSTEM_INSTRUCTION = [
  'You are Fourth Meridian, a financial assistant talking to the person whose money this is.',
  '',
  'Answer the question actually asked. Be brief by default — a few sentences — and go',
  'deeper only when asked. Talk like a person, not like a report.',
  '',
  'Use the financial evidence and tools you are given. Never state a figure you were not',
  'given or cannot compute from what you were given. If something is unknown or',
  'unknowable, say so once and move on.',
  '',
  'Keep these apart, in your own words: what is measured, what is an observed pattern,',
  'what the user assumed, and what is an illustrative scenario.',
  '',
  'An exploratory "what if" that leaves a number out is an invitation to choose one. Pick a',
  'reasonable value, put it through the tools, and say which value you used and that it can be',
  'changed — rather than asking for it. Never present a value you chose as one they chose, or',
  'as what will happen.',
  '',
  'Lead with what matters. Something immaterial does not become important because a field',
  'about it is missing. Correct a wrong premise rather than answering around it.',
  'Form a view when asked for one.',
  '',
  EVIDENCE_RULE,
].join('\n');

export interface TurnRecord {
  index: number;
  user: string;
  toolCalls: { name: string; arguments: unknown; result: unknown; latencyMs: number; error?: string }[];
  /** Subjects of any checkpoints written silently during this turn (slice 7). */
  checkpoints?: string[];
  /** What this turn did to the conversation's hypothetical, when it did anything. */
  scenarioCapture?: 'REPLACE' | 'CLEAR';
  roundTrips: number;
  /** 429s absorbed on this turn, with how long each wait was. Reported, never hidden. */
  retries: { attempt: number; waitedMs: number; reason: string }[];
  assistant: string | null;
  latencyMs: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number;
    reasoningTokens: number } | null;
  finishReason: string | null;
  /**
   * What the transcript CONTAINED when this turn was sent, by kind.
   *
   * ⚠️ MEASUREMENT ONLY, AND IT NEVER REACHES THE MODEL. The provider reports one
   * `prompt_tokens` number; this says what that number is made OF, which is the
   * only way to tell "the conversation got long" from "one tool payload is being
   * resent thirty times". Estimated at 4 chars/token — good enough to compare a
   * share against itself before and after a change, and never quoted as a cost.
   */
  retained: TranscriptComposition;
  /** What compaction removed AFTER this turn completed. Absent when disabled. */
  compaction?: CompactionStats;
  error?: string;
}

export interface TranscriptComposition {
  /** The behavioural instruction. Constant. */
  system:        number;
  /** Everything the user typed, including the evidence pack in a broad-context arm. */
  user:          number;
  /** Assistant natural-language answers. */
  assistant:     number;
  /** Assistant messages that are tool CALLS (names + arguments), not prose. */
  toolCallArgs:  number;
  /** `role: 'tool'` payloads — the thing compaction targets. */
  toolResults:   number;
  /** Sum of the above. */
  total:         number;
  /** toolResults / total, 0..1. The share a compaction policy can address. */
  toolResultShare: number;
  messageCount:  number;
}

const MAX_TOOL_ROUNDTRIPS = 6;
// ⚠️ THE RATE-LIMIT RULE LIVES IN lib/ai/rate-limit-retry.ts. It was written here
// first, privately ("quota, not behaviour": only a 429 is retried, the provider's
// own wait is honoured, the attempts are bounded), and the Daily Brief could not
// reach it. It is one function now; this turn calls it with no deadline — a chat
// turn holds no lease — and writes every wait into the artifact, so a slow case is
// never mistaken for a slow model.

/** Models that cannot take function tools through /v1/chat/completions (measured). */
export function supportsTools(model: string): boolean {
  return !/^(gpt-6|gpt-5\.6)/.test(model);
}

/**
 * ONE TURN: append the user's message, let the model call tools until it answers,
 * and record everything that happened.
 *
 * ⚠️ `messages` IS MUTATED, AND THAT IS THE STATE MODEL. The transcript — user
 * turns, assistant turns, tool calls and their JSON results — is the only memory
 * a conversation has. A later "break it down" works because the object that
 * produced the earlier number is still sitting in this array.
 *
 * ⚠️ ONE IMPLEMENTATION FOR EVERY CLIENT, not a copy each. A dogfooding session
 * whose turn loop had drifted from the batch runner's would produce transcripts
 * that are not comparable with the recorded runs — which is the entire value of
 * having recorded runs — and a route with its own loop would be a system nobody
 * had measured.
 */
export async function executeTurn(args: {
  /** The growing transcript. Mutated in place. */
  messages:    unknown[];
  user:        string;
  index:       number;
  model:       string;
  toolSchemas: unknown[];
  toolCtx:     ToolContext;
  /**
   * Opaque key grouping this turn's invocations into one session (cost Slice 3).
   *
   * ⚠️ TELEMETRY ONLY, AND IT CHANGES NOTHING THE MODEL SEES. It is not sent to
   * the provider, not added to the transcript, and not read by any tool. Absent
   * → invocations are still recorded and still billed, just not groupable.
   */
  correlationId?: string;
  /**
   * Which client is running this turn — 'harness', 'chat'. Telemetry only, and
   * it separates dogfood traffic from a real user's in the cost ledger.
   */
  surface?: string;
  /**
   * The conversation's single hypothetical slot, if it has one.
   *
   * ⚠️ OWNED BY THE CALLER, NOT BY THE TURN. A turn reads it to inject and writes
   * it when a scenario succeeds or fails; it belongs to whoever owns the
   * transcript, and it dies with them.
   */
  scenario?: ScenarioSlot;
  /**
   * The conversation's PRIOR user turns, verbatim — for durable memory's
   * provenance gate and nothing else.
   *
   * ⚠️ PASSED IN, NEVER READ OFF `messages`. The financial orientation is a
   * `role: 'user'` message and the active scenario a trailing `role: 'system'`
   * one, so "the user messages of the transcript" contain every balance we hold;
   * a gate that trusted them would let "Remember this." store a projected net
   * worth as the user's goal. A caller that replays history supplies it; a caller
   * that keeps one growing transcript may omit it, and the turns seen so far on
   * the same tool context are used. It changes nothing the model sees.
   */
  userTexts?: readonly string[];
}): Promise<TurnRecord> {
  // A tool loop makes SEVERAL invocations for ONE user turn; the ambient context
  // is what lets the ledger sum them back into that turn.
  return runWithAiInvocationContext(
    { correlationId: args.correlationId ?? 'conversation', turnIndex: args.index,
      surface: args.surface ?? 'harness' },
    () => executeTurnInner(args),
  );
}

async function executeTurnInner(args: {
  messages:    unknown[];
  user:        string;
  index:       number;
  model:       string;
  toolSchemas: unknown[];
  scenario?:   ScenarioSlot;
  toolCtx:     ToolContext;
  userTexts?:  readonly string[];
}): Promise<TurnRecord> {
  const { messages, user, index, model, toolSchemas, toolCtx } = args;
  // What the USER said, explicitly — and everything else in the transcript is ours.
  toolCtx.turn = turnEvidence([...(args.userTexts ?? toolCtx.turn?.userTexts ?? []), user], messages);
  // ⚠️ THE RESERVED TRAILING SLOT, REWRITTEN EACH TURN. Independent of Clip 6 —
  // compaction only rewrites `role: 'tool'` content and counts turns by assistant
  // completions, so a system message is inert to it. This is the whole continuity
  // contract: raw scenario payloads keep ageing out exactly as before.
  if (args.scenario) injectScenario(messages, args.scenario);
  messages.push({ role: 'user', content: user });
  const rec: TurnRecord = {
    index, user, toolCalls: [], roundTrips: 0, retries: [], assistant: null,
    latencyMs: 0, usage: null, finishReason: null,
    // Measured AFTER the user message is appended and BEFORE the first call, so
    // it describes exactly what this turn was sent.
    retained: measureTranscript(messages),
  };

  try {
    for (let hop = 0; hop < MAX_TOOL_ROUNDTRIPS; hop++) {
      rec.roundTrips++;
      const out = await callWithRateLimitRetry(
        () => generateWithTools({ model, messages, tools: toolSchemas }),
        { onRetry: (r) => rec.retries.push(r) });
      rec.latencyMs += out.latencyMs;
      if (out.usage) {
        rec.usage = rec.usage
          ? { promptTokens: rec.usage.promptTokens + out.usage.promptTokens,
              completionTokens: rec.usage.completionTokens + out.usage.completionTokens,
              totalTokens: rec.usage.totalTokens + out.usage.totalTokens,
              reasoningTokens: rec.usage.reasoningTokens + out.usage.reasoningTokens }
          : out.usage;
      }
      rec.finishReason = out.finishReason;
      messages.push(out.raw);

      if (out.toolCalls.length === 0) { rec.assistant = out.content; break; }

      for (const call of out.toolCalls) {
        const started = Date.now();
        let result: unknown; let error: string | undefined;
        try {
          const tool = findTool(call.name);
          if (!tool) throw new Error(`no such tool: ${call.name}`);
          const parsed = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
          result = await tool.run(parsed, toolCtx);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          result = { error };
        }
        rec.toolCalls.push({
          name: call.name,
          arguments: safeParse(call.arguments),
          result, latencyMs: Date.now() - started, ...(error ? { error } : {}),
        });
        // ⚠️ SLICE 7 — SILENT, AND SILENT IS THE PRODUCT DECISION. When a
        // deterministic projection is stated, what it said and what it rested on
        // are recorded so a later session can reconcile them. Nothing is added
        // to the transcript, the model is not told, and a failure here cannot
        // affect the answer: `checkpointProjection` swallows its own errors and
        // returns null for every tool that is not `project_cash`.
        const checkpointed = await checkpointProjection(toolCtx, call.name, result);
        if (checkpointed) (rec.checkpoints ??= []).push(checkpointed.subject);
        // ⚠️ THE SAME LIFECYCLE POSITION, THE OPPOSITE TOOL FILTER, AND A
        // DIFFERENT DESTINATION. `checkpointProjection` writes a durable record
        // for `project_cash`; this holds a transient pair for
        // `scenario_projection` and touches no store. Their persistence
        // semantics must not be mixed: one is what we told the user, the other
        // is what we are supposing with them.
        if (args.scenario) {
          const capture = captureActiveScenario(call.name, safeParse(call.arguments), result);
          applyCapture(args.scenario, capture);
          if (capture.action !== 'IGNORE') rec.scenarioCapture = capture.action;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    // ⚠️ AN EMPTY STRING IS NOT AN ANSWER, AND USED TO PASS THIS CHECK. The test
    // was `=== null`, so a reply of `''` — which is exactly what a reasoning
    // model returns when the completion budget is spent before it emits a
    // character — broke the loop, recorded no error, and left `ok: true`. Two
    // dogfood turns disappeared that way with `finish_reason: 'length'` sitting
    // unread on the record. A turn that produced no text now says why.
    if (!rec.assistant?.trim() && !rec.error) {
      const spent = rec.usage
        ? ` (${rec.usage.completionTokens} completion tok, of which ${rec.usage.reasoningTokens} reasoning)`
        : '';
      rec.error = rec.finishReason === 'length'
        ? `the model produced no text: the completion budget was exhausted${spent}. `
          + 'On a reasoning model the budget covers reasoning AND output.'
        : rec.finishReason && rec.finishReason !== 'stop'
          ? `the model produced no text (finish_reason: ${rec.finishReason})${spent}`
          : `no final answer after ${MAX_TOOL_ROUNDTRIPS} tool round trips`;
      rec.assistant = null;
    }
  } catch (err) {
    // ⚠️ A PROVIDER FAILURE IS A RESULT, NOT A CRASH. The caller records the turn
    // and decides what to do with it: the batch runner stops the case, the
    // interactive session keeps the prompt open, the route answers with a
    // message rather than a stack trace.
    rec.error = err instanceof Error ? err.message : String(err);
  }
  return rec;
}

/**
 * What the transcript is made of, by kind. PURE.
 *
 * ⚠️ IT INSPECTS SHAPE, NOT PROTOCOL. A message is a tool result when it carries
 * `role: 'tool'`; an assistant message is a CALL when it carries `tool_calls` and
 * prose otherwise. Nothing here depends on which provider produced it.
 */
export function measureTranscript(messages: readonly unknown[]): TranscriptComposition {
  const tok = (v: unknown) => Math.ceil(JSON.stringify(v ?? '').length / 4);
  const c = { system: 0, user: 0, assistant: 0, toolCallArgs: 0, toolResults: 0 };
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown; tool_calls?: unknown[] };
    if (m.role === 'system')      c.system       += tok(m.content);
    else if (m.role === 'user')   c.user         += tok(m.content);
    else if (m.role === 'tool')   c.toolResults  += tok(m.content);
    else if (m.role === 'assistant') {
      if (m.tool_calls?.length) c.toolCallArgs += tok(m.tool_calls);
      c.assistant += tok(m.content);
    }
  }
  const total = c.system + c.user + c.assistant + c.toolCallArgs + c.toolResults;
  return { ...c, total, messageCount: messages.length,
    toolResultShare: total > 0 ? c.toolResults / total : 0 };
}

/** Tool arguments as the model sent them, never lost to a parse failure. */
function safeParse(raw: string): unknown {
  try { return JSON.parse(raw || '{}'); } catch { return { unparseable: raw }; }
}
