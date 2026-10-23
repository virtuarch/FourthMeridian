/**
 * lib/prices/acquisition-plan.core.test.ts
 *
 * V26-PRICE-3 — pure acquisition-planning fixtures. Standalone tsx script:
 *
 *     npx tsx lib/prices/acquisition-plan.core.test.ts
 *
 * Coverage inputs are built through the REAL PRICE-2 binding core rather than
 * hand-written CoverageReport literals, so every fixture exercises the actual
 * calendar → coverage → plan chain and cannot drift from the invariants
 * coverage.core.ts guarantees.
 *
 * Section 6 is the one that matters most: a regression for the 2026-07-15
 * failure, which asserts BOTH that the deleted block-edge reasoning would have
 * fetched nothing AND that coverage-driven planning emits the missing span.
 */

import { PriceBasis } from "@prisma/client";
import { minusDaysISO } from "./config";
import {
  resolveInstrumentCoverage,
  type InstrumentCoverage,
  type InstrumentMeta,
  type ObservedPriceDate,
} from "./coverage-binding.core";
import { planAcquisition, type AcquisitionPlan } from "./acquisition-plan.core";
import { usEquityCalendar } from "@/lib/calendar/us-equity-calendar";
import { cryptoCalendar } from "@/lib/calendar/crypto-calendar";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const EQUITY: InstrumentMeta = {
  instrumentId: "inst_eq", assetClass: "EQUITY", tickerSymbol: "AAPL",
  marketIdentifierCode: "XNAS", currency: "USD",
};
const CRYPTO: InstrumentMeta = {
  instrumentId: "inst_btc", assetClass: "CRYPTO", tickerSymbol: "BTC",
  marketIdentifierCode: null, currency: "USD",
};

const usd = (dates: readonly string[]): ObservedPriceDate[] =>
  dates.map((d) => ({ dateISO: d, currency: "USD" }));

// Mon 2026-01-05 → Fri 2026-01-16: ten consecutive US trading days, no holiday.
const W_FROM = "2026-01-05";
const W_TO   = "2026-01-16";
const TRADING = [...usEquityCalendar.expectedDates(W_FROM, W_TO)];

interface Opts {
  meta?: InstrumentMeta; observed?: ObservedPriceDate[];
  from?: string; to?: string; floor?: string | null;
}
function coverageOf(o: Opts = {}): InstrumentCoverage {
  return resolveInstrumentCoverage({
    meta:             o.meta ?? EQUITY,
    basis:            PriceBasis.RAW_CLOSE,
    requestedFromISO: o.from ?? W_FROM,
    requestedToISO:   o.to   ?? W_TO,
    observed:         o.observed ?? usd(TRADING),
    providerFloorISO: o.floor === undefined ? null : o.floor,
  });
}
function planOf(o: Opts = {}, maxDays = 365): AcquisitionPlan {
  return planAcquisition({ coverage: coverageOf(o), maxCalendarDaysPerRequest: maxDays });
}
const without = (dates: readonly string[], ...drop: string[]): string[] =>
  dates.filter((d) => !drop.includes(d));

/** Replaces global Date with one that throws on `new Date()` / `Date.now()`. */
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
  const plans: AcquisitionPlan[] = [];
  const record = <T extends AcquisitionPlan>(p: T): T => { plans.push(p); return p; };

  // ── 1. Zero-window outcomes stay distinguishable ──────────────────────────
  console.log("1. zero-window outcomes name their own cause");
  {
    const complete = record(planOf());
    check("fully covered → no-op / COMPLETE",
      complete.kind === "no-op" && complete.reason === "COMPLETE" && complete.windows.length === 0);

    // A weekend-only equity window expects nothing at all.
    const weekend = record(planOf({ from: "2026-01-10", to: "2026-01-11", observed: [] }));
    check("weekend-only equity window → no-op / NO_EXPECTED_DATES",
      weekend.kind === "no-op" && weekend.reason === "NO_EXPECTED_DATES");

    const belowDepth = record(planOf({ observed: [], floor: "2026-06-01" }));
    check("window wholly below provider depth → no-op / BEFORE_PROVIDER_DEPTH, NOT unavailable",
      belowDepth.kind === "no-op" && belowDepth.reason === "BEFORE_PROVIDER_DEPTH");
    check("…and it discloses how many dates were unreachable",
      belowDepth.kind === "no-op" && belowDepth.unreachableCount === 10);

    const cash = record(planOf({
      meta: { ...EQUITY, instrumentId: "inst_cash", assetClass: "CASH", tickerSymbol: "CUR:USD" },
      observed: [],
    }));
    check("CASH → unavailable (instrument-level, never retry)",
      cash.kind === "unavailable" && eq(cash.reasons, ["NOT_PRICEABLE"]));

    const noSym = record(planOf({ meta: { ...EQUITY, tickerSymbol: null }, observed: [] }));
    check("null symbol → unavailable / NO_PROVIDER_SYMBOL",
      noSym.kind === "unavailable" && eq(noSym.reasons, ["NO_PROVIDER_SYMBOL"]));

    const opt = record(planOf({
      meta: { ...EQUITY, assetClass: "OPTION", tickerSymbol: "NVDA260522C00232500" }, observed: [],
    }));
    check("unsupported category (OPTION) → unavailable", opt.kind === "unavailable");

    const horizon = record(planOf({ from: "2023-06-01", to: "2023-06-30", observed: [] }));
    check("pre-horizon window → calendar-unavailable, distinct from every coverage outcome",
      horizon.kind === "calendar-unavailable" && horizon.failure.code === "HORIZON_EXCEEDED");

    const foreign = record(planOf({ meta: { ...EQUITY, marketIdentifierCode: "XLON" }, observed: [] }));
    check("unknown market → calendar-unavailable / NO_CALENDAR_FOR_MARKET",
      foreign.kind === "calendar-unavailable" && foreign.failure.code === "NO_CALENDAR_FOR_MARKET");

    check("every zero-window plan still carries an empty windows array",
      plans.every((p) => Array.isArray(p.windows) && p.windows.length === 0));
    // The whole reason the result is a union: an operator must be able to tell
    // "nothing to do" from "fix the instrument" from "extend the holiday table".
    const cause = (p: AcquisitionPlan): string =>
      p.kind === "no-op"                ? `no-op/${p.reason}`
      : p.kind === "unavailable"        ? `unavailable/${p.reasons.join("+")}`
      : p.kind === "calendar-unavailable" ? `calendar-unavailable/${p.failure.code}`
      : p.kind;
    check("all seven no-window causes are mutually distinguishable",
      new Set([complete, weekend, belowDepth, cash, noSym, horizon, foreign].map(cause)).size === 7,
      [complete, weekend, belowDepth, cash, noSym, horizon, foreign].map(cause).join(" | "));
  }

  // ── 2. Gap shapes ─────────────────────────────────────────────────────────
  console.log("2. gap shapes");
  {
    const none = record(planOf({ observed: [] }));
    check("no coverage → one window spanning the whole expected span",
      none.kind === "planned" &&
      eq(none.windows, [{ fromISO: "2026-01-05", toISO: "2026-01-16", requestDays: 12 }]));
    check("…covering all 10 missing expected dates",
      none.kind === "planned" && none.missingExpectedCount === 10);

    const leading = record(planOf({ observed: usd(without(TRADING, "2026-01-05", "2026-01-06")) }));
    check("leading gap → one window at the head",
      leading.kind === "planned" &&
      eq(leading.windows, [{ fromISO: "2026-01-05", toISO: "2026-01-06", requestDays: 2 }]));

    const trailing = record(planOf({ observed: usd(without(TRADING, "2026-01-15", "2026-01-16")) }));
    check("trailing gap → one window at the tail",
      trailing.kind === "planned" &&
      eq(trailing.windows, [{ fromISO: "2026-01-15", toISO: "2026-01-16", requestDays: 2 }]));

    const interior = record(planOf({ observed: usd(without(TRADING, "2026-01-07", "2026-01-08")) }));
    check("interior gap → one window inside the block (impossible for edge arithmetic)",
      interior.kind === "planned" &&
      eq(interior.windows, [{ fromISO: "2026-01-07", toISO: "2026-01-08", requestDays: 2 }]));

    const disjoint = record(planOf({ observed: usd(["2026-01-06", "2026-01-09", "2026-01-14"]) }));
    check("multiple disjoint gaps → several ascending windows",
      disjoint.kind === "planned" && disjoint.windows.length === 4);
    check("…in ascending, non-overlapping order",
      disjoint.kind === "planned" &&
      disjoint.windows.every((w, i) => i === 0 || w.fromISO > disjoint.windows[i - 1].toISO));

    const friMon = record(planOf({ observed: usd(without(TRADING, "2026-01-09", "2026-01-12")) }));
    check("Friday+Monday → ONE request spanning the weekend, not two",
      friMon.kind === "planned" &&
      eq(friMon.windows, [{ fromISO: "2026-01-09", toISO: "2026-01-12", requestDays: 4 }]));

    const separated = record(planOf({ observed: usd(["2026-01-07"]), from: "2026-01-05", to: "2026-01-08" }));
    check("a COVERED expected date between two runs keeps them separate",
      separated.kind === "planned" &&
      eq(separated.windows, [
        { fromISO: "2026-01-05", toISO: "2026-01-06", requestDays: 2 },
        { fromISO: "2026-01-08", toISO: "2026-01-08", requestDays: 1 },
      ]));
  }

  // ── 3. Provider floor ─────────────────────────────────────────────────────
  console.log("3. provider floor");
  {
    const nullFloor = record(planOf({ observed: [] , floor: null }));
    check("null floor → everything is actionable",
      nullFloor.kind === "planned" && nullFloor.unreachableCount === 0);

    // Floor mid-window: 01-05..01-07 unreachable, 01-08.. actionable.
    const mixed = record(planOf({ observed: [], floor: "2026-01-08" }));
    check("mixed window → windows start AT the floor, never before",
      mixed.kind === "planned" && mixed.windows[0].fromISO === "2026-01-08");
    check("…unreachable dates are counted, not requested",
      mixed.kind === "planned" && mixed.unreachableCount === 3 && mixed.missingExpectedCount === 7);

    const atFirst = record(planOf({ observed: [], floor: "2026-01-05" }));
    check("floor equal to the first expected date → nothing unreachable",
      atFirst.kind === "planned" && atFirst.unreachableCount === 0 && atFirst.missingExpectedCount === 10);

    // 2026-01-11 is a Sunday — not an expected date at all.
    const nonExpected = record(planOf({ observed: [], floor: "2026-01-11" }));
    check("floor on a non-expected date behaves by ordering, not by membership",
      nonExpected.kind === "planned" && nonExpected.unreachableCount === 5 &&
      nonExpected.windows[0].fromISO === "2026-01-12");

    const completePlusPrehistory = record(planOf({
      observed: usd(TRADING.slice(3)), floor: "2026-01-08",
    }));
    check("complete reachable coverage + unreachable prehistory → no-op / COMPLETE",
      completePlusPrehistory.kind === "no-op" && completePlusPrehistory.reason === "COMPLETE");
    check("…and the prehistory is still disclosed, explaining the narrower plan",
      completePlusPrehistory.kind === "no-op" && completePlusPrehistory.unreachableCount === 3);
  }

  // ── 4. Diagnostics that must NOT create requests ──────────────────────────
  console.log("4. diagnostics that must not create requests");
  {
    // A Saturday price row for an equity: unexpected, but not a gap.
    const unexpected = record(planOf({ observed: usd([...TRADING, "2026-01-10"]) }));
    check("an unexpected observation creates no request",
      unexpected.kind === "no-op" && unexpected.reason === "COMPLETE");

    // Wrong-currency rows are dropped by the binding, so their dates ARE missing.
    const wrongCcy = record(planAcquisition({
      coverage: resolveInstrumentCoverage({
        meta: EQUITY, basis: PriceBasis.RAW_CLOSE,
        requestedFromISO: W_FROM, requestedToISO: W_TO,
        observed: [
          ...usd(without(TRADING, "2026-01-07")),
          { dateISO: "2026-01-07", currency: "EUR" },
        ],
        providerFloorISO: null,
      }),
      maxCalendarDaysPerRequest: 365,
    }));
    check("a wrong-currency row does not count as coverage, so its date IS requested",
      wrongCcy.kind === "planned" &&
      eq(wrongCcy.windows, [{ fromISO: "2026-01-07", toISO: "2026-01-07", requestDays: 1 }]));
  }

  // ── 5. Chunking ───────────────────────────────────────────────────────────
  console.log("5. chunking");
  {
    // Crypto expects every day, so calendar days and expected dates coincide.
    const CFROM = "2026-01-01", CTO = "2026-01-10"; // 10 days
    const cryptoPlan = (maxDays: number, observed: string[] = []): AcquisitionPlan =>
      planAcquisition({
        coverage: resolveInstrumentCoverage({
          meta: CRYPTO, basis: PriceBasis.RAW_CLOSE,
          requestedFromISO: CFROM, requestedToISO: CTO,
          observed: usd(observed), providerFloorISO: null,
        }),
        maxCalendarDaysPerRequest: maxDays,
      });

    const exact = record(cryptoPlan(10));
    check("range exactly at the limit → ONE chunk with inclusive endpoints",
      exact.kind === "planned" &&
      eq(exact.windows, [{ fromISO: CFROM, toISO: CTO, requestDays: 10 }]));

    const over = record(cryptoPlan(9));
    check("range one day over the limit → two chunks",
      over.kind === "planned" &&
      eq(over.windows, [
        { fromISO: "2026-01-01", toISO: "2026-01-09", requestDays: 9 },
        { fromISO: "2026-01-10", toISO: "2026-01-10", requestDays: 1 },
      ]));

    const many = record(cryptoPlan(3));
    check("several chunks, ascending", many.kind === "planned" && many.windows.length === 4);
    check("no overlap between chunks",
      many.kind === "planned" && many.windows.every((w, i) => i === 0 || w.fromISO > many.windows[i - 1].toISO));
    check("no hole between chunks (each starts the day after the previous ends)",
      many.kind === "planned" &&
      many.windows.every((w, i) => i === 0 || w.fromISO === minusDaysISO(many.windows[i - 1].toISO, -1)));
    check("chunk days sum to the whole range",
      many.kind === "planned" && many.requestDayCount === 10);

    // A covered day splits the range; a huge limit must NOT merge across it.
    const split = record(cryptoPlan(100, ["2026-01-05"]));
    check("chunks never merge across a covered expected date, even at a huge limit",
      split.kind === "planned" &&
      eq(split.windows, [
        { fromISO: "2026-01-01", toISO: "2026-01-04", requestDays: 4 },
        { fromISO: "2026-01-06", toISO: "2026-01-10", requestDays: 5 },
      ]));

    const multi = record(cryptoPlan(2, ["2026-01-05"]));
    check("multiple source ranges stay ordered after chunking",
      multi.kind === "planned" &&
      multi.windows.every((w, i) => i === 0 || w.fromISO > multi.windows[i - 1].toISO));
  }

  // ── 6. REGRESSION — the 2026-07-15 collapse ───────────────────────────────
  console.log("6. regression: 2026-07-15 front-edge coverage collapse");
  {
    // The recorded shape: a two-year historical request while the daily cron had
    // already accreted a recent block running up to the request's end date.
    const REQ_FROM = "2024-07-15", REQ_TO = "2026-07-13";
    const COVERED_FROM = "2026-06-12";
    const covered = [...usEquityCalendar.expectedDates(COVERED_FROM, REQ_TO)];
    const latestCovered = covered[covered.length - 1];

    // The DELETED resolveBackfillWindow rule, inlined so the regression proves
    // the old reasoning failed rather than merely asserting the new one works.
    const oldResumeFrom = minusDaysISO(latestCovered, -1);
    const oldWouldFetch = oldResumeFrom <= REQ_TO;
    check("the OLD resume-after-latest-covered rule would have fetched NOTHING",
      !oldWouldFetch, `oldResumeFrom=${oldResumeFrom} reqTo=${REQ_TO}`);

    const plan = record(planOf({ from: REQ_FROM, to: REQ_TO, observed: usd(covered) }));
    check("coverage-driven planning emits the gap BEHIND the front-edge block",
      plan.kind === "planned" && plan.windows.length >= 1);
    check("…starting at the requested window, not after the covered block",
      plan.kind === "planned" && plan.windows[0].fromISO === "2024-07-15");
    check("…and ending the day before the block begins",
      plan.kind === "planned" &&
      plan.windows[plan.windows.length - 1].toISO === "2026-06-11");
    check("…recovering ~two years of missing trading days",
      plan.kind === "planned" && plan.missingExpectedCount > 400,
      plan.kind === "planned" ? `missing=${plan.missingExpectedCount}` : "");

    // The interior case the old edge arithmetic could not represent AT ALL.
    const interiorHole = [...covered, ...usEquityCalendar.expectedDates(REQ_FROM, "2024-08-01")];
    const bothEnds = record(planOf({ from: REQ_FROM, to: REQ_TO, observed: usd(interiorHole) }));
    check("coverage at BOTH ends → the interior gap is planned (edge subtraction could not)",
      bothEnds.kind === "planned" && bothEnds.windows.length >= 1 &&
      bothEnds.windows[0].fromISO > "2024-08-01" &&
      bothEnds.windows[bothEnds.windows.length - 1].toISO === "2026-06-11");
  }

  // ── 7. Determinism ────────────────────────────────────────────────────────
  console.log("7. determinism");
  {
    const base = usd(without(TRADING, "2026-01-07", "2026-01-12"));
    const scrambled = [...base].reverse().concat(base); // reordered + duplicated
    check("shuffled and duplicated observations → byte-identical plan",
      JSON.stringify(planOf({ observed: scrambled })) === JSON.stringify(planOf({ observed: base })));
    check("repeat invocation → byte-identical plan",
      JSON.stringify(planOf({ observed: base })) === JSON.stringify(planOf({ observed: base })));

    const kindsSeen = new Set(plans.map((p) => p.kind));
    check("every plan puts `kind` first so the discriminant is never buried",
      plans.every((p) => Object.keys(p)[0] === "kind"), [...kindsSeen].join(","));
    const plannedKeys = plans.filter((p) => p.kind === "planned").map((p) => Object.keys(p).join(","));
    check("planned plans share one key order", new Set(plannedKeys).size === 1);
    const noopKeys = plans.filter((p) => p.kind === "no-op").map((p) => Object.keys(p).join(","));
    check("no-op plans share one key order", new Set(noopKeys).size === 1);

    const unav = planOf({ meta: { ...EQUITY, assetClass: "CASH", tickerSymbol: "CUR:USD" }, observed: usd(["2026-01-05"]) });
    check("reason ordering is inherited from the canonical coverage order",
      unav.kind === "unavailable" && eq(unav.reasons, ["NOT_PRICEABLE", "UNEXPECTED_OBSERVATION"]));

    // Golden: a frozen byte-for-byte reference across gap-splitting AND chunking.
    const goldenObserved = usd(["2026-01-06", "2026-01-07", "2026-01-13", "2026-01-14", "2026-01-15", "2026-01-16"]);
    const golden = planAcquisition({
      coverage: resolveInstrumentCoverage({
        meta: { ...EQUITY, instrumentId: "inst_golden" }, basis: PriceBasis.RAW_CLOSE,
        requestedFromISO: W_FROM, requestedToISO: W_TO,
        observed: goldenObserved, providerFloorISO: null,
      }),
      maxCalendarDaysPerRequest: 3,
    });
    const GOLDEN =
      '{"kind":"planned","instrumentId":"inst_golden","calendarId":"us-equity@2024-2027.r1",' +
      '"requestedFromISO":"2026-01-05","requestedToISO":"2026-01-16","windows":[' +
        '{"fromISO":"2026-01-05","toISO":"2026-01-05","requestDays":1},' +
        '{"fromISO":"2026-01-08","toISO":"2026-01-10","requestDays":3},' +
        '{"fromISO":"2026-01-11","toISO":"2026-01-12","requestDays":2}],' +
      '"missingExpectedCount":4,"requestDayCount":6,"unreachableCount":0}';
    const actual = JSON.stringify(golden);
    check("golden plan is byte-identical to the frozen reference", actual === GOLDEN,
      `\n      expected ${GOLDEN}\n      actual   ${actual}`);
  }

  // ── 8. Invariants and purity ──────────────────────────────────────────────
  console.log("8. invariants and purity");
  {
    check("windows are non-empty ONLY on a planned plan",
      plans.every((p) => (p.windows.length > 0) === (p.kind === "planned")));
    check("no window ever precedes its plan's requested window",
      plans.every((p) => p.kind !== "planned" || p.windows.every((w) => w.fromISO >= p.requestedFromISO)));
    check("no window ever exceeds its plan's requested window",
      plans.every((p) => p.kind !== "planned" || p.windows.every((w) => w.toISO <= p.requestedToISO)));
    check("requestDayCount === Σ window.requestDays",
      plans.every((p) => p.kind !== "planned" ||
        p.requestDayCount === p.windows.reduce((n, w) => n + w.requestDays, 0)));
    check("no planning-error ever fired (the partial⇒windows invariant held)",
      plans.every((p) => p.kind !== "planning-error"));

    let clockRead = false, identical = true;
    try {
      withNoClock(() => {
        if (JSON.stringify(planOf({ observed: usd(without(TRADING, "2026-01-07")) })) !==
            JSON.stringify(planOf({ observed: usd(without(TRADING, "2026-01-07")) }))) identical = false;
        planOf({ observed: [] });
        planOf({ observed: [], floor: "2026-01-08" });
      });
    } catch (e) {
      clockRead = true;
      console.error(`      ↳ ${e instanceof Error ? e.message : e}`);
    }
    check("the planner never constructs a Date or reads Date.now()", !clockRead);
    check("output identical with the clock removed", identical);

    check("crypto and equity traverse the identical planner",
      cryptoCalendar.id !== usEquityCalendar.id &&
      planAcquisition({
        coverage: resolveInstrumentCoverage({
          meta: CRYPTO, basis: PriceBasis.RAW_CLOSE,
          requestedFromISO: "2026-01-09", requestedToISO: "2026-01-12",
          observed: usd(["2026-01-09", "2026-01-12"]), providerFloorISO: null,
        }),
        maxCalendarDaysPerRequest: 365,
      }).kind === "planned");
  }

  console.log(failures === 0 ? "\nAll acquisition-plan checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
