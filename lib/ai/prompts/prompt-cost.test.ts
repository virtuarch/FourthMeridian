/**
 * lib/ai/prompts/prompt-cost.test.ts
 *
 * V26-REASONING Slice 7 — THE PROMPT'S SHAPE, MEASURED WITHOUT A MODEL CALL.
 *
 * ⚠️ EVERYTHING HERE IS DETERMINISTIC, WHICH IS THE POINT. The plan's own
 * caveat is that `ApiUsageCounter` has no `userId` or `spaceId`, so a per-turn
 * saving is not measurable from the usage ledger — and the instruction that
 * follows from that is "do not claim savings the instrumentation cannot
 * establish".
 *
 * So nothing is claimed from the ledger. What IS measurable, exactly and for
 * free, is the shape of the string this product builds: how long it is, and how
 * much of it is byte-identical from turn to turn. Both are asserted here.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { computeAssessment } from '@/lib/ai/intelligence';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import { assembleForecast } from '@/lib/ai/forecast/assemble';
import { planRetrieval } from '@/lib/ai/retrieval-plan';
import { EvidenceAvailability, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { realSpaceCtx, STREAMS, HORIZON, AS_OF } from '@/lib/ai/conformance/forecast-scenarios';
import { buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import {
  buildTypedPromptSuffix, minimalPreamble, resolvePromptShape,
} from '@/lib/reasoning/answer/for-request';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const ENVELOPE: CoverageEnvelope = {
  transactions: { availability: EvidenceAvailability.AVAILABLE,
    span: { fromISO: '2023-03-01', toISO: AS_OF, count: 1840 } },
  snapshots: { availability: EvidenceAvailability.AVAILABLE,
    span: { fromISO: '2025-06-01', toISO: AS_OF, count: 454 } },
  accounts: { cash: 4, debt: 2, investments: 3, digitalAssets: 4, other: 0 },
  chains: [],
};

const tok = (s: string) => Math.ceil(s.length / 4);

function build(question: string): { full: string; typed: string; minimal: string } {
  const ctx = realSpaceCtx();
  const history = [{ role: 'user', content: question }];
  const plan = planRetrieval({ messages: history, envelope: ENVELOPE,
    now: new Date(`${AS_OF}T12:00:00.000Z`) });
  const forecast = assembleForecast({ ctx, streams: STREAMS, horizon: HORIZON,
    asOfISO: AS_OF, question });
  const assessment = computeAssessment(ctx);
  const full = buildSpaceSystemPrompt(ctx, assessment, classifyFinancialIntent(question),
    undefined, ENVELOPE, question, plan, forecast, undefined);
  const { suffix } = buildTypedPromptSuffix({ forecast, ctx, assessment, messages: history });
  return {
    full,
    typed: `${full}\n${suffix}`,
    minimal: `${minimalPreamble('Personal', AS_OF)}\n${suffix}`,
  };
}

const A = build('What will my cash look like over the next 3 months?');
const B = build('How much do I owe?');

// ═══════════════════════════════════════════════════════════════════════════
// A. THE PREFIX IS STABLE — which is what makes caching possible at all
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ ONE LINE WAS THE WHOLE CACHE. `Today's date: 2026-09-01.` sat on LINE 3 of
// every prompt this product has ever built, so no two turns on different days
// shared a prefix and the ~4,250 tokens of doctrine that follow — identical on
// every single turn — could never be cached. It is at the end now.

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const prefix = sharedPrefix(A.full, B.full);
check('A1 two different questions share a long identical prefix',
  prefix > 4_000, `${prefix} chars (~${tok(A.full.slice(0, prefix))} tok)`);

// ⚠️ AND THE DATE IS NOT IN IT. A date on line 3 caps the shared prefix at ~120
// characters on any day the date changes — which is every day.
check('A2 the date is not in the prefix',
  !A.full.slice(0, prefix).includes("Today's date"),
  A.full.split('\n').slice(0, 4).join(' | '));
check('A3 and the date is still stated, at the end',
  A.full.includes("Today's date:")
  && A.full.lastIndexOf("Today's date:") > A.full.length - 200);

// ⚠️ THE DOCTRINE IS INSIDE THE SHARED PREFIX, which is the whole prize: it is
// the largest thing in the prompt and the least variable.
check('A4 the doctrine is inside the shared prefix',
  A.full.slice(0, prefix).includes('Authority precedence'));

// ═══════════════════════════════════════════════════════════════════════════
// B. THE SIZE, STATED RATHER THAN ESTIMATED
// ═══════════════════════════════════════════════════════════════════════════

const sizes = {
  full:    tok(A.full),
  typed:   tok(A.typed),
  minimal: tok(A.minimal),
  suffix:  tok(A.typed) - tok(A.full),
  prefix:  tok(A.full.slice(0, prefix)),
};
console.log(`  PROMPT TOKENS  full=${sizes.full}  typed=${sizes.typed}  `
  + `minimal=${sizes.minimal}  (typed table=${sizes.suffix}, cacheable prefix=${sizes.prefix})`);

// ⚠️ A RATIO, NOT AN ABSOLUTE. Absolute token counts move with the fixture and
// pinning one would make this a test of the fixture. What must hold is that the
// minimal shape is a fraction of the full one — the claim Slice 7 makes.
check('B1 the minimal typed prompt is under a third of the full one',
  sizes.minimal * 3 < sizes.full, JSON.stringify(sizes));
check('B2 and it still carries the whole figure table',
  sizes.minimal > sizes.suffix && A.minimal.includes('=== FIGURES YOU MAY STATE ==='));

// ⚠️ THE MINIMAL SHAPE DROPS THE DOCTRINE, NOT THE EVIDENCE. A prompt that had
// quietly dropped the figures would score wonderfully here and answer nothing.
check('B3 the minimal shape carries no doctrine',
  !A.minimal.includes('Authority precedence') && !A.minimal.includes('=== QUESTION ROUTING ==='));
check('B4 and it is not a trimmed doctrine — the preamble is five lines',
  minimalPreamble('Personal', AS_OF).split('\n').length === 5);

eq('B5 unset prompt shape is `full` — a saving this large is opted into',
  resolvePromptShape(undefined), 'full');

// ═══════════════════════════════════════════════════════════════════════════
// C. THE HONEST CAVEAT, KEPT HONEST
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ `ApiUsageCounter` HAS NO `userId` OR `spaceId`, so a PER-TURN saving cannot
// be read back from the usage ledger — only a per-model daily total. Everything
// this file asserts is about the STRING, which is exact and free. Nothing here
// claims a bill went down, and this check exists so that stays true: if the
// dimension is ever added, this fails and somebody reconsiders the claim.

const SCHEMA = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const usageModel = SCHEMA.slice(SCHEMA.indexOf('model ApiUsageCounter'));
const usageBody = usageModel.slice(0, usageModel.indexOf('\n}'));
check('C1 the usage ledger still carries no per-turn dimension, so no saving is claimed',
  !/\buserId\b|\bspaceId\b/.test(usageBody),
  'ApiUsageCounter gained a dimension — a per-turn cost measurement is now '
  + 'possible, and the token-shape assertions above should be joined by one');

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
