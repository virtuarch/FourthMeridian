/**
 * lib/accounts/wallet-connection-format.ts
 *
 * Pure formatting helpers for the Wallet Provider v1.5 Connection spine. No DB
 * or framework imports, so this module is unit-testable under the bare-tsx test
 * runner (mirrors the lib/crypto/btc-explorer.ts pure/impure split). The
 * DB-touching orchestration lives in ./wallet-connection.ts.
 */

/**
 * Watch-only credential for a single-address wallet = the address itself.
 * (An xpub/descriptor will replace this for HD wallets in v4 — this is NEVER a
 * private key; a public address is a public external fact.)
 */
export function walletConnectionCredential(address: string): string {
  return address.trim();
}

/** Stable human/debug id for the Connection, e.g. "BTC:1Cn7RX…". */
export function walletExternalConnectionId(chain: string, address: string): string {
  return `${chain.trim().toUpperCase()}:${address.trim()}`;
}
