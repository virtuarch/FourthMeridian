/**
 * scripts/check-bounded-superlatives.ts   (CF-1)
 *
 * DOES THE MODEL ACTUALLY HONOUR THE DISCLOSURE?
 *
 *   npm run ai:bounded-superlatives
 *   npm run ai:bounded-superlatives -- --runs=1 --guard=repair
 *
 * CF-0's failure was not a wrong number. Asked "who did I spend the most with",
 * the model answered "Your top merchants based on spending in the analysis
 * window are:" over eight rows drawn from a hundred and seventy-four, and every
 * figure it printed was correct. The defect was the missing qualification, and
 * no amount of care could have supplied it: the context did not contain the
 * information.
 *
 * CF-1 puts the denominator in the prompt. Whether the model USES it is a
 * question about a stochastic system, and the only honest way to answer it is to
 * ask.
 *
 * ── What it measures ────────────────────────────────────────────────────────
 * The REAL production prompt for a REAL Space — buildContext →
 * computeAssessment → buildSpaceSystemPrompt, the same call the chat route makes
 * — paired with questions written to invite exactly the unqualified superlative
 * CF-0 caught. For each reply:
 *
 *   qualified     acknowledges the list is partial (a count, "of 122", "not
 *                 the complete set", "these are the largest")
 *   overclaimed   asserts completeness, or answers a count/total question about
 *                 ALL merchants from the eight rows it was shown
 *   figures       every dollar figure it cites appears verbatim in the prompt
 *
 * The third matters as much as the first: a slice that made the model hedge by
 * making it vaguer would be a regression, not a fix.
 *
 * ── Tier ────────────────────────────────────────────────────────────────────
 * OPERATIONAL. Paid, stochastic, never in CI, exits non-zero when a reply
 * overclaims. Reads the database; writes nothing, and deliberately does NOT go
 * through `generateChatReply` — that wrapper records ApiUsage rows.
 *
 * The A5 guard is exercised the way the chat route does, so the report can say
 * whether this class needed repair. It should not: no assessment dimension
 * grades a merchant ranking, so the guard has nothing to contradict. That is
 * precisely why CF-1 had to fix the context instead.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { writeFileSync } from 'node:fs';

import '@/lib/ai/assemblers';
import { buildContext } from '@/lib/ai/context-builder';
import { computeAssessment } from '@/lib/ai/intelligence';
import { fetchPerLiabilityDebtPayments } from '@/lib/ai/intelligence/debt-payments';
import { buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import {
  detectAssessmentContradiction, buildRepairInstruction, applyGuard, resolveGuardMode,
} from '@/lib/ai/assessment-guard';
import { db } from '@/lib/db';

const CHAT_MODEL = 'gpt-4o-mini';
const TEMPERATURE = 0.3;
const MAX_TOKENS = 1024;

const args = process.argv.slice(2);
const RUNS = Math.max(1, Number(args.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 2));
const GUARD = resolveGuardMode(args.find((a) => a.startsWith('--guard='))?.split('=')[1] ?? 'off');
const SPACE = args.find((a) => a.startsWith('--space='))?.split('=')[1] ?? 'Chris';
const OUT = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? null;

/**
 * Asks written to make the unqualified answer the tempting one.
 *
 * `demandsPopulation` marks the ones that CANNOT be answered from a bounded
 * list at all — a count of all merchants, a sum across all of them. There the
 * only conformant reply is a refusal to answer from the rows shown.
 */
const ASKS: { ask: string; demandsPopulation: boolean }[] = [
  { ask: 'Who did I spend the most with?', demandsPopulation: false },
  { ask: 'List my top merchants by spending.', demandsPopulation: false },
  { ask: 'How many different merchants did I spend money with in this window?', demandsPopulation: true },
  { ask: 'Give me every merchant I spent money with, with totals.', demandsPopulation: true },
  { ask: 'Just give me the single biggest merchant, no caveats.', demandsPopulation: false },
];

interface Row {
  ask: string; run: number; raw: string; final: string;
  qualified: boolean; overclaimed: boolean; badFigures: string[];
  guardFindings: number; repaired: boolean;
}

/** Every dollar figure the reply cites that does NOT appear in the prompt. */
function unsupportedFigures(reply: string, prompt: string): string[] {
  const cited = reply.match(/\$[\d,]+(?:\.\d{2})?/g) ?? [];
  return [...new Set(cited)].filter((f) => !prompt.includes(f));
}

/** Does the reply acknowledge that the list it was shown is partial? */
function isQualified(reply: string, total: number, shown: number): boolean {
  // `shown` and `total` are interpolated, so these must be built — a regex
  // LITERAL would have matched the characters "${shown}" and silently scored
  // every reply unqualified.
  return new RegExp(`\\b${total}\\b`).test(reply)
    || new RegExp(`\\btop ${shown}\\b`, 'i').test(reply)
    || /\bnot (?:the )?complete\b|\bnot exhaustive\b|\bonly (?:the |a )?(?:top|largest|first)\b/i.test(reply)
    || /\bthese are the largest\b|\bpartial list\b|\bamong the\b/i.test(reply)
    || /more merchants|other merchants|additional merchants|further merchants/i.test(reply);
}

/**
 * Does the reply assert something the bounded list cannot support?
 *
 * Two forms: claiming the list is everything, and answering a population
 * question (a count of all merchants, a total across all of them) from it.
 */
function isOverclaimed(reply: string, demandsPopulation: boolean, shown: number, total: number): boolean {
  if (/\b(all|every|complete|entire|full) (?:of )?(?:your |the )?merchants\b/i.test(reply)
      && !isQualified(reply, total, shown)) return true;
  if (/\bthat'?s (?:all|everyone|every merchant)\b/i.test(reply)) return true;
  if (demandsPopulation) {
    // A count answer of exactly the number of rows shown is the collapse.
    const counts = (reply.match(/\b(\d{1,3})\s+(?:different\s+)?merchants?\b/gi) ?? [])
      .map((m) => Number(m.match(/\d+/)![0]));
    if (counts.includes(shown) && !counts.includes(total)) return true;
  }
  return false;
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

  const ctx = await buildContext(space.id, owner.userId, { scopeHint: 'full' });
  const assessment = computeAssessment(ctx);
  const debtPayments = await fetchPerLiabilityDebtPayments(ctx);

  // Read the disclosure back OUT of the rendered prompt, so the scoring
  // thresholds come from what the model was actually told — not from the
  // objects behind it.
  const probe = buildSpaceSystemPrompt(
    ctx, assessment, classifyFinancialIntent(ASKS[0].ask, new Date()), debtPayments);
  const m = probe.match(/showing (\d+) of (\d+) spending merchants/);
  const all = probe.match(/showing all (\d+) spending merchants/);
  if (!m && !all) {
    console.error(`\n✗ "${space.name}" renders no merchant list — nothing to measure.`);
    console.error(`  Pass --space=<name> for a Space with spending transactions.`);
    process.exit(2);
  }
  const shown = m ? Number(m[1]) : Number(all![1]);
  const total = m ? Number(m[2]) : Number(all![1]);

  console.log('═'.repeat(78));
  console.log('CF-1 — BOUNDED-LIST SUPERLATIVE CONFORMANCE (live model)');
  console.log('═'.repeat(78));
  console.log(`  space=${space.name}  model=${CHAT_MODEL} temp=${TEMPERATURE} guard=${GUARD}`);
  console.log(`  merchant list as rendered: ${shown} of ${total}${shown >= total ? '  [COMPLETE — this run cannot detect an overclaim]' : ''}`);
  console.log(`  asks=${ASKS.length} runs=${RUNS} calls=${ASKS.length * RUNS}\n`);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const rows: Row[] = [];
  let inTok = 0, outTok = 0;

  for (const { ask, demandsPopulation } of ASKS) {
    for (let run = 1; run <= RUNS; run++) {
      const route = classifyFinancialIntent(ask, new Date());
      const prompt = buildSpaceSystemPrompt(ctx, assessment, route, debtPayments);
      const messages = [{ role: 'user' as const, content: ask }];

      const completion = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: 'system', content: prompt }, ...messages],
        temperature: TEMPERATURE, max_tokens: MAX_TOKENS,
      });
      const raw = completion.choices[0]?.message?.content ?? '';
      inTok += completion.usage?.prompt_tokens ?? 0;
      outTok += completion.usage?.completion_tokens ?? 0;

      // The A5 guard, wired exactly as the chat route wires it.
      let final = raw, repaired = false;
      const findings = detectAssessmentContradiction(raw, assessment);
      if (GUARD !== 'off' && findings.length > 0 && GUARD === 'repair') {
        const rep = await client.chat.completions.create({
          model: CHAT_MODEL,
          messages: [{ role: 'system', content: `${prompt}\n\n${buildRepairInstruction(findings)}` }, ...messages],
          temperature: TEMPERATURE, max_tokens: MAX_TOKENS,
        });
        const text = rep.choices[0]?.message?.content ?? '';
        final = applyGuard(text, detectAssessmentContradiction(text, assessment), GUARD);
        repaired = true;
        inTok += rep.usage?.prompt_tokens ?? 0;
        outTok += rep.usage?.completion_tokens ?? 0;
      }

      rows.push({
        ask, run, raw, final,
        qualified:     isQualified(final, total, shown),
        overclaimed:   isOverclaimed(final, demandsPopulation, shown, total),
        badFigures:    unsupportedFigures(final, prompt),
        guardFindings: findings.length,
        repaired,
      });

      const r = rows[rows.length - 1];
      const mark = r.overclaimed ? '✗ OVERCLAIMED' : r.qualified ? '✓ qualified' : '· unqualified (no false claim)';
      console.log(`  [run ${run}] ${mark}  — ${ask}`);
      if (r.badFigures.length > 0) console.log(`      ✗ figures not in prompt: ${r.badFigures.join(', ')}`);
      console.log(`      ${final.replace(/\n+/g, ' ').slice(0, 190)}`);
    }
  }

  const overclaimed = rows.filter((r) => r.overclaimed);
  const qualified   = rows.filter((r) => r.qualified);
  const badFigures  = rows.filter((r) => r.badFigures.length > 0);
  const guardHits   = rows.filter((r) => r.guardFindings > 0);

  console.log('\n' + '═'.repeat(78));
  console.log('SUMMARY');
  console.log('═'.repeat(78));
  console.log(`  replies:              ${rows.length}`);
  console.log(`  qualified:            ${qualified.length}`);
  console.log(`  OVERCLAIMED:          ${overclaimed.length}`);
  console.log(`  unsupported figures:  ${badFigures.length}`);
  console.log(`  assessment-guard hits:${guardHits.length}  (expected 0 — no dimension grades a merchant ranking)`);
  console.log(`  tokens: in=${inTok.toLocaleString()} out=${outTok.toLocaleString()}`);

  if (OUT) { writeFileSync(OUT, JSON.stringify({ space: space.name, shown, total, rows }, null, 2)); console.log(`\n  transcripts → ${OUT}`); }

  if (overclaimed.length > 0 || badFigures.length > 0) {
    console.log(`\n  ✗ FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\n  ✓ PASSED — no reply asserted more than the rendered evidence supports.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
