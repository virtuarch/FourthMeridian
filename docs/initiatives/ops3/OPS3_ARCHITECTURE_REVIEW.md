# OPS-3 — Architecture Review (Second Pass)

**Date:** 2026-07-07 · **Baseline under review:** `docs/initiatives/ops3/OPS3_NOTIFICATIONS_PREFERENCES_INVESTIGATION.md` (same day)
**Nature:** ARCHITECTURE REVIEW ONLY — no implementation, no code, no schema, no STATUS update. The baseline's conclusions are treated as challengeable, not final.
**New evidence consulted beyond the baseline:** `docs/architecture/PORTFOLIO_MASTER_PLAN_2026-07-06.md` (Rev B — ratified into the STATUS runway: "OPS-1 S0/S1 → PO1 Event Grammar & Telemetry → Platform Facts → Platform Rollups → Platform Operations"), `docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md` (PO1, Parts 1–10), `lib/widget-registry.ts`, `lib/perspective-engine/`, STATUS.md §§1–4.

**Verdict in one paragraph:** the baseline is structurally right — the fact/notification/delivery separation, the chokepoint invariant, and the slice order all survive review. It has two material gaps that would become refactors if implemented as written: it coins its notification vocabulary in isolation from the already-ratified PO1 P0 Event Grammar & Registry (recreating the exact "fourth vocabulary" defect class Rev B documented), and it omits deduplication — the one capability whose retrofit onto a populated table is genuinely expensive. It also proposes two new raw Vercel crons into a cron budget the PlatOps investigation calls "effectively exhausted," when the ratified answer to that constraint (the PF1 dispatcher) is already on the runway. Corrections are ordered by cost-of-delay in §8.

---

## 1. Platform architecture — do five pillars hold?

### 1.1 The proposed decomposition against the tree

The five pillars are not an invention; four of them already exist as code centers of gravity:

| Proposed pillar | What the tree already shows |
|---|---|
| **Identity** (users, auth, sessions, lifecycle) | `lib/auth.ts`, `lib/sessions.ts` / `UserSession`, `lib/recovery-codes.ts`, `lib/totp.ts`, the whole of OPS-2 (deactivation, deletion, email change, export). Coherent and real. |
| **Spaces** (membership, permissions, sharing, collaboration) | `lib/spaces/policy.ts` (centralized authorization), `SpaceMember` / `SpaceInvite`, `SpaceAccountLink`, visibility predicates (`lib/ai/visibility.ts` + KD-1/15/19). Coherent and real. |
| **Financial Platform** (accounts, transactions, facts, perspectives) | The finished "data plane": dual account models converging, `classifyFlow`, MC1's FX archive + snapshots, `SyncIssue` — and the *names already match*: `lib/perspective-engine/`, `lib/perspectives.ts`, and the master plan's own doctrine "facts outlive features" (Part 8.2). The pillar's internal vocabulary (Facts, Perspectives) is the repo's vocabulary. |
| **Operations** (notifications, jobs, platform ops, administration) | OPS-x + PO1–PO4 tracks. Real — but see the boundary problem in §1.2. |
| **Ambient Intelligence** (AI, agents, recommendations, brief, automation) | `AiAgent`/`AiAdvice`, validator, the AI ladder ("honest answers → coherent conversations → earned ambience → autonomy," Part 8.4). Coherent and real. |

So: **sound as a conceptual map.** Two structural objections and one scope gap before it becomes doctrine.

### 1.2 Objection 1 — the Operations pillar as drawn merges two trust domains

The master plan's five-year invariant #1 is explicit: *"no privileged path into customer tenancy… every ops capability must pass the 'structurally incapable of reading product content' test."* The PlatOps roadmap builds its entire console (Part 6) on that rule — the Users panel is "expressly not their finances."

But **notifications read product content by design.** `GOAL_RISK`, `UNUSUAL_SPENDING`, `DAILY_BRIEF_READY` are tenant-scoped, finance-bearing messages. Putting Notifications in the same pillar as Platform Operations quietly co-locates a tenant-blind observability system with a tenant-embedded messaging system. That is how boundary erosion starts — not by decision, but by a shared module namespace and a shared team habit.

**Recommendation:** split the pillar's interior explicitly:

- **Product Operations** — tenant-scoped, user-facing: notifications, user-visible background jobs (digests, cleanup), transactional email. Reads product data on the user's behalf; lives under the same visibility predicates as any product surface.
- **Platform Operations** — tenant-blind: telemetry, job ledger, rollups, ops console, administration. Structurally incapable of reading product content (PO doctrine).

Same pillar on the org chart if desired, but the trust boundary must be drawn *inside* it, in writing, now — because OPS-3 is the first initiative that would otherwise straddle it silently. (Concretely: OPS-5 dashboards read `NotificationDelivery` *metadata* — counts, statuses, providers — never `Notification.title/body`. The PlatOps "Emails" panel already models this: "per-user delivery history (metadata only).")

### 1.3 Objection 2 — pillars are a taxonomy, not an operating model; don't replace the one that works

The repo already runs on a three-layer operating model that is demonstrably working: **lanes** (data plane / operational plane / market plane — Part 1.3), **tracks** (`OPS-x`, `AI-x`, `MC-x`, `PO1–PO4`… — STATUS §4's freeze-not-renumber namespace), and **initiatives/slices** (MC1 doctrine). Pillars answer "where does this capability live conceptually?"; lanes answer "which lane is allowed to move the calendar?" — the master plan's closing sentence. Those are different questions. Replacing lanes/tracks with pillars would discard a proven sequencing tool for an org chart.

**Recommendation:** adopt the pillar map as the *architecture documentation* layer (a page in `docs/architecture/` naming pillar → owned models → owned `lib/` seams → track prefixes), and keep lanes/tracks/initiatives as the *execution* layer. Pillars should constrain module boundaries and schema ownership (one pillar = one schema owner per domain, which STATUS's "never overlap" rules already enforce initiative-by-initiative), not scheduling.

### 1.4 Scope gap — the taxonomy is missing a lane and an interior

- **Market/Growth is absent.** The master plan's third lane (landing, beta mechanics, invites, eventually billing) is real work with real code (L-2/L-3) and — per Part 8.3 — billing will one day force the Decimal migration. A pillar map that can't place "billing" will be reorganized the year revenue arrives. Add a sixth pillar (call it **Market** or **Growth**) or explicitly declare it out of platform scope; don't leave it implicit.
- **Experience/Interface is unplaced.** The design system (Atlas, `lib/widget-registry.ts`, UI-x track, `components/ui`) is a genuine long-lived investment that belongs to no proposed pillar. Acceptable to leave horizontal, but say so.
- **Minor naming challenge:** "Financial Platform" as a pillar name invites confusion with "the platform" writ large. The repo's own language — the **data plane**, or "Financial Facts & Perspectives" — is more precise.

**Does it scale over several years?** With the §1.2 split and §1.4 additions, yes — each pillar maps to a stable set of models and seams, and the master plan's five-year projections (Part 8) each land cleanly in exactly one pillar. Where OPS-3 sits: the *pipeline* is Product Operations; the *producers* stay in their own pillars; the *vocabulary* is platform-wide (PO1 P0). That factoring is what keeps the pillar boundaries honest.

---

## 2. Notification architecture — the three-way separation, re-derived

The baseline separates immutable platform facts (`AuditLog`), user-facing notifications (`Notification`), and delivery attempts (`NotificationDelivery`). Re-derived from first principles, the split holds because the three objects differ on **every** axis that matters, not just one:

| Axis | Fact (AuditLog) | Notification | Delivery attempt |
|---|---|---|---|
| Answers | what happened | does this user need a ping | did we reach them |
| Mutability | append-only, never | timestamps set once each | status/attempts progress |
| Retention | indefinite (forensics → future SOC 2 evidence, Part 8.2) | short (30/90-day aging) | medium (ops analytics window) |
| On user deletion | `SetNull` — survives anonymized | `Cascade` — it's their inbox | cascades with notification |
| Cardinality | 1 per fact | N per fact (one per recipient) | M per notification (one per channel/attempt) |
| Reader | user (security history), operator (audit), compliance | user | operator (OPS-5), retry machinery (OPS-4) |

Any merge forces one row to serve two masters on at least three axes. The specific alternatives, evaluated honestly:

- **Fold delivery into Notification** (columns: `emailStatus`, `deliveredAt`) — the tempting "simplicity" cut, and defensible while email is the only channel. Rejected anyway, for a reason stronger than channel-count: an update-in-place delivery column **destroys attempt history**, and attempt history is precisely the raw material OPS-4 (retries) and OPS-5 (provider health) are already scheduled to consume. The repo's uniform idiom is that operational truth is append-only (`AuditLog`, `FxRate`, `SyncIssue`, PF1's job-run ledger — "every scheduled unit of work leaves a corpse"). Delivery attempts are the same species of corpse. §J's warning ("don't conflate the bell-icon record with the email send log — different retention and PII handling") was correct before this review and remains correct after it.
- **Fold notification into the fact** (render the bell from `AuditLog` the way security history does) — works for exactly one surface (the user's own security log) and fails at the first multi-recipient event: `MemberRemoved` is *one* fact but must ping the remover's audit trail and the removed user's bell with different copy and independent read state. Recipient-cardinality alone kills this.
- **Event-sourced notifications** (a bus, projections) — EV-1's header explicitly declined event sourcing ("no event bus, no queue, no async fan-out"), and nothing OPS-3 needs requires replay. Rejected; revisit only if a genuine multi-consumer stream need appears (none is on the five-year projection).
- **Outbox pattern** — worth naming because the baseline's design *already converges on it*: a `NotificationDelivery` row in `status: "error"` with an `attempts` counter is an outbox entry the moment OPS-4 gives it a dispatcher. No change needed; this is a point in favor of the split — it becomes the retry substrate without a new table.

**Two refinements the review adds:**

1. **The in-app asymmetry is a documented wart, not a flaw.** No delivery row for in-app means OPS-5 queries in-app reach from `Notification` and external reach from `NotificationDelivery`. Correct trade (the common bell-only case stays one insert), but the S0 module header must state it, or the first OPS-5 dashboard will double-count or zero-count in-app.
2. **`auditLogId` is the weaker of the two joins the platform will want.** A row-id pointer into `AuditLog` is store-local and survives only as long as both rows do. The join OPS-5/POR1 will actually use is the **canonical event identity** from PO1 P0 (§3) — "which fact class, which occurrence" — which also joins telemetry and the job ledger. Keep `auditLogId` (cheap, useful for the security-history cross-link), but the durable lineage field is `sourceEventId`/`dedupeKey` (§4).

**Verdict: validated.** The three-way separation is the correct long-term architecture; no better alternative exists at any horizon visible from the current roadmap.

---

## 3. Notification vocabulary — the baseline is right about strings, wrong about isolation

The baseline chose `category`/`type` as strings validated by a config module, rejecting Prisma enums. The enum rejection is correct and needs no relitigation (a migration per notification type is disqualifying; `AuditLog.action` set the precedent).

But the baseline designed `lib/notifications/categories.ts` as a **self-standing vocabulary** — and the portfolio has already ruled that pattern a defect. Master Plan Rev B, Finding 2: the repo *already* carries three drifted event grammars (`audit-actions`' mixed tenses, EV-1's PascalCase, `SyncIssueKind`'s noun phrases), duplicate semantics are already live (`GOAL_CREATED`/`GoalCreated`), and PO1 P0 ("Event Grammar & Registry") was created — and ratified into the STATUS runway *ahead of this initiative* — precisely so that "every subsequently-born event is canonical from its first emission." A notification type list coined independently would be the **fifth grammar**, born one initiative after the ruling that forbade the fourth.

**Recommendation — a single notification registry, PO1 P0-aligned.** The user's instinct ("touch one place when introducing a new notification type") is exactly right, and the repo already has the strongest possible precedent for it: `lib/widget-registry.ts` — *"Central source of truth for every section key the dashboard runtime knows about… Adding a new section type = add one entry here; no switch/case edits. Placeholder entries keep the registry honest."* Apply that contract verbatim:

```
lib/notifications/registry.ts   (replaces the baseline's categories.ts + scattered policy)

One entry per notification type. Shape (illustrative, not code):
  id              canonical event id per PO1 P0 grammar — DOMAIN_OBJECT_EVENT,
                  past-tense SCREAMING_SNAKE ("PASSWORD_CHANGED", "SYNC_FAILED"),
                  registered in / reconciled with the PO1 P0 event registry —
                  NOT coined locally
  category        ACCOUNT_SECURITY | SPACES | FINANCIAL | AI | PLATFORM
  priority        LOW | NORMAL | HIGH | CRITICAL
  channels        default-enabled channels
  locked          user cannot mute (ACCOUNT_SECURITY)
  retention       { autoArchiveDays, deleteDays } — per-type override of the defaults
  digestable      may fold into the digest email (needed by S6; deciding it per-type
                  at S6 time is a retrofit — declare it at birth)
  dedupe          strategy + key template (§4): none | suppress | refresh
  icon            iconography key (lucide name) — UI stays switch-free
  render          title/body template refs (the copy single-source §12 of the
                  baseline asked for)
  ai              reserved metadata surface for v2.6b (e.g. explainable: bool,
                  agentAttributable: bool) — added when the first agent ships,
                  NOT stubbed now (no-placeholder rule; the registry shape is
                  the reservation)
```

Typed as a `const` object with a `satisfies` contract; `NotificationTypeId = keyof typeof REGISTRY` gives compile-time exhaustiveness everywhere (chokepoint, preferences UI, digest job) with zero runtime cost — strictly stronger typing than the baseline's constants-plus-map, and *one* definition site instead of three (constants, policy map, labels).

Two consequences worth stating:

- **The DB stays strings; the registry is the gate.** `Notification.type` is validated against the registry at the chokepoint (unknown type = throw at the producer, the `emitDomainEvent` "no AuditAction mapped" idiom). Adding a type = one registry entry, no migration — the goal achieved.
- **Source-of-record discipline (Rev B rule 4) applies:** where a notification type corresponds to an existing audit action or domain event (most of §2 of the baseline), the registry id **cites** that canonical id rather than coining a synonym. Where the grammar conflicts (legacy `SPACE_LEAVE` vs canonical `MEMBER_LEFT`), the registry entry carries the canonical id and maps to the legacy audit string — the grandfather-never-rename rule handles history.
- **Sequencing note:** the runway already places PO1 P0 before OPS-3 (STATUS: "OPS-1 S0/S1 → PO1 → …"). If OPS-3 somehow starts first, its registry ids must still follow the P0 grammar and be reconciled into the P0 registry when it lands — the grammar is published in Rev B R.2 and costs nothing to follow early.

**Verdict on the baseline: overturned in part.** Strings-over-enums stands; the isolated `categories.ts` policy map is superseded by a single typed registry aligned with PO1 P0. This is the review's most important structural correction.

---

## 4. Deduplication — the baseline's one genuine omission

The baseline never mentions dedupe. The need is not speculative; it is visible in the tree today:

- **`SYNC_FAILED` re-fires daily by construction.** `sync-banks` runs on a daily cron; a broken PlaidItem stays broken for days. Without dedupe, wave-3 producers manufacture an identical notification every morning — the noise catastrophe §12 of the baseline itself names as *the* product risk, built in by its own design.
- **The multi-producer future is the roadmap, not a hypothetical.** AI agents (v2.6b), the PF1 dispatcher re-running jobs, OPS-4 retries, and EV-1 handlers can all plausibly observe the same underlying fact. The master plan's answer to duplicate *vocabulary* was source-of-record assignment; the runtime analogue for duplicate *notifications* is a dedupe key.
- **The repo already solves this class of problem with unique constraints, twice:** `DuplicateAccountCandidate` (kept as "a true unique constraint, not relaxed to append-only" — the schema comment says why) and `RateLimit @@unique([key, windowStart])`. Idempotency-by-constraint is the house style.

**Why this must be reserved now and not added later** — the review's sharpest cost asymmetry: every other deferred capability in the baseline is an *additive nullable column* later (cheap, mechanical). A dedupe key is a **unique constraint**, and retrofitting a unique constraint onto a populated table requires a data-dedupe backfill migration with collision-resolution decisions — real migration pain, on the platform's highest-write-volume user-facing table. Reserve the constraint at birth, when the table is empty and the constraint is free.

**Recommended shape (proposal only):**

```prisma
// on Notification
dedupeKey     String?    // producer-supplied identity of the underlying condition,
                         // template owned by the registry entry (§3), e.g.
                         // "SYNC_FAILED:item:<plaidItemId>:open"
sourceEventId String?    // canonical event-instance lineage (PO1 P0 world) —
                         // which occurrence produced this; joins telemetry,
                         // job ledger, and audit without store-local row ids

@@unique([userId, dedupeKey])   // Postgres: NULLs are distinct, so notifications
                                // without a key (the majority) are unconstrained
```

With **registry-owned semantics** per type: `none` (default — most types are naturally unique), `suppress` (insert is a no-op while an un-archived row with the same key exists — the `SYNC_FAILED` case; the key's `:open` suffix retires when the condition resolves, letting a *new* outage notify again), `refresh` (bump the existing row to unread/top — "3 new duplicates detected" collapse). Only `suppress` needs to exist in OPS-3; the other strategies are registry vocabulary.

On the other proposed fields: **`fingerprint`** is `dedupeKey` under another name — one concept, one field. **`correlationId`** (request-scoped tracing) is PO1 telemetry's concern, not the notification store's; don't duplicate it here. **`sourceId`** (which producer) belongs in `metadata` until a query needs it as a column — that one *is* a cheap later addition.

**Verdict: reserve `dedupeKey` + unique constraint and `sourceEventId` in the S1 migration.** This is the review's second material correction. It is not architectural gold-plating; it is the difference between a constraint that is free today and a backfill migration in a year.

---

## 5. Ambient Intelligence — the invariant, stress-tested

The philosophy under evaluation: *no subsystem — not even AI — sends notifications directly; everything flows Producer → `createNotification()` → preference resolution → delivery adapters.*

**Preserve it.** It is the same invariant that already governs email (one chokepoint, SDK in one file), rate limiting, and Space authorization (`lib/spaces/policy.ts`) — the repo's most consistently rewarded pattern. For AI specifically it is *more* than hygiene: the AI ladder's brand promise (Part 8.4: "the products that survive the agent-hype cycle will be the ones that can prove restraint") requires that every agent utterance be **attributable, preference-gated, and observable**. The chokepoint is where all three are enforced; an AI bypass path is an unprovable-restraint path. And layer the chokepoints: an agent that wants to email a user goes AI → `createNotification()` → email adapter → `sendEmail()` — never straight to `sendEmail()`.

**Are there legitimate bypasses? Yes — four, and naming them precisely is what keeps the invariant enforceable** (an invariant with unnamed exceptions dies by accretion):

1. **Ceremony, not awareness.** Password-reset links, email-verification links, email-change confirmations, invite-acceptance links: these are *steps in a flow the user is actively performing*, not pings about state. They are correctly `sendEmail()`-direct today and must stay so — a "reset your password" email must not be muteable, archivable, or digest-foldable, and putting it through preference resolution would be a security bug. **The test: if suppressing the message breaks a flow the user initiated, it is ceremony and bypasses; if suppressing it merely leaves the user less informed, it is awareness and must go through the chokepoint.** This test should be written into the S0 module header.
2. **The recipient no longer exists.** The post-purge "your account has been deleted" email (OPS-2 S7c) has no `User` row to notify. Email-direct by necessity.
3. **Operator alerting is a different trust domain.** PlatOps Phase 5 alerts ("job didn't run," "provider degraded") target the *operator*, are tenant-blind, and belong to the PO track's own delivery path — per §1.2, routing them through the user-notification system would cross the Product/Platform Operations boundary in the wrong direction.
4. **Interactive responses are not notifications.** AI chat replies, and the Daily Brief rendered on-demand when the user opens it, are request/response surfaces. The notification is "your brief is ready," never the brief itself.

Everything else — including every future automation, every agent, every background job — goes through the chokepoint, no exceptions. Worth adding the grep-grade enforcement the repo already uses for the email SDK: `db.notification.create` appears in exactly one file (`lib/notifications/`), the way the Resend import is single-sited.

**Verdict: validated, strengthened with a decidable ceremony/awareness test and a named exception list.**

---

## 6. OPS-5 compatibility — several initiatives ahead

Checked against what PO1/POR1/POS1 actually plan to build (not a guess at "dashboards"): telemetry seam → job-run ledger → frozen daily rollups with one-definition-site metrics → console panels including an "Emails: volume/outcome by template, bounce/failure triage, per-user delivery history (metadata only)" panel.

| Future need | Supported without redesign? |
|---|---|
| Delivery analytics | ✅ `NotificationDelivery` rows are the raws; `[channel, status, createdAt]` index is the scan path. POR1's doctrine ("rollups before raws = vanity metrics") is satisfied — OPS-3 ships raws, POR1 freezes rollups. Never pre-build rollup tables in OPS-3. |
| Notification health | ✅ volume/category mix/unread-aging are aggregate queries over `Notification` (`[category, createdAt]`). §2's in-app asymmetry must be documented for correct counts. |
| Provider health | ✅ `provider` + `providerMessageId` + `status`/`error` come verbatim from `EmailResult`. Bounce data arrives later via a Resend-webhook consumer — additive. |
| Retry metrics | ✅ `attempts` + error rows are exactly the outbox-shaped substrate OPS-4 needs (§2). |
| Engagement | ◐ Email opens/clicks: reserved columns + future webhook consumer — fine. In-app: `readAt` yes; **click-through is not instrumented** and the review recommends *not* adding `clickedAt` to `Notification` now — no writer exists, and it is a plain nullable column later (the cheap kind of retrofit, unlike §4's constraint). Accepted, consciously. |
| Platform rollups / dashboards | ✅ with one addition: the lineage fields (§4 `sourceEventId`, §3 canonical ids) are what let POR1 join notification facts to telemetry and the job ledger. Without them, cross-store joins fall back to timestamps — the redesign risk the question asks about. With them, none. |
| PO boundary | ✅ if §1.2 is honored: OPS-5 reads delivery *metadata*, never `title`/`body`. State it in the S1 schema comments so the boundary is in the schema file, not in memory. |

**What to change now while it's cheap:** (a) the §4 lineage/dedupe fields; (b) the §1.2 metadata-only doctrine written into schema comments; (c) one line in the S0 header telling PO1's Phase 1 that `createNotification()` is a **telemetry chokepoint candidate** — when the telemetry seam lands, it wraps this one function and observability is total. Nothing else. Everything heavier belongs to POR1/POS1 by the portfolio's own sequencing.

---

## 7. Simplicity audit — "the smallest architecture that can grow forever"

### 7.1 Over-engineered for today

- **Two new raw crons (S6) — the review's third material correction.** PlatOps 1.4 calls the Vercel cron budget "effectively exhausted" and rules that every future scheduled need "must either consolidate into a single dispatcher cron or assume a paid plan"; PF1 Slice 2.2 (the dispatcher, already on the ratified runway as "Platform Facts"-adjacent) exists to solve exactly this — `vercel.json` shrinks to one entry. (`vercel.json` now carries **3** crons — process-deletions landed after that audit — so either the plan changed or the ceiling was misread; either way the constraint is contested and the dispatcher remains the ratified answer.) **OPS-3 should not spend cron slots.** Revised S6: if PF1's dispatcher exists, register cleanup/digests as dispatcher jobs; if not, fold cleanup into an existing daily cron's window (the `process-deletions` pattern of bounded best-effort work) and let digests *wait for the dispatcher* — a digest with zero users is not worth a plan upgrade or an architectural exception.
- **`openedAt`/`clickedAt` reserved columns (S1).** Reserved with no writer, contradicting the no-placeholder discipline the baseline itself invokes. Unlike `dedupeKey` (a constraint — expensive later), these are nullable columns — free later. **Cut from the S1 migration; add with the Resend-webhook consumer.** The general principle this review proposes: *reserve constraints at birth; defer columns until a writer exists.*
- **The dismissed/archived hand-wringing.** The baseline spends an open decision on it; v1 archive-only is obviously right and `dismissedAt` is a cheap later column. Close the decision, stop carrying it.
- **Weekly digest.** A frequency enum value, not a capability. Fine as vocabulary; flagged only so nobody builds a second job for it.

### 7.2 Under-designed — will force refactors if built as written

- **No deduplication** (§4). The one omission with a genuinely expensive retrofit. Highest-priority correction.
- **Vocabulary coined in isolation from PO1 P0** (§3). Grammar drift is a documented, already-observed defect class here, and the fix is free if done at birth: follow the published grammar, cite canonical ids.
- **No collapse semantics for bursty producers.** One sync run can detect N duplicates; one import can complete with M errors. Without the registry's `refresh`/count strategy (§4) — or at minimum per-*run* rather than per-*finding* producer granularity — wave 3 ships spam. The baseline's `SYNC_COMPLETED`-off-by-default instinct was treating a symptom of this missing layer.
- **`digestable` decided at S6.** Digest membership is a per-type property; deciding it when the digest job lands means re-opening every registry entry. Declare it at S0 (one boolean per entry, no behavior until S6).
- **Digest observability is undefined.** If the digest email doesn't itself flow through the chokepoint, OPS-5 loses digest delivery data and §5's invariant grows an unnamed exception. Resolve by doctrine now: *the digest is itself a notification* (its own registry entry, LOW/locked-off-bell or equivalent) whose email delivery writes `NotificationDelivery` rows like any other; folded items record `metadata.digestedIn`. One sentence today; an inconsistency audit later if unsaid.
- **Retention as global constants.** 30/90 works for the bell; it silently deletes `MAINTENANCE` (shelf-life = the window, fine) *and* AI recommendations (v2.6b may want longer memory-visible history). Per-type `retention` in the registry (§3) costs nothing and removes the future argument.

### 7.3 Explicitly examined and cleared

`NotificationDelivery` at beta scale (justified by §2 — it is the retry outbox and the OPS-5 raw store, and merging it back later is the expensive direction) · preferences default-by-absence (the smallest possible preference store) · quiet hours deferred to OPS-4 (delay-not-drop needs a mechanism that doesn't exist; correctly fenced) · no real-time push (nothing in the tree does server push; polling is honest) · EV-1-handler + inline dual producer paths (mirrors exactly how email landed; migrates with EV-1's own track).

---

## 8. Consolidated rulings

| # | Ruling | Baseline status |
|---|---|---|
| 1 | Fact / Notification / Delivery three-way split | **Validated** (§2) — strongest part of the baseline |
| 2 | Chokepoint invariant incl. AI; ceremony/awareness test + 4 named exceptions | **Validated & strengthened** (§5) |
| 3 | Single typed **notification registry**, PO1 P0-aligned ids, widget-registry contract ("one entry, no switch edits"), per-type retention/digestable/dedupe/icon metadata | **Overturns** the isolated `categories.ts` policy map (§3) |
| 4 | Reserve `dedupeKey` (+ `@@unique([userId, dedupeKey])`) and `sourceEventId` in the S1 migration; registry-owned dedupe strategies; suppress-while-open for `SYNC_FAILED`-class types | **Corrects an omission** (§4) |
| 5 | No new raw crons: dispatcher-or-fold; digests wait for PF1 if needed | **Overturns** S6's cron plan (§7.1) |
| 6 | Cut `openedAt`/`clickedAt` from S1 (defer to the webhook consumer). Principle: reserve constraints, defer columns | **Amends** S1 (§7.1) |
| 7 | Product Operations / Platform Operations trust split inside the Operations pillar; OPS-5 reads metadata only, stated in schema comments | **New** (§1.2, §6) |
| 8 | Pillars adopted as documentation taxonomy (+ Market lane, Experience noted); lanes/tracks/initiatives remain the operating model | **New** (§1.3–1.4) |
| 9 | Digest is itself a notification through the chokepoint; `digestable` declared at S0 | **New** (§7.2) |
| 10 | Slice order S0→S6 and the additive migration strategy | **Validated** with amendments 4/5/6 folded into S0/S1/S6 |

Net effect on scope: the corrections **shrink** the v1 build (two fewer reserved columns, zero-to-one new crons instead of two) while adding two cheap-now/expensive-later reservations (dedupe constraint, canonical ids) and one page of doctrine. That is the right direction under "the smallest architecture that can grow forever" — the baseline was smallest-*today* in a few places where it needed to be smallest-*forever*.

---

*Architecture review only — stop here. No implementation begun. Becomes actionable only by revising the OPS-3 investigation's S0/S1/S6 slices at implementation-planning time.*
