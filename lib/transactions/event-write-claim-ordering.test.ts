/**
 * lib/transactions/event-write-claim-ordering.test.ts
 *
 * EVENT-WRITE-1 — BEHAVIOURAL proof that the observation write CANNOT LEAVE A
 * ROW DISAGREEING WITH ITS OWN EVENT'S ECONOMIC-DATE PIN (house pattern:
 * standalone tsx, DB-free):
 *
 *   npx tsx lib/transactions/event-write-claim-ordering.test.ts
 *
 * ── The corruption this reproduces ─────────────────────────────────────────
 *
 * Two live production rows carried an `economicDate` that disagreed with their
 * own `TransactionEvent.economicDate`, with ONE observation where there should
 * have been two. The second was written 2026-10-01 — six weeks after the
 * v2.6-EVENT-2 guard and the W1/D6 generalisation — so it is not residue.
 *
 *   id                         event pin   row econ   posting     authorizedAt
 *   cmu2z2a5c00y4ku3vbcmufjx4  2026-09-10  2026-09-09 2026-09-13  2026-09-09
 *   cmupscz6s006y8hhavzqtiw8h  2026-09-25  2026-09-24 2026-09-27  2026-09-24
 *
 * The mechanism, reproduced END TO END against a real Postgres before this file
 * was written (P2002, `meta.target = ["currentTransactionId"]`, raised at
 * `event-write.ts`'s `transactionEvent.create`):
 *
 *   1. Settlement A arrives. Its `pending_transaction_id` names a predecessor
 *      that is NOT in the corpus, so the identity authority answers NEW_EVENT /
 *      DANGLING_PENDING_REF. A row is created; an event is created holding it as
 *      `currentTransactionId`. Row and event agree on A's economic date.
 *   2. Settlement B arrives: same account, same posting date, same amount, same
 *      raw descriptor, same `pending` — an IDENTICAL DF-4 fingerprint — but a
 *      DIFFERENT `authorized_date` and a DIFFERENT, also-dangling pending ref.
 *   3. The sync's EVENT-2 refusal guard cannot fire: both of its rungs need the
 *      incoming row's predecessor to RESOLVE to a row, and it does not. So
 *      fingerprint adoption proceeds and re-stamps the row's `economicDate`
 *      from B's own evidence — a committed statement of its own.
 *   4. The observation write for B then resolves NEW_EVENT again and its FIRST
 *      statement claims `currentTransactionId: <the adopted row>` — a UNIQUE
 *      column A's event still holds. P2002. The release-the-stale-claim block
 *      that exists for exactly this collision sits FORTY LINES LATER.
 *   5. The unit rolls back. The row keeps B's date, the event keeps A's pin,
 *      and no observation records why. Unreachable by replay: the observation
 *      key was never written, so the idempotent early-return never fires.
 *
 * ⚠️ WHY THE FAKES NEVER CAUGHT IT. `TransactionEvent.currentTransactionId` is
 * `@unique`. Every in-memory fake in this repository — including the one in
 * event-write-atomicity.test.ts, whose own comment names this hazard — carries
 * no constraints, so the colliding statement simply succeeded there. The fake
 * below ENFORCES that uniqueness and raises a Prisma-shaped P2002, which is the
 * only reason this file can fail.
 *
 * ⚠️ THE SECOND HALF, AND WHY ONE FIX WAS NOT ENOUGH. Creating the event with
 * `currentTransactionId: null` alone does NOT close this: measured on the same
 * real Postgres, the collision MOVED from the create to `reprojectEvent`'s own
 * update. Both settlements observe the SAME adopted row, so once the row moves
 * to the new event, the ORIGIN event's re-derivation re-claims it and aborts the
 * unit at identical cost. `reprojectEvent` therefore now treats a row as this
 * event's live projection only when the row's own `transactionEventId` still
 * says so. Tests 1 and 2 fail if EITHER half is reverted; test 3 names which.
 */

import {
  recordTransactionObservation, reprojectEvent, isEventWriteIntegrityFailure,
  type EventWriteIntegrityFailure,
} from "./event-write";
import { observationKey } from "./event-identity";
import { economicDateWriteFields } from "./economic-date-write";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "null");

// ── A Prisma stand-in that CARRIES THE UNIQUE CONSTRAINT ────────────────────

interface Row {
  id: string; plaidTransactionId: string | null; deletedAt: Date | null;
  transactionEventId: string | null; economicDate: Date | null;
}
interface Obs {
  id: string; eventId: string; transactionId: string | null; financialAccountId: string;
  provider: string; providerRowId: string | null; providerPendingRef: string | null;
  observedAt: Date; lifecycle: string; amount: number; postingDate: Date;
  economicDate: Date; authorizedAt: Date | null; observationKey: string;
  linkBasis: string | null; linkRefusal: string | null;
}
interface Evt {
  id: string; financialAccountId: string; lifecycle: string; economicDate: Date;
  currentAmount: number; currentTransactionId: string | null; observationCount: number;
  firstObservedAt: Date; lastObservedAt: Date;
  firstPendingObservedAt: Date | null; postedObservedAt: Date | null;
}
interface State { txns: Row[]; obs: Obs[]; events: Evt[] }

const clone = (s: State): State => ({
  txns: s.txns.map((r) => ({ ...r })),
  obs: s.obs.map((o) => ({ ...o })),
  events: s.events.map((e) => ({ ...e })),
});

/**
 * The real constraint, raised the way Prisma raises it.
 *
 * `code` and `meta.target` are copied verbatim from the exception the real
 * Postgres produced while reproducing this defect, so the module's failure
 * classification is exercised against the shape it will actually meet.
 */
function p2002(): Error & { code: string; meta: { modelName: string; target: string[] } } {
  const e = new Error(
    "\nInvalid `tx.transactionEvent.create()` invocation\n\n" +
    "Unique constraint failed on the fields: (`currentTransactionId`)",
  ) as Error & { code: string; meta: { modelName: string; target: string[] } };
  e.name = "PrismaClientKnownRequestError";
  e.code = "P2002";
  e.meta = { modelName: "TransactionEvent", target: ["currentTransactionId"] };
  return e;
}

/**
 * @param failOnProjectionUpdate throw an injected error when this many event
 *        projection updates have been attempted (retry-safety probe).
 */
function makeDb(initial: State, failOnProjectionUpdate?: number) {
  let s = clone(initial);
  let seq = 0, projectionUpdates = 0;

  /** Enforce `TransactionEvent.currentTransactionId @unique`. */
  const assertCurrentFree = (eventId: string | null, value: unknown): void => {
    if (value === null || value === undefined) return;
    if (s.events.some((e) => e.id !== eventId && e.currentTransactionId === value)) throw p2002();
  };

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
      updateMany: async ({ where, data }: {
        where: { id: string; NOT?: { economicDate?: Date } }; data: Record<string, unknown>;
      }) => {
        const r = s.txns.find((t) => t.id === where.id);
        if (!r) return { count: 0 };
        if (where.NOT?.economicDate !== undefined &&
            r.economicDate?.getTime() === where.NOT.economicDate.getTime()) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    transactionObservation: {
      findUnique: async ({ where }: { where: { observationKey: string } }) => {
        const o = s.obs.find((x) => x.observationKey === where.observationKey);
        return o ? { id: o.id, eventId: o.eventId, linkBasis: o.linkBasis, linkRefusal: o.linkRefusal } : null;
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
      count: async ({ where }: { where: { eventId?: string; providerPendingRef?: string; NOT?: { transactionId?: string } } }) =>
        s.obs.filter((o) =>
          (where.eventId === undefined || o.eventId === where.eventId) &&
          (where.providerPendingRef === undefined || o.providerPendingRef === where.providerPendingRef) &&
          (where.NOT?.transactionId === undefined || o.transactionId !== where.NOT.transactionId)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const o = { id: `o${++seq}`, ...data } as unknown as Obs;
        s.obs.push(o);
        return { id: o.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const o = s.obs.find((x) => x.id === where.id);
        if (o) Object.assign(o, data);
        return o;
      },
    },
    transactionEvent: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const e = s.events.find((x) => x.id === where.id);
        return e ? { ...e } : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        assertCurrentFree(null, data.currentTransactionId);
        const e = { id: `e${++seq}`, observationCount: 0, firstPendingObservedAt: null,
                    postedObservedAt: null, ...data } as unknown as Evt;
        s.events.push(e);
        return { id: e.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        projectionUpdates++;
        if (failOnProjectionUpdate !== undefined && projectionUpdates === failOnProjectionUpdate) {
          throw new Error(`injected failure on projection update #${failOnProjectionUpdate}`);
        }
        assertCurrentFree(where.id, data.currentTransactionId);
        const e = s.events.find((x) => x.id === where.id);
        if (e) Object.assign(e, data);
        return e;
      },
      updateMany: async ({ where, data }: { where: { id: string; currentTransactionId?: string }; data: Record<string, unknown> }) => {
        const e = s.events.find((x) => x.id === where.id &&
          (where.currentTransactionId === undefined || x.currentTransactionId === where.currentTransactionId));
        if (!e) return { count: 0 };
        assertCurrentFree(where.id, data.currentTransactionId);
        Object.assign(e, data);
        return { count: 1 };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        s.events = s.events.filter((e) => e.id !== where.id);
        return { id: where.id };
      },
    },
    /** A real rollback: the callback mutates a SNAPSHOT, promoted only on success. */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const before = clone(s);
      s = clone(s);
      try {
        return await fn(client);
      } catch (e) {
        s = before;
        throw e;
      }
    },
  };
  return client;
}

/** The event a row's FK actually points at — the canonical one for that row. */
const canonicalEvent = (s: State, rowId: string): Evt | undefined => {
  const r = s.txns.find((t) => t.id === rowId);
  return s.events.find((e) => e.id === r?.transactionEventId);
};

// ── The measured shape, as a scenario ───────────────────────────────────────

interface Shape {
  label: string;
  posting: string;
  authA: string;
  authB: string;
  amount: number;
  /** The pin the corrupt production row's event carried. */
  expectedEventPinA: string;
  /** The date the corrupt production row carried. */
  expectedRowEconB: string;
}

/** Both measured rows, by the facts the database holds for them. */
const SHAPES: Shape[] = [
  { label: "cmu2z2a5c00y4ku3vbcmufjx4 (Tap Talabat Food, −12.07)",
    posting: "2026-09-13", authA: "2026-09-10", authB: "2026-09-09", amount: 12.07,
    expectedEventPinA: "2026-09-10", expectedRowEconB: "2026-09-09" },
  { label: "cmupscz6s006y8hhavzqtiw8h (Talabat Food, −12.03)",
    posting: "2026-09-27", authA: "2026-09-25", authB: "2026-09-24", amount: 12.03,
    expectedEventPinA: "2026-09-25", expectedRowEconB: "2026-09-24" },
];

const FA = "fa_credit_card";

/**
 * Replay the ingest sequence for one shape and return the final state.
 *
 * Deliberately exercises the REAL writer at both steps, and the sync's own
 * adoption statement in between — the latter as a plain row update, because
 * that is exactly what it is in `syncTransactions.ts`: a committed statement of
 * its own, outside the observation unit, carrying `...econFields`
 * unconditionally.
 */
async function replayAdoptionCollision(shape: Shape) {
  const posting = D(shape.posting);
  const econA = economicDateWriteFields({ postingDate: posting, authorizedAt: D(shape.authA) });
  const econB = economicDateWriteFields({ postingDate: posting, authorizedAt: D(shape.authB) });

  const db = makeDb({
    // Settlement A's row, as the sync created it (step 3 of the upsert ladder).
    txns: [{ id: "R", plaidTransactionId: "post_A", deletedAt: null,
             transactionEventId: null, economicDate: econA.economicDate }],
    obs: [], events: [],
  });

  const a = await recordTransactionObservation(db as never, {
    transactionId: "R", financialAccountId: FA, provider: "PLAID",
    providerRowId: "post_A", providerPendingRef: "pend_A_DANGLES",
    lifecycle: "POSTED", amount: shape.amount, postingDate: posting,
    economicDate: econA.economicDate, authorizedAt: D(shape.authA),
    transactionIsLive: true, observedAt: D("2026-09-15"),
  });

  // THE SYNC'S FINGERPRINT ADOPTION (syncTransactions.ts:834-838). Same
  // fingerprint — account, posting date, amount, raw descriptor, pending — so
  // DF-4 matches A's row, and the EVENT-2 refusal guard cannot fire because
  // neither pending ref resolves to any row in the corpus.
  await db.transaction.update({
    where: { id: "R" },
    data: { plaidTransactionId: "post_B", economicDate: econB.economicDate },
  });

  let thrown: unknown = null;
  let b: Awaited<ReturnType<typeof recordTransactionObservation>> = null;
  try {
    b = await recordTransactionObservation(db as never, {
      transactionId: "R", financialAccountId: FA, provider: "PLAID",
      providerRowId: "post_B", providerPendingRef: "pend_B_DANGLES",
      lifecycle: "POSTED", amount: shape.amount, postingDate: posting,
      economicDate: econB.economicDate, authorizedAt: D(shape.authB),
      transactionIsLive: true, observedAt: D("2026-10-01"),
    });
  } catch (e) { thrown = e; }

  return { db, a, b, thrown, econA, econB };
}

async function main(): Promise<void> {

// ── 1. THE DEFECT — the terminal state, for BOTH measured rows ──────────────
console.log("1. A fingerprint-adopted row never commits disagreeing with its own event");
for (const shape of SHAPES) {
  console.log(`   ${shape.label}`);
  const { db, a, thrown, econA, econB } = await replayAdoptionCollision(shape);
  const s = db._state();
  const row = s.txns.find((t) => t.id === "R")!;
  const canonical = canonicalEvent(s, "R");

  // Sanity: the fixture really is the production shape, so a pass cannot come
  // from the scenario having quietly stopped reproducing anything.
  check("     fixture: the two settlements resolve to DIFFERENT economic dates",
    day(econA.economicDate) === shape.expectedEventPinA &&
    day(econB.economicDate) === shape.expectedRowEconB,
    `${day(econA.economicDate)} / ${day(econB.economicDate)}`);
  check("     fixture: A's event pinned the production value",
    day(s.events.find((e) => e.id === a?.eventId)?.economicDate) === shape.expectedEventPinA,
    `${day(s.events.find((e) => e.id === a?.eventId)?.economicDate)}`);

  // ⚠️ THE ASSERTIONS THAT MATTER. Pre-fix, `thrown` is a P2002, the row sits on
  // A's event carrying B's date, and there is ONE observation — the exact
  // production corruption. None of these is "an exception was thrown".
  check("  1A the row agrees with its own event's pin (THE CORRUPTION)",
    canonical !== undefined && day(canonical.economicDate) === day(row.economicDate),
    `row econ ${day(row.economicDate)} vs event pin ${day(canonical?.economicDate)}`);
  check("  1B the second settlement was RECORDED, not lost",
    s.obs.length === 2, `${s.obs.length} observation(s)`);
  check("  1C the write did not abort",
    thrown === null,
    thrown instanceof Error ? `${thrown.name}: ${String((thrown as { code?: string }).code)}` : "");
  check("  1D no two events claim the same live row",
    new Set(s.events.map((e) => e.currentTransactionId).filter((x) => x !== null)).size ===
      s.events.filter((e) => e.currentTransactionId !== null).length,
    s.events.map((e) => `${e.id}=${e.currentTransactionId}`).join(","));
  check("  1E the event the row LEFT released it and says so",
    s.events.filter((e) => e.currentTransactionId === "R").length === 1 &&
      s.events.find((e) => e.id === a?.eventId)?.currentTransactionId === null,
    s.events.map((e) => `${e.id}=${e.currentTransactionId ?? "null"}`).join(","));
  // B-6 is a per-EVENT invariant: the event A opened must keep the date its own
  // first (and only) observation resolved to. Losing a row does not re-date it.
  check("  1F B-6: the origin event's pin did NOT move",
    day(s.events.find((e) => e.id === a?.eventId)?.economicDate) === shape.expectedEventPinA,
    `${day(s.events.find((e) => e.id === a?.eventId)?.economicDate)}`);
}

// ── 2. The constraint is really in the fake ─────────────────────────────────
console.log("\n2. The harness carries the constraint that made this invisible");
{
  const db = makeDb({
    txns: [{ id: "R", plaidTransactionId: "p", deletedAt: null, transactionEventId: "e_held", economicDate: D("2026-09-13") }],
    obs: [], events: [{
      id: "e_held", financialAccountId: FA, lifecycle: "POSTED", economicDate: D("2026-09-13"),
      currentAmount: 1, currentTransactionId: "R", observationCount: 1,
      firstObservedAt: D("2026-09-13"), lastObservedAt: D("2026-09-13"),
      firstPendingObservedAt: null, postedObservedAt: D("2026-09-13"),
    }],
  });
  let code: string | null = null;
  try {
    await db.transactionEvent.create({ data: { financialAccountId: FA, currentTransactionId: "R" } as never });
  } catch (e) { code = String((e as { code?: string }).code); }
  check("  2A a second event claiming the same row is REFUSED with P2002", code === "P2002", `${code}`);
}

// ── 3. THE SECOND HALF — reprojectEvent must not re-claim a row it lost ─────
//
// Named separately so a reverter sees which half broke. This is the collision
// the create-ordering fix alone leaves behind, measured on a real Postgres.
console.log("\n3. An event re-derived after losing a row does not re-claim it");
{
  const db = makeDb({
    txns: [{ id: "R", plaidTransactionId: "post_B", deletedAt: null,
             transactionEventId: "e_new", economicDate: D("2026-09-09") }],
    obs: [
      { id: "o_a", eventId: "e_lost", transactionId: "R", financialAccountId: FA, provider: "PLAID",
        providerRowId: "post_A", providerPendingRef: null, observedAt: D("2026-09-15"),
        lifecycle: "POSTED", amount: 12.07, postingDate: D("2026-09-13"),
        economicDate: D("2026-09-10"), authorizedAt: D("2026-09-10"),
        observationKey: "k_a", linkBasis: "NEW_EVENT", linkRefusal: "DANGLING_PENDING_REF" },
      { id: "o_b", eventId: "e_new", transactionId: "R", financialAccountId: FA, provider: "PLAID",
        providerRowId: "post_B", providerPendingRef: null, observedAt: D("2026-10-01"),
        lifecycle: "POSTED", amount: 12.07, postingDate: D("2026-09-13"),
        economicDate: D("2026-09-09"), authorizedAt: D("2026-09-09"),
        observationKey: "k_b", linkBasis: "NEW_EVENT", linkRefusal: "DANGLING_PENDING_REF" },
    ],
    events: [
      { id: "e_lost", financialAccountId: FA, lifecycle: "POSTED", economicDate: D("2026-09-10"),
        currentAmount: 12.07, currentTransactionId: null, observationCount: 1,
        firstObservedAt: D("2026-09-15"), lastObservedAt: D("2026-09-15"),
        firstPendingObservedAt: null, postedObservedAt: D("2026-09-15") },
      { id: "e_new", financialAccountId: FA, lifecycle: "POSTED", economicDate: D("2026-09-09"),
        currentAmount: 12.07, currentTransactionId: "R", observationCount: 1,
        firstObservedAt: D("2026-10-01"), lastObservedAt: D("2026-10-01"),
        firstPendingObservedAt: null, postedObservedAt: D("2026-10-01") },
    ],
  });

  let thrown: unknown = null;
  try { await reprojectEvent(db as never, "e_lost"); } catch (e) { thrown = e; }
  const s = db._state();
  check("  3A re-deriving the losing event does NOT raise P2002",
    thrown === null, `${(thrown as { code?: string } | null)?.code}`);
  check("  3B it claims no row — the row's own FK names another event",
    s.events.find((e) => e.id === "e_lost")?.currentTransactionId === null,
    `${s.events.find((e) => e.id === "e_lost")?.currentTransactionId}`);
  check("  3C the row's date was NOT re-stamped by the event that lost it",
    day(s.txns.find((t) => t.id === "R")?.economicDate) === "2026-09-09",
    `${day(s.txns.find((t) => t.id === "R")?.economicDate)}`);
  check("  3D the event that OWNS the row still projects it",
    s.events.find((e) => e.id === "e_new")?.currentTransactionId === "R",
    `${s.events.find((e) => e.id === "e_new")?.currentTransactionId}`);
}

// ── 4. PRESERVED: pending → posted continuity, and the B-6 pin ──────────────
console.log("\n4. PRESERVED — a pending→posted succession is still ONE event, pinned");
{
  const db = makeDb({
    txns: [
      { id: "t_pend", plaidTransactionId: "pend_S", deletedAt: null, transactionEventId: null, economicDate: D("2026-09-05") },
      { id: "t_post", plaidTransactionId: "post_S", deletedAt: null, transactionEventId: null, economicDate: D("2026-09-09") },
    ],
    obs: [], events: [],
  });
  const p = await recordTransactionObservation(db as never, {
    transactionId: "t_pend", financialAccountId: FA, provider: "PLAID",
    providerRowId: "pend_S", providerPendingRef: null, lifecycle: "PENDING",
    amount: 20, postingDate: D("2026-09-05"), economicDate: D("2026-09-05"),
    authorizedAt: null, transactionIsLive: true, observedAt: D("2026-09-05"),
  });
  const q = await recordTransactionObservation(db as never, {
    transactionId: "t_post", financialAccountId: FA, provider: "PLAID",
    providerRowId: "post_S", providerPendingRef: "pend_S", lifecycle: "POSTED",
    amount: 20, postingDate: D("2026-09-09"), economicDate: D("2026-09-09"),
    // A LATE authorization, arriving only at posting. B-6 forbids it moving the pin.
    authorizedAt: D("2026-09-07"), transactionIsLive: true, observedAt: D("2026-09-09"),
  });
  // The pending row is tombstoned by removed[], then the event re-derived.
  await db.transaction.update({ where: { id: "t_pend" }, data: { deletedAt: D("2026-09-09") } });
  await reprojectEvent(db as never, q!.eventId);

  const s = db._state();
  const ev = s.events.find((e) => e.id === q?.eventId)!;
  check("  4A both observations landed on ONE event",
    p?.eventId === q?.eventId && s.events.length === 1 && ev.observationCount === 2,
    `${s.events.length} event(s), basis=${q?.basis}, count=${ev.observationCount}`);
  check("  4B the succession was linked by the PROVIDER's claim",
    q?.basis === "PROVIDER_PENDING_REF", `${q?.basis}`);
  check("  4C B-6: the pin is the FIRST pending resolution, not the late authorization",
    day(ev.economicDate) === "2026-09-05", day(ev.economicDate));
  check("  4D the posted row is the current projection",
    ev.currentTransactionId === "t_post", `${ev.currentTransactionId}`);
  check("  4E the posted row carries the event's pin",
    day(s.txns.find((t) => t.id === "t_post")?.economicDate) === "2026-09-05",
    `${day(s.txns.find((t) => t.id === "t_post")?.economicDate)}`);
  check("  4F the tombstoned pending row was left alone",
    day(s.txns.find((t) => t.id === "t_pend")?.economicDate) === "2026-09-05",
    `${day(s.txns.find((t) => t.id === "t_pend")?.economicDate)}`);
}

// ── 5. PRESERVED: a legitimate duplicate delivery (DF-4) still fuses ────────
console.log("\n5. PRESERVED — a re-keyed delivery of ONE row is still ONE event, agreeing");
{
  // The Uber/Amazon case the fingerprint adoption exists for: the provider
  // re-keyed the same transaction, no pending ref anywhere. The row is adopted
  // and the SECOND observation must attach to the row's PERSISTED event.
  const db = makeDb({
    txns: [{ id: "R", plaidTransactionId: "uber_1", deletedAt: null, transactionEventId: null, economicDate: D("2026-09-16") }],
    obs: [], events: [],
  });
  const first = await recordTransactionObservation(db as never, {
    transactionId: "R", financialAccountId: FA, provider: "PLAID",
    providerRowId: "uber_1", providerPendingRef: null, lifecycle: "POSTED",
    amount: 7.12, postingDate: D("2026-09-16"), economicDate: D("2026-09-16"),
    authorizedAt: null, transactionIsLive: true, observedAt: D("2026-09-16"),
  });
  await db.transaction.update({ where: { id: "R" }, data: { plaidTransactionId: "uber_2" } });
  const second = await recordTransactionObservation(db as never, {
    transactionId: "R", financialAccountId: FA, provider: "PLAID",
    providerRowId: "uber_2", providerPendingRef: null, lifecycle: "POSTED",
    amount: 7.12, postingDate: D("2026-09-16"), economicDate: D("2026-09-16"),
    authorizedAt: null, transactionIsLive: true, observedAt: D("2026-09-17"),
  });
  const s = db._state();
  check("  5A still ONE event — the duplicate was not re-opened",
    s.events.length === 1 && first?.eventId === second?.eventId,
    `${s.events.length} event(s)`);
  check("  5B the second delivery attached by the PERSISTED link",
    second?.basis === "PERSISTED_LINK", `${second?.basis}`);
  check("  5C two observations, one live row",
    s.obs.length === 2 && s.events[0].currentTransactionId === "R",
    `${s.obs.length} obs, current=${s.events[0].currentTransactionId}`);
  check("  5D row and event agree",
    day(s.events[0].economicDate) === day(s.txns[0].economicDate),
    `${day(s.events[0].economicDate)} vs ${day(s.txns[0].economicDate)}`);
}

// ── 6. PRESERVED: idempotence ───────────────────────────────────────────────
console.log("\n6. PRESERVED — replaying an identical payload still writes nothing");
{
  const replay = {
    transactionId: "R", financialAccountId: FA, provider: "PLAID" as const,
    providerRowId: "post_A", providerPendingRef: null,
    lifecycle: "POSTED" as const, amount: 12.07,
    postingDate: D("2026-09-13"), economicDate: D("2026-09-10"),
    authorizedAt: D("2026-09-10"), transactionIsLive: true, observedAt: D("2026-09-15"),
  };
  const db = makeDb({
    txns: [{ id: "R", plaidTransactionId: "post_A", deletedAt: null, transactionEventId: "e1", economicDate: D("2026-09-10") }],
    obs: [{
      id: "o1", eventId: "e1", transactionId: "R", financialAccountId: FA, provider: "PLAID",
      providerRowId: "post_A", providerPendingRef: null, observedAt: D("2026-09-15"),
      lifecycle: "POSTED", amount: 12.07, postingDate: D("2026-09-13"),
      economicDate: D("2026-09-10"), authorizedAt: D("2026-09-10"),
      observationKey: observationKey(replay), linkBasis: "NEW_EVENT", linkRefusal: null,
    }],
    events: [{
      id: "e1", financialAccountId: FA, lifecycle: "POSTED", economicDate: D("2026-09-10"),
      currentAmount: 12.07, currentTransactionId: "R", observationCount: 1,
      firstObservedAt: D("2026-09-15"), lastObservedAt: D("2026-09-15"),
      firstPendingObservedAt: null, postedObservedAt: D("2026-09-15"),
    }],
  });
  const before = JSON.stringify(db._state());
  const r = await recordTransactionObservation(db as never, replay);
  check("  6A state is byte-identical after a replay",
    JSON.stringify(db._state()) === before, `${db._state().obs.length} observation(s)`);
  check("  6B the stored basis is returned, not re-derived",
    r?.created === false && r?.basis === "NEW_EVENT", `${r?.basis}/${r?.created}`);
}

// ── 7. FAILURE SEMANTICS — a rollback is typed, not a bare Prisma error ─────
console.log("\n7. A rolled-back unit says CANONICAL EVENT STATE WAS NOT PERSISTED");
{
  // Fail on the origin's re-derivation: the observation is already inserted, the
  // FK has moved, the destination is already re-derived. The worst moment.
  const db = makeDb({
    txns: [
      { id: "R", plaidTransactionId: "post_A", deletedAt: null, transactionEventId: "e_origin", economicDate: D("2026-09-10") },
      { id: "t_p", plaidTransactionId: "pend_B", deletedAt: D("2026-09-13"), transactionEventId: "e_dest", economicDate: D("2026-09-06") },
    ],
    obs: [
      { id: "o_a", eventId: "e_origin", transactionId: "R", financialAccountId: FA, provider: "PLAID",
        providerRowId: "post_A", providerPendingRef: null, observedAt: D("2026-09-15"),
        lifecycle: "POSTED", amount: 12.07, postingDate: D("2026-09-13"),
        economicDate: D("2026-09-10"), authorizedAt: D("2026-09-10"),
        observationKey: "k_a", linkBasis: "NEW_EVENT", linkRefusal: null },
      { id: "o_p", eventId: "e_dest", transactionId: "t_p", financialAccountId: FA, provider: "PLAID",
        providerRowId: "pend_B", providerPendingRef: null, observedAt: D("2026-09-06"),
        lifecycle: "PENDING", amount: 12.07, postingDate: D("2026-09-06"),
        economicDate: D("2026-09-06"), authorizedAt: null,
        observationKey: "k_p", linkBasis: "NEW_EVENT", linkRefusal: null },
    ],
    events: [
      { id: "e_origin", financialAccountId: FA, lifecycle: "POSTED", economicDate: D("2026-09-10"),
        currentAmount: 12.07, currentTransactionId: "R", observationCount: 1,
        firstObservedAt: D("2026-09-15"), lastObservedAt: D("2026-09-15"),
        firstPendingObservedAt: null, postedObservedAt: D("2026-09-15") },
      { id: "e_dest", financialAccountId: FA, lifecycle: "PENDING", economicDate: D("2026-09-06"),
        currentAmount: 12.07, currentTransactionId: null, observationCount: 1,
        firstObservedAt: D("2026-09-06"), lastObservedAt: D("2026-09-06"),
        firstPendingObservedAt: D("2026-09-06"), postedObservedAt: null },
    ],
  }, 2);

  const input = {
    transactionId: "R", financialAccountId: FA, provider: "PLAID" as const,
    providerRowId: "post_C", providerPendingRef: "pend_B",
    lifecycle: "POSTED" as const, amount: 12.07,
    postingDate: D("2026-09-13"), economicDate: D("2026-09-13"),
    authorizedAt: null, transactionIsLive: true, observedAt: D("2026-09-18"),
  };
  let thrown: unknown = null;
  try { await recordTransactionObservation(db as never, input); } catch (e) { thrown = e; }
  const f = thrown as EventWriteIntegrityFailure;
  const s = db._state();

  check("  7A the failure is TYPED, not a bare database error",
    isEventWriteIntegrityFailure(thrown), `${(thrown as Error)?.name}`);
  check("  7B it states that canonical event state was not persisted",
    f?.canonicalStatePersisted === false, `${f?.canonicalStatePersisted}`);
  check("  7C it names the observation key, so the payload is replayable",
    f?.detail?.observationKey === observationKey(input), `${f?.detail?.observationKey}`);
  check("  7D it names the row, the origin and the target",
    f?.detail?.transactionId === "R" && f?.detail?.originEventId === "e_origin" &&
      f?.detail?.targetEventId === "e_dest",
    `${f?.detail?.transactionId}/${f?.detail?.originEventId}/${f?.detail?.targetEventId}`);
  check("  7E the cause is preserved for diagnosis",
    /injected failure/.test(String((f as unknown as { cause?: Error })?.cause?.message)),
    `${(f as unknown as { cause?: Error })?.cause?.message}`);
  // Retry safety: a rollback must leave the corpus replayable, not half-written.
  check("  7F RETRY SAFE — no observation survived the rollback",
    s.obs.length === 2, `${s.obs.length} observation(s)`);
  check("  7G RETRY SAFE — the row's event assignment is unchanged",
    s.txns.find((t) => t.id === "R")?.transactionEventId === "e_origin",
    `${s.txns.find((t) => t.id === "R")?.transactionEventId}`);
  check("  7H RETRY SAFE — the origin still holds its row",
    s.events.find((e) => e.id === "e_origin")?.currentTransactionId === "R",
    `${s.events.find((e) => e.id === "e_origin")?.currentTransactionId}`);
}

// ── 8. FAILURE SEMANTICS — a real P2002 is classified, not swallowed ────────
console.log("\n8. A database integrity refusal is reported with its own vocabulary");
{
  const db = makeDb({
    txns: [{ id: "R", plaidTransactionId: "post_A", deletedAt: null, transactionEventId: null, economicDate: D("2026-09-13") }],
    obs: [], events: [],
  });
  // An unrelated event already holds this row: whatever the ordering, the unit
  // cannot grant the claim, so the module must report it as what it is.
  db._state().events.push({
    id: "e_squatter", financialAccountId: FA, lifecycle: "POSTED", economicDate: D("2026-09-13"),
    currentAmount: 1, currentTransactionId: "R", observationCount: 0,
    firstObservedAt: D("2026-09-13"), lastObservedAt: D("2026-09-13"),
    firstPendingObservedAt: null, postedObservedAt: null,
  });
  let thrown: unknown = null;
  try {
    await recordTransactionObservation(db as never, {
      transactionId: "R", financialAccountId: FA, provider: "PLAID",
      providerRowId: "post_A", providerPendingRef: null, lifecycle: "POSTED",
      amount: 12.07, postingDate: D("2026-09-13"), economicDate: D("2026-09-13"),
      authorizedAt: null, transactionIsLive: true, observedAt: D("2026-09-15"),
    });
  } catch (e) { thrown = e; }
  const f = thrown as EventWriteIntegrityFailure;
  check("  8A typed failure", isEventWriteIntegrityFailure(thrown), `${(thrown as Error)?.name}`);
  check("  8B carries the Prisma code", f?.detail?.code === "P2002", `${f?.detail?.code}`);
  check("  8C names the constraint the database named",
    f?.detail?.constraint?.join(",") === "currentTransactionId", `${f?.detail?.constraint}`);
  check("  8D the stage is the observation write", f?.detail?.stage === "OBSERVATION_WRITE", `${f?.detail?.stage}`);
}

// ── 9. The write's own terminal-state assertion is REACHABLE ────────────────
//
// D — the guarantee must be checked, not hoped. Proven by sabotaging the
// materialization the check exists to verify: a row that refuses to take its
// event's pin must abort the unit rather than commit the disagreement.
console.log("\n9. A row that will not take its event's pin aborts the unit");
{
  const db = makeDb({
    txns: [{ id: "R", plaidTransactionId: "post_A", deletedAt: null, transactionEventId: null, economicDate: D("2026-09-13") }],
    obs: [], events: [],
  });
  // Sabotage: the row-side materialization silently does nothing. Pre-check this
  // committed a row whose economicDate disagreed with its own event's pin.
  db.transaction.updateMany = async () => ({ count: 0 });
  let thrown: unknown = null;
  try {
    await recordTransactionObservation(db as never, {
      transactionId: "R", financialAccountId: FA, provider: "PLAID",
      providerRowId: "post_A", providerPendingRef: null, lifecycle: "POSTED",
      amount: 12.07, postingDate: D("2026-09-13"), economicDate: D("2026-09-13"),
      // authorizedAt 3 days before posting ⇒ the event pins 2026-09-10 while the
      // row sits on 2026-09-13, and the pin write is the sabotaged statement.
      authorizedAt: D("2026-09-10"), transactionIsLive: true, observedAt: D("2026-09-15"),
    });
  } catch (e) { thrown = e; }
  const f = thrown as EventWriteIntegrityFailure;
  const s = db._state();
  check("  9A the disagreement was refused, not committed",
    isEventWriteIntegrityFailure(thrown) && f.detail.stage === "TERMINAL_STATE_CHECK",
    `${(thrown as Error)?.name}/${f?.detail?.stage}`);
  check("  9B nothing was left behind", s.obs.length === 0 && s.events.length === 0,
    `${s.obs.length} obs / ${s.events.length} events`);
}

console.log(failures === 0 ? "\nAll event-write claim-ordering checks passed.\n" : `\n${failures} check(s) failed\n`);
if (failures > 0) process.exit(1);
}

main();
