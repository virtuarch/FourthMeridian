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
    select: { id: true, eventId: true, linkBasis: true, linkRefusal: true },
  });
  if (existing) {
    // W1 (D6) — REPLAY HEALING. A pending ref that was DANGLING at first
    // observation (predecessor not yet in the corpus — e.g. a historical sync
    // that delivered the settlement before the authorisation) produced an
    // honest but SPLIT identity: a fresh event recording the refusal. Before
    // this path existed the split was permanent — the observation key exists,
    // so the idempotent early-return meant no future replay ever re-ran rung 1.
    // Now a replay re-resolves the link, and when — and only when — the
    // provider's own claim resolves CLEANLY (rank-1 PROVIDER_PENDING_REF, no
    // ambiguity, no cross-account veto) to a DIFFERENT event, the observation
    // moves onto it. Rung-1-outranks-persisted-link is the existing merge
    // doctrine; this applies it on replay. Nothing else heals: still-dangling
    // and ambiguous claims stay refused, and no event-split machinery exists.
    if (input.providerPendingRef) {
      const healed = await maybeHealDanglingLink(db, input, existing);
      if (healed) return healed;
    }
    // B-6 — RE-PIN even on the idempotent path. The ingest writer stamps the
    // row's economicDate from ROW evidence just before calling here; when the
    // event's pinned date differs (a pending→posted chain whose pin is earlier
    // than the row's own evidence supports), a replayed payload would leave the
    // row on the wrong date FOREVER — the observation key exists, so no future
    // write ever corrects it. One guarded no-op-when-equal write closes that.
    await pinRowToEvent(db, existing.eventId);
    return {
      observationId: existing.id,
      eventId: existing.eventId,
      // W1 (D6) — return the STORED basis/refusal where the ledger has them.
      // The pre-ledger hard-coded "PERSISTED_LINK" was a fabrication on this
      // path; it remains only as the fallback for rows written before the
      // ledger existed (linkBasis null), where the true basis is unrecoverable.
      basis: (existing.linkBasis as EventLinkBasis | null) ?? "PERSISTED_LINK",
      refusal: (existing.linkRefusal as EventLinkRefusal | null) ?? null,
      created: false,
    };
  }

  // ── Evidence for the identity decision ───────────────────────────────────
  const evidence = await gatherLinkEvidence(db, input);

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
    evidence,
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
        // W1 (D6) — the evidence ledger: persist the basis/refusal the authority
        // just decided, instead of computing and dropping them. Recorded at
        // write time, never inferred later; no confidence scalar.
        linkBasis: link.basis,
        linkRefusal: link.refusal,
      },
      select: { id: true },
    });

    // W1 (D6) — when this observation MOVES the row to a different event
    // (rung-1 outranking a persisted link), the origin may still hold this row
    // as its currentTransactionId. That column is UNIQUE, so reprojecting the
    // destination first would collide with the origin's stale claim and abort
    // the whole unit on a real database (the fakes carry no constraints, which
    // is why this never surfaced in the harness). Release the stale claim
    // before any reprojection; the origin's own reprojection below re-derives
    // its true current row from what remains.
    if (originEventId && originEventId !== eventId) {
      await tx.transactionEvent.updateMany({
        where: { id: originEventId, currentTransactionId: input.transactionId },
        data:  { currentTransactionId: null },
      });
    }

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
 * W1 (D6) — the corpus evidence `resolveEventLink` needs, gathered ONE way.
 *
 * Extracted from the main write path so the replay-heal path re-derives the
 * link from the SAME evidence shape — two gatherers would be two chances for
 * the write path and the heal path to disagree about what the corpus says.
 */
async function gatherLinkEvidence(
  db: Db,
  input: Pick<ObservationInput, "providerRowId" | "providerPendingRef" | "transactionId">,
): Promise<{
  eventByProviderRowId: Map<string, string>;
  accountByProviderRowId: Map<string, string>;
  claimsPerPendingRef: Map<string, number>;
}> {
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
  return { eventByProviderRowId, accountByProviderRowId, claimsPerPendingRef };
}

/**
 * W1 (D6) — REPLAY HEALING of a dangling-ref split. Idempotent-path only.
 *
 * When an observation carrying a `providerPendingRef` was first recorded while
 * its predecessor was absent from the corpus, the authority refused the link
 * (DANGLING_PENDING_REF) and the observation landed on its own event — honest,
 * but split. If the predecessor has SINCE been observed, replaying the same
 * provider payload re-runs rung 1 here and moves the observation onto the
 * predecessor's event.
 *
 * Heals if and only if the fresh resolution is a CLEAN rank-1
 * PROVIDER_PENDING_REF link to a DIFFERENT event — the same precedence the
 * live write path applies (rung 1 outranks a persisted link). Still-dangling,
 * ambiguous (two claimants) and cross-account claims heal nothing; there is
 * deliberately NO event-split machinery. The gate is the RESOLUTION, not the
 * stored refusal, so observations written before the evidence ledger existed
 * (linkRefusal null — the 62 production dangling refs) heal on replay too.
 *
 * The observation's PROVIDER FACTS are never touched: `eventId`, `linkBasis`
 * and `linkRefusal` are OUR derivation columns, and correcting a derivation on
 * new evidence is exactly what makes the ledger honest. All writes are one
 * atomic unit. An origin event left with zero observations is deleted (nothing
 * observed it; keeping it would be a projection of nothing) — observations
 * cascade only from that empty state, and row FKs SetNull by schema.
 */
async function maybeHealDanglingLink(
  db: Db,
  input: ObservationInput,
  existing: { id: string; eventId: string },
): Promise<ObservationResult | null> {
  const evidence = await gatherLinkEvidence(db, input);
  const link = resolveEventLink(
    {
      transactionId: input.transactionId,
      financialAccountId: input.financialAccountId,
      providerRowId: input.providerRowId,
      providerPendingRef: input.providerPendingRef,
      persistedEventId: existing.eventId,
    },
    evidence,
  );
  if (link.basis !== "PROVIDER_PENDING_REF" || link.eventId === existing.eventId) return null;
  const targetEventId = link.eventId;
  const originEventId = existing.eventId;

  const heal = async (tx: Db): Promise<ObservationResult> => {
    // Release the origin's (unique) current-row claim before the destination
    // reprojection can assert it — same constraint-ordering rule as the live
    // write path.
    await tx.transactionEvent.updateMany({
      where: { id: originEventId, currentTransactionId: input.transactionId },
      data:  { currentTransactionId: null },
    });
    await tx.transactionObservation.update({
      where: { id: existing.id },
      data:  { eventId: targetEventId, linkBasis: "PROVIDER_PENDING_REF", linkRefusal: null },
    });
    await tx.transaction.update({
      where: { id: input.transactionId },
      data:  { transactionEventId: targetEventId },
    });
    await reprojectEvent(tx, targetEventId);
    const remaining = await tx.transactionObservation.count({ where: { eventId: originEventId } });
    if (remaining === 0) {
      await tx.transactionEvent.delete({ where: { id: originEventId } });
    } else {
      await reprojectEvent(tx, originEventId);
    }
    return {
      observationId: existing.id,
      eventId: targetEventId,
      basis: "PROVIDER_PENDING_REF",
      refusal: null,
      created: false,
    };
  };
  return hasInteractiveTransaction(db) ? db.$transaction(heal) : heal(db);
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
