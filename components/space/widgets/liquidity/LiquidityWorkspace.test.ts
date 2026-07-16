/**
 * components/space/widgets/liquidity/LiquidityWorkspace.test.ts
 *
 * SD-6B source-scan ratchets for the Liquidity WORKSPACE (pure, DB-free — house
 * pattern). Locks the extraction + the LiquiditySpaceData activation:
 *
 *   1. Composition: the current-anchor widgets (Accessible Cash / EFR / Reachability
 *      / Concentration / What Changed) + the temporal Ladder + the lede, once each.
 *   2. Grid + span pairs + min-w-0 + no fixed height (layout preserved from the old
 *      Perspective, so present-day is byte-parity).
 *   3. Source order (= mobile stacking).
 *   4. WORKSPACE BOUNDARY: owns useLiquiditySpaceData; consumes LiquiditySpaceData
 *      (data.current / data.atAsOf / data.delta / data.trust); no local time state;
 *      no as-of loader / no second valuation engine imported.
 *   5. TEMPORAL activation: the Ladder is reconstructed from the canonical atAsOf tier
 *      metrics (cashNow / marketable / illiquid) with a per-tier delta; the hook
 *      fetches the WHOLE contract from the space-data route; present-day reuses the
 *      host lens (byte-identical, no fetch).
 *   6. CANONICAL TIERS: the workspace RE-SURFACES computeLiquidity's metrics — it
 *      never re-partitions accounts into tiers or recomputes a liquidity sum on the
 *      historical path, and it never classifies liquidity by payment-app rail.
 *   7. Crypto exactly once / no second authority: no splice / valuation / lens import
 *      in the workspace (the engine owns crypto-once; the workspace inherits it).
 *   8. Trust PRESENTED, not recomputed (data.trust; no buildLiquidityCompleteness).
 *   9. Net EXCLUDES credit (liquidity.core doctrine): credit shown separately.
 *  10. FX not regressed: ctx threaded; no bespoke FX in the workspace.
 *  11. Envelope bridge: emits the envelope up via onEnvelopeChange; the host consumes
 *      liquidityEnvelope for the shell chip (host no longer the Liquidity data owner).
 *  12. Route serves the WHOLE contract via loadLiquiditySpaceData (perspective:read),
 *      composing / clipping nothing itself.
 *  13. Host wiring: mounts <LiquidityWorkspace once; dropped <LiquidityPerspective.
 *  14. Registry: liquidity stays consumesShellTime: true (temporal in runtime now).
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

console.log("1. Composition — current-anchor widgets + temporal Ladder + lede, once each");
{
  const mounts: [string, string][] = [
    ["Accessible Cash", "renderAccessibleCash("],
    ["Emergency Fund Readiness", "renderEmergencyFundReadiness("],
    ["Liquidity Concentration", "renderLiquidityConcentration("],
    ["What Changed", "<LiquidityWhatChangedCard"],
    ["Liquidity Ladder tiles (present)", "<LiquidityLadderTiers"],
  ];
  for (const [label, needle] of mounts) {
    check(`${label} mounted exactly once`, count(SRC, needle) === 1, `${count(SRC, needle)} occurrence(s)`);
  }
}

console.log("2. Grid + span + overflow contract (layout preserved)");
{
  check("root uses the 12-col grid", SRC.includes("lg:grid-cols-12"));
  check("items-stretch balances rows", SRC.includes("items-stretch"));
  const spans = [
    "lg:col-span-12",
    "lg:col-span-5 xl:col-span-4",
    "lg:col-span-7 xl:col-span-8",
    "lg:col-span-6 xl:col-span-5",
    "lg:col-span-6 xl:col-span-7",
  ];
  for (const s of spans) check(`span "${s}" present`, SRC.includes(s));
  check("min-w-0 appears on every column + the panel (≥6)", count(SRC, "min-w-0") >= 6, `${count(SRC, "min-w-0")}`);
  check("no fixed h-[…] on panels", !SRC.includes("h-["));
  check("no max-h-[…] on panels", !SRC.includes("max-h-["));
}

console.log("3. Source order = mobile stacking order");
{
  const gridIdx = SRC.indexOf("grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch");
  const RET = gridIdx >= 0 ? SRC.slice(gridIdx) : "";
  const order = [
    "renderLede(",
    "renderAccessibleCash(",
    "renderEmergencyFundReadiness(",
    "renderLadder(",
    "renderReachability(",
    "renderLiquidityConcentration(",
    "<LiquidityWhatChangedCard",
  ];
  const positions = order.map((n) => RET.indexOf(n));
  check("all order anchors present", positions.every((p) => p >= 0), positions.join(","));
  check("panels appear in the mandated source order", positions.every((p, i) => i === 0 || positions[i - 1] < p), positions.join(","));
}

console.log("4. WORKSPACE BOUNDARY — owns the data, consumes the contract, no local time state");
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

console.log("5. TEMPORAL activation — Ladder from atAsOf metrics + delta; hook fetches the contract");
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

console.log("6. CANONICAL TIERS — re-surface, never re-partition or rail-classify on the historical path");
{
  // metricValue reads a named metric out of a LensResult; it must NOT sum balances.
  check("metricValue reads lens.metrics (no re-sum)", CODE.includes("lens.metrics.find"));
  check("no historical liquidity recomputation (no computeLiquidity)", !CODE.includes("computeLiquidity"));
  check("no splice engine in the workspace", !CODE.includes("spliceLiquidityRows") && !CODE.includes("historical-splice"));
  // Payment-app rail is never a liquidity classifier here (doctrine §8).
  check("no payment-app rail classification math", !CODE.includes("paymentApp") && !CODE.includes("payment_app") && !CODE.includes("rail"));
}

console.log("7. Crypto exactly once / no second valuation authority in the workspace");
{
  // The engine guarantees crypto-once (splice REPLACES a wallet's held-flat estimate);
  // the workspace must import NO valuation / splice / lens-compute authority of its own.
  check("no getInvestmentValueAsOf import", !CODE.includes("getInvestmentValueAsOf"));
  check("no digital-asset re-bucket (no separate crypto sum on the historical path)",
    !CODE.includes("totalDigitalAssets +") || count(CODE, "totalDigitalAssets") <= 2);
}

console.log("8. Trust PRESENTED, not recomputed");
{
  check("no completeness recomputation in the workspace", !CODE.includes("buildLiquidityCompleteness"));
  check("as-of trust reason is presented", CODE.includes("trust.reason"));
}

console.log("9. Net EXCLUDES credit (liquidity.core doctrine)");
{
  // The workspace never adds availableCredit into net — it re-surfaces delta.net
  // (which the pure contract computes credit-excluded) and shows credit separately.
  check("credit shown separately (not in a liquidity sum)", CODE.includes('metricValue(atAsOf, "availableCredit")'));
  check("net is the contract's delta.net (never recomputed with credit)",
    CODE.includes("delta.net") && !/delta\.net\s*\+\s*.*credit/i.test(CODE));
}

console.log("10. FX correctness — historical values CONVERTED (no symbol-only relabel), no bespoke FX");
{
  check("ctx threaded into the panels", /ctx=\{ctx\}/.test(SRC) && CODE.includes("ConversionContext"));
  // The workspace runs the ONE canonical display-conversion pass over the contract
  // before rendering — so the tiles/delta read CONVERTED numbers, never a reporting
  // magnitude under a display symbol.
  check("workspace applies convertLiquiditySpaceData over the contract", CODE.includes("convertLiquiditySpaceData("));
  check("conversion runs before render (memoized on data + ctx)", /convertLiquiditySpaceData\(rawData, ctx\)/.test(CODE));
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

console.log("11. Envelope bridge — emitted up, consumed by the host");
{
  check("workspace emits the envelope via onEnvelopeChange", CODE.includes("onEnvelopeChange("));
  check("workspace reuses the canonical resolver", CODE.includes("resolvePerspectiveEnvelope("));
  check("host consumes liquidityEnvelope in the shell chip", DASH.includes("liquidityEnvelope"));
  check("host relays the workspace envelope (onEnvelopeChange={setLiquidityEnvelope})", DASH.includes("setLiquidityEnvelope"));
}

console.log("12. Route serves the WHOLE contract via loadLiquiditySpaceData");
{
  check("route calls the single canonical loader", ROUTE.includes("loadLiquiditySpaceData("));
  check("route is membership-gated (perspective:read)", ROUTE.includes("perspective:read"));
  check("route accepts asOf + compareTo", ROUTE.includes("asOf") && ROUTE.includes("compareTo"));
  // The route must not compose / splice / clip — the loader is the single authority.
  check("route computes NOTHING else (no splice / assemble / lens math in code)",
    !ROUTEC.includes("assembleLiquiditySpaceData") && !ROUTEC.includes("spliceLiquidityRows") && !ROUTEC.includes("computeLiquidity"));
}

console.log("13. Host wiring — mounts <LiquidityWorkspace, dropped <LiquidityPerspective");
{
  check("host mounts LiquidityWorkspace exactly once", count(DASH, "<LiquidityWorkspace") === 1, `${count(DASH, "<LiquidityWorkspace")}`);
  check("host no longer mounts LiquidityPerspective", !DASH.includes("<LiquidityPerspective"));
  const jsxStart = DASH.indexOf("<LiquidityWorkspace");
  const jsxEnd = DASH.indexOf("/>", jsxStart);
  const jsx = jsxStart >= 0 && jsxEnd >= 0 ? DASH.slice(jsxStart, jsxEnd) : "";
  for (const prop of ["spaceId=", "asOf=", "compareTo=", "today=", "active=", "accounts=", "ctx=", "presentLens=", "onEnvelopeChange="]) {
    check(`mount passes ${prop.replace("=", "")}`, jsx.includes(prop));
  }
  const genericIdx = DASH.indexOf("toVirtualSections(activePerspective.id");
  check("liquidity branch precedes the generic virtual-sections branch", jsxStart >= 0 && genericIdx > jsxStart);
}

console.log("14. Registry — liquidity stays temporal (consumesShellTime: true)");
{
  check("liquidity consumesShellTime is true", PERSPECTIVE_LIBRARY.liquidity?.consumesShellTime === true);
}

if (failures > 0) { console.error(`\n${failures} LiquidityWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll LiquidityWorkspace checks passed");
