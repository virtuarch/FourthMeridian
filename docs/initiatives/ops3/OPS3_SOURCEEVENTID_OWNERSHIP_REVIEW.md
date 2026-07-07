# OPS-3 — `sourceEventId` Ownership Review (Pre-Freeze Ruling)

**Date:** 2026-07-07 · **Question:** should `sourceEventId` be introduced in the OPS-3 S1 migration, or owned by PO1's canonical Event Grammar / Registry when it lands?
**Nature:** ARCHITECTURE REVIEW ONLY — no code, no schema, no implementation, no STATUS update.
**Documents under review:** `OPS3_NOTIFICATIONS_PREFERENCES_INVESTIGATION.md` (baseline) and `OPS3_ARCHITECTURE_REVIEW.md` (second pass), which recommended reserving `sourceEventId` in S1 (§4, ruling 4).

**Verdict up front: the second review got this one wrong, and the error is worth naming precisely because the rest of its §4 ruling (dedupe) is right. `sourceEventId` should be deferred.** The review conflated two different identities — the canonical event **type** (real, ratified, PO1 P0's property, and already honored by OPS-3's registry-aligned `type` field) and a canonical event **instance** (a concept that has no substrate, no owner, and no consumer anywhere on the ratified runway). It also violated its own freshly-minted principle — *"reserve constraints at birth; defer columns until a writer exists"* — in the very section that minted it: `sourceEventId` is a nullable column with no writer, and worse, no referent.

---

## 1. Ownership

### 1.1 Two identities, two owners

The phrase "canonical event identity" hides a type/instance distinction that decides the whole question:

- **Type identity** — "what kind of fact is this?" (`PASSWORD_CHANGED`, `SYNC_FAILED`). PO1 P0 (Event Grammar & Registry, ratified into the STATUS runway *ahead* of OPS-3) owns this exclusively: one grammar, one registry entry per event, source-of-record assignment (Master Plan Rev B, R.2). OPS-3's obligation — already ruled in the second review's §3 and **unchanged by this ruling** — is to *cite* those ids in its notification registry rather than coin synonyms. `Notification.type` therefore already carries the canonical type identity. Nothing more is needed at the type level.
- **Instance identity** — "which occurrence of that fact?" This is what `sourceEventId` would hold. Verified against the tree and the ratified plans: **no such concept exists anywhere, and none is planned.** Zero occurrences of `eventId` / `correlationId` / `traceId` in `lib/`, `app/`, or the schema. PO1 P0 is explicitly "types + doctrine, zero runtime" — a registry of event *kinds*, not a store of event *occurrences*. PO1 P1 (telemetry) is explicitly an aggregate stream — "counts/durations/kinds/IDs only… telemetry counts, audit records" — its rows are counters, not citable instances. PF1's job ledger has run ids scoped to jobs. The only durable event-instance record in the entire platform is **the `AuditLog` row itself**, whose id the baseline already captures as `auditLogId`.

### 1.2 The ownership answers

- **Who should own canonical event identity?** Type level: PO1 P0, already settled. Instance level: whichever future initiative creates an event-instance store — plausibly a later PO phase, possibly nobody, because the platform's own doctrine ("telemetry counts, audit records") assigns instance-recording to `AuditLog` and may never need a second instance store.
- **Does introducing `sourceEventId` in OPS-3 violate one-source-of-truth?** Yes — in a subtler way than usual. It doesn't duplicate an existing concept; it **coins a concept whose owner hasn't defined it**. OPS-3 would be deciding, implicitly and ahead of PO1, that event instances have platform-wide ids, what format they take, and that the notification store is a consumer — three decisions that belong to the initiative that builds the substrate. If PO1 later chooses a different shape (composite keys, per-store ids + a mapping, or no instance ids at all), OPS-3's column is not just unused but *wrong*, and a wrong reserved column is worse than an absent one: it documents a contract the platform never made. This is precisely the "vocabulary born ahead of its owner" failure Rev B's Finding 3 fixed by re-ordering PO1 P0 ahead of OPS-1's emissions — the same principle, one level up.
- **Is OPS-3 creating vocabulary that belongs to PO1?** At the type level, no (it cites). At the instance level, yes — which is the reason to stop.

---

## 2. Practical need — every proposed consumer, examined

| Consumer | Verdict | Reasoning |
|---|---|---|
| **Notification deduplication** | **Doesn't need it** | Dedupe is served by `dedupeKey`, which identifies the ongoing *condition* and deliberately **collapses** occurrences. `sourceEventId` distinguishes occurrences — the opposite motion (§5). |
| **Notification → AuditLog linkage** | **Doesn't need it — already served** | `auditLogId` *is* the instance pointer for audited facts, and `AuditLog` is the platform's only instance store. `sourceEventId` would be a second pointer to the same row with extra indirection. |
| **OPS-5 Platform Operations** | **Doesn't need it** | Every planned OPS-5 read (delivery analytics, notification health, provider health) is an **aggregate** over `type`/`category`/`channel`/`status`/time — type-level identity plus timestamps. Instance-level drill-down ("show me the exact occurrence") is served by `auditLogId` + `metadata` pointers where it exists at all. |
| **Platform Facts (PF1)** | **Benefits later** | A digest or cleanup notification created by a dispatcher job could carry the job-run id — but PF1 run ids don't exist yet, and when they do, `metadata.jobRunId` carries them **with zero migration** (§3-D). |
| **Platform Rollups (POR1)** | **Doesn't need it** | Rollups are frozen daily aggregates by definition. They join on type ids and dates, never on instances. |
| **Telemetry (PO1 P1)** | **Doesn't need it** | Telemetry is counters at chokepoints; it has no instance rows to join *to*. Correlation happens at emission time (the chokepoint sees both sides), not by stored id. |
| **Future AI reasoning** | **Benefits later, served by metadata** | "Why did I get this?" wants the underlying *fact*: `metadata.adviceId` → `AiAdvice`, `metadata.plaidItemId` → the item, `auditLogId` → the audit row. Domain pointers are *more* explainable than an opaque event id — the agent can read the actual object. |
| **Job ledger** | **Benefits later** | Same as PF1: `metadata.jobRunId` when the ledger exists. |
| **Debugging** | **Doesn't need it now** | At beta scale: `type` + `userId` + `createdAt` + `metadata` + `auditLogId` reconstructs any notification's provenance in one query. Cross-store trace ids are a real want at *distributed* scale — which is a different platform than the one being built (single process, single DB, no queue). |

**Score: zero "needs it now."** Every "benefits later" case is served by the `metadata Json` field the baseline already has — and JSON keys require no migration, which collapses the urgency argument entirely.

---

## 3. Alternatives

**A. No `sourceEventId` in OPS-3; PO1 introduces it later (if ever).**
Migration cost: one additive nullable column + index in a future PO slice — the cheap kind, per the second review's own taxonomy. Cleanliness: highest — the concept is born with its substrate, defined by its owner, shaped by a real consumer. Risk: bounded lineage gap in historical rows (§4) — which retention makes nearly meaningless.

**B. Reserve nullable `sourceEventId` now, unused until PO1.**
Migration cost now: trivial. Architectural cost: real — a column with no writer, no referent, and no defined format is a **placeholder**, the thing every investigation in this repo forbids; it pre-commits PO1 to a shape it hasn't chosen; and it violates the reserve-constraints/defer-columns principle. If PO1's eventual shape differs, the platform carries either a dead column or a semantics-changed column (worse than dead). This is the second review's recommendation, and it is the wrong branch of its own principle.

**C. `auditLogId` only today; supplement later.**
This is not really an alternative to A — it *is* A, stated from the schema's side. `auditLogId` has a real referent (the platform's only instance store), a real writer (inline producers capture it; EV-1-derived producers pending the emit-return-id decision), and a real consumer (the security-history cross-link). Keep it exactly as the baseline designed.

**D. Stronger design — lineage as registry-governed `metadata` pointer contracts.** *(Recommended, combined with A/C.)*
The baseline already established the pointer discipline (§J doctrine: notifications point at facts — `adviceId`, `inviteId`, `plaidItemId`, `batchId`). The one genuinely valuable, genuinely free reservation is to make those pointers **contractual instead of ad hoc**: each notification registry entry (second review §3) documents its `metadata` pointer shape — e.g. `SYNC_FAILED` carries `{ plaidItemId }`, `OPPORTUNITY_FOUND` carries `{ adviceId }`, digest-created types carry `{ jobRunId }` once PF1 exists. Cost: one documented field per registry entry — doctrine, not schema. Payoff: lineage is structured and queryable (Postgres JSON operators reach it even un-indexed at current scale), new stores' ids ride in without migration the day they exist, and if PO1 ever mints platform-wide instance ids, `metadata.sourceEventId` can carry them **from day one of PO1** — with column promotion (`ALTER TABLE ADD COLUMN` + backfill *from the JSON already present*) reserved for the day an indexed query actually needs it. That promotion path means choosing D now forecloses nothing.

---

## 4. Future migration cost if OPS-3 ships without it

- **What must PO1 do?** Nothing to OPS-3 tables on landing (P0 is types-only; P1 is counters). If a later PO phase mints instance ids: publish the format → notification registry entries adopt `metadata.sourceEventId` (zero migration, immediate) → optionally, much later, promote to a column when an indexed query exists (one additive migration, backfilled from JSON).
- **Do historical notifications lose lineage?** Only rows created before adoption — and here the notification store's own design answers the question: **it self-prunes.** Read rows auto-archive at ~30 days and archived rows delete at ~90. By the time a PO instance-id phase lands *and matures a consumer*, the unlineaged rows will have aged out of existence on their own. The window of "history without lineage" is at most one retention cycle of a deliberately ephemeral table. (Contrast `AuditLog` — where lineage *is* forever, and is already captured.)
- **Could lineage be reconstructed?** For the bounded window, yes, well enough for any real purpose: audited types via `auditLogId`; the rest via (`userId`, `type`, `createdAt`) correlation against their substrate tables (`SyncIssue`, `ImportBatch`, `SpaceInvite` all carry their own timestamps). Nobody has proposed a query that would need this.
- **Additive and low-risk, or expensive?** Additive and low-risk, categorically. This is the decisive asymmetry with `dedupeKey`: retrofitting a **unique constraint** onto a populated table demands collision-resolution backfill (expensive → reserve at birth); retrofitting a **nullable column** onto a self-pruning table demands nothing (cheap → defer until a writer exists). The two fields sit on opposite sides of the second review's own principle, and should get opposite treatment.

---

## 5. Interaction with dedupe

`dedupeKey` and `sourceEventId` are **not substitutes and not complements — they answer opposite questions about occurrences:**

- `dedupeKey` says *"these N occurrences are the same ongoing condition — collapse them."* It is identity of the **condition**, deliberately lossy about instances. It needs the unique constraint, needs it at birth, and its template is owned by the notification registry entry. **Unchanged by this ruling — reserve it in S1 as the second review directed.**
- `sourceEventId` says *"this notification came from exactly that occurrence — distinguish it."* Identity of the **instance**, deliberately precise.

Does dedupe alone solve the practical problem? The practical problems OPS-3 actually has are **noise** (solved by `dedupeKey`) and **fact linkage** (solved by `auditLogId` + registry-contracted `metadata` pointers). `sourceEventId`'s problem — joining notification instances to *other stores'* event instances — does not exist yet, because those stores do not exist yet. So: two different problems; only one of them is real today; the real one is already solved without `sourceEventId`.

One honest edge worth recording: multi-producer *cross-system* dedupe ("an AI agent and a cron both notice the same anomaly") might look like an instance-identity problem. It isn't — it's a condition-identity problem, and `dedupeKey` handles it *better*: two producers observing the same condition compute the same key (`GOAL_RISK:goal:<id>:open`) regardless of which occurrence they saw. Instance ids would *defeat* that dedupe (different occurrences → different ids → both notifications land). This edge case is an argument **for** the dedupe design and **against** needing instance identity, not the reverse.

---

## 6. Recommendation

**Defer `sourceEventId`. Do not include it in the OPS-3 S1 migration. Amend the second review's §4/ruling-4 accordingly.**

The reasoning, compressed:

1. **No referent.** There is no event-instance store for it to point at, and none on the ratified runway — PO1 P0 is a type registry, PO1 P1 is counters, and the platform's only instance record (`AuditLog`) is already captured by `auditLogId`. A foreign key to nowhere is not a reservation; it's a guess.
2. **No writer, no consumer.** All nine proposed consumers score "doesn't need it" or "benefits later via metadata" (§2). The second review's own principle — reserve constraints, defer columns until a writer exists — rules against it; the review erred by exempting its own suggestion.
3. **Wrong owner.** Instance-identity format and semantics belong to the initiative that builds the instance store. OPS-3 minting them pre-empts PO1 — the exact born-ahead-of-its-owner defect Rev B's Finding 3 exists to prevent.
4. **Deferral is nearly free.** The notification table self-prunes, so the lineage gap is one retention cycle of an ephemeral table; adoption later is a JSON key (zero migration) with an optional column promotion (additive) — the cheap side of the asymmetry that makes `dedupeKey` urgent.
5. **The valuable part survives in stronger form.** What the second review was *reaching for* — durable, queryable lineage — is delivered by three things that all stand: registry-aligned `type` (canonical type identity, PO1 P0-cited), `auditLogId` (instance identity for audited facts), and **registry-contracted `metadata` pointers** (§3-D — the one addition this ruling makes: each registry entry documents its pointer shape, so lineage is structured doctrine rather than a speculative column).

**Net change to the frozen design:** S1 migration drops `sourceEventId`; the notification registry (second review §3) gains a documented per-type `metadata` pointer contract; `dedupeKey` + `@@unique([userId, dedupeKey])` and `auditLogId` remain exactly as ruled. The OPS-3 schema gets one field smaller, and every long-term capability the field was meant to protect remains reachable by additive steps owned by the right initiatives.

---

*Architecture review only — stop here. No implementation begun.*
