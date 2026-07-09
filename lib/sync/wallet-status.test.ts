/**
 * lib/sync/wallet-status.test.ts
 *
 * Wallet Provider in Connections — the WALLET sync-status mapping (pure).
 *   npx tsx lib/sync/wallet-status.test.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  deriveWalletConnectionState,
  buildWalletSyncStatus,
  finalizeSyncStatus,
  providerName,
  PROVIDER_LABEL,
  type WalletConnectionStateInput,
} from "@/lib/sync/status";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const D = (over: Partial<WalletConnectionStateInput>): WalletConnectionStateInput => ({
  id: "c1", displayName: "My BTC Cold Storage",
  status: "ACTIVE", lastSyncedAt: null, errorCode: null, ...over,
});

// ── state derivation ────────────────────────────────────────────────────────
const SYNCED = new Date("2026-07-09T12:00:00Z");
check("ACTIVE + lastSyncedAt → ready", deriveWalletConnectionState(D({ lastSyncedAt: SYNCED })) === "ready");
check("ACTIVE + no lastSyncedAt, no error → importing", deriveWalletConnectionState(D({})) === "importing");
check("ACTIVE + errorCode (first sync failed) → error", deriveWalletConnectionState(D({ errorCode: "SYNC_FAILED" })) === "error");
check("status ERROR → error", deriveWalletConnectionState(D({ status: "ERROR" })) === "error");
check("status NEEDS_REAUTH → error (wallets never reauth)", deriveWalletConnectionState(D({ status: "NEEDS_REAUTH" })) === "error");
check("status REVOKED → excluded (null)", deriveWalletConnectionState(D({ status: "REVOKED" })) === null);

// ── card shape ──────────────────────────────────────────────────────────────
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

// ── labels + finalize ───────────────────────────────────────────────────────
check("providerName(WALLET) = Self-custody", providerName("WALLET") === "Self-custody" && PROVIDER_LABEL.WALLET === "Self-custody");
check("finalize: building true when any importing", finalizeSyncStatus(cards).building === true);
check("finalize: building false when all settled",
  finalizeSyncStatus(cards.filter((c) => c.state !== "importing")).building === false);
check("finalize merges plaid + wallet connection lists",
  finalizeSyncStatus([
    { id: "p1", provider: "PLAID", institution: "Chase", state: "ready", lastSyncedAt: null, errorCode: null },
    ...cards,
  ]).connections.length === 3);

// ── Error-card copy: truthful about (no) automatic retry ─────────────────────
// These strings are unique to ErrorContent, so presence in the file is exact.
const card = readFileSync(join(process.cwd(), "components", "connections", "ConnectionCard.tsx"), "utf8");
check("wallet error card says 'Press Refresh' (no background-retry promise)",
  /provider === "WALLET"/.test(card) && /Press Refresh to retry discovery/.test(card));
check("wallet error card says 'address discovery' + keeps a detailed reason",
  /couldn.t complete address discovery/.test(card) && /Address discovery failed:/.test(card));
check("Plaid error card keeps accurate 'we'll keep retrying' (daily sync-banks)",
  /keep retrying/.test(card));
check("wallet error branch is provider-gated (Plaid copy unchanged)",
  /isWallet\s*\?/.test(card));
check("wallet importing card shows 'Discovering addresses' (not the Plaid stepper)",
  /provider === "WALLET"/.test(card) && /Discovering addresses/.test(card));
check("zero-used wallet shows valid-but-wrong-type GUIDANCE, not a sync error",
  /NO_USED_ADDRESSES/.test(card) && /no used addresses were found/.test(card) &&
  /Native SegWit zpub/.test(card) && /No activity found/.test(card));
check("malformed xpub error explains it's not a valid extended key",
  /INVALID_XPUB/.test(card) && /valid extended public key/.test(card));

console.log(`\nwallet-status: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
