# BETA OWNER DECISION MATRIX — 2026-10-15

**Status:** ASSESSMENT / AWAITING OWNER DECISIONS · **Baseline:** v2.6 @ 0f07a62 · **Owner framing:** beta launch is the priority this week; UX P2 Phase A and Phase B targeted for beta; useful Platform Ops / Security Ops visibility prioritized; minimum viable beta analytics and AI/Plaid cost safeguards included; real-world assets targeted for beta if the existing backend supports a low-risk UI exposure; Coinbase, exchange adapters, universal connectors and multi-LLM support are post-beta.

**Classes:** REQUIRED = beta should not open without it · RECOMMENDED = ship before beta if the week allows; otherwise first post-beta slice · POST-BETA. **Flags:** 🗄 schema migration · 🔒 security / privacy implication · ⛓ dependency. **Effort** is agent-hours of coding, excluding owner review. Sources: the three assessments ([nav](PLATFORM-SPACES-UX-P2-NAVIGATION-ASSESSMENT.md), [cost](AI-PLAID-COST-ECONOMICS-ASSESSMENT.md), [providers](AI-PROVIDER-READINESS-ASSESSMENT.md)) and the [beta analytics design](BETA-PRODUCT-ANALYTICS-DESIGN.md).

---

## 1. UX P2 navigation (N)

| # | Decision | Class | Recommendation | Flags | Effort |
|---|---|---|---|---|---|
| N1 | HQ group on `/dashboard/spaces`: keep (dual entry) or move entirely to the new directory | REQUIRED (with Phase A) | move to the directory once the header switch exists; one home for Platform Spaces | none; `rls-server-component-authority.test.ts` read-site pins change | in A |
| N2 | Header "has ≥1 grant" flag: server prop vs client fetch | REQUIRED (with Phase A) | server prop from the dashboard layout (`withTenantDb` count, fail-closed hidden); no flicker, no second fetch | 🔒 display only; `[area]/page.tsx` and `/api/spaces` remain the authorities | in A |
| N3 | Directory route `/dashboard/platform` vs `/dashboard/spaces/platform` | REQUIRED (with Phase A) | `/dashboard/platform` (lights no primary destination, stays inside the proxy matcher and the platform-surface scan) | none | in A |
| — | **Phase A** (header switch + directory + no cookie/no auto-open) | REQUIRED | as specified in the nav assessment §10 Option 1 | 🔒 none new; no server authz change | 6–10 h |
| N4 | **Phase B** desktop sidebar Platform context (Platform list first, single "Personal Spaces" exit, PrimaryNav demoted not removed) | REQUIRED (owner targets it for beta) | ship after Phase A has been seen on Preview; keep PrimaryNav×2 / PlatformNav×2 pins as a reordering | ⛓ Phase A; rewrites `site-nav-in-space.test.ts:119-128` ordering and `platform-shell.test.ts:275-279` | 6–10 h |
| N5 | **Phase C** mobile bottom-bar Platform presentation | POST-BETA | wait for a phone-width verification; the most pinned surface in the repo | none | — |

## 2. AI / Plaid cost economics (C)

| # | Decision | Class | Recommendation | Flags | Effort |
|---|---|---|---|---|---|
| C1 | Record the Plaid environment per Item and exclude sandbox from cost | RECOMMENDED | yes; Production holds only production Items so beta accuracy is unaffected, but Preview's Economics figures are sandbox today | 🗄 additive column (or reuse `environment` with a Plaid value) + backfill by cutover date | 3–4 h |
| C2 | Investments priced only when `investmentsConsent === ENABLED` (or holdings fetched) | RECOMMENDED | ENABLED-only; reader change, no schema | none | 1–2 h |
| C3 | Persist `billed_products` / `consented_products` per Item | POST-BETA | later, with the reconciliation work | 🗄 | — |
| C4 | Widen the duplicate-Item gate to any non-REVOKED Item of the same institution (offer re-link) + scheduled retry of UNCONFIRMED removals | REQUIRED | yes; a beta user re-linking a broken bank today mints a second billable Item while the first keeps billing | 🔒 none; ⛓ one job registry entry | 4–6 h |
| C5 | `ProviderInvoice` table + monthly reconciliation (OpenAI Costs export, Plaid invoice) | POST-BETA | first post-beta economics slice | 🗄 | — |
| C6 | Fleet AI spend derived from `AiInvocation` by surface (harness excluded), counter kept as cross-check | RECOMMENDED | yes; makes the Economics block allocable and keeps eval runs out of "spend" | none | 3–4 h |
| C7 | First cost safeguards | REQUIRED (minimum set) | (a) `ai-spend-high` alert rule over 24 h fleet **and** per-user USD vs a `PlatformSetting` threshold (owner sets the number); (b) per-user daily AI allowance reader over `AiInvocation` surfaced in Customer Success and refused in the chat route above a catalogue ceiling (policy-group dimension `aiDailyUsdCeiling`, beta value owner-set); (c) a test that every call-site model has a rate | 🔒 none; ⛓ entitlements catalogue + alert registry; threshold values are owner decisions | 8–12 h |
| C7′ | Connection-count entitlement (`maxConnections`) | RECOMMENDED | yes at a generous beta value (e.g. 10 Items); bounds Plaid growth per user | ⛓ entitlements catalogue | 2–3 h |
| C8 | Inactivity disconnect policy for Plaid Items + customer wording | POST-BETA | needs product wording and a ruling; not a 5-user risk | 🔒 customer-facing | — |
| C9 | Beta analytics events and their visibility rules | REQUIRED | covered by A1–A8 below | see §4 | see §4 |
| C10 | Confirm the Plaid plan and obtain the contracted price sheet; confirm the OpenAI account/project split per environment | RECOMMENDED (owner admin action, no code) | do it this week; replaces invoice-derived rates and lets the OpenAI bill be split | 🔒 credentials stay external | owner |
| C11 | Adopt an illustrative customer price for planning | POST-BETA | none exists; break-even per active user is $0.57 / $1.87 / $5.28 (low / baseline / high) | none | — |

## 3. Multi-provider AI runtime (P) — all POST-BETA per the owner

| # | Decision | Class | Note |
|---|---|---|---|
| P1 | Adapter location under `scripts/ai-baseline/providers/` + "never in production" scan | POST-BETA | keep the design on file |
| P2 | `cacheCreationTokens` column + unit | POST-BETA | 🗄 |
| P3 | `cacheWriteInput` on the rate card + ANTHROPIC/GEMINI rates | POST-BETA | depends on P2 |
| P4 | First comparison set | POST-BETA | — |
| P5 | `@anthropic-ai/sdk`, `@google/genai` devDependencies | POST-BETA | new deps |
| P6 | Harness-only provider credentials and run budget | POST-BETA | 🔒 env names never read by production |
| P7 | `generate?` passthrough on `runStatelessTurn` | POST-BETA | one line, additive |

## 4. Beta product analytics (A) — see the design doc for definitions

| # | Decision | Class | Recommendation | Flags | Effort |
|---|---|---|---|---|---|
| A1 | Event store for beta: `AuditLog` actions (no migration) vs a new `ProductEvent` table | REQUIRED | `AuditLog` for beta (existing write path, RLS, pins); a dedicated table post-beta when volume or retention demands it | 🔒 product events kept out of Security History, the member Space feed and the operator feeds; 🗄 none now | — |
| A2 | Canonical event set | REQUIRED | the seven events in the design §1 (`SESSION_ACTIVE_DAY`, `SPACE_VIEWED`, `BRIEF_VIEWED`, `TRANSACTIONS_VIEWED`, `MANUAL_ASSET_VALUE_UPDATED`, plus normalising `WALLET_ADD` and `MANUAL_ASSET_ADD` into the enum); AI turns and connections are derived from existing ledgers, not re-evented | 🔒 metadata = ids, kinds, UTC day only | 10–14 h incl. tests |
| A3 | Active-user definition | REQUIRED | two numbers always shown: **present** (authenticated session touched that day) and **engaged** (≥1 product event, AI turn or connection action); background syncs, cron, webhooks and harness never count | none | in readers |
| A4 | Retention definitions | REQUIRED | returning = any engaged day after the first-visit day; D1 = engaged on day 1; D7 = engaged at least once in days 1–7 (window form, honest at n=5), with "on day 7" reported beside it | none | in readers |
| A5 | Dashboard home | REQUIRED | fleet counts in a new Growth & Revenue section `growth_product_analytics` (no identity); per-user usage/cost table in Customer Success; failed operations affecting users on Platform Ops Attention Required | ⛓ new section key ⇒ `platform:seed-spaces` on Dev, Preview, Production; 🔒 identity rules per area | 8–12 h |
| A6 | Retention window for product events | RECOMMENDED | 13 months rolling, deleted by a daily job; keep security actions as today (no purge) | 🔒 ⛓ new job entry; owner ruling on the window | 2–3 h |
| A7 | Clean existing PII in audit metadata (`REGISTER`/`EMAIL_VERIFIED`/`BETA_ACCESS_REQUESTED` store the email; `MANUAL_ASSET_ADD` stores name, balance, purchase price; `WALLET_ADD` stores the address) | RECOMMENDED | stop writing them (hash or omit) before beta users register; backfill-scrub later | 🔒 **existing violation of the metadata contract** (`lib/audit.ts:23-24`) | 3–4 h |
| A8 | Cost-per-active-user denominator | REQUIRED | engaged MAU; AI from `AiInvocation` surfaces chat+brief only; Plaid from Item-months with userId (Customer Success) and fleet Item-months (Growth / Platform Ops) | ⛓ C6 | in readers |

## 5. Real-world assets (R)

| # | Decision | Class | Recommendation | Flags |
|---|---|---|---|---|
| R1 | Manual real-world assets UI exposure: Real assets section, Update-value modal, Add-asset actions, one-step modal, PATCH/DELETE snapshot regeneration, `canManage`/`isUserEstimate` on the detail route | RECOMMENDED (reported by the RWA session as owner-approved; not verified by this session) | yes — backend already complete (create, PATCH balance, archive/restore/permanent, snapshot regen, ledger folding); the kind field is **not persisted** today, so dropping the kind chips is a product decision (no Property/Vehicle grouping until a profile exists) | 🔒 authorization unchanged (owner-only PATCH/DELETE; visibility via SpaceAccountLink + RLS); in flight on `rwa1/manual-assets` off 0f07a62 |
| R2 | Estimate-horizon freshness change (manual estimates stale after 180 days, excluded from the Space header anchor; AI `valuationSource: USER_ESTIMATE`) | RECOMMENDED, separate review | changes staleness semantics the Brief and AI read; review and pin on its own | ⛓ R1 |
| R3 | Property/Vehicle profile (`ManualAssetProfile`), valuation history | POST-BETA | 🗄 | — |

## 6. Platform Ops / Security Ops visibility (V)

| # | Decision | Class | Recommendation | Flags | Effort |
|---|---|---|---|---|---|
| V1 | Platform Ops: "failed operations affecting users" count and list on Attention Required (refresh FAILED/PARTIAL, AI FAILED/QUOTA, Brief failures, NEEDS_REAUTH) with opaque user refs; per-customer view in Customer Success | REQUIRED (beta operability) | additive to the UX P1 attention reader | 🔒 identity-minimised on Platform Ops | 4–6 h |
| V2 | Security Ops posture surface: Detections · Coverage · Notes over the five shipped routes (anomalies with their keys, auth posture, audit feed, operator actions, sessions), replacing five card-grain widgets | RECOMMENDED | presentation over shipped data; the July investigation's Brief 1; includes the two shipped honesty fixes (anomaly key rendered; login-failure pulse relabelled) | 🔒 none new | 6–10 h |
| V3 | Growth & Revenue product-analytics section | REQUIRED | = A5 | ⛓ seed | in A5 |

## 7. Post-beta by owner ruling

Coinbase, exchange adapters, universal connectors (the untracked `UNIVERSAL-FINANCIAL-CONNECTOR-ARCHITECTURE-P0.md` is another session's), multi-LLM support (P1–P7), C3, C5, C8, C11, N5, R3.

## 8. Dependency order for the beta week

1. A7 (stop writing PII into audit metadata) and C4 (duplicate gate) first — both protect beta users from day one.
2. Phase A → Phase B (N1–N4).
3. A1–A5, A8 events and readers → V3 section + seed on every environment → V1.
4. C7 safeguards (alert + allowance + model-rate test), C7′ cap, C2, C6.
5. R1 merge (in flight) → R2 on its own review.
6. V2 if the week allows; C1, A6 as first post-beta slices if not.

Approximate coding total for the REQUIRED set: 45–65 agent-hours; with the RECOMMENDED set: 75–100. With four agents and one coordinator this is 3–4 working days of coding plus Preview review, consistent with the UX P1 calibration.

*Assessment only. Nothing here is implemented until the owner approves specific decisions.*
