/**
 * lib/transactions/merchant-display.test.ts  (MI1 M6)
 *
 * Unit tests for the M6 read-cutover presentation helpers
 * (lib/transactions/merchant-display.ts) and the serializer's use of them.
 * Standalone tsx script — pure, no DB:
 *
 *     npx tsx lib/transactions/merchant-display.test.ts
 *
 * Covers the M6 checklist: merchant display fallback, alias display, missing
 * merchant fallback, logo fallback, alias-aware search, raw descriptor preserved,
 * and the transaction-detail/list serializer cutover (via serializeTransactionRow,
 * which the detail + list reads both use).
 */

import { merchantDisplayName, merchantLogoUrl } from "./merchant-display";
import { serializeTransactionRow, type TransactionRowLike } from "./serialize";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── 1. Display fallback: resolved name preferred, raw otherwise ────────────────
{
  eq("resolved → displayName", merchantDisplayName("WALMART #1842", { displayName: "Walmart", logoUrl: null }), "Walmart");
  eq("missing merchant → raw descriptor", merchantDisplayName("WALMART #1842", null), "WALMART #1842");
  eq("undefined merchant → raw descriptor", merchantDisplayName("SQ *BLUE BOTTLE", undefined), "SQ *BLUE BOTTLE");
}

// ── 2. Alias display: different raw descriptors, same resolved Merchant ────────
{
  const walmart = { displayName: "Walmart", logoUrl: null };
  eq("alias A displays canonical", merchantDisplayName("WALMART #1842", walmart), "Walmart");
  eq("alias B displays canonical", merchantDisplayName("WM SUPERCENTER", walmart), "Walmart");
  eq("alias C displays canonical", merchantDisplayName("Walmart", walmart), "Walmart");
}

// ── 3. Logo fallback ──────────────────────────────────────────────────────────
{
  eq("logo present", merchantLogoUrl({ displayName: "Netflix", logoUrl: "https://x/n.png" }), "https://x/n.png");
  eq("logo absent → null (icon fallback)", merchantLogoUrl({ displayName: "Netflix", logoUrl: null }), null);
  eq("no merchant → null (icon fallback)", merchantLogoUrl(null), null);
}

// ── 4. Alias-aware search: searching the canonical matches every alias ─────────
{
  const walmart = { displayName: "Walmart", logoUrl: null };
  const rows = [
    { merchant: "WALMART #1842", resolved: walmart },
    { merchant: "WM SUPERCENTER", resolved: walmart },
    { merchant: "Walmart", resolved: walmart },
    { merchant: "STARBUCKS #5", resolved: { displayName: "Starbucks", logoUrl: null } },
  ];
  // The UI predicate: match raw OR resolved display name.
  const q = "walmart";
  const hits = rows.filter(
    (r) =>
      r.merchant.toLowerCase().includes(q) ||
      merchantDisplayName(r.merchant, r.resolved).toLowerCase().includes(q),
  );
  eq("search 'walmart' returns all three Walmart aliases", hits.length, 3);
  check("search excludes the Starbucks row", !hits.some((r) => r.merchant.startsWith("STARBUCKS")));
}

// ── 5. Serializer cutover (list + detail) — resolved display, RAW preserved ────
{
  const base: TransactionRowLike = {
    id: "t1", financialAccountId: "fa1",
    date: new Date("2026-06-01T00:00:00.000Z"),
    merchant: "SQ *BLUE BOTTLE #442", description: "SQ *BLUE BOTTLE #442",
    category: "Dining", amount: -6, pending: false,
  };
  const resolved = serializeTransactionRow({ ...base, resolvedMerchant: { displayName: "Blue Bottle", logoUrl: "https://x/bb.png" } });
  eq("serializer: merchantDisplayName from Merchant", resolved.merchantDisplayName, "Blue Bottle");
  eq("serializer: merchantLogoUrl from Merchant", resolved.merchantLogoUrl, "https://x/bb.png");
  eq("serializer: RAW merchant descriptor preserved", resolved.merchant, "SQ *BLUE BOTTLE #442");

  const unresolved = serializeTransactionRow(base); // no resolvedMerchant
  eq("serializer: display falls back to raw", unresolved.merchantDisplayName, "SQ *BLUE BOTTLE #442");
  eq("serializer: logo falls back to null", unresolved.merchantLogoUrl, null);
  eq("serializer: raw still present", unresolved.merchant, "SQ *BLUE BOTTLE #442");
}

// ── Summary ───────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`merchant-display: all ${passed} checks passed.`);
  process.exit(0);
} else {
  console.error(`merchant-display: ${failures.length} FAILED (of ${passed + failures.length}):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
