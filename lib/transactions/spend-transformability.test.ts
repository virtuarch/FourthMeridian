/**
 * lib/transactions/spend-transformability.test.ts — S1-3
 *
 * What a spending CHANGE may be applied to, decided by the vocabulary, never by
 * prompt wording:
 *   · the three semantic classes (DIRECT / WHOLE_BUCKET / RESIDUAL);
 *   · subset words ("restaurants", "rent", "entertainment") are REFUSED with the
 *     bucket that holds them offered whole — never silently widened into it;
 *   · unsupported, structural and governed lines are refused with a reason;
 *   · the alias table is closed and consistent.
 *
 * Standalone tsx script. Pure.
 */

import {
  CATEGORY_VOCABULARY, SPEND_WORD_ALIASES, TRANSFORMABLE_SPEND_CATEGORIES, categoryDefinition,
  isTransformableSpendCategory, resolveTransformableCategory, spendTransformClass, transformableCategoryGuide,
} from './category-vocabulary';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const r = resolveTransformableCategory;

console.log('1. accepted, with the class that says what a change to the line means');
check('Travel and Fee are DIRECT', r('Travel').ok && (r('Travel') as { class: string }).class === 'DIRECT'
  && (r('fee') as { class: string }).class === 'DIRECT');
for (const c of ['Dining', 'Utilities', 'Shopping', 'Subscriptions']) {
  check(`${c} is accepted only as a WHOLE_BUCKET, with its meaning echoed`,
    ((x) => x.ok && x.class === 'WHOLE_BUCKET' && x.meaning === categoryDefinition(c)!.meaning)(r(c)));
}
check('Dining\'s meaning says it holds groceries; Utilities\' says rent',
  /groceries/.test((r('Dining') as { meaning: string }).meaning) && /rent/.test((r('Utilities') as { meaning: string }).meaning));
check('Other is accepted as the RESIDUAL, meaning what it holds', ((x) => x.ok && x.class === 'RESIDUAL'
  && /medical/.test(x.meaning))(r('Other')));
check('a word that means the WHOLE line resolves to it and keeps the user\'s word ("food" → Dining)',
  ((x) => x.ok && x.category === 'Dining' && x.requestedAs === 'food')(r('food')));

console.log('2. subset words are refused and the bucket is OFFERED, never applied');
for (const [word, bucket] of [['restaurants', 'Dining'], ['eating out', 'Dining'], ['rent', 'Utilities'],
  ['flights', 'Travel'], ['clothes', 'Shopping']] as const) {
  const x = r(word);
  check(`"${word}" → refused, SUBSET_OF_BUCKET, offering ${bucket} as a whole`,
    !x.ok && x.reason === 'SUBSET_OF_BUCKET' && x.bucket === bucket
      && new RegExp(`Offer the user ${bucket} AS A WHOLE`).test(x.unavailable) && /Nothing was applied/.test(x.unavailable),
    JSON.stringify(x));
}
check('"restaurants" says what else Dining holds — groceries', ((x) => !x.ok && /groceries/.test(x.unavailable))(r('restaurants')));

console.log('3. unsupported, governed, structural, unknown — refused with the reason');
for (const [word, bucket] of [['Groceries', 'Dining'], ['grocery', 'Dining'], ['Medical', 'Other'], ['entertainment', 'Other'],
  ['Transport', 'Other'], ['PersonalCare', 'Other'], ['Services', 'Other'], ['Education', 'Other'], ['movies', 'Other']] as const) {
  const x = r(word);
  check(`${word} → UNSUPPORTED, offering ${bucket}`, !x.ok && x.reason === 'UNSUPPORTED' && x.bucket === bucket, JSON.stringify(x));
}
check('Interest → GOVERNED_ELSEWHERE, pointing at the debt model', ((x) => !x.ok && x.reason === 'GOVERNED_ELSEWHERE'
  && /liabilityAssumptions/.test(x.unavailable))(r('Interest')));
check('"card interest" is Interest, and refused the same way', ((x) => !x.ok && x.reason === 'GOVERNED_ELSEWHERE')(r('card interest')));
for (const c of ['Income', 'Transfer', 'Payment', 'Buy', 'Sell', 'Dividend', 'Split']) {
  check(`${c} → NOT_SPENDING`, ((x) => !x.ok && x.reason === 'NOT_SPENDING')(r(c)));
}
check('an ambiguous word ("gas", "bills") is UNKNOWN — the user is asked, the table does not guess',
  ['gas', 'bills', 'water', 'delivery'].every((w) => ((x) => !x.ok && x.reason === 'UNKNOWN')(r(w))));

console.log('4. the table is closed and consistent');
check('every alias targets a real category', Object.values(SPEND_WORD_ALIASES).every((a) => categoryDefinition(a.category) !== null));
check('every SUBSET_OF / EQUALS alias targets a TRANSFORMABLE line', Object.values(SPEND_WORD_ALIASES)
  .filter((a) => a.kind !== 'IS').every((a) => isTransformableSpendCategory(a.category)));
check('no alias key shadows a category name', Object.keys(SPEND_WORD_ALIASES)
  .every((k) => !Object.keys(CATEGORY_VOCABULARY).some((c) => c.toLowerCase() === k)));
check('every transformable line has exactly one class; nothing else has one',
  Object.keys(CATEGORY_VOCABULARY).every((c) => (spendTransformClass(c) !== null) === TRANSFORMABLE_SPEND_CATEGORIES.includes(c)));
check('the generated guide names every transformable line and marks the buckets',
  TRANSFORMABLE_SPEND_CATEGORIES.every((c) => transformableCategoryGuide().includes(c))
    && /Dining \(as a whole\)/.test(transformableCategoryGuide()) && /Other \(the catch-all\)/.test(transformableCategoryGuide()));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall spend-transformability checks passed');
