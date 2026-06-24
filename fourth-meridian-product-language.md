# Fourth Meridian — Product Language & Naming Guide

**Status:** v2.0.2 draft — product language & rebrand prep
**Scope:** This document defines the vocabulary, naming hierarchy, and voice for Fourth Meridian. It is a planning artifact for the FinTracker → Fourth Meridian bridge.

**Update (Phase 1, post-v2.1.0):** the Prisma model/client layer has since been renamed to match this guide (`Workspace`→`Space`, `WorkspaceMember`→`SpaceMember`, `WorkspaceSnapshot`→`SpaceSnapshot`, etc.) via `@@map`/`@map` — a zero-DDL rename, so physical Postgres table/column names are untouched and no migration risk was introduced. `WorkspaceAccountShare` (model, accessor, and its own `workspaceId` field) was deliberately left unrenamed for compatibility and is out of scope until a future, separately-approved migration. §3 below has been updated to reflect this current state.

**Update (naming cleanup pass, post-v2.1.0):** the earlier "Module" framing below has been superseded. FinTracker is no longer described as a cross-cutting module layered on every Space — it is the **default Space Template**: the built-in preset used when a user creates a general-purpose finance Space. Fourth Meridian is the product; FinTracker is one built-in template among others (TaxFlow, Heritage, Crypto, future templates). AI is not a Space Template — it's a platform-level capability that surfaces briefings across whichever Spaces a user has, independent of template. The app/package name has also been renamed from `fintracker` to `fourth-meridian` in this pass (see §3, §8).

---

## 1. Naming Hierarchy

```
Fourth Meridian                    the platform
└── Spaces                         the organizing primitive
    ├── FinTracker (template)      day-to-day finance tracking — the default template
    ├── TaxFlow (template)         tax planning & prep
    ├── Heritage (template)        estate / legacy planning
    ├── Crypto (template)          digital asset tracking
    └── future templates

AI                                  platform-level briefings & advice — not a Space Template
```

Three nouns carry the entire system. Everything else is a variation on one of them:

* **Fourth Meridian** — the platform. Never a feature, never plural.
* **Space** — the organizing container for a person's, household's, or entity's financial life. A user can have several.
* **Space Template** — a preset that shapes what a Space tracks and how it's organized at creation. FinTracker is the default template, not a synonym for the product.

A simple test for any new term: does it describe the *platform*, a *container of financial context*, or a *preset shape for that context*? If it doesn't fit one of those three, it probably doesn't belong in the top-level vocabulary.

---

## 2. Core Terms

| Term | Definition | Notes |
|---|---|---|
| **Fourth Meridian** | The overall product/platform name. | Always full name on first reference in any document; "the platform" is an acceptable short form in running text. |
| **Space** | A financial, household, or planning context that holds accounts, assets, debts, goals, members, and history. The thing users create and live inside. | Also the live Prisma model name as of Phase 1 (see §3). |
| **Space Template** | A preset/blueprint applied when creating a Space (FinTracker, TaxFlow, Heritage, Crypto). | Replaces the earlier "Module" framing — see Phase-1-cleanup update above. Templates shape a Space at creation; they are not separate cross-cutting lenses applied to every Space at once. |
| **FinTracker** | The default Space Template: day-to-day finance tracking — balances, holdings, transactions, snapshots, manual refresh. | The original product, now the default built-in template. |
| **AI** | Ambient briefings and suggestions generated from a Space's context. | Platform-level capability, not a Space Template — surfaced via Daily Brief, independent of which template(s) a user's Spaces use. |
| **Account** | A linked or manual financial account inside a Space (bank, brokerage, crypto, manual asset/debt). | Unchanged. |
| **Snapshot** | A point-in-time aggregate of a Space's financial position. | Unchanged in meaning; the model is now named `SpaceSnapshot` (renamed from `WorkspaceSnapshot` in Phase 1, via `@@map` — no DDL). |
| **Member** | A person with access to a Space. | Replaces "workspace member" in user-facing copy. |
| **Briefing** | An AI-generated summary or set of suggestions surfaced ambiently (not a chat window). | New term — see §5, AI voice. |

---

## 3. Old Term → New Term Mapping

This is the bridge table: what changed in **user-facing copy**, and what changed (or deliberately didn't) at the **Prisma/code** layer. As of Phase 1, the Prisma model/client layer was renamed alongside the copy — via `@@map`/`@map`, so physical Postgres table/column names are untouched and no DB migration was required.

| Old / current | New (UI copy) | Code / schema | Status |
|---|---|---|---|
| Workspace | Space | `Workspace` model renamed to `Space` (`@@map`, no DDL) | Done — Phase 1 |
| Workspace member | Member (of a Space) | `WorkspaceMember` renamed to `SpaceMember` (`@@map`, no DDL) | Done — Phase 1 |
| WorkspaceSnapshot | Snapshot | `WorkspaceSnapshot` renamed to `SpaceSnapshot` (`@@map`, no DDL) | Done — Phase 1 |
| FinTracker (as the whole app) | Fourth Meridian (platform) / FinTracker (default Space Template) | npm package name renamed `fintracker` → `fourth-meridian`; branding strings, comments, and docs updated to match | Done — naming cleanup pass |
| PlaidItem | Linked account / connection | `PlaidItem` unchanged | UI copy only, no provider abstraction yet |
| Archive / Trash (workspace) | Archive / Trash (Space) | Lifecycle logic unchanged | UI copy only |
| WorkspaceAccountShare | (no UI copy change — internal join table) | `WorkspaceAccountShare` deliberately **not** renamed | Out of scope until a separately-approved migration (see `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` §2.C) |

Rule of thumb going forward for anything not yet renamed: **rename in sentences first; a code/schema rename only follows as its own controlled, explicitly-approved step.** `WorkspaceAccountShare` is the current example — its UI-facing concept ("which Spaces can see this account") already says "Space," but the model itself stays `WorkspaceAccountShare` until that step is separately approved.

Compatibility-sensitive identifiers left unchanged in the naming cleanup pass (intentionally, not oversights): the local Postgres database/user name (`fintracker`), the `fintracker_space` cookie name read by `lib/space.ts` and `components/ui/Sidebar.tsx`, and the `virtuarch/fintracker` GitHub repo name (an external rename, not a file change). See §8.

---

## 4. Space Template Directory

Short, consistent descriptions for use in nav, marketing, and onboarding. Each follows the same shape: *what it watches over → why it matters → tone note.*

**FinTracker** *(default template)*
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

Naming convention for future templates: one word, no suffix like "Template" or "Tool," and it should describe the *domain* (Tax, Heritage, Crypto) rather than the *feature* (Reports, Tracker) — FinTracker is the deliberate, grandfathered exception.

**AI is not a Space Template.** It's a platform-level capability — ambient briefings and suggestions generated from a Space's full context, surfaced via Daily Brief, not a generic chatbot. See §2 and §5.

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
* **Space Template names are fixed product nouns** (FinTracker, TaxFlow, Heritage, Crypto) — never localized, pluralized, or used as verbs ("FinTracker it" is not a thing). AI is named separately — see §2, §4 — and follows the same rule but is not itself a template.
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
> Fourth Meridian organizes your financial life into Spaces — personal, family, or goal-based — and gives you focused templates like FinTracker, TaxFlow, and Heritage to understand and act on what's inside them, with AI that explains rather than overwhelms.

---

## 8. Guardrails (current)

* Phase 1 (complete): `Workspace` → `Space`, `WorkspaceMember` → `SpaceMember`, `WorkspaceSnapshot` → `SpaceSnapshot` renamed at the Prisma model/client layer via `@@map`/`@map` — zero DDL, physical Postgres tables/columns unchanged, no API/auth/business-logic changes beyond the naming itself. `PlaidItem` stays exactly as it is in code (no rename proposed).
* `WorkspaceAccountShare` is explicitly **not** renamed — model name, Prisma accessor, and its own `workspaceId` field/relation all stay as-is for compatibility. Any future rename of it (e.g. into a consolidated `SpaceAccountLink`, per `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md`) is a separate, not-yet-approved milestone.
* No new backend architecture (`ProviderCatalog`, `Connection`, `SpaceAccountLink`) is in scope until separately approved.
* FinTracker is no longer the app/package name (renamed `fintracker` → `fourth-meridian` in the naming cleanup pass) but remains a valid Space Template name — the default one. This doc does not rename the GitHub repo (`virtuarch/fintracker`) — that's an external rename, done outside the codebase if/when desired.
* The local Postgres database/user name, the `fintracker_space` cookie, and any other compatibility-sensitive identifiers stay as `fintracker*` until a separately-approved migration — see §3.
* Nothing here authorizes touching the Refresh pipeline, reconciliation logic, or archive/trash lifecycle beyond the naming pass — business logic is unchanged.
