/**
 * app/api/brief/brief-authority.test.ts
 *
 * v2.6-BRIEF-1 — the Daily Brief states no financial verdict of its own.
 *
 * ── Why a source-scan guard ─────────────────────────────────────────────────
 *
 * `computeAssessment` is THE deterministic answer to "how am I doing?" — debt
 * health, liquidity coverage, cash-flow reliability, and which of them matters
 * most right now. The Brief answered the same questions itself, with four inline
 * rules that disagreed with it:
 *
 *     totalLiquid / netWorth < 0.05   →  "Low cash position"
 *     totalDebt / totalAssets > 0.5   →  "Debt makes up more than half…"
 *     cash / netWorth > 0.4           →  "…sitting in cash"
 *     (income − expense) / income     →  a savings rate, stated unconditionally
 *
 * None of those is the authority's definition. Liquidity is COVERAGE (cash
 * against monthly expenses), not a balance-sheet ratio; debt health is APR and
 * trend, not a share of assets. So the Brief could open with "Low cash position"
 * on a Space the AI would tell you has EXCELLENT coverage — two surfaces, one
 * corpus, opposite advice, and no way for a user to know which to believe.
 *
 * TRUTH-10 learned that a convergence asserted in prose gets re-broken: five
 * inline copies of the account-name rule existed, and TWO survived a convergence
 * proof that said they did not. This asserts it in code instead.
 *
 * The rule: the Brief may FORMAT anything and may quote any figure the context
 * carries. It may not DERIVE a verdict — no threshold comparison over a ratio of
 * two financial totals. That decision belongs to one module.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROUTE = path.join(process.cwd(), "app", "api", "brief", "route.ts");

/** Strip comments — this file's own history is DOCUMENTED in the route's
 *  headers, and prose describing a deleted rule is not that rule. */
function code(): string {
  return readFileSync(ROUTE, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

test("BRIEF-1: the Brief reads the assessment authority", () => {
  const src = code();
  assert.match(
    src, /computeAssessment\s*\(/,
    "app/api/brief/route.ts no longer calls computeAssessment. The Brief's " +
    "conclusions must come from the assessment authority, not from the route.",
  );
});

test("BRIEF-1: the Brief derives no verdict from a ratio of financial totals", () => {
  const src = code();

  // A comparison whose left side divides one money-ish quantity by another.
  // Catches `acct.totalLiquid / acct.netWorth < 0.05`, `totalDebt / totalAssets
  // > 0.5` and `cash / netWorth > 0.4` — the three rules this slice removed —
  // without objecting to formatting maths (`n / 1_000`, `x * 100`) or to a
  // percentage computed for DISPLAY and not compared against a threshold.
  const MONEY = String.raw`(?:\w+\.)?(?:total\w*|netWorth|cash|balance|liquid\w*|income\w*|expense\w*)`;
  const ratioVerdict = new RegExp(String.raw`${MONEY}\s*/\s*${MONEY}\s*[<>]=?\s*[\d.]`, "i");

  const offenders = src
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => ratioVerdict.test(line));

  assert.deepEqual(
    offenders.map((o) => `  ${o.n}: ${o.line}`), [],
    "The Brief is deriving a financial verdict from a ratio again.\n" +
    "Read the classification off computeAssessment instead:\n" +
    "  liquidity  → assessment.liquidity.classification   (COVERAGE, not a net-worth share)\n" +
    "  debt       → assessment.debt.classification        (APR and trend, not a share of assets)\n" +
    "  what leads → assessment.currentStatePriority\n" +
    "A ratio is a shape, not a verdict, and the two disagreed in both directions.",
  );
});

test("BRIEF-1: the Brief does not re-derive what the assessment already computed", () => {
  const src = code();
  // The route used to call deriveUnidentifiedInflowShare(txn) itself, computing
  // a second time — from the same input — what computeAssessment had already put
  // on dataQuality.unidentifiedInflowShare. Two call sites, one definition, and
  // nothing keeping the two readings of it in step.
  assert.doesNotMatch(
    src, /deriveUnidentifiedInflowShare\s*\(/,
    "Read assessment.dataQuality.unidentifiedInflowShare instead of recomputing it.",
  );
});

// ── W3 — assessment-complete debt context: the route RENDERS, never re-grades ─

test("W3: the DEBT insight arm exists and renders the engine's verdict", () => {
  const src = code();
  assert.match(src, /case "DEBT":/,
    "the DEBT arm was reinstated with the W3 product decision — its absence " +
    "would silently drop the engine's top priority on the Brief");
  assert.match(src, /debt\.classification === "CRITICAL"/,
    "the arm must branch on the ENGINE's classification, not a route-local rule");
});

test("W3: the route computes no debt figure of its own", () => {
  const src = code();
  assert.ok(!/computeDebtAggregate|resolveEffectiveDebtTerms|weightedApr/.test(src),
    "the Brief quotes the assessment's debt facts; it never re-derives them");
  assert.ok(!/monthlyInterestBurden\s*[=*+/-]/.test(src),
    "the interest burden is quoted from the engine, never recomputed");
});

test("W3: the payload-choice deflection is gone; the genuine-gap clause names APR_MISSING", () => {
  const src = code();
  assert.ok(!src.includes("ACCOUNT_LIST_WITHHELD_BY_SCOPE"),
    "the Brief no longer apologises for its own payload choice — that refusal is unreachable");
  assert.ok(!src.includes("doesn't carry the per-account detail"),
    "the old deflection copy must not survive in code");
  assert.match(src, /"APR_MISSING"/,
    "the say-so arm must name the one genuine debt data gap a user can fix");
});

test("W3: the honesty clause consumes the assembler's disclosure facts", () => {
  const src = code();
  for (const field of ["totalsUnconverted", "totalsEstimated", "redactedCount"]) {
    assert.ok(src.includes(field),
      `${field} is computed by the assembler on every payload; the Brief must consume it ` +
      "rather than present a complete-looking figure over partial totals");
  }
});
