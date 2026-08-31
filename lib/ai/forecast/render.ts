/**
 * lib/ai/forecast/render.ts
 *
 * FORECAST-10 — THE FORECAST, AS THE MODEL RECEIVES IT.
 *
 * ⚠️ IT COMPOSES THE EXISTING SERIALIZERS AND WRITES NO FINANCIAL PROSE OF ITS
 * OWN. `describeOperatingState`, `explainPolicy` and `explainForecast` were
 * built and measured in FORECAST-7/8/9; reconstructing their sentences here
 * would be a fourth description of the same objects, free to drift from all
 * three. Every number below came out of an authority already labelled.
 *
 * ── Structured labels, not warnings (§14) ───────────────────────────────────
 * The status words — FACTUALLY_LICENSED, ASSUMPTION_DEPENDENT, HYPOTHETICAL,
 * REFUSED — are FORECAST-8's enum, rendered verbatim rather than paraphrased
 * into English cautions. A caution is something a model can decide to
 * de-emphasise; a label on the number is not. Teaching the model to SPEAK about
 * them is FORECAST-11's job, and deliberately not attempted here.
 *
 * ── A refusal is a result (§16) ─────────────────────────────────────────────
 * The section renders whether or not ending cash is licensed. The facts-only
 * real Space produces a REFUSED path and a page of genuinely useful licensed
 * facts — opening cash, seven dated paydays, their nominal amounts, and the two
 * reasons net cash cannot be stated. Omitting the section because the headline
 * number is unavailable would hand the model an empty prompt and an obvious
 * question, which is how a model starts estimating.
 */

import { describeOperatingState } from '@/lib/forecast/operating-state';
import { describeAssertedFacts } from './fact-continuity';
import { explainForecast } from '@/lib/forecast/engine';
import type { AssembledForecast } from './assemble';

/**
 * The forecast block.
 *
 * Ordered state → policy/assumptions → result, because that is the order the
 * numbers depend on each other in: a reader who meets the ending balance first
 * has to work backwards to find out what it rests on.
 */
export function renderForecastSection(a: AssembledForecast): string[] {
  const lines: string[] = ['=== FORECAST ==='];

  if (a.unavailable) {
    // ⚠️ FAIL CLOSED (§29). An assembly failure states that a forecast could
    // not be built. It does not fall through to whatever the rest of the prompt
    // happens to contain, which is how "I couldn't compute this" becomes a
    // confident estimate from balances and a trend line.
    lines.push(`Forecast UNAVAILABLE: ${a.unavailable}.`,
      'Do not estimate a cash path from balances, averages or trends. State that it is unavailable.',
      '=== END FORECAST ===', '');
    return lines;
  }

  lines.push('CURRENT STATE', ...describeOperatingState(a.state));

  // ⚠️ "IN THIS CONVERSATION", not "this turn" — FORECAST-13 made the fact
  // outlive the sentence, and a label saying otherwise would misdescribe where
  // the number came from. Superseded and ambiguous claims are listed too: a
  // correction the user made is worth showing as a correction, and a claim
  // dropped for ambiguity is a question the assistant should ask rather than a
  // silence it should fill.
  const factLines = describeAssertedFacts(a.facts);
  if (factLines.length) {
    lines.push('STATED AS FACT BY THE USER IN THIS CONVERSATION '
      + '(already applied to the authorities above — do not re-apply or re-derive):');
    lines.push(...factLines);
  }

  // ── PROJECTION-1 / PROJECTION-2 — WHICH ANSWER LEADS ──────────────────────
  //
  // ⚠️ THE PRECEDENCE CHANGES WHEN AN ANSWER EXISTS. FORECAST-11's rule that a
  // refusal IS the answer was written for the case where there is nothing else
  // to say. With a projection in hand there is, and rendering the refusal first
  // produced the contradiction measured in the live UI: "I cannot provide a
  // specific ending cash figure" followed immediately by that figure. The
  // unresolved facts are still true and still shown — as a LIMIT on an answer
  // that was given, not as a refusal to give one.
  const proj = a.projection && a.projection.closing !== null ? a.projection : null;

  if (proj) {
    const m = (n: number) => `${proj.currency} ${n.toFixed(2)}`;
    const closing = proj.closing as number;
    lines.push(
      'ANSWER — EVIDENCE-BASED PROJECTION, and what to lead with. NOT a forecast and NOT',
      'what will happen: it continues MEASURED patterns, so speak it conditionally ("if',
      'these patterns continue") and name the window. Never say the user "will have" it.',
      `Projected cash at the end of the horizon: ${m(closing)}.`,
      `From cash of ${m(proj.openingCash ?? 0)} measured today:`,
      ...proj.components.map((c) => `  ${c.label}: ${m(c.value)} — ${c.derivation}.`),
      'Rests on, and the user may reject either:',
      ...proj.assumptions.map((x) => `  - ${x}`),
    );
    const sp = a.observedSpending;
    // ⚠️ ONLY WHERE A MEAN WAS ACTUALLY TAKEN. This disclaimer used to render on
    // every projection, including one whose rate the USER supplied — where there
    // are no "months named" and nothing was averaged, so it described the wrong
    // thing entirely. F6's word is only at risk when the observed mean is in play.
    if (sp) {
      lines.push('The spending figure is NOT a "normal" spending level — that remains UNKNOWN '
        + 'and refused. It is the mean of the months named, nothing more.');
    }
    if (proj.range && sp?.dispersionRatio && sp.dispersionRatio >= 2) {
      lines.push(
        `SPREAD: months averaged ${sp.values.map((v) => v.toFixed(2)).join(', ')} `
        + `(${sp.dispersionRatio.toFixed(1)}x); repeating each gives ${m(proj.range.low)} to `
        + `${m(proj.range.high)}. Give the projected figure as the answer, and say once that `
        + 'spending varies month to month so it is an estimate, not a target.',
      );
    }
    // ⚠️ THE LIMITS ARE NAMED, JUST NOT FIRST. Demoting the licensed refusal made
    // the model drop it entirely, and the corpus caught that: an answer that
    // treats unestablished-basis deposits as cash must say so, or the user cannot
    // tell what they are trusting. Lead with the answer; carry the limit in a
    // clause, not a preamble.
    const limits = 'refused' in a.forecast ? [] : a.forecast.fullCashPath.missing;
    if (limits.length > 0) {
      lines.push(
        'REQUIRED DISCLOSURES — the answer is incomplete without these, however brief. '
        + 'Say each in the user\'s own words after the figure:',
        ...limits.slice(0, 3).map((x) => `  - ${x}`),
      );
    }
    // ⚠️ RE-ADDED. Restructuring dropped this, and the corpus caught it: amounts
    // the projection could not use must still be reported with the authority's
    // own reason, or a GROSS bonus simply disappears from the answer instead of
    // being named as excluded — which is FORECAST-3's whole subject.
    if (proj.excluded.length > 0) {
      lines.push(`EXCLUDED, and say so with the reason: ${proj.excluded.length} amount(s) — `
        + `${[...new Set(proj.excluded.map((e) => e.reason))].slice(0, 2).join('; ')}.`);
    }
    lines.push(
      'HOW TO SAY IT: open with the projected figure in plain language. Then, briefly and '
      + 'in the user\'s words: the opening cash it starts from, what it rests on, the '
      + 'limits and exclusions above, and that spending varies. Do NOT open by saying you '
      + 'cannot provide a figure. Do NOT print this section\'s vocabulary (standings, '
      + 'authorities, day counts). Every one of those disclosures is required — leading '
      + 'with the answer is not permission to drop them.',
    );
  }

  if ('refused' in a.forecast) {
    lines.push(proj ? 'STRICTER FORECAST (not the answer here):' : '',
      `RESULT: no forecast — ${a.forecast.reason}.`);
  } else if (proj) {
    // Demoted: the same deterministic content, framed as the remaining limit.
    lines.push(
      'STRICTER FORECAST — what a fully licensed one would additionally need. A LIMITATION',
      'on the answer above, never a refusal to answer. Mention briefly, never first:',
      ...explainForecast(a.forecast),
    );
  } else {
    lines.push('RESULT', ...explainForecast(a.forecast));
  }

  lines.push('=== END FORECAST ===', '');
  return lines;
}
