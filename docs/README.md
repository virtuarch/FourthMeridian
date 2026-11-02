# Fourth Meridian — Documentation

This is the **specification of Fourth Meridian**, not the history of building it. A new
engineer or product person should be able to read `docs/` with zero prior context and
understand what the system is, how it is built, why it is built that way, and how to
change it safely. Implementation history lives in git; this tree keeps only the durable
truth.

For what is true **right now** (version, active work, blockers, next steps), read
[`/STATUS.md`](../STATUS.md) — the current-state authority. **If a doc here disagrees
with the code, the code wins; fix the doc.**

## Start here

**[architecture/](architecture/)** — the binding doctrine. Begin with
[architecture/README.md](architecture/README.md), then read
[FOURTH_MERIDIAN_DOCTRINE.md](architecture/FOURTH_MERIDIAN_DOCTRINE.md) (the reader's
guide that ties everything together).

## The four questions the docs answer

| Question | Where |
|---|---|
| **What is Fourth Meridian?** | [architecture/FOURTH_MERIDIAN_DOCTRINE.md](architecture/FOURTH_MERIDIAN_DOCTRINE.md) · [design-system/product-language.md](design-system/product-language.md) |
| **How is it built?** | [architecture/](architecture/) (doctrine) · [systems/](systems/) (subsystems) |
| **Why is it built this way?** | [decisions/](decisions/) (ADRs — decisions + rejected alternatives) |
| **How do I safely change it?** | [architecture/README.md](architecture/README.md) ("where to go when you change a feature") + the relevant systems doc |

## Folders

| Folder | What it holds |
|---|---|
| [`architecture/`](architecture/) | **Binding doctrine.** The doctrine reader's guide, the Financial Truth Spine, Space Architecture, the Security Model, the Time Model, the UI Interaction Model. |
| [`systems/`](systems/) | **Subsystem reference** — why each part exists, its authority, contracts, invariants: transactions, investments, wealth, cash-flow, liquidity, debt, connections, crypto-networks, money-and-fx, historical-data, ai-foundation, platform-operations. |
| [`decisions/`](decisions/) | **ADRs** — decisions already made, alternatives rejected. Do not revisit a decision here without a new ADR. Includes the immutable Phase-2 decision matrix. |
| [`operations/`](operations/) | Runbooks, deployment, incident response, admin operations, key rotation, environment separation (incl. [one OpenAI project per environment](operations/openai-environment-separation.md)), and the living production-readiness doc + checklists. |
| [`design-system/`](design-system/) | The Atlas design authority (glass/liquid material, modal doctrine, material classification) + the product language guide. |
| [`plans/`](plans/) | **Active work only.** [`plans/INDEX.md`](plans/INDEX.md) is the authoritative list (owner, status, what is open). A file not listed there is historical and is moving to `archive/`. |
| [`releases/`](releases/) | Honest per-version release notes. |
| [`archive/`](archive/README.md) | **Historical context, not current truth.** `completed-plans/` (the July archive), release buckets (`v2.6/`, `v2.7/`, `beta-b1-b9/`) for plans closed at each release, and `evidence/` (security, migrations/cutover, incidents, reviews), which is **never deleted**. |
| [`audits/`](audits/) | Being retired (owner, 2026-11-02): the pre-S1 audit stops being the live defect register. Its independently verified open findings are carried forward, then it moves to `archive/evidence/`. The pre-beta audit set moves to the archive. |
| [`design-studies/`](design-studies/) | Dated visual design studies for the Platform Spaces (Customer Success, Growth & Revenue, Platform refresh, Security Operations); the reference shape for Platform UI work. |
| [`initiatives/`](initiatives/) | Implementation checklists for named initiatives (currently KD-15). |
| [`bugfixes/`](bugfixes/) | A few closed bug writeups kept for operational reference. |
| [`images/`](images/) | Shared screenshots and diagrams. |

## The documentation contract

- **Doctrine is binding.** `architecture/` and `systems/` state what must be true. A
  change that violates a doctrine is a defect until an ADR says otherwise.
- **Decisions are durable.** A decision recorded in `decisions/` should not be
  re-litigated casually — read the ADR (including its rejected alternatives) first.
- **The archive is small.** We archive *rejected alternatives, security reviews, and
  irreversible-decision context* — never implementation logs. "What changed in July"
  lives in git history, not here.
- **When a slice completes**, its durable conclusions are promoted into `architecture/`,
  `systems/`, or `decisions/` and a release note is updated. The working plan is marked
  `DONE` and moves to `archive/<release>/` at release closeout (see below).

## Documentation lifecycle

[ADR-008](decisions/ADR-008-documentation-lifecycle.md) holds the decision and its
rationale. In short:

1. **Update before create.** Put a finding into the canonical doc or the active plan
   that owns the topic. A new plan is only for a distinct, substantial initiative (its
   own PR series or batch id) or an explicit owner request. Name it without a date and
   list it in [`plans/INDEX.md`](plans/INDEX.md) in the same PR.
2. **Every active plan has a header** directly under its title:
   `> **Owner:** … · **Status:** DRAFT|ACTIVE|BLOCKED|DONE|SUPERSEDED-BY <path> · **Updated:** YYYY-MM-DD · **PRs:** …`
3. **Implemented vs proposed.** Canonical docs mark statements **IMPLEMENTED** (PR #) ·
   **PROPOSED** · **DECIDED-NOT-BUILT**. A design is never presented as shipped.
4. **Release closeout.** `DONE` plans move to `archive/<release>/`, and citations in code,
   tests, scripts and READMEs are updated in the same PR. A code-cited doc leaves a
   `# Moved` stub at its old path until every citation is rewritten.
5. **Evidence is never deleted.** Security, incident, migration/cutover, rollback and
   billing records go to `archive/evidence/`.
6. **The repository is public.** Personal, billing, credential or Production-access
   detail never enters `docs/`; it belongs in the owner's private store. Public copies of
   real financial figures are sanitised.
7. **Destructive changes** (deleting a doc, or merging that drops text) need the owner's
   approval.
8. `scripts/docs-structure.test.ts` (part of the unit suite; no network, no extra
   workflow) enforces the index, the headers and the stubs.

## Who writes what (one writer per canonical document)

| Writer | Documents |
|---|---|
| Session 1 (release owner) | `STATUS.md`, `releases/`, `operations/release-checklist.md`, `operations/branching-and-protection.md`, the PRE-BETA release plan |
| Session 2 (independent reviewer) | `architecture/SECURITY_MODEL.md`, `operations/database-safety.md`, RLS documentation |
| Session 3 (workspace maintenance) | this file, `plans/INDEX.md`, `archive/`, the documentation lifecycle |
| The initiative's owner | Its `systems/` document, at closeout |

Others contribute through review notes or dated sections, never a competing copy.
Session 2 independently reviews every documentation PR.
