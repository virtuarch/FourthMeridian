/**
 * scripts/compare-plans.ts   (V26-REASONING Slice 5)
 *
 * ⚠️ SCAFFOLDING, NOT A FEATURE, AND IT SHIPS WITH ITS OWN DELETION CONDITION.
 *
 *     npm run ai:compare-plans
 *     npm run ai:compare-plans -- --class=forecast --verbose
 *
 * ── Why this one has a written ending ───────────────────────────────────────
 * This repository has shipped two shadow planners and ended neither.
 * `lib/ai/context-priority` was never once consulted, ran for months, and wrote
 * a database row on every chat turn — it was deleted in Slice 0 of this very
 * programme. `retrieval-plan.ts` still carried a "SHADOW ONLY. Nothing here
 * changes what is assembled" header that had been false at five call sites since
 * CF-9, with `route.ts` asserting "Nothing consults this plan" three lines above
 * the block that consults it.
 *
 * SHADOW MODE HERE IS 0-FOR-2 AT ENDING. So this one ships with its termination
 * written into the slice:
 *
 *   - a FIXED sample of real questions, harvested from this repository's own
 *     corpora and tests (`lib/ai/conformance/real-questions.json`);
 *   - a recorded decision PER CLASS in docs/systems/, naming the divergences and
 *     which side was right;
 *   - the legacy branch for a class is DELETED IN THE SAME COMMIT that flips
 *     that class — never left behind "just in case";
 *   - THIS FILE IS DELETED when the last class flips.
 *
 * ⚠️ AND THE SAMPLE IS 112, NOT THE 200 THE PLAN SPECIFIED. That is a deviation
 * and it is recorded rather than papered over: 112 is every question this
 * repository actually holds across its conformance corpora, its harnesses and
 * its tests. Reaching 200 would mean WRITING 88 questions and calling them real,
 * which is exactly the kind of number this programme exists to stop producing.
 * The right way to reach 200 is to harvest them from production traffic, which
 * needs a capture this product does not have.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { classifyFinancialIntent } from '@/lib/ai/intent';
import { planRetrieval, Concepts } from '@/lib/ai/retrieval-plan';
import { EvidenceAvailability, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { AS_OF } from '@/lib/ai/conformance/forecast-scenarios';
import { planTurn } from '@/lib/reasoning/plan/planner';
import { deriveConversationState } from '@/lib/reasoning/scenario/derive';
import { MeasureId, type MeasureIdName } from '@/lib/reasoning/measure/types';
import type { ReasoningPlan } from '@/lib/reasoning/plan/types';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const MODEL = args.find((a) => a.startsWith('--model='))?.split('=')[1];
const ONLY = args.find((a) => a.startsWith('--class='))?.split('=')[1];
const LIMIT = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);

const ENVELOPE: CoverageEnvelope = {
  transactions: { availability: EvidenceAvailability.AVAILABLE,
    span: { fromISO: '2023-03-01', toISO: AS_OF, count: 1840 } },
  snapshots: { availability: EvidenceAvailability.AVAILABLE,
    span: { fromISO: '2025-06-01', toISO: AS_OF, count: 454 } },
  accounts: { cash: 4, debt: 2, investments: 3, digitalAssets: 4, other: 0 },
  chains: [],
};

/**
 * The cutover classes, in the order the plan specifies they flip.
 *
 * ⚠️ CLASSIFIED FROM THE LEGACY CONCEPTS, NOT FROM THE QUESTION TEXT. Using a
 * fresh classifier here would mean the comparison's own reading of a question
 * could differ from both sides being compared, and a disagreement about which
 * class a question is in would read as a disagreement about the answer.
 */
type Klass = 'forecast' | 'broad' | 'spending-income' | 'debt' | 'other';
const ORDER: Klass[] = ['forecast', 'broad', 'spending-income', 'debt', 'other'];

const BROAD_RE = /\bhow am i doing\b|\bwhere i stand\b|\bworr\w+\b|\bfocus on\b|\bgood shape\b|\banything (?:unusual|odd)\b|\bin good shape\b|\bcrisis\b|\bhealthy\b/i;

function classify(q: string, concepts: readonly string[]): Klass {
  if (concepts.includes(Concepts.FORECAST) || concepts.includes(Concepts.PAY_DATES)) return 'forecast';
  if (BROAD_RE.test(q)) return 'broad';
  if (concepts.includes(Concepts.SPENDING) || concepts.includes(Concepts.INCOME)) return 'spending-income';
  if (concepts.includes(Concepts.DEBT)) return 'debt';
  return 'other';
}

/**
 * The measures a legacy CONCEPT set implies.
 *
 * ⚠️ THE FAIREST TRANSLATION AVAILABLE, AND IT IS DELIBERATELY GENEROUS TO
 * LEGACY. Concepts are coarser than measures — `SPENDING` does not distinguish
 * "how much am I spending" from "where does it go" — so a concept maps to EVERY
 * measure it could have meant, and legacy is scored as correct if the right one
 * is anywhere in that set. Anything narrower would score legacy down for a
 * distinction it was never asked to make.
 */
const CONCEPT_MEASURES: Record<string, MeasureIdName[]> = {
  SPENDING:    [MeasureId.MONTHLY_SPENDING],
  INCOME:      [MeasureId.MONTHLY_INCOME, MeasureId.SAVINGS_RATE],
  DEBT:        [MeasureId.DEBT_BALANCE],
  INVESTMENTS: [MeasureId.INVESTMENTS_VALUE, MeasureId.DIGITAL_ASSETS_VALUE,
    MeasureId.CONCENTRATION_TOP_WEIGHT],
  NET_WORTH:   [MeasureId.NET_WORTH, MeasureId.LIQUID_CASH],
  FORECAST:    [MeasureId.LIQUID_CASH, MeasureId.RUNWAY_MONTHS],
  PAY_DATES:   [],
  COVERAGE:    [],
};

interface Row {
  q: string; klass: Klass;
  legacyConcepts: string[];
  legacyMeasures: MeasureIdName[];
  legacyAsksClarification: boolean;
  plan: ReasoningPlan | null;
  agree: boolean;
  newOnly: MeasureIdName[];
  legacyOnly: MeasureIdName[];
  note: string;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY is not set.'); process.exit(2); }
  const questions: string[] = JSON.parse(
    readFileSync(join(process.cwd(), 'lib/ai/conformance/real-questions.json'), 'utf8'));

  const rows: Row[] = [];
  for (const q of questions) {
    const legacyPlan = planRetrieval({
      messages: [{ role: 'user', content: q }],
      envelope: ENVELOPE, now: new Date(`${AS_OF}T12:00:00.000Z`),
    });
    const concepts = [...legacyPlan.concepts];
    const klass = classify(q, concepts);
    if (ONLY && klass !== ONLY) continue;
    if (rows.length >= LIMIT) break;

    const route = classifyFinancialIntent(q);
    const legacyMeasures = [...new Set(concepts.flatMap((c) => CONCEPT_MEASURES[c] ?? []))];

    const state = deriveConversationState([{ role: 'user', content: q }], AS_OF);
    const plan = await planTurn({ question: q, state, todayISO: AS_OF, model: MODEL });

    const newMeasures = plan?.measures ?? [];
    const newOnly = newMeasures.filter((m) => !legacyMeasures.includes(m));
    const legacyOnly = legacyMeasures.filter((m) => !newMeasures.includes(m));
    const agree = plan !== null && newMeasures.some((m) => legacyMeasures.includes(m));

    const note = plan === null ? 'planner returned nothing'
      : legacyMeasures.length === 0 ? 'legacy resolved no measurable concept'
        : agree ? '' : 'disjoint selections';

    rows.push({ q, klass, legacyConcepts: concepts, legacyMeasures,
      legacyAsksClarification: route.answerStyle === 'CLARIFY' || route.confidence < 0.35,
      plan, agree, newOnly, legacyOnly, note });

    const mark = plan === null ? '!' : agree ? '=' : '≠';
    console.log(`${mark} [${klass}] ${q}`);
    console.log(`    legacy: ${concepts.join('+') || 'NONE'}`
      + `${route.answerStyle === 'CLARIFY' || route.confidence < 0.35
        ? ` (${route.intent}/${route.confidence}/${route.answerStyle})` : ''}`
      + `  ->  new: ${newMeasures.join(',') || 'NONE'}`
      + `${plan?.horizon ? ` @${plan.horizon.iso}` : ''}`
      + `${plan?.breadth === 'BROAD' ? ' BROAD' : ''}`);
    if (verbose && plan) console.log(`    reading: ${plan.reading}`);
  }

  // ── The per-class decision ────────────────────────────────────────────────
  console.log('\n══ BY CLASS ══');
  for (const k of ORDER) {
    const set = rows.filter((r) => r.klass === k);
    if (set.length === 0) continue;
    const planned = set.filter((r) => r.plan !== null).length;
    const agreed = set.filter((r) => r.agree).length;
    // ⚠️ THE NUMBER THAT DECIDES A CUTOVER. Legacy asking for clarification is
    // a legacy FAILURE on a question it was given — "what are my projections?"
    // returns UNKNOWN / 0.2 / CLARIFY and the prompt prints "briefly ask what
    // the user wants to focus on" directly above a computed forecast.
    const legacyClarifies = set.filter((r) => r.legacyAsksClarification).length;
    const legacyBlank = set.filter((r) => r.legacyMeasures.length === 0).length;
    const newBlank = set.filter((r) => r.plan === null).length;
    console.log(`  ${k.padEnd(16)} n=${String(set.length).padStart(3)}  `
      + `planner answered ${planned}/${set.length}  ·  overlap ${agreed}/${set.length}  ·  `
      + `legacy blank ${legacyBlank}  ·  legacy CLARIFY ${legacyClarifies}  ·  new blank ${newBlank}`);
  }

  writeFileSync('/tmp/compare-plans.json', JSON.stringify(rows, null, 2));
  console.log('\nfull comparison -> /tmp/compare-plans.json');
  console.log(`sample: ${rows.length} real questions from this repository's own corpora`);
}

void main();
