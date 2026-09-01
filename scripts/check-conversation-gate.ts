/**
 * scripts/check-conversation-gate.ts   (V26-REASONING Slice 4)
 *
 * DOES THE PRODUCT WORK?
 *
 *     npm run ai:conversation-gate
 *     npm run ai:conversation-gate -- --verbose --model=gpt-4.1
 *
 * ⚠️ THIS IS A DIFFERENT QUESTION FROM `ai:forecast-conformance`, AND THE TWO
 * MUST NOT SHARE A SCORE. That corpus answers "does the product LIE" — it is a
 * truth-regression net, and a system that answers "I cannot say" to everything
 * scores perfectly on it. This answers "does the product WORK": can somebody
 * have the conversation the product exists for.
 *
 * ⚠️ ONE CONVERSATION, SEVEN TURNS, AND DELIBERATELY NOT A CORPUS. Broadening
 * this into lexical variants converts a sharp product gate into a fuzzy
 * regression suite nobody reads. Variants are Slice 5's corpus. Make THIS
 * conversation excellent first.
 *
 *   1. "How much will I probably have by December?"
 *   2. "Nah, assume I spend $5K/month."
 *   3. "What would my net worth be?"
 *   4. "What if Bitcoin goes up 10%?"
 *   5. "And what about February?"
 *   6. "Okay, what's realistic though?"
 *   7. "So what will Bitcoin be worth in December?"
 *
 * ⚠️ THE SEVENTH TURN MUST DECLINE, AND IT IS NOT DECORATION. A gate made only
 * of turns that must be ANSWERED is passed by a system that answers everything —
 * which is the failure A4.2's S10 exists to catch in the other direction ("a
 * model that answers 'I cannot say' to everything is perfectly conformant and
 * completely useless"). The same trap, mirrored. One turn that must decline,
 * inside the gate, keeps the gate honest.
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';

import { generateStructured } from '@/lib/ai/provider';
import {
  realSpaceCtx, STREAMS, HORIZON, AS_OF,
} from '@/lib/ai/conformance/forecast-scenarios';
import { masterMeasureContext } from '@/lib/reasoning/master/dedupe';
import { FinanceDomains, type AccountsSectionData, type AccountSummaryItem } from '@/lib/ai/types';
import { resolveTurn } from '@/lib/reasoning/scenario/turn';
import { planTurn } from '@/lib/reasoning/plan/planner';
import { deriveConversationState } from '@/lib/reasoning/scenario/derive';
import { DeltaStatus, DeltaDimension, activeDeltas } from '@/lib/reasoning/scenario/types';
import { buildTypedPromptSuffix } from '@/lib/reasoning/answer/for-request';
import { ANSWER_SCHEMA } from '@/lib/reasoning/answer/schema';
import { verifyAnswer, buildRepairInstruction } from '@/lib/reasoning/verify/verify';
import { deterministicFallback } from '@/lib/reasoning/answer/generate';
import { MeasureId } from '@/lib/reasoning/measure/types';
import type { Answer } from '@/lib/reasoning/answer/types';
import type { ConversationState } from '@/lib/reasoning/scenario/types';
import type { TurnResolution } from '@/lib/reasoning/scenario/turn';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const MODEL = args.find((a) => a.startsWith('--model='))?.split('=')[1];
/** Structural checks only — no model calls, no key, no cost. */
const STRUCTURE_ONLY = args.includes('--structure-only');
const PACE_MS = Number(args.find((a) => a.startsWith('--pace='))?.split('=')[1] ?? 45_000);
/**
 * ⚠️ THE SAME SEVEN TURNS, WITH THE PLANNER CHOOSING THE MEASURES. Slice 4's
 * `selectMeasures` is a quarantined stand-in marked for deletion; `--planner`
 * runs the gate through `planTurn` instead, which is the only way to know
 * whether the planner can hold a conversation rather than answer a question.
 */
const USE_PLANNER = args.includes('--planner');
/**
 * ⚠️ SLICE 6'S ACCEPTANCE, AND IT IS THE SAME SEVEN TURNS. `--master` runs the
 * conversation against TWO Spaces that SHARE AN ACCOUNT, through the
 * deduplicated composition, and must produce the same answers as the
 * single-Space run — plus correct dedup. Anything else means master and
 * named-Space have diverged again, which is what PARITY-1/2/3 exist because of.
 */
const MASTER = args.includes('--master');

const TURNS = [
  'How much will I probably have by December?',
  'Nah, assume I spend $5K/month.',
  'What would my net worth be?',
  'What if Bitcoin goes up 10%?',
  'And what about February?',
  "Okay, what's realistic though?",
  'So what will Bitcoin be worth in December?',
] as const;

/**
 * What each turn must be true of.
 *
 * ⚠️ THE STRUCTURAL EXPECTATIONS ARE ON THE RESOLUTION, NOT ON THE PROSE, and
 * that is the point of having a typed layer at all. A regex over the reply can
 * only ask whether it SOUNDS right; this asks whether the right measure was
 * evaluated, under the right scenario, at the right instant, with the right
 * deltas still in force.
 */
interface Expect {
  why: string;
  structural: (r: TurnResolution, prior: TurnResolution[]) => string[];
  /** Applied to the served reply. Kept few and specific. */
  prose?: { must?: RegExp[]; mustNot?: RegExp[]; why: string }[];
}

const ex = (why: string, structural: Expect['structural'], prose?: Expect['prose']): Expect =>
  ({ why, structural, prose });

const measureIds = (r: TurnResolution) => r.measures.map((m) => m.id);
const futureOf = (r: TurnResolution, id: string) =>
  r.measures.find((m) => m.id === id && m.at.kind === 'DATE');
const valueOf = (r: TurnResolution, id: string) => {
  const m = futureOf(r, id);
  return m && m.resolution.kind === 'VALUE' ? m.resolution.value : null;
};

const EXPECT: Expect[] = [
  // ── 1 ──────────────────────────────────────────────────────────────────────
  ex('a figure, BASE, OBSERVED_CONTINUATION, and the horizon set to December',
    (r) => {
      const f: string[] = [];
      if (!measureIds(r).includes(MeasureId.LIQUID_CASH)) f.push('did not resolve liquid cash');
      if (r.scenario.id !== 'BASE') f.push(`scenario is ${r.scenario.id}, expected BASE`);
      if (r.state.horizon === null || !/^2026-12/.test(r.state.horizon.iso)) {
        f.push(`horizon is ${r.state.horizon?.iso ?? 'unset'}, expected a December date`);
      }
      if (valueOf(r, MeasureId.LIQUID_CASH) === null) f.push('produced no cash figure');
      if (activeDeltas(r.state).length !== 0) f.push('invented an assumption from a plain question');
      return f;
    }),

  // ── 2 ──────────────────────────────────────────────────────────────────────
  ex('the delta is ACTIVE, the figure MOVES, and the framing names the assumption',
    (r, prior) => {
      const f: string[] = [];
      const active = activeDeltas(r.state);
      const spend = active.find((d) => d.dimension === DeltaDimension.SPENDING);
      if (!spend) f.push('no ACTIVE spending delta was derived from "assume I spend $5K/month"');
      if (spend && spend.payload.kind === 'MONTHLY_AMOUNT' && spend.payload.value !== 5000) {
        f.push(`read $5K as ${spend.payload.value}`);
      }
      // ⚠️ THE FIGURE MUST MOVE. A delta that is ACTIVE and changes nothing is a
      // label, not an assumption.
      const before = valueOf(prior[0], MeasureId.LIQUID_CASH);
      const after = valueOf(r, MeasureId.LIQUID_CASH);
      if (before !== null && after !== null && Math.abs(before - after) < 0.01) {
        f.push(`the figure did not move: ${before} -> ${after}`);
      }
      if (r.framing.length === 0) f.push('the assumption is not passed to narration (rule 1)');
      // ⚠️ AND THE HORIZON MUST NOT SILENTLY REVERT. PROJECTION-1 measured this:
      // a refinement that names no period fell to the 3-month default and
      // answered a question the user had not asked, with a smaller number.
      if (!/^2026-12/.test(r.state.horizon?.iso ?? '')) f.push('the December horizon was lost');
      return f;
    },
    [{ must: [/5,?000|5k/i], why: 'must name the assumption it is pricing' }]),

  // ── 3 ──────────────────────────────────────────────────────────────────────
  ex('net_worth at the SAME horizon, under the SAME scenario — not ending cash',
    (r) => {
      const f: string[] = [];
      if (!measureIds(r).includes(MeasureId.NET_WORTH)) f.push('did not resolve net worth');
      if (measureIds(r).includes(MeasureId.LIQUID_CASH)) {
        f.push('answered with ending cash rather than net worth');
      }
      if (!/^2026-12/.test(r.state.horizon?.iso ?? '')) f.push('the December horizon was lost');
      const spend = activeDeltas(r.state).find((d) => d.dimension === DeltaDimension.SPENDING);
      if (!spend) f.push('the spending assumption was dropped by a follow-up (the FORECAST-13 defect)');
      // ⚠️ IT MUST NOT REFUSE WHOLESALE. The brief: "I do NOT want: 'I cannot
      // project your year-end net worth because future Bitcoin prices are
      // unknown.'"
      if (valueOf(r, MeasureId.NET_WORTH) === null) {
        f.push('refused a net worth because a leg is unknown — the behaviour the brief rejects');
      }
      return f;
    }),

  // ── 4 ──────────────────────────────────────────────────────────────────────
  ex('a SECOND scenario, with the FIRST still ACTIVE',
    (r) => {
      const f: string[] = [];
      const active = activeDeltas(r.state);
      if (!active.some((d) => d.dimension === DeltaDimension.INVESTMENT_RETURN)) {
        f.push('no investment-return delta from "what if Bitcoin goes up 10%"');
      }
      if (!active.some((d) => d.dimension === DeltaDimension.SPENDING)) {
        f.push('the spending assumption was lost when a second one arrived');
      }
      if (active.length < 2) f.push(`only ${active.length} delta(s) active, expected 2`);
      return f;
    }),

  // ── 5 ──────────────────────────────────────────────────────────────────────
  ex('the horizon moves to February, and BOTH deltas stay ACTIVE',
    (r) => {
      const f: string[] = [];
      if (!/^2027-02|^2026-02/.test(r.state.horizon?.iso ?? '')) {
        f.push(`horizon is ${r.state.horizon?.iso ?? 'unset'}, expected February`);
      }
      const active = activeDeltas(r.state);
      if (!active.some((d) => d.dimension === DeltaDimension.SPENDING)) f.push('spending delta lost');
      if (!active.some((d) => d.dimension === DeltaDimension.INVESTMENT_RETURN)) {
        f.push('investment-return delta lost');
      }
      // A bare "and what about February?" names no measure; it must inherit.
      if (measureIds(r).length === 0) f.push('resolved no measure at all');
      return f;
    }),

  // ── 6 ──────────────────────────────────────────────────────────────────────
  ex('every delta DISMISSED, back to BASE, and the answer says so',
    (r) => {
      const f: string[] = [];
      if (activeDeltas(r.state).length !== 0) {
        f.push(`${activeDeltas(r.state).length} delta(s) survived "what's realistic though?"`);
      }
      if (r.scenario.id !== 'BASE') f.push('did not return to BASE');
      if (!r.dismissedThisTurn) f.push('the turn does not report that it dropped the assumptions');
      // ⚠️ DISMISSED, NOT DELETED. A state that erased them could not tell the
      // user what it stopped assuming.
      const dismissed = r.state.deltas.filter((d) => d.status === DeltaStatus.DISMISSED);
      if (dismissed.length < 2) f.push('the dismissed assumptions were erased rather than flagged');
      return f;
    },
    [{ must: [/assum|realistic|recent|observ|actual|pattern/i],
      why: 'must say it dropped the assumptions and is back to observed patterns' }]),

  // ── 7 ──────────────────────────────────────────────────────────────────────
  ex('MUST NOT PREDICT — frames scenarios instead',
    (r) => {
      const f: string[] = [];
      // The measure must be digital assets, and at FLAT (no delta is active
      // after turn 6) it is today's value held constant — an ASSUMPTION, never a
      // prediction. What must not happen is a HYPOTHETICAL or a derived return
      // presented as an expectation.
      if (!measureIds(r).includes(MeasureId.DIGITAL_ASSETS_VALUE)) {
        f.push('did not resolve the digital-asset measure');
      }
      const m = futureOf(r, MeasureId.DIGITAL_ASSETS_VALUE);
      if (m && m.resolution.kind === 'VALUE' && m.resolution.standing === 'MEASURED') {
        f.push('presented a FUTURE crypto value as MEASURED');
      }
      return f;
    },
    [
      { mustNot: [/\bwill be worth\b|\bwill reach\b|\bis expected to (?:be|reach|hit)\b|\bI (?:predict|expect) (?:it|bitcoin)\b/i],
        why: 'must not predict a future Bitcoin price' },
      // ⚠️ TWO REQUIREMENTS, SCORED SEPARATELY, BECAUSE THEY FAIL SEPARATELY.
      // The first version of this check ran them together and the transcript
      // showed the model saying "future price movements are not predictable" —
      // which satisfies the honesty half perfectly and which the regex missed,
      // because it looked for "unpredictable" and not "not predictable". The
      // scorer has now been wrong before the model eight times in this
      // programme. Read the transcripts.
      // ⚠️ AND IT WAS WRONG AGAIN, ON THIS EXACT LINE. The transcript read
      // "Nobody CAN KNOW what Bitcoin will actually be worth in December" — the
      // sentence the brief asked for, word for word in spirit — and the pattern
      // scored it a failure because it looked for "nobody knows". This is the
      // ninth time in this programme a scorer has been wrong before the model.
      // The predicate is now about the CLAIM (that the value is not knowable),
      // not about one conjugation of one verb.
      { must: [/nobody (?:knows|can know)|no one (?:knows|can know)|can'?t (?:know|say|tell)|cannot (?:know|say|tell|be known)|unable to (?:know|say)|don'?t know|no way to know|unknowab|unpredictab|not predictab|not something (?:I|anyone) can|uncertain/i],
        why: 'must say the price is not knowable' },
      // ⚠️ AND IT MUST OFFER THE SHAPE OF THE UNCERTAINTY. A single flat number
      // with a caveat is truthful and poor: "the same as today, because we
      // assume no change" reads as a forecast of no change. The brief asked for
      // "if your portfolio stays flat, around A. At +5%, around B."
      { must: [/\bif\b[^.]{0,60}(?:up|down|rose|fell|higher|lower|\d+\s*%)|scenario|illustrat|range|between .{0,30}and/i],
        why: 'must offer the shape of the uncertainty, not one number with a caveat' },
    ]),
];

async function main(): Promise<void> {
  // ── The Space, or two overlapping Spaces composed into one ────────────────
  //
  // ⚠️ THE SECOND SPACE SHARES THE CHECKING ACCOUNT AND ADDS ONE OF ITS OWN, so
  // a naive sum would double-count $10,228.74 and a correct dedup counts it
  // once. That is the whole question Slice 6 answers.
  const single = realSpaceCtx();
  let ctx = single;
  if (MASTER) {
    // ⚠️ THE SHARED FIXTURE'S ROWS DO NOT ACCOUNT FOR ITS OWN TOTALS, and the
    // composition guard caught it. `realSpaceCtx` declares
    // `totalDigitalAssets: 19,014.63` with `counts.digitalAssets: 4` and carries
    // NO digital-asset rows in `accounts[]` — so recomputing from the rows
    // returned $0.00 and the answer read "your digital assets are projected to
    // be $0.00, even if Bitcoin goes up 10%".
    //
    // That is a FIXTURE gap, not a product one: the accounts assembler emits a
    // row per account at `scopeHint: 'full'`, which is what master uses. The
    // fixture only ever needed the totals, because nothing before this composed
    // over rows. So the rows are completed HERE rather than in the shared
    // fixture, which every other corpus depends on being byte-stable.
    const completeRows = (c: ReturnType<typeof realSpaceCtx>) => {
      const a = c.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData;
      const rows = [...(a.accounts ?? [])] as AccountSummaryItem[];
      const proto = rows[0];
      const missing = a.totalDigitalAssets
        - rows.filter((r) => r.type === 'crypto' || r.type === 'wallet')
          .reduce((t, r) => t + (r.reportingBalance ?? 0), 0);
      if (Math.abs(missing) > 0.01) {
        rows.push({ ...proto, id: 'w1', name: 'Wallet', type: 'crypto',
          balance: missing, reportingBalance: missing });
      }
      a.accounts = rows;
      a.accountIds = rows.map((r: AccountSummaryItem) => r.id);
      return c;
    };
    completeRows(single);

    const shared = completeRows(realSpaceCtx());
    const a = shared.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData;
    // Same checking account (same id), plus one savings account only this Space
    // can see — and its totals restated to match, since this Space is a
    // different Space and not a copy.
    const checking = (a.accounts ?? [])[0] as AccountSummaryItem;
    a.accounts = [
      checking,
      { ...checking, id: 's9', name: 'Shared Savings', type: 'savings',
        balance: 2_500, reportingBalance: 2_500 },
    ];
    a.accountIds = a.accounts.map((r: AccountSummaryItem) => r.id);
    a.totalLiquid = (checking.reportingBalance ?? 0) + 2_500;
    a.totalInvestments = 0; a.totalDigitalAssets = 0;
    a.totalRealAssets = 0;  a.totalLiabilities = 0;
    a.totalAssets = a.totalLiquid; a.netWorth = a.totalLiquid;
    a.counts = { liquid: 2, investments: 0, digitalAssets: 0, realAssets: 0, liabilities: 0 };

    const m = masterMeasureContext([single, shared]);
    if (!m.ok) {
      console.log(`[MASTER] composition REFUSED: ${m.reason.code} — ${m.reason.detail}`);
      process.exit(1);
    }
    ctx = m.ctx;
    const composed = ctx.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData;
    const singleAcc = single.domains[FinanceDomains.ACCOUNTS]?.data as AccountsSectionData;
    console.log(`[MASTER] ${m.distinctCount} distinct accounts, `
      + `${m.sharedCount} shared placement(s) deduplicated`);
    console.log(`[MASTER] liquid: ${singleAcc.totalLiquid} (one Space) `
      + `-> ${composed.totalLiquid} (two Spaces, one shared account + $2,500 savings)`);
    // ⚠️ THE DEDUP IS ASSERTED HERE, NOT ASSUMED. A shared checking account
    // counted twice would read $22,957.48.
    const expected = (singleAcc.totalLiquid ?? 0) + 2_500;
    if (Math.abs((composed.totalLiquid ?? 0) - expected) > 0.005) {
      console.log(`[MASTER] FAILED — expected ${expected}, got ${composed.totalLiquid}`);
      process.exit(1);
    }
    console.log('[MASTER] dedup correct — the shared account is counted once.\n');
  }
  const history: { role: string; content: string }[] = [];
  const resolutions: TurnResolution[] = [];
  const transcript: unknown[] = [];
  let failures = 0;
  let lastAnswer: ConversationState['lastAnswer'] = null;

  if (!STRUCTURE_ONLY && !process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set (use --structure-only to skip the model).');
    process.exit(2);
  }

  for (const [i, question] of TURNS.entries()) {
    // ⚠️ PACED. The frontier tier's TPM ceiling is 30,000 and a turn costs up to
    // two ~11k-token calls, so an unpaced seven-turn run rate-limits on the last
    // turn — which the gate would then report as a product failure. A harness
    // that cannot tell "the model refused" from "the account was throttled" is
    // measuring the wrong thing.
    if (i > 0 && !STRUCTURE_ONLY) await new Promise((r) => setTimeout(r, PACE_MS));
    history.push({ role: 'user', content: question });

    let plan = null as Awaited<ReturnType<typeof planTurn>>;
    if (USE_PLANNER && !STRUCTURE_ONLY) {
      const st = deriveConversationState(history, AS_OF, { lastAnswer });
      plan = await planTurn({ question, state: st, todayISO: AS_OF, model: MODEL });
    }
    const r = resolveTurn({
      messages: history, ctx, streams: STREAMS, asOfISO: AS_OF,
      defaultHorizon: HORIZON, lastAnswer, plan,
    });
    resolutions.push(r);

    const structural = EXPECT[i].structural(r, resolutions.slice(0, i));

    // ── The reply ────────────────────────────────────────────────────────────
    let served = '';
    let outcome = 'skipped';
    let v1Detail: string[] = [];
    if (!STRUCTURE_ONLY) {
      const { suffix, table } = buildTypedPromptSuffix({
        forecast: r.forecast, ctx, messages: history,
        measures: r.measures, framing: r.framing, turnWithheld: r.withheld,
      });
      const prompt = [
        'You are the financial assistant for this Space. Answer the user\'s question',
        'directly, in plain language, in the second person. Be brief.',
        `Today's date is ${AS_OF}.`,
        suffix,
      ].join('\n');
      const msgs = history.map((h) => ({ role: 'user' as const, content: h.content }));
      const opts = MODEL ? { model: MODEL } : undefined;
      try {
        const first = await generateStructured<Answer>(prompt, msgs, ANSWER_SCHEMA, opts);
        const v1 = verifyAnswer(first, table);
        v1Detail = v1.failures.map((f) => `${f.kind}:${f.offending ?? f.detail}`);
        if (v1.ok) { served = first.prose; outcome = 'clean'; }
        else {
          const rep = await generateStructured<Answer>(
            `${prompt}\n\n${buildRepairInstruction(v1.failures)}`, msgs, ANSWER_SCHEMA, opts);
          if (verifyAnswer(rep, table).ok) { served = rep.prose; outcome = 'repaired'; }
          else { served = deterministicFallback(table); outcome = 'fallback'; }
        }
      } catch (err) {
        served = ''; outcome = `error:${err instanceof Error ? err.message : ''}`;
      }
      history.push({ role: 'assistant', content: served });
    }

    const prose: string[] = [];
    if (!STRUCTURE_ONLY) {
      // ⚠️ A FALLBACK IS NOT A PASS, AND THIS GATE IS THE ONE PLACE THAT MUST
      // SAY SO. The deterministic fallback is a 25-line bullet dump of every
      // licensed figure. It is SAFE — that is what `ai:answer-boundary` measures
      // and it is why it exists — and it is not an ANSWER. This gate asks "does
      // the product work", and a gate that accepted a bullet dump would be
      // measuring the same thing the conformance corpus already measures.
      //
      // It very nearly did: the first version of this check passed T6 and T7 on
      // fallbacks, because the dump happens to contain the words the prose
      // patterns were looking for.
      if (outcome === 'fallback' || outcome === 'malformed') {
        prose.push(`FAILED — the answer was discarded and the user got the `
          + `deterministic list instead (${outcome})`);
      }
      if (outcome.startsWith('error')) prose.push(`FAILED — ${outcome}`);
      for (const p of EXPECT[i].prose ?? []) {
        if (p.must && !p.must.some((re) => re.test(served))) prose.push(`MISSING — ${p.why}`);
        if (p.mustNot && p.mustNot.some((re) => re.test(served))) prose.push(`FORBIDDEN — ${p.why}`);
      }
      // ⚠️ RULE 1, ENFORCED ON THE ANSWER AND NOT ONLY ON THE PROMPT. An
      // assumption the user cannot see is the dangerous one, and the whole
      // safety argument for carrying deltas across turns is that they appear.
      if (r.framing.length > 0 && outcome !== 'fallback') {
        const named = r.framing.some((f) => {
          const amt = /([\d,]+(?:\.\d+)?)\s*[kK]?/.exec(f)?.[1];
          return amt !== undefined && served.replace(/,/g, '').includes(amt.replace(/,/g, ''));
        }) || /assum|you said|your stated|based on your/i.test(served);
        if (!named) prose.push('MISSING — an ACTIVE assumption priced this answer and is not named in it (rule 1)');
      }
    }

    lastAnswer = {
      measureIds: [...new Set(r.measures.map((m) => m.id))],
      scenarioIds: [r.scenario.id],
      horizonISO: r.state.horizon?.iso ?? null,
    };

    const all = [...structural, ...prose];
    if (all.length > 0) failures++;
    console.log(`${all.length === 0 ? '✓' : '✗'} T${i + 1} "${question}"  [${outcome}]`);
    console.log(`    ${EXPECT[i].why}`);
    console.log(`    scenario=${r.scenario.id} horizon=${r.state.horizon?.iso ?? '—'} `
      + `active=${activeDeltas(r.state).length} measures=${[...new Set(measureIds(r))].join(',')}`);
    for (const f of all) console.log(`    ${f}`);
    if (outcome !== 'clean' && v1Detail.length > 0) {
      console.log(`    first attempt: ${v1Detail.slice(0, 5).join(' | ')}`);
    }
    if (verbose && served) console.log(served.split('\n').map((l) => `      | ${l}`).join('\n'));
    transcript.push({ turn: i + 1, question, served, outcome, structural, prose,
      scenario: r.scenario.id, horizon: r.state.horizon?.iso ?? null,
      deltas: r.state.deltas.map((d) => ({ id: d.id, dim: d.dimension, status: d.status,
        statedAs: d.statedAs, supersededBy: d.supersededBy })) });
  }

  writeFileSync('/tmp/conversation-gate.json', JSON.stringify(transcript, null, 2));
  console.log(`\n  ${TURNS.length - failures}/${TURNS.length} turns clean`);
  console.log('transcript -> /tmp/conversation-gate.json');

  if (failures > 0) {
    console.log('\n[CONVERSATION GATE] FAILED — the product does not have this conversation.');
    process.exit(1);
  }
  console.log('\n[CONVERSATION GATE] PASSED — the conversation works.');
}

void main();
