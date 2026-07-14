# Fourth Meridian — Dashboard Route Reachability Audit (2026-07-13)

Companion to `FOURTH_MERIDIAN_DEAD_CODE_AUDIT_2026-07-12.md`. Scope: every route under `app/(shell)/dashboard/`, investigated for reachability, machinery vintage (v1 vs SpaceDashboard/Perspectives), supersession, and server-side dependencies. Prepared as the pre-UX-sweep / pre-v2.6 map of what's real vs. vestigial.

## Method

Beyond `href=""` grep: searched all of `app/`, `components/`, `lib/`, `jobs/`, `proxy.ts`, `next.config.ts` for `Link` hrefs, template-literal hrefs, `router.push/replace`, `redirect()`, `window.location`, notification-registry deep links (`lib/notifications/registry.ts` render → href), server-generated Brief action hrefs (`app/api/brief/route.ts`), email/invite URL construction, activity-feed hrefs, middleware routing (`proxy.ts`), and the legacy `?tab=` deep-link mapper. Dynamic `` `/dashboard/${...}` `` construction: **none exists** — every dashboard href in the codebase is a static string, so this map is complete. Additionally computed each route's **exclusive weight**: files reachable *only* through that route's page.tsx (import-graph difference against all other entry points), i.e. what actually leaves the repo if the route is deleted.

Middleware note: `proxy.ts` does auth gating and SYSTEM_ADMIN redirection on `/dashboard/*` as a pattern — it never routes *to* a specific dashboard sub-route, so it creates no dependencies. No sitemap/robots files reference these routes. No `generateStaticParams` involved.

---

## Headline numbers

| | |
|---|---|
| Routes under `app/(shell)/dashboard/` | 19 page.tsx (+ 1 layout) |
| Live and current | 10 (root, spaces, connections, analyze, settings ×6) |
| Confirmed dead (zero inbound edges anywhere) | 3 — history, holdings, investments — **1,335 LOC exclusive weight** |
| Reachable but vestigial (needs product decision) | 3 — accounts, banking, advice — **1,021 LOC exclusive** |
| Live UI on a dead data pipeline | 2 — analyze, advice (AiAdvice has **no production producer**; rows come from `prisma/seed.ts` only) |
| Redirect shim | 1 — workspaces (13 LOC) |
| Dynamic href construction found | 0 (all dashboard hrefs are static strings) |

Your quick pass was close but two of your six "zero href" routes have non-href inbound edges: **banking** (template-literal Link in the live AccountsPerspective) and **advice** (notification-registry deep link). **accounts** is more alive than suspected — the Brief API server-generates eight hrefs to it. **history, holdings, investments** are confirmed fully dead. **workspaces** is a deliberate redirect, not a page.

---

## Per-route findings

### Tier 0 — Live and current (don't touch)

| Route | LOC (page) | Inbound | Machinery |
|---|---|---|---|
| `/dashboard` (root) | 131 | Sidebar, BottomNav active-state, SpacesClient/CreateSpaceModal `router.push`, admin redirects, DAILY_BRIEF_READY notification | Current — renders `SpaceDashboard`/`PersonalDashboard` |
| `/dashboard/spaces` | 178 | Sidebar ×2, BottomNav, Brief API href, 4 notification types, invite-email pointer | Current (`SpacesClient`) |
| `/dashboard/connections` | 94 (+296 excl.) | Sidebar, plaid-oauth-return `router.replace` ×2, 3 notification types, InvestmentAccountsWidget, AccountsPerspective, InvestmentsPerspective | Current — designated permanent Connections hub (D2.x) |
| `/dashboard/analyze` | 52 (+577 excl.) | Sidebar, BottomNav, Brief hero/insight/API | ⚠ live route, dead data — see Tier 3 |
| `/dashboard/credit` | 41 (+1,241 excl.) | FicoCard (rendered by Debt Perspective adapter + SpaceDashboard) | Mixed — v1 `DebtClient` (1,241 LOC) but FICO update flow is the live path from the Debt Perspective |
| `/dashboard/settings` + account/data/preferences/security/notifications/archived-assets | ~276 total | Sidebar ×2, BottomNav, UserButton, 13 security notification types → `settings/security`, activity feed → `archived-assets`, DataPrivacySettings | Current |

Note on **credit**: reachable and functionally needed (manual FICO entry), but `DebtClient` is pre-unification machinery and the Debt Perspective redesign (2026-07-12 plan) covers the same ground. It's live today; fold its FICO-update function into the Debt Perspective before retiring. Not safe to delete now.

### Tier 1 — Confirmed dead: no inbound edge of any kind

Checked against links, pushes, redirects, notifications, Brief actions, emails, middleware, tests. Nothing routes here; all three are fully superseded.

| Route | Exclusive weight | Superseded by | Notes |
|---|---|---|---|
| `/dashboard/investments` | **5 files, 1,160 LOC** — page + `InvestmentsClient` (745) + `AssetDrawer` (211) + `TradingViewChart` (123) + `lib/exchangeSymbol.ts` (33) | Investments Perspective (redesigned 2026-07-12) + Investments time machine | Biggest win. TradingViewChart embeds a third-party widget nothing else uses. |
| `/dashboard/history` | 1 file, 89 LOC | Wealth Perspective + time machine (uses same `getRecentSnapshots` but via current shell) | Uses live `NetWorthChart` — chart stays, page goes. |
| `/dashboard/holdings` | 1 file, 86 LOC | Investments Perspective holdings view | Pure server-rendered table, v1 vintage. |

Deleting these three also unlocks follow-on export-level cleanup: `getPortfolioHistory`, `getInvestmentTransactions`, `getHoldings` keep other callers, but `lib/exchangeSymbol.ts` goes entirely, and the prior audit's dead-file Cluster A overlaps nothing here (already cross-checked — no double counting).

### Tier 2 — Redirect shim

`/dashboard/workspaces` (13 LOC) — `redirect("/dashboard/spaces")`, self-described "permanent redirect so old URLs keep working." Zero internal references. Keep-or-kill is purely about external bookmarks/browser history from before the rename. Cost of keeping: 13 lines. Recommendation: keep through v2.6, delete after.

### Tier 3 — Reachable but vestigial: needs a product decision

**`/dashboard/accounts` — 338 LOC exclusive (page + AccountCard + RemoveAccountButton + RemoveAccountModal).**
Your instinct about BriefNewUser was half right — but BriefNewUser is *not* legacy: it's imported by `DailyBriefClient` and `BriefHero`, both live in the Brief flow. Bigger: `app/api/brief/route.ts` **server-generates 8 hrefs** to `/dashboard/accounts` (all four onboarding actions + 4 data-quality actions). This is the current new-user onboarding path. Meanwhile the Connections page header explicitly plans to absorb it ("folding the Accounts list in here are later slices" — D2.x Slice 3). Decision: retarget those 8 Brief hrefs + 2 BriefNewUser CTAs to `/dashboard/connections` (or `/dashboard?tab=ACCOUNTS`), then delete. Until retargeted, this route is load-bearing for onboarding.

**`/dashboard/banking` — 639 LOC exclusive (page + BankingClient 592).**
One live inbound edge, and it's not an href grep can catch: `` href={`/dashboard/banking?account=${id}`} `` in `AccountsPerspective.tsx` (the *current* Accounts tab, shipped 2026-07-12) — its "View transactions" per-account action. There's even a test asserting the link exists (`AccountsPerspective.test.ts`). The Transactions tab redesign (phase 1 complete 2026-07-12) is the successor. Decision: once the Transactions tab supports per-account filtering, retarget that one link, update the test, delete the route. Also note `TransactionDetailDrawer.test.ts` reads `BankingClient.tsx` source directly and will fail on deletion — update it in the same commit.

**`/dashboard/advice` — 44 LOC exclusive.**
No UI links to it. Its only inbound edge is server-side: the `OPPORTUNITY_FOUND` entry in `lib/notifications/registry.ts` deep-links here — and **nothing produces that notification** (only tests reference it; its producer would have been `jobs/run-ai-advice.ts`, now a tombstone). So it's unreachable in practice but referenced by infrastructure reserved for v2.6a Advisor Intelligence. Decision belongs to v2.6a planning: either the route is the landing surface for future advice notifications (keep, rebuild) or v2.6a lands advice inside the shell (delete page + retarget registry href). Don't delete without touching the registry entry, or future notifications 404.

**⚠ The analyze/advice data problem (flagged for v2.6, not a route deletion).**
`/dashboard/analyze` is fully live in nav — Sidebar, BottomNav, three Brief surfaces — but `AnalyzeClient` (577 LOC) renders `AiAdvice` data whose only writer in the entire codebase is `prisma/seed.ts`. In production, no job, route, or handler ever creates an AiAdvice row (`run-ai-advice` is tombstoned; deferred to v2.6a per the job registry). Every user's AI page is running on empty or seeded data. Same applies to the `AdviceBanner` inside AnalyzeClient. This is the strongest argument for sequencing: the v2.6a advisor work decides the fate of analyze, advice, and the OPPORTUNITY_FOUND registry entry together.

**Legacy `?tab=` mapper** — `app/(shell)/dashboard/page.tsx` still maps `?tab=banking|credit|investments|...` onto shell tabs (SP-2A-4c). Nothing in the codebase generates those query strings anymore; it exists for old external links. Harmless (12 lines); prune during the UX sweep if old-link compat is no longer wanted.

---

## Suggested cleanup order

1. **Now, zero risk:** delete `/dashboard/history`, `/dashboard/holdings`, `/dashboard/investments` (+ their 4 exclusive components + `lib/exchangeSymbol.ts`) — 1,335 LOC, no inbound edges, fully superseded. Run `tsc --noEmit` + test suite; no tests reference these three.
2. **Small PR, before UX sweep:** retarget the 10 `/dashboard/accounts` hrefs (8 in `app/api/brief/route.ts`, 2 in `BriefNewUser.tsx`) to the Connections hub, then delete the accounts route + its 3 exclusive components (338 LOC).
3. **With Transactions tab phase 2:** retarget the AccountsPerspective "View transactions" link, update `AccountsPerspective.test.ts` + `TransactionDetailDrawer.test.ts`, delete banking route + `BankingClient` (639 LOC).
4. **With v2.6a planning:** decide analyze/advice/OPPORTUNITY_FOUND as one unit (route + registry href + data producer). Don't delete piecemeal.
5. **With Debt Perspective completion:** move FICO update into the perspective, then retire `/dashboard/credit` + `DebtClient` (1,283 LOC).
6. **After v2.6:** drop the `/dashboard/workspaces` redirect shim and the legacy `?tab=` mapper.

Net effect if all steps land: ~3,600 LOC of route-level vestige removed, and the `(shell)/dashboard` tree collapses to exactly the unified shell: root + spaces + connections + settings (+ analyze, in whatever form v2.6a gives it).
