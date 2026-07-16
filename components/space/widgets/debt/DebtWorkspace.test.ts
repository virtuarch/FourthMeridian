/**
 * components/space/widgets/debt/DebtWorkspace.test.ts
 *
 * SD-6A durable-invariant ratchets for the Debt WORKSPACE (pure, DB-free — house
 * pattern). TEST-3 cleanup: brittle layout/JSX-order/prop-spelling/composition-once
 * pins removed; the durable extraction + DebtSpaceData-activation invariants kept:
 *
 *   1. WORKSPACE BOUNDARY: owns useDebtSpaceData; consumes DebtSpaceData
 *      (data.lens / data.history / data.completeness / data.fico); no local time
 *      authority; no raw as-of loader import; no cross-workspace imports.
 *   2. TEMPORAL activation: history comes pre-clipped from the contract (workspace
 *      never clips inline); the hook composes via assembleDebtSpaceData, fetches the
 *      lens AT asOf, and keeps the last lens on error (honesty).
 *   3. DUAL AUTHORITY: the lens is prose-only; every VISIBLE FIGURE stays sourced
 *      from the accounts array (KPIs / bars / payoff / signals), never the lens.
 *   4. Completeness PRESENTED, not recomputed.
 *   5. FICO passthrough via the contract.
 *   6. FX ownership: the Balance-Over-Time slice is converted via the canonical
 *      convertDebtHistory through the ONE money authority (no bespoke inline FX).
 *   7. Route serves the debt lens AT asOf (perspective:read gate; single authority —
 *      no compose/clip).
 *   8. Host RELAYS: mounts <DebtWorkspace> as the debt destination's renderer and
 *      dropped <DebtPerspective>.
 *   9. Envelope OWNERSHIP: the workspace resolves + emits its own trust envelope; the
 *      host merely relays debtEnvelope.
 *
 *   npx tsx components/space/widgets/debt/DebtWorkspace.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = "components/space/widgets/debt";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const SRC   = read(`${DIR}/DebtWorkspace.tsx`);
const CODE  = strip(SRC);
const HOOK  = read(`${DIR}/useDebtSpaceData.ts`);
const HOOKC = strip(HOOK);
const PANEL = strip(read(`${DIR}/DebtHistoryPanel.tsx`));
const ROUTE = read("app/api/spaces/[id]/debt/space-data/route.ts");
const ROUTEC = strip(ROUTE);
const DASH  = strip(read("components/dashboard/SpaceDashboard.tsx"));

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("1. WORKSPACE BOUNDARY — owns the data, consumes the contract, no local time state");
{
  check("Workspace owns the hook (calls useDebtSpaceData)", CODE.includes("useDebtSpaceData("));
  check("Workspace consumes DebtSpaceData.lens", CODE.includes("data.lens"));
  check("Workspace consumes DebtSpaceData.history", CODE.includes("data.history"));
  check("Workspace consumes DebtSpaceData.completeness", CODE.includes("data.completeness"));
  check("Workspace consumes DebtSpaceData.fico", CODE.includes("data.fico"));
  // No LOCAL time model — asOf/compareTo are shell props threaded into the hook.
  check("no usePerspectiveShellState (no duplicate time authority)", !CODE.includes("usePerspectiveShellState"));
  check("no local as-of loader import", !CODE.includes("getAccountsAsOf") && !CODE.includes("accounts-asof"));
  check("no cross-workspace imports", !CODE.includes("components/space/widgets/wealth/") &&
    !CODE.includes("components/space/widgets/cashflow/") && !CODE.includes("components/space/widgets/liquidity/"));
}

console.log("2. TEMPORAL activation — history pre-clipped by the contract, lens AT asOf, honesty");
{
  // The Balance-Over-Time slice is derived from data.history via the canonical FX
  // transform; the workspace never clips/filters/blends inline (that is the contract's job).
  check("converted slice derives from data.history via convertDebtHistory", CODE.includes("convertDebtHistory("));
  check("workspace does not clip history itself (no inline fxMiss/filter)", !CODE.includes("fxMiss") && !CODE.includes(".filter("));
  // The hook composes via the pure contract and threads BOTH bounds.
  check("hook composes via assembleDebtSpaceData", HOOKC.includes("assembleDebtSpaceData("));
  check("hook threads asOf + compareTo into the contract", HOOKC.includes("asOf,") && HOOKC.includes("compareTo,"));
  check("hook fetches the lens AT asOf (space-data route, asOf param)", HOOKC.includes("/debt/space-data") && HOOKC.includes("asOf"));
  check("hook is historical-gated (asOf < today ⇒ fetch; present ⇒ host lens)",
    HOOKC.includes("asOf < today") && HOOKC.includes("presentLens"));
  check("hook honesty: keeps last lens on error (no setAsOfLens(null) on catch)",
    HOOKC.includes("setError(true)") && !/catch[\s\S]*setAsOfLens\(null\)/.test(HOOKC));
  // The presenter consumes a pre-clipped slice type (not a raw Snapshot[]).
  check("DebtHistoryPanel consumes DebtHistorySlice (not Snapshot[])", PANEL.includes("DebtHistorySlice"));
}

console.log("3. DUAL AUTHORITY — lens is prose-only; visible figures come from accounts");
{
  // KPI band + bars + payoff + signals are all sourced from the accounts array.
  check("KPI strip sourced from accounts (not the lens)", SRC.includes("<DebtKpiStrip accounts={accounts}"));
  check("payoff aggregate sourced from accounts", CODE.includes("computePayoffAggregate(accounts"));
  check("debt-by-account sourced from accounts", SRC.includes("renderDebtByAccount(accounts"));
  check("signals fed the lens only as context (lensResult:), figures from accounts",
    CODE.includes("buildDebtSignals({ accounts") && CODE.includes("lensResult: lens"));
  // The lede is the ONLY lens consumer, and only its verdict SENTENCE (prose).
  check("lede reads only lens.verdict/provenance (prose), never a lens figure of record",
    CODE.includes("lens.verdict") && !CODE.includes("lens.headline") && !CODE.includes("lens.metrics"));
  check("lede gated on status === \"ok\"", CODE.includes('lens.status !== "ok"'));
}

console.log("4. Completeness PRESENTED, not recomputed");
{
  check("no completeness recomputation in the workspace", !CODE.includes("buildDebtCompleteness"));
  check("completeness reason is presented", CODE.includes("completeness.reason"));
}

console.log("5. FICO passthrough via the contract");
{
  check("FICO rendered from the contract passthrough (data.fico)", CODE.includes("renderCreditScore(data.fico"));
}

console.log("6. FX ownership — history converted via the canonical transform, ONE money authority");
{
  check("history FX-converted via the canonical convertDebtHistory", CODE.includes("convertDebtHistory("));
  check("no bespoke inline FX in the workspace (delegates to convertDebtHistory)", !CODE.includes("convertMoney"));
  check("convertDebtHistory itself uses the ONE money authority", strip(read("lib/debt/display-conversion.ts")).includes("convertMoney("));
  check("workspace threads a ConversionContext (no second rate source)", CODE.includes("ConversionContext"));
  check("history presenter formats via ConversionContext (no second convertMoney)", PANEL.includes("formatCurrency") && !PANEL.includes("convertMoney"));
}

console.log("7. Route serves the debt lens AT asOf (authz-gated single authority)");
{
  check("route computes a single lens AT asOf", ROUTE.includes('computePerspective(') && ROUTE.includes('"debt"') && ROUTE.includes("asOf"));
  check("route is membership-gated (perspective:read)", ROUTE.includes("perspective:read"));
  check("route registers the debt lens (side-effect import)", ROUTE.includes("lenses/debt"));
  // Scan STRIPPED code (not prose): the route must not compose or clip — that is the
  // pure contract's job, run client-side in the hook.
  check("route computes NOTHING else (no compose / clip in code)",
    !ROUTEC.includes("assembleDebtSpaceData") && !ROUTEC.includes("clipDebtHistory") && !ROUTEC.includes("DebtHistorySlice"));
}

console.log("8. Host RELAYS — mounts <DebtWorkspace> as the debt renderer, dropped <DebtPerspective>");
{
  check("host mounts DebtWorkspace (the debt destination's renderer)", DASH.includes("<DebtWorkspace"));
  check("host no longer mounts DebtPerspective", !DASH.includes("<DebtPerspective"));
}

console.log("9. Envelope OWNERSHIP — workspace resolves + emits its own trust envelope; host relays");
{
  check("workspace emits via onEnvelopeChange", CODE.includes("onEnvelopeChange("));
  check("envelope resolved from the on-screen lens via the canonical resolver",
    CODE.includes("resolvePerspectiveEnvelope(") && CODE.includes('perspectiveId: "debt"'));
  check("host declares + relays debtEnvelope state", DASH.includes("setDebtEnvelope") && DASH.includes("debtEnvelope"));
  check("host no longer resolves debt's chip envelope inline (relays state)",
    DASH.includes('activePerspectiveId === "debt"') && DASH.includes("? debtEnvelope"));
}

if (failures > 0) { console.error(`\n${failures} DebtWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll DebtWorkspace checks passed");
