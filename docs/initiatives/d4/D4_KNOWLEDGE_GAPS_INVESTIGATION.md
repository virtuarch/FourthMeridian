# D4 / Finance Metadata — Knowledge Gaps Investigation

**Status: Investigation only. No schema, migration, API route, or UI modified.**
**Date: 2026-07-01**
**Branch: feature/phase-2-architecture**

---

## 0. Scope and method

This investigation answers ten questions about AI-assisted financial metadata completion. Every claim below was verified against the live schema (`prisma/schema.prisma`) and the D4 implementation files (`lib/ai/`, `app/api/ai/chat/route.ts`). No code was changed.

---

## 1. What already exists in the schema

### Fields that already cover the target use cases

`FinancialAccount` (legacy flat fields — kept for backward compatibility):
- `interestRate Float?` — APR, e.g. 19.99
- `minimumPayment Float?` — minimum monthly payment
- `debtSubtype String?` — credit_card, auto_loan, mortgage, student_loan, etc.
- `creditLimit Float?` — populated by Plaid for credit cards

`DebtProfile` (1:1 optional extension of FinancialAccount, always user-entered):
- `apr Float?` — preferred over `FinancialAccount.interestRate` when set
- `minimumPayment Float?` — preferred over `FinancialAccount.minimumPayment` when set
- `dueDay Int?` — payment due day (1–31)
- `statementCloseDay Int?` — statement close day (1–31)
- `promoAprEndDate DateTime?` — when a promo APR expires
- `notes String?`

`SpaceGoal` (covers goal-based targets):
- `targetAmount Float?` — covers emergency fund target
- `targetDate DateTime?` — target completion date
- `targetReductionAmount/Pct Float?` — covers debt payoff goals

### Confirmed gaps in the schema

| Missing field | Where it should live | Risk |
|---|---|---|
| `promoApr Float?` | `DebtProfile` | Low — additive column |
| `payoffPriority Int?` | `DebtProfile` | Low — additive column |
| `apy Float?` (savings/CD APY) | `FinancialAccount` | Defer — no current use case driving it |

**Critically: `promoAprEndDate` exists but the actual promo rate does not.** Without `promoApr`, the AI knows a promo expires but can't compute how much interest is accruing at the promo rate vs. the post-promo rate.

### The bigger confirmed gap: DebtProfile is never assembled into context

The accounts assembler (`lib/ai/assemblers/accounts.ts`) queries `FinancialAccount` via `SpaceAccountLink` but does **not select** `interestRate`, `minimumPayment`, or join `DebtProfile` at all. The `AccountSummaryItem` type has no APR or rate fields. The AI receives zero debt metadata in context today, even for accounts that have a fully populated `DebtProfile`.

---

## 2. Where APR and minimum payment should live

**They already live in the right place.** The two-tier design is correct and documented in the schema:

- `FinancialAccount.interestRate` / `.minimumPayment` = provider-sourced or legacy flat fields (Plaid sometimes populates `interestRate` for credit cards; this is the fallback)
- `DebtProfile.apr` / `.minimumPayment` = always user-entered/confirmed; preferred over FinancialAccount when set

No new model is needed. `DebtProfile` already exists as a dedicated debt assumptions table. The schema comment on `FinancialAccount` explicitly states: *"effective values prefer DebtProfile when present and fall back to these flat columns otherwise."*

**Verdict: do not add a new `AccountMetadata` or `FinancialAccountAssumption` model.** DebtProfile is exactly that concept, already migrated and in production.

---

## 3. How to support multiple metadata types

Everything maps to existing or minimally-extended models:

| Metadata type | Current home | Status |
|---|---|---|
| APR | `DebtProfile.apr` / `FinancialAccount.interestRate` | Exists, not surfaced in context |
| Minimum payment | `DebtProfile.minimumPayment` / `FinancialAccount.minimumPayment` | Exists, not surfaced in context |
| Due day | `DebtProfile.dueDay` | Exists, not surfaced in context |
| Statement close day | `DebtProfile.statementCloseDay` | Exists, not surfaced in context |
| Promo APR end date | `DebtProfile.promoAprEndDate` | Exists, not surfaced in context |
| **Promo APR rate** | **`DebtProfile.promoApr Float?`** | **Needs additive schema change** |
| **Payoff priority** | **`DebtProfile.payoffPriority Int?`** | **Needs additive schema change** |
| Loan rate (auto/student/mortgage) | `DebtProfile.apr` | Exists — APR covers all loan types via `debtSubtype` |
| Emergency fund target | `SpaceGoal.targetAmount` (GoalCategory.EMERGENCY_FUND) | Exists |
| APY (savings/CD) | Nowhere | **Defer** — no current use case |

The `debtSubtype` string on `FinancialAccount` provides the differentiation between credit card, mortgage, auto loan, student loan, etc. The assembler can use this to label gaps correctly (e.g., "mortgage rate" vs. "APR" vs. "loan rate") without needing separate fields per loan type.

---

## 4. Whether this requires schema changes

**Schema changes are NOT required for the most impactful work.**

The biggest leverage is surfacing existing DebtProfile data in the assembled context — this is a pure TypeScript change (assembler + types + system prompt). That alone closes the gap that prevents the AI from knowing whether APR is null or just missing from context.

Schema changes that ARE needed for completeness:
- `DebtProfile.promoApr Float?` — additive, low risk, one migration
- `DebtProfile.payoffPriority Int?` — additive, low risk, same migration

These should be batched into a single migration when the context slice is ready to consume them. Do not migrate before the context layer is updated to read and surface them.

---

## 5. How knowledge gaps should be represented

**Recommended: a `knowledgeGaps` array on the assembled context, not a separate domain and not conflated with signals.**

### Why not signals

The existing signal types (STALE_CONNECTION, NEEDS_REAUTH, PENDING_CREDIT, NET_WORTH_DECLINED, etc.) represent operational health observations — things that happened that the user should act on. A missing APR is not a health event; it's a data completeness gap the system discovered while trying to answer a question. Conflating these two categories would dilute the signal severity model and make signals harder to triage.

### Why not a separate `knowledge_gaps` domain

Adding a new top-level domain for gaps means registering a new assembler, a new domain manifest entry per SpaceCategory, and new signal detectors. For what is ultimately a derived property of the accounts domain, this is over-engineering. Gaps are a property of accounts data — they belong adjacent to accounts data.

### Recommended representation

Extend `AccountsSectionData` with a `knowledgeGaps` array:

```typescript
interface KnowledgeGap {
  accountId:    string;
  accountName:  string;   // display-safe name
  field:        string;   // machine key: 'apr' | 'minimumPayment' | 'promoApr' | 'payoffPriority'
  label:        string;   // human label: 'APR', 'Minimum Payment', 'Promo APR', 'Payoff Priority'
  debtSubtype?: string;   // for contextual labeling: 'Mortgage Rate' instead of 'APR'
}

// Added to AccountsSectionData:
knowledgeGaps: KnowledgeGap[];
```

The accounts assembler detects nulls for debt-type accounts (`type === 'debt'`) during assembly and populates `knowledgeGaps`. No new query, no new model, no schema change needed for this.

The chat prompt system then references `knowledgeGaps` explicitly, instructing the AI to surface them conversationally.

---

## 6. How AI chat should surface missing data

### Current behavior (confirmed in `app/api/ai/chat/route.ts`)

The system prompt already contains:

> "For payoff schedules: if APR is not available in the context, clearly state that assumption, produce an approximate principal-only payoff table using a reasonable monthly payment, and note that interest charges will extend the actual schedule."

This is a reasonable fallback but has a critical flaw: **the AI cannot distinguish between "APR is null in the database" and "APR exists but wasn't included in context."** Because the assembler doesn't surface DebtProfile data at all today, the AI assumes APR is always unknown. Once the assembler surfaces the data, the AI will know when it's explicitly null (user never entered it) vs. when it's present.

### Recommended chat prompt addition

After the context block is serialized, add a dedicated knowledge-gaps section:

```
Knowledge gaps (fields the user has not yet provided):
  [Chase Sapphire Preferred] APR is not set — cannot compute interest charges
  [Chase Sapphire Preferred] Minimum Payment is not set — using account balance estimate

When you reference one of these accounts in a calculation that requires a missing field,
name the account and field explicitly and ask the user if they want to provide it.
Example: "I can calculate an approximate schedule, but I'm missing the APR for Chase
Sapphire Preferred. Want to add it? I'll use it for this session once you share it."
```

**Critical constraint:** the AI must not save anything. When a user provides a value in chat, the AI should confirm it will use the value for the current calculation, then remind the user they can save it in account settings for future use. No write path from AI chat.

---

## 7. How user confirmation should work

The flow has five steps, but the AI is only involved in steps 1 and 2:

1. **AI proposes** — "I'm missing APR for Chase Sapphire. Want to add it?" (chat response, text)
2. **User provides value** — user types "24.99" in chat, or clicks a UI shortcut
3. **App validates** — range check (0–99.99), type check (numeric)
4. **App saves** — `PATCH /api/accounts/:id/debt-profile` creates/updates `DebtProfile.apr`
5. **Future context includes it** — next `buildContext()` call assembles updated value

For step 2, the simplest approach requires no changes to the chat API response shape today. The AI's text response mentions the missing field by name; the UI can detect that pattern and surface an "Add APR" shortcut. This avoids introducing a `{ message, suggestedActions }` structured response shape before the need is proven.

**The AI must not accept user-provided values as permanent.** Within a single chat session, the AI can use a user-stated APR for calculations (e.g., "using the 24.99% you mentioned"), but it should always remind the user that the value is not saved until they update it in account settings. This prevents a permanent assumption from being implicitly encoded in chat history.

---

## 8. Security and permission rules

### Who can edit DebtProfile

Editing a `DebtProfile` (i.e., entering APR, minimum payment, promo rate) is equivalent to editing the `FinancialAccount` it belongs to. The same permission model applies:

- **USER-owned accounts**: only the owning user (`FinancialAccount.ownerUserId`)
- **SPACE-owned accounts**: Space OWNER or ADMIN role; plain MEMBER cannot edit
- **VIEWER role**: cannot edit DebtProfile for any account — same exclusion as AI chat access

For shared accounts (SHARED SpaceAccountLink rows), the account's HOME Space is authoritative. A user who only sees the account as a SHARED entry cannot edit its DebtProfile even if they're a Space MEMBER — they don't own the account.

### VisibilityLevel and DebtProfile

- **FULL visibility**: APR, minimum payment, promo rate should be included in assembled context
- **BALANCE_ONLY visibility**: APR and rate fields must be stripped — they are financially identifying metadata. `lib/account-privacy.ts`'s `sanitizeForBalanceOnly()` strips institution and rate fields; the assembler must extend this behavior to DebtProfile fields when surfacing them.
- **SUMMARY_ONLY visibility**: same treatment as BALANCE_ONLY for rate fields

The existing `genericAccountName()` and `sanitizeForBalanceOnly()` functions in `lib/account-privacy.ts` are the right extension point. The assembler already uses them for BALANCE_ONLY accounts — rate fields should follow the same conditional.

### User-entered vs. provider-sourced rates

`FinancialAccount.interestRate` may be populated by Plaid (provider-sourced). `DebtProfile.apr` is always user-entered. This distinction matters for trust and for UI labeling ("Provider-reported: 24.99%" vs. "You entered: 24.99%"). The assembled context should include a `source` field on rate metadata (`'provider' | 'user'`) so the AI can label its outputs accordingly.

---

## 9. Smallest safe implementation slices

These are ordered by dependency. Each slice is independently deployable.

### Slice A — Context slice (no schema change, no migration)

What changes: `lib/ai/assemblers/accounts.ts`, `lib/ai/types.ts`

- Add `debtProfile` join to the accounts assembler Prisma query (selecting `apr`, `minimumPayment`, `dueDay`, `promoAprEndDate`, `notes`)
- Add `interestRate`, `minimumPayment` from `FinancialAccount` to the select
- Extend `AccountSummaryItem` with nullable rate fields: `apr`, `minimumPayment`, `dueDay`, `promoAprEndDate`, `rateSource`
- Populate `knowledgeGaps` array in `AccountsSectionData` for debt accounts with null APR
- Apply the existing BALANCE_ONLY stripping logic to rate fields (no rates for BALANCE_ONLY accounts)

Validation: `npx tsc --noEmit`, `npm run lint`, manual `buildContext()` call — verify `knowledgeGaps` is populated for debt accounts without DebtProfile.

### Slice B — Chat prompt slice (no schema change)

What changes: `app/api/ai/chat/route.ts` (`serializeContextBlock`)

- Extend `serializeContextBlock()` to append a `Knowledge gaps:` section when `knowledgeGaps.length > 0`
- Update the RESPONSE_STYLE instruction to include the knowledge-gap surfacing rule and the "do not save values from chat" rule
- Remove or refine the existing generic APR fallback instruction (now redundant once the AI can see explicit null vs. present)

Validation: Manual chat test — ask "What's my credit card payoff schedule?" Verify AI names the account and missing field. Verify AI does not invent a rate.

### Slice C — Signal slice (no schema change)

What changes: `lib/ai/signals/types.ts`, new `lib/ai/signals/detectors/debt-metadata.ts`

- Add `MISSING_DEBT_APR`, `MISSING_MIN_PAYMENT` to `SignalType`
- Register a detector that reads `AccountsSectionData.knowledgeGaps` and emits `info`-severity signals
- These are `info` not `warning` — missing APR is not an operational emergency

Validation: `npx tsc --noEmit`, signal output visible in `buildContext()` result.

### Slice D — Schema slice (migration required)

What changes: `prisma/schema.prisma`, one migration

- `DebtProfile.promoApr Float?` — the promo rate itself (not just the expiry date)
- `DebtProfile.payoffPriority Int?` — user-defined debt payoff order

Run after Slices A–C are deployed and the context layer is ready to consume the new fields.

Validation: `npx prisma generate`, `npx prisma migrate dev`, `npx tsc --noEmit`, confirm no data loss.

### Slice E — UI/API slice (requires Slice A)

What changes: new or extended API route, chat UI component

- `PATCH /api/accounts/:id/debt-profile` — create-or-update DebtProfile for the given account
- Permission check: USER-owned → ownerUserId match; SPACE-owned → OWNER/ADMIN role
- Chat UI: detect knowledge-gap mention in AI response, surface inline "Add APR" button
- Or: extend the existing account detail modal/page with DebtProfile fields

This slice is the most UI-heavy and has the most surface area. Do it last.

---

## 10. Risks and mitigations

### Bad user-entered assumptions

**Risk**: user enters 0% APR thinking they're on a promo rate, or enters a rate from memory that's stale.

**Mitigation**: validate range (0.00–99.99) server-side. Store `updatedAt` on `DebtProfile` (already present). Add a `promoAprEndDate` check — if the promo expiry is in the past and `promoApr` is set, emit a `STALE_PROMO_RATE` signal prompting the user to confirm the rate has reverted. Label user-entered values clearly in UI as "You entered this — verify with your statement."

### AI hallucinating missing fields

**Risk**: AI invents a "typical credit card rate" of 20% when APR is null, presenting it as if it came from data.

**Mitigation**: the system prompt already says "Never invent accounts, balances, transactions, or any financial data." This must be extended to explicitly cover rates and assumptions: "Never invent or assume an interest rate, APR, or minimum payment. If a rate is not in the context, say it is missing and ask the user to provide it."

The `knowledgeGaps` list gives the AI an explicit list of what's null — it no longer needs to guess.

### Storing inaccurate rates

**Risk**: user enters APR once, rate changes (promotional period ends, rate is adjusted), and the stale DebtProfile is used indefinitely.

**Mitigation**: `DebtProfile.updatedAt` tracks when values were last touched. The assembler should include `debtProfileUpdatedAt` in context so the AI can note staleness ("APR last updated 8 months ago — you may want to verify this"). A future signal detector can fire when `DebtProfile.updatedAt` is more than 6 months old for active debt accounts.

### Shared Space privacy issues

**Risk**: a SHARED member sees APR/rates for an account they only have BALANCE_ONLY access to, revealing financially identifying information.

**Mitigation**: The existing `visibilityLevel` enforcement in the accounts assembler already gates on `VisibilityLevel.FULL` for institution names and identifying metadata. The same gate must be applied to rate fields. `AccountSummaryItem` for BALANCE_ONLY rows must not include `apr`, `minimumPayment`, or any DebtProfile fields. This is enforced in Slice A when the assembler is updated — it's a code change, not a schema change.

### Conflating provider data with user assumptions

**Risk**: `FinancialAccount.interestRate` might be set by Plaid; `DebtProfile.apr` is always user-entered. Mixing them without labeling breaks trust in the displayed data.

**Mitigation**: the assembled context should include a `rateSource: 'provider' | 'user'` field on rate-bearing AccountSummaryItems. The effective APR resolution is: DebtProfile.apr (user, trusted) → FinancialAccount.interestRate (provider, informational) → null (unknown). The assembler should resolve this at assembly time and set `rateSource` accordingly. The system prompt should note the distinction so the AI can qualify its statements ("using the APR you provided" vs. "using a rate reported by your provider").

---

## 11. What should be deferred

- **APY for savings/CD accounts** — no current user request pattern. `FinancialAccount.apy` is a straightforward additive field but has no consuming feature yet. Add to the backlog; do not implement now.
- **A dedicated `knowledge_gaps` domain** — embedding gaps in the accounts domain is sufficient. A separate domain adds assembler registration overhead with no benefit at current scale.
- **Structured chat responses** (`{ message, suggestedActions }`) — the text-first approach is sufficient for the first cut. Introduce structured actions only if/when the UI team commits to consuming them.
- **Persistent gap storage** — knowledge gaps are derived at assembly time from null fields. There is no need to store them in a database table. They are regenerated on every `buildContext()` call.
- **AI write path** — the AI must never write to `DebtProfile`. The confirmation flow described in §7 always routes through a user-initiated API call. This is a firm architectural constraint, not a phasing decision.
- **Emergency fund target via DebtProfile** — `SpaceGoal` (GoalCategory.EMERGENCY_FUND) is the correct home for this. No new field needed.

---

## 12. Recommended implementation order summary

1. **Slice A** (context layer): surface existing DebtProfile data in assembled context; add `knowledgeGaps` to AccountsSectionData. **Highest leverage. No migration.**
2. **Slice B** (chat prompt): update system prompt to reference knowledge gaps and enforce the no-assumption rule for rates.
3. **Slice C** (signals): add `MISSING_DEBT_APR` / `MISSING_MIN_PAYMENT` signal types and a detector.
4. **Slice D** (schema): add `DebtProfile.promoApr` and `DebtProfile.payoffPriority`. Batch as one migration.
5. **Slice E** (UI/API): `PATCH /api/accounts/:id/debt-profile` + chat UI shortcut or account modal fields.

Do not proceed to implementation without an approved checklist for each slice (matching the working style established for D1–D11).

---

## 13. Validation plan (per slice)

| Slice | Commands | Manual checks |
|---|---|---|
| A | `npx tsc --noEmit`, `npm run lint` | `buildContext()` output includes `apr`, `minimumPayment` for debt accounts; `knowledgeGaps` non-empty for accounts without DebtProfile; BALANCE_ONLY accounts have no rate fields |
| B | `npx tsc --noEmit`, `npm run lint` | Ask "What's my payoff schedule?" — AI names account and missing field; AI does not invent a rate |
| C | `npx tsc --noEmit`, `npm run lint` | `buildContext()` signals include `MISSING_DEBT_APR` for accounts with null APR |
| D | `npx prisma generate`, `npx prisma migrate dev`, `npx tsc --noEmit` | No data loss; `DebtProfile.promoApr` and `.payoffPriority` columns created; rollback: `npx prisma migrate reset` (dev only) |
| E | `npx tsc --noEmit`, `npm run lint` | `PATCH /api/accounts/:id/debt-profile` saves DebtProfile; subsequent `buildContext()` includes the saved value; VIEWER role rejected with 403; BALANCE_ONLY does not expose saved APR |
