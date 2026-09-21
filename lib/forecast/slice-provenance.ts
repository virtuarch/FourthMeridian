/**
 * lib/forecast/slice-provenance.ts
 *
 * THE FORECAST SLICE PROVENANCE MANIFEST — what each FORECAST slice's own commit
 * did NOT touch.
 *
 * Every FORECAST-N suite asserted a claim of the form "FORECAST-N did not touch
 * FORECAST-1..N-1", pinned commit-to-commit (never against the working tree: a
 * claim about one slice's diff has no standing to forbid a LATER slice from
 * editing the same files — FORECAST-6 L5, FORECAST-7 J6 and FORECAST-8 J10/J11
 * each tripped on exactly that). Those claims were `git diff <parent> <commit>`
 * calls inside the unit tests, which made the unit suite depend on repository
 * ancestry: a depth-1 checkout (GitHub Actions' default) failed all eight suites
 * with "bad revision" before a single forecast assertion ran.
 *
 * The claims are facts about immutable history, so they live here as DATA and
 * are checked in two halves:
 *
 *   · the unit suites (hermetic — no git, no network) assert that their claim is
 *     still recorded here and still covers every file it named. Deleting a claim
 *     or dropping a path from it fails the suite that owns it.
 *   · scripts/audit-forecast-slice-provenance.ts (REQUIRED, the CI architecture
 *     gate) verifies every record against the real commit objects: `parent` IS
 *     `commit`'s parent, the subject names the slice, and the diff over
 *     `untouched` is empty. On a shallow clone it fetches exactly these commits
 *     and fails closed if it cannot.
 *
 * Adding a slice: record its own commit and its first parent, never a range.
 */

export interface SliceProvenance {
  /** The slice whose commit the claim is about; its subject line starts with this. */
  slice: string;
  /** The slice commit's first parent (full SHA). */
  parent: string;
  /** The slice commit (full SHA). */
  commit: string;
  /** Paths (files or directory prefixes) the slice commit changed nothing under. */
  untouched: readonly string[];
}

const F = (p: string) => `lib/forecast/${p}.ts`;

export const FORECAST_SLICE_PROVENANCE: readonly SliceProvenance[] = [
  {
    slice: 'FORECAST-2',
    parent: 'abdf72f2b73e4b6798bdbdcf39c89e24b670407f',
    commit: 'd720d1e09090a61e75206d0607fff44c79c40cd9',
    untouched: [F('cadence')],
  },
  {
    slice: 'FORECAST-3',
    parent: 'd720d1e09090a61e75206d0607fff44c79c40cd9',
    commit: 'f849c05b2f35a1a3faf5e2d7722723485cc47903',
    untouched: [F('cadence'), F('stream-activity')],
  },
  {
    slice: 'FORECAST-4',
    parent: 'f849c05b2f35a1a3faf5e2d7722723485cc47903',
    commit: 'f0af73d4b2b4feec3565de8eb7f80d25c9dfa887',
    untouched: [F('cadence'), F('stream-activity'), F('future-cash-event')],
  },
  {
    slice: 'FORECAST-5',
    parent: 'f0af73d4b2b4feec3565de8eb7f80d25c9dfa887',
    commit: '0506c672feec0bc4f1e39ded2564f48c48cf2bd2',
    untouched: [F('cadence'), F('stream-activity'), F('future-cash-event'), F('obligation')],
  },
  {
    slice: 'FORECAST-6',
    parent: '0506c672feec0bc4f1e39ded2564f48c48cf2bd2',
    commit: '5ca025a45b6f02cbaed2aebc4993755ac2940451',
    untouched: [F('cadence'), F('stream-activity'), F('future-cash-event'), F('obligation'),
      F('periodic-amount'), 'lib/transactions/flow-predicates.ts'],
  },
  {
    slice: 'FORECAST-7',
    parent: '5ca025a45b6f02cbaed2aebc4993755ac2940451',
    commit: '3bcfce3ce23860f04e18713f09393d18e4387e6f',
    untouched: [F('cadence'), F('stream-activity'), F('future-cash-event'), F('obligation'),
      F('periodic-amount'), F('spending-baseline'), 'lib/ai/economic-concepts.ts'],
  },
  {
    slice: 'FORECAST-8',
    parent: '3bcfce3ce23860f04e18713f09393d18e4387e6f',
    commit: '109c9e108d590d73494d6de549dbd8316430d98a',
    untouched: [F('cadence'), F('stream-activity'), F('future-cash-event'), F('obligation'),
      F('periodic-amount'), F('spending-baseline'), F('operating-state'), 'lib/ai/'],
  },
  {
    slice: 'FORECAST-9',
    parent: '6410d82cb976796ad565d5fea662c3c23bacb81c',
    commit: '714d0994bff272526dee82639c4f52412fb589f9',
    untouched: [F('cadence'), F('stream-activity'), F('future-cash-event'), F('obligation'),
      F('periodic-amount'), F('operating-state'), 'lib/ai/', 'app/', 'components/', 'prisma/'],
  },
];

/**
 * True when `slice`'s recorded claim still covers every path in `paths` — a path
 * is covered by itself or by a recorded directory prefix that contains it. The
 * unit suites call this with the paths their original `git diff` named, so the
 * claim cannot be weakened here without the owning suite failing.
 */
export function provenanceCovers(slice: string, paths: readonly string[]): boolean {
  const claim = FORECAST_SLICE_PROVENANCE.find((c) => c.slice === slice);
  if (!claim) return false;
  return paths.every((p) =>
    claim.untouched.some((u) => u === p || (u.endsWith('/') && p.startsWith(u))));
}
