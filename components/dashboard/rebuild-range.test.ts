/**
 * components/dashboard/rebuild-range.test.ts
 *
 * REG-3 / REG-4 — pure tests for the wealth-history rebuild range logic. No React,
 * no DB. Standalone tsx script:  npx tsx components/dashboard/rebuild-range.test.ts
 */

import { resolveRebuildRange } from "./rebuild-range";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

// ── REG-3 — the "From" MINIMUM is SPACE-WIDE (min across accounts), not per-account.
console.log("REG-3 — space-wide earliest floor (one range authority)");
{
  const r = resolveRebuildRange(
    [{ earliestTxDate: "2024-03-15" }, { earliestTxDate: "2023-01-02" }, { earliestTxDate: null }],
    "2026-06-15",
  );
  check("earliest (picker minimum) = MIN across accounts (2023-01-02)", r.earliest === "2023-01-02");
  check("minimum is NOT the first/selected account's date", r.earliest !== "2024-03-15");
  check("historyPending false when any account has synced tx", r.historyPending === false);
}

// ── Default = a practical To−30d window (windowFrom), NOT the full-history earliest.
console.log("default From = practical 30-day window (not full-history earliest)");
{
  // Deep history (2023) but windowFrom (2026-06-15) is far later → default = window.
  const r = resolveRebuildRange([{ earliestTxDate: "2023-01-02" }], "2026-06-15");
  check("default From = the 30-day window (2026-06-15), not the 2023 earliest", r.defaultFrom === "2026-06-15");
  check("earliest still exposed as the picker minimum (full history reachable)", r.earliest === "2023-01-02");
  check("default is later than the minimum (opens on a recent window)", r.defaultFrom > r.earliest!);
}

// ── Clamp — a shallow-history account never defaults BEFORE its own earliest.
console.log("clamp — shallow history defaults up to its own earliest");
{
  // Account's earliest (2026-07-01) is MORE RECENT than windowFrom (2026-06-15).
  const r = resolveRebuildRange([{ earliestTxDate: "2026-07-01" }], "2026-06-15");
  check("default clamps up to earliest (2026-07-01), never before the data", r.defaultFrom === "2026-07-01");
  check("default never predates the picker minimum", r.defaultFrom >= (r.earliest ?? ""));
}

// ── REG-4 — nothing synced yet → historyPending, fall back to the window honestly.
console.log("REG-4 — sync awareness when no history is synced yet");
{
  const r = resolveRebuildRange([{ earliestTxDate: null }, { earliestTxDate: undefined }], "2026-06-15");
  check("earliest is null when nothing synced", r.earliest === null);
  check("default From = the 30-day window when nothing synced", r.defaultFrom === "2026-06-15");
  check("historyPending true when nothing synced (surface 'still importing')", r.historyPending === true);
}

// ── Edge — empty account list.
console.log("edge — empty account list");
{
  const r = resolveRebuildRange([], "2026-06-15");
  check("empty → earliest null, window default, historyPending", r.earliest === null && r.defaultFrom === "2026-06-15" && r.historyPending === true);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll rebuild-range checks passed");
