# Fourth Meridian — Product Language & Naming Guide

**Status:** v2.0.2 draft — product language & rebrand prep
**Scope:** This document defines the vocabulary, naming hierarchy, and voice for Fourth Meridian. It is a planning artifact for the FinTracker → Fourth Meridian bridge. It does not require any code or schema changes.

---

## 1. Naming Hierarchy

```
Fourth Meridian                    the platform
└── Spaces                         the organizing primitive
    ├── FinTracker (module)        day-to-day finance tracking
    ├── TaxFlow (module)           tax planning & prep
    ├── Heritage (module)          estate / legacy planning
    ├── Crypto (module)            digital asset tracking
    ├── AI (module)                ambient advice & briefings
    └── future modules
```

Three nouns carry the entire system. Everything else is a variation on one of them:

* **Fourth Meridian** — the platform. Never a feature, never plural.
* **Space** — the organizing container for a person's, household's, or entity's financial life. A user can have several.
* **Module** — a lens or capability applied inside a Space. FinTracker is the first module, not a synonym for the product.

A simple test for any new term: does it describe the *platform*, a *container of financial context*, or a *lens on that context*? If it doesn't fit one of those three, it probably doesn't belong in the top-level vocabulary.

---

## 2. Core Terms

| Term | Definition | Notes |
|---|---|---|
| **Fourth Meridian** | The overall product/platform name. | Always full name on first reference in any document; "the platform" is an acceptable short form in running text. |
| **Space** | A financial, household, or planning context that holds accounts, assets, debts, goals, members, and history. The thing users create and live inside. | User-facing term only (see §3 — `Workspace` stays in code). |
| **Module** | A capability or lens applied within a Space (FinTracker, TaxFlow, Heritage, Crypto, AI). | Modules read from the same Space data; they are views/tools, not separate data silos. |
| **FinTracker** | The day-to-day finance tracking module: balances, holdings, transactions, snapshots, manual refresh. | The original product, now scoped down to one module. |
| **Account** | A linked or manual financial account inside a Space (bank, brokerage, crypto, manual asset/debt). | Unchanged. |
| **Snapshot** | A point-in-time aggregate of a Space's financial position. | Unchanged in meaning; `WorkspaceSnapshot` stays as the model name. |
| **Member** | A person with access to a Space. | Replaces "workspace member" in user-facing copy. |
| **Briefing** | An AI-generated summary or set of suggestions surfaced ambiently (not a chat window). | New term — see §5, AI voice. |

---

## 3. Old Term → New Term Mapping

This is the bridge table: what changes in **user-facing copy** now, and what is explicitly **frozen in code** until a controlled migration (see project constraints).

| Old / current | New (UI copy) | Code / schema | Status |
|---|---|---|---|
| Workspace | Space | `Workspace` model unchanged | UI copy only, no migration yet |
| Workspace member | Member (of a Space) | `WorkspaceMember` unchanged | UI copy only |
| WorkspaceSnapshot | Snapshot | `WorkspaceSnapshot` unchanged | UI copy only |
| FinTracker (as the whole app) | Fourth Meridian (platform) / FinTracker (module) | App/package name unchanged for now | Product language only |
| PlaidItem | Linked account / connection | `PlaidItem` unchanged | UI copy only, no provider abstraction yet |
| Archive / Trash (workspace) | Archive / Trash (Space) | Lifecycle logic unchanged | UI copy only |

Rule of thumb: **rename in sentences, not in schemas.** Every row above is a copy change a designer or writer can make without touching Prisma, the database, or API contracts.

---

## 4. Module Directory

Short, consistent descriptions for use in nav, marketing, and onboarding. Each follows the same shape: *what it watches over → why it matters → tone note.*

**FinTracker**
Tracks balances, holdings, and transactions across every linked and manual account in a Space.
*The financial weather report — what's true right now.*

**TaxFlow** *(planned)*
Organizes tax-relevant events, documents, and deadlines tied to a Space's accounts and activity.
*Keeps tax season from being a surprise.*

**Heritage** *(planned)*
Estate and legacy planning — beneficiaries, documents, intentions, and long-horizon context for a Space.
*The module for "what happens after," handled calmly.*

**Crypto**
Tracks digital assets and wallets as first-class accounts inside a Space, alongside everything else.
*Crypto without a separate app to babysit.*

**AI**
Ambient briefings and suggestions generated from a Space's full context, not a generic chatbot.
*Explains and suggests — never overwhelms.*

Naming convention for future modules: one word, no suffix like "Module" or "Tool," and it should describe the *domain* (Tax, Heritage, Crypto) rather than the *feature* (Reports, Tracker) — FinTracker is the deliberate, grandfathered exception.

---

## 5. Voice & Tone

Five working principles, each with a do/don't pair.

**Calm, not urgent.**
Do: "Your Family Space is up 2% this month."
Don't: "⚠️ Your spending spiked! Act now!"

**Specific, not numerous.**
Do: surface the one number or insight that answers the screen's question.
Don't: list every balance, every percentage, every account on one screen.

**Explain, then suggest — never demand.**
Do: "Your emergency fund covers 2.1 months. Most people target 3–6."
Don't: "You need to save more."

**Plain language over fintech jargon.**
Do: "Linked account," "Space," "Snapshot."
Don't: "Aggregation node," "ledger entity," "instance."

**Confident, not performative.**
Do: short declarative sentences.
Don't: exclamation points, emoji, growth-hacker enthusiasm.

**AI voice specifically:** AI output is called a **Briefing** or a **suggestion**, never an "insight bomb" or "alert." It speaks in first person plural sparingly ("we noticed") and avoids hedging filler ("it looks like maybe perhaps").

---

## 6. Naming Conventions & Grammar

* **Space names are user-chosen**, title case, no required suffix: "Personal," "The Hogan Family," "Debt Payoff," "123 Maple St." Don't force a "Space" suffix into the name itself — the word "Space" comes from UI chrome (e.g., a label or icon), not the name string.
* Refer to **"a Space"** generically, **"your [Name] Space"** when specific: "your Personal Space," "the Family Space." Avoid "a workspace" anywhere in UI copy.
* **Module names are fixed product nouns** (FinTracker, TaxFlow, Heritage, Crypto, AI) — never localized, pluralized, or used as verbs ("FinTracker it" is not a thing).
* Capitalize **Space** and **Fourth Meridian** when referring to the product concepts; lowercase "space" only in generic, non-product usage (rare — prefer rewording).
* Avoid "dashboard," "workspace," and "portal" in new user-facing copy — they carry the enterprise-productivity tone this rebrand is moving away from. Prefer "Space," "overview," "briefing."

---

## 7. Positioning & Taglines (candidates)

For use in onboarding, marketing surfaces, and the eventual v2.1 landing experience. Not final — pick one direction in review rather than blending them.

1. *"A calm operating system for your financial life."*
2. *"One Space for everything you own, owe, and plan."*
3. *"Less dashboard. More clarity."*
4. *"Your financial life, organized into Spaces."*
5. *"Fourth Meridian: where your money makes sense."*

Short platform description (for app store / about copy):
> Fourth Meridian organizes your financial life into Spaces — personal, family, or goal-based — and gives you focused modules like FinTracker, TaxFlow, and Heritage to understand and act on what's inside them, with AI that explains rather than overwhelms.

---

## 8. Guardrails (do not violate in this phase)

* No database, Prisma schema, or model renames. `Workspace`, `WorkspaceMember`, `WorkspaceSnapshot`, and `PlaidItem` stay exactly as they are in code.
* "Space" is a **UI copy concept** right now, not a refactor target.
* FinTracker remains the app name in the repo and a valid module name — this doc does not rename the repo.
* Nothing here authorizes touching the Refresh pipeline, reconciliation logic, or archive/trash lifecycle — this is language and IA planning only, per v2.0.2 scope.
