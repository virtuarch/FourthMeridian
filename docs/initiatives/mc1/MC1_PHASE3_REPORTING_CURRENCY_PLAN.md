# MC1 Phase 3 — Reporting Currency (The Flip) — Implementation-Ready Plan

**Status:** ✅ **IMPLEMENTED & CLOSED 2026-07-05** — delivered as approved: Slice 1 `257f63f`, Slices 2–7 in the closing commits. All-USD no-op pinned by equivalence gates; entry findings F-1…F-4 closed; six Phase 4 entry findings recorded. Exit evidence: `MC1_PHASE3_CLOSEOUT_REPORT_2026-07-05.md`. Retained as the implementation record; the sections below are point-in-time design.
**Date:** 2026-07-05, verified against the working tree (Phases 0–2 complete and tagged; six identity seams live; `FxRate` archive accumulating daily).
**Governing docs:** `MC1_MULTI_CURRENCY_ROADMAP.md` §5 (approved) · `MC1_PHASE2_CLOSEOUT_REPORT_2026-07-05.md` §4 (entry findings F-1…F-4, all addressed below).
**Phase 3 goal (restated):** Spaces (and Users, as copy-once defaults) own a reporting currency; the Phase 2 machine converts into it for real. This is MC1's single behavior-changing phase — deliberately staged so that **for every existing all-USD Space the flip is a numerical no-op**, proven by equivalence gates at each slice. History is never rewritten; stored facts are never mutated; determinism is inherited from the immutable archive.

---

## 0. Executive summary

Phase 3 is two defaulted columns, one server-side context factory, one serializable context form for client surfaces, and the deliberate replacement of the six Phase 2 identity seams with real contexts — in four flip slices ordered by blast radius (snapshots → AI → lens → client surfaces). Every slice has a two-layer rollback: revert the seam to `identityContext` (code-level, per-seam) or set every `reportingCurrency` to `"USD"` (data-level, global — real contexts over all-USD data behave identically to identity for USD-stamped rows). The `estimated` flag becomes a first-class additive output of both aggregation families, carried to props and AI context data but **rendered nowhere** (presentation is Phase 4).

## 1. Investigation findings

1. **The Phase 2 seams (grep-verified, 5 code sites + 1 doc comment):** `lib/snapshots/regenerate.ts:61`, `lib/snapshots/backfill.ts:255`, `lib/ai/assemblers/accounts.ts:215`, `lib/ai/assemblers/transactions.ts:311` (`moneyCtx`), `app/api/ai/chat/route.ts:678` — all `identityContext(DEFAULT_DISPLAY_CURRENCY)`; `lib/account-classifier.ts:138` is documentation.
2. **Client surfaces receive server props.** `DashboardClient` takes `accounts: Account[]` from the server page (`app/(shell)/dashboard/page.tsx`) and classifies client-side (same pattern for `KpiRow`, Banking/Space panels, `DebtClient`). No client-side data fetching for these aggregates → a **serialized context prop** rides the existing data flow (F-1 resolution, §5).
3. **Space lifecycle endpoints exist:** creation `POST /api/spaces` (copy-once hook point), update `PATCH /api/spaces/[id]` (validated field addition; no UI needed — Phase 4 builds the selector).
4. **Backfill is the one historical-valuation writer.** Reconstructed snapshot rows are per-day recomputations, so their conversion must use **each reconstructed day's rate** (historical FX per day) — unlike `regenerate`, which values at the latest close. The Phase 1 archive's 365-day initial depth means older reconstructed days may resolve as misses → native + `estimated` (already `isEstimated: true` rows — coherent).
5. **`lib/money/context.ts` never imports the archive** (injected reader). The Phase 3 factory that binds `fxArchive` must live in a **server-only module** so client bundles never pull `lib/db`.

## 2. Decisions of record

| # | Decision | Resolution |
|---|---|---|
| D-1 | **Ownership** | `Space.reportingCurrency String @default("USD")` — authoritative for every Space-scoped aggregate, snapshot stamp, and AI total. `User.reportingCurrency String @default("USD")` — a default only: seeds new Spaces, denominates nothing by itself. |
| D-2 | **Inheritance** | **Copy-once at Space creation** (`POST /api/spaces` sets the new Space's currency from the creator's User default). **No retroactive inheritance**: editing the User default never re-denominates existing Spaces. No live chain — after creation the Space value is the only one consulted. |
| D-3 | **Defaults & migration** | Both columns `NOT NULL DEFAULT 'USD'` — a true statement for every existing row; no backfill, no data migration. Allowed values = `FX_BASE` + `SUPPORTED_QUOTES` (config), enforced at the API boundary (PATCH validation), not by DB constraint (house style). |
| D-4 | **Currency change semantics** | Forward-only (roadmap §5.2): live aggregates re-denominate on the next read (read-time conversion — there is no "convert my data" event); snapshots stamp the new currency from the next write; **existing snapshot rows keep their stamps — history is never rewritten**. Mixed-stamp chart display is Phase 4 (§6.4 of the roadmap); the data model is already unambiguous. |
| D-5 | **Context factory** | `lib/money/server-context.ts` (new, server-only): `buildSpaceConversionContext(space: {reportingCurrency}, opts: {currencies, dates})` → binds `fxArchive` into Phase 2's `buildConversionContext`. **Lifecycle: per request/invocation** — built where the data is fetched (route/assembler/writer), no cross-request cache (the request-scope memo + immutable archive make rebuilds cheap: one indexed query per distinct currency×date). USD fast path: when target is USD and every row currency is USD/null, callers may keep `identityContext` semantics implicitly — the real context produces identical results anyway, so **no special-casing is built**. |
| D-6 | **Serialization (F-1)** | `SerializedConversionContext = { target, entries: Record<"from\|date", Resolution> }` + pure `rehydrateContext(serialized)` in `lib/money/convert.ts` (client-safe). Server pages build once per Space, pass as a prop; client components pass the rehydrated context to their existing `classifyAccounts`/rollup calls. Chosen over server-computed totals: it preserves the client components' existing aggregation/memoization logic (smallest diff), keeps one aggregation implementation, and the payload is tiny (≤ distinct currencies × dates entries; all-USD Spaces serialize an empty table). |
| D-7 | **Estimated propagation** | Additive fields, rendered nowhere in Phase 3: `AccountClassification` gains `estimated: boolean` (true iff any converted member was estimated — walk-back, miss, or null-residue); debt rollup entries and monthly-breakdown buckets gain the same. Flags flow into snapshot writes? **No** — `SpaceSnapshot.isEstimated` keeps its D2.x reconstruction meaning; currency estimation on snapshots is recorded as a Phase 4 open item (a second flag or a widened meaning needs a product decision). AI context *data* carries the flags (assembler section fields), but prompts/serializers do not mention them yet (Phase 4 presentation). Dashboards receive them via props and ignore them (Phase 4 renders). |
| D-8 | **AI limitation comments** | The `lib/ai/types.ts` "summed without conversion" notes become **false** at the AI-family flip and are retired in that same slice (comment-accuracy is doctrine). Prompt/serializer presentation (labels, estimation disclosure) stays Phase 4. |
| D-9 | **Merchant/recurring (F-4)** | Unchanged: cadence heuristics keep comparing native amounts by design; merchant-total conversion is explicitly deferred to Phase 4 alongside its presentation. |
| D-10 | **Goldens evolve** | Phase 2's byte-identity goldens were the neutrality gate; Phase 3 replaces them with **equivalence gates**: (a) all-USD fixtures through a *real* USD context ≡ legacy output numerically, with `estimated: false`; (b) non-USD fixtures produce converted totals with correct flags; (c) determinism (same archive ⇒ same totals). The old goldens are updated, not deleted — their with/without-context comparison still pins the context-less kill-switch path. |

## 3. The six seams — call-site plan and rollout order

| # | Seam | Real context | Valuation dates | Slice |
|---|---|---|---|---|
| 1 | `lib/snapshots/regenerate.ts` | `buildSpaceConversionContext(space, {currencies: account currencies, dates: [yesterdayUTC]})`; **`reportingCurrency` stamp switches to `space.reportingCurrency` in the same edit** (F-2: target + stamp move together, atomically) | Latest close | **3** |
| 2 | `lib/snapshots/backfill.ts` | Same space context, but `dates` = every reconstructed day (historical FX per day, finding §1.4); archive gaps ⇒ native + estimated (rows are already `isEstimated`) | Per reconstructed day | **3** |
| 3 | `lib/ai/assemblers/accounts.ts` | Space context from the assembler's `SpaceContext` | Latest close | **4** |
| 4 | `lib/ai/assemblers/transactions.ts` (`moneyCtx`) | Space context; `dates` = distinct row dates in the fetched window (bounded by the fetch cap) | Per row date | **4** |
| 5 | `app/api/ai/chat/route.ts` (per-liability rollup) | Same space context as #4 (shared per-request build); rows gain `currency`/`dateISO` in the debt-transaction read | Per row date | **4** |
| 6 | F-3: `lib/perspective-engine/lenses/liquidity.core.ts` | Not an identity seam — raw self-summing. Threaded with an optional ctx (classifier pattern) + real context at the perspective route | Latest close | **5** |

Client surfaces (F-1, not seams but flip targets): `DashboardClient`, `KpiRow`, Banking/Space panels, `DebtClient` — serialized context props from their server pages — **Slice 6**.

Rollout order rationale: snapshots first (fewest consumers, exercises F-2 atomically, feeds charts only additively going forward), AI second (server-only, contract fields additive), lens third (single route), client surfaces last (widest prop surface). Each is independently revertible to `identityContext`/no-context.

## 4. Validation gates (every flip slice)

1. **USD-equivalence gate:** all-USD fixture (and, on the dev DB, the real all-USD Space) through the real context — totals numerically identical to legacy, `estimated: false`. This is the "no-op for existing users" proof, re-run per slice.
2. **Non-USD gate:** fixture Space with EUR/SAR rows — converted totals match hand-computed cross-rates; walk-back and miss produce flagged, native-included totals (D-3 continuity).
3. **Determinism gate:** repeated builds over the scratch archive byte-equal.
4. **History gate (Slice 3):** existing snapshot rows byte-untouched after a regenerate under a non-USD Space (only today's row changes); stamp = Space currency on new rows only.
5. Full suite (`npm test` incl. updated goldens + kd17/privacy/flow/perspective), `tsc`, lint — green at every slice.

## 5. Rollback strategy (two layers, every slice)

- **Data-level (global, instant, no deploy):** `UPDATE "Space" SET "reportingCurrency" = 'USD'` — real contexts over USD targets reproduce legacy numbers for USD-stamped rows; non-USD rows return to honest native-pass-through only if the archive lacks rates (otherwise they convert to USD, which is the *correct* USD-reporting behavior — strictly better than the legacy blend).
- **Code-level (per seam):** each flip slice is a small diff whose revert restores `identityContext`/no-context; the context-less classifier/rollup path (Phase 2's kill switch) remains intact underneath everything.
- **Schema:** columns are additive and defaulted; they can stay through any rollback.

## 6. Implementation slices

| Slice | Scope | Validation | Rollback |
|---|---|---|---|
| **1 — Ownership schema** | `Space.reportingCurrency` + `User.reportingCurrency` (defaulted); migration `mc1_phase3_reporting_currency`; copy-once in `POST /api/spaces`; `PATCH /api/spaces/[id]` accepts + validates the field (allowlist = FX_BASE + SUPPORTED_QUOTES). No consumer reads the columns yet. | Migration replay; `tsc` zero consumer edits; PATCH validation unit test; copy-once test | Drop columns / revert routes |
| **2 — Factory + serialization + estimated plumbing** | `lib/money/server-context.ts` (D-5); `rehydrateContext` + `SerializedConversionContext` (D-6, client-safe in `convert.ts`); additive `estimated` outputs on classifier/rollups/monthly (D-7); goldens updated per D-10. All seams still identity — zero behavior change. | Old-style neutrality: product output unchanged (identity seams untouched); new equivalence + flag unit tests | Delete new files; revert additive fields |
| **3 — Snapshot flip (F-2)** | Seams #1–2: real space contexts + `reportingCurrency` stamp switch, atomically; backfill per-day dates | Gates 1–5, incl. the history gate | Per-seam revert to identity + stamp constant; or data-level |
| **4 — AI flip** | Seams #3–5: space contexts through both assemblers + chat rollup; debt-transaction read gains `currency`/`dateISO`; retire the `lib/ai/types.ts` limitation notes (D-8); assembler section data carries `estimated` (no prompt changes) | Gates 1–3; AI suites (kd17/kd18/privacy/validator) green; USD-space AI context byte-comparable | Same |
| **5 — Lens flip (F-3)** | Thread `liquidity.core.ts` (optional ctx, classifier pattern) + real context at the perspective route | Gates 1–3; liquidity/engine/route suites | Same |
| **6 — Client surfaces (F-1)** | Server pages build + serialize the Space context; client components rehydrate and pass to existing calls; no rendering of flags, no selector | Gates 1–2 on props; visual QA: USD Space pixel-identical | Drop the prop (components fall back to context-less) |
| **7 — Closeout** | Docs (STATUS, roadmap, plan, charter, closeout report with Phase 4 entry findings — incl. the snapshot-estimation flag question from D-7 and mixed-stamp chart display) | Full suite + grep proofs (no selector UI, no Phase 4 work) | n/a |

## 7. Open items for approval alongside this plan

1. Confirm **D-6** (serialized context prop) over server-computed totals for client surfaces.
2. Confirm **D-7**'s snapshot boundary: `isEstimated` keeps its reconstruction meaning; currency-estimation flagging on snapshots deferred to Phase 4 as an open product decision.
3. Confirm **D-8** (limitation-comment retirement rides the AI flip slice, presentation stays Phase 4).

---

## 8. Recommended first-slice prompt

> Implement MC1 Phase 3 Slice 1 per `docs/initiatives/mc1/MC1_PHASE3_REPORTING_CURRENCY_PLAN.md` §6 exactly. Add `Space.reportingCurrency String @default("USD")` and `User.reportingCurrency String @default("USD")` to `prisma/schema.prisma` with comments recording D-1/D-2 (Space authoritative; User copy-once default; no retroactive inheritance; forward-only change semantics). Create one migration named `mc1_phase3_reporting_currency` containing only the two defaulted ADD COLUMN statements. Wire copy-once: `POST /api/spaces` sets the new Space's `reportingCurrency` from the creator's `User.reportingCurrency`. Extend `PATCH /api/spaces/[id]` to accept `reportingCurrency` validated against `FX_BASE` + `SUPPORTED_QUOTES` (reject anything else with a 400; no UI — the selector is Phase 4). Nothing reads the new columns yet — every conversion seam stays `identityContext`. Validate: migration replay on scratch Postgres, `npx prisma migrate dev` + `generate` locally, `npx tsc --noEmit` with zero consumer edits, `npm run lint`, `npm test`, plus unit tests for the PATCH allowlist and copy-once behavior, and a grep proving no consumer reads `Space.reportingCurrency`/`User.reportingCurrency`. Stop after Slice 1 and report before Slice 2.

---

*End of plan. Investigation and checklist only — no implementation, schema, migration, or code change is made or authorized by this document. Phase 3 work begins only upon approval, one slice at a time; Phase 4 (selector, presentation, estimation rendering, mixed-stamp charts) remains out of scope.*
