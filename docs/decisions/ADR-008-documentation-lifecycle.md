# ADR-008 — Documentation is update-first, indexed, and archived at release

**Status:** accepted (owner, 2026-11-02) · **Contract:** [docs/README.md](../README.md#documentation-lifecycle)

## Context

`docs/plans/` was meant to hold *active* plans ([docs/README.md](../README.md)), and
completed slices were supposed to promote their conclusions and delete the working
artifact. In practice, between July and November 2026 it grew to 176 files (4.6 MB).
Every investigation, closure, overnight report and readiness check became a new dated
file (`TOPIC-YYYY-MM-DD.md`), often in parallel copies by different agent sessions. By
November about 90% of `plans/` was completed history. Several docs still said
"awaiting review" or "nothing implemented" after their work had shipped, and STATUS.md
had grown to 84 KB and drifted from Production. The driver was an agent rule: one new
dated report per investigation.

## Problem

How do we keep durable knowledge (decisions, invariants, evidence) without the plans
tree turning into a log that agents and engineers can't navigate, and without
losing security, incident, migration, rollback or billing evidence?

## Decision

1. **Update before create.** A finding goes into the canonical doc
   (`architecture/`, `systems/`, `operations/`, `decisions/`) or the active plan that
   owns the topic. A new plan exists only for a distinct, substantial initiative (its
   own PR series or batch id) or an explicit owner request. Its name has no date.
2. **An index of active plans.** `docs/plans/INDEX.md` lists every active plan, one
   line each. Every active plan carries a header: **Owner · Status** (`DRAFT` ·
   `ACTIVE` · `BLOCKED` · `DONE` · `SUPERSEDED-BY <doc>`) **· Updated · PRs**.
3. **One writer per canonical doc** (ownership matrix in docs/README.md). Other
   sessions add review notes or dated sections, never a competing copy.
4. **Release closeout.** When an initiative finishes, its plan becomes `DONE`, durable
   conclusions are promoted into the canonical tree (each statement marked
   **IMPLEMENTED** (PR #) · **PROPOSED** · **DECIDED-NOT-BUILT**), and at the release
   the plan moves to `docs/archive/<release>/` with citations updated in the same PR.
5. **Evidence is never deleted.** Security, incident, migration/cutover, rollback and
   billing records move only to `docs/archive/evidence/` (public-safe) or to the
   owner's private store (personal, billing, credential or Production-access detail;
   the repository is public). Public copies of real financial data are sanitised;
   originals are kept privately.
6. **Destructive doc changes need owner approval**: deleting a doc, or merging that
   drops text.
7. **A unit test guards the structure** (`scripts/docs-structure.test.ts`): no
   network, no new workflow. Every top-level `plans/*.md` is either indexed with a
   valid header or on a shrinking legacy list, and every compatibility stub resolves.

## Alternatives considered

- **Delete completed plans outright** ("git keeps history"). Rejected: plans hold
  unique decisions and evidence that nobody would find in git history, and evidence
  must stay browsable.
- **Topic-based archive folders.** Rejected in favour of release buckets
  (`v2.6`, `v2.7`, `beta-b1-b9`, …). A release is the natural closeout moment, and
  topic knowledge belongs in the canonical `systems/` docs, not in an archive's shape.
- **A CI workflow or external docs linter.** Rejected: an extra workflow costs runner
  minutes and adds a dependency. The existing unit suite already runs on every PR.

## Consequences

- Agents orient from STATUS.md, then `plans/INDEX.md`, then the canonical doc,
  instead of scanning hundreds of dated reports.
- A new unindexed plan fails the unit suite, so authors must index it or update an
  existing doc instead.
- Moving a code-cited doc leaves a short compatibility stub at the old path until the
  citations are rewritten.
- Writing a plan now carries a small cost: header, index line, closeout. That cost is
  intended.
