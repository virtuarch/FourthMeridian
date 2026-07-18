/**
 * components/space/widgets/liquidity/LiquidityWorkspace.test.ts
 *
 * SD-6B durable-invariant ratchets for the Liquidity WORKSPACE (pure, DB-free — house
 * pattern). TEST-3 cleanup: brittle layout/JSX-order/prop-spelling/composition-once
 * pins removed; the durable extraction + LiquiditySpaceData-activation invariants kept:
 *
 *   1. WORKSPACE BOUNDARY: owns useLiquiditySpaceData; consumes LiquiditySpaceData
 *      (current / atAsOf / delta / trust); no local time state; no as-of loader / no
 *      second valuation engine imported; no cross-workspace imports.
 *   2. TEMPORAL activation: the Ladder RE-SURFACES the canonical atAsOf tier metrics
 *      (never a re-sum) with a per-tier delta; the hook fetches the WHOLE contract, is
 *      historical-gated, and keeps the last contract on error (honesty).
 *   3. CANONICAL TIERS: re-surface, never re-partition or rail-classify.
 *   4. Crypto exactly once / no second valuation authority in the workspace.
 *   5. Trust PRESENTED, not recomputed.
 *   6. Net EXCLUDES credit (liquidity.core doctrine).
 *   7. FX: historical values CONVERTED via the ONE canonical adapter (no symbol-only
 *      relabel), no bespoke FX in the workspace.
 *   8. Envelope bridge: emits the envelope up; the host consumes it for the shell chip.
 *   9. Route serves the WHOLE contract via loadLiquiditySpaceData (perspective:read),
 *      composing / clipping nothing itself.
 *  10. Host RELAYS: mounts <LiquidityWorkspace>; dropped <LiquidityPerspective>.
 *  11. Registry: liquidity stays consumesShellTime: true (temporal in runtime now).
 *
 *   npx tsx components/space/widgets/liquidity/LiquidityWorkspace.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PERSPECTIVE_LIBRARY } from "@/lib/perspectives";

const ROOT = process.cwd();
const DIR = "components/space/widgets/liquidity";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const SRC   = read(`${DIR}/LiquidityWorkspace.tsx`);
const CODE  = strip(SRC);
const HOOK  = read(`${DIR}/useLiquiditySpaceData.ts`);
const HOOKC = strip(HOOK);
const ROUTE = read("app/api/spaces/[id]/liquidity/space-data/route.ts");
const ROUTEC = strip(ROUTE);
const DASH  = strip(read("components/dashboard/SpaceDashboard.tsx"));

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j === -1) return n;
    n++; i = j + needle.length;
  }
}

console.log("1. WORKSPACE BOUNDARY — owns the data, consumes the contract, no local time state");
{
  check("Workspace owns the hook (calls useLiquiditySpaceData)", CODE.includes("useLiquiditySpaceData("));
  check("Workspace consumes LiquiditySpaceData.current", CODE.includes("data?.current") || CODE.includes("data.current"));
  check("Workspace consumes LiquiditySpaceData.atAsOf", CODE.includes("data?.atAsOf"));
  check("Workspace consumes LiquiditySpaceData.delta", CODE.includes("data?.delta"));
  check("Workspace consumes LiquiditySpaceData.trust", CODE.includes("data?.trust"));
  check("no usePerspectiveShellState (no duplicate time authority)", !CODE.includes("usePerspectiveShellState"));
  check("no local as-of loader / valuation import",
    !CODE.includes("getAccountsAsOf") && !CODE.includes("accounts-asof") &&
    !CODE.includes("getInvestmentValueAsOf") && !CODE.includes("investments/valuation"));
  check("no cross-workspace imports", !CODE.includes("components/space/widgets/wealth/") &&
    !CODE.includes("components/space/widgets/cashflow/") && !CODE.includes("components/space/widgets/debt/") &&
    !CODE.includes("components/space/widgets/investments/"));
}

console.log("2. TEMPORAL activation — Ladder from atAsOf metrics + delta; hook fetches the contract");
{
  // The historical Ladder RE-SURFACES the canonical tier metrics (never a sum).
  check("Ladder reads atAsOf cashNow metric", CODE.includes('metricValue(atAsOf, "cashNow")'));
  check("Ladder reads atAsOf marketable metric", CODE.includes('metricValue(atAsOf, "marketable")'));
  check("Ladder reads atAsOf illiquid metric", CODE.includes('metricValue(atAsOf, "illiquid")'));
  check("Ladder renders a per-tier delta chip", CODE.includes("delta?.cashNow") && CODE.includes("delta?.marketable") && CODE.includes("delta?.illiquid"));
  check("Ladder renders the net accessible change", CODE.includes("delta.net"));
  // The hook composes the WHOLE contract from the route (historical) / host lens (present).
  check("hook fetches the full contract (space-data route)", HOOKC.includes("/liquidity/space-data"));
  check("hook synthesizes present-day via assembleLiquiditySpaceData (no fetch)", HOOKC.includes("assembleLiquiditySpaceData("));
  check("hook is historical-gated (asOf < today / compareTo ⇒ server; present ⇒ host lens)",
    HOOKC.includes("asOf < today") && HOOKC.includes("presentLens") && HOOKC.includes("needsServer"));
  check("hook honesty: keeps last contract on error (no setServerData(null) in catch)",
    HOOKC.includes("setError(true)") && !/catch[\s\S]*setServerData\(null\)/.test(HOOKC));
  check("hook sends compareTo only when strictly earlier", HOOKC.includes("compareTo < asOf"));
}

console.log("3. CANONICAL TIERS — re-surface, never re-partition or rail-classify on the historical path");
{
  // metricValue reads a named metric out of a LensResult; it must NOT sum balances.
  check("metricValue reads lens.metrics (no re-sum)", CODE.includes("lens.metrics.find"));
  check("no historical liquidity recomputation (no computeLiquidity)", !CODE.includes("computeLiquidity"));
  check("no splice engine in the workspace", !CODE.includes("spliceLiquidityRows") && !CODE.includes("historical-splice"));
  // Payment-app rail is never a liquidity classifier here (doctrine §8).
  check("no payment-app rail classification math", !CODE.includes("paymentApp") && !CODE.includes("payment_app") && !CODE.includes("rail"));
}

console.log("4. Crypto exactly once / no second valuation authority in the workspace");
{
  // The engine guarantees crypto-once (splice REPLACES a wallet's held-flat estimate);
  // the workspace must import NO valuation / splice / lens-compute authority of its own.
  check("no getInvestmentValueAsOf import", !CODE.includes("getInvestmentValueAsOf"));
  check("no digital-asset re-bucket (no separate crypto sum on the historical path)",
    !CODE.includes("totalDigitalAssets +") || count(CODE, "totalDigitalAssets") <= 2);
}

console.log("5. Trust PRESENTED, not recomputed");
{
  check("no completeness recomputation in the workspace", !CODE.includes("buildLiquidityCompleteness"));
  check("as-of trust reason is presented", CODE.includes("trust.reason"));
}

console.log("6. Net EXCLUDES credit (liquidity.core doctrine)");
{
  // The workspace never adds availableCredit into net — it re-surfaces delta.net
  // (which the pure contract computes credit-excluded) and shows credit separately.
  check("credit shown separately (not in a liquidity sum)", CODE.includes('metricValue(atAsOf, "availableCredit")'));
  check("net is the contract's delta.net (never recomputed with credit)",
    CODE.includes("delta.net") && !/delta\.net\s*\+\s*.*credit/i.test(CODE));
}

console.log("7. FX correctness — historical values CONVERTED (no symbol-only relabel), no bespoke FX");
{
  check("ctx threaded into the panels (ConversionContext)", CODE.includes("ConversionContext"));
  // The workspace runs the ONE canonical display-conversion pass over the contract
  // before rendering — so the tiles/delta read CONVERTED numbers, never a reporting
  // magnitude under a display symbol.
  check("workspace applies convertLiquiditySpaceData over the contract", CODE.includes("convertLiquiditySpaceData("));
  check("workspace performs no bespoke FX (no convertMoney / no second rate source)", !CODE.includes("convertMoney"));
  // Honest provenance when a conversion actually happened (view-as override).
  check("workspace surfaces an FX-basis note (fxConverted)", CODE.includes("fxConverted"));
  // The adapter is the per-date authority; the workspace must not relabel by symbol only.
  const ADAPTER = strip(read("lib/liquidity/display-conversion.ts"));
  check("adapter identity when target === reportingCurrency (no relabel path)",
    ADAPTER.includes("ctx.target === data.reportingCurrency"));
  check("adapter converts per-date via convertMoney (each endpoint at its own date)",
    ADAPTER.includes("convertMoney(") && ADAPTER.includes("data.asOf") && ADAPTER.includes("data.compareTo"));
  check("adapter recomposes delta via the pure contract (no duplicate delta math)",
    ADAPTER.includes("assembleLiquiditySpaceData("));
}

console.log("8. Envelope bridge — emitted up, consumed by the host");
{
  check("workspace emits the envelope via onEnvelopeChange", CODE.includes("onEnvelopeChange("));
  check("workspace reuses the canonical resolver", CODE.includes("resolvePerspectiveEnvelope("));
  check("host consumes the consolidated envelope in the shell chip", DASH.includes("activeEnvelope"));
  check("host relays the workspace envelope (consolidated)", DASH.includes("<LiquidityWorkspace") && DASH.includes("onEnvelopeChange={setActiveEnvelope}"));
}

console.log("9. Route serves the WHOLE contract via loadLiquiditySpaceData (authz-gated single authority)");
{
  check("route calls the single canonical loader", ROUTE.includes("loadLiquiditySpaceData("));
  check("route is membership-gated (perspective:read)", ROUTE.includes("perspective:read"));
  check("route accepts asOf + compareTo", ROUTE.includes("asOf") && ROUTE.includes("compareTo"));
  // The route must not compose / splice / clip — the loader is the single authority.
  check("route computes NOTHING else (no splice / assemble / lens math in code)",
    !ROUTEC.includes("assembleLiquiditySpaceData") && !ROUTEC.includes("spliceLiquidityRows") && !ROUTEC.includes("computeLiquidity"));
}

console.log("10. Host RELAYS — mounts <LiquidityWorkspace>, dropped <LiquidityPerspective>");
{
  check("host mounts LiquidityWorkspace (the liquidity destination's renderer)", DASH.includes("<LiquidityWorkspace"));
  check("host no longer mounts LiquidityPerspective", !DASH.includes("<LiquidityPerspective"));
}

console.log("11. Registry — liquidity stays temporal (consumesShellTime: true)");
{
  check("liquidity consumesShellTime is true", PERSPECTIVE_LIBRARY.liquidity?.consumesShellTime === true);
}

if (failures > 0) { console.error(`\n${failures} LiquidityWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll LiquidityWorkspace checks passed");
