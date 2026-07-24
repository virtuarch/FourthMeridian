/**
 * app/api/spaces/[id]/accounts/earliest-tx-floor.test.ts
 *
 * Gate for the per-account earliest-transaction floor the accounts route
 * attaches (`earliestTxDate`), consumed by the personal-space
 * RebuildHistoryButton as the "From" min bound. The compute is inline in an
 * impure, DB-bound handler, so this follows the house pattern (standalone tsx,
 * exit 0/1) with two halves:
 *
 *   1. Behavioral fixture — a local mirror of the route's groupBy→Map→attach
 *      logic, proving the floor maps by FinancialAccount id, formats UTC-day,
 *      and yields null for accounts with no (or no-dated) transactions.
 *   2. Source-scan drift guards — read route.ts as text and assert the real
 *      handler still computes the floor from min non-deleted Transaction.date
 *      (NOT createdAt — the regen's definition, lib/snapshots/regenerate-
 *      history.ts) and still attaches `earliestTxDate`.
 *
 * If the behavioral mirror and the real route ever drift, half (2) fails.
 *
 *   npx tsx app/api/spaces/[id]/accounts/earliest-tx-floor.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. Behavioral fixture: mirror of the route's floor compute ────────────────
// Mirrors, from app/api/spaces/[id]/accounts/route.ts:
//   const floorByAccount = new Map();
//   for (const f of floors) if (f.financialAccountId && f._min.date)
//     floorByAccount.set(f.financialAccountId, f._min.date.toISOString().slice(0,10));
//   normalizeSharedAccounts(links).map(a => ({ ...a, earliestTxDate: floorByAccount.get(a.id) ?? null }))
type GroupRow = { financialAccountId: string | null; _min: { date: Date | null } };
type Acct = { id: string; name: string };

function attachFloors(floors: GroupRow[], normalized: Acct[]): (Acct & { earliestTxDate: string | null })[] {
  const floorByAccount = new Map<string, string>();
  for (const f of floors) {
    if (f.financialAccountId && f._min.date) {
      floorByAccount.set(f.financialAccountId, f._min.date.toISOString().slice(0, 10));
    }
  }
  return normalized.map((a) => ({ ...a, earliestTxDate: floorByAccount.get(a.id) ?? null }));
}

{
  const floors: GroupRow[] = [
    { financialAccountId: "acc_chase",   _min: { date: new Date("2024-07-15T00:00:00.000Z") } },
    { financialAccountId: "acc_bitcoin", _min: { date: new Date("2023-03-24T00:00:00.000Z") } },
    // An account that exists but has no dated transactions — groupBy can still
    // return a row with a null _min; it must NOT produce a floor.
    { financialAccountId: "acc_nodate",  _min: { date: null } },
  ];
  const normalized: Acct[] = [
    { id: "acc_chase",   name: "CHASE COLLEGE" },
    { id: "acc_bitcoin", name: "Bitcoin Ledger" },
    { id: "acc_nodate",  name: "Empty" },
    { id: "acc_notx",    name: "No transactions at all" }, // absent from groupBy entirely
  ];
  const out = attachFloors(floors, normalized);
  const by = (id: string) => out.find((a) => a.id === id)!.earliestTxDate;

  check("FULL row gets its earliest tx date as YYYY-MM-DD", by("acc_chase") === "2024-07-15", String(by("acc_chase")));
  check("second FULL row maps to its own floor", by("acc_bitcoin") === "2023-03-24", String(by("acc_bitcoin")));
  check("groupBy row with null _min.date → null floor", by("acc_nodate") === null, String(by("acc_nodate")));
  check("account absent from groupBy (no tx) → null floor", by("acc_notx") === null, String(by("acc_notx")));
  check("every normalized account is preserved 1:1", out.length === normalized.length, String(out.length));
}

{
  // UTC-day granularity: a timestamp is truncated to its calendar day, matching
  // the regen's truncDateUTC (Transaction.date is @db.Date anyway).
  const floors: GroupRow[] = [{ financialAccountId: "a", _min: { date: new Date("2025-09-25T00:00:00.000Z") } }];
  const out = attachFloors(floors, [{ id: "a", name: "x" }]);
  check("date formats to a bare calendar day", out[0].earliestTxDate === "2025-09-25", String(out[0].earliestTxDate));
}

// ── 2. Source-scan drift/safety guards ────────────────────────────────────────
// PS-6B — the floor logic (query + attach) moved from the route into its ONE
// authoritative loader (lib/space/mount-composition.ts#loadSpaceAccounts), which
// the route now delegates to. Scan the loader for the drift guards, and confirm
// the route still delegates (so the shape the personal-space RebuildHistoryButton
// depends on is produced identically for the API and the hydrated mount).
const loaderSrc = readFileSync(
  path.join(process.cwd(), "lib", "space", "mount-composition.ts"),
  "utf8",
);
const scrunch = loaderSrc.replace(/\s+/g, " ");
const routeDelegates = readFileSync(
  path.join(process.cwd(), "app", "api", "spaces", "[id]", "accounts", "route.ts"),
  "utf8",
).includes("loadSpaceAccounts(spaceId)");

check("accounts route delegates to the shared loadSpaceAccounts loader", routeDelegates, "expected the route to call loadSpaceAccounts(spaceId)");
check("loader groups transactions by financialAccountId", /groupBy\(\s*\{[^}]*by:\s*\[\s*"financialAccountId"\s*\]/.test(scrunch), "expected transaction.groupBy by financialAccountId");
check("loader floors on min transaction date", /_min:\s*\{\s*date:\s*true\s*\}/.test(scrunch), "expected _min: { date: true }");
check("loader excludes soft-deleted transactions (parity with regen)", /deletedAt:\s*null/.test(scrunch), "expected deletedAt: null in the floor query");
check("loader floors on date, never createdAt, inside the _min aggregate", !/_min:\s*\{[^}]*createdAt/.test(scrunch), "the floor must aggregate min(date), not createdAt — see regenerate-history.ts");
check("loader attaches earliestTxDate to each account", /earliestTxDate:/.test(scrunch), "expected earliestTxDate on the returned rows");
check("loader formats the floor as YYYY-MM-DD", /toISOString\(\)\.slice\(0,\s*10\)/.test(scrunch), "expected toISOString().slice(0,10)");

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nearliest-tx-floor: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`earliest-tx-floor: ${passed} checks passed`);
