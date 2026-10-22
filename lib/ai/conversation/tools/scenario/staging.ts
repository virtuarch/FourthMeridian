/**
 * lib/ai/conversation/tools/scenario/staging.ts
 *
 * Planning continuity: `stage_assumptions`.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { resolveTransformableCategory } from '@/lib/transactions/category-vocabulary';
import { SCENARIO_INPUTS, scenarioAssumptionKeys } from '../../scenario-inputs';
import { stagePlan } from '../../pending-plan';
import { notAppliedEcho } from '../../scenario-rules';
import type { ToolDefinition } from '../types';
import { obj } from '../shared/schema';

// ── 12. Staging — conditions stated before a scenario has run ────────────────

/**
 * THE CARRIER FOR "SAID, NOT YET RUN" (planning continuity).
 *
 * ⚠️ ITS PARAMETERS ARE THE SCENARIO'S OWN, READ OFF `SCENARIO_INPUTS`. There is
 * no second schema: a clause staged here is one item of the argument the scenario
 * tools already take, in the same shape, checked against the same literal — and
 * the next scenario run merges it in by identity (`pending-plan.ts`).
 *
 * ⚠️ THE BOUNDARY WITH `remember` IS THE SENTENCE THIS DESCRIPTION LEADS WITH.
 * Measured before this tool existed: "For this scenario, keep nine months in cash"
 * was written to DURABLE memory 3/3 — because memory was the only structured place
 * a condition could go. A condition for the calculation being assembled is staged
 * here; a standing preference the user wants kept across conversations is theirs
 * to ask `remember` for.
 */
/** S1 — the transformable lines named by held spending clauses, with what each holds. */
function spendingLinesHeld(clauses: readonly { key: string; value: unknown }[]) {
  const seen = new Map<string, { line: string; class: string; contains: string }>();
  for (const c of clauses) {
    const word = c.key === 'spendingChanges' ? (c.value as { category?: unknown }).category : undefined;
    if (typeof word !== 'string' || !word.trim()) continue;
    const r = resolveTransformableCategory(word);
    if (r.ok && !seen.has(r.category)) seen.set(r.category, { line: r.category, class: r.class, contains: r.meaning });
  }
  return [...seen.values()];
}

export const stageAssumptions: ToolDefinition = {
  name: 'stage_assumptions',
  description:
    'Hold a condition the user just stated for a projection that has NOT been run yet — a '
    + 'raise or income change from a date, a cut or change to a spending line or to all '
    + 'spending ("cut Dining 20%"), a cash floor, which debt to pay first, where the '
    + 'rest goes, a one-off amount, a return, a spending level — so the next '
    + 'scenario_projection, scenario_crossing or scenario_goal_seek in this conversation '
    + 'applies it. Use it whenever a condition is stated without asking for a figure yet ("keep '
    + 'nine months of expenses in cash", "starting January my income goes up 10%", "pay the '
    + 'highest APR first", "for this scenario, …"), and to restate one ("actually make it 15%" '
    + 'replaces the staged raise). Each field takes exactly the shape the scenario tools take. '
    + 'Staged conditions are NOT remembered beyond this conversation, NOT current facts, and NOT '
    + 'results: nothing is calculated until a scenario runs. A standing preference the user wants '
    + 'kept for future conversations is a different thing, and is not this.',
  // ⚠️ THE KEYS ARE DERIVED; THE SHAPES ARE REFERENCED, NOT COPIED. Spreading
  // `SCENARIO_INPUTS` in here restated ~11 KB of schema that scenario_projection
  // already puts in every prompt. The model reads each shape there; this names the
  // same closed set of keys, and `pending-plan.ts` checks every entry against the
  // canonical literal exactly as the scenario would.
  parameters: obj({
    ...Object.fromEntries(scenarioAssumptionKeys().map((k) => {
      const t = (SCENARIO_INPUTS as Record<string, { type?: string }>)[k]?.type ?? 'object';
      return [k, { type: t, ...(t === 'array' ? { items: { type: 'object' } } : {}),
        description: `Exactly the shape of scenario_projection's \`${k}\`.` }];
    })),
    retract: { type: 'array', items: { type: 'string' },
      description: 'Ids of staged conditions the user has withdrawn (e.g. "p2").' },
    // ⚠️ MEASURED 1/6: "invest everything above the floor", after "pay highest APR
    // debt first", was sent with `replace: true` and the debt order left the plan —
    // the guard made it explicit, and the description had not said that naming the
    // NEXT destination is not withdrawing the first.
    replace: { type: 'boolean', description: 'Only when the user WITHDREW or CORRECTED part of a '
      + 'staged rule ("don\'t pay debt first after all", "actually from February"). Saying where '
      + 'money goes NEXT is not a withdrawal: "invest everything above the floor" after "pay the '
      + 'highest APR first" is `target: ["highest_apr","investments"]`, without `replace`.' },
    // ⚠️ THE REFUSAL NAMED A FLAG THIS TOOL DID NOT HAVE (found in S1). Staging a
    // second rule about the same thing from another date ("another 10% from July",
    // "a second raise in July") is refused until the call says which it is, and the
    // refusal says "stage it again with `inAddition: true`" — which this schema did
    // not declare, so the retry was refused as an unknown assumption.
    inAddition: { type: 'boolean', description: 'Only when the user stated a SECOND rule about the '
      + 'same thing from another date and BOTH apply ("then cut it another 10% starting July", "and '
      + 'another raise next year"). Not for a correction — that is `replace`.' },
  }),
  async run(a, ctx) {
    if (!ctx.plan || !ctx.turn) {
      return { unavailable: 'this conversation cannot hold staged conditions here, so nothing was '
        + 'staged. State the conditions in the scenario call itself.' };
    }
    // ⚠️ STAGING IS FOR BEFORE A SCENARIO RUNS, AND ONLY THEN. Measured: once a
    // scenario had run, "actually make the raise 15%" was STAGED 6/6 and nothing
    // re-ran, although the result said to run it — the recompute I1 held at 6/6
    // fell to 0/6. After a run, a change takes effect by running again with it; the
    // envelope carries every condition that ran, and a re-run merges nothing stale
    // because the staged plan is empty from the moment a scenario runs. One carrier
    // per phase: stated-not-run here, ran in the envelope.
    // Withdrawing is always allowed: a clause a run could not confirm is still held,
    // and the user must be able to take it back after the run as well as before.
    const onlyRetracting = Object.keys(a).every((k) => k === 'retract');
    if (ctx.plan.scenarioRan && !onlyRetracting) {
      return { unavailable: 'a scenario has ALREADY RUN in this conversation, so this change was '
          + 'NOT staged — staging holds conditions only until the first run',
        instead: 'run scenario_projection again now with the ACTIVE SCENARIO\'s arguments and this '
          + 'change applied to them (for the horizon the user asked about). That run is the answer.' };
    }
    const { retract, replace, inAddition, ...stage } = a;
    const r = stagePlan(ctx.plan.pending,
      { stage, replace: replace === true, inAddition: inAddition === true,
        retract: Array.isArray(retract) ? retract.filter((x): x is string => typeof x === 'string') : [] },
      { turn: Math.max(0, ctx.turn.userTexts.length - 1), evidence: ctx.turn });
    ctx.plan.pending = r.plan;
    return {
      staged: r.staged, retracted: r.retracted,
      ...(r.refused.length ? { notStaged: notAppliedEcho(r.refused) } : {}),
      ...(r.replacedFields.length ? { replacedFields: {
        fields: r.replacedFields,
        meaning: 'These fields REPLACED what was staged before — a merge cannot tell "instead" from '
          + '"then". If the user meant both (e.g. pay the highest-APR debt first, THEN invest the '
          + 'rest), stage the combined value, e.g. `target: ["highest_apr", "investments"]`.',
      } } : {}),
      heldNow: r.plan.clauses.map((c) => ({ id: c.id, [c.key]: c.value })),
      // S1 — what each held spending line CONTAINS, so a whole bucket is said when the
      // user is told it is held ("Dining — which includes groceries").
      ...(spendingLinesHeld(r.plan.clauses).length ? { spendingLines: {
        lines: spendingLinesHeld(r.plan.clauses),
        meaning: 'Tell the user what each held line contains — a WHOLE bucket (Dining includes '
          + 'groceries, Utilities includes rent) or the catch-all (Other) changes all of it.' } } : {}),
      meaning: 'Held for THIS conversation only and not yet run; nothing here is a figure. The next '
        + 'scenario run applies every condition in `heldNow` and says so. To answer with numbers, '
        + 'run the scenario.',
    };
  },
};
