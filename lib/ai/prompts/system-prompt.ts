/**
 * lib/ai/prompts/system-prompt.ts
 *
 * Composes the full grounded system prompt for space and master (cross-Space)
 * chat sessions. Pure functions: assembled context(s) + assessment(s) + intent
 * route in, prompt string out. All doctrine, routing, assessment, and context
 * serialization are delegated to the focused modules below — this file only
 * orders the sections and adds the header. No DB, no LLM, no computation.
 *
 * Extracted verbatim from app/api/ai/chat/route.ts (AI-ARCH).
 */

import type { SpaceContext_AI, AccountsSectionData } from '@/lib/ai/types';
import { FinanceDomains } from '@/lib/ai/types';
import type { FinancialAssessment } from '@/lib/ai/intelligence';
import type { IntentRoute } from '@/lib/ai/intent';
import { serializeRoutingBlock } from '@/lib/ai/intent';
import { displaySpaceName } from '@/lib/format';
import { todayUTCISO } from '@/lib/time/clock';
import {
  AUTHORITY_PRECEDENCE,
  ADVISOR_PRINCIPLES,
  RESPONSE_STYLE,
  KNOWLEDGE_GAPS_RULES,
  EXECUTIVE_SUMMARY_DOCTRINE,
  EXPLAINABILITY_DOCTRINE,
  FORECAST_DOCTRINE,
} from './doctrine';
import { analysisWindowNote, temporalScopeFor, getTransactionsSummary } from './format';
import {
  describeCoverageEnvelope, type CoverageEnvelope,
} from '@/lib/ai/coverage-envelope';
import {
  composeInvestments, describeInvestmentConcept, resolveConceptBreadth, ConceptBreadth,
} from '@/lib/ai/economic-concepts';
import { NeedLevel, type RetrievalPlan } from '@/lib/ai/retrieval-plan';
import { renderForecastSection } from '@/lib/ai/forecast/render';
import type { AssembledForecast } from '@/lib/ai/forecast/assemble';
import { renderPayDates } from '@/lib/ai/forecast/pay-dates';
import type { PayDateResult } from '@/lib/ai/forecast/pay-dates';
import { serializeAssessmentBlock } from './assessment-serializer';
import { serializeContextBlock } from './context-serializer';
import type { DebtPaymentLine } from './context-serializer';

/** Today's UTC calendar day, from THE one clock (REVIEW-3 B-6 — lib/time).
 *  Computed per-request. This was one of the two recorded lib/ai inline day
 *  derivations; the clock-authority guard now scans lib/ai like everything else. */
function todayDateString(): string {
  return todayUTCISO();
}

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


/**
 * CF-7 — the INVESTMENTS composition, for questions that ask about it.
 *
 * The breadth comes from the same resolver CF-6 used to decide retrieval, so
 * what was loaded and what is composed can never disagree about the question.
 */
function renderConcepts(ctx: SpaceContext_AI, question: string | undefined): string[] {
  const breadth = resolveConceptBreadth(question);
  if (breadth === ConceptBreadth.NONE) return [];
  const accounts = ctx.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData | undefined;
  const lines = describeInvestmentConcept(composeInvestments(accounts ?? null), breadth);
  if (lines.length === 0) return [];
  return ['=== INVESTMENT COMPOSITION ===', ...lines, '=== END INVESTMENT COMPOSITION ===', ''];
}


/**
 * CF-11 — should the transaction ANALYSIS sections be omitted?
 *
 * The rule is exactly `need === NOT_NEEDED`, and nothing weaker. SUPPORTING is
 * evidence the plan wants; treating it as optional would let token pressure
 * narrow a broad overview, which is the failure this whole programme has been
 * avoiding one slice at a time.
 *
 * Fails OPEN: no plan, no decision, an unexpected value ⇒ render everything.
 */
export function omitTransactionAnalysis(plan?: RetrievalPlan): boolean {
  if (!plan) return false;
  const d = plan.domains.find((x) => x.domain === FinanceDomains.TRANSACTIONS_SUMMARY);
  return d?.need === NeedLevel.NOT_NEEDED;
}


/**
 * CF-9/CF-10 — which domains' raw JSON to leave out, from the retrieval plan.
 *
 * Two domains, and only when the plan says the model does not need them.
 * `accounts` and `holdings_summary` are deliberately absent: accounts is
 * required by every one of CF-8's nineteen scenarios, and holdings is already
 * conditional at the DOMAIN level (CF-6), so neither is a candidate here.
 *
 * ⚠️ The snapshot boundary does NOT generalise. Snapshots have no prose at all,
 * so omitting the dump removes the domain from the prompt; transactions carry
 * 2,039 tokens of prose that is a different consumer class (MODEL_SUMMARY) and
 * holds the CF-1 bounded disclosures and the CF-2/3/4 scope framing. So this
 * removes the RAW PAYLOAD only.
 *
 * (CF-10 reported that prose as 5,027 tokens and larger than the payload. That
 * measurement was wrong — the probe's `indexOf` matched the doctrine
 * preamble's mention of the section title. The real figure is 2,039, of which
 * 1,512 is the conditional ANALYSIS pool CF-11 removes. The decision stands on
 * the consumer-class argument, which never depended on the sizes.)
 *
 * Fails OPEN in every uncertain case — no plan, no decision, an unexpected
 * value — because removing evidence on a planner error is worse than the tokens
 * it would save.
 */
const CONDITIONAL_JSON_DOMAINS: ReadonlySet<string> = new Set([
  FinanceDomains.SNAPSHOT_HISTORY,
  FinanceDomains.TRANSACTIONS_SUMMARY,
]);

export function omitDomainJson(plan?: RetrievalPlan): ReadonlySet<string> {
  if (!plan) return new Set();
  const omit = new Set<string>();
  for (const d of plan.domains) {
    if (!CONDITIONAL_JSON_DOMAINS.has(d.domain)) continue;
    if (d.need === NeedLevel.NOT_NEEDED) omit.add(d.domain);
  }
  return omit;
}


/**
 * CF-5 — the envelope block, paired with what THIS turn loaded.
 *
 * The loaded interval comes from the assembled context rather than from the
 * caller, so the two halves cannot disagree: whatever the assembler actually
 * summarised is what gets named as loaded.
 */
function renderEnvelope(ctx: SpaceContext_AI, envelope?: CoverageEnvelope): string[] {
  if (!envelope) return [];
  const txn = getTransactionsSummary(ctx);
  const loaded = txn?.startDate && txn?.endDate
    ? { fromISO: txn.startDate, toISO: txn.endDate }
    : null;
  const lines = describeCoverageEnvelope(envelope, loaded);
  if (lines.length === 0) return [];
  return ['=== AVAILABLE EVIDENCE ===', ...lines, '=== END AVAILABLE EVIDENCE ===', ''];
}

/**
 * FORECAST-11A — should the historical spending mean be withheld entirely?
 *
 * ⚠️ ONE DECISION, REUSED. "Is this a historical question?" is already answered
 * by the retrieval plan: FORECAST-10 marks the transaction rollups NOT_NEEDED
 * for a forecast-only question and REQUIRED the moment the question also asks
 * about the past. Deriving the same thing a second way here would eventually
 * disagree with the first, and the disagreement would show up as a prompt that
 * withholds the mean while displaying the rollups it came from.
 *
 * Fails OPEN: no plan, no forecast, or an unexpected value ⇒ the figure stays.
 */
export function suppressHistoricalSpending(
  plan: RetrievalPlan | undefined, forecastPresent: boolean,
): boolean {
  if (!plan || !forecastPresent) return false;
  const txn = plan.domains.find((d) => d.domain === FinanceDomains.TRANSACTIONS_SUMMARY);
  return txn?.need === NeedLevel.NOT_NEEDED;
}

export function buildSpaceSystemPrompt(
  ctx: SpaceContext_AI,
  annotations: FinancialAssessment,
  route: IntentRoute,
  debtPayments?: DebtPaymentLine[],
  /**
   * CF-5 — what evidence EXISTS, as distinct from what was assembled below.
   * Optional: a census failure, or a caller that has none, costs the user
   * nothing and simply omits the block.
   */
  envelope?: CoverageEnvelope,
  /**
   * CF-7 — the user's message, as the CONCEPT-BREADTH signal.
   *
   * The same string CF-6 used to decide retrieval, so what was loaded and what
   * is composed can never disagree about the question being answered.
   */
  question?: string,
  /**
   * CF-9 — the CF-8 shadow retrieval plan. Used for ONE decision: whether a
   * domain's raw JSON is serialized. Absent ⇒ everything is serialized.
   */
  plan?: RetrievalPlan,
  /**
   * FORECAST-10 — the deterministic forecast, when the question asked for one.
   *
   * ⚠️ ALREADY COMPUTED. This carries a `CashForecast` the engine produced;
   * nothing in the prompt layer runs arithmetic over it, and its absence simply
   * omits the section. A forecast that could not be ASSEMBLED still arrives
   * here — as an unavailability, which is a result — because failing open to a
   * prompt with no forecast section is how a model starts estimating one.
   */
  forecast?: AssembledForecast,
  /**
   * FORECAST-16 — licensed pay dates, when the question asked for them.
   *
   * ⚠️ MUTUALLY EXCLUSIVE WITH `forecast` IN PRACTICE. A pay-date question does
   * not resolve FORECAST, so the two sections never both appear; the capability
   * answers itself rather than arriving as a fragment of a refused forecast.
   */
  payDates?: PayDateResult,
): string {
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
    // A3 — the precedence contract frames every rule that follows it.
    AUTHORITY_PRECEDENCE,
    '',
    ADVISOR_PRINCIPLES,
    '',
    RESPONSE_STYLE,
    '',
    KNOWLEDGE_GAPS_RULES,
    '',
    buildSpaceAliasGuidance(displaySpaceName(ctx.space.name)),
    '',
    EXECUTIVE_SUMMARY_DOCTRINE,
    '',
    EXPLAINABILITY_DOCTRINE,
    '',
    '=== QUESTION ROUTING ===',
    serializeRoutingBlock(route, plan?.concepts),
    '=== END ROUTING ===',
    '',
    // PARITY-2 — the SHARED per-Space body. Identical text in master mode, so
    // a capability cannot reach one entry point and not the other.
    ...renderSpaceEvidenceBody(ctx, annotations, route, question,
      { envelope, plan, debtPayments, forecast, payDates }),
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
/**
 * REVIEW-3 C-9 (KD-8) — the master roll-up facts the route computed:
 * attempted-vs-succeeded Space coverage, the failed Spaces by name, and the ONE
 * deterministic cross-Space deduped figure (distinct connected accounts — the
 * same dedupe the Brief route applies). Optional so existing fixture callers
 * keep the prior prompt shape.
 */
/**
 * PARITY-1 — the question-scoped capability surfaces, for MASTER sessions.
 *
 * ⚠️ MASTER IS THE DEFAULT ENTRY, AND IT HAD NONE OF THIS. `AnalyzeClient`
 * opens on `spaceId: 'master'`, so the ordinary first question a user asks goes
 * through `buildMasterSystemPrompt` — which took no question at all. Every
 * question-scoped capability the CF and FORECAST slices built therefore existed
 * only on a path most turns never reached: CF-7's investment composition was
 * absent, so "how much do I have in investments?" was answered from the raw
 * `totalInvestments` scalar in the accounts payload and silently dropped every
 * digital asset; FORECAST-16's pay-date block was absent, so "when is my next
 * paycheck?" was answered by the model SPECULATING from the income rows it
 * could see ("you might expect your next paycheck around the same time next
 * month") — the precise ungrounded forward claim FORECAST-11 through 15 exist
 * to make impossible.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT HERE: the cash forecast. A pay date and a
 * composition are both per-Space facts that stay true when several Spaces are
 * in view. A cash projection is not — it runs off account balances, and Spaces
 * share accounts, so a cross-Space projection would be a NEW aggregation
 * authority built on knowingly overlapping inputs. The rollup's existing
 * CROSS-SPACE ARITHMETIC RULE says why that must never be summed; this
 * interface honours it by carrying only what composes.
 *
 * Optional, like `MasterRollup` and for the same reason: fixture callers keep
 * the prior prompt shape.
 */
export interface MasterCapabilities {
  /** The latest user message — CF-7 and CF-6 resolve their own breadth from it. */
  question?: string;
  /**
   * PARITY-2 — the resolved surfaces, ALIGNED BY INDEX with `contexts`. One bag
   * per Space, rendered by the same body the named-Space prompt uses.
   */
  surfaces?: (SpaceSurfaces | undefined)[];
  /**
   * PARITY-2 — set when FORECAST was asked for and could not be scoped to one
   * Space. Renders an explicit refusal instead of leaving a silent hole the
   * model fills with historical means. See `renderForecastScopeRefusal`.
   */
  forecastScopeRefusal?: string[];
}

export interface MasterRollup {
  attemptedSpaceCount:  number;
  failedSpaceNames:     string[];
  distinctAccountCount: number;
}

/**
 * PARITY-2 — EVERY per-Space surface a prompt can carry, in one bag.
 *
 * ⚠️ THIS EXISTS BECAUSE PARITY-1 PICKED THE WRONG SEAM. That slice wired the
 * two capabilities it had just watched fail — a question and pay dates — into
 * master by hand, and the very next real conversation found the next two:
 * holdings never assembled (master passed no `evidence`, so CF-6 never licensed
 * the domain) and no forecast at all (master never planned, so FORECAST-10
 * never ran and the model multiplied a historical mean by four months). An
 * allowlist of capabilities is a list that is always one capability out of
 * date; the failure mode is structural, not a series of oversights.
 *
 * So the surfaces travel as ONE value and both modes render the SAME body from
 * it. A capability added to `renderSpaceEvidenceBody` reaches master by
 * construction, and the parity gate can then assert an equality of BLOCKS
 * rather than enumerating the capabilities anybody remembered to list.
 */
export interface SpaceSurfaces {
  envelope?:     CoverageEnvelope;
  plan?:         RetrievalPlan;
  debtPayments?: DebtPaymentLine[];
  forecast?:     AssembledForecast;
  payDates?:     PayDateResult;
}

/**
 * PARITY-2 — the evidence body for ONE Space: identical in both modes.
 *
 * Everything here is a statement about a single Space, which is what makes
 * master's per-Space blocks composable without inventing cross-Space authority.
 * The ORDER is FORECAST-10/CF-5/CF-7's and is load-bearing — see the comments
 * on each block, which explain why each is read before the next.
 */
function renderSpaceEvidenceBody(
  ctx: SpaceContext_AI,
  assessment: FinancialAssessment | undefined,
  route: IntentRoute,
  question: string | undefined,
  s: SpaceSurfaces,
): string[] {
  const { envelope, plan, debtPayments, forecast, payDates } = s;
  return [
    'AUTHORITATIVE — deterministic verdicts. Explain them; do not reverse them.',
    '=== FINANCIAL ASSESSMENT ===',
    assessment
      ? serializeAssessmentBlock(
        assessment, analysisWindowNote(ctx), ctx.space.reportingCurrency, forecast !== undefined,
        suppressHistoricalSpending(plan, forecast !== undefined))
      : '(no assessment available)',
    '=== END ASSESSMENT ===',
    '',
    ...(forecast ? [FORECAST_DOCTRINE, ''] : []),
    ...(payDates ? renderPayDates(payDates) : []),
    ...(forecast ? renderForecastSection(forecast) : []),
    ...renderEnvelope(ctx, envelope),
    ...renderConcepts(ctx, question),
    'SUPPORTING EVIDENCE — facts you may cite and reason from. Anything here that no assessment dimension grades is context, not a graded finding, and must not be presented as one.',
    '=== SPACE CONTEXT ===',
    serializeContextBlock(
      ctx, debtPayments, temporalScopeFor(ctx, route),
      omitDomainJson(plan), omitTransactionAnalysis(plan)),
    '=== END CONTEXT ===',
  ];
}

/**
 * PARITY-2 — what master says when a forecast is ASKED FOR but cannot be scoped.
 *
 * ⚠️ THE REFUSAL IS THE FEATURE. A cash projection runs off account balances and
 * Spaces share accounts, so a cross-Space forecast would be a new aggregation
 * authority over knowingly overlapping inputs — PARITY-1 declined to build one
 * and that decision stands. But declining to BUILD is not declining to ANSWER:
 * with no forecast section and no suppression, the model met a forecast question
 * holding a measured monthly income, a measured monthly spend and a cash
 * balance, and did the arithmetic itself. Measured on the real corpus, 4 of 6
 * primed turns produced an unlicensed year-end figure.
 *
 * So the absence is made EXPLICIT and the substitutes are named and forbidden.
 * The last line addresses the other half of the same failure: with the prior
 * projection in history, 5 of 5 follow-ups treated the assistant's own prose as
 * evidence — FORECAST-13 re-derives facts from USER messages for exactly this
 * reason, and master had no equivalent.
 */
export function renderForecastScopeRefusal(spaceNames: string[]): string[] {
  return [
    'AUTHORITATIVE — deterministic verdict. Explain it; do not reverse it.',
    '=== CASH FORECAST: REFUSED (SCOPE) ===',
    'A forward cash projection was asked for and is NOT AVAILABLE in all-spaces mode.',
    `A projection runs off account balances, and an account shared into several spaces appears in each of them — so there is no deduplicated cross-space balance to project from. Ask the user which space to forecast (${spaceNames.map((n) => `"${displaySpaceName(n)}"`).join(', ')}) and answer the rest of their question normally.`,
    'You MUST NOT construct the projection yourself. Specifically: do not multiply any monthly income, monthly spending, or net cash flow figure by a number of months; do not add such a product to a cash or net-worth balance; and do not present any year-end, month-end or "by then" total. These figures are measurements of the PAST and license no forward statement.',
    'Figures that appeared in your own earlier replies in this conversation are NOT evidence and carry no authority here. If a projection is needed, it comes from a forecast section in this prompt or it does not exist.',
    '=== END CASH FORECAST ===',
    '',
  ];
}

export function buildMasterSystemPrompt(
  contexts: SpaceContext_AI[],
  annotationsList: FinancialAssessment[],
  route: IntentRoute,
  debtPaymentsList?: DebtPaymentLine[][],
  rollup?: MasterRollup,
  capabilities?: MasterCapabilities,
): string {
  const spaceBlocks = contexts
    .map((ctx, i) => [
      `--- Space ${i + 1} of ${contexts.length} ---`,
      // PARITY-2 — the SAME body as the named-Space prompt. `debtPaymentsList`
      // stays a separate positional argument because callers predating the
      // surfaces bag still pass it; the surfaces value wins when present.
      ...renderSpaceEvidenceBody(ctx, annotationsList[i], route, capabilities?.question,
        { debtPayments: debtPaymentsList?.[i], ...(capabilities?.surfaces?.[i] ?? {}) }),
    ].join('\n'))
    .join('\n\n');

  // REVIEW-3 C-9 (KD-8) — honest coverage. The prompt used to state the
  // SURVIVOR count as the user's Space count: a failed buildContext silently
  // shrank the user's financial world and the model asserted completeness it
  // did not have.
  const attempted = rollup?.attemptedSpaceCount ?? contexts.length;
  const coverageLines: string[] = [
    attempted === contexts.length
      ? `You have context for all ${contexts.length} space(s) the user belongs to.`
      : `You have context for ${contexts.length} of the user's ${attempted} space(s).`,
  ];
  if (rollup && rollup.failedSpaceNames.length > 0) {
    coverageLines.push(
      `UNAVAILABLE SPACES: context could not be assembled for: ${rollup.failedSpaceNames.map((n) => `"${displaySpaceName(n)}"`).join(', ')}. ` +
      'Their data is MISSING from this conversation — the blocks below are NOT the user\'s complete financial picture. ' +
      'If the user asks about one of these spaces, or about all-spaces totals, say plainly that this data is currently unavailable.',
    );
  }
  if (rollup) {
    coverageLines.push(
      'CROSS-SPACE ARITHMETIC RULE: an account shared into multiple spaces appears in EACH of those spaces\' ' +
      'blocks below, so figures from different space blocks OVERLAP and must NEVER be added together. ' +
      `The one deduplicated cross-space fact available: the user has ${rollup.distinctAccountCount} distinct connected account(s) across all spaces. ` +
      'For any other cross-space total, present the per-space figures separately and state that a combined total is not available here.',
    );
  }

  return [
    'You are a skilled, direct financial advisor powered by Fourth Meridian.',
    ...coverageLines,
    `Today's date: ${todayDateString()}.`,
    'Answer using ONLY the supplied financial context.',
    'Never invent accounts, balances, transactions, or any financial data.',
    'If the context is insufficient, explain what is missing and why.',
    'Do not claim to execute trades, rebalance portfolios, or modify accounts or transaction records.',
    'Saving debt metadata (APR, minimum payment, due day, statement close day) is a supported user action via the form below your message — direct users there when they want to save those values.',
    'When referencing data, attribute it to the correct space by name.',
    '',
    // A3 — the precedence contract frames every rule that follows it.
    AUTHORITY_PRECEDENCE,
    '',
    ADVISOR_PRINCIPLES,
    '',
    RESPONSE_STYLE,
    '',
    KNOWLEDGE_GAPS_RULES,
    '',
    buildMasterAliasGuidance(contexts),
    '',
    EXECUTIVE_SUMMARY_DOCTRINE,
    '',
    EXPLAINABILITY_DOCTRINE,
    '',
    '=== QUESTION ROUTING ===',
    serializeRoutingBlock(route),
    '=== END ROUTING ===',
    '',
    ...(capabilities?.forecastScopeRefusal ?? []),
    '=== SPACE CONTEXTS ===',
    spaceBlocks,
    '=== END CONTEXTS ===',
  ].join('\n');
}
