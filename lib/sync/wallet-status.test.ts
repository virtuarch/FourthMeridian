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
    { id: "p1", provider: "PLAID", institution: "Chase", state: "ready", lastSyncedAt: null, errorCode: null, investments: null, importedCount: null },
    ...cards,
  ]).connections.length === 3);

// ── Error-card policy: wallets never auto-resync ─────────────────────────────
// The load-bearing invariant (not the exact marketing copy): the error card is
// PROVIDER-GATED, and the wallet arm must NOT promise a background retry that
// doesn't exist — self-custody wallets have no scheduled crypto sync, so retry
// is user-initiated. Plaid IS retried daily by sync-banks, so its background-
// retry promise is accurate and lives on the Plaid arm. Assert the semantics of
// the branch, not the wording of either sentence (which is free to churn).
const card = readFileSync(join(process.cwd(), "components", "connections", "ConnectionCard.tsx"), "utf8");

check("error card is provider-gated on a wallet branch (isWallet ? … : …)",
  /const isWallet\s*=\s*provider === "WALLET"/.test(card) && /isWallet\s*\?/.test(card));

// Capture the wallet arm — a plain double-quoted string in the `isWallet ? … : …`
// error copy. (We don't parse the Plaid arm: its template literal nests backticks.)
const walletArm = /isWallet\s*\?\s*"([^"]*)"/.exec(card)?.[1] ?? "";
const promisesBackgroundRetry = (s: string) => /keep retrying|we['’]ll[^.]*retr/i.test(s);

check("wallet error arm makes NO background-retry promise (wallets never auto-resync)",
  walletArm.length > 0 && !promisesBackgroundRetry(walletArm));
// The only background-retry promise in the card lives on the Plaid arm — accurate,
// since sync-banks retries Plaid daily. It's present in the card but NOT in the
// wallet arm, so the honest contrast holds.
check("Plaid arm keeps its accurate background-retry promise (contrast is real)",
  promisesBackgroundRetry(card) && !promisesBackgroundRetry(walletArm));

console.log(`\nwallet-status: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
