# D2 Step 2 — WALLET Dual-write: Implementation & Validation

Status: **implemented. `prisma generate`/`migrate dev` blocked in this sandbox (same
limitation as every prior D2 step); `tsc`/`lint` validated against a regenerated client
that reflects D2 Step 1D.**

Implements WALLET dual-write under the corrected model from D2 Step 1D
(`docs/initiatives/d2/D2_STEP1D_PROVIDER_ACCOUNT_IDENTITY_MULTI_ACCOUNT_CORRECTION.md`):
wallet addresses are public external identities; `FinancialAccount` rows remain private
per-user/Space interpretations; no cross-owner sharing; no signature verification; no
collision handling. Resumes exactly where that doc's revised checklist (§4/§5/§6) left off.

---

## 1. Files changed

| File | Change |
|---|---|
| `app/api/accounts/wallet/route.ts` | Added `ProviderType` to the `@prisma/client` import. Added `dualWriteProviderAccountIdentity` import. Added one call each in the active-match, archived/reactivate, and create branches — `dualWriteProviderAccountIdentity(<id>, ProviderType.WALLET, walletAddress.trim())`. Updated the module header's "Creates" list to mention the mirror write. |
| `scripts/backfill-provider-account-identity.ts` | Added a WALLET backfill block alongside the existing PLAID block: eligible = `deletedAt IS NULL AND walletAddress IS NOT NULL`, no exclusion set. Updated header doc and summary output to report PLAID/WALLET counts separately plus a total. |
| `scripts/verify-provider-account-identity-backfill.ts` | Extended Checks 1-3 to run for WALLET as well as PLAID (factored into a shared `checkEligibleAccounts` helper to avoid duplicating the loop twice). Narrowed Check 4 to PLAID-only (see §3 below — this was a necessary correction, not optional). Generalized Check 5 (orphaned identities) to both providers. Replaced the old "WALLET-for-now" framing in Check 6 with "no external identifier at all" (MANUAL/other), since WALLET is no longer an exception bucket. Added new Check 7: informational count of wallet addresses tracked by more than one account. |

**Not changed:** `prisma/schema.prisma` (no schema work this slice), `lib/accounts/reconcile.ts` (per D2 Step 1D §5, no change needed for WALLET), `lib/accounts/provider-identity.ts` (the dual-write helper itself — reused as-is; see §4 note below), any UI, any PLAID code path, any migration.

## 2. Why each call site is where it is

Each of the three branches in `wallet/route.ts` resolves its own `FinancialAccount` id (`activeFa.id`, `archivedFa.id`, `fa.id`) at a different point. The dual-write call was placed immediately after that branch's existing `dualWriteSpaceAccountLink` call in each case — both are best-effort, non-fatal mirror-table writes, so grouping them keeps the pattern consistent and easy to scan. All three calls use the same owner-scoped `walletAddress.trim()` value the branch already validated; none of the existing `ownerUserId` filters were touched.

No collision handling was added anywhere, per the approved model: if another owner already has a `FinancialAccount` for the same address, `dualWriteProviderAccountIdentity`'s `create()` simply succeeds with that owner's distinct `financialAccountId` — D2 Step 1D's corrected constraint `(provider, externalAccountId, financialAccountId)` allows this by design. This is the simplification D2 Step 1D was a prerequisite for: this slice required zero new logic to handle that case, only the three call sites.

## 3. One necessary correction beyond the literal ask: Check 4

The verify script's existing Check 4 grouped `ProviderAccountIdentity` rows by `(provider, externalAccountId)` only and flagged any group of size >1 as a failure. That was correct under the old global-unique constraint, but under D2 Step 1D's corrected model it would now flag the *intended* case — two different owners' accounts sharing one wallet address — as a failure. Extending Checks 1-3 to WALLET without also fixing Check 4 would have made this script fail on entirely correct, expected data.

Fix: Check 4 now runs PLAID-only (where global address-uniqueness is still a real invariant, backed independently by `FinancialAccount.plaidAccountId @unique`). The WALLET equivalent is new Check 7 — purely informational, reports the count and lists which addresses are shared, never fails. This wasn't on the explicit file-change list but is a direct, unavoidable consequence of "extend checks 1–3 to WALLET... no exclusion bucket" — flagging it here rather than letting it pass silently.

## 4. One thing intentionally *not* changed

`lib/accounts/provider-identity.ts`'s module header still says "WALLET is not wired to this helper... nothing calls it with provider=WALLET today" — that line is now stale, since this slice wires it. Left unedited: it wasn't on the listed file set, and the helper's actual code is provider-generic and required no behavior change to support WALLET (confirmed by reading it — `dualWriteProviderAccountIdentity` already takes `provider: ProviderType` as a parameter). Worth a one-line comment fix in a future small follow-up; not done here to keep this slice's diff to exactly what was asked.

## 5. Validation summary

| Check | Result |
|---|---|
| `npx prisma generate` | **Blocked.** `403 Forbidden` fetching engine binaries from `binaries.prisma.sh`, including with `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1`. Same sandbox limitation as every prior D2 step — no egress to that host from here. |
| `npx prisma migrate dev` | **Blocked**, same root cause. No schema change in this slice, so no migration is expected regardless — confirm this by checking `git status`/`prisma/migrations/` locally; nothing here should produce a new migration folder. |
| `npx tsc --noEmit` | **PASS, and a real signal this time.** Checked `node_modules/.prisma/client/index.d.ts` directly: the generated client in this workspace already reflects D2 Step 1D's corrected constraint (`provider_externalAccountId_financialAccountId` compound key present, old two-field key absent). So this is not the stale-client false-pass from the Step 1D session — `tsc` ran against the actual current types and found nothing wrong in the new WALLET call sites. |
| `npm run lint` | PASS — 0 errors, 4 pre-existing `no-img-element` warnings, unrelated and unchanged. |

## 6. Scope confirmation

- No schema or migration changes.
- No Plaid code touched.
- No Step 3 (read cutover) work — WALLET stays write-only into `ProviderAccountIdentity`, exactly like PLAID was between Steps 2A and 3.
- No UI changes.
- No cross-owner sharing, reuse, merge, or collision-handling logic added anywhere.
- No signature/ownership verification added.
- `findActiveAccountByIdentity()` and `mergeArchivedDuplicateIntoCanonical()` in `lib/accounts/reconcile.ts` untouched, per D2 Step 1D §5.

---

Stopping here per instruction.
