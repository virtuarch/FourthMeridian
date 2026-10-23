/**
 * lib/transactions/flow-presentation.direction.test.ts
 *
 * v2.6-DIR-1 — direction survives, on every row, whatever the tone or maturity.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 *
 * `RowTone` was answering two questions. It is a COLOUR ("gain, cost, or
 * neither"), and three components also read it as "should the amount show a
 * direction?":
 *
 *     {nature.tone === "neutral" ? "" : isCredit ? "+" : "−"}{fmt(amount)}
 *
 * Every transfer is neutral. So a −$650 payment leaving a checking account and
 * its +$650 counterpart arriving on the card BOTH rendered "$650.00", and a
 * user reading the ledger could not tell which way the money went.
 *
 * The perverse part: `describeRowNature` rung 3 directs an UNMATURED transfer by
 * the sign of its amount, and rung 2 — the transfer authority's maturity verdict
 * — runs FIRST and collapses SAVINGS_TRANSFER/CASH_TRANSFER into the
 * directionless `INTERNAL_TRANSFER`. Better evidence produced a LESS legible row.
 * Improving the transfer ladder made the ledger worse.
 *
 * The repair is one field. `direction` is computed from the row's own signed
 * amount before any rung runs, so no verdict can reach it and none can suppress
 * it. `nature` says WHAT the movement was; `direction` says WHICH WAY.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  describeRowNature,
  DIRECTION_SIGN,
  type RowNatureEvidence,
} from "@/lib/transactions/flow-presentation";

const ROOT = process.cwd();

/** Every transfer-shaped maturity the authority can emit, as the slice brief
 *  enumerates them. Each is exercised in BOTH directions. */
const TRANSFER_MATURITIES = [
  "INTERNAL_TRANSFER",
  "SAVINGS_TRANSFER",
  "CASH_TRANSFER",
  "INVESTMENT_TRANSFER",
  "DEBT_PAYMENT",
  "EXTERNAL_PERSON_TRANSFER",
  "EXTERNAL_VENUE_TRANSFER",
  "EXTERNAL_DEPOSITORY_TRANSFER",
  "CASH_MOVEMENT",
  "UNRESOLVED_TRANSFER",
] as const;

const row = (over: Partial<RowNatureEvidence> = {}): RowNatureEvidence => ({
  flowType: "TRANSFER", amount: -650, ...over,
});

// ── 1. Direction is present on every transfer kind, both ways ────────────────
test("DIR-1: every transfer maturity keeps its direction, in both directions", () => {
  for (const maturity of TRANSFER_MATURITIES) {
    const out = describeRowNature(row({ transferMaturity: maturity, amount: -650 }));
    const inn = describeRowNature(row({ transferMaturity: maturity, amount: 650 }));

    assert.equal(out.direction, "OUT", `${maturity} outflow lost its direction`);
    assert.equal(inn.direction, "IN", `${maturity} inflow lost its direction`);
    // …and the glyph a surface actually prints differs.
    assert.equal(DIRECTION_SIGN[out.direction], "−", `${maturity} outflow prints no minus`);
    assert.equal(DIRECTION_SIGN[inn.direction], "+", `${maturity} inflow prints no plus`);
  }
});

// ── 2. Equal-magnitude opposite legs render differently ──────────────────────
test("DIR-1: the two legs of one $650 movement do not render identically", () => {
  // The literal defect, as it appeared in the browser: two rows, same magnitude,
  // same label, indistinguishable.
  const cashLeg      = describeRowNature(row({ transferMaturity: "DEBT_PAYMENT", amount: -650 }));
  const liabilityLeg = describeRowNature(row({ transferMaturity: "DEBT_PAYMENT", amount: 650 }));

  assert.notEqual(
    `${DIRECTION_SIGN[cashLeg.direction]}650.00`,
    `${DIRECTION_SIGN[liabilityLeg.direction]}650.00`,
    "the two legs of the same movement still render identically",
  );
  assert.equal(`${DIRECTION_SIGN[cashLeg.direction]}650.00`, "−650.00");
  assert.equal(`${DIRECTION_SIGN[liabilityLeg.direction]}650.00`, "+650.00");
  // The LABEL is unchanged on both — this slice moves direction, never meaning.
  assert.equal(cashLeg.label, "Debt payment");
  assert.equal(liabilityLeg.label, "Debt payment");
});

// ── 3. Tone cannot suppress direction ────────────────────────────────────────
test("DIR-1: tone and direction are independent axes", () => {
  // A neutral tone with a real direction is the ENTIRE point: an internal
  // transfer is neither a gain nor a cost, and it still went somewhere.
  const neutralOut = describeRowNature(row({ transferMaturity: "SAVINGS_TRANSFER", amount: -4000 }));
  assert.equal(neutralOut.tone, "neutral");
  assert.equal(neutralOut.direction, "OUT");

  // Every combination that can occur, occurs — so no consumer can infer one from
  // the other and be right.
  const seen = new Set<string>();
  for (const e of [
    row({ flowType: "INCOME", incomeSubtype: "SALARY", amount: 5000 }),        // positive / IN
    row({ flowType: "SPENDING", amount: -20 }),                               // negative / OUT
    row({ transferMaturity: "CASH_TRANSFER", amount: -100 }),                 // neutral  / OUT
    row({ transferMaturity: "CASH_TRANSFER", amount: 100 }),                  // neutral  / IN
    row({ flowType: "REFUND", amount: 30 }),                                  // neutral  / IN
  ]) {
    const r = describeRowNature(e);
    seen.add(`${r.tone}/${r.direction}`);
  }
  assert.ok(seen.has("neutral/OUT") && seen.has("neutral/IN"),
    "a neutral tone must be able to carry either direction");
  assert.ok(seen.has("positive/IN") && seen.has("negative/OUT"),
    "the toned natures must still carry their direction");
});

// ── 4. Maturity cannot suppress direction ────────────────────────────────────
test("DIR-1: resolving a maturity never removes direction that was there without one", () => {
  // The regression shape: the SAME row, once before the transfer authority
  // reached a verdict and once after. Better evidence must not cost direction.
  for (const amount of [-650, 650]) {
    const unmatured = describeRowNature(row({ amount, transferMaturity: null }));
    for (const maturity of TRANSFER_MATURITIES) {
      const matured = describeRowNature(row({ amount, transferMaturity: maturity }));
      assert.equal(
        matured.direction, unmatured.direction,
        `maturity ${maturity} changed the direction of a ${amount} row ` +
        `(${unmatured.direction} → ${matured.direction}) — a destination verdict ` +
        `must not restate which way the money moved`,
      );
    }
  }
});

// ── 5. A zero amount is the only directionless row ───────────────────────────
test("DIR-1: NONE is reserved for a zero amount, never for uncertainty", () => {
  assert.equal(describeRowNature(row({ amount: 0 })).direction, "NONE");
  assert.equal(DIRECTION_SIGN.NONE, "");
  // Even the least-resolved row keeps its direction.
  assert.equal(describeRowNature({ flowType: null, amount: -1 }).direction, "OUT");
  assert.equal(describeRowNature({ flowType: "UNKNOWN", amount: 1 }).direction, "IN");
});

// ── 6. Source guards — React derives nothing ─────────────────────────────────

const UI_ROOTS = ["components", "app"];

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const childRel = path.join(rel, e);
    if (statSync(path.join(ROOT, childRel)).isDirectory()) { out.push(...walk(childRel)); continue; }
    if (!/\.(ts|tsx)$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
    out.push(childRel);
  }
  return out;
}
const codeOf = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

test("DIR-1: no UI file gates a sign on tone", () => {
  // The exact expression that caused this, in any spacing.
  const toneGatedSign = /tone\s*===\s*["']neutral["']\s*\?\s*["']["']\s*:/;
  const offenders = UI_ROOTS.flatMap(walk).filter((f) => toneGatedSign.test(codeOf(f)));
  assert.deepEqual(
    offenders, [],
    `Tone is gating a sign in:\n${offenders.map((f) => `  ${f}`).join("\n")}\n\n` +
    `Tone is a COLOUR. Use DIRECTION_SIGN[nature.direction] for the sign — a ` +
    `neutral tone must never erase a real direction.`,
  );
});

test("DIR-1: no ROW-level consumer derives a transaction sign from the amount", () => {
  // `amount > 0 ? "+" : "−"` and friends, scoped to files that decide a ROW's
  // nature. A file that resolves what a transaction IS must not separately
  // decide which way it went — that is the split this slice closed.
  //
  // ⚠️ Deliberately NOT repository-wide. An AGGREGATE sign is a different fact:
  // a period delta ("what changed", a net total) is signed by its own arithmetic
  // and has no `RowNature` at all. LiquidityWhatChangedCard.fmtSigned and the
  // slice drawer's net footer are correct as they stand, and a guard that flagged
  // them would be demanding the wrong authority — the first version of this test
  // did exactly that.
  const localSign = /\bamount\s*[><]=?\s*0\s*\?\s*["'][+−-]["']/;
  const offenders = [...UI_ROOTS, "lib"].flatMap(walk)
    .filter((f) => /\bdescribeRowNature\s*\(/.test(codeOf(f)))
    .filter((f) => localSign.test(codeOf(f)));
  assert.deepEqual(
    offenders, [],
    `A row-level consumer is deriving a sign from the amount in:\n${offenders.map((f) => `  ${f}`).join("\n")}\n\n` +
    `Use DIRECTION_SIGN[nature.direction].`,
  );
});

test("DIR-1: every describeRowNature consumer that prints a sign uses DIRECTION_SIGN", () => {
  // Consumers are found, not listed, so a NEW one is covered the day it lands.
  const consumers = [...UI_ROOTS, "lib"].flatMap(walk)
    .filter((f) => /\bdescribeRowNature\s*\(/.test(codeOf(f)));
  assert.ok(consumers.length >= 4, `expected the known consumers, found ${consumers.length}`);

  const offenders: string[] = [];
  for (const f of consumers) {
    const code = codeOf(f);
    // Does this consumer render a signed amount at all? A sign glyph adjacent to
    // a string boundary is the tell.
    const printsSign = /["'][+−]["']/.test(code);
    if (!printsSign) continue;                       // e.g. the CSV export: label only
    if (/DIRECTION_SIGN/.test(code)) continue;       // uses the authority
    offenders.push(f);
  }
  assert.deepEqual(
    offenders, [],
    `describeRowNature consumer(s) printing a sign without DIRECTION_SIGN:\n` +
    offenders.map((f) => `  ${f}`).join("\n"),
  );
});
