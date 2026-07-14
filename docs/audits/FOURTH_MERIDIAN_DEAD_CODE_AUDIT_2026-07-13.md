# Fourth Meridian — Dead Code Audit (2026-07-13)

**Type:** Delta audit — supersedes the reachability findings of `FOURTH_MERIDIAN_DEAD_CODE_AUDIT_2026-07-12.md` (one week stale). This is investigation-only; no deletions. It produces the list a future cleanup round works from, and for each Tier 1 item states whether it is **newly dead** (post-dates the 07-12 audit) or was **missed** by it.

## Method

Same as 07-12: full static **import-graph reachability** analysis. Every `.ts`/`.tsx` under `app/ components/ lib/ context/ types/` (840 non-`.d.ts` source files) was parsed for import specifiers — `import … from`, `export … from`, side-effect `import '…'`, dynamic `import('…')`, and `require('…')` — each specifier resolved (`@/` alias + relative, with `.ts/.tsx/.mts/.cts/.js/.jsx` and `/index` fallbacks) to a concrete file. Reachability was then BFS-computed from **all entry points**: every Next.js App Router convention (`page/layout/route/loading/error/not-found/template/default/…`), `middleware.ts`, `instrumentation.ts`, `proxy.ts`, `next.config.ts`, every `jobs/*` and `scripts/*` body, `prisma/*`, and **all test files**. Any source file not reached from an entry is dead. Every candidate below was then **manually verified** against string references, dynamic/`next/dynamic` imports, and comments — comment-only mentions discarded.

**Resolver note (correctness):** an initial pass over-reported 11 files (AI assemblers, signal detectors, PE lenses) because the first regex missed **side-effect imports** (`import './accounts';` with no `from`) — the exact wiring `lib/ai/assemblers/index.ts` uses as a registration barrel. Adding that pattern cleared all 11: they are registered/loaded, not dead. Flagged here because it mirrors the class of false alarm this repo has hit before (same-named symbols, comment mentions) and shows the numbers below were checked, not taken from a first run.

**Boundary:** this audit finds dead **files** (unreachable modules). It does **not** re-run route-reachability (dead *routes* that are themselves entries) — that is `FOURTH_MERIDIAN_ROUTE_REACHABILITY_AUDIT_2026-07-13.md`, whose Tier-1 finds (history/holdings/investments) were deleted `9a5b02d`/`4e513dd`/`3e89933`. Nor does it hand-resolve the 549 unused-*export* surface (see §Unused exports).

---

## Headline numbers

| Category | 07-12 | 07-13 (now) | Note |
|---|---|---|---|
| Source `.ts/.tsx` analyzed | 873* | 840 | *07-12 also counted `prisma/context/types`; net drop reflects ~2 cleanup rounds + route/retarget deletions |
| **Tier 1 — confirmed dead, safe to delete** | 31 files / ~3,960 LOC | **1 file / 220 LOC** | 07-12's 31 were all deleted in rounds 1–2 + today's route/retarget work; **1 new orphan** remains (below) |
| Zero-importer but **dormant-by-design** (Tier 2) | 3+ | 3 | `email/index.ts`, `providers/catalog.ts`, `providers/plaid/adapter.ts` — all already in 07-12 Tier 2 |
| Reachable **only via tests** | (implicit) | 1 | `lib/prices/providers/fixture.ts` — by design (07-12 noted) |
| `export {}` tombstone files | 6 | **0** | all removed round 1 (`68a4fb2`); none re-accrued |
| Unused **runtime** exports (spot-check) | ~18 named | ~15 still unused | knip never adopted → surface essentially unchanged (below) |
| Unused npm dependencies | 1 (`otplib`) | **1 (`dotenv-cli`)** | `otplib` removed `9bcca99`; `dotenv-cli` now **confirmed** unused (07-12 said "verify") |
| Empty `" 2"` duplicate dirs | 14 | **0** | deleted + gitignored in round 2 (`e948ee3`); KD-13 symptom now suppressed |
| Root-level markdown docs | 45 total / 21 tracked | **74 / 24 tracked / 50 untracked** | **materially worse** — see §Repo hygiene |
| Widgets registered / gated-unimplemented | 53 / 10 | 54 / ~14 | Tier 3, unchanged in kind |
| `comingSoon` perspectives | 3 | 3 | `tax`, `property`, `businessHealth` — unchanged |

**Headline:** after two cleanup rounds plus today's route-deletion and banking/accounts retarget-then-delete work, the module graph is **very clean** — exactly **one** newly-orphaned file. The redesign-orphan pattern the ask predicted *did* occur, but was already absorbed: the rewrites that orphaned components (banking → `BankingClient`, accounts → `AccountCard`/`PlaidLinkButton`/`RemoveAccountButton`/`RemoveAccountModal`) were cleaned today (`e144d7a`, `1eb72a2`); the Perspective/Transactions/Accounts-tab/shell-nav redesigns were **compositional** (relocated/reused existing widgets, additive primitive changes) and orphaned nothing — confirmed both by the import graph and by their completion docs (shell-nav S3: *"renders its bare `opt.label` exactly as before"*; the four Perspective redesigns relocate the same widgets behind `activePerspectiveId` branches).

---

## Tier 1 — Confirmed dead. Safe to delete.

Git-tracked, so deletion loses nothing.

| File | LOC | New or missed? | Evidence |
|---|---|---|---|
| `components/charts/PortfolioHistoryChart.tsx` | 220 | **NEWLY DEAD** (post-07-12) | The 07-12 audit explicitly listed it as **live — "do not remove"** (Cluster A note), and it was: its only importers were `components/dashboard/BankingClient.tsx` and `app/(shell)/dashboard/investments/page.tsx`. Both were deleted **today** — investments page `3e89933`, BankingClient `e144d7a` — orphaning it. Now zero references repo-wide except its own `export function PortfolioHistoryChart` declaration (`git grep PortfolioHistoryChart` → 1 hit, the definition). Recharts `AreaChart` wrapper; nothing else consumes it. |

That is the complete Tier 1. This is the same failure mode as the AccountCard cluster the banking/accounts work surfaced: **a route/host deletion silently orphans a chart/component the deletion's exclusive-dependent check didn't attribute to it.** `PortfolioHistoryChart` was a shared dependency of *two* deleted surfaces, so neither route-deletion's per-route exclusivity check flagged it — it only falls out of a whole-graph pass like this one. Recommend deleting in the next cleanup round.

---

## Tier 2 — Dormant by design (zero importers, but deliberate)

Each has a header explaining why it ships unwired; all three were already in the 07-12 Tier 2 and remain zero-importer. **Not newly dead** — listed so a cleanup round doesn't mistake them for Tier 1.

| File | LOC | Status (re-verified 07-13) |
|---|---|---|
| `lib/email/index.ts` | 17 | Barrel for the email seam; every caller imports `lib/email/send` directly, so the barrel is bypassed (0 importers). Decision unchanged from 07-12: enforce barrel imports or drop it. |
| `lib/providers/catalog.ts` | 186 | D6/D7 provider-catalog seam; still nothing consumes it. |
| `lib/providers/plaid/adapter.ts` | 23 | D2-5 sync-provider seam; "not yet referenced by any route" by decision — still true. |

Other 07-12 Tier-2 seams re-checked and still **reachable** (not dead), so correctly absent from the dead list: `jobs/sync-crypto.ts` (referenced by `lib/jobs/registry.ts` + its test), `lib/jobs/health.ts` (3 importers via `scripts/check-job-health.ts` chain), `lib/snapshots/regenerate-history*.ts` (script-reached), test fixtures.

---

## Tier 3 — Waiting for implementation (unchanged in kind)

No delta worth re-enumerating from 07-12. Current counts: **54** widget-registry entries with **~14** gated as `implemented:false` / "Not yet available" / "Requires transaction-level access" (was 53/10); **3** `comingSoon` perspectives in `lib/perspectives.ts` (`tax`, `property`, `businessHealth` — lines 174/178/182); Attention Center still behind `ATTENTION_CENTER_LIVE = false`; admin Force-Sync/Disconnect still disabled. These are intentional stubs, not dead code.

---

## Unused exports (the 549 count is stale — knip was never adopted)

**knip was not adopted.** No `knip` entry in `package.json` and none in `.github/workflows/ci.yml` — the 07-12 recommendation to ratchet unused exports in CI was not acted on. So the "549 names across 218 files" figure is unenforced and stale.

Re-counted the **runtime (non-type) exports** 07-12 flagged, by precise named-import (`import { X } from '@/…'`), not substring — because the substring approach produces exactly the false alarm this task warned about (e.g., `getRequestMeta` "matches" `lib/auth.ts`, but that file imports it from nowhere; from `@/lib/api` its true importer count is **0**):

| Export(s) | Owner | Still unused? |
|---|---|---|
| `getWidgetEntry`, `isWidgetImplemented`, `isDeprecatedAlias`, `getAllWidgets`, `getWidgetsForTab` | `lib/widget-registry.ts` | **Yes — all 0** |
| `ok`, `created`, `badRequest`, `notFound`, `getRequestMeta` | `lib/api.ts` | **Yes — 0** (only `withApiHandler` ×38 and `getClientIp` ×23 are imported from `@/lib/api`) |
| `base32Encode`, `base32Decode`, `generateTOTP` | `lib/totp.ts` | **Yes — all 0** |
| `PERSPECTIVE_GROUPS` | `lib/perspectives.ts` | **Yes — 0** |
| `SPACE_HERO_DEFS` | `lib/space-hero.ts` | **Yes — 0** |
| `FxService` (class name) | `lib/fx/service.ts` | **Yes — 0** (service seam) |
| `PriceService` (class name) | `lib/prices/service.ts` | **No — now consumed** by `lib/investments/valuation.ts` |

So the runtime-export dead surface is **essentially unchanged** in a week (one of eight groups became live). Recommendation stands: adopt `knip` in CI (Next plugin + `jobs/*`/`scripts/*`/`prisma/seed.ts` as entries; `NODE_OPTIONS=--max-old-space-size=8192` per the 07-12 OOM note) rather than hand-prune — otherwise this surface will keep drifting.

## Dependencies

- **`dotenv-cli` — unused (now confirmed).** Declared as a devDependency (`package.json`), but **0** npm scripts reference `dotenv`. 07-12 said "verify it's still used manually before removing"; verified — no script uses it. Safe to remove (or keep as a deliberate local-dev convenience, but then note it).
- `otplib` already removed (`9bcca99`). All other runtime dependencies import at least once.

## Repo hygiene

- **Root markdown docs have gotten materially worse: 74 total, 24 tracked, 50 untracked** (07-12: 45 / 21 / 24). The week's dated investigation/plan/completion docs (this audit's own siblings — `*_PERSPECTIVE_REDESIGN_*`, `*_SHELL_NAV_*`, `*_RETARGET_*`, `*_CLEANUP_*`, plus 8 `CLAUDE_CODE_PROMPT_*` files) all landed at root, untracked. **50 untracked docs are one `rm`/lost-laptop away from gone.** `docs/initiatives/` already holds 343 organized, tracked `.md`. **Recommendation (own line item):** move the root docs into `docs/initiatives/<track>/` and commit what's worth keeping — the ratio is now worse than at 07-12 and trending down each work-day. This is the single highest-value hygiene action this round.
- **`" 2"` duplicate dirs: 0** — deleted and gitignored in round 2 (`e948ee3`); the `* 2` / `* 2.*` rule suppresses the KD-13 symptom in-repo (the cloud-sync tool that creates them is still a local machine/OS config, unchanged).
- **`tsconfig.*.tmp.tsbuildinfo` / `.env.bak`:** cleared in round 2; `*.tsbuildinfo` and `.env*` remain gitignored so they won't re-accrue as tracked noise.
- **Design PNGs** already relocated to `docs/design-system/assets/`; unreferenced `public/*` assets removed (round 2, `e948ee3`).

---

## Delta summary vs. 07-12

**What the 07-12 audit got right (re-verified, no surprises):** all 31 of its Tier-1 files were genuinely dead and are now deleted; `PortfolioHistoryChart` was correctly live *then*; the six `export {}` tombstones, `computeCashResidual.ts`, `otplib`, and the `" 2"`/tsbuildinfo hygiene were all accurate; `email/index.ts`, `catalog.ts`, `plaid/adapter.ts` were correctly Tier-2 dormant and still are.

**What changed since:** one new orphan (`PortfolioHistoryChart.tsx`, dead as of today's route deletions), `dotenv-cli` now confirmed removable, `PriceService` now consumed, and the root-doc situation degraded from 45/21 to 74/24-tracked.

**Net actionable list for the next cleanup round:**
1. Delete `components/charts/PortfolioHistoryChart.tsx` (220 LOC, Tier 1).
2. Remove the `dotenv-cli` devDependency (or annotate why it stays).
3. Move the 50 untracked root docs into `docs/initiatives/` and commit — highest-value item.
4. Decide `lib/email/index.ts` (enforce-or-drop) and the two provider seams per roadmap (Tier 2 — keep with a "dormant until <initiative>" header, or drop).
5. Adopt `knip` in CI so the unused-export surface stops drifting unmeasured.

## Suggested cleanup order

1. Trivial/zero-risk: `PortfolioHistoryChart.tsx` deletion + `dotenv-cli` removal — one commit, `npx tsc --noEmit` + test suite after.
2. Root-doc relocation into `docs/initiatives/` (git mv + commit) — no code risk, big untracked-loss-risk reduction.
3. Tier-2 seam decisions (email barrel, provider catalog/adapter) — keep-with-header or delete per roadmap.
4. Adopt `knip` in CI to ratchet the 549-name export surface going forward.
