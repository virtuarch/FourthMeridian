# Archive

**Not current truth.** For what is true now, read [`/STATUS.md`](../../STATUS.md),
[`plans/INDEX.md`](../plans/INDEX.md) and the canonical docs (`architecture/`,
`systems/`, `operations/`, `decisions/`). Rules:
[ADR-008](../decisions/ADR-008-documentation-lifecycle.md).

**Completed plans are not archived.** Their durable content goes into the canonical
docs, and the working document is deleted. Git history is the record
(`git log --all -- <path>`).

This folder holds only:

| Folder | Holds |
|---|---|
| [`completed-plans/`](completed-plans/) | The July 2026 archive (security reviews, the frozen Phase-2 baseline, rejected proposals, closed migration plans). It is due for the same review: keep only what has long-term value |
| `evidence/` | **Protected, never deleted to reduce file count:** security incidents and remediation, database migration and rollback evidence, Production cutover records, financial reconciliation, important owner decisions, unresolved defects or obligations. Created by the first PR that needs it |

**The repository is public.** Evidence kept here must be public-safe (sanitised).
Originals with personal, billing, credential or Production-access detail, or real
financial figures, go to the owner's private store.
