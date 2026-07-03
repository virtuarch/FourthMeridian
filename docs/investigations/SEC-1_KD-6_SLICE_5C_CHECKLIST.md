# SEC-1 / KD-6 — Slice 5c Implementation Checklist

> **Checklist only. No code, test, schema, or migration was changed to produce this document.** Awaiting approval before implementation.

## 0. Scope

Remove the two **dead, deprecated** exports from `lib/plaid/encryption.ts`:

- `export function encrypt(plaintext: string): string`
- `export function decrypt(ciphertext: string): string`

**Explicitly NOT in this slice** (Gate 2, later): the v1-compatibility branch inside `decryptWithPurpose()` stays. No re-encryption, no schema change, no migration, no behavior change to any live path.

Preconditions (all met): v1 ciphertext count = 0 in the audited environment; the 9 "invalid" `PlaidItem.encryptedToken` rows are confirmed demo placeholders; the two exports have zero runtime callers.

---

## 1. Call-site grep proof

**`encrypt` (legacy export)** — one definition, one importer, and that importer is a test:

```
lib/plaid/encryption.ts:159   export function encrypt(plaintext: string): string   ← definition
lib/plaid/encryption.test.ts:24     encrypt as legacyEncrypt,                       ← the ONLY import
lib/plaid/encryption.test.ts:63     const v1 = legacyEncrypt("hello");              ← test fixture
lib/plaid/encryption.test.ts:88     const v1 = legacyEncrypt("payload");            ← test fixture
lib/plaid/encryption.test.ts:131    const v1 = legacyEncrypt(plain);                ← test fixture
```

**`decrypt` (legacy export)** — one definition, **zero** references anywhere else (fully dead, not even the test uses it):

```
lib/plaid/encryption.ts:167   export function decrypt(ciphertext: string): string  ← definition, 0 callers
```

Verification commands run (results as above):

```
# imports of the module that name a bare encrypt/decrypt (not *WithPurpose):
grep -rnE "import[^;]*\b(encrypt|decrypt)\b" --include=*.ts --include=*.tsx app lib jobs scripts prisma \
  | grep -viE "WithPurpose"
#   → only prose comments in lib/ai/** ("never call any decrypt function"); no real imports.

# every bare legacy decrypt( call:
grep -rnE "[^a-zA-Z.]decrypt\(" --include=*.ts --include=*.tsx app lib jobs scripts prisma \
  | grep -viE "WithPurpose"
#   → only lib/plaid/encryption.ts:167 (the definition).

# uses of the test alias:
grep -nE "legacyEncrypt" lib/plaid/encryption.test.ts
#   → lines 24 (import), 63, 88, 131 (fixtures).
```

Every production import from `@/lib/plaid/encryption` names only `encryptWithPurpose`, `decryptWithPurpose`, `EncryptionPurpose`, or `detectCiphertextVersion` — never `encrypt`/`decrypt`. (All 12 live importers listed in the investigation; unchanged since Slice 4.)

> Re-run the three greps immediately before implementing — the proof must be current at removal time, not just at checklist time.

---

## 2. Impact map

| Item | Impact |
|---|---|
| `lib/plaid/encryption.ts` lines **148–172** (the "Legacy API" comment block + `encrypt()` + `decrypt()`) | **Deleted.** |
| `getRootKey()` | **Kept** — still used by `deriveKey()` and by the v1 branch of `decryptWithPurpose()` (line 115). |
| `aesgcmEncrypt()` | **Kept** — used by `encryptWithPurpose()`. |
| `aesgcmDecrypt()` | **Kept** — used by both branches of `decryptWithPurpose()`. |
| `decryptWithPurpose()` v1 branch | **Untouched** — reading legacy rows still works (Gate 2 not in scope). |
| Live app / API / job paths | **None** — zero runtime callers removed. |
| `lib/plaid/encryption.test.ts` | **Updated** — replace the removed `encrypt` import with a test-only v1 fixture generator (§3). |
| `prisma/schema.prisma`, migrations | **None.** |
| Public API surface | **None** — no barrel re-exports `encrypt`/`decrypt`; not imported anywhere outside the test. |

Removing the two exports orphans **no** internal helper — all three primitives (`getRootKey`, `aesgcmEncrypt`, `aesgcmDecrypt`) remain referenced, so no unused-symbol lint/tsc fallout.

---

## 3. Test changes needed

`lib/plaid/encryption.test.ts` currently imports the soon-removed `encrypt` (aliased `legacyEncrypt`) to mint v1 fixtures for the v1-detection and dual-format-compat cases. Replace it with a **self-contained, test-only v1 generator** so the test owns its fixture and no longer depends on a production export.

**Change 1 — remove the import (line 24):** drop `encrypt as legacyEncrypt,` from the `@/lib/plaid/encryption` import list. Keep `EncryptionPurpose`, `encryptWithPurpose`, `decryptWithPurpose`, `detectCiphertextVersion`.

**Change 2 — add a local fixture helper** (v1 = root-key AES-256-GCM, `iv:authTag:ciphertext`, no HKDF), near the top of the test after the `ENCRYPTION_KEY` is set:

```ts
// Test-only v1 fixture generator. Reproduces the retired encrypt() format
// (root-key AES-256-GCM, "iv:authTag:ciphertext") so the suite can still
// assert v1 detection + dual-format reads without a production v1 encryptor.
function makeV1Fixture(plaintext: string): string {
  const rootKey = Buffer.from(process.env.ENCRYPTION_KEY as string, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", rootKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(":");
}
```

(`crypto` is already imported at the top of the test.)

**Change 3 — swap the three call sites:** `legacyEncrypt(...)` → `makeV1Fixture(...)` at lines 63, 88, 131. No assertions change; the fixtures are byte-compatible with the old `encrypt()` output (same algorithm, same root key, same layout), so `detectCiphertextVersion` still returns `"v1"` and `decryptWithPurpose` still reads them via the root-key branch.

No other test file references these exports.

---

## 4. Validation checklist

- [ ] Re-run the three §1 greps → still zero non-test callers before deleting.
- [ ] Delete lines 148–172 of `lib/plaid/encryption.ts`; apply the three test edits (§3).
- [ ] `npx prisma generate` — clean (no schema change).
- [ ] `npx tsc --noEmit` — no **new** errors in `lib/plaid/encryption.ts` or `encryption.test.ts`. (Note: 5 pre-existing `implicitly-any` errors in `components/charts/*` are unrelated baseline issues — confirm the count stays at 5 and none are in touched files.)
- [ ] `npm run lint` (`npx eslint lib/plaid/encryption.ts lib/plaid/encryption.test.ts`) — clean; confirm no "unused export/var" for the retained primitives.
- [ ] Run the encryption suite: `ENCRYPTION_KEY=$(openssl rand -hex 32) npx tsx lib/plaid/encryption.test.ts` → all cases pass (esp. v1 detection, dual-format read, tamper rejection).
- [ ] `npx tsx scripts/audit-ciphertext-versions.ts` still imports/typechecks (uses `detectCiphertextVersion`, unaffected by the removal).
- [ ] `git diff --stat prisma/schema.prisma` empty; `git status --short prisma/migrations/` empty.
- [ ] Optional high-stakes: independent reviewer confirms no dynamic/string reference to `encrypt`/`decrypt` remains (grep `"encrypt"`/`"decrypt"` string literals) before merge.

---

## 5. Rollback plan

Purely additive-to-subtractive dead-code removal with no data or schema effect, so rollback is trivial:

- **Primary:** `git revert` the Slice 5c commit (or `git checkout` the two files at the prior commit). Restores `encrypt()`/`decrypt()` and the test import verbatim.
- **No data risk:** nothing was migrated, re-encrypted, or dropped; legacy v1 rows remain readable throughout via the untouched `decryptWithPurpose` v1 branch. Reverting is never required for correctness — only if a missed caller surfaces.
- **Fast forward-fix alternative:** if a hidden caller of `encrypt`/`decrypt` appears post-merge, prefer migrating it to `*WithPurpose` (the Slice 4 pattern) rather than reverting; reserve revert for the rare case where that isn't immediately possible.
- **Recoverability:** both functions live in git history; the exact bodies are also reproduced in §3's fixture helper, so the v1 encryptor is never truly lost.

---

## 6. Sequencing note

Slice 5c is independent of Gate 2 (removing the `decryptWithPurpose` v1 branch), which stays blocked on "0 v1 rows in **every** environment + backup-retention window elapsed." Do 5c now; leave Gate 2 for a later, separately-approved slice. KD-6 itself can already be recorded as "no re-encryption required" per the invalid-tokens investigation.

**Checklist only — stopping here. Awaiting approval to implement.**
