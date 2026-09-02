/**
 * lib/reasoning/render.ts
 *
 * V26-REASONING Slice 1 — THE TABLE, AND THE FOUR SENTENCES THAT REPLACE THE
 * DOCTRINE.
 *
 * ⚠️ THE INSTRUCTION IS SHORT ON PURPOSE. The current prompt spends ~4,250
 * tokens of doctrine, and most of it exists to say in English what a type can
 * say structurally: which figures are facts, which rest on an assumption, which
 * are about today and which about a date, and what must not be said at all.
 * Once the table says those things, restating them in prose is not belt and
 * braces — it is a second, weaker copy that will drift from the first.
 *
 * What the instruction still has to carry is the one thing the table cannot: how
 * to SPEAK. That a withheld subject is a limitation inside a useful answer
 * rather than the whole answer; that a range is a better answer than a false
 * point estimate; that the user asked a question and deserves one.
 */

import {
  FigureKind, Standing, FigureRole, renderFigure,
  type FigureTable, type FigureUnitName,
} from './figures/types';

/** The one rendering edge; see `renderFigure`. */
const fmt = (value: number, unit: FigureUnitName, currency: string | undefined): string =>
  renderFigure(value, unit, currency);



const STANDING_NOTE: Record<string, string> = {
  [Standing.MEASURED]:              'MEASURED',
  [Standing.OBSERVED_CONTINUATION]: 'OBSERVED PATTERN CARRIED FORWARD',
  [Standing.ASSUMPTION_DEPENDENT]:  'RESTS ON AN ASSUMPTION',
  [Standing.HYPOTHETICAL]:          'HYPOTHETICAL — not a claim about their money',
};

/**
 * The block the model is given in place of the serialized doctrine.
 *
 * ⚠️ `STATED, NOT CASH` IS ITS OWN SECTION BECAUSE UNIT DOES NOT SUBSUME IT.
 * $15,500 is a GROSS bonus: sayable as a stated amount, and NOT as money
 * arriving. Both readings are `CURRENCY`, so the verifier cannot tell them
 * apart — this is the honest limit of the identity check, and the answer is to
 * put the caveat where the model reads the figure rather than to add a fourth
 * prose guard downstream.
 */
export function renderFigureTable(t: FigureTable, framing: readonly string[] = []): string {
  const lines: string[] = [];

  // ⚠️ RULE 1 — EVERY ACTIVE ASSUMPTION APPEARS IN THE ANSWER IT PRICES. First,
  // and as an instruction rather than a note: an assumption the user cannot see
  // is the dangerous one, and an assumption named in every sentence it prices is
  // not. This is what makes carrying assumptions across turns SAFE, and without
  // it the lifecycle would be exactly the stale-assumption defect
  // `fact-continuity.ts` closed by forgetting.
  if (framing.length > 0) {
    lines.push('=== ASSUMPTIONS IN FORCE — you MUST name these in your answer ===');
    for (const f of framing) lines.push(`- the user said: "${f}"`);
    lines.push('Every figure below that rests on one of these is priced BY it.');
    lines.push('Say so plainly, in the same sentence as the figure.');
    lines.push('');
  }
  const measures = t.figures.filter(
    (f) => f.kind === FigureKind.MEASURE && f.role !== FigureRole.STATED_NOT_CASH);
  const stated = t.figures.filter(
    (f) => f.kind === FigureKind.MEASURE && f.role === FigureRole.STATED_NOT_CASH);
  const premises = t.figures.filter((f) => f.kind === FigureKind.PREMISE);

  lines.push('=== FIGURES YOU MAY STATE ===');
  lines.push('id   value                  what it is                          standing');
  if (measures.length === 0) lines.push('  (none this turn)');
  for (const f of measures) {
    lines.push(
      `${f.fid.padEnd(4)} ${fmt(f.value, f.unit, f.currency).padEnd(22)} `
      + `${(f.label + (f.horizon === 'FUTURE' ? ' (a claim about a FUTURE date)' : '')).padEnd(35)} `
      + `${STANDING_NOTE[f.standing] ?? f.standing}`
      // ⚠️ A FUTURE FIGURE THAT IS NOT MEASURED MUST NOT BE CALLED MEASURED, and
      // the standing column alone did not stop it: asked what Bitcoin would be
      // worth, the model wrote a held-flat December figure and added "this is
      // based on measured amounts, not a forecast or scenario". Nothing today
      // measures December. The column says the standing; this says what saying
      // it wrongly would be.
      + (f.horizon === 'FUTURE' && f.standing !== Standing.MEASURED
        ? '  — NOTHING MEASURED THIS; do not call it measured or observed'
        : '')
      + (f.basis ? `  ("${f.basis}")` : ''));
    // ⚠️ ON ITS OWN LINE, AND ATTRIBUTED TO US. A system fallback is not
    // something the user said, and rendering it beside `- the user said:` was
    // the misattribution this pass closed. It is indented under its figure so a
    // reader can see which number it priced.
    for (const a of f.systemAssumptions ?? []) {
      lines.push(`       ↳ WE ASSUMED, and you must say so: ${a}`);
    }
  }

  if (stated.length > 0) {
    lines.push('');
    lines.push('=== STATED AMOUNTS THAT ARE NOT CASH ===');
    lines.push('These are real amounts and you may say they were STATED. You may NOT say');
    lines.push('they are arriving, are available to spend, or are part of a balance.');
    for (const f of stated) {
      lines.push(`${f.fid.padEnd(4)} ${fmt(f.value, f.unit, f.currency).padEnd(22)} ${f.label}`);
    }
  }

  if (premises.length > 0) {
    lines.push('');
    lines.push('=== THE USER\'S OWN NUMBERS ===');
    lines.push('You may quote these back as THEIR premise. They are not findings, and');
    lines.push('nothing may be calculated from them.');
    for (const f of premises) {
      lines.push(`${f.fid.padEnd(4)} ${fmt(f.value, f.unit, f.currency).padEnd(22)} ${f.label}`);
    }
  }

  if (t.withheld.length > 0) {
    lines.push('');
    lines.push('=== WITHHELD — say these as limitations, never as the whole answer ===');
    lines.push('If you state no figure at all, put the SUBJECT line verbatim — the');
    lines.push('quoted text only — into the answer\'s `withheld` field.');
    for (const w of t.withheld) {
      // ⚠️ THE SUBJECT IS QUOTED AND ON ITS OWN LINE because the model is asked
      // to copy it verbatim, and a subject run together with its code and detail
      // on one line got copied whole — costing a repair call on an otherwise
      // correct refusal. What must be copied should look like what must be
      // copied.
      lines.push(`- SUBJECT: "${w.subject}"`);
      lines.push(`    ${w.code} — ${w.detail}`);
    }
  }
  return lines.join('\n');
}

/**
 * The narration instruction. Four rules and a register.
 */
export const TYPED_NARRATION_INSTRUCTION = `
=== HOW TO ANSWER ===

1. EVERY figure you write goes in the claims list - every single one, including ones
   you are quoting back from the user, ones inside a parenthesis, and ones you
   mention only in passing. If you write eight amounts you make eight claims.
   An answer whose prose states a figure the claims list omits is
   DISCARDED WHOLE and the user gets a bare list instead of your answer. This
   is the most common way to lose a good answer, so check before you finish:
   read your own prose, and for each amount, month count or percentage in it,
   confirm there is a claim whose statedAs is exactly that text.

2. Do not calculate. A number you worked out from two figures in the table is
   not in the table, has no id, and may not be written. If the arithmetic the
   user asked for has not already been done for you, say so plainly — that is a
   useful answer, and a computed number is not.

3. A rate is not a balance. "$5,000/month" and "$5,000" are different
   statements, and a figure listed as a rate may only be written as a rate.
   A minus sign is part of the figure too: -$4,000.00 and $4,000.00 are opposite
   statements, and writing the wrong one turns an overdraft into a surplus.

4. A figure about today is not a figure about a future date, however reasonable
   the projection would be.

5. Say whose number it is. Each claim carries a frame:
     FACT        you are asserting it of their money — "Your net worth is X"
     ASSUMPTION  you are supposing it, or quoting theirs — "Assuming X, you'd…"
   A figure under THE USER'S OWN NUMBERS is their supposition, never a
   measurement. You may quote it back; you may not say "you have X" of a number
   they asked you to assume.

6. Anything marked "WE ASSUMED, and you must say so" is an assumption the SYSTEM
   made in order to reach a figure — the user has not agreed to it and cannot see
   it unless you say it. Name it in the same sentence as the figure it priced.

7. If you state no figure at all, that is allowed — a limitation, a refusal or a
   genuinely qualitative answer may need none. But set the withheld field to the
   WITHHELD subject you are speaking to. You may not reach a financial
   conclusion out of nothing.

── A WORKED EXAMPLE, BECAUSE RULE 1 IS THE ONE PEOPLE GET WRONG ──

Suppose the table holds f04 = $37,274.24 (projected cash), p01 = $5,000.00/month
(the user's own words) and f09 = 10% (an illustrative move). You write:

  prose:  "Assuming you spend $5,000/month, you'd have about $37,274.24 by
           December. If it moved 10% the other way, that changes."
  claims: [ {"fid":"p01","statedAs":"$5,000/month","frame":"ASSUMPTION"},
            {"fid":"f04","statedAs":"$37,274.24","frame":"ASSUMPTION"},
            {"fid":"f09","statedAs":"10%","frame":"ASSUMPTION"} ]
  withheld: null

THREE figures in the prose, THREE claims. Notice that the $5,000/month is the
user's own number quoted back and it STILL needs a claim, and that the 10% is a
percentage and it STILL needs a claim. Those two are the ones most often
forgotten, and forgetting either discards the whole answer. Notice too that
p01 is the user's own number, so its frame is ASSUMPTION — and that f04 is
ASSUMPTION as well, because that projection is priced BY p01.

Then answer the question the user actually asked. Speak WITHHELD subjects as
limitations inside a useful answer, not as the answer. If the honest answer is a
range rather than a point, give the range and say why. Do not pad, do not
lecture, and do not refuse a question you can partly answer.
`.trim();
