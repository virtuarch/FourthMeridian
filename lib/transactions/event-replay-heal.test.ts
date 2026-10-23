/**
 * lib/transactions/event-replay-heal.test.ts
 *
 * W1 (D6) — BEHAVIOURAL proof of REPLAY HEALING and the evidence ledger
 * (house pattern: standalone tsx, DB-free — the in-memory stand-in from
 * event-write-atomicity.test.ts, extended with observation.update and
 * event.delete):
 *
 *   npx tsx lib/transactions/event-replay-heal.test.ts
 *
 * ── The split this heals ────────────────────────────────────────────────────
 *
 * A settlement observed while its pending predecessor was absent from the
 * corpus (historical sync order, a purged pending row later restored, the
 * production backfill's own ordering) gets an honest refusal
 * (DANGLING_PENDING_REF) and its own event. Before W1 that split was
 * PERMANENT: the observation key exists, so every replay took the idempotent
 * early return and rung 1 never ran again — a dangling split could not heal
 * even after the predecessor appeared. Production carries 62 such dangling
 * refs today.
 *
 * ── What the heal is, and is not ────────────────────────────────────────────
 *
 *   · Heals ONLY on a clean rank-1 PROVIDER_PENDING_REF resolution to a
 *     different event — the same rung-1-outranks-persisted-link precedence the
 *     live write path applies. Still-dangling and ambiguous claims stay put.
 *   · The gate is the RESOLUTION, not the stored refusal — so observations
 *     written before the linkBasis/linkRefusal ledger existed heal too.
 *   · Provider facts are never touched; eventId/linkBasis/linkRefusal are OUR
 *     derivation columns. An origin event emptied by the move is deleted.
 *   · There is deliberately NO event-split machinery.
 *
 * ⚠️ Test 1 (heal) and test 4 (ledger written at create) are the ones that must
 * fail if W1's event-write changes are reverted.
 */

import { recordTransactionObservation } from "./event-write";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── In-memory Prisma stand-in ────────────────────────────────────────────────

interface Row { id: string; plaidTransactionId: string | null; deletedAt: Date | null; transactionEventId: string | null; economicDate?: Date }
interface Obs {
  id: string; eventId: string; transactionId: string | null; financialAccountId: string; providerRowId: string | null;
  providerPendingRef: string | null; observedAt: Date; lifecycle: string; amount: number;
  postingDate: Date; economicDate: Date; observationKey: string;
  linkBasis?: string | null; linkRefusal?: string | null;
}
interface Evt {
  id: string; lifecycle: string; economicDate: Date; currentAmount: number;
  currentTransactionId: string | null; observationCount: number;
  firstObservedAt: Date; lastObservedAt: Date;
  firstPendingObservedAt: Date | null; postedObservedAt: Date | null;
}
interface State { txns: Row[]; obs: Obs[]; events: Evt[] }

function makeDb(initial: State) {
  const s = initial;
  let seq = 0;
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
        where: { id: string; NOT?: { economicDate?: Date } };
        data: Record<string, unknown>;
      }) => {
        const r = s.txns.find((t) => t.id === where.id);
        if (!r) return { count: 0 };
        if (where.NOT?.economicDate !== undefined &&
            r.economicDate?.getTime?.() === where.NOT.economicDate?.getTime?.()) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    transactionObservation: {
      findUnique: async ({ where }: { where: { observationKey: string } }) => {
        const o = s.obs.find((x) => x.observationKey === where.observationKey);
        return o ? { id: o.id, eventId: o.eventId, linkBasis: o.linkBasis ?? null, linkRefusal: o.linkRefusal ?? null } : null;
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
      count: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.eventId) return s.obs.filter((o) => o.eventId === where.eventId).length;
        // claimsPerPendingRef: OTHER observations claiming the same predecessor.
        const notTx = (where.NOT as { transactionId?: string } | undefined)?.transactionId;
        return s.obs.filter((o) =>
          o.providerPendingRef === where.providerPendingRef && o.transactionId !== notTx).length;
      },
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
        const e = { id: `e${++seq}`, observationCount: 0, firstPendingObservedAt: null,
                    postedObservedAt: null, ...data } as unknown as Evt;
        s.events.push(e);
        return { id: e.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const e = s.events.find((x) => x.id === where.id);
        if (e) Object.assign(e, data);
        return e;
      },
      updateMany: async ({ where, data }: { where: { id: string; currentTransactionId?: string }; data: Record<string, unknown> }) => {
        const e = s.events.find((x) => x.id === where.id &&
          (where.currentTransactionId === undefined || x.currentTransactionId === where.currentTransactionId));
        if (!e) return { count: 0 };
        Object.assign(e, data);
        return { count: 1 };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = s.events.findIndex((x) => x.id === where.id);
        if (i >= 0) s.events.splice(i, 1);
        return { id: where.id };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(client),
  };
  return client;
}

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function main(): Promise<void> {

// ── 1. THE HEAL — dangling on first observation, predecessor arrives, replay ─
console.log("1. Dangling-ref split heals on idempotent replay once the predecessor exists");
{
  const db = makeDb({ txns: [], obs: [], events: [] });
  db._state().txns.push({ id: "t_post", plaidTransactionId: "post_X", deletedAt: null, transactionEventId: null });

  // First observation: the settlement, predecessor pend_X NOT in the corpus.
  const first = await recordTransactionObservation(db as never, {
    transactionId: "t_post", financialAccountId: "fa1", provider: "PLAID",
    providerRowId: "post_X", providerPendingRef: "pend_X",
    lifecycle: "POSTED", amount: -12.05, postingDate: D("2026-08-09"),
    economicDate: D("2026-08-09"), authorizedAt: null, transactionIsLive: true,
    observedAt: D("2026-08-09"),
  });
  check("first observation refused the dangling link and got its own event",
    first?.created === true && first.basis === "NEW_EVENT" && first.refusal === "DANGLING_PENDING_REF",
    JSON.stringify(first));
  check("the refusal is PERSISTED on the observation (evidence ledger)",
    db._state().obs[0]?.linkBasis === "NEW_EVENT" && db._state().obs[0]?.linkRefusal === "DANGLING_PENDING_REF",
    JSON.stringify(db._state().obs[0]));

  // The predecessor arrives late (historical order): its own row + observation.
  db._state().txns.push({ id: "t_pend", plaidTransactionId: "pend_X", deletedAt: null, transactionEventId: null });
  const pend = await recordTransactionObservation(db as never, {
    transactionId: "t_pend", financialAccountId: "fa1", provider: "PLAID",
    providerRowId: "pend_X", providerPendingRef: null,
    lifecycle: "PENDING", amount: -12.05, postingDate: D("2026-08-05"),
    // Backfill semantics: `observedAt` replays the HISTORICAL observation time
    // (that is why ObservationInput injects it) — the arrival is late only in
    // wall-clock. The projection therefore orders pending → posted correctly.
    economicDate: D("2026-08-05"), authorizedAt: null, transactionIsLive: true,
    observedAt: D("2026-08-05"),
  });
  check("the predecessor lands on its own event", pend?.created === true && pend.basis === "NEW_EVENT" && pend.refusal === null, JSON.stringify(pend));
  check("two events exist before the replay", db._state().events.length === 2, `${db._state().events.length}`);

  // REPLAY the settlement payload — identical facts, identical observation key.
  const replay = await recordTransactionObservation(db as never, {
    transactionId: "t_post", financialAccountId: "fa1", provider: "PLAID",
    providerRowId: "post_X", providerPendingRef: "pend_X",
    lifecycle: "POSTED", amount: -12.05, postingDate: D("2026-08-09"),
    economicDate: D("2026-08-09"), authorizedAt: null, transactionIsLive: true,
    observedAt: D("2026-08-09"),
  });
  const target = pend?.eventId;
  check("replay HEALS: idempotent (created=false) but re-linked by rank-1 evidence",
    replay?.created === false && replay.basis === "PROVIDER_PENDING_REF" && replay.eventId === target,
    JSON.stringify(replay));
  check("both observations now sit on the predecessor's event",
    db._state().obs.every((o) => o.eventId === target),
    db._state().obs.map((o) => o.eventId).join(","));
  check("the emptied origin event was deleted — ONE event remains",
    db._state().events.length === 1 && db._state().events[0].id === target,
    db._state().events.map((e) => e.id).join(","));
  check("the row's FK follows the heal", db._state().txns.find((t) => t.id === "t_post")?.transactionEventId === target,
    `${db._state().txns.find((t) => t.id === "t_post")?.transactionEventId}`);
  check("the healed observation's ledger reads PROVIDER_PENDING_REF / no refusal",
    db._state().obs.find((o) => o.providerRowId === "post_X")?.linkBasis === "PROVIDER_PENDING_REF" &&
    db._state().obs.find((o) => o.providerRowId === "post_X")?.linkRefusal === null,
    JSON.stringify(db._state().obs.find((o) => o.providerRowId === "post_X")));
  const evt = db._state().events[0];
  check("the healed event's projection is re-derived (POSTED, 2 observations, live row)",
    evt.lifecycle === "POSTED" && evt.observationCount === 2 && evt.currentTransactionId === "t_post",
    JSON.stringify(evt));
  check("the pin holds: economic date is the FIRST observation's (the pending's)",
    evt.economicDate.toISOString().slice(0, 10) === "2026-08-05",
    evt.economicDate.toISOString().slice(0, 10));

  // A SECOND replay after the heal is a plain idempotent no-op.
  const again = await recordTransactionObservation(db as never, {
    transactionId: "t_post", financialAccountId: "fa1", provider: "PLAID",
    providerRowId: "post_X", providerPendingRef: "pend_X",
    lifecycle: "POSTED", amount: -12.05, postingDate: D("2026-08-09"),
    economicDate: D("2026-08-09"), authorizedAt: null, transactionIsLive: true,
    observedAt: D("2026-08-09"),
  });
  check("post-heal replay is a no-op with the TRUE stored basis (not a fabricated PERSISTED_LINK)",
    again?.created === false && again.eventId === target && again.basis === "PROVIDER_PENDING_REF",
    JSON.stringify(again));
  check("no rows/observations/events were minted by the no-op",
    db._state().obs.length === 2 && db._state().events.length === 1,
    `${db._state().obs.length} obs, ${db._state().events.length} events`);
}

// ── 2. STILL-DANGLING replay heals nothing ──────────────────────────────────
console.log("\n2. A still-dangling claim stays split (no invention)");
{
  const db = makeDb({ txns: [{ id: "t_post", plaidTransactionId: "post_X", deletedAt: null, transactionEventId: null }], obs: [], events: [] });
  const input = {
    transactionId: "t_post", financialAccountId: "fa1", provider: "PLAID" as const,
    providerRowId: "post_X", providerPendingRef: "pend_GONE",
    lifecycle: "POSTED" as const, amount: -12.05, postingDate: D("2026-08-09"),
    economicDate: D("2026-08-09"), authorizedAt: null, transactionIsLive: true,
    observedAt: D("2026-08-09"),
  };
  const first = await recordTransactionObservation(db as never, input);
  const replay = await recordTransactionObservation(db as never, input);
  check("replay with the predecessor still absent: same event, still refused",
    replay?.created === false && replay.eventId === first?.eventId && replay.refusal === "DANGLING_PENDING_REF",
    JSON.stringify(replay));
  check("one event, one observation — nothing moved", db._state().events.length === 1 && db._state().obs.length === 1,
    `${db._state().events.length}/${db._state().obs.length}`);
}

// ── 3. AMBIGUOUS predecessor claims heal nothing ────────────────────────────
console.log("\n3. Two claimants on one predecessor: neither heals (1:1 identity cannot hold)");
{
  const db = makeDb({ txns: [
    { id: "t_a", plaidTransactionId: "post_A", deletedAt: null, transactionEventId: null },
    { id: "t_b", plaidTransactionId: "post_B", deletedAt: null, transactionEventId: null },
  ], obs: [], events: [] });
  const mk = (tid: string, rowId: string) => ({
    transactionId: tid, financialAccountId: "fa1", provider: "PLAID" as const,
    providerRowId: rowId, providerPendingRef: "pend_X",
    lifecycle: "POSTED" as const, amount: -12.05, postingDate: D("2026-08-09"),
    economicDate: D("2026-08-09"), authorizedAt: null, transactionIsLive: true,
    observedAt: D("2026-08-09"),
  });
  await recordTransactionObservation(db as never, mk("t_a", "post_A"));
  await recordTransactionObservation(db as never, mk("t_b", "post_B"));
  // The predecessor NOW arrives — but TWO observations claim it.
  db._state().txns.push({ id: "t_pend", plaidTransactionId: "pend_X", deletedAt: null, transactionEventId: null });
  await recordTransactionObservation(db as never, {
    transactionId: "t_pend", financialAccountId: "fa1", provider: "PLAID",
    providerRowId: "pend_X", providerPendingRef: null,
    lifecycle: "PENDING", amount: -12.05, postingDate: D("2026-08-05"),
    economicDate: D("2026-08-05"), authorizedAt: null, transactionIsLive: true,
    observedAt: D("2026-08-10"),
  });
  const replayA = await recordTransactionObservation(db as never, mk("t_a", "post_A"));
  // The heal path re-resolves, sees TWO claimants (AMBIGUOUS_PREDECESSOR), and
  // declines. The idempotent return then reports the STORED creation-time
  // refusal (DANGLING_PENDING_REF — the historical fact in the ledger); the
  // ambiguity verdict only gates the heal, it does not rewrite history.
  check("ambiguous claim refuses to heal — same split, ledger history intact",
    replayA?.created === false && replayA.basis === "NEW_EVENT" &&
    replayA.refusal === "DANGLING_PENDING_REF" && db._state().events.length === 3,
    JSON.stringify(replayA));
}

// ── 4. Pre-ledger observations (linkBasis null) still heal ──────────────────
console.log("\n4. An observation written BEFORE the ledger existed heals on replay too");
{
  // Seeded by hand: the production shape — a dangling-split observation with
  // NO linkBasis/linkRefusal (pre-W1 rows; the 62 dangling refs).
  const db = makeDb({
    txns: [
      { id: "t_post", plaidTransactionId: "post_X", deletedAt: null, transactionEventId: "eSplit" },
      { id: "t_pend", plaidTransactionId: "pend_X", deletedAt: null, transactionEventId: "ePend" },
    ],
    obs: [
      { id: "oldObs", eventId: "eSplit", transactionId: "t_post", financialAccountId: "fa1",
        providerRowId: "post_X", providerPendingRef: "pend_X", observedAt: D("2026-08-09"),
        lifecycle: "POSTED", amount: -12.05, postingDate: D("2026-08-09"), economicDate: D("2026-08-09"),
        // The REAL production key for these facts (sha of the material) — but the
        // fake matches on equality, so any stable string works.
        observationKey: "k_legacy_posted" },
      { id: "pendObs", eventId: "ePend", transactionId: "t_pend", financialAccountId: "fa1",
        providerRowId: "pend_X", providerPendingRef: null, observedAt: D("2026-08-10"),
        lifecycle: "PENDING", amount: -12.05, postingDate: D("2026-08-05"), economicDate: D("2026-08-05"),
        observationKey: "k_legacy_pending" },
    ],
    events: [
      { id: "eSplit", lifecycle: "POSTED", economicDate: D("2026-08-09"), currentAmount: -12.05,
        currentTransactionId: "t_post", observationCount: 1, firstObservedAt: D("2026-08-09"),
        lastObservedAt: D("2026-08-09"), firstPendingObservedAt: null, postedObservedAt: D("2026-08-09") },
      { id: "ePend", lifecycle: "PENDING", economicDate: D("2026-08-05"), currentAmount: -12.05,
        currentTransactionId: "t_pend", observationCount: 1, firstObservedAt: D("2026-08-10"),
        lastObservedAt: D("2026-08-10"), firstPendingObservedAt: D("2026-08-10"), postedObservedAt: null },
    ],
  });
  // The seeded key must be what the writer derives for the replayed facts, so
  // compute it the same way the writer will: replay with a patched key check —
  // simplest is to overwrite the seeded key with the writer's own derivation.
  const { observationKey } = await import("./event-identity");
  db._state().obs[0].observationKey = observationKey({
    provider: "PLAID", financialAccountId: "fa1", providerRowId: "post_X",
    transactionId: "t_post", lifecycle: "POSTED", amount: -12.05,
    postingDate: D("2026-08-09"), economicDate: D("2026-08-09"),
  });
  const replay = await recordTransactionObservation(db as never, {
    transactionId: "t_post", financialAccountId: "fa1", provider: "PLAID",
    providerRowId: "post_X", providerPendingRef: "pend_X",
    lifecycle: "POSTED", amount: -12.05, postingDate: D("2026-08-09"),
    economicDate: D("2026-08-09"), authorizedAt: null, transactionIsLive: true,
    observedAt: D("2026-08-09"),
  });
  check("legacy observation healed onto the predecessor's event",
    replay?.created === false && replay.basis === "PROVIDER_PENDING_REF" && replay.eventId === "ePend",
    JSON.stringify(replay));
  check("eSplit (emptied) deleted; ePend carries both observations",
    db._state().events.length === 1 && db._state().events[0].id === "ePend" &&
    db._state().obs.every((o) => o.eventId === "ePend"),
    JSON.stringify(db._state().events.map((e) => e.id)));
  check("ledger backfilled ON THE HEALED ROW ONLY (correcting a derivation, not history)",
    db._state().obs.find((o) => o.id === "oldObs")?.linkBasis === "PROVIDER_PENDING_REF" &&
    (db._state().obs.find((o) => o.id === "pendObs")?.linkBasis ?? null) === null,
    JSON.stringify(db._state().obs));
}

console.log(failures === 0 ? "\nAll replay-heal checks passed.\n" : `\n${failures} check(s) failed\n`);
process.exit(failures > 0 ? 1 : 0);
}

main();
