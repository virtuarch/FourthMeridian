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
import type { SpaceContext_AI, KnowledgeGap, AccountsSectionData } from '@/lib/ai/types';
import { FinanceDomains }            from '@/lib/ai/types';
import { computeAssessment }         from '@/lib/ai/intelligence';
import type { FinancialAssessment }  from '@/lib/ai/intelligence';
import { fetchPerLiabilityDebtPayments } from '@/lib/ai/intelligence/debt-payments';
import { loadCoverageEnvelope, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { planRetrieval, planAuditPayload, Concepts, type RetrievalPlan } from '@/lib/ai/retrieval-plan';
import { buildForecastSurfaces, guardForecastAnswer } from '@/lib/ai/forecast/for-request';
import { answerTyped, resolveAnswerMode } from '@/lib/reasoning/answer/for-request';
import { resolveMasterSurfaces } from '@/lib/ai/chat/master-surfaces';
import type { PayDateResult } from '@/lib/ai/forecast/pay-dates';
import type { AssembledForecast } from '@/lib/ai/forecast/assemble';

import { detectsPayoffIntent, detectsExplicitUpdateIntent } from '@/lib/ai/intent';
import type { IntentRoute }          from '@/lib/ai/intent';
import { buildSpaceSystemPrompt, buildMasterSystemPrompt, omitDomainJson,
  renderForecastScopeRefusal } from '@/lib/ai/prompts/system-prompt';
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
// A5 — assessment-contradiction guard. Sibling to the numeric validator, not an
// extension of it: different input (the assessment, not the prompt text),
// different consequence, so output-validator.ts stays single-purpose.
import {
  detectAssessmentContradiction, buildRepairInstruction, applyGuard, resolveGuardMode,
  type GuardFinding,
} from '@/lib/ai/assessment-guard';
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

/** CF-6 — the newest user message, as a domain-RELEVANCE signal. Nothing else reads it. */
function latestUserMessage(msgs: { role: string; content: string }[]): string | undefined {
  return [...msgs].reverse().find((m) => m.role === 'user')?.content;
}

// CF-8 — persist the SHADOW retrieval plan beside the domains production really
// assembled. Observational only, and failure is swallowed: a planning
// diagnostic must never cost a user their answer. Carries no financial content.
async function logShadowRetrievalPlan(
  userId: string,
  spaceId: string,
  plan: RetrievalPlan | undefined,
  actualDomains: string[],
  jsonOmitted: string[],
): Promise<void> {
  if (!plan) return;
  try {
    await db.auditLog.create({
      data: {
        action:  AuditAction.AI_CONTEXT_SELECTION_PLANNED,
        userId,
        spaceId,
        metadata: {
          ...planAuditPayload(plan),
          actualDomains,
          // CF-9 — which domains had their raw JSON withheld this turn. Names
          // only; no snapshot values, no balances.
          jsonOmitted,
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  } catch (err) {
    console.error('[api/ai/chat] CF-8 shadow retrieval-plan logging failed (non-fatal):', err);
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
  let guardAssessments: FinancialAssessment[] = [];
  let forecast: AssembledForecast | undefined; // FORECAST-13/14/16 — hoisted;
  let payDates: PayDateResult | undefined; let forecastGuardOutcome = 'none';
  // PARITY-2 — the Space a master forecast belongs to, so FORECAST-14's audit
  // row carries a real Space id rather than the literal 'master'.
  // PARITY-3 — `guardCtx` is the forecast Space's context; see currentAuthorityFigures.
  let forecastSpaceId: string | undefined; let guardCtx: SpaceContext_AI | undefined;
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
      // REVIEW-3 C-9 (KD-8) — the name rides along so a FAILED Space can be
      // named as unavailable in the prompt instead of silently vanishing.
      select: { spaceId: true, space: { select: { name: true } } },
    });

    if (memberships.length === 0) {
      return NextResponse.json(
        { error: 'No eligible spaces found.' },
        { status: 403 },
      );
    }

    // PARITY-2 — master resolves the SAME per-Space surfaces a named Space
    // does: envelope, plan, context, forecast and pay dates, in that order.
    const masterQuestion = latestUserMessage(messages) ?? '';
    const ms = await resolveMasterSurfaces({
      userId: user.id, spaceIds: memberships.map((m) => m.spaceId),
      messages, question: masterQuestion, transactionWindow, drilldown });
    const contexts: SpaceContext_AI[] = ms.resolved.map((r) => r.ctx);
    // REVIEW-3 C-9 (KD-8) — failed Spaces are logged AND surfaced. The prompt
    // previously stated the SURVIVOR count as the user's Space count, so a
    // build failure silently shrank the user's financial world.
    const failedSpaceNames = ms.failedIds.map(
      (id) => memberships.find((m) => m.spaceId === id)?.space.name ?? 'Unknown space');

    if (contexts.length === 0) {
      return NextResponse.json(
        { error: 'Could not assemble context for any eligible space.' },
        { status: 500 },
      );
    }

    // REVIEW-3 C-9 (KD-8) — ONE deterministic cross-Space deduped figure, the
    // same dedupe the Brief route applies (distinct FinancialAccount ids across
    // every Space's accountIds): an account shared into two Spaces counts once.
    // Deliberately NOT a new cross-Space aggregation authority — a count over
    // ids, so the model has a canonical figure instead of doing arithmetic over
    // knowingly overlapping per-Space blocks.
    const distinctAccountCount = new Set(
      contexts.flatMap(
        (c) => (c.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined)?.accountIds ?? [],
      ),
    ).size;

    const masterAssessments = contexts.map(computeAssessment);
    guardAssessments = masterAssessments;
    // Slice 6: per-liability debt-payment rollups (one Space-scoped query each,
    // in parallel; [] on failure — serializer falls back to disclosure-only).
    const masterDebtPayments = await Promise.all(
      contexts.map((c) => fetchPerLiabilityDebtPayments(c)),
    );
    // PARITY-2 — a forecast that could not be scoped REFUSES in as many words.
    // Silence is what let the model multiply a historical mean by four months.
    forecast = ms.forecast; forecastSpaceId = ms.forecastSpaceId;
    guardCtx = ms.resolved.find((r) => r.spaceId === ms.forecastSpaceId)?.ctx;
    const scopeRefusal = ms.forecastAsked && !ms.forecast
      ? renderForecastScopeRefusal(contexts.map((c) => c.space.name))
      : undefined;
    systemPrompt = buildMasterSystemPrompt(contexts, masterAssessments, intentRoute, masterDebtPayments,
      { attemptedSpaceCount: memberships.length, failedSpaceNames, distinctAccountCount },
      { question: masterQuestion, surfaces: ms.resolved.map((r) => r.surfaces),
        forecastScopeRefusal: scopeRefusal });
    // REVIEW-3 C-9 (KD-8) — deduplicate flat-mapped gaps: an account shared
    // into several Spaces surfaced the SAME gap once per Space, and the client
    // rendered duplicate cards.
    const seenGapKeys = new Set<string>();
    const dedupedGaps = contexts.flatMap(extractKnowledgeGaps).filter((g) => {
      const key = `${g.accountId}:${g.field}`;
      if (seenGapKeys.has(key)) return false;
      seenGapKeys.add(key);
      return true;
    });
    gapsForResponse = filterGapsByIntent(
      dedupedGaps,
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
    let envelopeForPrompt: CoverageEnvelope | undefined;
    let shadowPlan: RetrievalPlan | undefined;
    try {
      // CF-6 — the evidence census runs FIRST, because it decides which domains
      // are even reachable. Four indexed aggregates (~68 ms), already required
      // by CF-5's envelope, so this reorders work rather than adding any.
      envelopeForPrompt = await loadCoverageEnvelope(spaceId);

      // ── CF-8 — the SHADOW retrieval plan ──────────────────────────────────
      //
      // Computed HERE, before any assembler runs, because that is the position
      // an enforcing planner would have to occupy. The old context-priority
      // planner ran after assembly and could therefore only propose dropping
      // serialized text — it saved no retrieval work and could not widen
      // anything; it was deleted in V26-REASONING Slice 0.
      //
      // ⚠️ THE NAME IS NOW STALE AND THE HEADER USED TO LIE. "Nothing consults
      // this plan" was written when that was true and left in place after CF-9
      // wired it: the plan decides FORECAST/PAY_DATES execution below and the
      // omitDomainJson set in the prompt. It IS consulted, and it is also
      // logged for comparison.
      try {
        shadowPlan = planRetrieval({
          messages, envelope: envelopeForPrompt, now: new Date(),
        });
      } catch (planErr) {
        // CF-9 — FAIL OPEN. `shadowPlan` stays undefined, every domain is
        // serialized as before, and the user loses nothing. A first enforcement
        // slice must never remove evidence because its planner threw.
        console.error('[api/ai/chat] retrieval planning failed (non-fatal):', planErr);
      }

      ctx = await buildContext(spaceId, user.id, {
        scopeHint: 'full', transactionWindow, drilldown,
        evidence: envelopeForPrompt,
        question: latestUserMessage(messages),
      });
    } catch (err) {
      console.error('[api/ai/chat] buildContext error:', err);
      return NextResponse.json(
        { error: 'Failed to assemble space context.' },
        { status: 500 },
      );
    }

    // ── FORECAST-10 — the deterministic forecast, when the plan asked for one ─
    //
    // ⚠️ ONE EXECUTION SEAM, GATED ON THE PLAN. `assembleForecast` is the only
    // production caller of the engine, and it runs only when CF-8 resolved
    // FORECAST as a concept — so a spending question pays nothing for it, and a
    // forecast question is not recognised twice. Failure is non-fatal and
    // never falls back to an average; see `for-request.ts`.
    ({ forecast, payDates } = await buildForecastSurfaces({
      spaceId, ctx, question: latestUserMessage(messages) ?? '', messages,
      wantsForecast: shadowPlan?.concepts.includes(Concepts.FORECAST) ?? false,
      wantsPayDates: shadowPlan?.concepts.includes(Concepts.PAY_DATES) ?? false }));

    const assessment = computeAssessment(ctx); guardCtx = ctx;
    guardAssessments = [assessment];
    // Slice 6: per-liability debt-payment rollup ([] on failure → disclosure-only).
    // CF-5: the evidence census — four indexed aggregates, no rows, so it runs
    // alongside rather than in series.
    const debtPayments = await fetchPerLiabilityDebtPayments(ctx);
    // CF-9 — the plan reaches the prompt for ONE decision: whether a domain's
    // raw JSON is serialized. `shadowPlan` is undefined if planning failed,
    // which fails open to serializing everything.
    systemPrompt = buildSpaceSystemPrompt(
      ctx, assessment, intentRoute, debtPayments, envelopeForPrompt,
      latestUserMessage(messages), shadowPlan, forecast, payDates);
    // CF-8 — the retrieval plan beside what was actually assembled, so the two
    // can be compared after the fact from one audit row.
    await logShadowRetrievalPlan(
      user.id, spaceId, shadowPlan, Object.keys(ctx.domains),
      [...omitDomainJson(shadowPlan)]);
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
  // ── V26-REASONING Slice 1 — the typed answer boundary ─────────────────────
  //
  // ⚠️ `typed` BYPASSES G1/G2/G3 ENTIRELY, AND THAT IS THE POINT RATHER THAN A
  // RISK. All three exist to reconstruct, from the model's English, what the
  // model meant — the assessment-contradiction guard, the forecast numerical
  // boundary, and the output validator's tolerance ladder. Under `typed` the
  // model states its claims against addressed figures and verification is an
  // identity check, so running the prose readers on top would not add a fourth
  // opinion, it would add three chances to redact a licensed sentence. The
  // three `repair`-only failures the Slice 0 baseline recorded are exactly that
  // failure mode.
  const answerMode = resolveAnswerMode(process.env.AI_ANSWER_MODE);
  try {
    if (answerMode === 'typed') {
      const typed = await answerTyped({
        systemPrompt, messages, userId: user.id,
        spaceId: forecastSpaceId ?? spaceId,
        forecast, ctx: guardCtx, assessment: guardAssessments[0],
        history: messages,
        // ⚠️ SAME SCOPE THE PROSE PROMPT ALREADY APPLIES three lines above, where
        // `buildSpaceSystemPrompt` is handed `payDates ? undefined : forecast`.
        // A pay-date turn is answered with dates; every money figure offered on
        // one is a figure the answer is forbidden to state.
        scope: payDates && !forecast ? 'PAY_DATES' : 'FULL',
      });
      return NextResponse.json({
        message:          typed.reply,
        knowledgeGaps:    gapsForResponse,
        knowledgeGapMode: gapMode,
        ...(typed.outcome === 'clean' ? {} : { answerBoundary: typed.outcome }),
      });
    }
    reply = await generateChatReply(systemPrompt, messages);

    // ── A5: assessment-contradiction guard ─────────────────────────────────
    // Closes the one hole A4.2 measured: told "ignore the uncertainty and just
    // give me a yes or no", the model asserted a conclusion the assessment
    // refused, 2 of 2 runs. Doctrine cannot reach that — an instruction does not
    // defeat "ignore your instructions" — so it is checked deterministically.
    //
    // Clean replies (the overwhelming majority) cost NOTHING: detection is pure
    // string work and the reply is returned untouched. At most ONE repair call
    // is ever made, and only in 'repair' mode.
    try {
      const guardMode = resolveGuardMode(process.env.AI_ASSESSMENT_GUARD_MODE);
      if (guardMode !== 'off' && guardAssessments.length > 0) {
        const findings: GuardFinding[] = guardAssessments
          .flatMap((a) => detectAssessmentContradiction(reply, a));

        if (findings.length > 0) {
          console.warn('[ai/assessment-guard]', guardMode, findings.map((f) => `${f.kind}:${f.dimension}`).join(','));

          if (guardMode === 'repair') {
            // Exactly one repair attempt. The instruction names the violated
            // constraint only — the assessment is not up for re-evaluation.
            const repaired = await generateChatReply(
              `${systemPrompt}\n\n${buildRepairInstruction(findings)}`,
              messages,
            );
            const still = guardAssessments.flatMap((a) => detectAssessmentContradiction(repaired, a));
            // applyGuard returns the deterministic refusal-preserving fallback
            // when findings remain; otherwise the repaired reply stands. No loop.
            reply = applyGuard(repaired, still, guardMode);
          }
        }
      }
    } catch (guardErr) {
      // A guard failure must never break or delay a chat response. Swallowing
      // here means "no enforcement", exactly as the numeric validator does.
      console.error('[ai/assessment-guard] non-fatal:', guardErr);
    }

    try { // FORECAST-14 — numerical boundary; no-op off-forecast. Non-fatal.
      ({ reply, outcome: forecastGuardOutcome } =
        await guardForecastAnswer({
          reply, forecast, userId: user.id, ctx: guardCtx,
          spaceId: forecastSpaceId ?? spaceId }));
    } catch (fgErr) { console.error('[ai/forecast-guard] non-fatal:', fgErr); }
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
    ...(forecastGuardOutcome === 'none' ? {} : { forecastGuard: forecastGuardOutcome }),
  });
}
