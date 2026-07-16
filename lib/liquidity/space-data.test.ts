/**
 * lib/liquidity/space-data.test.ts  (LIQ-H1)
 *
 * End-to-end fixture test for the historical Liquidity engine (house convention,
 * DB-free via the injectable `deps` seam):  npx tsx lib/liquidity/space-data.test.ts
 *
 * Drives loadLiquiditySpaceData with fake canonical reads to pin the composition
 * behavior the real DB reads produce:
 *   • reconstruct liquidity asOf and compareTo through the splice engine;
 *   • crypto counted EXACTLY once end-to-end (A8 replaces held-flat, no double count);
 *   • current / atAsOf@today parity (cash observed, marketable == live);
 *   • depository (walk-back derived) + investment/crypto (A8) reconstruction;
 *   • held-flat estimated fallback surfaced in the completeness envelope;
 *   • per-tier delta + worst-of-endpoints trust;
 *   • completeness provenance present on the historical endpoints.
 *
 * Confirms — by construction — NO second valuation authority (values come only
 * from the injected getInvestmentValueAsOf) and NO raw-Holdings reconstruction.
 */

import { loadLiquiditySpaceData, type LiquidityEngineDeps } from "./space-data";
import { computeLiquidity } from "@/lib/perspective-engine/lenses/liquidity.core";
import { identityContext } from "@/lib/money/convert";
import type { CompletenessTier, LensResult, PerspectiveScope } from "@/lib/perspective-engine/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SCOPE: PerspectiveScope = { spaceId: "space-1", userId: "user-1" };
const TODAY = "2026-07-16";
const REPORTING = "USD";
const NOW = () => new Date("2026-07-16T12:00:00.000Z");

// Live/observed balances (stored). Investment/crypto held flat = stored balance.
const STORED = { chk: 5000, brk: 10000, wallet: 8000 };

// A8 valued components per date (the ONLY source of marketable value).
const A8: Record<string, { accountId: string; reportingValue: number | null; overallTier: CompletenessTier }[]> = {
  [TODAY]:        [comp("brk", 10000, "observed"), comp("wallet", 8000, "observed")], // == stored ⇒ parity
  "2026-06-30":   [comp("brk", 9000, "derived"),   comp("wallet", 6000, "estimated")],
  "2026-05-31":   [comp("brk", 8500, "derived"),   comp("wallet", 5500, "estimated")],
};
// Cash walk-back per date.
const CASH: Record<string, number> = { [TODAY]: 5000, "2026-06-30": 4000, "2026-05-31": 3000 };

function comp(accountId: string, reportingValue: number | null, overallTier: CompletenessTier) {
  return { accountId, reportingValue, overallTier };
}

function acct(id: string, type: string, balance: number, tier: CompletenessTier) {
  return {
    account: { id, type, balance, currency: "USD", creditLimit: null, lastUpdated: "2026-07-16T00:00:00.000Z" },
    visibilityLevel: "FULL",
    method: tier === "observed" ? "observed" : "held-flat",
    tier,
  };
}

// ── Fake canonical reads (the injectable seam) ───────────────────────────────
const deps: Partial<LiquidityEngineDeps> = {
  getAccountsAsOf: (async ({ asOf }: { asOf: string }) => {
    const isToday = asOf >= TODAY;
    return [
      acct("chk", "checking", CASH[asOf] ?? STORED.chk, isToday ? "observed" : "derived"),
      acct("brk", "investment", STORED.brk, isToday ? "observed" : "estimated"),
      acct("wallet", "crypto", STORED.wallet, isToday ? "observed" : "estimated"),
    ];
  }) as unknown as LiquidityEngineDeps["getAccountsAsOf"],

  getInvestmentValueAsOf: (async ({ asOf }: { asOf: string }) => ({
    asOf,
    reportingCurrency: REPORTING,
    valuedSubtotal: 0,
    valuedCount: 0,
    unvaluedCount: 0,
    unvalued: [],
    components: A8[asOf] ?? [],
    completeness: { tier: "derived", conflict: false, reason: "x", byInstrument: {} },
  })) as unknown as LiquidityEngineDeps["getInvestmentValueAsOf"],

  buildCtx: (async () => identityContext(REPORTING)) as unknown as LiquidityEngineDeps["buildCtx"],

  // Live current: computeLiquidity over the stored balances (no splice), identity FX.
  computeCurrent: (async (scope: PerspectiveScope, now: () => Date): Promise<LensResult> => {
    const rows = [
      { id: "chk", type: "checking", balance: STORED.chk, currency: "USD", lastUpdated: "2026-07-16T00:00:00.000Z", visibilityLevel: "FULL" },
      { id: "brk", type: "investment", balance: STORED.brk, currency: "USD", lastUpdated: "2026-07-16T00:00:00.000Z", visibilityLevel: "FULL" },
      { id: "wallet", type: "crypto", balance: STORED.wallet, currency: "USD", lastUpdated: "2026-07-16T00:00:00.000Z", visibilityLevel: "FULL" },
    ];
    return computeLiquidity(scope, { now }, rows, identityContext(REPORTING));
  }),
};

function metric(lens: LensResult | null, id: string): number {
  const m = lens?.metrics.find((x) => x.id === id);
  return m && typeof m.value === "number" ? m.value : NaN;
}

async function main() {
  // ── Pure current-state read ────────────────────────────────────────────────
  {
    const data = await loadLiquiditySpaceData(SCOPE, { now: NOW, deps });
    check("current-only: cashNow 5000", metric(data.current, "cashNow") === 5000);
    check("current-only: marketable 18000 (10000 + 8000)", metric(data.current, "marketable") === 18000);
    check("current-only: no atAsOf", data.atAsOf === null);
    check("current-only: asOf defaults to today", data.asOf === TODAY);
    check("current-only: reportingCurrency stamped from buildCtx target", data.reportingCurrency === REPORTING);
  }

  // ── Reconstruct asOf + compareTo ────────────────────────────────────────────
  {
    const data = await loadLiquiditySpaceData(SCOPE, { now: NOW, asOf: "2026-06-30", compareTo: "2026-05-31", deps });

    // asOf: cash walk-back + A8 marketable (crypto once).
    check("atAsOf cashNow = walk-back 4000", metric(data.atAsOf, "cashNow") === 4000);
    check("atAsOf marketable = A8 9000 + 6000 = 15000 (each asset once)", metric(data.atAsOf, "marketable") === 15000);
    check("atAsOf: crypto NOT double-counted (not 15000+8000, not held-flat)", metric(data.atAsOf, "marketable") === 15000);

    // compareTo endpoint.
    check("atCompareTo cashNow = 3000", metric(data.atCompareTo, "cashNow") === 3000);
    check("atCompareTo marketable = 8500 + 5500 = 14000", metric(data.atCompareTo, "marketable") === 14000);

    // Delta.
    check("delta present", data.delta != null);
    check("Δcash = 4000 − 3000 = 1000", data.delta?.cashNow === 1000);
    check("Δmarketable = 15000 − 14000 = 1000", data.delta?.marketable === 1000);
    check("delta.net = 2000 (credit excluded)", data.delta?.net === 2000);
    check("delta.from/to = compareTo/asOf", data.delta?.from === "2026-05-31" && data.delta?.to === "2026-06-30");

    // Trust / completeness provenance.
    check("atAsOf carries completeness envelope", data.atAsOf?.completeness != null);
    check("trust re-surfaced from atAsOf", data.trust === data.atAsOf?.completeness);
    check("completeness byComponent has cash (derived)", data.atAsOf?.completeness?.byComponent?.cash === "derived");
    check(
      "held-flat estimated surfaced: marketable component estimated (crypto held-flat tier)",
      data.atAsOf?.completeness?.byComponent?.marketable === "estimated",
    );
    check("delta trust = worst-of endpoints (estimated)", data.delta?.trust.tier === "estimated");
  }

  // ── Parity: atAsOf@today ≈ current ──────────────────────────────────────────
  {
    const data = await loadLiquiditySpaceData(SCOPE, { now: NOW, asOf: TODAY, deps });
    check("parity: atAsOf@today cashNow == current cashNow", metric(data.atAsOf, "cashNow") === metric(data.current, "cashNow"));
    check(
      "parity: atAsOf@today marketable == current marketable (A8@today == stored)",
      metric(data.atAsOf, "marketable") === metric(data.current, "marketable"),
    );
    check("parity: atAsOf@today observed tier", data.atAsOf?.completeness?.tier === "observed");
  }

  if (failures > 0) {
    console.error(`\nspace-data.test.ts: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nspace-data.test.ts: all checks passed");
}

void main();
