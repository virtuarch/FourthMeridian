/**
 * components/space/widgets/debt/DebtWorkspace.test.ts
 *
 * SD-6A source-scan ratchets for the Debt WORKSPACE (pure, DB-free — house pattern).
 * Locks the extraction + the DebtSpaceData activation:
 *
 *   1. Composition: the seven mounted widgets/presenters + KPI band, once each.
 *   2. Grid + span pairs + min-w-0 + no fixed height (layout preserved).
 *   3. Source order (= mobile stacking).
 *   4. WORKSPACE BOUNDARY: owns useDebtSpaceData; consumes DebtSpaceData
 *      (data.lens / data.history / data.completeness / data.fico); no local time
 *      state; no raw as-of loader import.
 *   5. TEMPORAL activation: Balance Over Time renders the CLIPPED data.history slice
 *      (not raw snapshots); the contract clips to [compareTo, asOf]; the hook fetches
 *      the lens AT asOf, present-day reuses the host lens (byte-identical).
 *   6. DUAL AUTHORITY: the lens is prose-only; every VISIBLE FIGURE stays sourced
 *      from the accounts array (KPIs / bars / payoff / signals), never the lens.
 *   7. Completeness PRESENTED, not recomputed (pointer to lens.completeness).
 *   8. FICO passthrough via the contract.
 *   9. FX ACTIVATED (SD-6 gate): the Balance-Over-Time slice is converted per-date via
 *      the canonical convertDebtHistory (identity when display == reporting).
 *  10. Route serves the debt lens AT asOf (perspective:read gate, computePerspective).
 *  11. Host wiring: mounts <DebtWorkspace once with asOf/compareTo/today/presentLens;
 *      dropped <DebtPerspective.
 *  12. Envelope OWNERSHIP (SD-6 gate): the workspace emits its own trust envelope
 *      (on-screen lens, as-of OR present-day); the host merely relays debtEnvelope.
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
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j === -1) return n;
    n++; i = j + needle.length;
  }
}

console.log("1. Composition — the seven mounted widgets/presenters + KPI band, once each");
{
  const mounts: [string, string][] = [
    ["Debt by Account", "renderDebtByAccount("],
    ["Interest Cost", "renderDebtCost("],
    ["Credit Utilization", "<CreditUtilizationWidget"],
    ["Balance Over Time (S3 presenter)", "<DebtHistoryPanel"],
    ["Payoff Planner", "renderDebtPayoffCalculator("],
    ["Credit Score (FICO)", "renderCreditScore("],
    ["Complete Debt Details", "renderDebtCompleteInfo("],
  ];
  for (const [label, needle] of mounts) {
    check(`${label} mounted exactly once`, count(SRC, needle) === 1, `${count(SRC, needle)} occurrence(s)`);
  }
  check("registry renderDebtHistory is not remounted", count(SRC, "renderDebtHistory(") === 0);
  check("renderDebtPayoffSnapshot is not remounted", count(SRC, "renderDebtPayoffSnapshot(") === 0);
  check("DebtKpiStrip mounted exactly once", count(SRC, "<DebtKpiStrip") === 1);
}

console.log("2. Grid + span + overflow contract (layout preserved)");
{
  check("root uses the 12-col grid", SRC.includes("lg:grid-cols-12"));
  check("items-stretch balances rows", SRC.includes("items-stretch"));
  const spans = [
    "lg:col-span-12",
    "lg:col-span-7 xl:col-span-8",
    "lg:col-span-5 xl:col-span-4",
    "lg:col-span-6 xl:col-span-7",
    "lg:col-span-6 xl:col-span-5",
  ];
  for (const s of spans) check(`span "${s}" present`, SRC.includes(s));
  check("min-w-0 appears on every column + the panel (≥9)", count(SRC, "min-w-0") >= 9, `${count(SRC, "min-w-0")}`);
  check("no fixed h-[…] on panels", !SRC.includes("h-["));
  check("no max-h-[…] on panels", !SRC.includes("max-h-["));
}

console.log("3. Source order = mobile stacking order");
{
  const gridIdx = SRC.indexOf("grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch");
  const RET = gridIdx >= 0 ? SRC.slice(gridIdx) : "";
  const order = [
    "renderLede(",
    "<DebtKpiStrip",
    "<DebtHistoryPanel",
    "<CreditUtilizationWidget",
    "renderDebtCost(",
    "renderDebtByAccount(",
    "renderDebtPayoffCalculator(",
    "renderCreditScore(",
    "renderDebtCompleteInfo(",
  ];
  const positions = order.map((n) => RET.indexOf(n));
  check("all order anchors present", positions.every((p) => p >= 0), positions.join(","));
  check("panels appear in the mandated source order", positions.every((p, i) => i === 0 || positions[i - 1] < p), positions.join(","));
}

console.log("4. WORKSPACE BOUNDARY — owns the data, consumes the contract, no local time state");
{
  check("Workspace owns the hook (calls useDebtSpaceData)", CODE.includes("useDebtSpaceData("));
  check("Workspace consumes DebtSpaceData.lens", CODE.includes("data.lens"));
  check("Workspace consumes DebtSpaceData.history", CODE.includes("data.history"));
  check("Workspace consumes DebtSpaceData.completeness", CODE.includes("data.completeness"));
  check("Workspace consumes DebtSpaceData.fico", CODE.includes("data.fico"));
  // No LOCAL time model — asOf/compareTo are shell props threaded into the hook,
  // never owned here (no shell-state hook, no useState around dates).
  check("no usePerspectiveShellState (no duplicate time authority)", !CODE.includes("usePerspectiveShellState"));
  check("no local as-of loader import", !CODE.includes("getAccountsAsOf") && !CODE.includes("accounts-asof"));
  check("no cross-workspace imports", !CODE.includes("components/space/widgets/wealth/") &&
    !CODE.includes("components/space/widgets/cashflow/") && !CODE.includes("components/space/widgets/liquidity/"));
}

console.log("5. TEMPORAL activation — clipped history [compareTo, asOf], lens AT asOf");
{
  // The Balance-Over-Time panel renders the CLIPPED + FX-converted slice, not the raw
  // snapshot array (the SD-6 gate added the per-date display-currency pass; §9).
  check("history panel is fed the converted clipped slice", SRC.includes("history={history}"));
  check("converted slice derives from data.history via convertDebtHistory", CODE.includes("convertDebtHistory(data.history"));
  check("history panel is NOT fed the raw snapshots array", !SRC.includes("snapshots={snapshots}") && !SRC.includes("<DebtHistoryPanel snapshots"));
  // The clip is the pure contract's job — the workspace never clips inline.
  check("workspace does not clip history itself (no inline fxMiss/filter)", !CODE.includes("fxMiss") && !CODE.includes(".filter("));
  // The hook composes via the pure contract and threads BOTH bounds.
  check("hook composes via assembleDebtSpaceData", HOOKC.includes("assembleDebtSpaceData("));
  check("hook threads asOf + compareTo into the contract", HOOKC.includes("asOf,") && HOOKC.includes("compareTo,"));
  check("hook fetches the lens AT asOf (space-data route, asOf param)", HOOKC.includes("/debt/space-data") && HOOKC.includes("asOf"));
  check("hook is historical-gated (asOf < today ⇒ fetch; present ⇒ host lens)",
    HOOKC.includes("asOf < today") && HOOKC.includes("presentLens"));
  check("hook honesty: keeps last lens on error (no setAsOfLens(null) on catch)",
    HOOKC.includes("setError(true)") && !/catch[\s\S]*setAsOfLens\(null\)/.test(HOOKC));
  // The presenter no longer owns clipping — it reads a pre-clipped slice.
  check("DebtHistoryPanel consumes DebtHistorySlice (not Snapshot[])",
    PANEL.includes("DebtHistorySlice") && PANEL.includes("history?.points"));
}

console.log("6. DUAL AUTHORITY — lens is prose-only; visible figures come from accounts");
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

console.log("7. Completeness PRESENTED, not recomputed");
{
  // The workspace presents data.completeness; it never builds a completeness envelope.
  check("no completeness recomputation in the workspace", !CODE.includes("buildDebtCompleteness"));
  // assembleDebtSpaceData re-surfaces lens.completeness as a POINTER (pinned in lib/debt-space-data.test.ts).
  check("completeness reason is presented", CODE.includes("completeness.reason"));
}

console.log("8. FICO passthrough via the contract");
{
  check("FICO rendered from the contract passthrough (data.fico)", CODE.includes("renderCreditScore(data.fico.score"));
}

console.log("9. FX ACTIVATED — history converted per-date via the canonical transform (SD-6 gate)");
{
  // The SD-6 integration gate closed the last symbol-only relabel: the Balance-Over-
  // Time slice (snapshot-currency) is now converted per-date into the display currency
  // through the ONE money authority, matching the KPI strip beside it. Identity when
  // display == reporting (byte-unchanged).
  check("history FX-converted via the canonical convertDebtHistory", CODE.includes("convertDebtHistory(data.history, ctx)"));
  check("no bespoke inline FX in the workspace (delegates to convertDebtHistory)", !CODE.includes("convertMoney"));
  check("convertDebtHistory itself uses the ONE money authority", strip(read("lib/debt/display-conversion.ts")).includes("convertMoney("));
  check("ctx still threaded into the KPI/adapter panels", /ctx=\{ctx\}/.test(SRC) && CODE.includes("ConversionContext"));
  check("history presenter formats via ConversionContext (no second convertMoney)", PANEL.includes("formatCurrency") && !PANEL.includes("convertMoney"));
}

console.log("10. Route serves the debt lens AT asOf");
{
  check("route computes a single lens AT asOf", ROUTE.includes('computePerspective(') && ROUTE.includes('"debt"') && ROUTE.includes("asOf"));
  check("route is membership-gated (perspective:read)", ROUTE.includes("perspective:read"));
  check("route registers the debt lens (side-effect import)", ROUTE.includes("lenses/debt"));
  // Scan STRIPPED code (not prose): the route must not compose or clip — that is
  // the pure contract's job, run client-side in the hook.
  check("route computes NOTHING else (no compose / clip in code)",
    !ROUTEC.includes("assembleDebtSpaceData") && !ROUTEC.includes("clipDebtHistory") && !ROUTEC.includes("DebtHistorySlice"));
}

console.log("11. Host wiring — mounts <DebtWorkspace, dropped <DebtPerspective");
{
  check("host mounts DebtWorkspace exactly once", count(DASH, "<DebtWorkspace") === 1, `${count(DASH, "<DebtWorkspace")}`);
  check("host no longer mounts DebtPerspective", !DASH.includes("<DebtPerspective"));
  const jsxStart = DASH.indexOf("<DebtWorkspace");
  const jsxEnd = DASH.indexOf("/>", jsxStart);
  const jsx = jsxStart >= 0 && jsxEnd >= 0 ? DASH.slice(jsxStart, jsxEnd) : "";
  for (const prop of ["asOf=", "compareTo=", "today=", "active=", "accounts=", "ctx=", "snapshots=", "snapshotCurrency=", "presentLens=", "onEnvelopeChange="]) {
    check(`mount passes ${prop.replace("=", "")}`, jsx.includes(prop));
  }
  const genericIdx = DASH.indexOf("toVirtualSections(activePerspective.id");
  check("debt branch precedes the generic virtual-sections branch", jsxStart >= 0 && genericIdx > jsxStart);
}

console.log("12. Envelope OWNERSHIP — workspace emits its own trust envelope (SD-6 gate)");
{
  // The workspace resolves the on-screen lens (as-of when historical, else present-day)
  // through the ONE canonical resolver and emits it up — so the shell chip is honest
  // for the SELECTED date instead of stuck on present state. The host merely relays it.
  check("workspace emits via onEnvelopeChange", CODE.includes("onEnvelopeChange("));
  check("envelope resolved from the on-screen lens", CODE.includes('resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: lens })'));
  check("host declares + relays debtEnvelope state", DASH.includes("setDebtEnvelope") && DASH.includes("debtEnvelope"));
  check("host no longer resolves debt's chip envelope inline (relays state)",
    DASH.includes('activePerspectiveId === "debt"') && DASH.includes("? debtEnvelope"));
}

if (failures > 0) { console.error(`\n${failures} DebtWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll DebtWorkspace checks passed");
