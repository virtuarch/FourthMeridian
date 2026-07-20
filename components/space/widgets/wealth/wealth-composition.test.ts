/**
 * components/space/widgets/wealth/wealth-composition.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1).
 *
 * UX-CLOSE-2 made "Where it sits" interrogable: clicking an institution segment
 * opens the accounts that produced it. That only stays honest if the chart and
 * the panel read ONE authority — two call sites filtering and converting "the
 * same way" is exactly how a segment and its drill-down drift apart.
 *
 * So the load-bearing property here is RECONCILIATION: a group's value is the
 * sum of the accounts it will show, and the groups partition the account rows
 * exactly. Everything else (asset-only, positive-only, ordering) is the
 * behaviour the previous adapters had, pinned so the refactor cannot regress it.
 *
 *   npx tsx components/space/widgets/wealth/wealth-composition.test.ts
 */

import {
  wealthAccountRows,
  wealthInstitutionGroups,
  NO_INSTITUTION_LABEL,
  type WealthAdapterAccount,
} from "../wealth-adapters";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const A = (
  id: string, name: string, institution: string, balance: number, type = "checking",
): WealthAdapterAccount => ({ id, name, type, institution, balance, currency: "USD" });

const ACCOUNTS: WealthAdapterAccount[] = [
  A("a1", "Chase Checking",  "Chase",    1000),
  A("a2", "Chase Savings",   "Chase",    2500, "savings"),
  A("a3", "Ally Savings",    "Ally",      800, "savings"),
  A("a4", "Brokerage",       "Vanguard", 5000, "investment"),
  A("a5", "Cold Wallet",     "",          300, "crypto"),   // no institution
  A("a6", "Credit Card",     "Chase",   -1200, "debt"),      // liability
  A("a7", "Closed Account",  "Ally",        0, "savings"),   // zero
];

function main(): void {
  const rows = wealthAccountRows(ACCOUNTS);
  const groups = wealthInstitutionGroups(ACCOUNTS);

  console.log("account rows — assets only, positive only");
  check("liabilities are excluded", !rows.some((r) => r.id === "a6"));
  check("zero-value accounts are excluded", !rows.some((r) => r.id === "a7"));
  check("five asset rows remain", rows.length === 5, `got ${rows.length}`);
  check("sorted by value descending",
    rows.every((r, i) => i === 0 || rows[i - 1].value >= r.value));
  check("largest first is the brokerage", rows[0]?.id === "a4");

  console.log("institution bucketing");
  check("a blank institution falls into the Other bucket",
    rows.find((r) => r.id === "a5")?.institution === NO_INSTITUTION_LABEL);
  check("groups are sorted by value descending",
    groups.every((g, i) => i === 0 || groups[i - 1].value >= g.value));
  const labels = groups.map((g) => g.label);
  check("one group per distinct institution",
    new Set(labels).size === labels.length && labels.length === 4,
    `got ${labels.join()}`);
  check("Chase groups its two asset accounts (not the credit card)",
    groups.find((g) => g.label === "Chase")?.accounts.length === 2);

  console.log("RECONCILIATION — a segment equals the panel behind it");
  for (const g of groups) {
    const summed = g.accounts.reduce((s, a) => s + a.value, 0);
    check(`${g.label}: group value equals the sum of its accounts`, g.value === summed,
      `${g.value} vs ${summed}`);
  }
  const groupTotal = groups.reduce((s, g) => s + g.value, 0);
  const rowTotal   = rows.reduce((s, r) => s + r.value, 0);
  check("groups total equals account-rows total (a true partition)",
    groupTotal === rowTotal, `${groupTotal} vs ${rowTotal}`);
  const grouped = groups.flatMap((g) => g.accounts.map((a) => a.id)).sort();
  check("every account row appears in exactly one group",
    grouped.join() === rows.map((r) => r.id).sort().join(),
    `${grouped.join()} vs ${rows.map((r) => r.id).sort().join()}`);

  console.log("known values");
  check("Chase totals 3500", groups.find((g) => g.label === "Chase")?.value === 3500);
  check("Vanguard leads at 5000", groups[0]?.label === "Vanguard" && groups[0]?.value === 5000);
  check("accounts within a group are largest first",
    groups.find((g) => g.label === "Chase")?.accounts[0]?.id === "a2");

  console.log("edges");
  check("no accounts ⇒ no rows", wealthAccountRows([]).length === 0);
  check("no accounts ⇒ no groups", wealthInstitutionGroups([]).length === 0);
  check("only-liabilities ⇒ empty", wealthInstitutionGroups([A("d", "Loan", "X", -5, "debt")]).length === 0);
  check("whitespace institution is treated as absent",
    wealthInstitutionGroups([A("w", "W", "   ", 10)])[0]?.label === NO_INSTITUTION_LABEL);

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
