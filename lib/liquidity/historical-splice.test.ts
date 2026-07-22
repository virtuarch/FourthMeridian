/**
 * lib/liquidity/historical-splice.test.ts  (LIQ-H1)
 *
 * Pure fixture test for the historical Liquidity splice (house convention, no
 * prisma generate):  npx tsx lib/liquidity/historical-splice.test.ts
 *
 * Pins the load-bearing invariants:
 *   • crypto counted EXACTLY once (A8 value REPLACES the held-flat estimate, never
 *     adds a parallel digital-asset total) — the historical Wealth double-count bug;
 *   • brokerage covered → derived value from A8; partial coverage → incomplete tier;
 *   • balance-only investment / all-unvalued → held-flat estimated PRESERVED (never
 *     zeroed): a balance-bearing account is never dropped for lack of positions;
 *   • depository / liability rows pass through untouched (no second reconstruction);
 *   • spliced rows stamped in the reporting currency (identity-convert downstream);
 *   • no second classifier — the splice is driven purely by A8 account coverage.
 */

import { spliceLiquidityRows, type AsOfLiquidityRow, type MarketableComponent } from "./historical-splice";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function row(
  id: string,
  type: string,
  balance: number,
  tier: CompletenessTier,
  extra?: Partial<AsOfLiquidityRow>,
): AsOfLiquidityRow {
  return {
    id,
    type,
    balance,
    currency: "USD",
    lastUpdated: "2026-06-30T00:00:00.000Z",
    visibilityLevel: "FULL",
    tier,
    ...extra,
  };
}

function comp(accountId: string, reportingValue: number | null, overallTier: CompletenessTier): MarketableComponent {
  return { accountId, reportingValue, overallTier };
}

const REPORTING = "USD";

// ── Depository + liability pass through untouched ─────────────────────────────
{
  const rows: AsOfLiquidityRow[] = [
    row("chk", "checking", 5000, "derived"),
    row("sav", "savings", 12000, "derived"),
    row("card", "debt", -800, "derived", { creditLimit: 5000 }),
  ];
  const { rows: out, stamps } = spliceLiquidityRows(rows, [], REPORTING);
  const chk = out.find((r) => r.id === "chk")!;
  const card = out.find((r) => r.id === "card")!;
  check("depository balance unchanged (no A8 component)", chk.balance === 5000);
  check("liability balance unchanged", card.balance === -800 && card.creditLimit === 5000);
  check("pass-through tier preserved (derived)", stamps.get("sav")!.tier === "derived");
  check("no rows dropped", out.length === 3);
}

// ── Brokerage: A8 value REPLACES held-flat estimate, tier → derived ───────────
{
  const rows: AsOfLiquidityRow[] = [row("brk", "investment", 20000 /* held-flat today */, "estimated")];
  // A8 says the account was worth 14,000 at date T (two valued instruments).
  const components = [comp("brk", 9000, "observed"), comp("brk", 5000, "derived")];
  const { rows: out, stamps } = spliceLiquidityRows(rows, components, REPORTING);
  const brk = out.find((r) => r.id === "brk")!;
  check("brokerage balance replaced by A8 valued subtotal (14000, not 20000)", brk.balance === 14000);
  check("spliced tier is worst of A8 instrument tiers (derived)", stamps.get("brk")!.tier === "derived");
  check("spliced row stamped reporting currency (identity FX)", brk.currency === REPORTING);
}

// ── Partial coverage: one unvalued instrument → tier incomplete, valued subset only ──
{
  const rows: AsOfLiquidityRow[] = [row("brk", "investment", 20000, "estimated")];
  const components = [comp("brk", 9000, "derived"), comp("brk", null, "incomplete")];
  const { rows: out, stamps } = spliceLiquidityRows(rows, components, REPORTING);
  const brk = out.find((r) => r.id === "brk")!;
  check("partial coverage uses valued subtotal only (9000)", brk.balance === 9000);
  check("partial coverage restamps tier incomplete", stamps.get("brk")!.tier === "incomplete");
}

// ── Crypto counted EXACTLY once — A8 replaces, never adds ─────────────────────
{
  const rows: AsOfLiquidityRow[] = [
    row("chk", "checking", 1000, "derived"),
    row("wallet", "crypto", 25000 /* held-flat today */, "estimated"),
  ];
  // A8 (scope 'all') values the BTC position on the shared spine at 14,536 at T.
  const components = [comp("wallet", 14536, "estimated")];
  const { rows: out, stamps } = spliceLiquidityRows(rows, components, REPORTING);
  const wallet = out.find((r) => r.id === "wallet")!;
  const cryptoRows = out.filter((r) => r.id === "wallet");
  check("crypto account appears exactly once (no parallel digital-asset row)", cryptoRows.length === 1);
  check("crypto balance == A8 value (14536), NOT held-flat 25000, NOT 25000+14536", wallet.balance === 14536);
  const totalMarketable = out
    .filter((r) => r.type === "investment" || r.type === "crypto")
    .reduce((s, r) => s + r.balance, 0);
  check("total marketable counts each covered asset once (== 14536)", totalMarketable === 14536);
  check("crypto spliced tier from A8 (estimated: constant-qty × real price)", stamps.get("wallet")!.tier === "estimated");
}

// ── Balance-only investment (no positions) → held-flat estimated PRESERVED ────
{
  const rows: AsOfLiquidityRow[] = [row("manualBrk", "investment", 8000, "estimated")];
  const { rows: out, stamps } = spliceLiquidityRows(rows, [] /* A8 has no components */, REPORTING);
  const m = out.find((r) => r.id === "manualBrk")!;
  check("balance-only investment held flat (8000), not zeroed", m.balance === 8000);
  check("balance-only investment stays estimated", stamps.get("manualBrk")!.tier === "estimated");
  check("balance-only investment keeps native currency (pass-through)", m.currency === "USD");
}

// ── All-unvalued at this date (positions exist, no price reached T) → held flat ──
{
  const rows: AsOfLiquidityRow[] = [row("brk", "investment", 6000, "estimated")];
  const components = [comp("brk", null, "incomplete")]; // component exists but unvalued
  const { rows: out, stamps } = spliceLiquidityRows(rows, components, REPORTING);
  const brk = out.find((r) => r.id === "brk")!;
  check("all-unvalued account held flat (6000), NOT zeroed", brk.balance === 6000);
  check("all-unvalued account keeps held-flat estimated tier", stamps.get("brk")!.tier === "estimated");
}

// ── Manual 'other' real asset → held flat estimated (no price series exists) ──
{
  const rows: AsOfLiquidityRow[] = [row("home", "other", 450000, "estimated")];
  const { rows: out } = spliceLiquidityRows(rows, [], REPORTING);
  check("manual 'other' asset held flat (450000)", out[0].balance === 450000);
}

// ── Mixed Space: cash + brokerage + crypto + manual — every asset once ────────
{
  const rows: AsOfLiquidityRow[] = [
    row("chk", "checking", 3000, "derived"),
    row("brk", "investment", 50000, "estimated"),
    row("wallet", "crypto", 30000, "estimated"),
    row("manual", "investment", 4000, "estimated"),
    row("home", "other", 200000, "estimated"),
  ];
  const components = [
    comp("brk", 42000, "derived"),
    comp("wallet", 18000, "estimated"),
    // manual has no components → held flat
  ];
  const { rows: out } = spliceLiquidityRows(rows, components, REPORTING);
  const byId = Object.fromEntries(out.map((r) => [r.id, r.balance]));
  check("mixed: covered brokerage → A8 (42000)", byId.brk === 42000);
  check("mixed: covered crypto → A8 (18000)", byId.wallet === 18000);
  check("mixed: uncovered manual investment → held flat (4000)", byId.manual === 4000);
  check("mixed: cash untouched (3000)", byId.chk === 3000);
  check("mixed: manual 'other' untouched (200000)", byId.home === 200000);
  const marketable = out
    .filter((r) => r.type === "investment" || r.type === "crypto")
    .reduce((s, r) => s + r.balance, 0);
  check("mixed: marketable = 42000 + 18000 + 4000, each asset once", marketable === 64000);
}

if (failures > 0) {
  console.error(`\nhistorical-splice.test.ts: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nhistorical-splice.test.ts: all checks passed");
