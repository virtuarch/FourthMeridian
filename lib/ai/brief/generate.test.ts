/**
 * lib/ai/brief/generate.test.ts
 *
 * ACCEPT, REDUCE OR REFUSE — what code does with whatever the model returns.
 *
 * Canned narrations over the golden fixture packages; no network, no database.
 * §6 runs the REAL provider seam against a fake client and fake ledgers, so the
 * one-invocation / surface=brief assertion is about the row the provider writes,
 * not about a stub.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/brief/generate.test.ts
 */

import { readFileSync } from 'node:fs';
import { StructuredOutputRefusalError, StructuredOutputTimeoutError, type StructuredClient } from '@/lib/ai/provider';
import { acceptNarration, generateBriefFromPackage, type StructuredCall } from './generate';
import { GENERATION_CALL_BUDGET_MS, GENERATION_LEASE_MS } from './policy';
import { BRIEF_SCENARIOS } from './fixtures';
import { BRIEF_SYSTEM_PROMPT } from './prompt';
import type { BriefNarration, BriefObservation } from './types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const fixture = (id: string) => BRIEF_SCENARIOS.find((s) => s.id === id)!.pkg;
const ob = (over: Partial<BriefObservation> = {}): BriefObservation => ({
  kind: 'CASH', title: 'Cash is steady', body: 'Your cash is $18.9K.', importance: 'CONTEXT',
  evidence: ['currentState.liquid'], ...over,
});
const narration = (over: Partial<BriefNarration> = {}): BriefNarration => ({
  headline: 'Not much changed yesterday.', quiet: true, observations: [], ...over,
});

async function main() {
  console.log('1. shape');
  {
    const quiet = fixture('01-quiet');
    const zero = acceptNarration(quiet, narration());
    check('zero observations is a valid Brief', zero.ok && zero.narration.observations.length === 0 && zero.narration.quiet);
    const four = acceptNarration(quiet, narration({ observations: [ob(), ob(), ob(), ob()] }));
    check('four observations are refused, not trimmed', !four.ok && four.reason === 'MALFORMED_OUTPUT');
    const three = acceptNarration(quiet, narration({ quiet: false, observations: [ob(), ob(), ob()] }));
    check('three are accepted', three.ok && three.narration.observations.length === 3);
    const contradicts = acceptNarration(quiet, narration({ quiet: true, observations: [ob({ importance: 'NOTABLE' })] }));
    check('quiet follows importance: a NOTABLE observation is not a quiet day, and the correction is recorded',
      contradicts.ok && contradicts.narration.quiet === false && contradicts.validation.quietCorrected);
    const consistent = acceptNarration(quiet, narration({ quiet: true, observations: [ob()] }));
    check('…a consistent narration is left alone', consistent.ok && consistent.narration.quiet && !consistent.validation.quietCorrected);
    const dropped = acceptNarration(quiet, narration({ quiet: false, observations: [ob({ importance: 'NOTABLE', body: 'You have $99,999 hidden away.' })] }));
    check('…and quiet is judged on what survived validation', dropped.ok && dropped.narration.quiet === true);
    const long = acceptNarration(quiet, narration({ headline: 'x'.repeat(141) }));
    check('a 141-character headline is refused', !long.ok && long.reason === 'MALFORMED_OUTPUT');
    const body = acceptNarration(quiet, narration({ observations: [ob({ body: 'y'.repeat(281) })] }));
    check('a 281-character body is refused', !body.ok);
    const kind = acceptNarration(quiet, { ...narration(), observations: [{ ...ob(), kind: 'GOSSIP' }] });
    check('an unknown kind is refused', !kind.ok);
    check('a non-object is refused', !acceptNarration(quiet, 'hello').ok);
  }

  console.log('\n2. figures');
  {
    const quiet = fixture('01-quiet');
    const invented = acceptNarration(quiet, narration({ quiet: false, observations: [
      ob({ body: 'You have about $8,000 set aside for travel.' }),
      ob({ kind: 'INVESTMENTS', title: 'Investments', body: 'Investments rose $240 yesterday.', evidence: ['recentChanges.d1.investments'] }),
    ] }));
    check('an observation with an invented figure is dropped', invented.ok
      && invented.narration.observations.length === 1
      && invented.validation.droppedObservations[0]?.reason === 'UNLICENSED_FIGURE'
      && invented.validation.droppedObservations[0]?.figures?.[0] === '$8,000');
    check('…and a licensed rounded one ($240 for 240.10) is kept', invented.ok && invented.narration.observations[0].kind === 'INVESTMENTS');
    const headline = acceptNarration(quiet, narration({ headline: 'Your net worth hit $150K.' }));
    check('an invented figure in the headline refuses the Brief', !headline.ok && headline.reason === 'UNLICENSED_HEADLINE');
    const rounded = acceptNarration(quiet, narration({ headline: 'Cash sits at $18.9K and net worth near $128K.' }));
    check('a licensed rounded headline is accepted', rounded.ok);
  }

  console.log('\n3. evidence');
  {
    const short = fixture('13-three-weeks');
    const r = acceptNarration(short, narration({ quiet: false, observations: [
      ob({ title: 'Month', body: 'Cash grew this month.', evidence: ['recentChanges.m1.liquid'] }),
      ob({ title: 'Week', body: 'Cash grew this week.', evidence: ['recentChanges.w1.liquid', 'made.up.path'] }),
    ] }));
    check('a window the package did not measure cannot be cited', r.ok
      && r.validation.droppedObservations.some((d) => d.reason === 'NO_EVIDENCE' && d.index === 0));
    check('invalid paths are stripped from an otherwise grounded observation',
      r.ok && r.narration.observations.length === 1 && r.narration.observations[0].evidence.join() === 'recentChanges.w1.liquid'
        && r.validation.strippedEvidence.includes('made.up.path'));
    const bracket = acceptNarration(fixture('02-paycheck'), narration({ quiet: false, observations: [
      ob({ kind: 'INCOME', title: 'Paycheck', body: 'Your Acme paycheck landed.', evidence: ['recentActivity.top[0]'] })] }));
    check('bracket indices resolve', bracket.ok && bracket.narration.observations.length === 1);
  }

  console.log('\n4. a debt payment is not spending');
  {
    const payoff = fixture('04-card-payoff');
    const r = acceptNarration(payoff, narration({ quiet: false, observations: [
      ob({ kind: 'SPENDING', title: 'Big spend', body: 'You spent $3,210.55 at Chase.', evidence: ['recentActivity.top.0'] }),
      ob({ kind: 'DEBT', title: 'Card paid off', body: 'You paid your card down to $0.', evidence: ['recentActivity.top.0', 'currentState.debt'] }),
    ] }));
    check('SPENDING citing a DEBT_PAYMENT row is dropped', r.ok
      && r.validation.droppedObservations[0]?.reason === 'MISLABELED_MOVEMENT');
    check('DEBT citing the same row is kept', r.ok && r.narration.observations.length === 1 && r.narration.observations[0].kind === 'DEBT');
  }

  console.log('\n4b. freshness is the page\'s to show');
  {
    const stale = fixture('09-stale');
    const r = acceptNarration(stale, narration({ quiet: false, observations: [
      ob({ kind: 'DATA_QUALITY', title: 'Data may be out of date', body: 'Some accounts have not updated recently.', importance: 'NOTABLE', evidence: ['freshness.band', 'freshness.oldestBalanceAgeDays'] }),
      ob({ kind: 'CASH', title: 'Cash may be behind', body: 'Your cash of $18.9K may not reflect recent activity.', evidence: ['currentState.liquid', 'freshness.band'] }),
    ] }));
    check('an observation resting only on freshness is dropped — the page already says it',
      r.ok && r.validation.droppedObservations[0]?.reason === 'SHOWN_ON_PAGE');
    check('…one that qualifies a real conclusion with freshness is kept', r.ok && r.narration.observations.length === 1 && r.narration.observations[0].kind === 'CASH');
    check('the instruction tells the model the page shows freshness', /page shows the user when their financial data was last updated/.test(BRIEF_SYSTEM_PROMPT)
      && !/deserve a brief CONTEXT observation even on a quiet day/.test(BRIEF_SYSTEM_PROMPT));
  }

  console.log('\n4b. causality needs evidence — and the evidence is where the row posted');
  {
    // The forensic shape: a hotel charge, and a week's rise in card debt.
    const onCard = structuredClone(fixture('18-stale-brokerage-debt-claim'));
    const debtOb = (over: Partial<BriefObservation> = {}) => ob({ kind: 'DEBT', title: 'Card balance rose',
      body: 'Your card balance rose by $2,480 this week with a Delta Air Lines purchase.', importance: 'NOTABLE',
      evidence: ['recentChanges.w1.debt', 'recentActivity.top.0'], ...over });
    const kept = acceptNarration(onCard, narration({ quiet: false, observations: [debtOb()] }));
    check('a purchase that posted on a LIABILITY account may be tied to the rise in debt',
      kept.ok && kept.narration.observations.length === 1 && onCard.recentActivity!.top[0].account === 'LIABILITY');

    const onChecking = structuredClone(onCard);
    onChecking.recentActivity!.top[0].account = 'LIQUID';
    const dropped = acceptNarration(onChecking, narration({ quiet: false, observations: [debtOb()] }));
    check('the SAME sentence over the SAME amounts is dropped when the row posted on a LIQUID account',
      dropped.ok && dropped.narration.observations.length === 0
        && dropped.validation.droppedObservations[0]?.reason === 'UNCONNECTED_MOVEMENT');
    check('…decided by the account class alone: merchant, category and flow are identical in both',
      JSON.stringify({ ...onCard.recentActivity!.top[0], account: 0 }) === JSON.stringify({ ...onChecking.recentActivity!.top[0], account: 0 }));

    const spending = acceptNarration(onChecking, narration({ quiet: false, observations: [ob({ kind: 'SPENDING',
      title: 'A large travel purchase', body: 'A Delta Air Lines purchase of $2,480 stands out against monthly expenses of $6,240.',
      importance: 'NOTABLE', evidence: ['recentActivity.top.0', 'behavior.monthlyExpenses'] })] }));
    check('the expense is still worth surfacing on its own — no balance is cited, so nothing is refused',
      spending.ok && spending.narration.observations.length === 1);

    const unknown = structuredClone(onCard);
    delete unknown.recentActivity!.top[0].account;
    const notGuessed = acceptNarration(unknown, narration({ quiet: false, observations: [debtOb()] }));
    check('a row whose account class is unknown is not refused by code (only a KNOWN mismatch fires)',
      notGuessed.ok && notGuessed.narration.observations.length === 1);

    const payoff = fixture('04-card-payoff');
    const legs = acceptNarration(payoff, narration({ quiet: false, observations: [ob({ kind: 'DEBT', title: 'Card paid off',
      body: 'You paid off your card balance of $3,210.55.', importance: 'NOTABLE',
      evidence: ['recentChanges.d1.debt', 'recentActivity.top.0', 'recentActivity.top.1'] })] }));
    check('a leg between the user\'s own accounts touches both sides and is always allowed',
      legs.ok && legs.narration.observations.length === 1 && payoff.recentActivity!.top[0].account === 'LIQUID');

    const cash = acceptNarration(onCard, narration({ quiet: false, observations: [ob({ kind: 'CASH', title: 'Cash fell',
      body: 'Your cash changed by $310.44 this week alongside a Delta Air Lines purchase.',
      evidence: ['recentChanges.w1.liquid', 'recentActivity.top.0'] })] }));
    check('it is general, not a debt rule: a card purchase cannot be tied to a CASH movement either',
      cash.ok && cash.validation.droppedObservations[0]?.reason === 'UNCONNECTED_MOVEMENT');
    const worth = acceptNarration(onChecking, narration({ quiet: false, observations: [ob({ kind: 'CASH', title: 'Net worth',
      body: 'Net worth moved by $2,242.72 this week.', evidence: ['recentChanges.w1.netWorth', 'recentActivity.top.0'] })] }));
    check('net worth spans every class, so no row is foreign to it', worth.ok && worth.narration.observations.length === 1);

    const freshOnly = acceptNarration(onCard, narration({ observations: [ob({ kind: 'DATA_QUALITY', title: 'Brokerage is behind',
      body: 'Charles Schwab has not updated recently.', evidence: ['claimEvidence.investments', 'freshness.staleSources.0'] })] }));
    check('an observation resting only on claim evidence is freshness-only too — the page already says it',
      freshOnly.ok && freshOnly.validation.droppedObservations[0]?.reason === 'SHOWN_ON_PAGE');
  }

  console.log('\n5. the instruction');
  {
    check('a classification is explained only from its own reason',
      /explain a classification only from its own scope and reasonMetrics/.test(BRIEF_SYSTEM_PROMPT)
        && !/Say what a classification means in plain words/.test(BRIEF_SYSTEM_PROMPT));
    check('the debt rate is not a debt verdict, and the burden is not interest paid',
      /grades only the interest rate on what is owed today/.test(BRIEF_SYSTEM_PROMPT) && /not interest the user is paying/.test(BRIEF_SYSTEM_PROMPT));
    check('a rate alone is not NOTABLE', !/cash buffer or debt classification at WARNING or CRITICAL/.test(BRIEF_SYSTEM_PROMPT)
      && /when that cost is small it is CONTEXT, however high the rate/.test(BRIEF_SYSTEM_PROMPT));
    check('freshness is never an observation of its own, of any kind',
      /Never write an observation about stale data, a source or a connection, of any kind/.test(BRIEF_SYSTEM_PROMPT));
    check('the model is no longer asked to judge which conclusions rest on a stale source',
      !/qualify only conclusions that rest on them/.test(BRIEF_SYSTEM_PROMPT) && !/guess which connection/.test(BRIEF_SYSTEM_PROMPT)
        && /only when the entry covering its figures has a tier other than observed/.test(BRIEF_SYSTEM_PROMPT));
    check('a movement joins a balance only through the account it posted on',
      /Connect a movement to a change in debt only when its account is LIABILITY/.test(BRIEF_SYSTEM_PROMPT));
    check('a withheld percentage is never replaced by a multiple', /pct is null[^.]*: state the amounts, never a percentage or a multiple/.test(BRIEF_SYSTEM_PROMPT));
    check('stale data must be named', /STALE, VERY_STALE or UNKNOWN/.test(BRIEF_SYSTEM_PROMPT) && /out of date/.test(BRIEF_SYSTEM_PROMPT));
    check('absent windows are not measured', /absent was not measured/.test(BRIEF_SYSTEM_PROMPT));
    check('debt payments are not spending', /DEBT_PAYMENT is paying down debt, not spending/.test(BRIEF_SYSTEM_PROMPT));
    check('no market attribution', /no market or price data/.test(BRIEF_SYSTEM_PROMPT));
    check('quiet is defined by importance', /quiet: true exactly when no observation is NOTABLE/.test(BRIEF_SYSTEM_PROMPT));
    const src = readFileSync('lib/ai/brief/generate.ts', 'utf8');
    check('no earlier Brief is fed back', !/previous|yesterday'?s brief|priorBrief/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')));
    check('no tool loop: no tools are offered', !/tools\s*:/.test(src));
  }

  console.log('\n6. generation — failures typed, accounting real');
  {
    const pkg = fixture('01-quiet');
    const throwing = (err: unknown): StructuredCall => (async () => { throw err; }) as StructuredCall;
    const timeout = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', deps: { structured: throwing(new StructuredOutputTimeoutError(10)) } });
    check('a timeout is TIMEOUT, not a throw', !timeout.ok && timeout.reason === 'TIMEOUT');
    const refused = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', deps: { structured: throwing(new StructuredOutputRefusalError('no')) } });
    check('a refusal is REFUSED', !refused.ok && refused.reason === 'REFUSED');
    const garbled = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', deps: { structured: throwing(new Error('[ai/provider] Model returned a structured response that is not JSON.')) } });
    check('unparseable output is MALFORMED_OUTPUT', !garbled.ok && garbled.reason === 'MALFORMED_OUTPUT');
    const down = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', deps: { structured: throwing(new Error('503')) } });
    check('anything else is PROVIDER_ERROR', !down.ok && down.reason === 'PROVIDER_ERROR');

    // ── A provider rate limit is quota, not a failed Brief ──
    const RATE_LIMITED = new Error('429 Rate limit reached for gpt-5.1 on tokens per min (TPM). Please try again in 8.2s.');
    const fake = (failTimes: number, err: unknown = RATE_LIMITED) => {
      let t = 5_000_000;
      const timeouts: (number | undefined)[] = [];
      const sleeps: number[] = [];
      const structured = (async (_s: unknown, _m: unknown, _sch: unknown, o?: { timeoutMs?: number }) => {
        timeouts.push(o?.timeoutMs); t += 250;
        if (timeouts.length <= failTimes) throw err;
        return { value: narration(), model: 'gpt-5.1', latencyMs: 1, finishReason: 'stop', usage: null };
      }) as unknown as StructuredCall;
      return { timeouts, sleeps, deps: { structured, clock: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } } };
    };
    const blip = fake(1);
    const healed = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', deps: blip.deps });
    check('one 429 then an answer is a Brief, not a refusal — two calls, one honoured wait',
      healed.ok && blip.timeouts.length === 2 && blip.sleeps.length === 1 && blip.sleeps[0] === 9_700);
    check('…and the wait is recorded, so a slow Brief is never mistaken for a slow model',
      healed.meta.rateLimitRetries?.length === 1 && healed.meta.rateLimitRetries[0].waitedMs === 9_700);
    check('the retried call may not buy a second full provider timeout: it gets what is left of the budget',
      blip.timeouts[0] === 60_000 && (blip.timeouts[1] ?? 0) < 75_000 - 9_700 && (blip.timeouts[1] ?? 0) <= 60_000);

    const stuck = fake(99);
    const gaveUp = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', deps: stuck.deps });
    const slept = stuck.sleeps.reduce((a, b) => a + b, 0);
    check('a provider that stays rate-limited fails as PROVIDER_ERROR — bounded, never a loop',
      !gaveUp.ok && gaveUp.reason === 'PROVIDER_ERROR' && stuck.timeouts.length <= 4 && stuck.sleeps.length <= 3,
      `${stuck.timeouts.length} calls`);
    check('…and every wait it took fits inside the budget, which fits inside the generation lease',
      slept < GENERATION_CALL_BUDGET_MS && GENERATION_CALL_BUDGET_MS < GENERATION_LEASE_MS, String(slept));

    const tooLong = fake(99, new Error('429 rate limit. Please try again in 70s.'));
    const failFast = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', deps: tooLong.deps });
    check('a wait that cannot fit the lease is not slept through: one call, fail now',
      !failFast.ok && tooLong.timeouts.length === 1 && tooLong.sleeps.length === 0);

    const flaky = fake(1, new Error('503 upstream'));
    const notQuota = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', deps: flaky.deps });
    check('only a rate limit is retried: a 5xx still fails at once', !notQuota.ok && flaky.timeouts.length === 1 && flaky.sleeps.length === 0);
    const slow = fake(1, new StructuredOutputTimeoutError(10));
    const timedOut = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', deps: slow.deps });
    check('…and so does a timeout — a model is never asked again because of how it answered',
      !timedOut.ok && timedOut.reason === 'TIMEOUT' && slow.timeouts.length === 1);

    const bodies: Record<string, unknown>[] = [];
    const rows: Record<string, unknown>[] = [];
    const client: StructuredClient = { chat: { completions: { create: async (body) => {
      bodies.push(body as Record<string, unknown>);
      return { choices: [{ message: { content: JSON.stringify(narration()) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2000, completion_tokens: 300, total_tokens: 2300,
          prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } };
    } } } };
    const now = new Date('2026-09-13T09:42:00.000Z');
    const r = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', now, deps: { client, sinks: {
      invocationClient: { aiInvocation: { create: async ({ data }) => { rows.push(data); } } },
    } } });
    await new Promise((res) => setImmediate(res));
    check('one Brief is one model call', bodies.length === 1);
    check('exactly one AiInvocation row', rows.length === 1, String(rows.length));
    check('…attributed surface=brief with an opaque correlation id',
      rows[0]?.surface === 'brief' && /^brief_[0-9a-f-]{36}$/.test(String(rows[0]?.correlationId)) && rows[0]?.turnIndex === 0);
    check('the request is gpt-5.1 in the modern dialect', bodies[0]?.model === 'gpt-5.1' && !('temperature' in bodies[0]));
    const msgs = bodies[0]?.messages as { role: string; content: string }[];
    check('system instruction, then the package as data', msgs[0].role === 'system' && msgs[1].content.includes('"identity"'));
    check('no tools offered', !('tools' in bodies[0]));
    check('the Brief carries its provenance', r.ok && r.brief.generatedAt === '2026-09-13T09:42:00.000Z'
      && r.brief.evidenceAsOf === '2026-09-13' && r.brief.briefDay === '2026-09-13');
    check('cost is priced from the gpt-5.1 rate (2,000 in / 300 out = $0.0055)',
      r.ok && Math.abs((r.meta.costUsd ?? 0) - 0.0055) < 1e-9, String(r.ok && r.meta.costUsd));
    check('package size is reported', r.meta.packageBytes > 1000 && r.meta.packageApproxTokens > 250);
    const withReason = await generateBriefFromPackage(pkg, { model: 'gpt-5.1', now, reason: 'change', deps: { structured: (async () => ({
      value: narration(), model: 'gpt-5.1', latencyMs: 1, finishReason: 'stop', usage: null })) as unknown as StructuredCall } });
    check('a generation reason is carried in the correlation id, and only there',
      /^brief_change_[0-9a-f-]{36}$/.test(withReason.meta.correlationId));
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
