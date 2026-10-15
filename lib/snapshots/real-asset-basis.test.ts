/**
 * lib/snapshots/real-asset-basis.test.ts   (RWA-2B — READ BOUNDARY)
 *
 * A stored history row's real-asset component is called MODELED only when it
 * can honestly be: the row is a reconstruction, the ledger models that date,
 * and the row actually carries a real-asset component. Through the same
 * resolver the engine wrote with (manual-asset-history.core → valueOn):
 *   - pure rule (real-asset-basis.core.ts);
 *   - the server helper over an in-memory client (links → ledgers → per-date);
 *   - source pins: the canonical read (lib/data/snapshots.ts) spreads the flag
 *     on BOTH mapping branches and decides it on the STORED row.
 *
 *   npx tsx lib/snapshots/real-asset-basis.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAnchors, type ValuationRow } from "@/lib/assets/valuation-series.core";
import type { ReadClient } from "@/lib/db/tenant-context";
import { isLegacyManualAsset, type ManualAssetHistoryInput } from "./manual-asset-history.core";
import { isRealAssetsModeled, realAssetBasisByDate } from "./real-asset-basis.core";
import { loadRealAssetBasisByDate } from "./real-asset-basis";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const row = (id: string, effectiveDate: string, value: number): ValuationRow =>
  ({ id, effectiveDate, value, currency: "USD", recordedAt: `${effectiveDate}T12:00:00.000Z` });
const asset = (valuations: ValuationRow[]): ManualAssetHistoryInput => {
  const resolved = resolveAnchors({ currency: "USD", valuations, profile: null, legacy: null });
  return { resolved, isLegacy: isLegacyManualAsset({ resolved, hasProfile: false }) };
};

async function main(): Promise<void> {
  console.log("1. per-date basis — the least-trusted basis among the assets valued that day");
  {
    const house = asset([row("h1", "2026-01-01", 100_000), row("h2", "2026-07-01", 120_000)]);
    const car   = asset([row("c1", "2026-04-01", 20_000)]);
    const by = realAssetBasisByDate([house, car], ["2025-12-31", "2026-01-01", "2026-03-01", "2026-04-01", "2026-07-01", "2026-09-01"]);
    check("before every anchor → null", by.get("2025-12-31") === null);
    check("on an anchor, alone → recorded", by.get("2026-01-01") === "recorded");
    check("between the house's anchors → modeled", by.get("2026-03-01") === "modeled");
    check("car recorded + house modeled → modeled wins", by.get("2026-04-01") === "modeled");
    check("house recorded + car carried → carried (not modeled)", by.get("2026-07-01") === "carried");
    check("both carried → carried", by.get("2026-09-01") === "carried");
  }

  console.log("2. the row rule — reconstruction AND modeled date AND a real-asset component");
  {
    const withReal = { isEstimated: true, stocks: 1_000, crypto: 500, cash: 2_000, savings: 1_000, totalAssets: 104_500 };
    const noReal   = { isEstimated: true, stocks: 1_000, crypto: 500, cash: 2_000, savings: 1_000, totalAssets: 4_500 };
    check("estimated + modeled + real component → modeled", isRealAssetsModeled(withReal, "modeled"));
    check("a FROZEN observed row is never modeled, whatever the ledger says now", !isRealAssetsModeled({ ...withReal, isEstimated: false }, "modeled"));
    check("a carried date is an ordinary reconstruction", !isRealAssetsModeled(withReal, "carried"));
    check("a recorded date is not modeled", !isRealAssetsModeled(withReal, "recorded"));
    check("no manual asset valued that date → not modeled", !isRealAssetsModeled(withReal, null) && !isRealAssetsModeled(withReal, undefined));
    check("a pre-RWA-2B estimated row that carries NO real assets is not relabelled", !isRealAssetsModeled(noReal, "modeled"));
    check("isEstimated absent (legacy DTO) → not modeled", !isRealAssetsModeled({ ...withReal, isEstimated: undefined }, "modeled"));
  }

  console.log("3. the server helper — links → ledgers → per-date, on the caller's client");
  {
    const calls: string[] = [];
    const client = {
      spaceAccountLink: {
        findMany: async (args: { where: { spaceId: string; status: string; financialAccount: { type: string; syncStatus: string } } }) => {
          calls.push(`links:${args.where.spaceId}:${args.where.status}:${args.where.financialAccount.type}/${args.where.financialAccount.syncStatus}`);
          return args.where.spaceId === "empty" ? [] : [
            { financialAccount: { id: "house", currency: "USD", balance: 120_000, lastUpdated: new Date("2026-07-01T12:00:00Z") } },
            { financialAccount: { id: "legacy", currency: "USD", balance: 9_000, lastUpdated: new Date("2025-11-01T12:00:00Z") } },
          ];
        },
      },
      assetValuation: {
        findMany: async () => {
          calls.push("valuations");
          return [
            { id: "h1", financialAccountId: "house", effectiveDate: new Date("2026-01-01T00:00:00Z"), value: 100_000, currency: "USD", recordedAt: new Date("2026-01-01T12:00:00Z") },
            { id: "h2", financialAccountId: "house", effectiveDate: new Date("2026-07-01T00:00:00Z"), value: 120_000, currency: "USD", recordedAt: new Date("2026-07-01T12:00:00Z") },
          ];
        },
      },
      manualAssetProfile: { findMany: async () => { calls.push("profiles"); return []; } },
    } as unknown as ReadClient;

    const by = await loadRealAssetBasisByDate(client, "s1", ["2026-03-01", "2026-07-01", "2026-08-01", "2025-12-15"], "2026-10-15");
    check("reads ACTIVE manual-asset links of THIS Space only",
      calls[0] === "links:s1:ACTIVE:other/manual", calls[0]);
    check("one bulk ledger read (valuations + profiles), never per asset",
      calls.filter((c) => c === "valuations").length === 1 && calls.filter((c) => c === "profiles").length === 1);
    check("between the house's anchors → modeled", by.get("2026-03-01") === "modeled");
    check("on the anchor → recorded; after it → carried", by.get("2026-07-01") === "recorded" && by.get("2026-08-01") === "carried");
    check("the legacy asset contributes nothing (no ledger rows ⇒ unchanged behaviour)", by.get("2025-12-15") === null);

    calls.length = 0;
    const none = await loadRealAssetBasisByDate(client, "empty", ["2026-03-01"], "2026-10-15");
    check("a Space with no manual asset costs the link query alone and returns an empty map",
      none.size === 0 && calls.length === 1);
    check("no dates → no reads at all", (await loadRealAssetBasisByDate(client, "s1", [], "2026-10-15")).size === 0 && calls.length === 1);
  }

  console.log("4. the canonical read spreads the flag on BOTH branches, decided on the STORED row");
  {
    const READ = code("lib", "data", "snapshots.ts");
    check("asks the helper once per read, for the rows' own dates",
      /const realAssetBasis = await loadRealAssetBasisByDate\(\s*client, spaceId, rows\.map/.test(READ));
    check("the verdict is computed on the raw row (pre-conversion)", /isRealAssetsModeled\(r, realAssetBasis\.get\(dateISO\)\)/.test(READ));
    check("present only when true (every other DTO byte-identical)", /\? \{ realAssetsModeled: true as const \} : \{\}/.test(READ));
    check("spread on the fast path AND the off-stamp path", (READ.match(/\.\.\.modeled,/g) ?? []).length === 2);
    const TM = code("lib", "wealth", "wealth-time-machine.ts");
    check("the Wealth read model carries it (never decides it) and only on an estimated point",
      /s\.realAssetsModeled && st\.isEstimated \? \{ realAssetsModeled: true as const \} : \{\}/.test(TM));
  }

  if (failures > 0) { console.error(`\nreal-asset-basis: ${failures} failure(s).`); process.exit(1); }
  console.log("\nreal-asset-basis: all passed.");
  process.exit(0);
}

main();
