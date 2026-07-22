/**
 * lib/investments/investment-import-commit.test.ts
 *
 * A7-4 — the investment import commit path, over a write-capturing fake client.
 * Proves: CREATE writes an InvestmentEvent with importBatchId + importedRaw +
 * mapperVersion + profile-specific source; MATCH never writes/claims; POSITION
 * rows upsert an IMPORTED PositionObservation; SKIP/FAILED count into the batch;
 * ImportBatch is kind INVESTMENT_HISTORY and finalizes with counters; imported
 * evidence supersedes a covered USER_ASSERTED opening; bounded repair is invoked;
 * preview is zero-write; flag off ⇒ disabled + no batch.
 *
 *   npx tsx lib/investments/investment-import-commit.test.ts
 */

import { ImportSource, InvestmentEventType, PositionOrigin } from "@prisma/client";
import { runInvestmentImportPipelineFromCsv } from "@/lib/imports/investments/pipeline";
import { readFileSync } from "node:fs";
import path from "node:path";
import { commitInvestmentImport, previewInvestmentImport, computeAffectedWindow } from "./investment-import-commit";
import type { NormalizedInvestmentRow } from "@/lib/imports/investments/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const FIX = path.join(process.cwd(), "lib/imports/investments/fixtures");
const genericRows = () => runInvestmentImportPipelineFromCsv(readFileSync(path.join(FIX, "generic.csv"), "utf8"), { profileKey: "csv:generic" }).rows;

interface Row { [k: string]: unknown }
function makeFake(opts: { candidates?: Row[]; priorUserOpenings?: Row[]; priorUserObs?: Row[] } = {}) {
  const w = { batch: null as Row | null, batchUpdates: [] as Row[], events: [] as Row[], observations: [] as Row[] };
  const superseded = { events: [] as string[], observations: [] as string[] };
  let evSeq = 0;
  const client: Record<string, unknown> = {
    importBatch: {
      create: async ({ data }: { data: Row }) => { w.batch = data; return { id: "batch_1" }; },
      update: async ({ data }: { data: Row }) => { w.batchUpdates.push(data); return {}; },
    },
    investmentEvent: {
      findMany: async ({ where }: { where: Row }) => (where.type === InvestmentEventType.OPENING_BALANCE ? (opts.priorUserOpenings ?? []) : (opts.candidates ?? [])),
      create: async ({ data }: { data: Row }) => { const id = `ev_${evSeq++}`; w.events.push({ id, ...data }); return { id }; },
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => { superseded.events.push(...where.id.in); return { count: where.id.in.length }; },
    },
    positionObservation: {
      upsert: async ({ create }: { create: Row }) => { w.observations.push(create); return { id: `obs_${w.observations.length}` }; },
      findMany: async () => opts.priorUserObs ?? [],
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => { superseded.observations.push(...where.id.in); return { count: where.id.in.length }; },
    },
    instrumentAlias: { findUnique: async ({ where }: { where: { provider_externalId: { externalId: string } } }) => ({ instrumentId: `inst_${where.provider_externalId.externalId}` }) },
    instrument: { findMany: async () => [], create: async () => ({ id: "inst_new" }) },
    positionReconstruction: { findMany: async () => [] },
  };
  return { client, w, superseded };
}

async function main(): Promise<void> {
  process.env.INVESTMENT_IMPORTS_ENABLED = "true";

  // ── CREATE path: events written with full provenance; batch finalized ──────
  console.log("commit: CREATE writes events with provenance; batch kind INVESTMENT_HISTORY");
  {
    const { client, w } = makeFake();
    const res = await commitInvestmentImport({
      financialAccountId: "fa1", userId: "u1", profileKey: "csv:generic", profileVersion: 1,
      source: ImportSource.CSV, resolvedColumnMapping: { profileKey: "csv:generic" }, rows: genericRows(),
      now: D("2026-07-12"), client: client as never,
    });
    check("status ok, batch created", res.status === "ok" && res.batchId === "batch_1");
    check("batch is kind INVESTMENT_HISTORY", (w.batch as Row)?.kind === "INVESTMENT_HISTORY");
    check("3 events created", w.events.length === 3 && res.counts?.create === 3);
    const ev = w.events[0];
    check("event carries importBatchId + importedRaw + mapperVersion + profile source", ev.importBatchId === "batch_1" && !!ev.importedRaw && ev.mapperVersion === 1 && ev.source === "csv:generic");
    check("event externalEventId is the row identity (broker reference)", ev.externalEventId === "REF-1");
    check("batch finalized COMPLETED with importedCount", (w.batchUpdates[0] as Row)?.status === "COMPLETED" && (w.batchUpdates[0] as Row)?.importedCount === 3);
    check("bounded repair invoked (disabled ⇒ reconstruction flag off)", res.repair?.status === "disabled");
    check("affected window exported for A9", res.affectedWindow?.financialAccountIds[0] === "fa1" && res.affectedWindow?.fromDate === "2026-05-01");
  }

  // ── MATCH path: an overlapping candidate ⇒ no write, no claim ──────────────
  console.log("commit: overlap MATCH never writes or claims");
  {
    const candidate = { id: "plaid_1", source: "plaid", externalEventId: "p1", date: D("2026-05-01"), type: InvestmentEventType.BUY, instrumentId: "inst_SPY", quantity: 3, amount: -1200, ratio: null };
    const { client, w } = makeFake({ candidates: [candidate] });
    const res = await commitInvestmentImport({
      financialAccountId: "fa1", userId: "u1", profileKey: "csv:generic", profileVersion: 1,
      source: ImportSource.CSV, resolvedColumnMapping: {}, rows: genericRows(), now: D("2026-07-12"), client: client as never,
    });
    check("Buy SPY matched the Plaid event (event count unchanged for it)", res.counts?.match === 1 && res.counts?.create === 2 && w.events.length === 2);
    check("no event written for the matched row", !w.events.some((e) => e.externalEventId === "REF-1"));
  }

  // ── POSITION rows: IMPORTED observation upserts ────────────────────────────
  console.log("commit: POSITION rows upsert IMPORTED observations");
  {
    const posRows = runInvestmentImportPipelineFromCsv(readFileSync(path.join(FIX, "positions-statement.csv"), "utf8"), { rowKindOverride: "POSITION" }).rows;
    const { client, w } = makeFake();
    const res = await commitInvestmentImport({
      financialAccountId: "fa1", userId: "u1", profileKey: "csv:schwab", profileVersion: 1,
      source: ImportSource.CSV, resolvedColumnMapping: {}, rows: posRows, now: D("2026-07-12"), client: client as never,
    });
    check("2 IMPORTED observations upserted with importBatchId", w.observations.length === 2 && w.observations.every((o) => o.origin === PositionOrigin.IMPORTED && o.importBatchId === "batch_1") && res.counts?.create === 2);
    check("cost basis carried onto the observation", w.observations[0].costBasis === 4500);
  }

  // ── Supersession: imported history covers a USER_ASSERTED opening ──────────
  console.log("commit: imported evidence supersedes a covered USER_ASSERTED opening");
  {
    const { client, superseded } = makeFake({
      priorUserOpenings: [{ id: "uo1", date: D("2026-05-01") }],
      priorUserObs: [{ id: "uobs1" }],
    });
    const res = await commitInvestmentImport({
      financialAccountId: "fa1", userId: "u1", profileKey: "csv:generic", profileVersion: 1,
      source: ImportSource.CSV, resolvedColumnMapping: {}, rows: genericRows(), now: D("2026-07-12"), client: client as never,
    });
    check("prior user opening superseded (append + supersede)", superseded.events.includes("uo1") && (res.supersededAssertions ?? 0) >= 1);
    check("prior user observation superseded", superseded.observations.includes("uobs1"));
  }

  // ── FAILED rows counted, never written ─────────────────────────────────────
  console.log("commit: FAILED rows counted into the batch, never written");
  {
    const badRow: NormalizedInvestmentRow = { lineNumber: 1, rowKind: "TRANSACTION", date: null, settlementDate: null, type: InvestmentEventType.BUY, rawAction: "Buy", symbol: "AAA", cusip: null, description: null, quantity: 1, price: null, amount: null, fees: null, currency: null, reference: null, costBasis: null, ratio: null, externalEventId: "x", importedRaw: { a: "b" }, error: "Missing date.", warnings: [] };
    const { client, w } = makeFake();
    const res = await commitInvestmentImport({ financialAccountId: "fa1", userId: "u1", profileKey: "csv:generic", profileVersion: 1, source: ImportSource.CSV, resolvedColumnMapping: {}, rows: [badRow], now: D("2026-07-12"), client: client as never });
    check("failed counted, no event written, batch COMPLETED_WITH_ERRORS", res.counts?.failed === 1 && w.events.length === 0 && (w.batchUpdates[0] as Row)?.status === "COMPLETED_WITH_ERRORS");
  }

  // ── Preview is zero-write ──────────────────────────────────────────────────
  console.log("preview: classifies with ZERO writes");
  {
    const { client, w } = makeFake();
    const preview = await previewInvestmentImport({ financialAccountId: "fa1", profileKey: "csv:generic", rows: genericRows(), client: client as never });
    check("no batch, no events, no observations written", w.batch === null && w.events.length === 0 && w.observations.length === 0);
    check("classification counts 3 CREATE", preview.counts.create === 3 && preview.rows.length === 3);
  }

  // ── Kill switch ────────────────────────────────────────────────────────────
  console.log("commit: flag off ⇒ disabled, no batch");
  delete process.env.INVESTMENT_IMPORTS_ENABLED;
  {
    const { client, w } = makeFake();
    const res = await commitInvestmentImport({ financialAccountId: "fa1", userId: "u1", profileKey: "csv:generic", profileVersion: 1, source: ImportSource.CSV, resolvedColumnMapping: {}, rows: genericRows(), client: client as never });
    check("disabled, no batch created", res.status === "disabled" && w.batch === null);
  }

  // ── computeAffectedWindow (pure) ───────────────────────────────────────────
  console.log("computeAffectedWindow");
  {
    const win = computeAffectedWindow({ financialAccountId: "fa1", instrumentIds: ["i1", "i1", "i2"], dates: ["2026-05-01", null, "2026-04-01"], toDate: "2026-07-12" });
    check("dedups instruments, fromDate = min, toDate carried", win.instrumentIds.length === 2 && win.fromDate === "2026-04-01" && win.toDate === "2026-07-12");
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll investment-import-commit checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
