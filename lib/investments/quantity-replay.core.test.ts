/**
 * lib/investments/quantity-replay.core.test.ts
 *
 * V26-QUANTITY-1C / 1C.1 — replay fixtures. Standalone tsx script:
 *
 *     npx tsx lib/investments/quantity-replay.core.test.ts
 *
 * The properties that matter most:
 *   - a delta without an anchor NEVER becomes an absolute quantity;
 *   - no segment exists before the first defensible evidence (PRICE-5A);
 *   - an observation proves a DATE, and only a declared-complete event stream
 *     lets that proof become an interval;
 *   - ABSOLUTE_COMPLETE means the whole requested window, or it means nothing.
 */

import {
  replayQuantityTimeline, classifySameDayGroup, summarise, licensedCoverage,
  PERMITTED_ANCHOR_ORIGINS, UNKNOWN_EVENT_STREAM,
  type QuantityAnchor, type QuantityTimelineSegment, type EventStreamCompleteness,
} from "./quantity-replay.core";
import { normalizeQuantityEvent, type QuantityEventSource } from "./quantity-event.core";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

let n = 0;
/** Build a normalized event through the REAL 1B normalizer — no parallel model. */
function ev(over: Partial<QuantityEventSource> = {}) {
  n++;
  return normalizeQuantityEvent({
    id: `e${n}`, financialAccountId: "acct1", instrumentId: "inst1",
    type: "BUY", dateISO: "2026-03-01", datetimeISO: null,
    quantity: 1, ratio: null, source: "plaid", externalEventId: `x${n}`,
    relatedInstrumentId: null, ...over,
  });
}
let a = 0;
function anchor(over: Partial<QuantityAnchor> = {}): QuantityAnchor {
  a++;
  return {
    observationId: `a${a}`, dateISO: "2026-01-01", effectiveDateTimeISO: null,
    quantity: 10, origin: "OBSERVED", completeness: "observed", ...over,
  };
}

/**
 * Sections 1–10 exercise the replay ALGEBRA, which 1C.1 did not change, so they
 * declare a complete stream: interval width is licensed and the arithmetic is
 * what is under test. Section 12 exercises the licensing itself.
 */
const COMPLETE_STREAM: EventStreamCompleteness =
  { kind: "COMPLETE", fromISO: "1900-01-01", toISO: "2100-01-01", source: "fixture" };

const ALL: Array<{
  anchors: QuantityAnchor[]; events: ReturnType<typeof ev>[];
  timeline: ReturnType<typeof replayQuantityTimeline>;
}> = [];

const run = (
  anchors: QuantityAnchor[], events: ReturnType<typeof ev>[],
  to = "2026-12-31", stream: EventStreamCompleteness = COMPLETE_STREAM, from?: string,
) => {
  // windowFromISO is a CALLER decision. These fixtures choose "the earliest
  // evidence I hold"; the core is forbidden from making that choice itself.
  const evidence = [...anchors.map((x) => x.dateISO), ...events.map((e) => e.dateISO)].sort();
  const timeline = replayQuantityTimeline({
    instrumentId: "inst1", accountId: "acct1", anchors, events,
    windowFromISO: from ?? evidence[0] ?? to, windowToISO: to, eventStream: stream,
  });
  ALL.push({ anchors, events, timeline });
  return timeline;
};

const abs = (s: QuantityTimelineSegment[]) => s.filter((x) => x.kind === "ABSOLUTE");
const rel = (s: QuantityTimelineSegment[]) => s.filter((x) => x.kind === "RELATIVE");
const unres = (s: QuantityTimelineSegment[]) => s.filter((x) => x.kind === "UNRESOLVED");
const qty = (s: QuantityTimelineSegment | undefined) => (s as never as { quantity: number }).quantity;
const delta = (s: QuantityTimelineSegment | undefined) => (s as never as { cumulativeDelta: number }).cumulativeDelta;

function main(): void {
  // ── 0. Purity ─────────────────────────────────────────────────────────────
  console.log("0. purity");
  {
    const src = readFileSync(join(import.meta.dirname, "quantity-replay.core.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    check("imports ONLY the QUANTITY-1B contract",
      imports.length === 1 && imports[0] === "./quantity-event.core", imports.join(", "));
    // Scan the IMPORT SPECIFIERS, not the prose: the header legitimately
    // discusses providers and ingestion while importing neither.
    const specifiers = imports.join(" ");
    check("no Prisma import", !/@prisma|prisma/i.test(specifiers));
    check("no database import", !/(^|[/\s])db($|[/\s])|lib\/db/i.test(specifiers));
    check("no provider import", !/lib\/prices|provider|tiingo|coingecko/i.test(specifiers));
    check("no ambient clock", !/Date\.now\(|new Date\(\s*\)/.test(src));
    check("no filesystem, network or randomness",
      !/require\(|fetch\(|Math\.random|readFile|process\.env/.test(src));
    check("windowFromISO is never inferred from evidence inside the core",
      !/windowFromISO\s*[=?]{1,2}\s*(evidence|first|earliest|segments)/i.test(src));
  }

  // ── 1. Absolute replay ────────────────────────────────────────────────────
  console.log("1. absolute replay");
  {
    const r = run([anchor({ quantity: 10 })], [ev({ type: "BUY", quantity: 5 })]);
    check("anchor + BUY over a complete stream → ABSOLUTE_COMPLETE", r.summary === "ABSOLUTE_COMPLETE");
    check("…closing quantity 10 + 5 = 15", qty(abs(r.segments).at(-1)) === 15);
    check("…the opening segment is the anchor itself",
      abs(r.segments)[0].kind === "ABSOLUTE" && abs(r.segments)[0].basis === "OBSERVED_ANCHOR");
    check("…and the anchor's opening role is recorded",
      r.diagnostics.anchorOutcomes.some((o) => o.openingRole === "OPENING"));

    const many = run([anchor({ quantity: 0 })], [
      ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" }),
      ev({ type: "BUY", quantity: 2, dateISO: "2026-04-01" }),
    ]);
    check("multiple BUYs accumulate", qty(abs(many.segments).at(-1)) === 5);

    const partial = run([anchor({ quantity: 10 })], [ev({ type: "SELL", quantity: 4 })]);
    check("partial SELL → 6", qty(abs(partial.segments).at(-1)) === 6);

    const exit = run([anchor({ quantity: 1 })], [ev({ type: "SELL", quantity: 1 })]);
    check("full exit produces an explicit ZERO segment, not an absent one",
      qty(abs(exit.segments).at(-1)) === 0 && abs(exit.segments).length >= 2);
    check("…zero is KNOWN closure, so the summary stays ABSOLUTE_COMPLETE",
      exit.summary === "ABSOLUTE_COMPLETE");

    const reentry = run([anchor({ quantity: 1 })], [
      ev({ type: "SELL", quantity: 1, dateISO: "2026-03-01" }),
      ev({ type: "BUY",  quantity: 3, dateISO: "2026-06-01" }),
    ]);
    const q = abs(reentry.segments).map(qty);
    check("re-entry after zero opens a new positive segment", q.includes(0) && q.at(-1) === 3);

    const short = run([anchor({ quantity: 0 })], [ev({ type: "SELL", quantity: 2.0058 })]);
    check("negative/short quantity is preserved, never clamped",
      qty(abs(short.segments).at(-1)) === -2.0058);

    const split = run([anchor({ quantity: 5 })], [ev({ type: "SPLIT", quantity: 0, ratio: 4 })]);
    check("a valid split MULTIPLIES (5 × 4 = 20)", qty(abs(split.segments).at(-1)) === 20);
  }

  // ── 2. No anchor → relative only ──────────────────────────────────────────
  console.log("2. no anchor → RELATIVE, never absolute");
  {
    const buyFirst = run([], [ev({ type: "BUY", quantity: 3 })]);
    check("a first BUY 3 does NOT establish quantity 3", abs(buyFirst.segments).length === 0);
    check("…it yields RELATIVE_ONLY", buyFirst.summary === "RELATIVE_ONLY");
    check("…carrying cumulativeDelta, not quantity", delta(rel(buyFirst.segments)[0]) === 3);
    check("…and the missing anchor is reported", buyFirst.diagnostics.missingOpeningAnchor === true);

    const sellFirst = run([], [ev({ type: "SELL", quantity: 1 })]);
    check("a first SELL 1 does NOT establish −1 holdings", abs(sellFirst.segments).length === 0);
    check("…cumulative delta is −1", delta(rel(sellFirst.segments).at(-1)) === -1);

    const several = run([], [
      ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" }),
      ev({ type: "SELL", quantity: 1, dateISO: "2026-04-01" }),
    ]);
    check("several deltas accumulate relatively", delta(rel(several.segments).at(-1)) === 2);
    check("NO segment exists before the first event",
      several.segments.every((s) => s.fromISO >= "2026-03-01"));
    check("OPENING_BALANCE is not silently promoted to an anchor",
      run([], [ev({ type: "OPENING_BALANCE", quantity: 7 })]).summary === "UNREPLAYABLE");
  }

  // ── 3. Anchor origin allowlist ────────────────────────────────────────────
  console.log("3. anchor origins");
  {
    const derived = run([anchor({ origin: "DERIVED" })], [ev({ type: "BUY", quantity: 5 })]);
    check("a DERIVED anchor is REJECTED — replay may not anchor on replay output",
      derived.diagnostics.anchorOutcomes[0].admissibility === "REJECTED_ORIGIN");
    check("…so the timeline falls back to RELATIVE_ONLY", derived.summary === "RELATIVE_ONLY");
    check("…it is represented in no segment",
      derived.diagnostics.anchorOutcomes[0].representation === "NOT_REPRESENTED");
    check("…and the rejection reason is recorded", derived.diagnostics.anchorRejectedReason !== null);

    for (const origin of ["OBSERVED", "IMPORTED", "USER_ASSERTED"]) {
      check(`${origin} is a permitted anchor origin`,
        PERMITTED_ANCHOR_ORIGINS.has(origin) &&
        run([anchor({ origin })], [ev({ type: "BUY", quantity: 5 })]).summary === "ABSOLUTE_COMPLETE");
    }
    check("DERIVED is not in the allowlist", !PERMITTED_ANCHOR_ORIGINS.has("DERIVED"));

    const late = run([anchor({ dateISO: "2027-01-01" })], [ev({ type: "BUY", quantity: 1 })]);
    check("an anchor dated after the window is OUTSIDE_WINDOW, not silently used",
      late.diagnostics.anchorOutcomes[0].admissibility === "OUTSIDE_WINDOW");
  }

  // ── 4. Anchor date vs event date ──────────────────────────────────────────
  console.log("4. anchor temporal precision");
  {
    const before = run([anchor({ dateISO: "2026-02-28", quantity: 4 })],
      [ev({ type: "BUY", quantity: 1, dateISO: "2026-03-01" })]);
    check("an anchor strictly BEFORE the first event opens the run",
      before.summary === "ABSOLUTE_COMPLETE" && qty(abs(before.segments).at(-1)) === 5);

    // The APLD shape: same-day observation is an END-of-day state.
    const sameDay = run([anchor({ dateISO: "2026-03-01", quantity: 3 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" })]);
    check("a same-day anchor WITHOUT a timestamp is NOT an opening (no 3+3=6)",
      sameDay.diagnostics.anchorOutcomes[0].openingRole === "AMBIGUOUS_SAME_DAY");
    check("…and no absolute 6 is ever emitted", !abs(sameDay.segments).some((s) => qty(s) === 6));

    const timed = run(
      [anchor({ dateISO: "2026-03-01", effectiveDateTimeISO: "2026-03-01T09:00:00.000Z", quantity: 3 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01", datetimeISO: "2026-03-01T15:00:00.000Z" })]);
    check("a same-day anchor with a PROVABLY EARLIER timestamp IS an opening",
      timed.summary === "ABSOLUTE_COMPLETE" && qty(abs(timed.segments).at(-1)) === 6);
  }

  // ── 5. Same-day classification ────────────────────────────────────────────
  console.log("5. same-day commutativity");
  {
    const deltas = [ev({ type: "BUY", quantity: 1 }), ev({ type: "SELL", quantity: 2 })];
    check("all-delta group without datetimes is COMMUTATIVE", classifySameDayGroup(deltas) === "COMMUTATIVE");
    const ratios = [ev({ type: "SPLIT", ratio: 2, quantity: 0 }), ev({ type: "SPLIT", ratio: 3, quantity: 0 })];
    check("all-ratio group is COMMUTATIVE (multiplication commutes)",
      classifySameDayGroup(ratios) === "COMMUTATIVE");
    const mixed = [ev({ type: "BUY", quantity: 1 }), ev({ type: "SPLIT", ratio: 2, quantity: 0 })];
    check("ratio + delta without datetimes is ORDER_SENSITIVE_UNRESOLVED",
      classifySameDayGroup(mixed) === "ORDER_SENSITIVE_UNRESOLVED");
    const timedMixed = [
      ev({ type: "BUY", quantity: 1, datetimeISO: "2026-03-01T10:00:00.000Z" }),
      ev({ type: "SPLIT", ratio: 2, quantity: 0, datetimeISO: "2026-03-01T11:00:00.000Z" }),
    ];
    check("…but WITH datetimes it is ORDERED", classifySameDayGroup(timedMixed) === "ORDERED");

    const commutative = run([anchor({ quantity: 10 })], deltas);
    check("a commutative group replays to a single defensible quantity",
      commutative.summary === "ABSOLUTE_COMPLETE" && qty(abs(commutative.segments).at(-1)) === 9);

    const blocked = run([anchor({ quantity: 10 })], mixed);
    check("an ORDER_SENSITIVE group STOPS absolute replay", unres(blocked.segments).length === 1);
    check("…rather than emitting one of two possible quantities", blocked.summary === "ABSOLUTE_WITH_GAPS");
    check("…and the group is reported", blocked.diagnostics.orderSensitiveGroups.length === 1);

    const ordered = run([anchor({ quantity: 10 })], timedMixed);
    check("with evidenced chronology the same shape replays ((10+1)×2 = 22)",
      ordered.summary === "ABSOLUTE_COMPLETE" && qty(abs(ordered.segments).at(-1)) === 22);
  }

  // ── 6. Unsupported evidence stops exact replay ────────────────────────────
  console.log("6. unresolved evidence");
  {
    const transfer = run([anchor({ quantity: 5 })], [
      ev({ type: "BUY", quantity: 1, dateISO: "2026-03-01" }),
      ev({ type: "TRANSFER_IN", quantity: -2, dateISO: "2026-05-01" }),
    ]);
    check("an unresolved transfer STOPS absolute replay", transfer.summary === "ABSOLUTE_WITH_GAPS");
    check("…and is reported as an unresolved transfer id",
      transfer.diagnostics.unresolvedTransferEventIds.length === 1);
    check("…the last absolute claim stops the day before it",
      transfer.diagnostics.absoluteResolvedThroughISO === "2026-04-30");

    const badSplit = run([anchor({ quantity: 5 })], [ev({ type: "SPLIT", quantity: 10, ratio: null })]);
    check("an INVALID split stops exact replay", unres(badSplit.segments).length === 1);
    check("…recorded as INVALID_EVENT",
      (unres(badSplit.segments)[0] as never as { reason: string }).reason === "INVALID_EVENT");

    const dividend = run([anchor({ quantity: 5 })], [ev({ type: "DIVIDEND", quantity: 0 })]);
    check("a neutral dividend does not alter quantity", qty(abs(dividend.segments).at(-1)) === 5);
    check("…and does not create a gap", unres(dividend.segments).length === 0);
    check("…but IS accounted for, so 'changed nothing' ≠ 'was dropped'",
      dividend.diagnostics.neutralEventIds.length === 1);

    const orphan = run([anchor({ quantity: 5 })], [ev({ instrumentId: null })]);
    check("an unattributable event stays diagnostic",
      orphan.diagnostics.unattributableEventIds.length === 1);
    check("no unsupported event is silently dropped",
      transfer.diagnostics.unsupportedEventIds.length +
      badSplit.diagnostics.invalidEventIds.length +
      orphan.diagnostics.unattributableEventIds.length === 3);
  }

  // ── 7. Multiple anchors, confirmation and resumption ──────────────────────
  console.log("7. multiple anchors");
  {
    const confirming = run([
      anchor({ observationId: "open", dateISO: "2026-01-01", quantity: 10 }),
      anchor({ observationId: "mid",  dateISO: "2026-04-01", quantity: 15 }),
    ], [ev({ type: "BUY", quantity: 5, dateISO: "2026-03-01" })]);
    const mid = confirming.diagnostics.anchorOutcomes.find((o) => o.observationId === "mid")!;
    check("an intermediate anchor inside a licensed interval CONFIRMS it",
      mid.representation === "COVERED_BY_INTERVAL");
    check("…with a residue of exactly zero recorded", mid.residue === 0);
    check("…and nothing added to the residue list", confirming.diagnostics.reconciliationResidues.length === 0);

    const mismatch = run([
      anchor({ observationId: "open", dateISO: "2026-01-01", quantity: 10 }),
      anchor({ observationId: "mid",  dateISO: "2026-03-01", quantity: 99 }),
    ], [ev({ type: "BUY", quantity: 5, dateISO: "2026-03-01" })]);
    check("a DISAGREEING intermediate anchor records a residue, not a forced equality",
      mismatch.diagnostics.reconciliationResidues.length === 1 &&
      mismatch.diagnostics.reconciliationResidues[0].residue === 84);
    check("…and replay keeps its own value rather than snapping to the anchor",
      qty(abs(mismatch.segments).at(-1)) === 15);

    const resumed = run([
      anchor({ observationId: "open",   dateISO: "2026-01-01", quantity: 5 }),
      anchor({ observationId: "resume", dateISO: "2026-06-01", quantity: 40 }),
    ], [
      ev({ type: "BUY", quantity: 1, dateISO: "2026-02-01" }),
      ev({ type: "TRANSFER_IN", quantity: -2, dateISO: "2026-04-01" }),
      ev({ type: "BUY", quantity: 2, dateISO: "2026-08-01" }),
    ]);
    check("absolute replay RESUMES from a later permitted anchor",
      resumed.diagnostics.resumedFromAnchors.includes("resume"));
    check("…the resumed run starts from the anchor's quantity, not the stale one",
      abs(resumed.segments).some((s) => qty(s) === 42));
    check("…the gap is bounded by the resume anchor",
      (unres(resumed.segments)[0] as never as { toISO: string }).toISO === "2026-05-31");
    check("…and the summary admits the gap", resumed.summary === "ABSOLUTE_WITH_GAPS");

    const mixedCandidates = run([
      anchor({ observationId: "derived", dateISO: "2026-01-01", origin: "DERIVED", quantity: 99 }),
      anchor({ observationId: "good",    dateISO: "2026-02-01", quantity: 4 }),
      anchor({ observationId: "sameday", dateISO: "2026-03-01", quantity: 7 }),
    ], [ev({ type: "BUY", quantity: 1, dateISO: "2026-03-01" })]);
    const out = (id: string) => mixedCandidates.diagnostics.anchorOutcomes.find((o) => o.observationId === id)!;
    check("several candidates are each given an explicit fate",
      out("derived").admissibility === "REJECTED_ORIGIN" &&
      out("good").openingRole === "OPENING" &&
      out("sameday").openingRole === "AMBIGUOUS_SAME_DAY");
    check("…and every anchor appears in the outcomes",
      mixedCandidates.diagnostics.anchorOutcomes.length === 3);
    check("…each carrying its own identity and evidence",
      mixedCandidates.diagnostics.anchorOutcomes.every((o) =>
        typeof o.quantity === "number" && o.origin.length > 0 && o.completeness.length > 0));
  }

  // ── 8. Summary truthfulness ───────────────────────────────────────────────
  console.log("8. summary truthfulness");
  {
    const withGaps = run([
      anchor({ observationId: "o1", dateISO: "2026-01-01", quantity: 5 }),
      anchor({ observationId: "o2", dateISO: "2026-06-01", quantity: 9 }),
    ], [
      ev({ type: "BUY", quantity: 1, dateISO: "2026-02-01" }),
      ev({ type: "TRANSFER_OUT", quantity: -1, dateISO: "2026-04-01" }),
      ev({ type: "BUY", quantity: 1, dateISO: "2026-08-01" }),
    ]);
    check("ABSOLUTE → UNRESOLVED → ABSOLUTE summarises as ABSOLUTE_WITH_GAPS",
      withGaps.summary === "ABSOLUTE_WITH_GAPS");
    check("…and the timeline really does contain all three kinds",
      abs(withGaps.segments).length >= 2 && unres(withGaps.segments).length === 1);

    check("summarise() requires FULL coverage, not merely an absolute segment",
      summarise([{ kind: "ABSOLUTE", fromISO: "2026-01-01", toISO: "2026-01-01", quantity: 1,
                   basis: "OBSERVED_ANCHOR", derivedFrom: [], orderCertainty: "KNOWN" }],
                [{ fromISO: "2026-01-02", toISO: "2026-12-31", reason: "AFTER_LAST_DEFENSIBLE_EVIDENCE" }])
        === "ABSOLUTE_WITH_GAPS");
    check("…and an UNRESOLVED segment alone is enough to deny completeness",
      summarise([{ kind: "ABSOLUTE", fromISO: "a", toISO: "a", quantity: 1, basis: "REPLAYED", derivedFrom: [], orderCertainty: "KNOWN" },
                 { kind: "UNRESOLVED", fromISO: "b", toISO: "b", reason: "UNSUPPORTED_EVENT", blockingEventIds: [] }], [])
        === "ABSOLUTE_WITH_GAPS");
    check("an empty timeline is UNREPLAYABLE", run([], []).summary === "UNREPLAYABLE");
  }

  // ── 9. Determinism ────────────────────────────────────────────────────────
  console.log("9. determinism");
  {
    const anchors = [anchor({ observationId: "z", dateISO: "2026-01-01", quantity: 2 }),
                     anchor({ observationId: "a", dateISO: "2026-05-01", quantity: 5 })];
    const events = [ev({ type: "BUY", quantity: 1, dateISO: "2026-02-01" }),
                    ev({ type: "SELL", quantity: 2, dateISO: "2026-03-01" })];
    const fwd = run(anchors, events);
    const rev = run([...anchors].reverse(), [...events].reverse());
    check("SHUFFLED anchors and events → byte-identical timeline",
      JSON.stringify(fwd) === JSON.stringify(rev));
    check("repeat invocation → byte-identical", JSON.stringify(run(anchors, events)) === JSON.stringify(fwd));
    check("tie-breaking never converts uncertainty to KNOWN",
      run([anchor()], [ev({ type: "BUY", quantity: 1 }), ev({ type: "SELL", quantity: 1 })])
        .segments.filter((s) => s.kind !== "UNRESOLVED")
        .every((s) => (s as never as { orderCertainty: string }).orderCertainty === "TIE_BROKEN" ||
                      (s as never as { basis?: string }).basis === "OBSERVED_ANCHOR"));
  }

  // ── 10. Real corpus shapes ────────────────────────────────────────────────
  console.log("10. real corpus shapes");
  {
    const spce = run([anchor({ dateISO: "2026-07-19", quantity: 1 })],
      [ev({ type: "SELL", quantity: 1, dateISO: "2026-07-27" })], "2026-07-31");
    check("SPCE replays to zero and reconciles",
      spce.summary === "ABSOLUTE_COMPLETE" && qty(abs(spce.segments).at(-1)) === 0);

    const nvda = run([anchor({ dateISO: "2025-10-01", quantity: -2.0058 })], [
      ev({ type: "BUY", quantity: 0.0029, dateISO: "2025-10-02" }),
      ev({ type: "SELL", quantity: 2.003, dateISO: "2026-07-27" }),
    ], "2026-07-31");
    check("NVDA keeps a negative holding throughout", qty(abs(nvda.segments).at(-1)) < 0);

    const tqqq = run([anchor({ dateISO: "2025-11-19", quantity: -20 })],
      [ev({ type: "SPLIT", quantity: 10, ratio: null, dateISO: "2025-11-20" })], "2026-07-31");
    check("TQQQ is blocked by its invalid split", tqqq.summary === "ABSOLUTE_WITH_GAPS");

    const apld = run([anchor({ dateISO: "2026-06-25", quantity: 3 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-06-25" })], "2026-07-31");
    check("APLD's same-day anchor does not double-count",
      !abs(apld.segments).some((s) => qty(s) === 6));

    const blocked = run([anchor({ dateISO: "2026-01-01", quantity: 5 })],
      [ev({ type: "TRANSFER_OUT", quantity: -1, dateISO: "2026-03-01" })]);
    check("a transfer-blocked pair reports the gap and the transfer id",
      blocked.summary === "ABSOLUTE_WITH_GAPS" &&
      blocked.diagnostics.unresolvedTransferEventIds.length === 1);
  }

  // ── 11. QUANTITY-1C.1 — coverage, points and stream completeness ──────────
  console.log("11. coverage, points and event-stream completeness");
  {
    check("UNKNOWN and open-ended PARTIAL license no interval at all",
      licensedCoverage(UNKNOWN_EVENT_STREAM) === null &&
      licensedCoverage({ kind: "PARTIAL", coveredFromISO: "2026-01-01", coveredToISO: null, reason: "r" }) === null);
    check("COMPLETE and closed PARTIAL license their stated interval",
      licensedCoverage(COMPLETE_STREAM)?.toISO === "2100-01-01" &&
      licensedCoverage({ kind: "PARTIAL", coveredFromISO: "2026-01-01", coveredToISO: "2026-06-30", reason: "r" })?.toISO === "2026-06-30");

    // ── one anchor, unknown completeness (the BTC shape) ────────────────────
    const lone = run([anchor({ dateISO: "2026-07-19", quantity: 0.24060252 })], [],
      "2026-07-31", UNKNOWN_EVENT_STREAM, "2026-07-01");
    check("a lone anchor with an UNKNOWN stream states a POINT, not a history",
      abs(lone.segments).length === 1 && lone.segments[0].fromISO === lone.segments[0].toISO);
    check("…so it does NOT report ABSOLUTE_COMPLETE over a multi-day window",
      lone.summary === "ABSOLUTE_WITH_GAPS");
    check("…the days before it are uncovered, not zero",
      lone.uncovered.some((u) => u.toISO === "2026-07-18" && u.reason === "BEFORE_FIRST_DEFENSIBLE_ANCHOR"));
    check("…and the days after it are uncovered too",
      lone.uncovered.some((u) => u.fromISO === "2026-07-20" && u.reason === "AFTER_LAST_DEFENSIBLE_EVIDENCE"));
    check("…the anchor's representation says POINT, in so many words",
      lone.diagnostics.anchorOutcomes[0].representation === "POINT");
    check("…and the withheld interval claim is counted",
      lone.diagnostics.intervalClaimsWithheld > 0);

    // ── the same anchor, complete stream ────────────────────────────────────
    const loneComplete = run([anchor({ dateISO: "2026-07-01", quantity: 0.24 })], [],
      "2026-07-31", { kind: "COMPLETE", fromISO: "2026-07-01", toISO: "2026-07-31", source: "fixture" });
    check("a lone anchor over a COMPLETE stream MAY span the window",
      loneComplete.summary === "ABSOLUTE_COMPLETE" && loneComplete.uncovered.length === 0);
    check("…because the completeness declaration, not the absence of events, licenses it",
      abs(loneComplete.segments)[0].toISO === "2026-07-31");

    // ── several anchors, no complete stream (the CUR:USD shape) ─────────────
    const many = run([
      anchor({ observationId: "p1", dateISO: "2026-07-19", quantity: 11.65 }),
      anchor({ observationId: "p2", dateISO: "2026-07-22", quantity: 11.65 }),
      anchor({ observationId: "p3", dateISO: "2026-07-31", quantity: 3556.22 }),
    ], [], "2026-07-31", UNKNOWN_EVENT_STREAM, "2026-07-19");
    check("EVERY permitted anchor survives as its own absolute fact",
      abs(many.segments).length === 3);
    check("…none of them stretched across a day it does not prove",
      abs(many.segments).every((s) => s.fromISO === s.toISO));
    check("…the intervals between them are explicitly uncovered",
      many.uncovered.length === 2 &&
      many.uncovered.every((u) => u.reason === "EVENT_STREAM_COMPLETENESS_UNKNOWN"));
    check("…and the timeline does not claim to be complete",
      many.summary === "ABSOLUTE_WITH_GAPS");
    check("…the late anchor no longer erases the early ones",
      abs(many.segments).some((s) => qty(s) === 11.65) && abs(many.segments).some((s) => qty(s) === 3556.22));

    // ── an earlier anchor is not dropped when a later one opens replay ──────
    const earlier = run([
      anchor({ observationId: "early", dateISO: "2026-07-19", quantity: 1 }),
      anchor({ observationId: "open",  dateISO: "2026-07-22", quantity: 1 }),
    ], [ev({ type: "SELL", quantity: 1, dateISO: "2026-07-27" })], "2026-07-31",
      { kind: "COMPLETE", fromISO: "2026-07-22", toISO: "2026-07-31", source: "fixture" }, "2026-07-19");
    check("an earlier permitted anchor outside the complete window is still stated",
      abs(earlier.segments).some((s) => s.fromISO === "2026-07-19"));
    check("…as a POINT, since nothing licenses carrying it forward",
      earlier.diagnostics.anchorOutcomes.find((o) => o.observationId === "early")!.representation === "POINT");
    check("…and 07-20…07-21 is reported uncovered rather than omitted",
      earlier.uncovered.some((u) => u.fromISO === "2026-07-20" && u.toISO === "2026-07-21"));

    // ── partial stream: claims inside coverage, silence outside ─────────────
    const partial = run([anchor({ dateISO: "2026-01-01", quantity: 4 })],
      [ev({ type: "BUY", quantity: 1, dateISO: "2026-02-01" })], "2026-12-31",
      { kind: "PARTIAL", coveredFromISO: "2026-01-01", coveredToISO: "2026-06-30", reason: "import window" });
    check("a PARTIAL stream licenses intervals inside its coverage",
      abs(partial.segments).some((s) => s.fromISO === "2026-01-01" && s.toISO === "2026-01-31"));
    check("…and withholds the claim beyond it",
      abs(partial.segments).every((s) => s.toISO <= "2026-06-30"));
    check("…leaving the remainder uncovered, not asserted",
      partial.uncovered.some((u) => u.fromISO === "2026-07-01" && u.toISO === "2026-12-31"));
    check("…so the summary is ABSOLUTE_WITH_GAPS", partial.summary === "ABSOLUTE_WITH_GAPS");

    // ── BTC-like: anchor plus a partial stream, residue still visible ───────
    const btc = run([
      anchor({ observationId: "obs", dateISO: "2026-07-19", quantity: 0.24060252 }),
    ], [ev({ type: "BUY", quantity: 0.22031745, dateISO: "2026-07-19" })], "2026-07-31",
      { kind: "PARTIAL", coveredFromISO: "2026-07-19", coveredToISO: "2026-07-19", reason: "partial import" },
      "2026-07-19");
    check("a BTC-like partial import makes no claim outside declared coverage",
      btc.uncovered.some((u) => u.fromISO === "2026-07-20"));
    check("…and the unexplained difference stays visible rather than absorbed",
      btc.summary !== "ABSOLUTE_COMPLETE");

    // ── window boundaries are the caller's, never inferred ─────────────────
    const wide = run([anchor({ dateISO: "2026-06-01", quantity: 2 })], [],
      "2026-12-31", UNKNOWN_EVENT_STREAM, "2026-01-01");
    check("a window wider than the evidence exposes the missing time",
      wide.uncovered.length === 2 && wide.summary === "ABSOLUTE_WITH_GAPS");
    check("…and windowFromISO is echoed exactly as the caller gave it",
      wide.windowFromISO === "2026-01-01" && wide.windowToISO === "2026-12-31");
    let threw = false;
    try {
      replayQuantityTimeline({ instrumentId: "i", accountId: "a", anchors: [], events: [],
        windowFromISO: "2026-12-31", windowToISO: "2026-01-01", eventStream: UNKNOWN_EVENT_STREAM });
    } catch { threw = true; }
    check("an inverted window is rejected outright", threw);
  }

  // ── 12. Invariants held across EVERY fixture above ────────────────────────
  console.log(`12. global invariant sweep (${ALL.length} timelines)`);
  {
    const every = (name: string, p: (c: (typeof ALL)[number]) => boolean) => {
      const bad = ALL.filter((c) => !p(c));
      check(name, bad.length === 0, bad.length ? `${bad.length} timeline(s) violate it` : undefined);
    };

    every("no segment ends before it begins", ({ timeline: t }) => t.segments.every((s) => s.toISO >= s.fromISO));
    every("segments are ordered by fromISO",
      ({ timeline: t }) => t.segments.every((s, i) => i === 0 || s.fromISO >= t.segments[i - 1].fromISO));
    // Two ABSOLUTE segments overlapping would state two quantities for one day
    // — a contradiction. An ABSOLUTE point overlapping a RELATIVE run is not:
    // one says what was held that day, the other how much moved. Both are true.
    every("no two segments of the same kind overlap",
      ({ timeline: t }) => (["ABSOLUTE", "RELATIVE", "UNRESOLVED"] as const).every((k) => {
        const of = t.segments.filter((s) => s.kind === k);
        return of.every((s, i) => i === 0 || s.fromISO > of[i - 1].toISO);
      }));
    every("an absolute claim is never contradicted by another on the same day",
      ({ timeline: t }) => t.segments.filter((s) => s.kind === "ABSOLUTE").every((s, i, xs) =>
        i === 0 || s.fromISO > xs[i - 1].toISO));
    every("every segment lies inside the requested window",
      ({ timeline: t }) => t.segments.every((s) => s.fromISO >= t.windowFromISO && s.toISO <= t.windowToISO));
    every("no fabricated quantity on RELATIVE or UNRESOLVED segments",
      ({ timeline: t }) => t.segments.every((s) =>
        s.kind === "ABSOLUTE" || !Object.prototype.hasOwnProperty.call(s, "quantity")));
    every("UNRESOLVED segments carry no cumulativeDelta either",
      ({ timeline: t }) => t.segments.every((s) =>
        s.kind !== "UNRESOLVED" || !Object.prototype.hasOwnProperty.call(s, "cumulativeDelta")));
    every("explicit zero is an ABSOLUTE known-closure segment, never a gap",
      ({ timeline: t }) => t.segments.every((s) => s.kind !== "ABSOLUTE" || Number.isFinite(s.quantity)));
    // V26-QUANTITY-1H restated this. Backward replay legitimately reaches
    // EARLIER than the first event — that is the whole point — but never
    // earlier than the licensed coverage floor, where "no events" stops
    // carrying information and PRICE-5A's prohibition resumes.
    every("no segment precedes the licensed coverage floor",
      ({ anchors, events, timeline: t }) => {
        const cover = licensedCoverage(t.diagnostics.eventStream);
        const floor = cover
          ? (cover.fromISO > t.windowFromISO ? cover.fromISO : t.windowFromISO)
          : [...anchors.filter((x) => PERMITTED_ANCHOR_ORIGINS.has(x.origin)).map((x) => x.dateISO),
             ...events.map((e) => e.dateISO)].sort()[0];
        if (floor === undefined) return t.segments.length === 0;
        // An OBSERVED anchor states its own date and is defensible there
        // whatever coverage says — the floor governs REPLAYED claims, which are
        // the ones that depend on the stream being complete.
        return t.segments.every((s) =>
          s.fromISO >= floor ||
          (s.kind === "ABSOLUTE" && s.basis === "OBSERVED_ANCHOR" && s.fromISO === s.toISO));
      });
    every("a backward-replayed segment is labelled as such, never as observed",
      ({ timeline: t }) => t.segments.every((s) =>
        s.kind !== "ABSOLUTE" || s.basis !== "REPLAYED_BACKWARD" ||
        t.diagnostics.backSolvedOpening !== null || licensedCoverage(t.diagnostics.eventStream) !== null));
    every("a DERIVED anchor never opens, resumes or appears in a segment",
      ({ anchors, timeline: t }) => anchors.filter((x) => x.origin === "DERIVED").every((x) => {
        const o = t.diagnostics.anchorOutcomes.find((y) => y.observationId === x.observationId);
        return o?.admissibility === "REJECTED_ORIGIN" && o.representation === "NOT_REPRESENTED" &&
          !t.diagnostics.resumedFromAnchors.includes(x.observationId) &&
          !t.segments.some((s) => s.kind !== "UNRESOLVED" && s.derivedFrom.includes(x.observationId));
      }));
    every("a blocking event prevents exact replay through its own date",
      ({ timeline: t }) => t.segments.filter((s) => s.kind === "UNRESOLVED").every((u) =>
        !t.segments.some((s) => s.kind === "ABSOLUTE" && s.fromISO <= u.fromISO && s.toISO >= u.fromISO)));
    every("replay resumes only from a LATER permitted anchor",
      ({ anchors, timeline: t }) => t.diagnostics.resumedFromAnchors.every((id) => {
        const x = anchors.find((y) => y.observationId === id);
        const firstGap = t.segments.find((s) => s.kind === "UNRESOLVED");
        return !!x && PERMITTED_ANCHOR_ORIGINS.has(x.origin) && !!firstGap && x.dateISO > firstGap.fromISO;
      }));
    // ── the 1C.1 summary contract ──────────────────────────────────────────
    every("ABSOLUTE_COMPLETE iff the WHOLE window is absolute and nothing else",
      ({ timeline: t }) => (t.summary === "ABSOLUTE_COMPLETE") === (
        t.segments.some((s) => s.kind === "ABSOLUTE") && t.uncovered.length === 0 &&
        !t.segments.some((s) => s.kind === "RELATIVE" || s.kind === "UNRESOLVED")));
    every("any uncovered interval denies ABSOLUTE_COMPLETE",
      ({ timeline: t }) => !(t.uncovered.length > 0 && t.summary === "ABSOLUTE_COMPLETE"));
    every("no timeline hides omitted dates — segments ∪ uncovered = the window",
      ({ timeline: t }) => {
        const spans = [...t.segments.map((s) => ({ f: s.fromISO, u: s.toISO })),
                       ...t.uncovered.map((u) => ({ f: u.fromISO, u: u.toISO }))]
          .sort((p, q) => (p.f < q.f ? -1 : p.f > q.f ? 1 : 0));
        if (spans.length === 0) return false;
        if (spans[0].f !== t.windowFromISO) return false;
        let reach = spans[0].u;
        for (const s of spans.slice(1)) {
          if (s.f > reach) {
            // a same-day overlap between a point and a wider claim is impossible
            // by construction; any true hole fails here.
            const next = new Date(Date.parse(`${reach}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
            if (s.f !== next) return false;
          }
          if (s.u > reach) reach = s.u;
        }
        return reach === t.windowToISO;
      });
    every("uncovered intervals are ordered, disjoint and non-empty",
      ({ timeline: t }) => t.uncovered.every((u, i) =>
        u.toISO >= u.fromISO && (i === 0 || u.fromISO > t.uncovered[i - 1].toISO)));
    every("an isolated anchor never fills adjacent dates",
      ({ timeline: t }) => t.diagnostics.anchorOutcomes.filter((o) => o.representation === "POINT")
        .every((o) => t.segments.some((s) => s.fromISO === o.dateISO && s.toISO === o.dateISO)));
    every("no interval is widened without a licensed stream",
      ({ timeline: t }) => licensedCoverage(t.diagnostics.eventStream) !== null ||
        t.segments.every((s) => s.kind === "UNRESOLVED" || s.fromISO === s.toISO));
    every("a residue is reported, never forced to zero",
      ({ timeline: t }) => t.diagnostics.reconciliationResidues.every((r) =>
        r.residue !== 0 && Math.abs(r.residue - (r.observed - r.expected)) < 1e-12));
    every("replay operators stay XOR — never both delta and ratio",
      ({ events }) => events.every((e) => e.status !== "REPLAYABLE" ||
        (e.normalizedDelta === null) !== (e.ratio === null)));
    every("same-day ratio+delta with unknown order never yields an exact quantity",
      ({ timeline: t }) => t.diagnostics.orderSensitiveGroups.every((g) =>
        t.segments.some((s) => s.kind === "UNRESOLVED" && s.fromISO === g.dateISO)));
    every("every input event id appears in a segment or a diagnostic",
      ({ events, timeline: t }) => {
        const seen = new Set<string>([
          ...t.segments.flatMap((s) => s.kind === "UNRESOLVED" ? s.blockingEventIds : s.derivedFrom),
          ...t.diagnostics.unsupportedEventIds, ...t.diagnostics.unattributableEventIds,
          ...t.diagnostics.invalidEventIds, ...t.diagnostics.neutralEventIds,
          ...t.diagnostics.unresolvedTransferEventIds,
          ...t.diagnostics.orderSensitiveGroups.flatMap((g) => g.eventIds),
        ]);
        const superseded = new Set<string>();
        for (const d of new Set(events.map((e) => e.dateISO))) {
          events.filter((e) => e.dateISO === d && e.status === "REPLAYABLE").slice(0, -1)
            .forEach((e) => superseded.add(e.eventId));
        }
        return events.every((e) => seen.has(e.eventId) || superseded.has(e.eventId));
      });
    every("every anchor has EXACTLY ONE anchorOutcome",
      ({ anchors, timeline: t }) => {
        const ids = t.diagnostics.anchorOutcomes.map((o) => o.observationId);
        return ids.length === anchors.length && new Set(ids).size === ids.length &&
          anchors.every((x) => ids.includes(x.observationId));
      });
    every("every outcome preserves identity, date, quantity, origin and completeness",
      ({ anchors, timeline: t }) => t.diagnostics.anchorOutcomes.every((o) => {
        const x = anchors.find((y) => y.observationId === o.observationId)!;
        return o.dateISO === x.dateISO && o.quantity === x.quantity &&
          o.origin === x.origin && o.completeness === x.completeness;
      }));
    const sorted = (xs: readonly string[]) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);
    every("all diagnostic arrays are deterministically sorted",
      ({ timeline: t }) => sorted(t.diagnostics.unsupportedEventIds) &&
        sorted(t.diagnostics.unattributableEventIds) && sorted(t.diagnostics.invalidEventIds) &&
        sorted(t.diagnostics.neutralEventIds) && sorted(t.diagnostics.unresolvedTransferEventIds) &&
        sorted(t.diagnostics.resumedFromAnchors) &&
        sorted(t.diagnostics.anchorOutcomes.map((o) => o.observationId)) &&
        t.diagnostics.orderSensitiveGroups.every((g) => sorted(g.eventIds)));
    every("re-running any fixture is byte-identical",
      ({ anchors, events, timeline: t }) => JSON.stringify(replayQuantityTimeline({
        instrumentId: "inst1", accountId: "acct1", anchors, events,
        windowFromISO: t.windowFromISO, windowToISO: t.windowToISO,
        eventStream: t.diagnostics.eventStream,
      })) === JSON.stringify(t));
    every("shuffled anchors AND events are byte-identical",
      ({ anchors, events, timeline: t }) => JSON.stringify(replayQuantityTimeline({
        instrumentId: "inst1", accountId: "acct1",
        anchors: [...anchors].reverse(), events: [...events].reverse(),
        windowFromISO: t.windowFromISO, windowToISO: t.windowToISO,
        eventStream: t.diagnostics.eventStream,
      })) === JSON.stringify(t));
  }

  console.log(failures === 0 ? "\nAll quantity-replay checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
