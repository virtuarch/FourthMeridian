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

/**
 * PARITY-3 — WHEN a figure may be asserted about, alongside what it may be used AS.
 *
 * ⚠️ ROLE ALONE COULD NOT HOLD THE LINE. Measured: with an invented projection
 * in the assistant's own history ("estimated cash flow until EOY: $34,035.64"),
 * a net-worth follow-up rebuilt on it 5 times out of 5 — in BOTH master and
 * named-Space mode — and every existing rule passed it. `ENDING_CASH_OVER_REFUSAL`
 * is keyed to ending-cash vocabulary and "projected increase of" is not that;
 * `UNLICENSED_PRODUCT` looks for a multiple and $75,022.17 is a SUM; and
 * `UNLICENSED_CASH_CLAIM` needs cash-claim language, which "net worth of" is not.
 *
 * The missing distinction was never about vocabulary. A figure can be perfectly
 * licensed as a CURRENT fact and carry no authority whatever for a claim about
 * December — current net worth is exactly that. So the licence gains the axis
 * it was missing: a claim about a future date requires a licence that reaches
 * the future, and no amount of conversational history can mint one.
 */
export const FigureHorizon = {
  /** True as of now. Licensed by the current-turn authorities that measured it. */
  CURRENT: 'CURRENT',
  /** Licensed for a claim about a future date by the deterministic forecast. */
  FUTURE:  'FUTURE',
} as const;

export type FigureHorizonKind = typeof FigureHorizon[keyof typeof FigureHorizon];

export interface LicensedFigure {
  value: number;
  role: FigureRoleKind;
  /** Where it came from, for the repair instruction and for debugging. */
  label: string;
  horizon: FigureHorizonKind;
}

/**
 * PARITY-3 — a CURRENT figure the turn's own authorities measured.
 *
 * ⚠️ THESE ARE NOT FORECAST OUTPUT, WHICH IS THE POINT. Net worth, liquid cash
 * and the investment totals come from the accounts authority, are true of today,
 * and are freely sayable — the boundary has never policed them and must not
 * start. They are listed here only so the future rule can tell "your current
 * net worth is $40,986.53" (a licensed present fact, in a sentence that also
 * mentions December) from "your net worth would be $75,022.17" (a claim about
 * December). Without them the first sentence is collateral damage.
 */
export interface CurrentAuthorityFigure { value: number; label: string; }

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
  // ⚠️ WORD-NUMBERS TOO. "Over the last three months … your total spending was
  // $25,048.98" was flagged as an unlicensed product — it is 3 x the historical
  // mean — because the pattern only matched digits.
  /\b(?:last|past|previous|prior|recent|historical|so far|to date|trailing)\s+(?:(?:\d+|one|two|three|four|five|six|nine|ten|twelve)\s+)?(?:month|months|week|weeks|year|years|quarter)\b|\byou spent\b|\bspent over\b|\baverage monthly spending\b|\bover the last\b|\bmonths? ago\b/i;

/**
 * A figure being discussed as an INVESTMENT VALUE, which is CF-7's authority.
 *
 * ⚠️ MEASURED FALSE POSITIVE WITH A REAL COST. On "your investments are
 * currently worth a total of $24,021.19, which includes $5,006.56 in
 * traditional investments and $19,014.63 in digital assets" — a clean answer to
 * a question the user asked — the guard fired on "worth a total of" and
 * redaction deleted all three figures. The forecast state says in as many words
 * that investments are NOT liquid cash; a boundary that polices them is
 * policing a different authority's figures.
 *
 * ⚠️ IT DOES NOT EXEMPT SPENDABILITY. "Your crypto gives you $19,014 available
 * to spend" is still a cash claim over a non-cash asset, and still a finding —
 * the exemption is checked against investment framing, and the spendability
 * vocabulary in CASH_CLAIM_RE is checked separately below.
 */
const INVESTMENT_CONTEXT_RE =
  /\b(?:investments?|holdings?|portfolio|brokerage|crypto|digital assets?|securities|equit(?:y|ies))\b/i;
/**
 * A per-period LEVEL framed before the figure — "a monthly spending of $4,000".
 *
 * ⚠️ THE SUFFIX IS NOT THE ONLY PLACE THE PERIOD LIVES. Measured false
 * positives on "assuming a monthly spending of $4,000 and that your paycheck…"
 * — a correct statement of the assumption, redacted because "spending of" reads
 * as claim language and no "/month" followed the figure.
 */
const RATE_FRAME_RE =
  /\b(?:monthly|per month|a month|each month|every month|per 28 days)\b[^.$]{0,24}$|\brate of\s*$/i;

/** Claims that make an investment figure a claim about CASH after all. */
const SPENDABILITY_RE =
  /\b(?:available to spend|spendable|as cash|in cash|liquid|cash you (?:have|can)|use(?:able)? for spending)\b/i;

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

/**
 * PARITY-3 — the sentence is about a FUTURE point in time.
 *
 * ⚠️ NARROWER THAN `FORWARD_CONTEXT_RE`, ON PURPOSE. That one ends a historical
 * SECTION and is deliberately loose — "will" and "would" alone trip it, which is
 * right for scoping a heading and far too broad for redacting a sentence. This
 * one requires an actual future REFERENCE POINT: a named horizon, a relative
 * period, or "then". "I cannot forecast this" mentions the future and asserts
 * nothing about it, and must not be caught.
 */
const FUTURE_POINT_RE =
  // ⚠️ HYPHENS ARE THE MODEL'S DEFAULT. Measured escape: "Estimated end-of-year
  // net worth: $75,022.17" — the period was written "end-of-year", and a pattern
  // that only knew "end of the year" did not see a future reference at all.
  /\b(?:by (?:the )?(?:end[- ]of[- ](?:the[- ])?(?:year|month|quarter)|eoy|year[- ]?end|then|next \w+)|at (?:the )?(?:end[- ]of[- ](?:the[- ])?(?:year|month|quarter)|year[- ]?end)|end[- ]of[- ](?:the[- ])?year\b|year[- ]end\b|\beoy\b|by \d{4}|in \d+ (?:more )?(?:days?|weeks?|months?|years?)|over (?:the next )?\d+ (?:more )?(?:days?|weeks?|months?|years?)|over the next \d+|(?:next|coming|following) (?:week|month|quarter|year)|(?:\d+|three|four|six|twelve) months? from now)\b/i;

/**
 * PARITY-3 — the figure is framed as a value AT that future point, rather than
 * as a present fact mentioned while discussing it.
 *
 * Checked against the text immediately BEFORE the figure, the same way
 * `CASH_CLAIM_RE` is, because "your current net worth of $40,986.53" and "your
 * net worth would be $75,022.17" differ exactly there and nowhere else.
 */
const FUTURE_VALUE_FRAME_RE =
  // ⚠️ THE WINDOW IS THE WHOLE DIFFICULTY. "Projected increase in cash over the
  // next 4 months: $34,035.64" puts 50 characters between the framing word and
  // the figure, because a markdown LABEL is how this model states a projection.
  // A 30-character window measured that escape.
  /\b(?:will|would|could|should|might) (?:be|have|reach|grow|rise|come|total|leave you with|end up (?:with|at))\b[^.$]{0,20}$|\b(?:projected|estimated|expected|forecast(?:ed)?|anticipated|increase)\b[^.$]{0,60}$|\b(?:giving|resulting in|bringing (?:your |it )?[\w ]{0,20}to|adds? up to|for a total of|totall?ing)\s*$/i;

/**
 * PARITY-3 — a line that OPENS a forward-looking section.
 *
 * ⚠️ SECTIONS, FOR THE SAME REASON HISTORY NEEDED THEM. The measured escape was
 * `- $40,986.53 + $34,035.64 = **$75,022.17**` — a line with no framing words at
 * all, under "your estimated net worth at the end of the year would be:". A
 * per-sentence test cannot see a future claim in a line that is pure arithmetic;
 * the scope carries from the line that announced it, exactly as
 * `HISTORICAL_CONTEXT_RE` carries the past. This is why the rule is not a fourth
 * vocabulary pattern: the claim is made by the section, not by the sentence.
 */
const FUTURE_SECTION_OPEN_RE =
  /\b(?:will|would|could|projected|estimated|expected|forecast(?:ed)?|anticipated)\b[^$]{0,80}:\s*$/i;

/**
 * PARITY-3 — framing that is forward-looking on its own, with no date named.
 *
 * ⚠️ MEASURED, AND THE LAST SHAPE TO ESCAPE. "**Projected Cash Increase:**
 * $34,035.64" is a claim about money that has not arrived, and it names no
 * period at all — so a rule requiring an explicit future reference could never
 * see it. These words ARE the reference.
 *
 * ⚠️ "ESTIMATED" IS DELIBERATELY ABSENT. It reads both ways: "Est. monthly
 * spending: $4,156.68 (measured)" is a statement about the PAST, and the
 * assessment block writes exactly that. It stays in `FUTURE_VALUE_FRAME_RE`,
 * where a named future point is also required, and out of this list.
 */
const INHERENTLY_FORWARD_RE =
  /\b(?:projected|forecast(?:ed)?|expected|anticipated|upcoming)\b/i;

/**
 * PARITY-3 — the figure is explicitly framed as a PRESENT fact.
 *
 * ⚠️ THE EXEMPTION IS WHAT KEEPS THE RULE HONEST. The contaminated answers put
 * the present and the future in ONE sentence — "start with your current net
 * worth of $40,986.53 and add the projected increase" — so a sentence-level
 * future test alone would redact a correct, licensed present fact as collateral.
 */
const CURRENT_FRAME_RE =
  /\b(?:current(?:ly)?|today|as of (?:now|today)|right now|at present|present(?:ly)?|you (?:currently )?have|your (?:current )?(?:balance|net worth|cash|liquid cash) is)\b[^.$]{0,30}$/i;

const CAVEAT_RE =
  /\b(?:not (?:counted|treated|included) as (?:cash|spendable)|gross|not spendable|basis (?:is )?(?:unknown|not established|unestablished)|net \(after[- ]tax\)|before deductions|not yet cash)\b/i;

export type ForecastGuardFindingKind =
  /**
   * PARITY-3 — a value asserted about a FUTURE date that no current-turn licence
   * reaches. The kind that closes assistant-history contamination: a figure the
   * model itself invented one turn earlier has no licence here, however
   * confidently the earlier turn stated it.
   */
  | 'FUTURE_VALUE_WITHOUT_LICENCE'
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
export function licensedFigures(
  f: CashForecast, current: readonly CurrentAuthorityFigure[] = [],
  projected: readonly CurrentAuthorityFigure[] = [],
): LicensedFigure[] {
  const out: LicensedFigure[] = [];
  const add = (
    value: number | null | undefined, role: FigureRoleKind, label: string,
    horizon: FigureHorizonKind = FigureHorizon.FUTURE,
  ) => {
    if (typeof value === 'number' && Number.isFinite(value)) out.push({ value, role, label, horizon });
  };

  // ⚠️ OPENING CASH IS A FACT ABOUT TODAY, not a licence to state a future balance.
  add(f.openingCash.amount, FigureRole.CASH, 'opening cash', FigureHorizon.CURRENT);

  // A stated rate may be spoken of as a rate, and it is a PRESENT-tense level.
  // The horizon total below is the only forward figure that rate can produce.
  add(f.spending.amount, FigureRole.RATE, 'the stated spending level', FigureHorizon.CURRENT);
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
  // PARITY-3 — the turn's measured present, so a present fact quoted inside a
  // forward-looking paragraph is recognised rather than redacted as collateral.
  for (const c of current) add(c.value, FigureRole.CASH, c.label, FigureHorizon.CURRENT);
  // PROJECTION-1 — deterministic figures about a FUTURE date, from the
  // evidence-based path. They are licences because an authority computed them,
  // on the same terms as `ending cash`; the standing they carry in the PROMPT is
  // weaker, and that is the renderer's contract, not this boundary's.
  for (const p of projected) add(p.value, FigureRole.CASH, p.label, FigureHorizon.FUTURE);
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
  /** PARITY-3 — asserted as a value at a future point in time. */
  futureValue: boolean;
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

/** Markdown emphasis removed. Presentation, never part of a claim. */
const md = (t: string) => t.replace(/\*+|_{2,}|`/g, '');

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
  // PARITY-3 — the forward scope, opened by a line that announces a future value
  // and closed by anything that plants the reader back in the present or past.
  let futureSection = false;
  for (const sentence of reply.split(/(?<=[.!?])\s+|\n+/)) {
    if (FUTURE_POINT_RE.test(sentence) && FUTURE_SECTION_OPEN_RE.test(md(sentence))) {
      futureSection = true;
    } else if (HISTORICAL_CONTEXT_RE.test(sentence)) {
      // ⚠️ A PRESENT MENTION DOES NOT CLOSE THE SECTION. Closing on one was
      // measured leaking: the model lists "- Current net worth: $40,986.53"
      // and then "- Projected increase in cash: $34,035.64" as consecutive
      // bullets, and the first bullet closed the scope that the second needed.
      // The present FIGURE is protected where it belongs — by `CURRENT_FRAME_RE`
      // on the figure itself — not by tearing down the section around it.
      futureSection = false;
    }
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
      // ⚠️ EMPHASIS STRIPPED FOR ANALYSIS ONLY, NEVER FROM THE EVIDENCE.
      // "**$11,454.40** per month" put `**` between the figure and its period
      // marker, so the rate exemption missed. Stripping the whole reply first
      // fixed that and broke redaction instead: `evidence` is matched back
      // against the ORIGINAL text, and a stripped sentence is never found in it.
      // So the windows are cleaned and the sentence is not.
      const near = md(sentence.slice(Math.max(0, m.index - 45), m.index));
      const after = md(sentence.slice(m.index + m[0].length, m.index + m[0].length + 20));
      // ⚠️ SPENDABILITY IS CHECKED AFTER THE FIGURE TOO. English puts it there
      // as often as before — "$19,014.63 available to spend" — and a
      // before-only window let a crypto-as-cash claim through untouched.
      const afterWide = md(sentence.slice(m.index + m[0].length, m.index + m[0].length + 60));
      // ⚠️ A WIDER WINDOW, AND ONLY FOR THE TEMPORAL TEST. Measured escape:
      // "gives an estimated end-of-year net worth of approximately $75,022.17"
      // puts 48 characters between "estimated" and the figure. `near` stays at
      // 45 because CASH_CLAIM_RE's proximity argument depends on it — widening
      // that one reintroduces the false positives FORECAST-14 measured.
      const nearFuture = md(sentence.slice(Math.max(0, m.index - 80), m.index));
      out.push({
        value: Math.abs(value), sentence: sentence.trim(), hedged: HEDGE_RE.test(before),
        cashClaim: CASH_CLAIM_RE.test(near) || SPENDABILITY_RE.test(afterWide),
        endingClaim: ENDING_CLAIM_RE.test(near),
        historical,
        // PARITY-3 — a value AT a future point: the sentence names one, the
        // framing before the figure asserts a value at it, and nothing frames
        // the figure as a present fact. All three, because any two of them
        // describe a correct sentence.
        futureValue: (futureSection
          || INHERENTLY_FORWARD_RE.test(nearFuture)
          || (FUTURE_POINT_RE.test(sentence) && FUTURE_VALUE_FRAME_RE.test(nearFuture)))
          && !CURRENT_FRAME_RE.test(near),
        isRateMention: /^\s*(?:\/|per\s|a\s|each\s|every\s)?\s*(?:month|mo\b|week|year|28 days)/i
          .test(after) || RATE_FRAME_RE.test(near),
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
  current: readonly CurrentAuthorityFigure[] = [],
  projected: readonly CurrentAuthorityFigure[] = [],
): ForecastGuardFinding[] {
  const licensed = licensedFigures(forecast, current, projected);
  const figures = replyFigures(reply);
  const findings: ForecastGuardFinding[] = [];
  const seen = new Set<number>();

  const endingRefused = forecast.fullCashPath.status === ConclusionStatus.REFUSED;

  for (const fig of figures) {
    if (seen.has(fig.value)) continue;
    // ⚠️ HISTORY IS OUT OF SCOPE, ENTIRELY. Not "allowed if licensed" — the
    // forecast licence has nothing to say about what the user spent last month.
    if (fig.historical) continue;
    // Investment values belong to CF-7, not to this boundary — unless the
    // sentence claims they are spendable, which is a cash claim about them.
    if (INVESTMENT_CONTEXT_RE.test(fig.sentence) && !SPENDABILITY_RE.test(fig.sentence)) continue;
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

    // ── 0b. A value asserted about a FUTURE date, with no licence that reaches it ──
    //
    // ⚠️ THE AUTHORITY IS THE TEST, NOT THE TEXT. The question this rule asks is
    // "does a current-turn deterministic licence cover a claim about that date?"
    // — never "is this number in the prompt". A figure the model invented last
    // turn is unlicensed for the same reason an invented one this turn is: no
    // authority produced it. And a CURRENT licence deliberately does NOT satisfy
    // it, which is the whole distinction — today's net worth is a fact about
    // today and says nothing about December.
    if (fig.futureValue && !fig.isRateMention) {
      const future = licensed.find((l) => l.horizon === FigureHorizon.FUTURE
        && licenceFor(fig.value, [l], fig.hedged) !== null);
      if (!future) {
        seen.add(fig.value);
        findings.push({
          kind: 'FUTURE_VALUE_WITHOUT_LICENCE', value: fig.value, evidence: fig.sentence,
          claim: `${money(fig.value)} as a value at a future date — no forecast this turn `
            + 'licenses a figure for that date, and a number stated earlier in this '
            + 'conversation is not a licence',
        });
        continue;
      }
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

  // ⚠️ AND THE STATED-BUT-NOT-CASH AMOUNTS. Measured: the model summed a
  // $15,500 GROSS bonus and a $1,500 unknown-basis payout into "$17,000 of
  // cash", the guard caught it, and redaction removed the only sentence that
  // named either amount — so the answer lost the honest half of the fact along
  // with the dishonest half. They are deterministic; they come back with the
  // caveat that makes them sayable.
  const notCash = forecast.events.filter((e) => e.included && e.cashDelta === null
    && e.authoritativeAmount);
  if (notCash.length > 0) {
    out += `\n\nStated but NOT counted as cash: ${notCash
      .map((e) => `${money(e.authoritativeAmount!.value)} on ${e.dateISO} `
        + `(${e.authoritativeAmount!.basis} basis)`).join('; ')}.`;
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
  current: readonly CurrentAuthorityFigure[] = [],
  /** PROJECTION-1 — deterministic FUTURE figures from the evidence-based path. */
  projected: readonly CurrentAuthorityFigure[] = [],
): { reply: string; outcome: string; findings: readonly ForecastGuardFinding[] } {
  const findings = detectUnlicensedForecastArithmetic(reply, forecast, current, projected);
  if (findings.length === 0) return { reply, outcome: 'clean', findings };
  if (mode !== 'repair') return { reply, outcome: `${mode}:${findings.length}`, findings };

  const redacted = redactUnlicensed(reply, findings, forecast);
  const still = detectUnlicensedForecastArithmetic(redacted, forecast, current, projected);
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
