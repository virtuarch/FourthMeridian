/**
 * lib/connections/intelligence.test.ts  (CONN-2A / CONN-2E / CONN-2G)
 *
 * Pure tests for the connection intelligence projection. Standalone `tsx`:
 *     npx tsx lib/connections/intelligence.test.ts
 *
 * Proves the CONN-2 invariants:
 *   - incomplete intelligence can NEVER claim ready (CONN-2G)
 *   - the RECONSTRUCTING window (transactions done, no anchor) is distinct from READY
 *   - intelligence derives ONLY from state + PLAID_HISTORY_SYNCED anchor (no fake completion)
 *   - available history is null (not "0 months") when there are no transactions
 */

import {
  deriveConnectionIntelligence,
  deriveConnectionTimeline,
  computeAvailableHistory,
  isBuildingIntelligence,
  type IntelligenceInput,
} from "./intelligence";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const NOW = new Date("2026-07-19T00:00:00.000Z");
const TWO_YEARS_AGO = new Date("2024-07-19T00:00:00.000Z");
const ANCHOR = new Date("2026-07-19T00:00:00.000Z");

function derive(p: Partial<IntelligenceInput>) {
  return deriveConnectionIntelligence(
    {
      provider:        p.provider ?? "PLAID",
      state:           p.state ?? "ready",
      historySyncedAt: p.historySyncedAt ?? null,
      earliestTxDate:  p.earliestTxDate ?? null,
      connectedAt:     p.connectedAt ?? null,
      lastSyncedAt:    p.lastSyncedAt ?? null,
    },
    NOW,
  );
}

console.log("CONN-2G — incomplete intelligence can never claim ready");
{
  // Transactions done (state ready) but NO PLAID_HISTORY_SYNCED anchor = REBUILDING.
  const rebuilding = derive({ provider: "PLAID", state: "ready", historySyncedAt: null });
  check("Plaid ready + no anchor → intelligence REBUILDING", rebuilding.intelligence === "REBUILDING");
  check("REBUILDING → phase BUILDING_INTELLIGENCE", rebuilding.phase === "BUILDING_INTELLIGENCE");
  check("REBUILDING → intelligenceReady is FALSE", rebuilding.intelligenceReady === false);
  check("REBUILDING → transactionHistory still READY", rebuilding.transactionHistory === "READY");
}

console.log("READY only with the anchor present");
{
  const ready = derive({ provider: "PLAID", state: "ready", historySyncedAt: ANCHOR });
  check("Plaid ready + anchor → intelligence READY", ready.intelligence === "READY");
  check("anchor → phase READY", ready.phase === "READY");
  check("anchor → intelligenceReady TRUE", ready.intelligenceReady === true);
  check("anchor surfaced as lastReconstructedAt", ready.lastReconstructedAt === ANCHOR.toISOString());
}

console.log("Importing — nothing is ready yet");
{
  const importing = derive({ provider: "PLAID", state: "importing" });
  check("importing → transactionHistory IMPORTING", importing.transactionHistory === "IMPORTING");
  check("importing → intelligence NOT_READY", importing.intelligence === "NOT_READY");
  check("importing → phase IMPORTING", importing.phase === "IMPORTING");
  check("importing → intelligenceReady FALSE", importing.intelligenceReady === false);
}

console.log("Action required — needs_reauth / error");
{
  for (const state of ["needs_reauth", "error"] as const) {
    const s = derive({ provider: "PLAID", state });
    check(`${state} → transactionHistory UNKNOWN`, s.transactionHistory === "UNKNOWN");
    check(`${state} → phase ACTION_REQUIRED`, s.phase === "ACTION_REQUIRED");
    check(`${state} → intelligenceReady FALSE`, s.intelligenceReady === false);
  }
}

console.log("Wallet — reconstruction runs inline; ready ⟺ intelligence READY");
{
  const wReady = derive({ provider: "WALLET", state: "ready" });
  check("wallet ready → intelligence READY (no anchor needed)", wReady.intelligence === "READY");
  check("wallet ready → phase READY", wReady.phase === "READY");
  const wImporting = derive({ provider: "WALLET", state: "importing" });
  check("wallet importing → intelligence NOT_READY", wImporting.intelligence === "NOT_READY");
}

console.log("Available history — null when no transactions (never '0 months')");
{
  const none = derive({ state: "ready", historySyncedAt: ANCHOR, earliestTxDate: null });
  check("no tx → availableHistory is null", none.availableHistory === null);
  check("no tx → earliestTransactionDate null", none.earliestTransactionDate === null);

  const twoYears = derive({ state: "ready", historySyncedAt: ANCHOR, earliestTxDate: TWO_YEARS_AGO });
  check("2y of tx → years === 2", twoYears.availableHistory?.years === 2);
  check("2y of tx → remainderMonths === 0", twoYears.availableHistory?.remainderMonths === 0);
}

console.log("computeAvailableHistory — 1 year 8 months form");
{
  const earliest = new Date("2024-11-19T00:00:00.000Z"); // ~20 months before NOW
  const h = computeAvailableHistory(earliest, NOW);
  check("~20 months → years 1", h?.years === 1);
  check("~20 months → remainderMonths 8", h?.remainderMonths === 8);
  check("~20 months → total months 20", h?.months === 20);
  check("null earliest → null", computeAvailableHistory(null, NOW) === null);
}

console.log("isBuildingIntelligence — importing OR reconstructing keeps polling");
{
  const rebuilding = derive({ provider: "PLAID", state: "ready", historySyncedAt: null });
  const importing = derive({ provider: "PLAID", state: "importing" });
  const ready = derive({ provider: "PLAID", state: "ready", historySyncedAt: ANCHOR });
  check("all ready → not building", isBuildingIntelligence([ready]) === false);
  check("one reconstructing → building", isBuildingIntelligence([ready, rebuilding]) === true);
  check("one importing → building", isBuildingIntelligence([ready, importing]) === true);
}

console.log("CONN-2D timeline — provider-neutral projection, no fabricated timestamps");
{
  const connected = new Date("2026-07-01T00:00:00.000Z");
  const synced = new Date("2026-07-19T00:00:00.000Z");
  const ready = derive({
    provider: "PLAID", state: "ready", historySyncedAt: ANCHOR,
    earliestTxDate: TWO_YEARS_AGO, connectedAt: connected, lastSyncedAt: synced,
  });
  const tl = deriveConnectionTimeline(ready);
  check("authorization carries the real connectedAt", tl.authorization.connectedAt === connected.toISOString());
  check("acquisition: transactions available at ready", tl.acquisition.transactionsAvailable === true);
  check("intelligence: profile built when READY", tl.intelligence.profileBuilt === true);
  check("intelligence: wealth timeline built", tl.intelligence.wealthTimeline === true);
  check("intelligence: cash flow available (derived from tx)", tl.intelligence.cashFlow === true);
  check("intelligence: lastBuiltAt = anchor", tl.intelligence.lastBuiltAt === ANCHOR.toISOString());
  check("freshness: lastUpdatedAt = lastSyncedAt", tl.freshness.lastUpdatedAt === synced.toISOString());

  // Building phase: acquisition done, but profile NOT built, no fabricated build time.
  const building = derive({ provider: "PLAID", state: "ready", historySyncedAt: null, connectedAt: connected });
  const btl = deriveConnectionTimeline(building);
  check("building: transactions available but profile NOT built", btl.acquisition.transactionsAvailable === true && btl.intelligence.profileBuilt === false);
  check("building: cash flow available (tx exist)", btl.intelligence.cashFlow === true);
  check("building: lastBuiltAt is null (not fabricated)", btl.intelligence.lastBuiltAt === null);

  // No connectedAt → null, never fabricated.
  const noDates = derive({ provider: "PLAID", state: "importing" });
  const ntl = deriveConnectionTimeline(noDates);
  check("no connectedAt → authorization.connectedAt null", ntl.authorization.connectedAt === null);
  check("importing: transactions NOT available", ntl.acquisition.transactionsAvailable === false);
  check("importing: freshness null (never fabricated)", ntl.freshness.lastUpdatedAt === null);
}

if (failures > 0) { console.error(`\nintelligence: ${failures} failure(s).`); process.exit(1); }
console.log("\nintelligence: all passed.");
