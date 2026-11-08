/**
 * lib/debt/liquid-net-worth-callers.test.ts
 *
 * Mortgage F1 — S2 B2 (caller parity) + R1 (writer parity).
 *
 * classifyAccounts splits installment loans out of LIQUID net worth from three
 * fields on each debt row: debtSubtype, providerSubtype, creditLimit. A caller
 * whose rows lack them silently counts a mortgage as "unknown" (subtracted) —
 * so liquid NW would differ by surface. This test:
 *
 *   B2  source-scans EVERY classifyAccounts call site, mapping each to the
 *       loader that feeds it; every loader that reads debt accounts must SELECT
 *       all three fields and FORWARD them. Call sites that never total debt are
 *       listed as explicit, reasoned exceptions — a new caller fails the test
 *       until it is classified here.
 *   R1  the live snapshot writer (readSpaceAccountsForSnapshot → classifyAccounts
 *       → computeSnapshotFields) and the history writer (liabilityKindEvidence
 *       day rows → classifyAccounts → regenerateDay) produce the SAME netLiquid
 *       for the same day with a mortgage present.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/debt/liquid-net-worth-callers.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { classifyAccounts } from "@/lib/account-classifier";
import { computeSnapshotFields } from "@/lib/snapshots/backfill-core";
import { regenerateDay, type DayRegenInput } from "@/lib/snapshots/regenerate-history.core";
import { readSpaceAccountsForSnapshot } from "@/lib/snapshots/space-accounts";
import { liabilityKindEvidence } from "@/lib/debt/liquid-net-worth";

const ROOT = process.cwd();
const code = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const checks: string[] = [];
const ok = (l: string) => checks.push(l);

// ── B2. Every classifyAccounts call site, classified ─────────────────────────

/** Loaders that read DEBT accounts for a liquid-NW total: must select + forward all three. */
const LOADERS: Record<string, string> = {
  "lib/snapshots/space-accounts.ts":       "today's snapshot row (regenerate.ts)",
  "lib/snapshots/backfill.ts":             "backfill writer",
  "lib/snapshots/regenerate-history.ts":   "history writer",
  "lib/data/accounts-asof.ts":             "as-of account reconstruction",
  "lib/data/accounts-asof-window.ts":      "as-of window reconstruction",
  "lib/ai/assemblers/accounts.ts":         "AI accounts assembler",
  "lib/data/accounts.ts":                  "dashboard account loader (personal)",
  "lib/space/mount-composition.ts":        "Space account loader (SpaceAccount[] for the client widgets)",
};

/** Call site → the loader whose rows it classifies (or an exception reason). */
const CALL_SITES: Record<string, { loader: keyof typeof LOADERS } | { exception: string }> = {
  "lib/snapshots/regenerate.ts":              { loader: "lib/snapshots/space-accounts.ts" },
  "lib/snapshots/backfill.ts":                { loader: "lib/snapshots/backfill.ts" },
  "lib/snapshots/regenerate-history.ts":      { loader: "lib/snapshots/regenerate-history.ts" },
  "lib/ai/assemblers/accounts.ts":            { loader: "lib/ai/assemblers/accounts.ts" },
  "components/space/widgets/wealth/WealthWorkspace.tsx":         { loader: "lib/space/mount-composition.ts" },
  "components/space/widgets/wealth-adapters.tsx":                { loader: "lib/space/mount-composition.ts" },
  "components/space/widgets/liquidity-adapters.tsx":             { loader: "lib/space/mount-composition.ts" },
  "components/space/widgets/liquidity/LiquidityWorkspace.tsx":   { loader: "lib/space/mount-composition.ts" },
  // ── Intentional exceptions: these never total DEBT, so liquid NW is unaffected.
  "lib/connections/connection-facts.ts":      { exception: "type-only bucket membership with balance 0 — no totals read" },
  "lib/connections/space-data-health.core.ts": { exception: "type-only bucket membership with balance 0 — no totals read" },
  "lib/crypto/token-valuation.ts":            { exception: "a single synthetic crypto row — totalDigitalAssets only" },
  "lib/history/account-series.ts":            { exception: "a single synthetic crypto row — totalDigitalAssets only" },
  "lib/investments/investment-accounts.ts":   { exception: "investment/crypto rows only — totalInvestments / totalDigitalAssets only" },
};

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((e) => {
    const rel = join(dir, e);
    if (e === "node_modules" || e.startsWith(".")) return [];
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) ? [rel] : [];
  });
}
const callers = ["lib", "app", "components", "jobs"].flatMap((d) => { try { return walk(d); } catch { return []; } })
  .filter((f) => code(f).split("\n").some((l) => /\bclassifyAccounts\(/.test(l) && !/^\s*(\*|\/\/)/.test(l)
    && !/export function classifyAccounts/.test(l)))
  .map((f) => relative(ROOT, join(ROOT, f)))
  .sort();

{
  const unclassified = callers.filter((f) => !(f in CALL_SITES));
  assert.deepEqual(unclassified, [], `classifyAccounts caller(s) not classified for F1 caller parity: ${unclassified.join(", ")}`);
  const stale = Object.keys(CALL_SITES).filter((f) => !callers.includes(f));
  assert.deepEqual(stale, [], `listed call site(s) no longer call classifyAccounts: ${stale.join(", ")}`);
  ok(`all ${callers.length} classifyAccounts call sites are classified (loader or reasoned exception)`);
}

{
  for (const [file, what] of Object.entries(LOADERS)) {
    const src = code(file);
    // mount-composition forwards whole rows through normalizeSharedAccounts
    // (lib/account-privacy.ts), which maps each field explicitly.
    const fwd = file === "lib/space/mount-composition.ts" ? src + code("lib/account-privacy.ts") : src;
    for (const field of ["debtSubtype", "providerSubtype", "creditLimit"]) {
      assert.ok(new RegExp(`${field}\\??:\\s*true`).test(src), `${file} (${what}) does not SELECT ${field}`);
      // Forwarded: the field is read off the selected row somewhere beyond the select.
      assert.ok(new RegExp(`\\.${field}\\b`).test(fwd) || /liabilityKindEvidence\(/.test(fwd),
        `${file} (${what}) selects ${field} but never forwards it`);
    }
  }
  // Writers: the debt-row forwarding sites are pinned exactly.
  assert.ok(/fa\.type === "debt" \? \{ debtSubtype: fa\.debtSubtype \?\? null, creditLimit: fa\.creditLimit \?\? null \}/.test(code("lib/snapshots/space-accounts.ts")));
  assert.equal((code("lib/snapshots/regenerate-history.ts").match(/\.\.\.liabilityKindEvidence\(a\)/g) ?? []).length, 3,
    "every flat/walked debt day-row carries the kind evidence");
  assert.ok(/debtSubtype: l\.financialAccount\.debtSubtype,\s*\n\s*creditLimit: l\.financialAccount\.creditLimit,/.test(code("lib/ai/assemblers/accounts.ts")));
  ok(`all ${Object.keys(LOADERS).length} debt-reading loaders select AND forward debtSubtype, providerSubtype, creditLimit`);
}

{
  // Documented, deliberate partial-evidence rows (counted, never excluded wrongly):
  //  • a row carrying a "home equity" subtype WITHOUT its creditLimit is COUNTED
  //    (liquidNetWorthTreatment: absent limit evidence ⇒ unknown).
  //  • S2 P1-R1 — non-FULL rows carry no subtype: the SERVER classifies from full
  //    evidence (limit included) and sends the coarse debtType; a privacy debt
  //    AGGREGATE whose members disagree reads "unknown" ⇒ counted.
  assert.ok(/creditLimit === undefined\) return "COUNTED"/.test(code("lib/debt/liquid-net-worth.ts")));
  assert.ok(/g\.liquidTreatmentUniform && g\.coarseDebtType !== null \? g\.coarseDebtType : \("unknown" as DebtType\)/.test(code("lib/account-privacy.ts")));
  ok("exceptions with partial evidence fall to COUNTED (absent limit; mixed-kind privacy aggregates)");
}

// ── R1. Live writer == regenerated row, same day, mortgage present ───────────
async function writerParity(): Promise<void> {
  const fa = [
    { id: "chk", type: "checking", balance: 10_000, currency: "USD", walletChain: null, lastUpdated: new Date("2026-11-08T00:00:00Z"), availableBalance: null, balanceObserved: true, providerSubtype: "checking", debtSubtype: null, creditLimit: null },
    { id: "mtg", type: "debt", balance: 300_000, currency: "USD", walletChain: null, lastUpdated: new Date("2026-11-08T00:00:00Z"), availableBalance: null, balanceObserved: true, providerSubtype: "mortgage", debtSubtype: null, creditLimit: 400_000 },
    { id: "card", type: "debt", balance: 5_000, currency: "USD", walletChain: null, lastUpdated: new Date("2026-11-08T00:00:00Z"), availableBalance: null, balanceObserved: true, providerSubtype: "credit card", debtSubtype: null, creditLimit: 10_000 },
    { id: "heq", type: "debt", balance: 20_000, currency: "USD", walletChain: null, lastUpdated: new Date("2026-11-08T00:00:00Z"), availableBalance: null, balanceObserved: true, providerSubtype: "home equity", debtSubtype: null, creditLimit: null },
    { id: "man", type: "debt", balance: 1_000, currency: "USD", walletChain: null, lastUpdated: new Date("2026-11-08T00:00:00Z"), availableBalance: null, balanceObserved: true, providerSubtype: null, debtSubtype: "mortgage", creditLimit: null },
  ];
  const fake = { spaceAccountLink: { async findMany() { return fa.map((f) => ({ visibilityLevel: "FULL", financialAccount: f })); } } };

  // Live writer path.
  const liveRows = await readSpaceAccountsForSnapshot("space-1", fake as never);
  const live = computeSnapshotFields(classifyAccounts(liveRows));

  // History writer path: the day-row shape regenerate-history builds, then the core.
  const dayRows = fa.map((a) => ({ type: a.type, balance: a.balance, currency: a.currency, ...liabilityKindEvidence(a) }));
  const c = classifyAccounts(dayRows);
  const input: DayRegenInput = {
    date: "2026-11-08", existingIsEstimated: null, existing: null,
    base: {
      totalInvestments: c.totalInvestments, totalDigitalAssets: c.totalDigitalAssets,
      totalChecking: c.totalChecking, totalSavings: c.totalSavings,
      totalLiabilities: c.totalLiabilities, totalRealAssets: c.totalRealAssets,
      totalInstallmentLiabilities: c.totalInstallmentLiabilities,
      totalRestrictedCash: c.totalRestrictedCash,
    },
    investmentValue: 0, investmentTier: "derived", hasInvestmentEvidence: false,
    digitalAssetValue: 0, digitalAssetTier: "derived", hasDigitalAssetEvidence: false,
    cashCardTier: "derived", membershipChangedSince: false,
  } as DayRegenInput;
  const regen = regenerateDay(input);
  const regenNetLiquid = (regen.fields ?? regen.fieldPatch ?? {}) as { netLiquid?: number };

  // mortgage (Plaid) + home equity w/o limit (closed-end) + manual mortgage are
  // installment ⇒ excluded; only the card is subtracted.
  assert.equal(live.netLiquid, 5_000, "live writer: only the card counts against liquid NW");
  assert.equal(regenNetLiquid.netLiquid, live.netLiquid, "regenerated row = live row for the same day");
  assert.equal(live.netWorth, 10_000 - 326_000, "net worth still subtracts every liability");
  ok("R1: live snapshot writer and regenerated row agree on netLiquid (5,000) with a mortgage, a home-equity loan and a manual mortgage present");
}

writerParity().then(() => {
  for (const c of checks) console.log(`  ✓ ${c}`);
  console.log(`\nliquid-net-worth-callers: ${checks.length} checks passed`);
}).catch((e) => { console.error(e); process.exit(1); });
