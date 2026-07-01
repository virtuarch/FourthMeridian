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
 * { "message": "...", "knowledgeGaps": [...] }
 * knowledgeGaps mirrors the KnowledgeGap[] assembled at context time so the
 * client can render structured input cards without parsing the assistant text.
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
import type { SpaceContext_AI, KnowledgeGap } from '@/lib/ai/types';
import { displaySpaceName }        from '@/lib/format';
import { computeAssessment }        from '@/lib/ai/intelligence';
import type { FinancialAssessment }  from '@/lib/ai/intelligence';

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

/** Returns today's date as a UTC ISO date string (YYYY-MM-DD). Computed per-request. */
function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

// Maps KnowledgeGap.field to a short phrase explaining its calculation impact.
// Used in the serialized gaps section so the AI understands why each field matters
// without needing to infer it from the field name alone.
const GAP_IMPACT: Record<string, string> = {
  apr:            'affects payoff calculations and interest cost',
  minimumPayment: 'affects payoff timeline',
};

/**
 * Extract knowledge gaps from the assembled accounts domain, if present.
 * Returns an empty array when the accounts domain is absent or has no gaps.
 * Type-narrows via a minimal structural check to avoid importing AccountsSectionData.
 */
function extractKnowledgeGaps(ctx: SpaceContext_AI): KnowledgeGap[] {
  const section = ctx.domains['accounts'];
  if (!section?.data) return [];
  const data = section.data as { knowledgeGaps?: KnowledgeGap[] };
  return Array.isArray(data.knowledgeGaps) ? data.knowledgeGaps : [];
}

/**
 * Serialize a single SpaceContext_AI into a compact text block.
 * Domain data is rendered as compact JSON; signals as a structured list;
 * knowledge gaps as a human-readable list with impact annotations.
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

  // ── Knowledge gaps ────────────────────────────────────────────────────────
  // Surfaced as a human-readable list so the AI can reference them by account
  // name and field label without parsing the raw accounts JSON blob.
  // Only populated for FULL-visibility debt accounts (enforced by the assembler).
  const gaps = extractKnowledgeGaps(ctx);
  if (gaps.length > 0) {
    lines.push('');
    lines.push('Knowledge gaps (missing verified metadata — do not invent these values):');
    for (const gap of gaps) {
      const impact = GAP_IMPACT[gap.field] ?? 'affects related calculations';
      lines.push(`  [${gap.accountName}] ${gap.label} not set — ${impact}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the full system prompt for a single-Space chat session.
 */

// ── Advisor reasoning principles ──────────────────────────────────────────────
// Establishes the reasoning mode before any formatting rules.
// Injected into every system prompt.

const ADVISOR_PRINCIPLES = [
  'Reasoning approach — think like a financial advisor, not a reporting tool:',
  '- Synthesize first. Open with a 1–2 sentence overall assessment or conclusion, then support it with data.',
  '- Lead with what matters most: the biggest risk, the clearest opportunity, or the most urgent observation.',
  '- Explain causal relationships when they exist. If high debt payments drove negative cash flow, say so directly. Do not list the components in isolation.',
  '- Identify the likely cause of a notable pattern when the data supports it.',
  '- Give a concrete recommendation when one is clearly supported by the data.',
  '- Reference only the numbers that substantiate your reasoning. Never enumerate every metric in context.',
  '- When a signal is high-severity or the magnitude is large, prioritize it in your response.',
  '- Be direct. Hedge only when the data is genuinely ambiguous.',
  '',
  'Temporal doctrine — current state vs. history:',
  '- When the user asks about their current position (debt situation, net worth, balances, liquidity, goals progress): lead with current values from the accounts and goals domains. Transaction summaries are supporting evidence, not the primary answer.',
  '- Never open a current-state answer primarily with 30- or 90-day aggregates. Historical data belongs after the current-state assessment, or when the user explicitly asks about history.',
  '- Switch to history-first framing only when the user uses past-tense language or references a time period ("last month", "over 90 days", "historically", "what did I spend").',
  '',
  'Debt payment doctrine:',
  '- The debtPaymentTotal field represents intentional debt reduction, not a consumption expense. It is capital directed toward a financial goal.',
  '- When cash flow is negative and debt payments are a primary driver: say so plainly. Cross-reference any debt-reduction goals to confirm it is the user\'s strategy, not a problem.',
  '- Do not label high debt payments as overspending. Only flag a spending problem when expenses excluding debt payments are themselves high relative to income.',
  '',
  'Financial Assessment doctrine:',
  '- The === FINANCIAL ASSESSMENT === block above the space context contains deterministic pre-computed findings. Read it before drawing any conclusions from the raw context data.',
  '- When incomeConfidence is LOW or cashFlowReliability is UNRELIABLE: do not state that expenses exceed income, do not declare cash flow negative as a fact, and do not project deficit timelines from the income figure. Instead, note that transaction history appears incomplete and suggest the user connect all income accounts.',
  '- Account balances, debt balances, and liquid cash totals are always reliable regardless of income confidence — use them confidently even when DATA_QUALITY is the current priority.',
  '- Lead with the currentStatePriority topic when the user asks an open-ended financial question.',
].join('\n');

// ── Shared response-style rules ───────────────────────────────────────────────
// Covers formatting and presentation. Injected after ADVISOR_PRINCIPLES.

const RESPONSE_STYLE = [
  'Response style:',
  '- Short paragraphs. Use a compact bullet list only when comparing 3+ items or when the user explicitly asks for a list.',
  '- Never expose internal field names, type codes, or category labels.',
  '- Do not enumerate every field in the context.',
  '',
  'Formatting:',
  '- Responses are rendered as Markdown. Use formatting where it improves clarity.',
  '- Produce a Markdown table when the user explicitly requests a table, comparison, schedule, breakdown, matrix, checklist, or plan.',
  '- When a calculation requires a field listed in Knowledge Gaps, provide the best answer with available data, explain what the gap prevents, and ask for the missing value. Do not refuse the calculation.',
  '- For general questions, prose is preferred over tables.',
].join('\n');

// ── Knowledge Gaps rules ──────────────────────────────────────────────────────
// Injected into every system prompt alongside RESPONSE_STYLE.
// Explains gap semantics and governs how the AI handles user-supplied values.

const KNOWLEDGE_GAPS_RULES = [
  'Knowledge Gaps rules:',
  '- Gaps list fields the user has not yet entered in Fourth Meridian. They are authoritative — the value is genuinely unknown.',
  '- Never invent, estimate, or assume a gap value. If you use an industry assumption, say so explicitly and label the result approximate.',
  '- When a gap field is needed: explain what is missing and why it matters, deliver the best answer with available data, and ask for the value naturally.',
  '- If the user provides a gap value during this conversation: confirm you are using it, and explicitly state it has NOT been saved. Example: "I\'ll use 24.99% for this conversation — this isn\'t saved yet, so tell Fourth Meridian when you\'re ready."',
  '- Never claim to save, remember, or persist a user-supplied value across sessions.',
  '- When a user wants to save or update a value such as APR, minimum payment, due day, or statement close day: tell them the form below this message saves it directly to their account. Their next message will automatically use the updated value.',
  '- You do not write data directly. Directing the user to the save form is a supported action — it is not a data modification by you.',
].join('\n');

/**
 * Alias guidance for a single-Space session.
 * Tells the AI that informal terms like "personal", "my finances", "dashboard"
 * refer to the named space, so the user is never required to use the exact name.
 */
function buildSpaceAliasGuidance(spaceName: string): string {
  return (
    `Space alias guidance: The user may refer to this space as "${spaceName}", ` +
    'or by informal terms such as "personal", "personal space", "home", "dashboard", ' +
    '"my finances", "my money", or similar. Interpret these as references to the ' +
    'current space unless context clearly indicates otherwise.'
  );
}

// ── Financial Assessment serialization ────────────────────────────────────────

/** Format a number as a USD money string (e.g. $4,320.00). */
function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Return a one-sentence LLM instruction based on the current priority. */
function priorityGuidance(assessment: FinancialAssessment): string {
  switch (assessment.currentStatePriority) {
    case 'DATA_QUALITY':
      return 'Note that transaction history is partial. Describe balances, liquidity, and debt figures confidently. Do not make income or cash flow statements.';
    case 'LIQUIDITY':
      return assessment.liquidity.classification === 'CRITICAL'
        ? 'Liquidity is critically low — lead with the coverage gap and near-term implications.'
        : 'Lead with the liquidity position and what it means for the user\'s financial flexibility.';
    case 'DEBT':
      return assessment.debt.classification === 'CRITICAL'
        ? 'High-APR debt is urgent — lead with the monthly interest cost and recommended payoff priority.'
        : 'High-APR debt is the most actionable item — discuss the interest burden and payoff options.';
    case 'CASH_FLOW':
      return (
        assessment.cashFlow.deficitCause === 'INTENTIONAL_DEBT_PAYOFF' ||
        assessment.cashFlow.deficitCause === 'MIXED'
      )
        ? 'Affirm the intentional debt payoff strategy. Note any liquidity constraint if coverage is below 3 months.'
        : 'Spending may be exceeding income — identify the specific expense categories driving the gap.';
    case 'GOALS':
      return 'A goal may need attention — discuss its status and recommend the next action.';
    case 'GOALS_GOOD':
      return 'Financial position looks healthy — affirm progress and highlight the next milestone.';
    default:
      return 'Provide an overall financial assessment.';
  }
}

/**
 * Serialize a FinancialAssessment into the === FINANCIAL ASSESSMENT === prompt block.
 *
 * v2 structure (order is deliberate):
 *   1. INTERPRETED STATE — priority + leading instruction, so LLM reads intent first.
 *   2. DATA QUALITY      — completeness + confidence before any numbers.
 *   3. CASH FLOW         — confidence + warnings before deficit framing.
 *   4. DEBT              — confidence + balances + APR state.
 *   5. LIQUIDITY         — confidence + coverage + space-scope warning.
 *   6. ADVISOR FLAGS     — typed heuristics for calibration.
 *   7. PRIORITIES        — ranked deterministic hints (not recommendations).
 */
function serializeAssessmentBlock(assessment: FinancialAssessment): string {
  const { dataQuality, cashFlow, debt, liquidity } = assessment;
  const lines: string[] = [];

  // ── 1. Interpreted state ──────────────────────────────────────────────────
  lines.push(`INTERPRETED STATE: ${assessment.currentStatePriority}`);
  lines.push(`  ${priorityGuidance(assessment)}`);
  lines.push('');

  // ── 2. Data quality ───────────────────────────────────────────────────────
  lines.push('DATA QUALITY');
  lines.push(
    `  Transaction completeness: ${dataQuality.transactionHistoryCompleteness}` +
    ` (${dataQuality.snapshotSpanDays}-day history in 90-day window;` +
    ` ${dataQuality.incomeTransactionCount} income transaction(s) captured)`,
  );
  lines.push(`  Income confidence: ${dataQuality.incomeConfidence}`);

  if (dataQuality.incomeConfidence === 'LOW') {
    lines.push('  ⚠ Income data is incomplete. Do not state cash flow is negative or income is insufficient as fact.');
    lines.push('    Account balances, debt balances, and liquid cash are always reliable — use them confidently.');
    lines.push('    Suggest the user connect all income accounts for a complete picture.');
  }

  lines.push('');

  // ── 3. Cash flow ──────────────────────────────────────────────────────────
  lines.push(`CASH FLOW  [confidence: ${cashFlow.confidence}]`);
  lines.push(`  Reliability: ${cashFlow.reliability}`);
  lines.push(`  Deficit cause: ${cashFlow.deficitCause}`);

  if (cashFlow.incompleteIncomeWarning) {
    lines.push('  ⚠ Do not treat apparent deficit as fact — income history is incomplete.');
  } else if (cashFlow.deficitCause === 'INTENTIONAL_DEBT_PAYOFF') {
    lines.push('  → Negative cash flow is intentional debt-reduction strategy — active debt goal confirms this.');
  } else if (cashFlow.deficitCause === 'MIXED') {
    lines.push('  → Deficit has both intentional debt payments and non-debt spending above income.');
  }

  if (cashFlow.impliedMonthlyIncome !== null) {
    const qualifier = dataQuality.incomeConfidence === 'LOW' ? ' (likely understated — partial data)' : '';
    lines.push(`  Implied monthly income: ${fmtMoney(cashFlow.impliedMonthlyIncome)}/mo${qualifier}`);
  }
  if (cashFlow.estimatedMonthlyExpenses !== null) {
    lines.push(`  Est. monthly expenses: ${fmtMoney(cashFlow.estimatedMonthlyExpenses)}/mo`);
  }
  if (cashFlow.estimatedMonthlyDebtPayments !== null) {
    lines.push(`  Est. monthly debt payments: ${fmtMoney(cashFlow.estimatedMonthlyDebtPayments)}/mo`);
  }

  lines.push('');

  // ── 4. Debt ───────────────────────────────────────────────────────────────
  lines.push(`DEBT  [confidence: ${debt.confidence}]`);
  lines.push(`  Classification: ${debt.classification}`);
  lines.push(`  Total liabilities: ${fmtMoney(debt.totalLiabilities)}`);

  if (debt.classification === 'INSUFFICIENT_DATA') {
    lines.push(`  APR completeness: ${debt.aprCompleteness}`);
    if (debt.aprGapAccountNames.length > 0) {
      lines.push(
        `  APR not entered for: ${debt.aprGapAccountNames.join(', ')} — ` +
        'enter in Fourth Meridian to enable full interest analysis.',
      );
    }
    if (debt.hasBalanceOnlyDebt) {
      lines.push(
        '  Some debt accounts are at balance-only visibility — APR is not accessible ' +
        'in this Space (structural limitation, not missing user input).',
      );
    }
  }

  if (debt.monthlyInterestBurden !== null) {
    const partial = debt.hasNullAPR ? ' (partial — APR missing for some accounts)' : '';
    lines.push(`  Monthly interest burden: ${fmtMoney(debt.monthlyInterestBurden)}/mo${partial}`);
  } else if (debt.hasNullAPR && debt.totalLiabilities > 0) {
    lines.push('  Monthly interest burden: cannot be computed — APR missing.');
  }

  lines.push('');

  // ── 5. Liquidity ──────────────────────────────────────────────────────────
  lines.push(`LIQUIDITY  [confidence: ${liquidity.confidence}]`);

  if (!liquidity.hasAccountsDomain) {
    lines.push('  No accounts are linked to this Space — balance data is unavailable.');
  } else {
    lines.push(`  Liquid cash: ${fmtMoney(liquidity.liquidCashTotal)} (${liquidity.liquidAccountCount} account(s))`);

    if (liquidity.noLiquidAccountsInSpace) {
      lines.push(
        '  ⚠ No checking or savings accounts are linked to this Space.' +
        ' Liquid balances may exist in other Spaces. Do not say the user has no liquid cash.',
      );
    }

    if (liquidity.estimatedMonthlyExpense !== null) {
      const partial = dataQuality.snapshotSpanDays < SNAPSHOT_HIGH_THRESHOLD_NOTE
        ? ' (from partial expense data)'
        : '';
      lines.push(`  Est. monthly expenses: ${fmtMoney(liquidity.estimatedMonthlyExpense)}/mo${partial}`);
    }

    if (liquidity.coverageMonths !== null) {
      lines.push(`  Coverage: ${liquidity.coverageMonths.toFixed(1)} months → ${liquidity.classification}`);
    } else {
      lines.push(`  Coverage: ${liquidity.classification}`);
    }
  }

  lines.push('');

  // ── 6. Advisor flags ──────────────────────────────────────────────────────
  if (assessment.advisorHeuristics.length > 0) {
    lines.push('ADVISOR FLAGS (deterministic — calibrate advice accordingly)');
    for (const flag of assessment.advisorHeuristics) {
      lines.push(`  • ${flag}`);
    }
    lines.push('');
  }

  // ── 7. Priorities ─────────────────────────────────────────────────────────
  if (assessment.priorities.length > 0) {
    lines.push('PRIORITIES (ranked hints — not recommendations; LLM decides how to apply)');
    assessment.priorities.forEach((p, i) => {
      lines.push(`  ${i + 1}. [${p.severity.toUpperCase()}] ${p.code}: ${p.reason}`);
    });
  }

  return lines.join('\n');
}

// Threshold used in assessment block to annotate partial expense data.
// Matches SNAPSHOT_HIGH_THRESHOLD from annotations.ts — defined here to avoid
// a cross-module constant import for a formatting-only concern.
const SNAPSHOT_HIGH_THRESHOLD_NOTE = 45;

function buildSpaceSystemPrompt(ctx: SpaceContext_AI, annotations: FinancialAssessment): string {
  return [
    'You are a skilled, direct financial advisor powered by Fourth Meridian.',
    'You advise on the space described below.',
    `Today's date: ${todayDateString()}.`,
    'Answer using ONLY the supplied financial context.',
    'Never invent accounts, balances, transactions, or any financial data.',
    'If the context is insufficient, explain what is missing and why.',
    'Do not claim to execute trades, rebalance portfolios, or modify accounts or transaction records.',
    'Saving debt metadata (APR, minimum payment, due day, statement close day) is a supported user action via the form below your message — direct users there when they want to save those values.',
    '',
    ADVISOR_PRINCIPLES,
    '',
    RESPONSE_STYLE,
    '',
    KNOWLEDGE_GAPS_RULES,
    '',
    buildSpaceAliasGuidance(displaySpaceName(ctx.space.name)),
    '',
    '=== FINANCIAL ASSESSMENT ===',
    serializeAssessmentBlock(annotations),
    '=== END ASSESSMENT ===',
    '',
    '=== SPACE CONTEXT ===',
    serializeContextBlock(ctx),
    '=== END CONTEXT ===',
  ].join('\n');
}

/**
 * Alias guidance for master (cross-Space) sessions.
 * Lists all space names and instructs the AI to map informal references
 * to the most likely space without requiring exact name matches.
 */
function buildMasterAliasGuidance(contexts: SpaceContext_AI[]): string {
  const names = contexts
    .map((ctx) => `"${displaySpaceName(ctx.space.name)}"`)
    .join(', ');
  return (
    `Space alias guidance: The user has access to these spaces: ${names}. ` +
    'Informal terms like "personal", "personal space", "home", "dashboard", ' +
    '"my finances", or "my money" typically refer to a personal or primary space. ' +
    'When the user\'s intent is ambiguous across spaces, use the most relevant ' +
    'space\'s data or ask which space they mean.'
  );
}

/**
 * Build the full system prompt for master (cross-Space) chat.
 * Each Space gets its own clearly delimited block to prevent cross-leakage.
 */
function buildMasterSystemPrompt(contexts: SpaceContext_AI[], annotationsList: FinancialAssessment[]): string {
  const spaceBlocks = contexts
    .map((ctx, i) => {
      const assessment = annotationsList[i];
      return [
        `--- Space ${i + 1} of ${contexts.length} ---`,
        '=== FINANCIAL ASSESSMENT ===',
        assessment ? serializeAssessmentBlock(assessment) : '(no assessment available)',
        '=== END ASSESSMENT ===',
        serializeContextBlock(ctx),
      ].join('\n');
    })
    .join('\n\n');

  return [
    'You are a skilled, direct financial advisor powered by Fourth Meridian.',
    `You have context for ${contexts.length} space(s) the user belongs to.`,
    `Today's date: ${todayDateString()}.`,
    'Answer using ONLY the supplied financial context.',
    'Never invent accounts, balances, transactions, or any financial data.',
    'If the context is insufficient, explain what is missing and why.',
    'Do not claim to execute trades, rebalance portfolios, or modify accounts or transaction records.',
    'Saving debt metadata (APR, minimum payment, due day, statement close day) is a supported user action via the form below your message — direct users there when they want to save those values.',
    'When referencing data, attribute it to the correct space by name.',
    '',
    ADVISOR_PRINCIPLES,
    '',
    RESPONSE_STYLE,
    '',
    KNOWLEDGE_GAPS_RULES,
    '',
    buildMasterAliasGuidance(contexts),
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
  // Knowledge gaps assembled at context time — returned alongside the reply so
  // the client can render structured input UI without parsing assistant text.
  let gapsForResponse: KnowledgeGap[] = [];

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

    systemPrompt = buildMasterSystemPrompt(contexts, contexts.map(computeAssessment));
    gapsForResponse = contexts.flatMap(extractKnowledgeGaps);

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

    systemPrompt = buildSpaceSystemPrompt(ctx, computeAssessment(ctx));
    gapsForResponse = extractKnowledgeGaps(ctx);
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

  return NextResponse.json({ message: reply, knowledgeGaps: gapsForResponse });
}
