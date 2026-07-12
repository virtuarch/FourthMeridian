/**
 * components/space/widgets/accounts/AccountsPerspective.test.ts
 *
 * Source-scan tests for the Accounts Tab redesign (Phase 1), house pattern —
 * pure, DB-free (template: cashflow/CashFlowPerspective.test.ts,
 * liquidity/LiquidityPerspective.test.ts). Locks the contract the plan §7 names:
 *
 *   1. Grouping by type preserved (parity with today's AccountsCard).
 *   2. Zero-count import clause omitted — never "0 imports".
 *   3. Manual accounts render no health chip (connectionState null → no chip),
 *      never a fabricated "healthy".
 *   4. Health-chip states map correctly (ready / needs_reauth / error / importing).
 *   5. Actions row shows only verified-real destinations: Rename, Remove from
 *      Space, View transactions (/dashboard/banking?account=), Manage Connections
 *      (/dashboard/connections). NO "View account" (no per-account detail page).
 *   6. Doctrine: never imports components/connections/**; never extends the
 *      shared SpaceAccount type.
 *   7. Detail route reuses the SAME spaceAccountLinks ACTIVE join + the Activity
 *      Tab's ImportBatch join shape, and deriveConnectionState() verbatim.
 *   8. Host wiring: accounts_overview mounts AccountsPerspective; business_accounts
 *      stays on the untouched AccountsCard.
 *
 *   npx tsx components/space/widgets/accounts/AccountsPerspective.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC   = readFileSync(path.join(ROOT, "components/space/widgets/accounts/AccountsPerspective.tsx"), "utf8");
const ROUTE = readFileSync(path.join(ROOT, "app/api/spaces/[id]/accounts/detail/route.ts"), "utf8");
const DASH  = readFileSync(path.join(ROOT, "components/dashboard/SpaceDashboard.tsx"), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function count(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j === -1) return n;
    n++; i = j + needle.length;
  }
}

console.log("1. Grouping by type preserved");
{
  check("groupByType helper exists", SRC.includes("export function groupByType"));
  check("groups by row.type", SRC.includes("(acc[r.type] ??= []).push(r)"));
  check("renders ACCOUNT_TYPE_LABELS per group", SRC.includes("ACCOUNT_TYPE_LABELS[type] ?? type"));
}

console.log("2. Zero-count import clause omitted");
{
  check("importsLabel guards count <= 0 → null", SRC.includes("if (count <= 0) return null"));
  check("pluralises honestly (1 → singular)", SRC.includes('count === 1 ? "" : "s"'));
  // The clause only renders when importsLabel returned truthy.
  check("imports clause gated on truthy label", SRC.includes("isFull && imports &&"));
}

console.log("3. Manual accounts render no health chip (no fabricated 'healthy')");
{
  // healthChip's default branch (null / manual / wallet-only / revoked) returns null.
  check("healthChip default → null", SRC.includes("default:             return null"));
  check("chip only rendered when non-null", SRC.includes("{chip && <Chip chip={chip} />}"));
  // isManual in the route is derived from a real absence of provider, never faked.
  check("route: isManual = !hasProvider", ROUTE.includes("isManual:           !hasProvider"));
  check("route: connectionState null when no plaid item", ROUTE.includes("? deriveConnectionState(plaidConn.plaidItem)\n      : null"));
}

console.log("4. Health-chip states map correctly");
{
  check('ready → "Synced" positive',            SRC.includes('case "ready":        return { label: "Synced",             tone: "positive" }'));
  check('needs_reauth → "Needs reconnection"',  SRC.includes('case "needs_reauth": return { label: "Needs reconnection", tone: "warning"  }'));
  check('error → "Sync error" warning',         SRC.includes('case "error":        return { label: "Sync error",         tone: "warning"  }'));
  check('importing → "Importing…" muted',       SRC.includes('case "importing":    return { label: "Importing…",         tone: "muted"    }'));
  // Visual language matches ConnectionCard: positive uses accent-positive + CheckCircle2; warning uses accent-warning + AlertTriangle.
  check("positive tone uses --accent-positive", SRC.includes("var(--accent-positive,#34d399)"));
  check("warning tone uses --accent-warning",   SRC.includes("var(--accent-warning,#f59e0b)"));
}

console.log("5. Actions row — only verified-real destinations");
{
  check("Rename via PATCH /api/accounts/[id] displayName", SRC.includes("`/api/accounts/${row.id}`") && SRC.includes("displayName: trimmed"));
  check("Rename uses PATCH", count(SRC, 'method:  "PATCH"') === 1);
  check("Remove from Space → revoke route DELETE", SRC.includes("`/api/spaces/${spaceId}/accounts/share`") && SRC.includes("financialAccountId: row.id"));
  check("Remove uses DELETE", SRC.includes('method:  "DELETE"'));
  check("View transactions → /dashboard/banking?account=", SRC.includes("/dashboard/banking?account=${encodeURIComponent(row.id)}"));
  check("Manage Connections → /dashboard/connections", SRC.includes('href="/dashboard/connections"'));
  // Stop condition 2: no per-account detail page exists → no "View account" action, no link to a bare accounts route.
  check('no "View account" action', !SRC.includes("View account"));
  check("no link to /dashboard/accounts", !SRC.includes("/dashboard/accounts"));
}

console.log("6. Doctrine — separate surfaces, shared type untouched");
{
  check("never imports components/connections/**", !SRC.includes("components/connections"));
  // No reauth/credential/provider-settings actions live here (Connections' job): the
  // Connections-management action components are never imported, no access token touched.
  check("no ReconnectAccountButton import",  !SRC.includes("ReconnectAccountButton"));
  check("no EnableInvestmentsButton import",  !SRC.includes("EnableInvestmentsButton"));
  check("no AccountRefreshButton import",     !SRC.includes("AccountRefreshButton"));
  check("no access-token handling",           !/access[_-]?token/i.test(SRC));
  // The detail route is a dedicated read — it must not USE the shared SpaceAccount
  // type (naming it in the header comment to explain WHY is fine; using it is not).
  check("route does not use the shared SpaceAccount type", !/:\s*SpaceAccount\b/.test(ROUTE) && !/SpaceAccount\[\]/.test(ROUTE) && !/import[^;]*\bSpaceAccount\b/.test(ROUTE));
  check("route defines its own AccountDetailRow", ROUTE.includes("export interface AccountDetailRow"));
}

console.log("7. Detail route reuses established joins + pure state derivation");
{
  check("ACTIVE SpaceAccountLink visibility join", ROUTE.includes("status:           ShareStatus.ACTIVE") && ROUTE.includes("db.spaceAccountLink.findMany"));
  check("financialAccount.deletedAt: null (same as shared route)", ROUTE.includes("financialAccount: { deletedAt: null }"));
  check("ImportBatch scoped by spaceAccountLinks.some ACTIVE", ROUTE.includes("spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE } }"));
  check("only COMPLETED batches counted", ROUTE.includes("status:           ImportBatchStatus.COMPLETED"));
  check("deriveConnectionState imported from lib/sync/status", ROUTE.includes('from "@/lib/sync/status"') && ROUTE.includes("deriveConnectionState"));
  check("state derivation not reimplemented (no local status switch)", !ROUTE.includes('case "NEEDS_REAUTH"'));
  check("BALANCE_ONLY reuses normalizeSharedAccounts", ROUTE.includes("normalizeSharedAccounts(balanceOnlyShares)"));
  check("cursor never returned (used only for derivation)", ROUTE.includes("cursor is consumed only by deriveConnectionState"));
  check("membership-gated VIEWER+", ROUTE.includes("requireSpaceRole(spaceId, SpaceMemberRole.VIEWER)"));
}

console.log("8. Host wiring — one renderer swap, business_accounts untouched");
{
  check("accounts_overview mounts AccountsPerspective",
    DASH.includes('"accounts_overview":      (p) => <AccountsPerspective spaceId={p.spaceId} accounts={p.accounts} />'));
  check("business_accounts still on AccountsCard",
    DASH.includes('"business_accounts":      (p) => <AccountsCard accounts={p.accounts} />'));
  check("AccountsCard still defined (serves business_accounts)", DASH.includes("function AccountsCard("));
  check("AccountsPerspective imported", DASH.includes('from "@/components/space/widgets/accounts/AccountsPerspective"'));
}

if (failures > 0) {
  console.error(`\nAccountsPerspective.test.ts — ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAccountsPerspective.test.ts — all checks passed");
