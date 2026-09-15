/**
 * lib/platform/plaid/usage.test.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The Plaid usage read model reconciles to the Item-month authority and keeps
 * USAGE apart from COST:
 *   · the population census counts every row; billable excludes seeded fixtures;
 *   · cycle Item-months equal `priceCycleBothReadings` over the same inputs;
 *   · cost is the rate card's, ESTIMATED, and null before the rate's evidence;
 *   · with no rate authority, usage is reported and cost is not;
 *   · transition decoding drops malformed audit rows rather than guessing.
 */

import { buildPlaidUsage, decodeTransitions } from "./usage";
import { priceCycleBothReadings, monthCycle, type PlaidItemFact, type PlaidItemTransition } from "./item-months";
import { PLAID_RATES } from "@/lib/usage/pricing";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const items: PlaidItemFact[] = [
  { id: "i1", externalItemId: "real-1", createdAt: "2026-07-03", status: "ACTIVE", investmentsConsent: "GRANTED", environment: "production" },
  { id: "i2", externalItemId: "real-2", createdAt: "2026-08-20", status: "NEEDS_REAUTH", investmentsConsent: null, environment: "production" },
  { id: "i3", externalItemId: "real-3", createdAt: "2026-06-01", status: "REVOKED", investmentsConsent: null, environment: null },
  { id: "d1", externalItemId: "demo_item_1", createdAt: "2026-06-01", status: "ACTIVE", investmentsConsent: null, environment: "development" },
];
const transitions: PlaidItemTransition[] = [
  { plaidItemId: "i3", at: "2026-08-10T00:00:00.000Z", from: "ACTIVE", to: "REVOKED" },
];
const today = "2026-09-15";

console.log("population census");
{
  const r = buildPlaidUsage(items, transitions, today);
  check("total counts every row", r.population.total === 4);
  check("billable excludes the seeded fixture", r.population.billable === 3 && r.population.seeded === 1);
  check("by status", r.population.byStatus.ACTIVE === 2 && r.population.byStatus.NEEDS_REAUTH === 1 && r.population.byStatus.REVOKED === 1);
  check("by environment, null → unknown", r.population.byEnvironment.production === 2 && r.population.byEnvironment.unknown === 1);
  check("investments consented", r.population.investmentsConsented === 1);
  check("items with transitions", r.population.withTransitions === 1);
}

console.log("cycles reconcile to the authority");
{
  const r = buildPlaidUsage(items, transitions, today);
  check("two cycles: current then previous", r.cycles.length === 2 && r.cycles[0].label === "current" && r.cycles[1].label === "previous");
  check("current cycle is September", r.cycles[0].cycle.start === "2026-09-01" && r.cycles[0].cycle.end === "2026-09-30");
  check("previous cycle is August", r.cycles[1].cycle.start === "2026-08-01");
  const authority = priceCycleBothReadings(items, transitions, monthCycle("2026-09"), { today });
  check("current Item-months equal the authority (during)", r.cycles[0].during.itemMonths.transactions === authority.during.itemMonths.transactions
    && r.cycles[0].during.itemMonths.investments === authority.during.itemMonths.investments);
  check("current usd equals the authority", r.cycles[0].during.usd === authority.during.usd && r.cycles[0].atEnd.usd === authority.atEnd.usd);
  check("agree flag carried", r.cycles[0].agree === authority.agree);
  const aug = priceCycleBothReadings(items, transitions, monthCycle("2026-08"), { today });
  check("the revoked item is retired from the transition, not the status: August still counts it during the cycle",
    aug.during.itemMonths.transactions === r.cycles[1].during.itemMonths.transactions);
  check("cost is labelled ESTIMATED with rate provenance", r.priceAuthority.tier === "ESTIMATED" && r.priceAuthority.configured && r.priceAuthority.rates.length === PLAID_RATES.length);
  check("rates carry product, price, effective date and source",
    r.priceAuthority.rates.every((x) => typeof x.usdPerItemMonth === "number" && x.effectiveFrom.length === 10 && x.source.length > 0));
  check("no daily allocation", r.limits.dailyAllocation === false);
}

console.log("no price authority");
{
  const r = buildPlaidUsage(items, transitions, today, []);
  check("usage still reported", r.cycles[0].during.itemMonths.transactions > 0);
  check("cost is null, never zero", r.cycles[0].during.usd === null && r.cycles[1].atEnd.usd === null);
  check("authority not configured", r.priceAuthority.configured === false);
}

console.log("cycle before the rate's evidence");
{
  const r = buildPlaidUsage(items, transitions, "2026-06-15");
  check("June (before 2026-07-01) is unpriced", r.cycles[0].during.usd === null && r.cycles[0].during.unpricedItemMonths > 0);
}

console.log("decodeTransitions");
{
  const at = new Date("2026-08-10T00:00:00.000Z");
  const decoded = decodeTransitions([
    { createdAt: at, metadata: { plaidItemId: "i3", from: "ACTIVE", to: "REVOKED", provider: "PLAID" } },
    { createdAt: at, metadata: { plaidItemId: "i9", to: "REVOKED" } },
    { createdAt: at, metadata: null },
    { createdAt: at, metadata: { plaidItemId: 42, from: "A", to: "B" } },
  ]);
  check("well-formed rows decode; malformed rows are dropped, not guessed", decoded.length === 1 && decoded[0].plaidItemId === "i3" && decoded[0].to === "REVOKED");
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
