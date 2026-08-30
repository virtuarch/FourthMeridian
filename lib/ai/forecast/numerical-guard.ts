/**
 * lib/ai/forecast/numerical-guard.ts
 *
 * FORECAST-14 — THE MODEL IS NOT A NUMERICAL AUTHORITY.
 *
 * ── What survived, and why this is not another prompt ───────────────────────
 * The deterministic forecast is correct in every failing case. The model reads
 * it, uses the right inputs, and then performs a multiplication that came from
 * the conversation: "$10,000 a month over 3 months" becomes $30,000 beside a
 * block saying $30,226.49. FORECAST-11A measured three interventions against it
 * — a restated horizon, an identity statement, a targeted doctrine line — at
 * 0/10 each, thirty samples in which the deterministic total was cited zero
 * times. FORECAST-12 measured four model tiers; the best improves D and regresses
 * I, and reintroduces an original failure class. Asking again, in different
 * words, is not a plan.
 *
 * So the boundary is structural: a figure may appear as a forecast money claim
 * only if the deterministic result licensed it.
 *
 * ── Shape borrowed, deliberately ────────────────────────────────────────────
 * This is `lib/ai/assessment-guard.ts` applied to arithmetic rather than to
 * verdicts: a PURE detector, one narrow repair, a deterministic fallback, and
 * an off/shadow/repair mode that is never silently on. That guard already
 * proved the sequence works and the route already runs it; a second mechanism
 * with different failure modes would be the novelty, not the reuse.
 *
 * ── Why "the number appears in the prompt" is not the test ──────────────────
 * $15,500 is in the prompt. It is a GROSS bonus, sayable as a stated gross
 * amount and NOT as money arriving — the distinction FORECAST-3 exists to hold.
 * A licence keyed on presence would authorise exactly the sentence that has to
 * be refused. So every licensed figure carries the ROLE it may be used in, and
 * a cash claim over a STATED_NOT_CASH figure is a finding.
 */

import { ConclusionStatus } from '@/lib/forecast/policy';
import { AmountBasis } from '@/lib/forecast/future-cash-event';
import type { CashForecast } from '@/lib/forecast/engine';

export type ForecastGuardMode = 'off' | 'shadow' | 'repair';

/** What a figure is licensed to be USED as. Presence is not permission. */
export const FigureRole = {
  /** Spendable cash: a balance, a licensed inflow, a deterministic total. */
  CASH: 'CASH',
  /**
   * A real amount that is NOT cash — a GROSS bonus, an unestablished-basis
   * paycheck. Mentionable with its caveat; never a balance or an arrival.
   */
  STATED_NOT_CASH: 'STATED_NOT_CASH',
  /** A per-period level. Mentionable as a rate; never as a horizon total. */
  RATE: 'RATE',
} as const;

export type FigureRoleKind = typeof FigureRole[keyof typeof FigureRole];

export interface LicensedFigure {
  value: number;
  role: FigureRoleKind;
  /** Where it came from, for the repair instruction and for debugging. */
  label: string;
}

/**
 * Ending-balance language specifically — the one slot a REFUSED path licenses
 * no figure for at all.
 */
const ENDING_CLAIM_RE =
  /\b(?:ending (?:cash|balance)|end (?:up )?with|final (?:cash|balance)|you'?ll have|cash (?:at the end|remaining|left))\b[^.]{0,24}$/i;

/**
 * A figure being discussed as HISTORY, which this boundary has no opinion about.
 *
 * ⚠️ MEASURED OVER-RESTRICTION. On a legitimate mixed historical+forecast answer
 * the guard flagged all three historical figures: $25,048.98 because it happens
 * to be 3 x the $8,349.66 mean, and the mean itself because "Average Monthly
 * Spending:" reads as spending-claim language. Both are correct answers to the
 * half of the question that asked about the past, and the user asked for them.
 * A forecast boundary that polices historical arithmetic is wrong in a way that
 * costs the user real answers.
 */
const HISTORICAL_CONTEXT_RE =
  /\b(?:last|past|previous|prior|recent|historical|so far|to date|trailing)\s+(?:\d+\s+)?(?:month|months|week|weeks|year|years|quarter)\b|\byou spent\b|\bspent over\b|\baverage monthly spending\b|\bover the last\b|\bmonths? ago\b/i;

/**
 * A caveat that makes a not-cash figure correctly stated.
 *
 * ⚠️ THE LICENCE'S OWN INTENT. STATED_NOT_CASH means "sayable with its caveat",
 * so a sentence carrying the caveat is the licence being honoured, not broken.
 * Without this the guard flagged "Known Future Inflows: $37,006.51 (not counted
 * as cash)" — the exact sentence FORECAST-3 wants.
 */
/**
 * Forward-looking framing, which ENDS a historical section.
 *
 * ⚠️ SECTIONS, NOT SENTENCES. "### Spending Over the Last 3 Months" is followed
 * by "- **Total Spending:** $25,048.98" — a line with no historical marker of
 * its own, under a heading that is entirely about the past. A per-sentence test
 * flagged it. The scope carries from the heading until something forward-looking
 * ends it.
 */
const FORWARD_CONTEXT_RE =
  /\b(?:next|upcoming|forecast|projected|going forward|from (?:now|here)|over the next|will|would)\b/i;

const CAVEAT_RE =
  /\b(?:not (?:counted|treated|included) as (?:cash|spendable)|gross|not spendable|basis (?:is )?(?:unknown|not established|unestablished)|net \(after[- ]tax\)|before deductions|not yet cash)\b/i;

export type ForecastGuardFindingKind =
  /** A money figure that is a product of two figures in the reply, and licensed by neither. */
  | 'UNLICENSED_PRODUCT'
  /** A cash/balance claim over a figure the forecast never licensed as cash. */
  | 'UNLICENSED_CASH_CLAIM'
  /**
   * An ending balance stated over a path the forecast REFUSED.
   *
   * ⚠️ ROLE IS NOT ENOUGH; THE SLOT MATTERS. Measured: "Ending Cash: $10,228"
   * over a refused path. That figure IS licensed — it is the opening balance —
   * so a role-only licence waved it through while the sentence asserted the one
   * thing the forecast had declined to say. Not every number in the prompt is
   * licensed for every semantic claim.
   */
  | 'ENDING_CASH_OVER_REFUSAL';

export interface ForecastGuardFinding {
  kind: ForecastGuardFindingKind;
  value: number;
  /** The sentence that triggered it — evidence, never a paraphrase. */
  evidence: string;
  /** What the model must not assert, phrased for the repair. */
  claim: string;
}

// ── The licence ─────────────────────────────────────────────────────────────

const money = (n: number) => `USD ${n.toFixed(2)}`;

/**
 * Every figure the deterministic result licenses, and the role it licenses it in.
 *
 * ⚠️ FROM THE TYPED RESULT, NEVER FROM THE RENDERED PROSE. Re-reading the
 * serializer's sentences to rediscover what it meant would be a second parser
 * of our own output, and it would drift the first time a line was reworded.
 * Everything below is a field.
 */
export function licensedFigures(f: CashForecast): LicensedFigure[] {
  const out: LicensedFigure[] = [];
  const add = (value: number | null | undefined, role: FigureRoleKind, label: string) => {
    if (typeof value === 'number' && Number.isFinite(value)) out.push({ value, role, label });
  };

  add(f.openingCash.amount, FigureRole.CASH, 'opening cash');

  // A stated rate may be spoken of as a rate. The horizon total below is the
  // only figure that rate is licensed to produce.
  add(f.spending.amount, FigureRole.RATE, 'the stated spending level');
  if (f.spending.dailyRate !== null) {
    add(f.spending.dailyRate * f.horizonDays, FigureRole.CASH, 'spending over the horizon');
  }

  let inflow = 0, outflow = 0;
  for (const e of f.events) {
    const amt = e.authoritativeAmount?.value;
    if (amt === undefined) continue;
    // ⚠️ ROLE FOLLOWS THE CASH LICENCE, NOT THE PRESENCE OF A NUMBER. An event
    // whose basis is unestablished, or established as GROSS, is a real amount
    // that is not money arriving.
    const isCash = e.included && e.cashDelta !== null
      && e.authoritativeAmount?.basis !== AmountBasis.GROSS;
    add(amt, isCash ? FigureRole.CASH : FigureRole.STATED_NOT_CASH, `event ${e.id}`);
    if (e.included && e.cashDelta !== null) {
      if (e.cashDelta >= 0) inflow += e.cashDelta; else outflow += -e.cashDelta;
    }
  }
  if (inflow > 0) add(inflow, FigureRole.CASH, 'licensed inflows');
  if (outflow > 0) add(outflow, FigureRole.CASH, 'licensed outflows');

  // Nominal totals of amounts that are NOT cash — the $17,000 the model must be
  // able to say is stated, and must not be able to say is arriving.
  const nominal = f.events
    .filter((e) => e.included && e.cashDelta === null)
    .reduce((t, e) => t + (e.authoritativeAmount?.value ?? 0), 0);
  if (nominal > 0) add(nominal, FigureRole.STATED_NOT_CASH, 'stated amounts not counted as cash');

  // Balances, only where the path was licensed. A REFUSED path licenses none —
  // which is the point: there is no ending figure to quote, so any is unlicensed.
  if (f.fullCashPath.status !== ConclusionStatus.REFUSED) {
    add(f.fullCashPath.closing, FigureRole.CASH, 'ending cash');
    for (const p of f.points) add(p.closingBalance, FigureRole.CASH, `balance at ${p.dateISO}`);
  }
  if (f.knownEventPath.status !== ConclusionStatus.REFUSED) {
    add(f.knownEventPath.closing, FigureRole.CASH, 'known-event balance');
  }
  return out;
}

// ── Reading figures out of a reply ──────────────────────────────────────────

/** A money figure and the sentence it sits in. */
interface ReplyFigure {
  value: number; sentence: string; hedged: boolean;
  /** Claim language immediately BEFORE this figure, not merely in its sentence. */
  cashClaim: boolean;
  /** Followed by a per-period marker — "$4,000/month" is a rate, not a balance. */
  isRateMention: boolean;
  /** Specifically an ENDING-balance claim. */
  endingClaim: boolean;
  /** Inside a section about the past, which this boundary does not police. */
  historical: boolean;
}

/** Language that makes a figure a claim about cash rather than a mention of an amount. */
/**
 * Language that makes a figure a CLAIM ABOUT CASH rather than a mention.
 *
 * ⚠️ THE LABELS ARE HERE BECAUSE A MEASURED ESCAPE PUT THEM HERE. "Known
 * Outflows: $30,000" reached a user: the reply never mentioned the $10,000 rate,
 * so the product rule had no operand to see, and "Outflows" was not claim
 * vocabulary. A ledger label IS a cash claim — that is what a reader takes from
 * it — so the labels a forecast answer actually uses are named.
 *
 * ⚠️ AND IT STAYS ROLE-AWARE RATHER THAN BECOMING "ANY UNLICENSED NUMBER". That
 * stricter rule would catch this too, and would also flag the $8,349.66
 * historical mean in a mixed historical+forecast answer, where it is legitimate
 * and the user asked for it. Over-restriction is a way of being wrong.
 */
const CASH_CLAIM_RE =
  /\b(?:ending cash|end(?:ing)? (?:up )?with|you'?ll have|you will have|balance (?:will|would|is|of)|total(?:ling|s|ing)?|(?:known|total|projected|estimated)?\s*(?:in|out)flows?|(?:total|projected)?\s*spending(?: over| of| for)?|cash (?:position|balance|available|flow)|available to spend|spendable|in (?:cash|hand)|net (?:cash|inflow)|receive|arriving|comes? in)\b[^.]{0,24}$/i;

const MONEY_RE = /(?:\$|\bUSD\s*)(-?[\d,]+(?:\.\d{1,2})?)/g;
const HEDGE_RE = /\b(?:about|roughly|around|approximately|近|~|nearly|just over|just under|some)\s*$/i;

/**
 * Money figures in the reply, with the sentence each appears in.
 *
 * ⚠️ MONEY ONLY. Dates, counts, percentages and day spans are not read, so
 * "7 paychecks", "92 days", "2026-11-28" and "0.16%" pass through untouched —
 * the boundary is about financial claims, not about digits.
 */
function replyFigures(reply: string): ReplyFigure[] {
  const out: ReplyFigure[] = [];
  // ⚠️ NOT ON THE COLON. Splitting there severed "- **Total Assumed
  // Outflows**:" from "$12,000", so the figure arrived with no claim language
  // anywhere near it and walked past the guard. A markdown label and its value
  // are one claim, and a boundary that cannot see the label cannot see the
  // claim. Newlines still separate, so a bullet is still its own unit.
  let historical = false;
  for (const sentence of reply.split(/(?<=[.!?])\s+|\n+/)) {
    // ⚠️ SECTION SCOPE. A historical heading opens one, a forward-looking line
    // closes it, and both on one line means forward wins — "what I spent last
    // month vs what next month looks like" is a forecast sentence with a
    // historical clause. Measured: without this, "- **Total Spending:**
    // $25,048.98" under "### Spending Over the Last 3 Months" was flagged.
    if (FORWARD_CONTEXT_RE.test(sentence)) historical = false;
    else if (HISTORICAL_CONTEXT_RE.test(sentence)) historical = true;
    for (const m of sentence.matchAll(MONEY_RE)) {
      const value = Number(m[1].replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;
      const before = sentence.slice(Math.max(0, m.index - 16), m.index);
      // ⚠️ PROXIMITY, NOT SENTENCE MEMBERSHIP. "Assuming $4,000/month spending
      // …, your ending cash would be $35,144.66" is a correct answer, and a
      // whole-sentence test flagged the $4,000 because the words "ending cash"
      // were somewhere in it. The claim has to attach to THIS figure.
      const near = sentence.slice(Math.max(0, m.index - 45), m.index);
      const after = sentence.slice(m.index + m[0].length, m.index + m[0].length + 14);
      out.push({
        value: Math.abs(value), sentence: sentence.trim(), hedged: HEDGE_RE.test(before),
        cashClaim: CASH_CLAIM_RE.test(near),
        endingClaim: ENDING_CLAIM_RE.test(near),
        historical,
        isRateMention: /^\s*(?:\/|per\s|a\s|each\s|every\s)?\s*(?:month|mo\b|week|year|28 days)/i
          .test(after),
      });
    }
  }
  return out;
}

/** Cent-level identity. A licensed figure quoted or lightly rounded is the same figure. */
const EXACT = 0.51;
/** A hedged approximation of a licensed figure — "roughly $35,000" — is honest. */
const HEDGED_PCT = 0.02;

function licenceFor(
  value: number, licensed: readonly LicensedFigure[], hedged: boolean,
): LicensedFigure | null {
  const exact = licensed.find((l) => Math.abs(l.value - value) <= EXACT);
  if (exact) return exact;
  if (!hedged) return null;
  return licensed.find((l) => l.value !== 0 && Math.abs(l.value - value) / l.value <= HEDGED_PCT)
    ?? null;
}

/**
 * Figures the model produced that the forecast did not license.
 *
 * PURE. The same (reply, forecast) always yields the same findings — no I/O, no
 * clock, no model.
 */
export function detectUnlicensedForecastArithmetic(
  reply: string, forecast: CashForecast,
): ForecastGuardFinding[] {
  const licensed = licensedFigures(forecast);
  const figures = replyFigures(reply);
  const findings: ForecastGuardFinding[] = [];
  const seen = new Set<number>();

  const endingRefused = forecast.fullCashPath.status === ConclusionStatus.REFUSED;

  for (const fig of figures) {
    if (seen.has(fig.value)) continue;
    // ⚠️ HISTORY IS OUT OF SCOPE, ENTIRELY. Not "allowed if licensed" — the
    // forecast licence has nothing to say about what the user spent last month.
    if (fig.historical) continue;
    const lic = licenceFor(fig.value, licensed, fig.hedged);

    // ── 0. An ending balance over a refused path ───────────────────────────
    if (endingRefused && fig.endingClaim && !fig.isRateMention) {
      seen.add(fig.value);
      findings.push({
        kind: 'ENDING_CASH_OVER_REFUSAL', value: fig.value, evidence: fig.sentence,
        claim: `${money(fig.value)} as an ending balance — the forecast REFUSED an ending figure`,
      });
      continue;
    }

    // ── 1. A product of two figures in the reply, licensed by neither ───────
    //
    // ⚠️ THE MEASURED FAILURE, EXACTLY. Both operands are in the reply — "$10,000
    // a month" and "3 months" — so nothing has to be recovered from the
    // conversation to see the multiplication. A licensed figure is never a
    // finding however it was reached, so a correct total that happens to be a
    // round multiple is untouched.
    if (!lic) {
      const operand = figures.find((o) => o.value > 0 && o.value !== fig.value
        && Number.isInteger(Math.round((fig.value / o.value) * 1000) / 1000)
        && Math.round(fig.value / o.value) >= 2 && Math.round(fig.value / o.value) <= 24
        && Math.abs(fig.value - o.value * Math.round(fig.value / o.value)) <= EXACT);
      if (operand) {
        seen.add(fig.value);
        findings.push({
          kind: 'UNLICENSED_PRODUCT', value: fig.value, evidence: fig.sentence,
          claim: `${money(fig.value)}, which you calculated from ${money(operand.value)} rather than `
            + 'taking it from the forecast',
        });
        continue;
      }
    }

    // ── 2. A cash claim over a figure never licensed as cash ────────────────
    //
    // Covers both halves of the distinction: a figure the forecast licensed
    // only as a STATED_NOT_CASH amount (a GROSS bonus), and a figure it never
    // licensed at all (an ending balance invented over a REFUSED path).
    // ⚠️ A RATE MENTION IS NEVER A CASH CLAIM. "$4,000/month" says how fast
    // money leaves; it is not a balance however the sentence around it reads.
    // A not-cash figure stated WITH its caveat is the licence working.
    if (lic?.role === FigureRole.STATED_NOT_CASH && CAVEAT_RE.test(fig.sentence)) continue;

    if (fig.cashClaim && !fig.isRateMention
      && (!lic || lic.role === FigureRole.STATED_NOT_CASH || lic.role === FigureRole.RATE)) {
      seen.add(fig.value);
      findings.push({
        kind: 'UNLICENSED_CASH_CLAIM', value: fig.value, evidence: fig.sentence,
        claim: lic
          ? `${money(fig.value)} as cash — the forecast holds it as ${lic.label}, which is not spendable cash`
          : `${money(fig.value)} as a cash figure the forecast does not license`,
      });
    }
  }
  return findings;
}

// ── Repair and fallback ─────────────────────────────────────────────────────

/**
 * The repair instruction. Narrow by design: it names the figures that may not
 * appear and the ones that may, and invites no re-evaluation of anything else.
 */
export function buildForecastRepairInstruction(
  findings: readonly ForecastGuardFinding[], forecast: CashForecast,
): string {
  const cash = licensedFigures(forecast).filter((l) => l.role === FigureRole.CASH);
  return [
    'Your previous draft stated a financial figure the deterministic forecast did not license.',
    ...findings.map((f) => `- Do not state ${f.claim}.`),
    cash.length
      ? `The only cash figures you may state are: ${cash.map((l) => `${money(l.value)} (${l.label})`).join('; ')}.`
      : 'The forecast licenses NO cash figure for this question — state none, and say what is missing instead.',
    'Do not calculate any figure yourself, including from a rate the user gave you.',
    'Preserve the rest of your answer, including dates, counts and stated amounts with their caveats.',
  ].join('\n');
}

/**
 * Remove the offending claims and keep the rest of the answer.
 *
 * ⚠️ MEASURED AGAINST THE ALTERNATIVE, not assumed better. Regenerating against
 * a correction was tried first and cleared the finding in 1 of 20 samples — the
 * same model, the same blind spot, one more paid call and a second round of
 * latency to arrive at the deterministic fallback anyway. Redaction is free,
 * deterministic, and keeps the paragraphs that were never in question.
 *
 * It removes SENTENCES, not numbers: excising "$30,000" from "your total
 * spending would amount to $30,000" leaves a sentence that still makes a claim
 * and no longer says what it is. The licensed figure is offered in its place so
 * the answer still carries the total the user asked for.
 */
export function redactUnlicensed(
  reply: string, findings: readonly ForecastGuardFinding[], forecast: CashForecast,
): string {
  let out = reply;
  for (const f of findings) {
    // The evidence is a verbatim slice of the reply, so this is exact removal.
    out = out.split(f.evidence).join('');
  }
  // ⚠️ A BULLET WITHOUT ITS FIGURE IS WORSE THAN NO BULLET. Removing "$30,000"
  // from "- **Total Spending Over 3 Months**: $30,000" leaves a label promising
  // a number that is not there, which reads as a rendering failure. A line left
  // holding only a label goes with it.
  const LABEL_ONLY = /^[ \t]*(?:[-*\u2022]\s*)?(?:\*{0,2}[^:*]{0,60}\*{0,2}\s*:)?\s*$/;
  out = out.split('\n').filter((l) => !LABEL_ONLY.test(l)).join('\n').trim();

  const spend = licensedFigures(forecast)
    .find((l) => l.role === FigureRole.CASH && l.label === 'spending over the horizon');
  const ending = forecast.fullCashPath.status === ConclusionStatus.REFUSED
    ? null : forecast.fullCashPath.closing;
  const restored: string[] = [];
  if (spend) restored.push(`spending over this horizon is ${money(spend.value)}`);
  if (ending !== null && ending !== undefined) restored.push(`ending cash is ${money(ending)}`);

  // ⚠️ REDACTION IS COLLATERAL, SO THE ASSUMPTIONS ARE RESTORED TOO. Measured:
  // the offending figure often shares a line with the supposition that
  // justified it — "Known Outflows: $12,000 (3 months at $4,000/month)" — so
  // removing the line removed the model's statement of what the answer rests
  // on. An assumption-dependent number without its assumptions is exactly what
  // FORECAST-11's contract forbids, and the assumptions are deterministic.
  const supposed = forecast.accepted.filter((a) => a.origin === 'USER_REQUESTED');
  if (supposed.length > 0 && ending !== null && ending !== undefined) {
    restored.push(`this rests on ${supposed.map((a) => `"${a.statedAs}"`).join(' and ')}`);
  }
  if (restored.length) {
    out += `\n\nTo be precise about the figures: ${restored.join(', and ')}.`;
  }

  // ⚠️ A REDACTION MUST NOT DELETE THE REFUSAL. Measured: the offending figure
  // sometimes sits in the same sentence as "ending cash cannot be stated", and
  // removing the sentence removed both — leaving an answer that had lost the
  // one thing it most needed to say. The refusal is deterministic, so it is
  // restored rather than hoped for.
  if (forecast.fullCashPath.status === ConclusionStatus.REFUSED
    && !/\brefus|cannot be (?:stated|determined|calculated)|can'?t (?:be )?(?:state|determine|calculate)/i.test(out)) {
    out += `\n\nEnding cash cannot be stated: ${forecast.fullCashPath.missing.join('; ')}.`;
  }
  return out;
}

/**
 * Deterministic last resort — the forecast, narrated from its own serializer.
 *
 * ⚠️ IT ANSWERS THE QUESTION. A user who asked what their cash will do should
 * get the deterministic answer, not a notice that a validator fired. This is
 * the existing guard's `refusalPreservingFallback` lesson applied here, and it
 * is why a generic error is not an acceptable fallback.
 */
export function forecastNarrationFallback(lines: readonly string[]): string {
  return [
    'Here is the forecast exactly as calculated:',
    '',
    ...lines,
  ].join('\n');
}

/**
 * The whole boundary, as one call: detect, redact, verify, fall back.
 *
 * ⚠️ EXTRACTED SO THE ROUTE STAYS UNDER ITS 700-LINE CEILING, which
 * `route-authority.aiarch` enforces and which FORECAST-10 already learned to
 * respect rather than raise. The route asks one question — "is this reply
 * safe?" — and everything that answers it lives here.
 *
 * ⚠️ NO SECOND MODEL CALL. Regenerating against a correction was measured
 * first: it cleared the finding in 1 of 20 samples, at the cost of a paid call
 * and a second round of latency, before arriving at this same fallback.
 * Redaction clears it in roughly three quarters of cases for nothing.
 */
export function guardForecastReply(
  reply: string, forecast: CashForecast, mode: ForecastGuardMode,
  narrate: () => readonly string[],
): { reply: string; outcome: string; findings: readonly ForecastGuardFinding[] } {
  const findings = detectUnlicensedForecastArithmetic(reply, forecast);
  if (findings.length === 0) return { reply, outcome: 'clean', findings };
  if (mode !== 'repair') return { reply, outcome: `${mode}:${findings.length}`, findings };

  const redacted = redactUnlicensed(reply, findings, forecast);
  const still = detectUnlicensedForecastArithmetic(redacted, forecast);
  return {
    reply: applyForecastGuard(redacted, still, mode, forecastNarrationFallback(narrate())),
    outcome: still.length === 0 ? 'redacted' : 'fallback',
    findings,
  };
}

/** Pure decision function — the twin of `applyGuard`. */
export function applyForecastGuard(
  reply: string, findings: readonly ForecastGuardFinding[], mode: ForecastGuardMode,
  fallback: string,
): string {
  if (mode === 'off' || mode === 'shadow') return reply;
  if (findings.length === 0) return reply;
  return fallback;
}

/** Unset ⇒ shadow. Enforcement is never silently on. */
export function resolveForecastGuardMode(raw: string | undefined): ForecastGuardMode {
  return raw === 'repair' ? 'repair' : raw === 'off' ? 'off' : 'shadow';
}
