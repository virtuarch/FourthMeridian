/**
 * lib/ai/assemblers/transactions.parity.test.ts
 *
 * v2.6-PARITY-1 — the AI reads the product's population, and cannot stop.
 *
 * ── What went wrong, so the guards make sense ───────────────────────────────
 *
 * The AI assembler built its own `where`: it restated the KD-15 visibility gate,
 * spread `BANKING_POPULATION`, applied no event projection, and windowed on
 * `date` while every bucket downstream keyed on `econOf`. Four rules that are
 * stated canonically elsewhere, restated here, and the model reasoned over the
 * result.
 *
 * Three of the four divergences turned out to be LATENT on the live corpus
 * (audit-ai-read-parity measured them before the cutover: 0 superseded rows, 0
 * gate drift, 0 unreachable drilldown rows). That is exactly why guards are
 * needed rather than a one-off fix — nothing about the corpus would have told
 * anyone when they stopped being latent.
 *
 * These probes pin the SHAPE, not the numbers: the numbers were fine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { FlowType, TransactionCategory, type Prisma } from "@prisma/client";

import { aiTransactionWhere, aiDrilldownWhere } from "@/lib/ai/assemblers/transactions";
import { bankingTransactionWhere } from "@/lib/data/banking-population";

const SPACE = "space-1";
const WIN = { start: new Date("2026-01-01T00:00:00.000Z"), end: new Date("2026-03-31T23:59:59.999Z") };

/** Every key path present anywhere in a nested where-fragment. */
function keysDeep(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) { for (const x of v) keysDeep(x, acc); return acc; }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) { acc.push(k); keysDeep(val, acc); }
  }
  return acc;
}

// ── 1. The population IS the product's, not a copy of it ────────────────────
test("PARITY-1: the AI's where CONTAINS bankingTransactionWhere verbatim", () => {
  for (const where of [
    aiTransactionWhere(SPACE, WIN),
    aiTransactionWhere(SPACE, { start: WIN.start, end: null }),
    aiDrilldownWhere(SPACE, { start: WIN.start, end: WIN.end }, {
      categoryWhere: {}, amountWhere: {}, merchantQuery: undefined,
    }),
  ]) {
    const and = (where as { AND?: unknown[] }).AND;
    assert.ok(Array.isArray(and), "the fragment must be AND-composed, never a spread object literal");
    const canonical = JSON.stringify(bankingTransactionWhere(SPACE));
    assert.ok(
      and.some((f) => JSON.stringify(f) === canonical),
      "the canonical banking population must appear UNCHANGED — restating the KD-15 gate, " +
      "the population or the event projection is how the AI came to read a population " +
      "no other surface did",
    );
  }
});

// ── 2. The basis ────────────────────────────────────────────────────────────
test("PARITY-1: a flow read windows on economicDate and never on date (rule B1)", () => {
  for (const [name, where] of [
    ["summary (bounded)", aiTransactionWhere(SPACE, WIN)],
    ["summary (open)", aiTransactionWhere(SPACE, { start: WIN.start, end: null })],
    ["drilldown", aiDrilldownWhere(SPACE, { start: WIN.start, end: WIN.end }, {
      categoryWhere: {}, amountWhere: {}, merchantQuery: undefined,
    })],
  ] as const) {
    const keys = keysDeep(where);
    assert.ok(keys.includes("economicDate"), `${name} must window on economicDate`);
    assert.ok(
      !keys.includes("date"),
      `${name} still filters on \`date\`. The window and the buckets would then use ` +
      `different chronologies: a row admitted because it POSTED inside the window, ` +
      `counted under the month it ECONOMICALLY happened in — a month the window never covered.`,
    );
  }
});

// ── 3. Composition, not spreading ───────────────────────────────────────────
test("PARITY-1: caller fragments are AND-ed, so none can silently swallow another", () => {
  // The live hazard: `categoryWhere` may itself be an `{ AND: [...] }`, and
  // `bankingTransactionWhere` carries BOTH an `AND` (population) and an `OR`
  // (event projection). Spread into one object literal, the later key wins and
  // the earlier filter vanishes — with no error and no wrong-looking output.
  const categoryWhere: Prisma.TransactionWhereInput = {
    AND: [{ category: TransactionCategory.Shopping }],
  };
  const amountWhere: Prisma.TransactionWhereInput = { amount: { lt: 0 } };
  const where = aiDrilldownWhere(SPACE, { start: WIN.start, end: WIN.end }, {
    categoryWhere, amountWhere, merchantQuery: "amazon",
  });
  const and = (where as { AND: unknown[] }).AND;
  const serialized = and.map((f) => JSON.stringify(f));

  assert.ok(serialized.some((s) => s === JSON.stringify(categoryWhere)), "categoryWhere was swallowed");
  assert.ok(serialized.some((s) => s === JSON.stringify(amountWhere)), "amountWhere was swallowed");
  assert.ok(serialized.some((s) => s.includes("amazon")), "the merchant filter was swallowed");
  assert.ok(serialized.some((s) => s === JSON.stringify(bankingTransactionWhere(SPACE))), "the population was swallowed");
  // Every distinct fragment survives as its own conjunct.
  assert.equal(new Set(serialized).size, serialized.length, "two fragments collapsed into one");
});

// ── 4. The drilldown applies the population on EVERY path ───────────────────
test("PARITY-1: a category drill is bounded by the banking population too", () => {
  // Before the cutover, only the `includeNonSpending` arm applied the population.
  // A resolved category applied `{ category: X }` and nothing else, so an
  // INVESTMENT row filed under a banking category was citable by the model and
  // invisible everywhere else. Measured live at 0 rows — a structural hole, not
  // a leak, and the kind that stays 0 only until it doesn't.
  const canonical = JSON.stringify(bankingTransactionWhere(SPACE));
  const arms: Prisma.TransactionWhereInput[] = [
    { category: TransactionCategory.Shopping }, // resolved category
    { flowType: FlowType.SPENDING },            // the default arm
    {},                                         // includeNonSpending
  ];
  for (const categoryWhere of arms) {
    const and = (aiDrilldownWhere(SPACE, { start: WIN.start, end: WIN.end }, {
      categoryWhere, amountWhere: {}, merchantQuery: undefined,
    }) as { AND: unknown[] }).AND;
    assert.ok(
      and.some((f) => JSON.stringify(f) === canonical),
      `the ${JSON.stringify(categoryWhere)} path escaped the banking population`,
    );
  }
});

// ── 5. Ordering follows the basis ───────────────────────────────────────────
test("PARITY-1: both reads ORDER on economicDate", () => {
  // Load-bearing, not cosmetic: the KD-7 sentinel takes newest-first and drops
  // the OLDEST rows past the cap. Ordering on posting while windowing on economic
  // would truncate a different set than the window admits — silently deflating
  // the oldest months in exactly the corpus large enough to hit the cap.
  const src = readFileSync(path.join(process.cwd(), "lib/ai/assemblers/transactions.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  const orderBys = [...src.matchAll(/orderBy:\s*\{\s*([A-Za-z]+):/g)].map((m) => m[1]);
  assert.ok(orderBys.length >= 2, "expected the summary and drilldown orderBy clauses");
  assert.deepEqual(
    [...new Set(orderBys)], ["economicDate"],
    `a read orders on ${orderBys.filter((o) => o !== "economicDate").join(", ")} — rule B1 ` +
    `requires a flow read to filter, order, group and bucket on the same basis`,
  );
});

// ── 6. The half-fragment cannot come back ───────────────────────────────────
test("PARITY-1: the assembler consumes the whole read boundary, not half of it", () => {
  const src = readFileSync(path.join(process.cwd(), "lib/ai/assemblers/transactions.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  // BANKING_POPULATION without the Space gate and the event projection is what
  // the old boundary consumed. Importing it here again is the regression.
  assert.ok(
    !/\bBANKING_POPULATION\b/.test(src),
    "the bare BANKING_POPULATION fragment is back in the AI assembler. It is the " +
    "banking population WITHOUT the KD-15 gate or the event projection; consuming " +
    "that half is precisely how this file came to read a population no other " +
    "surface did. Use bankingTransactionWhere(spaceId).",
  );
  // …and the gate itself must not be hand-spelled a second time.
  assert.ok(
    !/spaceAccountLinks:\s*\{/.test(src),
    "the KD-15 visibility gate is spelled out in the AI assembler again. It is " +
    "stated once, in bankingTransactionWhere — two statements of one rule drift.",
  );
});
