/**
 * lib/investments/quantity-reconciliation.core.test.ts
 *
 * V26-QUANTITY-1D fixtures. Standalone tsx script:
 *
 *     npx tsx lib/investments/quantity-reconciliation.core.test.ts
 *
 * The property that matters most: a candidate explanation must never be
 * mistakable for a fact, and must never become an anchor.
 */

import {
  reconcileQuantityTimeline, CANDIDATE_KINDS, BACK_SOLVE_REFUSALS,
  type ReconciliationReport,
} from "./quantity-reconciliation.core";
import {
  replayQuantityTimeline, PERMITTED_ANCHOR_ORIGINS, UNKNOWN_EVENT_STREAM,
  type QuantityAnchor, type EventStreamCompleteness,
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
const COMPLETE = (fromISO = "1900-01-01", toISO = "2100-01-01"): EventStreamCompleteness =>
  ({ kind: "COMPLETE", fromISO, toISO, source: "fixture" });

const ALL: ReconciliationReport[] = [];
function reconcile(
  anchors: QuantityAnchor[], events: ReturnType<typeof ev>[],
  stream: EventStreamCompleteness = UNKNOWN_EVENT_STREAM,
  from = "2026-01-01", to = "2026-12-31",
): ReconciliationReport {
  const timeline = replayQuantityTimeline({
    instrumentId: "inst1", accountId: "acct1", anchors, events,
    windowFromISO: from, windowToISO: to, eventStream: stream,
  });
  const report = reconcileQuantityTimeline({ timeline, events });
  ALL.push(report);
  return report;
}
const factKinds = (r: ReconciliationReport) => r.facts.map((f) => f.kind);
const candKinds = (r: ReconciliationReport) =>
  [...r.residues, ...r.unattributedDifferences].flatMap((x) => x.candidates.map((c) => c.kind));

function main(): void {
  // ── 0. Purity ─────────────────────────────────────────────────────────────
  console.log("0. purity");
  {
    const src = readFileSync(join(import.meta.dirname, "quantity-reconciliation.core.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    check("imports only the 1B and 1C contracts",
      imports.every((i) => i === "./quantity-event.core" || i === "./quantity-replay.core"),
      imports.join(", "));
    const specifiers = imports.join(" ");
    check("no Prisma, database or provider import",
      !/@prisma|prisma|lib\/db|lib\/prices|tiingo|coingecko/i.test(specifiers));
    check("no ambient clock", !/Date\.now\(|new Date\(\s*\)/.test(src));
    check("no filesystem, network or randomness",
      !/require\(|fetch\(|Math\.random|readFile|process\.env/.test(src));
    check("it never replays — no arithmetic loop over events beyond summing deltas",
      !/quantity\s*\*=|\.ratio\s*\*/.test(src));
  }

  // ── 1. Observed facts are read, not inferred ──────────────────────────────
  console.log("1. observed facts");
  {
    const clean = reconcile([anchor({ quantity: 10 })], [ev({ type: "BUY", quantity: 5 })], COMPLETE());
    check("a fully covered, fully explained timeline is CLEAN", clean.summary === "CLEAN");
    check("…with no facts at all", clean.facts.length === 0);

    const unknown = reconcile([anchor({ quantity: 10 })], [ev({ type: "BUY", quantity: 5 })]);
    check("an UNKNOWN stream is stated as a fact",
      factKinds(unknown).includes("STREAM_COMPLETENESS_UNKNOWN"));
    check("…as are the uncovered intervals it causes",
      factKinds(unknown).includes("UNCOVERED_INTERVAL_PRESENT"));
    check("…and the summary is FACTS_ONLY, not a difference",
      unknown.summary === "FACTS_ONLY");

    const noAnchor = reconcile([], [ev({ type: "BUY", quantity: 3 })], COMPLETE());
    check("a missing opening anchor is a fact", factKinds(noAnchor).includes("MISSING_OPENING_ANCHOR"));

    const transfer = reconcile([anchor({ quantity: 5 })],
      [ev({ type: "TRANSFER_IN", quantity: -2, dateISO: "2026-05-01" })], COMPLETE());
    check("an unsupported transfer is a fact with its id",
      factKinds(transfer).includes("UNSUPPORTED_TRANSFER_PRESENT") &&
      transfer.facts.find((f) => f.kind === "UNSUPPORTED_TRANSFER_PRESENT")!.evidenceIds.length === 1);
    check("…and so is the interval it blocks", factKinds(transfer).includes("BLOCKED_INTERVAL"));

    const badSplit = reconcile([anchor({ quantity: 5 })],
      [ev({ type: "SPLIT", quantity: 10, ratio: null })], COMPLETE());
    check("an invalid event is a fact", factKinds(badSplit).includes("INVALID_EVENT_PRESENT"));

    const orphan = reconcile([anchor({ quantity: 5 })], [ev({ instrumentId: null })], COMPLETE());
    check("an unattributable event is a fact",
      factKinds(orphan).includes("UNATTRIBUTABLE_EVENT_PRESENT"));

    const derived = reconcile([anchor({ origin: "DERIVED" })], [ev({ type: "BUY", quantity: 1 })], COMPLETE());
    check("a rejected DERIVED anchor is a fact", factKinds(derived).includes("REJECTED_DERIVED_ANCHOR"));

    const ambiguous = reconcile([anchor({ dateISO: "2026-03-01", quantity: 3 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" })], COMPLETE());
    check("an ambiguous same-day anchor is a fact",
      factKinds(ambiguous).includes("AMBIGUOUS_SAME_DAY_ANCHOR"));

    const orderSensitive = reconcile([anchor({ quantity: 10 })],
      [ev({ type: "BUY", quantity: 1 }), ev({ type: "SPLIT", ratio: 2, quantity: 0 })], COMPLETE());
    check("an order-sensitive group is a fact",
      factKinds(orderSensitive).includes("ORDER_SENSITIVE_GROUP_PRESENT"));

    const partial = reconcile([anchor({ quantity: 5 })], [ev({ type: "BUY", quantity: 1 })],
      { kind: "PARTIAL", coveredFromISO: "2026-01-01", coveredToISO: "2026-06-30", reason: "import window" });
    check("a PARTIAL stream is a fact distinct from UNKNOWN",
      factKinds(partial).includes("STREAM_COMPLETENESS_PARTIAL") &&
      !factKinds(partial).includes("STREAM_COMPLETENESS_UNKNOWN"));

    check("facts are emitted in declaration order, always",
      ALL.every((r) => r.facts.every((f, i) =>
        i === 0 || factOrder(r.facts[i - 1].kind) <= factOrder(f.kind))));
  }

  // ── 2. Residues carry candidates, never conclusions ───────────────────────
  console.log("2. residues and candidate explanations");
  {
    // Replay reaches 15; the observation says 99.
    const mismatch = reconcile([
      anchor({ observationId: "open", dateISO: "2026-01-01", quantity: 10 }),
      anchor({ observationId: "mid",  dateISO: "2026-03-01", quantity: 99 }),
    ], [ev({ type: "BUY", quantity: 5, dateISO: "2026-03-01" })], COMPLETE());
    check("the residue is reported with both sides", mismatch.residues.length === 1 &&
      mismatch.residues[0].expected === 15 && mismatch.residues[0].observed === 99);
    check("…recorded as an ANCHOR_MISMATCH fact", factKinds(mismatch).includes("ANCHOR_MISMATCH"));
    check("…and with nothing to explain it, the verdict is UNEXPLAINED",
      mismatch.residues[0].verdict === "UNEXPLAINED" && mismatch.residues[0].candidates.length === 0);
    check("…the summary says a difference exists", mismatch.summary === "DIFFERENCES_PRESENT");

    // A blocked transfer of exactly the residue's magnitude.
    const coincidence = reconcile([
      anchor({ observationId: "open", dateISO: "2026-01-01", quantity: 10 }),
      anchor({ observationId: "mid",  dateISO: "2026-05-01", quantity: 17 }),
    ], [
      ev({ type: "BUY", quantity: 5, dateISO: "2026-02-01" }),
      ev({ type: "TRANSFER_IN", quantity: -2, dateISO: "2026-09-01" }),
    ], COMPLETE());
    const kinds = candKinds(coincidence);
    check("a transfer whose magnitude matches is offered as a CANDIDATE",
      kinds.includes("TRANSFER_MAGNITUDE_MATCH"));
    const c = coincidence.residues[0]?.candidates.find((x) => x.kind === "TRANSFER_MAGNITUDE_MATCH");
    check("…basis ARITHMETIC_COINCIDENCE, in so many words",
      c?.basis === "ARITHMETIC_COINCIDENCE");
    check("…confidence WEAK, because nothing corroborates it", c?.confidence === "WEAK");
    check("…and it names the supporting event id", (c?.supportingEventIds.length ?? 0) === 1);
    check("…the verdict is CANDIDATES_AVAILABLE, never 'explained'",
      coincidence.residues[0].verdict === "CANDIDATES_AVAILABLE");

    // Twice the magnitude: a flipped sign fits too, so both must be offered.
    const twoWays = reconcile([
      anchor({ observationId: "open", dateISO: "2026-01-01", quantity: 10 }),
      anchor({ observationId: "mid",  dateISO: "2026-05-01", quantity: 19 }),
    ], [
      ev({ type: "BUY", quantity: 5, dateISO: "2026-02-01" }),
      ev({ type: "TRANSFER_IN", quantity: -2, dateISO: "2026-09-01" }),
    ], COMPLETE());
    const k2 = candKinds(twoWays);
    check("a difference of twice a transfer's magnitude offers SIGN_INVERSION_CONSISTENT",
      k2.includes("SIGN_INVERSION_CONSISTENT"));
    check("…and every competing candidate is named by the others",
      twoWays.residues[0].candidates.every((x) =>
        x.competingWith.length === twoWays.residues[0].candidates.length - 1 &&
        !x.competingWith.includes(x.kind)));

    // A clean 2:1 ratio between observed and replayed.
    const splitLike = reconcile([
      anchor({ observationId: "open", dateISO: "2026-01-01", quantity: 10 }),
      anchor({ observationId: "mid",  dateISO: "2026-05-01", quantity: 30 }),
    ], [ev({ type: "BUY", quantity: 5, dateISO: "2026-02-01" })], COMPLETE());
    check("observed/replayed of exactly 2 offers SPLIT_RATIO_CONSISTENT",
      candKinds(splitLike).includes("SPLIT_RATIO_CONSISTENT"));

    const implausible = reconcile([
      anchor({ observationId: "open", dateISO: "2026-01-01", quantity: 10 }),
      anchor({ observationId: "mid",  dateISO: "2026-05-01", quantity: 15.7 }),
    ], [ev({ type: "BUY", quantity: 5, dateISO: "2026-02-01" })], COMPLETE());
    check("an arbitrary ratio is NOT dressed up as a split",
      !candKinds(implausible).includes("SPLIT_RATIO_CONSISTENT"));
    check("…it stays UNEXPLAINED", implausible.residues[0].verdict === "UNEXPLAINED");
  }

  // ── 3. Unattributed difference — the shape prehistory takes ───────────────
  console.log("3. unattributed differences");
  {
    // An observation of 10 with only 3 of movement recorded before it.
    const gapToObs = reconcile([anchor({ observationId: "obs", dateISO: "2026-06-01", quantity: 10 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" })]);
    check("an observation exceeding recorded movement raises a difference",
      gapToObs.unattributedDifferences.length === 1 &&
      gapToObs.unattributedDifferences[0].difference === 7);
    const cands = gapToObs.unattributedDifferences[0].candidates.map((x) => x.kind);
    check("…offering BOTH prehistory and missing events, in competition",
      cands.includes("MISSING_PREHISTORY_CONSISTENT") && cands.includes("MISSING_EVENTS_CONSISTENT"));
    check("…neither presented as the answer",
      gapToObs.unattributedDifferences[0].candidates.every((x) =>
        x.confidence === "WEAK" && x.competingWith.length > 0));
    check("…and it is NOT called an opening quantity",
      !("openingQuantity" in gapToObs.unattributedDifferences[0]) && gapToObs.backSolved === null);

    const complete = reconcile([anchor({ observationId: "obs", dateISO: "2026-06-01", quantity: 10 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" })], COMPLETE());
    const cc = complete.unattributedDifferences[0].candidates.map((x) => x.kind);
    check("with a COMPLETE stream, missing events is no longer offered",
      !cc.includes("MISSING_EVENTS_CONSISTENT") && cc.includes("MISSING_PREHISTORY_CONSISTENT"));

    const balanced = reconcile([anchor({ observationId: "obs", dateISO: "2026-06-01", quantity: 3 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" })], COMPLETE());
    check("an observation that matches recorded movement raises nothing",
      balanced.unattributedDifferences.length === 0);
  }

  // ── 4. Back-solve is gated, and its output is unusable as evidence ────────
  console.log("4. back-solved opening quantity");
  {
    const ok = reconcile([anchor({ observationId: "obs", dateISO: "2026-06-01", quantity: 10 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" })], COMPLETE("2026-01-01", "2026-12-31"));
    check("with every gate passed, an implied opening is emitted", ok.backSolved !== null);
    check("…equal to anchorQuantity − recorded movement (10 − 3)", ok.backSolved?.quantity === 7);
    check("…as of the first recorded movement", ok.backSolved?.asOfISO === "2026-03-01");
    check("…basis BACK_SOLVED", ok.backSolved?.basis === "BACK_SOLVED");
    check("…origin DERIVED, which PERMITTED_ANCHOR_ORIGINS rejects",
      ok.backSolved?.origin === "DERIVED" && !PERMITTED_ANCHOR_ORIGINS.has("DERIVED"));
    check("…completeness no stronger than derived", ok.backSolved?.completeness === "derived");
    check("…and it names the observation and events it came from",
      ok.backSolved?.derivedFromObservationId === "obs" &&
      (ok.backSolved?.derivedFromEventIds.length ?? 0) === 1);
    check("…with no refusals recorded", ok.backSolveRefusals.length === 0);

    // Feeding it back would need origin OBSERVED; the literal type forbids it.
    const asAnchor = { origin: ok.backSolved!.origin };
    check("the implied opening cannot become a permitted anchor",
      !PERMITTED_ANCHOR_ORIGINS.has(asAnchor.origin));

    const unknownStream = reconcile([anchor({ observationId: "obs", dateISO: "2026-06-01", quantity: 10 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" })]);
    check("an UNKNOWN stream refuses the back-solve outright",
      unknownStream.backSolved === null &&
      unknownStream.backSolveRefusals.includes("STREAM_NOT_COMPLETE"));

    const narrow = reconcile([anchor({ observationId: "obs", dateISO: "2026-06-01", quantity: 10 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" })], COMPLETE("2026-04-01", "2026-12-31"));
    check("a COMPLETE stream that does not span the interval refuses it too",
      narrow.backSolved === null && narrow.backSolveRefusals.includes("STREAM_DOES_NOT_SPAN_INTERVAL"));

    const gapped = reconcile([anchor({ observationId: "obs", dateISO: "2026-06-01", quantity: 10 })], [
      ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" }),
      ev({ type: "TRANSFER_OUT", quantity: -1, dateISO: "2026-04-01" }),
    ], COMPLETE());
    check("a blocked interval before the anchor refuses it",
      gapped.backSolved === null && gapped.backSolveRefusals.includes("BLOCKED_INTERVAL"));

    const ratioed = reconcile([anchor({ observationId: "obs", dateISO: "2026-06-01", quantity: 10 })], [
      ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" }),
      ev({ type: "SPLIT", quantity: 0, ratio: 2, dateISO: "2026-04-01" }),
    ], COMPLETE());
    check("a ratio event before the anchor refuses it — no delta sum inverts a multiplication",
      ratioed.backSolved === null && ratioed.backSolveRefusals.includes("NON_FINITE_ARITHMETIC"));

    const orderSensitive = reconcile([anchor({ observationId: "obs", dateISO: "2026-06-01", quantity: 10 })], [
      ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" }),
      ev({ type: "SPLIT", quantity: 0, ratio: 2, dateISO: "2026-03-01" }),
    ], COMPLETE());
    check("an order-sensitive interval refuses it",
      orderSensitive.backSolved === null &&
      orderSensitive.backSolveRefusals.includes("ORDER_SENSITIVE_INTERVAL"));

    const noMovement = reconcile([anchor({ observationId: "obs", dateISO: "2026-06-01", quantity: 10 })],
      [], COMPLETE());
    check("no recorded movement refuses it",
      noMovement.backSolved === null && noMovement.backSolveRefusals.includes("NO_RECORDED_MOVEMENT"));

    const noAnchor = reconcile([], [ev({ type: "BUY", quantity: 3 })], COMPLETE());
    check("no permitted anchor refuses it",
      noAnchor.backSolved === null && noAnchor.backSolveRefusals.includes("NO_PERMITTED_LATER_ANCHOR"));

    const derivedOnly = reconcile([anchor({ dateISO: "2026-06-01", origin: "DERIVED", quantity: 10 })],
      [ev({ type: "BUY", quantity: 3, dateISO: "2026-03-01" })], COMPLETE());
    check("a DERIVED anchor cannot support a back-solve either",
      derivedOnly.backSolved === null &&
      derivedOnly.backSolveRefusals.includes("NO_PERMITTED_LATER_ANCHOR"));
  }

  // ── 5. Invariants across every fixture ────────────────────────────────────
  console.log(`5. global invariant sweep (${ALL.length} reports)`);
  {
    const every = (name: string, p: (r: ReconciliationReport) => boolean) => {
      const bad = ALL.filter((r) => !p(r));
      check(name, bad.length === 0, bad.length ? `${bad.length} report(s) violate it` : undefined);
    };

    every("no candidate ever claims to be CORROBORATED — nothing supplies a second signal",
      (r) => allCandidates(r).every((c) => c.confidence === "WEAK"));
    every("every candidate carries at least one supporting id or an explicit structural basis",
      (r) => allCandidates(r).every((c) =>
        c.supportingEventIds.length > 0 || c.supportingObservationIds.length > 0 ||
        c.basis === "STRUCTURAL_ABSENCE"));
    every("every candidate names all its competitors and never itself",
      (r) => [...r.residues, ...r.unattributedDifferences].every((x) =>
        x.candidates.every((c) =>
          !c.competingWith.includes(c.kind) &&
          c.competingWith.length === x.candidates.length - 1)));
    every("a difference with no candidate is UNEXPLAINED, never quietly dropped",
      (r) => [...r.residues, ...r.unattributedDifferences].every((x) =>
        (x.candidates.length === 0) === (x.verdict === "UNEXPLAINED")));
    every("a back-solved opening is emitted ONLY with zero refusals",
      (r) => (r.backSolved !== null) === (r.backSolveRefusals.length === 0 &&
        r.backSolved !== undefined && r.backSolveRefusals.length === 0 && r.backSolved !== null));
    every("a back-solved opening is never origin OBSERVED",
      (r) => r.backSolved === null || (r.backSolved.origin === "DERIVED" &&
        !PERMITTED_ANCHOR_ORIGINS.has(r.backSolved.origin)));
    every("a back-solved opening never predates the first recorded movement",
      (r) => r.backSolved === null || r.backSolved.derivedFromEventIds.length > 0);
    every("refusals are emitted in declaration order and are unique",
      (r) => r.backSolveRefusals.every((x, i) =>
        i === 0 || BACK_SOLVE_REFUSALS.indexOf(r.backSolveRefusals[i - 1]) <= BACK_SOLVE_REFUSALS.indexOf(x)) &&
        new Set(r.backSolveRefusals).size === r.backSolveRefusals.length);
    every("candidates are emitted in declaration order",
      (r) => [...r.residues, ...r.unattributedDifferences].every((x) =>
        x.candidates.every((c, i) => i === 0 ||
          CANDIDATE_KINDS.indexOf(x.candidates[i - 1].kind) <= CANDIDATE_KINDS.indexOf(c.kind))));
    every("evidence id lists are sorted",
      (r) => r.facts.every((f) => f.evidenceIds.every((x, i) => i === 0 || f.evidenceIds[i - 1] <= x)));
    every("the summary follows from the content",
      (r) => r.summary === (r.residues.length > 0 || r.unattributedDifferences.length > 0
        ? "DIFFERENCES_PRESENT" : r.facts.length > 0 ? "FACTS_ONLY" : "CLEAN"));
    every("no report emits a quantity event, an anchor or a correction",
      (r) => !("events" in r) && !("anchors" in r) && !("corrections" in r));
  }

  console.log(failures === 0 ? "\nAll quantity-reconciliation checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

const FACT_ORDER = [
  "MISSING_OPENING_ANCHOR", "AMBIGUOUS_SAME_DAY_ANCHOR", "BLOCKED_INTERVAL",
  "UNSUPPORTED_TRANSFER_PRESENT", "INVALID_EVENT_PRESENT", "UNATTRIBUTABLE_EVENT_PRESENT",
  "ORDER_SENSITIVE_GROUP_PRESENT", "STREAM_COMPLETENESS_UNKNOWN", "STREAM_COMPLETENESS_PARTIAL",
  "UNCOVERED_INTERVAL_PRESENT", "ANCHOR_MISMATCH", "REJECTED_DERIVED_ANCHOR",
];
const factOrder = (k: string) => FACT_ORDER.indexOf(k);
const allCandidates = (r: ReconciliationReport) =>
  [...r.residues, ...r.unattributedDifferences].flatMap((x) => x.candidates);

main();
