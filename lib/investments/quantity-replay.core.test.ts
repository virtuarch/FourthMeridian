/**
 * lib/investments/quantity-replay.core.test.ts
 *
 * V26-QUANTITY-1C — replay fixtures. Standalone tsx script:
 *
 *     npx tsx lib/investments/quantity-replay.core.test.ts
 *
 * The properties that matter most:
 *   - a delta without an anchor NEVER becomes an absolute quantity;
 *   - no segment exists before the first defensible evidence (PRICE-5A);
 *   - the summary never hides an UNRESOLVED segment.
 */

import {
  replayQuantityTimeline, classifySameDayGroup, summarise,
  PERMITTED_ANCHOR_ORIGINS,
  type QuantityAnchor, type QuantityTimelineSegment,
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
 * Every timeline any fixture produces, with the input that produced it. The
 * closing sweep asserts the replay invariants across ALL of them, so a fixture
 * added for one property is automatically held to every other property too.
 */
const ALL: Array<{
  anchors: QuantityAnchor[];
  events: ReturnType<typeof ev>[];
  timeline: ReturnType<typeof replayQuantityTimeline>;
}> = [];

const run = (anchors: QuantityAnchor[], events: ReturnType<typeof ev>[], to = "2026-12-31") => {
  const timeline = replayQuantityTimeline({
    instrumentId: "inst1", accountId: "acct1", anchors, events, windowToISO: to,
  });
  ALL.push({ anchors, events, timeline });
  return timeline;
};

const abs = (s: QuantityTimelineSegment[]) => s.filter((x) => x.kind === "ABSOLUTE");
const rel = (s: QuantityTimelineSegment[]) => s.filter((x) => x.kind === "RELATIVE");
const unres = (s: QuantityTimelineSegment[]) => s.filter((x) => x.kind === "UNRESOLVED");

function main(): void {
  // ── 0. Purity ─────────────────────────────────────────────────────────────
  // Read the module's own source. A pure core stays pure only if something
  // fails when it stops being pure.
  console.log("0. purity");
  {
    const src = readFileSync(join(import.meta.dirname, "quantity-replay.core.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    check("imports ONLY the QUANTITY-1B contract",
      imports.length === 1 && imports[0] === "./quantity-event.core", imports.join(", "));
    check("no Prisma import", !/@prisma\/client|["']prisma/.test(src));
    check("no database import", !/lib\/db|["']\.\.?\/db|prisma\./.test(src));
    check("no provider import", !/lib\/prices|provider|tiingo|coingecko/i.test(src));
    // Date is used only to normalise supplied ISO strings — never to ask the
    // ambient clock what day it is.
    check("no ambient clock", !/Date\.now\(|new Date\(\s*\)|toISOString\(\)\s*\)\s*;?\s*\/\/\s*now/.test(src));
    check("no filesystem, network or randomness",
      !/require\(|fetch\(|Math\.random|readFile|process\.env/.test(src));
  }

  // ── 1. Absolute replay ────────────────────────────────────────────────────
  console.log("1. absolute replay");
  {
    const r = run([anchor({ quantity: 10 })], [ev({ type: "BUY", quantity: 5 })]);
    check("anchor + BUY → ABSOLUTE_COMPLETE", r.summary === "ABSOLUTE_COMPLETE");
    const last = abs(r.segments).at(-1)!;
    check("…closing quantity 10 + 5 = 15", last.kind === "ABSOLUTE" && last.quantity === 15);
    check("…the opening segment is the anchor itself",
      abs(r.segments)[0].kind === "ABSOLUTE" && abs(r.segments)[0].basis === "OBSERVED_ANCHOR");
    check("…and the anchor is recorded as USED_OPENING",
      r.diagnostics.anchorOutcomes.some((o) => o.disposition === "USED_OPENING"));

    const many = run([anchor({ quantity: 0 })], [
      ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" }),
      ev({ type: "BUY", quantity: 2, dateISO: "2026-04-01" }),
    ]);
    check("multiple BUYs accumulate", (abs(many.segments).at(-1) as never as { quantity: number }).quantity === 5);

    const partial = run([anchor({ quantity: 10 })], [ev({ type: "SELL", quantity: 4 })]);
    check("partial SELL → 6", (abs(partial.segments).at(-1) as never as { quantity: number }).quantity === 6);

    const exit = run([anchor({ quantity: 1 })], [ev({ type: "SELL", quantity: 1 })]);
    const zeroSeg = abs(exit.segments).at(-1) as never as { quantity: number };
    check("full exit produces an explicit ZERO segment, not an absent one",
      zeroSeg.quantity === 0 && abs(exit.segments).length >= 2);
    check("…zero is KNOWN closure, so the summary stays ABSOLUTE_COMPLETE",
      exit.summary === "ABSOLUTE_COMPLETE");

    const reentry = run([anchor({ quantity: 1 })], [
      ev({ type: "SELL", quantity: 1, dateISO: "2026-03-01" }),
      ev({ type: "BUY",  quantity: 3, dateISO: "2026-06-01" }),
    ]);
    const q = abs(reentry.segments).map((s) => (s as never as { quantity: number }).quantity);
    check("re-entry after zero opens a new positive segment", q.includes(0) && q.at(-1) === 3);

    const short = run([anchor({ quantity: 0 })], [ev({ type: "SELL", quantity: 2.0058 })]);
    check("negative/short quantity is preserved, never clamped",
      (abs(short.segments).at(-1) as never as { quantity: number }).quantity === -2.0058);

    const split = run([anchor({ quantity: 5 })], [ev({ type: "SPLIT", quantity: 0, ratio: 4 })]);
    check("a valid split MULTIPLIES (5 × 4 = 20)",
      (abs(split.segments).at(-1) as never as { quantity: number }).quantity === 20);
  }

  // ── 2. No anchor → relative only ──────────────────────────────────────────
  console.log("2. no anchor → RELATIVE, never absolute");
  {
    const buyFirst = run([], [ev({ type: "BUY", quantity: 3 })]);
    check("a first BUY 3 does NOT establish quantity 3", abs(buyFirst.segments).length === 0);
    check("…it yields RELATIVE_ONLY", buyFirst.summary === "RELATIVE_ONLY");
    check("…carrying cumulativeDelta, not quantity",
      (rel(buyFirst.segments)[0] as never as { cumulativeDelta: number }).cumulativeDelta === 3);
    check("…and the missing anchor is reported", buyFirst.diagnostics.missingOpeningAnchor === true);

    const sellFirst = run([], [ev({ type: "SELL", quantity: 1 })]);
    check("a first SELL 1 does NOT establish −1 holdings", abs(sellFirst.segments).length === 0);
    check("…cumulative delta is −1", (rel(sellFirst.segments).at(-1) as never as { cumulativeDelta: number }).cumulativeDelta === -1);

    const several = run([], [
      ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" }),
      ev({ type: "SELL", quantity: 1, dateISO: "2026-04-01" }),
    ]);
    check("several deltas accumulate relatively",
      (rel(several.segments).at(-1) as never as { cumulativeDelta: number }).cumulativeDelta === 2);

    // PRICE-5A: nothing before the first defensible evidence.
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
      derived.diagnostics.anchorOutcomes[0].disposition === "REJECTED_ORIGIN");
    check("…so the timeline falls back to RELATIVE_ONLY", derived.summary === "RELATIVE_ONLY");
    check("…and the rejection reason is recorded", derived.diagnostics.anchorRejectedReason !== null);

    for (const origin of ["OBSERVED", "IMPORTED", "USER_ASSERTED"]) {
      check(`${origin} is a permitted anchor origin`,
        PERMITTED_ANCHOR_ORIGINS.has(origin) &&
        run([anchor({ origin })], [ev({ type: "BUY", quantity: 5 })]).summary === "ABSOLUTE_COMPLETE");
    }
    check("DERIVED is not in the allowlist", !PERMITTED_ANCHOR_ORIGINS.has("DERIVED"));
  }

  // ── 4. Anchor date vs event date ──────────────────────────────────────────
  console.log("4. anchor temporal precision");
  {
    const before = run([anchor({ dateISO: "2026-02-28", quantity: 4 })],
      [ev({ type: "BUY", quantity: 1, dateISO: "2026-03-01" })]);
    check("an anchor strictly BEFORE the first event opens the run",
      before.summary === "ABSOLUTE_COMPLETE" &&
      (abs(before.segments).at(-1) as never as { quantity: number }).quantity === 5);

    // The APLD shape: same-day observation is an END-of-day state.
    const sameDay = run([anchor({ dateISO: "2026-03-01", quantity: 3 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" })]);
    check("a same-day anchor WITHOUT a timestamp is NOT an opening (no 3+3=6)",
      sameDay.summary === "RELATIVE_ONLY");
    check("…it is recorded AMBIGUOUS_SAME_DAY, not silently dropped",
      sameDay.diagnostics.anchorOutcomes[0].disposition === "AMBIGUOUS_SAME_DAY");

    const timed = run(
      [anchor({ dateISO: "2026-03-01", effectiveDateTimeISO: "2026-03-01T09:00:00.000Z", quantity: 3 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01", datetimeISO: "2026-03-01T15:00:00.000Z" })]);
    check("a same-day anchor with a PROVABLY EARLIER timestamp IS an opening",
      timed.summary === "ABSOLUTE_COMPLETE" &&
      (abs(timed.segments).at(-1) as never as { quantity: number }).quantity === 6);
  }

  // ── 5. Same-day classification ────────────────────────────────────────────
  console.log("5. same-day commutativity");
  {
    const deltas = [ev({ type: "BUY", quantity: 1 }), ev({ type: "SELL", quantity: 2 })];
    check("all-delta group without datetimes is COMMUTATIVE",
      classifySameDayGroup(deltas) === "COMMUTATIVE");
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
      commutative.summary === "ABSOLUTE_COMPLETE" &&
      (abs(commutative.segments).at(-1) as never as { quantity: number }).quantity === 9);

    const blocked = run([anchor({ quantity: 10 })], mixed);
    check("an ORDER_SENSITIVE group STOPS absolute replay", unres(blocked.segments).length === 1);
    check("…rather than emitting one of two possible quantities",
      blocked.summary === "ABSOLUTE_WITH_GAPS");
    check("…and the group is reported", blocked.diagnostics.orderSensitiveGroups.length === 1);

    const ordered = run([anchor({ quantity: 10 })], timedMixed);
    check("with evidenced chronology the same shape replays ((10+1)×2 = 22)",
      ordered.summary === "ABSOLUTE_COMPLETE" &&
      (abs(ordered.segments).at(-1) as never as { quantity: number }).quantity === 22);
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
    check("…absoluteResolvedThroughISO marks the last defensible date",
      transfer.diagnostics.absoluteResolvedThroughISO === "2026-04-30");

    const badSplit = run([anchor({ quantity: 5 })], [ev({ type: "SPLIT", quantity: 10, ratio: null })]);
    check("an INVALID split stops exact replay", unres(badSplit.segments).length === 1);
    check("…recorded as INVALID_EVENT",
      (unres(badSplit.segments)[0] as never as { reason: string }).reason === "INVALID_EVENT");

    const dividend = run([anchor({ quantity: 5 })], [ev({ type: "DIVIDEND", quantity: 0 })]);
    check("a neutral dividend does not alter quantity",
      (abs(dividend.segments).at(-1) as never as { quantity: number }).quantity === 5);
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
    check("an intermediate anchor that AGREES is marked CONFIRMING",
      confirming.diagnostics.anchorOutcomes.find((o) => o.observationId === "mid")!.disposition === "CONFIRMING");
    check("…with no residue recorded", confirming.diagnostics.reconciliationResidues.length === 0);

    const mismatch = run([
      anchor({ observationId: "open", dateISO: "2026-01-01", quantity: 10 }),
      anchor({ observationId: "mid",  dateISO: "2026-03-01", quantity: 99 }),
    ], [ev({ type: "BUY", quantity: 5, dateISO: "2026-03-01" })]);
    check("a DISAGREEING intermediate anchor records a residue, not a forced equality",
      mismatch.diagnostics.reconciliationResidues.length === 1 &&
      mismatch.diagnostics.reconciliationResidues[0].residue === 84);
    check("…and replay keeps its own value rather than snapping to the anchor",
      (abs(mismatch.segments).at(-1) as never as { quantity: number }).quantity === 15);

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
      abs(resumed.segments).some((s) => (s as never as { quantity: number }).quantity === 42));
    check("…the gap is bounded by the resume anchor",
      (unres(resumed.segments)[0] as never as { toISO: string }).toISO === "2026-05-31");
    check("…and the summary admits the gap", resumed.summary === "ABSOLUTE_WITH_GAPS");

    const mixedCandidates = run([
      anchor({ observationId: "derived", dateISO: "2026-01-01", origin: "DERIVED", quantity: 99 }),
      anchor({ observationId: "good",    dateISO: "2026-02-01", quantity: 4 }),
      anchor({ observationId: "sameday", dateISO: "2026-03-01", quantity: 7 }),
    ], [ev({ type: "BUY", quantity: 1, dateISO: "2026-03-01" })]);
    const disp = (id: string) => mixedCandidates.diagnostics.anchorOutcomes.find((o) => o.observationId === id)!.disposition;
    check("several candidates are each given an explicit fate",
      disp("derived") === "REJECTED_ORIGIN" && disp("good") === "USED_OPENING" &&
      disp("sameday") === "AMBIGUOUS_SAME_DAY");
    check("…and every anchor appears in the outcomes",
      mixedCandidates.diagnostics.anchorOutcomes.length === 3);
  }

  // ── 8. THE SUMMARY MUST NOT HIDE A GAP ────────────────────────────────────
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

    // The invariant, stated directly.
    const cases = [withGaps, run([anchor()], [ev({ type: "BUY", quantity: 1 })]),
      run([], [ev({ type: "BUY", quantity: 1 })]), run([], [])];
    check("NO timeline containing an UNRESOLVED segment reports ABSOLUTE_COMPLETE",
      cases.every((t) => !(t.segments.some((s) => s.kind === "UNRESOLVED") && t.summary === "ABSOLUTE_COMPLETE")));
    check("summarise() is derived from ALL segments",
      summarise([{ kind: "ABSOLUTE", fromISO: "a", toISO: null, quantity: 1, basis: "REPLAYED", derivedFrom: [], orderCertainty: "KNOWN" },
                 { kind: "UNRESOLVED", fromISO: "b", toISO: null, reason: "UNSUPPORTED_EVENT", blockingEventIds: [] }]) === "ABSOLUTE_WITH_GAPS");
    check("an empty timeline is UNREPLAYABLE", run([], []).summary === "UNREPLAYABLE");
    check("an anchor with no events still states a holding",
      run([anchor({ quantity: 8 })], []).summary === "ABSOLUTE_COMPLETE");
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
    check("segments are ascending and non-overlapping",
      fwd.segments.every((s, i) => i === 0 || s.fromISO > (fwd.segments[i - 1].toISO ?? s.fromISO) ||
        s.fromISO >= fwd.segments[i - 1].fromISO));
    // A run superseded on the day it opened must vanish, not invert.
    const everyTimeline = [fwd, rev, ...([
      run([anchor({ quantity: 10 })], [ev({ type: "BUY", quantity: 1 }), ev({ type: "SELL", quantity: 2 })]),
      run([], [ev({ type: "BUY", quantity: 3 })]),
      run([anchor({ dateISO: "2026-03-01", effectiveDateTimeISO: "2026-03-01T09:00:00.000Z" })],
          [ev({ type: "BUY", quantity: 1, dateISO: "2026-03-01", datetimeISO: "2026-03-01T15:00:00.000Z" })]),
    ])];
    check("NO segment ends before it begins (no degenerate empty segments)",
      everyTimeline.every((t) => t.segments.every((s) => s.toISO === null || s.toISO >= s.fromISO)));
    check("tie-breaking never converts uncertainty to KNOWN",
      run([anchor()], [ev({ type: "BUY", quantity: 1 }), ev({ type: "SELL", quantity: 1 })])
        .segments.filter((s) => s.kind !== "UNRESOLVED")
        .every((s) => (s as never as { orderCertainty: string }).orderCertainty === "TIE_BROKEN" ||
                      (s as never as { basis?: string }).basis === "OBSERVED_ANCHOR"));
  }

  // ── 10. Real corpus shapes ────────────────────────────────────────────────
  console.log("10. real corpus shapes");
  {
    // SPCE: observed 1 on 07-19, SELL 1 on 07-27, observed 0 after.
    const spce = run([anchor({ dateISO: "2026-07-19", quantity: 1 })],
      [ev({ type: "SELL", quantity: 1, dateISO: "2026-07-27" })], "2026-07-31");
    check("SPCE replays to zero and reconciles",
      spce.summary === "ABSOLUTE_COMPLETE" &&
      (abs(spce.segments).at(-1) as never as { quantity: number }).quantity === 0);

    // NVDA: negative anchor, buys and a sell.
    const nvda = run([anchor({ dateISO: "2025-10-01", quantity: -2.0058 })], [
      ev({ type: "BUY", quantity: 0.0029, dateISO: "2025-10-02" }),
      ev({ type: "SELL", quantity: 2.003, dateISO: "2026-07-27" }),
    ], "2026-07-31");
    check("NVDA keeps a negative holding throughout",
      (abs(nvda.segments).at(-1) as never as { quantity: number }) .quantity < 0);

    // TQQQ: the invalid split blocks it.
    const tqqq = run([anchor({ dateISO: "2025-11-19", quantity: -20 })],
      [ev({ type: "SPLIT", quantity: 10, ratio: null, dateISO: "2025-11-20" })], "2026-07-31");
    check("TQQQ is blocked by its invalid split", tqqq.summary === "ABSOLUTE_WITH_GAPS");

    // APLD: same-day observation and buy — the ambiguity case.
    const apld = run([anchor({ dateISO: "2026-06-25", quantity: 3 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-06-25" })], "2026-07-31");
    check("APLD's same-day anchor does not double-count", apld.summary === "RELATIVE_ONLY");

    // A pair with no replayable events at all.
    const none = run([anchor({ dateISO: "2026-07-19", quantity: 0.2406 })], [], "2026-07-31");
    check("a pair with observations only still states its holding",
      none.summary === "ABSOLUTE_COMPLETE");

    // A pair blocked purely by transfer semantics.
    const blocked = run([anchor({ dateISO: "2026-01-01", quantity: 5 })],
      [ev({ type: "TRANSFER_OUT", quantity: -1, dateISO: "2026-03-01" })]);
    check("a transfer-blocked pair reports the gap and the transfer id",
      blocked.summary === "ABSOLUTE_WITH_GAPS" &&
      blocked.diagnostics.unresolvedTransferEventIds.length === 1);
  }

  // ── 11. Invariants held across EVERY fixture above ────────────────────────
  console.log(`11. global invariant sweep (${ALL.length} timelines)`);
  {
    const every = (name: string, p: (c: (typeof ALL)[number]) => boolean) => {
      const bad = ALL.filter((c) => !p(c));
      check(name, bad.length === 0, bad.length ? `${bad.length} timeline(s) violate it` : undefined);
    };

    every("no segment ends before it begins",
      ({ timeline: t }) => t.segments.every((s) => s.toISO === null || s.toISO >= s.fromISO));
    every("segments are ordered by fromISO",
      ({ timeline: t }) => t.segments.every((s, i) => i === 0 || s.fromISO >= t.segments[i - 1].fromISO));
    every("segments do not overlap",
      ({ timeline: t }) => t.segments.every((s, i) => {
        const prev = t.segments[i - 1];
        return i === 0 || (prev.toISO !== null && s.fromISO > prev.toISO);
      }));
    every("no fabricated quantity on RELATIVE or UNRESOLVED segments",
      ({ timeline: t }) => t.segments.every((s) =>
        s.kind === "ABSOLUTE" || !Object.prototype.hasOwnProperty.call(s, "quantity")));
    every("UNRESOLVED segments carry no cumulativeDelta either",
      ({ timeline: t }) => t.segments.every((s) =>
        s.kind !== "UNRESOLVED" || !Object.prototype.hasOwnProperty.call(s, "cumulativeDelta")));
    every("explicit zero is an ABSOLUTE known-closure segment, never a gap",
      ({ timeline: t }) => t.segments.every((s) => s.kind !== "ABSOLUTE" || Number.isFinite(s.quantity)));
    every("no segment precedes the first defensible evidence",
      ({ anchors, events, timeline: t }) => {
        const earliest = [
          ...anchors.filter((a) => PERMITTED_ANCHOR_ORIGINS.has(a.origin)).map((a) => a.dateISO),
          ...events.map((e) => e.dateISO),
        ].sort()[0];
        return earliest === undefined ? t.segments.length === 0 : t.segments.every((s) => s.fromISO >= earliest);
      });
    every("a DERIVED anchor never opens or resumes an absolute run",
      ({ anchors, timeline: t }) => anchors.filter((a) => a.origin === "DERIVED").every((a) => {
        const o = t.diagnostics.anchorOutcomes.find((x) => x.observationId === a.observationId);
        return o?.disposition === "REJECTED_ORIGIN" &&
          !t.diagnostics.resumedFromAnchors.includes(a.observationId) &&
          !t.segments.some((s) => s.kind === "ABSOLUTE" && s.derivedFrom.includes(a.observationId));
      }));
    every("a blocking event prevents exact replay through its own date",
      ({ timeline: t }) => {
        const blockedDates = t.segments.filter((s) => s.kind === "UNRESOLVED").map((s) => s.fromISO);
        return blockedDates.every((d) =>
          !t.segments.some((s) => s.kind === "ABSOLUTE" && s.fromISO <= d && (s.toISO === null || s.toISO >= d)));
      });
    every("replay resumes only from a LATER permitted anchor",
      ({ anchors, timeline: t }) => t.diagnostics.resumedFromAnchors.every((id) => {
        const a = anchors.find((x) => x.observationId === id);
        const firstGap = t.segments.find((s) => s.kind === "UNRESOLVED");
        return !!a && PERMITTED_ANCHOR_ORIGINS.has(a.origin) && !!firstGap && a.dateISO > firstGap.fromISO;
      }));
    every("no UNRESOLVED segment coexists with ABSOLUTE_COMPLETE",
      ({ timeline: t }) => !(t.summary === "ABSOLUTE_COMPLETE" && t.segments.some((s) => s.kind === "UNRESOLVED")));
    every("summary always equals summarise(segments)",
      ({ timeline: t }) => t.summary === summarise(t.segments));
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
          ...t.diagnostics.invalidEventIds, ...t.diagnostics.unresolvedTransferEventIds,
          ...t.diagnostics.neutralEventIds,
          ...t.diagnostics.orderSensitiveGroups.flatMap((g) => g.eventIds),
        ]);
        // A replayable event folded into a later run on the same day is
        // represented by that run's closing quantity; only genuinely dropped
        // events are a defect, so require every NON-superseded id.
        const superseded = new Set<string>();
        for (const d of new Set(events.map((e) => e.dateISO))) {
          const day = events.filter((e) => e.dateISO === d && e.status === "REPLAYABLE");
          day.slice(0, -1).forEach((e) => superseded.add(e.eventId));
        }
        return events.every((e) => seen.has(e.eventId) || superseded.has(e.eventId));
      });
    every("every anchor has EXACTLY ONE anchorOutcome",
      ({ anchors, timeline: t }) => {
        const ids = t.diagnostics.anchorOutcomes.map((o) => o.observationId);
        return ids.length === anchors.length && new Set(ids).size === ids.length &&
          anchors.every((a) => ids.includes(a.observationId));
      });
    const sorted = (xs: readonly string[]) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);
    every("all diagnostic arrays are deterministically sorted",
      ({ timeline: t }) => sorted(t.diagnostics.unsupportedEventIds) &&
        sorted(t.diagnostics.unattributableEventIds) && sorted(t.diagnostics.invalidEventIds) &&
        sorted(t.diagnostics.neutralEventIds) &&
        sorted(t.diagnostics.unresolvedTransferEventIds) && sorted(t.diagnostics.resumedFromAnchors) &&
        sorted(t.diagnostics.anchorOutcomes.map((o) => o.observationId)) &&
        t.diagnostics.orderSensitiveGroups.every((g) => sorted(g.eventIds)));
    every("re-running any fixture is byte-identical",
      ({ anchors, events, timeline: t }) => JSON.stringify(replayQuantityTimeline({
        instrumentId: "inst1", accountId: "acct1", anchors, events, windowToISO: t.windowToISO,
      })) === JSON.stringify(t));
    every("shuffled anchors AND events are byte-identical",
      ({ anchors, events, timeline: t }) => JSON.stringify(replayQuantityTimeline({
        instrumentId: "inst1", accountId: "acct1",
        anchors: [...anchors].reverse(), events: [...events].reverse(), windowToISO: t.windowToISO,
      })) === JSON.stringify(t));
  }

  console.log(failures === 0 ? "\nAll quantity-replay checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
