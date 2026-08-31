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

  // ⚠️ THE HAND-OFF IS LOAD-BEARING. Measured: with the projection rendered
  // below an unqualified refusal, the model answered turn 1 with the refusal
  // alone and never reached the $42,597.20 the engine had just computed — the
  // refusal says "do not estimate a cash path", and obeying it literally means
  // ignoring a section that is not an estimate. The scope of the refusal has to
  // be stated where the refusal is read.
  if (a.projection && a.projection.closing !== null) {
    lines.push(
      'SCOPE: that refusal is about the LICENSED forecast only. The EVIDENCE-BASED '
      + 'PROJECTION below IS the answer here. Lead with its figure, conditionally ("if '
      + 'these patterns continue"), name its windows, then say what the licensed forecast '
      + 'still needs. Never answer with the refusal alone; never compute your own figure.',
    );
  }

  // ── PROJECTION-1 — the evidence-based path, when the licensed one refused ──
  //
  // ⚠️ AFTER the licensed result and clearly separated, because it is a weaker
  // claim about the same question and the reader must meet the refusal first.
  // Every figure arrives with its window and its transformation, and the block
  // says in as many words that this is not a forecast — a projection narrated
  // without those is indistinguishable from one.
  if (a.projection && a.projection.closing !== null) {
    const p = a.projection;
    const closing = a.projection.closing;
    const m = (n: number) => `${p.currency} ${n.toFixed(2)}`;
    lines.push(
      '',
      'EVIDENCE-BASED PROJECTION (NOT a forecast, NOT what will happen).',
      'It continues patterns MEASURED over stated windows, and is licensed only as "if '
      + 'these patterns continue" — always speak that condition and name the window. Never '
      + 'restate it as an expectation or as a figure the user "will have".',
      `Opening cash: ${m(p.openingCash ?? 0)} (measured today).`,
      // ⚠️ SAID EXPLICITLY, because the licensed section directly above calls the
      // same deposits "stated but NOT counted as cash" and the model repeated
      // that framing while quoting the projection's own inflow total.
      'NOTE: deposits the section above calls "not counted as cash" ARE counted here — '
      + 'there they lack a gross/net basis; here they are included because they were '
      + 'OBSERVED SETTLING into a depository account. The money arrived.',
      ...p.components.map((c) => `  ${c.label}: ${m(c.value)} — ${c.derivation}.`),
      `PROJECTED CASH at horizon end: ${m(closing)}.`,
      // ⚠️ MEASURED LEAK. The conformance corpus caught the model calling this
      // average a "current-normal spending level" — F6's own term, which F6
      // withheld for this user on evidence. The projection may USE the mean; it
      // may never rename it into the thing F6 refused to assert.
      'The average above is NOT a "normal" or "current-normal" spending level — that '
      + 'remains UNKNOWN and refused. It is only the mean of the months named.',
      'Assumptions carried, all of them OBSERVED_CONTINUATION and all rejectable by the user:',
      ...p.assumptions.map((x) => `  - ${x}`),
    );
    // ⚠️ SUPPLEMENTAL, NEVER INSTEAD OF THE CENTRAL FIGURE. Product policy is
    // that the projection answers the question; this exists so a window whose
    // months differ several-fold cannot be read as a settled level.
    const sp = a.observedSpending;
    if (p.range && sp?.dispersionRatio && sp.dispersionRatio >= 2) {
      lines.push(
        `UNCERTAINTY: the ${sp.monthCount} months averaged were `
        + `${sp.values.map((v) => p.currency + ' ' + v.toFixed(2)).join(', ')} — a `
        + `${sp.dispersionRatio.toFixed(1)}x spread. Repeating each of those months instead of `
        + `their average gives ${m(p.range.low)} to ${m(p.range.high)}. State the projected `
        + 'figure as the answer, and mention this spread once as the reason it is approximate.',
      );
    }
    if (p.excluded.length > 0) {
      lines.push(`EXCLUDED from the projection (${p.excluded.length}): `
        + `${[...new Set(p.excluded.map((e) => e.reason))].slice(0, 3).join('; ')}.`);
    }
  }

  lines.push('=== END FORECAST ===', '');
  return lines;
}
