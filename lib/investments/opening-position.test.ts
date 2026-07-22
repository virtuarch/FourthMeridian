/**
 * lib/investments/opening-position.test.ts
 *
 * A7-2 — manual opening-position assertion. Proves:
 *   1. The composite representation CLOSES a residual — an OPENING_BALANCE event
 *      of the residual quantity at the boundary flips a PARTIAL walk (residual Q)
 *      to COMPLETE (residual 0), via the real reconstruction-core seam (no DB).
 *   2. assertOpeningPosition writes the canonical pair with the right fields
 *      (OPENING_BALANCE event, source "user", no importedRaw/importBatch;
 *      USER_ASSERTED observation), append+supersedes a prior live assertion, and
 *      fires bounded repair for exactly the affected instrument.
 *   3. Kill switch: flag off ⇒ status "disabled", zero writes.
 *
 *   npx tsx lib/investments/opening-position.test.ts
 */

import { InvestmentEventType, PositionOrigin } from "@prisma/client";
import { reconstructPositions } from "./reconstruction-core";
import { assertOpeningPosition } from "./opening-position";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── A write-capturing fake client ────────────────────────────────────────────
interface Row { [k: string]: unknown }
function makeFake(seed: { priorEvents?: Row[]; priorObs?: Row[] } = {}) {
  const created = { events: [] as Row[], observations: [] as Row[] };
  const superseded = { events: [] as string[], observations: [] as string[] };
  let ev = 0, obs = 0;
  const client: Record<string, unknown> = {
    investmentEvent: {
      create: async ({ data }: { data: Row }) => { const id = `ev_new_${ev++}`; created.events.push({ id, ...data }); return { id }; },
      findMany: async () => seed.priorEvents ?? [],
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => { superseded.events.push(...where.id.in); return { count: where.id.in.length }; },
    },
    positionObservation: {
      upsert: async ({ create, update }: { create: Row; update: Row }) => { const id = `obs_new_${obs++}`; created.observations.push({ id, create, update }); return { id }; },
      findMany: async () => seed.priorObs ?? [],
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => { superseded.observations.push(...where.id.in); return { count: where.id.in.length }; },
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(client),
  };
  return { client, created, superseded };
}

async function main(): Promise<void> {
  // ── 1. Residual-closing via the real reconstruction-core walk ──────────────
  console.log("opening balance closes a reconstruction residual");
  {
    const anchor = { instrumentId: "AAA", quantity: 10, isCash: false, date: "2026-07-11", observationId: "o1" };
    const buy = { id: "e_buy", source: "plaid", externalEventId: "x1", date: "2026-06-03", type: InvestmentEventType.BUY, instrumentId: "AAA", quantity: 7.5, amount: null, currency: "USD", ratio: null };

    const before = reconstructPositions({ anchors: [anchor], events: [buy], runDate: "2026-07-11" })[0];
    check("without opening: PARTIAL, residual 2.5", before.status === "PARTIAL" && Math.abs(before.unexplainedOpeningQuantity - 2.5) <= 1e-6, JSON.stringify({ s: before.status, u: before.unexplainedOpeningQuantity }));

    const opening = { id: "e_open", source: "user", externalEventId: null, date: "2026-06-01", type: InvestmentEventType.OPENING_BALANCE, instrumentId: "AAA", quantity: 2.5, amount: null, currency: "USD", ratio: null };
    const after = reconstructPositions({ anchors: [anchor], events: [buy, opening], runDate: "2026-07-11" })[0];
    check("with opening of the residual at the boundary: COMPLETE, residual 0", after.status === "COMPLETE" && Math.abs(after.unexplainedOpeningQuantity) <= 1e-6, JSON.stringify({ s: after.status, u: after.unexplainedOpeningQuantity }));
  }

  // ── 2. Writer creates the canonical pair (flag on) ─────────────────────────
  console.log("assertOpeningPosition writes the canonical event+observation pair");
  process.env.INVESTMENT_IMPORTS_ENABLED = "true";
  {
    const { client, created } = makeFake();
    const res = await assertOpeningPosition({
      financialAccountId: "fa1", instrument: { instrumentId: "AAA" },
      date: "2026-06-01", quantity: 12.5, costBasis: 1000, userId: "u1", now: new Date("2026-07-12T00:00:00Z"), client: client as never,
    });
    check("status ok", res.status === "ok");
    check("one OPENING_BALANCE event, source user", created.events.length === 1 && created.events[0].type === InvestmentEventType.OPENING_BALANCE && created.events[0].source === "user" && created.events[0].createdByUserId === "u1");
    check("event carries no importedRaw / importBatchId (manual, not a file import)", created.events[0].importedRaw === undefined && created.events[0].importBatchId === undefined);
    check("event quantity is the signed opening", created.events[0].quantity === 12.5);
    const obs = created.observations[0];
    const oc = obs.create as Row;
    check("observation origin USER_ASSERTED, source user, costBasis carried", oc.origin === PositionOrigin.USER_ASSERTED && oc.source === "user" && oc.costBasis === 1000);
    check("no supersession on a first assertion", res.supersededEventIds?.length === 0 && res.supersededObservationIds?.length === 0);
    check("bounded repair invoked for the affected instrument (disabled ⇒ flag off)", res.repair?.status === "disabled");
  }

  // ── 3. Re-assertion append+supersedes the prior live pair ──────────────────
  console.log("re-assertion append+supersedes the prior live assertion");
  {
    const { client, created, superseded } = makeFake({ priorEvents: [{ id: "ev_old" }], priorObs: [{ id: "obs_old" }] });
    const res = await assertOpeningPosition({
      financialAccountId: "fa1", instrument: { instrumentId: "AAA" },
      date: "2026-06-02", quantity: 20, userId: "u1", now: new Date("2026-07-12T00:00:00Z"), client: client as never,
    });
    check("new pair created", created.events.length === 1 && created.observations.length === 1);
    check("prior event superseded (append + supersede, not edited)", superseded.events.includes("ev_old") && res.supersededEventIds?.includes("ev_old") === true);
    check("prior observation superseded", superseded.observations.includes("obs_old") && res.supersededObservationIds?.includes("obs_old") === true);
  }

  // ── 4. Kill switch — flag off ⇒ zero writes ────────────────────────────────
  console.log("kill switch — flag off writes nothing");
  delete process.env.INVESTMENT_IMPORTS_ENABLED;
  {
    const { client, created } = makeFake();
    const res = await assertOpeningPosition({
      financialAccountId: "fa1", instrument: { instrumentId: "AAA" },
      date: "2026-06-01", quantity: 5, userId: "u1", client: client as never,
    });
    check("status disabled", res.status === "disabled");
    check("no writes", created.events.length === 0 && created.observations.length === 0);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll opening-position checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
