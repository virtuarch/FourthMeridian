/**
 * lib/ai/conversation/scenario-contract.test.ts   (I1 — Slice 1)
 *
 * THE SCENARIO ARGUMENT, FROM DECLARATION TO CONTINUITY, WITH NO SILENT GAP.
 *
 * `refuseUnknownArguments` already closes one direction: an argument the schema
 * does not declare is refused by name. This closes the other two, which nothing
 * did:
 *
 *   CONDITION 1  every declared argument has an explicit CONTINUITY POLICY —
 *                it is a hypothesis, or it is named as a non-assumption.
 *   CONDITION 3  every declared argument has a production CONSUMER — something
 *                reads it, so an accepted key cannot be executed-as-absent.
 *
 * ⚠️ WHY A DECLARED-BUT-UNCONSUMED KEY IS THE DANGEROUS ONE. It is ACCEPTED (the
 * schema declares it, so the refusal machinery waves it through), it is ECHOED
 * (the arguments are preserved verbatim into the envelope), it is REPLAYED on
 * every later turn — and no code reads it. The scenario runs without the clause
 * and says nothing, which is the G5 substitution one level up. Before this file,
 * the only thing standing in the way was a hard-coded `'incomeChanges'` string in
 * a list of four reviewer's examples: deleting that one string would have made
 * the whole suite green on a schema key with zero consumers.
 *
 * ⚠️ EVERY CHECK IS PLANTED. A guard nobody has watched refuse is a guard nobody
 * knows works, so each invariant is run twice — once against the real schema, and
 * once against a schema carrying a mutation it must reject.
 *
 * Pure: reads two source files off disk and the schema module. No DB, no clock.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SCENARIO_INPUTS, NOT_AN_ASSUMPTION, scenarioAssumptionKeys,
} from './scenario-inputs';

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('scenario-contract — declared ⇒ classified ⇒ consumed');

const TOOLS = src('lib/ai/conversation/tools.ts');
const ACTIVE = src('lib/ai/conversation/active-scenario.ts');

/**
 * `prepareScenario`'s body — the one function that turns scenario arguments into
 * ledger inputs. Bounded deliberately: a key mentioned in some OTHER tool's
 * handler is not consumed by the scenario contract.
 */
const PREPARE = (() => {
  const from = TOOLS.indexOf('async function prepareScenario(');
  const to = TOOLS.indexOf('\nconst scenarioProjection: ToolDefinition', from);
  if (from < 0 || to < 0) throw new Error('prepareScenario not found — this guard is broken, not passing');
  return TOOLS.slice(from, to);
})();

/**
 * THE PREDICATE, as a function so a mutation can be run through it.
 *
 * A key is CONSUMED when `prepareScenario` reads it off its arguments object.
 * `a.granularity`, `a['granularity']` and a destructure all count; the key
 * appearing only inside its own schema description does not, which is precisely
 * the case a declared-but-unread key presents.
 */
function unconsumedKeys(keys: readonly string[], body: string): string[] {
  return keys.filter((k) => {
    const reads = [
      new RegExp(`\\ba\\.${k}\\b`),
      new RegExp(`\\ba\\[['"\`]${k}['"\`]\\]`),
      new RegExp(`\\{[^}]*\\b${k}\\b[^}]*\\}\\s*=\\s*a\\b`),
    ];
    return !reads.some((r) => r.test(body));
  });
}

/** Keys with no continuity policy: neither an assumption nor a named exception. */
function unclassifiedKeys(schema: Record<string, unknown>, except: readonly string[]): string[] {
  const assumptions = new Set(scenarioAssumptionKeys(schema, except));
  return Object.keys(schema).filter((k) => !assumptions.has(k) && !except.includes(k));
}

// ── 1. CONDITION 1 — every declared argument has a continuity policy ─────────
{
  const keys = Object.keys(SCENARIO_INPUTS);
  check('the schema declares at least the arguments this guard was written for',
    ['annualReturnPct', 'returns', 'contributions', 'outflows', 'assumedMonthlySpending',
      'liabilityAssumptions', 'granularity'].every((k) => keys.includes(k)), keys.join(','));

  check('every declared argument is classified', unclassifiedKeys(SCENARIO_INPUTS, NOT_AN_ASSUMPTION).length === 0,
    unclassifiedKeys(SCENARIO_INPUTS, NOT_AN_ASSUMPTION).join(','));

  // ⚠️ THE EXCEPTION LIST IS CLOSED AND SMALL. It is the only way an argument can
  // stop being treated as a hypothesis, so it is pinned by value rather than by
  // length — a second member arriving quietly is the thing to notice.
  check('the non-assumption exception list is exactly {granularity}',
    JSON.stringify([...NOT_AN_ASSUMPTION].sort()) === JSON.stringify(['granularity']),
    NOT_AN_ASSUMPTION.join(','));

  // ⚠️ THE FAIL-SAFE DIRECTION. A NEW argument must default to being an
  // assumption, so a crossing carrying only it REPLACES the scenario rather than
  // leaving a stale one standing.
  const planted = { ...SCENARIO_INPUTS, incomeChanges: { type: 'array' } } as Record<string, unknown>;
  check('PLANTED: a new argument defaults to ASSUMPTION, not to silence',
    scenarioAssumptionKeys(planted).includes('incomeChanges'));
  check('PLANTED: …and is therefore classified without anyone editing a list',
    unclassifiedKeys(planted, NOT_AN_ASSUMPTION).length === 0);

  // The derivation must actually be wired — a derived list beside a hand-written
  // one still in use would be worse than either.
  check('active-scenario derives its keys and keeps no list of its own',
    ACTIVE.includes('scenarioAssumptionKeys()')
    && !/const ASSUMPTION_KEYS\s*=\s*\[\s*'/.test(ACTIVE));
  check('the derivation reads SCENARIO_INPUTS, not a tool\'s own `parameters`',
    /scenarioAssumptionKeys\(\s*\n?\s*schema: Record<string, unknown> = SCENARIO_INPUTS/
      .test(src('lib/ai/conversation/scenario-inputs.ts')));
}

// ── 2. CONDITION 3 — every declared argument has a production consumer ───────
{
  const keys = Object.keys(SCENARIO_INPUTS);
  const missing = unconsumedKeys(keys, PREPARE);
  check('every declared scenario argument is READ by prepareScenario',
    missing.length === 0, `unconsumed: ${missing.join(',')}`);

  // ⚠️ THE MUTATION. Without this, the check above is satisfied by a schema that
  // happens to have no unconsumed keys today and would say nothing on the day one
  // appears. This was run for real against `incomeChanges` before the spine read
  // it — declaring it turned the suite red by name — and the planted key is now a
  // synthetic one, because the real one has a consumer.
  check('PLANTED: a declared key with no consumer is CAUGHT',
    unconsumedKeys([...keys, 'plantedKeyWithNoConsumer'], PREPARE).join(',') === 'plantedKeyWithNoConsumer');
  check('PLANTED: a misspelt consumer does not satisfy the guard',
    unconsumedKeys(['assumedMonthlySpendng'], PREPARE).length === 1);
  // A key named only in its own schema prose is NOT consumed — the exact shape of
  // the failure, since a description always mentions the thing it describes.
  check('PLANTED: a key mentioned only in the schema literal is not "consumed"',
    unconsumedKeys(['quarterly'], PREPARE).length === 1);

  // The closure in the other direction is the existing machinery; pinned here so
  // both halves of the contract are read in one place.
  check('an undeclared argument is still refused by name (the other direction)',
    TOOLS.includes('refuseUnknownArguments(a, tool.parameters)'));
}

// ── 3. The schema is ONE literal ─────────────────────────────────────────────
{
  check('tools.ts imports the schema and does not restate it',
    /import \{ SCENARIO_INPUTS[^}]*\} from '\.\/scenario-inputs'/.test(TOOLS)
    && !TOOLS.includes('const SCENARIO_INPUTS = {'));
  check('all three scenario tools spread the same literal',
    (TOOLS.match(/\.\.\.SCENARIO_INPUTS/g) ?? []).length === 3,
    String((TOOLS.match(/\.\.\.SCENARIO_INPUTS/g) ?? []).length));
  // ⚠️ PURE, so the continuity module can read it. A schema that dragged in the
  // database layer could not be imported by `active-scenario.ts` at all, which is
  // why the list was hand-written in the first place.
  const INPUTS = src('lib/ai/conversation/scenario-inputs.ts');
  check('the schema module imports nothing', !/^\s*import\s/m.test(INPUTS));
}

if (failures > 0) { console.error(`\nscenario-contract: ${failures} failure(s).`); process.exit(1); }
console.log('\nscenario-contract: all passed.');
