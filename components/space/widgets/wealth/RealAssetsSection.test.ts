/**
 * components/space/widgets/wealth/RealAssetsSection.test.ts   (RWA-1)
 *
 * Real-world assets exposed in the UI:
 *   - the section lists only FULL user-estimate rows (never a privacy aggregate),
 *   - Update value / Archive render only for rows the server says the viewer
 *     may manage (owner AND manual — the write routes' own gate),
 *   - the add form no longer collects fields the route does not persist,
 *   - every entry point exists (Net Worth → Assets, Connections, Daily Brief).
 *
 *   npx tsx components/space/widgets/wealth/RealAssetsSection.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountDetailRow } from "@/app/api/spaces/[id]/accounts/detail/route";
import { selectRealAssetRows } from "./RealAssetsSection";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
/** Source without comments, so a pin can't be satisfied by prose. */
const code = (...p: string[]) => read(...p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function row(over: Partial<AccountDetailRow>): AccountDetailRow {
  return {
    id: "a", spaceAccountLinkId: "l", visibility: "FULL", name: "Home", institution: "Manual Entry",
    type: "other", mask: null, balance: 1, currency: "USD", isManual: true, isUserEstimate: true,
    canManage: true, connectionState: null, importBatchCount: 0,
    ...over,
  } as AccountDetailRow;
}

console.log("selectRealAssetRows — FULL user estimates only, largest first");
const picked = selectRealAssetRows([
  row({ id: "car",   balance: 20_000 }),
  row({ id: "house", balance: 450_000 }),
  row({ id: "plaid-other", isManual: false, isUserEstimate: false }),
  row({ id: "import-only", isManual: true, isUserEstimate: false }),
  row({ id: "balance-only:x:Other:USD", visibility: "BALANCE_ONLY", isUserEstimate: false }),
  row({ id: "shared-estimate", visibility: "BALANCE_ONLY", isUserEstimate: true }),
]);
check("only the two FULL estimates", picked.map((r) => r.id).join() === "house,car", picked.map((r) => r.id).join());
check("a Plaid `other` account is not a real asset card", !picked.some((r) => r.id === "plaid-other"));
check("an import-only (isManual) account is not an estimate", !picked.some((r) => r.id === "import-only"));
check("a BALANCE_ONLY row is never listed, even if flagged", !picked.some((r) => r.visibility !== "FULL"));

console.log("RealAssetsSection — actions follow the server's canManage");
const SECTION = code("components", "space", "widgets", "wealth", "RealAssetsSection.tsx");
check("actions render only under r.canManage", /\{r\.canManage && \(/.test(SECTION));
check("reads the membership-gated detail route", SECTION.includes("/api/spaces/${spaceId}/accounts/detail"));
check("archive goes through the manual DELETE route", /\/api\/accounts\/manual\/\$\{encodeURIComponent\(archiving\.id\)\}`, \{ method: "DELETE" \}/.test(SECTION));
check("archive asks first (ConfirmDialog)", SECTION.includes("<ConfirmDialog"));
check("every card carries the estimate caption", SECTION.includes("estimateCaption("));
check("a write refreshes this Space's data (hero/chart follow the card)",
  SECTION.includes("new CustomEvent(SPACE_DATA_REFRESHED_EVENT, { detail: { spaceId } })"));

const UPDATE = code("components", "space", "widgets", "wealth", "UpdateAssetValueModal.tsx");
check("revaluation PATCHes { balance } only", UPDATE.includes('method:  "PATCH"') && UPDATE.includes("JSON.stringify({ balance: parsed })"));

console.log("AddManualAssetModal — asks only for what is kept");
const MODAL = code("components", "dashboard", "AddManualAssetModal.tsx");
for (const field of ["assetKind", "purchasePrice", "purchaseDate", "notes"]) {
  check(`no longer sends ${field} (the route stores none of them on the asset)`, !MODAL.includes(field));
}
check("POST body is name/balance/currency/spaceIds",
  /body: JSON\.stringify\(\{\s*name:\s+name\.trim\(\),\s*balance:\s+parsedValue,\s*currency,\s*spaceIds: shareTo,\s*\}\)/.test(MODAL));
check("currency options come from the server allowlist", MODAL.includes("MANUAL_ASSET_CURRENCIES.map"));
check("the value label follows the selected currency (no hard-coded $)",
  MODAL.includes("estimateValueLabel(currency)") && !MODAL.includes("Current value ($)"));
check("the estimate disclosure is on the form", MODAL.includes("{ESTIMATE_DISCLOSURE}"));

console.log("entry points");
const WEALTH = code("components", "space", "widgets", "wealth", "WealthWorkspace.tsx");
check("Net Worth → Assets mounts the Real assets section", WEALTH.includes('id="wealth-real-assets"') && WEALTH.includes("<RealAssetsSection"));
const CONN = code("components", "connections", "ConnectionsActions.tsx");
check("Connections offers Add asset", CONN.includes("<AddManualAssetModal") && CONN.includes("setAssetOpen(true)"));
const BRIEF = code("components", "brief", "BriefNewUser.tsx");
check("the Brief's add-asset button opens the form (no dead-end link to Connections)",
  BRIEF.includes("<AddManualAssetModal") && (BRIEF.match(/href="\/dashboard\/connections"/g) ?? []).length === 1);

console.log("detail route — the two new fields are the write routes' own gate");
const DETAIL = code("app", "api", "spaces", "[id]", "accounts", "detail", "route.ts");
check("isUserEstimate = syncStatus manual", DETAIL.includes('isUserEstimate:     a.syncStatus === "manual"'));
check("canManage = manual AND owner === viewer",
  DETAIL.includes('canManage:          a.syncStatus === "manual" && a.ownerUserId === viewer.user.id'));
check("aggregated BALANCE_ONLY rows can never be managed",
  /isUserEstimate:\s+false,\s*canManage:\s+false,\s*connectionState:\s+null/.test(DETAIL));
const ID_ROUTE = code("app", "api", "accounts", "manual", "[id]", "route.ts");
check("…and the write route still enforces owner + manual itself",
  ID_ROUTE.includes("fa.ownerUserId !== userId") && ID_ROUTE.includes('fa.syncStatus !== "manual"'));

if (failures > 0) {
  console.error(`\nRealAssetsSection: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nRealAssetsSection: all passed.");
