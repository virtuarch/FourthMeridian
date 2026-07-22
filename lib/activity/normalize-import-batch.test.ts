/**
 * lib/activity/normalize-import-batch.test.ts
 *
 * Unit gate for normalizeImportBatchEvent (Activity Tab event feed, §7):
 *   - COMPLETED-only filter (PENDING/PROCESSING/FAILED/ROLLED_BACK → null)
 *   - kind-based title branch (TRANSACTIONS vs INVESTMENT_HISTORY)
 *   - zero-count clauses omitted (never "0 skipped" / "0 matched")
 *   - id namespacing (`importbatch:<id>`)
 *   - date from completedAt, never createdAt
 *
 * House pattern: standalone tsx script, inline `check()` assertions, exit 0/1.
 */

import { normalizeImportBatchEvent, type ImportBatchRow } from "./normalize-import-batch";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const COMPLETED_AT = new Date("2026-07-10T14:30:00.000Z");

function base(overrides: Partial<ImportBatchRow> = {}): ImportBatchRow {
  return {
    id:            "batch-1",
    kind:          "TRANSACTIONS",
    status:        "COMPLETED",
    importedCount: 12,
    skippedCount:  0,
    matchedCount:  0,
    completedAt:   COMPLETED_AT,
    ...overrides,
  };
}

// ── COMPLETED-only filter ─────────────────────────────────────────────────────
for (const status of ["PENDING", "PROCESSING", "FAILED", "ROLLED_BACK", "COMPLETED_WITH_ERRORS"]) {
  check(`status ${status} → null`, normalizeImportBatchEvent(base({ status })) === null);
}
check("status COMPLETED → event", normalizeImportBatchEvent(base()) !== null);
// completedAt guard: even a COMPLETED row with no completedAt yields null (never a null-dated event)
check("COMPLETED but completedAt null → null", normalizeImportBatchEvent(base({ completedAt: null })) === null);

// ── kind-based title branch ───────────────────────────────────────────────────
check(
  "TRANSACTIONS → 'Transactions imported'",
  normalizeImportBatchEvent(base({ kind: "TRANSACTIONS" }))?.title === "Transactions imported",
);
check(
  "INVESTMENT_HISTORY → 'Investment history imported'",
  normalizeImportBatchEvent(base({ kind: "INVESTMENT_HISTORY" }))?.title === "Investment history imported",
);

// ── zero-count clauses omitted ────────────────────────────────────────────────
{
  const sub = normalizeImportBatchEvent(base({ importedCount: 5, skippedCount: 0, matchedCount: 0 }))?.subtitle ?? "";
  check("no zero clauses: '5 imported'", sub === "5 imported", `got "${sub}"`);
  check("no '0 skipped' substring", !sub.includes("skipped"));
  check("no '0 matched' substring", !sub.includes("matched"));
}
{
  const sub = normalizeImportBatchEvent(base({ importedCount: 324, skippedCount: 1, matchedCount: 0 }))?.subtitle ?? "";
  check("skipped>0 shown, matched=0 hidden", sub === "324 imported, 1 skipped", `got "${sub}"`);
}
{
  const sub = normalizeImportBatchEvent(base({ importedCount: 10, skippedCount: 2, matchedCount: 3 }))?.subtitle ?? "";
  check("all three shown when >0", sub === "10 imported, 2 skipped, 3 matched", `got "${sub}"`);
}
{
  const sub = normalizeImportBatchEvent(base({ importedCount: 8, skippedCount: 0, matchedCount: 4 }))?.subtitle ?? "";
  check("matched>0 shown, skipped=0 hidden", sub === "8 imported, 4 matched", `got "${sub}"`);
}

// ── id namespacing ────────────────────────────────────────────────────────────
check(
  "id namespaced as importbatch:<id>",
  normalizeImportBatchEvent(base({ id: "abc123" }))?.id === "importbatch:abc123",
);

// ── date from completedAt, never createdAt ────────────────────────────────────
check(
  "date is completedAt.toISOString()",
  normalizeImportBatchEvent(base())?.date === COMPLETED_AT.toISOString(),
);

// ── category / contract sanity ────────────────────────────────────────────────
check("category is connection", normalizeImportBatchEvent(base())?.category === "connection");

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nnormalize-import-batch: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`normalize-import-batch: all ${passed} checks passed.`);
process.exit(0);
