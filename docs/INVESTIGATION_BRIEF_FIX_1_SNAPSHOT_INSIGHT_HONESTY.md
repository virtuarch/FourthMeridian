# BRIEF-FIX-1 — Snapshot Insight Honesty Investigation

**Date:** 2026-07-08
**Status:** Investigation only. No code, schema, migration, or doc-status changes made.
**Predecessor:** `docs/INVESTIGATION_DAILY_REPORT_CONFLICTING_NET_WORTH_INSIGHTS.md` (root-cause analysis; confirmed below).
**Scope discipline:** Snapshot Intelligence / Daily Brief honesty only. Not TI. No redesign, no AI overhaul, no schema, no new jobs, no snapshot cadence changes. Presentation and signal selection only.

---

## 1. Executive summary

The smallest honest fix is **five surgical edits across four files** (a fifth file if attribution is included), no schema, no writers, no new jobs, no UI changes:

1. Scope net-worth trend signals to the **primary Space only** in the brief (Option A) — eliminates contradictions by restoring the detector's per-Space "never both" invariant.
2. Replace "over N days" with **"since \<oldestDate\>"** in the two display strings — the only wording that matches the existing computation exactly, with zero algorithm change.
3. **Suppress the percentage at display time** when it is baseline-degenerate (|pct| > 100% or |oldest| below a floor); keep the raw data untouched.
4. Fix the mislabeled `snapshotSpanDays` (row count labeled as days) that feeds the AI chat prompt — derive it from the dates already in hand.
5. *(Optional, recommended, still small)* Add the **previous snapshot point** to the snapshot domain payload (additive type field) and attribute the latest delta to the category that moved — "driven by investment balances" — from columns that already exist.

Items 1–4 are pure presentation/selection fixes. Item 5 is the only data-shape change and it is additive. Everything the user reported becomes truthful; nothing about how snapshots are computed, stored, or written changes.

## 2. Root cause confirmation

All prior findings re-verified against current source:

- `snapshotCount` (row count, ≤90) is formatted as "days" at `lib/ai/signals/detectors/snapshot.ts:77,97` and `app/api/brief/route.ts:380`. Confirmed.
- One-signal-per-Space invariant (`detectors/snapshot.ts:13`) voided by cross-Space merge at `route.ts:523-529`; `buildAttention` renders any Space's decline unattributed (`route.ts:261-267`); `buildInsight` triggers on any Space's increase but renders the primary Space's numbers (`route.ts:373-383`). Confirmed.
- `netWorthTrendPct = (latest − oldest) / |oldest|` over the whole available history (`lib/ai/assemblers/snapshot.ts:116-121`); day-one baselines explode it. Confirmed.
- `SpaceSnapshot` rows already carry `stocks`, `crypto`, `cash`, `savings`, `debt`, and the assembler already maps them onto `SnapshotDataPoint` (`investments`, `digitalAssets`, `liquid`, `liabilities` — `assemblers/snapshot.ts:96-106`). Attribution needs no new data. Confirmed.
- **New finding this pass:** a third count-as-days site. `lib/ai/intelligence/annotations.ts:1812` assigns `snapshotSpanDays: snapshotCount` in the `DataQualitySection`, and the AI chat prompt renders it as "`N`-day history in 90-day window" (`app/api/ai/chat/route.ts:1405`). The same falsehood the brief prints is also being *told to the model*.
- Non-issue checked and cleared: `components/dashboard/AnalyzeClient.tsx:335` says "N data points" — already honest, no change.

---

## 3. Question-by-question findings

### Q1 — Cross-Space aggregation

The merge itself (`route.ts:523-529`) serves signals that are *correctly* cross-Space: `NEEDS_REAUTH`, `STALE_CONNECTION`, and sync errors are operational facts about accounts, cannot contradict each other, and should keep surfacing from every Space. Only the **net-worth trend pair** is contradiction-capable, because it is an *opinion about a portfolio* and each Space is a different portfolio.

| Option | Assessment |
|---|---|
| **A — primary Space only (trend signals)** | Two small filters (`sig.spaceId === primarySpaceId`) in `buildAttention` and `buildInsight`. Restores the detector's invariant at the brief level: at most one net-worth statement, ever. Matches the route's own stated design ("Uses the primary Space for headline metrics… to avoid double-counting"). **Recommended.** |
| B — primary + attribution | Requires plumbing Space names into signal metadata (the route header falsely claims this already exists) and a privacy review — a Space name on an unqualified decline can leak portfolio information to members with reduced `VisibilityLevel`. More code, new risk surface, and the user still sees two opposing arrows. Not worth it for this slice. |
| C — separate sections per Space | A brief redesign. Violates "no redesign." Rejected. |
| D — reconcile into one cross-Space net figure | Would require deduplicating shared accounts across Space snapshots — the exact class of problem that produced the "44 accounts" bug. New computation, new invariants. Rejected for this slice. |

**Recommendation: A**, applied only to `NET_WORTH_INCREASED` / `NET_WORTH_DECLINED`. Operational signals stay cross-Space. Adjacent finding: `buildInsight`'s `GOAL_COMPLETED` lookup (`route.ts:359`) also searches all Spaces and can congratulate the user on another Space's goal by name — not contradictory, but the same one-line filter is defensible while in the file. Also correct the route header comment (lines 21-22) that claims Space-name metadata attribution exists.

### Q2 — Snapshot window wording

Complete inventory of `snapshotCount`-as-days (verified by grep across `lib/`, `app/`, `components/`):

| # | Site | Current text | Consumers |
|---|---|---|---|
| 1 | `detectors/snapshot.ts:77` | `Net worth up $X (pct%) over ${snapshotCount} days` | Brief attention cards; AI chat "Active signals" list (`chat/route.ts:1125-1131`) |
| 2 | `detectors/snapshot.ts:97` | same, "down" | same |
| 3 | `app/api/brief/route.ts:380` | `over the last ${snapshotCount} days` | Brief insight card |
| 4 | `annotations.ts:1812` | `snapshotSpanDays: snapshotCount` | AI chat prompt "`N`-day history…" (`chat/route.ts:1405,1495`) |

Wording comparison against the existing computation (oldest available row → latest row, capped at 90 rows):

- **"Since Jun 4"** — exactly what the code computes; `oldestDate` is already on `SnapshotSectionData` and already in signal metadata. **Recommended.** Format via a tiny date formatter (month + day; add year when it differs).
- "Between Jun 4 and Jul 8" — also truthful but `newestDate` ≈ today in practice; longer, no added honesty.
- "Since your first snapshot" — truthful only until history reaches the 90-row cap, then silently false. Rejected.
- "Last 30 days" — would be a *different computation* (filter rows by date). The brief's own guidance applies: do not redesign the trend algorithm in this slice. Deferred.

For site 4, the fix is to derive the value honestly rather than reword: `spanDays = ceil((newestDate − oldestDate)/86400000)` from fields already present in the same `SnapshotSectionData`, falling back to `snapshotCount` when dates are null. The two completeness thresholds at `annotations.ts:1794-1801` compare `snapshotCount` directly and keep count semantics — untouched.

### Q3 — Percentage honesty

Why it explodes: denominator is `|oldest.netWorth|`, and `oldest` is the Space's day-one snapshot — often taken when the Space held one small account. $1.27K → $6.9K prints +442% and calls account-linking "growth."

- **Is suppression enough?** Yes, for this slice. The dollar delta remains and is always truthful.
- **Better denominator?** Latest value (`Δ/latest`) is stable but answers a different question ("what fraction of today's worth changed") and would quietly change the meaning of a displayed number — worse than hiding it. Average-of-window is nonstandard. Rejected.
- **Should percentages disappear for lifetime trends entirely?** Defensible — a percentage against an arbitrary "first snapshot" baseline is rarely meaningful — but a guard achieves the same protection with less behavior change, and preserves the pct for mature Spaces where it *is* meaningful.

**Recommendation:** display-time guard at the two consumer sites (detector titles, insight body): omit the percentage when `netWorthTrendPct` is null, `|pct| > 100`, or `|oldest.netWorth| < $500` (detector has oldest values in hand; the insight can rely on the guarded signal or duplicate the check). Keep `netWorthTrendPct` itself raw in the domain payload — other consumers (AI assessment) should see true data, and guarding at presentation preserves the architecture's data/presentation split.

### Q4 — Cause attribution

Everything needed already exists:

- Fields: `SnapshotDataPoint` carries `netWorth`, `investments` (stocks), `digitalAssets` (crypto), `liquid` (cash+savings), `liabilities` (debt), per row (`assemblers/snapshot.ts:96-106`, `types.ts:780-786`).
- **Only the latest two snapshots are required.** No transactions, no TI, no holdings.
- The single gap: in brief scope the assembler returns `latest` only — `history` is omitted (`assemblers/snapshot.ts:134`), so the route cannot see the previous point. Smallest change: add an additive `previous: SnapshotDataPoint | null` field to `SnapshotSectionData`, populated in all scopes (`points[points.length - 2] ?? null`). Type + assembler; no schema, no writer, no query change (the rows are already read).
- Route-side: compute `Δcategory` between `previous` and `latest`; if one category's |Δ| ≥ ~80% of |ΔnetWorth| (and |ΔnetWorth| is non-trivial, e.g. ≥ $50), append one clause: "mostly from investment balances" / "mostly from debt reduction" / "mostly from cash movement." **If no category dominates, or `previous` is null, say nothing about cause** — the honesty requirement from the approved scope.
- Wording must respect cadence gaps: the previous row may be days old, so the clause should be anchored "since \<previous.date\>" (or "since yesterday" when it is literally yesterday) — never "today."
- Recommend implementing the dominance math as a small **pure function** (e.g. alongside the formatters, or `lib/snapshots/` following the `backfill-core.ts` pure-core precedent) so it is unit-testable under the repo's tsx test runner.

This is the one piece of the slice that changes a data shape (additively). It is small, but severable: items 1–4 stand alone if the slice must shrink.

### Q5 — Window semantics

What each card *should* say versus the smallest change that gets there:

| Card | Current window | User expectation | Smallest honest change |
|---|---|---|---|
| Section title "In the last hour" | `lastBriefViewedAt` bucket | fine as a *greeting* window | Keep. The problem is the content beneath it, not the title. |
| "Net worth ±$Δ" item (`route.ts:167-175`) | whole snapshot history, silently | change *since they last looked*, or a labeled period | Label it: `detail: "since Jun 4 · now $X"` instead of `"now $X"`. True since-last-visit math is a different computation — deferred. |
| Insight trend sentence (`route.ts:380`) | whole history called "N days" | a labeled, plausible period | "since Jun 4" wording (Q2). |
| Attention decline (signal title) | whole history called "N days" | when did this happen | "since Jun 4" wording (Q2) + attribution clause (Q4) covers "it was yesterday, it was investments." |
| Attribution clause (new) | — | "today" / "since yesterday" | anchored to `previous.date`. |

Windows that should exist *eventually*: 1-day (headline) and 30-day (trend). Both require filtering snapshot rows by date — a trend-algorithm change explicitly out of scope here. The label-matches-computation approach makes today's output honest without prejudicing that future change.

### Q6 — Existing code boundaries (exact files)

| File | Current responsibility | Required change | Why it belongs there |
|---|---|---|---|
| `app/api/brief/route.ts` | Assembles brief sections from per-Space contexts + signals | Filter trend (and optionally GOAL_COMPLETED) signals to primary Space in `buildAttention`/`buildInsight`; reword line 380 to "since \<date\>"; guard pct; relabel the since-last-visit delta detail; (opt.) attribution clause; fix the false header comment | It owns section construction and all affected strings |
| `lib/ai/signals/detectors/snapshot.ts` | Emits per-Space net-worth trend signals | Titles → "since \<oldestDate\>"; pct guard in title formatting | It owns the signal title text; metadata already carries the dates |
| `lib/ai/intelligence/annotations.ts` | Pure assessment for AI prompts | `snapshotSpanDays` derived from `oldestDate`/`newestDate` (fallback: count) | It computes the field; the chat route merely renders it |
| `lib/ai/types.ts` *(only if Q4 included)* | Context domain type contracts | Additive `previous: SnapshotDataPoint \| null` on `SnapshotSectionData` | Type contract lives here |
| `lib/ai/assemblers/snapshot.ts` *(only if Q4 included)* | Reads SpaceSnapshot rows into the domain | Populate `previous` (one expression; rows already in memory) | It owns the domain payload |

Explicitly **unchanged**: `prisma/schema.prisma` (no schema), `lib/snapshots/regenerate.ts` / `backfill*.ts` (no writer changes), `jobs/*` (no cadence), `components/brief/*` (dumb renderers of strings — verified they render `label`/`value`/`body` verbatim), `app/api/ai/chat/route.ts` (benefits automatically via detector titles and the annotations fix). Confirmed: **no schema or snapshot-writer changes are required.**

### Q7 — User trust ranking

1. **Contradictory cards** — worst; a product that argues with itself is untrusted instantly. Fix now (Q1).
2. **Fake "34 days"** — a concrete, checkable falsehood, also fed to the AI. Fix now (Q2, all four sites).
3. **Inflated percentages** — "+442%" reads as either a bug or a lie. Fix now (Q3).
4. **Whole-history delta under "In the last hour"** — subtler dishonesty, one-line fix while in the file. Fix now (Q5).
5. **Missing attribution** — absence of an explanation, not a false statement. Include if the slice allows (Q4); severable.
6. **Stale snapshots** (trend's latest row can be days old vs the live headline) — real, but the cure is snapshot cadence, explicitly out of scope (OPS-4 R7). Wait; the date-anchored wording makes the staleness *visible*, which is the honest interim behavior.
7. **Baseline artifacts beyond the pct guard** (resetting baseline when the account set changes) — needs account-set history; wait.

### Q8 — Future compatibility

- **Snapshot cadence (R7):** date-anchored wording ("since Jun 4") is cadence-agnostic — denser history just tightens the dates. No conflict; no debt.
- **Investment Intelligence:** the category-dominance attribution is the coarse ancestor of holdings-based attribution; when holdings history exists it *replaces the clause's data source*, not the presentation seam. The pure-function shape makes that swap clean.
- **TI:** cash-side attribution via FlowType would refine "mostly from cash movement" into income/spending/transfer. This slice deliberately says nothing TI would contradict.
- **MC1:** snapshots are stamped `reportingCurrency` and never rewritten; a currency flip mid-window is an existing trend caveat this slice neither worsens nor fixes. The additive `previous` field carries the same stamp semantics as `latest`. No conflict.
- **Ambient Intelligence (v2.6b):** scheduled briefs will consume the same sections; honest strings and primary-Space scoping are prerequisites for that work, not obstacles.
- **Holdings history / Daily Reports:** unaffected; nothing here persists new state.

One deliberate non-goal to keep debt at zero: do not "fix" `netWorthTrendPct` in the assembler by changing its formula — consumers beyond the brief (AI assessment) expect the raw ratio, and presentation-layer guards are removable the day a better window exists.

### Q9 — Validation strategy

House constraints: no jest/vitest — standalone `*.test.ts` tsx scripts under `lib/`/`app/` discovered by `scripts/run-tests.ts`; no live DB in unit tests; pinned-wording tests are an established pattern (MC1).

**Unit (new `*.test.ts` files, pure — no DB):**
- `detectors/snapshot`: feed synthetic `SnapshotSectionData` — assert (a) "since \<date\>" title, pinned; (b) pct omitted when |pct|>100 / |oldest|<floor / pct null; (c) MIN_SNAPSHOTS and MIN_SPAN_DAYS guards unchanged; (d) exactly one signal, correct direction; (e) zero trend → no signal.
- Attribution pure function: dominance ≥80% → correct category phrase; no dominant category → null; |ΔnetWorth| below floor → null; previous null → null; date anchoring ("since yesterday" vs "since \<date\>").
- `annotations`: `snapshotSpanDays` equals date-diff, falls back to count when dates null; completeness thresholds still driven by count.
- Route wording: extract the insight/delta string builders as small pure exported formatters (the only export change; consistent with the pure-core testing pattern) and pin their output.

**Integration (dev harness, live DB — `scripts/test-*` convention, excluded from unit runner):**
- Seed two Spaces sharing accounts, personal trending up, shared trending down → GET `/api/brief` → assert at most one net-worth statement across all sections, and it references the primary Space's numbers.

**Regression:**
- `npm test` fully green (prior suites untouched).
- AI chat: "Active signals" line and the "`N`-day history" prompt fragment now truthful — snapshot the prompt for a fixture context before/after.
- `AnalyzeClient` untouched (already honest).

**Manual scenarios:** new Space (<3 snapshots → no trend anywhere); sparse history (span < 7 days → suppressed); near-zero day-one baseline (delta shown, pct hidden); investment drop between last two snapshots (attribution clause names investments, anchored to the right date); multi-Space contradiction setup (impossible to reproduce post-fix); backfilled `isEstimated` history (unchanged behavior — noted risk below).

### Q10 — Final recommendation

**Implement, in one slice, in this order:**
1. Primary-Space scoping of trend signals (Q1-A) — kills contradictions.
2. "Since \<date\>" wording at all four sites incl. `snapshotSpanDays` (Q2) — kills the fake window, in the UI *and* the AI prompt.
3. Display-time pct guard (Q3) — kills +442%.
4. Truthful since-last-visit delta label (Q5) — one line while in the file.
5. `previous` point + category attribution with honest fallback (Q4) — the sentence the user actually wanted; severable if the slice must shrink.

**Explicitly do NOT build:** per-Space brief sections; cross-Space net-worth reconciliation; fixed 1-/30-day trend windows (algorithm change — next slice, likely alongside snapshot cadence); alternative pct denominators; baseline reset on account-set change; transaction-based attribution (TI); snapshot cadence or any writer/schema change; Space-name attribution on signals (privacy review first).

**Risks:** (a) `isEstimated` backfilled rows still feed trends unmarked — pre-existing, unchanged, cheap to address when the assembler is next touched for real; (b) date-anchored wording exposes snapshot staleness ("since Jun 4" when the user expected "today") — this is the honest behavior, but expect it to generate the *next* feature request (cadence); (c) exporting route formatters for tests slightly widens the module surface — keep them presentation-pure; (d) pct floor/threshold constants are judgment calls — pin them in tests so changes are deliberate.

This is presentation and selection only, ~5 files, no schema, no migrations, no new jobs, architecture preserved. It optimizes for exactly one thing: the Daily Brief never says something the data cannot defend.
