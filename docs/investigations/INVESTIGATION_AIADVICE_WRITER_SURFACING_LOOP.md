# Investigation — AiAdvice Writer & Surfacing Loop

**Status:** Investigation only. No implementation. Stop after checklist.
**Scope:** Design the smallest loop that turns already-computed AI insights into
persisted `AiAdvice` rows and surfaces them in Daily Brief / dashboard — without
building the full planner, notifications, or a background scheduler.

> Branch note: repo is currently on `feature/v2.5-spaces-completion`
> (`v2.4.5-102-gXXXXXXX`), not `feature/phase-2-architecture`. This investigation
> describes present-state code; confirm the target branch before any slice lands.

---

## 1. Current architecture

### 1.1 The model — `AiAdvice` (prisma/schema.prisma ~L1418)

```
model AiAdvice {
  id          String    @id @default(cuid())
  spaceId     String    @map("workspaceId")      // Space-scoped (userId removed)
  space       Space     @relation(..., onDelete: Cascade)
  agentId     String
  agent       AiAgent   @relation(..., onDelete: Cascade)
  summary     String                              // one-line headline
  adviceText  String    @db.Text                  // full markdown body
  riskLevel   RiskLevel                           // low | medium | high
  actionReady Boolean   @default(false)           // renamed from legacy playReady
  generatedAt DateTime  @default(now())
  createdAt   DateTime  @default(now())
  @@index([spaceId, generatedAt])
  @@index([agentId, generatedAt])
}
```

Key facts:
- **Scoping is Space-level, attributed to the Space's `AiAgent`** (not user). Both
  `Space.adviceHistory` and `AiAgent.adviceHistory` back-relations exist.
- **Append-only by design** — "one record per advice engine run", ordered by
  `generatedAt desc`. There is no `content hash`, no `dedupe key`, no
  `supersededAt`, no freshness/expiry column.
- `db.Text` body carries a loose markdown convention (`**Section**`, numbered
  action list, `**Risk Level: ...** | **Action Ready: ...**`) that the UI parses
  with regex (see §1.3).

### 1.2 Current readers (all present, all working)

| Reader | Path | How it reads |
|---|---|---|
| `getLatestAdvice()` | `lib/data/advice.ts` | `db.aiAdvice.findFirst` by `spaceId`, `orderBy generatedAt desc`; maps to `AiAdvice` view type. Returns `null` if none. |
| Daily Brief route | `app/api/brief/route.ts` | Directly `db.aiAdvice.findFirst` (primary Space only) → `buildInsight()` prefers `advice.summary`; else synthesizes a rule-based insight from context signals. |
| Advice page | `app/(shell)/dashboard/advice/page.tsx` | `getLatestAdvice()` → `<AdviceBanner>`. Static copy claims "Runs 2× daily" / "Next advice run: Today at 4:00 PM". |
| Analyze tab | `components/dashboard/AnalyzeClient.tsx` | Receives `advice` prop; renders `<AdviceBanner>` + "Advice Schedule" card; shows "No advice yet" fallback. |
| Overview panel | `components/dashboard/widgets/OverviewBriefPanel.tsx` | Condensed preview of the same single `advice` record (numbered-list parse mirroring AdviceBanner). |
| Dashboard shell | `components/dashboard/DashboardClient.tsx` | Passes `advice` prop through; contains an inline comment acknowledging "run-ai-advice never runs". |

### 1.3 Rendering contract

`components/dashboard/AdviceBanner.tsx` and `OverviewBriefPanel.tsx` parse
`adviceText` with regex helpers: `extractActions` (numbered lines),
`extractSection("**Market Context")`, `extractRiskFlag`. Any writer must emit
`adviceText` in this markdown shape or these panels degrade to empty sections.
`riskLevel` must be exactly `low|medium|high` (drives `RISK_CONFIG` styling);
`actionReady` drives the "Action Ready / Not Ready" pill.

### 1.4 The compute pipeline (already exists — this is the "insight" source)

- **Context Builder (D4):** `buildContext(spaceId, userId, { scopeHint })` in
  `lib/ai/context-builder.ts` assembles `SpaceContext_AI` (domains + signals).
  Barrel: `lib/ai/index.ts`.
- **Intelligence engine:** `computeAssessment(ctx): FinancialAssessment` in
  `lib/ai/intelligence/annotations.ts` (L1755). **Pure, deterministic,
  rule-based — no LLM.** Produces `currentStatePriority`, ranked `priorities`,
  `advisorHeuristics`, `riskOpportunities`, `debtStrategy`, `capitalAllocation`,
  etc. This is the computed insight that currently has nowhere to be persisted.
- **Signals engine:** `lib/ai/signals/*` — typed `ContextSignal[]` (NEEDS_REAUTH,
  NET_WORTH_DECLINED, GOAL_COMPLETED, …) already consumed by the brief.
- **LLM boundary:** `lib/ai/provider.ts` — the ONLY OpenAI import. Exposes exactly
  one function: `generateChatReply(systemPrompt, messages)` (gpt-4o-mini). There
  is **no** advice-generation function today.

---

## 2. The missing write path

**There is no writer.** Confirmed:

1. `jobs/run-ai-advice.ts` is a stub — its entire contents are `export {}`.
2. `jobs/scheduler.ts` `startScheduler()` registers only `purgeTrash` and
   `syncBanks`. It does **not** register `run-ai-advice`, and its header comment
   states `startScheduler()` "is not yet invoked anywhere (no instrumentation.ts
   hook exists)". So even the two registered jobs never fire.
3. The only `db.aiAdvice.create(...)` calls in the entire repo are in
   `prisma/seed.ts` (L738, L1214) — demo data for Jane/John. In production every
   Space has **zero** `AiAdvice` rows.
4. There is no cron API route, no server action, and no `provider`/`intelligence`
   function that serializes `FinancialAssessment` → `AiAdvice` fields.

Net effect: `computeAssessment` runs on-demand inside `/api/ai/chat` for prompting
but its output is never captured. Every reader therefore always hits its
"no advice" fallback (the brief's rule-based `buildInsight`, the "No advice yet"
card). UI copy promising "Runs 2× daily / Next run 4:00 PM" is **cosmetic
fiction**.

**The gap is exactly one component: a function that takes a Space's computed
assessment and writes one `AiAdvice` row, plus a trigger that calls it.**

---

## 3. Recommended minimal writer

Design goals: additive-only, no new tables, no scheduler dependency, no LLM
dependency required, deterministic, idempotent enough to avoid duplicate spam.

### 3.1 Shape

Add a single server-only writer, e.g. `lib/data/advice-writer.ts`:

```
writeAdviceForSpace(spaceId, userId, opts?) : Promise<AiAdvice | null>
  1. ctx  = await buildContext(spaceId, userId, { scopeHint: "full" })
  2. assessment = computeAssessment(ctx)
  3. { summary, adviceText, riskLevel, actionReady } = serializeAssessment(assessment, ctx)
  4. freshness/dedupe guard (see §3.3) → maybe return existing
  5. agentId = ctx.agentId (Space's AiAgent)
  6. db.aiAdvice.create({ data: { spaceId, agentId, summary, adviceText, riskLevel, actionReady } })
```

### 3.2 Serializer (`serializeAssessment`)

- **Deterministic path (recommended for slice 1):** map `FinancialAssessment`
  directly to the markdown contract the UI already parses (§1.3). `summary` from
  `currentStatePriority`; action list from top N `priorities`;
  `**Market Context**`/`**Risk Summary**` sections from `riskOpportunities`;
  `riskLevel` from the highest `advisorHeuristics` severity; `actionReady` from
  whether any actionable priority exists. No LLM, no cost, no non-determinism.
- **Optional LLM path (defer):** a future `generateAdviceBody()` in
  `lib/ai/provider.ts` could prose-ify the assessment. Not required for the loop;
  keep it out of the minimal slice.

### 3.3 Freshness + dedupe (without schema change)

The table has no dedupe/freshness columns and we are keeping changes additive.
Use query-time guards instead of new columns:

- **Freshness guard:** before writing, `findFirst` latest row for the Space; if
  `generatedAt` is within a min-interval (e.g. `< 12h` for the "2× daily"
  promise, tunable), skip and return the existing row. Prevents write floods when
  a trigger fires repeatedly.
- **Dedupe guard:** compute a stable content signature (hash of
  `summary + riskLevel + actionReady + normalized priority codes`) and compare to
  the latest row; if identical, skip the insert. Because the table is append-only
  and has no hash column, hold the signature in-memory for the comparison only —
  do not persist it in slice 1. (If dedupe proves valuable, a later slice can add
  an optional `contentHash String?` column — additive, indexed — but that is out
  of scope here.)
- **Scoping:** always write per-eligible-Space (OWNER/ADMIN/MEMBER; exclude
  VIEWER — mirror the brief's `ELIGIBLE_ROLES`). Never write user-scoped rows.

### 3.4 Trigger (minimal, no scheduler)

Do **not** revive `jobs/scheduler.ts` or wire `instrumentation.ts` in this loop.
Smallest viable trigger, pick one:

- **A (recommended): lazy write-through on brief read.** In `app/api/brief/route.ts`,
  when the primary Space has data but `db.aiAdvice.findFirst` returns null OR the
  latest row is stale, call `writeAdviceForSpace` for the primary Space, then read
  it back. Self-healing, zero infra, matches where the value is consumed. Keep it
  best-effort (wrapped, non-blocking on failure — brief already tolerates missing
  advice).
- **B: manual cron API route.** A protected `POST /api/jobs/run-ai-advice`
  (secret-guarded) that iterates eligible Spaces and calls the writer. Invokable
  by an external cron (Vercel Cron) later. No in-process scheduler needed.

Recommendation: ship **A** first (surfaces immediately, no external wiring), and
optionally add **B** as the durable path in a later slice. Filling the
`jobs/run-ai-advice.ts` stub is explicitly **out of scope** for the minimal loop.

---

## 4. Surfacing plan

No reader changes are strictly required — every surface already prefers a real
`AiAdvice` row and falls back gracefully. Once the writer runs:

1. **Daily Brief** — `buildInsight()` automatically prefers `advice.summary` over
   the rule-based fallback. No code change needed; verify the "Today's Insight"
   section now shows engine text.
2. **Advice page / Analyze tab / Overview panel** — all read the latest row via
   `getLatestAdvice()` / the `advice` prop; the `AdviceBanner` modal, "Advice
   Schedule" card, and preview populate automatically.
3. **Copy honesty (optional, non-blocking):** the static "Runs 2× daily / Next
   run 4:00 PM" strings in `advice/page.tsx` become approximately true under
   trigger A only if reads are frequent; consider softening to "Updates when you
   check in" to avoid over-promising. UI-only, defer if it touches unrelated
   layout.

**Explicitly deferred (per rules):** no planner promotion, no notifications, no
`Notification`/`Conversation`/`Message` tables, no push/email. The
"Not Ready / Action Ready" pill is display-only and stays display-only.

---

## 5. Implementation slices (do NOT implement yet)

Each slice is independently shippable with its own impact map + rollback.

- **Slice 0 — Serializer (pure, no DB, no I/O).** `serializeAssessment(assessment,
  ctx) → { summary, adviceText, riskLevel, actionReady }`. Unit-testable against
  the seed markdown shape. No writes, no reads. Lowest risk.
- **Slice 1 — Writer function.** `writeAdviceForSpace()` composing buildContext +
  computeAssessment + serializer + freshness/dedupe guard + `aiAdvice.create`.
  Covered by a script-driven manual invocation for one seeded Space. No trigger
  wired yet.
- **Slice 2 — Trigger A (lazy write-through in brief route).** Best-effort call in
  `/api/brief`; brief still renders if it throws. This is the smallest end-to-end
  loop.
- **Slice 3 (optional) — Trigger B (guarded cron route).** `POST /api/jobs/run-ai-advice`
  iterating eligible Spaces. Enables external scheduling without an in-process
  scheduler.
- **Slice 4 (optional, later) — copy honesty + optional `contentHash` column.**
  Only if dedupe needs persistence; additive column, separate migration.

Keep each slice in its own commit. Do not bundle. Do not touch unrelated UI.

---

## 6. Validation plan (per slice)

- `npx prisma generate` (schema only touched if the optional Slice 4 column lands;
  otherwise no migration).
- `npx tsc --noEmit`
- `npm run lint`
- **Slice 0:** unit test serializer output parses cleanly through
  `AdviceBanner.extractActions` / `extractSection` / `extractRiskFlag` and yields a
  valid `RiskLevel`.
- **Slice 1:** run writer against a seeded Space via a one-off script; assert
  exactly one row created, correct `spaceId`/`agentId`, freshness guard blocks a
  second immediate write.
- **Slice 2:** hit `GET /api/brief` for a Space with no advice → row created →
  "Today's Insight" shows engine summary; second call within the freshness window
  creates no duplicate. Confirm brief still 200s if the writer throws (force an
  error).
- **Scoping check:** VIEWER-only Space produces no rows.
- **Dedupe check:** unchanged assessment across two runs yields no duplicate row.

---

## 7. Rollback plan

- **Slice 0:** pure function, unreferenced until Slice 1 — delete file / revert
  commit. No data impact.
- **Slice 1:** writer is not invoked by any request path until Slice 2 — reverting
  the commit removes it with zero runtime effect. Any rows created during manual
  testing are removable with a targeted `deleteMany({ where: { spaceId } })`
  against test Spaces (append-only table, safe to prune).
- **Slice 2:** revert the brief-route diff; `buildInsight` falls back to the
  rule-based insight exactly as today. No schema, no data migration to undo.
- **Slice 3:** delete the route file; nothing else references it.
- **Slice 4 (if taken):** the added column is nullable/optional — a down-migration
  drops it without affecting existing rows; readers never depend on it.

Because the whole loop is **additive** (no table removal, no column change except
the optional Slice 4, no reader rewrites), every step is revertible by commit with
no forward-only data hazard.

---

## 8. Open questions to confirm before coding

1. Target branch — proceed on `feature/v2.5-spaces-completion` or rebase onto the
   Phase 2 branch?
2. Freshness interval — literal "2× daily" (12h) or a looser "once per check-in"?
3. Trigger choice — lazy write-through (A) only, or A + guarded cron (B)?
4. Serializer source of truth — deterministic mapping from `FinancialAssessment`
   (recommended, no LLM) vs. an LLM prose pass (deferred)?

**No implementation performed. Awaiting approval on the slice plan above.**
