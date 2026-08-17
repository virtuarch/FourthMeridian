/**
 * lib/transactions/event-write-atomicity.test.ts
 *
 * v2.6-EVENT-2 — BEHAVIOURAL proof of the two projection-integrity guarantees
 * (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/transactions/event-write-atomicity.test.ts
 *
 *   A. REASSIGNMENT REPROJECTS BOTH SIDES. When an observation moves a row from
 *      one event to another, the ORIGIN is re-derived too. Before this slice only
 *      the destination was, so the origin kept a projection describing a row it
 *      no longer owned — the production state `audit-event-identity` failed on.
 *
 *   B. THE WRITE IS ONE UNIT. Observation insert + FK update + both reprojections
 *      happen inside one interactive transaction. A failure at any point rolls the
 *      whole thing back rather than leaving an observation recorded against a
 *      projection that was never re-derived.
 *
 * ⚠️ Why atomicity is not merely tidy here. `observationKey` is unique and checked
 * FIRST, so a partial write is PERMANENT: the next replay finds the key, takes the
 * idempotent early return, and never repairs the projection. The Plaid sync also
 * swallows failures from this path by design (event identity is additive and must
 * not cost the transaction write). Together those two correct decisions turn any
 * mid-write failure into silent, unrecoverable drift. The transaction is what
 * makes the retry mean something.
 *
 * ⚠️ Tests A2 and B are the ones that must fail if the fix is reverted.
 */

import { recordTransactionObservation } from "./event-write";
import { observationKey } from "./event-identity";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── An in-memory Prisma stand-in with a real rollback ────────────────────────

interface Row { id: string; plaidTransactionId: string | null; deletedAt: Date | null; transactionEventId: string | null }
interface Obs {
  id: string; eventId: string; transactionId: string | null; financialAccountId: string; providerRowId: string | null;
  providerPendingRef: string | null; observedAt: Date; lifecycle: string; amount: number;
  postingDate: Date; economicDate: Date; observationKey: string;
}
interface Evt {
  id: string; lifecycle: string; economicDate: Date; currentAmount: number;
  currentTransactionId: string | null; observationCount: number;
  firstObservedAt: Date; lastObservedAt: Date;
  firstPendingObservedAt: Date | null; postedObservedAt: Date | null;
}

interface State { txns: Row[]; obs: Obs[]; events: Evt[] }

const clone = (s: State): State => ({
  txns: s.txns.map((r) => ({ ...r })),
  obs: s.obs.map((o) => ({ ...o })),
  events: s.events.map((e) => ({ ...e })),
});

/** @param failOn throw when this many event-projection updates have been attempted. */
function makeDb(initial: State, failOn?: number) {
  let s = clone(initial);
  let seq = 0, projectionUpdates = 0;

  const client = {
    _state: () => s,
    transaction: {
      findUnique: async ({ where }: { where: { id?: string; plaidTransactionId?: string } }) => {
        const r = where.id ? s.txns.find((t) => t.id === where.id)
                           : s.txns.find((t) => t.plaidTransactionId === where.plaidTransactionId);
        return r ? { ...r } : null;
      },
      findMany: async ({ where }: { where: { id?: { in: string[] }; deletedAt?: null } }) =>
        s.txns.filter((t) => (!where.id || where.id.in.includes(t.id)) &&
                             (where.deletedAt !== null || t.deletedAt === null)).map((t) => ({ ...t })),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = s.txns.find((t) => t.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      },
    },
    transactionObservation: {
      findUnique: async ({ where }: { where: { observationKey: string } }) => {
        const o = s.obs.find((x) => x.observationKey === where.observationKey);
        return o ? { id: o.id, eventId: o.eventId } : null;
      },
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const w = where ?? {};
        const rowIn = (w.providerRowId as { in?: string[] } | undefined)?.in;
        return s.obs.filter((o) => {
          if (w.eventId && o.eventId !== w.eventId) return false;
          if (rowIn && !rowIn.includes(o.providerRowId ?? "")) return false;
          return true;
        }).map((o) => ({ ...o }));
      },
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const o = { id: `o${++seq}`, ...data } as unknown as Obs;
        s.obs.push(o);
        return { id: o.id };
      },
    },
    transactionEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const e = { id: `e${++seq}`, observationCount: 0, firstPendingObservedAt: null,
                    postedObservedAt: null, ...data } as unknown as Evt;
        s.events.push(e);
        return { id: e.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        projectionUpdates++;
        if (failOn !== undefined && projectionUpdates === failOn) {
          throw new Error(`injected failure on projection update #${failOn}`);
        }
        const e = s.events.find((x) => x.id === where.id);
        if (e) Object.assign(e, data);
        return e;
      },
    },
    /** A real rollback: the callback mutates a SNAPSHOT, promoted only on success. */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const before = clone(s);
      const scratch = clone(s);
      s = scratch;
      try {
        const out = await fn(client);
        return out;
      } catch (e) {
        s = before;          // ← rollback
        throw e;
      }
    },
  };
  return client;
}

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const baseObs = (over: Partial<Obs> & { eventId: string; transactionId: string; observationKey: string }): Obs => ({
  id: `seed_${over.observationKey}`, financialAccountId: "fa1", providerRowId: null, providerPendingRef: null,
  observedAt: D("2026-08-05"), lifecycle: "PENDING", amount: -12.05,
  postingDate: D("2026-08-05"), economicDate: D("2026-08-05"), ...over,
});

const baseEvt = (over: Partial<Evt> & { id: string }): Evt => ({
  lifecycle: "PENDING", economicDate: D("2026-08-05"), currentAmount: -12.05,
  currentTransactionId: null, observationCount: 1,
  firstObservedAt: D("2026-08-05"), lastObservedAt: D("2026-08-05"),
  firstPendingObservedAt: D("2026-08-05"), postedObservedAt: null, ...over,
});

async function main(): Promise<void> {

// ── A. Reassignment reprojects BOTH events ──────────────────────────────────
console.log("A. Moving a row between events re-derives BOTH");
{
  // The production shape (events cmsiz3j48 / cmsiz3ja1). Row t1's FK points at
  // eOrigin, but eOrigin's OWN observation is of tOld, which is tombstoned — so
  // eOrigin's stored projection (PENDING, owning tOld) is already stale. A new
  // observation carrying a provider pending ref moves t1 to eDest.
  //
  // ⚠️ Note what origin reprojection does and does NOT fix. eOrigin's observations
  // are unchanged by the move, so re-deriving cannot "release" a row it still
  // observes — that disagreement is INV-2, and the MATCHER is what prevents it.
  // What re-derivation fixes is an origin whose stored state no longer follows
  // from its own observations, which is unreachable by any other code path.
  const initial: State = {
    txns: [
      { id: "t1",   plaidTransactionId: "post_A", deletedAt: null,       transactionEventId: "eOrigin" },
      { id: "tOld", plaidTransactionId: "pend_A", deletedAt: new Date(), transactionEventId: "eOrigin" },
      { id: "tp",   plaidTransactionId: "pend_B", deletedAt: new Date(), transactionEventId: "eDest" },
    ],
    obs: [
      baseObs({ eventId: "eOrigin", transactionId: "tOld", observationKey: "k_origin", providerRowId: "pend_A" }),
      baseObs({ eventId: "eDest",   transactionId: "tp",   observationKey: "k_dest",   providerRowId: "pend_B" }),
    ],
    events: [
      // Stale on purpose: claims a live row and PENDING, while its only
      // observation is of a tombstoned row.
      baseEvt({ id: "eOrigin", currentTransactionId: "t1" }),
      baseEvt({ id: "eDest", currentTransactionId: null }),
    ],
  };
  const db = makeDb(initial);

  await recordTransactionObservation(db as never, {
    transactionId: "t1", financialAccountId: "fa1", provider: "PLAID",
    providerRowId: "post_B", providerPendingRef: "pend_B",
    lifecycle: "POSTED", amount: -12.05,
    postingDate: D("2026-08-09"), economicDate: D("2026-08-09"),
    authorizedAt: null, transactionIsLive: true, observedAt: D("2026-08-09"),
  });

  const s = db._state();
  const origin = s.events.find((e) => e.id === "eOrigin")!;
  const dest   = s.events.find((e) => e.id === "eDest")!;

  check("the row moved to the destination event",
    s.txns.find((t) => t.id === "t1")?.transactionEventId === "eDest",
    `${s.txns.find((t) => t.id === "t1")?.transactionEventId}`);
  check("A1 destination reprojected — POSTED, owns the live row",
    dest.lifecycle === "POSTED" && dest.currentTransactionId === "t1",
    `${dest.lifecycle}/${dest.currentTransactionId}`);
  // Pre-fix these stayed PENDING / "t1": only the destination was ever
  // re-derived, so the origin kept a projection that followed from nothing.
  check("A2 ORIGIN reprojected — no longer claims the row it lost",
    origin.currentTransactionId !== "t1",
    `origin still claims ${origin.currentTransactionId}`);
  check("A2 origin lifecycle re-derived from its own observations (all PENDING, no live row ⇒ WITHDRAWN)",
    origin.lifecycle === "WITHDRAWN", `${origin.lifecycle}`);
}

// ── B. A failure mid-write leaves NOTHING behind ────────────────────────────
console.log("\nB. A failure during the write rolls back the whole unit");
{
  const initial: State = {
    txns: [
      { id: "t1", plaidTransactionId: "post_A", deletedAt: null, transactionEventId: "eOrigin" },
      { id: "tp", plaidTransactionId: "pend_B", deletedAt: new Date(), transactionEventId: "eDest" },
    ],
    obs: [
      baseObs({ eventId: "eOrigin", transactionId: "t1", observationKey: "k_origin", providerRowId: "post_A" }),
      baseObs({ eventId: "eDest", transactionId: "tp", observationKey: "k_dest", providerRowId: "pend_B" }),
    ],
    events: [
      baseEvt({ id: "eOrigin", currentTransactionId: "t1" }),
      baseEvt({ id: "eDest", currentTransactionId: null }),
    ],
  };
  // Fail on the SECOND projection update — i.e. after the observation is
  // inserted, after the FK moves, after the destination is re-derived, and
  // exactly when the origin's re-derivation is attempted. The worst moment.
  const db = makeDb(initial, 2);

  let threw = false;
  try {
    await recordTransactionObservation(db as never, {
      transactionId: "t1", financialAccountId: "fa1", provider: "PLAID",
      providerRowId: "post_B", providerPendingRef: "pend_B",
      lifecycle: "POSTED", amount: -12.05,
      postingDate: D("2026-08-09"), economicDate: D("2026-08-09"),
      authorizedAt: null, transactionIsLive: true, observedAt: D("2026-08-09"),
    });
  } catch { threw = true; }

  const s = db._state();
  check("the failure surfaced to the caller", threw);
  check("B1 no observation was left behind", s.obs.length === 2, `${s.obs.length} observations`);
  check("B2 the row's event assignment is unchanged",
    s.txns.find((t) => t.id === "t1")?.transactionEventId === "eOrigin",
    `${s.txns.find((t) => t.id === "t1")?.transactionEventId}`);
  check("B3 the destination projection did not survive the rollback",
    s.events.find((e) => e.id === "eDest")?.lifecycle === "PENDING",
    `${s.events.find((e) => e.id === "eDest")?.lifecycle}`);
  check("B4 the origin projection is untouched",
    s.events.find((e) => e.id === "eOrigin")?.currentTransactionId === "t1",
    `${s.events.find((e) => e.id === "eOrigin")?.currentTransactionId}`);
}

// ── C. Idempotence is unchanged ─────────────────────────────────────────────
console.log("\nC. Replaying an identical payload still writes nothing");
{
  // The seeded observation carries the REAL key the writer would compute, so the
  // idempotence check is exercised rather than sidestepped by a synthetic key.
  const replay = {
    transactionId: "t1", financialAccountId: "fa1", provider: "PLAID" as const,
    providerRowId: "post_A", providerPendingRef: null,
    lifecycle: "PENDING" as const, amount: -12.05,
    postingDate: D("2026-08-05"), economicDate: D("2026-08-05"),
    authorizedAt: null, transactionIsLive: true, observedAt: D("2026-08-05"),
  };
  const realKey = observationKey({
    provider: replay.provider, financialAccountId: replay.financialAccountId,
    providerRowId: replay.providerRowId, transactionId: replay.transactionId,
    lifecycle: replay.lifecycle, amount: replay.amount,
    postingDate: replay.postingDate, economicDate: replay.economicDate,
  });
  const initial: State = {
    txns: [{ id: "t1", plaidTransactionId: "post_A", deletedAt: null, transactionEventId: "eOrigin" }],
    obs: [baseObs({ eventId: "eOrigin", transactionId: "t1", observationKey: realKey, providerRowId: "post_A" })],
    events: [baseEvt({ id: "eOrigin", currentTransactionId: "t1" })],
  };
  const db = makeDb(initial);
  const before = JSON.stringify(db._state());
  await recordTransactionObservation(db as never, replay);
  check("C1 state is byte-identical after a replay",
    JSON.stringify(db._state()) === before,
    `${db._state().obs.length} observations`);
}

console.log(failures === 0 ? "\nAll event-write atomicity checks passed.\n" : `\n${failures} check(s) failed\n`);
if (failures > 0) process.exit(1);
}

main();
