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
import { PERSPECTIVE_LIBRARY, workspaceConsumesShellTime } from "@/lib/perspectives";

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
// SD-2 closeout — perspective render impls live in the component-layer renderer map.
const REND  = strip(read("components/space/workspaces/workspaceRenderers.tsx"));
const WEALTH = strip(read("components/space/widgets/wealth/WealthWorkspace.tsx"));
// Editorial redesign — the extracted surface components (present-day anchor + shared chart).
const HERO    = strip(read(`${DIR}/LiquidityHero.tsx`));
const HISTORY = strip(read(`${DIR}/LiquidityBalanceHistory.tsx`));
// v2.7 Cash accounts — the Sources ledger + SourceAccountDetail were REPLACED by the
// Cash distribution + Cash accounts ledger, whose rows open the EXISTING AccountDetail.
const LEDGER  = strip(read(`${DIR}/CashAccountsLedger.tsx`));
const DISTRIB = strip(read(`${DIR}/CashDistribution.tsx`));
const CASHHIST = strip(read("lib/liquidity/cash-history.ts"));

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
  // DELIBERATE (owner, v2.7-P0 PR): `delta` fed only the removed reconstructed
  // tiers; the workspace no longer renders it (the contract still carries it).
  check("Workspace no longer renders LiquiditySpaceData.delta (tiers removed)", !CODE.includes("data?.delta"));
  // Trust is presented via the shared TrustIndicator over the SAME canonical envelope the
  // workspace resolves — now rendered inside the extracted Hero (the editorial lede), which
  // receives the envelope as a prop (one authority, two consumers can't disagree).
  // v2.7 final UX pass — DELIBERATE: the Hero's figure is present-day, so its chip
  // reads the present lens's envelope in a past As-Of (figureEnvelope, same resolver).
  check("Workspace resolves the canonical envelope and hands the figure's envelope to the Hero",
    CODE.includes("resolvePerspectiveEnvelope(") && CODE.includes("envelope={figureEnvelope}"));
  check("Hero presents trust via the shared TrustIndicator", HERO.includes("TrustIndicator"));
  check("no usePerspectiveShellState (no duplicate time authority)", !CODE.includes("usePerspectiveShellState"));
  check("no local as-of loader / valuation import",
    !CODE.includes("getAccountsAsOf") && !CODE.includes("accounts-asof") &&
    !CODE.includes("getInvestmentValueAsOf") && !CODE.includes("investments/valuation"));
  check("no cross-workspace imports", !CODE.includes("components/space/widgets/wealth/") &&
    !CODE.includes("components/space/widgets/cashflow/") && !CODE.includes("components/space/widgets/debt/") &&
    !CODE.includes("components/space/widgets/investments/"));
}

console.log("2. TEMPORAL activation — hero/trend/verdict honour the As-Of; hook fetches the contract");
{
  // DELIBERATE (owner, v2.7-P0 PR): the reconstructed-tiers Ladder (atAsOf tier
  // metrics, per-tier delta chips, "Net accessible change") is REMOVED from the
  // Cash page. The historical contract is still read for the verdict + trust.
  check("no reconstructed-tiers section (no renderHistoricalTiers, no liquidity-reconstructed block)",
    !CODE.includes("renderHistoricalTiers") && !CODE.includes('id="liquidity-reconstructed"') && !CODE.includes("Reconstructed tiers"));
  check("no per-tier delta chips / net accessible change", !CODE.includes("delta?.cashNow") && !CODE.includes("delta.net") && !CODE.includes("Net accessible change"));
  check("the atAsOf lens still drives the verdict + trust envelope in a historical view",
    CODE.includes("showAsOf ? atAsOf : (data?.current ?? null)") && CODE.includes("resolvePerspectiveEnvelope"));
  // The hook composes the WHOLE contract from the route (historical) / host lens (present).
  check("hook fetches the full contract (space-data route)", HOOKC.includes("/liquidity/space-data"));
  check("hook synthesizes present-day via assembleLiquiditySpaceData (no fetch)", HOOKC.includes("assembleLiquiditySpaceData("));
  check("hook is historical-gated (asOf < today / compareTo ⇒ server; present ⇒ host lens)",
    HOOKC.includes("asOf < today") && HOOKC.includes("presentLens") && HOOKC.includes("needsServer"));
  check("hook honesty: keeps last contract on error (no setServerData(null) in catch)",
    HOOKC.includes("setError(true)") && !/catch[\s\S]*setServerData\(null\)/.test(HOOKC));
  check("hook sends compareTo only when strictly earlier", HOOKC.includes("compareTo < asOf"));
}

console.log("3. NO historical re-partition — the workspace computes no tier of its own");
{
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

console.log("5. Trust PRESENTED via the canonical envelope, not recomputed");
{
  check("no completeness recomputation in the workspace", !CODE.includes("buildLiquidityCompleteness"));
  // Trust converged onto the shared indicator over the SAME envelope the shell reads —
  // no hand-derived "≈" / amber reason line re-interpreting the lens. The inline caveat now
  // lives in the Hero (the lede), over the envelope prop the workspace hands it.
  check("trust caveat is the shared TrustIndicator (inline) over the envelope",
    HERO.includes('<TrustIndicator variant="inline"') && HERO.includes("envelope={envelope}"));
  // v2.7 visual-first — the embedded Accessible cash tile carries the SAME
  // classification.estimated "≈" marker the Hero always printed (presentation of
  // the FX-estimated flag, not a trust tier), beside the shared TrustIndicator.
  check("no bespoke hand-derived trust marker remains (workspace or Hero)",
    !CODE.includes("trust.reason") && !HERO.includes("trust.reason")
      && !/estimated \? "≈/.test(CODE.replace('const approx = classification.estimated ? "≈ " : "";', "")));
  check("the Accessible cash tile shows the shared TrustIndicator (compact + inline) over the figure's envelope",
    /data-accessible-cash[\s\S]{0,300}<TrustIndicator variant="compact" envelope=\{figureEnvelope\} \/>[\s\S]{0,1400}<TrustIndicator variant="inline" envelope=\{figureEnvelope\}/.test(CODE));
}

console.log("6. Net EXCLUDES credit (liquidity.core doctrine)");
{
  // DELIBERATE (owner, v2.7-P0 PR): the reconstructed tiers (which showed unused
  // credit separately and the contract's delta.net) are removed; the workspace now
  // states no credit figure and no net at all — so credit can never enter one.
  check("credit never enters a liquidity figure (no availableCredit read at all)", !CODE.includes("availableCredit"));
  check("no recomputed net (delta.net no longer rendered)", !CODE.includes("delta.net"));
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
  // DELIBERATE (owner, v2.7-P0 PR): the FX-basis note lived in the removed
  // reconstructed-tiers section; the converted historical endpoints now feed only
  // the verdict/trust (the adapter below stays the per-date authority).
  check("no orphaned FX-basis flag after the tiers removal", !CODE.includes("fxConverted"));
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
  // OVERVIEW-CONSOLIDATION — the workspace still resolves + emits its envelope
  // (optional callback: as the embedded Cash section it emits nothing upward,
  // the Assets page owns the ONE shell slot, and the section keeps its own
  // per-figure TrustIndicator).
  check("workspace emits the envelope via onEnvelopeChange (optional when embedded)", CODE.includes("onEnvelopeChange?.("));
  check("workspace reuses the canonical resolver", CODE.includes("resolvePerspectiveEnvelope("));
  check("host consumes the consolidated envelope in the shell chip", DASH.includes("activeEnvelope"));
  check("embedded in Assets, the Cash section does NOT emit to the shell (no onEnvelopeChange wired)",
    WEALTH.includes("<LiquidityWorkspace") && !/<LiquidityWorkspace[\s\S]*?onEnvelopeChange=/.test(WEALTH.slice(WEALTH.indexOf("<LiquidityWorkspace"), WEALTH.indexOf("<InvestmentsWorkspace"))));
  check("the Cash section keeps its own per-figure trust (LiquidityHero TrustIndicator)", strip(read(`${DIR}/LiquidityHero.tsx`)).includes("<TrustIndicator"));
  check("host relays the ONE envelope via useActiveEnvelope", DASH.includes("useActiveEnvelope"));
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

console.log("10. Host RELAYS — Liquidity renders as the CASH SECTION of Net Worth → Assets (OVERVIEW-CONSOLIDATION)");
{
  check("liquidity is no longer a peer renderer entry", !REND.includes("liquidity: (ctx)") && !REND.includes("<LiquidityWorkspace"));
  check("the Net Worth workspace embeds LiquidityWorkspace (embedded) as the Cash section",
    WEALTH.includes("<LiquidityWorkspace") && /<LiquidityWorkspace\s+embedded/.test(WEALTH) && WEALTH.includes('id="wealth-cash"'));
  check("embedded, the workspace publishes no sidebar sections of its own", CODE.includes("if (embedded) return;"));
  check("embedded, the workspace draws no second balance-history chart (the Assets chart slices to cashNow)",
    /\{!embedded && \([\s\S]*?<LiquidityBalanceHistory/.test(SRC));
  check("neither host nor renderer mounts LiquidityPerspective", !DASH.includes("<LiquidityPerspective") && !REND.includes("<LiquidityPerspective"));
  check("host dispatches via WORKSPACE_RENDERERS", DASH.includes("WORKSPACE_RENDERERS["));
}

console.log("11. Registry — liquidity stays temporal (temporalCapability PARTIAL, not a non-participation)");
{
  const cap = PERSPECTIVE_LIBRARY.liquidity?.temporalCapability;
  // PARTIAL asOf/compareTo — honest capability gap (Ladder temporal, per-account
  // panels current-anchor); NOT reclassified as non-temporal.
  check("liquidity temporalCapability is asOf/compareTo partial, period none",
    cap?.asOf === "partial" && cap?.compareTo === "partial" && cap?.period === "none");
  check("liquidity still participates in canonical shell time (derived consumesShellTime)",
    workspaceConsumesShellTime(PERSPECTIVE_LIBRARY.liquidity));
}

console.log("12. EDITORIAL REDESIGN — Hero / Balance History / Cash accounts (presentation only)");
{
  // ① Hero — present-day cashNow figure of record (from the accounts array, NOT the lens);
  //    the window delta rides the cashNow snapshot basis and is DROPPED when historical.
  // v2.6-L3 — the INTENT of this guard is "the figure of record comes from the
  // accounts array, not from the lens result", so the headline and the Sources
  // ledger below it can never disagree. That intent is unchanged; the figure is
  // now REACHABLE cash rather than the ledger sum, through the one canonical
  // authority both surfaces call. Asserting on `classification.totalLiquid`
  // pinned an implementation, not the invariant.
  check("workspace derives the cashNow figure of record from the ACCOUNTS array (not the lens)",
    CODE.includes("reachableNow(accounts") && CODE.includes("const cashNow = reach.total"));
  check("...through the canonical reachable authority, shared with the Sources ledger",
    CODE.includes('from "@/components/space/widgets/liquidity-adapters"'));
  // `classification.totalLiquid` survives in ONE place only: the basis-divergence
  // check that decides whether the window delta may be shown beside the headline.
  // It is a comparison, never the headline's value.
  check("the headline value is never the raw ledger sum",
    !CODE.includes("const cashNow = classification.totalLiquid") &&
    !CODE.includes("cashNow={classification.totalLiquid}"));
  check("the ledger sum survives only as the delta-basis comparison",
    (CODE.match(/classification\.totalLiquid/g) ?? []).length === 1 &&
    CODE.includes("deltaBasisDiffers"));
  check("Hero headline is passed in (presentation only — no sum in the Hero)",
    HERO.includes("cashNow") && !HERO.includes("classifyAccounts") && !HERO.includes("reduce("));
  check("Hero drops the window delta in a historical view (Debt precedent)",
    HERO.includes("!historical &&") && HERO.includes("DeltaBadge"));
  check("Hero SAYS balances are current in a historical view (no masquerade)",
    HERO.includes("Balances are current"));

  // TEMPORAL HONESTY — coverage is NEVER fabricated: it needs a real monthly-expense baseline.
  // v2.6-ASSESS-2 — this pinned the inline `monthlyExpenses == null` /
  // `cashNow / monthlyExpenses` spelling. The positive-or-refuse rule now belongs
  // to `resolveExpenseBaseline`, which also owns the precedence between a
  // DECLARED and a MEASURED baseline — the divergence that had the product and
  // the assessment engine dividing by different numbers. The invariant is
  // unchanged and is what is asserted now: no coverage without a resolved
  // baseline, and the divide uses what the authority returned.
  // v2.6-ASSESS-3 — the baseline now arrives ALREADY RESOLVED from the server.
  // The invariants are stronger than the ones these checks used to pin: coverage
  // still refuses without a baseline, and additionally NOTHING about which figure
  // wins — nor the measured average itself — may be computed in React.
  check("coverage is conditional on a RESOLVED baseline (no fabricated runway)",
    CODE.includes("if (!expenseBaseline || cashNow <= 0) return null;") &&
    CODE.includes("cashNow / expenseBaseline.amount"));
  check("the coverage assumption names WHICH baseline it used",
    HERO.includes("describeExpenseBaseline") && CODE.includes("basis:           expenseBaseline.basis"));

  // The workspace RENDERS a baseline; it never decides or derives one. A
  // `resolveExpenseBaseline` call here would mean the precedence is being applied
  // in two places, and `computeAverageMonthlySpending` would mean the measured
  // figure is being recomputed client-side from a population React cannot see.
  check("the workspace neither resolves nor derives the baseline",
    !CODE.includes("resolveExpenseBaseline(") &&
    !CODE.includes("computeAverageMonthlySpending") &&
    !CODE.includes("emergency_fund_progress"));

  // The host FETCHES the server-resolved baseline instead of reading the config
  // and calling it the only honest source — which is how the product came to show
  // no coverage at all on a corpus where nobody had declared a figure.
  check("host fetches the server-resolved baseline, lazily, and derives nothing",
    DASH.includes("liquidity/expense-baseline") &&
    DASH.includes("liquidityExpenseBaseline") &&
    !DASH.includes("config?.monthlyExpenses"));

  // ② Balance History — the SHARED TrendChart over the cashNow series, no liquidity look-alike.
  check("Balance History renders the shared TrendChart", HISTORY.includes("TrendChart"));
  check("Balance History plots the cashNow series (accessible cash), not a bespoke value",
    HISTORY.includes("value: p.cashNow"));
  check("cashNow series is the cash tier (totalCash + totalSavings) — no new authority",
    CASHHIST.includes("s.totalCash + s.totalSavings"));
  check("cash history drops fxMiss points (mixed-magnitude guard, Debt/Wealth semantics)",
    CASHHIST.includes("s.fxMiss !== true"));
  check("workspace clips the cash series from the host snapshots (NO new fetch)",
    CODE.includes("clipCashHistory(snapshots") && CODE.includes("convertCashHistory("));
  check("no second history fetch — only the one contract hook fetches",
    !CODE.includes("fetch(") && (CODE.match(/useLiquiditySpaceData\(/g) ?? []).length === 1);

  // ④⑤ Cash distribution + Cash accounts (v2.7 — replaces the Sources ledger).
  //  DELIBERATE: the Sources ledger's LeftPanel ("View all N sources") is gone on
  //  purpose — the owner requires the whole ledger visible, never behind a fold.
  //  The intents kept: generic Atlas panels (no domain panel primitive), and
  //  per-account detail through an EXISTING surface, present-day only.
  check("Cash accounts ledger composes the generic Atlas RightPanel",
    LEDGER.includes("RightPanel") && LEDGER.includes("@/components/atlas/panels"));
  check("the ledger is never folded behind a 'View all' disclosure",
    !LEDGER.includes("LeftPanel") && !LEDGER.includes("View all") && !LEDGER.includes("CompactDisclosure"));
  check("a row opens the EXISTING AccountDetail (no new detail surface, no new route)",
    LEDGER.includes("<AccountDetail") && LEDGER.includes("/api/spaces/${spaceId}/accounts/detail"));
  check("no domain panel primitive was created (no LiquidityPanel/Ledger/Detail primitive)",
    !LEDGER.includes("LiquidityPanel") && !LEDGER.includes("function LiquidityLedger") && !LEDGER.includes("function LiquidityDetail"));
  check("the donut reuses the shared BreakdownWidget, centred on TOTAL CASH",
    DISTRIB.includes("<BreakdownWidget") && DISTRIB.includes('label: "Total cash"'));
  check("historical: the distribution + ledger are labelled Current balances (never as-of)",
    (CODE.match(/Current balances/g) ?? []).length >= 1 && CODE.includes('{historical ? "Current balances" : "Total cash"}'));
  // DELIBERATE (owner): with the reconstructed tiers gone, a historical view shows
  // NO as-of per-account claim at all — the Current balances labels say so.
  check("historical: Cash distribution action reads Current balances (else Total cash)",
    CODE.includes('{historical ? "Current balances" : "Total cash"}'));
  // DELIBERATE (owner, v2.7 Cash layout): the ledger now lives INSIDE the Cash
  // distribution section, so that section's one label covers both.
  check("historical: the ledger sits inside the section whose label reads Current balances",
    CODE.indexOf('{historical ? "Current balances" : "Total cash"}') < CODE.indexOf("<CashAccountsLedger")
      && CODE.indexOf('id="liquidity-distribution"') < CODE.indexOf('id="liquidity-accounts"')
      && CODE.indexOf('id="liquidity-accounts"') < CODE.indexOf('id="liquidity-resilience"'));
}

if (failures > 0) { console.error(`\n${failures} LiquidityWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll LiquidityWorkspace checks passed");
