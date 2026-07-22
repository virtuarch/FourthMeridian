/**
 * lib/imports/investments/pipeline.test.ts
 *
 * A7-3 — the pure investment pipeline + dedupe classifier. Proves:
 *   - mapper totality (every action → canonical or UNKNOWN, never dropped);
 *   - Schwab sign conventions (buy +qty/cash-out, sell −qty/cash-in, …);
 *   - lot data preserved verbatim, never interpreted;
 *   - positions statements normalize as anchors (no type, unsigned qty, basis);
 *   - row-identity hash stability + overlapping-export stability + ordinal;
 *   - the dedupe matrix: exact / fingerprint-unique / ambiguous / none, null-
 *     amount wildcard, absolute-amount sign blindness;
 *   - no DB imports anywhere in the module family.
 *
 *   npx tsx lib/imports/investments/pipeline.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { InvestmentEventType } from "@prisma/client";
import { runInvestmentImportPipelineFromCsv } from "./pipeline";
import { decideInvestmentRowOutcome, type DedupeCandidate, type DedupeRow } from "./dedupe";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const FIX = path.join(process.cwd(), "lib/imports/investments/fixtures");
const load = (f: string) => readFileSync(path.join(FIX, f), "utf8");

function main(): void {
  // ── Schwab normalization + sign conventions ────────────────────────────────
  console.log("schwab fixture: canonical types + FM signs");
  {
    const { rows, error } = runInvestmentImportPipelineFromCsv(load("schwab-transactions.csv"), { profileKey: "csv:schwab" });
    check("no file-level error", !error, error);
    const byAction = (a: string) => rows.find((r) => r.rawAction === a)!;
    const buy = byAction("Buy");
    check("Buy → BUY, +qty, cash out", buy.type === InvestmentEventType.BUY && buy.quantity === 10 && buy.amount === -1500);
    const sell = byAction("Sell");
    check("Sell → SELL, −qty, cash in", sell.type === InvestmentEventType.SELL && sell.quantity === -5 && sell.amount === 800);
    const div = byAction("Cash Dividend");
    check("Cash Dividend → DIVIDEND, no qty, cash in", div.type === InvestmentEventType.DIVIDEND && div.quantity === null && div.amount === 25);
    const fee = byAction("Advisor Fee");
    check("Advisor Fee → FEE, no symbol (cash-only), cash out", fee.type === InvestmentEventType.FEE && fee.symbol === null && fee.amount === -30);
    const split = byAction("Stock Split");
    check("Stock Split → SPLIT with split-without-ratio warning (ratio null ⇒ recon stops)", split.type === InvestmentEventType.SPLIT && split.ratio === null && split.warnings.includes("split-without-ratio"));
    const xfer = byAction("Security Transfer");
    check("Security Transfer → TRANSFER_IN, signed +qty", xfer.type === InvestmentEventType.TRANSFER_IN && xfer.quantity === 15);
    check("every row preserved (7 in, 7 out)", rows.length === 7);
    check("importedRaw preserves the verbatim original row", buy.importedRaw["Action"] === "Buy" && buy.importedRaw["Amount"] === "-1500.00");
  }

  // ── Mapper totality: unknown actions become UNKNOWN, never dropped ──────────
  console.log("mapper totality: unknown actions preserved as UNKNOWN");
  {
    const { rows } = runInvestmentImportPipelineFromCsv(load("unknown-actions.csv"));
    check("both rows survive", rows.length === 2);
    check("every unmapped action → UNKNOWN with warning + raws", rows.every((r) => r.type === InvestmentEventType.UNKNOWN && r.warnings.includes("unmapped-action") && Object.keys(r.importedRaw).length > 0));
  }

  // ── Lot data preserved, never interpreted ──────────────────────────────────
  console.log("lot data preserved verbatim, never interpreted");
  {
    const { rows } = runInvestmentImportPipelineFromCsv(load("opening-with-lots.csv"));
    const r = rows[0];
    check("Opening Balance → OPENING_BALANCE +qty", r.type === InvestmentEventType.OPENING_BALANCE && r.quantity === 10);
    check("lot detail preserved in importedRaw, flagged, not parsed into fields", r.importedRaw["Lot Detail"] === "LOT-A:5@100;LOT-B:5@110" && r.warnings.includes("lot-data-preserved"));
  }

  // ── Positions statement → anchors (no type, unsigned qty, basis) ────────────
  console.log("positions statement normalizes as IMPORTED anchors");
  {
    const { rows, error } = runInvestmentImportPipelineFromCsv(load("positions-statement.csv"), { rowKindOverride: "POSITION" });
    check("no error (statement date + symbol resolve)", !error, error);
    check("all POSITION, no event type, unsigned qty, cost basis carried", rows.length === 2 && rows.every((r) => r.rowKind === "POSITION" && r.type === null) && rows[0].quantity === 30 && rows[0].costBasis === 4500);
  }

  // ── Row identity: hash stability + overlap + ordinal ───────────────────────
  console.log("row identity: hash stability, overlap, ordinal");
  {
    const a = runInvestmentImportPipelineFromCsv(load("schwab-transactions.csv"), { profileKey: "csv:schwab" }).rows.map((r) => r.externalEventId);
    const b = runInvestmentImportPipelineFromCsv(load("schwab-transactions.csv"), { profileKey: "csv:schwab" }).rows.map((r) => r.externalEventId);
    check("same file twice ⇒ identical ids", JSON.stringify(a) === JSON.stringify(b));
    // Overlap: a longer export (rows 1-7) shares row-1..3 ids with a shorter (rows 1-3).
    const shortCsv = load("schwab-transactions.csv").split("\n").slice(0, 4).join("\n");
    const shortIds = runInvestmentImportPipelineFromCsv(shortCsv, { profileKey: "csv:schwab" }).rows.map((r) => r.externalEventId);
    check("overlap rows keep identical hash ids in a longer export", shortIds.every((id, i) => id === a[i]));
    // Ordinal: two identical rows get distinct ids.
    const amb = runInvestmentImportPipelineFromCsv(load("ambiguous.csv")).rows.map((r) => r.externalEventId);
    check("two identical tuples ⇒ distinct ordinal-suffixed ids", amb[0] !== amb[1] && amb[0].endsWith("-0") && amb[1].endsWith("-1"));
  }

  // ── Dedupe matrix (pure core) ──────────────────────────────────────────────
  console.log("dedupe: exact / fingerprint / ambiguous / none");
  {
    const row: DedupeRow = { source: "csv:schwab", externalEventId: "conf-1", date: "2026-06-03", type: InvestmentEventType.BUY, instrumentId: "iA", quantity: 10, amount: -1500, ratio: null };
    const cand = (over: Partial<DedupeCandidate>): DedupeCandidate => ({ id: "c", source: "plaid", externalEventId: "p1", date: "2026-06-03", type: InvestmentEventType.BUY, instrumentId: "iA", quantity: 10, amount: 1500, ratio: null, ...over });

    check("exact [source, externalEventId] ⇒ MATCH", decideInvestmentRowOutcome(row, [cand({ id: "x", source: "csv:schwab", externalEventId: "conf-1" })]).outcome === "MATCH");
    check("one cross-source fingerprint ⇒ MATCH (absolute-amount sign blind)", decideInvestmentRowOutcome(row, [cand({ id: "p" })]).outcome === "MATCH");
    check("two fingerprint candidates ⇒ SKIP_AMBIGUOUS (never guess)", decideInvestmentRowOutcome(row, [cand({ id: "p1" }), cand({ id: "p2", externalEventId: "p2" })]).outcome === "SKIP_AMBIGUOUS");
    check("no candidate ⇒ CREATE", decideInvestmentRowOutcome(row, []).outcome === "CREATE");
    check("null-amount candidate is a wildcard on amount", decideInvestmentRowOutcome(row, [cand({ id: "p", amount: null })]).outcome === "MATCH");
    check("different instrument ⇒ CREATE (no false match)", decideInvestmentRowOutcome(row, [cand({ id: "p", instrumentId: "iB" })]).outcome === "CREATE");
    // Cash-only fingerprint.
    const cash: DedupeRow = { source: "csv:schwab", externalEventId: "h:zz-0", date: "2026-06-15", type: InvestmentEventType.DIVIDEND, instrumentId: null, quantity: null, amount: 25, ratio: null };
    check("cash-only fingerprint matches on |amount|", decideInvestmentRowOutcome(cash, [{ id: "pc", source: "plaid", externalEventId: "pc1", date: "2026-06-15", type: InvestmentEventType.DIVIDEND, instrumentId: null, quantity: null, amount: -25, ratio: null }]).outcome === "MATCH");
  }

  // ── No DB imports anywhere in the module family ────────────────────────────
  console.log("no DB imports in lib/imports/investments");
  {
    const dir = path.join(process.cwd(), "lib/imports/investments");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(path.join(dir, f), "utf8");
      if (src.includes('from "@/lib/db"') || /new\s+PrismaClient/.test(src)) offenders.push(f);
    }
    check("no @/lib/db import, no PrismaClient", offenders.length === 0, offenders.join(", "));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll investment-pipeline checks passed");
}

main();
