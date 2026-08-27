/**
 * scripts/check-evidence-awareness.ts   (CF-5)
 *
 * DOES THE MODEL KNOW WHAT EXISTS WITHOUT PRETENDING IT WAS LOADED?
 *
 *   npm run ai:evidence-awareness
 *   npm run ai:evidence-awareness -- --runs=2 --guard=repair
 *
 * CF-5 gives the prompt ~275 tokens describing evidence that was NOT loaded.
 * That is a deliberately risky thing to hand a language model: the same block
 * that stops it saying "I only have 90 days" also invites it to answer from
 * history it never received. So this harness grades five failure modes, and
 * three of them are failures CF-5 could CAUSE:
 *
 *   false scarcity     "I only have 90 days" while broader evidence exists.
 *                      The failure CF-5 exists to remove.
 *   false loading      quoting a figure for a period that was merely available.
 *                      The failure CF-5 could introduce.
 *   false completeness treating availability as proof the record is complete.
 *   false valuation    turning a crypto QUANTITY range into a value range.
 *   token regression   the envelope growing past its budget.
 *
 * ── Tier ────────────────────────────────────────────────────────────────────
 * OPERATIONAL. Paid, stochastic, never in CI, exits non-zero on any of the
 * above. Reads the database; writes nothing, and deliberately does NOT route
 * through `generateChatReply` (that wrapper records ApiUsage rows).
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { writeFileSync } from 'node:fs';

import '@/lib/ai/assemblers';
import { buildContext } from '@/lib/ai/context-builder';
import { computeAssessment } from '@/lib/ai/intelligence';
import { fetchPerLiabilityDebtPayments } from '@/lib/ai/intelligence/debt-payments';
import { buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { loadCoverageEnvelope, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { routeForMessages, resolveTransactionWindow } from '@/lib/ai/chat/message-analysis';
import {
  detectAssessmentContradiction, buildRepairInstruction, applyGuard, resolveGuardMode,
} from '@/lib/ai/assessment-guard';
import { db } from '@/lib/db';

const CHAT_MODEL = 'gpt-4o-mini';
const TEMPERATURE = 0.3;
const MAX_TOKENS = 1024;
/** The envelope's declared budget. A regression past this is a failure. */
const ENVELOPE_TOKEN_BUDGET = 300;

const args  = process.argv.slice(2);
const RUNS  = Math.max(1, Number(args.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 1));
const GUARD = resolveGuardMode(args.find((a) => a.startsWith('--guard='))?.split('=')[1] ?? 'off');
const SPACE = args.find((a) => a.startsWith('--space='))?.split('=')[1] ?? 'Chris';
const OUT   = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? null;

/**
 * `mustKnow` is a fact only the envelope supplies — it proves awareness landed.
 * `mustNotQuote` are figures the turn did NOT load: quoting one is false
 * loading, and they are chosen to be unreachable from the loaded window.
 */
interface Ask {
  ask: string;
  mustKnow?: RegExp;
  mustNotQuote?: RegExp;
  note?: string;
}

const ASKS: Ask[] = [
  { ask: 'How far back can you see my transactions?',
    mustKnow: /2024|Jul(y)?\s*2024|two years|2 years/i,
    note: 'the envelope says Jul 2024; the loaded window is 90 days' },
  // NOTE: "2025" is a bare year, so CF-3 resolves it and the turn LOADS 2025.
  // An earlier version of this case forbade the 2025 total — scoring a correct,
  // fully-loaded answer as false loading. The awareness being tested here is
  // that the year is answerable at all, not that it is withheld.
  { ask: 'Do you have anything from 2025?',
    mustKnow: /yes|do have|2025/i },
  // The false-LOADING probe needs a year the turn does NOT load. "two years
  // ago" carries a temporal cue CF-3 cannot resolve, so the window stays at the
  // 90-day default while 2024 remains merely available.
  { ask: 'What did I spend two years ago?',
    mustNotQuote: /114,439|51,127/,
    note: 'unresolved period: the default window is loaded, 2024 is only available' },
  { ask: 'What was my most expensive purchase?',
    mustNotQuote: /114,439|51,127/,
    note: 'CF-4 DEFAULT: answer the loaded period, do not reach into history' },
  { ask: 'What are my investments?',
    mustKnow: /investment|brokerage|crypto|digital/i,
    note: 'holdings domain is absent; the model must not claim none exist' },
  { ask: 'Do you have my crypto history?',
    mustKnow: /BTC|Bitcoin|ETH|Ethereum|SOL|Solana/i },
  { ask: 'How much have I ever spent?',
    mustNotQuote: /114,439/,
    note: 'CF-2 shortfall stands; the envelope only lets it say what DOES exist' },
];

/** "I only have 90 days" — the claim the envelope disproves. */
function claimsFalseScarcity(reply: string): boolean {
  return /only (?:have|see|covers?|access to)[^.]{0,40}\b(?:90|ninety) days/i.test(reply)
      || /(?:data|records?|history|transactions?)[^.]{0,30}only[^.]{0,20}\b(?:90|ninety) days/i.test(reply)
      || /(?:don'?t|do not) have (?:any )?(?:data|records?|transactions?|history) (?:before|prior to|older than)/i.test(reply);
}

/** Availability read as completeness. */
function claimsFalseCompleteness(reply: string): boolean {
  return /(?:complete|full|entire|all of your) (?:transaction )?history (?:is|was) (?:available|loaded|included)/i.test(reply)
      || /I have (?:all|every) (?:of )?your transactions?\b/i.test(reply);
}

/** A crypto QUANTITY range presented as a value/portfolio range. */
function claimsFalseValuation(reply: string): boolean {
  return /(?:value|worth|portfolio value|valuation)[^.]{0,60}\b(?:since|back to|from)\s+(?:\w+\s+)?20(1|2)\d/i.test(reply)
      || /\b20(1|2)\d[^.]{0,40}(?:portfolio|holdings?) (?:value|worth)/i.test(reply);
}

interface Row {
  ask: string; run: number; reply: string;
  falseScarcity: boolean; falseLoading: boolean;
  falseCompleteness: boolean; falseValuation: boolean;
  unaware: boolean;
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

  const t0 = Date.now();
  const envelope: CoverageEnvelope = await loadCoverageEnvelope(space.id);
  const censusMs = Date.now() - t0;

  console.log('═'.repeat(78));
  console.log('CF-5 — EVIDENCE AWARENESS (live model)');
  console.log('═'.repeat(78));
  console.log(`  space=${space.name}  model=${CHAT_MODEL} temp=${TEMPERATURE} guard=${GUARD}`);
  console.log(`  census: ${censusMs} ms · transactions ${envelope.transactions.span.fromISO}..${envelope.transactions.span.toISO} (${envelope.transactions.span.count})`);
  console.log(`  chains: ${envelope.chains.map((c) => c.chain).join(', ') || '(none)'}`);
  console.log(`  asks=${ASKS.length} runs=${RUNS}\n`);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const rows: Row[] = [];
  let inTok = 0, outTok = 0, envTok = 0;

  for (const a of ASKS) {
    for (let run = 1; run <= RUNS; run++) {
      const now = new Date();
      const messages = [{ role: 'user' as const, content: a.ask }];
      const ctx = await buildContext(space.id, owner.userId, {
        scopeHint: 'full', transactionWindow: resolveTransactionWindow(messages, now),
      });
      const [assessment, debtPayments] = await Promise.all([
        Promise.resolve(computeAssessment(ctx)),
        fetchPerLiabilityDebtPayments(ctx),
      ]);
      const prompt = buildSpaceSystemPrompt(
        ctx, assessment, routeForMessages(messages), debtPayments, envelope);

      // Envelope cost, measured from the rendered prompt rather than assumed.
      const s = prompt.indexOf('=== AVAILABLE EVIDENCE ===');
      const e = prompt.indexOf('=== END AVAILABLE EVIDENCE ===');
      envTok = s >= 0 && e > s ? Math.ceil((e - s + 30) / 4) : 0;

      const completion = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: 'system', content: prompt }, ...messages],
        temperature: TEMPERATURE, max_tokens: MAX_TOKENS,
      });
      let reply = completion.choices[0]?.message?.content ?? '';
      inTok  += completion.usage?.prompt_tokens ?? 0;
      outTok += completion.usage?.completion_tokens ?? 0;

      const findings = detectAssessmentContradiction(reply, assessment);
      if (GUARD === 'repair' && findings.length > 0) {
        const rep = await client.chat.completions.create({
          model: CHAT_MODEL,
          messages: [
            { role: 'system', content: `${prompt}\n\n${buildRepairInstruction(findings)}` },
            ...messages,
          ],
          temperature: TEMPERATURE, max_tokens: MAX_TOKENS,
        });
        const text = rep.choices[0]?.message?.content ?? '';
        reply = applyGuard(text, detectAssessmentContradiction(text, assessment), GUARD);
        inTok  += rep.usage?.prompt_tokens ?? 0;
        outTok += rep.usage?.completion_tokens ?? 0;
      }

      const row: Row = {
        ask: a.ask, run, reply,
        falseScarcity:     claimsFalseScarcity(reply),
        falseLoading:      a.mustNotQuote !== undefined && a.mustNotQuote.test(reply),
        falseCompleteness: claimsFalseCompleteness(reply),
        falseValuation:    claimsFalseValuation(reply),
        unaware:           a.mustKnow !== undefined && !a.mustKnow.test(reply),
      };
      rows.push(row);

      const bad = [
        row.falseScarcity && 'FALSE SCARCITY',
        row.falseLoading && 'FALSE LOADING',
        row.falseCompleteness && 'FALSE COMPLETENESS',
        row.falseValuation && 'FALSE VALUATION',
        row.unaware && 'UNAWARE',
      ].filter(Boolean);
      console.log(`  [run ${run}] ${bad.length ? `✗ ${bad.join(', ')}` : '✓'}  — ${a.ask}`);
      console.log(`      ${reply.replace(/\n+/g, ' ').slice(0, 200)}`);
      if (bad.length && a.note) console.log(`      ↳ ${a.note}`);
    }
  }

  const n = (k: keyof Row) => rows.filter((r) => r[k] === true).length;

  console.log('\n' + '═'.repeat(78));
  console.log('SUMMARY');
  console.log('═'.repeat(78));
  console.log(`  replies:              ${rows.length}`);
  console.log(`  FALSE SCARCITY:       ${n('falseScarcity')}     ("only 90 days" while more exists)`);
  console.log(`  FALSE LOADING:        ${n('falseLoading')}     (quoted a figure never computed)`);
  console.log(`  FALSE COMPLETENESS:   ${n('falseCompleteness')}     (availability read as completeness)`);
  console.log(`  FALSE VALUATION:      ${n('falseValuation')}     (crypto quantity read as value)`);
  console.log(`  UNAWARE:              ${n('unaware')}     (missed a fact the envelope supplied)`);
  console.log(`  envelope cost:        ${envTok} tokens (budget ${ENVELOPE_TOKEN_BUDGET})`);
  console.log(`  tokens: in=${inTok.toLocaleString()} out=${outTok.toLocaleString()}`);

  if (OUT) { writeFileSync(OUT, JSON.stringify({ space: space.name, envelope, rows }, null, 2)); console.log(`\n  transcripts → ${OUT}`); }

  const overBudget = envTok > ENVELOPE_TOKEN_BUDGET;
  const failed = n('falseScarcity') + n('falseLoading') + n('falseCompleteness')
               + n('falseValuation') + n('unaware') > 0 || overBudget;
  if (overBudget) console.log(`\n  ✗ envelope exceeded its token budget`);
  if (failed) { console.log(`\n  ✗ FAILED`); process.exitCode = 1; }
  else console.log(`\n  ✓ PASSED — the model knows what exists without claiming it was loaded.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
