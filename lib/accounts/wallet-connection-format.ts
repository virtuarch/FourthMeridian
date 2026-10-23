/**
 * lib/accounts/wallet-connection-format.ts
 *
 * Pure formatting helpers for the Wallet Provider v1.5 Connection spine. No DB
 * or framework imports, so this module is unit-testable under the bare-tsx test
 * runner (mirrors the lib/crypto/btc-explorer.ts pure/impure split). The
 * DB-touching orchestration lives in ./wallet-connection.ts.
 */

import { nativeAssetForChain } from "@/lib/crypto/native-asset";

/**
 * Watch-only credential for a single-address wallet = the address itself.
 * (An xpub/descriptor will replace this for HD wallets in v4 — this is NEVER a
 * private key; a public address is a public external fact.)
 */
export function walletConnectionCredential(address: string, chain?: string | null): string {
  return canonicalWalletAddress(address, chain);
}

/**
 * UI-C1 — THE CANONICAL FORM OF A WALLET ADDRESS, FOR IDENTITY PURPOSES.
 *
 * A wallet's Connection is deduped by its credential, so two spellings of one
 * address are two wallets. That is exactly what happened to Ethereum: the create
 * route stored the address as the user pasted it (EIP-55 checksummed, mixed
 * case) while the sync adapter normalised it to lower case before aligning the
 * spine. `findFirst` missed, a SECOND Connection was created two seconds after
 * the first, and the two halves of the wallet's identity landed on different
 * rows — the AccountConnection on one, the ProviderAccountIdentity and every
 * subsequent successful sync stamp on the other.
 *
 * The card reads the AccountConnection's row, found `lastSyncedAt: null`, and
 * correctly concluded from that input that the wallet had never synced. The
 * state authority was right; it was being shown the wrong Connection.
 *
 * ── Case sensitivity is a property of the CHAIN, not of addresses in general ──
 * An EVM address is a 20-byte value written in hex; case carries only the EIP-55
 * checksum, so `0xAbC…` and `0xabc…` are the SAME account and must produce the
 * same identity. Base58 (Solana, legacy Bitcoin) and bech32 are not
 * case-foldable that way — `1A` and `1a` are different strings and may be
 * different addresses — so they are left exactly as given.
 *
 * Keyed on the CAIP-2 namespace rather than a chain list, so a new EVM network
 * inherits this without an edit here.
 */
export function canonicalWalletAddress(address: string, chain?: string | null): string {
  const trimmed = address.trim();
  return isCaseInsensitiveAddressChain(chain) ? trimmed.toLowerCase() : trimmed;
}

/** Does this chain write its addresses in a case-insensitive representation? */
export function isCaseInsensitiveAddressChain(chain: string | null | undefined): boolean {
  const asset = nativeAssetForChain(chain);
  return asset !== null && asset.assetKey.startsWith("eip155:");
}

/** Stable human/debug id for the Connection, e.g. "BTC:1Cn7RX…". */
export function walletExternalConnectionId(chain: string, address: string): string {
  // Same canonical form as the credential — a debug id that disagreed with the
  // identity it labels is how the duplicate above went unnoticed for two days.
  return `${chain.trim().toUpperCase()}:${canonicalWalletAddress(address, chain)}`;
}
