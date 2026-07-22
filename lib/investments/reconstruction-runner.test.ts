/**
 * lib/investments/reconstruction-runner.test.ts
 *
 * A4-2 — runner tests without a real database, via a tiny in-memory fake Prisma
 * client (the row stores it needs: OBSERVED observations in, DERIVED rows +
 * summaries out). Proves: the kill switch writes nothing; a real run persists
 * DERIVED rows + a summary; the canonical-completeness write guard refuses a
 * non-A5-S1 value; and reruns are idempotent (delete-before-write). Real-data
 * replay against ingested events happens on the primary branch (plan §7).
 *
 *   npx tsx lib/investments/reconstruction-runner.test.ts
 */

import { InvestmentEventType } from "@prisma/client";
import {
  reconstructAccount,
  repairReconstructionForAccount,
  assertCanonicalCompleteness,
  RECONSTRUCTION_SOURCE,
} from "./reconstruction-runner";
import { RECONSTRUCTION_VERSION } from "./reconstruction-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

// ── Minimal in-memory fake Prisma client ─────────────────────────────────────
interface Row { [k: string]: unknown }
interface FakeOpts { existingSummaries?: Row[]; cashInstruments?: Row[] }
function makeFake(observed: Row[], events: Row[], opts: FakeOpts = {}) {
  const derivedCreated: Row[] = [];
  const summaries: Row[] = [];
  const calls = { deleteMany: 0, createMany: 0, upsert: 0 };
  const client: Record<string, unknown> = {
    positionObservation: {
      findMany: async () => observed,
      deleteMany: async () => { calls.deleteMany++; return { count: 0 }; },
      createMany: async ({ data }: { data: Row[] }) => { calls.createMany++; derivedCreated.push(...data); return { count: data.length }; },
    },
    investmentEvent: { findMany: async () => events },
    instrument: { findMany: async () => opts.cashInstruments ?? [] },
    positionReconstruction: {
      findMany: async () => opts.existingSummaries ?? [],
      upsert: async ({ create }: { create: Row }) => { calls.upsert++; summaries.push(create); return create; },
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(client),
  };
  return { client, derivedCreated, summaries, calls };
}

async function main(): Promise<void> {
  const anchor = (instrumentId: string, quantity: number, extra: Row = {}): Row =>
    ({ id: `obs_${instrumentId}`, instrumentId, date: D("2026-07-11"), quantity, isCash: false, currency: "USD", ...extra });
  const event = (instrumentId: string | null, type: InvestmentEventType, date: string, fields: Row = {}): Row =>
    ({ id: `ev_${date}_${instrumentId}`, source: "plaid", externalEventId: `x_${date}_${instrumentId}`, date: D(date), type, instrumentId, quantity: null, amount: null, currency: "USD", ratio: null, ...fields });

  // ── Kill switch off ⇒ zero writes ───────────────────────────────────────
  console.log("kill switch — flag off writes nothing");
  delete process.env.INVESTMENT_RECONSTRUCTION_ENABLED;
  {
    const f = makeFake([anchor("TQQQ", 42.5)], [event("TQQQ", InvestmentEventType.BUY, "2026-06-03", { quantity: 7.5 })]);
    const m = await reconstructAccount({ financialAccountId: "fa1", now: D("2026-07-11"), client: f.client as never });
    check("status disabled", m.status === "disabled");
    check("no DERIVED rows written", f.derivedCreated.length === 0 && f.calls.createMany === 0);
    check("no summaries written", f.summaries.length === 0 && f.calls.upsert === 0);
  }

  // ── Flag on ⇒ persists derived rows + summary, canonically ───────────────
  console.log("flag on — persists DERIVED rows + a per-position summary");
  process.env.INVESTMENT_RECONSTRUCTION_ENABLED = "true";
  {
    const f = makeFake(
      [anchor("TQQQ", 42.5)],
      [
        event("TQQQ", InvestmentEventType.BUY, "2026-06-03", { quantity: 7.5 }),
        event("TQQQ", InvestmentEventType.BUY, "2026-06-20", { quantity: 15 }),
      ],
    );
    const m = await reconstructAccount({ financialAccountId: "fa1", now: D("2026-07-11"), client: f.client as never });
    check("status ok, one instrument", m.status === "ok" && m.instruments === 1);
    check("summary written for the position", f.summaries.length === 1);
    const s = f.summaries[0];
    check("summary reconciliation PARTIAL (20 unexplained)", s.reconciliation === "PARTIAL");
    check("summary completeness is the canonical tier 'incomplete'", s.completeness === "incomplete");
    check("summary carries unexplainedOpeningQuantity = 20", Math.abs((s.unexplainedOpeningQuantity as number) - 20) <= 1e-6);
    check("summary reconstructionVersion pinned", s.reconstructionVersion === RECONSTRUCTION_VERSION);
    check("DERIVED rows written at event dates", f.derivedCreated.length === 2);
    check("every DERIVED row is origin DERIVED + source reconstruction",
      f.derivedCreated.every((r) => r.origin === "DERIVED" && r.source === RECONSTRUCTION_SOURCE));
    check("every DERIVED completeness is canonical (derived|incomplete)",
      f.derivedCreated.every((r) => r.completeness === "derived" || r.completeness === "incomplete"));
    check("delete-before-write (idempotent regenerate)", f.calls.deleteMany === 1 && f.calls.createMany === 1);
  }

  // ── Complete case ────────────────────────────────────────────────────────
  console.log("flag on — complete reconstruction stamps 'derived'");
  {
    const f = makeFake(
      [anchor("VTI", 30)],
      [
        event("VTI", InvestmentEventType.BUY, "2026-05-01", { quantity: 10 }),
        event("VTI", InvestmentEventType.BUY, "2026-06-01", { quantity: 20 }),
      ],
    );
    await reconstructAccount({ financialAccountId: "fa1", now: D("2026-07-11"), client: f.client as never });
    check("complete summary completeness = derived", f.summaries[0].completeness === "derived");
    check("complete summary reconciliation = COMPLETE", f.summaries[0].reconciliation === "COMPLETE");
  }

  // ── Bounded-repair instrument filter ─────────────────────────────────────
  console.log("instrument filter — only the named instrument is persisted");
  {
    const f = makeFake(
      [anchor("TQQQ", 10), anchor("VTI", 20)],
      [event("TQQQ", InvestmentEventType.BUY, "2026-06-01", { quantity: 10 }), event("VTI", InvestmentEventType.BUY, "2026-06-01", { quantity: 20 })],
    );
    const m = await reconstructAccount({ financialAccountId: "fa1", now: D("2026-07-11"), client: f.client as never, instrumentIds: ["VTI"] });
    check("only one instrument reconstructed", m.instruments === 1 && f.summaries.length === 1);
    check("it is the requested instrument", f.summaries[0].instrumentId === "VTI");
  }

  // ── Bounded repair (A4-3 incremental replay) ─────────────────────────────
  console.log("bounded repair — reruns only reconstructed positions touched by new events");
  {
    // TQQQ already reconstructed; a late buy arrives. Repair reruns TQQQ only.
    const f = makeFake(
      [anchor("TQQQ", 50)],
      [
        event("TQQQ", InvestmentEventType.BUY, "2026-05-01", { quantity: 20 }),
        event("TQQQ", InvestmentEventType.BUY, "2026-06-01", { quantity: 30 }), // the newly ingested event
      ],
      { existingSummaries: [{ instrumentId: "TQQQ" }] },
    );
    const m = await repairReconstructionForAccount({
      financialAccountId: "fa1", affectedInstrumentIds: ["TQQQ"], affectedCash: false, now: D("2026-07-11"), client: f.client as never,
    });
    check("repaired the affected reconstructed instrument", m.repairedInstrumentIds.includes("TQQQ") && m.instruments === 1);
    check("late event now fully explains it → COMPLETE (residual shrank to 0)", f.summaries[0].reconciliation === "COMPLETE");
  }

  console.log("bounded repair — never reconstructs a position that was never reconstructed");
  {
    const f = makeFake([anchor("NEW", 10)], [event("NEW", InvestmentEventType.BUY, "2026-06-01", { quantity: 10 })], { existingSummaries: [] });
    const m = await repairReconstructionForAccount({
      financialAccountId: "fa1", affectedInstrumentIds: ["NEW"], affectedCash: false, now: D("2026-07-11"), client: f.client as never,
    });
    check("no existing summary ⇒ repair is a no-op", m.instruments === 0 && f.summaries.length === 0 && f.calls.upsert === 0);
  }

  console.log("bounded repair — an affected instrument outside the reconstructed set is skipped");
  {
    const f = makeFake(
      [anchor("TQQQ", 10), anchor("OTHER", 5)],
      [event("TQQQ", InvestmentEventType.BUY, "2026-06-01", { quantity: 10 }), event("OTHER", InvestmentEventType.BUY, "2026-06-01", { quantity: 5 })],
      { existingSummaries: [{ instrumentId: "TQQQ" }] }, // only TQQQ was reconstructed
    );
    const m = await repairReconstructionForAccount({
      financialAccountId: "fa1", affectedInstrumentIds: ["OTHER"], affectedCash: false, now: D("2026-07-11"), client: f.client as never,
    });
    check("affected-but-unreconstructed instrument is not repaired", m.instruments === 0 && f.summaries.length === 0);
  }

  console.log("bounded repair — a touched cash-only event repairs reconstructed cash instruments");
  {
    const f = makeFake(
      [anchor("CASH_USD", 500, { isCash: true })],
      [event(null, InvestmentEventType.CONTRIBUTION, "2026-06-01", { amount: 100 })],
      { existingSummaries: [{ instrumentId: "CASH_USD" }], cashInstruments: [{ id: "CASH_USD" }] },
    );
    const m = await repairReconstructionForAccount({
      financialAccountId: "fa1", affectedInstrumentIds: [], affectedCash: true, now: D("2026-07-11"), client: f.client as never,
    });
    check("cash instrument repaired via AssetClass resolution", m.repairedInstrumentIds.includes("CASH_USD") && m.instruments === 1);
  }

  console.log("bounded repair — flag off writes nothing");
  {
    delete process.env.INVESTMENT_RECONSTRUCTION_ENABLED;
    const f = makeFake([anchor("TQQQ", 10)], [event("TQQQ", InvestmentEventType.BUY, "2026-06-01", { quantity: 10 })], { existingSummaries: [{ instrumentId: "TQQQ" }] });
    const m = await repairReconstructionForAccount({
      financialAccountId: "fa1", affectedInstrumentIds: ["TQQQ"], affectedCash: false, now: D("2026-07-11"), client: f.client as never,
    });
    check("repair disabled with the flag off", m.status === "disabled" && f.summaries.length === 0);
    process.env.INVESTMENT_RECONSTRUCTION_ENABLED = "true";
  }

  // ── Canonical write guard ────────────────────────────────────────────────
  console.log("canonical completeness guard — non-A5-S1 values are refused");
  {
    check("accepts a canonical tier", assertCanonicalCompleteness("derived") === "derived");
    let threw = false;
    try { assertCanonicalCompleteness("COMPLETE"); } catch { threw = true; }
    check("refuses a non-canonical value ('COMPLETE')", threw);
    let threw2 = false;
    try { assertCanonicalCompleteness("PARTIAL"); } catch { threw2 = true; }
    check("refuses a non-canonical value ('PARTIAL')", threw2);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll reconstruction-runner checks passed");
  process.exit(0);
}

main().catch((err) => { console.error("Test harness crashed:", err); process.exit(1); });
