/**
 * lib/imports/investments/import-validation.test.ts
 *
 * A7-6 — the wrong-file / wrong-provider / wrong-account safety core. Proves the
 * blocking/warning/confirmation behavior the ConnectionCard import UI depends on:
 *   Case 1  Coinbase export from a Schwab card ⇒ blocking mismatch.
 *   Case 2  unrelated / malformed / empty / no-records / missing-columns ⇒ blocked.
 *   Case 3  correct provider, wrong account ⇒ mismatch block.
 *   Case 4  multi-account file ⇒ block requiring independent mapping.
 *   Case 5  duplicate-only ⇒ honest, NON-blocking (safe re-import).
 *   + confidence is expressed (never a naive boolean), and identifiers are masked.
 *
 *   npx tsx lib/imports/investments/import-validation.test.ts
 */

import {
  detectInvestmentSource, checkImportCompatibility, assessImportRows,
  assessAccountMapping, maskAccountLabel,
} from "./import-validation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const SCHWAB = ["Date", "Action", "Symbol", "Description", "Quantity", "Price", "Fees & Comm", "Amount"];
const COINBASE = ["Timestamp", "Transaction Type", "Asset", "Quantity Transacted", "Spot Price Currency", "Spot Price at Transaction", "Subtotal"];
const RESUME = ["Name", "Experience", "Education", "Skills"];
const GENERIC = ["Trade Date", "Action", "Symbol", "Quantity", "Amount"];

function main(): void {
  // ── Detection + confidence ─────────────────────────────────────────────────
  console.log("source detection expresses confidence, never a naive boolean");
  {
    const s = detectInvestmentSource(SCHWAB);
    check("Schwab headers ⇒ csv:schwab, high confidence, branded", s.source === "csv:schwab" && s.confidence === "high" && s.branded && s.investmentLike);
    const c = detectInvestmentSource(COINBASE);
    check("Coinbase headers ⇒ coinbase, branded, investment-like", c.source === "coinbase" && c.branded && c.investmentLike);
    const g = detectInvestmentSource(GENERIC);
    check("generic investment headers ⇒ low-confidence generic (not a false brand)", g.investmentLike && !g.branded);
    const r = detectInvestmentSource(RESUME);
    check("résumé headers ⇒ not investment-like, confidence none", !r.investmentLike && r.confidence === "none" && r.source === "unknown");
  }

  // ── Case 1: Coinbase from a Schwab card ⇒ blocking mismatch ────────────────
  console.log("Case 1 — Coinbase export uploaded from a Schwab card");
  {
    const detection = detectInvestmentSource(COINBASE);
    const compat = checkImportCompatibility(detection, { connectionId: "item_1", institution: "Charles Schwab" });
    check("blocking mismatch, not compatible", compat.blockingMismatch && !compat.compatible);
    check("reason names both sides (Coinbase vs Schwab)", /Coinbase/.test(compat.reason) && /Schwab/.test(compat.reason));
  }
  console.log("Schwab file from the matching Schwab card ⇒ compatible");
  {
    const compat = checkImportCompatibility(detectInvestmentSource(SCHWAB), { connectionId: "item_1", institution: "Charles Schwab" });
    check("compatible, not blocking", compat.compatible && !compat.blockingMismatch && !compat.requiresConfirmation);
  }
  console.log("generic file ⇒ requires explicit confirmation (never auto-passes)");
  {
    const compat = checkImportCompatibility(detectInvestmentSource(GENERIC), { connectionId: "item_1", institution: "Charles Schwab" });
    check("not blocking but requires confirmation", !compat.blockingMismatch && compat.requiresConfirmation && !compat.compatible);
  }

  // ── Case 2: unrelated / malformed / empty / missing-columns ────────────────
  console.log("Case 2 — files with no importable investment facts are blocked");
  {
    const resume = assessImportRows({ parseError: null, investmentLike: false, missingRequired: [], totalRows: 5, invalidRows: 5, createRows: 0, matchRows: 0 });
    check("résumé (not investment-like) ⇒ not-investment, blocking", resume.verdict === "not-investment" && resume.blocking);
    const missing = assessImportRows({ parseError: "Could not resolve required column(s): symbol.", investmentLike: false, missingRequired: ["symbol"], totalRows: 0, invalidRows: 0, createRows: 0, matchRows: 0 });
    check("missing required columns ⇒ missing-columns, blocking", missing.verdict === "missing-columns" && missing.blocking);
    const malformed = assessImportRows({ parseError: "No header row found.", investmentLike: false, missingRequired: [], totalRows: 0, invalidRows: 0, createRows: 0, matchRows: 0 });
    check("unreadable/malformed ⇒ malformed-csv, blocking", malformed.verdict === "malformed-csv" && malformed.blocking);
    const empty = assessImportRows({ parseError: null, investmentLike: true, missingRequired: [], totalRows: 0, invalidRows: 0, createRows: 0, matchRows: 0 });
    check("investment-like but zero rows ⇒ no-records, blocking", empty.verdict === "no-records" && empty.blocking);
    const allBad = assessImportRows({ parseError: null, investmentLike: true, missingRequired: [], totalRows: 4, invalidRows: 4, createRows: 0, matchRows: 0 });
    check("all rows invalid ⇒ all-invalid, blocking", allBad.verdict === "all-invalid" && allBad.blocking);
  }

  // ── Case 5: duplicate-only is honest, NOT an error ─────────────────────────
  console.log("Case 5 — duplicate-only import is represented honestly (non-blocking)");
  {
    const dup = assessImportRows({ parseError: null, investmentLike: true, missingRequired: [], totalRows: 10, invalidRows: 0, createRows: 0, matchRows: 10 });
    check("all matched ⇒ duplicate-only, NOT blocking", dup.verdict === "duplicate-only" && !dup.blocking);
    const ok = assessImportRows({ parseError: null, investmentLike: true, missingRequired: [], totalRows: 10, invalidRows: 1, createRows: 6, matchRows: 3 });
    check("mixed create/match/invalid ⇒ ok, not blocking", ok.verdict === "ok" && !ok.blocking);
  }

  // ── Case 3 & 4: account safety ─────────────────────────────────────────────
  console.log("Case 3 — correct provider, wrong account ⇒ mismatch block");
  {
    const m = assessAccountMapping({ fileAccountIdentifiers: ["XXXX-4421"], targetMask: "9183" });
    check("single account not matching target mask ⇒ mismatch, blocking", m.verdict === "mismatch" && m.blocking && /4421/.test(m.reason) && /9183/.test(m.reason));
    const ok = assessAccountMapping({ fileAccountIdentifiers: ["ending 9183"], targetMask: "9183" });
    check("single account matching target mask ⇒ ok", ok.verdict === "ok" && !ok.blocking);
  }
  console.log("Case 4 — multi-account file ⇒ block requiring independent mapping");
  {
    const multi = assessAccountMapping({ fileAccountIdentifiers: ["1111", "2222", "3333"], targetMask: "1111" });
    check("multiple distinct accounts ⇒ multi-account, blocking", multi.verdict === "multi-account" && multi.blocking && /3 accounts/.test(multi.reason));
  }
  console.log("account not stated in file ⇒ unverified, requires confirmation (no silent commit)");
  {
    const u = assessAccountMapping({ fileAccountIdentifiers: [], targetMask: "9183" });
    check("no file account identifiers ⇒ unverified + requiresConfirmation", u.verdict === "unverified" && u.requiresConfirmation && !u.blocking);
  }

  // ── Masking ────────────────────────────────────────────────────────────────
  console.log("account identifiers are masked in rendered labels");
  {
    check("mask ⇒ 'account ending in 4421'", maskAccountLabel("4421") === "account ending in 4421");
    check("digits stripped to last 4", maskAccountLabel("XXXXXXXX9183") === "account ending in 9183");
    check("no mask ⇒ safe fallback (never a raw number)", maskAccountLabel(null, "Brokerage") === "Brokerage" && maskAccountLabel(null) === "this account");
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll import-validation checks passed");
}

main();
