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
 *
 * ── EVENT-WRITE-1: THE UNIQUE CURRENT-ROW CLAIM IS NEVER CONTESTED ─────────
 *
 * `TransactionEvent.currentTransactionId` is UNIQUE, so two events cannot both
 * hold one row — and a statement that asserts it anyway does not merely say
 * something false, it ABORTS THE UNIT. That is how two live rows came to carry
 * an `economicDate` disagreeing with their own event's pin: the ingest writer's
 * row re-stamp is a committed statement of its own, this unit rolled back, and
 * the observation key was never written for a replay to find. Two rules now
 * make the contest unreachable:
 *
 *   · a freshly created event claims NO row — `reprojectEvent` derives
 *     `currentTransactionId`, after the stale claim has been released;
 *   · `reprojectEvent` treats a row as this event's live projection only while
 *     the ROW's own `transactionEventId` still says so, so an event that lost a
 *     row re-derives to "I have none" instead of re-claiming it.
 *
 * And because a guarantee that is only hoped for is how this one was lost, the
 * write ASSERTS its terminal state before committing, and a rolled-back unit
 * raises `EventWriteIntegrityFailure` — which says in its own shape that
 * canonical event state is missing — instead of a bare database error a caller
 * cannot tell from a benign skip. Pinned by
 * lib/transactions/event-write-claim-ordering.test.ts.
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
  type EventLinkBasis, type EventLinkRefusal, type EventProjection, type ObservationFacts,
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

// ── EVENT-WRITE-1: FAILURE SEMANTICS ────────────────────────────────────────
//
// An integrity failure inside this unit is NOT the same kind of event as "event
// identity was skipped". The unit is atomic, so the whole observation —
// including the event's own projection — was NOT PERSISTED, and the ingest
// writer that called us has ALREADY committed its own row update as a separate
// statement. That pairing is exactly how the two measured corrupt rows came to
// exist: a row re-stamped from its own evidence, an event still carrying the
// other answer, no second observation to explain the gap, and the only trace a
// `console.warn` indistinguishable from a benign skip.
//
// So the failure is given a TYPE and a vocabulary. A caller can still choose to
// continue — event identity is deliberately non-blocking at the Plaid sync, and
// that remains correct — but it can no longer fail to *notice*: the error says
// in its own shape that canonical event state is missing, and carries the
// observation key, so the payload is replayable and an operator has something
// to act on.
//
// ⚠️ The `console.error` below is the FLOOR, not the durable record. The durable
// record belongs in the existing incident model (`recordSyncIssue`, kind
// `TRANSACTION_PERSISTENCE_FAILED` / `UPSERT_ERROR`), which lives in
// `lib/plaid/syncIssues.ts` — a module this slice deliberately does not own.
// The integration point is one catch block: `syncTransactions.ts`'s
// `recordObservation` should branch on `isEventWriteIntegrityFailure(e)` and
// record `e.detail` instead of warning. Reported, not reached around.

/** The Prisma error codes that mean the statement was REFUSED by the database's
 *  own integrity rules — as opposed to a transport or logic error. P2002 is the
 *  one the TALABAT shape produced (unique `TransactionEvent.currentTransactionId`);
 *  P2003 (foreign key) and P2025 (a required related record vanished) mean the
 *  same thing about persistence and deserve the same vocabulary. */
const DB_INTEGRITY_CODES: ReadonlySet<string> = new Set(["P2002", "P2003", "P2025"]);

/** Everything an operator (or a SyncIssue row) needs, and nothing a log must not
 *  carry: no amounts, no merchant strings, no tokens. */
export interface EventWriteIntegrityDetail {
  stage: "OBSERVATION_WRITE" | "REPLAY_HEAL" | "TERMINAL_STATE_CHECK";
  transactionId: string;
  financialAccountId: string;
  provider: ProviderType;
  providerRowId: string | null;
  providerPendingRef: string | null;
  /** The event the row belonged to when this unit began, if any. */
  originEventId: string | null;
  /** The event the authority resolved to, when it resolved to an existing one. */
  targetEventId: string | null;
  basis: EventLinkBasis | null;
  refusal: EventLinkRefusal | null;
  /** The key of the observation that was NOT written. Replaying the provider
   *  payload recomputes it, so this names the retry. */
  observationKey: string;
  /** Prisma's code, where the failure came from the database. */
  code: string | null;
  /** The constraint the database named, where it named one. */
  constraint: string[] | null;
  message: string;
}

/**
 * CANONICAL EVENT STATE WAS NOT PERSISTED.
 *
 * Thrown in place of the raw database error whenever the observation unit rolls
 * back. `canonicalStatePersisted` is `false` as a literal type so a caller
 * cannot read this as a partial success.
 */
export class EventWriteIntegrityFailure extends Error {
  readonly canonicalStatePersisted = false as const;
  readonly detail: EventWriteIntegrityDetail;
  constructor(detail: EventWriteIntegrityDetail, options?: { cause?: unknown }) {
    super(
      `event identity NOT PERSISTED for transaction ${detail.transactionId} ` +
      `(stage ${detail.stage}${detail.code ? `, ${detail.code}` : ""}` +
      `${detail.constraint?.length ? ` on ${detail.constraint.join("+")}` : ""}): ${detail.message}`,
      options,
    );
    this.name = "EventWriteIntegrityFailure";
    this.detail = detail;
  }
}

export function isEventWriteIntegrityFailure(e: unknown): e is EventWriteIntegrityFailure {
  return e instanceof EventWriteIntegrityFailure;
}

/**
 * Wrap a rolled-back observation unit in the typed failure, and emit the ONE
 * floor-level record that does not depend on the caller.
 *
 * ⚠️ Deliberately re-wraps EVERY failure of the unit, not only the Prisma
 * integrity codes. The code is reported where there is one, but the fact the
 * caller must act on — nothing of this event was persisted while the row write
 * already committed — is the same whichever statement aborted.
 */
function asIntegrityFailure(e: unknown, base: Omit<EventWriteIntegrityDetail, "code" | "constraint" | "message">): EventWriteIntegrityFailure {
  if (isEventWriteIntegrityFailure(e)) return e;
  const p = e as { code?: unknown; meta?: { target?: unknown } } | null;
  const code = typeof p?.code === "string" && DB_INTEGRITY_CODES.has(p.code) ? p.code
    : typeof p?.code === "string" ? p.code : null;
  const target = p?.meta?.target;
  const constraint = Array.isArray(target) ? target.filter((t): t is string => typeof t === "string")
    : typeof target === "string" ? [target] : null;
  const failure = new EventWriteIntegrityFailure(
    { ...base, code, constraint, message: e instanceof Error ? e.message.split("\n")[0] : String(e) },
    { cause: e },
  );
  // Error level, a stable marker, and an explicit statement of what is missing.
  // A caller is free to swallow the throw; it is not free to make this line
  // read like a benign skip.
  console.error(
    `[l8] CANONICAL EVENT STATE NOT PERSISTED — ${JSON.stringify(failure.detail)}`,
  );
  return failure;
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
        // EVENT-WRITE-1 — A FRESH EVENT CLAIMS NO ROW IN ITS OWN CREATE.
        //
        // `currentTransactionId` is UNIQUE. This literal is the FIRST statement
        // of the unit, and the release-the-stale-claim block that exists for
        // exactly this collision is forty lines BELOW it — so when the incoming
        // observation opens a NEW event for a row some OTHER event still holds,
        // the create aborts on P2002 (`TransactionEvent_currentTransactionId_key`)
        // before anything can free the old claim, and the whole unit rolls back.
        //
        // That is not hypothetical. The measured TALABAT shape reaches it on the
        // ordinary ingest path: two settlements of the same amount, descriptor,
        // account and posting date, each naming a DIFFERENT pending predecessor,
        // and NEITHER predecessor present in the corpus. The sync's DF-4
        // fingerprint adopts the first settlement's row (its refusal guard needs
        // a resolvable predecessor and has none), re-stamps `economicDate` from
        // the second settlement's own evidence in a statement of its own — and
        // then this create collides, so the event is never re-pinned. Terminal
        // state: a row whose economic date disagrees with its own event, one
        // observation where there should be two, and nothing to repair it,
        // because the observation key was never written for a replay to find.
        // Reproduced against a real Postgres; two live rows are in that state.
        //
        // So the create asserts NOTHING about the current row. `reprojectEvent`
        // derives `currentTransactionId` from the observations a few lines
        // below — it already does, unconditionally — and by then the stale claim
        // has been released. The unit now contains no statement that can claim a
        // contested unique column before the contest is resolved.
        currentTransactionId: null,
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

    const projection = await reprojectEvent(tx, eventId);

    // The origin loses a row here, so its liveness — and therefore possibly its
    // lifecycle, amount and currentTransactionId — changed too. Re-derive it in
    // the SAME unit, or the guarantee is only half kept.
    if (originEventId && originEventId !== eventId) {
      await reprojectEvent(tx, originEventId);
    }

    // EVENT-WRITE-1 — NO HALF-TRANSITIONED TERMINAL STATE, CHECKED NOT HOPED.
    //
    // Runs LAST, after both re-derivations, so it reads the state the commit
    // will actually leave. Where this event projects to this row, the row must
    // point back at the event and carry the event's pinned economic date — the
    // B-6 invariant `audit-event-identity` fails on, asserted at the moment the
    // write can still be REFUSED rather than discovered weeks later by an audit.
    // `reprojectEvent` writes that pin unconditionally, so a failure here means
    // some later statement moved it, and a rollback is strictly better than
    // committing the disagreement.
    //
    // ⚠️ Deliberately a `findUnique` and not a `count` with the expected values
    // in its predicate. Every in-memory harness in this repository already
    // serves `transaction.findUnique` and returns the whole row, so this check
    // RUNS in the fakes; a `count` predicate was tried first and threw
    // `tx.transaction.count is not a function` in three of them — an assertion
    // that cannot execute in the harness is exactly the shape of thing that let
    // the unique-column collision go unnoticed for six weeks.
    if (projection && projection.currentTransactionId === input.transactionId) {
      const committed = await tx.transaction.findUnique({
        where: { id: input.transactionId },
        select: { transactionEventId: true, economicDate: true },
      });
      const agrees =
        committed?.transactionEventId === eventId &&
        committed?.economicDate instanceof Date &&
        committed.economicDate.getTime() === projection.economicDate.getTime();
      if (!agrees) {
        throw new EventWriteIntegrityFailure({
          stage: "TERMINAL_STATE_CHECK",
          transactionId: input.transactionId,
          financialAccountId: input.financialAccountId,
          provider: input.provider,
          providerRowId: input.providerRowId,
          providerPendingRef: input.providerPendingRef,
          originEventId,
          targetEventId: eventId,
          basis: link.basis,
          refusal: link.refusal,
          observationKey: key,
          code: null,
          constraint: null,
          message:
            `the event projects transaction ${input.transactionId} but the row does not ` +
            `agree with it (expected transactionEventId=${eventId}, economicDate=` +
            `${projection.economicDate.toISOString().slice(0, 10)}); refusing to commit a row ` +
            `whose economic date disagrees with its own event's pin`,
        });
      }
    }

    return { observationId: observation.id, eventId, basis: link.basis, refusal: link.refusal, created: true };
  };

  // A caller already inside an interactive transaction (the CSV importer) passes
  // its handle; Prisma forbids nesting, and joining the caller's unit is the
  // stronger guarantee anyway.
  //
  // EVENT-WRITE-1 — a rolled-back unit means CANONICAL EVENT STATE WAS NOT
  // PERSISTED while the ingest writer's own row statement already committed.
  // The caller may still decide to continue; it may not be left guessing from a
  // bare Prisma error what, if anything, survived.
  try {
    return await (hasInteractiveTransaction(db) ? db.$transaction(write) : write(db));
  } catch (e) {
    throw asIntegrityFailure(e, {
      stage: "OBSERVATION_WRITE",
      transactionId: input.transactionId,
      financialAccountId: input.financialAccountId,
      provider: input.provider,
      providerRowId: input.providerRowId,
      providerPendingRef: input.providerPendingRef,
      originEventId,
      targetEventId: link.eventId,
      basis: link.basis,
      refusal: link.refusal,
      observationKey: key,
    });
  }
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
  // EVENT-WRITE-1 — the heal moves a row between events, so it can meet the same
  // unique-column contest as the write path and deserves the same vocabulary.
  // A heal that rolls back leaves the SPLIT in place, which is honest but is a
  // state an operator should hear about, not a silent no-op.
  try {
    return await (hasInteractiveTransaction(db) ? db.$transaction(heal) : heal(db));
  } catch (e) {
    throw asIntegrityFailure(e, {
      stage: "REPLAY_HEAL",
      transactionId: input.transactionId,
      financialAccountId: input.financialAccountId,
      provider: input.provider,
      providerRowId: input.providerRowId,
      providerPendingRef: input.providerPendingRef,
      originEventId,
      targetEventId,
      basis: "PROVIDER_PENDING_REF",
      refusal: null,
      observationKey: observationKey({
        provider: input.provider,
        financialAccountId: input.financialAccountId,
        providerRowId: input.providerRowId,
        transactionId: input.transactionId,
        lifecycle: input.lifecycle as "PENDING" | "POSTED",
        amount: input.amount,
        postingDate: input.postingDate,
        economicDate: input.economicDate,
      }),
    });
  }
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
export async function reprojectEvent(db: Db, eventId: string): Promise<EventProjection | null> {
  const observations = await db.transactionObservation.findMany({
    where: { eventId },
    select: { observedAt: true, lifecycle: true, amount: true, postingDate: true, economicDate: true, authorizedAt: true, transactionId: true },
    orderBy: { observedAt: "asc" },
  });
  if (observations.length === 0) return null;

  // Which of the observed rows are still LIVE — a tombstoned row cannot be an
  // event's current projection, and that is how WITHDRAWN becomes reachable.
  //
  // EVENT-WRITE-1 — AND STILL THIS EVENT'S. `Transaction.transactionEventId` is
  // the canonical statement of which event a row belongs to, and
  // `TransactionEvent.currentTransactionId` is UNIQUE — so an event that
  // re-asserts a row whose FK has moved away is not merely saying something
  // false, it is making a claim the database cannot grant, and the abort costs
  // the whole unit.
  //
  // ⚠️ This is the half the investigation's preferred repair did not cover, and
  // it was MEASURED: with only the create-ordering fix in place, the TALABAT
  // collision simply moved from the create to this function's own update. Both
  // settlements observe the SAME adopted row, so after the row moves to the new
  // event the ORIGIN's re-derivation re-claims it and fails on exactly the same
  // constraint, at exactly the same cost. `deletedAt: null` alone cannot see
  // that; the row's own FK can. The origin now honestly re-derives to "I have no
  // live row" — which is what losing a row to another event means.
  //
  // Nothing legitimate is lost: every caller sets the row's FK before
  // reprojecting (this module's write and replay-heal paths, the seed's
  // pending→posted succession, the Plaid sync's removed[] tombstone branch), so
  // a row an event genuinely owns always passes. What stops passing is exactly
  // a row the event lost.
  const ids = [...new Set(observations.map((o) => o.transactionId).filter((x): x is string => x != null))];
  const live = new Set(
    (await db.transaction.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, transactionEventId: true },
    }))
      .filter((r) => r.transactionEventId === eventId)
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

  // EVENT-WRITE-1 — returned so the write path can assert the TERMINAL state it
  // is about to commit without re-reading the event it just derived.
  return p;
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
