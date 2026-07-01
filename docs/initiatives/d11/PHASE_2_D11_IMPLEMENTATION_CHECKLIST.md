> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D11 — Schema Modernization: Implementation Checklist

**Status: Documentation only. No schema, migration, API, or application code was modified to produce this checklist.**
**Branch:** `feature/phase-2-architecture` · **Baseline stated in project instructions:** `v2.3.0`

---

## 0. Critical finding — read first

The project instructions frame D11 as *not yet started* ("First deliverable: create an implementation checklist … do not edit schema, migrations, API routes, or UI yet"). **The repository does not match that premise.** All three D11 items are already implemented, migrated, and wired into live code paths:

| D11 item | Status in repo | Evidence |
|---|---|---|
| Migrate `Holding` from legacy `Account` to `FinancialAccount` | **Landed** | Migration `20260622150000_d11_holding_financial_account_fk_and_created_by` loosens `Holding.accountId` to nullable and adds `Holding.financialAccountId` FK (+ indexes + unique). Schema `prisma/schema.prisma:1100–1125` reflects it. |
| Hash `passwordResetToken` at rest | **Landed** | `lib/password-reset-token.ts` (`hashResetToken`, SHA-256). `forgot-password/route.ts:56` stores `hashResetToken(rawToken)`; `reset-password/route.ts:30` looks up by hash. |
| Add `FinancialAccount.createdByUserId` | **Landed** | Same D11 migration adds the column, index, `SetNull` FK, and a backfill from `ownerUserId` → earliest `AccountConnection.connectedByUserId`. Schema `prisma/schema.prisma:681–682, 757`. |

Beyond D11, the repo has also already shipped migrations for **D1, D2, D3, and D4** (see `prisma/migrations/`) and an AI context builder — i.e. the codebase is materially ahead of the `v2.3.0` baseline the instructions assume.

**Per the project rule "do not re-litigate approved decisions unless implementation reveals a concrete blocker": this is that concrete blocker.** D11 cannot be *implemented* because it already exists. This checklist is therefore written as a **verification / audit checklist** to confirm the landed work is complete and correct, plus two residual items that genuinely still need a decision. See §5 for the recommended path and the one question for you.

---

## 1. Scope (as originally defined)

D11 = branch 1, `feature/schema-modernization` (Freeze doc §16.1; Decision Matrix D11 / D8 lifecycle rule). Three additive changes:

1. Close out the `Holding` → legacy `Account` FK gap by anchoring `Holding` to `FinancialAccount`.
2. Hash `passwordResetToken` at rest (currently the only Tier-1 secret stored plaintext per Freeze doc §7).
3. Add `FinancialAccount.createdByUserId` — a human-accountable creator independent of the visibility owner (Freeze doc §4, §19.3).

All three are **additive before subtractive**: no legacy table dropped, no column removed, no in-place rename (Freeze doc §15).

---

## 2. Impact map

### 2.1 `Holding` → `FinancialAccount`
- **Schema:** `Holding.accountId` `String` → `String?`; new nullable `Holding.financialAccountId` + FK (`onDelete: Cascade`), `@@unique([financialAccountId, symbol])`, two indexes. Legacy `accountId` FK to `Account` retained (dual-FK pattern, mirroring `Transaction`).
- **Write paths that must target the new FK:** `lib/plaid/exchangeToken.ts` (holdings written with `financialAccountId` — lines 287/296/319/386 ✅), `lib/plaid/refresh.ts` (`financialAccountId` — line 238 ✅, delete-by `financialAccountId` — line 223 ✅).
- **Residual legacy write path:** `lib/sync/computeCashResidual.ts` still creates/deletes the synthetic cash-residual `Holding` keyed on `accountId` (legacy `Account`), lines 32–51. **Verify whether this is still reachable** (who calls `computeCashResidual`, and with a legacy `Account.id` or a `FinancialAccount.id`?). If reachable, it is the one remaining piece of the "migrate Holding" work; if dead, note it for deletion in a later subtractive branch.
- **Read paths:** `lib/data/accounts.ts`, `lib/plaid/refresh.ts`, `lib/mock-data.ts` reference `Holding` — confirm none assume `accountId` is non-null.
- **Legacy table:** `Account` NOT dropped. `Holding.accountId` FK NOT dropped. Correct per §8 / §17.

### 2.2 `passwordResetToken` hashing
- **New module:** `lib/password-reset-token.ts` — `hashResetToken()` = SHA-256 hex (deliberately *not* bcrypt; rationale documented in-file: 256-bit random token's own entropy is the security property, and equality lookup must stay O(1)).
- **Column reused, not renamed:** the hash is stored in the existing `User.passwordResetToken String? @unique` column — no `passwordResetTokenHash` rename. Consistent with §17's "no in-place renames." **Confirm this naming choice is acceptable** (schema field name now says "token" but holds a hash — a comment on the field would remove the ambiguity; see §5 residual).
- **Call sites:** `app/api/auth/forgot-password/route.ts` (stores hash), `app/api/auth/reset-password/route.ts` (looks up by hash, nulls on use). Both updated ✅.
- **No migration required** for the hashing itself — column type unchanged; it is a code-only change. In-flight plaintext tokens issued before deploy become unusable (acceptable — users re-request; see rollback).

### 2.3 `FinancialAccount.createdByUserId`
- **Schema:** new nullable column + index + FK `onDelete: SetNull` (`prisma/schema.prisma:681–682, 757`).
- **Backfill:** `COALESCE(ownerUserId, earliest AccountConnection.connectedByUserId)`; rows with neither left NULL. Additive, never blocks an insert.
- **Creation path:** confirm new `FinancialAccount` inserts set `createdByUserId` going forward (exchange-token / manual-account / import paths). **This is worth an explicit grep** — the migration backfills history, but the field only stays meaningful if new rows populate it.
- **Unrelated UI:** untouched, per "do not modify unrelated UI while doing schema work."

---

## 3. Rollback plan

- **`Holding` FK:** additive and non-destructive. Rollback = down-migration dropping `financialAccountId` column/indexes/FK and restoring `accountId NOT NULL` (safe only while every row still has `accountId` set). Because writes now populate `financialAccountId`, a true rollback after production writes would orphan new holdings — so the real rollback is *forward-fix*, not revert. Flag: once new holdings exist with `financialAccountId` and null `accountId`, the down-migration's `SET NOT NULL` on `accountId` will fail. Document this as a one-way door already crossed.
- **`passwordResetToken` hashing:** pure code rollback (revert the two routes + delete the helper). No DB change to undo. Cost: outstanding hashed tokens become invalid on revert — acceptable.
- **`createdByUserId`:** additive, nullable — drop-column down-migration is clean; no data depends on it yet.

---

## 4. Validation checklist

Run from repo root (per project working style). Because D11 is already applied, these are **confirm-green**, not first-run:

- [ ] `npx prisma generate` — client matches schema, no drift.
- [ ] `npx prisma migrate status` — D11 migration recorded as applied, no pending/failed. (Use instead of `migrate dev`, since the schema change already exists — running `migrate dev` on an up-to-date schema should be a no-op; do **not** author a new migration.)
- [ ] `npx tsc --noEmit` — no type errors from the dual-FK `Holding` shape.
- [ ] `npm run lint`.
- [ ] Targeted: forgot-password → reset-password round trip works end-to-end with a hashed token; an old plaintext-format token is rejected.
- [ ] Targeted: connect/refresh a Plaid account → holdings land on `financialAccountId`, cash-residual row behaves; verify `computeCashResidual` path (§2.1 residual).
- [ ] Data check: `SELECT count(*) FROM "FinancialAccount" WHERE "createdByUserId" IS NULL;` — expect ~0 (only rows with neither owner nor connection).
- [ ] Data check: `SELECT count(*) FROM "Holding" WHERE "financialAccountId" IS NULL AND "accountId" IS NULL;` — expect 0.

---

## 5. Residual items needing a decision (the only open work)

1. **`computeCashResidual.ts` legacy `accountId` write (§2.1).** Determine reachable vs. dead. If reachable with a legacy `Account.id`, it's an unfinished slice of "migrate Holding"; if it's already fed a `FinancialAccount.id` or unused, it's cleanup for a later subtractive branch. **Verification, not a schema change.**
2. **`passwordResetToken` field naming/comment (§2.2).** The column holds a hash but is named `passwordResetToken`. Optional additive clarity: a schema comment noting "stores SHA-256 hash, not the raw token." No functional change.

Neither is a blocker; both are additive/verification-only.

---

## 6. Recommended next step

D11's substance is done. Rather than "implement D11," the useful next actions are: (a) run the §4 verification suite and confirm green, (b) resolve the two §5 residuals, and (c) **realign the project baseline** — the instructions' `v2.3.0` / "nothing started" framing is stale against a repo that has already landed D1–D4 + D11. Confirming the true current baseline will make the checklists for the *remaining* decisions (D6/D7 provider catalog, D9 space template, etc.) accurate instead of re-planning work that already exists.

Per the project working style, no schema/migration/route/UI code was changed to produce this document. Awaiting your direction.
