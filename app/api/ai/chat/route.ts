/**
 * POST /api/ai/chat
 *
 * Space-scoped AI chat endpoint — D4 Slice 1 (Backend).
 *
 * ── Request ───────────────────────────────────────────────────────────────────
 * {
 *   spaceId:  string | "master",
 *   messages: [{ role: "user" | "assistant", content: string }]
 * }
 *
 * ── Behaviour ─────────────────────────────────────────────────────────────────
 * Specific Space:
 *   - Verifies the user is OWNER, ADMIN, or MEMBER. Rejects VIEWER with 403.
 *   - Calls buildContext(spaceId, userId, { scopeHint: "full" }).
 *   - Serializes context + signals into a grounded system prompt.
 *   - Calls generateChatReply() from lib/ai/provider.ts.
 *
 * Master ("master"):
 *   - Enumerates all OWNER/ADMIN/MEMBER Spaces (VIEWER excluded).
 *   - Calls buildContext for each via Promise.allSettled.
 *   - Aggregates all contexts into one prompt with per-Space boundaries.
 *   - Calls generateChatReply() with the merged prompt.
 *
 * ── Response ──────────────────────────────────────────────────────────────────
 * { "message": "...", "knowledgeGaps": [...], "knowledgeGapMode": "clarification" | "form" }
 * knowledgeGaps mirrors the KnowledgeGap[] assembled at context time so the
 * client can render structured input cards without parsing the assistant text.
 * knowledgeGapMode signals how the client should render gaps:
 *   "form"          — user explicitly asked to update a field; render full card immediately.
 *   "clarification" — context has gaps; render lightweight clarification card first.
 *
 * ── Architecture (AI-ARCH) ────────────────────────────────────────────────────
 * This handler ORCHESTRATES; it does not own domain intelligence or prompt
 * detail. The flow is:
 *   canonical facts (assemblers via buildContext)
 *     → deterministic intelligence (computeAssessment, fetchPerLiabilityDebtPayments)
 *       → context assembler (SpaceContext_AI)
 *         → prompt serializer (lib/ai/prompts/*)
 *           → LLM execution (lib/ai/provider)
 *             → response
 * Message-analysis heuristics live in lib/ai/chat/message-analysis; prompt
 * serialization in lib/ai/prompts; the per-liability debt rollup in
 * lib/ai/intelligence/debt-payments. The route performs NO raw financial-table
 * query — only membership/authorization reads and audit writes.
 *
 * ── Not implemented in this slice ────────────────────────────────────────────
 * Streaming, conversation persistence, memory, actions, background jobs.
 *
 * Security notes:
 *   - Permission check is always server-side (db query), never client-asserted.
 *   - The OpenAI SDK is never imported here — all LLM calls go through
 *     lib/ai/provider.ts, the permanent AI provider boundary.
 *   - buildContext() carries its own membership guard (resolveSpaceContext
 *     fallback check) as a second layer of defence.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db }                        from '@/lib/db';
import { requireUser }               from '@/lib/session';
import { limitByUser }               from '@/lib/rate-limit';
import { SpaceMemberRole }           from '@prisma/client';
import { buildContext }              from '@/lib/ai/context-builder';
import { generateChatReply }         from '@/lib/ai/provider';
import type { ChatMessage }          from '@/lib/ai/provider';
import type { SpaceContext_AI, KnowledgeGap } from '@/lib/ai/types';
import { computeAssessment }         from '@/lib/ai/intelligence';
import type { FinancialAssessment }  from '@/lib/ai/intelligence';
import { fetchPerLiabilityDebtPayments } from '@/lib/ai/intelligence/debt-payments';
import { detectsPayoffIntent, detectsExplicitUpdateIntent } from '@/lib/ai/intent';
import type { IntentRoute }          from '@/lib/ai/intent';
import { planContextSelection, DEFAULT_CONTEXT_BUDGET_TOKENS } from '@/lib/ai/context-priority';
import { buildSpaceSystemPrompt, buildMasterSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { extractKnowledgeGaps } from '@/lib/ai/prompts/context-serializer';
import {
  routeForMessages,
  resolveTransactionWindow,
  resolveDrilldown,
  isAmbiguousBreakdownFollowUp,
  hasPriorFinancialContext,
  buildBreakdownClarification,
  filterGapsByIntent,
} from '@/lib/ai/chat/message-analysis';
import { validateOutput, applyEnforcement } from '@/lib/ai/output-validator';
import type { ValidationResult, EnforcementMode } from '@/lib/ai/output-validator';
import { AuditAction }               from '@/lib/audit-actions';
import type { Prisma }               from '@prisma/client';

export const preferredRegion = 'sin1';
export const runtime         = 'nodejs';

// ── Permission constants ─────────────────────────────────────────────────────
// VIEWER is explicitly excluded from AI chat — same rule as the Daily Brief.

const ELIGIBLE_ROLES: SpaceMemberRole[] = [
  SpaceMemberRole.OWNER,
  SpaceMemberRole.ADMIN,
  SpaceMemberRole.MEMBER,
];

// ── Shadow-mode context selection logging (D6.3D-1) ──────────────────────────
//
// Computes a deterministic SelectionPlan for each assembled context and writes
// it to the AuditLog as AI_CONTEXT_SELECTION_PLANNED. This is OBSERVATIONAL
// ONLY: the plan is never consulted when building the system prompt, so prompt
// output is byte-for-byte unchanged. Any failure here is swallowed so shadow
// logging can never affect the chat response.
//
// The existing AI_CONTEXT_ASSEMBLED row is written inside buildContext(), before
// the intent route and assessment exist, so it cannot carry the plan. A separate
// row is the low-risk, additive way to capture it.
async function logShadowSelectionPlans(
  userId:      string,
  contexts:    SpaceContext_AI[],
  assessments: FinancialAssessment[],
  intentRoute: IntentRoute,
): Promise<void> {
  try {
    await Promise.all(
      contexts.map((context, i) => {
        const assessment = assessments[i];
        if (!assessment) return Promise.resolve(null);

        const plan = planContextSelection({
          intentRoute,
          context,
          assessment,
          budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
        });

        return db.auditLog.create({
          data: {
            action:   AuditAction.AI_CONTEXT_SELECTION_PLANNED,
            userId,
            spaceId:  context.spaceId,
            metadata: plan as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
      }),
    );
  } catch (err) {
    // Non-fatal: shadow logging must never break the chat response.
    console.error('[api/ai/chat] shadow selection-plan logging failed (non-fatal):', err);
  }
}

// ── Output validation + live enforcement (AI-4 / KD-2) ───────────────────────
//
// Deterministically checks that every numeric claim in the LLM reply reconciles
// to a number present in the grounded system prompt (membership-with-tolerance,
// lib/ai/output-validator.ts), then returns the result so the caller can apply
// the configured enforcement behavior (applyEnforcement + AI_OUTPUT_VALIDATION_MODE).
//
// Logging is preserved from shadow mode: an AuditLog row is written ONLY when
// unreconciled numbers exist, so this still adds no per-message write
// amplification (KD-12). All errors are swallowed and yield a CLEAN result, so a
// validator failure deterministically means "no enforcement" — never a broken or
// delayed chat response.
const CLEAN_VALIDATION: ValidationResult = { unreconciled: [], checkedCount: 0, sourceCount: 0 };

/**
 * Enforcement mode from the environment. Defaults to live 'annotate' (KD-2
 * promotion); an unset or unrecognized value falls back to 'annotate'. Set
 * AI_OUTPUT_VALIDATION_MODE=shadow to revert to observational (kill switch), or
 * =block to suppress unreconciled replies.
 */
function outputEnforcementMode(): EnforcementMode {
  const raw = (process.env.AI_OUTPUT_VALIDATION_MODE ?? 'annotate').toLowerCase();
  return raw === 'shadow' || raw === 'block' ? raw : 'annotate';
}

async function runOutputValidation(
  userId:       string,
  spaceId:      string,
  reply:        string,
  systemPrompt: string,
  messages:     ChatMessage[],
  mode:         EnforcementMode,
): Promise<ValidationResult> {
  try {
    const userMessages = messages.filter((m) => m.role === 'user').map((m) => m.content);
    const result = validateOutput(reply, systemPrompt, userMessages);
    if (result.unreconciled.length === 0) return result; // clean — write nothing.

    await db.auditLog.create({
      data: {
        action:   AuditAction.AI_OUTPUT_VALIDATION_FLAGGED,
        userId,
        // Master mode has no single Space — spaceId is nullable on AuditLog.
        spaceId:  spaceId === 'master' ? null : spaceId,
        metadata: {
          mode:         spaceId === 'master' ? 'master' : 'space',
          enforcement:  mode,
          unreconciled: result.unreconciled,
          checkedCount: result.checkedCount,
          sourceCount:  result.sourceCount,
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return result;
  } catch (err) {
    // Non-fatal: validation must never break the chat response. A swallowed
    // error yields a clean result, so enforcement deterministically no-ops.
    console.error('[api/ai/chat] output validation failed (non-fatal):', err);
    return CLEAN_VALIDATION;
  }
}

// ── Knowledge-gap gating heuristics (KD-11) ───────────────────────────────────
// detectsPayoffIntent / detectsExplicitUpdateIntent live in lib/ai/intent; the
// message-analysis heuristics (routing, window carry-forward, drilldown,
// ambiguity, gap filtering) live in lib/ai/chat/message-analysis. Both are
// imported above and used unchanged in the handler below.

// ── Request validation ────────────────────────────────────────────────────────

interface ChatRequestBody {
  spaceId:  string;
  messages: ChatMessage[];
}

function parseBody(raw: unknown): ChatRequestBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;

  if (typeof b.spaceId !== 'string' || !b.spaceId.trim()) return null;

  if (!Array.isArray(b.messages)) return null;
  for (const m of b.messages) {
    if (
      !m ||
      typeof m !== 'object' ||
      !('role' in m) ||
      !('content' in m) ||
      (m.role !== 'user' && m.role !== 'assistant') ||
      typeof m.content !== 'string'
    ) {
      return null;
    }
  }

  return {
    spaceId:  b.spaceId.trim(),
    messages: b.messages as ChatMessage[],
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;

  // ── Rate limit (KD-3) ───────────────────────────────────────────────────────
  // Per-user cap to contain LLM cost abuse. SYSTEM_ADMIN is exempt.
  if (user.role !== 'SYSTEM_ADMIN') {
    const limited = await limitByUser(user.id, 'ai-chat', { limit: 30, windowSec: 60 });
    if (limited) return limited;
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const body = parseBody(rawBody);
  if (!body) {
    return NextResponse.json(
      { error: 'Invalid request. Required: spaceId (string), messages (array of {role, content}).' },
      { status: 400 },
    );
  }

  const { spaceId, messages } = body;

  // ── Body guard (KD-3) ───────────────────────────────────────────────────────
  // Cheap ceilings that bound prompt size independent of the rate limiter:
  // reject oversized conversations before any context build or LLM call.
  const MAX_MESSAGES            = 50;
  const MAX_TOTAL_CONTENT_CHARS = 24_000;
  if (messages.length > MAX_MESSAGES) {
    return NextResponse.json(
      {
        error: `This conversation is too long to send at once. Please start a new conversation or shorten it to ${MAX_MESSAGES} messages or fewer, then try again.`,
      },
      { status: 400 },
    );
  }
  const totalContentChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalContentChars > MAX_TOTAL_CONTENT_CHARS) {
    return NextResponse.json(
      { error: `Message content too large (max ${MAX_TOTAL_CONTENT_CHARS} characters).` },
      { status: 400 },
    );
  }

  // Must have at least one user message
  if (!messages.some((m) => m.role === 'user')) {
    return NextResponse.json(
      { error: 'messages must contain at least one user turn.' },
      { status: 400 },
    );
  }

  let systemPrompt: string;
  // Knowledge gaps assembled at context time — returned alongside the reply so
  // the client can render structured input UI without parsing assistant text.
  let gapsForResponse: KnowledgeGap[] = [];

  // Layer 0 (D4): classify the latest user message into routing metadata.
  // Injected into the system prompt as === QUESTION ROUTING ===.
  const intentRoute = routeForMessages(messages);

  // D6 dynamic windows (with carry-forward): an optional explicit transaction
  // window derived from the user's wording ("this year", "last 6 months", …).
  // The latest message's own window wins; a follow-up ("month by month",
  // "what about January") inherits the most recent explicit window instead of
  // resetting to the default. Undefined for unrelated general prompts, which
  // keeps the assembler's default 30/90-day window.
  const transactionWindow = resolveTransactionWindow(messages, new Date());

  // D6 transaction drilldown (evidence retrieval): present ONLY for an explicit
  // drilldown follow-up ("what is this Other category made up of?", "show me the
  // largest transactions"). Undefined otherwise — no raw rows on ordinary prompts.
  const drilldown = resolveDrilldown(messages, new Date());

  // ── Ambiguity guard ────────────────────────────────────────────────────────
  // An antecedent-less breakdown follow-up ("break it down", "month by month",
  // "what about January") with no window of its own and no prior financial topic
  // is genuinely ambiguous — there is no subject for "it". Ask what to break down
  // rather than guessing (which previously produced a default-90-day Apr–Jun
  // table). The clarification is space-agnostic and exposes no financial data.
  const latestUser = [...messages].reverse().find((m) => m.role === 'user');
  if (
    latestUser &&
    transactionWindow === undefined &&
    isAmbiguousBreakdownFollowUp(latestUser.content) &&
    !hasPriorFinancialContext(messages, new Date())
  ) {
    return NextResponse.json({
      message:          buildBreakdownClarification(latestUser.content),
      knowledgeGaps:    [],
      knowledgeGapMode: 'clarification',
    });
  }

  if (spaceId === 'master') {
    // ── Master mode: aggregate all eligible Spaces ─────────────────────────
    // Enumerate OWNER/ADMIN/MEMBER memberships only. VIEWER excluded.

    const memberships = await db.spaceMember.findMany({
      where: {
        userId: user.id,
        status: 'ACTIVE',
        role:   { in: ELIGIBLE_ROLES },
        space:  { archivedAt: null, deletedAt: null },
      },
      select: { spaceId: true },
    });

    if (memberships.length === 0) {
      return NextResponse.json(
        { error: 'No eligible spaces found.' },
        { status: 403 },
      );
    }

    const contextResults = await Promise.allSettled(
      memberships.map((m) =>
        buildContext(m.spaceId, user.id, { scopeHint: 'full', transactionWindow, drilldown }),
      ),
    );

    const contexts: SpaceContext_AI[] = contextResults
      .filter(
        (r): r is PromiseFulfilledResult<SpaceContext_AI> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value);

    // Log failures without crashing
    contextResults.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(
          `[api/ai/chat] buildContext failed for Space ${memberships[i]?.spaceId}:`,
          r.reason,
        );
      }
    });

    if (contexts.length === 0) {
      return NextResponse.json(
        { error: 'Could not assemble context for any eligible space.' },
        { status: 500 },
      );
    }

    const masterAssessments = contexts.map(computeAssessment);
    // Slice 6: per-liability debt-payment rollups (one Space-scoped query each,
    // in parallel; [] on failure — serializer falls back to disclosure-only).
    const masterDebtPayments = await Promise.all(
      contexts.map((c) => fetchPerLiabilityDebtPayments(c)),
    );
    systemPrompt = buildMasterSystemPrompt(contexts, masterAssessments, intentRoute, masterDebtPayments);
    // Shadow-mode selection plan (D6.3D-1): logged only — prompt is unchanged.
    await logShadowSelectionPlans(user.id, contexts, masterAssessments, intentRoute);
    gapsForResponse = filterGapsByIntent(
      contexts.flatMap(extractKnowledgeGaps),
      detectsPayoffIntent(messages),
    );

  } else {
    // ── Specific Space: verify membership, reject VIEWER ──────────────────
    const membership = await db.spaceMember.findUnique({
      where:  { spaceId_userId: { spaceId, userId: user.id } },
      select: { role: true, status: true, space: { select: { archivedAt: true, deletedAt: true } } },
    });

    if (
      !membership ||
      membership.status !== 'ACTIVE' ||
      membership.space.archivedAt !== null ||
      membership.space.deletedAt !== null
    ) {
      return NextResponse.json({ error: 'Space not found.' }, { status: 404 });
    }

    if (!ELIGIBLE_ROLES.includes(membership.role)) {
      // VIEWER — explicitly excluded from AI chat
      return NextResponse.json(
        { error: 'AI chat is not available for viewer-role members.' },
        { status: 403 },
      );
    }

    // buildContext carries a second membership guard internally.
    let ctx: SpaceContext_AI;
    try {
      ctx = await buildContext(spaceId, user.id, { scopeHint: 'full', transactionWindow, drilldown });
    } catch (err) {
      console.error('[api/ai/chat] buildContext error:', err);
      return NextResponse.json(
        { error: 'Failed to assemble space context.' },
        { status: 500 },
      );
    }

    const assessment = computeAssessment(ctx);
    // Slice 6: per-liability debt-payment rollup ([] on failure → disclosure-only).
    const debtPayments = await fetchPerLiabilityDebtPayments(ctx);
    systemPrompt = buildSpaceSystemPrompt(ctx, assessment, intentRoute, debtPayments);
    // Shadow-mode selection plan (D6.3D-1): logged only — prompt is unchanged.
    await logShadowSelectionPlans(user.id, [ctx], [assessment], intentRoute);
    gapsForResponse = filterGapsByIntent(
      extractKnowledgeGaps(ctx),
      detectsPayoffIntent(messages),
    );
  }

  // ── Gap mode ─────────────────────────────────────────────────────────────
  // "form"          — user explicitly asked to update a field; render full card immediately.
  // "clarification" — context has gaps but user didn't ask to update; render lightweight prompt.
  const gapMode: 'clarification' | 'form' =
    detectsExplicitUpdateIntent(messages) ? 'form' : 'clarification';

  // ── LLM call ──────────────────────────────────────────────────────────────
  // generateChatReply is the only sanctioned path to the OpenAI SDK.
  // If OPENAI_API_KEY is not set it throws a clear error caught below.

  let reply: string;
  try {
    reply = await generateChatReply(systemPrompt, messages);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error.';
    console.error('[api/ai/chat] generateChatReply error:', message);

    // Surface key-not-configured errors as 503 so the client can distinguish
    // from transient errors.
    if (message.includes('OPENAI_API_KEY')) {
      return NextResponse.json(
        { error: 'AI provider is not configured. Set OPENAI_API_KEY.' },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { error: 'AI provider error. Please try again.' },
      { status: 502 },
    );
  }

  // Output validation + live enforcement (AI-4 / KD-2). Validation runs after
  // the reply exists; enforcement then deterministically annotates (or, if
  // configured, blocks) a reply containing a figure that could not be reconciled
  // to context. Pure string work — no extra I/O, negligible latency.
  const enforcementMode = outputEnforcementMode();
  const validation = await runOutputValidation(
    user.id, spaceId, reply, systemPrompt, messages, enforcementMode,
  );
  reply = applyEnforcement(reply, validation, enforcementMode);

  return NextResponse.json({
    message:          reply,
    knowledgeGaps:    gapsForResponse,
    knowledgeGapMode: gapMode,
  });
}
