/**
 * lib/prices/acquisition-budget.core.test.ts
 *
 * V26-PRICE-4 — budget-estimate fixtures. Standalone tsx script:
 *
 *     npx tsx lib/prices/acquisition-budget.core.test.ts
 *
 * PRICE-4 is the first slice allowed to spend provider credits, so the estimate
 * must be trustworthy before anything is spent. Two properties matter most:
 * checkpoint identity is derived from WHAT a request is (never from execution
 * order), and spend is split between evidenced and inferred history rather than
 * presented as one undifferentiated number.
 */

import {
  estimateAcquisitionBudget,
  acquisitionCheckpointId,
  type BudgetInput,
} from "./acquisition-budget.core";
import type { AcquisitionPlan } from "./acquisition-plan.core";
import type { OwnershipSegment } from "./ownership-window.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function planned(
  instrumentId: string,
  windows: Array<{ fromISO: string; toISO: string; requestDays: number }>,
  missingExpectedCount: number,
  requestedFromISO = "2023-03-24",
  requestedToISO = "2026-07-30",
): AcquisitionPlan {
  return {
    kind: "planned", instrumentId, calendarId: "crypto-247@r1",
    requestedFromISO, requestedToISO, windows, missingExpectedCount,
    requestDayCount: windows.reduce((n, w) => n + w.requestDays, 0),
    unreachableCount: 0,
  };
}

// The real local BTC shape: an inferred prefix, then a short evidenced tail.
const BTC_SEGMENTS: OwnershipSegment[] = [
  { confidence: "POSSIBLE", fromISO: "2023-03-24", toISO: "2026-07-18", days: 1213 },
  { confidence: "KNOWN",    fromISO: "2026-07-19", toISO: "2026-07-30", days: 12 },
];

function main(): void {
  // ── 1. Checkpoint identity ────────────────────────────────────────────────
  console.log("1. checkpoint identity");
  {
    const a = acquisitionCheckpointId("coingecko", "inst_btc", "2023-03-24", "2026-07-30",
      { fromISO: "2023-03-24", toISO: "2023-12-31" });
    const b = acquisitionCheckpointId("coingecko", "inst_btc", "2023-03-24", "2026-07-30",
      { fromISO: "2023-03-24", toISO: "2023-12-31" });
    check("identical requests yield identical ids", a === b);
    check("the id names provider, instrument, requested window and chunk",
      a === "coingecko|inst_btc|2023-03-24..2026-07-30|2023-03-24..2023-12-31", a);

    const differentChunk = acquisitionCheckpointId("coingecko", "inst_btc", "2023-03-24", "2026-07-30",
      { fromISO: "2024-01-01", toISO: "2024-12-30" });
    check("a different chunk is a different checkpoint", a !== differentChunk);
    const differentProvider = acquisitionCheckpointId("tiingo", "inst_btc", "2023-03-24", "2026-07-30",
      { fromISO: "2023-03-24", toISO: "2023-12-31" });
    check("the same chunk from another provider is a different checkpoint", a !== differentProvider);
    const differentRequest = acquisitionCheckpointId("coingecko", "inst_btc", "2024-01-01", "2026-07-30",
      { fromISO: "2023-03-24", toISO: "2023-12-31" });
    check("the same chunk under a different requested window is distinct", a !== differentRequest);

    // Position would have been "chunk 1 of 5"; identity must not depend on that.
    check("nothing in the id encodes ordinal position",
      !/\b(chunk|index|#)\s*\d/i.test(a) && !a.includes("of "));
  }

  // ── 2. Confidence attribution ─────────────────────────────────────────────
  console.log("2. confidence attribution");
  {
    const input: BudgetInput = {
      plan: planned("inst_btc", [
        { fromISO: "2023-03-24", toISO: "2023-12-31", requestDays: 283 },
        { fromISO: "2024-01-01", toISO: "2024-12-30", requestDays: 365 },
        { fromISO: "2026-07-27", toISO: "2026-07-30", requestDays: 4 },
      ], 652),
      segments: BTC_SEGMENTS, source: "coingecko", unknownSkippedDays: 447,
    };
    const b = estimateAcquisitionBudget([input]);

    check("requests and request days are totalled", b.totalRequests === 3 && b.totalRequestDays === 652);
    check("expected new rows come from missing EXPECTED dates, not request days",
      b.totalExpectedRows === 652);
    check("spend is split by ownership confidence, not reported as one number",
      b.totalPossibleDays === 648 && b.totalKnownDays === 4,
      `known=${b.totalKnownDays} possible=${b.totalPossibleDays}`);
    check("nothing is requested outside a known ownership segment", b.totalUnattributed === 0);
    check("UNKNOWN prehistory deliberately skipped is reported", b.totalUnknownSkipped === 447);
    check("a checkpoint id exists for every request", b.instruments[0].checkpointIds.length === 3);
    check("the provider is named", b.instruments[0].source === "coingecko");
  }

  // ── 3. A request outside every segment is flagged ─────────────────────────
  console.log("3. requests outside ownership");
  {
    const b = estimateAcquisitionBudget([{
      plan: planned("inst_x", [{ fromISO: "2022-01-01", toISO: "2022-01-10", requestDays: 10 }], 10),
      segments: BTC_SEGMENTS, source: "coingecko", unknownSkippedDays: 0,
    }]);
    check("prehistory requests surface as unattributed, never as KNOWN or POSSIBLE",
      b.totalUnattributed === 10 && b.totalKnownDays === 0 && b.totalPossibleDays === 0);
  }

  // ── 4. Zero-window plans cost nothing ─────────────────────────────────────
  console.log("4. zero-window plans");
  {
    const noop: AcquisitionPlan = {
      kind: "no-op", instrumentId: "inst_done", calendarId: "us-equity@2024-2027.r1",
      requestedFromISO: "2026-01-01", requestedToISO: "2026-07-30",
      reason: "COMPLETE", windows: [], unreachableCount: 0,
    };
    const unavailable: AcquisitionPlan = {
      kind: "unavailable", instrumentId: "inst_cash", calendarId: "none",
      requestedFromISO: "2026-01-01", requestedToISO: "2026-07-30",
      reasons: ["NOT_PRICEABLE"], windows: [],
    };
    const b = estimateAcquisitionBudget([
      { plan: noop, segments: [], source: "tiingo", unknownSkippedDays: 0 },
      { plan: unavailable, segments: [], source: null, unknownSkippedDays: 0 },
    ]);
    check("no requests, no credits, no expected rows",
      b.totalRequests === 0 && b.estimatedCredits === 0 && b.totalExpectedRows === 0);
    check("an unroutable instrument reports a null provider",
      b.instruments.find((i) => i.instrumentId === "inst_cash")?.source === null);
    check("…and no checkpoints", b.instruments.every((i) => i.checkpointIds.length === 0));
  }

  // ── 5. Credits and the retry ceiling ──────────────────────────────────────
  console.log("5. credits and worst case");
  {
    const input: BudgetInput = {
      plan: planned("inst_btc", [
        { fromISO: "2023-03-24", toISO: "2023-12-31", requestDays: 283 },
        { fromISO: "2024-01-01", toISO: "2024-12-30", requestDays: 365 },
      ], 648),
      segments: BTC_SEGMENTS, source: "coingecko", unknownSkippedDays: 0,
    };
    const one = estimateAcquisitionBudget([input]);
    check("default is one credit per request", one.estimatedCredits === 2);
    check("worst case includes the retry allowance (2 retries ⇒ ×3)",
      one.worstCaseRequests === 6 && one.worstCaseCredits === 6);

    const pricey = estimateAcquisitionBudget([input], { creditsPerRequest: 5, maxRetriesPerRequest: 1 });
    check("credits per request is configurable", pricey.estimatedCredits === 10);
    check("retry allowance is configurable", pricey.worstCaseRequests === 4 && pricey.worstCaseCredits === 20);
    check("every reported figure is an integer",
      Object.values(pricey).filter((v) => typeof v === "number").every(Number.isInteger));
  }

  // ── 6. Determinism ────────────────────────────────────────────────────────
  console.log("6. determinism");
  {
    const a: BudgetInput = {
      plan: planned("inst_aaa", [{ fromISO: "2026-07-27", toISO: "2026-07-30", requestDays: 4 }], 4),
      segments: BTC_SEGMENTS, source: "tiingo", unknownSkippedDays: 0,
    };
    const z: BudgetInput = {
      plan: planned("inst_zzz", [{ fromISO: "2026-07-27", toISO: "2026-07-30", requestDays: 4 }], 4),
      segments: BTC_SEGMENTS, source: "tiingo", unknownSkippedDays: 0,
    };
    const forward = estimateAcquisitionBudget([a, z]);
    const reverse = estimateAcquisitionBudget([z, a]);
    check("INPUT ORDER CANNOT CHANGE THE REPORT", JSON.stringify(forward) === JSON.stringify(reverse));
    check("instruments are sorted by id",
      eq(forward.instruments.map((i) => i.instrumentId), ["inst_aaa", "inst_zzz"]));
    check("repeat invocation → byte-identical",
      JSON.stringify(estimateAcquisitionBudget([a, z])) === JSON.stringify(forward));
  }

  console.log(failures === 0 ? "\nAll acquisition-budget checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
