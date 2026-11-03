/**
 * lib/snapshots/backfill-unvalued-wallet.test.ts   (FM-AUDIT-022, history backfill)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/snapshots/backfill-unvalued-wallet.test.ts
 *
 * THE GAP: the new-Space backfill held crypto FLAT at `FinancialAccount.balance`.
 * For a NO_PRICE / NO_OBSERVATION wallet that column is the schema DEFAULT 0 or
 * an undated stored figure — today's row says "excluded, not yet valued" while
 * the 30 reconstructed days before it carried the stale column in `crypto`,
 * `totalAssets` and `netWorth`, with nothing recording that.
 *
 * THE FIX, pinned here:
 *   - the backfill's rows go through `resolveWalletBalance` (the ONE totals
 *     classification): unvalued ⇒ structural 0 + `valuationUnknown`, EXCLUDED by
 *     `classifyAccounts` and counted in `unvaluedCount`;
 *   - such a day records `completenessTier: "incomplete"` — the live writer's
 *     stamp, the canonical vocabulary (read as `unreliable`);
 *   - a priced wallet takes its resolved value, and a non-wallet row and a
 *     fully-valued day are byte-identical to before (tier null).
 *
 * All fixtures are synthetic. No DB.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWalletBalance, type WalletCurrentValue, type WalletValueState } from "@/lib/crypto/wallet-current-value";
import { classifyAccounts } from "@/lib/account-classifier";
import {
  applyResolvedWalletBalances,
  excludedTotalsCompletenessTier,
  computeSnapshotFields,
  type ResolvedWalletBalance,
} from "./backfill-core";
import { resolveSnapshotCompleteness, snapshotConfidence } from "./snapshot-completeness.core";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function wv(state: WalletValueState, value: number | null): WalletCurrentValue {
  return { state, value, quantity: value === null && state === "NO_OBSERVATION" ? null : 1 } as unknown as WalletCurrentValue;
}

// A synthetic Space: one checking account, one priced wallet, one unpriced, one never observed.
const base = [
  { id: "chk",    type: "checking", balance: 1000, currency: "USD" },
  { id: "w-ok",   type: "crypto",   balance: 40,   currency: "USD" }, // stale column; spine says 55
  { id: "w-np",   type: "crypto",   balance: 300,  currency: "USD" }, // stale column; NO_PRICE
  { id: "w-no",   type: "crypto",   balance: 0,    currency: "USD" }, // DEFAULT 0; NO_OBSERVATION
];
const values = new Map<string, WalletCurrentValue>([
  ["w-ok", wv("VALUED", 55)],
  ["w-np", wv("NO_PRICE", null)],
  ["w-no", wv("NO_OBSERVATION", null)],
]);
function resolvedFor(ids: string[]): Map<string, ResolvedWalletBalance> {
  const m = new Map<string, ResolvedWalletBalance>();
  for (const a of base) if (ids.includes(a.id) && values.has(a.id)) m.set(a.id, resolveWalletBalance(a.balance, values.get(a.id)));
  return m;
}

console.log("backfill — unvalued wallets");

// ── 1 · the row projection ──────────────────────────────────────────────────
{
  const rows = applyResolvedWalletBalances(base, resolvedFor(["w-ok", "w-np", "w-no"]));
  const by = new Map(rows.map((r) => [r.id, r]));
  check("non-wallet row is the SAME object (byte-identical)", by.get("chk") === base[0]);
  check("priced wallet takes the spine value, no flag",
    by.get("w-ok")!.balance === 55 && !("valuationUnknown" in by.get("w-ok")!));
  check("NO_PRICE wallet: structural 0 + valuationUnknown, never the stored column",
    by.get("w-np")!.balance === 0 && by.get("w-np")!.valuationUnknown === true);
  check("NO_OBSERVATION wallet: structural 0 + valuationUnknown",
    by.get("w-no")!.balance === 0 && by.get("w-no")!.valuationUnknown === true);
  // the day loop overrides balances with `{ ...a, balance }` — the flag must survive it
  const dayOverride = { ...by.get("w-np")!, balance: 999 };
  check("the flag survives the day loop's balance override", dayOverride.valuationUnknown === true);
}

// ── 2 · a day with unvalued wallets: excluded, counted, incomplete ──────────
{
  const rows = applyResolvedWalletBalances(base, resolvedFor(["w-ok", "w-np", "w-no"]));
  const c = classifyAccounts(rows);
  const f = computeSnapshotFields(c);
  check("unvaluedCount counts both unvalued wallets", c.unvaluedCount === 2, String(c.unvaluedCount));
  check("crypto = the priced wallet only (stale 300 not carried)", f.crypto === 55, String(f.crypto));
  check("totalAssets / netWorth exclude the unvalued wallets", f.totalAssets === 1055 && f.netWorth === 1055, `${f.totalAssets}/${f.netWorth}`);
  const tier = excludedTotalsCompletenessTier(c);
  check("tier = incomplete", tier === "incomplete", String(tier));
  check("an isEstimated row with that tier reads `unreliable`",
    snapshotConfidence(resolveSnapshotCompleteness({ isEstimated: true, completenessTier: tier })) === "unreliable");
}

// ── 3 · a fully priced day: unchanged ───────────────────────────────────────
{
  const rows = applyResolvedWalletBalances(base.filter((a) => a.id === "chk" || a.id === "w-ok"), resolvedFor(["w-ok"]));
  const c = classifyAccounts(rows);
  check("no unvalued ⇒ unvaluedCount 0", c.unvaluedCount === 0);
  check("no unvalued ⇒ tier null (prior backfill row, NOT RECORDED)", excludedTotalsCompletenessTier(c) === null);
  check("priced wallet counts at its resolved value", computeSnapshotFields(c).crypto === 55);
}

// ── 4 · non-wallet Space: no wallet map ⇒ byte-identical rows + totals ──────
{
  const plain = base.filter((a) => a.id === "chk");
  const rows = applyResolvedWalletBalances(plain, new Map());
  check("empty map ⇒ every row the same object", rows.every((r, i) => r === plain[i]));
  check("empty map ⇒ identical snapshot fields",
    JSON.stringify(computeSnapshotFields(classifyAccounts(rows))) === JSON.stringify(computeSnapshotFields(classifyAccounts(plain))));
}

// ── 5 · unconverted alone is also incomplete (the live writer's same rule) ──
check("unconverted ⇒ incomplete", excludedTotalsCompletenessTier({ unconverted: true, unvaluedCount: 0 }) === "incomplete");

// ── 6 · the DB binding (backfill.ts) uses the one classification ────────────
{
  const src = readFileSync(join(process.cwd(), "lib/snapshots/backfill.ts"), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("backfill.ts loads wallet current values and resolves through resolveWalletBalance",
    /loadWalletCurrentValues\(/.test(code) && /resolveWalletBalance\(/.test(code));
  check("backfill.ts selects walletChain + lastUpdated", /walletChain:\s*true/.test(code) && /lastUpdated:\s*true/.test(code));
  check("backfill.ts projects rows through applyResolvedWalletBalances", /applyResolvedWalletBalances\(/.test(code));
  check("backfill.ts stamps the tier from the classification",
    /completenessTier:\s*excludedTotalsCompletenessTier\(c\)/.test(code));
  check("backfill.ts never re-derives unvalued-ness itself (no NO_PRICE / NO_OBSERVATION branch)",
    !/NO_PRICE|NO_OBSERVATION|hasKnownValue/.test(code));
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
  check("backfill:snapshots runs with the server-only preload (wallet chain is server-only)",
    pkg.scripts["backfill:snapshots"]?.includes("--require ./scripts/lib/server-only-preload.cjs") === true);
}

console.log(failures === 0 ? `\nbackfill-unvalued-wallet: ${passes} checks passed.` : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
