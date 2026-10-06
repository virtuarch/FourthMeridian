/**
 * lib/ai/conversation/guidance.test.ts — the financial-guidance boundary, without a model.
 *
 * Pins the three layers of lib/ai/conversation/guidance.ts and the prompt rule in
 * turn.ts:
 *   1. the closed signal and its narrowing (both sides of the wire);
 *   2. THE TABLE — every (level, adjacency) cell, exhaustively;
 *   3. the conversation plan — full once, compact after, nothing on ordinary
 *      analysis, inherited (never dropped) on a failed label;
 *   4. the classifier seam — reads the whole exchange, never throws, never trusts
 *      an off-schema reply;
 *   5. the label never reaches the model or the transcript;
 *   6. the instruction rule — heuristics as options, missing variables named, no
 *      security selection, no model-written disclaimers — with the pre-slice
 *      instruction as the NEGATIVE CONTROL that must fail it.
 *
 * Standalone tsx (house pattern): exits 0/1.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  readGuidance, fromClassifierOutput, disclosureTier, disclosurePlan, classifyGuidance, classifierMessages,
  GUIDANCE_LEVELS, GUIDANCE_ADJACENCIES, GUIDANCE_SCHEMA, GUIDANCE_CLASSIFIER_INSTRUCTION,
  CLASSIFIER_PRIOR_MESSAGES, type GuidanceEntry,
} from './guidance';
import type { AiGuidance } from '@/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const g = (level: AiGuidance['level'], ...adjacencies: AiGuidance['adjacencies']): AiGuidance => ({ level, adjacencies });
const forms = (entries: GuidanceEntry[]) =>
  disclosurePlan(entries).map((p) => (p ? `${p.tier}:${p.form}` : '-')).join(' ');

async function main(): Promise<void> {
  console.log('1. the signal is closed, and narrowed the same way on both sides');
  {
    check('three levels, in increasing consequence',
      GUIDANCE_LEVELS.join(',') === 'UNDERSTANDING,PLANNING,RECOMMENDATION');
    check('five adjacencies', GUIDANCE_ADJACENCIES.length === 5);
    check('a well-formed signal survives', JSON.stringify(readGuidance({ level: 'PLANNING', adjacencies: ['TAX'] }))
      === JSON.stringify(g('PLANNING', 'TAX')));
    check('an unknown level is rejected', readGuidance({ level: 'ADVICE', adjacencies: [] }) === null);
    check('a non-object is rejected', readGuidance('RECOMMENDATION') === null && readGuidance(null) === null);
    check('an unknown adjacency is dropped, the level kept',
      JSON.stringify(readGuidance({ level: 'RECOMMENDATION', adjacencies: ['CRYPTO', 'TAX'] })) === JSON.stringify(g('RECOMMENDATION', 'TAX')));
    check('adjacencies are de-duplicated and canonically ordered',
      JSON.stringify(readGuidance({ level: 'RECOMMENDATION', adjacencies: ['TAX', 'SECURITIES', 'TAX'] }))
        === JSON.stringify(g('RECOMMENDATION', 'SECURITIES', 'TAX')));
    check('missing adjacencies read as none', JSON.stringify(readGuidance({ level: 'UNDERSTANDING' })) === JSON.stringify(g('UNDERSTANDING')));
    const props = GUIDANCE_SCHEMA.schema.properties as Record<string, { type: string; enum?: string[]; description?: string }>;
    check('the provider schema is strict: the closed level enum plus one required, described flag per adjacency',
      JSON.stringify(props.level.enum) === JSON.stringify(GUIDANCE_LEVELS)
        && Object.keys(props).length === 1 + GUIDANCE_ADJACENCIES.length
        && Object.entries(props).filter(([k]) => k !== 'level').every(([, v]) => v.type === 'boolean' && (v.description ?? '').length > 20)
        && GUIDANCE_SCHEMA.schema.required.length === Object.keys(props).length
        && GUIDANCE_SCHEMA.schema.additionalProperties === false);
    check('flags map onto the public signal in canonical order',
      JSON.stringify(fromClassifierOutput({ level: 'RECOMMENDATION', securities: true, tax: true, legal: false, retirementAccounts: false, leverage: false }))
        === JSON.stringify(g('RECOMMENDATION', 'SECURITIES', 'TAX')));
    check('…and off-shape flags are rejected or ignored, never trusted',
      fromClassifierOutput({ level: 'ADVICE', tax: true }) === null
        && JSON.stringify(fromClassifierOutput({ level: 'PLANNING', tax: 'yes' })) === JSON.stringify(g('PLANNING')));
    // Preview, 2026-10-07: "Should I sell $20k of investments to pay this loan?" came back LEVERAGE
    // (the answer said "you're still levered") and never TAX, so the note spoke about borrowing to
    // invest. Per-subject flags with these definitions: SECURITIES+TAX 5/5 on the same exchange.
    check('ordinary debt is not LEVERAGE; a sale carries TAX even when the answer omits it',
      /ordinary debt is false/.test(props.leverage?.description ?? '') && /even when the answer never mentions tax/.test(props.tax?.description ?? '')
        && /selling investments to raise/.test(props.securities?.description ?? ''));
  }

  console.log('2. THE TABLE — every cell');
  {
    for (const level of GUIDANCE_LEVELS) {
      const none = disclosureTier(g(level));
      const want = level === 'RECOMMENDATION' ? 'STANDARD' : 'NONE';
      check(`${level}, no adjacency → ${want}`, none === want, none);
      for (const a of GUIDANCE_ADJACENCIES) {
        const tier = disclosureTier(g(level, a));
        const wantA = level === 'UNDERSTANDING' ? 'NONE' : level === 'PLANNING' ? 'STANDARD' : 'HEIGHTENED';
        check(`${level} + ${a} → ${wantA}`, tier === wantA, tier);
      }
    }
    check('describing a portfolio is not advising on it (UNDERSTANDING + SECURITIES → NONE)',
      disclosureTier(g('UNDERSTANDING', 'SECURITIES')) === 'NONE');
  }

  console.log('3. the conversation plan');
  {
    // Acceptance 1 & 2 — ordinary analysis carries nothing.
    check('"How am I doing?" / "How much do I spend?" carry no note',
      forms([null, g('UNDERSTANDING'), null, g('UNDERSTANDING')]) === '- - - -');
    // Acceptance 3 — planning carries nothing unless it touches an adjacency.
    check('planning guidance carries no note', forms([null, g('PLANNING')]) === '- -');
    // Acceptance 4 — the consequential decision gets the full note.
    check('"Should I use $20k of cash on debt?" → full standard note',
      forms([null, g('RECOMMENDATION')]) === '- STANDARD:FULL');
    // Acceptance 5 & 6 — the regulated-adjacent decision gets the heightened note.
    check('"Should I sell $20k of investments?" → full heightened note',
      forms([null, g('RECOMMENDATION', 'SECURITIES', 'TAX')]) === '- HEIGHTENED:FULL');
    // Acceptance 7 — follow-ups.
    check('a follow-up at the same tier is reminded, not repeated',
      forms([null, g('RECOMMENDATION'), null, g('RECOMMENDATION'), null, g('RECOMMENDATION')])
        === '- STANDARD:FULL - STANDARD:COMPACT - STANDARD:COMPACT');
    check('an analysis question mid-decision carries nothing, and the decision resumes compact',
      forms([g('RECOMMENDATION'), g('UNDERSTANDING'), g('RECOMMENDATION')]) === 'STANDARD:FULL - STANDARD:COMPACT');
    check('a follow-up the classifier read as PLANNING keeps the reminder (live miss, on4)',
      forms([null, g('RECOMMENDATION'), null, g('PLANNING'), null, g('PLANNING')])
        === '- STANDARD:FULL - STANDARD:COMPACT - STANDARD:COMPACT');
    check('…until the conversation returns to plain understanding, which ends the decision',
      forms([g('RECOMMENDATION'), g('UNDERSTANDING'), g('PLANNING')]) === 'STANDARD:FULL - -');
    check('…and planning before any decision still carries nothing', forms([g('PLANNING'), g('PLANNING')]) === '- -');
    check('a NEW subject earns its own full note',
      forms([g('RECOMMENDATION'), g('RECOMMENDATION', 'SECURITIES'), g('RECOMMENDATION', 'SECURITIES')])
        === 'STANDARD:FULL HEIGHTENED:FULL HEIGHTENED:COMPACT');
    check('after a heightened note, a standard one is only a reminder',
      forms([g('RECOMMENDATION', 'TAX'), g('RECOMMENDATION')]) === 'HEIGHTENED:FULL STANDARD:COMPACT');
    check('the full note names the subjects; the plan carries them',
      JSON.stringify(disclosurePlan([g('RECOMMENDATION', 'SECURITIES')])[0]?.adjacencies) === '["SECURITIES"]');
    // A failed label inherits, never drops.
    check('an UNCLASSIFIED follow-up to a decision keeps the reminder',
      forms([g('RECOMMENDATION', 'SECURITIES'), 'UNCLASSIFIED']) === 'HEIGHTENED:FULL HEIGHTENED:COMPACT');
    check('…but with nothing to inherit it adds nothing', forms(['UNCLASSIFIED', g('UNDERSTANDING'), 'UNCLASSIFIED']) === '- - -');
    check('user turns, refusals and restored lines are outside the boundary',
      forms([null, null, g('RECOMMENDATION'), null]) === '- - STANDARD:FULL -');
    // NEGATIVE CONTROL — the policy this replaces: a note on every consequential turn.
    const everyTurn = (es: GuidanceEntry[]) => es.filter((e) => e && e !== 'UNCLASSIFIED' && disclosureTier(e) !== 'NONE').length;
    const seq = [g('RECOMMENDATION'), g('RECOMMENDATION'), g('RECOMMENDATION'), g('RECOMMENDATION')];
    const full = disclosurePlan(seq).filter((p) => p?.form === 'FULL').length;
    check(`negative control: "disclaim every time" would draw ${everyTurn(seq)} full notes; the plan draws ${full}`,
      everyTurn(seq) === 4 && full === 1);
  }

  console.log('4. the classifier seam');
  {
    const prior = [
      { role: 'user' as const, content: 'Should I use $20k of my cash to pay down my debt?' },
      { role: 'assistant' as const, content: 'It depends on the APR …' },
    ];
    let seen: { system: string; body: string; schema: unknown } | null = null;
    const label = await classifyGuidance({ prior, asked: 'What about $10k instead?', answer: 'At $10k …' },
      async (system, messages, schema) => { seen = { system, body: messages[0].content, schema }; return { level: 'RECOMMENDATION', securities: false, tax: false, legal: false, retirementAccounts: false, leverage: false }; });
    const s = seen as { system: string; body: string; schema: unknown } | null;
    check('a follow-up is classified WITH the decision it continues (prior turns are in the input)',
      !!s && s.body.includes('Should I use $20k') && s.body.includes('What about $10k instead?') && s.body.includes('At $10k'));
    check('…and the label comes back narrowed', JSON.stringify(label) === JSON.stringify(g('RECOMMENDATION')));
    check('…under the fixed instruction and the strict schema', s?.system === GUIDANCE_CLASSIFIER_INSTRUCTION && s?.schema === GUIDANCE_SCHEMA);
    check('a provider failure is null, never a thrown turn',
      (await classifyGuidance({ prior: [], asked: 'q', answer: 'a' }, async () => { throw new Error('503'); })) === null);
    check('an off-schema reply is null', (await classifyGuidance({ prior: [], asked: 'q', answer: 'a' }, async () => ({ level: 'ADVICE' }))) === null);
    const many = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `turn-${i}` }));
    const body = classifierMessages({ prior: many, asked: 'x'.repeat(5_000), answer: 'y'.repeat(9_000) })[0].content;
    check(`only the last ${CLASSIFIER_PRIOR_MESSAGES} prior messages are read`, !body.includes('turn-5') && body.includes('turn-6') && body.includes('turn-9'));
    check('long turns are clipped, and say so', body.includes('[truncated]') && body.length < 10_000);
    check('the instruction keys on the exchange, not on words',
      /read in the light of the earlier turns/.test(GUIDANCE_CLASSIFIER_INSTRUCTION)
        && /including a short follow-up/.test(GUIDANCE_CLASSIFIER_INSTRUCTION));
    check('…and a declined or hedged answer does not demote the question',
      /even when the answer declines, hedges or only lays out options/.test(GUIDANCE_CLASSIFIER_INSTRUCTION));
    // NEGATIVE CONTROL — keyword detection, which the brief rules out, gets the follow-up wrong.
    const keyword = (q: string) => /\bshould\b/i.test(q);
    check('negative control: a "should" keyword rule misses the follow-up the classifier is given context for',
      keyword('What about $10k instead?') === false);
  }

  console.log('5. the label never reaches the model, the transcript or the seal');
  {
    const src = readFileSync(path.join(process.cwd(), 'lib/ai/conversation/engine.ts'), 'utf8');
    const turnAt = src.indexOf('const record = await executeTurn(');
    const classifyAt = src.indexOf('classifyGuidance(');
    check('classification runs after the turn has answered', turnAt > 0 && classifyAt > turnAt);
    check('…and its result is not pushed into the transcript', !/messages\.push\([^)]*guidance/.test(src));
    const guidanceSrc = readFileSync(path.join(process.cwd(), 'lib/ai/conversation/guidance.ts'), 'utf8');
    check('guidance.ts reads no question text with a pattern (no keyword rules)',
      !/\.test\((args\.)?asked|asked\.match|\/\\bshould/.test(guidanceSrc));
    const route = readFileSync(path.join(process.cwd(), 'app/api/ai/chat/route.ts'), 'utf8');
    check('the sealed runtime state does not carry it',
      /sealRuntimeStateWithReport\(\s*\{ scenario: turn\.scenario, pending: turn\.pending, continuity: turn\.continuity \}/.test(route));
  }

  console.log('6. the instruction: calibrated, not cautious');
  {
    const { SYSTEM_INSTRUCTION, GUIDANCE_RULE, systemInstructionWith } = await import('./turn');
    const rule = (instr: string) => ({
      optionsBeforeVerdict: /realistic options and what each/.test(instr) && /which the evidence favours/.test(instr),
      heuristicIsAnOption: /rule of thumb/.test(instr) && /never a target you set/.test(instr),
      missingVariableNamed: /something you lack/.test(instr) && /show how it changes the answer/.test(instr),
      noSecuritySelection: /Never pick securities or funds for them/.test(instr),
      noModelDisclaimer: /Neither claim nor disclaim being/.test(instr),
    });
    const shipped = rule(SYSTEM_INSTRUCTION);
    for (const [k, v] of Object.entries(shipped)) check(`shipped instruction: ${k}`, v);
    check('the shipped instruction is the rule-on arm', SYSTEM_INSTRUCTION === systemInstructionWith({ guidance: true }));
    // NEGATIVE CONTROL — the pre-slice instruction fails every clause of the new contract.
    const before = rule(systemInstructionWith({ guidance: false }));
    check('negative control: the pre-slice instruction fails every clause', Object.values(before).every((v) => v === false),
      JSON.stringify(before));
    check('…and the rule-off arm is byte-identical to the pre-slice instruction minus nothing else',
      systemInstructionWith({ guidance: false }) === SYSTEM_INSTRUCTION.replace(`\n\n${GUIDANCE_RULE}`, ''));
    check('it does not refuse: "Form a view when asked for one" still stands', /Form a view when asked for one/.test(SYSTEM_INSTRUCTION));
    // The reserve thresholds come from a contract; the contract must not hand the choice to the model.
    const { findTool } = await import('./tools');
    const baselines = findTool('get_baselines')?.description ?? '';
    check('get_baselines offers 3/6/12 months as reference points, not a standard',
      /reference points to set side by side, not a standard/.test(baselines) && /leave the choice of reserve to the user/.test(baselines));
    check('the position contracts say a sale\'s tax effect is not in the data (DATA OWNS TRUTH)',
      /a sale's tax effect is\s+unknown here/.test(findTool('get_financial_snapshot')?.description ?? '')
        && /a sale's tax effect is never in this data/.test(findTool('get_investments')?.description ?? ''));
    check('negative control: the pre-slice contract handed the reserve judgement to the model',
      !/that judgement is yours/.test(baselines));
    check('no figures, no worked example, no disclaimer copy in the rule',
      !/\$|\d|for example|e\.g\.|not financial advice|consult/i.test(GUIDANCE_RULE));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall guidance checks passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
