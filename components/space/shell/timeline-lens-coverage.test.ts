/**
 * components/space/shell/timeline-lens-coverage.test.ts
 *
 * Slice 4 validation — the ALL / coverage lifecycle.
 *
 * This is the sharpest honesty case in the whole time model. `ALL` means "since
 * the first record", and the first record's date arrives ASYNCHRONOUSLY: the
 * Space's `earliestDefensibleDate` loads after first paint, and
 * usePerspectiveShellState re-derives ALL when it lands (the effect at :116-118).
 *
 * So there is a real window where a user has selected "All history" and the
 * system does not yet know when history starts. The requirement is that the UI
 * says so, rather than inventing a start date — `compareToForPreset` is explicit
 * that ALL must "never fabricate a start".
 *
 * These tests walk that lifecycle through the REAL reducer and the REAL adapter
 * derivations, asserting what the user would actually read at each step.
 *
 * Pure, DB-free:  npx tsx components/space/shell/timeline-lens-coverage.test.ts
 */

import {
  hydrateShellTimeState,
  shellTimeReducer,
  type PerspectiveTimeState,
} from "@/lib/perspectives/time-range";
import {
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
const show = (s: PerspectiveTimeState) => `${s.preset}/${s.asOf}/${s.compareTo}`;

/** The user picks "All history" through the lens. */
function pickAll(state: PerspectiveTimeState, coverageFrom: string | null) {
  const r = shellActionForIntent({ type: "period", optionId: "ALL", intent: "ALL" }, { today: TODAY });
  if (!r.ok) throw new Error("ALL intent rejected");
  return shellTimeReducer(state, r.action, { today: TODAY, coverageFrom });
}

const START: PerspectiveTimeState = { preset: "MTD", asOf: TODAY, compareTo: "2026-07-01" };

// ── 1. Coverage already known ────────────────────────────────────────────────
console.log("1. Space WITH a coverage date");
{
  const s = pickAll(START, COVERAGE);
  check("compareTo resolves to the coverage date", s.compareTo === COVERAGE, show(s));
  check("preset is ALL", s.preset === "ALL");
  check("the ALL option reads as active", deriveActiveOptionId(s) === "ALL");
  check("readout shows the real span", summarize(s, TODAY).rangeLabel.includes("→"));
  check("no point-in-time caveat is shown", summarize(s, TODAY).comparisonLabel === null);
  check("boundary fields carry the coverage date", deriveBoundaries(s).compareTo === COVERAGE);
}

// ── 2. Space with NO history at all ──────────────────────────────────────────
console.log("2. Space with NO coverage (empty / brand-new)");
{
  const s = pickAll(START, null);
  check("compareTo is null — no start date is FABRICATED", s.compareTo === null, show(s));
  check("preset is still ALL (the user's choice is honoured)", s.preset === "ALL");
  check("the ALL option still reads as active", deriveActiveOptionId(s) === "ALL");

  const sum = summarize(s, TODAY);
  check("readout does NOT claim a range", !sum.rangeLabel.includes("→"), sum.rangeLabel);
  check("readout is point-in-time instead", sum.rangeLabel.startsWith("As of"), sum.rangeLabel);
  check("the caveat is stated explicitly", sum.comparisonLabel === "Point-in-time · no opening date");
  check("the boundary field is EMPTY, not a placeholder date", deriveBoundaries(s).compareTo === "");
  check("asOf is untouched and real", s.asOf === TODAY);
}

// ── 3. Delayed coverage hydration — the async window ─────────────────────────
console.log("3. Coverage arrives AFTER the user picked ALL");
{
  // t0: ALL picked while coverage is still loading.
  const t0 = pickAll(START, null);
  check("t0 — no fabricated compareTo during the async window", t0.compareTo === null, show(t0));
  check("t0 — the readout is honest, not a wrong range",
    summarize(t0, TODAY).comparisonLabel === "Point-in-time · no opening date");

  // t1: coverage lands. This mirrors usePerspectiveShellState's re-derive effect
  // exactly: re-run selectPreset ALL against the NEW ctx.
  const t1 = shellTimeReducer(t0, { type: "selectPreset", preset: "ALL" }, { today: TODAY, coverageFrom: COVERAGE });
  check("t1 — compareTo becomes the coverage date", t1.compareTo === COVERAGE, show(t1));
  check("t1 — readout updates to the real span", summarize(t1, TODAY).rangeLabel.includes("→"));
  check("t1 — the caveat disappears", summarize(t1, TODAY).comparisonLabel === null);
  check("t1 — ALL is still the active option", deriveActiveOptionId(t1) === "ALL");
  check("t1 — asOf never moved across the transition", t1.asOf === t0.asOf);

  // The re-derive must be inert for any NON-ALL preset (the effect guards on it).
  const mtd = shellTimeReducer(START, { type: "selectPreset", preset: "MTD" }, { today: TODAY, coverageFrom: null });
  const mtdAfter = shellTimeReducer(mtd, { type: "selectPreset", preset: "MTD" }, { today: TODAY, coverageFrom: COVERAGE });
  check("a non-ALL preset is unaffected by coverage arriving",
    mtd.compareTo === mtdAfter.compareTo && mtd.preset === mtdAfter.preset);
}

// ── 4. Deep link to ALL before coverage is known ─────────────────────────────
console.log("4. Deep link ?preset=ALL while coverage is still loading");
{
  const hydratedNoCoverage = hydrateShellTimeState(
    { asOf: TODAY, compareTo: null, preset: "ALL" },
    { today: TODAY, coverageFrom: null },
  );
  check("hydrates to ALL with a null compareTo (nothing invented)",
    hydratedNoCoverage.preset === "ALL" && hydratedNoCoverage.compareTo === null, show(hydratedNoCoverage));
  check("the lens reads it as ALL, not as a custom range",
    deriveActiveOptionId(hydratedNoCoverage) === "ALL");
  check("the readout is honest at first paint",
    summarize(hydratedNoCoverage, TODAY).comparisonLabel === "Point-in-time · no opening date");

  const hydratedWithCoverage = hydrateShellTimeState(
    { asOf: TODAY, compareTo: null, preset: "ALL" },
    { today: TODAY, coverageFrom: COVERAGE },
  );
  check("with coverage known, the same link resolves the real span",
    hydratedWithCoverage.compareTo === COVERAGE, show(hydratedWithCoverage));
}

// ── 5. Editing a boundary out of ALL behaves like the old control ────────────
console.log("5. Leaving ALL by editing a boundary");
{
  const all = pickAll(START, COVERAGE);
  const r = shellActionForIntent({ type: "customBoundary", boundary: "compareTo", value: "2020-05-05" }, { today: TODAY });
  if (!r.ok) throw new Error("boundary rejected");
  const edited = shellTimeReducer(all, r.action, { today: TODAY, coverageFrom: COVERAGE });
  check("editing the opening boundary leaves ALL for CUSTOM", edited.preset === "CUSTOM", show(edited));
  check("no option reads as active under CUSTOM", deriveActiveOptionId(edited) === null);
  check("asOf is preserved", edited.asOf === all.asOf);
}

// ── 6. Empty Space — every preset stays coherent with no data ────────────────
console.log("6. Empty Space (no accounts, no coverage) — every preset");
{
  for (const preset of ["WTD", "MTD", "QTD", "YTD", "PAST_WEEK", "PAST_MONTH", "PAST_QUARTER", "PAST_6_MONTHS", "PAST_YEAR", "ALL"]) {
    const r = shellActionForIntent({ type: "period", optionId: preset, intent: preset }, { today: TODAY });
    if (!r.ok) { check(`${preset} produces an action`, false); continue; }
    const s = shellTimeReducer(START, r.action, { today: TODAY, coverageFrom: null });
    check(`${preset} — asOf stays real, never null/empty`, !!s.asOf && s.asOf === TODAY);
    check(`${preset} — reads back as itself`, deriveActiveOptionId(s) === preset);
    // Only ALL may legitimately have no opening boundary with no coverage.
    if (preset !== "ALL") {
      check(`${preset} — still derives its own opening boundary`, s.compareTo !== null, show(s));
    }
    // Nothing may produce a summary that claims a range it does not have.
    const sum = summarize(s, TODAY);
    check(`${preset} — range copy matches whether a boundary exists`,
      sum.rangeLabel.includes("→") === (s.compareTo !== null), `${sum.rangeLabel} vs ${show(s)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} coverage-lifecycle check(s) failed.`);
  process.exit(1);
}
console.log("\nALL / coverage lifecycle is honest at every step.");
