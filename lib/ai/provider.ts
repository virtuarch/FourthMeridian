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

const CHAT_MODEL = 'gpt-4o-mini';

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
 * V26-REASONING Slice 1 — THE MODEL IS GIVEN A WAY TO SAY WHAT IT MEANT.
 *
 * ⚠️ `generateChatReply` ABOVE IS UNTOUCHED, and that is deliberate: it is the
 * `prose` branch of `AI_ANSWER_MODE` and it must stay byte-identical while both
 * paths are measured against each other. A shared helper that "just" refactored
 * the two together would make the comparison meaningless.
 *
 * ⚠️ `strict: true`. Without it the schema is a suggestion, and a model that
 * partially satisfies it returns `claims: []` beside a prose full of numbers —
 * which the verifier would then reject as entirely unlicensed, turning a
 * formatting slip into a refused answer. Making the shape unrepresentable at the
 * provider is cheaper than repairing it downstream.
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
