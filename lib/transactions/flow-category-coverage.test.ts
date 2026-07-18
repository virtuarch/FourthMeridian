/**
 * lib/transactions/flow-category-coverage.test.ts
 *
 * CCPAY-2E — the classifier must KNOW every category the schema can store.
 *
 * flow-classifier.ts declares its category sets under a header claiming they
 * "mirror prisma/schema.prisma TransactionCategory". Nothing enforced that, and
 * they drifted by six values: the MI1 M1 spend vocabulary (Medical, Entertainment,
 * Transport, PersonalCare, Services, Education) was absent from SPEND_CATEGORIES,
 * so each classified UNKNOWN at 0.2.
 *
 * Why that is a silent disappearance rather than a degradation — UNKNOWN is not
 * "spend we're unsure about", it is outside the economic model entirely:
 *   isSpendLedgerFlow(UNKNOWN)     = false → gone from the spend ledger
 *   isCostFlow(UNKNOWN)            = false → gone from expenseTotal
 *   isNonEconomicResidue(UNKNOWN)  = true  → `continue` in the AI assembler
 * So a category the schema can store but the classifier does not know deletes its
 * rows from every number a user or the assistant sees. The six exist precisely to
 * RESCUE spend from `Other` (prisma/schema.prisma) — the drift would have
 * inverted their purpose on the day MI M2 began writing them.
 *
 * This is the tripwire, not the fix: it pins the mirror against the REAL Prisma
 * enum, so adding a category to the schema without teaching the classifier fails
 * the build here. lib/data/transactions.ts:96-99 retired the same
 * hand-listed-allow-list defect once already; this stops the classifier's copy of
 * it from coming back.
 *
 * NOTE — unlike flow-classifier.test.ts, this suite imports the RUNTIME Prisma
 * enum and therefore needs `prisma generate`. That is the whole point: the
 * classifier stays Prisma-free, and the coverage contract lives out here, where
 * it can read the real schema instead of a hand-copied list. Same pattern the AI
 * assembler already uses (lib/ai/assemblers/transactions.ts:94).
 *
 *     npx tsx lib/transactions/flow-category-coverage.test.ts
 */

import { TransactionCategory } from "@prisma/client";
import { classifyFlow } from "./flow-classifier";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const ALL_CATEGORIES = Object.values(TransactionCategory) as string[];

check("the enum is readable at runtime (guards against an empty sweep passing vacuously)",
  ALL_CATEGORIES.length >= 16, `got ${ALL_CATEGORIES.length}`);

// ── The contract: no schema category may classify UNKNOWN ────────────────────
// UNKNOWN is reserved for a category string the schema CANNOT produce (a corrupt
// or hand-written value). Any real enum value reaching it is a coverage gap.
//
// SR-1 EXCEPTION — `Other` is the deliberate exception, and ONLY on the INFLOW
// side. `Other` is the "provider told us nothing" sentinel, not a real spend
// category: a POSITIVE Other is an unclassified inflow whose honest answer IS
// UNKNOWN (never a manufactured REFUND). Its OUTFLOW side is still SPENDING (a
// cost with no finer label), so it remains covered there. Every OTHER category
// must still be known on both signs — a genuine spend category reaching UNKNOWN
// would silently delete its rows from every economic surface.
const OTHER_SENTINEL = "Other";
for (const category of ALL_CATEGORIES) {
  for (const [label, amount] of [["outflow", -50], ["inflow", 50]] as const) {
    if (category === OTHER_SENTINEL && label === "inflow") continue; // SR-1: asserted separately below
    const c = classifyFlow({ category, amount });
    check(
      `${category} (${label}) is known to the classifier`,
      c.flowType !== "UNKNOWN",
      `classified UNKNOWN/${c.confidence} — add it to the right set in flow-classifier.ts; ` +
      `UNKNOWN removes the row from the spend ledger, expenseTotal, and AI context`,
    );
  }
}

// SR-1 — the `Other` inflow exception, pinned explicitly so it stays intentional.
{
  const otherInflow  = classifyFlow({ category: OTHER_SENTINEL, amount: 50 });
  const otherOutflow = classifyFlow({ category: OTHER_SENTINEL, amount: -50 });
  check("SR-1: Other inflow is UNKNOWN (absence of info, not a fabricated REFUND)",
    otherInflow.flowType === "UNKNOWN" && otherInflow.flowDirection === "INFLOW",
    `got ${otherInflow.flowType}/${otherInflow.flowDirection}`);
  check("SR-1: Other outflow is still SPENDING (a cost with no finer label)",
    otherOutflow.flowType === "SPENDING", `got ${otherOutflow.flowType}`);
}

// Zero-amount rows are a separate, legitimate ADJUSTMENT/UNKNOWN case (a
// non-economic artifact), deliberately NOT covered by the contract above.

// ── The six MI1 M1 values specifically — the drift CCPAY-2E closed ───────────
// Pinned by name so a future edit cannot quietly drop them back out.
for (const category of ["Medical", "Entertainment", "Transport", "PersonalCare", "Services", "Education"]) {
  check(`${category} is in the enum (else this fixture is stale)`, ALL_CATEGORIES.includes(category));
  const out = classifyFlow({ category, amount: -50 });
  const inn = classifyFlow({ category, amount: 50 });
  check(`${category} outflow → SPENDING (was UNKNOWN before CCPAY-2E)`,
    out.flowType === "SPENDING" && out.flowDirection === "OUTFLOW", `got ${out.flowType}/${out.flowDirection}`);
  check(`${category} inflow → REFUND, consistent with every other spend category`,
    inn.flowType === "REFUND" && inn.flowDirection === "INFLOW", `got ${inn.flowType}/${inn.flowDirection}`);
}

// ── The flow-structural values must NOT have been swept into spend ───────────
// A coverage fix that "resolved" the gap by making everything spend would pass
// the contract above while destroying the taxonomy. Pin the structural ones.
for (const [category, want] of [
  ["Income", "INCOME"], ["Transfer", "TRANSFER"], ["Payment", "DEBT_PAYMENT"], ["Fee", "FEE"],
  ["Buy", "INVESTMENT"], ["Sell", "INVESTMENT"], ["Split", "INVESTMENT"], ["Dividend", "INCOME"],
] as const) {
  check(`${category} is still ${want}, not swept into the spend set`,
    classifyFlow({ category, amount: -50 }).flowType === want || classifyFlow({ category, amount: 50 }).flowType === want,
    `got ${classifyFlow({ category, amount: -50 }).flowType}/${classifyFlow({ category, amount: 50 }).flowType}`);
}

// ── Report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`flow-category-coverage: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`flow-category-coverage: all ${passed} checks passed ✓`);
console.log(`  · ${ALL_CATEGORIES.length} schema categories, every one known to the classifier`);
process.exit(0);
