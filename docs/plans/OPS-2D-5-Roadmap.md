# OPS-2D-5 — Sync Incident Architecture · Remaining Roadmap

**Status:** DOCUMENTATION ONLY — no code, no schema, no tests, no commits from this document
**Date:** 2026-07-27 · written against `b08d992`
**Purpose:** the authoritative backlog for the unfinished portions of OPS-2D-5, written so this work can be paused for weeks and resumed without reconstructing decisions from a chat log.

**Closed and committed:**

| Slice | Commit |
|---|---|
| OPS-2D-5A-1 — incident lifecycle foundation | `00bfd79` |
| OPS-2D-5A-2 — producer convergence | `1e7f9a0` |
| OPS-2D-5B-0 — operation identity | `786e230` |
| OPS-2D-5B-1 — typed persistence taxonomy | `b08d992` |

**Open:** 5B-2 (resolvers) · 5C (labels) · 5D (UI). **Blocking dependency:** OPS-2D-TX-1, owned by another session.

> **Read this first.** The sequencing in [§5](#5-ui-sequencing) supersedes any older ordering, including the implied 5B-2 → 5C → 5D numbering. UI comes next. The numbers are identifiers, not a schedule.

---

## 1. Current state

### 1.1 Incident lifecycle foundation (`00bfd79`)

`SyncIssue` is the **incident episode**; `SyncIssueOccurrence` is one manifestation. Before this, forty failed transactions produced forty unrelated rows and recurrence after recovery was indistinguishable from a first occurrence.

Persisted: `incidentKey`, `incidentKeyVersion`, `first/lastOccurredAt`, `resolvedAt`, `resolutionKind`, `resolvingExecutionId`, `previousIncidentId`. Derived and deliberately **not** persisted: domain, severity, nature, semantic state.

Concurrency is a **database guarantee**, not an application check:

```sql
UNIQUE(incidentKey) WHERE resolved = false AND incidentKey IS NOT NULL
```

Both predicates are load-bearing — `resolved = false` lets a resolved episode recur as a new generation instead of colliding forever; the null exemption leaves every legacy row alone. A racing writer loses on P2002 and retries into the winner's episode.

### 1.2 Producer convergence (`1e7f9a0`)

All **15 production write sites across 9 files** flow through `recordSyncIssue` → the lifecycle authority. No production writer creates or mutates `SyncIssue`/`SyncIssueOccurrence` directly; a structural guard enforces it.

Identity scope generalized to `PLAID_ITEM | FINANCIAL_ACCOUNT | WALLET | LEGACY_UNSCOPED`, type-prefixed so the same literal id cannot collide across scopes. **No version bump** — a Plaid item still serializes bare, so v1 keys are byte-identical and live episodes kept converging.

Correlation is a **lookup, never an assumption**: `runId` is `RefreshExecution.runId` (not `.id`), and `syncTransactionsForItem` mints its own when no caller threads one. The authority resolves it through the row seam and stores the FK only when an execution exists. Null is honest and common.

### 1.3 Operation-key identity doctrine (`786e230`)

Identity reads a **registered operation key**, not the raw `detail.stage` a producer types. Thirteen keys, all self-mapping, so nothing moved. An empty alias table gives the first rename a safe home. Unknown stages become `unregistered:<stage>` — namespaced, never collapsed.

**No new schema field**, deliberately: the resolved identity is already persisted inside `incidentKey`.

### 1.4 Typed persistence taxonomy (`b08d992`)

`UPSERT_ERROR` spanned ten operations. Four typed kinds replace it at eight physical sites, split by **operator remediation**:

| Kind | Domain | Severity | Operations | Resolver |
|---|---|---|---|---|
| `TRANSACTION_PERSISTENCE_FAILED` | transactions | **critical** | 1 | **yes** |
| `INVESTMENT_DATA_PERSISTENCE_FAILED` | investments | error | 5 | none |
| `IMPORT_ROLLBACK_FAILED` | imports | error | 1 | none |
| `WALLET_SYNC_FAILED` | wallet | error | 3 | none |

`UPSERT_ERROR` is retained; legacy rows keep the kind they were recorded under.

Untouched on purpose: `MISSING_ACCOUNT` (a different failure that happens to share a stage) and `PagePersistenceFailure` inside `syncTransactions` (cursor-safety accounting, not an incident classification).

### 1.5 Identity continuity guarantee

The guarantee everything else rests on, proven at runtime:

```
active legacy UPSERT_ERROR episode
+ new typed occurrence, same operation
→ ONE episode · same incidentKey · two occurrences
→ no resolution · no supersession · no recurrence generation
```

A taxonomy deployment describes a problem better. It does not end it.

### 1.6 Remaining transaction safety — OPS-2D-TX-1 (not ours)

Another session owns transaction-safety repair for the incident write path, adding `$transaction` to `IncidentClient` so a caller's transaction client fails to type-check at incident call sites.

**It modifies `lib/platform/incidents/lifecycle.ts` and `lib/plaid/syncIssues.ts` — the same files 5B-2 will touch.** Treat it as a hard dependency: land TX-1 first, then rebase. Do not absorb it.

---

## 2. OPS-2D-5B-2 — Incident Resolver Convergence

### Purpose

Three of the four typed conditions have no resolver and therefore stay active indefinitely. Give them recovery transitions **where recovery evidence genuinely exists** — and leave them active where it does not.

### Doctrine

Resolution is a **state transition backed by evidence**, never disappearance from a query. The matching rule is the substance: a success may resolve an incident only if it matches the semantic scope of the failure.

The existing resolver is the model. It resolves cursor-blocking transaction conditions because a later successful sync **proves** the held page replayed and every row persisted. A pre-cursor-safety failure has no such proof — its cursor already advanced — so it must never auto-resolve.

**Forbidden generalizations**, each of which fabricates recovery:

```
a later run succeeded          → resolve everything on this item
provider health became ACTIVE  → resolve everything on this connection
an unrelated stage succeeded   → resolve this one
time passed                    → resolve
```

Events (`INSTRUMENT_IDENTITY_CONFLICT`, `BALANCE_TX_MISMATCH`, `REMOVED_TOMBSTONE`) are terminal and can never be resolved.

### Scope

- For each of the three resolver-missing condition types, determine whether a **provable** matching success exists in current code.
- Where it does: implement the transition through the existing resolution authority, reusing `AUTOMATIC_RECOVERY` if the evidence is of the same character.
- Where it does not: **document the gap and leave the condition active.** That is a valid outcome for this slice.
- A new resolution kind requires a real producer. No kind without one.

### Non-goals

Manual operator resolution · acknowledgements · a generalized resolver framework · remediation workflows · notification or escalation · touching the existing cursor-blocking resolver.

### Dependencies

**OPS-2D-TX-1 must land first** (§1.6). Ideally also *after* the UI has run in production (§5) — resolver design is much better informed by seeing which incidents actually accumulate.

### Expected runtime proofs

Disposable database, no persistent dev records:

1. matching success resolves **only** the correct condition;
2. unrelated success on the same scope resolves nothing;
3. a new execution merely starting resolves nothing;
4. events remain untouched;
5. a resolver-missing condition stays active after an unrelated success;
6. resolution records `resolvedAt`, kind, and the resolving execution FK — or an honest null;
7. recurrence after resolution creates a new generation with `previousIncidentId`.

### Risks

- **Over-generalization.** The tempting rule ("a later successful run") is wrong for every case except the one already implemented.
- **False recovery is worse than no recovery.** A resolved incident that still represents missing financial data is the failure mode this whole initiative exists to prevent.
- **Merge risk with TX-1** on the shared lifecycle files.

### Acceptance criteria

- Every condition type is classified **resolver-backed** or **resolver-missing**, with evidence.
- No resolution kind exists without a producer.
- All seven runtime proofs pass on a disposable database.
- The cursor-blocking resolver's behaviour is unchanged.
- Resolver-missing types are *visibly* active, not quietly hidden.

---

## 3. OPS-2D-5C — Operator Labels and Guidance

### Purpose

Give each incident type wording an operator can act on, and wording a customer can safely see — from one authority.

### Intent captured

**Canonical operator wording.** A short label plus a description naming the failed *financial operation*, not the ORM mechanics. `describeSyncIssue` is the existing seam.

**Customer-safe wording.** Abstracted, actionable only when action genuinely helps. The asymmetry already in `sync-issue-semantics.ts` is the precedent: operator classification errs **loud** (an unclassifiable row shouts), member visibility errs **quiet** (it requires an affirmative signal). Preserve that.

**Diagnostic wording.** Raw `detail` is diagnostic storage, not a presentation DTO. It stays operator-only and must not leak into customer surfaces.

**Contextual guidance.** "What should I do about this?" per type — plausible for the four typed kinds, since they were split by remediation in the first place.

### Why labels remain derived

A stored label drifts from the rule that produced it the moment the rule changes, and every historical row would need a backfill. This mirrors `balance-semantics.ts`: we do not store `amountOwed`, we derive it.

### Why labels are not identity

Identity must survive rewording. A label change is a description change; if wording were in the key, improving a sentence would orphan every active episode. This is exactly what 5B-0 separated — **do not undo it in 5C.**

### Non-goals

Institution/account enrichment (its own concern) · UI layout · notification copy.

---

## 4. OPS-2D-5D — Incident UI

The existing **Preview → Browser → Detail** doctrine applies.

### Phase 1 — Preview

Active incident count, severity distribution, affected institutions. Small, and the point is that it is small: it is how we learn whether the model is legible before building on it.

### Phase 2 — Browser

Filterable list: active/resolved, severity, institution, category, age. **Active views must never show resolved incidents as active.**

### Phase 3 — Detail

Occurrence timeline with navigation `incident → RefreshExecution → stage → ProviderCall`, using the direct FKs from 5A-1. Missing correlation must render **honestly** — "correlation unavailable", never "no execution failed". Absence of a link is not evidence that nothing ran.

### Philosophy — preview first

**Do not build the complete browser before operators have used Preview.** A filterable list of the wrong dimensions is expensive to unwind, and a Preview answers the question a browser assumes: *is this model legible to the person on call?*

### Principal-engineering recommendation

**UI should become the primary consumer before further semantic expansion.**

The incident model now has considerable machinery and exactly one shipped read surface. The DF-2 refresh ledger already taught this lesson the expensive way: it shipped **write-only**, and the gap was invisible for months precisely because every producer worked correctly in isolation. More semantics without a consumer repeats that.

Concretely: a Preview will reveal within days whether `INVESTMENT_DATA_PERSISTENCE_FAILED` accumulates unbounded — which is the single most useful input to 5B-2's design, and cannot be obtained by reasoning.

---

## 5. UI sequencing

```
OPS-2D-TX-1  (transaction safety — other session)
        ↓
Canonical incident UI  (5D Preview — first real consumer)
        ↓
Observe production behaviour
        ↓
Resume 5B-2 only when real evidence exists
```

**This ordering reflects current architectural guidance and supersedes any older roadmap ordering**, including the implied 5B-2 → 5C → 5D sequence. 5C may land alongside 5D Preview, since a Preview needs labels; it should not land alone.

---

## 6. Architectural doctrine

Established across OPS-2D-5 and binding on future work.

### Identity

Identity is `v1::provider::scope::domain::operationKey` — **stable, and never derived from anything mutable.** It contains no issue kind, no wording, no error text, no timestamp, no execution id. Changing identity is a deliberate act requiring a key version and a compatibility decision; it is never a side effect of improving a description.

### Taxonomy

Taxonomy is **descriptive**. It answers "what kind of problem is this?" and is expected to improve over time. Because it is absent from identity, it can improve freely. Split a public kind only when an operator's **decision, remediation, ownership, severity, customer impact, or escalation** differs — never because the file, function, or Prisma call differs.

### Lifecycle

`SyncIssue` is the episode; `SyncIssueOccurrence` is the manifestation. The lifecycle authority owns every transition. Producers submit typed facts and decide nothing: they do not query active incidents, build keys, create occurrences, or set lifecycle fields.

The invariant is **not** universal, and stating it loosely is how it gets broken:

```
CONDITION active     resolved=false · resolvedAt=null · kind=null
CONDITION recovered  resolved=true  · resolvedAt SET  · kind SET
EVENT                resolved=true  · resolvedAt=null · kind=null · incidentKey=null
```

`resolved = true` means "recovered, here is when" on a condition and "terminal" on an event. Both are correct. Making them uniform would turn forensic evidence into a recovery that never happened.

### Semantic authority

`lib/platform/sync-issue-semantics.ts` is the **sole** authority for domain, severity, nature, semantic state and wording. It derives; it does not persist. There is no second classifier, and consumers do not build one.

### OperationKey

The stable machine identity of a failed operation, resolved through a central registry. Producers cannot invent keys. Aliases let a stage be reworded without moving identity. Unknown stages are namespaced, never collapsed — collapsing merges unrelated failures into one global episode.

### Stage

Diagnostic context. Producers write it freely; it carries no identity of its own and no operator contract. Its meaning for identity is decided entirely by the registry.

### Issue kind

The public semantic classification. Descriptive, additive, and **absent from identity**. Legacy kinds are retained — history records what was observed, not what we would call it today.

### Occurrence

One observed manifestation, carrying the direct execution FK **when one exists**. Null correlation is honest and common, and is rendered as unavailable rather than as absence of failure. `detail.runId` is retained for diagnostics and is **not** the relationship authority.

### Resolution

A state transition backed by evidence that **matches the semantic scope** of the failure. Only `AUTOMATIC_RECOVERY` exists, tied to cursor-blocking recovery. A kind without a producer is not a kind. Resolution is never archival deletion.

### Recurrence

A matching failure while active appends an occurrence and advances `lastOccurredAt`. A matching failure **after** resolution creates a **new episode** linked by `previousIncidentId`. Resolved episodes are immutable — a years-old row is never reopened, and prior recovery history is never erased.

---

## 7. Deferred / Not Yet Accepted

> Discussed but **not approved**. Listed so they are not lost and not mistaken for scope.

| Idea | Note |
|---|---|
| **Replay-kind cleanup** | `REPLAY_ATTEMPTED/RECOVERED/FAILED` are stale reserved values for v2.5 auto-recovery that never shipped. Recovery is now episode lifecycle. Recommend deprecate-then-remove in a later migration; **do not remove without an owner**. |
| **Richer operator guidance** | Beyond a label — runbook links, remediation steps. Wants real operator use first. |
| **Generalized resolver framework** | A declarative recovery-matching engine. Premature: we have exactly one proven resolver, and one instance is not a pattern. |
| **Manual acknowledgements** | "Seen, not fixed." Would need a lifecycle state, and no producer requires it yet. |
| **Automated remediation workflows** | Operator-triggered repair actions. Requires CONTROL capability work and admission integration. |
| **Incident analytics** | MTTR, recurrence rates, per-institution reliability. Needs meaningful history first. |
| **Notification policy** | Who gets told, when, and how loudly. |
| **Escalation policy** | Severity-driven paging. Depends on notification policy. |

---

## 8. Design principles

Governing all future incident work.

1. **Observation never controls the observed operation.** Telemetry failure must never become a second, louder failure for the caller.
2. **Identity is stable.** It survives renames, taxonomy changes, and rewording. If it does not, it is not identity.
3. **Taxonomy is descriptive.** It may improve freely precisely because it is not identity.
4. **Meaning is derived.** A stored opinion drifts from the rule that produced it.
5. **Lifecycle owns truth.** Producers submit facts and decide nothing.
6. **Consumers never reconstruct semantics.** A component that re-derives "is this active?" is a second authority.
7. **Absence is a state of its own.** Missing correlation, never observed, real zero and unavailable are four different things and must never collapse.
8. **Runtime evidence beats speculative abstraction.** Build the resolver you can prove, not the framework you can imagine.
9. **UI should validate architecture before expanding architecture.** An authority without a consumer is unfinished, however well-tested.
10. **A guard must assert its intent, not a proxy for it.** Guards pinning literals rather than doctrine blocked legitimate work **ten times** across this initiative. Every one was a guard that was *right* about the rule and *wrong* about how it checked it.

---

*Written 2026-07-27 against `b08d992`. Supersedes ordering implied by slice numbering. No code, schema, tests or commits originate from this document.*
