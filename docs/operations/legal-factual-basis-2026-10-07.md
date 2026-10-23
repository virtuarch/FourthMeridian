# Legal / policy documents — factual basis (2026-10-07)

**Scope.** `site/content/legal/{terms,privacy,legal-ai}.md` (byte-identical twins in `content/marketing/`, pinned by `lib/public-site-boundary.test.ts`). This record proves every system-behaviour statement in those documents from code, and lists what could NOT be proven from the repository. It is **not** a legal review: no statement here asserts legal sufficiency, regulatory status, or provider-side behaviour. Prepared under OPERATIONALIZATION P0, Workstream G.

**Discipline.** VERIFIED = the prior text was true and kept. CORRECTED = the prior text was false, stale or incomplete and was rewritten. ADDED = a behaviour the product has that the document did not disclose. WITHHELD = a claim deliberately not made because the repository cannot prove it. COUNSEL / OWNER = requires a decision outside this repo.

## 1. Statement inventory

### AI Disclosures (`legal-ai.md`)

| Statement (as published now) | Evidence | Verdict |
|---|---|---|
| AI is used in two places: Daily Brief and Conversations | `lib/ai/brief/generate.ts`; `app/api/ai/chat/route.ts` (live, `lib/ai/conversation/engine.ts`) | CORRECTED — prior text: "not a chat window you have to prompt" (false since Conversations shipped) |
| Brief figures are computed by Fourth Meridian; the model describes them | `lib/ai/brief/generate.ts` (observations carry evidence paths into a pre-computed package; `onlyReportsFreshness` filter); `docs/operations/production-readiness.md` "the model narrates, never calculates" | VERIFIED |
| Conversations: questions on position, spending, income, investments, debt, net-worth history; what-ifs incl. spending, income, contributions, returns, one-offs, debt payoff, goal seek | `lib/ai/conversation/product.ts` `CAPABILITY_BY_TOOL` (test-enforced to equal the tool registry) | ADDED |
| Figures come from Fourth Meridian's calculation tools; the model picks tools and explains | `lib/ai/conversation/engine.ts`, `turn.ts` (tool loop); `product.ts` `you` | ADDED |
| Takes no actions; cannot move money, pay bills, trade, open/close accounts, change balances/transactions/connections; cannot see employer/payroll/tax records | `product.ts` `CANNOT`; no mutating financial tool in `lib/ai/conversation/tools.ts` | VERIFIED (strengthened) |
| A conversation reads only the Space it is open in; nothing typed changes what it may read | `product.ts` `canSee`; `app/api/ai/chat/route.ts` (`resolveSpaceContext`, 403 on mismatch; `aiPhaseRunner(user.id)`; RLS tenant phases) | ADDED |
| Guidance classification understanding / planning / recommendation; notice beside planning & recommendation; extra wording for securities, tax, legal, retirement accounts, borrowing | `lib/ai/conversation/guidance.ts` (`GUIDANCE_LEVELS`, `GUIDANCE_ADJACENCIES`, `disclosureTier`); `components/ai/GuidanceNote.tsx`, `AiDisclosure.tsx` | ADDED |
| Does not pick securities/funds, no market research or price forecasts, does not determine tax/legal questions | `product.ts` `CANNOT`; `docs/systems/ai-financial-guidance-boundary.md` §"Product boundary today" | ADDED |
| "Not a licensed financial adviser, broker, tax adviser or attorney" wording | `components/ai/AiDisclosure.tsx`, `product.ts` `CANNOT` | VERIFIED — adequacy of wording is COUNSEL (boundary doc Q4) |
| Output can be incomplete or wrong; only as complete as connected accounts | `GuidanceNote.tsx`; knowledge-gap contract `lib/ai/conversation/knowledge-gaps.ts` | VERIFIED |
| Provider is OpenAI's API | `lib/ai/provider.ts` (sole `openai` import) | CORRECTED — prior text: "a third-party model provider" (unnamed) |
| What is sent: summarised balances, holdings, transactions (merchant, amount, date, category), income, history, the user's questions, remembered items | `lib/ai/assemblers/{accounts,holdings,transactions,snapshot}.ts`; memory line in `engine.ts` | ADDED |
| Password, bank credentials and Plaid access tokens are never sent | No assembler selects `passwordHash`, `encryptedToken` or `credential`; `lib/ai/assemblers/transactions.privacy.test.ts` and `lib/platform/observability-privacy.test.ts` scan for secrets | VERIFIED |
| Fourth Meridian does not train any model; does not opt in to any provider training programme | No training code in repo; `lib/ai/provider.ts` passes no `store`, no data-sharing or training flag | VERIFIED as to Fourth Meridian's own conduct only |
| OpenAI's retention of API inputs/outputs is governed by OpenAI's terms, which Fourth Meridian does not control | — | WITHHELD: no retention window stated. Prior text said "we do not use your data to train third-party models" — a claim about the provider's conduct; reworded to Fourth Meridian's own conduct. See §2 Q1 |
| Transcript kept only in the browser for up to 24 h; "New chat" clears it; not stored server-side | `product.ts` `BROWSER_TRANSCRIPT_TTL_HOURS = 24` (pinned to `components/ai/transcript-cache`); chat route header "Nothing about a conversation is stored" | ADDED |
| A what-if is carried for up to 2 h within one conversation | `lib/ai/conversation/runtime-state.ts` `RUNTIME_STATE_TTL_MS = 2h`, sealed HttpOnly cookie bound to user+Space+tail | ADDED |
| Memory: only user-stated goals, planned expenses, rules, planning figures + projection checkpoints; per person per Space; Memory panel; edit/delete; never balances/ownership/access/instructions | `lib/ai/conversation/memory-model.ts` (`STATED_CLASSES`, `PROJECTION` written by code only); `memory-write-policy.ts`; `prisma/schema.prisma` `SpaceMemory` (`ownerUserId` required, Space + User cascade); `app/api/ai/memory/[id]/route.ts` PATCH + DELETE; `components/dashboard/MemoryPanel.tsx` | ADDED |
| Operational records per model call: user, Space, conversation id, model, tokens, latency, outcome; never content or figures; operator-only | `prisma/schema.prisma` `AiInvocation` (+ migration `20261007100000_operationalization_p0_facts`); `lib/ai/invocation.ts` allowlisted fields; RLS `…000100 §4` (revoked from `fm_app`, `fm_system` only) | ADDED (new this slice; the owner ruling of 2026-10-07 authorised the attribution) |
| AI features cannot currently be switched off individually | No per-user AI toggle in `prisma/schema.prisma` or `lib/platform-settings.ts` | VERIFIED (rephrased from "if and when they become configurable") |

### Privacy Policy (`privacy.md`)

| Statement | Evidence | Verdict |
|---|---|---|
| Closed, invite-only beta | `lib/platform-settings.ts` `registration_mode`; `lib/registration-policy.ts` | VERIFIED |
| Account info: email, username, name, hashed password, encrypted DOB, TOTP secret + recovery codes | `app/api/auth/register/route.ts` (bcrypt `passwordHash`, `dateOfBirthEncrypted`); `app/api/user/totp/*`; `RecoveryCode` | ADDED detail |
| Financial info via Plaid: balances, transactions, consented holdings; manual assets, debts, wallets, notes, APR/minimums | `app/api/plaid/link-token/route.ts` (`products = [Transactions]`, Investments via `additional_consented_products`); `lib/debt/user-terms.ts`; wallet connections | CORRECTED (named Plaid, listed consent) |
| Memory contents collected | as above | ADDED |
| Security/audit records with IP + user-agent | `prisma/schema.prisma` `AuditLog.ipAddress/userAgent`; `lib/audit-actions.ts` (LOGIN, LOGIN_FAILED, PASSWORD_*, TOTP_*, CONNECTION_*, DATA_EXPORTED, ACCOUNT_*) | ADDED |
| Operational records (AI calls, connection refreshes) | `AiInvocation`; `RefreshExecution` ledger | ADDED |
| Uses: single view, net worth, cash flow, history, Brief, Conversations; security; operations; communications | product surfaces; `lib/alerts`, `lib/platform/*` | CORRECTED (Conversations + operations added) |
| Never sell; no advertising use | No ad/analytics SDK in `package.json`; `site/tests/surface.test.mts` forbids network calls on the site | VERIFIED |
| Plaid Link consent; read access to balances/transactions and consented holdings; cannot move money | `link-token/route.ts`; no Plaid payment/transfer product requested anywhere (`grep Products\.` → Transactions, Investments only) | CORRECTED (prior: "read-only wherever the provider supports it") |
| Tokens encrypted at rest AES-256-GCM, never shown or exported | `lib/plaid/encryption.ts` (`aes-256-gcm`, HKDF per purpose); `lib/export/assemble.ts` exclusion list | VERIFIED (algorithm now stated) |
| Disconnect: stops syncing, removes accounts from Spaces, revokes at Plaid when orphaned; history kept until account deletion; reconnect restores | `app/api/connections/[id]/disconnect/route.ts` ("Model A — stop syncing, PRESERVE history"); `lib/plaid/disconnect.ts` (`itemRemove` → REVOKED); `product.ts` `DISCONNECT` | ADDED — prior text omitted that history is retained |
| Sharing: Plaid, OpenAI named; hosting/database/email/error-monitoring generic | `lib/email/providers/resend.ts`, `instrumentation.ts` (Sentry), Vercel/Supabase deployment docs | CORRECTED (two providers named). Naming the rest: OWNER/COUNSEL (§2 Q3) |
| Deletion: 7-day grace; account locked; cancel by signing in ("Cancel deletion") | `lib/account-deletion/preflight.ts` `GRACE_DAYS = 7`; `app/api/user/delete/route.ts` (sets `deactivatedAt`, revokes sessions); `lib/auth.ts` `cancelDeletion` login leg; `jobs/process-deletions.ts` | CORRECTED — prior text: "When you delete your account, we delete …" (no grace window disclosed) |
| What is deleted: account, personal Space, accounts, transactions, holdings, memory; Plaid access revoked | `lib/account-deletion/purge.ts` steps 2, 5, 6; `SpaceMemory` cascades on User and Space | ADDED |
| Revocation hold up to three further days, then completes | `lib/account-deletion/revocation.ts` `MAX_REVOCATION_ATTEMPT_DAYS = 3`; `purge.ts` hold/complete branches; `ACCOUNT_DELETED_UNREVOKED` | ADDED |
| Space-owned accounts survive in a shared Space; your connection removed; sole-owner block | `purge.ts` step 4 (canonical re-election / `stale`); `preflight.ts` `isSoleOwnerBlock`; delete route 409 | ADDED |
| Retained after deletion: anonymised audit (email as one-way hash), operational records with non-resolving identifiers | `purge.ts` step 7 (`emailHash`, `AuditLog.userId` SetNull); `AiInvocation.userId` soft ref (no FK); `RefreshExecution.plaidItemId` soft ref | ADDED |
| Export: ZIP with manifest, JSON, CSVs; 3/day; newest 5,000 transactions; manifest flags truncation | `app/api/user/export/route.ts` (`limitByUser … limit: 3, windowSec: 86_400`); `lib/export/assemble.ts` (`capTransactions`, notes); `lib/export/select.ts` `EXPORT_TRANSACTION_CAP = 5000` | CORRECTED — prior: "export a full copy at any time" (no limits) |
| Choices: disconnection, AI memory edit/delete, 2FA | as above | ADDED |
| Contact: support@fourthmeridian.com | `lib/email/senders.ts` (From identity on every account-lifecycle email) | CORRECTED — prior: "through the request-access form". Inbox monitoring: OWNER (§2 Q4) |

### Terms of Service (`terms.md`)

| Statement | Evidence | Verdict |
|---|---|---|
| Closed, invite-only beta; features may change | registration mode; beta queue | VERIFIED |
| Compromise notice → support@ | senders.ts | CORRECTED (destination added) |
| Linked through Plaid; read-only view; no money movement, trades, payments, acting on behalf — nor the AI | link-token products; `product.ts` `CANNOT` | VERIFIED (strengthened to cover the AI) |
| Not financial advice: Brief + Conversations; planning insight; not adviser/broker/tax adviser/attorney; can be wrong; link to AI Disclosures | `guidance.ts`, `AiDisclosure.tsx` | CORRECTED (Conversations named; aligned with shipped wording) |
| Deletion completes 7 days after request; locked; cancel by signing in | as privacy §6 | CORRECTED |
| Eligibility (18+), acceptable use, availability, limitation of liability, changes | — | UNTOUCHED — COUNSEL (§2 Q5) |

## 2. Unresolved — counsel / owner / external verification

1. **OpenAI API data retention (EXTERNAL VERIFICATION).** `lib/ai/provider.ts` sends no `store` flag and no zero-data-retention configuration, so provider-side retention is whatever OpenAI's API terms currently provide. The repository cannot prove a window, so none is stated. The owner should confirm the current OpenAI API data-usage policy (and whether a ZDR arrangement is wanted) and, if a window is to be published, cite the policy and its date.
2. **Regulatory status of the guidance (COUNSEL).** The documents describe the shipped boundary (understanding / planning / recommendation; no security selection; heightened notes for five subjects) as product behaviour. Whether that posture, the "not a licensed financial adviser" wording, and the notice placement are legally sufficient are the eight open questions in `docs/systems/ai-financial-guidance-boundary.md` §"Questions for counsel". Nothing in the documents asserts an answer.
3. **Naming sub-processors (OWNER/COUNSEL).** Plaid and OpenAI are named (both user-visible). Vercel (hosting), Supabase (database), Resend (email) and Sentry (error monitoring) remain generic ("our hosting, database, email-delivery and error-monitoring providers"). Whether a named sub-processor list is required for the launch jurisdictions is a counsel question; the facts are in `docs/operations/deployment.md`, `lib/email/providers/resend.ts`, `instrumentation.ts`.
4. **Support inbox (OWNER).** `support@fourthmeridian.com` is published as the contact in all three documents. It is the From identity on every account-lifecycle email and sits on the Google Workspace domain (`lib/email/senders.ts`), but the repository cannot prove the mailbox is monitored. The owner must confirm before beta invitations go out.
5. **Untouched legal clauses (COUNSEL).** Eligibility, acceptable use, "as is" availability, limitation of liability, changes-by-continued-use. No governing-law, dispute-resolution or arbitration clause exists; none was added (counsel decision, as `docs/operations/production-readiness.md` already records: "Counsel-reviewed final legal text is deferred").
6. **Re-consent (OWNER).** `TERMS_VERSION` is bumped (below). Existing users accepted "2026-07-19"; no re-consent prompt exists in the product. Whether the two existing Production users and the Preview test users should be asked to re-accept is an owner decision; the data to drive it (`User.acceptedTermsVersion`) is present.
7. **Historical Plaid data after disconnect (PRODUCT POSTURE, disclosed).** Disconnect preserves imported history until account deletion (`CONN-4A`, Model A). This is now disclosed rather than implied. If the owner wants a "delete history on disconnect" option, that is a product change, not a copy change.

## 3. `TERMS_VERSION` decision

`app/api/auth/register/route.ts` is the only reader or writer of `TERMS_VERSION`; it stamps `User.acceptedTermsVersion` on a new registration (`acceptedTermsAt` beside it). No code compares a stored version to the current one and no re-consent flow exists (`grep acceptedTermsVersion` across `app/ lib/ components/` → the register route only). Bumping therefore changes exactly one thing — new registrations record which text they accepted — which is the purpose the constant's own comment states ("Bump when the legal documents materially change (so re-consent can be required later)"). **Bumped `"2026-07-19"` → `"2026-10-07"`.** `lib/platform/beta-ops-guards.test.ts` (which scans the register route) still passes.

## 4. Gates run

- `npx tsx lib/public-site-boundary.test.ts` — all checks passed (legal Markdown and copy parity between `site/content` and `content/marketing`).
- `npx tsx lib/platform/beta-ops-guards.test.ts` — all passed.
- `cd site && npm run typecheck` — clean.
- Markdown uses headings, paragraphs, lists, bold, italics and links only (the subset `site/components/LegalDocument.tsx` and `components/marketing/LegalDocument.tsx` render identically); no raw HTML.
