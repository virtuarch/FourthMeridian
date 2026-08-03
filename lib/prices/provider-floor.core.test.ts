/**
 * lib/prices/provider-floor.core.test.ts
 *
 * V26-PRICE-4B/4C — provider-floor ownership licensing.
 *
 * 4B: `FinancialAccount.createdAt` is our INGESTION date, and investment
 * accounts carry no Transaction rows, so the POSSIBLE bound collapsed onto the
 * first observation. Positions demonstrably held and later sold read as UNKNOWN
 * prehistory for every day before connection.
 *
 * 4C: the original predicate refused any instrument with an acquiring event.
 * That was too strict — a later BUY does not disprove an already-positive
 * opening, it changes the quantity from its own date forward. INTC (opening 4,
 * BUY 1, observed 5) and NVDA (opening 2.0001, fractional BUYs, observed 2.003)
 * both reconcile exactly.
 *
 * The blanket refusal is replaced by a STRONGER test: the licensed interval must
 * actually resolve to the opening, which it does only once the reconstruction
 * has published its OPENING ANCHOR. Measured on the corpus, exactly the two
 * instruments this admits are the two where the anchor matters — INTC's earliest
 * row is 5 against an opening of 4, NVDA's is 2.0002 against 2.0001.
 *
 * Standalone tsx script:  npx tsx lib/prices/provider-floor.core.test.ts
 */

import {
  licenseProviderFloor, earliestPossibleBound,
  CORPORATE_ACTION_TYPES, TRANSFER_TYPES,
  type ProviderFloorCandidate,
} from "./provider-floor.core";
import { resolveOwnershipWindow } from "./ownership-window.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const FLOOR = "2025-07-31";
const CEILING = "2026-08-01";

/** The AMZN/TSLA/SPCE shape: sold, no acquisition, positive opening, anchor present. */
function candidate(over: Partial<ProviderFloorCandidate> = {}): ProviderFloorCandidate {
  return {
    financialAccountId: "acct_llc",
    instrumentId:       "INST",
    providerFloorISO:   FLOOR,
    earliestDirectISO:  "2026-07-19",
    hasPositiveObservation: true,
    hasTransfer:            false,
    hasCorporateAction:     false,
    reconciliation:             "PARTIAL",
    conflicted:                 false,
    openingQuantity:            1,
    unexplainedOpeningQuantity: 1,
    openingAnchorDateISO:       "2026-07-26",
    hasOpeningAnchor:           true,
    eventCount:                 1,
    isCashEquivalent:           false,
    ...over,
  };
}

function segmentsFor(c: ProviderFloorCandidate) {
  const d = licenseProviderFloor(c);
  const possible = earliestPossibleBound(c.earliestDirectISO, d.licensed ? [d.possibleFromISO] : []);
  const r = resolveOwnershipWindow({
    instrumentId: c.instrumentId, earliestDirectISO: c.earliestDirectISO,
    earliestPossibleISO: possible, valuationToISO: CEILING,
  });
  return r.kind === "resolved" ? r.segments : [];
}
const reason = (c: ProviderFloorCandidate) => { const d = licenseProviderFloor(c); return d.licensed ? "LICENSED" : d.reason; };

function main(): void {
  // ══ A. INTC — newly licensed ══════════════════════════════════════════════
  console.log("A. INTC — POSSIBLE[2025-07-31..2025-10-29], KNOWN from the BUY onward");
  {
    const intc = candidate({
      instrumentId: "INTC", earliestDirectISO: "2025-10-30",
      openingQuantity: 4, unexplainedOpeningQuantity: 4,
      openingAnchorDateISO: "2025-10-29", hasOpeningAnchor: true,
    });
    check("licensed despite a later BUY", reason(intc) === "LICENSED");
    const segs = segmentsFor(intc);
    const poss = segs.find((s) => s.confidence === "POSSIBLE");
    const known = segs.find((s) => s.confidence === "KNOWN");
    check("POSSIBLE starts at the provider floor", poss?.fromISO === FLOOR);
    check("POSSIBLE ends 2025-10-29 (the day before the BUY)", poss?.toISO === "2025-10-29");
    check("KNOWN starts 2025-10-30 (the BUY)", known?.fromISO === "2025-10-30");
    check("KNOWN runs to the ceiling", known?.toISO === CEILING);
    check("nothing precedes the floor", segs.every((s) => s.fromISO >= FLOOR));
    // The quantities the anchor makes resolvable are proven in
    // reconstruction-opening-anchor.test.ts (4 before the BUY, 5 after).
  }

  // ══ B. NVDA — newly licensed ══════════════════════════════════════════════
  console.log("B. NVDA — POSSIBLE[2025-07-31..2025-10-01], KNOWN from the first event");
  {
    const nvda = candidate({
      instrumentId: "NVDA", earliestDirectISO: "2025-10-02",
      openingQuantity: 2.0001, unexplainedOpeningQuantity: 2.0001,
      openingAnchorDateISO: "2025-10-01", hasOpeningAnchor: true,
    });
    check("licensed despite four later fractional BUYs", reason(nvda) === "LICENSED");
    const segs = segmentsFor(nvda);
    check("POSSIBLE[2025-07-31..2025-10-01]",
      segs.find((s) => s.confidence === "POSSIBLE")?.fromISO === FLOOR &&
      segs.find((s) => s.confidence === "POSSIBLE")?.toISO === "2025-10-01");
    check("KNOWN from 2025-10-02", segs.find((s) => s.confidence === "KNOWN")?.fromISO === "2025-10-02");
    check("a fractional opening is not lost to epsilon",
      licenseProviderFloor(candidate({ openingQuantity: 0.0406, unexplainedOpeningQuantity: 0.0406 })).licensed);
  }

  // ══ C. Group A ════════════════════════════════════════════════════════════
  console.log("C. Group A — zero opening keeps them absent before their real 2026-06-25 BUY");
  {
    for (const sym of ["APLD", "OKLO", "QBTS", "VGT", "VRT", "VST"]) {
      const c = candidate({
        instrumentId: sym, earliestDirectISO: "2026-06-25",
        reconciliation: "COMPLETE", openingQuantity: 0, unexplainedOpeningQuantity: 0,
        openingAnchorDateISO: "2026-06-24", hasOpeningAnchor: false,
      });
      check(`${sym}: refused as NO_POSITIVE_OPENING`, reason(c) === "NO_POSITIVE_OPENING");
      const segs = segmentsFor(c);
      check(`${sym}: ownership still starts 2026-06-25 and is entirely KNOWN`,
        segs.length === 1 && segs[0].confidence === "KNOWN" && segs[0].fromISO === "2026-06-25");
    }
    check("a zero opening is refused even with an anchor present",
      reason(candidate({ openingQuantity: 0, unexplainedOpeningQuantity: 0 })) === "NO_POSITIVE_OPENING");
    check("a NEGATIVE opening (the expired option) is refused",
      reason(candidate({ openingQuantity: -2, unexplainedOpeningQuantity: -2 })) === "NO_POSITIVE_OPENING");
    check("opening positive but residue zero is refused — BOTH must be positive",
      reason(candidate({ openingQuantity: 4, unexplainedOpeningQuantity: 0 })) === "NO_POSITIVE_OPENING");
    check("a non-finite opening is refused",
      reason(candidate({ openingQuantity: Number.NaN, unexplainedOpeningQuantity: 4 })) === "NO_POSITIVE_OPENING");
  }

  // ══ D. TQQQ ═══════════════════════════════════════════════════════════════
  console.log("D. TQQQ — still refused");
  {
    check("corporate action refuses before anything else can license it",
      reason(candidate({ instrumentId: "TQQQ", hasCorporateAction: true, reconciliation: "FAILED",
        openingQuantity: 20, unexplainedOpeningQuantity: 20 })) === "CORPORATE_ACTION_PRESENT");
    check("a FAILED reconstruction alone also refuses",
      reason(candidate({ reconciliation: "FAILED" })) === "RECONSTRUCTION_FAILED");
    check("a positive opening cannot rescue a FAILED walk",
      !licenseProviderFloor(candidate({ reconciliation: "FAILED", openingQuantity: 20, unexplainedOpeningQuantity: 20 })).licensed);
  }

  // ══ E. Cash ═══════════════════════════════════════════════════════════════
  console.log("E. Cash — still refused, and checked first");
  {
    check("refused", reason(candidate({ isCashEquivalent: true })) === "CASH_INSTRUMENT");
    check("a large positive cash opening cannot license it",
      reason(candidate({ isCashEquivalent: true, openingQuantity: 3557.72, unexplainedOpeningQuantity: 3557.72 })) === "CASH_INSTRUMENT");
  }

  // ══ F. Transfers and corporate actions ════════════════════════════════════
  console.log("F. Unresolved transfer / corporate-action semantics still refuse");
  {
    check("transfer refuses", reason(candidate({ hasTransfer: true })) === "TRANSFER_PRESENT");
    check("corporate action refuses", reason(candidate({ hasCorporateAction: true })) === "CORPORATE_ACTION_PRESENT");
    check("the ratified vocabularies are unchanged",
      TRANSFER_TYPES.length === 2 && CORPORATE_ACTION_TYPES.length === 4);
    check("conflicted refuses", reason(candidate({ conflicted: true })) === "RECONSTRUCTION_CONFLICTED");
  }

  // ══ G. Coverage ═══════════════════════════════════════════════════════════
  console.log("G. Missing / unreconciled / unrelated coverage still refuses");
  {
    check("no provider floor refuses", reason(candidate({ providerFloorISO: null })) === "NO_PROVIDER_FLOOR");
    check("no positive observation refuses", reason(candidate({ hasPositiveObservation: false })) === "NO_POSITIVE_OBSERVATION");
    check("a missing reconstruction refuses", reason(candidate({ reconciliation: null })) === "RECONSTRUCTION_FAILED");
    check("an unlicensed pair contributes no bound", earliestPossibleBound("2026-07-19", []) === "2026-07-19");
    check("an existing earlier bound is never narrowed",
      earliestPossibleBound("2023-03-24", [FLOOR]) === "2023-03-24");
  }

  // ══ H. Floor bound ════════════════════════════════════════════════════════
  console.log("H. No instrument is licensed before its provider floor");
  {
    const d = licenseProviderFloor(candidate({ providerFloorISO: "2025-01-15" }));
    check("a licensed decision returns exactly the floor it was given",
      d.licensed && d.possibleFromISO === "2025-01-15");
    check("MIN across licensed floors is taken", earliestPossibleBound("2026-07-19", [FLOOR, "2025-01-15"]) === "2025-01-15");
    check("a floor at/after direct evidence widens nothing",
      reason(candidate({ providerFloorISO: "2026-07-19" })) === "FLOOR_NOT_EARLIER_THAN_DIRECT");
    check("every resolved segment starts on or after the floor",
      segmentsFor(candidate()).every((s) => s.fromISO >= FLOOR));
  }

  // ══ I. Floor/event collision and the anchor requirement ═══════════════════
  console.log("I. The opening must be READABLE — anchor requirement and the floor collision");
  {
    // The 4C safety test: without a published anchor, the licensed interval
    // would resolve the POST-event quantity. Refuse until reconstruction runs.
    check("INTC without its anchor is REFUSED, not silently over-stated",
      reason(candidate({ earliestDirectISO: "2025-10-30", openingQuantity: 4, unexplainedOpeningQuantity: 4,
        openingAnchorDateISO: "2025-10-29", hasOpeningAnchor: false })) === "OPENING_ANCHOR_MISSING");
    check("...and licensed once the anchor exists",
      reason(candidate({ earliestDirectISO: "2025-10-30", openingQuantity: 4, unexplainedOpeningQuantity: 4,
        openingAnchorDateISO: "2025-10-29", hasOpeningAnchor: true })) === "LICENSED");

    // JPM's shape: the first supported event sits ON the floor, so no anchor can
    // legally exist. Direct evidence is then the floor itself, the POSSIBLE
    // interval is empty, and the floor refusal fires — no quantity earlier than
    // the floor event is ever required inside a licensed interval.
    const jpm = candidate({
      instrumentId: "JPM", earliestDirectISO: FLOOR,
      openingAnchorDateISO: "2025-07-30", hasOpeningAnchor: false,
    });
    check("JPM: anchor cannot legally exist (its date precedes the floor)",
      ("2025-07-30" < FLOOR));
    check("JPM: refused by the floor bound, not by the missing anchor",
      reason(jpm) === "FLOOR_NOT_EARLIER_THAN_DIRECT");
    check("JPM: therefore no licensed interval needs a pre-floor quantity",
      segmentsFor(jpm).every((s) => s.confidence === "KNOWN"));

    // A pair never reconstructed states no anchor date at all.
    check("a null anchor date imposes no anchor requirement",
      reason(candidate({ openingAnchorDateISO: null, hasOpeningAnchor: false })) === "LICENSED");

    // SIRI/TTWO: no events at all, so the walk anchors on the observation and
    // `opening === anchorQuantity` by construction. No anchor can exist, and
    // hold-constant from that observation already resolves the opening.
    check("an event-free reconstruction needs no anchor (SIRI/TTWO)",
      reason(candidate({ eventCount: 0, openingAnchorDateISO: "2026-08-02", hasOpeningAnchor: false,
        openingQuantity: 0.1, unexplainedOpeningQuantity: 0.1 })) === "LICENSED");
    check("...but an event-BEARING reconstruction still requires it",
      reason(candidate({ eventCount: 2, openingAnchorDateISO: "2025-10-29", hasOpeningAnchor: false,
        earliestDirectISO: "2025-10-30", openingQuantity: 4, unexplainedOpeningQuantity: 4 })) === "OPENING_ANCHOR_MISSING");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll provider-floor licensing guards passed.");
  process.exit(0);
}

main();
