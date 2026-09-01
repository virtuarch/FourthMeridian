/**
 * lib/reasoning/verify/verify.ts
 *
 * V26-REASONING Slice 1 — VERIFICATION AS AN IDENTITY CHECK.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `numerical-guard.ts` carries ~450 lines that read the model's English back and
 * try to reconstruct what it meant: stateful section scoping, five different
 * character-window sizes, a cash-claim vocabulary, a hedge vocabulary, a
 * historical-section detector, an ending-claim detector. `output-validator.ts`
 * carries a tolerance ladder beside it. `assessment-guard.ts` carries a third
 * reader. All three exist for one reason — the model was never able to say what
 * it meant, so we inferred it.
 *
 * What is here instead:
 *
 *     for each claim:
 *         fid must exist
 *         Number-of(claim.statedAs) must equal figure.value
 *         claim.statedAs must RENDER figure.unit
 *     for each currency / percent / months token in prose:
 *         must appear as some claim.statedAs
 *
 * ⚠️ EXACT. NO TOLERANCE LADDER, NO HEDGE VOCABULARY, NO SECTION SCOPING. Those
 * mechanisms are all answers to the question "did the model mean this number as
 * a claim?", and that question has an answer now: the model said so.
 *
 * ⚠️ AND NO "OR ANY NUMBER THE USER TYPED" ESCAPE. That hatch exists once
 * already — `output-validator.ts:159-161` reconciles against
 * `collectSourceValues(systemPrompt, userMessages)` — and the audit recorded its
 * cost. Numbers the user typed reach this verifier the same way every other
 * number does: as an addressed PREMISE figure with a unit.
 */

import {
  statedAsRendersUnit, renderFigure, type FigureTable, type LicensedFigure,
} from '../figures/types';
import type { Answer, VerificationFailure } from '../answer/types';

/**
 * Every figure token the prose can be read to state.
 *
 * ⚠️ MONEY, PERCENT AND MONTH COUNTS — the three dimensions a financial claim is
 * made in. Dates, plain counts and day spans are not swept, so "7 paychecks",
 * "92 days" and "2026-11-28" pass through untouched. That is the same scope
 * `numerical-guard.ts` settled on after measuring, and it is right for the same
 * reason: this boundary is about financial claims, not about digits.
 */
const PROSE_TOKEN_RE =
  /(?:\$|\bUSD\s*)-?\d[\d,]*(?:\.\d+)?(?:\s*(?:\/|per|a|each)\s*(?:month|mo\b|year|yr\b))?|-?\d[\d,]*(?:\.\d+)?\s*(?:%|percent\b|months?\b)/gi;

/** Markdown emphasis is presentation and is never part of a claim. */
const stripMd = (t: string) => t.replace(/\*+|_{2,}|`/g, '');

/**
 * The number a rendering states.
 *
 * ⚠️ ONE NUMBER PER STRING, AND A SECOND ONE IS A FAILURE RATHER THAN A CHOICE.
 * `statedAs: "$5,000 x 3 = $15,000"` must not quietly verify against the first
 * of its numbers.
 */
export function valueOf(statedAs: string): number | null {
  const digits = stripMd(statedAs).match(/-?\d[\d,]*(?:\.\d+)?/g);
  if (!digits || digits.length !== 1) return null;
  const n = Number(digits[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Values compared as money, not as floats.
 *
 * ⚠️ THIS IS NOT A TOLERANCE LADDER. It is the observation that a figure printed
 * to two decimals cannot round-trip to full f64 precision — the fixture's own
 * payroll level is $5,286.645, and its rendered form is "$5,286.65". So the
 * comparison is at the precision the string was written to, and at no other.
 */
function sameValue(stated: string, f: LicensedFigure): boolean {
  // ⚠️ THE CANONICAL RENDERING IS ACCEPTED FIRST AND UNCONDITIONALLY. It is
  // literally the string the model was shown; rejecting it would be the
  // boundary contradicting the table, which is what the first measurement
  // caught it doing.
  if (normalise(stated) === normalise(renderFigure(f.value, f.unit, f.currency))) return true;
  const parsed = valueOf(stated);
  if (parsed === null) return false;
  const decimals = (stripMd(stated).match(/\.(\d+)/)?.[1] ?? '').length;
  const q = (n: number) => Number(n.toFixed(decimals));
  return q(parsed) === q(f.value) || q(parsed) === q(Math.abs(f.value));
}

export interface VerificationResult {
  ok: boolean;
  failures: VerificationFailure[];
}

export function verifyAnswer(answer: Answer, table: FigureTable): VerificationResult {
  const failures: VerificationFailure[] = [];
  const byId = new Map<string, LicensedFigure>(table.figures.map((f) => [f.fid, f]));

  for (const c of answer.claims ?? []) {
    const f = byId.get(c.fid);
    if (!f) {
      failures.push({
        kind: 'UNKNOWN_FID',
        detail: `claim cites "${c.fid}", which is not a figure you were given this turn`,
        offending: c.statedAs,
      });
      continue;
    }
    if (!sameValue(c.statedAs, f)) {
      failures.push({
        kind: 'VALUE_MISMATCH',
        detail: `${c.fid} is ${f.value}, and the claim states "${c.statedAs}"`,
        offending: c.statedAs,
      });
      continue;
    }
    if (!statedAsRendersUnit(c.statedAs, f.unit)) {
      failures.push({
        kind: 'UNIT_NOT_RENDERED',
        detail:
          `${c.fid} is in ${f.unit} and "${c.statedAs}" does not say so. `
          + (f.unit === 'CURRENCY_PER_MONTH' || f.unit === 'CURRENCY_PER_YEAR'
            ? 'A rate may only be stated as a rate; it is not a balance.'
            : 'A balance may not be stated as a rate.'),
        offending: c.statedAs,
      });
    }
  }

  // ── The sweep: no other escape ────────────────────────────────────────────
  //
  // Every figure token in the prose must be accounted for by a claim. A claim's
  // `statedAs` is matched by NORMALISED TEXT rather than by position, because a
  // figure legitimately appears more than once in an answer and requiring one
  // claim per occurrence would reject correct writing.
  const claimed = new Set(
    (answer.claims ?? []).map((c) => normalise(c.statedAs)),
  );
  for (const m of stripMd(answer.prose ?? '').matchAll(PROSE_TOKEN_RE)) {
    const tok = normalise(m[0]);
    if (claimed.has(tok)) continue;
    // A rate written as "$5,000/month" and claimed as "$5,000 a month" is the
    // same statement; normalisation already folds those. What is NOT folded is
    // a rate claimed as a bare amount, which is the leak this exists to catch.
    failures.push({
      kind: 'UNCLAIMED_FIGURE',
      detail: `"${m[0].trim()}" appears in the answer and no claim accounts for it`,
      offending: m[0].trim(),
    });
  }

  return { ok: failures.length === 0, failures };
}

/**
 * The comparable form of a rendered figure.
 *
 * Folds only presentation: whitespace, markdown, the several spellings of "per
 * month", and the currency word versus the symbol. It folds NOTHING about
 * dimension — "$5,000" and "$5,000/month" normalise differently, on purpose.
 */
function normalise(s: string): string {
  return stripMd(s)
    .toLowerCase()
    .replace(/\busd\s*/g, '$')
    .replace(/(?:\/|\s+(?:per|a|each)\s+)(month|mo)\b/g, '/month')
    .replace(/\bmonthly\b/g, '/month')
    .replace(/(?:\/|\s+(?:per|a|each)\s+)(year|yr|annum)\b/g, '/year')
    .replace(/\bannually\b/g, '/year')
    .replace(/\bpercent\b/g, '%')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * The one repair instruction.
 *
 * ⚠️ IT NAMES THE OFFENCE AND NOTHING ELSE. The figures are not up for
 * re-derivation, and the question is not re-asked. This is the same shape
 * `assessment-guard.ts` proved works: one attempt, then a deterministic
 * fallback, never a loop.
 */
export function buildRepairInstruction(failures: readonly VerificationFailure[]): string {
  const lines = failures.slice(0, 6).map((f) => `  - ${f.detail}`);
  return [
    'YOUR PREVIOUS ANSWER STATED A FIGURE YOU WERE NOT LICENSED TO STATE.',
    '',
    ...lines,
    '',
    'Rewrite the answer. Every figure in your prose must come from the FIGURES',
    'table and must be listed in `claims` with the id it came from and exactly',
    'the text you wrote. If the figure you wanted is not in the table, you may',
    'not state it — say what is withheld and why instead. Do not compute a new',
    'figure from figures in the table.',
  ].join('\n');
}
