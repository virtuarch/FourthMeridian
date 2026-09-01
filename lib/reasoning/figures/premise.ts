/**
 * lib/reasoning/figures/premise.ts
 *
 * V26-REASONING Slice 1 — A USER'S NUMBER IS A PREMISE, AND A PREMISE IS NOT A
 * FINANCIAL CONCLUSION.
 *
 * ── The hole this closes, which already exists once ─────────────────────────
 * `output-validator.ts:159-161` reconciles a figure against
 * `collectSourceValues(systemPrompt, userMessages)` — that is, it accepts any
 * number that appears anywhere in the conversation. The audit recorded the
 * consequence in one sentence: *a user who types "I have $50,000 saved" mints a
 * licence the model can then assert as fact.*
 *
 * An earlier draft of the reasoning plan re-opened the same hole from the other
 * side, by letting the new verifier pass "any number the user typed in this
 * conversation". It is closed here as follows:
 *
 *   - every number the user states becomes a PREMISE figure with its own `pid`,
 *     its own label IN THE USER'S FRAMING, and A RATE UNIT WHERE IT IS A RATE;
 *   - a number the user typed that did NOT become a premise may not be restated
 *     at all;
 *   - PREMISE and MEASURE share ONE address space, so there is one table and one
 *     claim shape — `kind` is one field, not a second parallel type.
 *
 * ── Why the unit is the safety property ─────────────────────────────────────
 * "Assume I spend $5,000/month" produces `CURRENCY_PER_MONTH`. The verifier
 * requires a claim's `statedAs` to RENDER its figure's unit, so that premise can
 * license the sentence "$5,000/month" and can license no sentence that says
 * "$5,000". A projected saving, an ending debt, an investment growth — all
 * stocks, all `CURRENCY`, none of them citable from a rate. The product the
 * model wants to write ($5,000 x 3 = $15,000) has no address at all.
 *
 * ⚠️ CAPTURE IS GENEROUS; USE IS NARROW. Missing a number the user typed does
 * NOT create a leak — an uncaptured number has no fid and is therefore
 * unsayable. It costs the user a restatement. Capturing one with the WRONG unit
 * is the dangerous direction, so every rate marker is read from the text
 * immediately following the amount and a bare amount stays a stock.
 *
 * ⚠️ THIS IS NOT `statements.ts` AND DOES NOT REPLACE IT. That module answers
 * "did the user assert a fact, suppose something, or ask for a scenario", feeds
 * the forecast policy, and deliberately recognises only three shapes. This
 * answers a smaller and different question — "which numbers did the user put on
 * the table, and in what dimension" — and recognises every one it can see.
 * Slice 5's planner replaces both.
 */

import {
  FigureKind, FigureHorizon, FigureUnit, Standing,
  FigureRole, type LicensedFigure, type FigureUnitName,
} from './types';

/**
 * A money, percent, month-count or bare-count token, with everything that
 * follows it for long enough to see a rate marker.
 *
 * ⚠️ THE DECIMAL POINT IS PART OF THE NUMBER. `statements.ts` records a measured
 * failure where a character class excluded `.` to stop a match running past a
 * sentence end, and thereby could never match `$5,286.645` — the class stopped
 * dead at the decimal point in the user's own figure. The same mistake is
 * available here and is not made.
 */
const MONEY_RE   = /(?:\$|\bUSD\s*)(-?\d[\d,]*(?:\.\d+)?)/gi;
const PERCENT_RE = /(-?\d[\d,]*(?:\.\d+)?)\s*(?:%|\bpercent\b)/gi;
const MONTHS_RE  = /\b(\d[\d,]*(?:\.\d+)?)\s*months?\b/gi;

/** How far past an amount a rate marker still belongs to it. */
const RATE_WINDOW = 18;
const PER_MONTH_RE = /^\s*(?:\/|\bper\b|\ba\b|\beach\b|\bevery\b)?\s*(?:month|mo\b)|^\s*monthly\b/i;
const PER_YEAR_RE  = /^\s*(?:\/|\bper\b|\ba\b|\beach\b|\bevery\b)?\s*(?:year|yr\b|annum)|^\s*annually\b/i;

const num = (raw: string): number | null => {
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * A short quotation of the clause the number came from, so nothing enters the
 * table anonymously.
 *
 * The label is what the model reads when deciding how to speak the figure, so
 * it is the user's own words rather than our paraphrase of them.
 */
function clauseAround(text: string, at: number): string {
  const start = Math.max(0, text.lastIndexOf('.', at) + 1);
  const nlStart = Math.max(start, text.lastIndexOf('\n', at) + 1);
  let end = text.length;
  for (const ch of ['.', '?', '!', '\n']) {
    const i = text.indexOf(ch, at);
    if (i >= 0 && i < end) end = i;
  }
  return text.slice(nlStart, end).trim().replace(/\s+/g, ' ').slice(0, 120);
}

interface RawPremise { value: number; unit: FigureUnitName; index: number; clause: string; }

function scan(text: string): RawPremise[] {
  const out: RawPremise[] = [];
  const push = (value: number | null, unit: FigureUnitName, index: number) => {
    if (value === null) return;
    out.push({ value, unit, index, clause: clauseAround(text, index) });
  };

  for (const m of text.matchAll(MONEY_RE)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + RATE_WINDOW);
    const unit = PER_MONTH_RE.test(after) ? FigureUnit.CURRENCY_PER_MONTH
      : PER_YEAR_RE.test(after) ? FigureUnit.CURRENCY_PER_YEAR
        : FigureUnit.CURRENCY;
    push(num(m[1]), unit, m.index);
  }
  for (const m of text.matchAll(PERCENT_RE)) push(num(m[1]), FigureUnit.PERCENT, m.index);
  for (const m of text.matchAll(MONTHS_RE)) push(num(m[1]), FigureUnit.MONTHS, m.index);
  return out;
}

/**
 * The PREMISE figures for a conversation.
 *
 * ⚠️ EVERY USER TURN, NOT ONLY THE LAST. A premise stated three turns ago is
 * still the user's own words and is still restatable as such — what it is NOT is
 * a licence for arithmetic, and that is enforced by the unit rather than by
 * forgetting it. (The forecast's own assumption continuity is a separate and
 * stricter question, decided by `fact-continuity.ts`; this table says only what
 * the user may hear quoted back.)
 *
 * ⚠️ ASSISTANT TURNS ARE NEVER READ. PARITY-3 measured a net-worth follow-up
 * rebuilding on a figure the assistant had itself invented, five times out of
 * five in both entry modes. A number the model produced last turn is not
 * evidence that it may produce it again.
 */
export function premiseFigures(
  messages: readonly { role: string; content: string }[] | undefined,
  currency = 'USD',
): LicensedFigure[] {
  const seen = new Map<string, LicensedFigure>();
  let n = 0;
  for (const m of messages ?? []) {
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    for (const r of scan(m.content)) {
      // Identity is value + unit: the same amount said twice is one premise,
      // and the same amount said once as a rate and once as a stock is two.
      const key = `${r.value}|${r.unit}`;
      if (seen.has(key)) continue;
      n += 1;
      seen.set(key, {
        fid:      `p${String(n).padStart(2, '0')}`,
        kind:     FigureKind.PREMISE,
        value:    r.value,
        unit:     r.unit,
        currency: r.unit === FigureUnit.PERCENT || r.unit === FigureUnit.MONTHS
          ? undefined : currency,
        label:    `your own words: "${r.clause}"`,
        horizon:  FigureHorizon.CURRENT,
        // ⚠️ A PREMISE IS NOT `MEASURED`. Nothing measured it; the user said it.
        // `ASSUMPTION_DEPENDENT` with the user's clause as its basis is exactly
        // what it is, and it is what makes the standing visible in the table.
        standing: Standing.ASSUMPTION_DEPENDENT,
        role:     r.unit === FigureUnit.CURRENCY_PER_MONTH
          || r.unit === FigureUnit.CURRENCY_PER_YEAR
          ? FigureRole.RATE : FigureRole.STATED_NOT_CASH,
        basis:    r.clause,
      });
    }
  }
  return [...seen.values()];
}
