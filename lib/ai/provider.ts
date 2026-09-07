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
