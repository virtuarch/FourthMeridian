/**
 * lib/prices/coverage.core.test.ts
 *
 * V26-PRICE-1 — pure coverage-planner fixtures. Standalone tsx script:
 *
 *     npx tsx lib/prices/coverage.core.test.ts
 *
 * Four groups:
 *   A. Decision procedure — every state/reason/range outcome, asserted exactly.
 *   B. Determinism        — shuffle, repeat, and a frozen golden JSON.
 *   C. Invariants         — properties that must hold across EVERY case in A.
 *   D. Purity             — the planner never reads the clock.
 *
 * Calendar note: the fixture dates are real 2026 weekdays. 2026-01-05 is a
 * Monday, 2026-01-09 a Friday, 2026-01-12 a Monday, 2026-01-16 a Friday, and
 * 2026-01-19 is MLK Day — so "Friday + following Monday" and "an observation on
 * a market holiday" are modelled with genuine calendar shapes rather than
 * arbitrary strings.
 */

import { PriceBasis } from "@prisma/client";
import {
  coverageFor,
  COVERAGE_REASONS,
  type CoverageInput,
  type CoverageRange,
  type CoverageReport,
  type CoverageReason,
} from "./coverage.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Ten consecutive trading days: Mon 01-05 → Fri 01-09, Mon 01-12 → Fri 01-16.
const TRADING = [
  "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09",
  "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15", "2026-01-16",
];

const without = (dates: readonly string[], ...drop: string[]): string[] =>
  dates.filter((d) => !drop.includes(d));

function mk(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    instrumentId:     "inst_1",
    basis:            PriceBasis.RAW_CLOSE,
    calendarId:       "test-cal",
    requestedFromISO: "2026-01-05",
    requestedToISO:   "2026-01-16",
    expectedDates:    TRADING,
    observedDates:    TRADING,
    providerFloorISO: null,
    priceability:     { priceable: true },
    ...over,
  };
}

interface Case {
  name:      string;
  input:     CoverageInput;
  state:     CoverageReport["state"];
  ranges:    CoverageRange[];
  reasons:   CoverageReason[];
  counts?:   Partial<Pick<CoverageReport,
    "expectedCount" | "observedCount" | "missingCount" | "unreachableCount" | "unexpectedCount">>;
}

const CASES: Case[] = [
  // ── unavailable ────────────────────────────────────────────────────────────
  {
    name: "1. CASH instrument → unavailable, no acquisition targets",
    input: mk({ observedDates: [], priceability: { priceable: false, reason: "NOT_PRICEABLE" } }),
    state: "unavailable", ranges: [], reasons: ["NOT_PRICEABLE"],
  },
  {
    name: "2. null ticker → unavailable (NO_PROVIDER_SYMBOL)",
    input: mk({ observedDates: [], priceability: { priceable: false, reason: "NO_PROVIDER_SYMBOL" } }),
    state: "unavailable", ranges: [], reasons: ["NO_PROVIDER_SYMBOL"],
  },
  {
    name: "6. whole window below provider depth → unavailable",
    input: mk({ observedDates: [], providerFloorISO: "2026-02-01" }),
    state: "unavailable", ranges: [], reasons: ["BEFORE_PROVIDER_DEPTH"],
    counts: { unreachableCount: 10, missingCount: 0 },
  },

  // ── complete ───────────────────────────────────────────────────────────────
  {
    name: "3. window holds no expected dates → complete + NO_EXPECTED_DATES",
    input: mk({ expectedDates: [], observedDates: [] }),
    state: "complete", ranges: [], reasons: ["NO_EXPECTED_DATES"],
    counts: { expectedCount: 0 },
  },
  {
    name: "4. fully covered → complete, no reasons",
    input: mk(),
    state: "complete", ranges: [], reasons: [],
    counts: { expectedCount: 10, observedCount: 10, missingCount: 0, unreachableCount: 0 },
  },
  {
    name: "4b. complete means nothing ACTIONABLE missing (depth disclosed)",
    input: mk({ providerFloorISO: "2026-01-08", observedDates: TRADING.slice(3) }),
    state: "complete", ranges: [], reasons: ["BEFORE_PROVIDER_DEPTH"],
    counts: { unreachableCount: 3, missingCount: 0 },
  },
  {
    name: "14. observation the calendar did not expect → tripwire, state UNCHANGED",
    input: mk({ observedDates: [...TRADING, "2026-01-10"] }), // a Saturday
    state: "complete", ranges: [], reasons: ["UNEXPECTED_OBSERVATION"],
    counts: { unexpectedCount: 1, observedCount: 11 },
  },
  {
    name: "16. dates outside the window are clipped, not counted",
    input: mk({
      expectedDates: ["2025-12-31", ...TRADING, "2026-02-01"],
      observedDates: ["2025-12-30", ...TRADING, "2026-03-15"],
    }),
    state: "complete", ranges: [], reasons: [],
    counts: { expectedCount: 10, observedCount: 10, unexpectedCount: 0 },
  },
  {
    name: "17. crypto 24/7 calendar, every day covered → complete",
    input: mk({
      calendarId: "crypto-247",
      expectedDates: ["2026-01-05","2026-01-06","2026-01-07","2026-01-08","2026-01-09","2026-01-10",
                      "2026-01-11","2026-01-12","2026-01-13","2026-01-14","2026-01-15","2026-01-16"],
      observedDates: ["2026-01-05","2026-01-06","2026-01-07","2026-01-08","2026-01-09","2026-01-10",
                      "2026-01-11","2026-01-12","2026-01-13","2026-01-14","2026-01-15","2026-01-16"],
    }),
    state: "complete", ranges: [], reasons: [],
    counts: { expectedCount: 12, observedCount: 12 },
  },

  // ── partial ────────────────────────────────────────────────────────────────
  {
    name: "5. nothing observed → partial + NO_COVERAGE, one whole-window range",
    input: mk({ observedDates: [] }),
    state: "partial",
    ranges: [{ fromISO: "2026-01-05", toISO: "2026-01-16", expectedDates: 10 }],
    reasons: ["NO_COVERAGE"],
    counts: { missingCount: 10, observedCount: 0 },
  },
  {
    name: "7. partly below depth → unfillable dates excluded from ranges",
    input: mk({ observedDates: [], providerFloorISO: "2026-01-08" }),
    state: "partial",
    ranges: [{ fromISO: "2026-01-08", toISO: "2026-01-16", expectedDates: 7 }],
    reasons: ["BEFORE_PROVIDER_DEPTH", "NO_COVERAGE"],
    counts: { unreachableCount: 3, missingCount: 7 },
  },
  {
    name: "8. gap before the observed block → BEFORE_FIRST_COVERAGE",
    input: mk({ observedDates: without(TRADING, "2026-01-05", "2026-01-06") }),
    state: "partial",
    ranges: [{ fromISO: "2026-01-05", toISO: "2026-01-06", expectedDates: 2 }],
    reasons: ["BEFORE_FIRST_COVERAGE"],
  },
  {
    name: "9. gap inside the observed block → INTERIOR_GAP (the F2 tripwire)",
    input: mk({ observedDates: without(TRADING, "2026-01-07", "2026-01-08") }),
    state: "partial",
    ranges: [{ fromISO: "2026-01-07", toISO: "2026-01-08", expectedDates: 2 }],
    reasons: ["INTERIOR_GAP"],
  },
  {
    name: "10. gap after the observed block → AFTER_LAST_COVERAGE",
    input: mk({ observedDates: without(TRADING, "2026-01-15", "2026-01-16") }),
    state: "partial",
    ranges: [{ fromISO: "2026-01-15", toISO: "2026-01-16", expectedDates: 2 }],
    reasons: ["AFTER_LAST_COVERAGE"],
  },
  {
    name: "11. gaps at all three positions → 3 codes, 4 ascending ranges",
    input: mk({ observedDates: ["2026-01-06", "2026-01-09", "2026-01-14"] }),
    state: "partial",
    ranges: [
      { fromISO: "2026-01-05", toISO: "2026-01-05", expectedDates: 1 },
      { fromISO: "2026-01-07", toISO: "2026-01-08", expectedDates: 2 },
      { fromISO: "2026-01-12", toISO: "2026-01-13", expectedDates: 2 },
      { fromISO: "2026-01-15", toISO: "2026-01-16", expectedDates: 2 },
    ],
    reasons: ["BEFORE_FIRST_COVERAGE", "INTERIOR_GAP", "AFTER_LAST_COVERAGE"],
    counts: { missingCount: 7 },
  },
  {
    name: "12. Friday + following Monday → ONE range (weekend does not fragment)",
    input: mk({ observedDates: without(TRADING, "2026-01-09", "2026-01-12") }),
    state: "partial",
    ranges: [{ fromISO: "2026-01-09", toISO: "2026-01-12", expectedDates: 2 }],
    reasons: ["INTERIOR_GAP"],
  },
  {
    name: "13. a single missing date → one range with fromISO === toISO",
    input: mk({ observedDates: without(TRADING, "2026-01-07") }),
    state: "partial",
    ranges: [{ fromISO: "2026-01-07", toISO: "2026-01-07", expectedDates: 1 }],
    reasons: ["INTERIOR_GAP"],
    counts: { missingCount: 1 },
  },
];

// ── D. purity harness ────────────────────────────────────────────────────────
// Replaces the global Date with one that throws on `new Date()` and `Date.now()`
// while keeping the static parsers assertISODate depends on. If the planner ever
// grows a clock read, every case below fails loudly instead of silently becoming
// non-deterministic.
const RealDate = Date;
function withNoClock<T>(fn: () => T): T {
  const boom = (): never => { throw new Error("[test] the planner read the clock"); };
  const ctor = function (...args: unknown[]): Date {
    if (args.length === 0) boom();
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  };
  Object.assign(ctor, { parse: RealDate.parse, UTC: RealDate.UTC, now: boom });
  globalThis.Date = ctor as unknown as DateConstructor;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

function main(): void {
  const reports: CoverageReport[] = [];

  // ── A. Decision procedure ──────────────────────────────────────────────────
  console.log("A. decision procedure");
  for (const c of CASES) {
    const r = coverageFor(c.input);
    reports.push(r);
    const okState   = r.state === c.state;
    const okRanges  = eq(r.missingRanges, c.ranges);
    const okReasons = eq(r.reasons, c.reasons);
    let okCounts = true;
    for (const [k, v] of Object.entries(c.counts ?? {})) {
      if (r[k as keyof CoverageReport] !== v) okCounts = false;
    }
    check(
      c.name,
      okState && okRanges && okReasons && okCounts,
      `state=${r.state} ranges=${JSON.stringify(r.missingRanges)} reasons=${JSON.stringify(r.reasons)} ` +
      `counts={expected:${r.expectedCount},observed:${r.observedCount},missing:${r.missingCount},` +
      `unreachable:${r.unreachableCount},unexpected:${r.unexpectedCount}}`,
    );
  }

  // ── A2. Rejected input ─────────────────────────────────────────────────────
  console.log("A2. rejected input (programmer error, never smoothed)");
  {
    let threw = false;
    try { coverageFor(mk({ requestedFromISO: "2026-01-16", requestedToISO: "2026-01-05" })); }
    catch { threw = true; }
    check("18. inverted window throws", threw);

    threw = false;
    try { coverageFor(mk({ expectedDates: ["2026-1-5"] })); } catch { threw = true; }
    check("19a. malformed expected date throws", threw);

    threw = false;
    try { coverageFor(mk({ observedDates: ["not-a-date"] })); } catch { threw = true; }
    check("19b. malformed observed date throws", threw);

    threw = false;
    try { coverageFor(mk({ providerFloorISO: "2026-13-01" })); } catch { threw = true; }
    check("19c. malformed provider floor throws", threw);
  }

  // ── B. Determinism ─────────────────────────────────────────────────────────
  console.log("B. determinism");
  {
    // Shuffle + duplicate: equivalent SETS in different orders must be identical.
    const shuffle = <T,>(xs: readonly T[], seed: number): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = (i * 7 + seed * 13 + 5) % (i + 1); // deterministic, not random
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    };

    let allShuffleStable = true;
    for (const [i, c] of CASES.entries()) {
      const scrambled: CoverageInput = {
        ...c.input,
        expectedDates: shuffle([...c.input.expectedDates, ...c.input.expectedDates], i),
        observedDates: shuffle([...c.input.observedDates, ...c.input.observedDates], i + 1),
      };
      if (JSON.stringify(coverageFor(scrambled)) !== JSON.stringify(coverageFor(c.input))) {
        allShuffleStable = false;
        console.error(`      ↳ unstable under shuffle: ${c.name}`);
      }
    }
    check("shuffled + duplicated inputs → byte-identical output (all cases)", allShuffleStable);

    // Repeat: catches accidental memoization or module-level mutable state.
    const repeated = CASES.every((c) =>
      JSON.stringify(coverageFor(c.input)) === JSON.stringify(coverageFor(c.input)));
    check("repeat invocation → byte-identical output (all cases)", repeated);

    // Key order cannot vary with the branch taken — every report serializes the
    // same key sequence regardless of state.
    const keySeq = reports.map((r) => Object.keys(r).join(","));
    check("object key order identical across every state", new Set(keySeq).size === 1, keySeq[0]);

    // Golden: a frozen byte-for-byte reference. Any field added, removed,
    // renamed, or reordered fails here and must be updated CONSCIOUSLY.
    //
    // Shape: expected = 12 trading days (2026-01-05→01-21, MLK 01-19 excluded);
    // provider depth starts 01-07 (01-05, 01-06 unreachable); observed covers
    // 01-08, 01-09, 01-13→01-16, plus a stray row on the 01-19 holiday. That
    // leaves missing 01-07 (before first coverage), 01-12 (interior), and
    // 01-20→01-21 (after last) — one range each, the last merged.
    const goldenInput = mk({
      instrumentId:     "inst_golden",
      calendarId:       "us-equity",
      requestedFromISO: "2026-01-05",
      requestedToISO:   "2026-01-21",
      expectedDates: [
        "2026-01-05","2026-01-06","2026-01-07","2026-01-08","2026-01-09",
        "2026-01-12","2026-01-13","2026-01-14","2026-01-15","2026-01-16",
        "2026-01-20","2026-01-21",
      ],
      observedDates: [
        "2026-01-08","2026-01-09","2026-01-13","2026-01-14","2026-01-15","2026-01-16",
        "2026-01-19", // MLK Day — a price the calendar did not expect
      ],
      providerFloorISO: "2026-01-07",
    });
    const GOLDEN =
      '{"instrumentId":"inst_golden","basis":"RAW_CLOSE","calendarId":"us-equity",' +
      '"requestedFromISO":"2026-01-05","requestedToISO":"2026-01-21","state":"partial",' +
      '"missingRanges":[' +
        '{"fromISO":"2026-01-07","toISO":"2026-01-07","expectedDates":1},' +
        '{"fromISO":"2026-01-12","toISO":"2026-01-12","expectedDates":1},' +
        '{"fromISO":"2026-01-20","toISO":"2026-01-21","expectedDates":2}],' +
      '"expectedCount":12,"observedCount":7,"missingCount":4,"unreachableCount":2,' +
      '"unexpectedCount":1,' +
      '"reasons":["BEFORE_PROVIDER_DEPTH","BEFORE_FIRST_COVERAGE","INTERIOR_GAP",' +
      '"AFTER_LAST_COVERAGE","UNEXPECTED_OBSERVATION"]}';
    const actual = JSON.stringify(coverageFor(goldenInput));
    check("golden report is byte-identical to the frozen reference", actual === GOLDEN,
      `\n      expected ${GOLDEN}\n      actual   ${actual}`);
  }

  // ── C. Invariants across every case ────────────────────────────────────────
  console.log("C. invariants");
  {
    const iff = reports.every((r) => (r.missingRanges.length > 0) === (r.state === "partial"));
    check("missingRanges non-empty ⟺ state is partial", iff);

    const summed = reports.every((r) =>
      r.missingCount === r.missingRanges.reduce((n, x) => n + x.expectedDates, 0));
    check("missingCount === Σ range.expectedDates", summed);

    const ascending = reports.every((r) =>
      r.missingRanges.every((x, i) =>
        x.fromISO <= x.toISO && (i === 0 || x.fromISO > r.missingRanges[i - 1].toISO)));
    check("ranges ascending, well-formed, non-overlapping", ascending);

    const subsequence = reports.every((r) => {
      const idx = r.reasons.map((x) => COVERAGE_REASONS.indexOf(x));
      return idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]));
    });
    check("reasons is a strictly ordered subsequence of COVERAGE_REASONS", subsequence);

    const bounded = reports.every((r) => r.missingCount + r.unreachableCount <= r.expectedCount);
    check("missingCount + unreachableCount ≤ expectedCount", bounded);

    const explained = reports.every((r) => r.state === "complete" || r.reasons.length > 0);
    check("every non-complete report carries at least one reason", explained);

    const noTargets = reports.every((r) => r.state !== "unavailable" || r.missingRanges.length === 0);
    check("an unavailable report never lists acquisition targets", noTargets);
  }

  // ── D. Purity ──────────────────────────────────────────────────────────────
  console.log("D. purity");
  {
    let clockRead = false;
    let identical = true;
    try {
      withNoClock(() => {
        for (const [i, c] of CASES.entries()) {
          if (JSON.stringify(coverageFor(c.input)) !== JSON.stringify(reports[i])) identical = false;
        }
      });
    } catch (e) {
      clockRead = true;
      console.error(`      ↳ ${e instanceof Error ? e.message : e}`);
    }
    check("planner never constructs a Date or reads Date.now()", !clockRead);
    check("output identical with the clock removed", identical);
  }

  console.log(failures === 0 ? "\nAll coverage-planner checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
