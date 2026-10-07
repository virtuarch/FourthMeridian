/**
 * lib/ai/invocation.ts  (Platform Ops cost accounting — Slice 3;
 * failure facts + attribution by OPERATIONALIZATION P0, 2026-10-07)
 *
 * THE IMMUTABLE AI INVOCATION FACT WRITER — one row per model call.
 *
 * TWO KINDS OF ROW, ONE TABLE, DISCRIMINATED BY `outcome`:
 *   · RETURNED — the provider answered and reported usage. Billed. The only
 *     kind the ledger held before 2026-10-07.
 *   · FAILED / TIMEOUT / RATE_LIMITED / QUOTA — the provider chokepoint's call
 *     THREW. Zero tokens, an error CODE, and the same attribution as a success.
 *     Before this, a throw wrote nothing: the Oct 4 Daily Brief outage
 *     (`insufficient_quota`) was a console line and a user report. Now it is a
 *     fact the alert engine and the Platform Ops overview read.
 *
 * ⚠️ EXACTLY ONCE, BY POSITION RATHER THAN BY DEDUPLICATION KEY. Both writers are
 * called from the provider chokepoint, one on the return path and one on the
 * throw path of the SAME call, so every attempt writes exactly one row. A retry
 * that succeeds is a genuinely separate billable request and writes its own
 * RETURNED row after the RATE_LIMITED row(s) of the attempts before it. Every
 * write is an INSERT with a fresh id; nothing is ever updated.
 *
 * ⚠️ TELEMETRY NEVER BREAKS THE CALL. Fire-and-forget and internally
 * non-throwing, the same posture as `recordApiUsage`, `recordProviderCall` and
 * the email seam. A ledger failure must never turn a successful generation into a
 * failed one, and a failure row must never swallow or replace the error the
 * caller is about to receive.
 *
 * ⚠️ ALLOWLISTED FIELDS ONLY. Counts, timings, grouping keys, the attribution
 * identifiers, an error CODE and the deployment environment. Never a prompt, a
 * completion, a message, an error MESSAGE (provider messages quote prompt
 * fragments), a tool argument or result, a financial value, or an account
 * identifier — and never a dollar figure, because cost is derived at read time
 * from an effective-dated rate and a stored cost would freeze a price into a fact.
 *
 * ⚠️ ATTRIBUTION (2026-10-07 owner ruling). `userId`, `spaceId`, `conversationId`
 * and `subSurface` come from the ambient context and reverse the Slice 3
 * decision that a row must never be resolvable to a person. They are bounded
 * operator telemetry: the table stays REVOKED from fm_app and is written and
 * read by fm_system only (…000100 §4), so there is no tenant path through which
 * Conversations could retrieve another user's telemetry. Estimated cost (a
 * read-time reduction over a versioned rate card) and provider-reported usage
 * (stored here verbatim) remain distinguishable; nothing here is invoice truth.
 */

import 'server-only';
import { systemDb } from '@/lib/db';
import { deploymentEnvironment } from '@/lib/env';
import { getAiInvocationContext, type AiInvocationContext } from '@/lib/ai/invocation-context';
import { isQuotaExhaustedError, isRateLimitError } from '@/lib/ai/rate-limit-retry';
import type { OpenAiUsage } from '@/lib/usage/ai-tokens';

/** What happened to a provider call. `RETURNED` is the only billed kind. */
export type AiInvocationOutcome = 'RETURNED' | 'FAILED' | 'TIMEOUT' | 'RATE_LIMITED' | 'QUOTA';

export interface AiInvocationInput {
  provider: string;
  model: string;
  usage: OpenAiUsage;
  latencyMs: number;
  toolCallCount?: number;
  finishReason?: string | null;
  occurredAt?: Date;
  /** The provider's own request id (OpenAI `x-request-id`), when the SDK exposed it. */
  providerRequestId?: string | null;
}

export interface AiInvocationFailureInput {
  provider: string;
  model: string;
  outcome: Exclude<AiInvocationOutcome, 'RETURNED'>;
  /** A CODE: provider `code`, HTTP status, or error class name. Never a message. */
  errorCode: string | null;
  latencyMs: number;
  occurredAt?: Date;
  providerRequestId?: string | null;
}

/** Narrow write-client seam — the ProviderCallWriteClient / JobRunWriteClient idiom. */
export interface AiInvocationWriteClient {
  aiInvocation: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

const whole = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/** Clip an identifier-shaped value; the ledger never carries free text. */
const code = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 64)
    : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

/** The attribution columns, from the ambient context. Shared by both writers. */
function attributionOf(ctx: AiInvocationContext | undefined): Record<string, unknown> {
  return {
    ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
    ...(typeof ctx?.turnIndex === 'number' ? { turnIndex: ctx.turnIndex } : {}),
    ...(ctx?.surface ? { surface: ctx.surface } : {}),
    ...(ctx?.subSurface ? { subSurface: ctx.subSurface } : {}),
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
    ...(ctx?.spaceId ? { spaceId: ctx.spaceId } : {}),
    ...(ctx?.conversationId ? { conversationId: ctx.conversationId } : {}),
  };
}

/**
 * Classify a thrown provider error into an outcome and a CODE.
 *
 * Quota is tested before rate limit because OpenAI answers both with a 429
 * (`isRateLimitError` already excludes quota). A timeout is an abort — either
 * the SDK's `APIUserAbortError`, the provider module's own
 * `StructuredOutputTimeoutError`, or any error whose name says abort. Everything
 * else is FAILED with whatever code the error carries.
 */
export function classifyAiFailure(err: unknown): { outcome: Exclude<AiInvocationOutcome, 'RETURNED'>; errorCode: string | null } {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; status?: unknown; name?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  if (isQuotaExhaustedError(err)) return { outcome: 'QUOTA', errorCode: code(e.code) ?? 'insufficient_quota' };
  if (isRateLimitError(err))      return { outcome: 'RATE_LIMITED', errorCode: code(e.code) ?? code(e.status) ?? '429' };
  if (/abort|timeout/i.test(name) || /^StructuredOutputTimeoutError$/.test(name)) {
    return { outcome: 'TIMEOUT', errorCode: code(e.code) ?? 'abort' };
  }
  return { outcome: 'FAILED', errorCode: code(e.code) ?? code(e.status) ?? (name || null) };
}

// ⚠️ fm_system, NOT the tenant role and NOT the migration principal. AiInvocation
// is REVOKED from fm_app (…000100 §4); fm_system is the only authority that can
// write it, and the default says so rather than leaving it to the ambient client.
const DEFAULT_CLIENT = (): AiInvocationWriteClient => systemDb as unknown as AiInvocationWriteClient;

/**
 * Record one RETURNED invocation. Never throws, never rejects.
 *
 * Token counts are stored EXACTLY as the provider reported them, preserving the
 * Slice 1 subset semantics (cached ⊆ prompt, reasoning ⊆ completion). Nothing is
 * clamped and no derivation is stored: `uncachedPromptTokens` and totals are
 * computed where they are read.
 */
export async function recordAiInvocation(
  input: AiInvocationInput,
  client: AiInvocationWriteClient = DEFAULT_CLIENT(),
): Promise<void> {
  try {
    const ctx = getAiInvocationContext();
    await client.aiInvocation.create({
      data: {
        provider: input.provider,
        model: input.model,
        occurredAt: input.occurredAt ?? new Date(),
        outcome: 'RETURNED',
        promptTokens:       whole(input.usage.prompt_tokens),
        cachedPromptTokens: whole(input.usage.prompt_tokens_details?.cached_tokens),
        completionTokens:   whole(input.usage.completion_tokens),
        reasoningTokens:    whole(input.usage.completion_tokens_details?.reasoning_tokens),
        latencyMs:     whole(input.latencyMs),
        toolCallCount: whole(input.toolCallCount),
        ...(input.finishReason ? { finishReason: input.finishReason } : {}),
        ...(input.providerRequestId ? { providerRequestId: code(input.providerRequestId) } : {}),
        environment: deploymentEnvironment(),
        ...attributionOf(ctx),
      },
    });
  } catch (e) {
    console.warn('[ai/invocation] recordAiInvocation failed (non-fatal):', e);
  }
}

/**
 * Record one FAILED invocation — a provider call that threw. Zero tokens, an
 * error CODE, full attribution. Never throws, never rejects, and never touches
 * the error it describes: the chokepoint rethrows that unchanged.
 */
export async function recordAiInvocationFailure(
  input: AiInvocationFailureInput,
  client: AiInvocationWriteClient = DEFAULT_CLIENT(),
): Promise<void> {
  try {
    const ctx = getAiInvocationContext();
    await client.aiInvocation.create({
      data: {
        provider: input.provider,
        model: input.model,
        occurredAt: input.occurredAt ?? new Date(),
        outcome: input.outcome,
        ...(input.errorCode ? { errorCode: code(input.errorCode) } : {}),
        promptTokens: 0,
        cachedPromptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        latencyMs: whole(input.latencyMs),
        toolCallCount: 0,
        ...(input.providerRequestId ? { providerRequestId: code(input.providerRequestId) } : {}),
        environment: deploymentEnvironment(),
        ...attributionOf(ctx),
      },
    });
  } catch (e) {
    console.warn('[ai/invocation] recordAiInvocationFailure failed (non-fatal):', e);
  }
}
