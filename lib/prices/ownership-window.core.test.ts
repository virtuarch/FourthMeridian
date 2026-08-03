/**
 * lib/prices/ownership-window.core.test.ts
 *
 * V26-PRICE-4 — ownership-window fixtures. Standalone tsx script:
 *
 *     npx tsx lib/prices/ownership-window.core.test.ts
 *
 * The property under test is not "the window is wide enough" — it is that
 * WIDENING NEVER ERASES CONFIDENCE. A KNOWN span and a POSSIBLE span may produce
 * identical provider requests; they must never produce identical facts.
 */

import {
  resolveOwnershipWindow,
  attributeRange,
  type OwnershipEvidence,
  type OwnershipResolution,
  type OwnershipSegment,
} from "./ownership-window.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const CEILING = "2026-07-30";
function ev(over: Partial<OwnershipEvidence> = {}): OwnershipEvidence {
  return {
    instrumentId: "inst_1",
    earliestDirectISO: "2026-01-05",
    earliestPossibleISO: null,
    valuationToISO: CEILING,
    ...over,
  };
}
const segs = (r: OwnershipResolution): OwnershipSegment[] =>
  r.kind === "resolved" ? r.segments : [];

/** Replaces global Date with one that throws on `new Date()` / `Date.now()`. */
const RealDate = Date;
function withNoClock<T>(fn: () => T): T {
  const boom = (): never => { throw new Error("[test] ownership resolution read the clock"); };
  const ctor = function (...args: unknown[]): Date {
    if (args.length === 0) boom();
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  };
  Object.assign(ctor, { parse: RealDate.parse, UTC: RealDate.UTC, now: boom });
  globalThis.Date = ctor as unknown as DateConstructor;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

function main(): void {
  // ── 1. Direct evidence only ───────────────────────────────────────────────
  console.log("1. direct evidence only");
  {
    const r = resolveOwnershipWindow(ev());
    check("one KNOWN segment from the first evidence to the ceiling",
      eq(segs(r), [{ confidence: "KNOWN", fromISO: "2026-01-05", toISO: CEILING, days: 207 }]));
    check("nothing is inferred", r.kind === "resolved" && r.possibleDays === 0);
    check("the acquisition window is the segment", r.kind === "resolved" &&
      r.acquisitionFromISO === "2026-01-05" && r.acquisitionToISO === CEILING);
    check("UNKNOWN prehistory ends the day before", r.kind === "resolved" && r.unknownBeforeISO === "2026-01-04");
  }

  // ── 2. The BTC shape ──────────────────────────────────────────────────────
  // The real local case: direct evidence begins when capture began (2026-07-19)
  // while the wallet's transactions reach back to 2023-03-24.
  console.log("2. possible earlier than direct (the BTC shape)");
  {
    const r = resolveOwnershipWindow(ev({
      earliestDirectISO: "2026-07-19", earliestPossibleISO: "2023-03-24",
    }));
    check("two segments: inferred prefix, then evidenced remainder",
      eq(segs(r), [
        { confidence: "POSSIBLE", fromISO: "2023-03-24", toISO: "2026-07-18", days: 1213 },
        { confidence: "KNOWN",    fromISO: "2026-07-19", toISO: CEILING,      days: 12 },
      ]));
    check("the segments are adjacent with no gap and no overlap",
      segs(r)[0].toISO < segs(r)[1].fromISO &&
      Date.parse(`${segs(r)[1].fromISO}T00:00:00Z`) - Date.parse(`${segs(r)[0].toISO}T00:00:00Z`) === 86_400_000);
    check("the acquisition window spans both", r.kind === "resolved" &&
      r.acquisitionFromISO === "2023-03-24" && r.acquisitionToISO === CEILING);
    check("…and the split is preserved, not collapsed into one number",
      r.kind === "resolved" && r.knownDays === 12 && r.possibleDays === 1213);
    check("over 99% of this window is INFERRED — the fact a single window would hide",
      r.kind === "resolved" && r.possibleDays > r.knownDays * 100);
  }

  // ── 3. Possible adds nothing ──────────────────────────────────────────────
  console.log("3. possible bound at or after direct evidence");
  {
    // The equity shape locally: accounts created AFTER the first observation.
    const later = resolveOwnershipWindow(ev({
      earliestDirectISO: "2025-08-12", earliestPossibleISO: "2026-07-19",
    }));
    check("a later possible bound never widens the window",
      eq(segs(later), [{ confidence: "KNOWN", fromISO: "2025-08-12", toISO: CEILING, days: 353 }]));
    check("…and never narrows it either", later.kind === "resolved" && later.possibleDays === 0);

    const same = resolveOwnershipWindow(ev({
      earliestDirectISO: "2026-01-05", earliestPossibleISO: "2026-01-05",
    }));
    check("an equal bound produces no empty POSSIBLE segment", segs(same).length === 1);
  }

  // ── 4. Possible only ──────────────────────────────────────────────────────
  console.log("4. possible evidence with no direct holding");
  {
    const r = resolveOwnershipWindow(ev({ earliestDirectISO: null, earliestPossibleISO: "2024-02-01" }));
    check("one POSSIBLE segment; nothing is KNOWN",
      segs(r).length === 1 && segs(r)[0].confidence === "POSSIBLE");
    check("knownDays is zero — no valuation may claim direct evidence",
      r.kind === "resolved" && r.knownDays === 0);
  }

  // ── 5. No acquisition ─────────────────────────────────────────────────────
  console.log("5. no acquisition");
  {
    const none = resolveOwnershipWindow(ev({ earliestDirectISO: null, earliestPossibleISO: null }));
    check("no evidence at all → never fetch blind history",
      none.kind === "no-acquisition" && none.reason === "NO_OWNERSHIP_EVIDENCE");

    const after = resolveOwnershipWindow(ev({ earliestDirectISO: "2027-01-01" }));
    check("evidence beginning after the ceiling → nothing to value",
      after.kind === "no-acquisition" && after.reason === "EVIDENCE_AFTER_CEILING");

    const afterPossible = resolveOwnershipWindow(ev({
      earliestDirectISO: null, earliestPossibleISO: "2027-01-01",
    }));
    check("a possible-only bound after the ceiling also yields nothing",
      afterPossible.kind === "no-acquisition" && afterPossible.reason === "EVIDENCE_AFTER_CEILING");
  }

  // ── 6. Boundaries ─────────────────────────────────────────────────────────
  console.log("6. boundaries");
  {
    const oneDay = resolveOwnershipWindow(ev({ earliestDirectISO: CEILING }));
    check("evidence exactly at the ceiling → a one-day KNOWN segment",
      eq(segs(oneDay), [{ confidence: "KNOWN", fromISO: CEILING, toISO: CEILING, days: 1 }]));

    const adjacent = resolveOwnershipWindow(ev({
      earliestDirectISO: "2026-01-05", earliestPossibleISO: "2026-01-04",
    }));
    check("a one-day POSSIBLE prefix is represented, not rounded away",
      segs(adjacent).length === 2 && segs(adjacent)[0].days === 1);

    const leap = resolveOwnershipWindow(ev({
      earliestDirectISO: "2024-02-28", earliestPossibleISO: null, valuationToISO: "2024-03-01",
    }));
    check("leap day is counted (2024-02-28 → 03-01 is 3 days)", segs(leap)[0].days === 3);

    let threw = false;
    try { resolveOwnershipWindow(ev({ earliestDirectISO: "2026-1-5" })); } catch { threw = true; }
    check("malformed evidence throws (programmer error)", threw);
  }

  // ── 7. Attribution ────────────────────────────────────────────────────────
  console.log("7. attribution of a requested range");
  {
    const r = resolveOwnershipWindow(ev({
      earliestDirectISO: "2026-07-19", earliestPossibleISO: "2023-03-24",
    }));
    const s = segs(r);

    check("a range wholly inside POSSIBLE attributes there, and only there",
      eq(attributeRange("2024-01-01", "2024-01-10", s),
         { knownDays: 0, possibleDays: 10, unattributedDays: 0 }));
    check("a range wholly inside KNOWN attributes there, and only there",
      eq(attributeRange("2026-07-20", "2026-07-25", s),
         { knownDays: 6, possibleDays: 0, unattributedDays: 0 }));
    check("a range straddling the boundary splits correctly",
      eq(attributeRange("2026-07-17", "2026-07-20", s),
         { knownDays: 2, possibleDays: 2, unattributedDays: 0 }));
    check("a range reaching into UNKNOWN prehistory is flagged, not silently counted",
      attributeRange("2023-03-22", "2023-03-25", s).unattributedDays === 2);
    check("with no segments everything is unattributed",
      eq(attributeRange("2026-01-01", "2026-01-05", []),
         { knownDays: 0, possibleDays: 0, unattributedDays: 5 }));
  }

  // ── 8. Determinism and purity ─────────────────────────────────────────────
  console.log("8. determinism and purity");
  {
    const a = resolveOwnershipWindow(ev({ earliestPossibleISO: "2023-03-24" }));
    const b = resolveOwnershipWindow(ev({ earliestPossibleISO: "2023-03-24" }));
    check("repeat invocation → byte-identical", JSON.stringify(a) === JSON.stringify(b));
    check("`kind` is the first key so the discriminant is never buried",
      Object.keys(a)[0] === "kind");

    let clockRead = false, identical = true;
    try {
      withNoClock(() => {
        const c = resolveOwnershipWindow(ev({ earliestPossibleISO: "2023-03-24" }));
        if (JSON.stringify(c) !== JSON.stringify(a)) identical = false;
        attributeRange("2024-01-01", "2024-01-10", segs(a));
      });
    } catch (e) {
      clockRead = true;
      console.error(`      ↳ ${e instanceof Error ? e.message : e}`);
    }
    check("never constructs a Date or reads Date.now()", !clockRead);
    check("output identical with the clock removed", identical);
  }

  // ══ V26-S2-OWNERSHIP — THE CLOSING BOUND ══════════════════════════════════
  //
  // Every window this module produced ran to the ceiling, so nine positions sold
  // on 2026-07-27 still read as owned today. Ownership now ends where an
  // observation proves it ended.
  console.log("V26-S2. Ownership ends");
  {
    const open = resolveOwnershipWindow({
      instrumentId: "i", earliestDirectISO: "2025-07-31",
      earliestPossibleISO: null, valuationToISO: "2026-08-02",
    });
    const closed = resolveOwnershipWindow({
      instrumentId: "i", earliestDirectISO: "2025-07-31",
      earliestPossibleISO: null, valuationToISO: "2026-08-02",
      closedFromISO: "2026-07-27",
    });
    check("without a closure the window still runs to the ceiling",
      open.kind === "resolved" && open.segments.at(-1)!.toISO === "2026-08-02");
    check("a closure ends the window the day BEFORE the proven zero",
      closed.kind === "resolved" && closed.segments.at(-1)!.toISO === "2026-07-26");
    check("the opening bound is untouched",
      closed.kind === "resolved" && closed.segments[0].fromISO === "2025-07-31");
    check("the day count shrinks with the window",
      open.kind === "resolved" && closed.kind === "resolved" &&
      closed.knownDays < open.knownDays);

    // A POSSIBLE prefix must be bounded by the closure too — it is the same
    // window, not a separate claim that survives disposal.
    const withPrefix = resolveOwnershipWindow({
      instrumentId: "i", earliestDirectISO: "2026-07-19",
      earliestPossibleISO: "2025-07-31", valuationToISO: "2026-08-02",
      closedFromISO: "2026-07-27",
    });
    check("a POSSIBLE prefix survives, and the KNOWN tail is clipped",
      withPrefix.kind === "resolved" && withPrefix.segments.length === 2 &&
      withPrefix.segments[0].confidence === "POSSIBLE" &&
      withPrefix.segments[1].toISO === "2026-07-26");
    check("acquisitionToISO follows the closure, so we stop buying prices after a sale",
      withPrefix.kind === "resolved" && withPrefix.acquisitionToISO === "2026-07-26");

    // A closure at or before the earliest evidence leaves no interval at all.
    const impossible = resolveOwnershipWindow({
      instrumentId: "i", earliestDirectISO: "2026-07-19",
      earliestPossibleISO: null, valuationToISO: "2026-08-02",
      closedFromISO: "2026-07-01",
    });
    check("a closure before any evidence yields NO window, not an inverted one",
      impossible.kind === "no-acquisition");

    // A closure after the ceiling changes nothing — the ceiling already binds.
    const late = resolveOwnershipWindow({
      instrumentId: "i", earliestDirectISO: "2025-07-31",
      earliestPossibleISO: null, valuationToISO: "2026-01-01",
      closedFromISO: "2026-07-27",
    });
    check("a closure beyond the ceiling does not extend the window",
      late.kind === "resolved" && late.segments.at(-1)!.toISO === "2026-01-01");

    check("an ABSENT closure is byte-identical to before this slice",
      JSON.stringify(open) === JSON.stringify(resolveOwnershipWindow({
        instrumentId: "i", earliestDirectISO: "2025-07-31",
        earliestPossibleISO: null, valuationToISO: "2026-08-02", closedFromISO: null,
      })));
  }

  console.log(failures === 0 ? "\nAll ownership-window checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
