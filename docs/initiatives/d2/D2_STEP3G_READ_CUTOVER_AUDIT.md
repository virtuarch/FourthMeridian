# D2 Step 3G — ProviderAccountIdentity Read Cutover Audit

Status: **read-only audit complete. No code changes. No schema changes. No migrations.**

> **Naming note:** prior D2 reports (3A, and `docs/initiatives/d2/D2_ROADMAP.md`) used "Step 3G" to refer to a *future* decision — removing the legacy-field fallback from 3C–3F once proven stable. This task names the present *audit* "Step 3G" instead. The two are not the same activity: this document audits, it does not remove anything. Recommend the roadmap reserve "3G" for whichever of these two activities is canonical and letter the other 3G\` / 3H accordingly — flagged here for the user/roadmap maintainer to resolve; not changed unilaterally in this read-only pass.

## 1. Repo-wide inventory

`plaidAccountId` appears 215 times across 28 files. Full breakdown by file and classification:

| File | Occurrences | Classification |
|---|---|---|
| `app/api/plaid/exchange-token/route.ts` | 14 | Active production read (cut over, 3C + 3F) + write path + comments |
| `lib/accounts/reconcile.ts` | 15 | Active production read (cut over, 3D) + comments + one unused selected field |
| `scripts/backfill-provider-account-identity.ts` | 14 | Backfill script (one-time tooling, already run) |
| `lib/plaid/syncTransactions.ts` | 11 | Active production read (cut over, 3F) + comments |
| `docs/initiatives/d2/D2_STEP3A_PROVIDER_ACCOUNT_IDENTITY_READ_CUTOVER_INVESTIGATION.md` | 21 | Documentation |
| `docs/initiatives/d2/D2_STEP2A_PLAID_DUAL_WRITE_INVESTIGATION.md` | 19 | Documentation |
| `scripts/verify-provider-account-identity-backfill.ts` | 13 | Verification script (read-only tooling) |
| `docs/initiatives/d2/D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md` | 15 | Documentation |
| `lib/plaid/refresh.ts` | 8 | Active production read (cut over, 3E) + comments |
| `docs/initiatives/d2/D2_STEP3D_RECONCILE_READ_CUTOVER_IMPLEMENTATION.md` | 8 | Documentation |
| `docs/architecture/D2_CONNECTION_ARCHITECTURE_REVIEW.md` | 9 | Documentation (superseded doc, retained) |
| `docs/initiatives/d2/D2_STEP3F_SYNCTRANSACTIONS_HOLDINGS_READ_CUTOVER_IMPLEMENTATION.md` | 10 | Documentation |
| `app/api/accounts/[id]/restore/route.ts` | 6 | Write/no-op site — selects field, consumes already-cut-over `reconcile.ts` helper + comments |
| `docs/initiatives/d2/D2_STEP3E_REFRESH_READ_CUTOVER_IMPLEMENTATION.md` | 6 | Documentation |
| `docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md` | 7 | Documentation |
| `docs/initiatives/d2/D2_ROADMAP.md` | 6 | Documentation |
| `docs/initiatives/d2/D2_STEP3C_EXACT_MATCH_READ_CUTOVER_IMPLEMENTATION.md` | 5 | Documentation |
| `lib/accounts/provider-identity.ts` | 4 | Write path (dual-write helper, 2A) + comments |
| `prisma/seed.ts` | 4 | Write path (dev/test seed data only — not production) |
| `docs/initiatives/d1/D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md` | 4 | Documentation |
| `prisma/schema.prisma` | 4 | Schema field (×2 models) + comments |
| `prisma/migrations/20260611000001_financial_account_tables/migration.sql` | 4 | Historical migration SQL (immutable) |
| `app/api/accounts/wallet/route.ts` | 1 | Comment only (notes wallet accounts have no `plaidAccountId`) — unrelated to PLAID cutover |
| `app/api/accounts/manual/[id]/restore/route.ts` | 1 | Write/no-op site — selects field, consumes already-cut-over `reconcile.ts` helper |
| `docs/releases/v2.0.1.md` | 1 | Documentation |
| `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` | 1 | Documentation |
| `prisma/migrations/20260609234422_init/migration.sql` | 2 | Historical migration SQL (immutable) |

Every file was read in full (not just grep context) before classification below.

## 2. Classification detail — code files only

**Active production reads, cut over (the six fallback call sites):**

| # | Site | Step | Identity lookup | Fallback (legacy) | Warning tag |
|---|---|---|---|---|---|
| 1 | `exchange-token/route.ts` — account exact-match | 3C | `providerAccountIdentity.findUnique` | `financialAccount.findUnique({plaidAccountId})` | `[plaid][D2-3C]` |
| 2 | `exchange-token/route.ts` — holdings cross-ref | 3F | `providerAccountIdentity.findUnique` | `financialAccount.findUnique({plaidAccountId})` | `[plaid][D2-3F]` |
| 3 | `refresh.ts` — balance/metadata lookup | 3E | `providerAccountIdentity.findUnique` | `financialAccount.findUnique({plaidAccountId})` | `[plaid][D2-3E]` |
| 4 | `refresh.ts` — holdings cross-ref | 3E | `providerAccountIdentity.findUnique` | `financialAccount.findUnique({plaidAccountId})` | `[plaid][D2-3E]` |
| 5 | `reconcile.ts` — `findActiveAccountByIdentity` (PLAID branch) | 3D | `providerAccountIdentity.findUnique` | `financialAccount.findFirst({plaidAccountId, deletedAt:null})` | `[plaid][D2-3D]` |
| 6 | `syncTransactions.ts` — `resolveFinancialAccountId` | 3F | `providerAccountIdentity.findUnique` | `financialAccount.findUnique({plaidAccountId})` | `[plaid][D2-3F]` |

Every one of these checks `ProviderAccountIdentity` first; the legacy `plaidAccountId` query only executes — and only then logs — on an identity-table miss. No site reads `plaidAccountId` as the primary path.

**Indirect consumers (no independent read, inherited automatically):**

- `app/api/accounts/[id]/restore/route.ts` — selects `plaidAccountId` as account data, hands it to `providerIdentityOf()` → `findActiveAccountByIdentity()` (site 5 above). No separate query of its own. Confirmed exactly as the 3D report predicted: zero additional changes needed.
- `app/api/accounts/manual/[id]/restore/route.ts` — same pattern, same inherited cutover.

**Write paths (correctly untouched — these populate the legacy column, they don't read it for resolution):**

- `exchange-token/route.ts` lines 208 and 227 — set `FinancialAccount.plaidAccountId` on fingerprint-repoint and on fresh create, immediately followed by `dualWriteProviderAccountIdentity()` (Step 2A). This is the one place the column is still written, by design — D2 never stops writing it, only stops reading it as the primary source.
- `lib/accounts/provider-identity.ts` — the 2A dual-write helper itself; queries/writes `ProviderAccountIdentity` keyed on `(financialAccountId, provider)`, never queries `plaidAccountId` directly. Comments reference it conceptually only.
- `prisma/seed.ts` — dev/test fixture data, writes `plaidAccountId` directly on both the legacy `Account` and `FinancialAccount` rows. Not production code, not in D2's cutover scope. **Observation (informational, not a defect):** seeded accounts get no `ProviderAccountIdentity` row unless the backfill script is re-run afterward against the seeded DB — a dev-tooling gap, not a production read-path gap.

**WALLET — confirmed still untouched, as intended:**

- `app/api/accounts/wallet/route.ts` and `reconcile.ts`'s WALLET branch of `findActiveAccountByIdentity` both query `FinancialAccount.walletAddress` directly — no `ProviderAccountIdentity` involvement at all. No accidental WALLET cutover occurred anywhere in the repo.

**Tooling (PLAID-scoped, not production app code):**

- `scripts/backfill-provider-account-identity.ts` — one-time backfill, already executed (Step 1C-A).
- `scripts/verify-provider-account-identity-backfill.ts` — read-only verification, PLAID-only by design, WALLET reported as a known exception (Step 1C-B / 3B).

**Schema fields (unchanged, both still `@unique`, neither dropped):**

- `prisma/schema.prisma` line 592 — legacy `Account.plaidAccountId`.
- `prisma/schema.prisma` line 656 — `FinancialAccount.plaidAccountId`.

**Minor cleanup observation (not a Step 3 blocker):** `reconcile.ts`'s `CANDIDATE_SELECT` (fingerprint-match path) selects `plaidAccountId` into `FingerprintCandidate`, but neither `pickCanonicalAndMerge` nor `resolveAccountByFingerprint` ever reads `c.plaidAccountId` — it's selected but unused. Harmless (fingerprint matching is deliberately identity-independent — it's the path that runs *when* an exact `plaidAccountId`/identity match has already failed), and out of Step 3's scope to touch. Flagged as a low-priority candidate for a future small cleanup pass, not for this audit to act on.

**Documentation, release notes, migration SQL:** all comment/historical record only — no code behavior, no action needed. Old sections preserved per standing rule; nothing here flags a coverage gap.

## 3. Production read-path status

Confirmed: every PLAID production read path identified by the original Step 3A inventory now resolves via `ProviderAccountIdentity` first. No direct, unconditional production read of `FinancialAccount.plaidAccountId` remains anywhere in the codebase — the six remaining `plaidAccountId`-keyed queries in production code are exclusively the fallback half of an already-cut-over lookup, each gated behind an identity-table miss and each logging a step-tagged warning when hit. No accidental or missed direct read was found in this audit's full-file review of every code file in the inventory.

Fallback behavior exists at all six sites, exactly where the 3C/3D/3E/3F reports said it would, and nowhere else.

## 4. Disposition recommendation

**Must remain until at least Step 3G (fallback-removal decision) / observed-stable:**

- The six fallback call sites (table in §2) — they are the safety net this whole staged migration depends on. Retire only after an observation period shows zero `[plaid][D2-3C/3D/3E/3F]` warnings in production logs, and only as its own explicit, separately-approved decision (not bundled here).
- `scripts/verify-provider-account-identity-backfill.ts` — still the tool that would detect coverage gaps before/during that observation period; useful at least through fallback removal, plausibly generalized rather than retired in Step 7.

**Must remain indefinitely (no removal planned, ever, without a separate explicit decision):**

- `FinancialAccount.plaidAccountId` and legacy `Account.plaidAccountId` schema columns — standing project rule against premature removal of legacy fields/tables.
- The two write sites in `exchange-token/route.ts` — this is where the legacy column keeps getting populated; D2's plan was always read-cutover, not write-cutover.

**Retirement candidates (low priority, not urgent, not part of Step 3):**

- `scripts/backfill-provider-account-identity.ts` — one-time tool, already served its purpose; safe to leave as historical/rerunnable tooling rather than delete.
- `reconcile.ts`'s unused `plaidAccountId` field in `CANDIDATE_SELECT` — dead but harmless; candidate for a future small cleanup pass.

**No action of any kind recommended for:** documentation files, release notes, migration SQL — all correctly historical/immutable.

## 5. Confirmations

- No Step 3 code changes are pending — 3C, 3D, 3E, 3F are each fully implemented and this audit found no read site any of them missed.
- No additional read cutovers are required — the inventory above is exhaustive (every file in the repo containing `plaidAccountId`, all 28, read and classified).
- WALLET remains intentionally deferred — confirmed no `ProviderAccountIdentity` involvement anywhere in the WALLET path, consistent with the 1C-C investigation's open decision.

## Recommendation

**Step 3 (PLAID read cutover, 3A–3F) is complete.** No further read-cutover implementation work is required. Fallback-removal (whatever its final letter turns out to be once the naming note in §0 is resolved) remains a distinct, separate, later decision gated on a production observation period — not started by this audit and not implied as ready by this report.

## Validation

| Check | Result |
|---|---|
| `git diff --stat` | Only this new file added (`docs/initiatives/d2/D2_STEP3G_READ_CUTOVER_AUDIT.md`); zero modifications to any existing file |
| Code changes | None |
| Schema changes | None |
| Migrations | None |

---

**Stopping here per scope. No fallback-removal work, no Step 4 work, started.**
