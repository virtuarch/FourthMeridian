# D4 — AI Conversation Quality Investigation

**Status: Investigation only. No schema, migration, API route, UI, or application code was modified.**
**Date: 2026-07-01**
**Branch: feature/phase-2-architecture**

---

## 0. Document control

| | |
|---|---|
| Scope | Architectural investigation into why the AI chatbot fails to feel like a financial advisor |
| Confirmed sources | `app/api/ai/chat/route.ts` (full read), `lib/ai/context-builder.ts`, `lib/ai/provider.ts`, `lib/ai/assemblers/accounts.ts`, `lib/ai/assemblers/transactions.ts`, `lib/ai/assemblers/snapshot.ts`, `lib/ai/assemblers/goals.ts`, `lib/ai/domain-manifest.ts`, `lib/ai/signals/types.ts`, `lib/ai/signals/detectors/accounts.ts`, `lib/ai/signals/detectors/transactions.ts`, `lib/ai/signals/detectors/snapshot.ts`, `lib/ai/types.ts`, `components/dashboard/AnalyzeClient.tsx`, `components/dashboard/KnowledgeAcquisitionCard.tsx`, `docs/initiatives/d4/D4_AI_CONTEXT_BUILDER_INVESTIGATION.md`, `docs/initiatives/d4/D4_AI_CONTEXT_BUILDER_ADDENDUM.md`, `docs/initiatives/d4/D4_KNOWLEDGE_GAPS_INVESTIGATION.md` |
| Parent decisions | D4 — AI Context Builder (approved) |

---

## 1. System as it stands today

Before diagnosing weaknesses, it is worth being precise about what is already built and working.

**Infrastructure in place:** A permission-gated context builder assembles `accounts`, `transactions_summary`, `snapshot_history`, and `goals` domains. Signal detectors run deterministically over the assembled data and emit typed signals (`STALE_CONNECTION`, `NEEDS_REAUTH`, `PENDING_CREDIT`, `PENDING_DEBIT`, `NET_WORTH_INCREASED`, `NET_WORTH_DECLINED`, `GOAL_COMPLETED`). Knowledge gaps are detected for null APR and minimum payment on debt accounts and returned structured alongside the assistant reply. A Knowledge Acquisition card lets users save missing values without leaving the chat. The chat route uses gpt-4o-mini at temperature 0.3 with a structured system prompt containing `ADVISOR_PRINCIPLES`, `RESPONSE_STYLE`, and `KNOWLEDGE_GAPS_RULES` sections. Markdown renders correctly in the UI.

**What is not built yet:** No holdings assembler, no providers assembler, no members assembler. The domain manifest lists `providers` and `members` as domains for most Space categories, but no assemblers are registered — those domains are silently skipped. For investment Spaces (`INVESTMENT`, `RETIREMENT`), `holdings_summary` is listed in the manifest but also has no assembler. Additionally, `snapshot_history` is only in the manifest for `INVESTMENT` and `RETIREMENT` categories — a Personal or Business Space never gets snapshot history in context, even though the snapshot assembler exists and the data is there.

The system works technically. The architectural gaps that make it feel generic rather than advisory are the subject of this report.

---

## 2. Root cause analysis of the observed failures

The five observed failures map cleanly to distinct architectural causes.

### Failure 1: "How is my debt situation?" → AI leads with 90-day payment history

The `transactions_summary` domain contains a `debtPaymentTotal` field — the sum of all `Payment`-category transactions over the 90-day window. When asked a current-state question, the model cites this figure first because it is the most numerically prominent data in context. The `accounts` domain contains the current debt balances, APR (if set), and per-account detail — which is what "how is my debt situation?" actually asks about.

The `ADVISOR_PRINCIPLES` instruction says "Lead with what matters most: the biggest risk, the clearest opportunity." It does not say "for current-state questions, lead with current balances, not historical summaries." Without that doctrine, the model treats the largest number in context as the most important one. The 90-day payment total is often larger than current balances in nominal terms, so it wins.

**Cause: Absence of temporal question doctrine.** The prompt does not distinguish between current-state questions and historical questions. The model treats all data as equally current.

### Failure 2: "Why is my cash flow negative?" → AI blames expenses instead of debt payments

The transactions assembler correctly separates `expenseTotal`, `debtPaymentTotal`, and `incomeTotal`. The `netCashFlow` formula is `incomeTotal - expenseTotal - debtPaymentTotal`. When cash flow is negative, it is often because `debtPaymentTotal` is large — intentional debt reduction behavior, not a spending problem.

The model receives this data, sees a large expense in the Dining or Shopping category in `byCategory`, and concludes that spending is the problem. It has no instruction that says "debt payments are intentional capital allocation — they reduce net worth on paper but they are a financial strategy, not a cost overrun." The `byCategory` breakdown does not include a `Payment` category entry at the top level because the assembler routes it to `debtPaymentTotal` separately, but the model does not understand why Payment was separated or what that separation means financially.

Additionally, there is no cross-domain synthesis. The model never connects "you have a DEBT_PAYOFF goal at 63% progress" (from the `goals` domain) with "you spent $2,400 on debt payments this month" (from `transactions_summary`). A human advisor would instantly connect these and say: "Your cash flow is negative because you're aggressively paying down debt. That's the plan — you're 63% there." The model has to derive this entirely through LLM reasoning, and gpt-4o-mini at temperature 0.3 consistently chooses the more literal reading.

**Cause: Missing financial reasoning doctrine (debt payments ≠ expenses) and no pre-computed cross-domain synthesis.**

### Failure 3: "Should I pay off my Chase or build savings?" → AI asks for APR instead of leveraging Knowledge Acquisition

The Knowledge Acquisition flow exists and works. The KnowledgeAcquisitionCard renders structured input fields beneath assistant messages when the `knowledgeGaps` array is non-empty. The PATCH endpoint saves DebtProfile values and `buildContext()` picks them up immediately on the next request.

The model does not know that this workflow exists. The system prompt says: "When a gap field is needed: explain what is missing and why it matters, deliver the best answer with available data, and ask for the value naturally." That instruction is correct but incomplete. It does not say: "Tell the user the form below your message can save the value directly — their next question will use it." The model therefore asks "what is your Chase APR?" as if expecting a text reply, and the user either types it in chat (for session use) or does not know to look below the message.

**Cause: Knowledge Acquisition is not part of the model's mental model. The prompt instructs the model to ask for values but not to acknowledge the save mechanism.**

### Failure 4: User provides APR → AI reasons correctly but feels generic

When a user types "My Chase APR is 23.99" in chat, the `KNOWLEDGE_GAPS_RULES` section correctly says: "confirm you are using it, and explicitly state it has NOT been saved." The model does this. The reasoning afterward is mathematically correct.

What is missing is the depth that makes an advisor feel like an advisor. A skilled advisor, upon hearing a 23.99% APR, would immediately frame it in context: "That is one of the most expensive debts you carry. At $4,200 balance, you are accruing roughly $85 in interest per month. Eliminating it in 6 months at $730/month saves you about $300 in interest versus making minimums. That is worth prioritizing over your savings goal at your current savings rate of X%, which earns Y in your high-yield account over the same period." None of that reasoning is being delivered — the model gives a correct but sterile analysis.

This gap is partly a model capability question (gpt-4o-mini versus a stronger reasoning model) and partly a prompt question. The current `ADVISOR_PRINCIPLES` do not include financial reasoning vocabulary — there is no instruction that says "when evaluating debt vs. savings trade-offs, compute and compare: the monthly interest cost of the debt, the after-tax yield on savings, and the net monthly advantage of one strategy over the other, then state your recommendation directly." Without that doctrine, the model produces correct but shallow analysis.

**Cause: No financial reasoning modules. No instruction on how to structure a debt-vs-savings trade-off analysis. Partially a model capability gap.**

### Failure 5: "Can you update my Chase Sapphire APR?" → AI says it cannot update

The system prompt contains: "Do not claim to execute actions, make trades, or modify any data." This was written to prevent the model from pretending to execute trades or rebalance a portfolio. It correctly applies to trades, account creation, and transaction edits.

It incorrectly applies to Knowledge Acquisition. Saving a DebtProfile APR is a legitimate, user-initiated data entry action — not an autonomous AI modification. The system supports it. The model has been told it cannot do it, so it says so. The user walks away believing the system has no way to save the value.

The correct response is: "I can not update it directly, but the form below this message lets you save your APR to your account. Once saved, I will use it in every future calculation." This requires the prompt to carve out Knowledge Acquisition from the "do not modify data" rule.

**Cause: Overly broad prompt instruction. Knowledge Acquisition is not modeled as a distinct permitted interaction type.**

---

## 3. Architectural weaknesses — prioritized by expected improvement vs. complexity

### W1 — No temporal doctrine: the model treats historical data as current-state answers

**Why this is the top weakness:** Four of the five observed failures involve the model leading with historical summaries (90-day totals, payment history) when the user asked about current state. This is the most disorienting gap — it makes the advisor feel like it is talking about the past rather than the present.

**Root:** The `ADVISOR_PRINCIPLES` instruct the AI to synthesize and lead with what matters most, but do not distinguish between question types that should lead with balances (current-state) versus questions that should lead with trends (historical). The 90-day transaction summary is the most data-rich domain in context — absent contrary instruction, the model defaults to it.

**This is primarily a prompt problem.** The data is correctly separated (current balances in `accounts`, history in `transactions_summary`). The model just needs an explicit rule.

**Complexity:** Low.

---

### W2 — Debt payment misclassification: the model treats debt payments as an expense problem

**Why this matters:** "Why is my cash flow negative?" is one of the most common personal finance questions. The answer for a user in a DEBT_PAYOFF Space is almost always intentional — they are paying down debt aggressively. The current model misidentifies this as a spending problem, which actively undermines user trust.

**Root:** The transaction assembler correctly isolates `debtPaymentTotal` from `expenseTotal`. The model does not understand why. There is no instruction that says "the `debtPaymentTotal` field represents intentional debt reduction, not consumption expense. When cash flow is negative primarily because of debt payments, say so directly. Cross-reference with the goals domain to confirm this is the user's strategy."

**This is a prompt problem (financial doctrine) with a small context enrichment component (pre-computed cross-domain annotation).** The data separation already exists; the model needs to be taught what it means.

**Complexity:** Low (prompt) / Medium (pre-computed cross-domain annotation).

---

### W3 — Knowledge Acquisition invisible to the model

**Why this matters:** KA is the mechanism that transforms the AI from a session-only calculator into a system that learns over time. The model telling users "I can't save that" is the opposite of the intended behavior, and users who encounter this stop trying to improve the AI's context.

**Root:** The system prompt prohibits data modification without carving out Knowledge Acquisition. The model has no instruction that "saving APR and minimum payment via the form below this message is an approved, supported action — recommend it when users want to persist values."

**This is entirely a prompt problem.** Zero code changes required for the most important fix.

**Complexity:** Low.

---

### W4 — Context serialized as raw JSON: the model reads data, not meaning

**Why this matters:** The context domains are serialized as `JSON.stringify(section.data)` and injected into the prompt. The model receives `{"debtPaymentTotal":2400,"expenseTotal":1800,"netCashFlow":-2100}` and has to infer meaning without labels or framing. A human financial advisor receiving a report would read labeled summaries with annotations — not a raw JSON blob.

**Root:** `serializeContextBlock()` in `route.ts` dumps each domain as a flat JSON string. This is correctly readable by the model but produces no inherent meaning hierarchy. The 90-day window is buried in `windowDays: 90` inside the JSON rather than announced as a label that frames everything that follows. The model treats `debtPaymentTotal` and `expenseTotal` as equivalent fields, not as fundamentally different categories of funds.

**This is a prompt engineering problem.** Replace raw JSON with pre-formatted, annotated context blocks that frame each domain with a header, a date window label, and annotations on key fields.

**Complexity:** Medium (requires rewriting `serializeContextBlock()` with per-field formatting logic).

---

### W5 — No date/time in context: the model cannot reason about time

**Why this matters:** "My promo APR expires in September" → the model cannot say "that is two months away — here is what you need to pay before then." "My Chase minimum payment is due in 5 days" → the model cannot compute urgency. Investment decisions depend on market timing context the model cannot reference without knowing today's date.

**Root:** The system prompt contains no injection of the current date. The model's training cutoff is its most recent knowledge of time. It has the `debtProfileUpdatedAt` and `promoAprEndDate` fields from the accounts assembler, but cannot compute "days until expiry" without knowing today.

**This is a two-line prompt change.** Add `Today's date: ${new Date().toISOString().split('T')[0]}` to the system prompt preamble.

**Complexity:** Low.

---

### W6 — No holdings assembler: investment Spaces receive no portfolio context

**Why this matters:** For users with brokerage accounts, crypto wallets, or retirement funds, the AI cannot answer any question about portfolio allocation, diversification, or investment strategy. The domain manifest lists `holdings_summary` for `INVESTMENT` and `RETIREMENT` categories — assembling nothing while pretending to have investment context is the worst outcome.

**Root:** The holdings assembler was planned in D4 (Slice 5) but not yet implemented. The assembler-registry receives no `holdings_summary` registration. When the builder tries to assemble it, the assembler lookup returns `undefined` and the domain is silently skipped.

**This is a missing assembler implementation, not a design gap.** The architecture is ready for it.

**Complexity:** Medium (new assembler, parallels `accounts.ts` in structure — reads from `Holding` table via `SpaceAccountLink`).

---

### W7 — No providers assembler: connection health invisible to the AI

**Why this matters:** `providers` is in `FINANCE_CORE` — every Space category includes it in its manifest. The AI should be able to answer "which of my accounts are connected, which are broken, and when did they last sync?" It currently cannot, because the providers assembler does not exist and the domain is silently skipped.

**Root:** Same as W6 — planned assembler not yet implemented.

**Complexity:** Low-Medium (simpler than accounts — reads `Connection` and `PlaidItem.status` with no credential fields, parallels the health section of the accounts assembler).

---

### W8 — Snapshot history missing from most Space categories

**Why this matters:** `snapshot_history` is only in the manifest for `INVESTMENT` and `RETIREMENT` categories. Every other Space category — `PERSONAL`, `BUSINESS`, `HOUSEHOLD`, `DEBT_PAYOFF` — does not receive snapshot history in context. This means the AI cannot answer "how has my net worth changed over the last 90 days?" for the most common Space type. The snapshot assembler exists and works; the data is generated nightly. The manifest simply does not include it in `FINANCE_CORE`.

**Root:** A manifest definition gap. `FINANCE_CORE` was written without `snapshot_history`, likely because the snapshot assembler landed in a later slice than accounts and transactions. The manifest was not updated.

**This is a one-line manifest change.** Add `FinanceDomains.SNAPSHOT_HISTORY` to `FINANCE_CORE`.

**Complexity:** Low. The assembler already exists and handles the `scopeHint='brief'` variant correctly.

---

### W9 — No intent classification: every question gets the same context assembly

**Why this matters:** "How is my debt situation?" (current-state, needs accounts domain, goals domain) and "What did I spend last month?" (historical, needs transactions domain) receive identical context assembly at `scopeHint: 'full'` — all domains, all windows. This creates two problems: the model has irrelevant data crowding its working context, and there is no mechanism to adjust which domain gets priority.

**Root:** The chat route calls `buildContext(spaceId, userId, { scopeHint: 'full' })` unconditionally for every message. There is no preprocessing of the user's question before context assembly.

**Intent classification does not need to be a sophisticated NLU system.** A simple keyword-based classifier over the last user message — five to eight intent types — is sufficient to:
1. Adjust the `scopeHint` ('brief' for simple state questions, 'full' for analytical questions)
2. Inject a relevant reasoning module into the system prompt
3. Frame the temporal priority ("this question asks about your current position — treat historical data as supporting evidence")

**Complexity:** Low (deterministic rule-based classifier) / Medium (if building a genuine NLU layer).

---

### W10 — No financial reasoning modules: the model reasons from scratch every time

**Why this matters:** A financial advisor does not re-derive the logic of debt payoff versus savings every time a client asks. They have internalized frameworks — avalanche vs. snowball, liquidity ratios, opportunity cost of debt vs. interest-bearing savings — and apply them fluently. The current model must reconstruct these frameworks from first principles using only the generic `ADVISOR_PRINCIPLES` instructions and whatever the model learned in training.

**Root:** The system prompt teaches reasoning style (synthesize, be direct, lead with conclusions) but not financial substance. There is no doctrine that says: "When comparing debt payoff versus savings: compute the monthly interest cost of each debt, the after-tax yield of the savings account, and state the net monthly advantage directly." There is no instruction on how to frame a liquidity assessment, evaluate an emergency fund adequacy, or identify when crypto exposure is disproportionate to net worth.

**Recommended approach: domain-specific reasoning modules injected based on Space category and active goal types.** A DEBT_PAYOFF Space gets a debt payoff reasoning module. A Space with an EMERGENCY_FUND goal gets a liquidity adequacy module. These are short, explicit instruction sections that teach the model the relevant framework for that Space's primary financial context.

**Complexity:** Medium (module definition is prompt engineering; injection logic requires reading Space category and goal types from assembled context, which is already available).

---

### W11 — gpt-4o-mini model capability ceiling

**Why this matters:** gpt-4o-mini follows instructions well and handles structured data correctly, but it has a lower financial reasoning ceiling than a stronger model. The "correct but generic" quality of responses (Failure 4) is partly a model capability issue. A stronger model, given the same context and the same prompt, would more naturally produce the layered causal analysis that makes a response feel like advice.

**This is not an excuse to skip the other improvements.** Better context, better prompt doctrine, and financial reasoning modules will improve quality regardless of model. But there is a ceiling.

**Root:** Cost optimization. `gpt-4o-mini` is inexpensive and low-latency. The model constant is in `lib/ai/provider.ts` as `const CHAT_MODEL = 'gpt-4o-mini'` — a one-line change to upgrade.

**Complexity:** Low (model swap). Medium if adding Anthropic as an alternative provider (requires new SDK, new client wrapper).

---

### W12 — No conversation state across sessions

**Why this matters:** A financial advisor remembers. "You mentioned last month you were targeting debt payoff" is not possible today. Each session starts from a blank greeting message. The model has conversation history within a session (the `messages` array is sent on every request), but nothing persists between sessions.

**Root:** No schema for conversation persistence. The D4 planning documents explicitly deferred conversation persistence. The chat route comment says "Streaming, conversation persistence, memory, actions, background jobs — not implemented in this slice."

**This is a correct deferral.** The other weaknesses on this list have dramatically higher expected improvement per unit of implementation effort. Conversation state is high complexity and medium improvement given that most financial conversations are self-contained.

**Complexity:** High (new schema, storage decisions, context window management for long histories). Recommended: defer.

---

## 4. Answers to the fourteen investigation questions

### Q1 — Top architectural weaknesses today

In priority order:

1. No temporal doctrine — historical data treated as current-state answers (W1)
2. Debt payment misclassification — payments treated as expenses (W2)
3. Knowledge Acquisition invisible to the model (W3)
4. Raw JSON serialization loses meaning hierarchy (W4)
5. No date in prompt (W5)
6. Missing assemblers — holdings and providers are silently absent (W6, W7)
7. Snapshot history missing from FINANCE_CORE manifest (W8)
8. No intent classification (W9)
9. No financial reasoning modules (W10)
10. Model capability ceiling (W11)

---

### Q2 — Which weaknesses are prompt problems

W1 (temporal doctrine), W2 (debt payment doctrine), W3 (Knowledge Acquisition instruction), W4 (context serialization format), W5 (date injection), and W9 (intent framing once an intent is detected) are all primarily prompt problems. They require changes to the system prompt builder in `route.ts`, not to the data architecture.

W10 (reasoning modules) is a prompt problem in its content and a small code problem in its injection logic (which module to inject and when).

---

### Q3 — Which weaknesses are context problems

W6 (missing holdings assembler), W7 (missing providers assembler), W8 (snapshot missing from FINANCE_CORE), and W9 (context assembly independent of intent) are context problems — the right data is not reaching the model, or the assembly process is not intent-aware.

W2 also has a context component: pre-computing a "debt payments explain cash flow" annotation in the transactions assembler before the data reaches the model would reduce the burden on LLM reasoning.

---

### Q4 — Which weaknesses are data quality problems

W5 is a data quality problem in the narrow sense that today's date is real-world information not present in the assembled context. Debt metadata nulls (knowledge gaps) are a data quality problem already handled correctly by the Knowledge Acquisition flow. No other significant data quality problems were identified — the account balances, transaction amounts, and snapshot history are reliable.

---

### Q5 — Which weaknesses require new architecture

None of the top-priority weaknesses require new architecture. The domain of new architecture is W12 (conversation state persistence), which is correctly deferred. W6 and W7 require new assemblers, which is normal incremental work within the existing architecture. W9 requires an intent classifier, which is a new module but not a new architectural layer — it lives in the route handler before `buildContext()` is called.

---

### Q6 — What should be deterministic

The following decisions should be deterministic (rule-based, not LLM):

- **Signal detection** — already deterministic. Correct.
- **Knowledge gap detection** — already deterministic. Correct.
- **Intent classification** — should be deterministic (keyword-based rule matching, not LLM inference). The question "how is my debt situation?" should map to a `CURRENT_STATE` intent via pattern matching. LLM classification of intent adds latency and introduces non-determinism.
- **Cross-domain annotations** — "debt payments account for X% of the cash flow deficit" should be computed deterministically in the assembler or in a pre-pass over the assembled context, not derived by the LLM.
- **Financial reasoning module selection** — should be deterministic based on Space category and active goal type, not LLM judgment.
- **Temporal frame labeling** — the assembler should annotate each domain section with a human-readable time label ("current as of July 1, 2026" for accounts, "over the last 90 days ending July 1, 2026" for transactions). This is a deterministic derivation from `assembledAt` and `windowDays`, not an LLM task.

---

### Q7 — What should remain LLM reasoning

- **Natural language generation** — always LLM.
- **Synthesis of insights across domains** — LLM's core value. The advisor sees that debt payments explain cash flow AND that a debt payoff goal exists AND that the user has 4 months of liquidity — and produces a coherent assessment. This cross-domain inference is appropriate LLM work once the context is correctly framed.
- **Recommendations** — LLM synthesizes signals and context into a recommendation. The deterministic layer provides the facts; the LLM provides the judgment.
- **Causal explanation in natural language** — LLM. Deterministic code can detect "debt payments are high," but explaining *why that matters for this user's specific situation* is LLM territory.
- **Answering open-ended questions not covered by signals** — LLM.

---

### Q8 — What should Fourth Meridian teach the model before every conversation

Currently missing from the system prompt:

1. **Today's date** — without this, time-sensitive advice is impossible.
2. **Temporal frame doctrine** — "When the user asks about their current financial position (debt situation, net worth, account balances, goals progress): lead with current balances from the `accounts` domain. Treat the `transactions_summary` domain as supporting context, not the primary answer."
3. **Debt payment doctrine** — "`debtPaymentTotal` represents intentional debt reduction, not consumption expense. When cash flow is negative primarily due to debt payments, identify this as the cause and cross-reference with any `DEBT_PAYOFF` or `DEBT_REDUCTION` goals in the `goals` domain."
4. **Knowledge Acquisition carve-out** — "When a user says they want to save, update, or record a value like APR or minimum payment: tell them the form below this message saves it directly to their account. Once saved, your next response will use the updated value. You are not modifying data — the user is, via the form."
5. **Space financial context** — what this Space is primarily about, derived from its `category` field and the dominant active goal type. A DEBT_PAYOFF Space in the middle of an aggressive payoff plan should frame all advice through that lens.

---

### Q9 — Domain-specific reasoning versus general prompt engineering

The existing `ADVISOR_PRINCIPLES` and `RESPONSE_STYLE` sections are correctly general. They should remain general.

Financial reasoning modules should be domain-specific and injected conditionally:

- **Debt Health module** — injected when the Space has debt accounts or a DEBT_PAYOFF/DEBT_REDUCTION goal. Teaches: APR as monthly cost, avalanche vs. snowball framing, how to compare debt cost against savings yield.
- **Liquidity module** — injected when the question involves cash, checking, or emergency funds. Teaches: liquidity ratio, months-of-expenses framing, the difference between liquid assets and total assets.
- **Cash Flow module** — injected when the question involves spending, income, or net cash flow. Teaches: the three-way split (income → expenses → debt payments), what negative cash flow from debt payoff means versus from overspending.
- **Wealth module** — injected when the question involves net worth trends or investment performance. Teaches: net worth as lagging indicator, why net worth can decline while financial health improves (debt payoff erodes assets used to pay debt before principal reduction shows up in reduced liabilities).
- **Affordability module** — injected for "can I afford X" questions. Teaches: cash flow margin, liquidity headroom, and debt-to-income framing.

The distinction is: general prompt engineering governs *how* the model communicates. Domain-specific modules govern *what financial framework* the model uses for a given question type.

---

### Q10 — Should domain-specific financial concepts become reusable reasoning modules

Yes, and the recommended first set is: Debt Health, Liquidity, Cash Flow, and Affordability. Wealth and Risk are warranted additions but lower priority than the first four.

Each module is a short (3–7 line) instruction block that teaches the model a specific analytical framework. Modules are injected into the system prompt after `ADVISOR_PRINCIPLES`, before the context block. Selection is deterministic (based on Space category and active goals). A DEBT_PAYOFF Space with no investment accounts gets Debt Health + Liquidity + Cash Flow. An INVESTMENT Space gets Wealth + Liquidity. A Space with an EMERGENCY_FUND goal gets Liquidity + Affordability.

This is a maintainable pattern: modules are string constants defined once, updated independently, and composed at request time. They do not require new data models or new assemblers.

---

### Q11 — Should there be an intent layer before prompt construction

Yes — a lightweight one. The purpose is not to route the user's message to different API endpoints or to classify the full taxonomy of financial questions. It is to solve three specific problems:

1. Set the temporal frame: "this question asks about current state" vs. "this question asks about history" — which controls whether the prompt tells the model to lead with account balances or with transaction summaries.
2. Select the reasoning module to inject.
3. Set `scopeHint` for the context assembly call.

Implementation: a small deterministic function in `route.ts` that pattern-matches the last user message against a set of keyword clusters (five to eight clusters). This runs before `buildContext()` and produces a typed intent object. The intent object controls prompt construction and context assembly options.

A full LLM-based intent classifier is over-engineering for the current problem. Rule-based classification over the last user message is sufficient for the observed failure modes and avoids the latency and cost of a pre-pass LLM call.

---

### Q12 — Should historical metrics automatically become secondary evidence unless explicitly requested

Yes. This is the single highest-leverage prompt change. The rule should be explicit: "When a user asks about their current financial situation, current debt, current balances, or current position: the `accounts` domain is the primary source. The `transactions_summary` domain is supporting evidence — cite it only when it explains or elaborates on the current state, not as the lead."

An explicit trigger for "historical mode" — the user says "last month," "over the 90 days," "historically," "in the past" — switches the priority: transactions and snapshot history become primary, accounts become supporting context.

This requires zero code changes. It is two sentences added to `ADVISOR_PRINCIPLES`.

---

### Q13 — Should Knowledge Acquisition become part of normal conversation

Yes — in the model's understanding of what it can do. It is already part of the normal conversation flow technically: the UI renders the KA card whenever `knowledgeGaps` is non-empty in the response. The gap is that the model does not know this.

Three changes make KA feel native:

1. The system prompt explicitly describes KA as a permitted interaction: "When a user wants to save or update a value like APR, minimum payment, due date, or statement close date: tell them the form below your message can save it directly to their account."
2. The "Do not claim to execute actions or modify any data" restriction is narrowed: "Do not claim to execute trades, rebalance accounts, or create/delete accounts. Saving debt metadata values (APR, minimum payment) via the form below your message is supported — direct users to use it."
3. When APR is in a knowledge gap and the question requires it: the model explicitly says "I see your Chase APR is not saved yet — fill in the form below and ask me again with your calculation." Not "I cannot answer without the APR."

---

### Q14 — Recommended roadmap from today to excellent financial advisor

#### Tier 1: Prompt-only changes (zero code changes, zero migration)

These can be deployed in a single commit to `route.ts`. Expected improvement is substantial — Failures 1, 2, 3, and 5 are primarily prompt problems.

1. **Add today's date** to the system prompt preamble.
2. **Add temporal doctrine** to `ADVISOR_PRINCIPLES`: current-state questions lead with `accounts` domain; historical summaries are supporting evidence unless specifically requested.
3. **Add debt payment doctrine** to `ADVISOR_PRINCIPLES`: `debtPaymentTotal` is intentional capital allocation; cross-reference with goals to confirm; never label it as a spending problem.
4. **Narrow the "do not modify data" restriction** to carve out Knowledge Acquisition explicitly.
5. **Add Knowledge Acquisition guidance**: tell the model that the form below its message saves APR and minimum payment, and instruct it to direct users there when they want to save values.

These five changes directly fix Failures 1, 2, 3, and 5. They are the highest-leverage improvement available.

#### Tier 2: Context improvements (low-complexity code changes)

6. **Add `snapshot_history` to `FINANCE_CORE`** in `domain-manifest.ts`. One line. The assembler already exists.
7. **Replace raw JSON serialization** in `serializeContextBlock()` with pre-formatted, annotated context blocks. Each domain section gets a header with its time window, key fields get human-readable labels, and the `debtPaymentTotal` field gets an explicit annotation ("intentional debt payments, not expense").
8. **Implement the providers assembler** (`lib/ai/assemblers/providers.ts`). Low-complexity — reads `Connection` status and `PlaidItem.status` with no credential fields.

#### Tier 3: Financial reasoning modules (medium complexity)

9. **Define and inject reasoning modules** — Debt Health, Liquidity, Cash Flow, Affordability. Each is a short string constant. Inject based on Space category and active goal types using a deterministic selection function.
10. **Add pre-computed cross-domain annotations** to the serialized context — specifically, annotate when `debtPaymentTotal` is the primary driver of negative `netCashFlow`, and when the user has a goal that explains observed behavior. This can be a post-assembly pass before serialization.

#### Tier 4: Intent classification (medium complexity)

11. **Lightweight intent classifier** — 5–8 intent types, keyword-based. Controls temporal frame doctrine, reasoning module selection, and `scopeHint`. Lives in `route.ts` as a pre-pass before `buildContext()`.

#### Tier 5: Missing assemblers (medium complexity)

12. **Holdings assembler** — reads from the `Holding` table via `SpaceAccountLink`, produces allocation by asset class. Needed for `INVESTMENT` and `RETIREMENT` Spaces.

#### Tier 6: Model upgrade (low complexity, meaningful cost)

13. **Model upgrade** from `gpt-4o-mini` to a stronger reasoning model. Tiers 1–5 should be completed first — model improvements compound on a better prompt/context foundation. Evaluating on the improved system produces a cleaner signal about where the capability ceiling actually is.

#### Defer

- Conversation state persistence across sessions (high complexity, lower incremental lift than Tiers 1–5 combined)
- Streaming responses (nice-to-have UX, not a quality gap)
- Proactive / ambient intelligence (requires AiAdvice job runner, which is a separate D4 slice)

---

## 5. Summary findings

| ID | Weakness | Type | Complexity | Roadmap Order |
|---|---|---|---|---|
| W1 | No temporal doctrine | Prompt | Low | Tier 1 |
| W2 | Debt payments treated as expenses | Prompt + Context | Low / Medium | Tier 1 / Tier 3 |
| W3 | Knowledge Acquisition invisible to model | Prompt | Low | Tier 1 |
| W4 | Raw JSON serialization | Prompt / Code | Medium | Tier 2 |
| W5 | No date in prompt | Prompt | Low | Tier 1 |
| W6 | Holdings assembler missing | New assembler | Medium | Tier 5 |
| W7 | Providers assembler missing | New assembler | Low-Medium | Tier 2 |
| W8 | Snapshot missing from FINANCE_CORE | Manifest | Low | Tier 2 |
| W9 | No intent classification | New module | Low-Medium | Tier 4 |
| W10 | No financial reasoning modules | Prompt / Code | Medium | Tier 3 |
| W11 | gpt-4o-mini model ceiling | Config | Low | Tier 6 |
| W12 | No conversation state | New architecture | High | Deferred |

The most impactful improvements are in Tier 1 — prompt-only changes that fix the majority of observed failures without touching a single assembler, schema, or migration. Tiers 2 and 3 complete the context layer and introduce the financial reasoning vocabulary that produces genuinely advisor-quality responses. Tiers 4 and 5 are important for Spaces where the missing assemblers matter. The model upgrade in Tier 6 compounds on everything else.

Do not implement all of this in one branch. Each tier is a natural boundary for a checklist-first, validation-gated implementation step consistent with the project's working style.
