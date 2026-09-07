/**
 * scripts/ai-baseline/baseline.test.ts
 *
 * DETERMINISTIC HARNESS BEHAVIOUR — no DB, no model, no network.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs \
 *       scripts/ai-baseline/baseline.test.ts
 *
 * (The preload is required because the tool adapters reach canonical read
 *  authorities that declare `import "server-only"`. scripts/run-tests.ts wires
 *  the same preload, so this file runs in the ordinary suite unchanged.)
 *
 * ⚠️ NOTHING HERE SNAPSHOTS MODEL PROSE. The experiment's output is transcripts
 * a human reads; automating a verdict on them would rebuild the scorer layer the
 * reset removed. What IS pinned is everything the experiment's VALIDITY rests on:
 * that an arm gets what it claims to get, that no arm secretly gets more, that
 * the tool surface cannot write, and that the arithmetic is arithmetic.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { applyInvestmentScenario, SCENARIO_BASIS } from './scenario';
import { TOOLS, openAiToolSchemas, findTool } from './tools';
import { PROBES, PROBE_IDS, findProbe } from './probes';
import { ARMS, ARM_USES_TOOLS, ARM_QUESTION } from './evidence';
import { SYSTEM_INSTRUCTION, supportsTools } from './run';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/**
 * Source with comments stripped.
 *
 * ⚠️ EVERY SOURCE ASSERTION BELOW USES THIS. These files explain themselves at
 * length, and a doc comment saying "the router is NOT run here" would otherwise
 * fail a check for the string `resolveDomains` — the test would be reading the
 * explanation instead of the code.
 */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ══ 1. Probes are conversations, and the goldens do not leak ═════════════════
console.log('1. probes');
{
  check('ten probes', PROBES.length === 10, String(PROBES.length));
  check('ids are unique', new Set(PROBE_IDS).size === PROBES.length);
  check('every probe is multi-turn', PROBES.every((p) => p.turns.length >= 3));
  check('the state probe is the long one',
    (findProbe('projection')?.turns.length ?? 0) >= 8);
  check('the mandated probes all exist',
    ['broad', 'projection', 'cadence', 'debt', 'investments', 'affordability',
      'networth', 'spending', 'strategy', 'format'].every((id) => !!findProbe(id)));

  // The turns are the USER's words only — no expected answer smuggled in.
  check('turns contain no assistant text', PROBES.every((p) => p.turns.every((t) => t.length < 120)));

  const src = code(read('scripts/ai-baseline/run.ts'));
  check('the runner never reads whatItDiscriminates into a message',
    !/content:[^\n]*whatItDiscriminates/.test(src));
  check('…it reaches only the artifact, for the human reader',
    /whatItDiscriminates/.test(src) && /humanReview|blankReview/.test(src));
}

// ══ 2. The instruction stays an instruction ══════════════════════════════════
console.log('2. system instruction');
{
  const words = SYSTEM_INSTRUCTION.split(/\s+/).filter(Boolean).length;
  check(`~100–200 words (is ${words})`, words >= 90 && words <= 210, String(words));
  check('no worked example', !/for example|e\.g\.|example:/i.test(SYSTEM_INSTRUCTION));
  check('no phrase table', !/say "|respond with "|use the phrase/i.test(SYSTEM_INSTRUCTION));
  // The goldens evaluate behaviour; their wording must not become the prompt.
  const goldens = read('docs/plans/AI-CONVERSATION-GOLDENS.md');
  const sentences = SYSTEM_INSTRUCTION.split('\n').filter((l) => l.trim().length > 30);
  check('no sentence of the instruction appears in the goldens',
    sentences.every((s) => !goldens.includes(s.trim())));
  check('names no financial figure', !/\$|\d{3,}/.test(SYSTEM_INSTRUCTION));
}

// ══ 3. Arms get what they claim, and nothing more ════════════════════════════
console.log('3. evidence arms');
{
  check('four arms', ARMS.length === 4);
  check('each arm states the question it answers',
    ARMS.every((a) => (ARM_QUESTION[a] ?? '').length > 20));
  check('A0/A1 have no tools', !ARM_USES_TOOLS.A0 && !ARM_USES_TOOLS.A1);
  check('A2/A3 have tools', ARM_USES_TOOLS.A2 && ARM_USES_TOOLS.A3);

  const raw = read('scripts/ai-baseline/evidence.ts');
  const src = code(raw);
  // The A0/A1 split is the highest-value comparison; it must be one branch.
  check('computeAssessment is CALLED exactly once',
    (src.match(/computeAssessment\(ctx\)/g) ?? []).length === 1);
  check('…and only inside the A1 branch',
    /arm === 'A1'\)\s*\{\s*payload\.deterministicAssessment = computeAssessment\(ctx\)/.test(src));
  check('A3 is given no financial body at all',
    /arm === 'A3'[\s\S]{0,160}body: null/.test(src));
  check('A2 gets a thin core, not the assembled context',
    /arm === 'A2'[\s\S]{0,260}thinCore\(ctx\)/.test(src));
  check('the thin core omits per-account rows and the snapshot series',
    !/function thinCore[\s\S]{0,1200}acc\.accounts/.test(src)
      && !/function thinCore[\s\S]{0,1200}snap\.history/.test(src));
  check('A0/A1 assemble domains directly — the router is NOT run inside the arms',
    !/resolveDomains/.test(src));
  check('…and the reason is recorded where someone will read it',
    /excludes `holdings_summary`/.test(raw) && /resolveDomains/.test(raw));
  check('the assessment is not modified before the comparison',
    !/delete .*assessment|assessment\.\w+ =/.test(src));
}

// ══ 4. The tool surface is read-only ═════════════════════════════════════════
console.log('4. tool surface');
{
  check('ten tools', TOOLS.length === 10, String(TOOLS.length));
  check('names are unique', new Set(TOOLS.map((t) => t.name)).size === TOOLS.length);
  check('every tool describes itself', TOOLS.every((t) => t.description.length > 40));
  check('every schema is a closed object',
    TOOLS.every((t) => (t.parameters as { type: string; additionalProperties: boolean }).type === 'object'
      && (t.parameters as { additionalProperties: boolean }).additionalProperties === false));

  // No write verb may exist in the vocabulary — a model cannot call what is absent.
  const WRITE = /^(set|update|create|delete|write|save|record|apply|correct|categorise|categorize|remember|store|sync|refresh)_/;
  check('no tool name is a write verb', TOOLS.every((t) => !WRITE.test(t.name)));

  const src = code(read('scripts/ai-baseline/tools.ts'));
  for (const op of ['db.', '.create(', '.update(', '.delete(', '.upsert(', 'deleteMany', 'updateMany']) {
    check(`tools.ts contains no \`${op}\``, !src.includes(op));
  }
  check('tools.ts imports no Prisma client', !/from '@\/lib\/db'/.test(src));

  // The vocabulary is the user's, not the architecture's.
  const LEAKED = /assembler|assemble|domain|measure|licence|license|scope_?hint|spine|planner/i;
  check('no tool name leaks internal architecture vocabulary',
    TOOLS.every((t) => !LEAKED.test(t.name)));

  const schemas = openAiToolSchemas() as { type: string; function: { name: string } }[];
  check('schemas are OpenAI function tools', schemas.every((s) => s.type === 'function'));
  check('every schema maps back to a runnable tool',
    schemas.every((s) => !!findTool(s.function.name)));
  check('an unknown name resolves to nothing', findTool('drop_database') === undefined);
}

// ══ 5. Investment scenario is arithmetic ═════════════════════════════════════
console.log('5. investment scenario arithmetic');
{
  const components = [
    { key: 'DIGITAL_ASSETS', label: 'Digital assets', currentValue: 20000 },
    { key: 'TRADITIONAL_INVESTMENTS', label: 'Traditional investments', currentValue: 5000 },
  ];

  const up10 = applyInvestmentScenario({
    components, moves: { DIGITAL_ASSETS: 0.10 }, currentNetWorth: 40000 });
  check('+10% on 20,000 is a 2,000 delta', approx(up10.totalDelta, 2000));
  check('scenario component value is 22,000', approx(up10.legs[0].scenarioValue, 22000));
  check('net worth moves by exactly the delta', approx(up10.scenarioNetWorth!, 42000));
  check('the unmoved component is untouched', up10.legs.length === 1);

  const down = applyInvestmentScenario({
    components, moves: { DIGITAL_ASSETS: -0.30, TRADITIONAL_INVESTMENTS: -0.20 },
    currentNetWorth: 40000 });
  check('two legs compose', approx(down.totalDelta, -(6000 + 1000)));
  check('…and net worth follows', approx(down.scenarioNetWorth!, 33000));

  const zero = applyInvestmentScenario({ components, moves: {}, currentNetWorth: 40000 });
  check('no move ⇒ no delta and net worth unchanged',
    zero.totalDelta === 0 && approx(zero.scenarioNetWorth!, 40000));

  const missing = applyInvestmentScenario({
    components, moves: { REAL_ESTATE: 0.5 }, currentNetWorth: 40000 });
  check('an unmatched component is REPORTED, never silently dropped',
    missing.unresolved.length === 1 && missing.legs.length === 0);

  const noNw = applyInvestmentScenario({
    components, moves: { DIGITAL_ASSETS: 0.1 }, currentNetWorth: null });
  check('no authoritative net worth ⇒ no scenario net worth (never a guess)',
    noNw.scenarioNetWorth === null && approx(noNw.totalDelta, 2000));

  check('the result states it is a hypothesis, not a forecast',
    up10.basis === SCENARIO_BASIS && /not a forecast/i.test(up10.basis)
      && /nothing else changes/i.test(up10.basis));

  const src = code(read('scripts/ai-baseline/scenario.ts'));
  for (const banned of ['Math.random', 'historical', 'expectedReturn', 'volatility', 'probability']) {
    check(`scenario.ts computes no \`${banned}\``, !src.includes(banned));
  }
}

// ══ 6. Conversation state IS the transcript ══════════════════════════════════
console.log('6. conversation state');
{
  const src = code(read('scripts/ai-baseline/run.ts'));
  check('one growing message array across all turns',
    /const messages: unknown\[\]/.test(src) && /for \(const \[index, user\] of probe\.turns/.test(src));
  check('turns are NOT independent requests', !/messages = \[/.test(src.split('const messages')[1] ?? ''));
  check('tool results are appended to the transcript',
    /role: 'tool', tool_call_id/.test(src));
  check('…so a later turn can still see an earlier tool result',
    /messages\.push\(\{ role: 'tool'/.test(src));
  for (const banned of ['ScenarioState', 'ConversationLifecycle', 'assumptionStore', 'MeasureId', 'LicensedFigure']) {
    check(`no \`${banned}\``, !src.includes(banned));
  }
  check('a tool loop is bounded', /MAX_TOOL_ROUNDTRIPS/.test(src));
}

// ══ 7. Failure is recorded, not fatal ════════════════════════════════════════
console.log('7. failure handling');
{
  const runSrc = code(read('scripts/ai-baseline/run.ts'));
  check('a provider error is caught per turn and stored on the record',
    /catch \(err\)[\s\S]{0,200}rec\.error =/.test(runSrc));
  // The write happens after the loop, so a failed case still leaves a transcript.
  check('the artifact is written after the turn loop, on every path',
    runSrc.lastIndexOf('writeFileSync(artifactPath') > runSrc.lastIndexOf('rec.error ='));
  check('…and `ok: false` is recorded in it',
    /ok = false/.test(runSrc) && /turns, totals, ok,/.test(runSrc));

  check('a rate limit is retried, and ONLY a rate limit',
    /isRateLimit = \/rate limit\|429\/i\.test\(message\)/.test(runSrc)
      && /if \(!isRateLimit \|\| attempt > MAX_RATE_LIMIT_RETRIES\) throw err/.test(runSrc));
  check('…bounded', /MAX_RATE_LIMIT_RETRIES = \d/.test(runSrc));
  check('…recorded on the turn, never hidden', /rec\.retries\.push/.test(runSrc));
  check('…and quota waiting is kept OUT of the latency figure',
    /rateLimitWaitMs: t\.rateLimitWaitMs/.test(runSrc)
      && !/latencyMs: t\.latencyMs \+ [\s\S]{0,40}waitedMs/.test(runSrc));

  const cliSrc = code(read('scripts/ai-conversation-baseline.ts'));
  check('one case throwing does not abort the matrix',
    /for \(const \[i, cell\] of matrix\.entries\(\)\)[\s\S]{0,900}catch \(err\)/.test(cliSrc));
}

// ══ 8. Selection is explicit ═════════════════════════════════════════════════
console.log('8. CLI selection');
{
  const src = code(read('scripts/ai-conversation-baseline.ts'));
  check('nothing runs without a selection',
    /probes\.length === 0 \|\| arms\.length === 0 \|\| modelKeys\.length === 0/.test(src));
  check('--all is never implied', !/const all\s*=\s*true/.test(src) && /has\('all'\)/.test(src));
  check('--smoke is the three highest-value probes on one model',
    /SMOKE_PROBES = \['projection', 'debt', 'investments'\]/.test(src)
      && /smoke \? \['mid'\]/.test(src));
  check('an unknown probe or arm is rejected',
    /unknown probe/.test(src) && /unknown arm/.test(src));
  check('--dry-run calls no model', /dry-run: nothing called/.test(src));
  check('the Space is printed before anything runs',
    src.indexOf('READ-ONLY') < src.indexOf('await runCase('));
  check('the Space can be named explicitly', /--space/.test(src) && /flag\('space'\)/.test(src));
}

// ══ 9. Model tiers reflect what the API actually accepts ═════════════════════
console.log('9. model tiers');
{
  check('models without chat.completions tool support are known',
    !supportsTools('gpt-6-astra') && !supportsTools('gpt-5.6-terra'));
  check('…and models with it are not excluded',
    supportsTools('gpt-4o-mini') && supportsTools('gpt-4.1') && supportsTools('gpt-5.5'));

  const provider = code(read('lib/ai/provider.ts'));
  check('the provider selects a parameter dialect by model family',
    /usesModernParams/.test(provider) && /max_completion_tokens/.test(provider));
  check('…and does not send a temperature the newer models reject',
    /modern[\s\S]{0,120}max_completion_tokens[\s\S]{0,120}temperature: 0\.3/.test(provider));
  check('the tool LOOP is not in the provider',
    !/tool_call_id/.test(provider));
}

// ══ 10. Artifacts are complete and carry no secret ═══════════════════════════
console.log('10. artifacts');
{
  const src = code(read('scripts/ai-baseline/run.ts'));
  for (const field of ['probe', 'arm', 'model', 'systemInstruction', 'evidence',
    'toolsOffered', 'turns', 'totals', 'humanReview', 'spaceId', 'asOfISO']) {
    check(`artifact records \`${field}\``, new RegExp(`${field}[:,]`).test(src));
  }
  check('a turn records its tool calls AND their results',
    /toolCalls: \{ name: string; arguments: unknown; result: unknown/.test(src));
  check('a turn records latency and usage', /latencyMs: number/.test(src) && /usage:/.test(src));

  const all = [src, read('scripts/ai-baseline/artifacts.ts'), read('scripts/ai-conversation-baseline.ts')].join('\n');
  for (const secret of ['OPENAI_API_KEY', 'DATABASE_URL', 'ENCRYPTION_KEY', 'apiKey', 'process.env.OPENAI']) {
    check(`no \`${secret}\` reaches an artifact`, !all.includes(secret));
  }

  check('human review fields are blank and not model-populated',
    /accuracy: null/.test(src) && /No automated scorer populates these/.test(src));
  const idx = code(read('scripts/ai-baseline/artifacts.ts'));
  check('the index has no rubric or judge', !/llmJudge|autoScore|rubric\(/i.test(idx));
  check('the index calls out A0 vs A1', /A0 vs A1/.test(idx));
  check('…and the investment scope diagnostic', /SEMANTIC SCOPE/.test(idx));
}

// ══ 11. The production boundary is untouched ═════════════════════════════════
console.log('11. production boundary');
{
  const route = read('app/api/ai/chat/route.ts');
  check('the chat route still refuses', /AWAITING_REDESIGN/.test(route));
  check('…and imports nothing from the harness', !/ai-baseline/.test(route));

  const cli = code(read('scripts/ai-conversation-baseline.ts'));
  const runSrc = code(read('scripts/ai-baseline/run.ts'));
  check('the harness is not imported by any app route',
    !/app\//.test(cli.split('\n').filter((l) => l.startsWith('import')).join('\n')));
  check('the harness does not create lib/ai/chat', !/lib\/ai\/chat/.test(cli + runSrc));
  check('no persistence of conversations',
    !/aiAdvice|conversation\.create|prisma\.conversation/i.test(cli + runSrc));
}

// ══ 12. Interactive mode is the SAME experiment with a keyboard ══════════════
console.log('12. interactive operator mode');
{
  const src  = code(read('scripts/ai-baseline/interactive.ts'));
  const raw  = read('scripts/ai-baseline/interactive.ts');
  const cli  = code(read('scripts/ai-conversation-baseline.ts'));
  const run  = code(read('scripts/ai-baseline/run.ts'));

  // The whole point: one turn loop, not two.
  check('it runs the batch runner\'s turn executor, not a copy',
    /import \{[^}]*executeTurn[^}]*\} from '\.\/run'/.test(src)
      && !/generateWithTools\(/.test(src));
  check('…which is exported from run.ts and used by BOTH',
    /export async function executeTurn/.test(run)
      && /executeTurn\(\{ messages, user, index, model, toolSchemas, toolCtx \}\)/.test(run));
  check('totals are summed by the shared helper', /sumTurns/.test(src) && /export function sumTurns/.test(run));

  // Same arm, same evidence, same instruction, same tools.
  check('the arm is fixed to A2', /const ARM = 'A2' as const/.test(src));
  check('evidence comes from buildEvidence, not a bespoke pack',
    /buildEvidence\(ARM, ctx, spaceCtx\.spaceId\)/.test(src));
  check('the tool surface is the shared one', /openAiToolSchemas\(\)/.test(src));
  check('the instruction is the shared one — not a second prompt',
    /SYSTEM_INSTRUCTION/.test(src) && !/You are Fourth Meridian/.test(src));

  // Artifact parity — a session must be readable beside a recorded run.
  for (const field of ['probe', 'arm', 'armQuestion', 'model', 'toolsOffered',
    'spaceId', 'asOfISO', 'systemInstruction', 'evidence', 'turns', 'totals',
    'ok', 'humanReview']) {
    check(`session artifact carries \`${field}\``, new RegExp(`\\b${field}:`).test(src));
  }
  check('it is labelled as interactive so it is never mistaken for a probe run',
    /mode: 'interactive'/.test(src));
  check('the transcript is written after EVERY turn, not only on a clean exit',
    /const save = \(\): void =>/.test(src) && /turns\.push\(rec\);\s*\n\s*save\(\);/.test(src));
  check('…and on Ctrl-C', /SIGINT/.test(src));

  // It must not quietly become a different experiment.
  check('a model that cannot call tools is REFUSED, not silently downgraded',
    /supportsTools\(model\)/.test(cli) && /cannot call tools through this provider seam/.test(cli));
  check('the picker names that limitation next to the model',
    /cannot call tools — not usable for this mode/.test(cli));
  check('the default tier is the one the recorded runs used',
    /INTERACTIVE_DEFAULT_TIER = 'mid'/.test(cli));

  // Read-only, no production reach, no new machinery.
  for (const banned of ['db.', '.create(', '.update(', '.delete(', 'lib/ai/chat', 'AiAdvice']) {
    check(`interactive.ts contains no \`${banned}\``, !src.includes(banned));
  }
  check('it declares that it fixes none of the known failures',
    /IT FIXES NOTHING/.test(raw));
  check('the production route is still untouched',
    /AWAITING_REDESIGN/.test(read('app/api/ai/chat/route.ts')));
}

console.log(failures === 0 ? '\nAll baseline-harness checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
