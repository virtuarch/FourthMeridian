# ADR-008 — Documentation lifecycle: preserve knowledge, not paperwork

**Status:** accepted (owner, 2026-11-02) · **Contract:** [docs/README.md](../README.md#documentation-lifecycle)

## Context

`docs/plans/` was meant to hold *active* plans. Between July and November 2026 it grew
to 176 files (4.6 MB). Every investigation, closure, overnight report and readiness
check became a new dated file (`TOPIC-YYYY-MM-DD.md`), often in parallel copies by
different agent sessions. By November only a handful governed unfinished work. Several
said "awaiting review" or "nothing implemented" after their work had shipped, and
STATUS.md had grown to 84 KB and drifted from Production. The driver was an agent rule:
one new dated report per investigation.

## Problem

How do we keep the knowledge (decisions, invariants, constraints, operational
procedures, unresolved requirements, evidence) without keeping the paperwork, and
without a documentation system that has to be cleaned up again?

## Decision

**The lifecycle:**

> Investigation → active plan (only when necessary) → implementation → update the
> canonical documentation → close the initiative → **delete the redundant working
> document.**

1. **One authoritative document per subject**, in the canonical tree:
   `architecture/` · `systems/` · `operations/` · `decisions/`. Every material claim is
   marked **IMPLEMENTED** (with a PR or code reference) · **DECIDED BUT NOT IMPLEMENTED**
   · **PROPOSED** · **DEPRECATED**. A historical proposal is never presented as shipped,
   and investigations are not copied wholesale.
2. **Update before create.** A finding goes into the canonical doc or the active plan
   that owns the topic. A new plan exists only for a distinct, substantial initiative
   (its own PR series or batch id) or an explicit owner request. Its name has no date.
3. **Active plans are indexed.** `docs/plans/INDEX.md` lists each one, and each carries
   a header: **Owner · Status** (`DRAFT` · `ACTIVE` · `BLOCKED` · `DONE` ·
   `SUPERSEDED-BY <doc>`) **· Updated · PRs**. A plan is active only if it governs
   unfinished work, with an owner and a next action.
4. **Closeout deletes, it does not archive.** When an initiative closes, its durable
   content is extracted into the canonical doc and the working plan is **deleted**.
   Git history is the archive for ordinary completed plans. Deleting tracked
   documentation needs the owner's approval, and a short disposition manifest is
   recorded in the PR.
5. **A dedicated archive is only for protected evidence** (security incidents and
   remediation, database migration and rollback evidence, Production cutover records,
   financial reconciliation, billing evidence, important owner decisions, unresolved
   defects or obligations, records with a real retention requirement) and for material
   with demonstrated long-term value. Evidence is never deleted to reduce file count.
   Evidence kept in `docs/archive/` must be public-safe (sanitised); originals with
   personal, billing, credential or Production-access detail go to the owner's private
   store.
6. **The repository is public.** Personal, billing, credential or Production-access
   detail lives in the owner's private store, never in `docs/`. Public copies of real
   financial data are sanitised.
7. **One writer per canonical document** (ownership matrix in docs/README.md). Other
   sessions add review notes or sections, never a competing copy.
8. **A unit test guards the structure** (`scripts/docs-structure.test.ts`): no network,
   no new workflow. It checks:
   * every indexed plan carries a valid header, and INDEX's status equals the header's;
   * every other top-level plan is on a legacy allowlist that can only shrink (capped);
   * any `# Moved` pointer resolves.

   It never forces an obsolete plan to stay. Deleting a legacy plan just removes its
   allowlist entry.

## Alternatives considered

- **Move every completed plan into release-based archive folders.** Rejected (owner,
  2026-11-02). It relocates the paperwork instead of removing it, creates hundreds of
  pointer stubs to maintain, and keeps duplicated and superseded text browsable as if
  it still mattered. Git history already preserves it.
- **Delete without extraction** ("it's old"). Rejected: plans can hold the only record
  of a decision, an invariant or an unresolved requirement. Extraction comes first, and
  protected evidence is kept.
- **A CI workflow or external docs linter.** Rejected: runner cost and a dependency for
  checks the existing unit suite can do.

## Consequences

- Agents orient from STATUS.md, then `plans/INDEX.md`, then one canonical doc.
- `docs/plans/` stays small: only plans with unfinished work and a named owner.
- Closing an initiative carries a small cost: extract into the canonical doc, then
  delete the plan. That cost is intended.
- Old text is recovered with `git log -- <path>` / `git show`, not by browsing an archive.
- Git history is now load-bearing. Any history rewrite must target only the specific
  files approved for removal and must preserve all other documentation history.
