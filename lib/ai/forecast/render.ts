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

  if ('refused' in a.forecast) {
    lines.push(`RESULT: no forecast — ${a.forecast.reason}.`);
  } else {
    lines.push('RESULT', ...explainForecast(a.forecast));
  }

  lines.push('=== END FORECAST ===', '');
  return lines;
}
