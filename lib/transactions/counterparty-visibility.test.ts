/**
 * lib/transactions/counterparty-visibility.test.ts
 *
 * KD-15 gate for the Cash Flow liquidity axis' counterpartyAccountId. Pure —
 * runnable with tsx. Proves the id is exposed ONLY when the counterparty account
 * is visible to the reading Space, and withheld (null) otherwise, so no
 * cross-Space account leakage can occur.
 */

import { gatedCounterpartyId, type CounterpartyVisibilityRow } from "@/lib/transactions/counterparty-visibility";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const visibleLinks = [{ id: "sal_1" }];   // ACTIVE + FULL link to this space (pre-filtered by the query)
const noLinks: { id: string }[] = [];

// Visible counterparty → id exposed (Feb 27 Coinbase→Chase: both accounts shared).
check("visible counterparty → id exposed",
  gatedCounterpartyId({
    counterpartyAccountId: "fa_coinbase",
    counterpartyAccount: { deletedAt: null, spaceAccountLinks: visibleLinks },
  }) === "fa_coinbase");

// Not shared to this space (no visible link) → withheld.
check("counterparty not shared to space → null (no leak)",
  gatedCounterpartyId({
    counterpartyAccountId: "fa_hidden",
    counterpartyAccount: { deletedAt: null, spaceAccountLinks: noLinks },
  }) === null);

// Deleted counterparty account → withheld.
check("deleted counterparty account → null",
  gatedCounterpartyId({
    counterpartyAccountId: "fa_del",
    counterpartyAccount: { deletedAt: new Date("2026-01-01"), spaceAccountLinks: visibleLinks },
  }) === null);

// No counterparty id at all → null.
check("no counterparty id → null",
  gatedCounterpartyId({ counterpartyAccountId: null, counterpartyAccount: null }) === null);

// Counterparty relation not loaded (defensive) → null.
check("counterparty relation absent → null (fails closed)",
  gatedCounterpartyId({ counterpartyAccountId: "fa_x" } as CounterpartyVisibilityRow) === null);

// The id is only ever the real id or null — never a different account's id.
check("gate returns exactly the input id or null",
  gatedCounterpartyId({
    counterpartyAccountId: "fa_real",
    counterpartyAccount: { deletedAt: null, spaceAccountLinks: visibleLinks },
  }) === "fa_real");

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${failures} failed (${passes + failures} checks).`);
if (failures > 0) { console.log("Counterparty-visibility gate tests FAILED."); process.exit(1); }
console.log("Counterparty-visibility gate tests passed.");
process.exit(0);
