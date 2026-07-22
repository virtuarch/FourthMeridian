/**
 * app/api/ai/chat/needs-classification-line.ti2.test.ts
 *
 * TI2-W2 — pins the exact wording of the chat serializer's needs-classification
 * disclosure line (KD-17/KD-18 wording-pinned precedent: a regression to vaguer
 * phrasing must fail here). DISCLOSURE-ONLY framing is load-bearing — the line
 * must tell the model the amounts are already included and must not be subtracted.
 *
 * Inline assertions, exit 0/1 (house pattern).
 */

import { needsClassificationSummaryLine } from "@/lib/ai/prompts/context-serializer";

type NC = NonNullable<Parameters<typeof needsClassificationSummaryLine>[0]>;

const base: NC = {
  count: 0, unknownInflowCount: 0, unknownInflowTotal: 0,
  unknownPaymentAppCount: 0, unknownPaymentAppTotal: 0,
  counterpartyResolution: "PERSISTED_AND_READ_TIME",
};

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// Nothing to classify → null (no line emitted).
check("count 0 → null", needsClassificationSummaryLine(base) === null);
check("undefined → null", needsClassificationSummaryLine(undefined) === null);

// Both clusters present → both clauses, exact money formatting, disclosure framing.
{
  const line = needsClassificationSummaryLine({
    ...base, count: 3, unknownInflowCount: 2, unknownInflowTotal: 1200.5,
    unknownPaymentAppCount: 1, unknownPaymentAppTotal: 412,
  });
  check("both clusters pinned exactly",
    line === "  NEEDS CLASSIFICATION: 3 transactions need classification " +
      "($1,200.50 of income has no identified source; $412.00 moved via payment apps, purpose unknown). " +
      "These amounts are already included in the totals above — do not subtract them; only their " +
      "source/purpose is unresolved, so do not present any income figure that depends on them as fully verified.",
    line ?? "null");
}

// Singular + single cluster (inflow only).
{
  const line = needsClassificationSummaryLine({
    ...base, count: 1, unknownInflowCount: 1, unknownInflowTotal: 200,
  });
  check("singular, inflow-only clause",
    !!line && line.startsWith("  NEEDS CLASSIFICATION: 1 transaction need classification ($200.00 of income has no identified source)."),
    line ?? "null");
  check("inflow-only omits payment-app clause", !!line && !line.includes("payment apps"));
}

// Payment-app only cluster.
{
  const line = needsClassificationSummaryLine({
    ...base, count: 2, unknownPaymentAppCount: 2, unknownPaymentAppTotal: 75.25,
  });
  check("payment-app-only clause",
    !!line && line.includes("($75.25 moved via payment apps, purpose unknown)") && !line.includes("has no identified source"),
    line ?? "null");
}

if (failures.length > 0) {
  console.error(`\nTI2-W2 chat line: ${failures.length} FAILURE(S) (${passed} passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`TI2-W2 chat line: all ${passed} checks passed.`);
process.exit(0);
