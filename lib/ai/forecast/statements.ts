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

import { PeriodBasis, type PeriodBasisKind } from '@/lib/forecast/spending-baseline';
import { AmountBasis, FlowRole } from '@/lib/forecast/future-cash-event';
import { resolveExplicitDate } from './horizon';
import { MAGNITUDE_SRC, scaleOf } from '@/lib/reasoning/figures/magnitude';
import {
  StatementMode, routeStatement,
  type Routing, type StatementModeKind, type StatementSubject, type UserStatement,
} from '@/lib/forecast/policy';

/** Explicit supposition. The user is asking for arithmetic, not stating a fact. */
const ASSUME_RE = /\b(assume|assuming|suppose|supposing|pretend|if i (?:were to )?(?:spend|earn|make|get)|what if|say (?:i|my)|hypothetical(?:ly)?)\b/i;
/** Explicit counterfactual exploration. */
const SCENARIO_RE = /\b(show me (?:a |the )?(?:scenario|case|version|world)|scenario where|what (?:would happen|happens) if|worst.case|best.case|model a)\b/i;

// ⚠️ THE GAP IS `[^;!?]`, NOT `[^.]`, AND A MEASURED MODEL RUN FOUND OUT WHY.
// These patterns originally excluded `.` to stop a match running past a
// sentence end. But a money figure CONTAINS periods — "$5,286.645" — so
// "My Vectrus paycheck is $5,286.645 take-home" could never match: the class
// stopped dead at the decimal point in the user's own number, and the truthful
// assertion silently became no assertion at all. FORECAST-11's trace C caught
// it: the model correctly refused a forecast the user had just supplied both
// facts for.
//
// The sentence-end guard was redundant anyway — `extractForecastStatements`
// splits into sentences before matching, so every pattern already runs inside
// one. What remains excludes only the separators a split does not consume.
const GAP = '[^;!?]';
// ⚠️ THE `k` SUFFIX IS PART OF THE NUMBER, AND OMITTING IT WAS A SILENT
// THOUSAND-FOLD ERROR (V26-REASONING Slice 4). "Nah, assume I spend $5K/month"
// — the second turn of the conversation this product exists for — extracted
// $5.00, and the forecast dutifully projected $20.53 of spending over four
// months and an ending balance of $57,788. Nothing refused, nothing flagged: the
// number was licensed, the arithmetic was correct, and the premise was wrong by
// three orders of magnitude.
//
// This is the same lesson the GAP comment below records at a different
// character: a pattern that cannot read the user's own notation does not fail
// loudly, it silently reads something else. `$5K`, `$5k`, `$1.5M` are all
// notations people type.
// ⚠️ AND THE SUFFIX HAS A RIGHT EDGE, WHICH THIS PATTERN DID NOT HAVE. Written
// as `([kKmM])?` it consumed the `m` beginning the NEXT WORD, so
//
//     "Assume I spend $5,000 monthly."   -> a spending level of $5,000,000,000
//     "Assume I spend $1,200 mortgage…"  -> a spending level of $1,200,000,000
//
// reached the FORECAST ENGINE — not the typed layer, the engine, on the path
// that serves users today. The grammar now comes from the one shared authority
// (`lib/reasoning/figures/magnitude`), which is boundary-anchored on both sides
// and also reads the word forms: `$50 million` is fifty million, and
// `$5,000 monthly` is five thousand.
const MONTHLY_SPEND_RE = new RegExp(
  `(?:spend|spending|spends|burn|outgoings?|expenses?)\\b[^$;!?]{0,40}\\$\\s?([\\d,]+(?:\\.\\d+)?)${MAGNITUDE_SRC}\\s*(?:a|per|/|each)?\\s*(month|mo\\b|28 days|week|year|monthly|annually)?`, 'i');
const SPEND_AMOUNT_FIRST_RE = new RegExp(
  `\\$\\s?([\\d,]+(?:\\.\\d+)?)${MAGNITUDE_SRC}\\s*(?:a|per|/|each)\\s*(month|mo\\b|week|year)\\b${GAP}{0,30}\\b(?:spend|spending|of (?:normal |ordinary )?spending|in spending)`, 'i');

/**
 * A bare amount that revises something already under discussion.
 *
 * ⚠️ IT FIRES ONLY WITH AN ANTECEDENT (§4, §I). "Actually make that $5,000" and
 * "What if it were $10,000?" name no subject at all — they are corrections and
 * suppositions ABOUT the spending level the conversation has already
 * established, and read alone they mean nothing. So the caller supplies whether
 * a spending level is under discussion, and without one the sentence produces
 * no claim rather than a guessed one. That is the whole of the anaphora
 * supported here: no pronoun resolution, no topic model, one antecedent.
 */
const ANAPHORIC_AMOUNT_RE = new RegExp(
  `\\b(?:actually,?\\s+)?(?:make (?:that|it)|change (?:that|it) to|what if it (?:were|was)|let'?s say|say)`
  + `\\s+(?:it'?s\\s+)?\\$?\\s?([\\d,]+(?:\\.\\d+)?)${MAGNITUDE_SRC}`
  + `|^\\s*actually,?\\s+\\$?\\s?([\\d,]+(?:\\.\\d+)?)${MAGNITUDE_SRC}`, 'i');

/**
 * A basis claim whose SUBJECT is the amount, not a paycheck noun.
 *
 * ⚠️ MEASURED GAP (FORECAST-12 trace C). "No — $5,286.645 is take-home" is how a
 * correction is actually phrased, and every pattern below required the words
 * paycheck / salary / payroll / pay. The truthful correction matched nothing and
 * was discarded, which is what made FORECAST-9A's fact path unreachable in
 * conversation. These forms are deliberately narrow: an explicit amount, a
 * copula, and a basis word. "It's net" is NOT here — there is no amount to
 * identify a stream by, and guessing which stream is the failure §6 forbids.
 */
const AMOUNT_IS_BASIS_RE = new RegExp(
  `(?:that |the |this )?\\$\\s?([\\d,]+(?:\\.\\d+)?)\\s*(?:amount\\s+|figure\\s+)?(?:is|was|=)\\s+(?:my\\s+|the\\s+)?(take[- ]?home|net|after[- ]?tax|gross)\\b`, 'i');

/** A paycheck figure declared net, or an existing one declared net. */
const NET_BASIS_RE = new RegExp(
  `\\b(?:paycheck|pay ?check|salary|payroll|pay)\\b${GAP}{0,60}\\b(?:is|are|of|as)\\b${GAP}{0,30}\\b(take[- ]?home|net|after[- ]?tax)\\b`, 'i');
const NET_BASIS_REVERSED_RE = new RegExp(
  `\\b(take[- ]?home|net|after[- ]?tax)\\b${GAP}{0,40}\\b(?:paycheck|pay ?check|salary|payroll)\\b`, 'i');
const GROSS_BASIS_RE = new RegExp(
  `\\b(?:paycheck|pay ?check|salary|payroll)\\b${GAP}{0,60}\\b(?:is|are)\\b${GAP}{0,20}\\bgross\\b`, 'i');

const num = (s: string) => Number(s.replace(/,/g, ''));
/**
 * A magnitude suffix applied to a parsed amount.
 *
 * ⚠️ ONE HELPER, SO EVERY PATTERN THAT GAINS A SUFFIX GROUP APPLIES IT THE SAME
 * WAY. Two spellings of "thousand" is how one caller comes to read $5K as $5.
 */
const scaled = (n: number, letter: string | undefined, word?: string | undefined): number =>
  n * scaleOf(letter, word);

// ── One-off dated events (FORECAST-17) ──────────────────────────────────────
//
// ⚠️ THE VOCABULARY IS A CLOSED LIST, AND SHORT. Each verb below states a
// direction unambiguously; anything that needs interpretation is absent. There
// is no attempt to read a merchant, a category or a habit into an event — that
// is FORECAST-4's territory for obligations and FORECAST-1/2/5's for recurring
// pay, and a fourth producer guessing at the same questions is how authorities
// start disagreeing.

/** Money arriving. */
// ⚠️ PAST-TENSE FORMS ARE HERE ON PURPOSE. "What if I got $5,000 on October 15"
// is a supposition about the future in the past subjunctive, and excluding
// "got" lost it. A genuinely historical "I got $5,000 on August 1" is refused
// one step earlier, by the date resolver, which never returns a day before the
// as-of — so tense does not have to be policed twice.
const INFLOW_VERB_RE =
  /\b(?:get|got|getting|receive|received|receiving|am getting|'ll get|will get|will receive|be paid|paid out|coming in|expect(?:ing)?)\b/i;
/** Money leaving. */
const OUTFLOW_VERB_RE =
  /\b(?:pay|paying|owe|owing|have to pay|need to pay|due|must pay|will pay|settle)\b/i;

/**
 * The kind of movement, where the sentence names one.
 *
 * ⚠️ A ROLE IS NOT A RECURRENCE CLAIM (FORECAST-3's rule, unchanged). A bonus
 * and a refund are both one-off inflows here; nothing below implies a schedule.
 */
const ROLE_WORDS: { re: RegExp; role: typeof FlowRole[keyof typeof FlowRole];
  direction: 'INFLOW' | 'OUTFLOW' }[] = [
  { re: /\brefunds?\b/i, role: FlowRole.REFUND, direction: 'INFLOW' },
  { re: /\b(?:bonus(?:es)?|payout|severance|commission|back ?pay|settlement|rebate|reimbursement)\b/i,
    role: FlowRole.INCOME, direction: 'INFLOW' },
  { re: /\b(?:bill|invoice|rent|premium|instal?ment|fee)\b/i,
    role: FlowRole.SPENDING, direction: 'OUTFLOW' },
];

/** Basis, only where the sentence states it. Absent ⇒ UNKNOWN, never NET. */
const EVENT_BASIS_RE = /\b(net|after[- ]?tax|take[- ]?home|gross|before[- ]?tax|pre[- ]?tax)\b/i;

/** A figure with a date somewhere in the same sentence. */
const EVENT_AMOUNT_RE = /\$\s?([\d,]+(?:\.\d{1,2})?)/;

/** Recurrence words — a one-off producer must refuse these outright. */
const RECURRING_RE =
  /\b(?:every|each|per|monthly|weekly|biweekly|fortnightly|annually|yearly|recurring|ongoing|a month|a week|a year)\b/i;

/**
 * One dated movement the sentence states explicitly, or null.
 *
 * ⚠️ FAILS CLOSED ON EVERY MISSING PIECE. No amount, no date, no direction —
 * no event. "I might get a $5,000 bonus sometime in October" has an amount and
 * a role and no day, and produces nothing rather than a guessed 15th.
 */
function extractOneOffEvent(
  sentence: string, asOfISO: string,
): Extract<StatementSubject, { kind: 'ONE_OFF_EVENT' }> | null {
  if (RECURRING_RE.test(sentence)) return null;

  const amt = EVENT_AMOUNT_RE.exec(sentence);
  if (!amt) return null;
  const amount = num(amt[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const dateISO = resolveExplicitDate(sentence, asOfISO);
  if (!dateISO) return null;

  // Direction: a role noun decides it; otherwise an explicit verb must.
  const roleHit = ROLE_WORDS.find((r) => r.re.test(sentence));
  const inflowVerb = INFLOW_VERB_RE.test(sentence);
  const outflowVerb = OUTFLOW_VERB_RE.test(sentence);
  let direction: 'INFLOW' | 'OUTFLOW';
  let role: typeof FlowRole[keyof typeof FlowRole];
  if (roleHit) {
    direction = roleHit.direction;
    role = roleHit.role;
  } else if (inflowVerb !== outflowVerb) {
    direction = inflowVerb ? 'INFLOW' : 'OUTFLOW';
    role = inflowVerb ? FlowRole.INCOME : FlowRole.SPENDING;
  } else {
    // ⚠️ BOTH OR NEITHER IS AMBIGUOUS. "I pay the bonus" and a sentence with no
    // verb at all are equally unreadable, and a default direction would be a
    // coin flip over the sign of a cash movement.
    return null;
  }

  const basisWord = EVENT_BASIS_RE.exec(sentence)?.[1] ?? '';
  const basis = /gross|before|pre/i.test(basisWord) ? AmountBasis.GROSS
    : basisWord ? AmountBasis.NET
      // ⚠️ NEVER NET BY DEFAULT. "I get a $15,500 bonus October 15" states an
      // amount and says nothing about deductions; FORECAST-3 has refused to
      // guess that since f849c05 and this does not start.
      : AmountBasis.UNKNOWN;

  return { kind: 'ONE_OFF_EVENT', amount, currency: 'USD', basis, direction, role, dateISO };
}

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
  /**
   * The figure the sentence named, when it named one.
   *
   * ⚠️ IDENTITY, NOT VALUE. A basis claim changes no amount; this is how the
   * claim is matched to the stream it is ABOUT. "$5,286.645 is take-home"
   * belongs to the stream whose established level is $5,286.645 and to no
   * other, however similar another stream's figure happens to be.
   */
  identityAmount: number | null;
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
/**
 * How a basis claim finds the stream it is about.
 *
 * A bare `string` names the stream directly — the pre-FORECAST-13 behaviour,
 * kept so every existing caller and test is unchanged. A function receives the
 * figure the sentence named (or null) and answers with a stream or, on any
 * ambiguity, with null.
 */
export type StreamResolver = string | null | ((identityAmount: number | null) => string | null);

export function extractForecastStatements(
  message: string, asOfISO: string, incomeSourceKey: StreamResolver,
  /**
   * What a bare amount would be revising, when the conversation has established
   * something. Absent ⇒ anaphoric sentences produce nothing.
   */
  antecedent?: { kind: 'SPENDING_LEVEL'; currency: string; periodBasis: PeriodBasisKind },
): ExtractedStatement[] {
  const out: ExtractedStatement[] = [];
  const sentences = message.split(/(?<=[.!?;])\s+|\n+/).filter((s) => s.trim().length > 0);

  let n = 0;
  const push = (
    sentence: string, mode: StatementModeKind, subject: StatementSubject,
    identityAmount: number | null = null,
  ) => {
    const statedAs = sentence.trim();
    const statement: UserStatement = { mode, subject, statedAs, asOfISO };
    out.push({ statedAs, mode, subject, identityAmount,
      routing: routeStatement(statement, `s${n++}`) });
  };
  const streamFor = (identityAmount: number | null): string | null =>
    typeof incomeSourceKey === 'function' ? incomeSourceKey(identityAmount) : incomeSourceKey;

  for (const sentence of sentences) {
    const mode = modeOf(sentence);

    // An explicit spending sentence first; a bare revision only if none matched
    // and the conversation has something for it to revise.
    const anaphor = antecedent ? ANAPHORIC_AMOUNT_RE.exec(sentence) : null;
    const spend = SPEND_AMOUNT_FIRST_RE.exec(sentence) ?? MONTHLY_SPEND_RE.exec(sentence);
    if (!spend && anaphor) {
      const amount = anaphor[1] !== undefined
        ? scaled(num(anaphor[1]), anaphor[2], anaphor[3])
        : scaled(num(anaphor[4]), anaphor[5], anaphor[6]);
      if (Number.isFinite(amount) && amount >= 0) {
        push(sentence, mode, { kind: 'SPENDING_LEVEL', amount,
          currency: antecedent!.currency, periodBasis: antecedent!.periodBasis }, amount);
      }
    }
    if (spend) {
      const amount = scaled(num(spend[1]), spend[2], spend[3]);
      // ⚠️ A weekly or yearly figure is NOT converted here. FORECAST-6 states
      // levels per month or per 28 days and nothing else; silently rescaling a
      // yearly figure into a monthly one would be this file inventing a
      // financial fact, which is precisely what it must not do.
      // Group 4 now: the magnitude contributes TWO groups, not one.
      const unit = spend[4];
      if (Number.isFinite(amount) && amount >= 0 && (!unit || /month|mo|28 days/i.test(unit))) {
        push(sentence, mode, {
          kind: 'SPENDING_LEVEL', amount, currency: 'USD', periodBasis: periodOf(unit),
        });
      }
    }

    // ── One-off dated events ────────────────────────────────────────────────
    //
    // Tried BEFORE the basis claims: "I get a $1,500 net payout on November 1"
    // states an event whose basis happens to be named, not a claim about an
    // income stream's basis.
    const oneOff = extractOneOffEvent(sentence, asOfISO);
    if (oneOff) {
      push(sentence, mode, oneOff, oneOff.amount);
      continue;
    }

    // ── Basis claims ────────────────────────────────────────────────────────
    //
    // The amount-subject form is tried FIRST, because it carries the identity.
    // "My paycheck is $5,286.645 take-home" satisfies both patterns, and the one
    // that names a figure is the one that can be matched to a stream.
    const amountBasis = AMOUNT_IS_BASIS_RE.exec(sentence);
    if (amountBasis) {
      const identity = num(amountBasis[1]);
      const basis = /gross/i.test(amountBasis[2]) ? AmountBasis.GROSS : AmountBasis.NET;
      const sourceKey = streamFor(Number.isFinite(identity) ? identity : null);
      // ⚠️ FAIL CLOSED. No stream, no statement — the claim is dropped rather
      // than attached to a guess.
      if (sourceKey) {
        push(sentence, mode, { kind: 'STREAM_AMOUNT_BASIS', sourceKey, basis },
          Number.isFinite(identity) ? identity : null);
      }
    } else if (NET_BASIS_RE.test(sentence) || NET_BASIS_REVERSED_RE.test(sentence)) {
      const sourceKey = streamFor(null);
      if (sourceKey) {
        push(sentence, mode, {
          kind: 'STREAM_AMOUNT_BASIS', sourceKey, basis: AmountBasis.NET });
      }
    } else if (GROSS_BASIS_RE.test(sentence)) {
      const sourceKey = streamFor(null);
      if (sourceKey) {
        push(sentence, mode, {
          kind: 'STREAM_AMOUNT_BASIS', sourceKey, basis: AmountBasis.GROSS });
      }
    }
  }
  return out;
}
