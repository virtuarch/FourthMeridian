/**
 * lib/connections/health.test.ts  (Wave 2 S7 / CH-1)
 *
 * Pure guards for deriveConnectionHealthState — the precedence that makes the
 * two providers' semantics reconcile into one signal, especially the wallet
 * DEGRADED case (errorCode set WITHOUT a status flip). Standalone tsx script:
 *
 *     npx tsx lib/connections/health.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import {
  deriveConnectionHealthState,
  PLAID_STALE_MS_EXPORT,
  WALLET_STALE_MS_EXPORT,
} from "@/lib/connections/health";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = 1_000_000_000_000; // fixed "now" so staleness is deterministic
const fresh = new Date(NOW - 60_000);            // 1 min ago
const stalePlaid = new Date(NOW - PLAID_STALE_MS_EXPORT - 60_000);
const staleWallet = new Date(NOW - WALLET_STALE_MS_EXPORT - 60_000);

console.log("deriveConnectionHealthState");

// Status precedence — terminal/actionable states win over everything.
check("REVOKED status → REVOKED", deriveConnectionHealthState("REVOKED", null, fresh, PLAID_STALE_MS_EXPORT, NOW) === "REVOKED");
check("ERROR status → ERROR", deriveConnectionHealthState("ERROR", null, fresh, PLAID_STALE_MS_EXPORT, NOW) === "ERROR");
check("NEEDS_REAUTH status → NEEDS_REAUTH", deriveConnectionHealthState("NEEDS_REAUTH", null, fresh, PLAID_STALE_MS_EXPORT, NOW) === "NEEDS_REAUTH");
check("status wins over errorCode", deriveConnectionHealthState("ERROR", "SOME_ERR", fresh, PLAID_STALE_MS_EXPORT, NOW) === "ERROR");

// The wallet case: errorCode set, status still ACTIVE → DEGRADED (the crux).
check("ACTIVE + errorCode (wallet failure) → DEGRADED", deriveConnectionHealthState("ACTIVE", "EXPLORER_TIMEOUT", fresh, WALLET_STALE_MS_EXPORT, NOW) === "DEGRADED");
check("DEGRADED wins over staleness", deriveConnectionHealthState("ACTIVE", "ERR", staleWallet, WALLET_STALE_MS_EXPORT, NOW) === "DEGRADED");

// Staleness — only when status ACTIVE and no errorCode.
check("ACTIVE + no error + old lastSyncedAt → STALE", deriveConnectionHealthState("ACTIVE", null, stalePlaid, PLAID_STALE_MS_EXPORT, NOW) === "STALE");
check("ACTIVE + no error + never synced (null) → STALE", deriveConnectionHealthState("ACTIVE", null, null, PLAID_STALE_MS_EXPORT, NOW) === "STALE");
check("wallet 12h window: 11h-old wallet still HEALTHY", deriveConnectionHealthState("ACTIVE", null, new Date(NOW - 11 * 60 * 60 * 1000), WALLET_STALE_MS_EXPORT, NOW) === "HEALTHY");
check("plaid 48h window: 11h-old plaid still HEALTHY", deriveConnectionHealthState("ACTIVE", null, new Date(NOW - 11 * 60 * 60 * 1000), PLAID_STALE_MS_EXPORT, NOW) === "HEALTHY");

// Fresh + clean → HEALTHY.
check("ACTIVE + no error + fresh → HEALTHY", deriveConnectionHealthState("ACTIVE", null, fresh, PLAID_STALE_MS_EXPORT, NOW) === "HEALTHY");

// Window sanity: wallet is the stricter (shorter) window.
check("wallet window (12h) is stricter than plaid (48h)", WALLET_STALE_MS_EXPORT < PLAID_STALE_MS_EXPORT);

console.log(failures === 0 ? "\nAll deriveConnectionHealthState checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
