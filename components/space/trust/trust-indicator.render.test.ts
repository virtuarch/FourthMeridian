/**
 * components/space/trust/trust-indicator.render.test.ts
 *
 * Standalone tsx + renderToStaticMarkup (house pattern), exits 0/1.
 *
 *   npx tsx components/space/trust/trust-indicator.render.test.ts
 *
 * The Overview heroes (Net Worth, Debt, Liquidity, Investments) each render a
 * `compact` TrustIndicator beside their headline figure. (Cash Flow's hero mounts
 * none at all — see widgets/cashflow/cash-flow-hero.render.test.ts.) On the normal
 * path that was a second "Observed" badge under the shell's "Completeness
 * Observed" pill. Both are gone from the Overview. What must NOT go is a tier or
 * a caveat that changes how the figure should be read.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TrustIndicator } from "./TrustIndicator";
import { COMPLETENESS_PRESENTATION, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tier = (t: keyof typeof COMPLETENESS_PRESENTATION) => ({ tier: t, ...COMPLETENESS_PRESENTATION[t] });
const render = (envelope: PerspectiveEnvelope, variant: "compact" | "inline" | "expanded" = "compact") =>
  renderToStaticMarkup(createElement(TrustIndicator, { envelope, variant }));

console.log("1. The clean tier is silent on a hero");
check("compact + Observed ⇒ renders NOTHING (no child 'Observed' badge)", render({ completeness: tier("observed") }) === "");
check("…even with evidence attached (no 'N accounts' chip leaks in)",
  render({ completeness: tier("observed"), evidence: { label: "2 accounts", rows: [{ date: "2026-09-20", label: "Chase", tier: "observed" }] } }) === "");

console.log("2. A tier that changes how the figure reads still shows");
for (const t of ["derived", "estimated", "incomplete", "unknown"] as const) {
  check(`compact + ${COMPLETENESS_PRESENTATION[t].label} ⇒ shown`, text(render({ completeness: tier(t) })).includes(COMPLETENESS_PRESENTATION[t].label));
}

console.log("3. An orthogonal caveat still shows — without dragging 'Observed' back");
{
  const html = render({ completeness: tier("observed"), warnings: [{ kind: "fx", label: "FX rate unavailable" } as never] });
  check("the caveat renders", text(html).includes("FX rate unavailable"));
  check("the clean tier pill does not", !text(html).includes("Observed"));
}

console.log("4. The other variants are unchanged");
check("expanded still states the tier, clean or not", text(render({ completeness: tier("observed") }, "expanded")).includes("Observed"));
check("inline is still silent when clean, vocal when not",
  render({ completeness: tier("observed") }, "inline") === "" && text(render({ completeness: tier("estimated") }, "inline")).length > 0);

console.log("5. Every Overview hero that carries a badge uses the compact variant (so the rule reaches all of them)");
for (const f of [
  "components/space/widgets/wealth/WealthHero.tsx",
  "components/space/widgets/debt/DebtHero.tsx",
  "components/space/widgets/liquidity/LiquidityHero.tsx",
  "components/space/widgets/investments/InvestmentsHero.tsx",
]) {
  check(f.split("/").pop()!, /<TrustIndicator variant="compact" envelope=\{envelope\}/.test(readFileSync(path.join(process.cwd(), f), "utf8")));
}
// Cash Flow is the deliberate exception: its hero mounts NO badge, for any tier. Its
// caveats still surface in the shell's ShellTrustRow, off the envelope the workspace
// reports up.
check("CashFlowHero.tsx mounts no TrustIndicator",
  !/<TrustIndicator\b/.test(readFileSync(path.join(process.cwd(), "components/space/widgets/cashflow/CashFlowHero.tsx"), "utf8")));

if (failures > 0) { console.error(`\ntrust-indicator: ${failures} failure(s).`); process.exit(1); }
console.log("\ntrust-indicator: all passed.");
