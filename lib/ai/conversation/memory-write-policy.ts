/**
 * lib/ai/conversation/memory-write-policy.ts — FM-AUDIT-019
 *
 * WHO MAY WRITE DURABLE MEMORY.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * Every turn can write `SpaceMemory`: the `remember` tool, and the silent
 * `checkpointProjection` after an evidence-based project_cash. The dogfood and
 * evaluation harnesses (`npm run ai:chat`, `ai:baseline`, the `ai:*` checks) open
 * the SAME transcript the product does, against whatever `.env.local` names —
 * the operator's real database — with no guard armed. So a probe sentence ("I
 * want $1M by 2030", "use $5k") became the operator's real goal and planning
 * figure, a probe projection superseded the real checkpoint for that horizon,
 * and `reconcile_projection` later graded the probe. The harness header called
 * itself read-only.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * Durable memory writes are OFF unless a caller turns them on. `ToolContext`
 * carries `memoryWrites`; only `true` permits a write, and the two write paths
 * (`remember`, `checkpointProjection`) refuse / no-op otherwise. Exactly two
 * callers set it:
 *   · the product chat route — memory is a product feature, written for the
 *     signed-in user in their own Space;
 *   · a harness that EXPLICITLY opted in with `FM_AI_MEMORY_WRITES=clone-only`
 *     AND is pointed at a clone (`fintracker_<suffix>`). Opting in against the
 *     live database, or an unidentifiable one, is refused before anything runs.
 * Reads (the memory line, `recall`, reconciliation) are unaffected: a probe may
 * SEE memory; it may not become it.
 *
 * Pure. No I/O.
 */

import { classifyDatabaseTarget } from '@/lib/db/live-guard';

export const HARNESS_MEMORY_ENV = 'FM_AI_MEMORY_WRITES';
export const HARNESS_MEMORY_CLONE_ONLY = 'clone-only';

export type HarnessMemoryPolicy =
  | { writes: false; basis: 'READ_ONLY_DEFAULT' }
  | { writes: true; basis: 'CLONE_OPT_IN'; database: string }
  | { refusal: string };

/**
 * The durable-memory policy for a harness run, from its environment.
 *
 * Unset ⇒ read-only (the default — a harness never writes memory by accident).
 * `clone-only` ⇒ writes, but only against a clone; anything else refuses.
 * Any other value refuses (a typo must not silently mean "write").
 */
export function harnessMemoryPolicy(env: NodeJS.ProcessEnv = process.env): HarnessMemoryPolicy {
  const asked = env[HARNESS_MEMORY_ENV];
  if (asked === undefined || asked === '') return { writes: false, basis: 'READ_ONLY_DEFAULT' };
  if (asked !== HARNESS_MEMORY_CLONE_ONLY) {
    return { refusal: `${HARNESS_MEMORY_ENV}=${asked} is not a recognised value. Leave it unset for a `
      + `read-only run, or set ${HARNESS_MEMORY_ENV}=${HARNESS_MEMORY_CLONE_ONLY} against a clone.` };
  }
  const target = classifyDatabaseTarget(env.DATABASE_URL);
  if (target.verdict !== 'NON_LIVE') {
    return { refusal: `${HARNESS_MEMORY_ENV}=${HARNESS_MEMORY_CLONE_ONLY} asks to write durable memory, but `
      + `${target.reason} Point DATABASE_URL (and DIRECT_URL) at a clone \`fintracker_<suffix>\`, or leave `
      + `${HARNESS_MEMORY_ENV} unset for a read-only run. Nothing was run.` };
  }
  return { writes: true, basis: 'CLONE_OPT_IN', database: target.name! };
}

/**
 * For a harness whose PURPOSE is writing memory rows (a memory-store check that
 * seeds and reads back scratch rows): it may only ever run against a clone.
 * Throws otherwise — before any row is written.
 */
export function assertCloneForDurableWrites(env: NodeJS.ProcessEnv = process.env): string {
  const target = classifyDatabaseTarget(env.DATABASE_URL);
  if (target.verdict !== 'NON_LIVE') {
    throw new Error('REFUSING TO RUN: this check writes durable memory rows, and '
      + `${target.reason} Run it against a clone (DATABASE_URL=…/fintracker_<suffix>). Nothing was written.`);
  }
  return target.name!;
}

/** The single predicate the write paths consult. Only an explicit `true` permits a write. */
export function durableMemoryWritesAllowed(ctx: { memoryWrites?: boolean }): boolean {
  return ctx.memoryWrites === true;
}
