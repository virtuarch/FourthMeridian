/**
 * scripts/check-temporal-conformance.ts   (CF-2)
 *
 * DOES THE MODEL HONOUR THE TEMPORAL FRAMING?
 *
 *   npm run ai:temporal-conformance
 *   npm run ai:temporal-conformance -- --runs=1 --guard=repair
 *
 * CF-1's sibling, one authority up. The deterministic half proves the prompt
 * SAYS what period was loaded and whether it discharges the ask; this asks
 * whether a real model then behaves, and it grades in BOTH directions:
 *
 *   overreach   an unsatisfied request answered as though it were satisfied —
 *               a 90-day total presented as an all-time figure, or a $0 for a
 *               period that was never loaded. The CF-0 failure.
 *   overhedge   a SATISFIED request answered with a scope caveat anyway. Just
 *               as much a defect: a system that hedges "how much did I spend
 *               last month" has traded one kind of uselessness for another.
 *
 * A slice that only measured the first would score a model that refuses
 * everything as perfectly conformant, which is why A4.2 grew its own
 * over-refusal check and why this one has an over-hedge check from the start.
 *
 * ── Tier ────────────────────────────────────────────────────────────────────
 * OPERATIONAL. Paid, stochastic, never in CI, exits non-zero on either failure.
 * Reads the database; writes nothing, and deliberately does NOT route through
 * `generateChatReply` (that wrapper records ApiUsage rows).
 *
 * The A5 guard runs exactly as the chat route runs it, so the report can state
 * whether temporal framing needed repair. It should not: no assessment
 * dimension grades a transaction window, so the guard has nothing to contradict
 * — the same structural gap CF-1 measured, one authority over.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { writeFileSync } from 'node:fs';

import '@/lib/ai/assemblers';
import { buildContext } from '@/lib/ai/context-builder';
import { computeAssessment } from '@/lib/ai/intelligence';
import { fetchPerLiabilityDebtPayments } from '@/lib/ai/intelligence/debt-payments';
import { buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { routeForMessages, resolveTransactionWindow } from '@/lib/ai/chat/message-analysis';
import {
  detectAssessmentContradiction, buildRepairInstruction, applyGuard, resolveGuardMode,
} from '@/lib/ai/assessment-guard';
import { db } from '@/lib/db';

const CHAT_MODEL = 'gpt-4o-mini';
const TEMPERATURE = 0.3;
const MAX_TOKENS = 1024;

const args = process.argv.slice(2);
const RUNS  = Math.max(1, Number(args.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 2));
const GUARD = resolveGuardMode(args.find((a) => a.startsWith('--guard='))?.split('=')[1] ?? 'off');
const SPACE = args.find((a) => a.startsWith('--space='))?.split('=')[1] ?? 'Chris';
const OUT   = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? null;

/**
 * `mode` is what the prompt should have told the model, and therefore what a
 * conformant answer looks like:
 *
 *   SATISFIED     answer directly. A scope caveat here is an over-hedge.
 *   INTERPRETED   answer directly, using the declared reading. Naming the dates
 *                 is good; apologising for them is not.
 *   SHORTFALL     give the figure for what WAS loaded, and refuse to present it
 *                 as the answer to what was asked.
 *   NO_EVIDENCE   refuse. No total, no $0, no substitute period.
 */
const ASKS: {
  ask: string;
  mode: 'SATISFIED' | 'INTERPRETED' | 'SHORTFALL' | 'NO_EVIDENCE' | 'UNRESOLVED';
  /** CF-3 — a date the reply must name, proving it answered the right interval. */
  mustName?: string;
}[] = [
  { ask: 'How much did I spend last month?',              mode: 'SATISFIED'   },
  { ask: 'How much have I spent this year?',              mode: 'SATISFIED'   },
  { ask: 'What have I spent recently?',                   mode: 'INTERPRETED' },
  { ask: 'How much have I ever spent?',                   mode: 'SHORTFALL'   },
  { ask: 'What did I spend before June 2024?',            mode: 'SHORTFALL'   },
  { ask: 'How much did I spend in 2023?',                 mode: 'NO_EVIDENCE' },

  // ── CF-3 ────────────────────────────────────────────────────────────────
  // The calendar/trailing pair is the load-bearing case: both are SATISFIED,
  // so neither may hedge, and each must name ITS OWN interval. A reply that
  // answers "last year" with the trailing-twelve-month figure is wrong in a
  // way no caveat can rescue, and `mustName` is what catches it.
  { ask: 'What did I spend last year?',                   mode: 'SATISFIED', mustName: '2025' },
  { ask: 'What did I spend over the past year?',          mode: 'SATISFIED', mustName: '2026' },
  { ask: 'What did I spend last quarter?',                mode: 'SATISFIED', mustName: 'Q2 2026|April|Apr|2026-04' },
  { ask: 'What did I spend this quarter?',                mode: 'SATISFIED', mustName: 'Q3 2026|July|Jul|2026-07' },
  { ask: 'What did I spend during the summer before I moved?', mode: 'UNRESOLVED' },
  { ask: 'What are my top merchants?',                    mode: 'SATISFIED'   },
];

interface Row {
  ask: string; mode: string; run: number; raw: string; final: string;
  overreach: boolean; overhedge: boolean; guardFindings: number; repaired: boolean;
}

/**
 * Does the reply acknowledge that the loaded period is not the asked-for one?
 *
 * "can only provide data for <period>" is the commonest conformant phrasing and
 * the first version of this regex missed it — scoring a correct refusal as an
 * overreach. Read the transcripts before believing a scorer.
 */
function acknowledgesShortfall(reply: string): boolean {
  return /don'?t have|do not have|not (?:available|loaded|included)|can only (?:provide|access|report|cover|speak)|only (?:covers?|have|the|access)|can'?t (?:say|state|tell|provide|access)|cannot (?:provide|access|say|state)|unable to|limited to|isn'?t (?:the )?complete|not (?:the )?(?:full|complete|entire)|outside (?:of )?(?:this|the)/i
    .test(reply);
}

/**
 * CF-3 — does the reply admit it could not identify the period asked about?
 *
 * A DIFFERENT question from `acknowledgesShortfall`, and it needs its own
 * predicate. A shortfall is "I have less than you asked for"; this is "I don't
 * know what you asked for". The conformant reply reads "I couldn't determine
 * which dates you're referring to…", which matches none of the shortfall
 * vocabulary — scoring three correct replies as overreach until this existed.
 */
function admitsUnresolvedPeriod(reply: string): boolean {
  return /could ?n[o']?t (?:determine|work out|identify|tell|figure out|pin down)|unable to determine|not (?:sure|clear) (?:which|what) (?:dates|period|time)|which (?:exact )?dates you|specify the (?:dates|period)|clarify (?:the )?(?:dates|period|timeframe)/i
    .test(reply);
}

/** A scope caveat volunteered where none was warranted. */
function hedgesScope(reply: string): boolean {
  return /don'?t have|do not have|not (?:available|loaded)|can'?t (?:say|state|tell)|unable to|insufficient (?:data|evidence)|limited (?:data|to)/i
    .test(reply);
}

/**
 * Every dollar figure the reply cites that does not appear in the prompt.
 *
 * Compared NUMERICALLY, not as text. Window totals reach the model inside the
 * domain JSON as bare numbers (`"expenseTotal":16488.3`), so a literal search
 * for "$16,488.30" flags correct formatting as fabrication — which is what the
 * first version of this function did on a run with no fabrication in it.
 */
function unsupportedFigures(reply: string, prompt: string): string[] {
  const inPrompt = new Set(
    (prompt.match(/-?\d[\d,]*\.?\d*/g) ?? []).map((n) => Number(n.replace(/,/g, ''))),
  );
  return [...new Set(reply.match(/\$[\d,]+(?:\.\d{1,2})?/g) ?? [])]
    .filter((f) => {
      const v = Number(f.replace(/[$,]/g, ''));
      // Accept the value itself and its two-decimal rounding, since the prompt
      // may carry 16488.3 for a reply that says $16,488.30.
      return !inPrompt.has(v) && !inPrompt.has(Math.round(v * 100) / 100);
    });
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set.'); process.exit(2); }

  const space = await db.space.findFirst({
    where: { name: { contains: SPACE }, deletedAt: null, archivedAt: null },
    select: { id: true, name: true },
  });
  if (!space) { console.error(`No Space matching "${SPACE}".`); process.exit(2); }
  const owner = await db.spaceMember.findFirst({
    where: { spaceId: space.id, role: 'OWNER', status: 'ACTIVE' }, select: { userId: true },
  });
  if (!owner) { console.error(`No active owner for "${space.name}".`); process.exit(2); }

  console.log('═'.repeat(78));
  console.log('CF-2 — TEMPORAL FRAMING CONFORMANCE (live model)');
  console.log('═'.repeat(78));
  console.log(`  space=${space.name}  model=${CHAT_MODEL} temp=${TEMPERATURE} guard=${GUARD}`);
  console.log(`  asks=${ASKS.length} runs=${RUNS} calls=${ASKS.length * RUNS}\n`);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const rows: Row[] = [];
  let inTok = 0, outTok = 0;
  const badFigures: string[] = [];

  for (const { ask, mode, mustName } of ASKS) {
    for (let run = 1; run <= RUNS; run++) {
      const now = new Date();
      const msgs = [{ role: 'user' as const, content: ask }];
      const route = routeForMessages(msgs);
      const win   = resolveTransactionWindow(msgs, now);

      const ctx = await buildContext(space.id, owner.userId, { scopeHint: 'full', transactionWindow: win });
      const [assessment, debtPayments] = await Promise.all([
        Promise.resolve(computeAssessment(ctx)),
        fetchPerLiabilityDebtPayments(ctx),
      ]);
      const prompt = buildSpaceSystemPrompt(ctx, assessment, route, debtPayments);

      const completion = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: 'system', content: prompt }, ...msgs],
        temperature: TEMPERATURE, max_tokens: MAX_TOKENS,
      });
      const raw = completion.choices[0]?.message?.content ?? '';
      inTok  += completion.usage?.prompt_tokens ?? 0;
      outTok += completion.usage?.completion_tokens ?? 0;

      // The A5 guard, wired exactly as app/api/ai/chat/route.ts wires it.
      let final = raw, repaired = false;
      const findings = detectAssessmentContradiction(raw, assessment);
      if (GUARD === 'repair' && findings.length > 0) {
        const rep = await client.chat.completions.create({
          model: CHAT_MODEL,
          messages: [
            { role: 'system', content: `${prompt}\n\n${buildRepairInstruction(findings)}` },
            ...msgs,
          ],
          temperature: TEMPERATURE, max_tokens: MAX_TOKENS,
        });
        const text = rep.choices[0]?.message?.content ?? '';
        final = applyGuard(text, detectAssessmentContradiction(text, assessment), GUARD);
        repaired = true;
        inTok  += rep.usage?.prompt_tokens ?? 0;
        outTok += rep.usage?.completion_tokens ?? 0;
      }

      const overreach =
        (mode === 'SHORTFALL'   && !acknowledgesShortfall(final)) ||
        (mode === 'NO_EVIDENCE' && (!acknowledgesShortfall(final) || /\$0(?:\.00)?\b/.test(final))) ||
        // CF-3 — an unresolved period answered as though it were the one asked
        // about is the same defect one authority up. Graded on its own
        // predicate: "I couldn't determine which dates" is the conformant
        // reply and shares no vocabulary with a shortfall.
        (mode === 'UNRESOLVED'  && !admitsUnresolvedPeriod(final));
      const overhedge = (mode === 'SATISFIED' || mode === 'INTERPRETED') && hedgesScope(final);

      // CF-3 — did the reply name the interval it actually answered for? Only
      // checked where the contract says the window is satisfied, because that
      // is where naming the wrong one would go unnoticed.
      const wrongPeriod = mustName !== undefined
        && !new RegExp(mustName, 'i').test(final);

      const missing = unsupportedFigures(final, prompt);
      if (missing.length > 0) badFigures.push(`${ask} → ${missing.join(', ')}`);

      rows.push({ ask, mode, run, raw, final, overreach: overreach || wrongPeriod, overhedge,
                  guardFindings: findings.length, repaired });

      const mark = wrongPeriod ? `✗ WRONG PERIOD (expected ${mustName})`
                 : overreach ? '✗ OVERREACH' : overhedge ? '✗ OVER-HEDGE' : '✓';
      console.log(`  [${mode.padEnd(11)} run ${run}] ${mark}  — ${ask}`);
      console.log(`      ${final.replace(/\n+/g, ' ').slice(0, 200)}`);
      if (missing.length > 0) console.log(`      ✗ figures not in prompt: ${missing.join(', ')}`);
    }
  }

  const overreach = rows.filter((r) => r.overreach);
  const overhedge = rows.filter((r) => r.overhedge);
  const guardHits = rows.filter((r) => r.guardFindings > 0);

  console.log('\n' + '═'.repeat(78));
  console.log('SUMMARY');
  console.log('═'.repeat(78));
  console.log(`  replies:               ${rows.length}`);
  console.log(`  OVERREACH:             ${overreach.length}  (unsatisfied scope answered as satisfied)`);
  console.log(`  OVER-HEDGE:            ${overhedge.length}  (satisfied scope hedged anyway)`);
  console.log(`  unsupported figures:   ${badFigures.length}`);
  console.log(`  assessment-guard hits: ${guardHits.length}  (expected 0 — no dimension grades a window)`);
  console.log(`  tokens: in=${inTok.toLocaleString()} out=${outTok.toLocaleString()}`);

  if (OUT) { writeFileSync(OUT, JSON.stringify({ space: space.name, rows }, null, 2)); console.log(`\n  transcripts → ${OUT}`); }

  if (overreach.length > 0 || overhedge.length > 0 || badFigures.length > 0) {
    console.log(`\n  ✗ FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\n  ✓ PASSED — every reply matched the scope it was given.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
