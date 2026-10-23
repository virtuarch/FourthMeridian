/**
 * lib/transactions/flow-presentation.test.ts   (v2.6-TRUTH-7)
 *
 * The nature authority, and the standing probes that keep presentation from
 * becoming a second classifier.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  describeRowNature, flowTypeLabel,
  ROW_NATURE_LABEL, ROW_NATURE_GROUP_LABEL, ROW_NATURE_ORDER, type RowNature,
} from "./flow-presentation";
import { FLOW_TYPE_LABEL } from "./flow-predicates";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

// ─────────────────────────────────────────────────────────────────────────────
// The four live rows that started this slice
// ─────────────────────────────────────────────────────────────────────────────

test("an issuer credit is never Income, whatever flowType says", () => {
  // MICROSOFT#G174400309 +$280.45 on a CREDIT CARD. flowType=INCOME; the income
  // authority already said ISSUER_CREDIT. Presentation must follow the authority.
  const r = describeRowNature({ flowType: "INCOME", incomeSubtype: "ISSUER_CREDIT", amount: 280.45 });
  assert.equal(r.nature, "ISSUER_CREDIT");
  assert.equal(r.label, "Issuer credit");
  assert.equal(r.basis, "INCOME_TAXONOMY");
  // ⚠️ NEUTRAL, not positive. It returns money already spent; colouring it as a
  // gain is the visual form of the error the taxonomy fixed in the data.
  assert.equal(r.tone, "neutral");
});

test("interest earned is not earned income", () => {
  const r = describeRowNature({ flowType: "INCOME", incomeSubtype: "DEPOSIT_INTEREST", amount: 5.79 });
  assert.equal(r.nature, "INTEREST");
  assert.equal(r.label, "Interest earned");
  assert.notEqual(r.nature, "EARNED_INCOME");
});

test("salary stays earned income, and stays positive", () => {
  const r = describeRowNature({ flowType: "INCOME", incomeSubtype: "SALARY", amount: 5286.4 });
  assert.equal(r.nature, "EARNED_INCOME");
  assert.equal(r.tone, "positive");
});

test("a dividend is its own thing", () => {
  assert.equal(describeRowNature({ flowType: "INCOME", incomeSubtype: "SECURITY_DIVIDEND", amount: 12 }).nature, "DIVIDEND");
});

test("a refund is a refund whether the taxonomy or the flow type says so", () => {
  assert.equal(describeRowNature({ flowType: "INCOME", incomeSubtype: "REFUND_REVERSAL", amount: 1 }).nature, "REFUND");
  assert.equal(describeRowNature({ flowType: "REFUND", amount: 1 }).nature, "REFUND");
  // Neutral in both directions — a refund is not a gain.
  assert.equal(describeRowNature({ flowType: "REFUND", amount: 1 }).tone, "neutral");
});

// ─────────────────────────────────────────────────────────────────────────────
// Transfers
// ─────────────────────────────────────────────────────────────────────────────

test("a transfer is directed by the sign of its amount, and is never a gain", () => {
  assert.equal(describeRowNature({ flowType: "TRANSFER", amount: 4000 }).nature, "TRANSFER_IN");
  assert.equal(describeRowNature({ flowType: "TRANSFER", amount: -4000 }).nature, "TRANSFER_OUT");
  assert.equal(describeRowNature({ flowType: "TRANSFER", amount: 4000 }).tone, "neutral");
});

test("an owned counterparty makes it an INTERNAL transfer, in either direction", () => {
  // The $4,000 Amex HYSA row: TRANSFER, counterparty CHASE COLLEGE (owned).
  const into = describeRowNature({ flowType: "TRANSFER", amount: 4000, hasOwnedCounterparty: true });
  assert.equal(into.nature, "INTERNAL_TRANSFER");
  assert.equal(describeRowNature({ flowType: "TRANSFER", amount: -4000, hasOwnedCounterparty: true }).nature, "INTERNAL_TRANSFER");
  // ⚠️ And it is NEVER a debt payment.
  assert.notEqual(into.nature, "DEBT_PAYMENT");
});

test("the transfer authority's destination verdict outranks the provider's flowType", () => {
  // The live row: persisted DEBT_PAYMENT because the provider categorised it from
  // a descriptor naming an institution that also issues a card. The transfer
  // authority resolved the destination to a SAVINGS account.
  const r = describeRowNature({ flowType: "DEBT_PAYMENT", transferMaturity: "SAVINGS_TRANSFER", amount: -4000 });
  assert.equal(r.nature, "INTERNAL_TRANSFER");
  assert.equal(r.label, "Internal transfer");
  assert.equal(r.basis, "TRANSFER_MATURITY");
  assert.equal(r.tone, "neutral");
});

test("a maturity of DEBT_PAYMENT keeps a real card payment a debt payment", () => {
  const r = describeRowNature({ flowType: "DEBT_PAYMENT", transferMaturity: "DEBT_PAYMENT", amount: -650 });
  assert.equal(r.nature, "DEBT_PAYMENT");
  assert.equal(r.basis, "TRANSFER_MATURITY");
});

test("an unassessed row still reads from its flowType", () => {
  // Most rows carry no maturity — they already had a persisted counterparty, or
  // are not transfer-shaped. Absence must not change their label.
  const r = describeRowNature({ flowType: "DEBT_PAYMENT", transferMaturity: null, amount: -650 });
  assert.equal(r.nature, "DEBT_PAYMENT");
  assert.equal(r.basis, "FLOW_TYPE");
});

test("an unrecognized maturity falls through rather than inventing a nature", () => {
  const r = describeRowNature({ flowType: "SPENDING", transferMaturity: "SOME_FUTURE_MATURITY", amount: -5 });
  assert.equal(r.nature, "SPENDING");
  assert.equal(r.basis, "FLOW_TYPE");
});

// ─────────────────────────────────────────────────────────────────────────────
// Precedence and honest absence
// ─────────────────────────────────────────────────────────────────────────────

test("the income taxonomy outranks flowType, because it is strictly more informed", () => {
  const r = describeRowNature({ flowType: "INCOME", incomeSubtype: "INTERNAL_TRANSFER", amount: 100 });
  assert.equal(r.nature, "INTERNAL_TRANSFER");
  assert.equal(r.basis, "INCOME_TAXONOMY");
});

test("no attribution falls back to the CANONICAL flow label, and says so", () => {
  const r = describeRowNature({ flowType: "SPENDING", amount: -20 });
  assert.equal(r.nature, "SPENDING");
  assert.equal(r.basis, "FLOW_TYPE");
  // Not a silent fallback — `basis` records which authority answered.
  const u = describeRowNature({ flowType: null, amount: 0 });
  assert.equal(u.nature, "UNKNOWN");
  assert.equal(u.basis, "FLOW_TYPE");
});

test("an unrecognized subtype falls through rather than inventing a nature", () => {
  const r = describeRowNature({ flowType: "SPENDING", incomeSubtype: "NOT_A_REAL_SUBTYPE", amount: -5 });
  assert.equal(r.nature, "SPENDING");
  assert.equal(r.basis, "FLOW_TYPE");
});

// ─────────────────────────────────────────────────────────────────────────────
// Completeness
// ─────────────────────────────────────────────────────────────────────────────

test("every nature has a label, a group label and a place in the order", () => {
  const natures = Object.keys(ROW_NATURE_LABEL) as RowNature[];
  for (const n of natures) {
    assert.ok(ROW_NATURE_LABEL[n], `${n} has no label`);
    assert.ok(ROW_NATURE_GROUP_LABEL[n], `${n} has no group label`);
    assert.ok(ROW_NATURE_ORDER.includes(n), `${n} is missing from ROW_NATURE_ORDER`);
  }
  assert.equal(ROW_NATURE_ORDER.length, natures.length, "ROW_NATURE_ORDER and the label map disagree");
});

test("flowTypeLabel delegates to the canonical map", () => {
  for (const [k, v] of Object.entries(FLOW_TYPE_LABEL)) assert.equal(flowTypeLabel(k), v);
  assert.equal(flowTypeLabel(null), FLOW_TYPE_LABEL.UNKNOWN);
});

// ─────────────────────────────────────────────────────────────────────────────
// Standing source probes
// ─────────────────────────────────────────────────────────────────────────────

test("the nature authority reads no descriptor, ever", () => {
  // The moment a label is derived from a merchant string, presentation has
  // become a second classifier — which is what this module exists to remove.
  const code = strip(read("lib/transactions/flow-presentation.ts"));
  for (const forbidden of [/\bmerchant\b/i, /\bdescription\b/i, /\bcategory\b/i, /Math\.abs/, /86_?400_?000/, /\bdate\b/i]) {
    assert.ok(!forbidden.test(code), `flow-presentation.ts consults a descriptor: ${forbidden}`);
  }
});

const walk = (d: string, out: string[] = []): string[] => {
  let entries: string[] = [];
  try { entries = readdirSync(join(process.cwd(), d)); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const rel = `${d}/${e}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
};

test("exactly one FlowType label map exists", () => {
  // FLOW_TYPE_LABEL (the enum words) and ROW_NATURE_LABEL / ROW_NATURE_GROUP_LABEL
  // (the nature words) are the only sanctioned maps, and both live in lib/.
  const ALLOWED = new Set([
    "lib/transactions/flow-predicates.ts",
    "lib/transactions/flow-presentation.ts",
  ]);
  const offenders = ["lib", "app", "components", "jobs"].flatMap((r) => walk(r))
    .filter((f) => !f.startsWith("prototype/") && !ALLOWED.has(f))
    .filter((f) => {
      const code = strip(read(f));
      // A duplicate label map is an object literal whose keys are ALL FlowType
      // values and whose values are human prose. Both halves matter:
      //  · liquidity-breakdown.ts keys on LiquidityReason (INTERNAL_TRANSFER,
      //    ASSET_LIQUIDATION) — a different vocabulary, not a duplicate.
      //  · plaid-flow-input.ts maps FlowType → the SAME enum value — an adapter's
      //    value map, carrying no words at all.
      const FLOW = new Set(Object.keys(FLOW_TYPE_LABEL));
      for (const body of code.match(/\{[^{}]*\}/g) ?? []) {
        const pairs = [...body.matchAll(/(\w+)\s*:\s*["'`]([^"'`]*)["'`]/g)];
        if (pairs.length < 3) continue;
        if (!pairs.every(([, k]) => FLOW.has(k))) continue;      // a different vocabulary
        if (!pairs.some(([, , v]) => /[a-z]/.test(v))) continue; // enum→enum, not labels
        return true;
      }
      return false;
    });
  assert.deepEqual(offenders, [], "these modules declare their own FlowType label map");
});

test("no presentation component derives a flow label mechanically", () => {
  // `humanize(flowType)` — replacing underscores and title-casing an enum — is
  // the weakest of the three maps this slice collapsed. It must not come back.
  const offenders = ["components", "app"].flatMap((r) => walk(r))
    .filter((f) => !f.startsWith("prototype/"))
    .filter((f) => {
      const code = strip(read(f));
      if (!/flowType/.test(code)) return false;
      return /flowType[^\n]*replace\(\/_\/g/.test(code) || /humanize\(\s*\w*\.?flowType/.test(code);
    });
  assert.deepEqual(offenders, [], "these components humanize flowType instead of asking the authority");
});
