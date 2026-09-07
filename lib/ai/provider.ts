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

  const completion = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    temperature: 0.3,
    max_tokens:  1024,
  });

  // Wave 2 S7 — record API usage (calls + tokens per model). Fire-and-forget:
  // recordApiUsage is internally non-throwing, so `void` here can neither fail
  // the chat nor produce an unhandled rejection. Metric embeds the model so the
  // per-model breakdown needs no extra dimension.
  const usage = completion.usage;
  if (usage) {
    const metric = `chat.completions:${CHAT_MODEL}`;
    void recordApiUsage('OPENAI', metric, 'calls', 1);
    void recordApiUsage('OPENAI', metric, 'prompt_tokens', usage.prompt_tokens ?? 0);
    void recordApiUsage('OPENAI', metric, 'completion_tokens', usage.completion_tokens ?? 0);
  }

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
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number } };
  };
  const latencyMs = Date.now() - started;

  const usage = completion.usage;
  if (usage) {
    const metric = `chat.completions:${model}`;
    void recordApiUsage('OPENAI', metric, 'calls', 1);
    void recordApiUsage('OPENAI', metric, 'prompt_tokens', usage.prompt_tokens ?? 0);
    void recordApiUsage('OPENAI', metric, 'completion_tokens', usage.completion_tokens ?? 0);
  }

  const choice = completion.choices[0];
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
 * Generate a reply that conforms to a JSON schema.
 *
 * A structured-output seam, kept through the AI conversation reset.
 *
 * ⚠️ IT HAS NO CALLER TODAY, AND THAT IS THE POINT OF A SEAM. The typed answer
 * boundary that used it was deleted; the provider boundary is not architecture,
 * it is the one place this codebase is allowed to import the OpenAI SDK, and
 * removing a capability from it would only mean re-adding it later in a worse
 * place. `generateChatReply` beside it is likewise callable and uncalled.
 *
 * ⚠️ `strict: true` MAKES EVERY PROPERTY REQUIRED AND FORBIDS EXTRAS. It does
 * NOT bound array lengths — this comment used to say it made `claims: []`
 * "unrepresentable at the provider", which was wrong and was caught by audit.
 * Emptiness is the verifier's problem and the verifier now handles it.
 *
 * Throws on an empty or unparseable response, exactly as its sibling does, so
 * the caller's existing failure path covers it.
 */
export async function generateStructured<T>(
  systemPrompt: string,
  messages:     ChatMessage[],
  schema:       { name: string; schema: Record<string, unknown> },
  options?:     { model?: string; temperature?: number; maxTokens?: number },
): Promise<T> {
  const client = getClient();
  const model = options?.model ?? CHAT_MODEL;

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    temperature: options?.temperature ?? 0.3,
    max_tokens:  options?.maxTokens ?? 1024,
    response_format: {
      type: 'json_schema',
      json_schema: { name: schema.name, schema: schema.schema, strict: true },
    },
  });

  const usage = completion.usage;
  if (usage) {
    const metric = `chat.completions:${model}`;
    void recordApiUsage('OPENAI', metric, 'calls', 1);
    void recordApiUsage('OPENAI', metric, 'prompt_tokens', usage.prompt_tokens ?? 0);
    void recordApiUsage('OPENAI', metric, 'completion_tokens', usage.completion_tokens ?? 0);
  }

  const raw = completion.choices[0]?.message?.content ?? '';
  if (!raw) throw new Error('[ai/provider] Model returned an empty structured response.');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('[ai/provider] Model returned a structured response that is not JSON.');
  }
}
