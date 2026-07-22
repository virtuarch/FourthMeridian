/**
 * lib/transactions/merchant.test.ts
 *
 * Merchant-normalization coverage (v2.4.5 verification debt — slice c1).
 * Pure, no DB, no LLM, no I/O. Target: normalizeMerchant() in ./merchant.
 *
 * The project has no test runner (no jest/vitest). This is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/ai/output-validator.test.ts and lib/ai/assemblers/transactions.kd17.test.ts:
 *
 *     npx tsx lib/transactions/merchant.test.ts
 *
 * Exits 0 when all cases pass and 1 on failure, so it can be wired into CI.
 *
 * Coverage (per the c1 checklist):
 *   - leading prefix stripping: SQ, TST, PAYPAL, POS DEBIT, ACH, CHECKCARD,
 *     PURCHASE AUTHORIZED
 *   - noise-token removal: long digit runs, masked card tails, "#1234", "xxxx1234"
 *   - preservation of short meaningful numbers ("76", "7")
 *   - conservatism: genuinely distinct merchants never collapse to one key
 *   - display casing: ALL-CAPS → Title Case; already-mixed-case left untouched
 *   - never-empty fallback for pathological / all-noise input
 */

import { normalizeMerchant } from './merchant';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`       ${detail}`);
  }
}

/** Assert both the canonical key and display name for a raw merchant string. */
function expectNorm(raw: string, expectKey: string, expectName: string): void {
  const { canonicalKey, canonicalName } = normalizeMerchant(raw);
  const ok = canonicalKey === expectKey && canonicalName === expectName;
  check(
    `normalize(${JSON.stringify(raw)})`,
    ok,
    ok
      ? undefined
      : `expected key=${JSON.stringify(expectKey)} name=${JSON.stringify(expectName)}; ` +
        `got key=${JSON.stringify(canonicalKey)} name=${JSON.stringify(canonicalName)}`,
  );
}

/** Assert that two raw strings normalize to DIFFERENT canonical keys. */
function expectDistinctKeys(a: string, b: string): void {
  const ka = normalizeMerchant(a).canonicalKey;
  const kb = normalizeMerchant(b).canonicalKey;
  check(
    `distinct keys: ${JSON.stringify(a)} != ${JSON.stringify(b)}`,
    ka !== kb,
    `both collapsed to ${JSON.stringify(ka)}`,
  );
}

/** Assert that neither the key nor the name is ever empty. */
function expectNonEmpty(raw: string): void {
  const { canonicalKey, canonicalName } = normalizeMerchant(raw);
  check(
    `non-empty output for ${JSON.stringify(raw)}`,
    canonicalKey.length > 0 && canonicalName.length > 0,
    `got key=${JSON.stringify(canonicalKey)} name=${JSON.stringify(canonicalName)}`,
  );
}

// ── 1) Leading payment-processor / card-rail prefix stripping ─────────────────
// Each removes only the rail, revealing the real merchant; ALL-CAPS remainder is
// title-cased for display and uppercased for the key.
expectNorm('SQ *COFFEE BAR', 'COFFEE BAR', 'Coffee Bar');           // Square
expectNorm('TST* TACO STAND', 'TACO STAND', 'Taco Stand');         // Toast
expectNorm('PAYPAL *SPOTIFY', 'SPOTIFY', 'Spotify');               // PayPal
expectNorm('POS DEBIT WALMART', 'WALMART', 'Walmart');             // POS debit
expectNorm('ACH DEBIT COMCAST', 'COMCAST', 'Comcast');             // ACH debit/credit
expectNorm('ACH VERIZON', 'VERIZON', 'Verizon');                   // bare ACH
expectNorm('CHECKCARD STARBUCKS', 'STARBUCKS', 'Starbucks');       // CHECKCARD
expectNorm(
  'PURCHASE AUTHORIZED ON 03/14 WHOLE FOODS',
  'WHOLE FOODS',
  'Whole Foods',
); // dated verbose descriptor

// Prefix stripping must not run away: only the leading rail is removed, the rest
// of the merchant name is preserved intact.
expectNorm('POS DEBIT POST OFFICE', 'POST OFFICE', 'Post Office');

// ── 2) Noise-token removal ────────────────────────────────────────────────────
// Store numbers, long digit/reference runs, and masked card tails are dropped.
expectNorm('WALMART 0099123', 'WALMART', 'Walmart');   // >=4-digit run
expectNorm('TARGET #1234', 'TARGET', 'Target');        // "#1234" store number
expectNorm('AMAZON *1234', 'AMAZON', 'Amazon');        // "*1234" masked tail
expectNorm('COSTCO xxxx1234', 'COSTCO', 'Costco');     // "xxxx1234" masked tail

// ── 3) Short meaningful numbers are PRESERVED (not treated as store ids) ───────
expectNorm('7 ELEVEN', '7 ELEVEN', '7 Eleven');   // leading single digit kept
expectNorm('UNION 76', 'UNION 76', 'Union 76');   // 2-digit brand number kept
expectNorm('STORE 760', 'STORE 760', 'Store 760'); // 3-digit number kept (< 4)

// ── 4) Conservatism — genuinely distinct merchants must NOT collapse ──────────
// City/state tokens are deliberately not stripped, so same-brand-different-city
// stays split; unrelated names stay split.
expectDistinctKeys('STARBUCKS SEATTLE WA', 'STARBUCKS PORTLAND OR');
expectDistinctKeys('COFFEE BAR', 'COFFEE SHOP');
expectDistinctKeys('APPLE', 'APPLEBEES');
// Prefix removal must not make two different merchants identical.
expectDistinctKeys('SQ *COFFEE BAR', 'SQ *TEA HOUSE');

// ── 5) Display casing ─────────────────────────────────────────────────────────
// ALL-CAPS bank-feed text → Title Case; already-mixed-case names left untouched.
expectNorm('WHOLE FOODS MARKET', 'WHOLE FOODS MARKET', 'Whole Foods Market');
expectNorm('Netflix', 'NETFLIX', 'Netflix');   // mixed case preserved as-is
expectNorm('iTunes', 'ITUNES', 'iTunes');       // internal caps preserved

// ── 6) Never-empty fallback for pathological / all-noise input ────────────────
// Empty and whitespace-only collapse to the explicit UNKNOWN sentinel.
expectNorm('', 'UNKNOWN', 'Unknown');
expectNorm('   ', 'UNKNOWN', 'Unknown');
// All-noise and prefix-only inputs fall back through progressively less-cleaned
// forms rather than emitting an empty group — assert only that output is non-empty
// (the exact fallback form is an implementation detail, but must never be blank).
expectNonEmpty('#1234 0099999');
expectNonEmpty('SQ *');
expectNonEmpty('****');

// ── Summary ───────────────────────────────────────────────────────────────────
if (failures === 0) {
  console.log('\nAll merchant-normalization cases passed.');
  process.exit(0);
} else {
  console.log(`\n${failures} merchant-normalization case(s) FAILED.`);
  process.exit(1);
}
