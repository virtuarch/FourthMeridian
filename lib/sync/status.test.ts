/**
 * lib/sync/status.test.ts
 *
 * D2.x Slice 3 — pure tests for the sync-status derivation. Standalone `tsx`
 * script (exit 0/1), no DB, no prisma generate required:
 *
 *     npx tsx lib/sync/status.test.ts
 *
 * Covers: deriveConnectionState across all five status × syncIncompleteAt
 * combinations, buildSyncStatus.building aggregation + REVOKED exclusion, and
 * the invariant that neither `cursor` nor `syncIncompleteAt` appears on an
 * outward SyncConnection.
 */

import {
  deriveConnectionState,
  buildSyncStatus,
  deriveInvestmentsCapability,
  type PlaidItemStateInput,
} from "./status";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

function item(partial: Partial<PlaidItemStateInput>): PlaidItemStateInput {
  return {
    id:              "id_" + (partial.id ?? "x"),
    institutionName: partial.institutionName ?? "Test Bank",
    status:          partial.status ?? "ACTIVE",
    syncIncompleteAt: partial.syncIncompleteAt ?? null,
    lastSyncedAt:    partial.lastSyncedAt ?? null,
    errorCode:       partial.errorCode ?? null,
    investmentsConsent: partial.investmentsConsent,
  };
}

const INCOMPLETE = new Date(0); // any non-null timestamp = "still importing"

console.log("deriveConnectionState — five combinations");
check("ACTIVE + syncIncompleteAt set → importing",
  deriveConnectionState({ status: "ACTIVE", syncIncompleteAt: INCOMPLETE }) === "importing");
check("ACTIVE + syncIncompleteAt null → ready",
  deriveConnectionState({ status: "ACTIVE", syncIncompleteAt: null }) === "ready");
check("NEEDS_REAUTH → needs_reauth",
  deriveConnectionState({ status: "NEEDS_REAUTH", syncIncompleteAt: INCOMPLETE }) === "needs_reauth");
check("NEEDS_REAUTH ignores marker → needs_reauth",
  deriveConnectionState({ status: "NEEDS_REAUTH", syncIncompleteAt: null }) === "needs_reauth");
check("ERROR → error",
  deriveConnectionState({ status: "ERROR", syncIncompleteAt: null }) === "error");
check("REVOKED → null (excluded)",
  deriveConnectionState({ status: "REVOKED", syncIncompleteAt: null }) === null);

console.log("buildSyncStatus — aggregation + exclusion");
const status = buildSyncStatus([
  item({ id: "a", status: "ACTIVE", syncIncompleteAt: INCOMPLETE }),                    // importing
  item({ id: "b", status: "ACTIVE", syncIncompleteAt: null, lastSyncedAt: new Date(0) }), // ready
  item({ id: "c", status: "NEEDS_REAUTH", syncIncompleteAt: INCOMPLETE, errorCode: "ITEM_LOGIN_REQUIRED" }),
  item({ id: "d", status: "REVOKED", syncIncompleteAt: null }),                         // excluded
]);
check("building is true when any importing", status.building === true);
check("REVOKED excluded (3 of 4 remain)", status.connections.length === 3);
check("ready connection carries ISO lastSyncedAt",
  status.connections.find((c) => c.id === "id_b")?.lastSyncedAt === new Date(0).toISOString());
check("needs_reauth carries errorCode",
  status.connections.find((c) => c.id === "id_c")?.errorCode === "ITEM_LOGIN_REQUIRED");
check("importing connection has null lastSyncedAt",
  status.connections.find((c) => c.id === "id_a")?.lastSyncedAt === null);

console.log("buildSyncStatus — building false when none importing");
const settled = buildSyncStatus([
  item({ id: "b", status: "ACTIVE", syncIncompleteAt: null }),
  item({ id: "c", status: "ERROR", syncIncompleteAt: null }),
]);
check("building false when no importing", settled.building === false);

console.log("deriveInvestmentsCapability — DB enum → client capability");
check("ENABLED → enabled",
  deriveInvestmentsCapability("ENABLED") === "enabled");
check("CONSENT_REQUIRED → available",
  deriveInvestmentsCapability("CONSENT_REQUIRED") === "available");
check("UNSUPPORTED → null (never a misleading action)",
  deriveInvestmentsCapability("UNSUPPORTED") === null);
check("null (unknown) → null",
  deriveInvestmentsCapability(null) === null);
check("undefined → null",
  deriveInvestmentsCapability(undefined) === null);

console.log("buildSyncStatus — investments capability wired onto SyncConnection");
const invStatus = buildSyncStatus([
  item({ id: "enabled",  status: "ACTIVE", syncIncompleteAt: null, investmentsConsent: "ENABLED" }),
  item({ id: "consent",  status: "ACTIVE", syncIncompleteAt: null, investmentsConsent: "CONSENT_REQUIRED" }),
  item({ id: "unsupp",   status: "ACTIVE", syncIncompleteAt: null, investmentsConsent: "UNSUPPORTED" }),
  item({ id: "unknown",  status: "ACTIVE", syncIncompleteAt: null }), // no consent field → null
]);
check("ENABLED item → investments 'enabled'",
  invStatus.connections.find((c) => c.id === "id_enabled")?.investments === "enabled");
check("CONSENT_REQUIRED item → investments 'available'",
  invStatus.connections.find((c) => c.id === "id_consent")?.investments === "available");
check("UNSUPPORTED item → investments null",
  invStatus.connections.find((c) => c.id === "id_unsupp")?.investments === null);
check("unknown item → investments null",
  invStatus.connections.find((c) => c.id === "id_unknown")?.investments === null);

console.log("invariant — internal derivation fields never leak onto SyncConnection");
const allConns = [...status.connections, ...settled.connections];
check("no connection object has a `cursor` key",
  allConns.every((c) => !Object.prototype.hasOwnProperty.call(c, "cursor")));
check("no connection object has a `syncIncompleteAt` key",
  allConns.every((c) => !Object.prototype.hasOwnProperty.call(c, "syncIncompleteAt")));
check("serialized JSON contains no 'cursor'",
  !JSON.stringify(status).includes("cursor"));
check("serialized JSON contains no 'syncIncompleteAt'",
  !JSON.stringify(status).includes("syncIncompleteAt"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll sync-status checks passed");
