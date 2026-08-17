/**
 * lib/transactions/event-write.ts   (L8 — Part 4)
 *
 * THE one way an observation is recorded and its event resolved. SERVER-ONLY.
 *
 * Every banking ingest path calls `recordTransactionObservation`; none of them
 * writes `TransactionObservation` or `TransactionEvent` directly, and a probe
 * enforces that. The identity decision itself is pure
 * (`lib/transactions/event-identity.ts`) — this module supplies evidence and
 * persists the outcome.
 *
 * ── Idempotence ────────────────────────────────────────────────────────────
 *
 * `observationKey` is unique. Replaying an identical provider payload finds the
 * existing observation and returns it: zero new rows, zero event drift. A
 * genuine restatement produces a different key, appends an observation, and
 * re-derives the event's projection from ALL of them.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * ⚠️ BANKING ONLY. `isEventEligibleProvider` refuses WALLET/EXCHANGE outright: a
 * wallet transaction has no pending↔posted lifecycle of this shape, and forcing
 * it into these tables would model a state no provider attests. Crypto shares
 * the abstraction later through its own domain implementation. A probe asserts
 * the crypto writers never reach this module.
 *
 * ⚠️ Readers: the population cutover reads the projection through
 * `eventProjectionWhere` (L8-B1), and — B-6 — the event's economicDate is now
 * AUTHORITATIVE for its current row's chronology: `reprojectEvent` materializes
 * it into `Transaction.economicDate` (see its doc block). Lifecycle/amount
 * remain row-carried; their reader cutover is still a separate slice.
 */

// ⚠️ NO `server-only` marker, deliberately.
//
// This module takes an explicit `db` handle and touches Prisma directly, so it
// can never run in a browser bundle regardless — the marker added nothing a
// client component could actually violate. What it DID do was make the module
// unreachable from `tsx`, which is how the database seed and the backfill both
// run. That forced the backfill to re-implement the persistence, and it would
// have forced the seed to do the same.
//
// One writer that every path can reach is worth more than a bundling marker on
// a module no bundle includes. The real boundary is unchanged: identity is
// decided by the pure authority (`event-identity.ts`), and a standing probe
// asserts nothing outside this module writes the L8 tables.
import type { Prisma, PrismaClient, ProviderType, SettlementState } from "@prisma/client";
import {
  resolveEventLink, projectEvent, observationKey, isEventEligibleProvider,
  type EventLinkBasis, type EventLinkRefusal, type ObservationFacts,
} from "@/lib/transactions/event-identity";

// Re-exported so an ingest path imports ONE module, while the pure definitions
// stay in event-identity.ts where a tsx script can reach them.
export { observationKey, isEventEligibleProvider };

/** A Prisma client or an interactive-transaction handle. */
type Db = PrismaClient | Prisma.TransactionClient;

export interface ObservationInput {
  transactionId: string;
  financialAccountId: string;
  provider: ProviderType;
  providerRowId: string | null;
  providerPendingRef: string | null;
  lifecycle: SettlementState;
  amount: number;
  postingDate: Date;
  economicDate: Date;
  authorizedAt: Date | null;
  /** The row this observation came from, if it is still live. */
  transactionIsLive: boolean;
  /** Injected so a backfill can replay historical observation times honestly
   *  rather than stamping "now" on a two-year-old row. */
  observedAt: Date;
}

export interface ObservationResult {
  observationId: string;
  eventId: string;
  basis: EventLinkBasis;
  refusal: EventLinkRefusal | null;
  /** False when an identical observation already existed — the idempotent path. */
  created: boolean;
}

/**
 * Record one provider observation and resolve its logical event.
 *
 * Returns the existing observation untouched when the same payload is replayed.
 * Never mutates an observation — a restatement appends.
 */
export async function recordTransactionObservation(
  db: Db,
  input: ObservationInput,
): Promise<ObservationResult | null> {
  if (!isEventEligibleProvider(input.provider)) return null;

  const key = observationKey({
    provider: input.provider,
    financialAccountId: input.financialAccountId,
    providerRowId: input.providerRowId,
    transactionId: input.transactionId,
    lifecycle: input.lifecycle as "PENDING" | "POSTED",
    amount: input.amount,
    postingDate: input.postingDate,
    economicDate: input.economicDate,
  });

  // ── Idempotence, checked FIRST ───────────────────────────────────────────
  const existing = await db.transactionObservation.findUnique({
    where: { observationKey: key },
    select: { id: true, eventId: true },
  });
  if (existing) {
    // B-6 — RE-PIN even on the idempotent path. The ingest writer stamps the
    // row's economicDate from ROW evidence just before calling here; when the
    // event's pinned date differs (a pending→posted chain whose pin is earlier
    // than the row's own evidence supports), a replayed payload would leave the
    // row on the wrong date FOREVER — the observation key exists, so no future
    // write ever corrects it. One guarded no-op-when-equal write closes that.
    await pinRowToEvent(db, existing.eventId);
    return { observationId: existing.id, eventId: existing.eventId, basis: "PERSISTED_LINK", refusal: null, created: false };
  }

  // ── Evidence for the identity decision ───────────────────────────────────
  const anchors = [input.providerRowId, input.providerPendingRef].filter((x): x is string => x != null);
  const related = anchors.length
    ? await db.transactionObservation.findMany({
        where: { providerRowId: { in: anchors } },
        select: { providerRowId: true, eventId: true, financialAccountId: true },
      })
    : [];
  const eventByProviderRowId = new Map<string, string>();
  const accountByProviderRowId = new Map<string, string>();
  for (const r of related) {
    if (!r.providerRowId) continue;
    eventByProviderRowId.set(r.providerRowId, r.eventId);
    accountByProviderRowId.set(r.providerRowId, r.financialAccountId);
  }
  const claimsPerPendingRef = new Map<string, number>();
  if (input.providerPendingRef) {
    // Count OTHER observations claiming the same predecessor. More than one and
    // 1:1 identity cannot hold, so the authority refuses both.
    const claims = await db.transactionObservation.count({
      where: { providerPendingRef: input.providerPendingRef, NOT: { transactionId: input.transactionId } },
    });
    claimsPerPendingRef.set(input.providerPendingRef, claims + 1);
  }

  const persisted = await db.transaction.findUnique({
    where: { id: input.transactionId },
    select: { transactionEventId: true },
  });

  const link = resolveEventLink(
    {
      transactionId: input.transactionId,
      financialAccountId: input.financialAccountId,
      providerRowId: input.providerRowId,
      providerPendingRef: input.providerPendingRef,
      persistedEventId: persisted?.transactionEventId ?? null,
    },
    { eventByProviderRowId, accountByProviderRowId, claimsPerPendingRef },
  );

  // v2.6-EVENT-2 — the event this row belongs to BEFORE this observation. When
  // an observation moves a row to a different event, the ORIGIN is left holding a
  // projection derived from a row it no longer owns, and nothing else ever
  // revisits it. That is one of the two production defects this slice repairs.
  const originEventId = persisted?.transactionEventId ?? null;

  // ── Create or attach ─────────────────────────────────────────────────────
  //
  // ⚠️ ALL FOUR WRITES ARE ONE UNIT. Previously they were four awaits in
  // sequence, and the Plaid sync wraps this whole call in a non-blocking
  // try/catch — so a failure after the observation insert left the observation
  // recorded, the row's FK possibly moved, and the projection never re-derived.
  // An event whose stored state disagrees with its own observations is exactly
  // what `audit-event-identity` fails on, and it is unreachable by any replay:
  // the observation key now exists, so the idempotent path returns early and the
  // drift is permanent. Atomicity is what makes the retry meaningful.
  const write = async (tx: Db): Promise<ObservationResult> => {
    const eventId = link.eventId ?? (await tx.transactionEvent.create({
      data: {
        financialAccountId: input.financialAccountId,
        // Provisional: re-derived from every observation immediately below, so a
        // freshly-created event is never left carrying a guess.
        lifecycle: input.lifecycle === "PENDING" ? "PENDING" : "POSTED",
        economicDate: input.economicDate,
        currentAmount: input.amount,
        currentTransactionId: input.transactionIsLive ? input.transactionId : null,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
      },
      select: { id: true },
    })).id;

    const observation = await tx.transactionObservation.create({
      data: {
        eventId,
        transactionId: input.transactionId,
        financialAccountId: input.financialAccountId,
        provider: input.provider,
        providerRowId: input.providerRowId,
        providerPendingRef: input.providerPendingRef,
        observedAt: input.observedAt,
        lifecycle: input.lifecycle,
        amount: input.amount,
        postingDate: input.postingDate,
        economicDate: input.economicDate,
        authorizedAt: input.authorizedAt,
        observationKey: key,
      },
      select: { id: true },
    });

    await tx.transaction.update({
      where: { id: input.transactionId },
      data: { transactionEventId: eventId },
    });

    await reprojectEvent(tx, eventId);

    // The origin loses a row here, so its liveness — and therefore possibly its
    // lifecycle, amount and currentTransactionId — changed too. Re-derive it in
    // the SAME unit, or the guarantee is only half kept.
    if (originEventId && originEventId !== eventId) {
      await reprojectEvent(tx, originEventId);
    }

    return { observationId: observation.id, eventId, basis: link.basis, refusal: link.refusal, created: true };
  };

  // A caller already inside an interactive transaction (the CSV importer) passes
  // its handle; Prisma forbids nesting, and joining the caller's unit is the
  // stronger guarantee anyway.
  return hasInteractiveTransaction(db) ? db.$transaction(write) : write(db);
}

/** True for a full PrismaClient — a TransactionClient cannot open a nested one. */
function hasInteractiveTransaction(db: Db): db is PrismaClient {
  return typeof (db as PrismaClient).$transaction === "function";
}

/**
 * Re-derive an event's current state from ALL of its observations.
 *
 * ⚠️ Never writes a projection field from the incoming observation alone. The
 * event's state is a function of its whole history — that is what makes it
 * re-derivable, and what keeps the economic date pinned to the FIRST observation
 * when a posting arrives later.
 *
 * ── B-6: the event's economic date is MATERIALIZED into its current row ─────
 *
 * `TransactionEvent.economicDate` is the authority for an event-linked row's
 * chronology (`projectEvent` derives it through `resolveEconomicDate`, the one
 * resolver — first resolution wins). But every product surface sorts, filters
 * and folds on `Transaction.economicDate`, the indexed column. So after every
 * reprojection the event's answer is written onto the event's CURRENT row
 * (no-op when already equal) — the row column stays what it has always been,
 * the sort key, and the event is what decides it. Row and event therefore
 * agree BY CONSTRUCTION; `audit-event-identity` fails if they ever do not, and
 * event-economic-date-rule.test.ts pins the whole rule.
 *
 * Rows OUTSIDE the event domain (self-custody crypto; any provider the
 * identity authority refuses) keep their write-time evidence-derived value —
 * there is no observation history to pin them to, and nothing here touches
 * them. Superseded (tombstoned) rows are also left alone: they are outside
 * every product population and their columns are provider provenance.
 */
export async function reprojectEvent(db: Db, eventId: string): Promise<void> {
  const observations = await db.transactionObservation.findMany({
    where: { eventId },
    select: { observedAt: true, lifecycle: true, amount: true, postingDate: true, economicDate: true, authorizedAt: true, transactionId: true },
    orderBy: { observedAt: "asc" },
  });
  if (observations.length === 0) return;

  // Which of the observed rows are still LIVE — a tombstoned row cannot be an
  // event's current projection, and that is how WITHDRAWN becomes reachable.
  const ids = [...new Set(observations.map((o) => o.transactionId).filter((x): x is string => x != null))];
  const live = new Set(
    (await db.transaction.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } }))
      .map((r) => r.id),
  );

  const facts: ObservationFacts[] = observations.map((o) => ({
    observedAt: o.observedAt,
    lifecycle: o.lifecycle as "PENDING" | "POSTED",
    amount: o.amount,
    postingDate: o.postingDate,
    economicDate: o.economicDate,
    authorizedAt: o.authorizedAt,
    liveTransactionId: o.transactionId && live.has(o.transactionId) ? o.transactionId : null,
  }));
  const p = projectEvent(facts);

  await db.transactionEvent.update({
    where: { id: eventId },
    data: {
      lifecycle: p.lifecycle,
      economicDate: p.economicDate,
      currentAmount: p.currentAmount,
      currentTransactionId: p.currentTransactionId,
      firstObservedAt: p.firstObservedAt,
      lastObservedAt: p.lastObservedAt,
      firstPendingObservedAt: p.firstPendingObservedAt,
      postedObservedAt: p.postedObservedAt,
      observationCount: p.observationCount,
    },
  });

  // The event's answer, onto the row every surface actually reads. Guarded so
  // an agreeing row costs no write; never touches a row the event does not
  // currently project.
  if (p.currentTransactionId) {
    await db.transaction.updateMany({
      where: { id: p.currentTransactionId, NOT: { economicDate: p.economicDate } },
      data: { economicDate: p.economicDate },
    });
  }
}

/**
 * B-6 — re-align an event's current row with the event's already-stored
 * projection, WITHOUT re-deriving it. Used on the idempotent replay path,
 * where the observations are unchanged (so the projection is too) but the
 * ingest writer has just re-stamped the row from row evidence.
 */
async function pinRowToEvent(db: Db, eventId: string): Promise<void> {
  const ev = await db.transactionEvent.findUnique({
    where: { id: eventId },
    select: { economicDate: true, currentTransactionId: true },
  });
  if (!ev?.currentTransactionId) return;
  await db.transaction.updateMany({
    where: { id: ev.currentTransactionId, NOT: { economicDate: ev.economicDate } },
    data: { economicDate: ev.economicDate },
  });
}
