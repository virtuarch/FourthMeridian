/**
 * components/space/widgets/investments/InvestmentsPerspective.test.ts
 *
 * Source-scan tests for the Investments Perspective composition (house pattern —
 * pure, DB-free, no React render). These lock the layout + honesty contract from
 * the redesign plan §7 without mounting anything.
 *
 *   npx tsx components/space/widgets/investments/InvestmentsPerspective.test.ts
 *
 * COVERAGE NOTE — this suite runs while the SpaceDashboard host wiring is
 * DEFERRED (a concurrent Liquidity redesign owns SpaceDashboard.tsx on primary).
 * So plan §7 check 6 (the `SpaceDashboard` investments-branch scan) is
 * intentionally NOT asserted here; it lands with the host wiring. Everything the
 * new components can be exercised on WITHOUT being mounted — checks 1–5 — is
 * asserted now. This file must NOT read SpaceDashboard.tsx (the branch it would
 * scan for does not exist yet by design).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = "components/space/widgets/investments";
const SRC = readFileSync(path.join(ROOT, DIR, "InvestmentsPerspective.tsx"), "utf8");
const HOLD = readFileSync(path.join(ROOT, DIR, "InvestmentsHoldings.tsx"), "utf8");
const HOOK = readFileSync(path.join(ROOT, DIR, "useInvestmentsTimeMachine.ts"), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) { const j = hay.indexOf(needle, i); if (j === -1) return n; n++; i = j + needle.length; }
}

console.log("1. Grid + span + overflow contract (plan §3.3, §7.1)");
{
  check("root uses the 12-col grid", SRC.includes("lg:grid-cols-12"));
  check("items-start (Wealth's choice, not items-stretch)", SRC.includes("items-start") && !SRC.includes("items-stretch"));
  const spans = ["lg:col-span-12", "lg:col-span-7 xl:col-span-8", "lg:col-span-5 xl:col-span-4"];
  for (const s of spans) check(`span "${s}" present`, SRC.includes(s));
  check("min-w-0 on every column + the panel (≥4)", count(SRC, "min-w-0") >= 4, `${count(SRC, "min-w-0")}`);
  check("no fixed h-[…] on panels", !SRC.includes("h-["));
  check("no max-h-[…] on panels", !SRC.includes("max-h-["));
}

console.log("2. Source order = mobile stacking order (Header → Holdings → Activity → Bridge → Connections)");
{
  // Anchor on the MAIN grid (the empty-state grid renders earlier and is skipped).
  const gridIdx = SRC.lastIndexOf('grid grid-cols-1 lg:grid-cols-12');
  const RET = gridIdx >= 0 ? SRC.slice(gridIdx) : "";
  const order = ["<PortfolioHeader", "<InvestmentsHoldings", "<InvestmentsActivityCard", "<InvestmentsBridgeCard", "<InvestmentConnectionsCard"];
  const positions = order.map((n) => RET.indexOf(n));
  check("all order anchors present in the main grid", positions.every((p) => p >= 0), positions.join(","));
  check("panels appear in the mandated source order", positions.every((p, i) => i === 0 || positions[i - 1] < p), positions.join(","));
}

console.log("3. No forbidden imports; DTO type imported type-only (plan §7.3)");
{
  check("no import of usePerspectiveShellState (time stays host-owned)", !SRC.includes("usePerspectiveShellState"));
  check("no import from the Wealth workspace", !SRC.includes("components/space/widgets/wealth/"));
  check("no import from the Cash Flow workspace", !SRC.includes("components/space/widgets/cashflow/"));
  // The DTO type never arrives via a value import (would bundle the pure core).
  check("InvestmentsTimeMachineResult imported via `import type`", /import type \{[^}]*InvestmentsTimeMachineResult/.test(SRC));
  check("no value import of investments-time-machine-core", !/import \{[^}]*\} from "@\/lib\/investments\/investments-time-machine-core"/.test(SRC));
  check("holdings imports ValuedHoldingRow via `import type`", /import type \{[^}]*ValuedHoldingRow/.test(HOLD));
}

console.log("4. Unvalued handling present; partial-subtotal label branch exists (plan §7.4)");
{
  // Holdings iterates the full holdings[] and never filters out unvalued rows.
  check("holdings maps the full result set", HOLD.includes(".map("));
  check("unvalued rows detected via reportingValue == null", HOLD.includes("reportingValue == null"));
  check("holdings never filters rows out", !HOLD.includes(".filter("));
  // The pixel rule (partial subtotal labelled, never presented as the total)
  // now lives in the canonical Activity + Trust summary (PCS-1C): the header
  // consumes buildInvestmentsTrustSummary().figureLabel instead of re-deriving
  // the "Valued holdings" branch inline. The branch itself is pinned in
  // lib/investments/investments-trust.test.ts.
  check("delegates the partial-subtotal label to the canonical Trust summary",
    SRC.includes("buildInvestmentsTrustSummary") && SRC.includes("trust.figureLabel"));
  check("unvalued positions surfaced (unvaluedCount referenced)", SRC.includes("portfolio.unvaluedCount"));
}

console.log("5. Hook honesty guards (plan §7.5, §3.5)");
{
  check("compareTo < asOf guard present", HOOK.includes("compareTo < asOf"));
  check("active-flag gate present", HOOK.includes("if (!active) return"));
  check("stale-response cancellation present", HOOK.includes("alive = false"));
  check("keeps last result on error (no blanking)", HOOK.includes("setError(true)") && !HOOK.includes("setResult(null)"));
  check("DTO type imported type-only", /import type \{[^}]*InvestmentsTimeMachineResult/.test(HOOK));
}

if (failures > 0) { console.error(`\n${failures} InvestmentsPerspective check(s) failed`); process.exit(1); }
console.log("\nAll InvestmentsPerspective checks passed");
