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
 * { "message": "..." }
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
import { SpaceMemberRole }           from '@prisma/client';
import { buildContext }              from '@/lib/ai/context-builder';
import { generateChatReply }      from '@/lib/ai/provider';
import type { ChatMessage }        from '@/lib/ai/provider';
import type { SpaceContext_AI }    from '@/lib/ai/types';
import { displaySpaceName }        from '@/lib/format';

export const preferredRegion = 'sin1';
export const runtime         = 'nodejs';

// ── Permission constants ─────────────────────────────────────────────────────
// VIEWER is explicitly excluded from AI chat — same rule as the Daily Brief.

const ELIGIBLE_ROLES: SpaceMemberRole[] = [
  SpaceMemberRole.OWNER,
  SpaceMemberRole.ADMIN,
  SpaceMemberRole.MEMBER,
];

// ── System prompt builder ────────────────────────────────────────────────────

/**
 * Serialize a single SpaceContext_AI into a compact text block.
 * Domain data is rendered as compact JSON; signals as a structured list.
 * The prompt explicitly constrains the model to this data only.
 */
function serializeContextBlock(ctx: SpaceContext_AI): string {
  const lines: string[] = [];

  lines.push(`Space: ${displaySpaceName(ctx.space.name)}`);
  lines.push(`Your role: ${ctx.role}`);
  lines.push('');

  // ── Domains ───────────────────────────────────────────────────────────────
  const domainKeys = Object.keys(ctx.domains);
  if (domainKeys.length > 0) {
    lines.push('Financial context:');
    for (const key of domainKeys) {
      const section = ctx.domains[key];
      if (section?.data) {
        lines.push(`  [${key}]`);
        lines.push(`  ${JSON.stringify(section.data)}`);
      }
    }
  } else {
    lines.push('Financial context: none assembled for this Space.');
  }

  lines.push('');

  // ── Signals ───────────────────────────────────────────────────────────────
  if (ctx.signals.length > 0) {
    lines.push('Active signals:');
    for (const sig of ctx.signals) {
      const detail = sig.body ? ` — ${sig.body}` : '';
      lines.push(`  [${sig.severity.toUpperCase()}] ${sig.title}${detail}`);
    }
  } else {
    lines.push('Active signals: none.');
  }

  return lines.join('\n');
}

/**
 * Build the full system prompt for a single-Space chat session.
 */
function buildSpaceSystemPrompt(ctx: SpaceContext_AI): string {
  return [
    'You are the Fourth Meridian AI advisor for the space described below.',
    'Answer questions using ONLY the supplied financial context.',
    'Never invent accounts, balances, transactions, or any financial data.',
    'If the context is insufficient to answer, say so clearly.',
    'Do not claim to execute actions, make trades, or modify any data.',
    '',
    'Response style:',
    '- Be conversational and direct. Lead with your answer in 1–2 sentences.',
    '- Mention only the 2–4 numbers most relevant to the question.',
    '- Use short paragraphs. Use a compact bullet list only when comparing 3+ items or when the user explicitly asks for a list.',
    '- Do not enumerate every field in the context. Synthesize; do not dump data.',
    '- Never expose internal field names, type codes, or category labels in your reply.',
    '',
    '=== SPACE CONTEXT ===',
    serializeContextBlock(ctx),
    '=== END CONTEXT ===',
  ].join('\n');
}

/**
 * Build the full system prompt for master (cross-Space) chat.
 * Each Space gets its own clearly delimited block to prevent cross-leakage.
 */
function buildMasterSystemPrompt(contexts: SpaceContext_AI[]): string {
  const spaceBlocks = contexts
    .map((ctx, i) =>
      [
        `--- Space ${i + 1} of ${contexts.length} ---`,
        serializeContextBlock(ctx),
      ].join('\n'),
    )
    .join('\n\n');

  return [
    'You are the Fourth Meridian Master AI advisor.',
    `You have been provided context for ${contexts.length} space(s) the user belongs to.`,
    'Answer questions using ONLY the supplied financial context.',
    'Never invent accounts, balances, transactions, or any financial data.',
    'If the context is insufficient to answer, say so clearly.',
    'Do not claim to execute actions, make trades, or modify any data.',
    'When referencing data, attribute it to the correct space by name.',
    '',
    'Response style:',
    '- Be conversational and direct. Lead with your answer in 1–2 sentences.',
    '- Mention only the 2–4 numbers most relevant to the question.',
    '- Use short paragraphs. Use a compact bullet list only when comparing 3+ items or when the user explicitly asks for a list.',
    '- Do not enumerate every field in the context. Synthesize; do not dump data.',
    '- Never expose internal field names, type codes, or category labels in your reply.',
    '',
    '=== SPACE CONTEXTS ===',
    spaceBlocks,
    '=== END CONTEXTS ===',
  ].join('\n');
}

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

  // Must have at least one user message
  if (!messages.some((m) => m.role === 'user')) {
    return NextResponse.json(
      { error: 'messages must contain at least one user turn.' },
      { status: 400 },
    );
  }

  let systemPrompt: string;

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
        buildContext(m.spaceId, user.id, { scopeHint: 'full' }),
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

    systemPrompt = buildMasterSystemPrompt(contexts);

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
      ctx = await buildContext(spaceId, user.id, { scopeHint: 'full' });
    } catch (err) {
      console.error('[api/ai/chat] buildContext error:', err);
      return NextResponse.json(
        { error: 'Failed to assemble space context.' },
        { status: 500 },
      );
    }

    systemPrompt = buildSpaceSystemPrompt(ctx);
  }

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

  return NextResponse.json({ message: reply });
}
