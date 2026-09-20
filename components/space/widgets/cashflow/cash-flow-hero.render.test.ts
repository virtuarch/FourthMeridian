/**
 * components/space/widgets/cashflow/cash-flow-hero.render.test.ts
 *
 * Standalone tsx + renderToStaticMarkup (house pattern), exits 0/1.
 *
 *   npx tsx components/space/widgets/cashflow/cash-flow-hero.render.test.ts
 *
 * The Cash Flow Overview hero carries NO provenance / status badge — not the
 * clean one (Cash Flow's observed tier is toned "neutral", so the compact
 * TrustIndicator's silent-when-clean rule never reached it: it kept printing
 * "Complete within transaction depth"), and not an exceptional one either
 * (History-limited / Estimated / Incomplete / Unavailable, or an FX caveat chip).
 * PRESENTATION ONLY, and Cash Flow ONLY:
 *
 *   • the workspace still resolves the Cash Flow trust envelope and reports it
 *     UP (onEnvelopeChange), so the shell's ShellTrustRow keeps rendering the
 *     orthogonal FX / syncing caveats for Cash Flow;
 *   • the shared TrustIndicator is unchanged, and the other four Overview heroes
 *     still mount its compact variant (pinned in trust-indicator.render.test.ts).
 */

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CashFlowHero } from "./CashFlowHero";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import { ShellTrustRow } from "@/components/space/shell/ShellTrustRow";
import {
  COMPLETENESS_PRESENTATION,
  SYNC_INCOMPLETE_WARNING,
  resolvePerspectiveEnvelope,
  type PerspectiveEnvelope,
} from "@/lib/perspectives/envelope";
import type { CashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import type { DayFacts } from "@/lib/transactions/cash-flow-projection";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Only the liquidity Net (cashIn − cashOut) is read on this path.
const FACTS = { cashIn: 5000, cashOut: 3200 } as unknown as DayFacts;
const baseProps = {
  facts: FACTS,
  perspective: "liquidity" as const,
  filterId: "",
  onPerspectiveChange: () => {},
  currency: "USD",
  period: "PAST_MONTH" as never,
  asOf: "2026-09-20",
  change: null,
};
// `extra` force-feeds props the hero no longer declares (a stale caller passing an
// envelope must still produce no badge).
const renderHero = (extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(CashFlowHero as ComponentType<Record<string, unknown>>, { ...baseProps, ...extra }));

const stamp = (tier: CashFlowStamp["completeness"]["tier"], reason: string): CashFlowStamp =>
  ({ completeness: { tier, conflict: false, reason }, dataAsOf: "2026-09-19" });
const REASON = "The selected period reaches before your earliest transaction on file.";
const observedEnv = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", cashFlowStamp: stamp("observed", "") });
const exceptional: Array<[string, PerspectiveEnvelope]> = (["derived", "estimated", "incomplete", "unknown"] as const).map((t) => [
  t,
  resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", cashFlowStamp: stamp(t, REASON), fxUnconverted: true, syncIncomplete: true }),
]);

// Every string a provenance/status badge could put on the hero.
const BADGE_WORDS = [
  ...Object.values(COMPLETENESS_PRESENTATION).map((p) => p.label),
  "History-limited",
  "Complete within transaction depth",
  "Some balances excluded",
  SYNC_INCOMPLETE_WARNING[0].label,
  REASON,
];
const badgeWordsIn = (html: string) => BADGE_WORDS.filter((w) => text(html).includes(w));

console.log("1. The hero still renders its figures (the data path is untouched)");
{
  const t = text(renderHero());
  check("eyebrow", t.includes("Net cash flow"));
  check("Net headline = cashIn − cashOut, signed", t.includes("+$1,800"), t);
  check("as-of bridge line", t.includes("net cash this period") && t.includes("as of"));
  check("loading state renders an em dash, no badge", text(renderHero({ facts: null })).includes("—") && badgeWordsIn(renderHero({ facts: null })).length === 0);
}

console.log("2. Normal path — no 'Observed' (or any) badge on the Cash Flow hero");
{
  const html = renderHero();
  check("no provenance/status wording", badgeWordsIn(html).length === 0, badgeWordsIn(html).join(", "));
  check("no warning glyph / popover trigger in the hero", !/lucide-(alert|triangle|info|shield)/i.test(html) && !/aria-haspopup/.test(html));
  // Why Cash Flow still showed a badge on the NORMAL path: its observed tier is toned
  // "neutral" ("Complete within transaction depth"), and the compact TrustIndicator is
  // silent only on a "positive" tone — so the shared rule never silenced this hero.
  const wouldShow = text(renderToStaticMarkup(createElement(TrustIndicator, { envelope: observedEnv, variant: "compact" })));
  check("the clean Cash Flow envelope is one a compact TrustIndicator WOULD badge", wouldShow.includes("Complete within transaction depth"), wouldShow);
  check("…and the hero renders nothing for it, even when a stale caller passes it", renderHero({ envelope: observedEnv }) === html);
}

console.log("3. Exceptional Cash Flow envelope — still no hero badge");
for (const [t, env] of exceptional) {
  const shown = text(renderToStaticMarkup(createElement(TrustIndicator, { envelope: env, variant: "compact" })));
  check(`${t}: the envelope IS exceptional (a compact TrustIndicator would speak: "${env.completeness?.label}")`,
    shown.includes(env.completeness!.label) && shown.includes("2 caveats"), shown);
  const html = renderHero({ envelope: env });
  check(`${t}: hero renders no badge for it`, badgeWordsIn(html).length === 0, badgeWordsIn(html).join(", "));
  check(`${t}: hero markup is byte-identical to the clean render`, html === renderHero());
}

console.log("4. The caveats still surface for Cash Flow — in the shell row");
{
  const env = exceptional.find(([t]) => t === "incomplete")![1];
  const row = text(renderToStaticMarkup(createElement(ShellTrustRow, { envelope: env })));
  check("ShellTrustRow renders the FX exclusion caveat from the Cash Flow envelope", row.includes("Some balances excluded — no exchange rate"));
  check("ShellTrustRow renders the syncing caveat", row.includes(SYNC_INCOMPLETE_WARNING[0].label));
  check("ShellTrustRow stays silent with no warnings", renderToStaticMarkup(createElement(ShellTrustRow, { envelope: observedEnv })) === "");
  const SHELL = code(read("components/space/shell/PerspectiveShell.tsx"));
  check("the shell mounts ShellTrustRow on the ACTIVE envelope (every perspective, incl. Cash Flow)", SHELL.includes("<ShellTrustRow envelope={props.envelope}"));
}

console.log("5. Source — the badge is gone from the Cash Flow composition, and ONLY from it");
{
  const HERO = code(read("components/space/widgets/cashflow/CashFlowHero.tsx"));
  const WS = code(read("components/space/widgets/cashflow/CashFlowWorkspace.tsx"));
  check("CashFlowHero does not import or mount TrustIndicator", !HERO.includes("TrustIndicator"));
  check("CashFlowHero mounts no hand-rolled trust surface", !/CompletenessPopover|EvidenceDrawer|PerspectiveEnvelope|envelope/.test(HERO));
  const i = WS.indexOf("<CashFlowHero");
  const heroJsx = WS.slice(i, WS.indexOf("/>", i));
  check("the workspace no longer passes an envelope to the hero", i >= 0 && !heroJsx.includes("envelope"));
  check("the workspace mounts no TrustIndicator anywhere on the Cash Flow page", !WS.includes("TrustIndicator"));
  check("the workspace STILL resolves the Cash Flow envelope (stamp + FX exclusion)",
    WS.includes("cashFlowStamp(") && /resolvePerspectiveEnvelope\(\{ perspectiveId: "cashFlow", cashFlowStamp: stamp, fxUnconverted \}\)/.test(WS));
  check("…and STILL reports it up to the shell", /useEffect\(\(\) => \{ onEnvelopeChange\(envelope\); \}, \[envelope, onEnvelopeChange\]\)/.test(WS));
  check("…and the Insights caveat still reads the same stamp", WS.includes("stamp={stamp}"));
  for (const f of [
    "components/space/widgets/wealth/WealthHero.tsx",
    "components/space/widgets/debt/DebtHero.tsx",
    "components/space/widgets/liquidity/LiquidityHero.tsx",
    "components/space/widgets/investments/InvestmentsHero.tsx",
  ]) {
    check(`${f.split("/").pop()} keeps its compact TrustIndicator`, /<TrustIndicator variant="compact" envelope=\{envelope\}/.test(read(f)));
  }
}

if (failures > 0) { console.error(`\ncash-flow-hero: ${failures} failure(s).`); process.exit(1); }
console.log("\ncash-flow-hero: all passed.");
