/**
 * lib/export/select.test.ts  (OPS-2 S6)
 *
 * Pure guards for the export selection helpers. Standalone tsx script:
 *
 *     npx tsx lib/export/select.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import {
  EXPORT_TRANSACTION_CAP,
  capTransactions,
  dedupById,
  filterVisibleContributions,
  isFullVisibility,
} from "@/lib/export/select";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("export/select");

// ── isFullVisibility ──────────────────────────────────────────────────────────
check("FULL is full visibility", isFullVisibility("FULL"));
check("BALANCE_ONLY is NOT full", !isFullVisibility("BALANCE_ONLY"));
check("SUMMARY_ONLY is NOT full", !isFullVisibility("SUMMARY_ONLY"));
check("PRIVATE is NOT full", !isFullVisibility("PRIVATE"));
check("SHARED (legacy) is NOT full", !isFullVisibility("SHARED"));

// ── dedupById ─────────────────────────────────────────────────────────────────
const deduped = dedupById([{ id: "a" }, { id: "b" }, { id: "a" }, { id: "c" }]);
check("dedupById keeps first occurrences only", deduped.length === 3 && deduped.map((r) => r.id).join(",") === "a,b,c");

// ── capTransactions ───────────────────────────────────────────────────────────
const under = capTransactions([
  { date: "2026-01-01" }, { date: "2026-03-01" }, { date: "2026-02-01" },
]);
check("under cap → not truncated", under.truncated === false && under.rows.length === 3);
check("sorts newest-first", under.rows.map((r) => r.date).join(",") === "2026-03-01,2026-02-01,2026-01-01");

const many = Array.from({ length: EXPORT_TRANSACTION_CAP + 5 }, (_, i) => ({
  date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
  n: i,
}));
const capped = capTransactions(many);
check("over cap → truncated flag set", capped.truncated === true);
check("over cap → exactly the cap kept", capped.rows.length === EXPORT_TRANSACTION_CAP);

// ── filterVisibleContributions (D4) ───────────────────────────────────────────
const contributions = [
  { financialAccountId: "visible-1" },
  { financialAccountId: "hidden-1" },
  { financialAccountId: "visible-2" },
];
const kept = filterVisibleContributions(contributions, new Set(["visible-1", "visible-2"]));
check(
  "drops contributions tied to non-FULL-visible accounts",
  kept.length === 2 && kept.every((c) => c.financialAccountId.startsWith("visible")),
);

console.log(failures === 0 ? "\nAll export/select checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
