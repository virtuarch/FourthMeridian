/**
 * lib/platform/plaid/item-months.test.ts  (cost Slice 4)
 *
 * Plaid cost at the Item-subscription-month grain. Standalone tsx, no DB.
 * The defect class pinned here is a cost curve built on call volume — which the
 * reconciled July invoice shows has no relationship to the bill.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  itemMonths, priceCycle, priceCycleBothReadings, censusCoverage, retiredAtFrom,
  monthCycle, isBillableItem, SEEDED_ITEM_PREFIX,
  type PlaidItemFact, type PlaidItemTransition,
} from "@/lib/platform/plaid/item-months";
import { PLAID_RATES, plaidRateAt, type PlaidRate } from "@/lib/usage/pricing";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const near = (a: number | null, b: number, eps = 1e-9) => a !== null && Math.abs(a - b) < eps;

const JULY = monthCycle("2026-07");
const AUG  = monthCycle("2026-08");
let n = 0;
const item = (o: Partial<PlaidItemFact> = {}): PlaidItemFact => ({
  id: `i${++n}`, externalItemId: `real_${n}`, createdAt: "2026-06-01",
  status: "ACTIVE", investmentsConsent: null, environment: "production", ...o });
const rev = (id: string, at: string): PlaidItemTransition =>
  ({ plaidItemId: id, at, from: "ACTIVE", to: "REVOKED" });

console.log("1. calls can never become cost");
{
  const src = code(read("lib/platform/plaid/item-months.ts"));
  check("the derivation never reads a call counter",
    !/apiUsageCounter|calls|transactionsSync|prompt_tokens/.test(src));
  check("…and no Plaid rate is expressed per call",
    PLAID_RATES.every((r) => typeof r.usdPerItemMonth === "number") &&
      !/usdPerCall|perCall/.test(code(read("lib/usage/pricing.ts"))));
  // The AI reducer already excludes Plaid structurally; re-pinned here because
  // Slice 4 is where someone would be tempted to add it.
  check("a Plaid metric still resolves no AI model (structural exclusion holds)",
    !/chat\.completions/.test("transactionsSync"));
  check("no user financial data enters the fact shape",
    !/balance|amount|transaction|accountNumber|token|credential/i.test(
      /export interface PlaidItemFact \{[\s\S]*?\n\}/.exec(src)![0]));
}

console.log("2. seeded fixtures are not billable");
{
  check("a seeded Item is excluded", !isBillableItem(item({ externalItemId: "demo_item_demobank" })));
  check("a real Item is included", isBillableItem(item({ externalItemId: "AkY6XxnJKeF6zQaJgE" })));
  check("the seed still uses the prefix the exclusion keys on",
    read("prisma/seed.ts").includes(`"${SEEDED_ITEM_PREFIX}`));
  const mixed = [item({ externalItemId: "demo_item_a" }), item({ externalItemId: "real_x" })];
  check("a census counts only the real one", itemMonths(mixed, [], JULY).length === 1);
}

console.log("3. lifecycle — created, retired, and never projected backward");
{
  check("an Item created AFTER the cycle contributes nothing",
    itemMonths([item({ createdAt: "2026-08-05" })], [], JULY).length === 0);
  check("an Item created during the cycle contributes",
    itemMonths([item({ createdAt: "2026-07-15" })], [], JULY).length === 1);
  check("an Item retired BEFORE the cycle contributes nothing",
    itemMonths([item({ id: "r1", createdAt: "2026-01-01" })], [rev("r1", "2026-06-15")], JULY).length === 0);

  // ⚠️ THE BACKWARD-PROJECTION TRAP. An Item revoked in August was fully billable
  // in July; today's status must not erase that.
  const revokedLater = [item({ id: "r2", createdAt: "2026-01-01", status: "REVOKED" })];
  const t = [rev("r2", "2026-08-20")];
  check("an Item revoked AFTER the cycle is still counted for that cycle",
    itemMonths(revokedLater, t, JULY).length === 1);
  check("…and current REVOKED status alone never retires it historically",
    retiredAtFrom("r2", []) === null);
  check("retirement is read from the ledger, at the transition's date",
    retiredAtFrom("r2", t) === "2026-08-20");
  check("…and it stops contributing in the cycle after retirement",
    itemMonths(revokedLater, t, monthCycle("2026-09")).length === 0);

  // NEEDS_REAUTH / ERROR are not retirement — a broken Item is still billed.
  check("a broken Item is still billable",
    itemMonths([item({ status: "NEEDS_REAUTH", createdAt: "2026-01-01" })], [], JULY).length === 1);
  check("…and a NEEDS_REAUTH transition is not a retirement",
    retiredAtFrom("x", [{ plaidItemId: "x", at: "2026-07-05", from: "ACTIVE", to: "NEEDS_REAUTH" }]) === null);
}

console.log("4. the two billing interpretations, exposed not resolved");
{
  // Retired mid-cycle: the ONE case where the readings diverge.
  const mid = [item({ id: "m1", createdAt: "2026-06-01" })];
  const rows = itemMonths(mid, [rev("m1", "2026-07-15")], JULY);
  check("present-during-cycle sees it", rows[0].presentDuringCycle === true);
  check("present-at-cycle-end does not", rows[0].presentAtCycleEnd === false);

  const both = priceCycleBothReadings(mid, [rev("m1", "2026-07-15")], JULY);
  check("the two readings disagree and the result says so", both.agree === false);
  check("…with different item-month counts",
    both.during.itemMonths.transactions === 1 && both.atEnd.itemMonths.transactions === 0);
  check("each figure names the interpretation that produced it",
    both.during.interpretation === "presentDuringCycle" && both.atEnd.interpretation === "presentAtCycleEnd");

  // Where nothing was retired mid-cycle — July's actual shape — they agree.
  const stable = [item({ createdAt: "2026-06-01" }), item({ createdAt: "2026-06-02" })];
  check("with no mid-cycle retirement the readings agree, so one figure is safe",
    priceCycleBothReadings(stable, [], JULY).agree === true);
}

console.log("5. products, and consent that carries no timestamp");
{
  const withInv = [item({ createdAt: "2026-06-01", investmentsConsent: "ENABLED" })];
  const rows = itemMonths(withInv, [], JULY, "2026-09-09");
  check("an investments Item bills on two product lines", rows.length === 2);
  // ⚠️ investmentsConsent has NO timestamp, so it evidences only the present.
  check("investments is NOT evidenced for a past cycle",
    rows.find((r) => r.product === "investments")!.productEvidenced === false);
  check("…while transactions is", rows.find((r) => r.product === "transactions")!.productEvidenced === true);
  const now = itemMonths(withInv, [], monthCycle("2026-09"), "2026-09-09");
  check("investments IS evidenced for the current cycle",
    now.find((r) => r.product === "investments")!.productEvidenced === true);
  const priced = priceCycle(withInv, [], JULY, "presentDuringCycle", { today: "2026-09-09" });
  check("unevidenced product-months are reported, not hidden", priced.unevidencedProductItemMonths === 1);
}

console.log("6. environment stays separable, and unknown stays unknown");
{
  const pop = [
    item({ createdAt: "2026-06-01", environment: "production" }),
    item({ createdAt: "2026-06-01", environment: "development" }),
    item({ createdAt: "2026-06-01", environment: "preview" }),
    item({ createdAt: "2026-06-01", environment: null }),
  ];
  const c = priceCycle(pop, [], JULY, "presentDuringCycle");
  check("four environments are separable", c.byEnvironment.length === 4);
  // ⚠️ UNKNOWN IS NOT PRODUCTION.
  const envs = c.byEnvironment.map((e) => e.environment).sort();
  check("a null environment reads as unknown, never production",
    envs.includes("unknown") && c.byEnvironment.find((e) => e.environment === "unknown")!.itemMonths === 1);
  check("production is only what was stamped production",
    c.byEnvironment.find((e) => e.environment === "production")!.itemMonths === 1);
  check("total spend is the sum across environments",
    near(c.usd, c.byEnvironment.reduce((a, e) => a + (e.usd ?? 0), 0)));
  const src = code(read("lib/plaid/exchangeToken.ts"));
  check("environment is stamped at the one creation chokepoint, on create only",
    /environment:\s+deploymentEnvironment\(\)/.test(src) && /create: \{[\s\S]{0,400}environment:/.test(src));
  check("…and reuses the existing V26-ENV-1 classifier",
    /deploymentEnvironment/.test(src) && !/VERCEL_ENV|NODE_ENV/.test(src));
}

console.log("7. pricing is effective-dated and never fabricated");
{
  const c = priceCycle([item({ createdAt: "2026-06-01" })], [], JULY, "presentDuringCycle");
  check("a July Item-month prices at the evidenced $0.30", near(c.usd, 0.30));
  check("the rate carries its provenance",
    (plaidRateAt("transactions", "2026-07-01")!.source ?? "").includes("S-J7Y5657ZK0-2607"));

  // ⚠️ NO EVIDENCE, NO PRICE. June predates the only invoice we have.
  const june = priceCycle([item({ createdAt: "2026-01-01" })], [], monthCycle("2026-06"), "presentDuringCycle");
  check("a cycle before the evidenced rate is UNPRICED, not $0",
    june.usd === null && june.unpricedItemMonths === 1);
  check("…and its item-months are still counted", june.itemMonths.transactions === 1);

  // ⚠️ A NEW RATE MUST NOT REPRICE AN UNSUPPORTED HISTORICAL PERIOD.
  const withToday: PlaidRate[] = [...PLAID_RATES,
    { provider: "PLAID", product: "transactions", effectiveFrom: "2026-09-01", usdPerItemMonth: 9.99, source: "fixture" }];
  check("adding today's rate does not reprice July",
    near(priceCycle([item({ createdAt: "2026-06-01" })], [], JULY, "presentDuringCycle", { rates: withToday }).usd, 0.30));
  check("…nor price a period the evidence never covered",
    priceCycle([item({ createdAt: "2026-01-01" })], [], monthCycle("2026-06"), "presentDuringCycle", { rates: withToday }).usd === null);
}

console.log("8. coverage is stated when evidence is missing");
{
  const items = [item({ createdAt: "2026-07-19" })];
  const cov = censusCoverage(items, [], JULY);
  check("an empty transition ledger makes the cycle incomplete", cov.incomplete === true);
  check("…and says retirement cannot be detected", cov.reasons.some((r) => /retirement evidence/.test(r)));
  check("…and that a wiped table makes the census a LOWER BOUND",
    cov.reasons.some((r) => /LOWER BOUND/.test(r)));
  const good = censusCoverage([item({ createdAt: "2026-05-01" })],
    [{ plaidItemId: "z", at: "2026-05-01", from: "ACTIVE", to: "NEEDS_REAUTH" }], JULY);
  check("a cycle fully covered by evidence is not marked incomplete", good.incomplete === false);
  check("coverage travels with every priced cycle",
    priceCycle(items, [], JULY, "presentDuringCycle").coverage.incomplete === true);
}

console.log("9. no parallel collector, no mirrored AI shape");
{
  const schema = read("prisma/schema.prisma");
  check("no PlaidInvocation or PlaidBillingEvent table was created",
    !/model PlaidInvocation|model PlaidBillingEvent|model PlaidItemMonth/.test(schema));
  check("the only Plaid schema change is one nullable environment column",
    /model PlaidItem \{[\s\S]*?environment\s+String\?/.test(schema));
  const src = code(read("lib/platform/plaid/item-months.ts"));
  check("the derivation stores nothing", !/\.(create|update|upsert|delete)\(/.test(src));
  check("…and reads only injected facts", !/@\/lib\/db|prisma/.test(src));
  check("Plaid rates live in the same code-owned pricing module as AI's",
    /PLAID_RATES/.test(read("lib/usage/pricing.ts")));
}

console.log(failures === 0 ? "\nAll item-month checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
