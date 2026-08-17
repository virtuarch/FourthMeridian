/**
 * components/space/widgets/display-currency-fallback.test.ts
 *
 * REVIEW-3 B-5 (E5, matrix row 34) — THE WIDGET CURRENCY-FALLBACK RATCHET.
 *
 * With no ConversionContext, widget amounts pass through NATIVE and
 * unconverted (the deliberate kill-switch); the LABEL must obey the same
 * honesty rule as the number (`amount: null`, never a relabel). The two
 * banned shapes both asserted USD over native magnitudes:
 *
 *   1. `…target ?? DEFAULT_DISPLAY_CURRENCY`  — the ctx-fallback label
 *   2. `style: "currency", currency: DEFAULT_DISPLAY_CURRENCY` — the inline
 *      Intl USD-literal aggregate label
 *
 * Sanctioned replacements live in display-money.ts: `useAggregateCurrency`
 * (component bodies — the display-currency AUTHORITY as fallback) and
 * `formatAggregateMoney` (pure helpers — magnitude with NO currency claim).
 *
 * Itemized rows formatting in their own row `currency` are untouched by this
 * ratchet (per the lib/currency-context doctrine, itemized ≠ aggregate).
 *
 * Runtime proof lives beside it: buildCashFlowInsights and
 * buildPayoffScenarios label checks (payoff-scenarios.test.ts §6, and the
 * insight fmt checks below).
 *
 * Standalone tsx script:
 *   npx tsx components/space/widgets/display-currency-fallback.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCAN_DIR = path.join(ROOT, "components", "space", "widgets");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

console.log("REVIEW-3 — widget currency-fallback ratchet (components/space/widgets)\n");

const BANNED: Array<[string, RegExp]> = [
  ["`target ?? DEFAULT_DISPLAY_CURRENCY` (silent USD relabel of native amounts)",
    /target\s*\?\?\s*DEFAULT_DISPLAY_CURRENCY/],
  ["inline Intl USD-literal aggregate label",
    /style:\s*["']currency["']\s*,\s*currency:\s*DEFAULT_DISPLAY_CURRENCY/],
];

const files = collect(SCAN_DIR);
check("scan is not vacuous", files.length > 20, `saw ${files.length} files`);

for (const [label, re] of BANNED) {
  const offenders = files
    .filter((f) => re.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => path.relative(ROOT, f));
  check(`no widget carries ${label}`, offenders.length === 0, offenders.join(", "));
}

// The sanctioned authority module exists and exports both replacements.
const dm = readFileSync(path.join(SCAN_DIR, "display-money.ts"), "utf8");
check("display-money.ts exports useAggregateCurrency (hook fallback = the authority)",
  /export function useAggregateCurrency\b/.test(dm) && dm.includes("useDisplayCurrency()"));
check("display-money.ts exports formatAggregateMoney (no-context ⇒ no currency claim)",
  /export function formatAggregateMoney\b/.test(dm));

// ── Runtime spot-proofs (no relabel; correct label with a real target) ───────
void (async () => {
  const { formatAggregateMoney } = await import("./display-money");
  check("formatAggregateMoney labels the context target (EUR fixture)",
    formatAggregateMoney(1234, { target: "EUR" }) === "€1,234",
    formatAggregateMoney(1234, { target: "EUR" }));
  check("without a context the magnitude carries NO currency claim",
    formatAggregateMoney(1234) === "1,234",
    formatAggregateMoney(1234));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll widget currency-fallback checks passed");
})();
