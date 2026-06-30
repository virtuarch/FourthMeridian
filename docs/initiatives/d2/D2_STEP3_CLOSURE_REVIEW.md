# D2 Step 3 — Read Cutover Closure Audit

Status: **read-only audit complete. No code changes. No schema changes. No
migrations. No documentation edits other than this file.**

Scope: confirm whether D2 Step 3 (Read Cutover) can now be marked closed,
given everything that has landed since the prior closure pass
(`D2_STEP3G_READ_CUTOVER_AUDIT.md`) — the D2 Step 1D schema correction, the
WALLET dual-write, the orphaned-PlaidItem bugfix, and the archived-account
warning refinement. Not re-auditing Step 4 (already closed separately in
`D2_STEP4_CLOSURE_REVIEW.md`), not starting Step 5, not touching
fallback-removal (Step 7).

**Naming note:** this file is deliberately not called "Step 3G" — that label
already exists (`D2_STEP3G_READ_CUTOVER_AUDIT.md`, the original PLAID
closure audit) and `D2_ROADMAP.md` L56 has since formally retired "3G" as a
Step 3 sub-step name, reserving the term informally for the Step 7
fallback-removal decision instead. This file follows the
`D2_STEP4_CLOSURE_REVIEW.md` naming precedent for a cross-cutting "is this
step done" sign-off review.

---

## 1. What changed since the original Step 3 closure

Four commits landed after `D2_STEP3G_READ_CUTOVER_AUDIT.md`:

| Commit | What | Touches a Step 3 PLAID read-cutover site? |
|---|---|---|
| `8ac2291` D2 Step 1D — multi-account `ProviderAccountIdentity` correction | `@@unique([provider, externalAccountId])` → `@@unique([provider, externalAccountId, financialAccountId])`; every PLAID lookup changed `findUnique` → `findFirst` | Yes — mechanical only. Same identity-first/fallback-second order, same warning tags, same six sites. PLAID's real uniqueness is still independently guaranteed by `FinancialAccount.plaidAccountId @unique`, so this is a type-shape change, not a behavior change (each site's own comment says so). |
| `03a99c7` WALLET dual-write | `app/api/accounts/wallet/route.ts` gains three `dualWriteProviderAccountIdentity(..., ProviderType.WALLET, ...)` calls (lines 103, 186, 269) | No — write-side only. Confirmed via `git show --stat 03a99c7`: it does not touch `lib/accounts/reconcile.ts` or any of the six PLAID fallback sites. |
| `8f719fa` Orphaned PlaidItem lifecycle fix | New `closeOutAccountConnections()` in `reconcile.ts`; calls into `disconnectPlaidItemIfOrphaned()` | No — lifecycle/connection cleanup only. No identity read added or changed. |
| `3289796` Archived-account warning suppression | `refresh.ts`'s two fallback-hit `console.warn` calls gated behind `!fa.deletedAt` / `!legacyFa.deletedAt` | No — logging condition only. Resolution order (identity table first, legacy column second) is unchanged; only whether the fallback-hit gets logged for an already-archived sibling account changed. |

None of the four touched the resolution logic at any of the six PLAID
fallback call sites the original audit inventoried. This audit re-read all
six in full to confirm that directly rather than inferring it from the diffs
alone (§2).

## 2. Re-verification: the six PLAID fallback call sites, unchanged in structure

| # | Site | Step | Identity lookup (re-read this session) | Fallback (legacy) | Warning tag |
|---|---|---|---|---|---|
| 1 | `exchange-token/route.ts` — account exact-match | 3C | `providerAccountIdentity.findFirst` | `financialAccount.findUnique({plaidAccountId})` | `[plaid][D2-3C]` |
| 2 | `exchange-token/route.ts` — holdings cross-ref | 3F | `providerAccountIdentity.findFirst` | `financialAccount.findUnique({plaidAccountId})` | `[plaid][D2-3F]` |
| 3 | `refresh.ts` — balance/metadata lookup | 3E | `providerAccountIdentity.findFirst` | `financialAccount.findUnique({plaidAccountId})` | `[plaid][D2-3E]` (now gated on `!fa.deletedAt`) |
| 4 | `refresh.ts` — holdings cross-ref | 3E | `providerAccountIdentity.findFirst` | `financialAccount.findUnique({plaidAccountId})` | `[plaid][D2-3E]` (now gated on `!legacyFa.deletedAt`) |
| 5 | `reconcile.ts` — `findActiveAccountByIdentity` (PLAID branch) | 3D | `providerAccountIdentity.findFirst` | `financialAccount.findFirst({plaidAccountId, deletedAt:null})` | `[plaid][D2-3D]` |
| 6 | `syncTransactions.ts` — `resolveFinancialAccountId` | 3F | `providerAccountIdentity.findFirst` | `financialAccount.findUnique({plaidAccountId})` | `[plaid][D2-3F]` |

All six still check `ProviderAccountIdentity` first; the legacy column query
only runs — and only then logs — on an identity-table miss. The only delta
from the original audit's table is `findUnique` → `findFirst` (Step 1D,
mechanical) and the two added `deletedAt` warning guards in `refresh.ts`
(Step 3289796, logging only). No site reads `plaidAccountId` as the primary
path. No new fallback site was introduced, and no existing one was removed.

## 3. New surface added since the original audit — none of it is a read-resolution gap

- `app/api/accounts/wallet/route.ts` lines 103, 186, 269 — `dualWriteProviderAccountIdentity(..., ProviderType.WALLET, ...)`. Write-only, best-effort, non-fatal, identical pattern to the existing PLAID dual-write (Step 2A). Does not read `ProviderAccountIdentity` or change how the surrounding owner-scoped `walletAddress` lookups resolve identity.
- `lib/accounts/reconcile.ts`'s new `closeOutAccountConnections()` — closes out `AccountConnection`/`PlaidItem` rows on a losing merge candidate. No `plaidAccountId`/`walletAddress` read anywhere in its body.
- An exhaustive re-grep this session (`plaidAccountId:`/`walletAddress:` as a query key, every `.ts`/`.tsx` file under `app/`, `lib/`, `scripts/`) found no `FinancialAccount` lookup keyed on either field beyond the sites already named in §2 and §4. The inventory is the same shape as the original 3G audit's, plus the three new WALLET write call sites.

## 4. WALLET — the open question is resolved, but not by cutting WALLET over

This is the substantive update since the original closure. At the time of
`D2_STEP3G_READ_CUTOVER_AUDIT.md`, WALLET was "intentionally deferred,"
phrased as blocked on an *open* decision (the 1C-C identity-collision
question: does `walletAddress` map onto provider identity the same way
`plaidAccountId` does?). `D2_ROADMAP.md` still carries that phrasing today
— L54 ("blocked on the same WALLET identity semantics question") and the
"Required notes" WALLET paragraph (L110, "stays blocked until those
semantics are explicitly resolved").

That question has since been answered, by `D2_STEP1D_PROVIDER_ACCOUNT_
IDENTITY_MULTI_ACCOUNT_CORRECTION.md` §5: a wallet address is a public
external fact that multiple private `FinancialAccount` rows — belonging to
different owners — may legitimately and independently reference. Routing
WALLET identity *resolution* through `ProviderAccountIdentity` (a table with
no owner scoping of its own) would mean one user's lookup could resolve to,
or leak the existence of, another owner's private account for the same
public address. The fix was not "cut WALLET over once the semantics are
clear" — it was "correct the schema so dual-write can proceed safely
(`@@unique([provider, externalAccountId, financialAccountId])`), and decide
that resolution must stay owner-scoped and direct against
`FinancialAccount.walletAddress`, permanently." This is a closed design
decision, not a pending one.

Confirmed directly in this session:

- `app/api/accounts/wallet/route.ts`'s three identity-resolution lookups (active match, archived-duplicate fold, archived match — all `db.financialAccount.findFirst({ ownerUserId, walletAddress, deletedAt })`) are unchanged by the dual-write commit and remain owner-scoped/direct.
- `reconcile.ts`'s `findActiveAccountByIdentity` WALLET branch is the same direct `ownerUserId` + `walletAddress` lookup as before — `git show --stat 03a99c7` confirms this function's file wasn't even touched by the WALLET dual-write commit.

**Recommendation for the roadmap maintainer (not applied here — out of this
audit's scope):** `D2_ROADMAP.md` L54 and L110 should be reworded from
"blocked on an open decision" to "permanently excluded from read cutover by
design (D2 Step 1D §5) — dual-write ships, read resolution stays direct."
The practical status (no WALLET read cutover, none planned) is unchanged;
only the *reason* changed, from "not yet decided" to "decided, and the
decision is never."

## 5. Confirmation — every production identity-resolution path traced to one of the six sites or to WALLET's direct path

Walked every file the repo-wide sweep surfaced, beyond what's already
covered in §2–§4:

- **Both restore routes** (`app/api/accounts/[id]/restore/route.ts`, `app/api/accounts/manual/[id]/restore/route.ts`) — select `plaidAccountId`/`walletAddress` only to build a `ProviderIdentity` via `providerIdentityOf()`, then call `findActiveAccountByIdentity()` (site 5 in §2, which itself branches into the WALLET direct path for WALLET identities). No independent query of their own. Unchanged since the original audit.
- **Legacy `Account` model** (`db.account.*`, 4 call sites: `app/admin/page.tsx`, `app/api/admin/overview/route.ts`, `app/api/accounts/[id]/transactions/route.ts`, `lib/imports/authorize.ts`) — all four resolve by primary key (`id`/`spaceId`) or are bare `.count()` calls for admin stats. None reads `Account.plaidAccountId` or `Account.walletAddress` for identity resolution. The legacy `Account` model's own copies of these two fields (schema lines 621, 626) are dormant — present for the standing "never remove legacy columns prematurely" rule, zero active readers.
- **Display/UI/type files** (`archived-assets/page.tsx`, `manual/route.ts` comments, `AddWalletModal.tsx`, `AssetDrawer.tsx`, `InvestmentsClient.tsx`, `lib/data/accounts.ts`, `lib/mock-data.ts`, `types/index.ts`) — all display labeling, form bodies, UI props, type definitions, or dev fixtures. None performs identity resolution.
- **Tooling** (`scripts/backfill-provider-account-identity.ts`, `scripts/verify-provider-account-identity-backfill.ts`, `scripts/cleanup-orphaned-plaid-items.ts`, `scripts/verify-orphaned-plaid-items.ts`) — one-time backfill and read-only verification/cleanup scripts, explicitly out of this audit's scope per the task's own filter (migration/backfill/verification/diagnostics).
- **Schema and seed** (`prisma/schema.prisma`, `prisma/seed.ts`) — field definitions and dev fixtures, not runtime resolution code.

No remaining production code path resolves a provider identity directly
from `FinancialAccount.plaidAccountId` or `FinancialAccount.walletAddress`
outside the six accounted-for PLAID fallback sites (§2) and WALLET's
intentionally-direct path (§4).

## 6. Classification summary

| Occurrence class | Disposition |
|---|---|
| PLAID fallback reads (6 sites, §2) | **Required legacy compatibility** — the safety net Step 3 was built around; stays until a separate, later, explicitly-approved Step 7 decision retires it after an observed-stable period. |
| WALLET direct reads (`wallet/route.ts` ×3, `reconcile.ts` WALLET branch) | **Intentional canonical read** — permanent by design (D2 Step 1D §5), not a cutover candidate. |
| WALLET dual-write calls (`wallet/route.ts` ×3) | **Intentional canonical write** — Step 2 WALLET, mirrors PLAID's Step 2A pattern; writes only, no resolution role. |
| Restore-route field selects | **Intentional canonical read** (delegated) — no independent logic, inherits site 5's cutover/WALLET-direct behavior automatically. |
| Legacy `Account.plaidAccountId`/`walletAddress` columns | **Required legacy compatibility** — dormant, zero active readers, retained per standing no-premature-removal rule. |
| `exchange-token/route.ts` plaidAccountId writes (create/repoint) | **Required legacy compatibility** — column is still the column of record; D2 was always read-cutover, not write-cutover. |
| Backfill/verify/cleanup scripts | **Verification / tooling / Migration / backfill** — explicitly out of this audit's scope. |
| `prisma/schema.prisma`, `prisma/seed.ts` | **Documentation only** / fixture — not a runtime resolution path. |
| Display/UI/type files | **Out of scope** (display, not identity resolution) — confirmed, not reclassified. |
| Candidates for replacement with `ProviderAccountIdentity` | **None found.** |

## 7. Recommendation

**D2 Step 3 is architecturally complete.** This reaffirms the original
`D2_STEP3G_READ_CUTOVER_AUDIT.md` conclusion for PLAID (3A–3F), and closes
the one open item that audit left outstanding: WALLET's identity semantics
question is no longer pending — it has been resolved as a permanent
exclusion from read cutover, not a temporary deferral. No additional
read-cutover implementation work is required for either provider.

Recommend marking Step 3 complete, with the roadmap text updated (by
whoever next edits `D2_ROADMAP.md`, per this audit's read-only scope) to
reflect WALLET's resolved-permanent status rather than its now-stale
"blocked" phrasing (§4).

**Legacy fields that intentionally remain, and why:**

- `FinancialAccount.plaidAccountId` / legacy `Account.plaidAccountId` — backing fallback at the six sites in §2 until Step 7 retires the fallback after an observation period; the column itself is never dropped per standing rule.
- `FinancialAccount.walletAddress` / legacy `Account.walletAddress` — the permanent, correct identity-resolution mechanism for WALLET; not a transitional field, not a cutover candidate.
- `ProviderAccountIdentity.connectionId` — still always `null` for both providers; `Connection` has zero writers anywhere in the codebase. Unrelated to read cutover, a separate, later, not-yet-approved decision.

## Validation

| Check | Result |
|---|---|
| `git status --short` | Clean — no tracked-file changes from this audit |
| `git diff --stat` | Only this new file added (`docs/initiatives/d2/D2_STEP3_CLOSURE_REVIEW.md`) |
| Code changes | None |
| Schema changes | None |
| Migrations | None |

---

**Stopping here per scope. No roadmap-doc edits, no fallback-removal work, no Step 4/5 work started.**
