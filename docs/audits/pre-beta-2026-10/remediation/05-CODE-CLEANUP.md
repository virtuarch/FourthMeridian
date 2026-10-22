# 05 — Product Retirement and Code Cleanup

Sources: `agent-reports/G-retirement-hygiene.md` (full per-candidate evidence), `agent-reports/F-release-engineering.md` (dependencies), orchestrator commits on `remediation/beta-1`. Nothing persisted was dropped; no Prisma model, table or migration was removed.

## 1. Credit retirement (owner decision 1) — DONE

| Item | Disposition | Commit |
|---|---|---|
| `app/(shell)/dashboard/credit/page.tsx` (orphaned, pre-redesign Credit page) | deleted | `88cdaee` |
| `components/dashboard/DebtClient.tsx` (1,251 lines; only importer was the Credit page) | deleted | `88cdaee` |
| `components/dashboard/FicoCard.tsx` | links to `/dashboard/credit` and the compact variant removed; card kept (Debt workspace uses it) | `88cdaee` |
| `app/api/credit/update-fico` | **kept** — it is the save path of the Debt workspace's credit-score input | — |
| `CreditScore` model + rows, registration optional score, export | **kept** (historical financial data) | — |
| Dashboard layout comment naming `/dashboard/credit` | fixed | `75b733a` |

## 2. Growth retirement (owner decision 2) — NO CODE REMOVED, by evidence

No "Growth product" exists in code, docs or STATUS. The only Growth surface is the operator Platform Space `GROWTH_REVENUE` (beta requests, invitations, registration mode, product status, sign-ups, product analytics shared with Customer Success, funnel, users, activity, policy groups). Every sub-feature has a reader and is acquisition, waitlist, analytics or operations — the categories the owner said to preserve. Full table: G report §2.

## 3. Markets (owner decision 3) — PRESERVED, Coming Soon

- The registry `status` field was inert; Agent G made the renderer map read it generically, so any `comingSoon` workspace renders an honest "Coming soon." placeholder (`components/space/workspaces/WorkspaceComingSoon.tsx`). `lib/perspectives.ts` sets Markets to `comingSoon`. Commit `a69674f`.
- Nothing deleted: `MarketsWorkspace`, `lib/markets/markets-mode`, `?view=` routing, the five sidebar views and the registry entry all remain. Flipping the one word back restores the skeleton.
- The pre-existing truthfulness rule ("no comingSoon lens in a category list") received one named exemption for Markets citing this owner decision, pinned to the placeholder gate (`37a5e6f`'s parent integration fix).
- Residual: the sidebar still lists Markets and its five views, each landing on the placeholder. Hiding it entirely is a further documented edit (G report §3).

## 4. Dead code (CQ-002)

Deleted after a per-candidate importer census (static, relative, dynamic `import()`, registries, scripts, site, docs plans):

| Deleted | Commit |
|---|---|
| `components/brief/{BriefModal,HeroRegionProvider,BriefLogo}.tsx`, `lib/hero-region.ts`, `components/plaid/AccountRefreshButton.tsx`, `components/atlas/{InlineFilter.tsx,tones.ts}`, `components/space/widgets/{TimelineWidget,ProgressWidget}.tsx`, `components/ui/UserButton.tsx`, `components/dashboard/widgets/GlassModal.tsx` | `51bc553` |
| `lib/ai/domain-relevance.ts` + test (G marked ready; orchestrator removed the two source checks that read it) | `a37c364` |

Kept, against the audit's list, with reasons: `AssetValueWidget` (named by the RWA connector architecture), `lib/ai/domain-manifest.ts` (used by the two-user privacy harness), `lib/forecast/spending-baseline.ts` (imported by the forecast engine; only the `deriveSpendingBaseline` export is dead — left, as its absence from callers is already pinned), `lib/ai/conversation/compaction.ts` (runtime types + AI harness), `capability-classification.ts` and `obligation.ts` (named by dated plans).

## 5. Routes (ARCH-007 / CQ-009)

| Route | Consumers found | Disposition |
|---|---|---|
| `POST /api/plaid/sync` | none | deleted `1d4bf78` |
| `GET /api/spaces/[id]/investments` | none | deleted `1d4bf78` |
| `GET /api/spaces/[id]/snapshots`, `/transactions` | `lib/space/use-space-data.ts:228,254` | **kept** (audit was wrong) |

## 6. Dependencies (CQ-001) and upgrades

| Package | Change | Commit |
|---|---|---|
| `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `recharts` | uninstalled (0 importers, verified independently by F and G) | `08a7034`'s parent `CQ-001` |
| `next` 16.2.7 → 16.3.8, `next-auth` 4.24.14 → 4.24.15, transitive highs | `npm audit --omit=dev`: 14 (2 critical, 9 high) → 2 moderate; audit gate in CI | `e4c4031` |

## 7. Smaller consolidations

- CQ-008: one monthly-interest formula (`fdd34cc`).
- ARCH-003/CQ-004: one client-IP extractor (Agent A, `ecf3581`).
- ARCH-012 / PRIV-014: stale prose fixed (`046b655`, `75b733a`).

## 8. Assessed, not changed (with recommendations)

- **Schema models** (G report §5): `SpaceGoal`/`GoalCheckIn`/`GoalContribution` — 0 readers, 0 writers ⇒ drop in the next schema train. `AiAdvice` — drop after removing 2 readers. `Holding` — stop the dual-write in `sync-current-holdings.ts` first, then drop. Tombstone audits stay green. No drop performed: table removal is not authorised by "model appears unused".
- **Membership authorities (ARCH-001/CQ-007)**: one inline check (`app/api/space/switch`) is a drop-in for `requireSpaceRole(VIEWER)`; `accounts/manual` duplicates `resolvePersonalSpaceId`. The security-relevant divergence (`resolveSpaceContext` on the migration principal) belongs to the RLS-cutover programme. Recorded for wave 2.
- **Audit writers (CQ-006)**: 82 direct `auditLog.create(` sites; a proposed ESLint `no-restricted-syntax` rule is in G report §9 (not enabled — it would fail 80 sites at once; adopt with a baseline).
- **Unreferenced exports (CQ-003)** and **renames (CQ-010)**: deferred, cosmetic.
