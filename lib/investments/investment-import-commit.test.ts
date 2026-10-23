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
function makeFake(opts: { candidates?: Row[]; priorUserOpenings?: Row[]; priorUserObs?: Row[]; noAlias?: boolean; weakMatches?: Row[]; repairThrows?: boolean; batchRefused?: boolean } = {}) {
  const w = { batch: null as Row | null, batchUpdates: [] as Row[], events: [] as Row[], observations: [] as Row[] };
  const superseded = { events: [] as string[], observations: [] as string[] };
  let evSeq = 0;
  const client: Record<string, unknown> = {
    importBatch: {
      create: async ({ data }: { data: Row }) => { if (opts.batchRefused) throw new Error("new row violates row-level security policy"); w.batch = data; return { id: "batch_1" }; },
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
    instrumentAlias: { findUnique: async ({ where }: { where: { provider_externalId: { externalId: string } } }) => (opts.noAlias ? null : { instrumentId: `inst_${where.provider_externalId.externalId}` }) },
    instrument: { findMany: async () => opts.weakMatches ?? [], create: async () => ({ id: "inst_new" }) },
    positionReconstruction: { findMany: async () => { if (opts.repairThrows) throw new Error("repair boom"); return []; } },
  };
  return { client, w, superseded };
}

// RLS-PREP-2 — the writer takes a phase runner and an incident recorder, never
// a client. `log` records the ORDER in which phases close and incidents are
// recorded, which is the property the boundary rests on.
function authority(client: unknown, log: string[] = []) {
  const issues: { kind: string; detail?: unknown }[] = [];
  let open = 0;
  return {
    issues, log,
    tenant: async <T>(fn: (tx: never) => Promise<T>): Promise<T> => {
      open++; log.push("phase:open");
      try { const r = await fn(client as never); log.push("phase:commit"); return r; }
      catch (e) { log.push("phase:rollback"); throw e; }
      finally { open--; }
    },
    recordIssue: async (issue: { kind: string; detail?: unknown }) => {
      log.push(open === 0 ? `issue:${issue.kind}` : `issue-INSIDE-PHASE:${issue.kind}`);
      issues.push(issue);
    },
  };
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
      now: D("2026-07-12"), ...authority(client),
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
      source: ImportSource.CSV, resolvedColumnMapping: {}, rows: genericRows(), now: D("2026-07-12"), ...authority(client),
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
      source: ImportSource.CSV, resolvedColumnMapping: {}, rows: posRows, now: D("2026-07-12"), ...authority(client),
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
      source: ImportSource.CSV, resolvedColumnMapping: {}, rows: genericRows(), now: D("2026-07-12"), ...authority(client),
    });
    check("prior user opening superseded (append + supersede)", superseded.events.includes("uo1") && (res.supersededAssertions ?? 0) >= 1);
    check("prior user observation superseded", superseded.observations.includes("uobs1"));
  }

  // ── FAILED rows counted, never written ─────────────────────────────────────
  console.log("commit: FAILED rows counted into the batch, never written");
  {
    const badRow: NormalizedInvestmentRow = { lineNumber: 1, rowKind: "TRANSACTION", date: null, settlementDate: null, type: InvestmentEventType.BUY, rawAction: "Buy", symbol: "AAA", cusip: null, description: null, quantity: 1, price: null, amount: null, fees: null, currency: null, reference: null, costBasis: null, ratio: null, externalEventId: "x", importedRaw: { a: "b" }, error: "Missing date.", warnings: [] };
    const { client, w } = makeFake();
    const res = await commitInvestmentImport({ financialAccountId: "fa1", userId: "u1", profileKey: "csv:generic", profileVersion: 1, source: ImportSource.CSV, resolvedColumnMapping: {}, rows: [badRow], now: D("2026-07-12"), ...authority(client) });
    check("failed counted, no event written, batch COMPLETED_WITH_ERRORS", res.counts?.failed === 1 && w.events.length === 0 && (w.batchUpdates[0] as Row)?.status === "COMPLETED_WITH_ERRORS");
  }

  // ── RLS-PREP-2 — the authority boundary ────────────────────────────────────
  console.log("authority: row phases, telemetry after the phase, refusals raise");
  {
    // Every row whose symbol is ambiguous: no event, and each incident lands
    // strictly between phases.
    const { client, w } = makeFake({ noAlias: true, weakMatches: [{ id: "i1" }, { id: "i2" }] });
    const a = authority(client);
    const res = await commitInvestmentImport({ financialAccountId: "fa1", userId: "u1", profileKey: "csv:generic", profileVersion: 1, source: ImportSource.CSV, resolvedColumnMapping: {}, rows: genericRows(), now: D("2026-07-12"), ...a });
    const conflicts = a.issues.filter((i) => i.kind === "INSTRUMENT_IDENTITY_CONFLICT").length;
    check("ambiguous instruments are skipped, counted, and never written", conflicts >= 1 && res.counts?.skip === conflicts && w.events.every((e) => e.instrumentId === null));
    check("no incident is ever recorded while a tenant phase is open", !a.log.some((l) => l.startsWith("issue-INSIDE-PHASE")), a.log.join(","));
    check("the batch still finalizes COMPLETED_WITH_ERRORS", (w.batchUpdates[0] as Row)?.status === "COMPLETED_WITH_ERRORS");
  }
  {
    // The batch INSERT is the boundary: refused ⇒ raise, no row, no incident.
    const { client, w } = makeFake({ batchRefused: true, noAlias: true, weakMatches: [{ id: "i1" }, { id: "i2" }] });
    const a = authority(client);
    let raised = false;
    try { await commitInvestmentImport({ financialAccountId: "fa_foreign", userId: "u1", profileKey: "csv:generic", profileVersion: 1, source: ImportSource.CSV, resolvedColumnMapping: {}, rows: genericRows(), ...a }); } catch { raised = true; }
    check("a refused batch raises before any row, instrument or incident", raised && w.events.length === 0 && a.issues.length === 0 && a.log.join(",") === "phase:open,phase:rollback", a.log.join(","));
  }
  {
    // One phase per written row (+ batch, finalize, repair) — a later failure cannot unwrite an earlier row.
    const { client } = makeFake();
    const a = authority(client);
    await commitInvestmentImport({ financialAccountId: "fa1", userId: "u1", profileKey: "csv:generic", profileVersion: 1, source: ImportSource.CSV, resolvedColumnMapping: {}, rows: genericRows(), now: D("2026-07-12"), ...a });
    const phases = a.log.filter((l) => l === "phase:commit").length;
    check("batch + one phase per row + supersession + finalize + repair", phases >= 1 + 3 + 1 + 1, String(phases));
  }
  {
    process.env.INVESTMENT_RECONSTRUCTION_ENABLED = "true";
    const { client, w } = makeFake({ repairThrows: true });
    const a = authority(client);
    const res = await commitInvestmentImport({ financialAccountId: "fa1", userId: "u1", profileKey: "csv:generic", profileVersion: 1, source: ImportSource.CSV, resolvedColumnMapping: {}, rows: genericRows(), now: D("2026-07-12"), ...a });
    delete process.env.INVESTMENT_RECONSTRUCTION_ENABLED;
    check("repair failure is non-fatal: import ok, batch finalized, incident recorded after the rollback",
      res.status === "ok" && w.events.length === 3 && res.repair === undefined
      && a.log.slice(-2).join(",") === "phase:rollback,issue:INVESTMENT_DATA_PERSISTENCE_FAILED", a.log.slice(-3).join(","));
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
    const res = await commitInvestmentImport({ financialAccountId: "fa1", userId: "u1", profileKey: "csv:generic", profileVersion: 1, source: ImportSource.CSV, resolvedColumnMapping: {}, rows: genericRows(), ...authority(client) });
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
