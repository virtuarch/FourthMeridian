/**
 * lib/export/accounts.test.ts  (FM-AUDIT-022)
 *
 * Pure guards for the export account projection: an unvalued wallet (the read
 * layer's structural 0 flagged `valuationUnknown`) exports `balance: null` and
 * `valuationStatus: "not_yet_valued"` in data.json — never 0 — and a valued
 * account passes through byte-identical. Plus a source pin that the assembler
 * projects through it. Standalone tsx script (exit 0/1). No DB, no network.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/export/accounts.test.ts
 *
 * All fixtures are synthetic.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toExportAccount, countUnvaluedExportAccounts, NOT_YET_VALUED } from "@/lib/export/accounts";
import type { Account } from "@/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("export/accounts");

const valued = {
  id: "a1", name: "Checking", type: "checking", institution: "Bank", balance: 100.5,
  currency: "USD", lastUpdated: "2026-03-01T00:00:00.000Z",
} as unknown as Account;
const unvalued = {
  id: "w1", name: "Wallet", type: "crypto", institution: "", balance: 0, valuationUnknown: true,
  currency: "USD", lastUpdated: "2026-03-01T00:00:00.000Z",
  cryptoPosition: { state: "NO_PRICE", freshness: null, observedAt: null, quantity: 1, value: null, symbol: "XYZ" },
} as unknown as Account;

// ── valued: byte-identical to the prior `{ ...account, spaceId, spaceName }` ──
{
  const out = toExportAccount(valued, "s1", "Personal");
  check("valued account: JSON byte-identical to the prior spread",
    JSON.stringify(out) === JSON.stringify({ ...valued, spaceId: "s1", spaceName: "Personal" }), JSON.stringify(out));
  check("valued account: no valuationStatus key", !("valuationStatus" in out));
}

// ── unvalued: null + status, never 0 ─────────────────────────────────────────
{
  const out = toExportAccount(unvalued, "s1", "Personal");
  const json = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
  check("unvalued account: balance is null in data.json", json.balance === null, String(json.balance));
  check("unvalued account: valuationStatus = not_yet_valued", json.valuationStatus === NOT_YET_VALUED);
  check("unvalued account: the structural-0 flag is not exported beside it", !("valuationUnknown" in json));
  check("unvalued account: identity + the position's own state retained",
    json.id === "w1" && (json.cryptoPosition as { state?: string })?.state === "NO_PRICE");
  check("unvalued account: no numeric 0 balance anywhere in the serialised row",
    !/"balance":\s*0\b/.test(JSON.stringify(out)));
  check("countUnvaluedExportAccounts counts only the unvalued row",
    countUnvaluedExportAccounts([toExportAccount(valued, "s1", "P"), out]) === 1);
}

// ── assembler binding ────────────────────────────────────────────────────────
{
  const src = readFileSync(join(process.cwd(), "lib/export/assemble.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  check("assemble.ts projects every exported account through toExportAccount",
    /accounts\.push\(toExportAccount\(row\.account, spaceId, spaceName\)\)/.test(src) &&
    !/accounts\.push\(\{\s*\.\.\.row\.account/.test(src));
  check("assemble.ts states the unvalued count in the manifest notes",
    /countUnvaluedExportAccounts\(data\.accounts\)/.test(src));
}

console.log(failures === 0 ? "\nAll export/accounts checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
