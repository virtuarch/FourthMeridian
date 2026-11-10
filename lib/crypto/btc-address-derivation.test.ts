/**
 * lib/crypto/btc-address-derivation.test.ts
 *
 * Wallet Provider v4 — xpub/ypub/zpub → address derivation, validated against
 * BIP44/49/84 authoritative spec vectors. Pure, offline.
 *
 *   npx tsx lib/crypto/btc-address-derivation.test.ts
 */

import {
  detectExtendedKeyType,
  isExtendedKey,
  deriveAddresses,
  encodeAddress,
  reencodeExtendedKey,
  scriptTypeForPurpose,
  purposeFromPath,
  normalizeExtendedKeyInput,
  isBtcAddress,
} from "@/lib/crypto/btc-address-derivation";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

// Spec vectors — mnemonic "abandon abandon … about" (BIP49/BIP84 appendices).
const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const YPUB = "ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP";
const XPUB = "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj";

const rcv = (ext: string, n = 1) => deriveAddresses(ext, 0, 0, n).map((d) => d.address);
const chg = (ext: string, n = 1) => deriveAddresses(ext, 1, 0, n).map((d) => d.address);

// ── Type detection ─────────────────────────────────────────────────────────────
check("detectExtendedKeyType: zpub → p2wpkh", detectExtendedKeyType(ZPUB) === "p2wpkh");
check("detectExtendedKeyType: ypub → p2sh",   detectExtendedKeyType(YPUB) === "p2sh");
check("detectExtendedKeyType: xpub → p2pkh",  detectExtendedKeyType(XPUB) === "p2pkh");
check("detectExtendedKeyType: address → null", detectExtendedKeyType("1Cn7RXTTd5aN1ys32GfXVdXUzTyDxdpS1D") === null);
check("isExtendedKey: xpub true",  isExtendedKey(XPUB));
check("isExtendedKey: address false", !isExtendedKey("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"));
check("isExtendedKey: junk false", !isExtendedKey("xpubNOTVALID"));

// ── BIP84 (zpub → native segwit) — authoritative ───────────────────────────────
check("BIP84 zpub m/…/0/0", rcv(ZPUB, 2)[0] === "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
check("BIP84 zpub m/…/0/1", rcv(ZPUB, 2)[1] === "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
check("BIP84 zpub m/…/1/0 (change)", chg(ZPUB)[0] === "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");

// ── BIP49 (ypub → wrapped segwit "3…") — authoritative ─────────────────────────
check("BIP49 ypub m/…/0/0", rcv(YPUB)[0] === "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf");

// ── BIP44 (xpub → legacy "1…") ─────────────────────────────────────────────────
// P2PKH encoding proven independently by the generator-pubkey → puzzle-#1 vector
// below; this locks the full derive path as a regression fixture.
check("BIP44 xpub m/…/0/0", rcv(XPUB)[0] === "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA");

// ── Independent P2PKH proof: compressed secp256k1 generator G → puzzle #1 ───────
const G = Uint8Array.from(
  (("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798").match(/../g) ?? [])
    .map((h) => parseInt(h, 16)),
);
check("encodeAddress p2pkh(G) = puzzle #1", encodeAddress(G, "p2pkh") === "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH");

// ── Derivation walks indices (gap-scan input) ──────────────────────────────────
const three = deriveAddresses(ZPUB, 0, 0, 3);
check("deriveAddresses returns count with branch/index/path",
  three.length === 3 && three[2].index === 2 && three[0].branch === 0 && three[1].path === "0/1");
check("deriveAddresses distinct addresses", new Set(three.map((d) => d.address)).size === 3);

// ── Part B — script-type re-encoding + path inference (no user path picking) ────
check("reencodeExtendedKey: zpub → xpub prefix, still a valid extended key",
  detectExtendedKeyType(reencodeExtendedKey(ZPUB, "p2pkh")) === "p2pkh" && isExtendedKey(reencodeExtendedKey(ZPUB, "p2pkh")));
check("reencodeExtendedKey: round-trips key material (xpub-form → zpub === original)",
  reencodeExtendedKey(reencodeExtendedKey(ZPUB, "p2pkh"), "p2wpkh") === ZPUB);
check("purposeFromPath: 84'/0'/0'/0/1 → 84", purposeFromPath("84'/0'/0'/0/1") === 84);
check("purposeFromPath: m/49h/0h/0h → 49", purposeFromPath("m/49h/0h/0h") === 49);
check("purposeFromPath: 44'/0'/0' → 44", purposeFromPath("44'/0'/0'") === 44);
check("scriptTypeForPurpose: 84→p2wpkh, 49→p2sh, 44→p2pkh, other→null",
  scriptTypeForPurpose(84) === "p2wpkh" && scriptTypeForPurpose(49) === "p2sh" &&
  scriptTypeForPurpose(44) === "p2pkh" && scriptTypeForPurpose(0) === null);

// Bare descriptors pass through untouched.
check("normalizeExtendedKeyInput: bare zpub unchanged", normalizeExtendedKeyInput(ZPUB) === ZPUB);
check("normalizeExtendedKeyInput: plain address unchanged",
  normalizeExtendedKeyInput("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu") === "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");

// THE Ledger case: a NATIVE-SEGWIT account exported with an `xpub` PREFIX + an
// 84' freshAddressPath. Normalization must infer native segwit from the path and
// re-encode so derivation yields the correct bc1… address (same key as ZPUB).
const zAsXpub = reencodeExtendedKey(ZPUB, "p2pkh"); // xpub-prefixed, native-segwit key
const ledgerJson = JSON.stringify({ xpub: zAsXpub, freshAddressPath: "84'/0'/0'/0/1" });
const normalized = normalizeExtendedKeyInput(ledgerJson);
check("normalizeExtendedKeyInput: Ledger JSON (xpub + 84' path) → zpub prefix",
  detectExtendedKeyType(normalized) === "p2wpkh");
check("normalizeExtendedKeyInput: Ledger native-segwit JSON derives bc1 (matches BIP84 vector)",
  deriveAddresses(normalized, 0, 0, 1)[0].address === "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
// A genuinely-legacy JSON (44' path) stays legacy.
check("normalizeExtendedKeyInput: 44' path keeps xpub/legacy",
  detectExtendedKeyType(normalizeExtendedKeyInput(JSON.stringify({ xpub: XPUB, derivationPath: "44'/0'/0'" }))) === "p2pkh");

// ── S2 09eq P1 — isBtcAddress: the pre-explorer guard for single-address syncs ──
// Accept: every form a customer could hold (BIP173/BIP350 spec vectors + the
// addresses this module derives). Reject: anything the explorer could only 400.
const VALID_ADDRESSES: Array<[string, string]> = [
  ["legacy P2PKH 1…",           "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"],
  ["legacy P2PKH (fixture)",    "1Cn7RXTTd5aN1ys32GfXVdXUzTyDxdpS1D"],
  ["P2SH 3…",                   "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"],
  ["bech32 P2WPKH bc1q…",       "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"],
  ["bech32 upper-case",         "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4"],
  ["bech32 P2WSH bc1q… (32B)",  "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"],
  ["bech32m taproot bc1p…",     "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"],
  ["bech32m v1 40-byte",        "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y"],
  ["testnet bech32 tb1q…",      "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"],
  ["testnet P2PKH m…",          "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn"],
  ["testnet P2SH 2…",           "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc"],
  ["derived BIP84 (this module)", rcv(ZPUB)[0]],
  ["derived BIP49 (this module)", rcv(YPUB)[0]],
  ["derived BIP44 (this module)", rcv(XPUB)[0]],
  ["surrounding whitespace",    "  bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 "],
];
for (const [label, a] of VALID_ADDRESSES) check(`isBtcAddress accepts ${label}`, isBtcAddress(a), a);

const INVALID_ADDRESSES: Array<[string, string]> = [
  ["e0-live fixture sentinel",          "e0lADDR3fa9c2d11"],
  ["bech32-looking stub",               "bc1qunitstubaddress"],
  ["bech32 bad checksum",               "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"],
  ["bech32 mixed case",                 "bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"],
  ["taproot encoded as bech32 (BIP350)", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd"],
  ["v0 encoded as bech32m (BIP350)",    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh"],
  ["unknown HRP",                       "ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9"],
  ["legacy bad checksum",               "1Cn7RXTTd5aN1ys32GfXVdXUzTyDxdpS1E"],
  ["an xpub is not an address",         XPUB],
  ["EVM address",                       "0x52908400098527886E0F7030069857D2E4169EE7"],
  ["empty",                             ""],
];
for (const [label, a] of INVALID_ADDRESSES) check(`isBtcAddress rejects ${label}`, !isBtcAddress(a), a);

console.log(`\nbtc-address-derivation: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
