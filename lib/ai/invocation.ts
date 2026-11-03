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
 * ⚠️ TELEMETRY NEVER BREAKS THE CALL — BUT IT IS NO LONGER SILENT (IDEMP-009 /
 * OBS-005). Both writers are internally non-throwing: a ledger failure must never
 * turn a successful generation into a failed one, and a failure row must never
 * swallow or replace the error the caller is about to receive. What changed:
 * the chokepoint now AWAITS them (a row is on the ledger before the response
 * resolves), and a failed write is captured, counted and reported to the
 * allowance reservation through lib/platform/ai/ledger-health.ts, which then
 * fails CLOSED. The allowance never under-counts silently.
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
import { noteLedgerWriteFailure, noteLedgerWriteSuccess, type LedgerHealthWriteClient } from '@/lib/platform/ai/ledger-health';
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

/**
 * Narrow write-client seam — the ProviderCallWriteClient / JobRunWriteClient idiom.
 * `rateLimit` is optional: the real fm_system client has it and the durable
 * ledger-health signal rides it; a test's fake ledger need not.
 */
export interface AiInvocationWriteClient extends LedgerHealthWriteClient {
  aiInvocation: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

const whole = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/**
 * The ONLY shape an error code may have on the ledger: a short identifier. A
 * provider that puts prose in `err.code` (a sentence, a prompt fragment, a URL
 * with a query) must never reach `AiInvocation.errorCode` — truncation alone
 * kept 64 characters of that prose (#331 fixed only the display).
 */
export const AI_LEDGER_ERROR_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** What the ledger stores when a code was supplied but is not code-shaped. */
export const AI_LEDGER_ERROR_CODE_FALLBACK = 'error';

/** The trimmed text of a string or finite number, or null when absent/blank. */
const textOf = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim()
    : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

/** A code-shaped value, or null (absent OR not code-shaped) — lets classification fall through. */
const shaped = (v: unknown): string | null => {
  const t = textOf(v);
  return t !== null && AI_LEDGER_ERROR_CODE_SHAPE.test(t) ? t : null;
};

/**
 * The ledger error-code gate. Absent/blank → null (nothing written); a
 * code-shaped value → itself; anything else (prose, over-long, punctuation) →
 * `"error"`. Every write of `AiInvocation.errorCode` goes through this
 * (pinned by lib/ai/invocation-error-code.test.ts).
 */
export function code(v: unknown): string | null {
  const t = textOf(v);
  if (t === null) return null;
  return AI_LEDGER_ERROR_CODE_SHAPE.test(t) ? t : AI_LEDGER_ERROR_CODE_FALLBACK;
}

/** Clip an identifier-like value (a provider request id); unchanged pre-existing behaviour. */
const clip = (v: unknown): string | null => {
  const t = textOf(v);
  return t === null ? null : t.slice(0, 64);
};

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
  // `shaped` (not `code`) so a prose `e.code` falls through to the status / class name.
  if (isQuotaExhaustedError(err)) return { outcome: 'QUOTA', errorCode: shaped(e.code) ?? 'insufficient_quota' };
  if (isRateLimitError(err))      return { outcome: 'RATE_LIMITED', errorCode: shaped(e.code) ?? shaped(e.status) ?? '429' };
  if (/abort|timeout/i.test(name) || /^StructuredOutputTimeoutError$/.test(name)) {
    return { outcome: 'TIMEOUT', errorCode: shaped(e.code) ?? 'abort' };
  }
  return { outcome: 'FAILED', errorCode: shaped(e.code) ?? shaped(e.status) ?? (name ? code(name) : null) };
}

// ⚠️ fm_system, NOT the tenant role and NOT the migration principal. AiInvocation
// is REVOKED from fm_app (…000100 §4); fm_system is the only authority that can
// write it, and the default says so rather than leaving it to the ambient client.
const DEFAULT_CLIENT = (): AiInvocationWriteClient => systemDb as unknown as AiInvocationWriteClient;

/**
 * Record one RETURNED invocation. Never throws, never rejects. Resolves `true`
 * when the row is on the ledger, `false` when the write failed (and was
 * captured, counted and reported — see lib/platform/ai/ledger-health.ts).
 *
 * Token counts are stored EXACTLY as the provider reported them, preserving the
 * Slice 1 subset semantics (cached ⊆ prompt, reasoning ⊆ completion). Nothing is
 * clamped and no derivation is stored: `uncachedPromptTokens` and totals are
 * computed where they are read.
 */
export async function recordAiInvocation(
  input: AiInvocationInput,
  client: AiInvocationWriteClient = DEFAULT_CLIENT(),
): Promise<boolean> {
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
        ...(input.providerRequestId ? { providerRequestId: clip(input.providerRequestId) } : {}),
        environment: deploymentEnvironment(),
        ...attributionOf(ctx),
      },
    });
  } catch (e) {
    // IDEMP-009 — captured, counted, reported to the reservation; never rethrown.
    await noteLedgerWriteFailure(e, client);
    return false;
  }
  await noteLedgerWriteSuccess(client);
  return true;
}

/**
 * Record one FAILED invocation — a provider call that threw. Zero tokens, an
 * error CODE, full attribution. Never throws, never rejects, and never touches
 * the error it describes: the chokepoint rethrows that unchanged. Resolves
 * whether the row was written, like the success writer.
 */
export async function recordAiInvocationFailure(
  input: AiInvocationFailureInput,
  client: AiInvocationWriteClient = DEFAULT_CLIENT(),
): Promise<boolean> {
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
        // SEC-AI-003 — the attempt number of this hop, so cost exposure is
        // countable per row (a RETURNED row's finishReason is the provider's).
        ...(typeof ctx?.attempt === 'number' && ctx.attempt > 0 ? { finishReason: `attempt:${Math.floor(ctx.attempt)}` } : {}),
        ...(input.providerRequestId ? { providerRequestId: clip(input.providerRequestId) } : {}),
        environment: deploymentEnvironment(),
        ...attributionOf(ctx),
      },
    });
  } catch (e) {
    // IDEMP-009 — captured, counted, reported to the reservation; never rethrown.
    await noteLedgerWriteFailure(e, client);
    return false;
  }
  await noteLedgerWriteSuccess(client);
  return true;
}
