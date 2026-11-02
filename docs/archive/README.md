# Archive

Historical context: **not current truth.** For what is true now, read
[`/STATUS.md`](../../STATUS.md), [`plans/INDEX.md`](../plans/INDEX.md) and the canonical
docs (`architecture/`, `systems/`, `operations/`, `decisions/`). The rules are in
[ADR-008](../decisions/ADR-008-documentation-lifecycle.md).

| Folder | Holds |
|---|---|
| [`completed-plans/`](completed-plans/) | The original archive (July 2026): security reviews, the frozen Phase-2 baseline, rejected proposals, closed migration plans. Path kept for inbound links |
| `v2.6/` | Plans and investigations completed up to the v2.6 release (2026-10-23): the v2.6 engine series, AI reasoning slices and experiments, operationalization, UX refinement, the pre-beta audit set |
| `v2.7/` | v2.7 work through its Production release (2026-10-27) |
| `beta-b1-b9/` | Work completed and released in beta batches B1–B9 (2026-10-28 … 11-02) |
| `evidence/` | **Protected, never deleted.** `security/`, `migrations-cutover/`, `incidents/`, `reviews/` |

Release buckets are created by the PRs that fill them. A plan moves here when its
release closes out (its Status is `DONE`). Its durable conclusions are first
promoted into the canonical tree.

**Public repository.** Archived public copies must not carry personal, billing,
credential or Production-access detail. Real financial figures are sanitised in public
copies, and originals that must be kept live in the owner's private store.

**Compatibility stubs.** When a code-cited doc moves, a short stub stays at the old path
(first line `# Moved`, with a link to the new location) until every citation is
rewritten. `scripts/docs-structure.test.ts` fails if a stub points nowhere.
