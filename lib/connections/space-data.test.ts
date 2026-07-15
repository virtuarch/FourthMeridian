/**
 * lib/connections/space-data.test.ts  (PCS-2)
 *
 * Pure + source-scan tests for the canonical Connections contract. Standalone
 * `tsx` script (exit 0/1), no DB:
 *
 *     npx tsx lib/connections/space-data.test.ts
 *
 * Covers:
 *   1. groupConnectionAccounts — name-resolution order, de-dup, per-connection
 *      keying (the pure core of the account-inventory join).
 *   2. Contract-stabilization invariants (source scan): the Connections page and
 *      poll route no longer read the portfolio (getAccounts) and no longer group
 *      accounts by institution string; both derive state through this one module.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { groupConnectionAccounts, type ConnectionAccountRow } from "./space-data";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

function row(connectionId: string, account: Partial<ConnectionAccountRow["account"]> & { id: string }): ConnectionAccountRow {
  return {
    connectionId,
    account: {
      id:           account.id,
      name:         account.name ?? "Fallback Name",
      displayName:  account.displayName ?? null,
      officialName: account.officialName ?? null,
      plaidName:    account.plaidName ?? null,
      type:         account.type ?? "depository",
    },
  };
}

function main(): void {
  console.log("groupConnectionAccounts — pure grouping / name resolution");

  // Name resolution order: displayName ?? officialName ?? plaidName ?? name.
  const resolved = groupConnectionAccounts([
    row("c1", { id: "a", displayName: "Display", officialName: "Official", plaidName: "Plaid", name: "Raw" }),
    row("c1", { id: "b", officialName: "Official", plaidName: "Plaid", name: "Raw" }),
    row("c1", { id: "c", plaidName: "Plaid", name: "Raw" }),
    row("c1", { id: "d", name: "Raw" }),
  ]);
  check("prefers displayName", resolved.c1[0].name === "Display");
  check("falls back to officialName", resolved.c1[1].name === "Official");
  check("falls back to plaidName", resolved.c1[2].name === "Plaid");
  check("falls back to raw name", resolved.c1[3].name === "Raw");

  // Keyed per connection id; de-dups a repeated account under the same connection.
  const grouped = groupConnectionAccounts([
    row("c1", { id: "a", name: "A" }),
    row("c1", { id: "a", name: "A again" }), // duplicate → dropped
    row("c1", { id: "b", name: "B" }),
    row("c2", { id: "z", name: "Z" }),
  ]);
  check("groups by connection id", Object.keys(grouped).sort().join(",") === "c1,c2");
  check("de-dups repeated account id within a connection", grouped.c1.length === 2);
  check("keeps the first occurrence of a duplicate", grouped.c1[0].name === "A");
  check("separate connection gets its own bucket", grouped.c2.length === 1 && grouped.c2[0].id === "z");

  // Carries names/types only — never a balance/currency field.
  const acct = grouped.c1[0] as unknown as Record<string, unknown>;
  check("account shape is names/types only (no balance)", !("balance" in acct) && !("currency" in acct));

  console.log("contract-stabilization invariants (source scan)");
  const page  = read("app/(shell)/dashboard/connections/page.tsx");
  const list  = read("components/connections/ConnectionsList.tsx");
  const route = read("app/api/sync/status/route.ts");
  const mod   = read("lib/connections/space-data.ts");

  // Assert on the actual import path (comment-proof — the module headers
  // legitimately DISCUSS getAccounts as the removed anti-pattern).
  const importsPortfolio = (src: string) => /from ["']@\/lib\/data\/accounts["']/.test(src);
  check("page no longer imports the portfolio read (lib/data/accounts)", !importsPortfolio(page));
  check("page consumes loadConnectionsSpaceData", /loadConnectionsSpaceData/.test(page));
  check("page no longer groups by institution", !/accountsByInstitution/.test(page));
  check("ConnectionsList prop is by-connection-id only", !/accountsByInstitution/.test(list) && /accountsByConnectionId/.test(list));
  check("poll route derives state via the shared loader", /loadConnectionsSyncStatus/.test(route));
  check("poll route no longer re-implements the plaidItem query", !/db\.plaidItem\.findMany/.test(route));
  check("loader reuses the single state authority (buildSyncStatus)", /buildSyncStatus/.test(mod));
  check("loader does not import the portfolio read (lib/data/accounts)", !importsPortfolio(mod));
  check("loader joins accounts by stable id (plaidItemDbId)", /plaidItemDbId:\s+{ in: itemIds }/.test(mod));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

main();
