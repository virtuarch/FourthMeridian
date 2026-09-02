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
  statedAsRendersUnit, renderFigure, FigureKind, PER_MONTH_SRC, PER_YEAR_SRC,
  type FigureTable, type LicensedFigure,
} from '../figures/types';
import { MAGNITUDE_SRC, scaleOf, trailingScale } from '../figures/magnitude';
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
// ⚠️ THE MAGNITUDE SUFFIX AND THE MINUS SIGN BOTH HAD A MISSING EDGE, and both
// cost correct answers.
//
//   `[kKmM]?` with no right boundary tokenised the model's own correct prose
//   "You spend $5,000.00 monthly." as `$5,000.00 m` — an amount that matches no
//   figure — so a good answer was DISCARDED on every sentence containing the
//   word "monthly". The grammar now comes from `../figures/magnitude`, shared
//   with the premise extractor, which had the identical hole.
//
//   `-?` sat INSIDE the currency symbol (`\$-?\d`), so the natural rendering
//   `-$4,000.00` tokenised as `$4,000.00` and could never match a claim written
//   the way a person writes it. A negative balance was unsayable.
const PROSE_TOKEN_RE = new RegExp(
  `-?(?:\\$|\\bUSD\\s*)-?\\d[\\d,]*(?:\\.\\d+)?${MAGNITUDE_SRC}`
  // The rate tail is the SAME grammar `statedAsRendersUnit` accepts. It used to
  // be a hand-copied subset that omitted `monthly` and `annually`, so a claim
  // written the way the unit check permits could never match its own prose.
  + `(?:\\s*(?:${PER_MONTH_SRC}|${PER_YEAR_SRC}))?`
  + '|-?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:%|percent\\b|months?\\b)', 'gi');

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
  const flat = stripMd(statedAs);
  const digits = flat.match(/-?\d[\d,]*(?:\.\d+)?/g);
  if (!digits || digits.length !== 1) return null;
  let n = Number(digits[0].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  // ⚠️ A MINUS BEFORE THE CURRENCY SYMBOL IS STILL A MINUS. `-$4,000.00` is how
  // people write a negative balance, and the digit match above starts at the
  // `4` — so without this the sign is silently dropped and the figure verifies
  // as a POSITIVE four thousand.
  if (n > 0 && /-\s*(?:\$|USD\s*)\s*$/i.test(flat.slice(0, flat.indexOf(digits[0])))) n = -n;
  // The magnitude, from the one shared grammar. See `../figures/magnitude`.
  return n * trailingScale(flat.slice(flat.indexOf(digits[0]) + digits[0].length));
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
  // ⚠️ THE `|| q(parsed) === q(Math.abs(f.value))` CLAUSE THAT USED TO SIT HERE
  // ACCEPTED A SIGN FLIP. A licensed figure of −$4,000 verified against prose
  // reading "$4,000.00" — a projected overdraft narrated as a surplus, which is
  // the worst output this product can produce. It was not even a convenience:
  // `renderFigure` emitted the malformed `$-4,000.00`, the natural `-$4,000.00`
  // was rejected by the sweep, and so the ONLY renderings that verified were the
  // malformed one and the WRONG one. Both halves are fixed; no absolute-value
  // equivalence exists anywhere in this file.
  return q(parsed) === q(f.value);
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
    // ⚠️ A PREMISE MAY BE QUOTED BACK; IT MAY NOT BE ASSERTED. See `Claim.frame`.
    // The unit axis cannot reach this: a supposed $50,000 and a measured $50,000
    // render identically, so only the authority the sentence gives the figure
    // separates them — and only the writer of the sentence knows that.
    if (f.kind === FigureKind.PREMISE && c.frame !== 'ASSUMPTION') {
      failures.push({
        kind: 'PREMISE_AS_FACT',
        detail: `${c.fid} is the user's own supposition (${f.label}). It may be `
          + 'restated as their assumption — "assuming …", "if we use your …" — and '
          + 'may not be asserted as something you measured.',
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

  // ── Anti-vacuity: silence is not an escape ────────────────────────────────
  //
  // ⚠️ A CONFIDENT FINANCIAL CONCLUSION COULD EVADE THE WHOLE BOUNDARY BY NAMING
  // NO NUMBER. `{ claims: [], prose: "You are on track and can comfortably
  // afford it." }` verified clean — nothing for the sweep to catch, nothing for
  // the identity check to check.
  //
  // The rule is deliberately NOT "an answer must state a figure": a refusal, a
  // limitation and a genuinely qualitative reply are all legitimate answers with
  // no number in them. It is "if you state none, cite the withholding you are
  // speaking to" — checked by identity against the table, like everything else
  // here. No sentiment classifier, no prose reading.
  if ((answer.claims ?? []).length === 0 && table.figures.length > 0) {
    const cited = (answer.withheld ?? '').trim();
    const known = table.withheld.some((w) => w.subject.trim() === cited);
    if (!known) {
      failures.push({
        kind: 'VACUOUS',
        detail: cited.length === 0
          ? `you stated no figure and cited no withholding, with ${table.figures.length} `
            + 'figure(s) available. Either state what you were licensed to state, or '
            + 'name the WITHHELD subject you are declining on.'
          : `"${cited}" is not one of this turn's WITHHELD subjects`,
        offending: cited || undefined,
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
  // ⚠️ THE SUFFIX IS FOLDED INTO THE DIGITS, so "$5K/month" and "$5,000/month"
  // normalise identically. They are the same statement, and a sweep that
  // treated them as different would reject the user's own notation quoted back.
  const expanded = stripMd(s).replace(
    // Same two edges as everywhere else: a lone letter, or a whole word.
    /(-?\d[\d,]*(?:\.\d+)?)(?:\s*(k|m)(?![A-Za-z])|\s+(thousand|million|billion)\b)/gi,
    (whole: string, d: string, letter: string | undefined, word: string | undefined) => {
      const n = Number(d.replace(/,/g, ''));
      if (!Number.isFinite(n)) return whole;
      return String(n * scaleOf(letter, word));
    });
  return expanded
    .toLowerCase()
    // ⚠️ THE SIGN IS NORMALISED IN FRONT OF THE SYMBOL, so `-$4,000.00` and the
    // older `$-4,000.00` fold together — and neither folds to the positive.
    .replace(/(^|[\s(])-\s*\$/g, '$1$-')
    .replace(/\$\s*-\s*/g, '$-')
    .replace(/\busd\s*/g, '$')
    .replace(/(?:\/|\s+(?:per|a|each|every)\s+)(month|mo)\b/g, '/month')
    .replace(/\s*\bmonthly\b/g, '/month')
    .replace(/(?:\/|\s+(?:per|a|each|every)\s+)(year|yr|annum)\b/g, '/year')
    .replace(/\s*\bannually\b/g, '/year')
    .replace(/\bpercent\b/g, '%')
    .replace(/\s+/g, '')
    .replace(/(\d)\.00\b/g, '$1')
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
  const vacuous = failures.some((f) => f.kind === 'VACUOUS');
  const premise = failures.some((f) => f.kind === 'PREMISE_AS_FACT');
  return [
    vacuous
      ? 'YOUR PREVIOUS ANSWER REACHED A CONCLUSION WITHOUT STATING A FIGURE.'
      : premise
        ? "YOUR PREVIOUS ANSWER ASSERTED THE USER'S OWN SUPPOSITION AS A FACT."
        : 'YOUR PREVIOUS ANSWER STATED A FIGURE YOU WERE NOT LICENSED TO STATE.',
    '',
    ...lines,
    '',
    'Rewrite the answer. Every figure in your prose must come from the FIGURES',
    'table and must be listed in `claims` with the id it came from, exactly the',
    'text you wrote, and the frame your sentence gives it. If the figure you',
    'wanted is not in the table, you may not state it — say what is withheld and',
    'why instead. Do not compute a new figure from figures in the table.',
    'If you state no figure, set `withheld` to the WITHHELD subject you are',
    "speaking to. A figure under THE USER'S OWN NUMBERS is their supposition and",
    'may only be framed as ASSUMPTION.',
  ].join('\n');
}
