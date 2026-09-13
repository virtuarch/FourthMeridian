/**
 * lib/ai/provider.ts
 *
 * AI Provider boundary — D4 Space-Scoped Chat.
 *
 * THE ONLY FILE IN THIS CODEBASE THAT MAY IMPORT THE OPENAI SDK.
 *
 * All AI features must call the exported functions here rather than
 * instantiating an OpenAI client directly. This keeps the provider
 * swappable (OpenAI → Anthropic → local) without touching any route
 * handler or business logic.
 *
 * Model: gpt-4o-mini — inexpensive, low-latency, sufficient for
 * grounded context-bound chat. Swap CHAT_MODEL when ready to upgrade.
 */

import 'server-only';
import OpenAI from 'openai';
import { recordApiUsage } from '@/lib/usage/record';
import { aiUsageUnits, type OpenAiUsage } from '@/lib/usage/ai-tokens';
import { recordAiInvocation, type AiInvocationWriteClient } from '@/lib/ai/invocation';

// ── Client ───────────────────────────────────────────────────────────────────
// Lazy-initialised singleton. Fails loudly if the key is absent so
// misconfiguration surfaces at the first call, not at module import time
// (import-time throws can cause confusing Next.js build errors).

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      '[ai/provider] OPENAI_API_KEY is not set. ' +
      'Add it to .env.local for local development and to your Vercel ' +
      'environment variables for deployed environments.',
    );
  }

  _client = new OpenAI({ apiKey: key });
  return _client;
}

// ── Model ────────────────────────────────────────────────────────────────────

/**
 * The chat tier.
 *
 * ⚠️ PARAMETERISED, NOT CHANGED. The default is exactly what it has always been,
 * so an unset environment is byte-identical to before. What this buys is that
 * the tier becomes a decision somebody makes rather than a literal nobody
 * revisits.
 *
 * ⚠️ AND THE RECORDED TIER DECISION WAS RETIRED WITH THE ARCHITECTURE IT WAS
 * MEASURED AGAINST. Both prior answers were conditional on a pipeline that no
 * longer exists — FORECAST-11 measured a stronger tier against prose reasoning
 * and said no; V26-REASONING measured it against a typed answer boundary and
 * said yes. Neither conclusion transfers. The next conversation layer must
 * measure the tier for itself; see docs/plans/AI-CONVERSATION-RESET.md.
 */
const CHAT_MODEL = process.env.AI_CHAT_MODEL || 'gpt-4o-mini';

/**
 * Record one OpenAI call against `ApiUsageCounter` — the ONLY usage-write path
 * in this module.
 *
 * ⚠️ IT EXISTS BECAUSE THREE COPIES HAD ALREADY DRIFTED. Each generator used to
 * inline its own three `recordApiUsage` lines; `reasoning_tokens` was read in one
 * of the three and thrown away at the counter, and `cached_tokens` was read in
 * none — so every dollar figure derivable from the ledger overstated input cost
 * by roughly five times on measured traffic. One list, one loop, every path.
 *
 * Fire-and-forget and non-throwing, unchanged: `recordApiUsage` swallows its own
 * errors, so `void` here can neither fail a generation nor leave an unhandled
 * rejection. A metrics write must never break a chat call.
 */
/**
 * Where the invocation fact is written. Defaults to the real ledger.
 *
 * ⚠️ INJECTABLE ONLY SO THE ACCOUNTING CAN BE TESTED WITHOUT A DATABASE — the
 * write-client idiom `recordAiInvocation` already takes. The invocation writer
 * still runs for real under a fake client, so a test reads the row this module
 * would have written, ambient correlation included. The day-grain counter is
 * deliberately NOT injectable: it stays the one direct, fire-and-forget
 * `recordApiUsage` call site the usage guards pin, and it swallows its own errors.
 */
export interface UsageSinks {
  invocationClient?: AiInvocationWriteClient;
}

function recordOpenAiUsage(args: {
  model: string;
  usage: OpenAiUsage | null | undefined;
  latencyMs: number;
  toolCallCount?: number;
  finishReason?: string | null;
  sinks?: UsageSinks;
}): void {
  const { model, usage } = args;
  if (!usage) return;

  // (a) The DAY-GRAIN aggregate. Cheap, durable, race-safe, and the input to
  //     provider health. Kept exactly as it was — Slice 3 adds a grain, it does
  //     not replace one, and summing (b) against (a) is an independent
  //     reconciliation of two separately-written figures.
  const metric = `chat.completions:${model}`;
  for (const { unit, count } of aiUsageUnits(usage)) {
    void recordApiUsage('OPENAI', metric, unit, count);
  }

  // (b) The INVOCATION-GRAIN immutable fact. The finest grain at which a bill is
  //     incurred, and the one the counter's (provider, metric, unit, day) key
  //     structurally cannot reach: "what did this turn cost?" is unanswerable
  //     from a daily sum. Correlation comes from ambient context, so no generator
  //     signature changes and no caller has to thread it.
  void recordAiInvocation({
    provider: 'OPENAI', model, usage,
    latencyMs: args.latencyMs,
    toolCallCount: args.toolCallCount ?? 0,
    finishReason: args.finishReason ?? null,
  }, args.sinks?.invocationClient);
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role:    'user' | 'assistant';
  content: string;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a single chat reply from the model.
 *
 * @param systemPrompt  Grounded system prompt built from SpaceContext_AI.
 *                      Contains all financial context — the model must not
 *                      invent data beyond what is supplied here.
 * @param messages      Conversation history — user/assistant turns only.
 *                      The system prompt is prepended internally.
 * @returns             The model's reply as a plain string.
 */
export async function generateChatReply(
  systemPrompt: string,
  messages:     ChatMessage[],
): Promise<string> {
  const client = getClient();

  const started = Date.now();
  const completion = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    temperature: 0.3,
    max_tokens:  1024,
  });
  const latencyMs = Date.now() - started;

  // Wave 2 S7 + cost Slice 3 — the day aggregate and the invocation fact.
  recordOpenAiUsage({
    model: CHAT_MODEL, usage: completion.usage, latencyMs,
    // This path cannot request tools, so zero is a FACT rather than a missing value.
    toolCallCount: 0,
    finishReason: completion.choices[0]?.finish_reason ?? null,
  });

  const reply = completion.choices[0]?.message?.content ?? '';
  if (!reply) {
    throw new Error('[ai/provider] Model returned an empty response.');
  }
  return reply;
}

/**
 * ⚠️ EXPERIMENT SEAM (model-first conversation baseline). ADDITIVE, and it has
 * NO production caller — `app/api/ai/chat` returns 503 AWAITING_REDESIGN.
 *
 * One completion with tools offered. The tool LOOP is deliberately NOT here: the
 * caller owns which tools exist, how their results are shaped and when to stop,
 * and burying that in the provider would make the boundary an agent runtime.
 * This function does exactly what the other two do — one request, one response,
 * usage recorded — plus it hands back the raw tool calls.
 *
 * ⚠️ TWO PARAMETER DIALECTS, MEASURED NOT ASSUMED (2026-09-07, live API):
 *   gpt-4o-mini / gpt-4.1   `max_tokens`, `temperature` honoured
 *   gpt-5.x / gpt-6.x / o*  `max_completion_tokens`, temperature MUST be default
 * Sending the wrong one is a 400, so the dialect is selected by model family
 * rather than by hope. See docs/plans/AI-CONVERSATION-BASELINE-HARNESS.md.
 */
export interface ToolCallRequest {
  id:        string;
  name:      string;
  /** Raw JSON string exactly as the model emitted it. Parsed by the caller. */
  arguments: string;
}

export interface ToolTurnResult {
  /** Assistant prose, when the model answered instead of calling a tool. */
  content:   string | null;
  toolCalls: ToolCallRequest[];
  /** The assistant message verbatim, to be appended to the transcript. */
  raw:       unknown;
  usage:     {
    promptTokens: number; completionTokens: number; totalTokens: number;
    /**
     * ⚠️ REASONING TOKENS SPEND THE COMPLETION BUDGET. On gpt-5.x they are billed
     * inside `completion_tokens` and counted against `max_completion_tokens`, so a
     * cap that looks generous for prose can be entirely consumed before a single
     * visible character is emitted. Measured 2026-09-07: a 1,500 cap produced
     * 1,500 reasoning tokens, zero content and `finish_reason: 'length'`. Carried
     * so a blank answer can be explained rather than guessed at.
     */
    reasoningTokens: number;
  } | null;
  latencyMs: number;
  finishReason: string | null;
}

/** True for model families that reject `max_tokens` and a non-default temperature. */
export function usesModernParams(model: string): boolean {
  return /^(gpt-5|gpt-6|o\d)/.test(model);
}

/**
 * The completion budget, by dialect.
 *
 * ⚠️ THE TWO NUMBERS MEASURE DIFFERENT THINGS, which is why they differ so much.
 * On the classic dialect `max_tokens` bounds VISIBLE OUTPUT. On the modern one
 * `max_completion_tokens` bounds reasoning + output together, and the reasoning
 * half is invisible and unbounded by anything else. A shared 1,500 silently
 * turned two hard questions into blank answers; the modern cap is set well above
 * the observed reasoning spend (~1,500 tok on a month-by-month projection) so
 * the visible answer is never the part that gets truncated.
 */
export const CLASSIC_COMPLETION_BUDGET = 1_500;
export const REASONING_COMPLETION_BUDGET = 8_000;

export function completionBudgetFor(model: string): number {
  return usesModernParams(model) ? REASONING_COMPLETION_BUDGET : CLASSIC_COMPLETION_BUDGET;
}

export async function generateWithTools(args: {
  model:    string;
  /** The full transcript: system first, then user/assistant/tool messages. */
  messages: unknown[];
  /** OpenAI function-tool definitions. Omit or empty to run without tools. */
  tools?:   unknown[];
  /** Omit to take the dialect-appropriate budget — see `completionBudgetFor`. */
  maxTokens?: number;
}): Promise<ToolTurnResult> {
  const client = getClient();
  const { model, messages, tools } = args;
  const maxTokens = args.maxTokens ?? completionBudgetFor(model);
  const modern = usesModernParams(model);

  const body = {
    model,
    messages,
    ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    ...(modern
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens, temperature: 0.3 }),
  } as unknown as Parameters<typeof client.chat.completions.create>[0];

  const started = Date.now();
  const completion = await client.chat.completions.create(body) as {
    choices: { message: { content: string | null; tool_calls?: { id: string;
      function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
    usage?: OpenAiUsage;
  };
  const latencyMs = Date.now() - started;

  const usage = completion.usage;
  const choice = completion.choices[0];
  recordOpenAiUsage({
    model, usage, latencyMs,
    // Tool calls this invocation ASKED FOR — known exactly at this seam, and the
    // reason a single turn can produce several invocations.
    toolCallCount: choice?.message?.tool_calls?.length ?? 0,
    finishReason: choice?.finish_reason ?? null,
  });

  return {
    content:   choice?.message?.content ?? null,
    toolCalls: (choice?.message?.tool_calls ?? []).map((t) => ({
      id: t.id, name: t.function.name, arguments: t.function.arguments,
    })),
    raw:       choice?.message,
    usage:     usage
      ? { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
          reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 }
      : null,
    latencyMs,
    finishReason: choice?.finish_reason ?? null,
  };
}

/**
 * How long a structured call may take, end to end, before it is abandoned.
 *
 * ⚠️ THE SDK'S OWN DEFAULT IS TEN MINUTES. A structured call backs a surface that
 * has a page waiting on it; a generation that has not returned in a minute has
 * failed in every sense a reader cares about, and the caller's failure path is
 * the right place for it to land. Generous against the observed ~3–8 s.
 */
export const STRUCTURED_TIMEOUT_MS = 60_000;

/** The structured call was abandoned at its deadline. Nothing was recorded. */
export class StructuredOutputTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`[ai/provider] Structured response did not arrive within ${timeoutMs} ms.`);
    this.name = 'StructuredOutputTimeoutError';
  }
}

/** The model declined to answer in the schema. Billed, and recorded as such. */
export class StructuredOutputRefusalError extends Error {
  constructor(readonly refusal: string) {
    super('[ai/provider] Model refused the structured request.');
    this.name = 'StructuredOutputRefusalError';
  }
}

export interface StructuredOptions {
  model?:       string;
  /** Classic dialect only. The modern dialect rejects any non-default value. */
  temperature?: number;
  maxTokens?:   number;
  timeoutMs?:   number;
}

/** The narrow client surface a structured call uses — injectable for tests. */
export interface StructuredClient {
  chat: { completions: { create(body: unknown, options?: { signal?: AbortSignal }): Promise<unknown> } };
}

export interface StructuredResult<T> {
  value:        T;
  model:        string;
  latencyMs:    number;
  finishReason: string | null;
  usage: {
    promptTokens: number; cachedPromptTokens: number;
    completionTokens: number; reasoningTokens: number;
  } | null;
}

/**
 * Generate a reply that conforms to a JSON schema, with what it cost.
 *
 * ⚠️ THE PRE-FIX VERSION COULD NOT CALL THE MODEL THE PRODUCT RUNS ON. It always
 * sent `temperature` and `max_tokens`, and the dialect note above
 * `generateWithTools` records (measured, 2026-09-07) that gpt-5.x answers both
 * with a 400. The seam had no caller, so nothing noticed. The dialect is now
 * chosen exactly as `generateWithTools` chooses it — `usesModernParams` — and
 * the classic dialect is byte-for-byte what it was.
 *
 * ⚠️ `strict: true` MAKES EVERY PROPERTY REQUIRED AND FORBIDS EXTRAS. It does
 * NOT bound array lengths — this comment used to say it made `claims: []`
 * "unrepresentable at the provider", which was wrong and was caught by audit.
 * Lengths and emptiness are the caller's verifier's problem.
 *
 * Throws on a timeout, a refusal, or an empty or unparseable response, so the
 * caller's existing failure path covers every one of them. Usage is recorded
 * whenever the provider returned it — a refusal is still a billed request.
 */
export async function generateStructuredWithUsage<T>(
  systemPrompt: string,
  messages:     ChatMessage[],
  schema:       { name: string; schema: Record<string, unknown> },
  options?:     StructuredOptions,
  deps?:        { client?: StructuredClient; sinks?: UsageSinks },
): Promise<StructuredResult<T>> {
  const client = deps?.client ?? (getClient() as unknown as StructuredClient);
  const model = options?.model ?? CHAT_MODEL;
  const modern = usesModernParams(model);
  const timeoutMs = options?.timeoutMs ?? STRUCTURED_TIMEOUT_MS;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    ...(modern
      ? { max_completion_tokens: options?.maxTokens ?? completionBudgetFor(model) }
      : { temperature: options?.temperature ?? 0.3, max_tokens: options?.maxTokens ?? 1024 }),
    response_format: {
      type: 'json_schema',
      json_schema: { name: schema.name, schema: schema.schema, strict: true },
    },
  };

  // One deadline for the whole request, retries included: the signal is what the
  // SDK abandons on, so a slow first attempt cannot buy a second full timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let completion: {
    choices: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
    usage?: OpenAiUsage;
  };
  try {
    completion = await client.chat.completions.create(body, { signal: controller.signal }) as typeof completion;
  } catch (err) {
    if (controller.signal.aborted) throw new StructuredOutputTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;

  const choice = completion.choices?.[0];
  const finishReason = choice?.finish_reason ?? null;
  recordOpenAiUsage({
    model, usage: completion.usage, latencyMs,
    toolCallCount: 0,   // structured output, not tools
    finishReason,
    sinks: deps?.sinks,
  });

  const refusal = choice?.message?.refusal;
  if (refusal) throw new StructuredOutputRefusalError(refusal);

  const raw = choice?.message?.content ?? '';
  if (!raw) throw new Error('[ai/provider] Model returned an empty structured response.');
  let value: T;
  try {
    value = JSON.parse(raw) as T;
  } catch {
    throw new Error('[ai/provider] Model returned a structured response that is not JSON.');
  }

  const u = completion.usage;
  return {
    value, model, latencyMs, finishReason,
    usage: u ? {
      promptTokens:       u.prompt_tokens ?? 0,
      cachedPromptTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
      completionTokens:   u.completion_tokens ?? 0,
      reasoningTokens:    u.completion_tokens_details?.reasoning_tokens ?? 0,
    } : null,
  };
}

/**
 * Generate a reply that conforms to a JSON schema — the value alone.
 *
 * A structured-output seam, kept through the AI conversation reset. Same
 * signature as ever; `generateStructuredWithUsage` does the work.
 */
export async function generateStructured<T>(
  systemPrompt: string,
  messages:     ChatMessage[],
  schema:       { name: string; schema: Record<string, unknown> },
  options?:     StructuredOptions,
): Promise<T> {
  return (await generateStructuredWithUsage<T>(systemPrompt, messages, schema, options)).value;
}
