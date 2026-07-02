/**
 * app/api/ai/chat/attribution-guardrail.kd18.test.ts
 *
 * KD-18 regression tests — attribution honesty guardrail (pure, no DB, no import
 * of the route module).
 *
 * The project has no test runner (no jest/vitest). This file is a standalone,
 * dependency-free script runnable with the already-installed `tsx`, mirroring
 * lib/ai/assemblers/transactions.kd17.test.ts:
 *
 *     npx tsx app/api/ai/chat/attribution-guardrail.kd18.test.ts
 *
 * Run from the repo root (source tripwires resolve paths from cwd).
 * Exits 0 when all cases pass and 1 on failure.
 *
 * Why source tripwires rather than calling the builder:
 * app/api/ai/chat/route.ts is a Next.js route module. Next's route-type check
 * forbids exporting arbitrary symbols from it, so the two guardrail constants
 * and the two prompt builders cannot be exported for a runtime assertion without
 * failing `tsc`. These tests therefore pin the guardrail structurally against the
 * route source — the same technique the KD-17 serializer tripwires use.
 *
 * Defect under test (docs/investigations/DEBT_PAYMENT_ATTRIBUTION_INVESTIGATION.md
 * + STATUS.md KD-18): deterministic context carries exact flow TOTALS but not the
 * account/card/source/destination dimension of those flows, and the prompt
 * presented monthly totals next to named liabilities with no attribution
 * disclaimer — so a per-card question yielded an invented allocation the
 * membership validator structurally cannot catch (attribution, not figures).
 *
 * KD-18 (generalized per the approved refinement) adds honesty, not capability:
 *   1. Disclosure exists — a named ATTRIBUTION_DISCLOSURE constant stating the
 *      totals are not attributed to specific accounts/destinations.
 *   2. Rule exists — a named ATTRIBUTION_RULE forbidding any invented per-account
 *      breakdown along ANY missing dimension, not only debt payments.
 *   3. Prompt serialization includes both — the disclosure is pushed into the
 *      serialized context block (inside the transaction guard); the rule is part
 *      of ADVISOR_PRINCIPLES, which both prompt builders embed.
 *   4. Ordinary prompts remain unchanged — the disclosure is emitted exactly once
 *      and only inside the `if (txn)` transaction guard, and the rule appears
 *      exactly once, in ADVISOR_PRINCIPLES between the debt-payment and financial
 *      -assessment doctrines. No other prompt text is touched.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Tiny harness (mirrors transactions.kd17.test.ts)
// ---------------------------------------------------------------------------

let failures = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failures += 1;
    console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Return the body of a top-level function by brace matching from its signature. */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(braceOpen, i + 1);
    }
  }
  throw new Error(`unbalanced braces for: ${signature}`);
}

/** Return the array-literal body of `const NAME = [ ... ]`. */
function arrayLiteral(src: string, name: string): string {
  const decl = src.indexOf(`const ${name} = [`);
  if (decl === -1) throw new Error(`array const not found: ${name}`);
  const open = src.indexOf('[', decl);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced brackets for: ${name}`);
}

// ---------------------------------------------------------------------------
// Load route source (text only — never imported)
// ---------------------------------------------------------------------------

const ROUTE_PATH = join(process.cwd(), 'app/api/ai/chat/route.ts');
const src = readFileSync(ROUTE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 1. Disclosure exists
// ---------------------------------------------------------------------------

check(
  'disclosure constant is declared',
  /const\s+ATTRIBUTION_DISCLOSURE\s*=/.test(src),
  'ATTRIBUTION_DISCLOSURE const missing from route.ts',
);

// Wording snapshot — exact phrases that must survive verbatim so the disclosure
// cannot silently drift into a weaker or capability-implying statement.
const DISCLOSURE_PHRASES = [
  'ATTRIBUTION LIMIT',
  'NOT attributed to specific accounts, cards, sources, ',
  'or destinations.',
  'which specific card a debt payment ',
  'went to, which account a transfer came from or went to',
  'Any split of these totals ',
  'across individual accounts or cards would be invented.',
];
for (const phrase of DISCLOSURE_PHRASES) {
  check(
    `disclosure wording pinned: "${phrase.slice(0, 40)}…"`,
    src.includes(phrase),
    `disclosure lost expected phrase: ${phrase}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Rule exists — and is GENERALIZED (not debt-payment-specific)
// ---------------------------------------------------------------------------

check(
  'rule constant is declared',
  /const\s+ATTRIBUTION_RULE\s*=\s*\[/.test(src),
  'ATTRIBUTION_RULE const missing from route.ts',
);

// Doctrine (refined): refuse only the missing dimension, not the whole question —
// answer every deterministic portion FIRST, disclose the missing dimension SECOND,
// offer the nearest truthful alternative, and never fabricate a split. These
// phrases pin that wording so the answer-first behavior cannot silently regress
// back to a refusal-first rule.
const RULE_PHRASES = [
  'Attribution honesty — refuse only the missing dimension, never the whole question:',
  'Do not lead with a refusal',
  'FIRST, answer every deterministic portion the context DOES contain',
  'Never withhold a correct total because one requested dimension is missing.',
  'THEN disclose, plainly and once, that per-account',
  'attribution is not available in this data.',
  'Offer the nearest truthful alternative you can answer',
  'Never infer, allocate, or distribute a total across accounts or cards',
  'any such split would be invented',
  'This applies to every dimension, not only debt payments.',
];
for (const phrase of RULE_PHRASES) {
  check(
    `rule wording pinned: "${phrase.slice(0, 40)}…"`,
    src.includes(phrase),
    `rule lost expected phrase: ${phrase}`,
  );
}

check(
  'rule is generalized beyond debt payments (names multiple dimensions)',
  src.includes('income/interest/spending') &&
    src.includes('transfers per account') &&
    src.includes('not only debt payments'),
  'rule appears narrowed to debt payments only',
);

// Answer-first doctrine: the instruction to answer the deterministic portion must
// come BEFORE the instruction to disclose the missing dimension. This is the whole
// point of the refinement — refuse the dimension, not the question.
const ruleArr = arrayLiteral(src, 'ATTRIBUTION_RULE');
const answerFirstIdx = ruleArr.indexOf('FIRST, answer every deterministic portion');
const discloseIdx = ruleArr.indexOf('attribution is not available in this data');
const alternativeIdx = ruleArr.indexOf('Offer the nearest truthful alternative');
check(
  'rule answers the deterministic portion BEFORE disclosing the missing dimension',
  answerFirstIdx !== -1 && discloseIdx !== -1 && answerFirstIdx < discloseIdx,
  'rule discloses the missing dimension before answering what is known (refusal-first)',
);
check(
  'rule offers the nearest truthful alternative after the disclosure',
  alternativeIdx !== -1 && alternativeIdx > discloseIdx,
  'rule does not offer a truthful alternative after the disclosure',
);

// ---------------------------------------------------------------------------
// 3. Prompt serialization includes BOTH
// ---------------------------------------------------------------------------

// 3a. Disclosure is pushed into the serialized context block, inside the
//     transaction (`if (txn)`) guard.
const ctxBody = functionBody(src, 'function serializeContextBlock(ctx: SpaceContext_AI): string');

check(
  'disclosure is pushed into the context block',
  /lines\.push\(\s*`\s*\$\{ATTRIBUTION_DISCLOSURE\}`\s*\)/.test(ctxBody),
  'ATTRIBUTION_DISCLOSURE is not pushed into `lines` in serializeContextBlock',
);

// Gating: the push must sit after `if (txn) {` so contexts without a transaction
// summary never receive it (ordinary non-transaction prompts unchanged).
const txnGuardIdx = ctxBody.indexOf('if (txn) {');
const disclosurePushIdx = ctxBody.indexOf('${ATTRIBUTION_DISCLOSURE}');
check(
  'disclosure push is gated inside the `if (txn)` transaction guard',
  txnGuardIdx !== -1 && disclosurePushIdx > txnGuardIdx,
  'disclosure is not gated by the transaction guard',
);

// 3b. Rule is a member of ADVISOR_PRINCIPLES.
const advisorArr = arrayLiteral(src, 'ADVISOR_PRINCIPLES');
check(
  'rule is included in ADVISOR_PRINCIPLES',
  /(^|[\s,[])ATTRIBUTION_RULE([\s,\]])/.test(advisorArr),
  'ATTRIBUTION_RULE is not a member of ADVISOR_PRINCIPLES',
);

// 3c. ADVISOR_PRINCIPLES is embedded in BOTH prompt builders, so the rule
//     serializes into space AND master prompts.
const spaceBody = functionBody(
  src,
  'function buildSpaceSystemPrompt(',
);
const masterBody = functionBody(
  src,
  'function buildMasterSystemPrompt(',
);
check(
  'space prompt embeds ADVISOR_PRINCIPLES (carries the rule)',
  spaceBody.includes('ADVISOR_PRINCIPLES'),
  'buildSpaceSystemPrompt does not embed ADVISOR_PRINCIPLES',
);
check(
  'master prompt embeds ADVISOR_PRINCIPLES (carries the rule)',
  masterBody.includes('ADVISOR_PRINCIPLES'),
  'buildMasterSystemPrompt does not embed ADVISOR_PRINCIPLES',
);
check(
  'both prompt builders embed serializeContextBlock (carries the disclosure)',
  spaceBody.includes('serializeContextBlock(') &&
    masterBody.includes('serializeContextBlock('),
  'a prompt builder does not embed serializeContextBlock',
);

// ---------------------------------------------------------------------------
// 4. Ordinary prompts remain unchanged (no scattering / single insertion)
// ---------------------------------------------------------------------------

check(
  'disclosure is emitted exactly once',
  countOccurrences(ctxBody, 'lines.push(`  ${ATTRIBUTION_DISCLOSURE}`)') === 1,
  'disclosure pushed zero or multiple times',
);

check(
  'rule is referenced exactly once in the module',
  // one declaration + one membership reference in ADVISOR_PRINCIPLES = 2 total.
  countOccurrences(src, 'ATTRIBUTION_RULE') === 2,
  'ATTRIBUTION_RULE referenced an unexpected number of times',
);

// Rule sits between the debt-payment and financial-assessment doctrines — it
// augments existing doctrine in place rather than displacing other prompt text.
const debtDoctrineIdx = advisorArr.indexOf('Debt payment doctrine:');
const ruleMemberIdx = advisorArr.indexOf('ATTRIBUTION_RULE');
const finAssessIdx = advisorArr.indexOf('Financial Assessment doctrine:');
check(
  'rule is inserted between existing doctrines (no reordering of other text)',
  debtDoctrineIdx !== -1 &&
    finAssessIdx !== -1 &&
    ruleMemberIdx > debtDoctrineIdx &&
    ruleMemberIdx < finAssessIdx,
  'rule is not positioned between the debt-payment and financial-assessment doctrines',
);

// Guardrail is prompt-text only: KD-18 must not have touched aggregation,
// schema, rollups, or the validator from within this route.
check(
  'no new aggregation/rollup introduced by KD-18 (no byLiability in route)',
  !src.includes('byLiability'),
  'unexpected byLiability rollup found — KD-18 is guardrail-only',
);

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} KD-18 check(s) failed.`);
  process.exit(1);
}
console.log('\nAll KD-18 attribution-guardrail checks passed.');
