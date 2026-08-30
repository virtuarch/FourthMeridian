/**
 * lib/ai/forecast/statements.ts
 *
 * FORECAST-10 — "I SPEND $4,000" AND "ASSUME I SPEND $4,000" ARE DIFFERENT SENTENCES.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * FORECAST-8 built `routeStatement`, which sends a fact upstream and keeps a
 * supposition in policy. It takes a TYPED statement — a mode and a subject —
 * and parses nothing, deliberately: "this module has no string matching and no
 * lexicon, for the same reason FORECAST-7 has none."
 *
 * Production has no such typed statement. Measured at 714d099, intent extraction
 * resolves a route and a temporal scope and nothing that could distinguish an
 * assertion from a supposition. So the typing has to happen somewhere, and this
 * is the smallest place: one file, at the edge, that turns a sentence into the
 * struct FORECAST-8 already knows how to route.
 *
 * ⚠️ DELIBERATELY NARROW, AND IT REFUSES RATHER THAN GUESSES. It recognises
 * three shapes — a spending level, a paycheck basis, and an explicit scenario —
 * because those are the three the forecast substrate can actually consume. A
 * sentence it does not recognise produces NOTHING, which costs the user a
 * scenario they must restate and costs them no wrong answer at all. The
 * alternative — a broad extractor that usually gets it right — would put
 * suppositions into the fact authorities, which is the one failure FORECAST-8
 * spent a whole slice making structurally impossible.
 *
 * ── The distinction, mechanically ───────────────────────────────────────────
 *   "assume …", "if I …", "what if …", "say I …"      → REQUESTS_ASSUMPTION
 *   "show me a scenario where …", "what would happen"  → REQUESTS_SCENARIO
 *   anything else that states a figure                 → ASSERTS_FACT
 *
 * The hedge word is the signal, and its ABSENCE is equally a signal: "my normal
 * spending is $4,000" hedges nothing and is a claim about the world.
 */

import { PeriodBasis } from '@/lib/forecast/spending-baseline';
import { AmountBasis } from '@/lib/forecast/future-cash-event';
import {
  StatementMode, routeStatement,
  type Routing, type StatementModeKind, type StatementSubject, type UserStatement,
} from '@/lib/forecast/policy';

/** Explicit supposition. The user is asking for arithmetic, not stating a fact. */
const ASSUME_RE = /\b(assume|assuming|suppose|supposing|pretend|if i (?:were to )?(?:spend|earn|make|get)|what if|say (?:i|my)|hypothetical(?:ly)?)\b/i;
/** Explicit counterfactual exploration. */
const SCENARIO_RE = /\b(show me (?:a |the )?(?:scenario|case|version|world)|scenario where|what (?:would happen|happens) if|worst.case|best.case|model a)\b/i;

/** A money figure with an optional period. */
const MONTHLY_SPEND_RE =
  /(?:spend|spending|spends|burn|outgoings?|expenses?)\b[^.$]{0,40}\$\s?([\d,]+(?:\.\d+)?)\s*(?:a|per|\/|each)?\s*(month|mo\b|28 days|week|year)?/i;
const SPEND_AMOUNT_FIRST_RE =
  /\$\s?([\d,]+(?:\.\d+)?)\s*(?:a|per|\/|each)\s*(month|mo\b|week|year)\b[^.]{0,30}\b(?:spend|spending|of (?:normal |ordinary )?spending|in spending)/i;

/** A paycheck figure declared net, or an existing one declared net. */
const NET_BASIS_RE =
  /\b(?:paycheck|pay ?check|salary|payroll|pay)\b[^.]{0,60}\b(?:is|are|of|as)\b[^.]{0,30}\b(take[- ]?home|net|after[- ]?tax)\b/i;
const NET_BASIS_REVERSED_RE =
  /\b(take[- ]?home|net|after[- ]?tax)\b[^.]{0,40}\b(?:paycheck|pay ?check|salary|payroll)\b/i;
const GROSS_BASIS_RE =
  /\b(?:paycheck|pay ?check|salary|payroll)\b[^.]{0,60}\b(?:is|are)\b[^.]{0,20}\bgross\b/i;

const num = (s: string) => Number(s.replace(/,/g, ''));

function modeOf(sentence: string): StatementModeKind {
  if (SCENARIO_RE.test(sentence)) return StatementMode.REQUESTS_SCENARIO;
  if (ASSUME_RE.test(sentence)) return StatementMode.REQUESTS_ASSUMPTION;
  return StatementMode.ASSERTS_FACT;
}

function periodOf(unit: string | undefined) {
  return unit && /28 days/i.test(unit) ? PeriodBasis.PER_28_DAYS : PeriodBasis.MONTHLY;
}

/** One recognised statement, and where FORECAST-8 says it belongs. */
export interface ExtractedStatement {
  /** The clause it came from, so nothing enters the substrate anonymously. */
  statedAs: string;
  mode: StatementModeKind;
  subject: StatementSubject;
  routing: Routing;
}

/**
 * Read the recognisable forecast statements out of one turn.
 *
 * ⚠️ SENTENCE BY SENTENCE, because a single turn routinely carries one of each:
 * "My paycheck is take-home. Assume I spend $4,000 a month." is a fact and a
 * supposition, and a whole-message mode would have to pick one and be wrong
 * about the other.
 *
 * ⚠️ `sourceKey` IS SUPPLIED BY THE CALLER, never parsed. Which stream a user
 * means by "my paycheck" is a question about their accounts, and guessing it
 * from a sentence would attach an asserted basis to the wrong income. The
 * caller passes the stream the forecast is actually built on, or nothing.
 */
export function extractForecastStatements(
  message: string, asOfISO: string, incomeSourceKey: string | null,
): ExtractedStatement[] {
  const out: ExtractedStatement[] = [];
  const sentences = message.split(/(?<=[.!?;])\s+|\n+/).filter((s) => s.trim().length > 0);

  let n = 0;
  const push = (sentence: string, mode: StatementModeKind, subject: StatementSubject) => {
    const statedAs = sentence.trim();
    const statement: UserStatement = { mode, subject, statedAs, asOfISO };
    out.push({ statedAs, mode, subject, routing: routeStatement(statement, `s${n++}`) });
  };

  for (const sentence of sentences) {
    const mode = modeOf(sentence);

    const spend = SPEND_AMOUNT_FIRST_RE.exec(sentence) ?? MONTHLY_SPEND_RE.exec(sentence);
    if (spend) {
      const amount = num(spend[1]);
      // ⚠️ A weekly or yearly figure is NOT converted here. FORECAST-6 states
      // levels per month or per 28 days and nothing else; silently rescaling a
      // yearly figure into a monthly one would be this file inventing a
      // financial fact, which is precisely what it must not do.
      const unit = spend[2];
      if (Number.isFinite(amount) && amount >= 0 && (!unit || /month|mo|28 days/i.test(unit))) {
        push(sentence, mode, {
          kind: 'SPENDING_LEVEL', amount, currency: 'USD', periodBasis: periodOf(unit),
        });
      }
    }

    if (incomeSourceKey
      && (NET_BASIS_RE.test(sentence) || NET_BASIS_REVERSED_RE.test(sentence))) {
      push(sentence, mode, {
        kind: 'STREAM_AMOUNT_BASIS', sourceKey: incomeSourceKey, basis: AmountBasis.NET,
      });
    } else if (incomeSourceKey && GROSS_BASIS_RE.test(sentence)) {
      push(sentence, mode, {
        kind: 'STREAM_AMOUNT_BASIS', sourceKey: incomeSourceKey, basis: AmountBasis.GROSS,
      });
    }
  }
  return out;
}
