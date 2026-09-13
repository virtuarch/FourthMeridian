/**
 * lib/connections/health.test.ts  (Wave 2 S7 / CH-1 · PLATFORM OPS POLICIES Slice 1)
 *
 * Pure guards for deriveConnectionHealthState — the precedence that makes the
 * two providers' semantics reconcile into one signal, especially the wallet
 * DEGRADED case (errorCode set WITHOUT a status flip) — and for the staleness
 * window now being the RESOLVED REFRESH POLICY's overdue threshold rather than
 * a copy of it. Standalone tsx script:
 *
 *     npx tsx lib/connections/health.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import { readFileSync } from "node:fs";
import { deriveConnectionHealthState, staleWindowMs } from "@/lib/connections/health";
import { resolveRefreshPolicy } from "@/lib/platform/refresh-policy.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const HOUR = 60 * 60 * 1000;
const NOW = 1_000_000_000_000; // fixed "now" so staleness is deterministic
const fresh = new Date(NOW - 60_000);            // 1 min ago

// The operator window IS the policy's overdue threshold: bank 24h + 6h grace = 30h; wallet 6h + 2h = 8h.
const BANK = staleWindowMs(resolveRefreshPolicy({ sourceKind: "BANK" }, null));
const WALLET = staleWindowMs(resolveRefreshPolicy({ sourceKind: "WALLET" }, null));
const stalePlaid = new Date(NOW - BANK - 60_000);
const staleWallet = new Date(NOW - WALLET - 60_000);

console.log("deriveConnectionHealthState");

// Status precedence — terminal/actionable states win over everything.
check("REVOKED status → REVOKED", deriveConnectionHealthState("REVOKED", null, fresh, BANK, NOW) === "REVOKED");
check("ERROR status → ERROR", deriveConnectionHealthState("ERROR", null, fresh, BANK, NOW) === "ERROR");
check("NEEDS_REAUTH status → NEEDS_REAUTH", deriveConnectionHealthState("NEEDS_REAUTH", null, fresh, BANK, NOW) === "NEEDS_REAUTH");
check("status wins over errorCode", deriveConnectionHealthState("ERROR", "SOME_ERR", fresh, BANK, NOW) === "ERROR");

// The wallet case: errorCode set, status still ACTIVE → DEGRADED (the crux).
check("ACTIVE + errorCode (wallet failure) → DEGRADED", deriveConnectionHealthState("ACTIVE", "EXPLORER_TIMEOUT", fresh, WALLET, NOW) === "DEGRADED");
check("DEGRADED wins over staleness", deriveConnectionHealthState("ACTIVE", "ERR", staleWallet, WALLET, NOW) === "DEGRADED");

// Staleness — only when status ACTIVE and no errorCode.
check("ACTIVE + no error + old lastSyncedAt → STALE", deriveConnectionHealthState("ACTIVE", null, stalePlaid, BANK, NOW) === "STALE");
check("ACTIVE + no error + never synced (null) → STALE", deriveConnectionHealthState("ACTIVE", null, null, BANK, NOW) === "STALE");
check("wallet under the default policy: 7h-old wallet still HEALTHY (inside 6h + 2h grace)",
  deriveConnectionHealthState("ACTIVE", null, new Date(NOW - 7 * HOUR), WALLET, NOW) === "HEALTHY");
check("wallet under the default policy: 9h-old wallet is STALE",
  deriveConnectionHealthState("ACTIVE", null, new Date(NOW - 9 * HOUR), WALLET, NOW) === "STALE");
check("plaid under the default policy: 29h-old bank still HEALTHY (inside 24h + 6h grace)",
  deriveConnectionHealthState("ACTIVE", null, new Date(NOW - 29 * HOUR), BANK, NOW) === "HEALTHY");
check("plaid under the default policy: 31h-old bank is STALE",
  deriveConnectionHealthState("ACTIVE", null, new Date(NOW - 31 * HOUR), BANK, NOW) === "STALE");

// Fresh + clean → HEALTHY.
check("ACTIVE + no error + fresh → HEALTHY", deriveConnectionHealthState("ACTIVE", null, fresh, BANK, NOW) === "HEALTHY");

// The window follows the policy — a 12h wallet policy widens it to 15h.
const TWELVE = staleWindowMs(resolveRefreshPolicy({ sourceKind: "WALLET" }, { value: "12h", updatedAt: new Date(NOW) }));
check("a 12h wallet policy makes a 14h-old wallet HEALTHY and a 16h-old one STALE",
  deriveConnectionHealthState("ACTIVE", null, new Date(NOW - 14 * HOUR), TWELVE, NOW) === "HEALTHY"
    && deriveConnectionHealthState("ACTIVE", null, new Date(NOW - 16 * HOUR), TWELVE, NOW) === "STALE");
check("window sanity: wallet (8h) is stricter than plaid (30h) under the defaults", WALLET < BANK && WALLET === 8 * HOUR && BANK === 30 * HOUR);

// The module holds no window of its own any more.
const src = readFileSync("lib/connections/health.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
check("no hardcoded staleness window survives in the module", !/STALE_MS\s*=|\b48\s*\*\s*HOUR_MS|\b12\s*\*\s*HOUR_MS/.test(src));
check("the operator model resolves the policy through the one loader", /loadRefreshPolicies\(/.test(src));

console.log(failures === 0 ? "\nAll deriveConnectionHealthState checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
