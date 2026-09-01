/**
 * lib/reasoning/scenario/derive.ts
 *
 * V26-REASONING Slice 4 — THE CONVERSATION STATE, DERIVED FRESH EVERY TURN.
 *
 * ⚠️ DERIVE-PER-TURN IS KEPT, AND IT IS THE RIGHT INSTINCT. CF-4 carries the
 * conversation's temporal scope across turns and holds NO state at all —
 * `resolveConversationScope` re-reads the user messages every turn, so there is
 * nothing to desynchronise, nothing to invalidate, and the history is the single
 * source of what the user said. FORECAST-13 mirrored that for facts. This
 * mirrors it for assumptions.
 *
 * What changes is not WHERE assumptions live but HOW LONG they live: they gain a
 * lifecycle instead of expiring at the end of the turn that stated them.
 *
 * ⚠️ USER MESSAGES ONLY. Nothing the assistant said can create an assumption,
 * for the same reason nothing it said can create a fact — and PARITY-3 measured
 * what happens otherwise: a net-worth follow-up rebuilt on an invented
 * projection, five times out of five, in both entry modes.
 *
 * ── ⚠️ THIS EXTRACTOR IS TEMPORARY AND IS MARKED FOR DELETION IN SLICE 5 ─────
 * Interpretation belongs to the planner. `statements.ts` is the existing
 * extractor and recognises exactly three shapes — a spending level, a paycheck
 * basis, an explicit scenario — because those are the three the forecast
 * substrate could consume. The conversation this slice exists to make work needs
 * two more (an investment-return supposition, and "what's realistic though?"),
 * and building them as regexes here is deliberately the SMALLEST thing that
 * demonstrates the lifecycle rather than the RIGHT way to read a sentence.
 *
 * It is quarantined in one file with one export so Slice 5 deletes it whole.
 * Nothing else in `lib/reasoning/**` reads a message.
 */

import { resolveForecastHorizon } from '@/lib/ai/forecast/horizon';
import {
  DeltaDimension, DeltaStatus, BASE,
  type AssumptionDelta, type ConversationState, type DeltaPayload, type LastAnswer,
} from './types';

export interface Turn { role: string; content: string }

// ── The vocabularies. Temporary; see the header. ────────────────────────────

const ASSUME_RE =
  /\b(assume|assuming|suppose|supposing|say i|what if|if i (?:were to )?(?:spend|earn|make)|pretend|nah,?\s*assume)\b/i;

/**
 * ⚠️ "$5K" IS A NUMBER PEOPLE ACTUALLY TYPE AND `statements.ts` CANNOT READ IT.
 * Its money patterns require digits, so "assume I spend $5K/month" — the second
 * turn of the conversation this slice is graded on — extracts nothing at all.
 */
const AMOUNT_RE = /\$\s?([\d,]+(?:\.\d+)?)\s*([kKmM])?/;
const PER_MONTH_RE = /(?:\/|\bper\b|\ba\b|\beach\b)\s*(?:month|mo\b)|\bmonthly\b/i;
const SPEND_RE = /\b(spend|spending|spends|burn|outgoings?|expenses?)\b/i;
const EARN_RE  = /\b(earn|earns|make|income|salary|paid)\b/i;

/** "what if Bitcoin goes up 10%", "if the market drops 5 percent". */
const RETURN_RE =
  /\b(?:if|what if|assume|suppose)\b[^.?!]{0,60}?\b(up|down|rises?|falls?|drops?|gains?|grows?|goes? up|goes? down)\b[^.?!]{0,20}?(-?\d+(?:\.\d+)?)\s*(?:%|percent)/i;
const DOWNWARD_RE = /\b(down|falls?|drops?|goes? down|loses?)\b/i;

/**
 * "Okay, what's realistic though?" — the DISMISS_ALL operation.
 *
 * ⚠️ IT IS NOT A KEYWORD IN THE PRODUCT SENSE. The planner emits `DISMISS_ALL`
 * from meaning, in Slice 5. This pattern exists so the lifecycle can be
 * demonstrated and graded before the planner does.
 */
const DISMISS_ALL_RE =
  /\b(?:what(?:'s| is) realistic|realistically|forget (?:that|those|the assumptions?)|never mind|ignore (?:that|those|the assumptions?)|without (?:those |the |any )?assumptions?|back to (?:reality|normal|base)|actually,? (?:just )?(?:show|tell) me (?:the )?real)\b/i;

function amountIn(text: string): number | null {
  const m = AMOUNT_RE.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] ?? '').toLowerCase();
  return suffix === 'k' ? n * 1_000 : suffix === 'm' ? n * 1_000_000 : n;
}

/** A short quotation of the user's own words, for `statedAs`. */
const quote = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, 120);

/**
 * The deltas one user turn states.
 *
 * Returns [] for a turn that states none, which is the ordinary case and costs
 * the user nothing: a sentence this cannot read produces NO delta rather than a
 * guessed one. That is `statements.ts`'s own rule and it is the right one — a
 * broad extractor that usually gets it right would put suppositions into the
 * fact authorities.
 */
function deltasIn(text: string, turn: number, currency: string): AssumptionDelta[] {
  const out: AssumptionDelta[] = [];
  const sentences = text.split(/(?<=[.?!])\s+|\n+/).filter((s) => s.trim().length > 0);

  for (const [i, raw] of sentences.entries()) {
    const s = raw.trim();

    const ret = RETURN_RE.exec(s);
    if (ret) {
      const magnitude = Number(ret[2]);
      if (Number.isFinite(magnitude)) {
        const signed = DOWNWARD_RE.test(ret[1]) ? -Math.abs(magnitude) : Math.abs(magnitude);
        out.push(mkDelta(DeltaDimension.INVESTMENT_RETURN, turn, i, quote(s),
          { kind: 'RETURN_PCT', pct: signed }));
        continue;
      }
    }

    if (!ASSUME_RE.test(s)) continue;
    const amount = amountIn(s);
    if (amount === null) continue;
    // ⚠️ A MONTHLY LEVEL, OR NOTHING. An amount with no period is not a rate,
    // and reading it as one is the premise-leak defect from the other side.
    if (!PER_MONTH_RE.test(s)) continue;

    if (SPEND_RE.test(s)) {
      out.push(mkDelta(DeltaDimension.SPENDING, turn, i, quote(s),
        { kind: 'MONTHLY_AMOUNT', value: amount, currency }));
    } else if (EARN_RE.test(s)) {
      out.push(mkDelta(DeltaDimension.INCOME, turn, i, quote(s),
        { kind: 'MONTHLY_AMOUNT', value: amount, currency }));
    }
  }
  return out;
}

function mkDelta(
  dimension: AssumptionDelta['dimension'], turn: number, seq: number,
  statedAs: string, payload: DeltaPayload,
): AssumptionDelta {
  return {
    id: `d${turn}_${seq}`,
    dimension, statedAs, statedAtTurn: turn,
    effectiveFrom: null, effectiveUntil: null,
    status: DeltaStatus.ACTIVE,
    payload,
  };
}

/**
 * The conversation state as of the latest turn.
 *
 * ⚠️ SUPERSESSION IS BY DIMENSION, NOT BY VALUE. "Assume I spend $5K/month" and
 * later "make that $6K" are two statements about the SAME dimension, and the
 * later one wins — but the earlier one is kept, flagged SUPERSEDED, with
 * `supersededBy` pointing at its replacement. That is rule 2, and it is why this
 * is not a map of current values.
 *
 * ⚠️ AND `DISMISS_ALL` DISMISSES, IT DOES NOT DELETE. "Okay, what's realistic
 * though?" is a thing the user said at a turn, and a state that erased the
 * assumptions instead of dismissing them could not tell the user what it stopped
 * assuming.
 */
export function deriveConversationState(
  messages: readonly Turn[] | undefined,
  asOfISO: string,
  opts: { currency?: string; lastAnswer?: LastAnswer | null } = {},
): ConversationState {
  const currency = opts.currency ?? 'USD';
  const users = (messages ?? []).filter((m) => m.role === 'user' && typeof m.content === 'string');

  const deltas: AssumptionDelta[] = [];
  let horizon: ConversationState['horizon'] = null;

  for (const [turn, m] of users.entries()) {
    // ⚠️ DISMISS FIRST, THEN COLLECT. A single turn can do both — "forget that,
    // what if it's $6K?" — and dismissing after collecting would dismiss the
    // delta the same sentence just created.
    if (DISMISS_ALL_RE.test(m.content)) {
      for (const d of deltas) {
        if (d.status === DeltaStatus.ACTIVE) d.status = DeltaStatus.DISMISSED;
      }
    }

    for (const fresh of deltasIn(m.content, turn, currency)) {
      for (const prior of deltas) {
        if (prior.status === DeltaStatus.ACTIVE && prior.dimension === fresh.dimension) {
          prior.status = DeltaStatus.SUPERSEDED;
          prior.supersededBy = fresh.id;
        }
      }
      deltas.push(fresh);
    }

    // ⚠️ THE HORIZON IS THE ONE THING THAT ALREADY SURVIVED TURNS, and its rule
    // is unchanged: a turn that names its own period always wins, and this only
    // fills a silence. PROJECTION-1 measured why — "what if I spend $5,000/month
    // instead?" names no period, fell to the 3-month default, and silently
    // answered a 91-day question the user had not asked.
    const h = resolveForecastHorizon(m.content, asOfISO);
    if (h) horizon = { iso: h.toISO, statedAs: h.statedAs, statedAtTurn: turn };
  }

  return {
    turn: Math.max(0, users.length - 1),
    horizon,
    deltas,
    lastAnswer: opts.lastAnswer ?? null,
  };
}

export { BASE };
