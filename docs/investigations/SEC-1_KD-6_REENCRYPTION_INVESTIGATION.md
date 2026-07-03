# SEC-1 / KD-6 — v1→v2 Ciphertext Re-encryption Investigation

> **Investigation only. No schema, migration, API, or application code was modified to produce this document.**
> Closes the remaining encryption-format debt from **D14 Slice 5** (defect **KD-6**, scheduled v2.5 / FlowType foundation window per `STATUS.md`).

## 0. Document control

| | |
|---|---|
| Governing decision record | `docs/architecture/PHASE_2_DECISION_MATRIX.md` §D14 (immutable) |
| Freeze reference | `PHASE_2_ARCHITECTURE_FREEZE.md` §7, §19.7 |
| Defect | KD-6 — "v1 (root-key) ciphertexts not re-encrypted; D14 Slice 5 pending" (`STATUS.md`, Medium, Open) |
| Implementation module | `lib/plaid/encryption.ts` |
| Scope this pass | Investigate, confirm, design. **Stop before implementation.** |
| Explicitly out of scope | Atlas, FlowType, Merchant, Daily Brief, SpaceDashboard, UI, provider adapter work |
| Branch note | Working tree is on `feature/v2.5-spaces-completion`, not the `feature/phase-2-architecture` named in project instructions. Confirm intended target branch before any Slice 5 work opens. |

---

## 1. Current encryption architecture (confirmed against code)

`lib/plaid/encryption.ts` implements AES-256-GCM with **HKDF-SHA-256 per-purpose key derivation** (D14). One root `ENCRYPTION_KEY` (32 bytes / 64 hex) derives a distinct 32-byte subkey per named purpose, so rotating/isolating one field never affects the others.

**Two ciphertext formats coexist by design:**

| Version | Layout | Segments | Key used | Written by |
|---|---|---|---|---|
| **v1 (legacy)** | `iv:authTag:ciphertext` | 3 | root key directly | `encrypt()` — deprecated, **0 callers** |
| **v2 (current)** | `v2:iv:authTag:ciphertext` | 4 | HKDF subkey per purpose | `encryptWithPurpose(plaintext, purpose)` |

`decryptWithPurpose()` reads **both** formats (dual-format reads), which is why no data migration was required to ship D14 — existing v1 rows keep working. New writes are always v2.

**Purpose registry** (`EncryptionPurpose`): `PLAID_ACCESS_TOKEN`, `TOTP_SECRET`, `DATE_OF_BIRTH`, `CONNECTION_CREDENTIAL`.

**Slice status inferred from code + `STATUS.md`:** Slices 1–4 complete (HKDF helper, purpose registry, purpose-aware API, and call-site migration). **Slice 5 (re-encrypt existing v1 rows, then retire the v1 path) is the entire remaining debt.**

### Call-site migration is already complete (Slice 4)

A repo-wide grep for the deprecated helpers returns **zero** remaining importers or callers of `encrypt()` / `decrypt()`:

- All Plaid token paths (`exchangeToken`, `refresh`, `disconnect`, `syncTransactions`, `link-token`, `reset-chase-history-test`) use `*WithPurpose` with `PLAID_ACCESS_TOKEN`.
- All TOTP paths (`auth.ts`, `totp/setup|verify|disable|recovery-codes`) use `TOTP_SECRET`.
- DOB paths (`auth/register`, `user/profile`) use `DATE_OF_BIRTH`.
- `Connection.credential` (`exchangeToken.ts`) uses `CONNECTION_CREDENTIAL`.

Consequence: **the deprecated exported `encrypt()`/`decrypt()` functions are already dead code.** The live compatibility surface is the **v1-read branch inside `decryptWithPurpose()`**, which is exercised only by not-yet-migrated rows.

*(Note: `lib/crypto-apis.ts` and `jobs/sync-crypto.ts` are empty `export {}` stubs and unrelated — "crypto" there means cryptocurrency, not encryption.)*

---

## 2. Affected tables / fields

Four fields are encrypted with this module. Their ability to hold **v1** ciphertext is determined by whether a legacy `encrypt()` write path ever targeted them (i.e. whether the field predates the D14 commit `9761cd9`).

| Table.field | Type | Purpose | Predates D14? | Can contain v1? |
|---|---|---|---|---|
| `PlaidItem.encryptedToken` | `String` (required) | `PLAID_ACCESS_TOKEN` | Yes — exists since v1.0 (`b2564b4`) | **Yes** |
| `User.totpSecret` | `String?` | `TOTP_SECRET` | Yes — M3 | **Yes** (only rows for users who enrolled TOTP before Slice 4) |
| `User.dateOfBirthEncrypted` | `String?` | `DATE_OF_BIRTH` | Yes | **Yes** (only rows written at registration/profile before Slice 4) |
| `Connection.credential` | `String?` | `CONNECTION_CREDENTIAL` | No — added in the **same** D14/D2 commit `9761cd9`, written via `encryptWithPurpose` from day one | **No** — v2-only by construction (verify in the audit slice; also always null for MANUAL) |

**Re-encryption target set: three fields** — `PlaidItem.encryptedToken`, `User.totpSecret`, `User.dateOfBirthEncrypted`. `Connection.credential` is expected to be v2-only but is included in the read-only audit purely to *prove* zero v1.

> **Out of scope for KD-6:** `User.passwordResetToken` is a *hashing-at-rest* concern (D11), not GCM ciphertext — it is not part of this re-encryption and must not be conflated with it.

---

## 3. How to identify v1 vs v2 (discriminator)

The format is self-describing; no schema column or side-table is needed. The canonical test is exactly the logic already in `decryptWithPurpose()`:

```
parts = value.split(":")
v2  ⟺ parts.length === 4 && parts[0] === "v2"
v1  ⟺ parts.length === 3
else → malformed / not-our-ciphertext
```

**Why this is unambiguous and safe:**

- v1 segments are all hex; hex contains no `:`, so a v1 value splits to **exactly 3** parts.
- A v1 IV is 16 bytes → 32 hex chars, so `parts[0]` of a v1 value can never literally equal `"v2"`. No collision between the version tag and a legitimate v1 IV.
- Null/empty (`totpSecret`, `dateOfBirthEncrypted`, `credential` are nullable) → skip.

This same discriminator is what makes the backfill **idempotent**: a second run sees v2 and skips.

---

## 4. Impact map

| Area | Impact of Slice 5 | Notes |
|---|---|---|
| `lib/plaid/encryption.ts` | Eventually: delete deprecated `encrypt()`/`decrypt()`; later remove v1 branch of `decryptWithPurpose()` | Two separate removal gates — see §8 |
| DB rows (3 fields) | Ciphertext rewritten v1→v2 in place; **plaintext unchanged** | Same column, same type; no length concern (v2 adds a 3-char `v2:` prefix) |
| `prisma/schema.prisma` | **None** | Format is self-describing; no column, no enum, no migration needed |
| App read paths | **None during/after** | `decryptWithPurpose` already reads both formats throughout the backfill |
| App write paths | **None** | Already emit v2 (Slice 4 done) |
| Key material | **None** | Same root `ENCRYPTION_KEY`; v2 subkeys derive from the same root. Re-encryption is a *format* migration, not a key rotation |
| Runtime services | Read-side unaffected; backfill runs as an offline/maintenance job | No downtime required |
| Out-of-scope systems | Atlas / FlowType / Merchant / Daily Brief / SpaceDashboard / UI / provider adapters — **untouched** | |

**Blast-radius / security framing (D14 §327):** re-encryption is what finally *realizes* D14's isolation guarantee for legacy rows — until a v1 row is rewritten, that secret is still bound to the root key directly rather than its purpose subkey. Completing Slice 5 is what lets "rotate the Plaid key" stop implicitly meaning "also break TOTP + DOB."

---

## 5. Migration / backfill strategy (idempotent)

**Shape:** an offline maintenance script (sits alongside existing `scripts/*backfill*.ts`), run per environment. Not a Prisma migration (no schema change). Not an app request path.

**Per field, per row:**

1. Read `id` + ciphertext. If null/empty → skip.
2. Classify via §3 discriminator. If **v2** → skip (idempotent no-op). If **malformed** → do not touch; log to an exceptions list for manual review.
3. If **v1**: `plaintext = decryptWithPurpose(value, purpose)` (its v1 branch handles it) → `next = encryptWithPurpose(plaintext, purpose)`.
4. **Round-trip verify before write:** assert `decryptWithPurpose(next, purpose) === plaintext`. If not, abort that row, log, continue. Never persist a value you can't decrypt back to the original.
5. **Compare-and-swap write:** `UPDATE ... SET field = next WHERE id = ? AND field = <original v1 value>`. If 0 rows affected, a concurrent write already changed it → skip. This prevents clobbering a live app write mid-run.

**Properties:**

- **Idempotent** — re-running only ever touches remaining v1 rows; v2 rows are skipped by construction. Safe to run repeatedly and to resume after interruption.
- **Online-safe** — reads keep working throughout (dual-format); CAS write avoids races with live writes.
- **Batched** — process in stable `id`-ordered pages with a small delay; per-field counters (`scanned / v1 / rewritten / skipped-v2 / malformed / cas-miss`).
- **Dry-run first** — a `--report` mode that only classifies and counts, writing nothing. This *is* the confirmation of the real v1 population (§9 first slice).
- **Scope guard** — three named fields only; `Connection.credential` audited read-only.

**Sequencing across environments:** dry-run everywhere → mutate `preview` → verify 0 v1 → mutate `production` → verify 0 v1. Keep the deprecated helpers and the v1-read branch in place across all of this (§8).

---

## 6. Rollback plan

Re-encryption is **non-destructive to availability**: because `decryptWithPurpose` reads both formats and the root key is unchanged, the app functions identically before, during, and after — so "rollback" almost never means reverting data.

- **Abort mid-run:** stop the job. Partially-migrated state is fully valid (mixed v1/v2 both readable). Re-run later resumes safely.
- **Bad-ciphertext defense:** the step-4 round-trip verify + step-5 CAS guarantee no unreadable value is ever written; a row that fails verification is left as v1 and logged.
- **True data restore (defense in depth):** before the mutating run in each environment, capture a snapshot of `(id, field)` for the three fields (a small `SELECT` dump or a standard DB backup). To reverse a specific row, restore its original ciphertext from the snapshot. Pre-images are only needed if a bug slipped past verification — not expected, but cheap insurance.
- **No key rollback involved** — nothing about `ENCRYPTION_KEY` changes, so there is no key-state to restore.

---

## 7. Validation checklist

**Pre-implementation gates (per project working style):**

- [ ] `npx prisma generate` (no schema change expected — confirms clean)
- [ ] `npx tsc --noEmit`
- [ ] `npm run lint`
- [ ] *No* `prisma migrate dev` — schema is untouched (flag if investigation-during-build proves otherwise)

**Correctness (unit tests — new; note there is currently no encryption test file, itself a gap to close):**

- [ ] v1 round-trips to identical plaintext, for each of the 3 purposes
- [ ] Re-encrypted v2 decrypts back to the original plaintext
- [ ] Version discriminator: v1 (3-seg) → v1, `v2:`+4-seg → v2, other → error
- [ ] **Idempotency:** running the backfill twice rewrites 0 rows on the second pass
- [ ] Null/empty nullable fields are skipped, not errored
- [ ] Malformed value is quarantined, not written

**Data validation (dry-run + post-run):**

- [ ] Dry-run report: v1/v2/null/malformed counts per field, per environment
- [ ] Post-run: **0 v1 rows** for all three fields (and confirmed 0 for `Connection.credential`)
- [ ] Functional smoke: TOTP login verify, Plaid `refresh`/`link-token`, DOB profile read all succeed post-run

**High-stakes verification:** run the post-run 0-v1 count and functional smoke via an independent check (subagent or second reviewer) before declaring KD-6 closed, given this touches auth secrets.

---

## 8. When the deprecated helpers can be removed (two gates)

There are **two** distinct removals; do not collapse them.

**Gate 1 — delete exported `encrypt()` / `decrypt()` (deprecated).**
Already safe: **0 callers today** (Slice 4 complete). These are dead exports. Can be removed as an early, trivial, low-risk cleanup slice *independent of the backfill* — removing them does not affect the ability to read v1 rows (that lives in `decryptWithPurpose`'s v1 branch, which stays).

**Gate 2 — remove the v1-read branch inside `decryptWithPurpose()`.**
Only after **all** hold:
1. Backfill reports **0 v1 rows** for all three fields in **every** environment (prod + preview + any long-lived dev/seed DB).
2. A retention window has passed such that no pre-backfill DB backup could be restored into service and silently reintroduce v1 (align the window with the DB backup-retention policy).
3. The `malformed` exception list is empty or explicitly triaged.

Until Gate 2, keeping the v1 branch is harmless (it's a read fallback) and is the safety net if a restore reintroduces v1. Removing it early would turn a routine DB restore into a decryption outage.

---

## 9. Recommended first implementation slice

**Slice 5a — read-only audit + encryption unit tests. No data writes. No schema.**

Rationale: the single biggest unknown is *how many* v1 rows actually exist (possibly near-zero if the DB is young), and there is currently **no test coverage** on the encryption module at all. Slice 5a de-risks everything downstream and directly answers the scope question "confirm which fields can still contain v1."

Contents:
1. A `--report` maintenance script that classifies and counts v1/v2/null/malformed per field (three targets + `Connection.credential` for proof), writing nothing.
2. The unit-test suite from §7 (round-trip, discriminator, idempotency, null/malformed).
3. Run the report in each environment; record counts in `STATUS.md` against KD-6.

**Then, gated on approval:** Slice 5b = the idempotent mutating backfill (§5) with snapshot + CAS + verify. Slice 5c = Gate 1 helper deletion. Slice 5d = Gate 2 v1-branch removal after the retention window. Each is its own checklist → approval → implementation → validation cycle; **none are bundled into one commit.**

---

## 10. Summary

The debt is narrow and well-bounded. Writes are already 100% v2; the only v1 data can live in three fields, all self-identifying by a `v2:` prefix, all readable today via a dual-format decrypt. The work is: (a) prove the v1 population, (b) rewrite it in place with an idempotent, online-safe, verify-then-CAS backfill needing **no schema change**, then (c) retire the deprecated exports (already dead) and, after a backup-retention window, the v1-read branch. Recommended first move is a zero-write audit + the missing unit tests.

**Stopping here per instruction — investigation only.**
