/**
 * lib/money/reporting-currency-failure-contract.test.ts — V25-CLOSE-3A
 *
 * Source-scan guards for the reporting-currency failure contract:
 *   - PERSISTENCE: the display-time fallback NEVER writes Space.reportingCurrency.
 *   - CANONICAL PATH: the decision lives in ONE resolver, adopted by the shared
 *     display readers — not re-implemented per perspective.
 *   - UI: the banner renders iff `reverted`, at the composition root.
 *
 *     npx tsx lib/money/reporting-currency-failure-contract.test.ts
 */

import { readFileSync } from "fs";
import { join } from "path";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

// ── PERSISTENCE — the fallback is read-time only ─────────────────────────────
// No display reader that resolves the effective currency may write reportingCurrency.
const READ_SIDE = [
  "lib/money/server-context.ts",
  "lib/data/snapshots.ts",
  "app/api/money/view-context/route.ts",
  "app/api/spaces/[id]/transactions/route.ts",
];
for (const f of READ_SIDE) {
  const code = stripComments(read(f));
  check(
    `${f} never writes reportingCurrency (display-time fallback is non-destructive)`,
    !/reportingCurrency\s*:/.test(codeWrites(code)),
    "a display reader is assigning reportingCurrency — the fallback must not persist",
  );
}
/** Restrict to obvious Prisma write shapes so a `select: { reportingCurrency: true }` read never trips. */
function codeWrites(code: string): string {
  // Keep only text inside data:{...} update/create payloads (heuristic: after `data:`).
  const out: string[] = [];
  const re = /\bdata\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 0, i = code.indexOf("{", m.index);
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) { out.push(code.slice(m.index, i + 1)); break; }
    }
  }
  return out.join("\n");
}

// The ONLY writer of Space.reportingCurrency is the explicit PATCH route.
{
  const patch = stripComments(read("app/api/spaces/[id]/route.ts"));
  check(
    "the persisted currency is written ONLY by the explicit PATCH route",
    /reportingCurrency:\s*resolvedReportingCurrency/.test(patch),
    "the PATCH writer changed shape — update this guard",
  );
}

// ── CANONICAL PATH — one resolver, shared readers, no per-perspective fallback ──
{
  const serverCtx = stripComments(read("lib/money/server-context.ts"));
  check(
    "the canonical resolver exists (resolveEffectiveSpaceConversion)",
    /export\s+async\s+function\s+resolveEffectiveSpaceConversion\b/.test(serverCtx),
  );
  check(
    "the resolver reverts to DEFAULT_DISPLAY_CURRENCY, not a hand-picked currency",
    serverCtx.includes("DEFAULT_DISPLAY_CURRENCY") && serverCtx.includes("decideEffectiveCurrency"),
  );
}

// No perspective/workspace implements its own currency fallback. They must not
// resolve an effective currency or reference the failure verdict — the shared
// context they already consume does it for them.
const PERSPECTIVES = [
  "components/space/widgets/wealth/WealthWorkspace.tsx",
  "components/space/widgets/cashflow/CashFlowWorkspace.tsx",
  "components/space/widgets/debt/DebtWorkspace.tsx",
  "components/space/widgets/liquidity/LiquidityWorkspace.tsx",
  "components/space/widgets/investments/InvestmentsWorkspace.tsx",
];
for (const f of PERSPECTIVES) {
  const code = stripComments(read(f));
  check(
    `${f} implements NO currency fallback of its own`,
    !/resolveEffectiveSpaceConversion|decideEffectiveCurrency|currencyReverted|fxCoverageOf/.test(code),
    "a perspective is re-implementing the failure path — it must consume the shared context instead",
  );
}

// ── UI — the banner renders iff reverted, at the composition root ────────────
{
  const dash = stripComments(read("components/dashboard/SpaceDashboard.tsx"));
  check(
    "SpaceDashboard imports the banner",
    dash.includes("CurrencyRevertedBanner"),
  );
  check(
    "SpaceDashboard renders the banner GATED on currencyReverted",
    /currencyReverted\s*&&\s*[\s\S]{0,120}CurrencyRevertedBanner/.test(dash),
    "the banner must be conditional on the reverted verdict, never unconditional",
  );
  check(
    "SpaceDashboard flips the display currency to the effective one when reverted",
    dash.includes("effectiveDisplay") && /DisplayCurrencyProvider\s+currency=\{effectiveDisplay\}/.test(dash),
    "reverted display must re-scope formatting to the effective (USD) currency",
  );
}
// The "view as" selector must carry the REQUESTED currency (not the effective
// one), so an unsatisfiable pick routes back through /view-context and lights the
// composition-root banner — instead of silently snapping to the effective
// currency with no disclosure (V25-CLOSE-3A-FIX).
{
  const sel = stripComments(read("components/dashboard/widgets/ViewCurrencyOverride.tsx"));
  check(
    "ViewCurrencyOverride stores the requested currency (so a reverted pick still discloses)",
    /currency:\s*d\.requested/.test(sel),
    "the selector must store d.requested, not d.target/d.effective — otherwise a reverted pick shows no banner",
  );
}
{
  const banner = read("components/dashboard/CurrencyRevertedBanner.tsx");
  // The four required meanings.
  check("banner: conversion unavailable", /unavailable/i.test(banner));
  check("banner: fallback occurred (returned to …)", /returned to/i.test(banner));
  check("banner: preference not deleted (saved / resume)", /saved/i.test(banner) && /resume/i.test(banner));
  check("banner: accuracy preserved", /accurate/i.test(banner));
}

console.log(`\nreporting-currency-failure-contract: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
