/**
 * lib/crypto/btc-address-derivation.ts
 *
 * Wallet Provider v4 — watch-only BTC address derivation from an extended
 * PUBLIC key (xpub / ypub / zpub). PURE (no DB, no network) so it is unit-tested
 * offline against BIP44/49/84 spec vectors.
 *
 * WATCH-ONLY, ALWAYS. The input is a PUBLIC descriptor only — never a private
 * key, seed, or mnemonic. Public derivation (non-hardened CKD) can only ever
 * produce public keys / addresses; it is cryptographically incapable of
 * recovering spend authority.
 *
 * Script type is inferred from the SLIP-0132 prefix:
 *   xpub → BIP44 P2PKH        (legacy "1…")
 *   ypub → BIP49 P2SH-P2WPKH  (wrapped segwit "3…")
 *   zpub → BIP84 P2WPKH       (native segwit "bc1…")
 *
 * ypub/zpub carry non-xpub version bytes; we rewrite them to the xpub version
 * for parsing (the key material is identical — the version only signals script
 * type), and remember the script type separately. Validated against the BIP84
 * and BIP49 spec vectors, plus the generator-pubkey P2PKH vector.
 */

import { HDKey } from "@scure/bip32";
import { base58check, bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

export type BtcScriptType = "p2pkh" | "p2sh" | "p2wpkh";

const b58c = base58check(sha256);
const hash160 = (b: Uint8Array): Uint8Array => ripemd160(sha256(b));

// SLIP-0132 mainnet public version bytes per script type.
const VERSION_BYTES: Record<BtcScriptType, Uint8Array> = {
  p2pkh:  Uint8Array.from([0x04, 0x88, 0xb2, 0x1e]), // xpub
  p2sh:   Uint8Array.from([0x04, 0x9d, 0x7c, 0xb2]), // ypub
  p2wpkh: Uint8Array.from([0x04, 0xb2, 0x47, 0x46]), // zpub
};
const XPUB_VERSION = VERSION_BYTES.p2pkh;

/** SLIP-0132 human prefix → script type. Null when not an extended public key. */
export function detectExtendedKeyType(input: string): BtcScriptType | null {
  const s = input.trim();
  if (s.startsWith("xpub")) return "p2pkh";
  if (s.startsWith("ypub")) return "p2sh";
  if (s.startsWith("zpub")) return "p2wpkh";
  return null;
}

/** True iff `input` is a well-formed xpub/ypub/zpub extended PUBLIC key. */
export function isExtendedKey(input: string): boolean {
  if (!detectExtendedKeyType(input)) return false;
  try {
    const raw = b58c.decode(input.trim());
    return raw.length === 78; // version(4)+depth(1)+fpr(4)+idx(4)+chaincode(32)+key(33)
  } catch {
    return false;
  }
}

interface ParsedExtendedKey {
  node: HDKey;
  type: BtcScriptType;
}

/** Parse an extended public key once for efficient repeated derivation. */
export function parseExtendedKey(ext: string): ParsedExtendedKey {
  const type = detectExtendedKeyType(ext);
  if (!type) throw new Error("Not a supported extended public key (expected xpub/ypub/zpub).");

  // Rewrite the version bytes to xpub so @scure/bip32 accepts it; key material
  // is unchanged.
  const payload = new Uint8Array(b58c.decode(ext.trim()));
  if (payload.length !== 78) throw new Error("Malformed extended public key.");
  payload.set(XPUB_VERSION, 0);

  const node = HDKey.fromExtendedKey(b58c.encode(payload));
  if (node.privateKey) throw new Error("Refusing a private extended key — watch-only requires a public descriptor.");
  return { node, type };
}

/** Encode a compressed public key to an address of the given script type. */
export function encodeAddress(pubkey: Uint8Array, type: BtcScriptType): string {
  const h = hash160(pubkey);
  if (type === "p2wpkh") {
    return bech32.encode("bc", [0, ...bech32.toWords(h)]);
  }
  if (type === "p2sh") {
    // P2SH-P2WPKH: redeemScript = OP_0 <20-byte keyhash>
    const redeem = Uint8Array.from([0x00, 0x14, ...h]);
    return b58c.encode(Uint8Array.from([0x05, ...hash160(redeem)]));
  }
  // p2pkh
  return b58c.encode(Uint8Array.from([0x00, ...h]));
}

/** Derive a single address at account-relative path `branch/index`. */
export function deriveAddressAt(parsed: ParsedExtendedKey, branch: number, index: number): string {
  const child = parsed.node.deriveChild(branch).deriveChild(index);
  if (!child.publicKey) throw new Error("Derivation produced no public key.");
  return encodeAddress(child.publicKey, parsed.type);
}

export interface DerivedAddress {
  address: string;
  branch: number; // 0 = receive (external), 1 = change (internal)
  index: number;
  path: string;   // account-relative, e.g. "0/3"
}

/**
 * Re-encode an extended public key with the version bytes of `type` (xpub/ypub/
 * zpub). Key material is identical — only the SLIP-0132 prefix changes, so the
 * whole pipeline (which infers script type from the prefix) stays correct.
 */
export function reencodeExtendedKey(ext: string, type: BtcScriptType): string {
  const payload = new Uint8Array(b58c.decode(ext.trim()));
  if (payload.length !== 78) throw new Error("Malformed extended public key.");
  payload.set(VERSION_BYTES[type], 0);
  return b58c.encode(payload);
}

/** BIP purpose (44/49/84) → script type. Null when the purpose is unrecognized. */
export function scriptTypeForPurpose(purpose: number): BtcScriptType | null {
  if (purpose === 84) return "p2wpkh";
  if (purpose === 49) return "p2sh";
  if (purpose === 44) return "p2pkh";
  return null;
}

/** Extract the BIP purpose from a derivation path like "84'/0'/0'/0/1" or "m/84h/0h/0h". */
export function purposeFromPath(path: string): number | null {
  const m = path.trim().replace(/^m\//i, "").match(/^(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a pasted wallet descriptor to a canonical extended key string so the
 * rest of the pipeline can rely on the SLIP-0132 prefix for script type.
 *
 * Handles two shapes without ever asking the user to pick a derivation path:
 *   1. A bare xpub/ypub/zpub — returned as-is.
 *   2. A Ledger-style JSON export, e.g.
 *        {"xpub":"xpub6…","freshAddressPath":"84'/0'/0'/0/1"}
 *      Ledger exports a NATIVE-SEGWIT account with an `xpub`-PREFIXED string plus
 *      a path whose purpose (84') reveals the real script type. We read the
 *      purpose from the path and re-encode the key to the matching prefix
 *      (84'→zpub) so downstream derivation produces the correct bc1… addresses.
 *
 * Anything else (a plain BTC address, unparseable text) is returned trimmed and
 * unchanged. Never parses or stores seeds/keys — only public descriptors.
 */
export function normalizeExtendedKeyInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    const xpub = [j.xpub, j.extendedPublicKey, j.extended_public_key, j.key]
      .find((v): v is string => typeof v === "string" && isExtendedKey(v));
    if (!xpub) return trimmed;
    const pathRaw = [j.freshAddressPath, j.derivationPath, j.path]
      .find((v): v is string => typeof v === "string");
    const purpose = pathRaw ? purposeFromPath(pathRaw) : null;
    const type = purpose != null ? scriptTypeForPurpose(purpose) : null;
    // Only re-encode when the path implies a DIFFERENT script type than the
    // string's own prefix (e.g. xpub string but 84' path → zpub).
    if (type && type !== detectExtendedKeyType(xpub)) return reencodeExtendedKey(xpub, type);
    return xpub;
  } catch {
    return trimmed;
  }
}

/** Derive `count` consecutive addresses on a branch (receive=0, change=1). */
export function deriveAddresses(
  ext: string,
  branch: number,
  start: number,
  count: number,
): DerivedAddress[] {
  const parsed = parseExtendedKey(ext);
  const out: DerivedAddress[] = [];
  for (let i = start; i < start + count; i++) {
    out.push({ address: deriveAddressAt(parsed, branch, i), branch, index: i, path: `${branch}/${i}` });
  }
  return out;
}
