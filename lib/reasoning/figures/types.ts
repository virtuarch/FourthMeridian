/**
 * lib/reasoning/figures/types.ts
 *
 * V26-REASONING Slice 1 — EVERYTHING THE MODEL MAY STATE, WITH AN ADDRESS.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Today the pipeline flattens typed truth into English, and then
 * `lib/ai/forecast/numerical-guard.ts` spends ~450 lines of regex — with
 * stateful section scoping, five different character-window sizes and a stray
 * CJK character in a hedge vocabulary — trying to reconstruct the types back
 * out of the model's prose. That entire layer exists because THE MODEL WAS
 * NEVER GIVEN A WAY TO SAY WHAT IT MEANT. This gives it one.
 *
 * ── THE ADDRESS DETERMINES THE MEANING ──────────────────────────────────────
 * A number the user typed is not a number the system may use. This is the same
 * lesson `FigureHorizon` learned at the CURRENT/FUTURE axis after PARITY-3
 * measured a net-worth follow-up rebuilding on an invented projection five times
 * out of five, in both entry modes, past every existing rule:
 *
 *     "ROLE ALONE COULD NOT HOLD THE LINE ... no amount of conversational
 *      history can mint a licence."
 *
 * `kind` is that axis for provenance, and `unit` is that axis for dimension.
 * There is NO "or any number the user typed" escape hatch — that hole already
 * exists once, in `output-validator.ts`'s `collectSourceValues(systemPrompt,
 * userMessages)`, and the audit already recorded its consequence: a user who
 * types "I have $50,000 saved" mints a licence the model can assert as fact.
 */

import { FigureRole, type FigureRoleKind } from '@/lib/ai/forecast/numerical-guard';

export { FigureRole };
export type { FigureRoleKind };

/**
 * WHO PRODUCED THE NUMBER.
 *
 * Two members, and the second is the whole point of the axis.
 */
export const FigureKind = {
  /** Produced by an authority. May be asserted as a fact about the user's money. */
  MEASURE: 'MEASURE',
  /** Stated by the user. May be RESTATED as their premise, and nothing else. */
  PREMISE: 'PREMISE',
} as const;
export type FigureKindName = typeof FigureKind[keyof typeof FigureKind];

/**
 * WHAT DIMENSION THE NUMBER IS IN — and this is the field doing the structural
 * work that a semantic-role system would otherwise have to do by reading prose.
 *
 * ⚠️ RATE UNITS ARE DISTINCT FROM STOCK UNITS, AND `statedAs` MUST RENDER THEM.
 * The risk is concrete: a user says "assume I spend $5,000/month", and `$5,000`
 * must not thereby become sayable as projected savings, as ending debt, or as
 * investment growth. Policing that by SEMANTIC ROLE means reading prose, which
 * is the thing this slice exists to stop doing. Unit does it structurally
 * instead — a monthly rate is a different unit from a stock of money, a claim's
 * rendering must carry the unit, and so the only sentence that premise can
 * license is one that says "$5,000/month". "Your projected savings will be
 * $5,000" can cite no fid, and therefore cannot be written.
 */
export const FigureUnit = {
  CURRENCY:           'CURRENCY',
  CURRENCY_PER_MONTH: 'CURRENCY_PER_MONTH',
  CURRENCY_PER_YEAR:  'CURRENCY_PER_YEAR',
  MONTHS:             'MONTHS',
  RATIO:              'RATIO',
  PERCENT:            'PERCENT',
  COUNT:              'COUNT',
} as const;
export type FigureUnitName = typeof FigureUnit[keyof typeof FigureUnit];

/** WHEN the figure is true of. Carried forward unchanged from PARITY-3. */
export const FigureHorizon = { CURRENT: 'CURRENT', FUTURE: 'FUTURE' } as const;
export type FigureHorizonName = typeof FigureHorizon[keyof typeof FigureHorizon];

/**
 * HOW STRONGLY a figure may be said.
 *
 * ⚠️ FOUR MEMBERS, NOT FIVE. Unresolvedness is NOT a standing — a figure that
 * cannot be resolved has no value and therefore no standing, and belongs in the
 * WITHHELD list with a `RefusalCode`. Representing "unknown" as a fifth standing
 * is how `value: null` comes to sit beside a confident label.
 */
export const Standing = {
  /** Provider fact, or a deterministic calculation over provider facts. */
  MEASURED:              'MEASURED',
  /** Measured patterns carried forward. */
  OBSERVED_CONTINUATION: 'OBSERVED_CONTINUATION',
  /** Priced by an assumption. `basis` is REQUIRED and is the user's own words. */
  ASSUMPTION_DEPENDENT:  'ASSUMPTION_DEPENDENT',
  /** A counterfactual the user asked to see. Never a claim about their money. */
  HYPOTHETICAL:          'HYPOTHETICAL',
} as const;
export type StandingKind = typeof Standing[keyof typeof Standing];

export interface LicensedFigure {
  /** Stable within the turn. `f01…` for a MEASURE, `p01…` for a PREMISE. */
  fid:      string;
  kind:     FigureKindName;
  value:    number;
  unit:     FigureUnitName;
  currency?: string;
  /**
   * MEASURE: "projected ending cash 2026-12-31".
   * PREMISE: "the $5,000/month spending level you assumed".
   */
  label:    string;
  horizon:  FigureHorizonName;
  standing: StandingKind;
  /**
   * ⚠️ CARRIED FORWARD, NOT REPLACED BY `unit` (an honest limit of this slice).
   *
   * FORECAST-3's distinction is real and `unit` does not subsume it: $15,500 is
   * a GROSS bonus, sayable as a stated amount and NOT as money arriving, and
   * both readings are `CURRENCY`. The plan's argument that unit does the work
   * structurally is right about the rate-versus-stock axis and does not reach
   * this one. So the EXISTING `FigureRole` enum is carried on the figure and
   * rendered with its caveat in the table — a reused vocabulary, not a new one —
   * and the verifier does not check it. What the verifier enforces is identity,
   * unit, horizon and kind; what the table carries is everything the model needs
   * to choose the right sentence.
   */
  role:     FigureRoleKind;
  /**
   * For ASSUMPTION_DEPENDENT and HYPOTHETICAL: THE USER'S OWN WORDS.
   *
   * ⚠️ THE USER'S, AND NOBODY ELSE'S. The table used to set this to
   * `args.framing?.[0]` — the first item of an unrelated list — so a figure
   * resting on a SYSTEM fallback about debt was rendered as
   * `- the user said: "assume I spend $5,000/month"`. Attributing to somebody an
   * assumption they never made is worse than disclosing nothing.
   */
  basis?:   string;
  /**
   * SYSTEM_POLICY fallbacks that priced this figure, in the system's own words.
   *
   * Kept apart from `basis` because they are a different authority. See
   * `Measure.systemAssumptions`, where the sentence is built.
   */
  systemAssumptions?: readonly string[];
}

/** Stated withholdings — what may NOT be said, and why. */
export interface LicensedRefusal {
  /** "ending cash", "months of coverage". Empty for an aggregate-only refusal. */
  subject: string;
  code:    import('../refusal').RefusalCode;
  /** Rendered verbatim; the model may quote it. */
  detail:  string;
}

/** Everything this turn licenses, in one object. */
export interface FigureTable {
  figures:  LicensedFigure[];
  withheld: LicensedRefusal[];
}

// ── Rendering the unit ───────────────────────────────────────────────────────

/**
 * Whether `statedAs` renders `unit`.
 *
 * ⚠️ THIS IS THE WHOLE OF THE PREMISE-LEAK DEFENCE, so it is exact and it is
 * one function. A `CURRENCY_PER_MONTH` premise can be restated as
 * "$5,000/month", "$5,000 a month", "$5,000 per month" or "$5,000 monthly", and
 * can NEVER satisfy a claim written as "$5,000".
 *
 * Deliberately NOT a tolerance ladder and NOT a hedge vocabulary. It answers one
 * question about one string.
 */
/**
 * The per-period marker, as a regex SOURCE fragment.
 *
 * ⚠️ EXPORTED BECAUSE THE TWO SIDES OF THE BOUNDARY DISAGREED ABOUT IT. This
 * check accepted `"$5,000.00 monthly"` as rendering CURRENCY_PER_MONTH while the
 * verifier's prose sweep could not tokenise the word `monthly` at all — so the
 * sweep saw a bare `$5,000.00`, the claim said `$5,000.00 monthly`, they did not
 * match, and a correct answer was discarded. A token is whatever BOTH sides say
 * it is, or it is nothing.
 */
export const PER_MONTH_SRC = '(?:\\/|\\bper\\b|\\ba\\b|\\beach\\b|\\bevery\\b)\\s*(?:month|mo\\b)|\\bmonthly\\b';
export const PER_YEAR_SRC  = '(?:\\/|\\bper\\b|\\ba\\b|\\beach\\b|\\bevery\\b)\\s*(?:year|yr\\b|annum)|\\bannually\\b';

const PER_MONTH_RE = new RegExp(PER_MONTH_SRC, 'i');
const PER_YEAR_RE  = new RegExp(PER_YEAR_SRC, 'i');
const MONTHS_RE    = /\bmonths?\b/i;
const PERCENT_RE   = /%|\bpercent\b/i;

export function statedAsRendersUnit(statedAs: string, unit: FigureUnitName): boolean {
  const s = statedAs.trim();
  const perMonth = PER_MONTH_RE.test(s);
  const perYear  = PER_YEAR_RE.test(s);
  switch (unit) {
    case FigureUnit.CURRENCY:
      // A stock of money must NOT be dressed as a rate, and must not be dressed
      // as a duration or a proportion either.
      return !perMonth && !perYear && !PERCENT_RE.test(s) && !MONTHS_RE.test(s);
    case FigureUnit.CURRENCY_PER_MONTH: return perMonth && !perYear;
    case FigureUnit.CURRENCY_PER_YEAR:  return perYear && !perMonth;
    case FigureUnit.MONTHS:             return MONTHS_RE.test(s);
    case FigureUnit.PERCENT:            return PERCENT_RE.test(s);
    // A ratio and a count render as bare numbers; there is no marker to require,
    // so the identity check is the whole check for them.
    case FigureUnit.RATIO:
    case FigureUnit.COUNT:              return true;
  }
}

// ── One rendering edge ───────────────────────────────────────────────────────

/**
 * The canonical rendering of a figure.
 *
 * ⚠️ ONE FUNCTION, AND THE FIRST MEASUREMENT IS WHY. The table printed
 * `$37,006.52` (via `toLocaleString`) for a value of 37006.515 while the
 * verifier accepted only `$37,006.51` (via `toFixed`), because f64 stores that
 * value as 37006.51499… and the two rounders disagree about it. So the model was
 * SHOWN a number and then REJECTED for writing it back — twice in seven cases,
 * on the fixture's own $5,286.645 payroll level, which is exactly the half-cent
 * `engine.ts`'s D-4 note exists to warn about:
 *
 *     "money() below is that edge and the ONLY place a figure is rounded."
 *
 * This is that edge for the reasoning layer. The renderer prints it, the
 * deterministic fallback prints it, and the verifier accepts it — three callers,
 * one rounding, no way for them to disagree.
 */
export function renderFigure(
  value: number, unit: FigureUnitName, currency?: string,
): string {
  const sym = currency === 'USD' || currency === undefined ? '$' : `${currency} `;
  // ⚠️ THE SIGN GOES OUTSIDE THE CURRENCY SYMBOL. This used to emit
  // `$-4,000.00`, which nobody writes, while the sweep rejected the natural
  // `-$4,000.00` — so the only renderings a negative figure could verify against
  // were the malformed one and the sign-flipped one that `sameValue` wrongly
  // accepted. Both halves of that are fixed; this is the rendering half.
  const abs = Math.abs(Number(value.toFixed(2)));
  const sign = Number(value.toFixed(2)) < 0 ? '-' : '';
  const money = `${sign}${sym}${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
  switch (unit) {
    case FigureUnit.CURRENCY:           return money;
    case FigureUnit.CURRENCY_PER_MONTH: return `${money}/month`;
    case FigureUnit.CURRENCY_PER_YEAR:  return `${money}/year`;
    case FigureUnit.MONTHS:             return `${Number(value.toFixed(1))} months`;
    case FigureUnit.PERCENT:            return `${Number(value.toFixed(1))}%`;
    case FigureUnit.RATIO:
    case FigureUnit.COUNT:              return String(Number(value.toFixed(2)));
  }
}
