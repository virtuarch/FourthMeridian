> **INVESTIGATION ONLY — no code, schema, or doc-of-record changes were made.** Post-FlowType-P5 next-step recommendation plus a diagnosis of the recurring dev-time `E668` router error. Sources: `STATUS.md` (checkpoint `2db97ef`), `docs/initiatives/flowtype/P5_CLOSEOUT_INVESTIGATION_2026-07-05.md`, `docs/investigations/V2.5_ROADMAP_ORDERING_AUDIT_2026-07-05.md`, `docs/ROADMAP_REVISION_PROPOSAL_2026-07.md`, and direct code inspection (app source + `node_modules/next@16.2.7`).

# Next Initiative & Router E668 Investigation — 2026-07-05

**Branch:** `feature/v2.5-spaces-completion` (4 commits ahead of origin; P5 closeout doc untracked)

---

## Part A — Next initiative after FlowType P5

### A.1 Recommendation

**Merchant Intelligence (persisted tier) is the next real initiative — but it is entered through a short, ordered runway of small items, not started directly.** Recommended order:

1. **FlowType closeout** — push the 4 local commits, commit the closeout investigation doc, apply the STATUS/doc updates (§A.4), tag per convention. Pure bookkeeping; the STATUS maintenance rule already requires it, and every later item cites documents that are currently stale.
2. **One-time flow-desync remediation** — re-run `backfill-flowtype.ts` over merchant-backfill-rewritten rows (P5 closeout §2.1), verified first by the one-line count (`category='Fee' AND flowType='SPENDING'`). Small, data-only, and it establishes the exact contract (category rewrite ⇒ flow invalidation) that MI Slice 1a must adopt — doing it first means MI starts from a clean baseline instead of inheriting a known-desynced one.
3. **MC1 Phase 0 — currency provenance** — approved, additive, behavior-neutral (all defaults `USD`). Sequenced here per §A.3/A.5.
4. **Merchant Intelligence persisted tier** — opened by the Slice 1a category-enum expansion decision + `categorySource` provenance, carrying the category-rewrite invalidation contract as an entry-gate design rule. Then user/Space overrides (`MerchantRule` schema), then cadence detection as its own slice.
5. **AiAdvice minimal writer + surfacing** — scheduler-free, trigger-agnostic `writeAdviceForSpace()` per `INVESTIGATION_AIADVICE_WRITER_SURFACING_LOOP.md`. Its FlowType dependency (per-liability capability, KD-18) is now satisfied by P5 Slices 3/6. Design must include: dedupe/freshness mechanism (the `AiAdvice` model is append-only with no dedupe key), a `SyncIssue` data-health check before writing, and the Float→Decimal *plan* existing before persisted derived figures ship (ordering audit §3.2).
6. **Job substrate / D5** — after the writer exists; the scheduler entrypoint upgrades it from on-demand to ambient and satisfies v2.6b entry criteria (KD-14). Fold the D2.x-deferred SyncJob / `SYNC_UPDATES_AVAILABLE` webhook / retry hardening into this same substrate rather than building it twice.
7. **Provider Catalogs (D6/D7) — defer.** D6's own resume trigger ("a second provider or launch UI needs it") has not fired, and the MC1 charter explicitly sequences currency architecture *before* provider expansion.
8. **SP-1 SpaceTemplate — stays parked.** D9 is parked in STATUS §8 with an explicit unpark condition (real users requesting templates); no `SpaceTemplate` model exists; the 07-refresh audit independently down-ranked it.

### A.2 Why this order

The chain is dependency-driven, and each step is smaller than the one after it: closeout is required by the STATUS maintenance rule and unblocks accurate planning; the desync remediation both cleans the only real P5 debt and *defines* MI's entry contract; MC1 Phase 0 is the last cheap moment to stamp provenance before new writers and large backfills (MI's) churn the ledger; MI is the approved headline (P5 closeout §6 and the v2.5 ordering audit independently agree, and the dual-semantics seam that audit ranked above MI is now closed); the AiAdvice writer reads through MI/FlowType output and must not precede the KD-18 capability (now landed); D5 exists to give the writer cadence, so building the substrate before the writer would be substrate with no job. Catalogs and SP-1 have explicit unfired triggers. This also preserves the approved ladder: v2.5 seams → v2.5.5 data semantics → v2.6a advisor → v2.6b ambient; nothing here reorders an approved gate.

Riding alongside (not gating MI, but open v2.5 debt): legacy `Account` out of the 3 remaining read sites (`lib/imports/authorize.ts`, `app/api/admin/overview/route.ts`, `app/api/accounts/[id]/transactions/route.ts` — an unmet v2.5 exit criterion), `.env.example` flags, observability counters, KD-13 root cause (see Part B — same root cause as the E668 aggravator).

### A.3 Prerequisites before Merchant Intelligence starts

From the P5 closeout (§6), plus MI's own gates:

1. Push + tag the P5 closeout (4 local commits ahead of origin).
2. Documentation closeout pass (§A.4 below).
3. One-time flow-desync remediation (§A.1 item 2) — verify with the count first.
4. Adopt the **category-rewrite invalidation contract** into MI Slice 1a design: any category rewrite must clear/bump `classifierVersion` or reclassify synchronously. The existing merchant backfill violates it; MI's override tier would violate it at scale.
5. MI's own entry gates: the `TransactionCategory` **enum expansion decision** (no Medical/Education/Auto/Transport/Entertainment — "a binding constraint on any merchant layer") and **`categorySource` provenance** (overrides need a home; backfill re-runs must not clobber user corrections — the `classifierVersion` pattern is the model).
6. Recommended: MC1 Phase 0 lands first (§A.5).
7. Optional dev nicety: wire seed → flow backfill (P5 closeout §2.2).

### A.4 Exact docs/status updates required after FlowType P5

1. **Push the 4 local commits**; commit the untracked `P5_CLOSEOUT_INVESTIGATION_2026-07-05.md`; tag the closeout per convention.
2. **STATUS.md re-verification pass** (its own maintenance rule requires it — last verified at `2db97ef`, many commits behind):
   - Add/complete a **FlowType ledger entry** recording the v2.5.5 flowType scope as shipped (write side + P5 read cutover Slices 0–7), with the four named residual debt items (desync seam until remediated, seed path, `FLOW_COST` triplication, `incomeTransactionCount` name-lookup).
   - **KD-18 entry**: the per-liability capability is no longer "ratified into v2.5.5" — it shipped (Slice 3 rollup, Slice 6 serializer + guardrail relaxation). Update status accordingly.
   - **v2.4.5 carry-forward / §6 blocker 6**: the "no test runner" caveat is closed by D-TEST (`scripts/run-tests.ts`, `.github/workflows/ci.yml`); the remaining open items (observability counters, window/rollup + follow-up/drilldown suites, `.env.example` flags, max-50 copy) stay open.
   - Record DB1/LC1/D-TEST/merchant-Slice-1 in the verification checkpoint (all postdate `2db97ef`).
3. **Mark superseded**: `P5_END_TO_END_CUTOVER_STATE_INVESTIGATION.md` (still says Slices 3–7 "NOT STARTED") and `P5_RESUMPTION_PLAN_2026-07-05.md` — point-in-time headers pointing to the closeout doc.
4. **Comment-only fix** (may ride the closeout commit): `lib/data/transactions.ts:86,123` — "flow metadata not consumed anywhere yet" is false since Slice 2.

### A.5 Should MC1 Phase 0 precede Merchant Intelligence?

**Yes — sequence it before MI Slice 1a, while being honest that it is a soft prerequisite, not a hard technical blocker.** MI's persisted tier writes category/identity data, not monetary rows, so nothing in MI *breaks* without Phase 0. The reasons to do it first anyway: (a) it is approved for the v2.5 window and is deliberately tiny (additive, behavior-neutral, `USD` defaults); (b) the charter's doctrine — provenance cannot be reconstructed later — means every writer and every large backfill that lands before Phase 0 enlarges the unstamped surface, and MI's backfills rewrite rows at scale; (c) landing one small additive migration before MI opens its own schema (`MerchantRule`, `categorySource`) keeps the migration sequence serialized and each rollback trivial. If MI Slice 1a turns out to be pure decision-making (enum decision, no schema), the two can proceed in parallel without conflict — but any MI *schema or backfill* work should land after Phase 0.

---

## Part B — `E668: Router action dispatched before initialization`

### B.1 What the error is

Thrown by `dispatchAppRouterAction()` in `next/dist/esm/client/components/use-action-queue.js` (Next 16.2.7, error code **E668**). `dispatch` is a **module-level variable**, set during the root `AppRouter` component's render (`useActionQueue`) and **never reset to null afterwards**. The error therefore means one of exactly two things:

1. A router action was dispatched **before the very first AppRouter hydration render** in that page load; or
2. The dispatch reached a **second, never-initialized copy of the module** — i.e., a duplicated/mismatched client chunk graph (two instances of `use-action-queue` in one page).

The `[browser]` prefix is Next 16's dev console-forwarding; "Uncaught" means it escaped React (event listener, `setTimeout`, or promise stack — not render).

### B.2 App code or Next dev/runtime instability?

**Verdict: predominantly dev/runtime chunk-graph instability, with two identified app-code call sites that are the only candidates worth auditing.** Evidence:

- **App-code sweep is nearly clean.** The only places app code can feed `dispatchAppRouterAction` outside the router API are raw History calls, which Next patches (in an AppRouter `useEffect`) to dispatch `ACTION_RESTORE`. The repo has exactly two: `components/dashboard/SpacesClient.tsx:1013` (inside a `setTimeout(0)` in the `?left=` toast effect) and `components/dashboard/TotpSection.tsx:534` (inside an async handler, `?setup2fa=` flow). Both run post-mount, when `dispatch` is necessarily set *in a healthy single-graph page* — but both run through `setTimeout`/async stacks, matching the "Uncaught" signature if the graph is unhealthy. No module-scope or render-time `router.*` dispatches were found; no other `pushState`/`replaceState`/`popstate` usage exists.
- **"Persists after clearing `.next`" points away from a stale build cache and toward a *continuously re-corrupting* environment.** KD-13's recurrence is direct evidence: 19 iCloud/Finder `" 2"` duplicate dirs are on disk right now, **including four inside `.next/dev/*`** — the repo lives in a cloud-synced `Documents` path and the sync provably tampers with the dev cache while the dev server serves from it. A webpack dev graph whose files are duplicated/swapped underneath it is exactly how a page ends up with a stale chunk holding an uninitialized second copy of `use-action-queue`. The same mechanism (stale browser tab holding pre-restart chunks, then client-navigating against a restarted server; or chunks served through the `cloudflared` tunnel with caching) produces the identical signature.
- **The project has documented prior dev-server graph instability** (the `proxy.ts` header records a Turbopack manifest-regeneration race; the team already runs `next dev --webpack` because of it).

### B.3 Could recent changes have caused it?

No recent commit touches routing, layout, providers, or history handling. However, the two candidate call sites were both touched in the current window: `57da0b8` (Spaces Atlas Liquid redesign — `SpacesClient.tsx`, which contains the `?left=` toast `replaceState`) and `7f9d1fe` (M2 TotpSection overlay migration). If the error's onset correlates with the Spaces redesign landing, the `SpacesClient` effect is the prime app-side suspect — it fires on mount whenever `?left=` is present, via `setTimeout`. If the error appears on arbitrary pages without those query params, recent changes are exonerated and the environment explanation stands alone.

### B.4 Files/components to inspect

| File | Why |
|---|---|
| `components/dashboard/SpacesClient.tsx:1005–1013` | Raw `history.replaceState` in `setTimeout(0)` — one of two app-code paths into the patched-history dispatch |
| `components/dashboard/TotpSection.tsx:527–534` | Raw `history.replaceState` in async handler — the other |
| `node_modules/next/dist/esm/client/components/use-action-queue.js` | E668 throw site; confirms module-level `dispatch` lifecycle |
| `.next/dev/`, `lib/`, `app/` `" 2"` duplicate dirs | Evidence of live cloud-sync interference with the dev cache (KD-13) |
| `package.json` `dev` script / `proxy.ts` header | Confirms webpack dev + documented prior manifest races |
| Browser tabs / `cloudflared` tunnel | Stale-chunk serving paths |

### B.5 Recommended minimal fix path (in order; no code changed here)

1. **Capture the full source-mapped stack on next occurrence** (dev overlay → expand). One stack frame decides everything: if it passes through the patched `replaceState`, it's the app call sites; if it originates in prefetch/server-action internals, it's the graph.
2. **Fix the environment, not the code (likely the actual fix):** move the repo out of the cloud-synced path (or exclude the project folder from iCloud sync), then do one full clean — `rm -rf .next node_modules/.cache`, restart dev, **close all stale tabs** (hard-reload is not enough for a tab holding old chunks). This simultaneously closes KD-13's root cause, which is already v2.5 debt.
3. **If a stack implicates the two call sites:** replace the raw `window.history.replaceState` calls with `router.replace(pathname, { scroll: false })` (2-line change each) so URL cleanup goes through the router API instead of the patched-history back door.
4. **Only if it still reproduces from a clean, un-synced environment:** treat as a Next 16.2.7 internal defect (E668 is an internal invariant) — pin/patch and file upstream with the captured stack.

### B.6 Must-fix-now vs can-defer

**Must-fix-now (this week, before/alongside MI runway):** the P5 closeout push + doc/STATUS pass (governance rule, everything else plans against it); the one-time flow-desync remediation (data change — needs its own approval, count-first); the **cloud-sync root cause** (it corrupts the dev cache, causes KD-13's permanent regression, and is the leading E668 explanation — cheap to fix, compounding cost to defer).

**Can-defer:** the E668 error itself is dev-only with zero production impact — tolerate until step B.5-1 yields a stack; the two `replaceState`→`router.replace` swaps (only if implicated); seed→flow-backfill wiring; `FLOW_COST` consolidation; `incomeTransactionCount` name-lookup; the `lib/data/transactions.ts` stale comment (ride the closeout commit).
