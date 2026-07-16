/**
 * components/space/widgets/investments/InvestmentsWorkspace.test.ts
 *
 * SD-4 source-scan ratchets for the extracted Investments WORKSPACE (pure, DB-free,
 * no React render). They lock four things:
 *   1. the composition + honesty layout contract,
 *   2. the InvestmentsSpaceData activation (current → data.current [getCurrentPositions];
 *      historical → data.historical [A10]; never cross-derived),
 *   3. the "do not fake data" audit — no fabricated metric is rendered,
 *   4. the host wiring (host mounts <InvestmentsWorkspace>, drops the old perspective +
 *      A10-at-today hook, and feeds the shell envelope from data.historical).
 *
 *   npx tsx components/space/widgets/investments/InvestmentsWorkspace.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = "components/space/widgets/investments";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // drop comments before scanning

const SRC   = read(`${DIR}/InvestmentsWorkspace.tsx`);
const CODE  = strip(SRC);
const KPI   = strip(read(`${DIR}/InvestmentKpiStrip.tsx`));
const HOOK  = read(`${DIR}/useInvestmentsSpaceData.ts`);
const ROUTE = read("app/api/spaces/[id]/investments/space-data/route.ts");
const HOST  = read("components/dashboard/SpaceDashboard.tsx");
const HOSTC = strip(HOST);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) { const j = hay.indexOf(needle, i); if (j === -1) return n; n++; i = j + needle.length; }
}

console.log("1. Composition + overflow contract");
{
  check("root uses the 12-col grid", SRC.includes("lg:grid-cols-12"));
  check("items-start (content-defined panel heights)", SRC.includes("items-start") && !SRC.includes("items-stretch"));
  for (const s of ["lg:col-span-7 xl:col-span-8", "lg:col-span-5 xl:col-span-4"]) {
    check(`span "${s}" present`, SRC.includes(s));
  }
  check("min-w-0 guards (≥3)", count(SRC, "min-w-0") >= 3, `${count(SRC, "min-w-0")}`);
  check("no fixed h-[…] / max-h-[…] on panels", !SRC.includes("h-[") && !SRC.includes("max-h-["));
}

console.log("2. Source order = mobile stacking (KPI → Holdings → Allocation → Activity → Bridge → Connections)");
{
  const order = [
    "<InvestmentKpiStrip", "<InvestmentsHoldings", "<InvestmentAllocationPanel",
    "<InvestmentsActivityCard", "<InvestmentsBridgeCard", "<InvestmentConnectionsCard",
  ];
  // Anchor on the MAIN return (skip the empty-state grid that renders earlier).
  const mainIdx = SRC.indexOf("<InvestmentKpiStrip");
  const RET = mainIdx >= 0 ? SRC.slice(mainIdx) : "";
  const positions = order.map((n) => RET.indexOf(n));
  check("all composition anchors present", positions.every((p) => p >= 0), positions.join(","));
  check("panels appear in the mandated source order", positions.every((p, i) => i === 0 || positions[i - 1] < p), positions.join(","));
}

console.log("3. InvestmentsSpaceData ACTIVATION — current vs historical, never cross-derived");
{
  // Consumes the composed contract type-only (no server loader bundled).
  check("InvestmentsSpaceData imported via `import type`", /import type \{[^}]*InvestmentsSpaceData/.test(SRC));
  // Current view from data.current (getCurrentPositions); period/as-of from data.historical (A10).
  check("reads the CURRENT slice (data.current)", CODE.includes("data.current"));
  check("reads the HISTORICAL slice (data.historical)", CODE.includes("data.historical"));
  check("period activity + trust from the composed contract", CODE.includes("data.activity") && CODE.includes("data.trust"));
  // As-of in the past ⇒ historical is primary; else current. The selection exists.
  check("current↔historical primary selection (asOf < today)", CODE.includes("asOf < today"));
  // The workspace never reaches a raw authority itself — it reads ONE contract.
  check("no direct getCurrentPositions/getInvestmentsTimeMachine import", !CODE.includes("getCurrentPositions") && !CODE.includes("getInvestmentsTimeMachine"));
  check("no client-side allocation recompute import (computeAllocation)", !CODE.includes("computeAllocation"));
}

console.log("4. Activation route + hook");
{
  check("route serves the composed contract (loadInvestmentsSpaceData)", ROUTE.includes("loadInvestmentsSpaceData"));
  check("route requests the historical slice (history: { asOf, compareTo })", ROUTE.includes("history:"));
  check("route is membership-gated (VIEWER)", ROUTE.includes("requireSpaceRole") && ROUTE.includes("SpaceMemberRole.VIEWER"));
  // Hook honesty guards (same as the A10 hook it supersedes).
  check("hook: compareTo < asOf guard", HOOK.includes("compareTo < asOf"));
  check("hook: active-flag gate", HOOK.includes("if (!active) return"));
  check("hook: stale-response cancellation", HOOK.includes("alive = false"));
  check("hook: keeps last data on error (no blanking)", HOOK.includes("setError(true)") && !HOOK.includes("setData(null)"));
  check("hook: DTO type imported type-only", /import type \{[^}]*InvestmentsSpaceData/.test(HOOK));
}

console.log("5. DO NOT FAKE DATA — no fabricated metric is rendered");
{
  // None of these have a canonical source; the workspace/KPI must never display them.
  const FORBIDDEN = ["IRR", "Sharpe", "S&P", "VTI", "Benchmark", "benchmark", "Best Month", "Worst Month", "Realized", "Unrealized", "Day Change"];
  for (const term of FORBIDDEN) {
    check(`KPI strip does not render "${term}"`, !KPI.includes(term));
    check(`workspace does not render "${term}"`, !CODE.includes(term));
  }
  // Income is shown COMBINED — never split into a dividends-vs-interest breakdown
  // (the flow layer merges them; a split would be fabricated). The label discloses it.
  check("income label discloses it is combined", KPI.includes("combined") || KPI.includes("Combined"));
  // Trust label comes from the canonical summary, not a re-derived string.
  check("figure label sourced from canonical trust (data.trust.figureLabel)", CODE.includes("data.trust?.figureLabel") || CODE.includes("figureLabel"));
}

console.log("6. Host wiring — extraction landed, old paths retired");
{
  check("host mounts <InvestmentsWorkspace", HOSTC.includes("<InvestmentsWorkspace"));
  check("host dropped the old <InvestmentsPerspective", !HOSTC.includes("<InvestmentsPerspective"));
  check("host uses useInvestmentsSpaceData (activation)", HOSTC.includes("useInvestmentsSpaceData"));
  check("host dropped useInvestmentsTimeMachine (A10-at-today)", !HOSTC.includes("useInvestmentsTimeMachine"));
  check("shell envelope reads the historical slice (data?.historical)", HOSTC.includes("investments.data?.historical"));
}

if (failures > 0) { console.error(`\n${failures} InvestmentsWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll InvestmentsWorkspace checks passed");
