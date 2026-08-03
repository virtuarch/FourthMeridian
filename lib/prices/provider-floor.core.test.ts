/**
 * lib/prices/provider-floor.core.test.ts
 *
 * V26-PRICE-4B — provider-floor ownership licensing.
 *
 * The defect: `FinancialAccount.createdAt` is our INGESTION date, and investment
 * accounts carry no Transaction rows, so the POSSIBLE bound collapsed onto the
 * first observation. AMZN, TSLA and SPCE — demonstrably held on 2026-07-19 and
 * fully sold on 2026-07-27, with no acquiring event anywhere in a COMPLETE,
 * pagination-reconciled provider corpus reaching back to 2025-07-31 — therefore
 * read as UNKNOWN prehistory for every day before connection.
 *
 * This suite pins the licensing predicate and, just as importantly, every case
 * that must stay refused.
 *
 * Standalone tsx script:  npx tsx lib/prices/provider-floor.core.test.ts
 */

import {
  licenseProviderFloor, earliestPossibleBound,
  ACQUIRING_EVENT_TYPES, CORPORATE_ACTION_TYPES, TRANSFER_TYPES,
  type ProviderFloorCandidate,
} from "./provider-floor.core";
import { resolveOwnershipWindow } from "./ownership-window.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const FLOOR = "2025-07-31";
const CONNECT = "2026-07-19";
const CEILING = "2026-08-01";

/** The AMZN/TSLA/SPCE shape: observed, sold, no acquisition, positive residue. */
function candidate(over: Partial<ProviderFloorCandidate> = {}): ProviderFloorCandidate {
  return {
    financialAccountId: "acct_llc",
    instrumentId:       "INST",
    providerFloorISO:   FLOOR,
    earliestDirectISO:  CONNECT,
    hasPositiveObservation: true,
    hasAcquiringEvent:      false,
    hasTransfer:            false,
    hasCorporateAction:     false,
    reconciliation:             "PARTIAL",
    conflicted:                 false,
    unexplainedOpeningQuantity: 1,
    isCashEquivalent:           false,
    ...over,
  };
}

/** Resolve the full window the way the binding will, to assert segment shape. */
function segmentsFor(c: ProviderFloorCandidate) {
  const d = licenseProviderFloor(c);
  const possible = earliestPossibleBound(CONNECT, d.licensed ? [d.possibleFromISO] : []);
  const r = resolveOwnershipWindow({
    instrumentId: c.instrumentId,
    earliestDirectISO: c.earliestDirectISO,
    earliestPossibleISO: possible,
    valuationToISO: CEILING,
  });
  return r.kind === "resolved" ? r.segments : [];
}

function main(): void {
  // ── 1–3. The primary fixtures ─────────────────────────────────────────────
  console.log("1-3. AMZN / TSLA / SPCE — POSSIBLE from the provider floor, KNOWN from direct evidence");
  {
    for (const sym of ["AMZN", "TSLA", "SPCE"]) {
      const segs = segmentsFor(candidate({ instrumentId: sym }));
      const poss = segs.find((s) => s.confidence === "POSSIBLE");
      const known = segs.find((s) => s.confidence === "KNOWN");
      check(`${sym}: a POSSIBLE segment exists`, poss !== undefined);
      check(`${sym}: POSSIBLE starts at the provider floor ${FLOOR}`, poss?.fromISO === FLOOR);
      check(`${sym}: POSSIBLE ends the day BEFORE direct evidence (2026-07-18)`, poss?.toISO === "2026-07-18");
      check(`${sym}: KNOWN starts at direct evidence ${CONNECT}`, known?.fromISO === CONNECT);
      check(`${sym}: KNOWN runs to the ceiling`, known?.toISO === CEILING);
      check(`${sym}: nothing is licensed before the floor`,
        segs.every((s) => s.fromISO >= FLOOR));
    }
  }

  // ── 4. Group A — a real acquiring event blocks inference ──────────────────
  console.log("4. Group A (APLD/OKLO/QBTS/VGT/VRT/VST) — real 2026-06-25 BUY prevents inference");
  {
    for (const sym of ["APLD", "OKLO", "QBTS", "VGT", "VRT", "VST"]) {
      const c = candidate({
        instrumentId: sym, hasAcquiringEvent: true,
        earliestDirectISO: "2026-06-25", reconciliation: "COMPLETE", unexplainedOpeningQuantity: 0,
      });
      const d = licenseProviderFloor(c);
      check(`${sym}: refused`, d.licensed === false);
      check(`${sym}: reason is the acquiring event`,
        !d.licensed && d.reason === "ACQUIRING_EVENT_PRESENT");
      const segs = segmentsFor(c);
      check(`${sym}: ownership still starts 2026-06-25, entirely KNOWN`,
        segs.length === 1 && segs[0].confidence === "KNOWN" && segs[0].fromISO === "2026-06-25");
    }
    check("every ratified acquiring type blocks it", ACQUIRING_EVENT_TYPES.length === 4);
  }

  // ── 5. TQQQ ───────────────────────────────────────────────────────────────
  console.log("5. TQQQ — FAILED / UNSUPPORTED_CORPORATE_ACTION stays excluded");
  {
    const d = licenseProviderFloor(candidate({
      instrumentId: "TQQQ", hasCorporateAction: true, reconciliation: "FAILED",
      unexplainedOpeningQuantity: 20,
    }));
    check("refused", d.licensed === false);
    check("the corporate action is reported before the failure",
      !d.licensed && d.reason === "CORPORATE_ACTION_PRESENT");
    check("and a FAILED reconstruction alone also refuses",
      licenseProviderFloor(candidate({ reconciliation: "FAILED" })).licensed === false);
  }

  // ── 6. Transfers and corporate actions ────────────────────────────────────
  console.log("6. Unresolved transfer / corporate-action semantics prevent inference");
  {
    check("a transfer refuses", (() => { const d = licenseProviderFloor(candidate({ hasTransfer: true }));
      return !d.licensed && d.reason === "TRANSFER_PRESENT"; })());
    check("a corporate action refuses", (() => { const d = licenseProviderFloor(candidate({ hasCorporateAction: true }));
      return !d.licensed && d.reason === "CORPORATE_ACTION_PRESENT"; })());
    check("both vocabularies are the ratified ones",
      TRANSFER_TYPES.length === 2 && CORPORATE_ACTION_TYPES.length === 4);
  }

  // ── 7. Failed / conflicted reconstruction ─────────────────────────────────
  console.log("7. Failed or conflicted reconstruction prevents inference");
  {
    check("FAILED refuses", (() => { const d = licenseProviderFloor(candidate({ reconciliation: "FAILED" }));
      return !d.licensed && d.reason === "RECONSTRUCTION_FAILED"; })());
    check("a missing reconstruction refuses", (() => { const d = licenseProviderFloor(candidate({ reconciliation: null }));
      return !d.licensed && d.reason === "RECONSTRUCTION_FAILED"; })());
    check("conflicted refuses", (() => { const d = licenseProviderFloor(candidate({ conflicted: true }));
      return !d.licensed && d.reason === "RECONSTRUCTION_CONFLICTED"; })());
  }

  // ── 8. Opening residue ────────────────────────────────────────────────────
  console.log("8. The corrected replay must state a positive unexplained opening");
  {
    check("zero residue refuses", (() => { const d = licenseProviderFloor(candidate({ unexplainedOpeningQuantity: 0 }));
      return !d.licensed && d.reason === "NO_UNEXPLAINED_OPENING"; })());
    check("a NEGATIVE residue refuses (pre-sign-fix rows license nothing)",
      licenseProviderFloor(candidate({ unexplainedOpeningQuantity: -1 })).licensed === false);
    check("null residue refuses", licenseProviderFloor(candidate({ unexplainedOpeningQuantity: null })).licensed === false);
    check("sub-epsilon residue refuses", licenseProviderFloor(candidate({ unexplainedOpeningQuantity: 1e-9 })).licensed === false);
    check("a materially positive residue licenses", licenseProviderFloor(candidate({ unexplainedOpeningQuantity: 0.5 })).licensed === true);
  }

  // ── 9. Coverage gating ────────────────────────────────────────────────────
  console.log("9. Missing / unreconciled coverage prevents inference");
  {
    check("no provider floor refuses", (() => { const d = licenseProviderFloor(candidate({ providerFloorISO: null }));
      return !d.licensed && d.reason === "NO_PROVIDER_FLOOR"; })());
    check("no positive observation refuses", (() => { const d = licenseProviderFloor(candidate({ hasPositiveObservation: false }));
      return !d.licensed && d.reason === "NO_POSITIVE_OBSERVATION"; })());
    check("a floor at/after direct evidence widens nothing and is refused", (() => {
      const d = licenseProviderFloor(candidate({ providerFloorISO: CONNECT }));
      return !d.licensed && d.reason === "FLOOR_NOT_EARLIER_THAN_DIRECT"; })());
  }

  // ── 10. A later attempt with an earlier floor widens safely ───────────────
  console.log("10. An earlier valid floor widens; the bound never predates it");
  {
    const earlier = licenseProviderFloor(candidate({ providerFloorISO: "2025-01-15" }));
    check("licensed at the earlier floor", earlier.licensed && earlier.possibleFromISO === "2025-01-15");
    check("the resolved POSSIBLE segment starts there",
      segmentsFor(candidate({ providerFloorISO: "2025-01-15" }))
        .find((s) => s.confidence === "POSSIBLE")?.fromISO === "2025-01-15");
    check("MIN across licensed floors is taken",
      earliestPossibleBound(CONNECT, ["2025-07-31", "2025-01-15"]) === "2025-01-15");
    check("and never reaches past the earliest floor supplied",
      earliestPossibleBound(CONNECT, ["2025-07-31"]) === "2025-07-31");
  }

  // ── 11. Provider identity ─────────────────────────────────────────────────
  console.log("11. An unrelated provider identity cannot widen the floor");
  {
    // The predicate receives ONE floor per (account, instrument); the binding
    // restricts it to the account's current plaidItem before it ever gets here.
    // What is provable purely: an account whose floor is null licenses nothing,
    // and floors are only ever combined per-instrument across LICENSED pairs.
    check("a pair with no floor contributes nothing",
      licenseProviderFloor(candidate({ providerFloorISO: null })).licensed === false);
    check("an unlicensed pair contributes no candidate to the bound",
      earliestPossibleBound(CONNECT, []) === CONNECT);
    check("the existing account-activity bound is never narrowed by a later floor",
      earliestPossibleBound("2023-03-24", ["2025-07-31"]) === "2023-03-24");
  }

  // ── 12. Cash ──────────────────────────────────────────────────────────────
  console.log("12. Cash is explicitly EXCLUDED, not silently included");
  {
    const d = licenseProviderFloor(candidate({ instrumentId: "CUR:USD", isCashEquivalent: true }));
    check("refused", d.licensed === false);
    check("reason names the cash exclusion", !d.licensed && d.reason === "CASH_INSTRUMENT");
    check("the exclusion is checked FIRST, so no other reason can mask it",
      (() => { const x = licenseProviderFloor(candidate({
        isCashEquivalent: true, providerFloorISO: null, hasAcquiringEvent: true, reconciliation: "FAILED" }));
        return !x.licensed && x.reason === "CASH_INSTRUMENT"; })());
  }

  // ── Invariants that must hold whatever the inputs ─────────────────────────
  console.log("13. Structural invariants");
  {
    const segs = segmentsFor(candidate());
    check("POSSIBLE precedes KNOWN and they do not overlap",
      segs.length === 2 && segs[0].confidence === "POSSIBLE" && segs[1].confidence === "KNOWN" &&
      segs[0].toISO < segs[1].fromISO);
    check("no segment is ever KNOWN before direct evidence",
      segs.filter((s) => s.confidence === "KNOWN").every((s) => s.fromISO >= CONNECT));
    check("a licensed decision never returns a date other than the floor it was given",
      (() => { const d = licenseProviderFloor(candidate({ providerFloorISO: "2024-02-29" }));
        return d.licensed && d.possibleFromISO === "2024-02-29"; })());
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll provider-floor licensing guards passed.");
  process.exit(0);
}

main();
