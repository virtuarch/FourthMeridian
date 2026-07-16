/**
 * components/space/widgets/investments/InvestmentsWorkspace.test.ts
 *
 * SD-4 / SD-4D+ source-scan ratchets for the Investments WORKSPACE (pure, DB-free).
 * Locks: composition + honesty; InvestmentsSpaceData activation (current vs historical,
 * never cross-derived); DATA OWNERSHIP (Workspace owns the fetch, host does not);
 * the envelope BRIDGE (Workspace emits, shell relays); display-currency conversion;
 * do-not-fake; allocation donut/dropdown; holdings top-5 + modal.
 *
 *   npx tsx components/space/widgets/investments/InvestmentsWorkspace.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = "components/space/widgets/investments";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const SRC   = read(`${DIR}/InvestmentsWorkspace.tsx`);
const CODE  = strip(SRC);
const KPI   = strip(read(`${DIR}/InvestmentKpiStrip.tsx`));
const HOOK  = read(`${DIR}/useInvestmentsSpaceData.ts`);
const ROUTE = read("app/api/spaces/[id]/investments/space-data/route.ts");
const ALLOC = strip(read(`${DIR}/InvestmentAllocationPanel.tsx`));
const HOLD  = strip(read(`${DIR}/InvestmentsHoldings.tsx`));
const CONV  = read("lib/investments/display-conversion.ts");
const HOSTC = strip(read("components/dashboard/SpaceDashboard.tsx"));

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("1. Composition + source order");
{
  check("root uses the 12-col grid, items-start", SRC.includes("lg:grid-cols-12") && SRC.includes("items-start") && !SRC.includes("items-stretch"));
  check("no fixed h-[…] / max-h-[…]", !SRC.includes("h-[") && !SRC.includes("max-h-["));
  const order = ["<InvestmentKpiStrip", "<InvestmentsHoldings", "<InvestmentAllocationPanel", "<InvestmentsActivityCard", "<InvestmentsBridgeCard", "<InvestmentConnectionsCard"];
  const mainIdx = SRC.indexOf("<InvestmentKpiStrip");
  const RET = mainIdx >= 0 ? SRC.slice(mainIdx) : "";
  const pos = order.map((n) => RET.indexOf(n));
  check("panels appear in the mandated source order", pos.every((p, i) => p >= 0 && (i === 0 || pos[i - 1] < p)), pos.join(","));
}

console.log("2. Data OWNERSHIP — the Workspace owns its data consumption (§1/§16)");
{
  check("Workspace owns the hook (calls useInvestmentsSpaceData)", CODE.includes("useInvestmentsSpaceData("));
  check("host NO LONGER calls useInvestmentsSpaceData", !HOSTC.includes("useInvestmentsSpaceData"));
  check("host retains NO Investments data (no investments.data reference)", !HOSTC.includes("investments.data"));
}

console.log("3. Envelope BRIDGE — Workspace emits, shell relays (no host fetch, no dup trust)");
{
  check("Workspace emits its envelope (onEnvelopeChange)", CODE.includes("onEnvelopeChange("));
  check("Workspace reuses the canonical resolver (no duplicated trust logic)", CODE.includes("resolvePerspectiveEnvelope("));
  check("envelope built from historical (currency-agnostic trust)", CODE.includes("raw?.historical"));
  check("host relays the Workspace envelope for investments", HOSTC.includes("investmentsEnvelope"));
  check("host state receives it (setInvestmentsEnvelope onEnvelopeChange)", HOSTC.includes("onEnvelopeChange={setInvestmentsEnvelope}"));
}

console.log("4. InvestmentsSpaceData activation — current vs historical, one composed contract");
{
  check("reads current + historical + activity + trust", CODE.includes("data.current") && CODE.includes("data.historical") && CODE.includes("data.activity") && CODE.includes("data.trust"));
  check("current↔historical primary selection (asOf < today)", CODE.includes("asOf < today"));
  check("no direct raw-loader call", !CODE.includes("getCurrentPositions") && !CODE.includes("getInvestmentsTimeMachine"));
  check("route serves the composed contract (loadInvestmentsSpaceData + history)", ROUTE.includes("loadInvestmentsSpaceData") && ROUTE.includes("history:"));
  check("hook honesty guards intact", HOOK.includes("compareTo < asOf") && HOOK.includes("if (!active) return") && !HOOK.includes("setData(null)"));
}

console.log("5. Display-currency (SD-4D) — pure transform, canonical facts untouched");
{
  check("Workspace applies convertInvestmentsSpaceData", CODE.includes("convertInvestmentsSpaceData("));
  check("Workspace threads a ConversionContext (ctx)", CODE.includes("ctx") && /ctx\?:/.test(SRC));
  // The transform reuses the ONE money authority and never mutates persisted facts.
  check("transform uses canonical convertMoney (no bespoke FX)", CONV.includes("convertMoney"));
  check("transform is identity when reporting === target (no relabel/masquerade)", CONV.includes("from === ctx.target") && CONV.includes("return data"));
  check("row conversion touches reportingValue only — native/costBasis NOT converted",
    CONV.includes("reportingValue:") && !CONV.includes("costBasis: c(") && !CONV.includes("nativePrice: c(") && !CONV.includes("nativeValue: c("));
}

console.log("6. DO NOT FAKE DATA — no fabricated metric rendered");
{
  const FORBIDDEN = ["IRR", "Sharpe", "S&P", "VTI", "Benchmark", "benchmark", "Best Month", "Worst Month", "Realized", "Unrealized", "Day Change", "Held since"];
  for (const t of FORBIDDEN) {
    check(`KPI does not render "${t}"`, !KPI.includes(t));
    check(`holdings does not render "${t}"`, !HOLD.includes(t));
  }
  check("income disclosed as combined (no dividends/interest split)", KPI.includes("combined"));
  // Cost-basis derived facts are labeled honestly ("Value vs cost", not a return claim).
  check("holdings uses honest 'Value vs cost' (not unrealized)", HOLD.includes("Value vs cost"));
}

console.log("7. KPI period semantics (§4)");
{
  check("Total Investment Value labeled as of asOf (point-in-time)", KPI.includes("As of ${asOf}"));
  check("Investment Income renamed (not 'Income Received')", KPI.includes("Investment Income") && !KPI.includes("Income Received"));
  check("period cards carry from → to labels", KPI.includes("→ ${activity.to}"));
}

console.log("8. Allocation — dropdown + shared donut (§10)");
{
  check("allocation uses a <select> dropdown (not SegmentedControl)", ALLOC.includes("<select") && !ALLOC.includes("SegmentedControl"));
  check("allocation reuses the shared BreakdownWidget donut", ALLOC.includes("BreakdownWidget") && ALLOC.includes('viewMode="donut"'));
}

console.log("9. Holdings — top 5 in card + full list in a modal (§5)");
{
  check("holdings caps the card at 5 (slice)", HOLD.includes("TOP_N = 5") && HOLD.includes("slice(0, TOP_N)"));
  check("holdings opens the full list in a GlassModal", HOLD.includes("GlassModal"));
  check("holding detail leads with investment facts then demotes evidence", HOLD.includes("Valuation evidence") && HOLD.includes("Cost basis"));
}

if (failures > 0) { console.error(`\n${failures} InvestmentsWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll InvestmentsWorkspace checks passed");
