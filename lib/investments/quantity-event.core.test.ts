/**
 * lib/investments/quantity-event.core.test.ts
 *
 * V26-QUANTITY-1B — normalizer fixtures. Standalone tsx script:
 *
 *     npx tsx lib/investments/quantity-event.core.test.ts
 *
 * The two properties that matter most:
 *   - every active input yields ONE inspectable outcome, never a silent drop;
 *   - deterministic sorting NEVER upgrades uncertain ordering to KNOWN.
 */

import {
  normalizeQuantityEvent,
  normalizeQuantityEvents,
  quantityEventIdentity,
  QUANTITY_EVENT_REASONS,
  hasSingleReplayOperator,
  type QuantityEventSource,
} from "./quantity-event.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

let n = 0;
function src(over: Partial<QuantityEventSource> = {}): QuantityEventSource {
  n++;
  return {
    id: `e${n}`, financialAccountId: "acct1", instrumentId: "inst1",
    type: "BUY", dateISO: "2026-06-25", datetimeISO: null,
    quantity: 5, ratio: null, source: "plaid", externalEventId: `x${n}`,
    relatedInstrumentId: null, ...over,
  };
}

function main(): void {
  // ── 1. BUY / SELL — measured magnitude convention ─────────────────────────
  console.log("1. BUY / SELL");
  {
    const buy = normalizeQuantityEvent(src({ type: "BUY", quantity: 5 }));
    check("BUY +5 → REPLAYABLE, delta +5", buy.status === "REPLAYABLE" && buy.normalizedDelta === 5);
    check("…and the source value is preserved verbatim", buy.sourceQuantity === 5);

    const sell = normalizeQuantityEvent(src({ type: "SELL", quantity: 5 }));
    check("SELL +5 → REPLAYABLE, delta −5 (type supplies direction)",
      sell.status === "REPLAYABLE" && sell.normalizedDelta === -5);
    check("…source stays POSITIVE, unchanged", sell.sourceQuantity === 5);

    // 0/22 local rows are negative. A negative contradicts the measured
    // convention and is reported, never double-negated into a plausible number.
    const negBuy = normalizeQuantityEvent(src({ type: "BUY", quantity: -5 }));
    check("BUY with a NEGATIVE source is UNSUPPORTED_SEMANTICS, not +5 or −5",
      negBuy.status === "UNSUPPORTED_SEMANTICS" && negBuy.reason === "SIGN_CONVENTION_UNRESOLVED" &&
      negBuy.normalizedDelta === null);
    const negSell = normalizeQuantityEvent(src({ type: "SELL", quantity: -5 }));
    check("SELL with a NEGATIVE source is likewise unresolved",
      negSell.status === "UNSUPPORTED_SEMANTICS" && negSell.normalizedDelta === null);

    check("a fractional BUY is preserved exactly",
      normalizeQuantityEvent(src({ quantity: 1.9083 })).normalizedDelta === 1.9083);
    check("a zero-quantity BUY is NEUTRAL, not a delta of 0",
      normalizeQuantityEvent(src({ quantity: 0 })).status === "NEUTRAL");
    check("a null-quantity BUY is INVALID",
      normalizeQuantityEvent(src({ quantity: null })).status === "INVALID");
  }

  // ── 2. Transfers — the unresolved sign convention ─────────────────────────
  console.log("2. transfers");
  {
    // Local: TRANSFER_IN 2/2 NEGATIVE (contradicts its own type), TRANSFER_OUT
    // 1/1 negative (matches the schema doc but not the BUY/SELL rule). Two
    // conventions coexist; three rows cannot settle it.
    for (const t of ["TRANSFER_IN", "TRANSFER_OUT"]) {
      const r = normalizeQuantityEvent(src({ type: t, quantity: -2 }));
      check(`${t} → UNSUPPORTED_SEMANTICS / SIGN_CONVENTION_UNRESOLVED`,
        r.status === "UNSUPPORTED_SEMANTICS" && r.reason === "SIGN_CONVENTION_UNRESOLVED");
      check(`…${t} emits no delta rather than guessing a direction`, r.normalizedDelta === null);
      check(`…${t} still preserves the source value for later resolution`, r.sourceQuantity === -2);
    }
  }

  // ── 3. Splits ─────────────────────────────────────────────────────────────
  console.log("3. splits");
  {
    const ok = normalizeQuantityEvent(src({ type: "SPLIT", quantity: 10, ratio: 4 }));
    check("SPLIT with a valid ratio → REPLAYABLE, ratio carried, no delta",
      ok.status === "REPLAYABLE" && ok.ratio === 4 && ok.normalizedDelta === null);

    // The one real local SPLIT: ratio NULL, quantity 10 — unknowable whether 10
    // is the resulting count or the added shares.
    const real = normalizeQuantityEvent(src({ type: "SPLIT", quantity: 10, ratio: null }));
    check("the REAL local SPLIT shape (ratio null) is INVALID / MISSING_RATIO",
      real.status === "INVALID" && real.reason === "MISSING_RATIO");
    check("zero or negative ratio is INVALID",
      normalizeQuantityEvent(src({ type: "SPLIT", ratio: 0 })).status === "INVALID" &&
      normalizeQuantityEvent(src({ type: "SPLIT", ratio: -2 })).status === "INVALID");
    check("non-finite ratio is INVALID",
      normalizeQuantityEvent(src({ type: "SPLIT", ratio: Number.NaN })).status === "INVALID");
  }

  // ── 4. Dividends — audited, not assumed ───────────────────────────────────
  console.log("4. dividends");
  {
    // All 24 local rows: providerType cash / subtype dividend, quantity 0 or
    // null, positive cash amount. NONE creates units.
    const zeroQty = normalizeQuantityEvent(src({ type: "DIVIDEND", quantity: 0 }));
    check("cash dividend (quantity 0) → NEUTRAL / CASH_DIVIDEND",
      zeroQty.status === "NEUTRAL" && zeroQty.reason === "CASH_DIVIDEND");
    const nullQty = normalizeQuantityEvent(src({ type: "DIVIDEND", quantity: null }));
    check("cash dividend (quantity null) → NEUTRAL", nullQty.status === "NEUTRAL");
    check("…and neither emits a delta",
      zeroQty.normalizedDelta === null && nullQty.normalizedDelta === null);

    // No reinvestment exists locally, so none is invented. A units-bearing
    // dividend is ambiguous by construction and must be reported.
    const withUnits = normalizeQuantityEvent(src({ type: "DIVIDEND", quantity: 3 }));
    check("a units-bearing DIVIDEND is UNSUPPORTED_SEMANTICS, never assumed reinvestment",
      withUnits.status === "UNSUPPORTED_SEMANTICS" && withUnits.normalizedDelta === null);

    check("REINVESTMENT is a conversion kind, not silently replayable",
      normalizeQuantityEvent(src({ type: "REINVESTMENT", quantity: 3 })).reason === "CONVERSION_NOT_IMPLEMENTED");
  }

  // ── 5. Identity failure vs unsupported semantics ──────────────────────────
  console.log("5. identity vs semantics");
  {
    const noInst = normalizeQuantityEvent(src({ instrumentId: null }));
    check("null instrumentId → UNATTRIBUTABLE / NO_INSTRUMENT",
      noInst.status === "UNATTRIBUTABLE" && noInst.reason === "NO_INSTRUMENT");
    check("…identity failure is checked BEFORE semantics",
      normalizeQuantityEvent(src({ instrumentId: null, type: "MERGER" })).status === "UNATTRIBUTABLE");

    for (const t of ["MERGER", "SPIN_OFF", "SYMBOL_CHANGE"]) {
      const r = normalizeQuantityEvent(src({ type: t }));
      check(`${t} → UNSUPPORTED_SEMANTICS / CONVERSION_NOT_IMPLEMENTED`,
        r.status === "UNSUPPORTED_SEMANTICS" && r.reason === "CONVERSION_NOT_IMPLEMENTED");
    }
    check("a non-finite quantity is INVALID",
      normalizeQuantityEvent(src({ quantity: Number.POSITIVE_INFINITY })).status === "INVALID" &&
      normalizeQuantityEvent(src({ quantity: Number.NaN })).status === "INVALID");
    check("cash-only kinds are NEUTRAL",
      ["CONTRIBUTION", "WITHDRAWAL", "INTEREST", "FEE", "TAX"]
        .every((t) => normalizeQuantityEvent(src({ type: t })).status === "NEUTRAL"));
    const unknown = normalizeQuantityEvent(src({ type: "SOME_FUTURE_TYPE" }));
    check("an UNKNOWN future enum member is reported, never silently NEUTRAL",
      unknown.status === "UNSUPPORTED_SEMANTICS" && unknown.reason === "UNKNOWN_EVENT_TYPE");
    check("OPENING_BALANCE / CANCEL / ADJUSTMENT are reported too",
      ["OPENING_BALANCE", "CANCEL", "ADJUSTMENT", "OTHER", "UNKNOWN"]
        .every((t) => normalizeQuantityEvent(src({ type: t })).status === "UNSUPPORTED_SEMANTICS"));
  }

  // ── 6. Ordering certainty ─────────────────────────────────────────────────
  console.log("6. ordering never pretends to be observed");
  {
    const withDt = normalizeQuantityEvent(src({ datetimeISO: "2026-05-21T14:30:00.000Z" }));
    check("a real datetime → certainty KNOWN", withDt.order.certainty === "KNOWN");
    check("…and it is preserved", withDt.order.effectiveDateTimeISO === "2026-05-21T14:30:00.000Z");

    const noDt = normalizeQuantityEvent(src({ datetimeISO: null }));
    check("day precision only → certainty TIE_BROKEN", noDt.order.certainty === "TIE_BROKEN");
    check("…with a null datetime, not a fabricated midnight",
      noDt.order.effectiveDateTimeISO === null);
    check("…but still a stable key for reproducible sorting",
      typeof noDt.order.deterministicKey === "string" && noDt.order.deterministicKey.length > 0);

    // THE INVARIANT: sorting must never promote uncertainty to fact.
    const batch = normalizeQuantityEvents([
      src({ id: "b", datetimeISO: null }), src({ id: "a", datetimeISO: null }),
    ]);
    check("sorting TIE_BROKEN events leaves them TIE_BROKEN",
      batch.events.every((e) => e.order.certainty === "TIE_BROKEN"));
  }

  // ── 7. Exclusion and de-duplication ───────────────────────────────────────
  console.log("7. exclusion and de-duplication");
  {
    const audit = normalizeQuantityEvents([
      src({ id: "live" }),
      { ...src({ id: "gone" }), deletedAt: new Date() } as never,
      { ...src({ id: "old" }), supersededById: "newer" } as never,
    ]);
    check("deleted and superseded rows are excluded", audit.events.length === 1);
    check("…and COUNTED, not hidden", audit.excludedInactive === 2);
    check("totalInput reports everything handed in", audit.totalInput === 3);

    const dupes = normalizeQuantityEvents([
      src({ id: "r1", source: "plaid", externalEventId: "SAME" }),
      src({ id: "r2", source: "plaid", externalEventId: "SAME" }),
    ]);
    check("two rows sharing (source, externalEventId) de-duplicate to one",
      dupes.events.length === 1 && dupes.excludedDuplicate === 1);

    // The trap: null externalEventId must NOT collapse distinct rows.
    const nulls = normalizeQuantityEvents([
      src({ id: "n1", externalEventId: null }), src({ id: "n2", externalEventId: null }),
    ]);
    check("two rows with NULL externalEventId stay SEPARATE events",
      nulls.events.length === 2 && nulls.excludedDuplicate === 0);
    check("identity falls back to the row id when no external id exists",
      quantityEventIdentity(src({ id: "z", externalEventId: null })) === "id:z");
    check("…and uses source+externalEventId when both exist",
      quantityEventIdentity(src({ id: "z", source: "plaid", externalEventId: "E1" })) === "x:plaid|E1");

    // Two legitimate same-day events on one instrument must both survive.
    const sameDay = normalizeQuantityEvents([
      src({ id: "s1", type: "BUY", dateISO: "2025-10-02", externalEventId: "A" }),
      src({ id: "s2", type: "DIVIDEND", quantity: 0, dateISO: "2025-10-02", externalEventId: "B" }),
    ]);
    check("two legitimate same-day events are both kept", sameDay.events.length === 2);
    check("…and the collision is reported for replay to notice",
      sameDay.sameDayCollisions === 2);
  }

  // ── 8. Totality and determinism ───────────────────────────────────────────
  console.log("8. totality and determinism");
  {
    const inputs = [
      src({ type: "BUY", quantity: 5 }), src({ type: "SELL", quantity: 2 }),
      src({ type: "DIVIDEND", quantity: 0 }), src({ type: "TRANSFER_IN", quantity: -1 }),
      src({ type: "SPLIT", ratio: null }), src({ instrumentId: null }),
      src({ type: "MERGER" }), src({ quantity: Number.NaN }),
    ];
    const a = normalizeQuantityEvents(inputs);
    check("EVERY active input produces exactly one outcome",
      a.events.length === inputs.length && a.totalInput === inputs.length);
    check("…and every outcome carries a status", a.events.every((e) => !!e.status));
    check("only REPLAYABLE events have a null reason",
      a.events.every((e) => (e.reason === null) === (e.status === "REPLAYABLE")));
    check("every reason is from the declared vocabulary",
      a.events.every((e) => e.reason === null || QUANTITY_EVENT_REASONS.includes(e.reason)));
    check("no REPLAYABLE event lacks a delta or a ratio",
      a.events.filter((e) => e.status === "REPLAYABLE")
        .every((e) => e.normalizedDelta !== null || e.ratio !== null));
    check("no non-replayable event carries a delta",
      a.events.filter((e) => e.status !== "REPLAYABLE").every((e) => e.normalizedDelta === null));
    check("status tally sums to the event count",
      Object.values(a.byStatus).reduce((x, y) => x + y, 0) === a.events.length);

    const b = normalizeQuantityEvents([...inputs].reverse());
    check("SHUFFLED INPUT → byte-identical output", JSON.stringify(a.events) === JSON.stringify(b.events));
    check("repeat invocation → byte-identical",
      JSON.stringify(normalizeQuantityEvents(inputs).events) === JSON.stringify(a.events));
    check("output is sorted by the deterministic key",
      a.events.every((e, i) => i === 0 || e.order.deterministicKey >= a.events[i - 1].order.deterministicKey));
    check("an empty batch is handled",
      normalizeQuantityEvents([]).events.length === 0);
  }

  // ── 9. REPLAY-OPERATOR XOR ────────────────────────────────────────────────
  console.log("9. replay-operator XOR");
  {
    const buy   = normalizeQuantityEvent(src({ type: "BUY", quantity: 5 }));
    const sell  = normalizeQuantityEvent(src({ type: "SELL", quantity: 5 }));
    const split = normalizeQuantityEvent(src({ type: "SPLIT", quantity: 10, ratio: 4 }));

    check("BUY exposes a delta and NO ratio",
      buy.normalizedDelta !== null && buy.ratio === null);
    check("SELL exposes a delta and NO ratio",
      sell.normalizedDelta !== null && sell.ratio === null);
    check("SPLIT exposes a ratio and NO delta",
      split.ratio !== null && split.normalizedDelta === null);
    check("every replayable event satisfies the XOR",
      [buy, sell, split].every(hasSingleReplayOperator));

    // A ratio riding along on a delta event must not survive normalization.
    const buyWithRatio = normalizeQuantityEvent(src({ type: "BUY", quantity: 5, ratio: 3 }));
    check("a BUY carrying a stray ratio still exposes ONLY a delta",
      buyWithRatio.normalizedDelta === 5 && buyWithRatio.ratio === null &&
      hasSingleReplayOperator(buyWithRatio));

    // A quantity riding along on a ratio event must not become a delta.
    const splitWithQty = normalizeQuantityEvent(src({ type: "SPLIT", quantity: 10, ratio: 4 }));
    check("a SPLIT carrying a quantity still exposes ONLY a ratio",
      splitWithQty.normalizedDelta === null && splitWithQty.ratio === 4);
    check("…and the source quantity is still preserved for diagnostics",
      splitWithQty.sourceQuantity === 10);

    // Non-replayable events must expose NOTHING replay can act on — including a
    // provider ratio that would otherwise leak through.
    const badSplit = normalizeQuantityEvent(src({ type: "SPLIT", quantity: 10, ratio: null }));
    const transfer = normalizeQuantityEvent(src({ type: "TRANSFER_IN", quantity: -2 }));
    const noInst   = normalizeQuantityEvent(src({ instrumentId: null, ratio: 4 }));
    const merger   = normalizeQuantityEvent(src({ type: "MERGER", ratio: 2, quantity: 7 }));
    for (const [label, e] of [["INVALID split", badSplit], ["transfer", transfer],
                              ["unattributable", noInst], ["merger", merger]] as const) {
      check(`a non-replayable ${label} exposes NO operator`,
        e.normalizedDelta === null && e.ratio === null && hasSingleReplayOperator(e));
    }
  }

  // ── 10. Sign and finiteness invariants ────────────────────────────────────
  console.log("10. sign and finiteness");
  {
    check("BUY +5 → +5 (not absolute-valued away from meaning)",
      normalizeQuantityEvent(src({ type: "BUY", quantity: 5 })).normalizedDelta === 5);
    check("SELL +5 → −5 (single negation)",
      normalizeQuantityEvent(src({ type: "SELL", quantity: 5 })).normalizedDelta === -5);
    check("BUY −5 → unsupported, NOT abs()",
      normalizeQuantityEvent(src({ type: "BUY", quantity: -5 })).normalizedDelta === null);
    check("SELL −5 → unsupported, NOT double-negated to +5",
      normalizeQuantityEvent(src({ type: "SELL", quantity: -5 })).normalizedDelta === null);

    // -0 breaks byte-equality: Object.is(-0, 0) is false.
    const noneAreNegZero = [
      normalizeQuantityEvent(src({ type: "SELL", quantity: 5 })),
      normalizeQuantityEvent(src({ type: "BUY", quantity: 5 })),
      normalizeQuantityEvent(src({ type: "SELL", quantity: 1e-12 })),
    ].every((e) => !Object.is(e.normalizedDelta, -0));
    check("normalized delta is never -0", noneAreNegZero);
    check("a zero quantity on a quantity-changing event is explicitly NEUTRAL",
      normalizeQuantityEvent(src({ type: "SELL", quantity: 0 })).status === "NEUTRAL");
    check("ratio must be finite and > 0",
      normalizeQuantityEvent(src({ type: "SPLIT", ratio: Number.POSITIVE_INFINITY })).status === "INVALID" &&
      normalizeQuantityEvent(src({ type: "SPLIT", ratio: 0.0001 })).status === "REPLAYABLE");
    check("source quantity is never mutated by normalization",
      normalizeQuantityEvent(src({ type: "SELL", quantity: 5 })).sourceQuantity === 5);
  }

  // ── 11. Ordering — pinned to the observed corpus shape ────────────────────
  console.log("11. ordering regression (observed corpus shape)");
  {
    // The real 2026-05-21 option pair: same day, same instrument, BOTH with
    // datetimes. That they carry chronology is an EMPIRICAL FACT of this corpus,
    // not a guarantee — fixture 11b pins the unsafe case that 1C must survive.
    const withTimes = normalizeQuantityEvents([
      src({ id: "o1", type: "BUY",  quantity: 1, dateISO: "2026-05-21",
            datetimeISO: "2026-05-21T13:00:00.000Z", externalEventId: "OB" }),
      src({ id: "o2", type: "SELL", quantity: 1, dateISO: "2026-05-21",
            datetimeISO: "2026-05-21T15:00:00.000Z", externalEventId: "OS" }),
    ]);
    check("the same-day BUY/SELL pair with datetimes is KNOWN order",
      withTimes.events.every((e) => e.order.certainty === "KNOWN"));
    check("…and sorts earlier-datetime first",
      withTimes.events[0].sourceType === "BUY" && withTimes.events[1].sourceType === "SELL");
    check("…and the group counts as known-chronology",
      withTimes.collisionGroups === 1 && withTimes.collisionGroupsWithKnownOrder === 1);

    // 11b — the case QUANTITY-1C must remain safe for.
    const noTimes = normalizeQuantityEvents([
      src({ id: "z", type: "SELL", quantity: 1, dateISO: "2026-05-21", externalEventId: "B" }),
      src({ id: "a", type: "BUY",  quantity: 1, dateISO: "2026-05-21", externalEventId: "A" }),
    ]);
    check("a same-day collision WITHOUT datetimes sorts deterministically",
      noTimes.events.length === 2);
    check("…but stays TIE_BROKEN — sorting never upgrades certainty",
      noTimes.events.every((e) => e.order.certainty === "TIE_BROKEN"));
    check("…and the group is NOT counted as known-chronology",
      noTimes.collisionGroups === 1 && noTimes.collisionGroupsWithKnownOrder === 0);
    check("shuffling that collision does not change output order",
      JSON.stringify(normalizeQuantityEvents([
        src({ id: "a", type: "BUY", quantity: 1, dateISO: "2026-05-21", externalEventId: "A" }),
        src({ id: "z", type: "SELL", quantity: 1, dateISO: "2026-05-21", externalEventId: "B" }),
      ]).events.map((e) => e.eventId)) === JSON.stringify(noTimes.events.map((e) => e.eventId)));
  }

  // ── 12. Corpus contracts pinned ───────────────────────────────────────────
  console.log("12. dividend and transfer contracts");
  {
    // DIVIDEND: 24/24 local rows are cash/dividend with quantity 0 or null.
    check("a future units-bearing DIVIDEND does NOT become replayable",
      normalizeQuantityEvent(src({ type: "DIVIDEND", quantity: 12 })).status === "UNSUPPORTED_SEMANTICS");
    check("…and carries the stable unresolved-sign reason",
      normalizeQuantityEvent(src({ type: "DIVIDEND", quantity: 12 })).reason === "SIGN_CONVENTION_UNRESOLVED");
    check("…and never emits a delta", 
      normalizeQuantityEvent(src({ type: "DIVIDEND", quantity: 12 })).normalizedDelta === null);

    // TRANSFERS remain unresolved regardless of sign — 1F resolves them.
    for (const q of [-2, 2, 0.5]) {
      check(`TRANSFER_IN quantity ${q} stays unresolved (no direction guessed)`,
        normalizeQuantityEvent(src({ type: "TRANSFER_IN", quantity: q })).status === "UNSUPPORTED_SEMANTICS");
      check(`TRANSFER_OUT quantity ${q} stays unresolved`,
        normalizeQuantityEvent(src({ type: "TRANSFER_OUT", quantity: q })).status === "UNSUPPORTED_SEMANTICS");
    }
  }

  console.log(failures === 0 ? "\nAll quantity-event checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
