# Fourth Meridian — Dead Code Audit (2026-07-12)

## Method

Full static import-graph analysis of every TypeScript file in `app/`, `components/`, `lib/`, `jobs/`, `scripts/`, `context/`, `types/`, `prisma/` plus root entry files (873 files, ~148k LOC). Entry points: all Next.js App Router conventions (page/layout/route/etc.), `instrumentation.ts`, `proxy.ts`, `next.config.ts`, every `jobs/*` body, every `scripts/*`, `prisma/seed.ts`, and all test files. Reachability was computed from those entries; every "dead" finding below was then manually verified against string references, dynamic imports (`await import(...)` in the job registry is handled), and comments. Comment-only mentions were discarded.

Caveats: analysis is syntactic (no type checker). Ambient `.d.ts` files were excluded as false positives. "Unused export" means no other file statically imports that name; same-file use and namespace imports are credited conservatively.

---

## Headline numbers

| Category | Count |
|---|---|
| Files scanned | 873 |
| Confirmed dead files (unreachable from any entry point) | 31 files, ~3,960 LOC |
| Tombstone files (`export {}` only) | 6 |
| Dormant-by-design seams (zero callers, documented) | 3 files |
| Unused exported names | 549 across 218 files (mostly types) |
| Unused npm dependencies | 1 confirmed (`otplib`) |
| Widgets registered but unimplemented | 10 of 53 |
| Perspectives marked comingSoon | 3 (tax, property, businessHealth) |
| Empty duplicate " 2" directories | 14 |
| Stray build artifacts / backups at root | 13 `.tsbuildinfo` + `.env.bak` |

---

## Tier 1 — Confirmed dead. Safe to delete.

All git-tracked, so deletion loses nothing.

### Cluster A: Retired dashboard v1 (~2,780 LOC)

The old card/chart dashboard, fully superseded by the section-backed `SpaceDashboard` + widget registry + perspective engine. Only references anywhere are historical comments ("formerly hardcoded in PersonalHero").

| File | LOC | Note |
|---|---|---|
| `components/dashboard/AccountModal.tsx` | 772 | Largest single dead file |
| `components/charts/HoldingsDonutChart.tsx` | 459 | |
| `components/dashboard/widgets/KpiRow.tsx` | 247 | Absorbed into SpaceTrendHero |
| `components/dashboard/PersonalHero.tsx` | 191 | Replaced by renderHero seam |
| `components/charts/CashChart.tsx` | 175 | |
| `components/charts/BankingChart.tsx` | 152 | |
| `components/charts/InvestmentsChart.tsx` | 148 | |
| `lib/mock-data.ts` | 144 | Demo fixtures, nothing imports them |
| `components/dashboard/SummaryStatCard.tsx` | 84 | Only imported by dead cards below |
| `components/dashboard/InvestmentsCard.tsx` | 69 | |
| `components/dashboard/AccountGroupCard.tsx` | 68 | |
| `components/dashboard/NetWorthCard.tsx` | 68 | |
| `components/dashboard/CashOnHandCard.tsx` | 59 | |
| `components/dashboard/DebtCard.tsx` | 58 | |
| `components/dashboard/FilterBar.tsx` | 42 | |
| `lib/summary-status.ts` | 40 | Only importers are the dead cards |

(`NetWorthChart`, `PortfolioHistoryChart`, `ChartFirstDayPlaceholder` are live — do not remove.)

### Cluster B: Timeline preview (~355 LOC)

`components/dashboard/widgets/TimelineModal.tsx` (87) → `components/dashboard/widgets/SpaceTimelineWidget.tsx` (194) → `lib/timeline-placeholder.ts` (73). Nothing imports TimelineModal, so the whole chain is unreachable. The live activity feed is `components/space/widgets/TimelineWidget.tsx` + the activity route. `lib/timeline-types.ts` is still used by live code — keep it.

### Cluster C: Brief leftovers (~270 LOC)

- `components/brief/BriefActions.tsx` (18) — self-documented: "retired… TODO: delete this file". The DailyBriefClient import it worried about is already gone; only a comment remains.
- `components/brief/UserMenu.tsx` (251) — brief layout comment says "kept (inert) for now" but nothing imports it. Its theme/region controls were absorbed elsewhere. Decide: delete or actually re-wire.

### Cluster D: Tombstones and superseded logic

- `export {}` stubs (1–2 lines each): `lib/ai-advice.ts`, `lib/crypto-apis.ts`, `lib/market-data.ts`, `lib/simplefin.ts`, `jobs/run-ai-advice.ts`, `jobs/take-snapshot.ts`. Already gutted; the empty shells just add noise.
- `lib/sync/computeCashResidual.ts` (66) — its docstring claims "called by the Plaid sync job," but nothing imports it. Superseded by `lib/investments/brokerage-cash.ts` (which `lib/plaid/refresh.ts` uses).
- `components/dashboard/widgets/MoreMenu.tsx` (151) and `components/dashboard/widgets/OverviewBriefPanel.tsx` (104) — orphaned widgets, zero importers.

---

## Tier 2 — Dormant by design (zero callers, but deliberate)

Not dead weight in the same sense; each carries a header explaining why it ships unwired. Keep if the roadmap still points at them; delete if it doesn't.

| File | Status |
|---|---|
| `lib/email/index.ts` | Barrel for the email seam, "ships with ZERO production callers." In practice every caller (9 API routes + purge) imports `lib/email/send` directly, so the barrel is bypassed. Either enforce barrel imports or drop it. |
| `lib/providers/catalog.ts` (187 LOC) | D6/D7 provider catalog — future institution-routing layer. Nothing consumes it yet. |
| `lib/providers/plaid/adapter.ts` (24 LOC) | D2-5 sync-provider seam, "not yet referenced by any route" by decision. |
| `jobs/sync-crypto.ts` | Real, working job body; deliberately NOT in the registry (v2.6b / R7 deferral). BTC sync happens via run-on-add + manual re-sync instead. |
| `lib/jobs/health.ts` (174 LOC) | Dead-job detection (OPS-4 S5). Reachable only from `scripts/check-job-health.ts` — never runs automatically. |
| `lib/snapshots/regenerate-history.ts` / `.core.ts` (427 LOC) | Reachable only from `scripts/regenerate-wealth-history.ts`. Operational tool, fine. |
| Test fixtures (`accounts-asof.fixtures.ts`, `valuation.fixtures.ts`, `prices/providers/fixture.ts`) | Test-only by design. Fine. |

Related operational note: `vercel.json` carries a single 06:00 UTC cron (Hobby-tier limit, documented in the dispatch route), so registry jobs on the 06:30 / 07:00 / 07:30 slots (daily sync-fx? no — notification-cleanup, purge-trash, rate-limit sweep, notification-retry, security prices) only run via the CRON_SECRET fallback routes or the FX stale-while-revalidate path. Known and documented, but worth keeping on the radar: some maintenance jobs effectively never fire on the current tier.

---

## Tier 3 — Waiting for implementation (intentional stubs, flags, placeholders)

What's promised in code but not built yet:

1. **Attention Center** — `components/brief/AttentionModal.tsx` renders a disabled "coming soon" CTA behind `ATTENTION_CENTER_LIVE = false`. `/dashboard/attention` route does not exist.
2. **10 unimplemented widgets** in `lib/widget-registry.ts` (53 registered total): `debt_summary`, `debt_payoff_tracker`, `mortgage_tracker`, `debt_payoff_calculator`, `investment_summary`, `investment_allocation`, `recent_activity`, `cash_flow`, `savings_rate`, `business_cash_flow` — most gated on "Requires transaction-level access. Not yet available." `SpaceDashboard` carries TODOs mapping two of them to fallback renderers until the payoff simulation / BreakdownWidget adapter exist.
3. **3 comingSoon perspectives** in `lib/perspectives.ts`: `tax`, `property`, `businessHealth` (wealth, cashFlow, investments, debt, liquidity, retirement, goals are live).
4. **Admin provider actions** — `components/admin/ProviderActionsButton.tsx`: Force Sync and Disconnect buttons are permanently disabled ("Coming soon").
5. **Public Space joining** — `components/dashboard/SpacesClient.tsx` disabled button: "Public Space joining is coming soon."
6. **Deferred jobs** (per `lib/jobs/registry.ts` header): email digests (no template/preference/marker yet), scheduled snapshot cadence (stale-balance semantics unresolved), dead-job detection automation (S5), plus run-ai-advice / take-snapshot (tombstoned) and sync-crypto (built, unregistered).
7. **One-time migration guards** — `SpaceDashboard.tsx` lines ~1769–1772 keep legacy section-key aliases alive pending a rename migration; `isDeprecatedAlias` exists in the registry for the same reason.
8. **Timeline simulation** — `TimelineModal.tsx` header describes an unimplemented snapshot-based simulation (moot if Cluster B is deleted).
9. **AI chat** — `app/api/ai/chat/route.ts` documents a "not implemented in this slice" boundary; owner-notification for space members explicitly ruled out for now in `lib/events/handlers/space-member-notifications.ts`.

---

## Unused exports (549 names across 218 files)

The large majority are exported **types/interfaces** — near-zero cost, common convention; deprioritize. The runtime (value) exports worth a pass:

- `lib/widget-registry.ts`: `getWidgetEntry`, `isWidgetImplemented`, `isDeprecatedAlias`, `getAllWidgets`, `getWidgetsForTab` — helpers nothing calls.
- `lib/api.ts`: `getRequestMeta`, `ok`, `created`, `badRequest`, `notFound` (file is heavily used; these specific helpers aren't).
- `lib/totp.ts`: `base32Encode`, `base32Decode`, `generateTOTP` exported but unimported.
- `lib/hero-region.ts`: 5 exported constants unused; `lib/perspectives.ts`: `PERSPECTIVE_GROUPS`; `lib/currency.ts`: local `formatCurrency` (live code uses `lib/format`'s); `lib/space-hero.ts`: `SPACE_HERO_DEFS`; `components/space/widgets/accounts/AccountsPerspective.tsx`: 7 unused helpers; `lib/fx/service.ts` `FxService` / `lib/prices/service.ts` `PriceService` class names (verify — may be intentional service seams).
- Barrels with big unused surfaces: `lib/ai/index.ts`, `lib/ai/intelligence/index.ts`, `lib/ai/context-priority/index.ts` re-export dozens of names nothing imports.

Recommendation: don't hand-prune 549 names. Add `knip` to CI with a tuned config (Next plugin + `jobs/*`, `scripts/*`, `prisma/seed.ts` as entries) and let it ratchet. (Note: knip needs more memory than a small CI box default — it OOM'd twice on this machine at ~4 GB; run with `NODE_OPTIONS=--max-old-space-size=8192` or file-level checks only.)

## Dependencies

- **`otplib` — unused.** Zero imports; `lib/totp.ts` header says it was deliberately reimplemented "to avoid otplib v13's async plugin system." Remove from package.json.
- `dotenv-cli` (devDep) — not referenced by any npm script; verify it's still used manually before removing.
- Everything else in dependencies is imported at least once (checked all 20).

## Repo hygiene (not code, still dead weight)

- **14 empty `" 2"` directories** (macOS Finder-duplicate artifacts), all untracked and all empty: `app/api/spaces/[id] 2`, `app/api/spaces/invites 2`, `components/space/{widgets,sections} 2`, `lib/providers/plaid 2`, `lib/ai/{intent,intelligence,signals,context-priority,assemblers} 2`, `docs/initiatives/d2/{validation,investigations,implementation,closeout} 2`. Delete all.
- **13 stray `tsconfig.*.tmp.tsbuildinfo` files** at root (~4 MB, gitignored) — leftover from parallel typecheck runs. Delete.
- **`.env.bak`** at root (gitignored but a secrets backup sitting in the tree) — delete or move out of the repo.
- **Two tracked ~2.3/2.7 MB source PNGs** at root (`fourth meridian dark background.png`, `fourth meridian light background.png`) — unreferenced by code; move to `docs/design-system/assets/` or out of git.
- **Unreferenced public assets**: `public/atlas-card-nebula.png`, `public/atlas-card-neutral.png`, `public/logo-icon.png` (0 code references; `atlas-card-nebula-v2.png` is the live one).
- **45 root-level markdown investigation/plan docs**, only 21 tracked in git — 24 untracked docs could be lost. Consider moving the lot into `docs/initiatives/` (which already holds 343 docs, well organized) and committing what's worth keeping.

---

## Suggested cleanup order

1. Zero-risk mechanical: " 2" dirs, tsbuildinfo files, `.env.bak`, `otplib`, the six `export {}` tombstones.
2. Cluster A + D deletions (one commit, ~3,000 LOC) — every file verified unreachable; `npx tsc --noEmit` + test suite after.
3. Cluster B + C after a quick product decision on UserMenu ("kept inert") and the timeline preview vocabulary.
4. Tier 2 seams: keep or kill per roadmap; if kept, add a one-line "dormant until <initiative>" so future audits skip them.
5. Adopt knip in CI to keep export-level drift from re-accumulating.
