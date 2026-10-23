/**
 * lib/db/write-phase.ts  (RLS-C-S8)
 *
 * A WRITER'S ATOMICITY MUST NOT DEPEND ON WHO CALLED IT.
 *
 * ── THE TRAP THIS EXISTS FOR ─────────────────────────────────────────────────
 * Three writers in the investments spine carry a documented, load-bearing
 * atomicity requirement — holdings reconciliation (delete-stale → update →
 * insert), investment-event correction (append + supersede, which must release
 * the `[source, externalEventId]` unique key inside one statement boundary), and
 * reconstruction persistence (one instrument set per account). Each of them
 * expressed it the same way:
 *
 *     if ("$transaction" in client) await (client as PrismaClient).$transaction(fn);
 *     else await fn(client);
 *
 * That line is correct and it is also the sharpest hazard in the conversion.
 * `Prisma.TransactionClient` has no `$transaction`, so under a tenant phase the
 * predicate is false and the writer takes the INLINE branch — which is right,
 * because it then becomes atomic with the enclosing phase. But it is right ONLY
 * IF THE PHASE ACTUALLY WRAPS IT. Draw the boundary one line too high and the
 * writer runs its three statements with no transaction around them at all:
 *
 *   - no error is raised, because a transaction client outside a transaction is
 *     not a thing that can exist — the type is only obtainable from inside one;
 *   - no test fails, because every statement still succeeds individually;
 *   - the requirement is simply gone, and the first partial failure in
 *     production leaves half a reconciliation behind.
 *
 * A silent loss of atomicity is indistinguishable from atomicity until the day
 * it matters. So the branch is made ONCE, here, named, and asserted — rather
 * than hand-written at each of the sites that must not get it wrong.
 *
 * ── WHY NOT JUST REQUIRE A ROOT CLIENT EVERYWHERE ────────────────────────────
 * Because that is the bug in the other direction. `withTenantDb` IS a
 * transaction (the identity it binds is transaction-local — see
 * lib/db/tenant-context.ts), so a writer called from inside a tenant phase can
 * only ever be handed a `Prisma.TransactionClient`. A writer that insisted on a
 * root client would be unreachable from any tenant phase, which is the whole
 * programme. Both shapes are legitimate; which one arrives is the CALLER's
 * fact, and the writer's job is to be correct either way.
 *
 * Dependency-free by design (type-only Prisma import, no `db`, no
 * "server-only"), so a route, a service, a job and a test harness can all reach
 * it — the same reason lib/db/conditional-write.ts is.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * An authority a WRITE may execute through.
 *
 * Deliberately a union, and deliberately NOT `ReadClient`: a read leaf is typed
 * so that `$transaction` is a compile error (Prisma's ITXClientDenyList strips
 * it), because a leaf must never own a phase boundary. A write spine entry point
 * is the opposite case — it is sometimes the outermost thing in the call stack,
 * and then somebody has to open the transaction its atomicity requires.
 *
 * `PrismaClient` here means a ROOT authority: `db` today, `systemDb` for a job,
 * never a tenant one (a tenant authority is only ever a transaction client).
 */
export type WriteClient = PrismaClient | Prisma.TransactionClient;

/**
 * True when this client can open a transaction of its own — i.e. it is a root
 * client and NOT already inside one.
 *
 * The predicate is `"$transaction" in client` and nothing cleverer, because that
 * is the only structural difference between the two shapes. What this function
 * adds is a NAME and a single place to test: `canOpenTransaction` is greppable,
 * `"$transaction" in client` scattered across four files is not.
 */
export function canOpenTransaction(client: WriteClient): client is PrismaClient {
  return "$transaction" in client;
}

/**
 * Run `fn` so that everything it does commits or rolls back together.
 *
 *   root client     → opens one interactive transaction and runs `fn` inside it.
 *   phase client    → runs `fn` INLINE on the caller's transaction, so the
 *                     writer's statements join the enclosing phase's atomic unit
 *                     instead of escaping into one of their own.
 *
 * ⚠️ THE INLINE BRANCH DELIVERS ATOMICITY BY LETTING THE ERROR OUT. It does not
 * catch, retry, or soften anything: a failure inside `fn` propagates to whoever
 * opened the phase, and that propagation IS the rollback. A caller that wraps
 * this in a try/catch for "best effort" reasons, while holding a phase client,
 * silently converts an all-or-nothing write into a partial one. Best-effort
 * handling belongs OUTSIDE the phase, around the phase runner.
 *
 * ⚠️ NEVER PUT NETWORK WORK IN `fn`. A provider HTTP call, a model call or
 * streaming inside a transaction holds a database connection (and, under RLS, a
 * bound identity) for the duration of somebody else's latency. The investments
 * spine's provider fetch completes in full BEFORE its persistence phase opens,
 * and lib/investments/transaction-boundary.test.ts scans these files to keep it
 * that way.
 */
export async function inOneTransaction<T>(
  client: WriteClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (canOpenTransaction(client)) return client.$transaction((tx) => fn(tx));
  return fn(client);
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE BULK-WRITE HALF LIVES IN lib/db/conditional-write.ts, NOT HERE.
 *
 * This slice needed the same primitive the disconnect slice (RLS-C-S7) was
 * building in parallel — `assertEveryObservedRowWasWritten` / `PartialBulkWriteError`
 * — because an `updateMany` keyed by `importBatchId` has the same defect as one
 * keyed by a link id: a count that fell short reports health. It was written
 * twice, independently, within an hour, which is itself the evidence that it is
 * the right abstraction. S7 landed first, so this file imports theirs rather than
 * shipping a second copy under a second name. The import sites are
 * lib/investments/investment-import-rollback.ts and the rollback route.
 *
 * What stays here is only the thing conditional-write.ts does NOT answer: WHICH
 * TRANSACTION a write belongs to. The two are complementary — one is about
 * whether a write landed, the other about what it landed WITH.
 * ──────────────────────────────────────────────────────────────────────────── */
