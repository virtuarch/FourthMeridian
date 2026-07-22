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

console.log(`\nbtc-address-derivation: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
