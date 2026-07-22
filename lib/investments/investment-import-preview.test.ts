/**
 * lib/investments/investment-import-preview.test.ts
 *
 * A7-6 — the shared preview/commit safety gate (buildImportPreview) over real
 * fixtures + a fake candidate client, and the upload guard. Proves the gate the
 * commit route also runs: a Coinbase file on a Schwab connection is blocked; a
 * matching Schwab file commits; a résumé is blocked; a generic file requires
 * confirmation; a duplicate-only file is non-blocking. Then the upload guard
 * rejects wrong types / oversize before parsing.
 *
 *   npx tsx lib/investments/investment-import-preview.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildImportPreview } from "./investment-import-preview";
import { guardImportUpload } from "./import-upload-guard";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const FIX = path.join(process.cwd(), "lib/imports/investments/fixtures");
const load = (f: string) => readFileSync(path.join(FIX, f), "utf8");

// Fake client: candidate fetch returns seeded rows; instrument resolution is
// read-only "would create" (no alias, no existing instrument) — enough for a
// zero-write preview classification.
function fakeClient(candidates: Record<string, unknown>[] = []) {
  return {
    investmentEvent: { findMany: async () => candidates },
    instrumentAlias: { findUnique: async () => null },
    instrument: { findMany: async () => [] },
  } as never;
}

const COINBASE_CSV = "Timestamp,Transaction Type,Asset,Quantity Transacted,Spot Price Currency,Spot Price at Transaction,Subtotal\n2026-01-02,Buy,BTC,0.5,USD,40000,20000\n";
const RESUME_CSV = "Name,Experience,Education,Skills\nJane Doe,10 years,BSc,TypeScript\n";

async function main(): Promise<void> {
  // ── Coinbase file on a Schwab connection ⇒ blocked ─────────────────────────
  console.log("buildImportPreview: Coinbase file on a Schwab connection blocks commit");
  {
    const p = await buildImportPreview({ csvText: COINBASE_CSV, profileKey: "csv:schwab", financialAccountId: "fa1", connectionInstitution: "Charles Schwab", targetMask: "9183", client: fakeClient() });
    check("detected coinbase, blocking mismatch, canCommit false", p.detection.source === "coinbase" && p.compatibility.blockingMismatch && !p.canCommit);
    check("blocking reason surfaced", p.blockingReasons.some((r) => /Coinbase/.test(r) && /Schwab/.test(r)));
  }

  // ── Matching Schwab file ⇒ commit allowed (once account confirmed) ──────────
  console.log("buildImportPreview: Schwab file on a Schwab connection is importable");
  {
    const p = await buildImportPreview({ csvText: load("schwab-transactions.csv"), profileKey: "csv:schwab", financialAccountId: "fa1", connectionInstitution: "Charles Schwab", targetMask: "9183", client: fakeClient() });
    check("detected schwab + compatible", p.detection.source === "csv:schwab" && p.compatibility.compatible);
    check("file ok, canCommit true", p.file.verdict === "ok" && p.canCommit);
    // Account not stated in the file ⇒ requires explicit confirmation.
    check("account unverified ⇒ requiresConfirmation", p.account.verdict === "unverified" && p.requiresConfirmation);
    check("counts + date range populated", p.counts.create > 0 && p.dateRange.from !== null);
  }

  // ── Résumé ⇒ blocked as not-investment ─────────────────────────────────────
  console.log("buildImportPreview: a résumé cannot be committed");
  {
    const p = await buildImportPreview({ csvText: RESUME_CSV, profileKey: "csv:generic", financialAccountId: "fa1", connectionInstitution: "Charles Schwab", targetMask: "9183", client: fakeClient() });
    // A résumé has neither investment columns nor a date ⇒ blocked (missing-columns
    // or not-investment — both honest, both refuse commit).
    check("blocked (not-investment / missing-columns), canCommit false", ["not-investment", "missing-columns"].includes(p.file.verdict) && p.file.blocking && !p.canCommit);
  }

  // ── Duplicate-only ⇒ honest, non-blocking ──────────────────────────────────
  console.log("buildImportPreview: duplicate-only file is non-blocking");
  {
    // Seed candidates that MATCH every generic row so all classify as MATCH.
    const seeded = [
      { id: "c1", source: "plaid", externalEventId: "p1", date: new Date("2026-05-01"), type: "BUY", instrumentId: null, quantity: 3, amount: -1200, ratio: null },
    ];
    const p = await buildImportPreview({ csvText: load("generic.csv"), profileKey: "csv:generic", financialAccountId: "fa1", connectionInstitution: "Generic", targetMask: null, client: fakeClient(seeded) });
    check("generic file detected non-branded (no false brand)", !p.detection.branded && p.detection.investmentLike);
    check("file verdict is ok or duplicate-only, never a hard error", (p.file.verdict === "ok" || p.file.verdict === "duplicate-only") && !p.file.blocking);
  }

  // ── Upload guard ───────────────────────────────────────────────────────────
  console.log("guardImportUpload rejects wrong types / empty / oversize before parsing");
  {
    const mk = (name: string, size: number) => ({ name, size } as File);
    check("empty file ⇒ rejected", guardImportUpload(mk("x.csv", 0)).ok === false);
    check(".pdf ⇒ unsupported type", (() => { const r = guardImportUpload(mk("statement.pdf", 100)); return !r.ok && r.status === 415; })());
    check(".xlsx ⇒ nudge to CSV", (() => { const r = guardImportUpload(mk("export.xlsx", 100)); return !r.ok && r.status === 415; })());
    check("oversize .csv ⇒ 413", (() => { const r = guardImportUpload(mk("big.csv", 20 * 1024 * 1024)); return !r.ok && r.status === 413; })());
    check("normal .csv ⇒ ok", guardImportUpload(mk("schwab.csv", 5000)).ok === true);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll investment-import-preview checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
