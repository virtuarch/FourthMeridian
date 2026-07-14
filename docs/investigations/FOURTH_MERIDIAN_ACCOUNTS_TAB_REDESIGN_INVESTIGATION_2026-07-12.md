# Fourth Meridian — Accounts Tab Redesign: Investigation

**Date:** 2026-07-12
**Scope:** Ground the "Accounts = Space participation, Connections = data source" vision against real code — what exists, what's cheap, what needs new schema, what's honestly out of reach today.
**Prompted by:** a product vision proposing the Accounts tab become account-management-centric (identity, Space participation, data health, historical coverage, imports visibility), explicitly NOT a second Connections page.

---

## 1. Executive assessment

**The conceptual split this vision proposes already exists as stated doctrine — the UI just hasn't caught up to it.** `components/connections/ConnectionCard.tsx`'s own header comment: *"Connections is a provider-management surface, NOT the Accounts page... Account NAMES only — never dollar balances (those live on Accounts/Spaces/Dashboard)."* This mirrors the Activity Tab investigation's finding almost exactly: the architecture already anticipated this distinction; the gap is that the Accounts tab today doesn't live up to its half of it.

**But the current Accounts tab is the thinnest starting point of any redesign this wave.** Verified: it's `AccountsCard`, an inline function defined directly inside `SpaceDashboard.tsx` (never extracted to its own file, unlike every other perspective), rendering a type-grouped list of name/institution/balance and nothing else — no status, no actions, no coverage, no imports. This is closer to Investments' "basically nothing" starting point than Cash Flow's "mostly relocate real widgets" one.

**The vision splits into four genuinely different buckets, not one build:**
1. **Real and cheap** — identity fields, connection health (a pure function already exists, decoupled from Connections), imports count, rename, remove-from-space. All backed by real, already-queryable data.
2. **Real but larger** — Historical Coverage. Genuinely valuable, genuinely computable from A4/A7/A8 data without new schema, but a real new read-time aggregation, not a relocation.
3. **New schema required** — "Space participation" controls (hide, exclude from calculations, display order, default account). None of these fields exist on `SpaceAccountLink` today. This is the only part of this vision that needs a migration.
4. **Not honestly buildable yet** — Account Intelligence (confidence, last regenerated, evidence). Asymmetric across account types and dependent on A9 activation, which still isn't wired.

---

## 2. Current state (verified)

- **Component:** `AccountsCard` (`components/dashboard/SpaceDashboard.tsx:382–422`) — groups the `accounts` prop by `type`, renders name/institution/balance per row. No status, no per-account actions, no coverage.
- **Mount:** `lib/space-presets.ts:77–83` defines `ACCOUNTS_SECTION` (`key: "accounts_overview"`), dispatched via `WIDGET_RENDERERS["accounts_overview"]` (`SpaceDashboard.tsx:1385`) → `<AccountsCard accounts={p.accounts} />`. Same generic `SectionCard` mechanism the pre-redesign Cash Flow/Liquidity/Debt tabs used — not a bespoke composition.
- **Data shape today:** `SpaceAccount` (`SpaceDashboard.tsx:151–162`) — `id, name, type, institution, balance, currency, lastUpdated, creditLimit?, interestRate?, minimumPayment?`. **No `mask`, no connection status, no coverage, no import count.** This type is shared broadly across the dashboard (Wealth, Cash Flow, Liquidity, Debt widgets all consume it) — extending it for Accounts-tab-specific fields risks bloating a type many unrelated widgets depend on.
- **Source route:** `app/api/spaces/[id]/accounts/route.ts` — returns active accounts visible to a Space via `SpaceAccountLink` (header comment confirms this join). Does not currently select `mask`, connection/Plaid state, or any coverage-relevant fields.

---

## 3. Bucket 1 — real and cheap (verified data, no new schema)

| Vision item | Real source | Note |
|---|---|---|
| Name, institution, type | `FinancialAccount` — already in `SpaceAccount` | Direct |
| Last four digits | `FinancialAccount.mask` (`prisma/schema.prisma:788`, "last 4 digits of account number") | Real column, just not selected into `SpaceAccount` today |
| Connection health (Healthy / Needs reconnection) | `lib/sync/status.ts` — `deriveConnectionState()` (`:125`) already returns `"ready" \| "needs_reauth" \| "error" \| "importing"` as a **pure function**, decoupled from any Connections UI. `FinancialAccount.connectionId → Connection` (`:664–665`) is the same join `ConnectionCard` already uses. | This is the best finding in this investigation — real health, zero duplication of Connections management, already built as reusable logic. |
| Historical imports count | `ImportBatch` — same model, same `spaceAccountLinks` join pattern already designed for the Activity Tab plan's producer | Direct reuse across two initiatives, not two implementations |
| Rename (Space alias) | `ACCOUNT_RENAMED` is a real `AuditAction`; write site confirmed at `app/api/accounts/[id]/route.ts` | Not invented — a real, already-shipped feature |
| Remove from Space | `SpaceAccountLink.status → REVOKED`, confirmed live at `app/api/spaces/[id]/accounts/share/route.ts` (the established revoke-don't-delete doctrine used throughout this codebase) | Real mutation exists |
| View / View transactions | Pure navigation to existing routes | No new capability needed |

---

## 4. Bucket 2 — real but larger: Historical Coverage

Verified per-source, since the vision's mockup mixes account-level and Space-level concepts that don't map 1:1 onto how this app actually stores history:

- **Transactions coverage** (e.g. "Jan 2018 → Today"): a `MIN(date)`/`MAX(date)` over `Transaction` rows for the account. `Transaction.financialAccountId` is nullable (`prisma/schema.prisma:1723` — some transactions aren't account-linked, e.g. certain manual entries), so this query must handle that honestly (accounts with zero linked transactions show "no transaction history," not a fabricated range). Cheap, real, no new schema.
- **Investments coverage** (e.g. "Mar 2020 → Today"): A4's reconstruction already resolves the earliest defensible position date per account (the same machinery `resolvePositionAsOf`/`PositionReconstruction` already compute) — real, but investment-account-specific; a checking account has no equivalent concept.
- **Historical Prices: available** — an existence check against `PriceObservation` for the account's held instruments. Real, A8-backed.
- **Historical Wealth range — mockup mismatch.** The vision's mockup shows this as a per-account bar, but wealth history (`SpaceSnapshot`) is a **Space-level** concept in this codebase, not account-level — there is no per-account wealth history to show. This bar doesn't map onto real data structure as drawn; it belongs in the Space Coverage rollup at the bottom of the vision (§5), not inside each account card.

**Recommendation:** build this as a second slice after Bucket 1 — it's real and valuable, but it's a genuinely new read (multiple `MIN`/`MAX` aggregations per account type), not a relocation, and deserves its own scrutiny rather than being folded into the identity/status/actions slice.

---

## 5. Bucket 3 — new schema required: Space participation

Checked directly against `SpaceAccountLink` (`prisma/schema.prisma:966–991`): fields are `spaceId, financialAccountId, kind, addedByUserId, visibilityLevel, status, revokedAt, revokedByUserId`. **None of "hidden from dashboards," "excluded from calculations," "display order," or "default account" exist.** This is the only part of the entire vision that requires a schema migration — a real, additive one (new nullable/defaulted columns on an existing model, not a new table), but it's categorically different work from everything else here and should be scoped as its own small backend slice, not bundled into a presentation redesign. Recommend treating it as explicitly deferred from Phase 1, revisited once there's a concrete need driving it (rather than building four new toggles speculatively).

---

## 6. Bucket 4 — not honestly buildable yet: Account Intelligence

Two independent blockers, verified:

1. **Asymmetric data.** "Evidence: Observed + Imported" maps directly to A4's real origin precedence (`OBSERVED > IMPORTED > DERIVED > USER_ASSERTED`) — genuinely real for investment/crypto accounts. There is no equivalent evidence-tier concept anywhere in this codebase for a plain checking or savings account. Shipping this section today means it's real for a minority of account types and either empty or fabricated-looking for the rest.
2. **"Last regenerated" can't be honest today.** Confirmed multiple times this week: A9's wealth regeneration (`regenerateWealthHistoryForAccounts`) is not wired to any trigger — it's "exported and called by nobody" per the repository audit. There is no "yesterday" to report.

**Recommendation:** hold this feature entirely, not just "not in beta" — revisit once A9 activation lands (the same dependency already gating the Activity Tab's Intelligence category and the Liquidity/Debt historical asOf work). When it does ship, scope it to investment/crypto accounts only, or design an honest empty state for account types with no evidence-tier concept, rather than a universal section.

---

## 7. The Space Coverage rollup (bottom of the vision)

Split the same way as Historical Coverage:

- Account count, connected-vs-manual split: cheap, real — `SpaceAccountLink` count + a null-check on `FinancialAccount.connectionId` (manual assets have none).
- Historical timeline range (e.g. "Jan 2017 – Today"): **already computed** — `earliestDefensibleDate`, built for the Perspective Shell's ALL preset (`lib/perspectives/time-range.ts`), is exactly this figure at the Space level. Reuse, don't recompute.
- **The single "Coverage: 92%" figure is the one genuinely novel metric in this entire vision.** The repository audit from earlier this week named this exact concept as missing: *"add a lightweight coverage read (per-space: first covered date, % days valued at each tier over the window)... this is the missing 'visible coverage status' and it is a read-time aggregation, not new schema."* Buildable without a migration, but it needs a real, honestly-defined formula (e.g., % of days across the Space's history where every held position resolves at `observed`-or-better tier) — not a plausible-sounding number. This is exactly the kind of metric that becomes quietly dishonest if the formula isn't scrutinized as carefully as the rest of this codebase's completeness machinery has been.

---

## 8. Recommended sequencing

1. **Extract `AccountsCard` into its own composition file** (`components/space/widgets/accounts/AccountsPerspective.tsx` or similar) — matches every other redesigned tab's pattern; it's currently the only one still inline in `SpaceDashboard.tsx`.
2. **Phase 1 — identity + health + actions + imports.** Everything in Bucket 1. Requires a new, dedicated per-account read (do not extend the shared `SpaceAccount` type used across Wealth/Cash Flow/Liquidity/Debt — build a scoped detail read the same way Investments got its own route rather than overloading `current-holdings`).
3. **Phase 2 — Historical Coverage.** Bucket 2, its own slice given the new aggregation work involved.
4. **Deferred, own slice whenever justified — Space participation schema.** Bucket 3. Not blocked on anything, just categorically different work (migration) that shouldn't ride along with a UI redesign.
5. **Held until A9 activation — Account Intelligence + the Space Coverage percentage.** Buckets 4 and the one real gap in §7. Same dependency already gating two other initiatives this week.
