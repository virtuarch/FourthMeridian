# D2 Step 1C-C — Wallet Identity Collision Investigation

Status: **read-only investigation. No code, schema, migration, or data changes made.**

Context confirmed before writing this report:
- D2 Step 1A, 1B applied locally. D2 Step 1C-A (PLAID backfill script) and 1C-B (PLAID verification script) complete — live backfill ran, 3 rows inserted, verification passed.
- `ProviderAccountIdentity` still has zero application readers (confirmed again: no new references introduced since Step 1C). No WALLET rows exist in the table yet.
- `FinancialAccount.walletAddress` (schema.prisma:662) carries no `@unique` or composite-unique annotation — confirmed directly in `prisma/schema.prisma`, not inferred.
- `ProviderAccountIdentity.@@unique([provider, externalAccountId])` (schema.prisma:557) is **global** — it does not include `ownerUserId` or any per-user scoping.

---

## A. Wallet inventory summary

No live DB access from this sandbox (same limitation as Steps 1A/1B/1C-A/1C-B — `localhost:5432` unreachable, Prisma engine blocked). What's confirmed from code and fixture data:

- **Creation path:** exactly one route creates wallet `FinancialAccount` rows — `app/api/accounts/wallet/route.ts`. No other route sets `walletAddress` on create.
- **Mutability:** `walletAddress` is immutable after creation. The only PATCH route (`app/api/accounts/[id]/route.ts`) allows `creditLimit`, `debtSubtype`, `interestRate`, `minimumPayment`, `displayName` — never `walletAddress`.
- **Format validation:** none. The create route's only check is `!walletAddress?.trim()` — empty/whitespace is rejected, but there is no length check, no chain-specific format check (e.g. BTC bech32/base58, ETH `0x`+40-hex), no checksum validation. A malformed or nonsensical string is accepted today. This doesn't threaten the `@@unique` constraint by itself, but it means `externalAccountId` quality for WALLET rows would be only as good as whatever the user typed.
- **Seed/fixture baseline:** `prisma/seed.ts` contains exactly 2 wallet accounts — Jane's BTC wallet (`bc1demo...janeA`) and John's BTC wallet (`bc1demo...johnB`). Distinct addresses, distinct owners, neither archived. Zero collision in fixture data. This is a baseline only — not necessarily representative of the real dev/prod database, which may have more wallets added since seeding.

Exact queries to run locally for real counts:

```sql
-- Wallet inventory
SELECT
  ("deletedAt" IS NULL) AS active,
  COUNT(*) AS account_count,
  COUNT(*) FILTER (WHERE "walletAddress" IS NULL OR TRIM("walletAddress") = '') AS null_or_empty,
  COUNT(DISTINCT "walletAddress") AS distinct_addresses
FROM "FinancialAccount"
WHERE "walletAddress" IS NOT NULL
GROUP BY 1;

-- Any malformed-looking addresses (quick heuristic, not authoritative — flags very short/odd values for manual review)
SELECT id, "ownerUserId", "walletAddress", "walletChain", "deletedAt"
FROM "FinancialAccount"
WHERE "walletAddress" IS NOT NULL AND LENGTH(TRIM("walletAddress")) < 20;
```

---

## B. Collision findings

**1. No DB-level uniqueness exists on `walletAddress` today.** Confirmed directly in schema.prisma:662 — no `@unique`, no composite unique. Nothing in Postgres prevents two `FinancialAccount` rows, under any two owners, from holding the identical `walletAddress`.

**2. The application-level duplicate check is owner-scoped, not global — confirmed in two independent places:**

- `app/api/accounts/wallet/route.ts` (create path): both the active-duplicate check and the archived-duplicate check query `{ ownerUserId: userId, walletAddress: walletAddress.trim() }`. Nothing in this route ever queries by `walletAddress` alone.
- `lib/accounts/reconcile.ts`: `providerIdentityOf()` returns `{ kind: "wallet", ownerUserId, walletAddress }` (line 65–66), and `findActiveAccountByIdentity()` builds its lookup as `{ ownerUserId: identity.ownerUserId, walletAddress: identity.walletAddress }` (line 80) for the wallet branch. This function is the shared dedup engine used by both the wallet route and the generic restore route — so every existing wallet-merge path in the codebase is owner-scoped by design.

**This means: two different users adding the identical `walletAddress` today produces two completely independent, permanently-active `FinancialAccount` rows. Nothing detects it, nothing warns about it, nothing merges it.** This isn't a hypothetical edge case in the abstract sense — it's a direct, confirmed gap in the current duplicate-detection logic.

**3. This is a structural mismatch with the schema already shipped in Step 1B.** `ProviderAccountIdentity.@@unique([provider, externalAccountId])` is global — no `ownerUserId` in the constraint. The app's wallet semantics are owner-scoped; the new schema's wallet semantics (as shipped) are global. These two models of "what makes a wallet identity unique" disagree.

Concretely, if backfill ever wrote both colliding rows: `createMany({ skipDuplicates: true })` would insert the first and **silently drop the second** — no error, no log, nothing surfaced to anyone. One user's wallet would simply never get a `ProviderAccountIdentity` row, with no signal that it happened. This is the central risk this investigation was asked to evaluate, and it does not depend on how many real collisions exist today — it's a property of the schema-vs-app mismatch itself. It will surface the moment a real collision exists, today or in the future, unless something changes first.

**4. Active+archived same-address case.** `mergeArchivedDuplicateIntoCanonical()` already exists specifically to fold a stale archived duplicate into an active canonical row (same owner, same address) — confirmed called from `wallet/route.ts`. If archived rows were ever included in a backfill (the eligibility matrix below excludes them, consistent with the PLAID rule), an archived row sharing its `walletAddress` with its own active counterpart would collide on `(provider, externalAccountId)` by design — same reasoning Step 1C already used to exclude archived PLAID rows.

**5. No live collision data available from this sandbox.** Query to run locally before any backfill decision:

```sql
-- Wallet-address collision pre-check (must be empty before any WALLET backfill)
SELECT "walletAddress",
       COUNT(*)                       AS account_count,
       COUNT(DISTINCT "ownerUserId")   AS distinct_owners,
       ARRAY_AGG(id)                   AS account_ids
FROM "FinancialAccount"
WHERE "walletAddress" IS NOT NULL AND "deletedAt" IS NULL
GROUP BY "walletAddress"
HAVING COUNT(*) > 1;

-- Cross-state collision: same address active for one row, archived for another
SELECT a."walletAddress", a.id AS active_id, b.id AS archived_id
FROM "FinancialAccount" a
JOIN "FinancialAccount" b
  ON a."walletAddress" = b."walletAddress" AND a.id <> b.id
WHERE a."deletedAt" IS NULL AND b."deletedAt" IS NOT NULL;
```

---

## C. Ownership findings

Wallet accounts are created through exactly one route, `app/api/accounts/wallet/route.ts`. Validation before create:

```
if (!name?.trim())          → 400
if (!walletAddress?.trim()) → 400
if (!walletChain?.trim())   → 400
if (!SUPPORTED_CHAINS.includes(chain)) → 400
```

That's the entire check. No cryptographic signature challenge, no on-chain verification, no proof-of-control of any kind. A user can type any string — their own address, a public figure's address, another tracked user's address, or pure garbage — and the route accepts it as long as it's non-empty and the chain is in the allowlist. The pre-create duplicate check only asks "does *this* user already have this exact address," never "does *anyone* already have this address" and never "does this address actually belong to this user." Conclusion: yes, multiple users can trivially add the same `walletAddress` today, with zero friction and zero detection anywhere in the codebase.

**Route inventory — wallet lifecycle touchpoints** (confirmed via `find app/api/accounts -type f -name "*.ts"`, 11 routes total):

| Action | Route | Wallet-specific? |
|---|---|---|
| Create / re-share-if-active / reactivate-if-archived | `app/api/accounts/wallet/route.ts` (POST) | Yes — the only route that ever sets `walletAddress` |
| Restore from archive (explicit action) | `app/api/accounts/[id]/restore/route.ts` (POST) | No — generic, id-based, applies identically to wallet/Plaid/manual rows via `providerIdentityOf()` |
| Archive / soft-delete | `app/api/accounts/[id]/route.ts` (DELETE) | No — generic, never touches `walletAddress`, Plaid-disconnect branch is a no-op for wallets |
| Rename / edit mutable fields | `app/api/accounts/[id]/route.ts` (PATCH) | No — `walletAddress` is not in the allowed field list; immutable post-create |
| `app/api/accounts/manual/[id]/restore/route.ts` | Ruled out — read directly; hard-guards `fa.type !== "other"` (rejects everything except manual assets), so it can never act on a wallet row. The `walletAddress` field in its `select` is incidental (shared type signature with `providerIdentityOf()`), not functional for wallets. |

**Single hook point for future writes:** there is no one unified "wallet write" route, but two seams already concentrate the writes that matter:
1. The create-branch inside `wallet/route.ts` is the only place a brand-new `walletAddress` is ever attached to a brand-new account — a future write hooks here once.
2. `mergeArchivedDuplicateIntoCanonical()` in `lib/accounts/reconcile.ts` is already the single shared function called by every route that discovers a duplicate (wallet route, generic restore route, Plaid exchange-token route) — a future "re-point `ProviderAccountIdentity.financialAccountId`" write would hook here once and cover all callers automatically, the same pattern `dualWriteSpaceAccountLink`/`dualWriteFromShares` already use elsewhere in this codebase.

---

## D. Eligibility matrix and recommended backfill strategy

| Category | Eligible? | Reasoning |
|---|---|---|
| WALLET, active, collision-free | Conditional | Safe only after B's pre-check query confirms zero collisions for that address |
| WALLET, active, colliding (same address, ≥2 owners) | **Not safe** | Second insert would be silently dropped by `skipDuplicates` — no error, no record of the loss |
| WALLET, archived | **Not safe (deferred)** | Same reasoning as archived PLAID — risk of colliding with its own active counterpart post-merge |
| WALLET, reactivated (was archived, now active again) | Same as active | No different from any other active row once reactivated; `walletAddress` doesn't change across the archive/restore cycle |
| WALLET, shared into multiple spaces | No effect on identity | `ProviderAccountIdentity` is keyed on `FinancialAccountId`, not on space/share — sharing into more spaces doesn't change eligibility either way |

**Recommended rule: Option C — delay WALLET identities until the dual-write phase, not Option B.**

Rationale: Option B (backfill only collision-free addresses now) is workable for *today's* data, but it doesn't fix the actual gap — `wallet/route.ts`'s create path has zero global duplicate detection, so nothing stops a *new* collision from appearing the day after a clean backfill. Once that happens, the table starts silently drifting (a new wallet quietly fails to get an identity row) with no current alerting to catch it. Choosing B commits the team to re-running the collision pre-check indefinitely until dual-write lands, for a table nothing reads yet.

Given there is no current reader of `ProviderAccountIdentity` and zero urgency, the cost of waiting (Option C) is purely "wallet identities arrive a step later." The better fix is to close the gap at the source: when the wallet create-path is upgraded for dual-write, add real cross-owner collision handling (reject, warn, or merge) *before* any `ProviderAccountIdentity` row is ever written for a wallet — rather than backfilling against an invariant the app doesn't actually enforce.

Option A (backfill all wallets now, no pre-check) is not recommended — it ignores a confirmed, not hypothetical, schema/app mismatch.

If the team prefers partial progress now, **Option B is a documented, acceptable fallback** — run the pre-check, exclude any colliding address, backfill the rest, and accept the open monitoring commitment until dual-write closes the gap.

---

## E. Verification design (for when wallet backfill proceeds, regardless of timing)

Extends `scripts/verify-provider-account-identity-backfill.ts`'s existing pattern:

| # | Check | Treatment |
|---|---|---|
| 1 | Missing wallet identity — eligible active WALLET account (not in the collision-exclusion set) has no `ProviderAccountIdentity` row | Real failure |
| 2 | Duplicate wallet identity — `FinancialAccount` has >1 WALLET identity row | Real failure |
| 3 | `walletAddress` mismatch — `identity.externalAccountId` ≠ current `account.walletAddress` | Real failure (should never drift today since `walletAddress` is immutable post-create, but check directly rather than assume) |
| 4 | Global `(provider, externalAccountId)` uniqueness | Already covered by the existing PLAID script's Check 4 — provider-generic, needs no change, will catch WALLET rows automatically once they exist |
| 5 | Orphaned WALLET identities pointing at a soft-deleted account | Informational only |
| 6 | Known exceptions — MANUAL/other, archived accounts, addresses excluded by the collision pre-check (reported by address + affected owner count) | Informational only |
| 7 (recommended addition, beyond the literal PLAID mirror) | **Standing cross-owner collision monitor** — independent of backfill state, group active `FinancialAccount` by `walletAddress` where `COUNT(DISTINCT ownerUserId) > 1` | Informational/monitoring — this is the structural risk from B; worth surfacing on every verification run so it doesn't go unnoticed even before backfill happens |

---

## F. Smallest safe implementation slice

Given the Option C recommendation, the smallest safe slice right now is **not a backfill**. It is:

1. Run the collision pre-check query (B) locally to learn whether the risk is theoretical or real in the actual database — zero code required, this report's query is sufficient.
2. Defer extending `scripts/backfill-provider-account-identity.ts` and `scripts/verify-provider-account-identity-backfill.ts` with a WALLET branch until either (a) the team explicitly accepts Option B's fallback and the pre-check comes back clean, or (b) the dual-write phase begins and the wallet create-path gets real collision handling at write time.

If the team chooses to proceed with Option B instead, the next concrete step would be a Step 1C-D extending the same two scripts with the WALLET logic designed in D/E above — not authorized by this report.

---

## Open decisions carried forward (not resolved by this report)

1. Whether wallet identity should ultimately be modeled as global (current schema) or owner-scoped (current app behavior) — these disagree today, and reconciling them is a schema-level decision, out of scope for a read-only investigation.
2. Whether to add real ownership verification (signed-message challenge) to `wallet/route.ts` at the same time dual-write is added — would close the gap at its actual source rather than working around it downstream.
3. Same open items carried from Step 1C: archived-row identity retention policy, EXCHANGE/BROKERAGE/CSV timing — unchanged.

**No implementation performed. No schema, migration, route, UI, or data changes made in this step.**
