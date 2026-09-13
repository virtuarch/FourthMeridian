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

  console.log('\n5. the instruction');
  {
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
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
