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
 *
 * Also carries the WALLET sync-status mapping for the same SUT module (merged
 * from lib/sync/wallet-status.test.ts — Wallet Provider in Connections):
 * wallet state derivation, card shape, labels/finalize, and the error-card
 * retry-promise policy scan.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  deriveConnectionState,
  buildSyncStatus,
  deriveInvestmentsCapability,
  deriveWalletConnectionState,
  buildWalletSyncStatus,
  finalizeSyncStatus,
  providerName,
  PROVIDER_LABEL,
  type PlaidItemStateInput,
  type WalletConnectionStateInput,
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

// ── merged from lib/sync/wallet-status.test.ts (Wallet Provider in
//    Connections — the WALLET sync-status mapping, pure) ─────────────────────

const D = (over: Partial<WalletConnectionStateInput>): WalletConnectionStateInput => ({
  id: "c1", displayName: "My BTC Cold Storage",
  status: "ACTIVE", lastSyncedAt: null, errorCode: null, ...over,
});

console.log("wallet — state derivation");
const SYNCED = new Date("2026-07-09T12:00:00Z");
check("ACTIVE + lastSyncedAt → ready", deriveWalletConnectionState(D({ lastSyncedAt: SYNCED })) === "ready");
check("ACTIVE + no lastSyncedAt, no error → importing", deriveWalletConnectionState(D({})) === "importing");
check("ACTIVE + errorCode (first sync failed) → error", deriveWalletConnectionState(D({ errorCode: "SYNC_FAILED" })) === "error");
check("status ERROR → error", deriveWalletConnectionState(D({ status: "ERROR" })) === "error");
check("status NEEDS_REAUTH → error (wallets never reauth)", deriveWalletConnectionState(D({ status: "NEEDS_REAUTH" })) === "error");
check("status REVOKED → excluded (null)", deriveWalletConnectionState(D({ status: "REVOKED" })) === null);

console.log("wallet — card shape");
const cards = buildWalletSyncStatus([
  D({ id: "w1", displayName: "Ledger BTC", status: "ACTIVE", lastSyncedAt: SYNCED }),
  D({ id: "w2", displayName: "Watch xpub", status: "ACTIVE" }),           // importing
  D({ id: "w3", displayName: "Revoked",    status: "REVOKED" }),          // excluded
]);
check("REVOKED wallet excluded from cards", cards.length === 2 && !cards.some((c) => c.id === "w3"));
const w1 = cards.find((c) => c.id === "w1")!;
check("wallet card: provider WALLET, institution = displayName, lastSyncedAt ISO",
  w1.provider === "WALLET" && w1.institution === "Ledger BTC" && w1.lastSyncedAt === SYNCED.toISOString());
check("no wallet card is ever needs_reauth (no Plaid reconnect)",
  !cards.some((c) => c.state === "needs_reauth"));
check("wallet card carries no cursor field", !("cursor" in (w1 as unknown as Record<string, unknown>)));

console.log("wallet — labels + finalize");
check("providerName(WALLET) = Self-custody", providerName("WALLET") === "Self-custody" && PROVIDER_LABEL.WALLET === "Self-custody");
check("finalize: building true when any importing", finalizeSyncStatus(cards).building === true);
check("finalize: building false when all settled",
  finalizeSyncStatus(cards.filter((c) => c.state !== "importing")).building === false);
check("finalize merges plaid + wallet connection lists",
  finalizeSyncStatus([
    { id: "p1", provider: "PLAID", institution: "Chase", state: "ready", lastSyncedAt: null, errorCode: null, investments: null, importedCount: null, historyBuild: null, deferredReason: null },
    ...cards,
  ]).connections.length === 3);

// ── Error-card policy: NEITHER provider promises a retry that doesn't happen ──
// Originally this asserted a CONTRAST: wallets promise nothing, Plaid promises a
// daily retry. That contrast was false. sync-banks selects `status: ACTIVE` and
// the error card renders only for ERROR, so an errored Plaid connection is
// skipped by every scheduled run — the copy asked users to wait for something
// that was never going to run (fixed 2026-07-23).
//
// Comments are STRIPPED before scanning: this file's own prose quotes the retired
// copy, and an un-stripped scan passes on the explanation rather than the code —
// which is exactly how this guard survived the behaviour change that invalidated it.
console.log("wallet — error-card retry-promise policy");
const cardRaw = readFileSync(join(process.cwd(), "components", "connections", "ConnectionCard.tsx"), "utf8");
const card = cardRaw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

check("error card is provider-gated on a wallet branch (isWallet ? … : …)",
  /const isWallet\s*=\s*provider === "WALLET"/.test(card) && /isWallet\s*\?/.test(card));

const walletArm = /isWallet\s*\?\s*"([^"]*)"/.exec(card)?.[1] ?? "";
const promisesBackgroundRetry = (s: string) => /keep retrying|we['’]ll[^.]*retr/i.test(s);

check("wallet error arm makes NO background-retry promise (wallets never auto-resync)",
  walletArm.length > 0 && !promisesBackgroundRetry(walletArm));
check("NO arm promises a background retry — nothing retries an ERROR connection",
  !promisesBackgroundRetry(card));
check("ITEM_NOT_FOUND gets terminal copy directing the user to reconnect",
  /ITEM_NOT_FOUND/.test(card) && /no longer exists at your provider/i.test(card));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll sync-status checks passed");
