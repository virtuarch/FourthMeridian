/**
 * lib/investments/atomicity-under-phase.test.ts  (RLS-C-S8)
 *
 * THE THREE DOCUMENTED ATOMICITY REQUIREMENTS SURVIVE A TENANT PHASE — AND ARE
 * ATOMIC *WITH* IT.
 *
 * ── WHY THIS FILE EXISTS, AND WHY REASONING WAS NOT ENOUGH ───────────────────
 * Each of these three writers must apply its statements as one unit:
 *
 *   1. HOLDINGS RECONCILIATION  delete-stale → update-in-place → insert-new.
 *      Two of three applied is a current-state projection that states positions
 *      the account does not hold.
 *   2. INVESTMENT-EVENT CORRECTION  append the corrected row → release the old
 *      row's `externalEventId` and point it at the new one → re-attach the key.
 *      Half of that leaves `[source, externalEventId]` held by NOBODY, so the
 *      next ingest inserts a duplicate of a row it already has.
 *   3. RECONSTRUCTION PERSISTENCE  the whole instrument set for one account.
 *      Half publishes DERIVED rows for some positions while the summaries of the
 *      rest still describe the previous walk, and the residue guard reads both.
 *
 * All three decide by asking whether their client can open a transaction. A
 * `Prisma.TransactionClient` cannot, so under a tenant phase they take the
 * INLINE branch — which is RIGHT, because it makes them atomic with the enclosing
 * phase. But it is right ONLY IF A PHASE ACTUALLY WRAPS THE CALL, and when it
 * does not, nothing complains: every statement still succeeds on its own, no type
 * is violated, and the requirement is simply gone until the first partial failure
 * in production.
 *
 * So the property is MEASURED, not argued. The fake database below distinguishes
 * ATTEMPTED statements from COMMITTED ones, and the failure cases assert both
 * halves: the statements really ran (so the test cannot pass by doing nothing —
 * every positive case asserts a non-empty write set), and NONE of them survived
 * the enclosing phase's rollback. A writer that opened a transaction of its own
 * would commit the first statements before the failure and fail exactly these
 * assertions, which is what makes them worth running.
 *
 *   npx tsx lib/investments/atomicity-under-phase.test.ts
 */

import { InvestmentEventType } from "@prisma/client";

import { syncCurrentHoldings } from "./sync-current-holdings";
import { persistPlaidEvent } from "./investment-event-ingest";
import { reconstructAccount } from "./reconstruction-runner";
import type { MappedInvestmentEvent } from "./plaid-investment-events";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

/* ────────────────────────────────────────────────────────────────────────────
 * A fake database with a real transaction boundary.
 *
 * `attempted` records every statement the writer issued. `committed` records
 * only what survived. The difference between them is the entire subject of this
 * file: a statement that ran and did not commit is a statement whose atomicity
 * held.
 * ──────────────────────────────────────────────────────────────────────────── */
interface Journal {
  attempted: string[];
  committed: string[];
  begins: number;
}

function newJournal(): Journal {
  return { attempted: [], committed: [], begins: 0 };
}

/** Builds the delegate surface. `record` is how a statement reaches the journal. */
function makeStore(j: Journal, pending: { log: string[] | null }, failOn: string | null) {
  const record = (op: string) => {
    j.attempted.push(op);
    if (failOn === op) throw new Error(`induced failure at ${op}`);
    (pending.log ?? j.committed).push(op);
  };
  return record;
}

/**
 * ONE phase, the way `withTenantDb` provides one: the identity-bound transaction
 * is opened by the CALLER, the writer is handed a client that cannot open its
 * own, and a rejection rolls the whole thing back.
 */
async function inTenantPhase<T>(
  j: Journal,
  build: (record: (op: string) => void) => Record<string, unknown>,
  failOn: string | null,
  fn: (tx: never) => Promise<T>,
): Promise<T> {
  const pending: { log: string[] | null } = { log: [] };
  j.begins++;
  const record = makeStore(j, pending, failOn);
  const client = build(record);
  // ⚠️ NO `$transaction` on this object. That is what makes it a phase client,
  // and it is the only thing that makes the inline branch reachable.
  if ("$transaction" in client) throw new Error("fixture bug: the phase client must not expose $transaction");
  try {
    const out = await fn(client as never);
    j.committed.push(...(pending.log ?? []));
    pending.log = null;
    return out;
  } catch (e) {
    pending.log = null;           // rollback: nothing pending survives
    throw e;
  }
}

/* ── Site 1 — holdings reconciliation ─────────────────────────────────────── */

function holdingStore(record: (op: string) => void): Record<string, unknown> {
  return {
    holding: {
      findMany: async () => [
        { id: "h_vti",   symbol: "VTI", name: "Vanguard Total", quantity: 1,  price: 100, value: 100, change24h: 0, currency: "USD" },
        { id: "h_stale", symbol: "OLD", name: "Sold Out",       quantity: 3,  price: 10,  value: 30,  change24h: 0, currency: "USD" },
      ],
      deleteMany: async () => { record("holding.deleteMany"); return { count: 1 }; },
      update:     async () => { record("holding.update"); return {}; },
      createMany: async ({ data }: { data: unknown[] }) => { record("holding.createMany"); return { count: data.length }; },
    },
  };
}

const HOLDING_PARAMS = {
  financialAccountId: "fa_1",
  plaidHoldings: [
    // VTI at a new quantity ⇒ UPDATE in place
    { security_id: "sec_vti", quantity: 4, institution_price: 110, institution_value: 440, iso_currency_code: "USD" },
    // a position Plaid now reports that we have never held ⇒ INSERT
    { security_id: "sec_new", quantity: 2, institution_price: 50,  institution_value: 100, iso_currency_code: "USD" },
    // "OLD" is absent from a COMPLETE payload ⇒ DELETE as stale
  ] as never,
  securitiesById: {
    sec_vti: { security_id: "sec_vti", ticker_symbol: "VTI", name: "Vanguard Total", type: "etf", close_price: 108, iso_currency_code: "USD" },
    sec_new: { security_id: "sec_new", ticker_symbol: "NEW", name: "New Position",   type: "etf", close_price: 49,  iso_currency_code: "USD" },
  } as never,
  accountCurrency: "USD",
  payloadComplete: true,
};

/* ── Site 2 — investment-event correction ─────────────────────────────────── */

const MAPPED: MappedInvestmentEvent = {
  type: InvestmentEventType.BUY, date: D("2026-06-03"), datetime: null,
  quantity: 9, price: 100, amount: -900, fees: 0, currency: "USD",
  source: "plaid", externalEventId: "plaid_tx_1",
  providerType: "buy", providerSubtype: "buy", providerSecurityId: "sec_vti",
  description: "Buy VTI", mapperVersion: 1,
};

function eventStore(record: (op: string) => void): Record<string, unknown> {
  return {
    investmentEvent: {
      // A row already on this key whose QUANTITY differs ⇒ a provider
      // restatement ⇒ the append + supersede path, which is the atomic one.
      findUnique: async () => ({
        // RLS-ACC-FK — the FK is part of this select now, and the fake must
        // answer it. `persistPlaidEvent` refuses to proceed when the resolved
        // row's account is unknown or differs from the ingest's: the same key is
        // tenant-wide unique, so it names a row without naming an account. This
        // fake's row belongs to the account the ingest is for, which is what
        // makes the three-statement correction below the path under test.
        id: "ev_old", financialAccountId: "fa_1",
        type: InvestmentEventType.BUY, date: D("2026-06-03"),
        quantity: 7, price: 100, amount: -700, fees: 0, currency: "USD",
        providerType: "buy", providerSubtype: "buy", providerSecurityId: "sec_vti",
        description: "Buy VTI", instrumentId: "inst_vti",
      }),
      create: async () => { record("investmentEvent.create"); return { id: "ev_new" }; },
      update: async ({ where }: { where: { id: string } }) => {
        record(where.id === "ev_old" ? "investmentEvent.release" : "investmentEvent.reattach");
        return {};
      },
    },
  };
}

/* ── Site 3 — reconstruction persistence (per-account instrument set) ─────── */

function reconstructionStore(record: (op: string) => void, failInstrument: string | null): Record<string, unknown> {
  const anchor = (instrumentId: string, quantity: number) =>
    ({ id: `obs_${instrumentId}`, instrumentId, date: D("2026-07-11"), quantity, isCash: false, currency: "USD" });
  const event = (instrumentId: string, quantity: number) =>
    ({ id: `ev_${instrumentId}`, source: "plaid", externalEventId: `x_${instrumentId}`, date: D("2026-06-03"),
       type: InvestmentEventType.BUY, instrumentId, quantity, amount: null, currency: "USD", ratio: null, relatedInstrumentId: null });
  return {
    positionObservation: {
      findMany: async () => [anchor("TQQQ", 42.5), anchor("VTI", 10)],
      deleteMany: async () => { record("derived.deleteMany"); return { count: 0 }; },
      createMany: async ({ data }: { data: unknown[] }) => { record("derived.createMany"); return { count: data.length }; },
    },
    investmentEvent: { findMany: async () => [event("TQQQ", 7.5), event("VTI", 4)] },
    investmentEventCoverage: {
      findFirst: async () => null,
      aggregate: async () => ({ _min: { earliestReturnedDate: null } }),
    },
    instrument: { findMany: async () => [] },
    corporateActionTerms: { findMany: async () => [] },
    positionReconstruction: {
      findMany: async () => [],
      upsert: async ({ where }: { where: { financialAccountId_instrumentId: { instrumentId: string } } }) => {
        const instrumentId = where.financialAccountId_instrumentId.instrumentId;
        if (failInstrument === instrumentId) { record("summary.upsert"); throw new Error(`induced failure on ${instrumentId}`); }
        record("summary.upsert");
        return {};
      },
    },
  };
}

async function main(): Promise<void> {
  process.env.INVESTMENT_RECONSTRUCTION_ENABLED = "true";

  // ── 1. HOLDINGS RECONCILIATION ────────────────────────────────────────────
  console.log("1. holdings reconciliation — insert / update / remove-stale as ONE unit");
  {
    const j = newJournal();
    const counts = await inTenantPhase(j, holdingStore, null, (tx) => syncCurrentHoldings(tx, HOLDING_PARAMS));
    // NON-VACUOUS: the fixture must really have produced all three statements,
    // or "they all committed together" would be true of an empty set.
    check("the plan genuinely contains all three statements (1 delete, 1 update, 1 insert)",
      counts.removed === 1 && counts.updated === 1 && counts.inserted === 1,
      JSON.stringify(counts));
    check("all three ran",
      j.attempted.join(",") === "holding.deleteMany,holding.update,holding.createMany", j.attempted.join(","));
    check("all three committed with the enclosing phase", j.committed.length === 3);
    check("exactly ONE transaction boundary existed, and the PHASE owned it", j.begins === 1);
  }
  {
    // The discriminating case. The insert fails after the delete and the update
    // have already run. If the writer had opened its own transaction, those two
    // would be committed by now and the projection would be missing a holding
    // the account still holds.
    const j = newJournal();
    let threw: unknown = null;
    try {
      await inTenantPhase(j, holdingStore, "holding.createMany", (tx) => syncCurrentHoldings(tx, HOLDING_PARAMS));
    } catch (e) { threw = e; }
    check("a mid-plan failure propagates out of the writer (it does not swallow it)",
      threw instanceof Error && /induced failure/.test((threw as Error).message));
    check("the earlier statements HAD run", j.attempted.length === 3, j.attempted.join(","));
    check("…and NONE of them survived the phase's rollback", j.committed.length === 0, j.committed.join(","));
  }

  // ── 2. INVESTMENT-EVENT CORRECTION ────────────────────────────────────────
  console.log("\n2. investment-event correction — append + supersede as ONE unit");
  {
    const j = newJournal();
    const outcome = await inTenantPhase(j, eventStore, null, (tx) =>
      persistPlaidEvent(tx, "fa_1", "inst_vti", MAPPED));
    check("the material change really took the CORRECTION path", outcome === "corrected", String(outcome));
    check("append → release the key → re-attach it, in that order",
      j.attempted.join(",") === "investmentEvent.create,investmentEvent.release,investmentEvent.reattach",
      j.attempted.join(","));
    check("all three committed with the enclosing phase", j.committed.length === 3);
    check("exactly ONE transaction boundary existed, and the PHASE owned it", j.begins === 1);
  }
  {
    // Fail on the re-attach. Non-atomically this is the worst of the three
    // outcomes: the old row has released `externalEventId` and the new one never
    // took it, so the unique key is held by nobody and the next ingest inserts a
    // duplicate of a row the system already has.
    const j = newJournal();
    let threw: unknown = null;
    try {
      await inTenantPhase(j, eventStore, "investmentEvent.reattach", (tx) =>
        persistPlaidEvent(tx, "fa_1", "inst_vti", MAPPED));
    } catch (e) { threw = e; }
    check("the failure propagates out of the writer", threw instanceof Error);
    check("the append and the release HAD run", j.attempted.length === 3, j.attempted.join(","));
    check("…and the key is never left orphaned: nothing committed", j.committed.length === 0, j.committed.join(","));
  }

  // ── 3. RECONSTRUCTION PERSISTENCE ─────────────────────────────────────────
  console.log("\n3. reconstruction persistence — the account's whole instrument set as ONE unit");
  {
    const j = newJournal();
    const m = await inTenantPhase(j, (r) => reconstructionStore(r, null), null, (tx) =>
      reconstructAccount(tx, { financialAccountId: "fa_1", now: D("2026-07-11") }));
    check("the fixture really reconstructed TWO instruments (not a vacuous empty set)",
      m.status === "ok" && m.instruments === 2, JSON.stringify(m));
    check("both instruments were persisted", j.attempted.filter((o) => o === "summary.upsert").length === 2);
    check("every statement committed with the enclosing phase",
      j.committed.length === j.attempted.length && j.committed.length >= 4, j.committed.join(","));
    check("exactly ONE transaction boundary existed, and the PHASE owned it", j.begins === 1);
  }
  {
    // The second instrument's summary fails. Non-atomically, the first
    // instrument's DERIVED rows and summary are already committed and the
    // account is left half-reconstructed.
    const j = newJournal();
    let threw: unknown = null;
    try {
      await inTenantPhase(j, (r) => reconstructionStore(r, "VTI"), null, (tx) =>
        reconstructAccount(tx, { financialAccountId: "fa_1", now: D("2026-07-11") }));
    } catch (e) { threw = e; }
    check("the failure propagates out of the runner", threw instanceof Error);
    check("the FIRST instrument's rows and summary HAD been written",
      j.attempted.filter((o) => o === "summary.upsert").length >= 1 && j.attempted.includes("derived.createMany"),
      j.attempted.join(","));
    check("…and the account is not left half-reconstructed: nothing committed",
      j.committed.length === 0, j.committed.join(","));
  }

  // ── 4. THE SAME WRITERS, GIVEN A ROOT CLIENT, STILL OPEN THEIR OWN ────────
  //
  // The mirror half. A writer that is the outermost thing in the call stack has
  // nobody to be atomic with, so it must open the transaction itself — and a
  // "fix" that deleted the root branch would pass every assertion above.
  console.log("\n4. the mirror — a ROOT client makes the writer open exactly one transaction itself");
  {
    const j = newJournal();
    const pending: { log: string[] | null } = { log: null };
    const record = makeStore(j, pending, null);
    const store = holdingStore(record);
    const root = {
      ...store,
      async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        j.begins++;
        pending.log = [];
        try {
          const out = await fn(root);
          j.committed.push(...(pending.log ?? []));
          pending.log = null;
          return out;
        } catch (e) { pending.log = null; throw e; }
      },
    };
    await syncCurrentHoldings(root as never, HOLDING_PARAMS);
    check("the writer opened exactly one transaction of its own", j.begins === 1);
    check("all three statements ran inside it and committed",
      j.attempted.length === 3 && j.committed.length === 3, `${j.attempted.length}/${j.committed.length}`);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll atomicity-under-phase checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
