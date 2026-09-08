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
import {
  TOOLS, openAiToolSchemas, findTool, readWindowToExhaustion, clampToCeiling,
  monthEndsBetween, yearEndsBetween,
} from './tools';
import {
  runScenarioLedger, growthFactor, validateReturns, expandContributions, solveForTarget,
  PROVENANCE, MAX_EXPANDED_CONTRIBUTIONS,
} from './scenario-ledger';
import { compactToolHistory, DEFAULT_COMPACTION } from './compaction';
import { WRITE_TOOL_NAME } from './memory-tools';
import { validatePayload, MemoryKind } from './memory-store';
import {
  compareToStatement, diffBasis, readCheckpoint, ON_TRACK_BAND,
} from './reconcile';
import { TRANSACTION_FETCH_LIMIT } from '@/lib/ai/assemblers/transactions';
import { PROBES, PROBE_IDS, findProbe } from './probes';
import { ARMS, ARM_USES_TOOLS, ARM_QUESTION } from './evidence';
import { SYSTEM_INSTRUCTION, supportsTools } from './run';
import {
  usesModernParams, completionBudgetFor,
  CLASSIC_COMPLETION_BUDGET, REASONING_COMPLETION_BUDGET,
} from '@/lib/ai/provider';

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
  check('eleven probes', PROBES.length === 11, String(PROBES.length));
  check('…one of which is long enough to measure context retention',
    (findProbe('session')?.turns.length ?? 0) >= 15);
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
  check('fifteen tools', TOOLS.length === 15, String(TOOLS.length));
  check('names are unique', new Set(TOOLS.map((t) => t.name)).size === TOOLS.length);
  check('every tool describes itself', TOOLS.every((t) => t.description.length > 40));
  check('every schema is a closed object',
    TOOLS.every((t) => (t.parameters as { type: string; additionalProperties: boolean }).type === 'object'
      && (t.parameters as { additionalProperties: boolean }).additionalProperties === false));

  // ⚠️ ONE WRITE VERB EXISTS NOW, AND IT IS NAMED HERE RATHER THAN TOLERATED.
  // Slice 6 added memory. The rule did not soften from "nothing writes" to
  // "writes are fine"; it became "exactly one tool writes, it is `remember`, and
  // it can reach exactly one table". A second write verb appearing anywhere in
  // the surface fails this.
  const WRITE = /^(set|update|create|delete|write|save|record|apply|correct|categorise|categorize|remember|store|sync|refresh)/;
  const writeNamed = TOOLS.filter((t) => WRITE.test(t.name)).map((t) => t.name);
  check('exactly one tool name is a write verb', writeNamed.length === 1, writeNamed.join(','));
  check('…and it is `remember`', writeNamed[0] === WRITE_TOOL_NAME && WRITE_TOOL_NAME === 'remember');

  const src = code(read('scripts/ai-baseline/tools.ts'));
  for (const op of ['db.', '.create(', '.update(', '.delete(', '.upsert(', 'deleteMany', 'updateMany']) {
    check(`tools.ts contains no \`${op}\``, !src.includes(op));
  }
  check('tools.ts imports no Prisma client', !/from '@\/lib\/db'/.test(src));

  // ── The exception, bounded exactly ──────────────────────────────────────────
  //
  // ⚠️ THE FINANCIAL SURFACE IS STILL INCAPABLE OF MUTATING ANYTHING. The memory
  // store is the whole write path in the harness, and the only Prisma accessor
  // it may name is `db.spaceMemory`. A `db.transaction`, a `db.financialAccount`
  // or a `db.space` write here fails the build.
  const storeSrc = code(read('scripts/ai-baseline/memory-store.ts'));
  const accessors = [...storeSrc.matchAll(/\bdb\.(\w+)/g)].map((m) => m[1]);
  const txAccessors = [...storeSrc.matchAll(/\btx\.(\w+)/g)].map((m) => m[1]);
  check('the only Prisma model the write path can reach is SpaceMemory',
    [...new Set([...accessors, ...txAccessors])].every((x) => x === 'spaceMemory' || x === '$transaction'),
    [...new Set([...accessors, ...txAccessors])].join(','));
  check('no other harness file holds a Prisma client',
    ['tools.ts', 'scenario-ledger.ts', 'scenario.ts', 'compaction.ts', 'memory-tools.ts']
      .every((f) => !/from '@\/lib\/db'/.test(code(read(`scripts/ai-baseline/${f}`)))));
  check('the ledger and the compactor remain pure',
    !/^import /m.test(read('scripts/ai-baseline/scenario-ledger.ts'))
      && !/from '@\//m.test(code(read('scripts/ai-baseline/compaction.ts'))));

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
  // `let`, not `const`, since Clip 6: compaction returns a NEW array and the loop
  // rebinds it. It is still ONE transcript carried across every turn.
  check('one growing message array across all turns',
    /let messages: unknown\[\]/.test(src) && /for \(const \[index, user\] of probe\.turns/.test(src));
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
    /const save = \(\): void =>/.test(src)
      // compaction may sit between the push and the save; the save still happens.
      && /turns\.push\(rec\);[\s\S]{0,320}?\n\s*save\(\);/.test(src));
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

// ══ 13. Dogfood tuning — clips 1–5 ═══════════════════════════════════════════
//
// Each check below corresponds to a measured dogfood failure. The comment names
// the failure, because a check whose reason is forgotten is a check somebody
// deletes.

console.log('13a. clip 1 — the harness stops losing answers');
{
  const run  = code(read('scripts/ai-baseline/run.ts'));
  const prov = code(read('lib/ai/provider.ts'));
  const inter= code(read('scripts/ai-baseline/interactive.ts'));
  const cli  = code(read('scripts/ai-conversation-baseline.ts'));

  // Two dogfood turns returned '' with finish_reason 'length' and recorded NO error,
  // because the guard tested `=== null` and '' is not null.
  check('an empty or whitespace answer is a FAILURE, not an answer',
    /if \(!rec\.assistant\?\.trim\(\) && !rec\.error\)/.test(run));
  check('…and the recorded reason names the exhausted budget',
    /finishReason === 'length'/.test(run) && /completion budget was exhausted/.test(run));
  check('…and reasoning spend is quoted in it', /reasoning\)/.test(run));
  check('…and `assistant` is nulled so nothing downstream reads "" as text',
    /rec\.assistant = null;/.test(run));

  // gpt-5.x reasoning tokens are billed inside the completion budget.
  check('reasoning tokens are captured from the provider',
    /reasoning_tokens/.test(prov) && /reasoningTokens:/.test(prov));
  check('…carried on the turn record and summed', /reasoningTokens/.test(run));
  check('the completion budget is dialect-aware, not one shared number',
    completionBudgetFor('gpt-4.1') === CLASSIC_COMPLETION_BUDGET
      && completionBudgetFor('gpt-5.5') === REASONING_COMPLETION_BUDGET);
  check('…and the reasoning budget is well above the observed ~1,500 tok spend',
    REASONING_COMPLETION_BUDGET >= 4 * 1500);
  for (const [m, modern] of [['gpt-4o-mini', false], ['gpt-4.1', false], ['gpt-5.5', true],
    ['gpt-5-mini', true], ['gpt-6-astra', true], ['o3', true]] as [string, boolean][]) {
    check(`dialect: ${m} ⇒ ${modern ? 'modern' : 'classic'}`, usesModernParams(m) === modern);
  }
  check('the interactive loop prints finish_reason when a turn produced no text',
    /finish_reason: \$\{rec\.finishReason\}/.test(inter));

  // One session lost three turns to `400 invalid model ID` after a question was
  // typed at the model prompt and accepted as a model id.
  check('an unrecognised model entry is rejected and re-asked',
    /LOOKS_LIKE_MODEL_ID/.test(cli) && /is not one of the listed options/.test(cli));
  check('…and free prose cannot pass as a model id',
    !/^gpt|^o\d/.test('what is my financial situation looking like'));
}

console.log('13b. clip 2 — history granularity and coverage');
{
  const src = code(read('scripts/ai-baseline/tools.ts'));

  // The tool read raw Snapshot fields, so 407 unassertable points were reported as
  // facts and the model told the user he had negative net worth in early 2025.
  check('history routes through the assembler projection, not raw rows',
    /projectSnapshotSection\(rows as Snapshot\[\], 'full'\)/.test(src));
  check('…and never reads netWorth/totalCrypto off a raw snapshot row',
    !/r\.totalCrypto/.test(src) && !/r\.netWorth/.test(src) && !/r\.totalSavings/.test(src));
  check('a monthly granularity exists', /granularity: 'monthly' \| 'daily'/.test(src)
    || /enum: \['monthly', 'daily'\]/.test(src));
  check('…and is the default for a range over a quarter', /spanDays > 92 \? 'monthly'/.test(src));
  check('month-end means the LAST point in the month, not every Nth day',
    /byMonth\.set\(p\.date\.slice\(0, 7\), p\)/.test(src));
  check('coverage is returned as evidence', /coverage: \{/.test(src)
    && /pointsUnassertable/.test(src) && /firstAssertableDate/.test(src));
  check('…and says what a null point is NOT',
    /NOT zero and NOT measured/.test(src));
  check('a silent maxPoints clamp is reported', /maxPointsClamped/.test(src));
}

console.log('13c. clip 3 — project_cash');
{
  const src = code(read('scripts/ai-baseline/tools.ts'));

  // The synthetic context carried only ACCOUNTS, so PROJECTION-1 saw zero reliable
  // months and returned closing: null for every horizon.
  check('the transactions domain reaches the forecast context',
    /forecastCtx[\s\S]{0,220}TRANSACTIONS_SUMMARY\]: \{ data: transactions \}/.test(src));
  check('…and it is named `forecastCtx`, not a "fake" one', !/fakeCtx/.test(src));

  // Product decision: the evidence-based estimate is the answer; the strict path
  // qualifies it and must not be offered as a rival figure.
  check('the evidence-based estimate is the headline field', /projection: f\.projection/.test(src));
  check('…and the strict path is provenance, named as such',
    /establishment: \{/.test(src) && /must not be offered as an alternative figure/.test(src));
  check('…and the strict refusal reasons are preserved, not deleted',
    /notEstablished/.test(src) && /licensed\.missing/.test(src));

  // The label said USER_ASSUMED whenever observedSpending was absent, even with
  // no user assumption in play.
  check('the spending source is never mislabelled USER_ASSUMED',
    /userAssumed[\s\S]{0,140}'USER_STATED'/.test(src)
      && !/kind: 'USER_ASSUMED'/.test(src));
  check('…and a genuinely absent basis says NONE', /source: 'NONE'/.test(src));

  // Checkpoints must not compound.
  check('each checkpoint is an independent run from the same asOf',
    /const run = runTo\(end\)/.test(src));
  check('…and the adapter does no money arithmetic beyond a reported delta',
    (src.match(/closing - prevClosing/g) ?? []).length === 1);
  check('the checkpoint contract is stated where someone would break it',
    /balance carried forward from the previous one/.test(read('scripts/ai-baseline/tools.ts')));
  check('a basis block discloses the drivers',
    /basis: \{/.test(src) && /incomeEventsCounted/.test(src) && /monthsAveraged/.test(src));
  check('the estimate carries its own qualification', /EVIDENCE_BASED_ESTIMATE/.test(src)
    && /not a guaranteed forecast/.test(src));
}

console.log('13d. clip 3 — month-end arithmetic (pure)');
{
  // The helper is not exported (it is an implementation detail of one tool), so the
  // CONTRACT is asserted here against the shape the tool must produce: the last
  // entry is always the horizon, which is what makes the final checkpoint equal the
  // standalone endpoint rather than nearly equal it.
  const src = code(read('scripts/ai-baseline/tools.ts'));
  check('month-ends are generated, not hand-listed', /function monthEndsBetween/.test(src));
  check('…strictly after the start', /if \(iso > fromISO\) out\.push\(iso\)/.test(src));
  check('…and the horizon is always the last entry',
    /out\[out\.length - 1\] !== toISO && toISO > fromISO/.test(src));
}

console.log('13e. clip 4 — semantic flow on transactions');
{
  const src = code(read('scripts/ai-baseline/tools.ts'));
  // "biggest purchase last month" surfaced a payroll deposit.
  check('a flow vocabulary exists and maps to canonical FlowType',
    /FLOW_SETS/.test(src) && /FlowType\.SPENDING/.test(src) && /FlowType\.INCOME/.test(src));
  check('…and it reaches the read authority', /flowTypes \}/.test(src));
  check('…chosen by the model, never by keyword matching here',
    /THE MODEL PICKS/.test(read('scripts/ai-baseline/tools.ts')));
  check('spending means outflows, not income', !/spending:\s*\[FlowType\.INCOME/.test(src));
  check('a bounded ranking discloses its bound',
    /rankedOver/.test(src) && /rankingIsComplete/.test(src) && /rankingCaveat/.test(src));
}

console.log('13f. clip 5 — temporal identity');
{
  const src = code(read('scripts/ai-baseline/tools.ts'));
  // Since the information ceiling landed, the instant a result describes is the
  // CEILING, not unconditionally today — which is the point of the parameter.
  check('get_transactions names its instant', /asOf: ceiling,\n\s*window: \{ from/.test(src));
  check('get_investments names its instant', /asOf: ctx\.asOfISO,\n\s*\/\/|asOf: ctx\.asOfISO,/.test(src));
  check('investment_scenario states it is a CURRENT-instant scenario',
    /effectiveAt: ctx\.asOfISO/.test(src) && /does NOT move forward in time/.test(src));
  check('…and warns against composing it with a projection',
    /doNotComposeWith/.test(src));
  check('project_cash carries both ends of its horizon',
    /horizon: \{ asOf, to: toISO, days: horizonDays \}/.test(src));
}

// ══ 14. Complete-window ranking ══════════════════════════════════════════════
//
// `sort: 'largest'` ranked the newest 100 matching rows and called the winner
// "your biggest". On a 173-row month that answered from 58% of the data, and on a
// 144-row spending population it is the difference between a $680 Shein purchase
// and a $5,306 payroll deposit. Raising the page would move the cliff, not remove
// it — the ranking now pages the keyset cursor to exhaustion.
// ⚠️ THE ONLY ASYNC SECTION, so it runs inside an IIFE — the house pattern is a
// top-level script and tsx compiles these to CJS, where top-level await is not
// available. The summary and exit code move inside it so nothing can report a
// pass before this section has run.
void (async () => {
console.log('14. complete-window ranking');
{
  type Row = { id: string; date: string; amount: number };
  const row = (i: number): Row => ({ id: `t${i}`, date: '2026-08-01', amount: -i });

  /** A fake seam that hands out fixed-size pages and a strictly advancing cursor. */
  const pagerOf = (total: number) => {
    let calls = 0;
    const read = (async (args: { query: { limit?: number; cursor?: { lastId: string } } }) => {
      calls++;
      const limit = args.query.limit ?? 100;
      const start = args.query.cursor ? Number(args.query.cursor.lastId.slice(1)) + 1 : 0;
      const rows = Array.from({ length: Math.max(0, Math.min(limit, total - start)) },
        (_, k) => row(start + k));
      const last = rows[rows.length - 1];
      const hasMore = start + rows.length < total;
      return { rows, hasMore,
        nextCursor: hasMore && last ? { sort: 'newest', lastDate: last.date, lastId: last.id } : null,
        cursorReset: false };
    }) as unknown as Parameters<typeof readWindowToExhaustion>[2];
    return { read, calls: () => calls };
  };
  const q = { sort: 'newest' } as unknown as Parameters<typeof readWindowToExhaustion>[1];

  const one = await readWindowToExhaustion('s', q, pagerOf(40).read);
  check('a window inside one page reads once and is complete',
    one.rows.length === 40 && one.pages === 1 && one.complete === true);

  const two = await readWindowToExhaustion('s', q, pagerOf(173).read);
  check('a 173-row window is read WHOLE, not to the first page',
    two.rows.length === 173 && two.complete === true && two.pages === 2);

  const exact = await readWindowToExhaustion('s', q, pagerOf(100).read);
  check('a window exactly one page long does not lose its last row',
    exact.rows.length === 100 && exact.complete === true);

  const big = await readWindowToExhaustion('s', q, pagerOf(3392).read);
  check('a multi-year window still completes', big.complete === true && big.rows.length === 3392);

  // The ceiling must FAIL LOUDLY. This is the property that stops "raise 100 to 500"
  // from being the fix: whatever the bound, reaching it is reported.
  const over = await readWindowToExhaustion('s', q, pagerOf(TRANSACTION_FETCH_LIMIT + 500).read);
  check('reaching the read ceiling reports incomplete, never silently truncates',
    over.complete === false && over.rows.length >= TRANSACTION_FETCH_LIMIT);
  check('…and the ceiling is the repository\'s own, shared with the assembler',
    TRANSACTION_FETCH_LIMIT === 5_000);

  // A seam that stops advancing would otherwise loop forever.
  const stuck = (async () => ({
    rows: [row(1)], hasMore: true,
    nextCursor: { sort: 'newest', lastDate: '2026-08-01', lastId: 't1' }, cursorReset: false,
  })) as unknown as Parameters<typeof readWindowToExhaustion>[2];
  const halted = await readWindowToExhaustion('s', q, stuck);
  check('a non-advancing cursor halts instead of looping',
    halted.complete === false && halted.pages <= 3);

  const src = code(read('scripts/ai-baseline/tools.ts'));
  check('ranking uses the exhaustive read; a plain page does not',
    /wantLargest\s*\n?\s*\? await readWindowToExhaustion/.test(src));
  check('…and the population size and completeness are always reported',
    /rankedOver: population\.length/.test(src) && /rankingIsComplete: complete/.test(src));
  check('…with a caveat only when it is genuinely incomplete',
    /complete \? \{\} : \{ rankingCaveat/.test(src));
  check('the page size is the read authority\'s own constant, not a local number',
    /limit: MAX_TRANSACTION_PAGE_SIZE/.test(src) && !/RANKING_PAGE/.test(src));
}

// ══ 15. Context compaction ═══════════════════════════════════════════════════
//
// Old raw tool payloads are garbage-collected; conversation prose is not. The
// checks below are all about what must SURVIVE — a compaction that loses a user
// message or breaks tool linkage is not a saving, it is a bug that presents as
// one.
console.log('15. context compaction');
{
  let uid = 0;
  const sys  = { role: 'system', content: 'be brief' };
  const usr  = (t: string) => ({ role: 'user', content: t });
  const say  = (t: string) => ({ role: 'assistant', content: t });
  const call = (name: string, args: unknown) => {
    const id = `call_${++uid}`;
    return { msg: { role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, id };
  };
  const res  = (id: string, payload: unknown) =>
    ({ role: 'tool', tool_call_id: id, content: JSON.stringify(payload) });

  /** A turn: user → n tool hops → prose. */
  const turn = (q: string, tools: [string, unknown][], answer: string): unknown[] => {
    const out: unknown[] = [usr(q)];
    for (const [n, a] of tools) {
      const c = call(n, a);
      out.push(c.msg, res(c.id, { big: 'x'.repeat(2000), n }));
    }
    out.push(say(answer));
    return out;
  };

  const build = (n: number): unknown[] => ([sys, usr('EVIDENCE')] as unknown[]).concat(
    ...Array.from({ length: n }, (_, i) =>
      turn(`q${i}`, [['get_spending', { i }]], `a${i}`)));

  const toolMsgs = (ms: readonly unknown[]) =>
    ms.filter((m) => (m as { role?: string }).role === 'tool');
  const isStub = (m: unknown) => {
    try { return JSON.parse(String((m as { content?: string }).content)).elided === true; }
    catch { return false; }
  };

  // ── the retention window ───────────────────────────────────────────────────
  const five = build(5);
  const { messages: c5, stats } = compactToolHistory(five);
  check('the default policy retains two completed turns', DEFAULT_COMPACTION.retainCompletedTurns === 2);
  check('five completed turns are recognised', stats.completedTurns === 5);
  const stubs5 = toolMsgs(c5).map(isStub);
  check('the last two completed turns keep raw results',
    stubs5[3] === false && stubs5[4] === false);
  check('…and everything older is a stub',
    stubs5[0] === true && stubs5[1] === true && stubs5[2] === true);
  check('bytes actually fall', stats.bytesAfter < stats.bytesBefore / 2, `${stats.bytesBefore}→${stats.bytesAfter}`);

  // ── the active turn is untouchable ─────────────────────────────────────────
  const mid: unknown[] = [...build(4)];
  const open = call('get_transactions', { live: true });
  mid.push(usr('q-active'), open.msg, res(open.id, { big: 'y'.repeat(2000) }));
  const { messages: cMid } = compactToolHistory(mid);
  check('an UNFINISHED turn keeps its evidence — no answer has landed yet',
    isStub(toolMsgs(cMid)[toolMsgs(cMid).length - 1]) === false);

  const multi: unknown[] = [sys, usr('EVIDENCE'), ...build(4).slice(2)];
  const h1 = call('get_income', {}); const h2 = call('get_spending', {}); const h3 = call('project_cash', {});
  multi.push(usr('q-multi'), h1.msg, res(h1.id, { a: 1 }), h2.msg, res(h2.id, { b: 2 }), h3.msg, res(h3.id, { c: 3 }));
  const { messages: cMulti } = compactToolHistory(multi);
  const lastThree = toolMsgs(cMulti).slice(-3);
  check('a turn with THREE tool hops stays whole while it is still running',
    lastThree.every((m) => isStub(m) === false));

  // ── a failed turn ──────────────────────────────────────────────────────────
  //
  // ⚠️ THE POLICY, STATED: a blank assistant message is not an ANSWER, so it does
  // not close a turn and does not advance the retention window. A failure is
  // therefore always inside the window immediately after it happens — which is
  // when somebody would look at it — and it ages out later like any other turn.
  // It is not pinned in the model's context forever; the ARTIFACT keeps every
  // payload verbatim regardless, and that is where diagnosis actually happens.
  const mkFailed = (completedAfter: number) => {
    const t: unknown[] = [sys, usr('EVIDENCE')];
    const f = call('get_spending', {});
    t.push(usr('q-fail'), f.msg, res(f.id, { big: 'z'.repeat(2000) }),
      { role: 'assistant', content: '' }); // finish_reason: length — NOT an answer
    for (let i = 0; i < completedAfter; i++) t.push(...turn(`q-after${i}`, [['get_income', {}]], `a${i}`));
    return t;
  };
  const justFailed = compactToolHistory(mkFailed(0));
  check('a turn that just failed keeps its evidence', justFailed.stats.elided === 0);
  check('…because a blank answer does not close a turn', justFailed.stats.completedTurns === 0);
  const failedThenOne = compactToolHistory(mkFailed(1));
  check('…and it is still there one completed turn later', failedThenOne.stats.elided === 0);
  const failedThenTwo = compactToolHistory(mkFailed(2));
  check('…and two completed turns later, still inside the window',
    failedThenTwo.stats.elided === 0 && failedThenTwo.stats.completedTurns === 2);
  const failedThenThree = compactToolHistory(mkFailed(3));
  check('…then it ages out like any other turn, once THREE answers have landed',
    isStub(toolMsgs(failedThenThree.messages)[0]) === true
      // The failed turn AND the oldest completed turn both fall outside the window.
      && failedThenThree.stats.elided === 2);

  // ── prose survives byte for byte ───────────────────────────────────────────
  const before = build(6);
  const { messages: after } = compactToolHistory(before);
  const proseOf = (ms: readonly unknown[]) => ms
    .filter((m) => ['user', 'system'].includes((m as { role?: string }).role ?? '')
      || ((m as { role?: string }).role === 'assistant' && (m as { content?: unknown }).content))
    .map((m) => JSON.stringify(m));
  check('every user and system message is unchanged, byte for byte',
    JSON.stringify(proseOf(before).filter((x) => !x.includes('"assistant"')))
      === JSON.stringify(proseOf(after).filter((x) => !x.includes('"assistant"'))));
  check('every assistant ANSWER is unchanged, byte for byte',
    JSON.stringify(proseOf(before).filter((x) => x.includes('"assistant"')))
      === JSON.stringify(proseOf(after).filter((x) => x.includes('"assistant"'))));
  check('the message COUNT is unchanged — nothing is dropped, only emptied',
    before.length === after.length);

  // ── protocol linkage ───────────────────────────────────────────────────────
  const ids = (ms: readonly unknown[]) => ms.map((m) => (m as { tool_call_id?: string }).tool_call_id);
  check('every tool_call_id survives compaction', JSON.stringify(ids(before)) === JSON.stringify(ids(after)));
  check('every tool message keeps role: tool',
    toolMsgs(after).length === toolMsgs(before).length);
  check('assistant tool_calls (name + arguments) are untouched',
    JSON.stringify(before.filter((m) => (m as { tool_calls?: unknown }).tool_calls))
      === JSON.stringify(after.filter((m) => (m as { tool_calls?: unknown }).tool_calls)));

  // ── the stub itself ────────────────────────────────────────────────────────
  const stub = JSON.parse(String((toolMsgs(after).find(isStub) as { content: string }).content));
  check('the stub says it was elided', stub.elided === true);
  check('…and names the tool so the model knows what to re-fetch',
    typeof stub.tool === 'string' && stub.tool.length > 0);
  check('…and carries NOTHING else — no values, no summary, no byte counts',
    Object.keys(stub).sort().join(',') === 'elided,tool');
  check('the stub is small', JSON.stringify(stub).length < 60, String(JSON.stringify(stub).length));
  check('no financial value is synthesised into it',
    !/\d{3,}|\$|balance|cash|networth/i.test(JSON.stringify(stub)));

  // ── idempotence ────────────────────────────────────────────────────────────
  const once = compactToolHistory(build(6));
  const twice = compactToolHistory(once.messages);
  const thrice = compactToolHistory(twice.messages);
  check('compaction is idempotent', JSON.stringify(twice.messages) === JSON.stringify(thrice.messages));
  check('…and a second pass elides nothing new on an unchanged transcript', twice.stats.elided === 0);
  check('repeated passes do not damage a stub',
    JSON.stringify(once.messages.filter(isStub)) === JSON.stringify(thrice.messages.filter(isStub)));

  // ── nothing to do ──────────────────────────────────────────────────────────
  const short = compactToolHistory(build(2));
  check('two completed turns are entirely retained', short.stats.elided === 0);
  const one = compactToolHistory(build(1));
  check('one completed turn is retained', one.stats.elided === 0);
  const none = compactToolHistory([sys, usr('hello')]);
  check('a transcript with no tools is untouched', none.stats.elided === 0 && none.stats.bytesBefore === 0);

  // ── stats are for the artifact, not the model ──────────────────────────────
  check('stats carry the byte counts the artifact needs',
    typeof stats.bytesBefore === 'number' && typeof stats.bytesAfter === 'number'
      && stats.bytesBefore > stats.bytesAfter);
  const wire = JSON.stringify(c5);
  check('…and none of those diagnostics reach the model',
    !wire.includes('originalBytes') && !wire.includes('bytesBefore') && !wire.includes('elidedBytes'));
}

// ══ 16. As-of coherence and the information ceiling (slices 1–3) ═════════════
//
// The beta blocker: on 2026-01-01 one tool reported cash $1,255.20 (checking) and
// another reported $9,517.46 (checking + savings), both under the name "cash".
// 4M quoted the smaller one, built debt advice on it, and corrected only when the
// user pushed back.
console.log('16. as-of coherence');
{
  const src = code(read('scripts/ai-baseline/tools.ts'));
  const schemaOf = (n: string) => findTool(n)!.parameters as
    { properties: Record<string, unknown> };

  // ── slice 1: the collision cannot come back ──────────────────────────────
  check('no tool result field is named `cash`',
    !/\bcash:\s/.test(src), (src.match(/\bcash:\s\S+/g) ?? []).join(' '));
  check('the history point names checking and liquid separately',
    /liquid: p\.liquid/.test(src) && /checking: p\.cashOnHand/.test(src));
  check('a single-lens answer states the population it covers',
    /population: \{/.test(src) && /covers: components\.map/.test(src));
  check('…and names its sibling lenses so a bucket is not read as a whole',
    /siblingLenses: EXPLAINABLE_LENSES\.filter/.test(src));
  check('…including savings beside cash',
    /'cash', 'savings'/.test(src) || /'savings'/.test(src));

  // ── slice 2: one tool for the whole position on a date ───────────────────
  check('get_financial_snapshot takes an asOf', 'asOf' in schemaOf('get_financial_snapshot').properties);
  check('a past date takes the historical path, today takes the accounts path',
    /if \(asOf < ctx\.asOfISO\) return historicalSnapshot/.test(src));
  check('both paths declare which basis produced them',
    /basis: 'HISTORICAL_SNAPSHOT'/.test(src) && /basis: 'CURRENT_ACCOUNTS'/.test(src));
  check('the historical path reports the date it actually observed',
    /observedOn: point\.date/.test(src));
  check('…and carries coverage, not just totals',
    /netWorthAssertable/.test(src) && /NOT zero and NOT measured/.test(src));
  check('the historical composition comes from authorities, not from adapter addition',
    // liquid / checking / savings each come from a different authority that already
    // computed them; nothing here sums two money numbers.
    /liquid: point\.liquid/.test(src) && /checking: point\.cashOnHand/.test(src)
      && !/point\.cashOnHand \+/.test(src) && !/\+ point\.liquid/.test(src));

  // ── slice 3: the ceiling ─────────────────────────────────────────────────
  for (const t of ['get_spending', 'get_income', 'get_transactions', 'get_investments', 'project_cash']) {
    check(`${t} accepts an information ceiling`, 'asOf' in schemaOf(t).properties);
  }
  check('a ceiling OVERRIDES a later explicit bound, it is not merely a default',
    clampToCeiling('2026-09-01', '2026-01-01') === '2026-01-01');
  check('…and leaves an earlier bound alone',
    clampToCeiling('2025-06-01', '2026-01-01') === '2025-06-01');
  check('…and is applied to every windowed read',
    (src.match(/clampToCeiling\(/g) ?? []).length >= 3);
  check('the ceiling reaches the income CADENCE authority, not only the totals',
    /loadForecastIncomeStreams\(ctx\.spaceId, ceiling\)/.test(src));
  check('a retrospective projection starts from the balance that was true THEN',
    /openingBasis = 'HISTORICAL_SNAPSHOT'/.test(src)
      && /historicalSnapshot\(ctx, asOf\)/.test(src));
  check('…and windows its spending evidence to the cutoff',
    /evidence through \$\{asOf\}/.test(src));
  check('…and runs the engine from that date, not from today',
    /assembleForecast\(\{[\s\S]*?asOfISO: asOf,/.test(src) && /fromISO: asOf/.test(src));
  check('…and says what it is, so it is never read as a current expectation',
    /retrospective: true/.test(src) && /do not\n?\s*\/\/?\s*present it as a current expectation|not\s+'\s*\+\s*'present it as a current expectation|present it as a current expectation/.test(src));
  check('a past date never returns the CURRENT investment composition',
    /composeInvestments reads today's account totals|reads today's account totals/.test(read('scripts/ai-baseline/tools.ts')));
}

// ══ 17. The scenario ledger (slice 4) ════════════════════════════════════════
//
// Turns 11–13 of the gpt-5.5 dogfood did three consecutive turns of consequential
// arithmetic in prose — a five-year contribution-and-compounding table, then the
// same table with per-year returns. Every figure happened to be correct, and not
// one of them was reproducible, testable or traceable. These checks are what
// makes the same arithmetic boring.
console.log('17. scenario ledger');
{
  const OPENING = {
    asOfISO: '2026-01-01',
    liquid: 10_000, investments: 20_000, debt: 500, otherAssets: 300_000,
  };
  const SPINE = [
    { date: '2026-12-31', liquid: 15_000, isCheckpoint: true },
    { date: '2027-12-31', liquid: 20_000, isCheckpoint: true },
  ];
  const flat = runScenarioLedger({
    opening: OPENING, spine: SPINE, contributions: [], outflows: [], returns: [] });

  // ── §12.10 — the ledger is the cash spine plus movements, never a rival ────
  check('with nothing stated, every checkpoint IS the spine',
    flat.checkpoints.every((c, i) => c.liquid!.amount === SPINE[i].liquid));
  check('…and no figure claims a user assumption that was never made',
    flat.checkpoints.every((c) => !c.netWorth!.provenance.includes(PROVENANCE.USER_ASSUMED)));
  check('…and the untouched investment pot says it is being held flat',
    flat.checkpoints[0].investments.provenance.includes(PROVENANCE.HELD_FLAT)
      && flat.checkpoints[0].investments.amount === 20_000);
  check('opening net worth composes the four lines',
    flat.opening.netWorth === 10_000 + 20_000 + 300_000 - 500);

  // ── §12.11 — one movement, two signs, no double count ─────────────────────
  const contributed = runScenarioLedger({
    opening: OPENING, spine: SPINE, returns: [], outflows: [],
    contributions: [{ date: '2026-06-01', amount: 5_000, label: 'half my cash' }] });
  check('a contribution leaves cash', contributed.checkpoints[0].liquid!.amount === 10_000);
  check('…and arrives in investments, to the cent',
    contributed.checkpoints[0].investments.amount === 25_000);
  check('…so at a zero return the composed net worth is UNCHANGED',
    contributed.checkpoints[0].netWorth!.amount === flat.checkpoints[0].netWorth!.amount);
  check('…and the movement is reported, not merely applied',
    contributed.checkpoints[0].movements.contributionsToDate.total === 5_000
      && contributed.checkpoints[0].movements.investmentGrowthToDate === 0);

  // ── §12.12 — a per-year rate compounds only inside its own year ───────────
  const perYear = runScenarioLedger({
    opening: OPENING, spine: SPINE, contributions: [], outflows: [],
    returns: [
      { fromISO: '2026-01-01', toISO: '2026-12-31', annualPct: 100 },
      { fromISO: '2027-01-01', toISO: '2027-12-31', annualPct: 0 },
    ] });
  check('100% for 2026 doubles the pot over the full year',
    approx(perYear.checkpoints[1].investments.amount, 40_000, 0.005));
  // 2027 contributes a factor of exactly 1, so the whole gain is 2026's — and the
  // only difference between the two checkpoints is 2026's own last day.
  check('…and 2027 at 0% neither extends nor undoes it',
    approx(perYear.checkpoints[1].movements.investmentGrowthToDate, 20_000, 0.005)
      && perYear.checkpoints[1].investments.amount > perYear.checkpoints[0].investments.amount
      && perYear.checkpoints[1].investments.amount - perYear.checkpoints[0].investments.amount < 100);

  // ⚠️ A 31 DECEMBER CHECKPOINT IS 364 DAYS AFTER 1 JANUARY, NOT 365. Rounding it
  // up to a clean ×2 would flatter every table by the width of a day, forever.
  check('the year-end checkpoint is one day short of the full year, and says so in the number',
    perYear.checkpoints[0].investments.amount < 40_000
      && perYear.checkpoints[0].investments.amount > 39_900);

  // ── §12.14 — a stated return can never be read as measured ────────────────
  const assumed = runScenarioLedger({
    opening: OPENING, spine: SPINE, outflows: [],
    contributions: [{ date: '2026-06-01', amount: 5_000, label: 'monthly' }],
    returns: [{ fromISO: '2026-01-01', toISO: '2027-12-31', annualPct: 8 }] });
  check('an investment balance built on a stated return carries USER_ASSUMED',
    assumed.checkpoints.every((c) => c.investments.provenance.includes(PROVENANCE.USER_ASSUMED)));
  check('…and so does the net worth composed from it',
    assumed.checkpoints.every((c) => c.netWorth!.provenance.includes(PROVENANCE.USER_ASSUMED)));
  check('…and cash touched by a stated contribution says so too',
    assumed.checkpoints.every((c) => c.liquid!.provenance.includes(PROVENANCE.USER_ASSUMED)));
  check('the spine is never labelled MEASURED — it is a projection',
    flat.checkpoints.every((c) => c.liquid!.provenance.includes(PROVENANCE.PROJECTED_FROM_EVIDENCE)
      && !c.liquid!.provenance.includes(PROVENANCE.MEASURED)));
  check('debt and other assets are measured AND held flat, which are different claims',
    flat.checkpoints.every((c) => c.debt.provenance.includes(PROVENANCE.MEASURED)
      && c.debt.provenance.includes(PROVENANCE.HELD_FLAT)));

  // ⚠️ A HOUSE MUST NOT VANISH FROM A FIVE-YEAR TABLE. Composing net worth as
  // cash + investments − debt is the obvious shape and it is wrong by the value
  // of every asset that is neither.
  check('assets that are neither cash nor investments are carried, not dropped',
    flat.checkpoints.every((c) => c.otherAssets.amount === 300_000
      && c.netWorth!.amount === c.liquid!.amount + c.investments.amount + 300_000 - 500));

  // ── Nothing is clamped to what the projection can afford ──────────────────
  const overspent = runScenarioLedger({
    opening: OPENING, spine: SPINE, contributions: [], returns: [],
    outflows: [{ date: '2026-03-01', amount: 50_000, label: 'a car' }] });
  check('a plan that does not fund itself goes negative rather than being trimmed',
    overspent.checkpoints[0].liquid!.amount === -35_000);
  check('…and says so out loud', overspent.warnings.some((w) => /negative/i.test(w)));

  // ── A refused spine point stays refused ───────────────────────────────────
  const refused = runScenarioLedger({
    opening: OPENING, contributions: [], outflows: [], returns: [],
    spine: [{ date: '2026-12-31', liquid: null, isCheckpoint: true }] });
  check('a checkpoint the projection could not produce is null, never zero',
    refused.checkpoints[0].liquid === null && refused.checkpoints[0].netWorth === null
      && !!refused.checkpoints[0].unavailable);
}

// ══ 17a. Compounding, schedules and the inputs that are refused ══════════════
console.log('17a. ledger arithmetic primitives');
{
  const eight = [{ fromISO: '2026-01-01', toISO: '2026-12-31', annualPct: 8 }];
  check('no stated period means 0%, never a market average',
    growthFactor([], '2026-01-01', '2030-12-31') === 1);
  check('a full year at 8% is exactly ×1.08',
    approx(growthFactor(eight, '2026-01-01', '2027-01-01'), 1.08, 1e-12));
  check('growth from a date to itself is nothing',
    growthFactor(eight, '2026-06-01', '2026-06-01') === 1);
  check('a period ends where it says it ends — nothing accrues past it',
    approx(growthFactor(eight, '2026-01-01', '2030-01-01'), 1.08, 1e-12));
  check('adjacent years tile exactly, with no gap and no overlap at the boundary',
    approx(growthFactor([...eight, { fromISO: '2027-01-01', toISO: '2027-12-31', annualPct: 8 }],
      '2026-01-01', '2028-01-01'), 1.08 * 1.08, 1e-12));

  // ⚠️ TWO RATES IN FORCE AT ONCE HAS NO HONEST READING. Neither "the later one
  // wins" nor "multiply them" is what anyone meant, so neither is applied.
  const clash = validateReturns([
    { fromISO: '2026-01-01', toISO: '2026-12-31', annualPct: 8 },
    { fromISO: '2026-06-01', toISO: '2027-06-01', annualPct: 5 },
  ]);
  check('overlapping return periods are refused, not blended',
    clash.ok.length === 1 && clash.rejected.length === 1);
  check('…and the refusal names what it collided with',
    /overlaps/.test(clash.rejected[0].reason));
  check('a period that ends before it starts is refused',
    validateReturns([{ fromISO: '2027-01-01', toISO: '2026-01-01', annualPct: 8 }]).ok.length === 0);

  // ── Schedules ─────────────────────────────────────────────────────────────
  const monthly = expandContributions(
    [{ from: '2026-01-31', amount: 500, cadence: 'monthly' }], '2026-01-01', '2026-06-30');
  check('a monthly schedule produces one movement per month',
    monthly.movements.length === 6);
  // ⚠️ MEASURED FROM THE ORIGINAL DATE, NOT STEPPED. Stepping one month at a time
  // walks a 31st back to the 28th in February and leaves it there forever.
  check('…and a 31st clamps into February without dragging the rest of the year back',
    monthly.movements[1].date === '2026-02-28' && monthly.movements[2].date === '2026-03-31');
  const yearly = expandContributions(
    [{ from: '2026-06-01', amount: 10_000, cadence: 'yearly' }], '2026-01-01', '2029-12-31');
  check('a yearly schedule steps twelve months',
    yearly.movements.map((m) => m.date).join(',') === '2026-06-01,2027-06-01,2028-06-01,2029-06-01');
  check('a contribution dated before the projection starts is refused, not moved',
    expandContributions([{ onDate: '2025-01-01', amount: 100 }], '2026-01-01', '2026-12-31')
      .rejected.length === 1);
  check('a contribution past the horizon is refused',
    expandContributions([{ onDate: '2027-01-01', amount: 100 }], '2026-01-01', '2026-12-31')
      .rejected.length === 1);
  check('a schedule with no occurrence in the window says so rather than returning nothing',
    expandContributions([{ from: '2030-01-01', amount: 100, cadence: 'monthly' }],
      '2026-01-01', '2026-12-31').rejected.length === 1);
  check('a zero amount is refused',
    expandContributions([{ onDate: '2026-02-01', amount: 0 }], '2026-01-01', '2026-12-31')
      .rejected.length === 1);
  check('a schedule cannot run away',
    expandContributions([{ from: '2026-01-01', amount: 1, cadence: 'monthly' }],
      '2026-01-01', '2126-01-01').movements.length <= MAX_EXPANDED_CONTRIBUTIONS);
  check('the ledger reads no data at all — it is arithmetic, and importable anywhere',
    !/^import /m.test(read('scripts/ai-baseline/scenario-ledger.ts')));
}

// ══ 17b. One spine, two tools ════════════════════════════════════════════════
//
// §12.13 — the last checkpoint must equal a standalone run to the same horizon.
// That holds because there is exactly ONE place a forecast is assembled and both
// tools go through it, not because two code paths were checked against each other.
console.log('17b. one spine');
{
  const src = code(read('scripts/ai-baseline/tools.ts'));
  check('scenario_projection exists and is read-only like the rest',
    !!findTool('scenario_projection'));
  check('there is exactly ONE place a forecast is assembled',
    (src.match(/assembleForecast\(\{/g) ?? []).length === 1,
    String((src.match(/assembleForecast\(\{/g) ?? []).length));
  check('…and every tool that projects reaches it through the same spine',
    (src.match(/buildCashSpine\(ctx, \{/g) ?? []).length === 3);
  check('every checkpoint is an INDEPENDENT run from the same asOf',
    /runTo\(date, override\)\.projection\?\.closing/.test(src) && /runTo\(end\)/.test(src));
  check('the last checkpoint date IS the horizon, monthly and yearly alike',
    monthEndsBetween('2026-09-08', '2027-03-15').slice(-1)[0] === '2027-03-15'
      && yearEndsBetween('2026-09-08', '2030-06-30').slice(-1)[0] === '2030-06-30');
  check('…and a horizon that is already a period end is not duplicated',
    yearEndsBetween('2026-09-08', '2027-12-31').filter((d) => d === '2027-12-31').length === 1);
  check('yearly checkpoints are December year-ends',
    yearEndsBetween('2026-09-08', '2029-12-31').join(',')
      === '2026-12-31,2027-12-31,2028-12-31,2029-12-31');

  const schema = findTool('scenario_projection')!.parameters as
    { properties: Record<string, unknown>; required: string[] };
  check('the horizon is the only required argument', schema.required.join(',') === 'to');
  for (const p of ['contributions', 'outflows', 'returns', 'annualReturnPct', 'granularity']) {
    check(`…and the model can state ${p}`, p in schema.properties);
  }
  // ⚠️ THE DEFAULT RETURN IS ZERO AND THE DESCRIPTION SAYS SO. An unstated return
  // quietly becoming a market average is how a scenario tool turns into a
  // prediction engine.
  check('the schema tells the model never to supply a rate the user did not state',
    /never supply a rate the user did not state/i.test(findTool('scenario_projection')!.description));
  check('the investment pot comes from the canonical composer, not a sum here',
    /composeInvestments\(accounts\)/.test(src) && /composition\.combined === null/.test(src));
  check('a withheld investment total refuses rather than treating null as zero',
    /arithmetic on an unknown/.test(read('scripts/ai-baseline/tools.ts')));
  check('the ledger opening is reconciled against the accounts authority, out loud',
    /reconciliation: \{/.test(src) && /accountsNetWorth: setup\.accounts\.netWorth/.test(src));
}

// ══ 17c. "Half my liquidity" — a share is not an amount ══════════════════════
//
// ⚠️ FOUND BY RUNNING IT, NOT BY READING IT. Asked to redo the table investing
// half his liquidity each year, gpt-4.1 filled in `amount: -0.5`. The ledger
// moved fifty cents, the table came back internally consistent to the penny, and
// it answered a question nobody had asked. The fix is both halves: a share can be
// stated, and a dollar amount under a dollar is refused.
console.log('17c. proportional contributions');
{
  const OPENING = {
    asOfISO: '2026-01-01',
    liquid: 10_000, investments: 0, debt: 0, otherAssets: 0,
  };
  // Two checkpoints, and a mid-year date that exists only to settle a share.
  const SPINE = [
    { date: '2026-06-30', liquid: 12_000, isCheckpoint: false },
    { date: '2026-12-31', liquid: 20_000, isCheckpoint: true },
    { date: '2027-12-31', liquid: 40_000, isCheckpoint: true },
  ];

  const half = runScenarioLedger({
    opening: OPENING, spine: SPINE, returns: [], outflows: [],
    contributions: [
      { date: '2026-12-31', fractionOfLiquid: 0.5, label: 'half my liquidity' },
      { date: '2027-12-31', fractionOfLiquid: 0.5, label: 'half my liquidity' },
    ] });
  check('half of 20,000 is 10,000 — settled from the projection, not from today',
    half.movements[0].amount === 10_000);
  // ⚠️ HALF OF WHAT IS LEFT, NOT HALF OF THE HEADLINE. By the second year 10,000
  // has already moved out, so the balance is 30,000 and half of it is 15,000.
  check('…and the next share is of what remains, not of the projection again',
    half.movements[1].amount === 15_000);
  check('the settled amounts are reported, because only they can be checked',
    half.movements.every((m) => m.fractionOfLiquid === 0.5 && typeof m.amount === 'number'));
  check('cash and investments still move by the same amount',
    half.checkpoints[0].liquid!.amount === 10_000
      && half.checkpoints[0].investments.amount === 10_000);
  check('a date evaluated only to settle a share is NOT a row in the table',
    half.checkpoints.length === 2 && half.checkpoints[0].date === '2026-12-31');

  // ── The defect that made this necessary ───────────────────────────────────
  const disguised = expandContributions(
    [{ from: '2026-12-31', amount: -0.5, cadence: 'yearly', label: 'half my liquidity' }],
    '2026-01-01', '2030-12-31');
  check('a dollar amount under a dollar is refused as a fraction in disguise',
    disguised.movements.length === 0 && disguised.rejected.length === 1);
  check('…and the refusal says which field to use instead',
    /fractionOfLiquid/.test(disguised.rejected[0].reason));
  check('stating both an amount and a fraction is refused',
    expandContributions([{ onDate: '2026-06-01', amount: 100, fractionOfLiquid: 0.5 }],
      '2026-01-01', '2026-12-31').rejected.length === 1);
  check('stating neither is refused',
    expandContributions([{ onDate: '2026-06-01' }], '2026-01-01', '2026-12-31')
      .rejected.length === 1);
  check('a fraction outside 0–1 is refused',
    expandContributions([{ onDate: '2026-06-01', fractionOfLiquid: 1.5 }],
      '2026-01-01', '2026-12-31').rejected.length === 1);

  // ── Order on a shared date, and a balance that is already gone ────────────
  const withCar = runScenarioLedger({
    opening: OPENING, spine: SPINE, returns: [],
    outflows:      [{ date: '2026-12-31', amount: 8_000, label: 'a car' }],
    contributions: [{ date: '2026-12-31', fractionOfLiquid: 0.5, label: 'half of what is left' }],
  });
  check('on one date the outflow settles first, and the share is of what remains',
    withCar.movements[0].kind === 'OUTFLOW' && withCar.movements[1].amount === 6_000);

  const nothingLeft = runScenarioLedger({
    opening: OPENING, returns: [],
    spine: [{ date: '2026-12-31', liquid: 5_000, isCheckpoint: true }],
    outflows:      [{ date: '2026-12-31', amount: 9_000, label: 'a car' }],
    contributions: [{ date: '2026-12-31', fractionOfLiquid: 0.5, label: 'half my liquidity' }],
  });
  check('half of a balance that is already spent is nothing, and it says so',
    nothingLeft.movements[1].amount === 0
      && nothingLeft.warnings.some((w) => /nothing was available/i.test(w)));

  const noPoint = runScenarioLedger({
    opening: OPENING, spine: SPINE, returns: [], outflows: [],
    contributions: [{ date: '2028-03-01', fractionOfLiquid: 0.5, label: 'half' }] });
  check('a share on a date the projection was never run for is refused, not guessed',
    noPoint.movements.length === 0 && noPoint.rejected.length === 1);

  const src = code(read('scripts/ai-baseline/tools.ts'));
  check('the tool evaluates the spine on every share date, not only at checkpoints',
    /shareDates/.test(src) && /isCheckpoint: checkpointDates\.has\(date\)/.test(src));
  const schema = findTool('scenario_projection')!.parameters as
    { properties: Record<string, { items?: { properties: Record<string, unknown> } }> };
  check('…and the model is told that a proportion goes in its own field',
    'fractionOfLiquid' in (schema.properties.contributions.items!.properties));
}

// ══ 18. Goal seek (slice 5) ══════════════════════════════════════════════════
//
// Turn 13 of the dogfood asked "how could I reach $1M by 2030?" and got back
// *"mid-40% annualized returns"* and *"~$90K/year additional investable
// surplus"* — two advice-shaped figures derivable from nothing at all. The
// solver's job is to make those derivable; the bracket's job is to make "no"
// sayable.
console.log('18. goal seek');
{
  // A deliberately simple function so the bisection's own behaviour is visible:
  // f(x) = 1000 + 100x, which reaches 2000 at exactly x = 10.
  const linear = (x: number) => 1000 + 100 * x;

  const hit = solveForTarget({ solveFor: 'x', evaluate: linear, target: 2000,
    lo: 0, hi: 100, precision: 0.01 });
  check('the solver finds the value that reaches the target',
    hit.feasible && approx(hit.required, 10, 0.011), JSON.stringify(hit));

  // ⚠️ §12.15 — THE ROUND TRIP IS THE WHOLE POINT. Solving for a value and then
  // evaluating at that value must reach the target, or the number and the table
  // beneath it disagree.
  check('…and evaluating at the answer actually reaches the target',
    hit.feasible && linear(hit.required) >= 2000 && hit.reached >= 2000);
  check('…and it does not overshoot by more than the reportable precision',
    hit.feasible && linear(hit.required - 0.02) < 2000);

  const already = solveForTarget({ solveFor: 'x', evaluate: linear, target: 500,
    lo: 0, hi: 100, precision: 0.01 });
  check('a target already reached needs nothing, and says so',
    already.feasible && already.alreadyMet && already.required === 0);

  // ⚠️ §12.16 — AN UNREACHABLE TARGET IS A REAL ANSWER. What it must never be is
  // a huge number invented to avoid saying "no".
  const impossible = solveForTarget({ solveFor: 'x', evaluate: linear, target: 1_000_000,
    lo: 0, hi: 100, precision: 0.01 });
  check('an unreachable target is refused rather than answered with a huge number',
    !impossible.feasible);
  check('…and the refusal reports how far the range actually got',
    !impossible.feasible && impossible.bestReached === 11_000 && impossible.bestAt === 100);
  check('…and names the range it searched',
    !impossible.feasible && impossible.lo === 0 && impossible.hi === 100);

  // ⚠️ THE MOST USEFUL REFUSAL THIS TOOL PRODUCES. Moving cash into investments
  // relocates money; at a 0% return it creates none, so NO monthly contribution
  // reaches a net-worth target. "You would need $90K a year" was the
  // fabrication standing in for exactly this.
  const flat = solveForTarget({ solveFor: 'monthlyContribution', evaluate: () => 50_000,
    target: 1_000_000, lo: 0, hi: 1_000_000, precision: 0.01 });
  check('a variable the target does not respond to is named as such',
    !flat.feasible && /does not respond/.test(flat.reason));

  const refusing = solveForTarget({ solveFor: 'x', evaluate: () => null, target: 10,
    lo: 0, hi: 100, precision: 0.01 });
  check('a projection that refuses is "did not reach", never zero',
    !refusing.feasible && refusing.bestReached === null);

  check('the search is bounded even against a pathological function',
    solveForTarget({ solveFor: 'x', evaluate: linear, target: 2000, lo: 0, hi: 1e12,
      precision: 1e-12, maxIterations: 5 }).feasible);
}

// ══ 18a. The goal-seek tool ══════════════════════════════════════════════════
console.log('18a. goal seek tool');
{
  const src = code(read('scripts/ai-baseline/tools.ts'));
  const tool = findTool('scenario_goal_seek');
  check('scenario_goal_seek exists', !!tool);
  const schema = tool!.parameters as { properties: Record<string, unknown>; required: string[] };
  check('it needs a target, a date and one unknown',
    schema.required.slice().sort().join(',') === 'by,solveFor,target');
  check('…and accepts the same scenario inputs, so nothing is stated twice',
    ['contributions', 'outflows', 'returns', 'annualReturnPct', 'assumedMonthlySpending']
      .every((p) => p in schema.properties));
  check('one shared definition supplies those inputs to both tools',
    (src.match(/\.\.\.SCENARIO_INPUTS/g) ?? []).length === 2);
  check('there is still exactly ONE place a forecast is assembled',
    (src.match(/assembleForecast\(\{/g) ?? []).length === 1);
  check('…and one place a scenario is set up, so a solve and its table cannot diverge',
    (src.match(/prepareScenario\(a, ctx,/g) ?? []).length === 2
      && (src.match(/^async function prepareScenario/m) ?? []).length === 1);
  check('…and one place a scenario is presented',
    (src.match(/^function presentScenario/m) ?? []).length === 1
      && (src.match(/presentScenario\(setup,/g) ?? []).length === 2);

  // ⚠️ THE LEDGER RETURNED IS THE ONE RUN AT THE ANSWER, not a re-derivation.
  check('the answer is rendered from the scenario the solution actually produces',
    /const ledger = setup\.run\(atSolution\)/.test(src));

  // ⚠️ REPORT AND LET THE MODEL JUDGE (open question 5). Nothing in the code
  // decides that a required return is unrealistic; the bracket is wide and
  // stated, and out-of-range is reported with how far it got.
  check('a required return is reported however large, inside a wide stated bracket',
    /MAX_SOLVED_RETURN_PCT = 500/.test(src) && /searchRange: \{ from: lo, to: hi/.test(src));
  check('the spending-cut bound is what the user actually spends',
    /nobody can cut more than they spend/.test(read('scripts/ai-baseline/tools.ts')));
  check('a Space with no established spending level cannot be asked for a cut',
    /nothing to solve a cut against/.test(read('scripts/ai-baseline/tools.ts')));

  // ⚠️ RELOCATING MONEY IS NOT CREATING IT, AND THE SCHEMA SAYS SO. A monthly
  // contribution at 0% leaves net worth exactly where it was.
  const solveForDesc = (schema.properties.solveFor as { description: string }).description;
  check('the schema tells the model a contribution relocates money rather than creating it',
    /RELOCATES money/.test(solveForDesc) && /does not change net worth/.test(solveForDesc));
  check('…and which lever actually creates net worth',
    /actually creates net worth/.test(solveForDesc));
  check('the tool tells the model to judge achievability rather than the code doing it',
    /judgement about the world/.test(read('scripts/ai-baseline/tools.ts')));

  // ⚠️ FOUND BY RUNNING IT. Asked "how could I reach $1M?", gpt-4.1 called the
  // goal seek with a bare target — no return, no contributions — got an honest
  // "not reachable", and then described it as "investing half your liquidity each
  // year at 8%", because that is what the conversation had said. The figure was
  // right and the sentence around it was not.
  check('the assumptions actually in force are echoed on EVERY path, refusal included',
    /assumptionsInForce: scenarioAssumptions\(setup, baseLedger, setup\.returns\)/.test(src)
      && /^function scenarioAssumptions/m.test(src));
  check('…and it is the same function the projection reports from',
    (src.match(/scenarioAssumptions\(setup,/g) ?? []).length === 2);
  check('…so an absent return says it was absent, rather than saying nothing',
    /do not describe this result as carrying a return/
      .test(read('scripts/ai-baseline/tools.ts')));
  check('…and an absent contribution likewise',
    /No contributions were in force/.test(read('scripts/ai-baseline/tools.ts')));
  check('a refusal tells the model to describe it from that echo and not from memory',
    /it was NOT applied/.test(read('scripts/ai-baseline/tools.ts')));

  // The spine is memoised per spending level; a return solve must not pay for it.
  check('varying a return or a contribution re-uses one set of projection runs',
    /const spineCache = new Map/.test(src)
      && /\$\{monthlySpending \?\? 'base'\}/.test(src));
  check('a horizon in the past is refused before anything is projected',
    /is not in the future; a scenario needs a/.test(read('scripts/ai-baseline/tools.ts')));
}

// ══ 19. Memory (slice 6) ═════════════════════════════════════════════════════
//
// Memory is for the two things re-fetching cannot reconstruct: what the user
// DECIDED, and what we SAID, when, on what basis. Compaction already proved
// conversational continuity does not need it.
//
// Ownership (product decision, 2026-09-08): USER-OWNED WITHIN A SPACE. The Space
// identifies the financial world; the user identifies whose intention it is.
console.log('19. memory shape');
{
  const K = MemoryKind;

  // ── §12.20 — the invariant, enforced by shape ─────────────────────────────
  //
  // ⚠️ NOT A DENYLIST SOMEBODY HAS TO MAINTAIN. Each kind declares a CLOSED key
  // set, so a key naming a current balance is not forbidden — it simply does not
  // exist in any kind, and cannot be written.
  for (const forbidden of ['currentCash', 'balance', 'liquid', 'netWorth', 'totalAssets',
                           'investments', 'debt', 'holdings']) {
    const r = validatePayload(K.INTENTION, { targetMetric: 'netWorth', targetAmount: 1e6,
      byDate: '2030-12-31', [forbidden]: 12_345 });
    check(`no memory payload can carry \`${forbidden}\``, !r.ok);
  }
  check('…and the refusal says why, and what the payload is for',
    (() => { const r = validatePayload(K.INTENTION, { targetMetric: 'x', currentCash: 1 });
      return !r.ok && /never a current balance/.test(r.reason); })());

  check('an INTENTION holds a target and a date',
    validatePayload(K.INTENTION,
      { targetMetric: 'netWorth', targetAmount: 1_000_000, byDate: '2030-12-31' }).ok);
  check('…or a planned outlay',
    validatePayload(K.INTENTION, { intent: 'purchase', amount: 20_000, label: 'car' }).ok);
  check('…but not a bare number with no target and no date',
    !validatePayload(K.INTENTION, { targetAmount: 1_000_000 }).ok);

  // ⚠️ §12.22 — `horizon` IS THE SAFETY PROPERTY. A value with a horizon and a
  // statedAt is "what we said on the 8th about year end". Without one it is a
  // balance, so the write is refused.
  check('a CHECKPOINT with a metric, a horizon and a value is storable',
    validatePayload(K.CHECKPOINT,
      { metric: 'cash', horizon: '2026-12-31', value: 38_243.5, basis: { x: 1 } }).ok);
  check('a CHECKPOINT without a horizon is refused — that would be a balance',
    !validatePayload(K.CHECKPOINT, { metric: 'cash', value: 38_243.5 }).ok);
  check('an ASSUMPTION carries a rate or a level, and nothing else',
    validatePayload(K.ASSUMPTION, { monthlySpending: 6_000 }).ok
      && validatePayload(K.ASSUMPTION, { annualReturnPct: 8, appliesTo: 'investments' }).ok
      && !validatePayload(K.ASSUMPTION, { monthlySpending: 6_000, cashOnHand: 12_000 }).ok);
  check('an empty payload is refused', !validatePayload(K.INTENTION, {}).ok);

  // ── Ownership, in the shapes themselves ──────────────────────────────────
  const storeSrc = code(read('scripts/ai-baseline/memory-store.ts'));
  const toolSrc  = code(read('scripts/ai-baseline/memory-tools.ts'));
  check('every read and write is scoped to (spaceId, ownerUserId) together',
    /ownerUserId: scope\.ownerUserId/.test(storeSrc)
      && (storeSrc.match(/spaceId: scope\.spaceId/g) ?? []).length >= 3);
  // Scoped to the model block: `MerchantRule` has carried a NULLABLE
  // `ownerUserId` since long before this, and a whole-file scan reads it as ours.
  const memoryModel = read('prisma/schema.prisma')
    .split(/^model SpaceMemory \{/m)[1]?.split(/^\}/m)[0] ?? '';
  check('ownership is required, never nullable',
    /ownerUserId String\b/.test(memoryModel) && !/ownerUserId String\?/.test(memoryModel));
  check('…and both scopes are indexed together, so no query is cheap without the owner',
    /@@index\(\[spaceId, ownerUserId,/.test(memoryModel)
      && !/@@index\(\[spaceId\]\)/.test(memoryModel));
  check('the supersession chain is one nullable self-relation, not an event log',
    /supersedesId String\?\s+@unique/.test(memoryModel)
      && /supersededBy SpaceMemory\?/.test(memoryModel));
  // ⚠️ THE MODEL CANNOT NAME AN OWNER, SO IT CANNOT ADDRESS ANOTHER MEMBER'S.
  const memSchemas = ['recall', 'remember'].map((n) => findTool(n)!.parameters as
    { properties: Record<string, unknown> });
  check('neither memory tool takes a user id — the owner is the authenticated user',
    memSchemas.every((s) => !('userId' in s.properties) && !('ownerUserId' in s.properties)));
  check('…which the tool derives from the resolved Space context',
    /ownerUserId: ctx\.spaceCtx\.userId/.test(toolSrc));
  check('there is no sharing, visibility or ACL vocabulary in the memory path',
    !/\b(visibility|acl|shared|household|consensus)\b/i.test(storeSrc + toolSrc));

  // ── Retrieval is model-driven, like every other tool ─────────────────────
  check('no memory is injected into the system instruction',
    !/recall|memory|intention/i.test(SYSTEM_INSTRUCTION));
  check('recall tells the model a checkpoint is not a balance',
    /NOT a current[\s'+]+balance/.test(read('scripts/ai-baseline/memory-tools.ts')));
  check('recall says so plainly when nothing has been recorded',
    /rather than guessing/.test(read('scripts/ai-baseline/memory-tools.ts')));
}

// ══ 19a. The memory line in the orientation core ═════════════════════════════
//
// ⚠️ MEASURED BEFORE IT WAS BUILT, WHICH IS THE ONLY REASON IT EXISTS. The
// investigation proposed it as "one concession worth testing — drop it if the
// model finds goals without it". Run without it: the user said "I want to hit
// $1M by 2030", the model answered well and recorded NOTHING, and a fresh
// session asked "how are we doing?" answered from balances alone and never
// called `recall`. Zero rows written, zero reads.
console.log('19a. memory line');
{
  const ev = code(read('scripts/ai-baseline/evidence.ts'));

  check('the A2 orientation carries this user\'s memory',
    /memory \}/.test(ev) && /async function memoryLine/.test(ev));
  check('…scoped to the authenticated user, not the Space',
    /memoryLine\(spaceId, ctx\.userId\)/.test(ev)
      && /const scope = \{ spaceId, ownerUserId \}/.test(ev));
  check('…bounded on both kinds, so a long history cannot grow the core without limit',
    /MAX_CORE_INTENTIONS = 8/.test(ev) && /MAX_CORE_CHECKPOINTS = 6/.test(ev));
  check('the empty state names the tool rather than saying nothing',
    /record it with `remember`/.test(read('scripts/ai-baseline/evidence.ts')));

  // ⚠️ FOUND BY RUNNING IT, IN THE SLICE THAT BROKE IT. The first version listed
  // intentions only and its empty note said "nothing has been recorded for this
  // user yet". Slice 7 then started recording projections silently, so asked "am
  // I ahead of where you said I would be?", the model read that note, believed
  // it, and answered "I have no record of a previous projection" while two
  // checkpoints sat in the table.
  check('the line speaks for ALL of memory, not only for goals',
    /projectionsOnRecord: \{ count: projections\.length/.test(ev)
      && /kind: MemoryKind\.CHECKPOINT/.test(ev) && /kind: MemoryKind\.INTENTION/.test(ev));
  check('…so "nothing recorded" is said only when nothing at all is recorded',
    /goals\.length === 0 && projections\.length === 0/.test(ev));
  check('…and recorded projections point at the tool that reconciles them',
    /`reconcile_projection` compares them/.test(read('scripts/ai-baseline/evidence.ts')));
  check('…and say what they are, so they are not read as balances',
    /never current balances/.test(read('scripts/ai-baseline/evidence.ts')));

  // ⚠️ IT IS EVIDENCE, NOT DOCTRINE. It deliberately did NOT go in the system
  // instruction, which is ~140 words and whose growth is itself a finding.
  check('the system instruction still says nothing about memory',
    !/recall|remember|memory|intention|goal/i.test(SYSTEM_INSTRUCTION));
  check('…and it is still a short instruction',
    SYSTEM_INSTRUCTION.split(/\s+/).length < 200, String(SYSTEM_INSTRUCTION.split(/\s+/).length));

  // ⚠️ NO BALANCE REACHES THE ORIENTATION THROUGH MEMORY. Only subjects, targets,
  // dates and horizons are ever emitted.
  check('an intention in the core emits only subject, statedAt and target',
    /return \{ subject: r\.subject, statedAt: r\.statedAt\.slice\(0, 10\),/.test(ev));
  check('…and a projection emits only its horizon',
    /\.map\(\(r\) => \(r\.payload as \{ horizon\?: string \}\)\.horizon\)/.test(ev));

  // The collision slice 1 removed from every tool result survived one file.
  check('the orientation core calls checking-plus-savings `liquid`, not `cash`',
    /liquid: acc\.totalLiquid/.test(ev) && !/\bcash: acc\./.test(ev));
}

// ══ 20. Reconciliation (slice 7) ═════════════════════════════════════════════
//
// §5.5 gave us the retrospective: what we WOULD say today, standing in January.
// That is a recomputation with today's code — it cannot know what was actually
// said, or that the user asserted a spending level in the conversation.
// A CHECKPOINT records a STATEMENT; the retrospective records a CAPABILITY.
console.log('20. reconciliation arithmetic');
{
  const ahead = compareToStatement(38_243.50, 40_700);
  check('a settled statement produces a signed variance',
    ahead.difference === 2_456.5 && ahead.direction === 'AHEAD');
  check('…and a share of what was stated',
    ahead.percentOfStated !== null && Math.abs(ahead.percentOfStated - 6.42) < 0.01);
  check('a shortfall is BEHIND, and the sign says so',
    compareToStatement(38_243.50, 30_000).direction === 'BEHIND'
      && compareToStatement(38_243.50, 30_000).difference === -8_243.5);

  // ⚠️ "ON TRACK" IS A BAND. Reporting `difference: 0.37, direction: BEHIND` on a
  // five-figure statement invites a sentence about being behind that is false in
  // every way that matters.
  check('a difference inside the band is ON_TRACK, not a rounding-error verdict',
    compareToStatement(38_243.50, 38_243.87).direction === 'ON_TRACK');
  check('…and the band is a dollar, stated rather than hidden', ON_TRACK_BAND === 1);
  check('a percentage of nothing is null, not Infinity',
    compareToStatement(0, 500).percentOfStated === null);

  // ── The cause, not just the score ────────────────────────────────────────
  const changes = diffBasis(
    { spendingSource: 'OBSERVED', dailyRate: 142.9, incomeEvents: 8,
      monthsAveraged: ['2026-07', '2026-08'] },
    { spendingSource: 'OBSERVED', dailyRate: 131.2, incomeEvents: 9,
      monthsAveraged: ['2026-09', '2026-10'] });
  check('the basis diff names every field that moved',
    changes.map((c) => c.field).sort().join(',') === 'dailyRate,incomeEvents,monthsAveraged');
  check('…with the signed move on the numbers',
    changes.find((c) => c.field === 'dailyRate')!.delta === -11.7
      && changes.find((c) => c.field === 'incomeEvents')!.delta === 1);
  check('…and no delta on the things that are not numbers',
    changes.find((c) => c.field === 'monthsAveraged')!.delta === null);
  check('an unchanged basis reports nothing at all',
    diffBasis({ dailyRate: 142.9 }, { dailyRate: 142.9 }).length === 0);
  check('a field that appeared or vanished IS a change',
    diffBasis({ a: 1 }, {}).length === 1 && diffBasis({}, { b: 2 }).length === 1);
  // ⚠️ FOUND BY RUNNING IT. A rate stored as 142.8979726027397 came back out of
  // the engine as 142.89797260273974 and was reported as a basis change with a
  // delta of zero — noise dressed as an explanation.
  check('a sub-cent float round-trip is not a change',
    diffBasis({ dailyRate: 142.8979726027397 },
              { dailyRate: 142.89797260273974 }).length === 0);
  check('…but a real move of a cent still is',
    diffBasis({ dailyRate: 142.89 }, { dailyRate: 142.90 }).length === 1);

  // ── A row read back is data, and fails closed ────────────────────────────
  const good = readCheckpoint({ id: 'm1', subject: 'liquid-2026-12-31',
    statedAs: 'x', statedAt: '2026-09-08T00:00:00.000Z',
    payload: { metric: 'liquid', horizon: '2026-12-31', value: 38_243.5, basis: {} } });
  check('a well-formed checkpoint reads back as a statement', !('unusable' in good));
  for (const [name, payload] of [
    ['no horizon', { metric: 'liquid', value: 1 }],
    ['no value',   { metric: 'liquid', horizon: '2026-12-31' }],
    ['no metric',  { horizon: '2026-12-31', value: 1 }],
  ] as [string, unknown][]) {
    check(`a checkpoint with ${name} is refused rather than reconciled against a guess`,
      'unusable' in readCheckpoint({ id: 'm', subject: 's', statedAs: 'x',
        statedAt: '2026-09-08T00:00:00.000Z', payload }));
  }
  check('the reconciler reads no data at all — it is arithmetic',
    !/^import /m.test(read('scripts/ai-baseline/reconcile.ts')));
}

// ══ 20a. The silent checkpoint and the tool ══════════════════════════════════
console.log('20a. checkpoint-on-projection');
{
  const mt  = code(read('scripts/ai-baseline/memory-tools.ts'));
  const run = code(read('scripts/ai-baseline/run.ts'));
  const src = code(read('scripts/ai-baseline/tools.ts'));

  // ⚠️ THE WRITE LIVES IN THE TURN LOOP, NOT IN THE TOOL. Making `project_cash`
  // write would have made the "tools.ts holds no Prisma client" assertion a lie
  // told by indirection.
  check('the checkpoint is written by the conversation loop, not by the tool',
    /checkpointProjection\(toolCtx, call\.name, result\)/.test(run));
  check('…and `project_cash` itself still writes nothing',
    !/checkpointProjection/.test(src));
  check('…and only that one tool produces a checkpoint',
    /toolName !== 'project_cash'/.test(mt));

  // ⚠️ A RETROSPECTIVE RUN IS A RECOMPUTATION, NOT A STATEMENT. Checkpointing it
  // would let the system mark its own homework.
  check('a retrospective projection is never checkpointed',
    /r\.retrospective === true/.test(mt));
  // A scenario ending balance is conditional on the user's assumptions;
  // reconciling it later would measure their compliance, not our accuracy.
  check('a scenario projection is never checkpointed either',
    !/scenario_projection/.test(mt.split('checkpointProjection')[1] ?? ''));

  check('the write is a copy of project_cash\'s own basis, not a computation',
    /spendingSource: spending\.source/.test(mt) && /dailyRate: spending\.dailyRate/.test(mt)
      && /incomeEvents: basis\.incomeEventsCounted/.test(mt));
  check('it is silent — nothing is added to the transcript',
    !/messages\.push[\s\S]{0,80}checkpoint/i.test(run));
  check('and non-fatal — a memory failure cannot break a correct answer',
    /catch \{[\s\S]{0,200}return null;/.test(mt));

  // ⚠️ THE STORED METRIC IS `liquid`. A tool result carrying the loose name is
  // read beside its own description; a stored row is read months later with
  // neither.
  check('the stored metric is `liquid`, not `cash`',
    /metric: 'liquid', horizon, value: projection\.endingCash/.test(mt)
      && /subject: `liquid-\$\{horizon\}`/.test(mt));
  check('…and the statement says in words what population that is',
    /checking plus savings/.test(read('scripts/ai-baseline/memory-tools.ts')));
  check('the conversation\'s clock is what a statement is dated with',
    /statedAt: ctx\.asOfISO/.test(mt));

  // ── The tool ─────────────────────────────────────────────────────────────
  const tool = findTool('reconcile_projection');
  check('reconcile_projection exists and needs no arguments', !!tool
    && ((tool.parameters as { required: string[] }).required.length === 0));
  check('a settled horizon is compared against what actually happened',
    /historicalSnapshot\(ctx, cp\.horizon\)/.test(src));
  // ⚠️ MID-FLIGHT, PROJECTION AGAINST PROJECTION. Setting a year-end statement
  // beside today's balance and subtracting produces a number about two different
  // instants that means nothing at all.
  check('an open horizon is compared against the same projection re-run today',
    /the same projection re-run today, to the same horizon/.test(read('scripts/ai-baseline/tools.ts')));
  check('…and the result says so, so it is not described as a current balance',
    /must not be described as one/.test(read('scripts/ai-baseline/tools.ts')));
  check('nothing recorded is reported as nothing recorded, never as nothing said',
    /there is nothing to/.test(read('scripts/ai-baseline/tools.ts')));
  check('an unknown metric is refused rather than mapped to something plausible',
    /no authority in this harness answers the metric/.test(read('scripts/ai-baseline/tools.ts')));
  check('the reconciliation is bounded', /MAX_RECONCILED = 6/.test(src));
  check('tools.ts still holds no Prisma client after gaining a memory read',
    !/from '@\/lib\/db'/.test(src) && !src.includes('db.'));
}

console.log(failures === 0 ? '\nAll baseline-harness checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
})();
