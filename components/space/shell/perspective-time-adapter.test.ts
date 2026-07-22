/**
 * components/space/shell/perspective-time-adapter.test.ts
 *
 * Behavior-parity proof for the TimelineLens v4 adapter.
 *
 * The migration claim is: routing a user action through TimelineLens produces
 * the SAME canonical state as the control it replaces. These tests assert that
 * directly — for every path the current UI can take — by running both routes
 * through the real `shellTimeReducer` and comparing the results.
 *
 *   BEFORE:  existing control → shell action → reducer → canonical
 *   AFTER:   TimelineIntent  → adapter      → reducer → canonical
 *
 * Pure, DB-free:  npx tsx components/space/shell/perspective-time-adapter.test.ts
 */

import {
  shellTimeReducer,
  type PerspectiveTimeState,
  type ShellTimeAction,
} from "@/lib/perspectives/time-range";
import { CASH_FLOW_PERIODS, type RelativeCashFlowPeriod } from "@/lib/transactions/cash-flow";
import {
  PERIOD_OPTIONS,
  capabilityForLens,
  deriveActiveOptionId,
  deriveBoundaries,
  shellActionForIntent,
  summarize,
} from "./perspective-time-adapter";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}

const TODAY = "2026-07-19";
const COVERAGE = "2016-02-12";
const CTX = { today: TODAY, coverageFrom: COVERAGE };
const ADAPTER_CTX = { today: TODAY };

const START: PerspectiveTimeState = { preset: "PAST_YEAR", asOf: TODAY, compareTo: "2025-07-19" };
const eq = (a: PerspectiveTimeState, b: PerspectiveTimeState) =>
  a.preset === b.preset && a.asOf === b.asOf && a.compareTo === b.compareTo;
const show = (s: PerspectiveTimeState) => `${s.preset}/${s.asOf}/${s.compareTo}`;

/** Run an intent all the way to canonical state, failing loudly if rejected. */
function applyIntent(state: PerspectiveTimeState, intent: Parameters<typeof shellActionForIntent>[0]) {
  const result = shellActionForIntent(intent, ADAPTER_CTX);
  if (!result.ok) throw new Error(`intent rejected: ${result.error}`);
  return shellTimeReducer(state, result.action, CTX);
}

const applyAction = (state: PerspectiveTimeState, action: ShellTimeAction) =>
  shellTimeReducer(state, action, CTX);

// ── 1. Option table cannot drift from the canonical vocabulary ───────────────
console.log("1. Option table — derived from the production preset table");
{
  check("exactly one option per canonical preset", PERIOD_OPTIONS.length === CASH_FLOW_PERIODS.length,
    `${PERIOD_OPTIONS.length} vs ${CASH_FLOW_PERIODS.length}`);

  for (const p of CASH_FLOW_PERIODS) {
    check(`preset ${p.id} has an option`, PERIOD_OPTIONS.some((o) => o.id === p.id));
  }
  check("every option id is a real preset",
    PERIOD_OPTIONS.every((o) => CASH_FLOW_PERIODS.some((p) => p.id === o.id)));
  check("option id and intent are the same identity",
    PERIOD_OPTIONS.every((o) => o.id === o.intent));
  check("CUSTOM is never offered as an option (it is inferred, not chosen)",
    !PERIOD_OPTIONS.some((o) => o.id === "CUSTOM"));
  check("every option carries an editorial label",
    PERIOD_OPTIONS.every((o) => o.label.length > 0 && (o.supportingLabel?.length ?? 0) > 0));
}

// ── 2. Intent parity — the core claim ────────────────────────────────────────
console.log("2. Intent parity — every preset produces identical canonical state");
{
  // Exercised from several starting states, because setAsOf/setCompareTo behave
  // differently under a preset vs under CUSTOM.
  const STARTS: PerspectiveTimeState[] = [
    START,
    { preset: "MTD", asOf: TODAY, compareTo: "2026-07-01" },
    { preset: "CUSTOM", asOf: "2024-03-15", compareTo: "2023-11-02" },
    { preset: "CUSTOM", asOf: TODAY, compareTo: null },
    { preset: "ALL", asOf: TODAY, compareTo: COVERAGE },
  ];

  for (const start of STARTS) {
    for (const p of CASH_FLOW_PERIODS) {
      const preset = p.id as Exclude<RelativeCashFlowPeriod, never>;
      const before = applyAction(start, { type: "selectPreset", preset });
      const after = applyIntent(start, { type: "period", optionId: p.id, intent: p.id });
      check(`${show(start)} + ${p.id} → identical`, eq(before, after),
        `${show(before)} vs ${show(after)}`);
    }
  }
}

// ── 3. Round trip — selecting an option makes that option read as active ─────
console.log("3. Round trip — deriveActiveOptionId(apply(intent)) === intent.optionId");
{
  for (const p of CASH_FLOW_PERIODS) {
    const next = applyIntent(START, { type: "period", optionId: p.id, intent: p.id });
    check(`${p.id} round-trips to itself`, deriveActiveOptionId(next) === p.id,
      `got ${deriveActiveOptionId(next)}`);
  }
  const custom = applyIntent(START, { type: "customBoundary", boundary: "compareTo", value: "2021-04-07" });
  check("an unmatched pair reads as no active option", deriveActiveOptionId(custom) === null);
  check("...and canonical says CUSTOM", custom.preset === "CUSTOM");
}

// ── 4. Forward comparison — the v2 regression must not return ────────────────
console.log("4. Forward comparison — compareTo AFTER asOf stays expressible");
{
  const base: PerspectiveTimeState = { preset: "CUSTOM", asOf: "2026-01-15", compareTo: null };
  const forward = applyIntent(base, { type: "customBoundary", boundary: "compareTo", value: "2026-06-30" });
  check("a later comparison boundary is accepted", forward.compareTo === "2026-06-30");
  check("...and asOf is untouched", forward.asOf === "2026-01-15");
  check("compareTo > asOf survives the adapter", forward.compareTo! > forward.asOf);

  const viaAction = applyAction(base, { type: "setCompareTo", compareTo: "2026-06-30" });
  check("identical to the existing control's result", eq(viaAction, forward));

  // The adapter must not silently reorder or reject.
  const r = shellActionForIntent(
    { type: "customBoundary", boundary: "compareTo", value: "2026-06-30" }, ADAPTER_CTX);
  check("the adapter does not reject a forward comparison", r.ok);
}

// ── 5. Custom boundaries — valid, capped, invalid ────────────────────────────
console.log("5. Custom boundary behavior");
{
  const base: PerspectiveTimeState = { preset: "MTD", asOf: TODAY, compareTo: "2026-07-01" };

  const okAsOf = applyIntent(base, { type: "customBoundary", boundary: "asOf", value: "2026-05-04" });
  check("a valid as-of matches setAsOf exactly",
    eq(okAsOf, applyAction(base, { type: "setAsOf", asOf: "2026-05-04" })));

  const okCmp = applyIntent(base, { type: "customBoundary", boundary: "compareTo", value: "2026-02-02" });
  check("a valid compare-to matches setCompareTo exactly",
    eq(okCmp, applyAction(base, { type: "setCompareTo", compareTo: "2026-02-02" })));

  // max=today is enforced at the input; the adapter re-checks for typed input.
  const future = shellActionForIntent(
    { type: "customBoundary", boundary: "asOf", value: "2027-01-01" }, ADAPTER_CTX);
  check("a future as-of is rejected, not clamped", !future.ok);
  const futureCmp = shellActionForIntent(
    { type: "customBoundary", boundary: "compareTo", value: "2027-01-01" }, ADAPTER_CTX);
  check("a future compare-to is rejected too (parity with max on both inputs)", !futureCmp.ok);
  check("today itself is allowed",
    shellActionForIntent({ type: "customBoundary", boundary: "asOf", value: TODAY }, ADAPTER_CTX).ok);

  for (const bad of ["", "not-a-date", "2026-02-30", "2026-13-01", "26-01-01"]) {
    const r = shellActionForIntent({ type: "customBoundary", boundary: "asOf", value: bad }, ADAPTER_CTX);
    check(`as-of "${bad}" is rejected with a message`, !r.ok && (r as { error: string }).error.length > 0);
  }

  // No silent fabrication: a rejected intent yields NO action at all, so
  // canonical state cannot move to a date the user never chose.
  const rejected = shellActionForIntent({ type: "customBoundary", boundary: "asOf", value: "" }, ADAPTER_CTX);
  check("a rejected intent carries no action (nothing to dispatch)", !rejected.ok && !("action" in rejected));
}

// ── 6. Clear comparison — parity with the ✕ button, not with clearCompareTo ──
console.log("6. Clear comparison — matches today's ✕ button");
{
  // Today's ✕ calls onCompareToChange(null) → setCompareTo(null). Nothing in the
  // app calls clearCompareTo, and the two are NOT equivalent.
  const base: PerspectiveTimeState = { preset: "MTD", asOf: TODAY, compareTo: "2026-07-01" };
  const viaLens = applyIntent(base, { type: "clearComparison" });
  const viaButton = applyAction(base, { type: "setCompareTo", compareTo: null });
  check("clearComparison === the ✕ button", eq(viaLens, viaButton), `${show(viaLens)} vs ${show(viaButton)}`);

  // Emptying the field is the same gesture and must agree.
  const viaField = applyIntent(base, { type: "customBoundary", boundary: "compareTo", value: "" });
  check("emptying the compare-to field agrees with ✕", eq(viaField, viaLens));

  // Pin the actual relationship between the two candidate actions, across every
  // shape that could plausibly separate them. They do NOT diverge:
  // inferPerspectiveTimePreset returns CUSTOM immediately when compareTo is null
  // (time-range.ts:167), and neither action touches asOf. So setCompareTo(null)
  // and clearCompareTo are equivalent everywhere.
  //
  // The adapter still uses setCompareTo(null) — not because the other is wrong,
  // but because it is literally the action today's ✕ dispatches, which makes
  // parity true by construction instead of by argument. If the reducer's null
  // handling ever changes, this block fails and the choice gets re-examined.
  for (const ctx of [{ today: TODAY, coverageFrom: COVERAGE }, { today: TODAY, coverageFrom: null }]) {
    for (const s of [
      { preset: "ALL", asOf: TODAY, compareTo: null },
      { preset: "ALL", asOf: TODAY, compareTo: COVERAGE },
      { preset: "MTD", asOf: TODAY, compareTo: "2026-07-01" },
      { preset: "CUSTOM", asOf: "2024-01-02", compareTo: "2023-01-02" },
    ] as PerspectiveTimeState[]) {
      const a = shellTimeReducer(s, { type: "clearCompareTo" }, ctx);
      const b = shellTimeReducer(s, { type: "setCompareTo", compareTo: null }, ctx);
      check(`clearCompareTo ≡ setCompareTo(null) from ${show(s)} (coverage=${ctx.coverageFrom})`, eq(a, b),
        `${show(a)} vs ${show(b)}`);
    }
  }

  // The adapter takes the branch that mirrors the existing control.
  const chosen = shellActionForIntent({ type: "clearComparison" }, ADAPTER_CTX);
  check("the adapter emits setCompareTo(null) — the action the ✕ button dispatches",
    chosen.ok && chosen.action.type === "setCompareTo");
}

// ── 7. Swap parity ───────────────────────────────────────────────────────────
console.log("7. Swap parity");
{
  const base: PerspectiveTimeState = { preset: "CUSTOM", asOf: "2026-05-01", compareTo: "2025-01-01" };
  check("swap matches the existing control",
    eq(applyIntent(base, { type: "swap" }), applyAction(base, { type: "swap" })));

  const noCmp: PerspectiveTimeState = { preset: "CUSTOM", asOf: TODAY, compareTo: null };
  check("swap with no comparison is a no-op, same as today",
    eq(applyIntent(noCmp, { type: "swap" }), noCmp));
}

// ── 8. Derivations ───────────────────────────────────────────────────────────
console.log("8. Canonical → display derivations");
{
  const s: PerspectiveTimeState = { preset: "PAST_YEAR", asOf: TODAY, compareTo: "2025-07-19" };
  check("boundaries mirror canonical", deriveBoundaries(s).asOf === TODAY && deriveBoundaries(s).compareTo === "2025-07-19");
  check("a null comparison renders as an empty field",
    deriveBoundaries({ ...s, compareTo: null }).compareTo === "");

  check("summary uses the editorial label", summarize(s, TODAY).periodLabel === "Last 12 months");
  check("summary shows the full range", summarize(s, TODAY).rangeLabel.includes("→"));
  check("CUSTOM summarises as Custom range",
    summarize({ preset: "CUSTOM", asOf: TODAY, compareTo: "2020-01-01" }, TODAY).periodLabel === "Custom range");
  check("no comparison reads as point-in-time, not a fabricated range",
    summarize({ ...s, compareTo: null }, TODAY).comparisonLabel === "Point-in-time · no opening date" &&
    summarize({ ...s, compareTo: null }, TODAY).rangeLabel.startsWith("As of"));
  check("a real comparison adds no redundant second line",
    summarize(s, TODAY).comparisonLabel === null);
}

// ── 9. Capability gating mirrors the existing rule ───────────────────────────
console.log("9. Capability gating");
{
  check("undeclared capability shows the boundary controls (pre-declaration default)",
    capabilityForLens(undefined).custom === true);
  check("a lens with no explicit axes hides them",
    capabilityForLens({ asOf: "none", compareTo: "none", period: "full" }).custom === false);
  check("partial still renders (Debt/Liquidity)",
    capabilityForLens({ asOf: "partial", compareTo: "partial", period: "none" }).custom === true);
  check("comparison affordances need BOTH axes",
    capabilityForLens({ asOf: "full", compareTo: "none", period: "none" }).comparison === false);
}

// ── 10. TIME-1A/1B — anchor naming and the return-to-present escape hatch ────
console.log("10. Anchor semantics (TIME-1A/1B)");
{
  const present: PerspectiveTimeState = { preset: "MTD", asOf: TODAY, compareTo: "2026-07-01" };
  const historical: PerspectiveTimeState = { preset: "YTD", asOf: "2026-03-31", compareTo: "2026-01-01" };

  // 1B — the anchor is NAMED, always.
  check("present anchor is named 'As of today'", summarize(present, TODAY).anchorLabel === "As of today");
  check("present anchor reports anchoredToPresent", summarize(present, TODAY).anchoredToPresent === true);
  check("historical anchor is named with its date",
    summarize(historical, TODAY).anchorLabel === "As of Mar 31, 2026", summarize(historical, TODAY).anchorLabel);
  check("historical anchor reports NOT anchoredToPresent", summarize(historical, TODAY).anchoredToPresent === false);

  // 1B — no label may assert the present tense; that was the falsehood.
  for (const o of PERIOD_OPTIONS) {
    check(`option "${o.id}" label makes no present-tense claim`, !/^This\b/.test(o.label), o.label);
  }
  check("to-date presets read as 'to date'", PERIOD_OPTIONS.find((o) => o.id === "MTD")?.label === "Month to date");

  // 1A — the escape hatch maps onto an EXISTING action, and actually escapes.
  const r = shellActionForIntent({ type: "returnToPresent" }, ADAPTER_CTX);
  check("returnToPresent produces an action", r.ok);
  check("...and it is the existing setAsOf, not a new authority",
    r.ok && r.action.type === "setAsOf" && r.action.asOf === TODAY);

  const returned = applyIntent(historical, { type: "returnToPresent" });
  check("returning moves the anchor to today", returned.asOf === TODAY, show(returned));
  check("...preserving the active preset", returned.preset === "YTD");
  check("...and re-deriving its window from the NEW anchor", returned.compareTo === "2026-01-01");
  check("returning is reported as anchored to the present",
    summarize(returned, TODAY).anchoredToPresent === true);

  // The doctrine it exists to serve: presets do NOT free you.
  const stillAnchored = applyIntent(historical, { type: "period", optionId: "MTD", intent: "MTD" });
  check("a preset does NOT return you to the present (that is what the hatch is for)",
    stillAnchored.asOf === "2026-03-31");
}

// ── 11. RESOLVED: exactly ONE sanctioned path back to the present ────────────
//
// Open since Slice 4: should an emptied As-of field silently become today (what
// the legacy control did) or be rejected?
//
// RESOLVED — rejected. Not merely on "no silent fabricated dates", but because
// TIME-1A introduced an EXPLICIT "Return to today". If clearing the field also
// landed on today, there would be two paths to the present: one deliberate and
// labelled, one silent and accidental. A user who cleared the field and arrived
// at today would reasonably conclude that is how you return — and the labelled
// affordance becomes noise. Coherence requires exactly one.
//
// Doctrine: docs/architecture/CANONICAL_TIME_DOCTRINE.md
console.log("11. One sanctioned return to the present (RESOLVED)");
{
  const historical: PerspectiveTimeState = { preset: "YTD", asOf: "2026-03-31", compareTo: "2026-01-01" };

  // The sanctioned path.
  const viaHatch = shellActionForIntent({ type: "returnToPresent" }, ADAPTER_CTX);
  check("returnToPresent reaches the present", viaHatch.ok && viaHatch.action.type === "setAsOf" && viaHatch.action.asOf === TODAY);

  // The rejected path — deliberately NOT a second route.
  const viaEmpty = shellActionForIntent({ type: "customBoundary", boundary: "asOf", value: "" }, ADAPTER_CTX);
  check("clearing As-of does NOT silently return you to the present", !viaEmpty.ok);
  check("...it explains itself instead", !viaEmpty.ok && viaEmpty.error.length > 0);
  check("...and produces no action, so canonical time cannot move", !viaEmpty.ok && !("action" in viaEmpty));

  // Nothing else may reach today implicitly. Every other intent either leaves the
  // anchor alone or moves it only to a date the user typed.
  const anchorMovers = [
    { type: "period", optionId: "YTD", intent: "YTD" },
    { type: "swap" },
    { type: "clearComparison" },
  ] as const;
  for (const intent of anchorMovers) {
    const next = applyIntent(historical, intent);
    check(`${intent.type} does not quietly jump the anchor to today`, next.asOf !== TODAY, show(next));
  }

  // The empty COMPARISON boundary is a different case and stays legitimate — it
  // means "no comparison", exactly what the old ✕ button meant.
  const clearedCompare = shellActionForIntent({ type: "customBoundary", boundary: "compareTo", value: "" }, ADAPTER_CTX);
  check("an empty COMPARE-TO is still a legitimate clear, not an error", clearedCompare.ok);
}

if (failures > 0) {
  console.error(`\n${failures} adapter parity check(s) failed.`);
  process.exit(1);
}
console.log("\nTimelineLens adapter is behavior-identical to the existing controls.");
