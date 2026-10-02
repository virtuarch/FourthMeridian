/**
 * lib/db/conditional-write.ts  (RLS-C-S6a)
 *
 * A ZERO-ROW CONDITIONAL WRITE IS NOT AN ANSWER.
 *
 * ── THE ASYMMETRY THIS EXISTS FOR ────────────────────────────────────────────
 * Under a tenant role a policy refusal is NOT uniformly loud:
 *
 *     INSERT  refused by WITH CHECK  →  raises
 *     UPDATE  refused by USING       →  { count: 0 }   no error, no log
 *     DELETE  refused by USING       →  { count: 0 }   no error, no log
 *
 * Postgres is behaving exactly as specified: a row the policy hides is simply
 * not a row the statement matched. The hazard is entirely on our side, because
 * `updateMany`/`deleteMany` return a count and this codebase has
 * compare-and-swap code that reads that count as a BUSINESS ANSWER —
 * "somebody else got there first."
 *
 * That reading turns a tenant-isolation refusal into ordinary CONTENTION, and
 * contention has a defined, calm, permanent response: back off and let the
 * other worker finish. There is no other worker. Nothing retries into success,
 * nothing escalates, nothing is logged — the system politely does nothing,
 * forever, while reporting health. A silent wrong answer is worse than an
 * error, and this is the quietest one we have.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * Inside a tenant phase, a zero-row `updateMany`/`deleteMany` is INDETERMINATE
 * unless the row's visibility was already established in the same phase. It may
 * not be reported as a business outcome.
 *
 * ── WHY A HELPER AND NOT A CONVENTION ────────────────────────────────────────
 * The whole problem is that the WRONG CODE LOOKS RIGHT: `return count === 1` is
 * idiomatic, reviewed thousands of times, and correct in every codebase without
 * row-level security. A convention cannot carry a property whose violation is
 * invisible. So the distinction is made mechanically, and it is cheap, because
 * VISIBILITY and THE CAS CONDITION are separable questions:
 *
 *     const { count } = await client.x.updateMany({ where: { id, ...cas }, data });
 *     const won = await resolveConditionalWrite(
 *       count,
 *       { table: "X", rowId: id, operation: "update" },
 *       () => client.x.count({ where: { id } }),   // SAME client, SAME policy
 *     );
 *
 * One extra indexed `count`, ON THE FAILURE PATH ONLY — the probe is a thunk
 * precisely so the success path cannot pay for it, and a test asserts the thunk
 * is never invoked when the write matched.
 *
 * ── WHAT `visible === 0` MEANS, AND WHY THE CONFLATION IS CORRECT ────────────
 * It conflates "the policy hid the row" with "the row no longer exists". That
 * is deliberate and it is not a weakness: NEITHER IS CONTENTION, and contention
 * is the only thing the caller was entitled to conclude. Note the corollary —
 * this is not a database defect and no widened policy or extra grant fixes it.
 * It would still be a defect with RLS switched off and the row merely deleted.
 *
 * ── THE PROBE MUST SHARE THE WRITE'S AUTHORITY ───────────────────────────────
 * The thunk MUST issue its count through the same client the write used. A probe
 * on a wider authority (`db`, `systemDb`) would answer "yes, the row exists"
 * for a row the writing authority cannot see, which is the original bug with a
 * more expensive round trip. The type system cannot enforce this — the thunk's
 * closure is opaque — so it is stated here and pinned by the source scan in
 * lib/db/conditional-write.test.ts.
 *
 * Dependency-free by design: no Prisma types, no `db` import, no "server-only".
 * It must be callable from a route, a service, a job and a test harness alike,
 * and a generic over Prisma's delegate types cannot be written without `any`.
 */

/** The statement whose count came back zero. `delete` and `update` fail identically. */
export type ConditionalWriteOperation = "update" | "delete";

/**
 * What an operator needs to act, and nothing more.
 *
 * ⚠️ NO ROW CONTENTS. This travels into logs and error reporting. A table name,
 * a primary key and a verb are enough to find the row and the policy; the
 * columns the statement was trying to write are not, and one of these sites
 * writes credentials-adjacent operator settings.
 */
export interface ConditionalWriteSite {
  /** The database table, as the policy names it (e.g. "PlaidItem"). */
  readonly table: string;
  /** The row's primary key — the value the CAS predicated on identity with. */
  readonly rowId: string;
  readonly operation: ConditionalWriteOperation;
}

/**
 * A conditional write matched no rows AND the row is not visible to the
 * authority that attempted it.
 *
 * The caller must not translate this into contention, a conflict, a 409, a
 * retry-later, or any other calm business outcome — the entire point is that
 * this stops being silent. Catch it only where throwing would turn a
 * best-effort write into a fatal one, and log it where you do.
 */
export class IndeterminateWriteError extends Error {
  readonly table: string;
  readonly rowId: string;
  readonly operation: ConditionalWriteOperation;

  constructor(site: ConditionalWriteSite) {
    super(
      `${site.table} row "${site.rowId}": conditional ${site.operation} matched 0 rows and the row is NOT VISIBLE to this authority. ` +
        `Refusing to report contention — the statement was either refused by row-level security or the row no longer exists, and neither is a concurrent writer.`,
    );
    this.name = "IndeterminateWriteError";
    this.table = site.table;
    this.rowId = site.rowId;
    this.operation = site.operation;
  }
}

/**
 * Turn the count of an already-performed conditional write into the only two
 * conclusions it can honestly support.
 *
 *   count > 0   the write landed. Returns true. **The probe is never called** —
 *               the cost of this guard lives entirely on the failure path.
 *   count === 0 and the row IS visible   genuine contention. Returns false,
 *               which is exactly what the caller used to return, so converting
 *               a site does not change its happy or its racing behaviour.
 *   count === 0 and the row is NOT visible   throws IndeterminateWriteError.
 *
 * `count` is passed in rather than the statement being performed here on the
 * caller's behalf: Prisma's delegates cannot be abstracted over without `any`,
 * and a wrapper that owned the write would have to take an untyped `where`.
 * Keeping the write at the call site keeps its `where` clause typed and honest,
 * and leaves this function with nothing to get wrong.
 *
 * A probe that itself rejects propagates untouched. A broken probe must not
 * decay into "contention" — that is the failure this module exists to remove.
 */
export async function resolveConditionalWrite(
  count: number,
  site: ConditionalWriteSite,
  probeVisibleRows: () => Promise<number>,
): Promise<boolean> {
  if (count > 0) return true;

  const visible = await probeVisibleRows();
  if (visible > 0) return false;

  throw new IndeterminateWriteError(site);
}
