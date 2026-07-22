/**
 * components/space/widgets/investments/investments-activity.test.ts
 *
 * Pure tests for the Period Activity presentation model. Deterministic, DB-free
 * (house pattern):
 *
 *   npx tsx components/space/widgets/investments/investments-activity.test.ts
 *
 * Locks:
 *   1. null flows ⇒ no-comparison state (honest, no fabricated window).
 *   2. zero events ⇒ no-events state carrying flows.reason.
 *   3. Grouping per §2: money in = contribution + transfer_in; money out =
 *      withdrawal + transfer_out; fees / buys / sells / income are INSIDE, never
 *      money-out (agrees with the Bridge's external = the four).
 *   4. The caveat sentence surfaces every one of the four counters + FX-estimated.
 */

import type { PeriodFlows, FlowCategorySummary } from "@/lib/investments/investment-flows-core";
import { buildActivityGroups } from "./investments-activity";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function flows(over: Partial<PeriodFlows> & { byCategory: FlowCategorySummary[]; eventCount: number }): PeriodFlows {
  return {
    from: "2026-01-01", to: "2026-02-01", reportingCurrency: "USD",
    contributions: 0, withdrawals: 0, transfersIn: 0, transfersOut: 0,
    buys: 0, sells: 0, income: 0, fees: 0, netExternalFlows: 0,
    inKindTransferCount: 0, unclassifiedCount: 0, externalAmountMissingCount: 0, fxEstimated: false,
    completeness: "observed", reason: "",
    ...over,
  };
}

console.log("1. null flows ⇒ no-comparison");
{
  const m = buildActivityGroups(null);
  check("state is no-comparison", m.state === "no-comparison");
  check("no groups", m.groups.length === 0);
  check("message present", !!m.message && m.message.length > 0);
}

console.log("2. zero events ⇒ no-events carrying flows.reason");
{
  const m = buildActivityGroups(flows({ byCategory: [], eventCount: 0, reason: "No investment events between 2026-01-01 and 2026-02-01." }));
  check("state is no-events", m.state === "no-events");
  check("message = flows.reason", m.message === "No investment events between 2026-01-01 and 2026-02-01.");
  check("no groups", m.groups.length === 0);
}

console.log("3. Grouping per §2 (fees inside, external = the four)");
{
  const m = buildActivityGroups(flows({
    eventCount: 8,
    contributions: 5000, transfersIn: 1000, withdrawals: -800, transfersOut: -200,
    buys: -3000, sells: 500, income: 120, fees: -15,
    netExternalFlows: 5000, // informational; not read by the model
    byCategory: [
      { category: "contribution", count: 2, amount: 5000 },
      { category: "transfer_in", count: 1, amount: 1000 },
      { category: "withdrawal", count: 1, amount: -800 },
      { category: "transfer_out", count: 1, amount: -200 },
      { category: "buy", count: 1, amount: -3000 },
      { category: "sell", count: 1, amount: 500 },
      { category: "income", count: 1, amount: 120 },
      { category: "fee", count: 1, amount: -15 },
    ],
    reason: "8 events in the period.",
  }));
  const byKey = Object.fromEntries(m.groups.map((g) => [g.key, g]));
  check("state is events", m.state === "events");
  check("money_in amount = contributions + transfersIn (6000)", byKey.money_in?.amount === 6000);
  check("money_out amount = withdrawals + transfersOut (-1000)", byKey.money_out?.amount === -1000);
  check("inside group present with null amount", byKey.inside != null && byKey.inside.amount === null);
  check("money_in sentence counts contributions + transfers in", /2 contributions/.test(byKey.money_in.sentence) && /1 transfer in/.test(byKey.money_in.sentence));
  check("inside sentence mentions fees (fees are INSIDE, not money-out)", /fees/.test(byKey.inside.sentence));
  check("money_out sentence never mentions fees", !/fee/.test(byKey.money_out.sentence));
  check("inside sentence mentions income + buys + sells", /income/.test(byKey.inside.sentence) && /buy/.test(byKey.inside.sentence) && /sell/.test(byKey.inside.sentence));
  check("exactly three groups", m.groups.length === 3);
}

console.log("4. Caveat surfaces every counter + FX-estimated");
{
  const m = buildActivityGroups(flows({
    eventCount: 5,
    contributions: 100, byCategory: [{ category: "contribution", count: 1, amount: 100 }],
    inKindTransferCount: 1, externalAmountMissingCount: 2, unclassifiedCount: 3, fxEstimated: true,
    reason: "5 events in the period.",
  }));
  check("caveat present", !!m.caveat, m.caveat ?? "(null)");
  check("mentions in-kind transfer", /in-kind transfer/.test(m.caveat ?? ""));
  check("mentions external movement with no amount", /external movement/.test(m.caveat ?? "") && /had no amount/.test(m.caveat ?? ""));
  check("mentions uncategorised events", /could not be categorised/.test(m.caveat ?? ""));
  check("mentions estimated FX rate", /estimated rate/.test(m.caveat ?? ""));
  const clean = buildActivityGroups(flows({ eventCount: 1, contributions: 10, byCategory: [{ category: "contribution", count: 1, amount: 10 }], reason: "1 event in the period." }));
  check("clean flows ⇒ null caveat", clean.caveat === null);
}

if (failures > 0) { console.error(`\n${failures} investments-activity check(s) failed`); process.exit(1); }
console.log("\nAll investments-activity checks passed");
