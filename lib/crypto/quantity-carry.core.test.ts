/**
 * lib/crypto/quantity-carry.core.test.ts
 *
 * V26-CRYPTO-QTY-1 — the constant-quantity carry guard. Standalone tsx, pure.
 *
 * The filtering predicates (wallet scope, BTC currency, POSTED, not-deleted) are
 * the BINDING's responsibility and are asserted as such here: cases H/G/I feed
 * the guard the event list those predicates would actually produce, which is the
 * honest unit boundary — the pure decision takes dates and nothing else.
 */

import { licenseConstantQuantityCarry, blocksCarry } from "./quantity-carry.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** The incident's real shape: anchor at the sync date, last event 2023-09-26. */
const ANCHOR = "2026-08-03";
const REAL_EVENTS = ["2023-03-24", "2023-09-26"]; // first and last of the 25

function licensed(targetISO: string, events: readonly string[] = REAL_EVENTS, anchorISO: string | null = ANCHOR): boolean {
  return licenseConstantQuantityCarry({ targetISO, anchorISO, eventDatesISO: events }).licensed;
}

function main(): void {
  console.log("V26-CRYPTO-QTY-1 — constant-quantity carry guard\n");

  // A — an event-free interval licenses the constant.
  check("A. no transactions between target and anchor → licensed",
    licensed("2025-08-03"));

  // B — a BTC INFLOW inside the interval refuses it.
  {
    const d = licenseConstantQuantityCarry({
      targetISO: "2025-08-03", anchorISO: ANCHOR, eventDatesISO: ["2026-01-15"],
    });
    check("B. BTC inflow between target and anchor → refused",
      !d.licensed && d.reason === "QUANTITY_EVENT_IN_INTERVAL");
    check("B. the blocking date is reported, not merely counted",
      !d.licensed && d.blockingDateISO === "2026-01-15");
  }

  // C/D — outflows and fees are the SAME signal to this guard: btc-sync writes a
  // signed native amount, so every settled BTC row changes the wallet balance.
  // The guard never inspects sign, which is exactly why an outflow cannot slip
  // past a rule written only for inflows.
  check("C. BTC outflow between target and anchor → refused",
    !licensed("2025-08-03", ["2026-02-01"]));
  check("D. BTC network fee between target and anchor → refused",
    !licensed("2025-08-03", ["2026-02-01"])); // fee rows are ordinary signed BTC rows

  // E — an event at or before the target does not block it. This is the
  // half-open boundary: a transaction ON the target date is already inside that
  // day's end-of-day quantity.
  check("E. transaction strictly before the target → does not block",
    licensed("2025-08-03", ["2023-09-26"]));
  check("E. transaction ON the target date → does not block (end-of-day convention)",
    licensed("2025-08-03", ["2025-08-03"]));
  check("E. transaction one day AFTER the target → blocks",
    !licensed("2025-08-03", ["2025-08-04"]));

  // F — an event after the anchor does not block an earlier target.
  check("F. transaction after the anchor → does not block",
    licensed("2025-08-03", ["2026-09-01"]));
  check("F. transaction ON the anchor date → blocks (the observation already includes it)",
    !licensed("2025-08-03", [ANCHOR]));

  // G/H/I — rows the binding filters out never reach the guard, so they cannot
  // block. Modelled as the empty event list the binding would produce.
  check("G. pending / deleted / superseded rows are filtered out → do not block",
    licensed("2025-08-03", []));
  check("H. a different wallet's rows are filtered out → do not block",
    licensed("2025-08-03", []));
  check("I. a fiat row with no BTC amount is filtered out → do not block",
    licensed("2025-08-03", []));

  // J — two equal observed anchors with an event-free interval between them.
  check("J. event-free interval between two equal observations → licensed",
    licensed("2026-07-19") && licensed("2026-08-03"));

  // Missing anchor is a refusal, never a silent pass.
  {
    const d = licenseConstantQuantityCarry({ targetISO: "2026-01-01", anchorISO: null, eventDatesISO: [] });
    check("no anchor → refused (never silently licensed)", !d.licensed && d.reason === "NO_ANCHOR");
  }

  // K — THE CURRENT INCIDENT. Every date the regeneration will touch must be
  // licensed against the wallet's real event history.
  {
    const INCIDENT = ["2025-08-03", "2025-10-01", "2026-01-01", "2026-03-22", "2026-03-23", "2026-07-19", "2026-08-02"];
    const all = INCIDENT.every((d) => licensed(d));
    check("K. 0.24060252 is licensed for every incident date", all,
      INCIDENT.filter((d) => !licensed(d)).join(","));
    check("K. the whole priced window 2025-08-03..2026-08-02 is licensed",
      ["2025-08-03", "2025-12-31", "2026-04-15", "2026-08-02"].every((d) => licensed(d)));
  }

  // L — a synthetic FUTURE movement must retro-refuse the dates it crosses
  // rather than let them be silently restated at the new balance.
  {
    const withFuture = [...REAL_EVENTS, "2026-05-10"];
    check("L. every date the movement crosses is refused, not rewritten",
      !licensed("2025-08-03", withFuture) &&
      !licensed("2026-01-01", withFuture) &&
      !licensed("2026-05-09", withFuture));
    check("L. dates at/after the movement remain licensed (end-of-day convention)",
      licensed("2026-05-10", withFuture) && licensed("2026-08-02", withFuture));
    check("L. the same dates were licensed BEFORE the movement existed",
      licensed("2025-08-03") && licensed("2026-01-01") && licensed("2026-05-09"));
  }

  // The raw interval predicate, pinned on both ends and in both directions.
  check("blocksCarry is half-open at the earlier end", !blocksCarry("2026-01-01", "2026-01-01", "2026-06-01"));
  check("blocksCarry is closed at the later end", blocksCarry("2026-06-01", "2026-01-01", "2026-06-01"));
  check("blocksCarry is direction-agnostic", blocksCarry("2026-03-01", "2026-06-01", "2026-01-01"));
  check("blocksCarry excludes outside the interval",
    !blocksCarry("2025-12-31", "2026-01-01", "2026-06-01") && !blocksCarry("2026-06-02", "2026-01-01", "2026-06-01"));
  check("target === anchor → empty interval, not even a same-day event blocks",
    licenseConstantQuantityCarry({ targetISO: ANCHOR, anchorISO: ANCHOR, eventDatesISO: [ANCHOR, "2023-09-26"] }).licensed);

  // ── V26-S1-BTC — an incomplete ledger licenses NOTHING ──────────────────────
  //
  // This module decides by SEARCHING the event list for a blocker. The list was
  // demonstrably short: 25 of the wallet's 28 confirmed transactions. "No event
  // blocks this interval" was then an artefact of the missing rows, and every
  // date above was licensed on that basis. The check must come FIRST, before any
  // answer derived from the list.
  {
    const incomplete = { targetISO: "2026-01-01", anchorISO: ANCHOR, eventDatesISO: REAL_EVENTS, ledgerComplete: false };
    const d = licenseConstantQuantityCarry(incomplete);
    check("M. an incomplete ledger refuses even where no event blocks",
      !d.licensed && !d.licensed && d.reason === "LEDGER_INCOMPLETE");
    check("M. it outranks NO_ANCHOR — the list is untrustworthy either way",
      licenseConstantQuantityCarry({ ...incomplete, anchorISO: null }).licensed === false);
    const noAnchorReason = licenseConstantQuantityCarry({ ...incomplete, anchorISO: null });
    check("M. …and reports LEDGER_INCOMPLETE, the more fundamental refusal",
      !noAnchorReason.licensed && noAnchorReason.reason === "LEDGER_INCOMPLETE");
    check("M. an explicitly COMPLETE ledger licenses exactly as before",
      licenseConstantQuantityCarry({ ...incomplete, ledgerComplete: true }).licensed);
    check("M. an ABSENT flag is backward-compatible (licensed), never a silent refusal",
      licenseConstantQuantityCarry({ targetISO: "2026-01-01", anchorISO: ANCHOR, eventDatesISO: REAL_EVENTS }).licensed);
  }

  console.log(failures === 0 ? "\nAll quantity-carry checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
