# SEC-1 / KD-6 — Invalid `PlaidItem.encryptedToken` Investigation

> **Read-only investigation. No writes, deletes, re-encryption, schema, or app-code changes were made. No token values or decrypted secrets appear in this document.**
> Follow-up to the Slice 5a audit, which reported: **v1 = 0, invalid = 9 (all in `PlaidItem.encryptedToken`)**.

## 0. Bottom line

The 9 invalid values are the **demo/seed placeholder token** `"[demo-placeholder-not-a-real-token]"` written by `prisma/seed.ts` — not real credentials, not plaintext secrets, not malformed legacy ciphertext. They classify as "invalid" only because the literal contains no `:`, so it is neither the 3-segment v1 nor the `v2:`+4-segment v2 format.

- **Re-encryption: not applicable.** There is no real secret to protect; nothing to migrate.
- **KD-6 (v1→v2) can be considered complete.** v1 count is 0; the 9 invalids are out of scope for a v1→v2 migration.
- **Deprecated helpers: yes, `encrypt()`/`decrypt()` can be removed now** (Gate 1). The v1-read branch of `decryptWithPurpose()` is a separate, later decision (Gate 2).

---

## 1. What the 9 values are (Q1)

`prisma/seed.ts` seeds demo `PlaidItem` rows with a literal placeholder in place of a real Plaid access token:

```
encryptedToken: "[demo-placeholder-not-a-real-token]"
```

A repo count confirms **exactly 9** such literals in `seed.ts` — matching the audit's 9 invalid rows one-for-one:

| Owner (seed user) | Count | Lines in `seed.ts` |
|---|---|---|
| Jane Smith | 4 | 432–435 |
| John | 5 | 774–778 |
| **Total** | **9** | |

Classification against the four hypotheses:

- **Null-like placeholder?** No — it is a non-empty string (so counted "invalid", not "null").
- **Plaintext real token?** No — it is a bracketed sentinel, and by name/shape is not an `access-…` Plaid token.
- **Malformed legacy ciphertext?** No — it was never produced by `encrypt()`; it is a hand-written seed constant.
- **Intentionally fake seed/dev token?** **Yes — this is exactly what it is.** Deliberate demo fixture.

These rows only exist where `prisma db seed` has been run (dev/preview, or any environment seeded with demo data). The exact 9-for-9 match makes the identification effectively conclusive; the diagnostic script (§7) confirms it row-by-row in whichever environment you run it.

---

## 2. Which rows are affected (Q2)

All are demo `PlaidItem`s, `status = ACTIVE`, owned by the two demo users, with `externalItemId` prefixed `demo_item_` and `institutionId` in `demo_ins_00X` / `manual_entry`:

| externalItemId | institutionName | institutionId | owner |
|---|---|---|---|
| `demo_item_demobank` | Demo Bank | demo_ins_001 | Jane |
| `demo_item_examplecu` | Example Credit Union | demo_ins_002 | Jane |
| `demo_item_samplebrokerage` | Sample Brokerage | demo_ins_003 | Jane |
| `demo_item_fictionalcrypto` | Fictional Crypto Exchange | demo_ins_004 | Jane |
| `demo_item_beaconbank` | Beacon Bank | demo_ins_005 | John |
| `demo_item_alphabrokerage` | Alpha Brokerage | demo_ins_006 | John |
| `demo_item_alphacrypto` | Alpha Crypto Exchange | demo_ins_007 | John |
| `demo_item_summitbusiness` | Summit Business Bank | demo_ins_008 | John |
| `demo_item_manual_john` | Manual Entry | manual_entry | John |

> **Row `id` values are cuid()s generated at seed time, so they differ per environment.** The diagnostic script (§7) prints the actual `id`s for your database. This document deliberately keeps to the stable `externalItemId`s rather than guessing ids.

---

## 3. Are the affected items active / archived / stale / demo (Q3)

**All 9 are demo/test fixtures with `status = ACTIVE`.** They are not archived, superseded, or error-flagged in seed — `seed.ts` sets `status: PlaidItemStatus.ACTIVE` on every one. "Active" here is a seed default, not evidence of a live bank link; there is no real Plaid Item behind them.

---

## 4. Associated Connections / FinancialAccounts (Q4)

**Yes — the demo items are wired to demo accounts.** In `seed.ts`, `createFullAccount(...)` builds a `FinancialAccount` + `AccountConnection` (+ `SpaceAccountLink`) for each demo institution, linking back via `plaidItemDbId`. So each affected `PlaidItem` has one or more `AccountConnection` rows and the `FinancialAccount`s behind them (e.g. Demo Bank → Checking, HYSA, Japan Trip Fund).

They do **not** map to D2 `Connection` rows — demo data uses the legacy `PlaidItem` → `AccountConnection` path, not the `Connection` model. (`PlaidItem.connections` is confusingly typed `AccountConnection[]`, not `Connection[]`.) The diagnostic script reports active/total `AccountConnection`s, the distinct `FinancialAccount`s they reach, and any legacy `Account` rows, per affected item.

---

## 5. Would they break Plaid refresh / sync? (Q5)

**They error per-item, but do not break the batch — and make no external Plaid call.**

Both batch paths select `status = ACTIVE`, so the demo items are picked up:

- `refreshAllActiveItemsForUser` (`lib/plaid/refresh.ts`) — wraps **each item in its own try/catch**. It also skips items with no active linked account via `hasActiveLinkedAccount`; the demo items *do* have linked accounts, so they proceed to `refreshPlaidItem`, where `decryptWithPurpose("[demo-placeholder…]")` throws `Invalid ciphertext format` **before any Plaid API call**. Caught → recorded `ok: false`; `classifyPlaidErrorForHealth` returns null for a non-Plaid error, so status is left unchanged. Batch continues.
- `syncBanks` (`jobs/sync-banks.ts`) — same per-item isolation ("One institution's failure … must never block syncing the rest"). Same decrypt-throw, caught, next item.

Net effect: in any environment where these seed rows exist **and** a sync/refresh job runs for the demo users, each demo item logs a decrypt error and counts as a failed item every run — **log noise, not breakage, and no secret exposure** (the throw happens before Plaid is contacted, and the error is a format error that never contains the token). In production without demo seed data, there is no effect at all.

---

## 6. Recommended action (Q6)

**Ignore for KD-6; clean up only as demo-data hygiene, and only if a sync job actually runs against seeded environments.** Ranked:

1. **Preferred — leave as-is for KD-6 purposes.** They are correct, intentional demo fixtures. No security or data-integrity issue. KD-6 does not require touching them.
2. **Optional hygiene (separate from KD-6), if the per-run error noise is undesirable in a seeded environment:** exclude non-real items from sync at the *query* level — e.g. have the batch selectors skip items whose token is unusable, or tag demo items so refresh/sync ignores them. This is a **sync-path** change, explicitly out of scope for this investigation and for KD-6; flag it as its own small ticket if wanted.
3. **Not recommended:** deleting or re-encrypting the rows. Deletion would break the demo dataset's accounts/spaces; re-encryption is meaningless for a non-secret placeholder.

No cleanup is required in production unless the audit is confirming that demo seed data reached a production database — in which case the right fix is removing demo data via the seed/reset tooling, not a token migration.

---

## 7. How to confirm in your environment (read-only)

`scripts/diagnose-invalid-plaid-tokens.ts` (new, read-only) prints, per invalid row: `id`, owner id + email, `externalItemId`, institution, status, `createdAt`, **token shape only** (length, segment count, boolean `seedPlaceholder` / `plaintextPlaidToken` / `printableAscii` flags — never the value), and related `AccountConnection` / `FinancialAccount` / legacy `Account` counts. It never decrypts and never prints a token.

```
npx tsx scripts/diagnose-invalid-plaid-tokens.ts
```

Expected result: `invalid rows: 9`, `all seed placeholders: true`, `any plaintext Plaid tok: false`. (It cannot be run from the investigation sandbox — the mounted `node_modules` carries macOS-only Prisma/esbuild binaries — so run it in your own environment. `tsc --noEmit` already type-verifies its every DB field.)

If the script ever reports `all seed placeholders: false` or `any plaintext Plaid tok: true`, stop and treat it as a real-secret-at-rest finding — do not print or log the value.

---

## 8. KD-6 completeness & helper removal

**Can KD-6 be considered complete despite the invalid rows? — Yes.**
KD-6 is specifically the v1→v2 re-encryption debt. v1 count is **0**, so there is nothing to re-encrypt. The 9 invalids are demo placeholders, categorically outside a ciphertext-version migration. KD-6 (SEC-1) can be closed as **no re-encryption required**, with the demo-placeholder note recorded so a future audit reader isn't surprised by a non-zero "invalid" count.

**Can the deprecated helpers be removed now? — Split, per the Slice 5a two-gate model:**

- **Gate 1 — `encrypt()` / `decrypt()` exports: removable now.** They have **zero callers** (confirmed Slice 4/5a) and are pure dead code. Removing them does not affect reading legacy rows. Note: `scripts/audit-ciphertext-versions`' test and `encryption.test.ts` reference `encrypt` to *generate* a v1 fixture — update those two call sites in the same change, or keep a tiny test-only v1 encryptor. This is a small, low-risk cleanup slice (call it 5c).
- **Gate 2 — the v1-read branch inside `decryptWithPurpose()`: not yet.** Its removal was gated on 0 v1 rows in *every* environment **plus** a backup-retention window (so a restore can't reintroduce v1). v1 is 0 in the audited environment; confirm the same across all environments and let the retention window pass before removing it. The 9 invalids are irrelevant to this gate (they are not v1 and never enter that branch). Keeping the branch until then remains the safe default.

---

## 9. Scope & guardrails honored

No writes, deletes, or re-encryption. No schema or app-code modified. No token values or decrypted secrets printed. The only new artifact is one read-only diagnostic script; the classifier and tests from Slice 5a are unchanged.

**Investigation only — stopping here.**
