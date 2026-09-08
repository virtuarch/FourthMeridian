/**
 * lib/ai/invocation.ts  (Platform Ops cost accounting — Slice 3)
 *
 * THE IMMUTABLE AI INVOCATION FACT WRITER — one row per model call that actually
 * returned usage.
 *
 * ⚠️ EXACTLY ONCE, BY POSITION RATHER THAN BY DEDUPLICATION KEY. This is called
 * from the provider chokepoint AFTER a response carrying usage has been returned.
 * A call that threw — a rate limit the caller will retry, a timeout, an invalid
 * request — never reaches here, so it writes nothing. A retry that succeeds is a
 * genuinely separate billable request and writes its own row. Every write is an
 * INSERT with a fresh id; nothing is ever updated, so a later attempt can neither
 * overwrite an earlier one nor be mistaken for it.
 *
 * ⚠️ TELEMETRY NEVER BREAKS THE CALL. Fire-and-forget and internally
 * non-throwing, the same posture as `recordApiUsage`, `recordProviderCall` and
 * the email seam. A ledger failure must never turn a successful generation into a
 * failed one.
 *
 * ⚠️ ALLOWLISTED FIELDS ONLY. Counts, timings, an opaque grouping key and the
 * deployment environment. Never a prompt, a completion, a message, a tool
 * argument or result, a financial value, or an account identifier — and never a
 * dollar figure, because cost is derived at read time from an effective-dated
 * rate and a stored cost would freeze a price into a fact.
 */

import 'server-only';
import { db } from '@/lib/db';
import { deploymentEnvironment } from '@/lib/env';
import { getAiInvocationContext } from '@/lib/ai/invocation-context';
import type { OpenAiUsage } from '@/lib/usage/ai-tokens';

export interface AiInvocationInput {
  provider: string;
  model: string;
  usage: OpenAiUsage;
  latencyMs: number;
  toolCallCount?: number;
  finishReason?: string | null;
  occurredAt?: Date;
}

/** Narrow write-client seam — the ProviderCallWriteClient / JobRunWriteClient idiom. */
export interface AiInvocationWriteClient {
  aiInvocation: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

const whole = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/**
 * Record one invocation. Never throws, never rejects.
 *
 * Token counts are stored EXACTLY as the provider reported them, preserving the
 * Slice 1 subset semantics (cached ⊆ prompt, reasoning ⊆ completion). Nothing is
 * clamped and no derivation is stored: `uncachedPromptTokens` and totals are
 * computed where they are read.
 */
export async function recordAiInvocation(
  input: AiInvocationInput,
  client: AiInvocationWriteClient = db as unknown as AiInvocationWriteClient,
): Promise<void> {
  try {
    const ctx = getAiInvocationContext();
    await client.aiInvocation.create({
      data: {
        provider: input.provider,
        model: input.model,
        occurredAt: input.occurredAt ?? new Date(),
        promptTokens:       whole(input.usage.prompt_tokens),
        cachedPromptTokens: whole(input.usage.prompt_tokens_details?.cached_tokens),
        completionTokens:   whole(input.usage.completion_tokens),
        reasoningTokens:    whole(input.usage.completion_tokens_details?.reasoning_tokens),
        latencyMs:     whole(input.latencyMs),
        toolCallCount: whole(input.toolCallCount),
        ...(input.finishReason ? { finishReason: input.finishReason } : {}),
        environment: deploymentEnvironment(),
        ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
        ...(typeof ctx?.turnIndex === 'number' ? { turnIndex: ctx.turnIndex } : {}),
        ...(ctx?.surface ? { surface: ctx.surface } : {}),
      },
    });
  } catch (e) {
    console.warn('[ai/invocation] recordAiInvocation failed (non-fatal):', e);
  }
}
