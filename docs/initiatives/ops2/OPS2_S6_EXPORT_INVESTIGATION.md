# OPS-2 S6 — Personal Data Export: Investigation & Design

**Status:** INVESTIGATION — awaiting approval before implementation
**Slice:** OPS-2 S6 (Export). Precedes S7 (Delete Account).
**Companion contracts:** `OPS2_S5_DELETION_INVENTORY.md` (frozen soft/hard map), `OPS2_ACCOUNT_LIFECYCLE_INVESTIGATION.md` §5 (the ratified S6 sketch).
**Scope guardrails honored:** investigation only, no code, no schema change, no migration, no deletion logic, no background job, reuse existing visibility rules.

The one-line goal: export **everything the user owns**, accurately, **without leaking a single field the same read surface would redact** — by routing the export through the visibility helpers the app and AI already use, never around them.

---

## 1. Files inspected

**Schema / contracts**
- `prisma/schema.prisma` — every model below.
- `docs/initiatives/ops2/OPS2_S5_DELETION_INVENTORY.md` — frozen cascade + soft/hard map.
- `docs/initiatives/ops2/OPS2_ACCOUNT_LIFECYCLE_INVESTIGATION.md` §3.11, §4, §5, §7.

**Privacy / visibility (the reusable core)**
- `lib/account-privacy.ts` — `genericAccountName`, `sanitizeForBalanceOnly`, `normalizeSharedAccounts`.
- `lib/ai/visibility.ts` — `TRANSACTION_DETAIL_VISIBILITY` (= `[FULL]`), `grantsTransactionDetail`, `grantsAccountDetail`. **Single source of truth for "who may see detail."**
- `lib/data/accounts.ts` — `getAccountsWithVisibility`, `getAccounts`, `getHoldings`, `getFicoData`. Already SAL-visibility-filtered.
- `lib/data/transactions.ts` — `getTransactions`, `getDebtTransactions`, `getInvestmentTransactions`, `getTransactionDetail`. Already SAL-visibility-filtered; fail-closed.
- `lib/data/transactions.privacy.test.ts`, `lib/data/transaction-detail.privacy.test.ts` — the privacy invariants to mirror.
- `lib/accounts/space-account-link.ts` — SAL kind/ownership resolution (`resolvePersonalSpaceId`, `resolveAccountCreatorUserId`, `computeLinkKind`).
- `lib/space.ts` — `getSpaceContext` / `resolveSpaceContext` (per-Space read context + membership verification).

**Reusable infra**
- `lib/session.ts` — `requireFreshUser()` (live revocation check).
- `lib/rate-limit.ts` — `limitByIp`, `limitByUser`.
- `lib/audit-actions.ts` — `AuditAction` catalog (**`DATA_EXPORTED` is NOT present yet**).
- `lib/security-history.ts` — `SECURITY_HISTORY_ACTIONS` allowlist, `securityHistoryLabel`.
- `app/api/user/security-history/route.ts` — the allowlist read pattern to reuse.
- `app/api/user/deactivate/route.ts` — the exact sensitive-action template (fresh user → rate limit → mutate → security-alert email → audit).
- `lib/email/send.ts`, `lib/email/senders.ts` — `sendEmail("security-alert", …)`.
- `lib/imports/csv.ts`, `lib/imports/excel.ts`, `package.json` — `papaparse@5.5.4` (has `.unparse`), `exceljs@4.4.0` (import-only today).

---

## 2. Current capabilities

There is **no export capability of any kind**. Confirmed by grep: no `Content-Disposition`, no `text/csv`/xlsx response, no `download`/`export` route anywhere under `app/api`. `exceljs` and `papaparse` are wired for **import parsing only** (`lib/imports/*`, `app/api/accounts/[id]/import`). `papaparse.unparse` (CSV writer) is available but unused. Node has **no** built-in multi-file zip (only `zlib` gzip); no `jszip`/`archiver`/`adm-zip` dependency is installed.

What *does* exist and is directly reusable is the entire **read + redaction layer**: every account/transaction/holding read already flows through SAL visibility and the `lib/account-privacy.ts` sanitizers. S6 is therefore a **serialization slice, not a data-access slice** — the hard privacy work is already solved and tested; S6 must simply not bypass it.

---

## 3. Export inventory (what should be exported)

Two lenses combine to define "everything the user owns":

- **Ownership lens** — rows FK'd to the user (`userId`), and `FinancialAccount`s where `ownerType=USER & ownerUserId=self` or `createdByUserId=self`. Full detail, regardless of which Space they're linked into (an owned account carries its own `HOME` SAL, so the user's owning Space read already returns it at FULL).
- **Visibility lens** — for every Space the user is an **ACTIVE** member of, exactly what that Space read surface returns, already sanitized by SAL visibility.

The export builder iterates ACTIVE `SpaceMember` rows and calls the **existing per-Space data-layer functions** for each `spaceId`, then adds the personal-ownership rows. No raw table union.

| Section | Source models | Included | Excluded (see §4) |
|---|---|---|---|
| **Profile** | `User` | email, username, name/firstName/lastName, **decrypted DOB** (their own), employmentStatus, useCase, reportingCurrency, role, totpEnabled, emailVerifiedAt, pendingEmail (their requested address), lastBriefViewedAt, deactivatedAt, createdAt/updatedAt | passwordHash, totpSecret, raw `dateOfBirthEncrypted`, all `*Token`/`*Expiry`, forcePasswordReset |
| **Security** | `UserSession`, `RecoveryCode`, `User` | session rows (ip, userAgent, lastActiveAt, createdAt, revokedAt), totpEnabled, recovery-code **count + generatedAt/usedAt metadata** | `RecoveryCode.codeHash`, `sessionToken` |
| **Spaces** | `SpaceMember`, `Space` | the user's memberships (role, status, joinedAt) and each Space's own metadata (name, description, type, category, reportingCurrency, timestamps) | other members' rows beyond first-name (§4, open decision D3) |
| **Accounts** | `FinancialAccount`, `DebtProfile`, legacy `Account` | owned accounts in full incl. DebtProfile; shared accounts **only** at the visibility the SAL grants (FULL → full; BALANCE_ONLY → sanitized; SUMMARY_ONLY/PRIVATE → omitted) | mask/institution/rates of non-FULL shared accounts |
| **Connections** | `AccountConnection`, `PlaidItem`, `Connection`, `ProviderAccountIdentity` | rows where `connectedByUserId=self`: institutionName, status, lastSyncedAt, provider, wallet address / xpub (their own public fact) | `encryptedToken`, `Connection.credential`, `cursor`, `errorCode` |
| **Transactions** | `Transaction` | owned accounts: full. Shared accounts: **FULL-visibility only** (via `TRANSACTION_DETAIL_VISIBILITY`) | rows from BALANCE_ONLY / SUMMARY_ONLY / PRIVATE shared accounts |
| **Holdings** | `Holding` | same rule as transactions (FULL only for shared) | positions from non-FULL shared accounts |
| **Credit history** | `CreditScore` | all rows for the user (score, source, recordedAt) | — |
| **Goals** | `SpaceGoal`, `GoalContribution`, `GoalCheckIn` | PERSONAL-Space goals in full; SHARED-Space goals as the member sees them, with contributions restricted to accounts the user can see at FULL | contributions/check-ins that would reveal a non-visible member account (open decision D4) |
| **Audit history** | `AuditLog` | the user's own rows filtered to `SECURITY_HISTORY_ACTIONS` (reuse the S1 allowlist verbatim) | raw audit rows, admin-context metadata, other users' rows |
| **Imports** | `ImportBatch`, `ImportMappingProfile` | batches/profiles where `createdByUserId=self`: filename, source, counts, status, resolvedColumnMapping, timestamps | — |
| **AI data** | `AiAdvice`, `AiAgent` | PERSONAL-Space advice (summary, adviceText, riskLevel, generatedAt) — optional, open decision D5. Note "no chat transcripts are persisted." | SHARED-Space advice (Space property), agent internals |
| **Settings** | `User`, `SpaceDashboardSection` | reportingCurrency, useCase, employmentStatus, preferredSpaceId; PERSONAL-Space dashboard customizations | SHARED-Space dashboard config (Space property) |
| **Other** | `DuplicateAccountCandidate`, `SyncIssue`, `RateLimit`, `PlatformSetting`, `FxRate` | **none** — internal/system ledgers | all |

`SpaceSnapshot` rides under **Spaces/Accounts** as a tabular set (per the ratified §5 CSV list): PERSONAL-Space snapshots in full; SHARED-Space snapshots are Space aggregates and are scoped by decision D3. All snapshot/FX totals carry their `reportingCurrency` and are **labeled estimates** per MC1 doctrine.

---

## 4. Privacy analysis (shared Spaces — the core of the slice)

**Ownership map**

- **Belongs to the requesting user (full export):** `User` PII + decrypted DOB; `UserSession`/`RecoveryCode` metadata; `CreditScore`; `FinancialAccount` where `ownerType=USER & ownerUserId=self` OR `createdByUserId=self`, plus their `DebtProfile`, `AccountConnection`, `PlaidItem`, `Connection`, `ProviderAccountIdentity`; their `ImportBatch`/`ImportMappingProfile`; their `SpaceMember` rows; their allowlisted `AuditLog` rows; the entire **PERSONAL Space** and everything cascading from it.
- **Belongs to the Space (include only as a member sees it):** SHARED `Space` metadata, `SpaceGoal`, `SpaceSnapshot`, `AiAgent`/`AiAdvice`, `SpaceDashboardSection`, and `FinancialAccount` where `ownerType=SPACE`.
- **Belongs to other members (never the user's to export raw):** other members' owned accounts and their transactions/holdings/institution/rates; their `AccountConnection`/`PlaidItem`; SALs they added; goals/contributions/check-ins they authored; their PII beyond first name.
- **Must be excluded outright:** every secret/hash/token (`passwordHash`, `totpSecret`, `dateOfBirthEncrypted` raw, `RecoveryCode.codeHash`, `PlaidItem.encryptedToken`, `Connection.credential`, `sessionToken`); PRIVATE-linked accounts of others; raw audit beyond the allowlist; system tables (`SyncIssue`, `RateLimit`, `PlatformSetting`, `FxRate`, `DuplicateAccountCandidate`).
- **Must be anonymized (not excluded):** shared accounts linked **BALANCE_ONLY** → generic label via `genericAccountName` + summed balance only (`sanitizeForBalanceOnly`); **SUMMARY_ONLY** → qualitative only, no raw numbers; the other-member identity on any shared row → **first name only** (exactly what `normalizeSharedAccounts` already emits).

**Can existing filters be reused without a new visibility system? — Yes, and they must be.**

The redaction rule the export needs *is* `grantsAccountDetail` / `grantsTransactionDetail` (both `=== FULL`), and the sanitizers *are* `sanitizeForBalanceOnly` / `normalizeSharedAccounts`. The data-layer reads (`getAccountsWithVisibility`, `getTransactions`, `getHoldings`) already apply these and **fail closed** (absence of a grant = redact). Building a parallel export-only visibility path would be the single biggest correctness risk in the slice — it could drift from the read layer and leak. **Design rule: the export calls the same per-Space read functions the UI/AI call; it never re-queries `FinancialAccount`/`Transaction`/`Holding` directly for shared data.** The only direct-query work is the personal-ownership pass (rows keyed by `userId`/`ownerUserId`), which by construction contains no other member's data.

This also inherits the KD-1/KD-15/KD-19 discipline for free: if `TRANSACTION_DETAIL_VISIBILITY` ever widens, the export widens with it, in lockstep, from one constant.

---

## 5. Recommended format

**JSON + CSV, delivered as one ZIP bundle.**

- `manifest.json` — versioned envelope (`schemaVersion`, `generatedAt`, `userId`, per-section row counts, cap flags).
- `data.json` — the full canonical bundle, all sections, nested.
- `transactions.csv`, `accounts.csv`, `holdings.csv`, `snapshots.csv` — the tabular sets, written with **`papaparse.unparse`** using the **same column conventions the CSV importer reads** (`lib/imports/csv.ts`).

**Why this and not the alternatives:**

- **JSON-only** is the smallest to build but loses the round-trip self-consistency test and is poor for the tabular sets a user actually wants in a spreadsheet. Kept as the **zero-new-dependency fallback** (see D1).
- **JSON + CSV in a ZIP** is the smallest format that is *both* machine-complete (JSON) *and* self-validating: a `transactions.csv` written to import conventions can be fed back through the existing CSV importer as an automated correctness check. CSV writing is free (`papaparse` already installed). The only cost is a zip step.
- **Excel workbook** adds nothing over CSV here (the importer round-trips CSV, not xlsx), makes `exceljs` an output dependency, and is heavier to stream. Rejected.

**Honest cost:** a multi-file ZIP needs a library (`jszip` or `archiver`) — Node has no built-in. That is the one new dependency the recommended format implies (open decision D1). If we refuse any new dependency, ship **JSON-only** now and add the CSV/ZIP wrapper when a zip lib lands.

---

## 6. Proposed minimal implementation

Mirror `app/api/user/deactivate/route.ts` almost exactly — it is the ratified template for a sensitive user-scoped action.

**Endpoint:** `POST /api/user/export` (POST, not GET: audited, rate-limited, side-effecting via the alert email; also avoids browsers/proxies caching a data dump). Returns the ZIP with `Content-Disposition: attachment`, or `application/json` in the JSON-only fallback.

**Order of operations (all synchronous):**
1. `limitByUser(user, "data-export", { limit: 3, windowSec: 86400 })` — 3/day (§5).
2. `requireFreshUser()` — live revocation check (data egress is sensitive).
3. Build the bundle: for each ACTIVE `SpaceMember`, call the existing per-Space reads; add the personal-ownership pass; assemble sections per §3.
4. Serialize JSON + CSVs; zip.
5. `sendEmail("security-alert", email, { title: "Your data was exported", message: "…from IP x on <time>" })` — non-throwing.
6. `db.auditLog.create({ action: AuditAction.DATA_EXPORTED, metadata: { counts, ip } })`.
7. Stream the bundle back.

**New surface required (minimal):**
- One route file.
- One export-assembler module (`lib/export/*`) that composes the existing readers — **no new visibility logic**.
- One constant: add `DATA_EXPORTED` to `lib/audit-actions.ts` (it is already referenced by the S1 `SECURITY_HISTORY_ACTIONS` allowlist plan, so this closes an existing forward-reference). **Not a schema change.**
- Reuse `security-alert` email template as-is.

**Fresh-user requirement:** `requireFreshUser()` — yes. Password re-auth is **not** proposed (export is read-only, unlike deactivate/delete); flagged as D2.

**Synchronous vs async:** synchronous is acceptable at beta scale, consistent with the existing 5k-row transaction cap precedent (KD-7). Apply that cap to the export's transaction pull and set a `truncated: true` flag in the manifest when hit. **No background job** (honors the constraint); async generation is explicitly deferred to OPS-4 per §5.

**Reuse table**

| Need | Reuse (do not rebuild) |
|---|---|
| "Who may see detail" | `grantsAccountDetail` / `grantsTransactionDetail` / `TRANSACTION_DETAIL_VISIBILITY` |
| Sanitize shared accounts | `sanitizeForBalanceOnly`, `normalizeSharedAccounts`, `genericAccountName` |
| Per-Space visible reads | `getAccountsWithVisibility`, `getAccounts`, `getHoldings`, `getTransactions`, `getDebtTransactions`, `getInvestmentTransactions`, `getFicoData` |
| Space context + membership | `getSpaceContext` / `resolveSpaceContext`, `resolvePersonalSpaceId` |
| Audit allowlist | `SECURITY_HISTORY_ACTIONS`, `securityHistoryLabel` |
| CSV writing | `papaparse.unparse` + `lib/imports/csv.ts` column conventions |
| Freshness / rate limit / email / audit | `requireFreshUser`, `limitByUser`, `sendEmail("security-alert")`, `db.auditLog.create` |
| Route shape | `app/api/user/deactivate/route.ts` |

---

## 7. S7 interaction

- **"Download my data"** is one button surfaced in two places: the Security/Settings center, and the S7 delete-confirmation page ("export first"). Both hit the same `POST /api/user/export`.
- **Export before delete:** S6 ships **before** S7 so the offer is real (§5 dependency). S7 depends on S6 existing; **S6 has no dependency on S7.**
- **Export validity:** the export is a **point-in-time snapshot generated on demand** and streamed — nothing is stored server-side, so there is no "validity window" or artifact to expire or reconcile against deletion timing. Each request regenerates fresh from live data.
- **Deletion timing:** because export is synchronous, immediate, and stored nowhere, it is fully decoupled from S7's grace/pending window. Recommendation (D7): keep `POST /api/user/export` reachable **during** the S7 pending-deletion window (the account behaves as deactivated, but the export/cancel surface stays available) so a user can still retrieve their data before purge. The S7 pipeline itself needs no export step — it just links to the endpoint.

---

## 8. Validation plan

1. **Round-trip self-consistency:** feed the exported `transactions.csv` back through the existing CSV importer; assert the normalized rows equal the source (built-in correctness test, enabled by reusing import column conventions).
2. **Privacy invariants (mirror `transactions.privacy.test.ts` / `transaction-detail.privacy.test.ts`):** a BALANCE_ONLY / SUMMARY_ONLY / PRIVATE counterparty's transactions, holdings, institution, and rates must be **absent** from every export artifact; BALANCE_ONLY shared accounts appear only as generic-named summed balances.
3. **Ownership completeness:** a USER-owned account shared *out* into another member's Space is still present **in full** (via its HOME Space) — export must not under-redact *or* drop owned data.
4. **Secret-exclusion scan:** grep the produced bundle for `passwordHash`, `totpSecret`, `encryptedToken`, `credential`, `codeHash`, `sessionToken`, raw `dateOfBirthEncrypted` values → must all be absent.
5. **Envelope / infra:** assert `requireFreshUser` gate, 3/day rate limit, `DATA_EXPORTED` audit row with counts, and security-alert email fire (mirror the deactivate route tests).
6. **Estimate labeling:** FX-converted/snapshot totals carry `reportingCurrency` and an `isEstimate` marker.
7. **Optional tripwire (recommended):** a schema-scan test in the spirit of `lib/deletion-safety.test.ts` asserting every model is classified `include`/`exclude` in the export inventory, so a future model added to `schema.prisma` fails CI until someone decides whether it's exportable.

---

## 9. Open decisions

- **D1 — ZIP dependency.** Add `jszip`/`archiver` for the JSON+CSV bundle (recommended, matches ratified §5), **or** ship JSON-only now for zero new dependencies and add the bundle later. *(Recommend: `jszip`, small/pure-JS.)*
- **D2 — Re-auth strength.** `requireFreshUser()` only (recommended, export is read-only), or also require current password like deactivate.
- **D3 — SHARED-Space breadth.** Include SHARED-Space aggregates (goals, snapshots, dashboard) and other members reduced to first name (recommended, mirrors in-app visibility), or restrict the export to PERSONAL Space + owned accounts + FULL-visible shared accounts only (maximal minimization).
- **D4 — Goal contributions in SHARED Spaces.** Drop contributions pointing at non-FULL-visible member accounts (recommended), or include contribution existence without the account detail.
- **D5 — AI advice.** Include PERSONAL-Space `AiAdvice` (recommended — it's about the user's finances) or exclude all AI output as Space property.
- **D6 — Transaction cap.** Reuse the KD-7 5k cap with a `truncated` manifest flag (recommended), or export all with an accepted latency/memory ceiling.
- **D7 — Export during S7 pending-deletion window.** Keep the endpoint reachable during the grace window (recommended) or freeze it once deletion is scheduled.
- **D8 — `DATA_EXPORTED` audit action.** Confirm it is added in S6 (it is currently absent from `lib/audit-actions.ts` despite the S1 allowlist referencing it).

---

**Stopping here for approval.** No code, schema, or migration changes have been made. On approval, implementation is one route + one assembler module (composing existing readers) + one audit-action constant, plus the D1 dependency decision.
