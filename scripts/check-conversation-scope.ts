/**
 * scripts/check-conversation-scope.ts   (CF-4)
 *
 * DOES A PERIOD SURVIVE THE NEXT QUESTION, IN A REAL CONVERSATION?
 *
 *   npm run ai:conversation-scope
 *   npm run ai:conversation-scope -- --runs=1 --guard=repair
 *
 * The other temporal harnesses ask single questions. This one holds a
 * CONVERSATION: each turn is appended to the message list, the assistant's own
 * replies are fed back, and the context is rebuilt per turn exactly as the chat
 * route rebuilds it. That matters because the defect CF-4 closes only exists
 * across turns — every individual prompt in the broken version was internally
 * consistent and confidently wrong.
 *
 * ── What it grades ──────────────────────────────────────────────────────────
 *   drift      a later turn answered from a period the user never asked about.
 *              Caught by requiring a figure that only the CORRECT period can
 *              produce, so a reply cannot pass by hedging.
 *   robotic    the period restated so insistently that the conversation reads
 *              like a form. An inherited scope should be named once, naturally,
 *              not re-announced with boilerplate in every reply.
 *
 * Both directions are graded because a fix that made the model recite "for the
 * period 2025-01-01 to 2025-12-31" before every sentence would satisfy the
 * first and ruin the product.
 *
 * ── Tier ────────────────────────────────────────────────────────────────────
 * OPERATIONAL. Paid, stochastic, never in CI, exits non-zero on either failure.
 * Reads the database; writes nothing, and deliberately does NOT route through
 * `generateChatReply` (that wrapper records ApiUsage rows).
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { writeFileSync } from 'node:fs';

import '@/lib/ai/assemblers';
import { buildContext } from '@/lib/ai/context-builder';
import { computeAssessment } from '@/lib/ai/intelligence';
import { fetchPerLiabilityDebtPayments } from '@/lib/ai/intelligence/debt-payments';
import { buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import {
  routeForMessages, resolveTransactionWindow, resolveDrilldown,
} from '@/lib/ai/chat/message-analysis';
import {
  detectAssessmentContradiction, buildRepairInstruction, applyGuard, resolveGuardMode,
} from '@/lib/ai/assessment-guard';
import { db } from '@/lib/db';

const CHAT_MODEL = 'gpt-4o-mini';
const TEMPERATURE = 0.3;
const MAX_TOKENS = 1024;

const args  = process.argv.slice(2);
const RUNS  = Math.max(1, Number(args.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 1));
const GUARD = resolveGuardMode(args.find((a) => a.startsWith('--guard='))?.split('=')[1] ?? 'off');
const SPACE = args.find((a) => a.startsWith('--space='))?.split('=')[1] ?? 'Chris';
const OUT   = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? null;

/**
 * `expect` is a regex the reply MUST match — chosen so only the right period
 * can produce it. "2025|114,439" passes on the year or on the year's total and
 * fails on the ninety-day figure, which is what makes drift detectable without
 * grading prose.
 *
 * `forbid` catches the opposite: a figure that ONLY the wrong period yields.
 */
interface Turn { ask: string; expect?: RegExp; forbid?: RegExp; note?: string }

const CONVERSATIONS: { name: string; turns: Turn[] }[] = [
  {
    name: 'C1  establish 2025, then refine twice',
    turns: [
      { ask: 'What did I spend in 2025?', expect: /2025/ },
      { ask: 'What was my most expensive purchase?',
        expect: /2025|2,611|AMEXTRAVEL/i, forbid: /Airbnb/i,
        note: 'Airbnb $3,315.87 is the 90-day answer; AMEXTRAVEL $2,611.49 is the 2025 answer' },
      { ask: 'Who did I spend the most with?', expect: /2025/ },
    ],
  },
  {
    name: 'C2  replace the period mid-conversation',
    turns: [
      { ask: 'What did I spend in 2025?', expect: /2025/ },
      { ask: 'What about 2024?', expect: /2024/, forbid: /114,439/ },
      { ask: 'And my biggest purchase?', expect: /2024/, forbid: /2025/ },
    ],
  },
  {
    name: 'C3  clear the period',
    turns: [
      { ask: 'What did I spend in 2025?', expect: /2025/ },
      { ask: 'Forget that timeframe — what are my top merchants?',
        forbid: /114,439/,
        note: 'must not answer from the discarded 2025 scope' },
    ],
  },
  {
    name: 'C4  an unresolved period does not borrow the active one',
    turns: [
      { ask: 'What did I spend in 2025?', expect: /2025/ },
      { ask: 'What about the summer before I moved?',
        expect: /could ?n[o']?t (?:determine|work out|identify|tell)|unable to determine|which (?:exact )?dates/i,
        forbid: /114,439/ },
    ],
  },
  {
    name: 'C5  scope-free from the first turn',
    turns: [
      { ask: 'What was my most expensive purchase?', expect: /90 days|May|Airbnb/i,
        note: 'the declared default, named' },
    ],
  },
];

/** Boilerplate that reads as a form rather than a conversation. */
function isRobotic(reply: string): boolean {
  const restatements = (reply.match(
    /\b(?:for the period|in the period|within the period|during the period|the period from|scope(?:d)? to)\b/gi,
  ) ?? []).length;
  return restatements >= 3
    || /\b2025-01-01 to 2025-12-31\b[\s\S]*\b2025-01-01 to 2025-12-31\b/.test(reply);
}

interface Row {
  convo: string; run: number; turn: number; ask: string; reply: string;
  summaryWindow: string; drilldownWindow: string | null;
  drift: boolean; robotic: boolean; guardFindings: number;
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
  console.log('CF-4 — CONVERSATION TEMPORAL SCOPE (live model, multi-turn)');
  console.log('═'.repeat(78));
  console.log(`  space=${space.name}  model=${CHAT_MODEL} temp=${TEMPERATURE} guard=${GUARD}`);
  console.log(`  conversations=${CONVERSATIONS.length} runs=${RUNS}\n`);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const rows: Row[] = [];
  let inTok = 0, outTok = 0;

  for (const convo of CONVERSATIONS) {
    for (let run = 1; run <= RUNS; run++) {
      console.log(`\n  ${convo.name}${RUNS > 1 ? `  [run ${run}]` : ''}`);
      const messages: { role: 'user' | 'assistant'; content: string }[] = [];

      for (let ti = 0; ti < convo.turns.length; ti++) {
        const t = convo.turns[ti];
        messages.push({ role: 'user', content: t.ask });

        // Exactly the chat route's per-turn resolution, over the live history.
        const now = new Date();
        const window    = resolveTransactionWindow(messages, now);
        const drilldown = resolveDrilldown(messages, now);
        const ctx = await buildContext(space.id, owner.userId, {
          scopeHint: 'full', transactionWindow: window, drilldown,
        });
        const [assessment, debtPayments] = await Promise.all([
          Promise.resolve(computeAssessment(ctx)),
          fetchPerLiabilityDebtPayments(ctx),
        ]);
        const prompt = buildSpaceSystemPrompt(
          ctx, assessment, routeForMessages(messages), debtPayments);

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

        // Conversation carries forward — the assistant's own words included,
        // because the next turn's scope resolution reads the same history.
        messages.push({ role: 'assistant', content: reply });

        const txn = (ctx.domains['transactions_summary'] as { data?: { startDate?: string; endDate?: string } } | undefined)?.data;
        const summaryWindow = txn ? `${txn.startDate}..${txn.endDate}` : '(none)';
        const drilldownWindow = drilldown
          ? `${drilldown.startDate ?? '(default)'}..${drilldown.endDate ?? ''}` : null;

        const drift = (t.expect !== undefined && !t.expect.test(reply))
                   || (t.forbid !== undefined &&  t.forbid.test(reply));
        const robotic = isRobotic(reply);

        rows.push({ convo: convo.name, run, turn: ti + 1, ask: t.ask, reply,
                    summaryWindow, drilldownWindow, drift, robotic,
                    guardFindings: findings.length });

        const mark = drift ? '✗ DRIFT' : robotic ? '✗ ROBOTIC' : '✓';
        console.log(`    T${ti + 1} ${mark}  "${t.ask}"`);
        console.log(`        window=${summaryWindow}${drilldownWindow ? `  drilldown=${drilldownWindow}` : ''}`);
        console.log(`        ${reply.replace(/\n+/g, ' ').slice(0, 175)}`);
        if (drift && t.note) console.log(`        ↳ ${t.note}`);
      }
    }
  }

  const drift   = rows.filter((r) => r.drift);
  const robotic = rows.filter((r) => r.robotic);
  const guard   = rows.filter((r) => r.guardFindings > 0);

  console.log('\n' + '═'.repeat(78));
  console.log('SUMMARY');
  console.log('═'.repeat(78));
  console.log(`  turns:                 ${rows.length}`);
  console.log(`  SCOPE DRIFT:           ${drift.length}  (answered from a period the user never asked about)`);
  console.log(`  ROBOTIC:               ${robotic.length}  (period restated to the point of boilerplate)`);
  console.log(`  assessment-guard hits: ${guard.length}  (expected 0 — no dimension grades a window)`);
  console.log(`  tokens: in=${inTok.toLocaleString()} out=${outTok.toLocaleString()}`);

  if (OUT) { writeFileSync(OUT, JSON.stringify({ space: space.name, rows }, null, 2)); console.log(`\n  transcripts → ${OUT}`); }

  if (drift.length > 0 || robotic.length > 0) {
    console.log(`\n  ✗ FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\n  ✓ PASSED — every turn answered within the period the conversation established.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
