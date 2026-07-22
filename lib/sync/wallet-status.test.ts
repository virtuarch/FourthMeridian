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
    { id: "p1", provider: "PLAID", institution: "Chase", state: "ready", lastSyncedAt: null, errorCode: null, investments: null, importedCount: null, historyBuild: null },
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

console.log(`\nwallet-status: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
