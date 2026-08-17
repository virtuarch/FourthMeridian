/**
 * lib/ai/currency-presentation.test.ts   (REVIEW-3 C-6 — the currency guard)
 *
 * No hard-coded currency symbol may appear in any money string produced under
 * lib/ai/** or app/api/brief/** . The Brief and every AI prompt line used to
 * interpolate a literal `$` (fmtCurrency, fmtMoney, detector titles, engine
 * evidence strings) and never read Space.reportingCurrency — an all-USD corpus
 * made that latent, and exactly latent defects are what a settings change turns
 * live. Money is now formatted through currency-aware formatters
 * (lib/ai/prompts/format.ts fmtMoney(n, currency), lib/currency
 * formatCurrency/currencySymbol) fed from the section/context's own reporting
 * currency.
 *
 * SOURCE SCAN — fails on any re-introduction of a literal dollar sign as a
 * money prefix in code (comments and test files excluded):
 *   · `$${expr}`   — template literal with a hard-coded $ before interpolation
 *   · '"$" + …' / quoted `$` glued to a digit — string-built money
 *
 * `$` inside a plain `${…}` interpolation is of course fine; the scan targets
 * the DOUBLE dollar and quoted-symbol shapes only.
 *
 *     npx tsx lib/ai/currency-presentation.test.ts
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

const ROOT = process.cwd();
const SCAN_ROOTS = [join('lib', 'ai'), join('app', 'api', 'brief')];

const HARD_CODED_SYMBOL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'template literal with hard-coded $ before an interpolation (`$${…}`)', re: /\$\$\{/ },
  { name: 'quoted currency symbol glued to a digit (\'$1…\')', re: /['"`]\$[0-9]/ },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full;
  }
}

/** Strip comment lines so a comment may still cite the old defect verbatim. */
function codeOf(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const offenders: string[] = [];
for (const dir of SCAN_ROOTS) {
  let files: string[] = [];
  try { files = [...walk(join(ROOT, dir))]; } catch { continue; }
  for (const file of files) {
    const code = codeOf(readFileSync(file, 'utf8'));
    for (const { name, re } of HARD_CODED_SYMBOL_PATTERNS) {
      if (re.test(code)) offenders.push(`${relative(ROOT, file)} — ${name}`);
    }
  }
}

check(
  'no hard-coded currency symbol in any money string under lib/ai/** or app/api/brief/**',
  offenders.length === 0,
  offenders.join('\n        '),
);

// The threading itself: the Brief reads the reporting currency; the prompt
// formatter takes a currency parameter; the detectors format via fmtMoney /
// formatCurrency rather than string-building.
{
  const brief = readFileSync(join(ROOT, 'app', 'api', 'brief', 'route.ts'), 'utf8');
  check('the Brief reads the Space reporting currency',
    /reportingCurrency/.test(brief) && /currencySymbol/.test(brief));

  const fmt = readFileSync(join(ROOT, 'lib', 'ai', 'prompts', 'format.ts'), 'utf8');
  check('fmtMoney is currency-parameterised (Intl currency style, no literal symbol)',
    /currency:\s*string\s*=\s*DEFAULT_DISPLAY_CURRENCY/.test(fmt) && /style:\s*'currency'/.test(fmt));

  const snapDetector = readFileSync(join(ROOT, 'lib', 'ai', 'signals', 'detectors', 'snapshot.ts'), 'utf8');
  check('snapshot detector formats via formatCurrency and fires off canonicalChange',
    /formatCurrency\(/.test(snapDetector) && /canonicalChange/.test(snapDetector) &&
    !/netWorthTrend/.test(codeOf(snapDetector)));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll currency-presentation checks passed.');
process.exit(0);
