/**
 * lib/investments/quantity-authority-bridge.core.test.ts
 *
 * V26-QUANTITY-1G fixtures. Standalone tsx script:
 *
 *     npx tsx lib/investments/quantity-authority-bridge.core.test.ts
 *
 * The properties that matter most: the authority may only move money where its
 * evidence is absolute, covered and evidenced in order; every refusal carries a
 * reason; and `compare` never changes a number.
 */

import {
  decideQuantity, compareQuantities, quantityToUse, FALLBACK_REASONS,
  type QuantityDecision,
} from "./quantity-authority-bridge.core";
import {
  replayQuantityTimeline, UNKNOWN_EVENT_STREAM,
  type QuantityAnchor, type EventStreamCompleteness, type QuantityTimeline,
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
    id: `e${n}`, financialAccountId: "acct1", instrumentId: "inst1", type: "BUY",
    dateISO: "2026-03-01", datetimeISO: null, quantity: 1, ratio: null,
    source: "plaid", externalEventId: `x${n}`, relatedInstrumentId: null, ...over,
  });
}
let a = 0;
function anchor(over: Partial<QuantityAnchor> = {}): QuantityAnchor {
  a++;
  return { observationId: `a${a}`, dateISO: "2026-01-01", effectiveDateTimeISO: null,
    quantity: 10, origin: "OBSERVED", completeness: "observed", ...over };
}
const COMPLETE: EventStreamCompleteness =
  { kind: "COMPLETE", fromISO: "1900-01-01", toISO: "2100-01-01", source: "fixture" };

const build = (
  anchors: QuantityAnchor[], events: ReturnType<typeof ev>[],
  stream: EventStreamCompleteness = COMPLETE, from = "2026-01-01", to = "2026-12-31",
): QuantityTimeline => replayQuantityTimeline({
  instrumentId: "inst1", accountId: "acct1", anchors, events,
  windowFromISO: from, windowToISO: to, eventStream: stream,
});
const reasonOf = (d: QuantityDecision) => (d.source === "LEGACY" ? d.reason : null);

function main(): void {
  console.log("0. purity");
  {
    const src = readFileSync(join(import.meta.dirname, "quantity-authority-bridge.core.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    check("imports only the 1C contract", imports.length === 1 && imports[0] === "./quantity-replay.core");
    check("no Prisma, database or provider import",
      !/@prisma|lib\/db|lib\/prices|plaid/i.test(imports.join(" ")));
    check("no ambient clock", !/Date\.now\(|new Date\(\s*\)/.test(src));
  }

  console.log("1. the authority speaks only where its evidence is a quantity");
  {
    const covered = build([anchor({ quantity: 10 })], [ev({ type: "BUY", quantity: 5 })]);
    const d = decideQuantity(covered, "2026-06-01");
    check("a licensed absolute interval → AUTHORITY",
      d.source === "AUTHORITY" && d.quantity === 15);
    check("…reported as an INTERVAL claim", d.source === "AUTHORITY" && d.shape === "INTERVAL");
    check("…naming the evidence it came from",
      d.source === "AUTHORITY" && d.derivedFrom.length > 0);

    const points = build([anchor({ dateISO: "2026-06-01", quantity: 7 })], [], UNKNOWN_EVENT_STREAM);
    const onPoint = decideQuantity(points, "2026-06-01");
    check("an observed POINT is a quantity on its own date",
      onPoint.source === "AUTHORITY" && onPoint.quantity === 7 && onPoint.shape === "POINT");
    check("…and the very next day is not",
      reasonOf(decideQuantity(points, "2026-06-02")) === "DATE_UNCOVERED");
    check("…nor the day before", reasonOf(decideQuantity(points, "2026-05-31")) === "DATE_UNCOVERED");
  }

  console.log("2. every refusal carries a reason");
  {
    check("no timeline at all", reasonOf(decideQuantity(null, "2026-06-01")) === "NO_TIMELINE_FOR_PAIR");
    check("a date outside the window",
      reasonOf(decideQuantity(build([anchor()], [ev()]), "2027-06-01")) === "DATE_OUTSIDE_TIMELINE_WINDOW");
    check("an unreplayable timeline",
      reasonOf(decideQuantity(build([], []), "2026-06-01")) === "TIMELINE_UNREPLAYABLE");

    const relative = build([], [ev({ type: "BUY", quantity: 3, dateISO: "2026-02-01" })]);
    check("movement without a level is refused — a delta is not a holding",
      reasonOf(decideQuantity(relative, "2026-06-01")) === "DATE_RELATIVE_ONLY");

    const blocked = build([anchor({ quantity: 5 })],
      [ev({ type: "TRANSFER_IN", quantity: -2, dateISO: "2026-05-01" })]);
    check("a blocked interval is refused",
      reasonOf(decideQuantity(blocked, "2026-06-01")) === "DATE_UNRESOLVED");

    // Plaid's investment transactions are date-only, so almost every replayed
    // segment is TIE_BROKEN. Gating on KNOWN would silence the authority on the
    // entire corpus while buying nothing — order-sensitivity is caught upstream.
    const commutative = build([anchor({ quantity: 10 })],
      [ev({ type: "BUY", quantity: 1, dateISO: "2026-02-01" }),
       ev({ type: "SELL", quantity: 2, dateISO: "2026-02-01" })]);
    const tieDecision = decideQuantity(commutative, "2026-06-01");
    check("a commutative same-day group is ACCEPTED despite a tie-broken order",
      tieDecision.source === "AUTHORITY" && tieDecision.quantity === 9);
    check("…with the tie-break carried through for inspection, not used as a gate",
      tieDecision.source === "AUTHORITY" && tieDecision.orderCertainty === "TIE_BROKEN");

    // The guarantee that makes the above safe.
    const orderSensitive = build([anchor({ quantity: 10 })],
      [ev({ type: "BUY", quantity: 1, dateISO: "2026-02-01" }),
       ev({ type: "SPLIT", ratio: 2, quantity: 0, dateISO: "2026-02-01" })]);
    check("an ORDER-SENSITIVE day never reaches the bridge as absolute",
      reasonOf(decideQuantity(orderSensitive, "2026-06-01")) === "DATE_UNRESOLVED");

    check("every declared reason is reachable or deliberate",
      FALLBACK_REASONS.length === 8 && FALLBACK_REASONS.includes("AUTHORITY_DISABLED"));
  }

  console.log("3. comparison classifies without editing");
  {
    const row = (legacy: number | null, d: QuantityDecision) => compareQuantities({
      dateISO: "2026-06-01", financialAccountId: "acct1", instrumentId: "inst1",
      legacyQuantity: legacy, decision: d,
    });
    const yes = decideQuantity(build([anchor({ quantity: 10 })], []), "2026-06-01");
    const no: QuantityDecision = { source: "LEGACY", reason: "DATE_UNCOVERED", detail: "d" };

    check("matching quantities → AGREE", row(10, yes).verdict === "AGREE");
    check("differing quantities → DISAGREE with a signed delta",
      row(4, yes).verdict === "DISAGREE" && row(4, yes).delta === 6);
    check("authority holds where legacy did not → AUTHORITY_ONLY",
      row(null, yes).verdict === "AUTHORITY_ONLY");
    check("legacy holds where the authority declines → LEGACY_ONLY",
      row(3, no).verdict === "LEGACY_ONLY");
    check("…which is the surface this whole exercise measures",
      row(3, no).fallbackReason === "DATE_UNCOVERED");
    check("neither holds → NOT_COMPARED", row(null, no).verdict === "NOT_COMPARED");
  }

  console.log("4. modes");
  {
    const yes = decideQuantity(build([anchor({ quantity: 10 })], []), "2026-06-01");
    check("off uses legacy", quantityToUse("off", 3, yes).quantity === 3);
    check("compare uses legacy — a comparison must not change what it measures",
      quantityToUse("compare", 3, yes).quantity === 3 &&
      quantityToUse("compare", 3, yes).usedAuthority === false);
    check("adopt uses the authority where supported",
      quantityToUse("adopt", 3, yes).quantity === 10 &&
      quantityToUse("adopt", 3, yes).usedAuthority === true);
    const no: QuantityDecision = { source: "LEGACY", reason: "DATE_UNCOVERED", detail: "d" };
    // The legacy value must NOT reach a user-visible total. TQQQ contributing
    // −20 shares because its split is unusable is the case this forbids.
    check("adopt EXCLUDES where unsupported — it does not fall back",
      quantityToUse("adopt", 3, no).quantity === null &&
      quantityToUse("adopt", 3, no).excluded === true);
    check("…and never claims the authority supplied it",
      quantityToUse("adopt", 3, no).usedAuthority === false);
    check("off and compare still carry the legacy value for tooling",
      quantityToUse("off", 3, no).quantity === 3 &&
      quantityToUse("compare", 3, no).quantity === 3 &&
      quantityToUse("compare", 3, no).excluded === false);
  }

  console.log("5. the case the arc exists to prevent");
  {
    // Legacy carries the earliest observed quantity backward across prehistory.
    // The authority holds one observation and refuses every earlier day.
    const t = build([anchor({ dateISO: "2026-06-01", quantity: 4 })], [], UNKNOWN_EVENT_STREAM);
    const before = decideQuantity(t, "2026-02-01");
    check("prehistory is refused, not valued", before.source === "LEGACY");
    check("…with the reason naming the missing evidence",
      reasonOf(before) === "DATE_UNCOVERED");
    const cmp = compareQuantities({
      dateISO: "2026-02-01", financialAccountId: "acct1", instrumentId: "inst1",
      legacyQuantity: 4, decision: before,
    });
    check("…and the comparison marks it LEGACY_ONLY, quantifying the unsupported surface",
      cmp.verdict === "LEGACY_ONLY" && cmp.authorityQuantity === null);
    check("in adopt, prehistory is EXCLUDED rather than carried forward",
      quantityToUse("adopt", 4, before).quantity === null &&
      quantityToUse("adopt", 4, before).excluded === true);
  }

  console.log(failures === 0 ? "\nAll quantity-authority-bridge checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
