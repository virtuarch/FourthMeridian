/**
 * components/platform/widgets/cs-list-population.test.ts  (Platform Spaces 2.0 — CS list vs hero populations)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/cs-list-population.test.ts
 */
import { listPopulation } from "./CsCustomersWidget";
import type { CustomerListResponse } from "@/app/api/platform/customer-success/customers/route";

let failures = 0;
const check = (name: string, cond: boolean, d?: unknown) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.error(`  ✗ ${name} — ${JSON.stringify(d)}`); } };
const row = (role: string, deactivated = false) => ({ role, deactivatedAt: deactivated ? "2026-10-01T00:00:00Z" : null }) as unknown as CustomerListResponse["customers"][number];
const list = (rows: ReturnType<typeof row>[], total = rows.length) => ({ total, customers: rows }) as unknown as CustomerListResponse;

const full = listPopulation(list([row("USER"), row("USER"), row("USER", true), row("SYSTEM_ADMIN")]));
check("full list reconciles: accounts = active customers + deactivated + admin", full === "4 accounts · 2 active customers · 1 deactivated · 1 admin", full);
const cut = listPopulation(list([row("USER"), row("USER", true)], 120));
check("truncated list scopes the breakdown to the rows shown", cut === "showing 2 of 120 accounts · of these 1 active customer · 1 deactivated", cut);
const one = listPopulation(list([row("USER")]));
check("singular words", one === "1 account · 1 active customer", one);
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
